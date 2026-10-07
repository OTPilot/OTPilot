//! 2.0 team collections: items shared end-to-end within a team.
//!
//! A collection belongs to a team. Its items are `vault_items` rows with a
//! `collection_id`, encrypted under the collection key (CK), which the server
//! never sees: each `collection_members` row carries CK wrapped to that
//! member's ECDH public key, and the collection name is encrypted under CK.
//!
//! Roles: `manage` (the creator by default) edits items, adds/removes
//! members, renames and deletes; `edit` changes items; `view` reads them.
//! Any team member can create a collection. Leaving or being removed from the
//! team drops the user's memberships (see `teams::remove_member_atomic`).
//!
//! Items are pulled per collection, with the same revision scheme as personal
//! items: a per-collection advisory lock makes revisions commit in order.

use axum::{
    extract::{Path, Query, State},
    response::{IntoResponse, Response},
    routing::{get, put},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    error::{ApiError, Result},
    middleware::auth::AuthUser,
    routes::vault::{conflict, item_json, validate_record, ItemRow, PAGE_SIZE},
    AppState,
};

/// Wrapped keys and encrypted names are small opaque strings.
const MAX_OPAQUE_BYTES: usize = 4096;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/teams/{team_id}/collections", axum::routing::post(create))
        .route("/collections", get(list_mine))
        .route(
            "/collections/{cid}",
            axum::routing::patch(rename).delete(delete_collection),
        )
        .route("/collections/{cid}/members", get(list_members))
        .route(
            "/collections/{cid}/members/{uid}",
            put(put_member).delete(remove_member),
        )
        .route("/collections/{cid}/items", get(list_items))
        .route(
            "/collections/{cid}/items/{id}",
            put(put_item).delete(delete_item),
        )
}

fn opaque(field: &str, value: &str) -> Result<()> {
    if value.is_empty() || value.len() > MAX_OPAQUE_BYTES {
        return Err(ApiError::BadRequest(format!(
            "{field} must be 1-{MAX_OPAQUE_BYTES} bytes"
        )));
    }
    Ok(())
}

fn valid_role(role: &str) -> Result<()> {
    if matches!(role, "manage" | "edit" | "view") {
        Ok(())
    } else {
        Err(ApiError::BadRequest(
            "role must be manage, edit or view".into(),
        ))
    }
}

async fn is_team_member(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    team_id: Uuid,
    user_id: Uuid,
) -> Result<bool> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2)",
    )
    .bind(team_id)
    .bind(user_id)
    .fetch_one(&mut **tx)
    .await?)
}

/// Serializes every change to who belongs to a team or its collections
/// (creating a collection, adding/removing members, changing roles, leaving
/// or being removed from the team): checks and counts made inside the
/// transaction can't be invalidated by a concurrent change.
pub(crate) async fn lock_team(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    team_id: Uuid,
) -> Result<()> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext('team_membership'), hashtext($1::text))")
        .bind(team_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// The caller's role, read inside `tx` with a share lock on their member row:
/// a concurrent role change or removal waits for this transaction (or this
/// one sees its result). 404 when not a member.
async fn role_locked(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    cid: Uuid,
    user_id: Uuid,
) -> Result<String> {
    sqlx::query_scalar(
        "SELECT role FROM collection_members WHERE collection_id = $1 AND user_id = $2 FOR SHARE",
    )
    .bind(cid)
    .bind(user_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(ApiError::NotFound)
}

fn allowed(role: &str, roles: &[&str]) -> Result<()> {
    if roles.contains(&role) {
        Ok(())
    } else {
        Err(ApiError::Forbidden)
    }
}

/// The caller's role in a collection, or 404 (not a member: as if it didn't
/// exist).
async fn role_in(db: &sqlx::PgPool, cid: Uuid, user_id: Uuid) -> Result<String> {
    sqlx::query_scalar(
        "SELECT role FROM collection_members WHERE collection_id = $1 AND user_id = $2",
    )
    .bind(cid)
    .bind(user_id)
    .fetch_optional(db)
    .await?
    .ok_or(ApiError::NotFound)
}

async fn require_role(db: &sqlx::PgPool, cid: Uuid, user_id: Uuid, allowed: &[&str]) -> Result<()> {
    let role = role_in(db, cid, user_id).await?;
    if allowed.contains(&role.as_str()) {
        Ok(())
    } else {
        Err(ApiError::Forbidden)
    }
}

async fn team_of(db: &sqlx::PgPool, cid: Uuid) -> Result<Uuid> {
    sqlx::query_scalar("SELECT team_id FROM collections WHERE id = $1")
        .bind(cid)
        .fetch_optional(db)
        .await?
        .ok_or(ApiError::NotFound)
}

async fn audit(
    db: &sqlx::PgPool,
    team_id: Uuid,
    actor: Uuid,
    action: &str,
    target: Option<Uuid>,
    metadata: Value,
) {
    if let Err(e) = sqlx::query(
        "INSERT INTO audit_logs (team_id, actor_id, action, target_id, metadata) VALUES ($1,$2,$3,$4,$5)",
    )
    .bind(team_id)
    .bind(actor)
    .bind(action)
    .bind(target)
    .bind(metadata)
    .execute(db)
    .await
    {
        tracing::error!("audit log write failed ({action}): {e}");
    }
}

// ── Collections ────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct CreateRequest {
    /// Client-generated, so the client can encrypt items for it right away.
    id: Uuid,
    encrypted_name: String,
    /// CK wrapped to the creator's own public key.
    wrapped_key: String,
}

async fn create(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(team_id): Path<Uuid>,
    Json(body): Json<CreateRequest>,
) -> Result<Response> {
    opaque("encrypted_name", &body.encrypted_name)?;
    opaque("wrapped_key", &body.wrapped_key)?;
    let mut tx = state.db.begin().await?;
    lock_team(&mut tx, team_id).await?;
    if !is_team_member(&mut tx, team_id, auth.id).await? {
        return Err(ApiError::Forbidden);
    }
    let created = sqlx::query(
        "INSERT INTO collections (id, team_id, encrypted_name, created_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO NOTHING",
    )
    .bind(body.id)
    .bind(team_id)
    .bind(&body.encrypted_name)
    .bind(auth.id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if created == 0 {
        return Err(ApiError::BadRequest("collection id already exists".into()));
    }
    sqlx::query(
        "INSERT INTO collection_members (collection_id, user_id, role, wrapped_key, added_by)
         VALUES ($1, $2, 'manage', $3, $2)",
    )
    .bind(body.id)
    .bind(auth.id)
    .bind(&body.wrapped_key)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    audit(
        &state.db,
        team_id,
        auth.id,
        "collection_create",
        Some(body.id),
        json!({}),
    )
    .await;
    Ok(Json(json!({ "id": body.id })).into_response())
}

#[derive(sqlx::FromRow)]
struct MyCollection {
    id: Uuid,
    team_id: Uuid,
    encrypted_name: String,
    role: String,
    wrapped_key: String,
    members: i64,
}

/// The collections the caller belongs to, with their role and wrapped CK.
async fn list_mine(State(state): State<AppState>, auth: AuthUser) -> Result<Json<Value>> {
    let rows = sqlx::query_as::<_, MyCollection>(
        r#"
        SELECT c.id, c.team_id, c.encrypted_name, m.role, m.wrapped_key,
               (SELECT COUNT(*) FROM collection_members x WHERE x.collection_id = c.id) AS members
        FROM collections c JOIN collection_members m ON m.collection_id = c.id
        WHERE m.user_id = $1
        ORDER BY c.created_at
        "#,
    )
    .bind(auth.id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!({
        "collections": rows.iter().map(|r| json!({
            "id": r.id, "team_id": r.team_id, "encrypted_name": r.encrypted_name,
            "role": r.role, "wrapped_key": r.wrapped_key, "members": r.members,
        })).collect::<Vec<_>>(),
    })))
}

#[derive(Deserialize)]
struct RenameRequest {
    encrypted_name: String,
}

async fn rename(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(cid): Path<Uuid>,
    Json(body): Json<RenameRequest>,
) -> Result<Json<Value>> {
    opaque("encrypted_name", &body.encrypted_name)?;
    require_role(&state.db, cid, auth.id, &["manage"]).await?;
    sqlx::query("UPDATE collections SET encrypted_name = $2 WHERE id = $1")
        .bind(cid)
        .bind(&body.encrypted_name)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

/// Deletes the collection and its items for everyone.
async fn delete_collection(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(cid): Path<Uuid>,
) -> Result<Json<Value>> {
    let team_id = team_of(&state.db, cid).await?;
    // The collection's write lock first (as item writes take it), then the
    // member row: never the reverse order, so no deadlock with a write.
    let mut tx = begin_collection_tx(&state, cid).await?;
    allowed(&role_locked(&mut tx, cid, auth.id).await?, &["manage"])?;
    sqlx::query("DELETE FROM collections WHERE id = $1")
        .bind(cid)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    audit(
        &state.db,
        team_id,
        auth.id,
        "collection_delete",
        Some(cid),
        json!({}),
    )
    .await;
    Ok(Json(json!({ "ok": true })))
}

// ── Members ────────────────────────────────────────────────────────────────────

#[derive(sqlx::FromRow)]
struct MemberRow {
    user_id: Uuid,
    email: Option<String>,
    role: String,
}

async fn list_members(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(cid): Path<Uuid>,
) -> Result<Json<Value>> {
    role_in(&state.db, cid, auth.id).await?;
    let rows = sqlx::query_as::<_, MemberRow>(
        r#"
        SELECT m.user_id, u.email, m.role FROM collection_members m
        JOIN users u ON u.id = m.user_id
        WHERE m.collection_id = $1 ORDER BY m.created_at
        "#,
    )
    .bind(cid)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!({
        "members": rows.iter().map(|r| json!({ "user_id": r.user_id, "email": r.email, "role": r.role }))
            .collect::<Vec<_>>(),
    })))
}

#[derive(Deserialize)]
struct PutMemberRequest {
    role: String,
    /// CK wrapped to the member's public key. Required to add someone; when
    /// only changing a role it may be omitted.
    #[serde(default)]
    wrapped_key: Option<String>,
}

/// Adds a team member to the collection, or changes their role (manage only).
async fn put_member(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((cid, uid)): Path<(Uuid, Uuid)>,
    Json(body): Json<PutMemberRequest>,
) -> Result<Json<Value>> {
    valid_role(&body.role)?;
    let team_id = team_of(&state.db, cid).await?;
    let mut tx = state.db.begin().await?;
    lock_team(&mut tx, team_id).await?;
    allowed(&role_locked(&mut tx, cid, auth.id).await?, &["manage"])?;
    if !is_team_member(&mut tx, team_id, uid).await? {
        return Err(ApiError::BadRequest("not a member of this team".into()));
    }
    if uid == auth.id && body.role != "manage" {
        // At least the caller keeps managing; another manager can demote them.
        let managers: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM collection_members WHERE collection_id = $1 AND role = 'manage'",
        )
        .bind(cid)
        .fetch_one(&mut *tx)
        .await?;
        if managers <= 1 {
            return Err(ApiError::BadRequest(
                "a collection needs at least one manager".into(),
            ));
        }
    }
    let updated = match body.wrapped_key.as_deref() {
        Some(key) => {
            opaque("wrapped_key", key)?;
            sqlx::query(
                "INSERT INTO collection_members (collection_id, user_id, role, wrapped_key, added_by)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (collection_id, user_id) DO UPDATE SET role = EXCLUDED.role, wrapped_key = EXCLUDED.wrapped_key",
            )
            .bind(cid)
            .bind(uid)
            .bind(&body.role)
            .bind(key)
            .bind(auth.id)
            .execute(&mut *tx)
            .await?
            .rows_affected()
        }
        None => sqlx::query(
            "UPDATE collection_members SET role = $3 WHERE collection_id = $1 AND user_id = $2",
        )
        .bind(cid)
        .bind(uid)
        .bind(&body.role)
        .execute(&mut *tx)
        .await?
        .rows_affected(),
    };
    if updated == 0 {
        return Err(ApiError::BadRequest(
            "wrapped_key is required to add a member".into(),
        ));
    }
    tx.commit().await?;
    audit(
        &state.db,
        team_id,
        auth.id,
        "collection_member_set",
        Some(uid),
        json!({ "collection_id": cid, "role": body.role }),
    )
    .await;
    Ok(Json(json!({ "ok": true })))
}

/// Removes a member (manage), or the caller leaves. They lose the
/// collection's items only, never their own vault. The last manager leaving
/// makes the oldest remaining member manager; the last member leaving
/// deletes the collection (a database trigger, so account deletion and team
/// departures get the same treatment).
async fn remove_member(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((cid, uid)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>> {
    let team_id = team_of(&state.db, cid).await?;
    let mut tx = state.db.begin().await?;
    lock_team(&mut tx, team_id).await?;
    let role = role_locked(&mut tx, cid, auth.id).await?;
    if uid != auth.id {
        allowed(&role, &["manage"])?;
    }
    let removed =
        sqlx::query("DELETE FROM collection_members WHERE collection_id = $1 AND user_id = $2")
            .bind(cid)
            .bind(uid)
            .execute(&mut *tx)
            .await?
            .rows_affected();
    if removed == 0 {
        return Err(ApiError::NotFound);
    }
    // The collection_member_removed trigger deletes an emptied collection and
    // promotes a member when no manager is left.
    tx.commit().await?;
    audit(
        &state.db,
        team_id,
        auth.id,
        "collection_member_remove",
        Some(uid),
        json!({ "collection_id": cid }),
    )
    .await;
    Ok(Json(json!({ "ok": true })))
}

// ── Items ──────────────────────────────────────────────────────────────────────

/// Same ordering guarantee as personal items (see vault::begin_owner_tx),
/// per collection.
async fn begin_collection_tx(
    state: &AppState,
    cid: Uuid,
) -> Result<sqlx::Transaction<'static, sqlx::Postgres>> {
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext('collection_items'), hashtext($1::text))")
        .bind(cid)
        .execute(&mut *tx)
        .await?;
    Ok(tx)
}

#[derive(Deserialize)]
struct ListParams {
    #[serde(default)]
    since: i64,
}

async fn list_items(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(cid): Path<Uuid>,
    Query(params): Query<ListParams>,
) -> Result<Json<Value>> {
    role_in(&state.db, cid, auth.id).await?;
    let mut rows = sqlx::query_as::<_, ItemRow>(
        "SELECT id, encrypted_item, revision, deleted_at, updated_at FROM vault_items
         WHERE collection_id = $1 AND revision > $2 ORDER BY revision LIMIT $3",
    )
    .bind(cid)
    .bind(params.since)
    .bind(PAGE_SIZE + 1)
    .fetch_all(&state.db)
    .await?;
    let more = rows.len() as i64 > PAGE_SIZE;
    rows.truncate(PAGE_SIZE as usize);
    let revision = rows.last().map(|r| r.revision).unwrap_or(params.since);
    Ok(Json(json!({
        "items": rows.iter().map(item_json).collect::<Vec<_>>(),
        "revision": revision,
        "more": more,
    })))
}

#[derive(Deserialize)]
struct PutItemRequest {
    record: Value,
    #[serde(default)]
    base_revision: Option<i64>,
}

#[derive(sqlx::FromRow)]
struct LockedItem {
    collection_id: Option<Uuid>,
    revision: i64,
}

async fn current_item(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    id: Uuid,
) -> Result<Option<ItemRow>> {
    Ok(sqlx::query_as::<_, ItemRow>(
        "SELECT id, encrypted_item, revision, deleted_at, updated_at FROM vault_items WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?)
}

/// Creates or updates an item in the collection (edit/manage, checked inside
/// the write's transaction). Same base_revision / 409 contract as personal
/// items. Collection items have no owner: they belong to the collection
/// (deleting a writer's account keeps them) and never count toward a
/// personal Free limit.
async fn put_item(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((cid, id)): Path<(Uuid, Uuid)>,
    Json(body): Json<PutItemRequest>,
) -> Result<Response> {
    let record = validate_record(&body.record)?;
    let mut tx = begin_collection_tx(&state, cid).await?;
    allowed(
        &role_locked(&mut tx, cid, auth.id).await?,
        &["manage", "edit"],
    )?;
    let existing = sqlx::query_as::<_, LockedItem>(
        "SELECT collection_id, revision FROM vault_items WHERE id = $1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    let revision: i64 = match existing {
        // Someone's personal item or another collection's: as if it didn't exist.
        Some(row) if row.collection_id != Some(cid) => return Err(ApiError::NotFound),
        Some(row) => {
            if body.base_revision != Some(row.revision) {
                let current = current_item(&mut tx, id).await?;
                return Ok(conflict(current.as_ref()));
            }
            sqlx::query_scalar(
                "UPDATE vault_items SET encrypted_item = $2, deleted_at = NULL,
                     revision = nextval('vault_revision_seq'), updated_at = NOW()
                 WHERE id = $1 RETURNING revision",
            )
            .bind(id)
            .bind(&record)
            .fetch_one(&mut *tx)
            .await?
        }
        None => {
            let created: Option<i64> = sqlx::query_scalar(
                "INSERT INTO vault_items (id, owner_id, collection_id, encrypted_item, counts_for_limit)
                 VALUES ($1, NULL, $2, $3, false) ON CONFLICT (id) DO NOTHING RETURNING revision",
            )
            .bind(id)
            .bind(cid)
            .bind(&record)
            .fetch_optional(&mut *tx)
            .await?;
            match created {
                Some(r) => r,
                None => return Err(ApiError::NotFound), // the id exists outside this collection
            }
        }
    };
    tx.commit().await?;
    Ok(Json(json!({ "id": id, "revision": revision })).into_response())
}

#[derive(Deserialize)]
struct DeleteParams {
    base_revision: i64,
}

async fn delete_item(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((cid, id)): Path<(Uuid, Uuid)>,
    Query(params): Query<DeleteParams>,
) -> Result<Response> {
    let mut tx = begin_collection_tx(&state, cid).await?;
    allowed(
        &role_locked(&mut tx, cid, auth.id).await?,
        &["manage", "edit"],
    )?;
    let existing = sqlx::query_as::<_, LockedItem>(
        "SELECT collection_id, revision FROM vault_items WHERE id = $1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    match existing {
        Some(row) if row.collection_id == Some(cid) => {
            if row.revision != params.base_revision {
                let current = current_item(&mut tx, id).await?;
                return Ok(conflict(current.as_ref()));
            }
        }
        _ => return Err(ApiError::NotFound),
    }
    let revision: i64 = sqlx::query_scalar(
        "UPDATE vault_items SET encrypted_item = '', deleted_at = NOW(),
             revision = nextval('vault_revision_seq'), updated_at = NOW()
         WHERE id = $1 RETURNING revision",
    )
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(json!({ "id": id, "revision": revision })).into_response())
}

#[cfg(all(test, feature = "db-tests"))]
mod db_tests {
    use super::*;
    use crate::test_support::{call, create_user, test_db, test_state, TestDb};
    use axum::http::{Method, StatusCode};

    async fn app() -> (Router, sqlx::PgPool, TestDb) {
        let db = test_db().await;
        let pool = db.pool.clone();
        let app = router()
            .merge(crate::routes::teams::router())
            .merge(crate::routes::vault::router())
            .with_state(test_state(pool.clone()));
        (app, pool, db)
    }

    /// A team with `owner` and `members`, all on team_lite.
    async fn team(db: &sqlx::PgPool, owner: Uuid, members: &[Uuid]) -> Uuid {
        let id: Uuid =
            sqlx::query_scalar("INSERT INTO teams (name, owner_id) VALUES ('T', $1) RETURNING id")
                .bind(owner)
                .fetch_one(db)
                .await
                .unwrap();
        for (u, role) in
            std::iter::once((owner, "owner")).chain(members.iter().map(|m| (*m, "member")))
        {
            sqlx::query("INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3)")
                .bind(id)
                .bind(u)
                .bind(role)
                .execute(db)
                .await
                .unwrap();
        }
        id
    }

    fn record(tag: &str) -> Value {
        json!({ "v": 2, "key": { "iv": "aXY=", "ct": "a2V5" }, "data": { "iv": "aXY=", "ct": tag } })
    }

    async fn new_collection(app: &Router, user: Uuid, team_id: Uuid) -> Uuid {
        let cid = Uuid::new_v4();
        let (s, _) = call(
            app,
            user,
            Method::POST,
            &format!("/teams/{team_id}/collections"),
            Some(
                json!({ "id": cid, "encrypted_name": "enc-name", "wrapped_key": "ck-for-creator" }),
            ),
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        cid
    }

    #[tokio::test]
    async fn any_team_member_creates_and_only_members_see_a_collection() {
        let (app, db, _g) = app().await;
        let (owner, alice, outsider) = (
            create_user(&db, "team_lite").await,
            create_user(&db, "team_lite").await,
            create_user(&db, "personal").await,
        );
        let t = team(&db, owner, &[alice]).await;

        // An outsider can't create one in this team.
        let (s, _) = call(
            &app,
            outsider,
            Method::POST,
            &format!("/teams/{t}/collections"),
            Some(json!({ "id": Uuid::new_v4(), "encrypted_name": "x", "wrapped_key": "y" })),
        )
        .await;
        assert_eq!(s, StatusCode::FORBIDDEN);

        let cid = new_collection(&app, alice, t).await;
        let (_, mine) = call(&app, alice, Method::GET, "/collections", None).await;
        assert_eq!(mine["collections"][0]["id"], json!(cid));
        assert_eq!(mine["collections"][0]["role"], "manage");
        assert_eq!(mine["collections"][0]["wrapped_key"], "ck-for-creator");

        // The team owner isn't a member of it: doesn't see it or its items.
        let (_, theirs) = call(&app, owner, Method::GET, "/collections", None).await;
        assert_eq!(theirs["collections"], json!([]));
        let (s, _) = call(
            &app,
            owner,
            Method::GET,
            &format!("/collections/{cid}/items"),
            None,
        )
        .await;
        assert_eq!(s, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn managers_add_members_with_their_wrapped_key_and_roles_gate_writes() {
        let (app, db, _g) = app().await;
        let (owner, alice, bob, outsider) = (
            create_user(&db, "team_lite").await,
            create_user(&db, "team_lite").await,
            create_user(&db, "team_lite").await,
            create_user(&db, "personal").await,
        );
        let t = team(&db, owner, &[alice, bob]).await;
        let cid = new_collection(&app, alice, t).await;
        let member = |uid: Uuid| format!("/collections/{cid}/members/{uid}");

        // Only team members can be added; adding needs the wrapped key.
        let (s, _) = call(
            &app,
            alice,
            Method::PUT,
            &member(outsider),
            Some(json!({ "role": "view", "wrapped_key": "k" })),
        )
        .await;
        assert_eq!(s, StatusCode::BAD_REQUEST);
        let (s, _) = call(
            &app,
            alice,
            Method::PUT,
            &member(bob),
            Some(json!({ "role": "view" })),
        )
        .await;
        assert_eq!(s, StatusCode::BAD_REQUEST);
        let (s, _) = call(
            &app,
            alice,
            Method::PUT,
            &member(bob),
            Some(json!({ "role": "view", "wrapped_key": "ck-for-bob" })),
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        let (_, bobs) = call(&app, bob, Method::GET, "/collections", None).await;
        assert_eq!(bobs["collections"][0]["wrapped_key"], "ck-for-bob");
        assert_eq!(bobs["collections"][0]["members"], 2);

        // A viewer reads but can't write, and can't manage members.
        let item = Uuid::new_v4();
        let (s, _) = call(
            &app,
            bob,
            Method::PUT,
            &format!("/collections/{cid}/items/{item}"),
            Some(json!({ "record": record("b") })),
        )
        .await;
        assert_eq!(s, StatusCode::FORBIDDEN);
        let (s, _) = call(
            &app,
            bob,
            Method::PUT,
            &member(owner),
            Some(json!({ "role": "view", "wrapped_key": "k" })),
        )
        .await;
        assert_eq!(s, StatusCode::FORBIDDEN);

        // Promoted to edit, he can.
        call(
            &app,
            alice,
            Method::PUT,
            &member(bob),
            Some(json!({ "role": "edit" })),
        )
        .await;
        let (s, created) = call(
            &app,
            bob,
            Method::PUT,
            &format!("/collections/{cid}/items/{item}"),
            Some(json!({ "record": record("b") })),
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        let rev = created["revision"].as_i64().unwrap();
        let (_, pulled) = call(
            &app,
            alice,
            Method::GET,
            &format!("/collections/{cid}/items?since=0"),
            None,
        )
        .await;
        assert_eq!(pulled["items"][0]["id"], json!(item));

        // Same base_revision contract as personal items.
        let (s, _) = call(
            &app,
            alice,
            Method::PUT,
            &format!("/collections/{cid}/items/{item}"),
            Some(json!({ "record": record("c") })),
        )
        .await;
        assert_eq!(s, StatusCode::CONFLICT);
        let (s, _) = call(
            &app,
            alice,
            Method::DELETE,
            &format!("/collections/{cid}/items/{item}?base_revision={rev}"),
            None,
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        let (_, after) = call(
            &app,
            bob,
            Method::GET,
            &format!("/collections/{cid}/items?since={rev}"),
            None,
        )
        .await;
        assert_eq!(after["items"][0]["deleted"], true);
    }

    #[tokio::test]
    async fn collection_items_stay_out_of_personal_sync_and_vice_versa() {
        let (app, db, _g) = app().await;
        let (owner, alice) = (
            create_user(&db, "team_lite").await,
            create_user(&db, "team_lite").await,
        );
        let t = team(&db, owner, &[alice]).await;
        let cid = new_collection(&app, alice, t).await;
        let shared = Uuid::new_v4();
        call(
            &app,
            alice,
            Method::PUT,
            &format!("/collections/{cid}/items/{shared}"),
            Some(json!({ "record": record("s") })),
        )
        .await;

        let (_, personal) = call(&app, alice, Method::GET, "/vault/items?since=0", None).await;
        assert_eq!(personal["items"], json!([]));
        // The personal endpoints can't touch it either.
        let (s, _) = call(
            &app,
            alice,
            Method::PUT,
            &format!("/vault/items/{shared}"),
            Some(json!({ "record": record("x"), "base_revision": 1 })),
        )
        .await;
        assert_eq!(s, StatusCode::NOT_FOUND);

        // And a personal item can't be written through a collection.
        let mine = Uuid::new_v4();
        call(
            &app,
            alice,
            Method::PUT,
            &format!("/vault/items/{mine}"),
            Some(json!({ "record": record("p") })),
        )
        .await;
        let (s, _) = call(
            &app,
            alice,
            Method::PUT,
            &format!("/collections/{cid}/items/{mine}"),
            Some(json!({ "record": record("y"), "base_revision": 1 })),
        )
        .await;
        assert_eq!(s, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn leaving_the_team_drops_shared_access_but_never_the_own_vault() {
        let (app, db, _g) = app().await;
        let (owner, alice, bob) = (
            create_user(&db, "team_lite").await,
            create_user(&db, "team_lite").await,
            create_user(&db, "team_lite").await,
        );
        let t = team(&db, owner, &[alice, bob]).await;
        // Alice manages a collection Bob is in, and Bob has one of his own.
        let shared = new_collection(&app, alice, t).await;
        call(
            &app,
            alice,
            Method::PUT,
            &format!("/collections/{shared}/members/{bob}"),
            Some(json!({ "role": "edit", "wrapped_key": "k" })),
        )
        .await;
        let solo = new_collection(&app, alice, t).await;
        let own = Uuid::new_v4();
        call(
            &app,
            alice,
            Method::PUT,
            &format!("/vault/items/{own}"),
            Some(json!({ "record": record("own") })),
        )
        .await;

        let (s, _) = call(
            &app,
            alice,
            Method::DELETE,
            &format!("/teams/{t}/leave"),
            None,
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        let (_, mine) = call(&app, alice, Method::GET, "/collections", None).await;
        assert_eq!(mine["collections"], json!([]));
        // Bob keeps the shared one and now manages it; Alice's solo one is gone.
        let (_, bobs) = call(&app, bob, Method::GET, "/collections", None).await;
        assert_eq!(bobs["collections"][0]["id"], json!(shared));
        assert_eq!(bobs["collections"][0]["role"], "manage");
        let solo_left: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM collections WHERE id = $1)")
                .bind(solo)
                .fetch_one(&db)
                .await
                .unwrap();
        assert!(!solo_left);
        // Her own items are untouched (she's on Free now, so check the table).
        let own_left: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM vault_items WHERE id = $1 AND deleted_at IS NULL)",
        )
        .bind(own)
        .fetch_one(&db)
        .await
        .unwrap();
        assert!(own_left);
    }

    #[tokio::test]
    async fn a_collection_always_keeps_a_manager() {
        let (app, db, _g) = app().await;
        let (owner, alice, bob, carol) = (
            create_user(&db, "team_lite").await,
            create_user(&db, "team_lite").await,
            create_user(&db, "team_lite").await,
            create_user(&db, "team_lite").await,
        );
        let t = team(&db, owner, &[alice, bob, carol]).await;
        let cid = new_collection(&app, alice, t).await;
        for u in [bob, carol] {
            call(
                &app,
                alice,
                Method::PUT,
                &format!("/collections/{cid}/members/{u}"),
                Some(json!({ "role": "view", "wrapped_key": "k" })),
            )
            .await;
        }
        // The only manager can't demote themselves...
        let (s, _) = call(
            &app,
            alice,
            Method::PUT,
            &format!("/collections/{cid}/members/{alice}"),
            Some(json!({ "role": "edit" })),
        )
        .await;
        assert_eq!(s, StatusCode::BAD_REQUEST);
        // ...and leaving makes the oldest remaining member manager.
        let (s, _) = call(
            &app,
            alice,
            Method::DELETE,
            &format!("/collections/{cid}/members/{alice}"),
            None,
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        let (_, bobs) = call(&app, bob, Method::GET, "/collections", None).await;
        assert_eq!(bobs["collections"][0]["role"], "manage");
        // The last member leaving deletes it.
        call(
            &app,
            carol,
            Method::DELETE,
            &format!("/collections/{cid}/members/{carol}"),
            None,
        )
        .await;
        let (s, _) = call(
            &app,
            bob,
            Method::DELETE,
            &format!("/collections/{cid}/members/{bob}"),
            None,
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM collections")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(left, 0);
    }

    #[tokio::test]
    async fn deleting_an_account_keeps_shared_items_and_a_manager() {
        let (app, db, _g) = app().await;
        let (owner, alice, bob) = (
            create_user(&db, "team_lite").await,
            create_user(&db, "team_lite").await,
            create_user(&db, "team_lite").await,
        );
        let t = team(&db, owner, &[alice, bob]).await;
        let cid = new_collection(&app, alice, t).await;
        call(
            &app,
            alice,
            Method::PUT,
            &format!("/collections/{cid}/members/{bob}"),
            Some(json!({ "role": "view", "wrapped_key": "k" })),
        )
        .await;
        let item = Uuid::new_v4();
        call(
            &app,
            alice,
            Method::PUT,
            &format!("/collections/{cid}/items/{item}"),
            Some(json!({ "record": record("a") })),
        )
        .await;

        // Alice (the writer and only manager) deletes her account.
        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(alice)
            .execute(&db)
            .await
            .unwrap();

        let (_, bobs) = call(&app, bob, Method::GET, "/collections", None).await;
        assert_eq!(bobs["collections"][0]["role"], "manage");
        let (_, items) = call(
            &app,
            bob,
            Method::GET,
            &format!("/collections/{cid}/items?since=0"),
            None,
        )
        .await;
        assert_eq!(items["items"][0]["id"], json!(item));
        assert_eq!(items["items"][0]["deleted"], false);
    }

    #[tokio::test]
    async fn two_accounts_deleted_at_once_never_orphan_a_collection() {
        let (app, db, _g) = app().await;
        for _ in 0..5 {
            let (owner, alice, bob) = (
                create_user(&db, "team_lite").await,
                create_user(&db, "team_lite").await,
                create_user(&db, "team_lite").await,
            );
            let t = team(&db, owner, &[alice, bob]).await;
            let cid = new_collection(&app, alice, t).await;
            call(
                &app,
                alice,
                Method::PUT,
                &format!("/collections/{cid}/members/{bob}"),
                Some(json!({ "role": "manage", "wrapped_key": "k" })),
            )
            .await;
            // Neither references the other (created_by / added_by would block
            // a deletion), so both deletions can run at the same time.
            sqlx::query("UPDATE collections SET created_by = NULL WHERE id = $1")
                .bind(cid)
                .execute(&db)
                .await
                .unwrap();
            sqlx::query("UPDATE collection_members SET added_by = NULL WHERE collection_id = $1")
                .bind(cid)
                .execute(&db)
                .await
                .unwrap();
            let (a, b) = (db.clone(), db.clone());
            let (ra, rb) = tokio::join!(
                tokio::spawn(async move {
                    sqlx::query("DELETE FROM users WHERE id = $1")
                        .bind(alice)
                        .execute(&a)
                        .await
                }),
                tokio::spawn(async move {
                    sqlx::query("DELETE FROM users WHERE id = $1")
                        .bind(bob)
                        .execute(&b)
                        .await
                }),
            );
            ra.unwrap().unwrap();
            rb.unwrap().unwrap();
            let left: bool =
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM collections WHERE id = $1)")
                    .bind(cid)
                    .fetch_one(&db)
                    .await
                    .unwrap();
            assert!(!left, "a collection without members was left behind");
        }
    }
}
