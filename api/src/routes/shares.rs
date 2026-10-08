//! 2.0 sharing: shares and grants (docs/sharing.md).
//!
//! A share is a copy of one of its owner's vault items — the whole item or
//! some of its fields — encrypted under a share key (SK) the server never
//! sees. A grant lets one person (SK wrapped to their public key) or one
//! collection (SK encrypted under the collection key) open it, as `view` or
//! `edit`; `edit` is only for whole-item shares. Through a collection, the
//! member's role caps the grant: a `view` member can't edit.
//!
//! Shares are team-scoped: the owner and every grantee are in the owner's
//! team. Grant changes take the team lock (`collections::lock_team`), like
//! collection membership changes and team departures, so a grant can't be
//! added for someone who is leaving at the same moment.
//!
//! The list of shares someone can open comes back whole on every call (with
//! each share's revision): it spans many owners, so a revision cursor could
//! skip a write that committed late; the list is small (one team's shared
//! items) and the client only downloads what changed.

use axum::http::StatusCode;
use axum::{
    extract::{Path, Query, State},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use uuid::Uuid;

use crate::{
    error::{ApiError, Result},
    middleware::auth::AuthUser,
    routes::{collections::lock_team, vault::validate_record},
    AppState,
};

/// Wrapped keys are small opaque strings.
const MAX_KEY_BYTES: usize = 4096;
/// Grants per share (a team is small; this bounds a request's work).
const MAX_GRANTS: usize = 100;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/shares", post(create_share))
        .route("/shares/mine", get(list_mine))
        .route("/shares/with-me", get(list_with_me))
        .route("/shares/{id}", put(update_share).delete(delete_share))
        .route("/shares/{id}/grants", put(put_grant).delete(remove_grant))
}

// ── Validation and access ──────────────────────────────────────────────────

#[derive(Deserialize, Clone)]
struct GrantRequest {
    #[serde(default)]
    user_id: Option<Uuid>,
    #[serde(default)]
    collection_id: Option<Uuid>,
    role: String,
    wrapped_key: String,
}

fn check_grant_shape(g: &GrantRequest, whole: bool) -> Result<()> {
    if g.user_id.is_some() == g.collection_id.is_some() {
        return Err(ApiError::BadRequest(
            "a grant is for one user_id or one collection_id".into(),
        ));
    }
    match g.role.as_str() {
        "view" => {}
        "edit" if whole => {}
        "edit" => {
            return Err(ApiError::BadRequest(
                "only a whole-item share can be edited by others".into(),
            ))
        }
        _ => return Err(ApiError::BadRequest("role must be view or edit".into())),
    }
    if g.wrapped_key.is_empty() || g.wrapped_key.len() > MAX_KEY_BYTES {
        return Err(ApiError::BadRequest(format!(
            "wrapped_key must be 1-{MAX_KEY_BYTES} bytes"
        )));
    }
    Ok(())
}

/// The caller's team (one per user), or 403: sharing needs a team.
async fn team_of_user(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: Uuid,
) -> Result<Uuid> {
    sqlx::query_scalar("SELECT team_id FROM team_members WHERE user_id = $1 LIMIT 1")
        .bind(user_id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(ApiError::Forbidden)
}

async fn still_member(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    team_id: Uuid,
    user: Uuid,
) -> Result<()> {
    let ok: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2)",
    )
    .bind(team_id)
    .bind(user)
    .fetch_one(&mut **tx)
    .await?;
    if ok {
        Ok(())
    } else {
        Err(ApiError::Forbidden)
    }
}

/// The team lock, then the share row (FOR UPDATE): the order every share
/// write and team departure takes them in, so they wait instead of
/// deadlocking.
async fn lock_team_then_share(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    id: Uuid,
) -> Result<LockedShare> {
    let team_id: Uuid = sqlx::query_scalar("SELECT team_id FROM shares WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(ApiError::NotFound)?;
    lock_team(tx, team_id).await?;
    lock_share(tx, id).await
}

/// A grantee has to be in the owner's team: another member (not the owner),
/// or a collection of the team the owner can write to.
async fn check_grantee(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    team_id: Uuid,
    owner: Uuid,
    g: &GrantRequest,
) -> Result<()> {
    if let Some(uid) = g.user_id {
        let ok: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2)",
        )
        .bind(team_id)
        .bind(uid)
        .fetch_one(&mut **tx)
        .await?;
        if !ok || uid == owner {
            return Err(ApiError::BadRequest("not a teammate".into()));
        }
    }
    if let Some(cid) = g.collection_id {
        let role: Option<String> = sqlx::query_scalar(
            "SELECT m.role FROM collections c
             JOIN collection_members m ON m.collection_id = c.id AND m.user_id = $3
             WHERE c.id = $1 AND c.team_id = $2",
        )
        .bind(cid)
        .bind(team_id)
        .bind(owner)
        .fetch_optional(&mut **tx)
        .await?;
        match role.as_deref() {
            Some("manage" | "edit") => {}
            Some(_) => return Err(ApiError::Forbidden),
            None => return Err(ApiError::NotFound),
        }
    }
    Ok(())
}

async fn insert_grant(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    share_id: Uuid,
    by: Uuid,
    g: &GrantRequest,
) -> Result<()> {
    // Replaces the grantee's grant if there is one (new role / new key) in
    // place: deleting it first would let the last-grant trigger drop the share.
    let conflict = if g.user_id.is_some() {
        "ON CONFLICT (share_id, user_id) WHERE user_id IS NOT NULL"
    } else {
        "ON CONFLICT (share_id, collection_id) WHERE collection_id IS NOT NULL"
    };
    sqlx::query(&format!(
        "INSERT INTO share_grants (share_id, user_id, collection_id, role, wrapped_key, granted_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         {conflict} DO UPDATE SET role = EXCLUDED.role, wrapped_key = EXCLUDED.wrapped_key,
           granted_by = EXCLUDED.granted_by"
    ))
    .bind(share_id)
    .bind(g.user_id)
    .bind(g.collection_id)
    .bind(&g.role)
    .bind(&g.wrapped_key)
    .bind(by)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

#[derive(sqlx::FromRow)]
struct LockedShare {
    team_id: Uuid,
    owner_id: Uuid,
    whole: bool,
    revision: i64,
}

async fn lock_share(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    id: Uuid,
) -> Result<LockedShare> {
    sqlx::query_as::<_, LockedShare>(
        "SELECT team_id, owner_id, whole, revision FROM shares WHERE id = $1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(ApiError::NotFound)
}

/// Whether `user` may edit share `id`: a direct `edit` grant, or an `edit`
/// grant to a collection where they're an editor or manager. Read with share
/// locks on the grant and member rows, so a concurrent revocation waits for
/// this write (or this check sees it).
async fn can_edit(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    id: Uuid,
    user: Uuid,
) -> Result<bool> {
    let direct: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM share_grants
           WHERE share_id = $1 AND user_id = $2 AND role = 'edit' FOR SHARE)",
    )
    .bind(id)
    .bind(user)
    .fetch_one(&mut **tx)
    .await?;
    if direct {
        return Ok(true);
    }
    Ok(sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM share_grants g
           JOIN collection_members m ON m.collection_id = g.collection_id AND m.user_id = $2
           WHERE g.share_id = $1 AND g.role = 'edit' AND m.role IN ('edit', 'manage')
           FOR SHARE OF g, m)",
    )
    .bind(id)
    .bind(user)
    .fetch_one(&mut **tx)
    .await?)
}

#[derive(sqlx::FromRow)]
struct ShareRow {
    id: Uuid,
    encrypted_item: String,
    revision: i64,
}

fn record_of(s: &str) -> Value {
    serde_json::from_str::<Value>(s).unwrap_or(Value::Null)
}

async fn current_share(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    id: Uuid,
) -> Result<Option<ShareRow>> {
    Ok(sqlx::query_as::<_, ShareRow>(
        "SELECT id, encrypted_item, revision FROM shares WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?)
}

fn share_conflict(current: Option<&ShareRow>) -> Response {
    (
        StatusCode::CONFLICT,
        Json(json!({
            "error": "revision conflict",
            "share": current.map(|s| json!({ "id": s.id, "record": record_of(&s.encrypted_item), "revision": s.revision })),
        })),
    )
        .into_response()
}

// ── Owner: create, update, delete ─────────────────────────────────────────

#[derive(Deserialize)]
struct CreateShareRequest {
    id: Uuid,
    item_id: Uuid,
    whole: bool,
    record: Value,
    grants: Vec<GrantRequest>,
}

/// Creates a share of one of the caller's items with its first grants.
async fn create_share(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(body): Json<CreateShareRequest>,
) -> Result<Json<Value>> {
    let record = validate_record(&body.record)?;
    if body.grants.is_empty() || body.grants.len() > MAX_GRANTS {
        return Err(ApiError::BadRequest(format!(
            "a share needs 1-{MAX_GRANTS} grants"
        )));
    }
    for g in &body.grants {
        check_grant_shape(g, body.whole)?;
    }
    let mut tx = state.db.begin().await?;
    let team_id = team_of_user(&mut tx, auth.id).await?;
    lock_team(&mut tx, team_id).await?;
    // Still in that team now that departures wait for us (one may have
    // committed between the read above and the lock).
    still_member(&mut tx, team_id, auth.id).await?;
    // The live item stays locked until the share commits: deleting it (which
    // deletes its shares) either happened before — not found — or waits.
    let owns = sqlx::query("SELECT 1 FROM vault_items WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL FOR UPDATE")
        .bind(body.item_id)
        .bind(auth.id)
        .fetch_optional(&mut *tx)
        .await?;
    if owns.is_none() {
        return Err(ApiError::NotFound);
    }
    for g in &body.grants {
        check_grantee(&mut tx, team_id, auth.id, g).await?;
    }
    let revision: Option<i64> = sqlx::query_scalar(
        "INSERT INTO shares (id, team_id, owner_id, item_id, whole, encrypted_item)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING RETURNING revision",
    )
    .bind(body.id)
    .bind(team_id)
    .bind(auth.id)
    .bind(body.item_id)
    .bind(body.whole)
    .bind(&record)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(revision) = revision else {
        return Err(ApiError::BadRequest("that share id is taken".into()));
    };
    for g in &body.grants {
        insert_grant(&mut tx, body.id, auth.id, g).await?;
    }
    tx.commit().await?;
    Ok(Json(json!({ "id": body.id, "revision": revision })))
}

#[derive(Deserialize)]
struct UpdateShareRequest {
    record: Value,
    base_revision: i64,
}

/// Rewrites a share's copy: its owner (the item changed), or someone who can
/// edit it. 409 + the current copy when `base_revision` is behind.
async fn update_share(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdateShareRequest>,
) -> Result<Response> {
    let record = validate_record(&body.record)?;
    let mut tx = state.db.begin().await?;
    let share = lock_team_then_share(&mut tx, id).await?;
    if share.owner_id != auth.id && !(share.whole && can_edit(&mut tx, id, auth.id).await?) {
        // Someone who can only view it: forbidden; anyone else: not found.
        return Err(if can_open(&mut tx, id, auth.id).await? {
            ApiError::Forbidden
        } else {
            ApiError::NotFound
        });
    }
    if share.revision != body.base_revision {
        let current = current_share(&mut tx, id).await?;
        return Ok(share_conflict(current.as_ref()));
    }
    let revision: i64 = sqlx::query_scalar(
        "UPDATE shares SET encrypted_item = $2, revision = nextval('vault_revision_seq'), updated_at = NOW()
         WHERE id = $1 RETURNING revision",
    )
    .bind(id)
    .bind(&record)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(json!({ "id": id, "revision": revision })).into_response())
}

async fn can_open(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    id: Uuid,
    user: Uuid,
) -> Result<bool> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM share_grants g
           LEFT JOIN collection_members m ON m.collection_id = g.collection_id AND m.user_id = $2
           WHERE g.share_id = $1 AND (g.user_id = $2 OR m.user_id IS NOT NULL))",
    )
    .bind(id)
    .bind(user)
    .fetch_one(&mut **tx)
    .await?)
}

/// The owner stops sharing this copy (every grant goes with it).
async fn delete_share(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let mut tx = state.db.begin().await?;
    let share = lock_team_then_share(&mut tx, id).await?;
    if share.owner_id != auth.id {
        return Err(ApiError::NotFound);
    }
    sqlx::query("DELETE FROM shares WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(json!({ "ok": true })))
}

// ── Grants ─────────────────────────────────────────────────────────────────

/// Adds a grant, or changes one (role, key). Owner only.
async fn put_grant(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<Uuid>,
    Json(g): Json<GrantRequest>,
) -> Result<Json<Value>> {
    let mut tx = state.db.begin().await?;
    let share = lock_team_then_share(&mut tx, id).await?;
    if share.owner_id != auth.id {
        return Err(ApiError::NotFound);
    }
    check_grant_shape(&g, share.whole)?;
    // The cap counts new grantees only: changing an existing grant is fine.
    let (count, exists): (i64, bool) = sqlx::query_as(
        "SELECT COUNT(*), COALESCE(bool_or(user_id = $2 OR collection_id = $3), false)
         FROM share_grants WHERE share_id = $1",
    )
    .bind(id)
    .bind(g.user_id)
    .bind(g.collection_id)
    .fetch_one(&mut *tx)
    .await?;
    if !exists && count as usize >= MAX_GRANTS {
        return Err(ApiError::BadRequest(format!(
            "a share has at most {MAX_GRANTS} grants"
        )));
    }
    check_grantee(&mut tx, share.team_id, auth.id, &g).await?;
    insert_grant(&mut tx, id, auth.id, &g).await?;
    tx.commit().await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct GrantTarget {
    #[serde(default)]
    user_id: Option<Uuid>,
    #[serde(default)]
    collection_id: Option<Uuid>,
}

/// Removes a grant: the owner (any grant), or a grantee removing their own
/// direct grant ("leave"). The share goes when its last grant does.
async fn remove_grant(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<Uuid>,
    Query(t): Query<GrantTarget>,
) -> Result<Json<Value>> {
    if t.user_id.is_some() == t.collection_id.is_some() {
        return Err(ApiError::BadRequest("user_id or collection_id".into()));
    }
    let mut tx = state.db.begin().await?;
    let share = lock_team_then_share(&mut tx, id).await?;
    let leaving = t.user_id == Some(auth.id);
    if share.owner_id != auth.id && !leaving {
        return Err(ApiError::NotFound);
    }
    let removed = sqlx::query(
        "DELETE FROM share_grants WHERE share_id = $1 AND (user_id = $2 OR collection_id = $3)",
    )
    .bind(id)
    .bind(t.user_id)
    .bind(t.collection_id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if removed == 0 {
        return Err(ApiError::NotFound);
    }
    // The share_grant_removed trigger deleted the share if that was its last grant.
    let deleted: bool = sqlx::query_scalar("SELECT NOT EXISTS(SELECT 1 FROM shares WHERE id = $1)")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(json!({ "ok": true, "share_deleted": deleted })))
}

// ── Lists ──────────────────────────────────────────────────────────────────

#[derive(sqlx::FromRow)]
struct MineRow {
    id: Uuid,
    item_id: Uuid,
    whole: bool,
    encrypted_item: String,
    revision: i64,
    updated_at: chrono::DateTime<chrono::Utc>,
    user_id: Option<Uuid>,
    collection_id: Option<Uuid>,
    role: Option<String>,
}

/// The caller's shares with their grants (who, role — not the keys, which
/// the owner made and doesn't need back). Editors' changes show up here as
/// newer revisions.
async fn list_mine(State(state): State<AppState>, auth: AuthUser) -> Result<Json<Value>> {
    let rows = sqlx::query_as::<_, MineRow>(
        "SELECT s.id, s.item_id, s.whole, s.encrypted_item, s.revision, s.updated_at,
                g.user_id, g.collection_id, g.role
         FROM shares s LEFT JOIN share_grants g ON g.share_id = s.id
         WHERE s.owner_id = $1 ORDER BY s.id",
    )
    .bind(auth.id)
    .fetch_all(&state.db)
    .await?;
    let mut out: BTreeMap<Uuid, Value> = BTreeMap::new();
    for r in rows {
        let e = out.entry(r.id).or_insert_with(|| {
            json!({
                "id": r.id, "item_id": r.item_id, "whole": r.whole,
                "record": record_of(&r.encrypted_item), "revision": r.revision,
                "updated_at": r.updated_at, "grants": [],
            })
        });
        if let Some(role) = r.role {
            e["grants"].as_array_mut().unwrap().push(json!({
                "user_id": r.user_id, "collection_id": r.collection_id, "role": role,
            }));
        }
    }
    Ok(Json(
        json!({ "shares": out.into_values().collect::<Vec<_>>() }),
    ))
}

#[derive(sqlx::FromRow)]
struct WithMeRow {
    id: Uuid,
    owner_id: Uuid,
    owner_email: Option<String>,
    whole: bool,
    encrypted_item: String,
    revision: i64,
    updated_at: chrono::DateTime<chrono::Utc>,
    user_id: Option<Uuid>,
    collection_id: Option<Uuid>,
    grant_role: String,
    member_role: Option<String>,
    wrapped_key: String,
}

/// Every share the caller can open (not their own): directly, or through a
/// collection they're in. For each: the copy, its revision, the caller's
/// effective role, and how to open it (`via`: the wrapped key per grant).
async fn list_with_me(State(state): State<AppState>, auth: AuthUser) -> Result<Json<Value>> {
    let rows = sqlx::query_as::<_, WithMeRow>(
        "SELECT s.id, s.owner_id, u.email AS owner_email, s.whole, s.encrypted_item, s.revision,
                s.updated_at, g.user_id, g.collection_id, g.role AS grant_role,
                m.role AS member_role, g.wrapped_key
         FROM shares s
         JOIN share_grants g ON g.share_id = s.id
         LEFT JOIN collection_members m ON m.collection_id = g.collection_id AND m.user_id = $1
         JOIN users u ON u.id = s.owner_id
         WHERE s.owner_id <> $1 AND (g.user_id = $1 OR m.user_id IS NOT NULL)
         ORDER BY s.id",
    )
    .bind(auth.id)
    .fetch_all(&state.db)
    .await?;
    let mut out: BTreeMap<Uuid, Value> = BTreeMap::new();
    for r in rows {
        // Through a collection, a `view` member can't edit.
        let edit = r.whole
            && r.grant_role == "edit"
            && r.member_role
                .as_deref()
                .is_none_or(|m| m == "edit" || m == "manage");
        let e = out.entry(r.id).or_insert_with(|| {
            json!({
                "id": r.id, "owner": { "id": r.owner_id, "email": r.owner_email },
                "whole": r.whole, "record": record_of(&r.encrypted_item),
                "revision": r.revision, "updated_at": r.updated_at, "role": "view", "via": [],
            })
        });
        if edit {
            e["role"] = json!("edit");
        }
        e["via"]
            .as_array_mut()
            .unwrap()
            .push(match r.collection_id {
                Some(cid) => json!({ "collection_id": cid, "wrapped_key": r.wrapped_key }),
                None => json!({ "user_id": r.user_id, "wrapped_key": r.wrapped_key }),
            });
    }
    Ok(Json(
        json!({ "shares": out.into_values().collect::<Vec<_>>() }),
    ))
}

#[cfg(all(test, feature = "db-tests"))]
mod db_tests {
    use super::*;
    use crate::test_support::{call, create_user, test_db, test_state, TestDb};
    use axum::http::Method;

    async fn app() -> (Router, sqlx::PgPool, TestDb) {
        let db = test_db().await;
        let pool = db.pool.clone();
        let app = router()
            .merge(crate::routes::collections::router())
            .merge(crate::routes::teams::router())
            .merge(crate::routes::vault::router())
            .with_state(test_state(pool.clone()));
        (app, pool, db)
    }

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

    /// One of `owner`'s vault items.
    async fn item(db: &sqlx::PgPool, owner: Uuid) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO vault_items (id, owner_id, encrypted_item) VALUES ($1, $2, 'x')")
            .bind(id)
            .bind(owner)
            .execute(db)
            .await
            .unwrap();
        id
    }

    async fn share(
        app: &Router,
        owner: Uuid,
        item_id: Uuid,
        whole: bool,
        grants: Value,
    ) -> (StatusCode, Value, Uuid) {
        let id = Uuid::new_v4();
        let (s, body) = call(app, owner, Method::POST, "/shares",
            Some(json!({ "id": id, "item_id": item_id, "whole": whole, "record": record("v1"), "grants": grants }))).await;
        (s, body, id)
    }

    async fn with_me(app: &Router, user: Uuid) -> Vec<Value> {
        let (_, b) = call(app, user, Method::GET, "/shares/with-me", None).await;
        b["shares"].as_array().cloned().unwrap_or_default()
    }

    #[tokio::test]
    async fn a_direct_share_is_listed_for_its_grantee_only() {
        let (app, db, _g) = app().await;
        let (owner, ceci, juan, outsider) = (
            create_user(&db, "team_lite").await,
            create_user(&db, "team_lite").await,
            create_user(&db, "team_lite").await,
            create_user(&db, "personal").await,
        );
        team(&db, owner, &[ceci, juan]).await;
        let it = item(&db, owner).await;
        // Not a teammate: refused.
        let (s, _, _) = share(
            &app,
            owner,
            it,
            true,
            json!([{ "user_id": outsider, "role": "view", "wrapped_key": "k" }]),
        )
        .await;
        assert_eq!(s, StatusCode::BAD_REQUEST);
        // Someone else's item: not found.
        let other = item(&db, ceci).await;
        let (s, _, _) = share(
            &app,
            owner,
            other,
            true,
            json!([{ "user_id": juan, "role": "view", "wrapped_key": "k" }]),
        )
        .await;
        assert_eq!(s, StatusCode::NOT_FOUND);

        let (s, _, sid) = share(
            &app,
            owner,
            it,
            true,
            json!([
                { "user_id": ceci, "role": "edit", "wrapped_key": "sk-for-ceci" },
                { "user_id": juan, "role": "view", "wrapped_key": "sk-for-juan" },
            ]),
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        let ceci_sees = with_me(&app, ceci).await;
        assert_eq!(ceci_sees.len(), 1);
        assert_eq!(ceci_sees[0]["id"], json!(sid));
        assert_eq!(ceci_sees[0]["role"], "edit");
        assert_eq!(
            ceci_sees[0]["via"],
            json!([{ "user_id": ceci, "wrapped_key": "sk-for-ceci" }])
        );
        assert_eq!(with_me(&app, juan).await[0]["role"], "view");
        assert!(with_me(&app, outsider).await.is_empty());
        assert!(with_me(&app, owner).await.is_empty()); // own shares are in /shares/mine
        let (_, mine) = call(&app, owner, Method::GET, "/shares/mine", None).await;
        assert_eq!(mine["shares"][0]["grants"].as_array().unwrap().len(), 2);
        assert!(mine.to_string().find("sk-for").is_none()); // keys aren't sent back
    }

    #[tokio::test]
    async fn only_whole_shares_can_be_edited_and_writes_check_the_revision() {
        let (app, db, _g) = app().await;
        let (owner, ceci, juan) = (
            create_user(&db, "team_lite").await,
            create_user(&db, "team_lite").await,
            create_user(&db, "team_lite").await,
        );
        team(&db, owner, &[ceci, juan]).await;
        let it = item(&db, owner).await;
        // A partial copy can't be given an edit grant.
        let (s, _, _) = share(
            &app,
            owner,
            it,
            false,
            json!([{ "user_id": ceci, "role": "edit", "wrapped_key": "k" }]),
        )
        .await;
        assert_eq!(s, StatusCode::BAD_REQUEST);

        let (_, created, sid) = share(
            &app,
            owner,
            it,
            true,
            json!([
                { "user_id": ceci, "role": "edit", "wrapped_key": "k1" },
                { "user_id": juan, "role": "view", "wrapped_key": "k2" },
            ]),
        )
        .await;
        let rev = created["revision"].as_i64().unwrap();
        let put = |user, base: i64, tag: &'static str| {
            let app = app.clone();
            async move {
                call(
                    &app,
                    user,
                    Method::PUT,
                    &format!("/shares/{sid}"),
                    Some(json!({ "record": record(tag), "base_revision": base })),
                )
                .await
            }
        };
        let (s, b) = put(ceci, rev, "by-ceci").await;
        assert_eq!(s, StatusCode::OK);
        let rev2 = b["revision"].as_i64().unwrap();
        // A viewer can't write; a stale base gets the current copy back.
        assert_eq!(put(juan, rev2, "by-juan").await.0, StatusCode::FORBIDDEN);
        let (s, b) = put(owner, rev, "stale").await;
        assert_eq!(s, StatusCode::CONFLICT);
        assert_eq!(b["share"]["record"]["data"]["ct"], "by-ceci");
        assert_eq!(put(owner, rev2, "by-owner").await.0, StatusCode::OK);
        // The owner sees the editor's change as a newer revision.
        let (_, mine) = call(&app, owner, Method::GET, "/shares/mine", None).await;
        assert_eq!(mine["shares"][0]["record"]["data"]["ct"], "by-owner");
    }

    #[tokio::test]
    async fn a_collection_grant_reaches_its_members_capped_by_their_role() {
        let (app, db, _g) = app().await;
        let (owner, ceci, juan, noone) = (
            create_user(&db, "team_lite").await,
            create_user(&db, "team_lite").await,
            create_user(&db, "team_lite").await,
            create_user(&db, "team_lite").await,
        );
        let t = team(&db, owner, &[ceci, juan, noone]).await;
        let cid = Uuid::new_v4();
        sqlx::query("INSERT INTO collections (id, team_id, encrypted_name) VALUES ($1, $2, 'n')")
            .bind(cid)
            .bind(t)
            .execute(&db)
            .await
            .unwrap();
        for (u, role) in [(owner, "manage"), (ceci, "edit"), (juan, "view")] {
            sqlx::query("INSERT INTO collection_members (collection_id, user_id, role, wrapped_key) VALUES ($1, $2, $3, 'ck')")
                .bind(cid)
                .bind(u)
                .bind(role)
                .execute(&db)
                .await
                .unwrap();
        }
        let it = item(&db, owner).await;
        // A non-member of the collection can't grant it.
        let theirs = item(&db, noone).await;
        let (s, _, _) = share(
            &app,
            noone,
            theirs,
            true,
            json!([{ "collection_id": cid, "role": "view", "wrapped_key": "k" }]),
        )
        .await;
        assert_eq!(s, StatusCode::NOT_FOUND);

        let (s, _, sid) = share(
            &app,
            owner,
            it,
            true,
            json!([{ "collection_id": cid, "role": "edit", "wrapped_key": "sk-under-ck" }]),
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        let c = with_me(&app, ceci).await;
        assert_eq!(
            (
                c[0]["role"].clone(),
                c[0]["via"][0]["collection_id"].clone()
            ),
            (json!("edit"), json!(cid))
        );
        assert_eq!(with_me(&app, juan).await[0]["role"], "view"); // a view member
        assert!(with_me(&app, noone).await.is_empty());
        let (s, _) = call(
            &app,
            juan,
            Method::PUT,
            &format!("/shares/{sid}"),
            Some(json!({ "record": record("x"), "base_revision": 0 })),
        )
        .await;
        assert_eq!(s, StatusCode::FORBIDDEN);
        // Leaving the collection ends the access.
        sqlx::query("DELETE FROM collection_members WHERE collection_id = $1 AND user_id = $2")
            .bind(cid)
            .bind(ceci)
            .execute(&db)
            .await
            .unwrap();
        assert!(with_me(&app, ceci).await.is_empty());
    }

    #[tokio::test]
    async fn grants_change_and_go_and_the_share_goes_with_its_last_grant() {
        let (app, db, _g) = app().await;
        let (owner, ceci, juan) = (
            create_user(&db, "team_lite").await,
            create_user(&db, "team_lite").await,
            create_user(&db, "team_lite").await,
        );
        team(&db, owner, &[ceci, juan]).await;
        let it = item(&db, owner).await;
        let (_, _, sid) = share(
            &app,
            owner,
            it,
            true,
            json!([{ "user_id": ceci, "role": "view", "wrapped_key": "k" }]),
        )
        .await;
        // Add Juan, then change Ceci to edit (same endpoint replaces the grant).
        let (s, _) = call(
            &app,
            owner,
            Method::PUT,
            &format!("/shares/{sid}/grants"),
            Some(json!({ "user_id": juan, "role": "view", "wrapped_key": "kj" })),
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        call(
            &app,
            owner,
            Method::PUT,
            &format!("/shares/{sid}/grants"),
            Some(json!({ "user_id": ceci, "role": "edit", "wrapped_key": "k2" })),
        )
        .await;
        assert_eq!(with_me(&app, ceci).await[0]["role"], "edit");
        // Someone else can't change grants; a grantee can leave.
        let (s, _) = call(
            &app,
            juan,
            Method::PUT,
            &format!("/shares/{sid}/grants"),
            Some(json!({ "user_id": juan, "role": "edit", "wrapped_key": "x" })),
        )
        .await;
        assert_eq!(s, StatusCode::NOT_FOUND);
        let (s, b) = call(
            &app,
            juan,
            Method::DELETE,
            &format!("/shares/{sid}/grants?user_id={juan}"),
            None,
        )
        .await;
        assert_eq!(
            (s, b["share_deleted"].clone()),
            (StatusCode::OK, json!(false))
        );
        let (_, b) = call(
            &app,
            owner,
            Method::DELETE,
            &format!("/shares/{sid}/grants?user_id={ceci}"),
            None,
        )
        .await;
        assert_eq!(b["share_deleted"], true);
        let (_, mine) = call(&app, owner, Method::GET, "/shares/mine", None).await;
        assert_eq!(mine["shares"], json!([]));
    }

    #[tokio::test]
    async fn deleting_the_item_or_leaving_the_team_removes_its_shares_and_grants() {
        let (app, db, _g) = app().await;
        let (owner, ceci) = (
            create_user(&db, "team_lite").await,
            create_user(&db, "team_lite").await,
        );
        let t = team(&db, owner, &[ceci]).await;
        let a = item(&db, owner).await;
        let b = item(&db, ceci).await;
        share(
            &app,
            owner,
            a,
            true,
            json!([{ "user_id": ceci, "role": "view", "wrapped_key": "k" }]),
        )
        .await;
        share(
            &app,
            ceci,
            b,
            true,
            json!([{ "user_id": owner, "role": "view", "wrapped_key": "k" }]),
        )
        .await;
        assert_eq!(with_me(&app, ceci).await.len(), 1);
        // The owner deletes item `a` from their vault: its share goes.
        let rev: i64 = sqlx::query_scalar("SELECT revision FROM vault_items WHERE id = $1")
            .bind(a)
            .fetch_one(&db)
            .await
            .unwrap();
        let (s, _) = call(
            &app,
            owner,
            Method::DELETE,
            &format!("/vault/items/{a}?base_revision={rev}"),
            None,
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        assert!(with_me(&app, ceci).await.is_empty());
        // Ceci leaves the team: what she shared there goes too.
        assert_eq!(with_me(&app, owner).await.len(), 1);
        crate::routes::teams::remove_member_atomic(&db, t, ceci)
            .await
            .unwrap();
        assert!(with_me(&app, owner).await.is_empty());
        let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM shares")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(left, 0);
    }
    #[tokio::test]
    async fn a_share_left_without_grants_goes_whatever_removed_them_but_a_role_change_keeps_it() {
        let (app, db, _g) = app().await;
        let (owner, ceci, juan) = (
            create_user(&db, "team_lite").await,
            create_user(&db, "team_lite").await,
            create_user(&db, "team_lite").await,
        );
        let t = team(&db, owner, &[ceci, juan]).await;
        // Changing the only grant's role keeps the share.
        let a = item(&db, owner).await;
        let (_, _, sid) = share(
            &app,
            owner,
            a,
            true,
            json!([{ "user_id": ceci, "role": "view", "wrapped_key": "k" }]),
        )
        .await;
        let (s, _) = call(
            &app,
            owner,
            Method::PUT,
            &format!("/shares/{sid}/grants"),
            Some(json!({ "user_id": ceci, "role": "edit", "wrapped_key": "k2" })),
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(with_me(&app, ceci).await[0]["role"], "edit");
        // Its only grantee leaves the team: the share goes.
        crate::routes::teams::remove_member_atomic(&db, t, ceci)
            .await
            .unwrap();
        let (_, mine) = call(&app, owner, Method::GET, "/shares/mine", None).await;
        assert_eq!(mine["shares"], json!([]));
        // Shared only with a collection that is then deleted: it goes too.
        let cid = Uuid::new_v4();
        sqlx::query("INSERT INTO collections (id, team_id, encrypted_name) VALUES ($1, $2, 'n')")
            .bind(cid)
            .bind(t)
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO collection_members (collection_id, user_id, role, wrapped_key) VALUES ($1, $2, 'manage', 'ck')")
            .bind(cid).bind(owner).execute(&db).await.unwrap();
        let b = item(&db, owner).await;
        let (s, _, _) = share(
            &app,
            owner,
            b,
            true,
            json!([{ "collection_id": cid, "role": "view", "wrapped_key": "k" }]),
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        let (s, _) = call(
            &app,
            owner,
            Method::DELETE,
            &format!("/collections/{cid}"),
            None,
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        let (_, mine) = call(&app, owner, Method::GET, "/shares/mine", None).await;
        assert_eq!(mine["shares"], json!([]));
        let _ = juan;
    }

    #[tokio::test]
    async fn a_share_created_while_the_owner_is_removed_from_the_team_is_refused() {
        let (app, db, _g) = app().await;
        let (owner, ceci, juan) = (
            create_user(&db, "team_lite").await,
            create_user(&db, "team_lite").await,
            create_user(&db, "team_lite").await,
        );
        let t = team(&db, owner, &[ceci, juan]).await;
        let it = item(&db, ceci).await;
        // Ceci's removal is in progress (holds the team lock).
        let mut removal = db.begin().await.unwrap();
        sqlx::query(
            "SELECT pg_advisory_xact_lock(hashtext('team_membership'), hashtext($1::text))",
        )
        .bind(t)
        .execute(&mut *removal)
        .await
        .unwrap();
        let creating = tokio::spawn({
            let app = app.clone();
            async move {
                share(
                    &app,
                    ceci,
                    it,
                    true,
                    json!([{ "user_id": juan, "role": "view", "wrapped_key": "k" }]),
                )
                .await
                .0
            }
        });
        crate::test_support::wait_for_lock_waits(&db, 1).await;
        sqlx::query("DELETE FROM team_members WHERE team_id = $1 AND user_id = $2")
            .bind(t)
            .bind(ceci)
            .execute(&mut *removal)
            .await
            .unwrap();
        removal.commit().await.unwrap();
        assert_eq!(creating.await.unwrap(), StatusCode::FORBIDDEN);
        assert!(with_me(&app, juan).await.is_empty());
    }

    #[tokio::test]
    async fn a_share_created_while_its_item_is_deleted_is_not_left_behind() {
        let (app, db, _g) = app().await;
        let (owner, ceci) = (
            create_user(&db, "team_lite").await,
            create_user(&db, "team_lite").await,
        );
        team(&db, owner, &[ceci]).await;
        let it = item(&db, owner).await;
        // The item's deletion is in progress (row locked, not committed).
        let mut deleting = db.begin().await.unwrap();
        sqlx::query("UPDATE vault_items SET deleted_at = NOW(), encrypted_item = '' WHERE id = $1")
            .bind(it)
            .execute(&mut *deleting)
            .await
            .unwrap();
        let creating = tokio::spawn({
            let app = app.clone();
            async move {
                share(
                    &app,
                    owner,
                    it,
                    true,
                    json!([{ "user_id": ceci, "role": "view", "wrapped_key": "k" }]),
                )
                .await
                .0
            }
        });
        crate::test_support::wait_for_lock_waits(&db, 1).await;
        deleting.commit().await.unwrap();
        assert_eq!(creating.await.unwrap(), StatusCode::NOT_FOUND);
        assert!(with_me(&app, ceci).await.is_empty());
    }

    #[tokio::test]
    async fn an_edit_and_the_editors_team_departure_do_not_deadlock() {
        let (app, db, _g) = app().await;
        let (owner, ceci) = (
            create_user(&db, "team_lite").await,
            create_user(&db, "team_lite").await,
        );
        let t = team(&db, owner, &[ceci]).await;
        let it = item(&db, owner).await;
        let (_, created, sid) = share(
            &app,
            owner,
            it,
            true,
            json!([{ "user_id": ceci, "role": "edit", "wrapped_key": "k" }]),
        )
        .await;
        let rev = created["revision"].as_i64().unwrap();
        let mut hold = db.begin().await.unwrap();
        sqlx::query(
            "SELECT pg_advisory_xact_lock(hashtext('team_membership'), hashtext($1::text))",
        )
        .bind(t)
        .execute(&mut *hold)
        .await
        .unwrap();
        // Ceci's edit and the owner's departure both queue on the team lock.
        let edit = tokio::spawn({
            let app = app.clone();
            async move {
                call(
                    &app,
                    ceci,
                    Method::PUT,
                    &format!("/shares/{sid}"),
                    Some(json!({ "record": record("x"), "base_revision": rev })),
                )
                .await
                .0
            }
        });
        let departure = tokio::spawn({
            let db = db.clone();
            async move { crate::routes::teams::remove_member_atomic(&db, t, owner).await }
        });
        crate::test_support::wait_for_lock_waits(&db, 2).await;
        hold.commit().await.unwrap();
        let e = edit.await.unwrap();
        assert!(
            e == StatusCode::OK || e == StatusCode::NOT_FOUND,
            "edit: {e}"
        );
        departure
            .await
            .unwrap()
            .expect("departure failed (deadlock?)");
    }
}
