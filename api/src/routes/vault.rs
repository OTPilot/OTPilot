//! 2.0 vault sync: one encrypted record per item, pulled incrementally by a
//! global revision number. The server never sees plaintext — `record` is the
//! client's `{ v, key, data }` ciphertext envelope (see extension/vaultCrypto.js),
//! stored as-is. These endpoints serve personal items (no collection_id);
//! team collection items go through routes/collections.rs.

use axum::{
    extract::{DefaultBodyLimit, Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    error::{ApiError, Result},
    middleware::auth::AuthUser,
    routes::accounts::require_cloud_plan,
    AppState,
};

/// Max size of one serialized record (~64 KB of item JSON once encrypted and
/// base64-encoded, plus envelope overhead).
pub(crate) const MAX_RECORD_BYTES: usize = 128 * 1024;
const MAX_BATCH: usize = 500;
/// Request body cap for a batch. Clients split uploads by count (MAX_BATCH)
/// and by size, so a full vault goes up in several batches.
const MAX_BATCH_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const PAGE_SIZE: i64 = 1000;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/vault/items", get(list_items))
        .route(
            "/vault/items/batch",
            post(create_batch).layer(DefaultBodyLimit::max(MAX_BATCH_BYTES)),
        )
        .route("/vault/items/{id}", put(put_item).delete(delete_item))
}

#[derive(sqlx::FromRow)]
pub(crate) struct ItemRow {
    pub(crate) id: Uuid,
    pub(crate) encrypted_item: String,
    pub(crate) revision: i64,
    pub(crate) deleted_at: Option<DateTime<Utc>>,
    pub(crate) updated_at: DateTime<Utc>,
}

#[derive(sqlx::FromRow)]
struct LockedRow {
    owner_id: Option<Uuid>,
    collection_id: Option<Uuid>,
    revision: i64,
}

pub(crate) fn item_json(r: &ItemRow) -> Value {
    json!({
        "id": r.id,
        "record": if r.deleted_at.is_some() { Value::Null } else {
            serde_json::from_str::<Value>(&r.encrypted_item).unwrap_or(Value::Null)
        },
        "revision": r.revision,
        "deleted": r.deleted_at.is_some(),
        "updated_at": r.updated_at,
    })
}

/// Checks the envelope shape and size without looking inside the ciphertext.
/// Returns the record serialized for storage.
pub(crate) fn validate_record(record: &Value) -> Result<String> {
    let ok_box = |b: &Value| {
        b.get("iv").and_then(Value::as_str).is_some()
            && b.get("ct").and_then(Value::as_str).is_some()
    };
    let shape_ok = record.get("v").and_then(Value::as_i64).is_some()
        && record.get("key").is_some_and(ok_box)
        && record.get("data").is_some_and(ok_box);
    if !shape_ok {
        return Err(ApiError::BadRequest(
            "record must be { v, key: {iv, ct}, data: {iv, ct} }".into(),
        ));
    }
    let s = serde_json::to_string(record).map_err(|e| ApiError::Internal(e.into()))?;
    if s.len() > MAX_RECORD_BYTES {
        return Err(ApiError::BadRequest("record too large".into()));
    }
    Ok(s)
}

pub(crate) fn conflict(current: Option<&ItemRow>) -> Response {
    (
        StatusCode::CONFLICT,
        Json(json!({ "error": "revision conflict", "item": current.map(item_json) })),
    )
        .into_response()
}

/// Starts a write transaction holding a per-owner advisory lock until commit.
///
/// `revision` comes from `nextval`, which is assigned at write time, not at
/// commit. Without this lock two writes by the same owner could take N and
/// N+1 and commit N+1 first; a pull in between would move the client's cursor
/// past N, and N would never be pulled. Serializing an owner's writes makes
/// their revisions commit in order. (Readers filter by owner, so other owners'
/// interleaving doesn't matter.)
async fn begin_owner_tx(
    state: &AppState,
    owner: Uuid,
) -> Result<sqlx::Transaction<'static, sqlx::Postgres>> {
    let mut owner_tx = state.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext('vault_items'), hashtext($1::text))")
        .bind(owner)
        .execute(&mut *owner_tx)
        .await?;
    Ok(owner_tx)
}

/// Marks the user as on the 2.0 vault, inside the write's transaction so the
/// flag and the items can't disagree.
async fn mark_migrated(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: Uuid,
) -> Result<()> {
    sqlx::query("UPDATE users SET vault_version = 2 WHERE id = $1 AND vault_version < 2")
        .bind(user_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

#[derive(Deserialize)]
struct ListParams {
    #[serde(default)]
    since: i64,
}

/// Items (including deletions) with a revision greater than `since`, oldest
/// first, a page at a time. `more` tells the client to ask again from
/// `revision`.
async fn list_items(
    State(state): State<AppState>,
    auth: AuthUser,
    Query(params): Query<ListParams>,
) -> Result<Json<Value>> {
    require_cloud_plan(&state, auth.id).await?;
    let mut rows = sqlx::query_as::<_, ItemRow>(
        "SELECT id, encrypted_item, revision, deleted_at, updated_at FROM vault_items
         WHERE owner_id = $1 AND collection_id IS NULL AND revision > $2 ORDER BY revision LIMIT $3",
    )
    .bind(auth.id)
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
    /// Revision the client last saw for this item; None when creating it.
    #[serde(default)]
    base_revision: Option<i64>,
    #[serde(default = "default_true")]
    counts_for_limit: bool,
}

fn default_true() -> bool {
    true
}

/// Creates or updates one item. Updates must name the revision they're based
/// on; if the server has moved on, it answers 409 with its current version so
/// the client can merge.
async fn put_item(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<Uuid>,
    Json(body): Json<PutItemRequest>,
) -> Result<Response> {
    require_cloud_plan(&state, auth.id).await?;
    let record = validate_record(&body.record)?;

    let mut tx = begin_owner_tx(&state, auth.id).await?;
    let existing = sqlx::query_as::<_, LockedRow>(
        "SELECT owner_id, collection_id, revision FROM vault_items WHERE id = $1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;

    let revision: Option<i64> = match existing {
        // Another user's id, or a collection item: answer as if it didn't
        // exist, without touching it.
        Some(row) if row.owner_id != Some(auth.id) || row.collection_id.is_some() => {
            return Err(ApiError::NotFound)
        }
        Some(row) => {
            if body.base_revision != Some(row.revision) {
                let current = current_row(&mut tx, id).await?;
                return Ok(conflict(current.as_ref()));
            }
            sqlx::query_scalar(
                "UPDATE vault_items
                 SET encrypted_item = $2, counts_for_limit = $3, deleted_at = NULL,
                     revision = nextval('vault_revision_seq'), updated_at = NOW()
                 WHERE id = $1 RETURNING revision",
            )
            .bind(id)
            .bind(&record)
            .bind(body.counts_for_limit)
            .fetch_optional(&mut *tx)
            .await?
        }
        // ON CONFLICT covers two devices creating the same id at once.
        None => {
            sqlx::query_scalar(
                "INSERT INTO vault_items (id, owner_id, encrypted_item, counts_for_limit)
                 VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING RETURNING revision",
            )
            .bind(id)
            .bind(auth.id)
            .bind(&record)
            .bind(body.counts_for_limit)
            .fetch_optional(&mut *tx)
            .await?
        }
    };

    let Some(revision) = revision else {
        tx.rollback().await?;
        let current = sqlx::query_as::<_, ItemRow>(
            "SELECT id, encrypted_item, revision, deleted_at, updated_at FROM vault_items
             WHERE id = $1 AND owner_id = $2 AND collection_id IS NULL",
        )
        .bind(id)
        .bind(auth.id)
        .fetch_optional(&state.db)
        .await?;
        return match current {
            Some(row) => Ok(conflict(Some(&row))),
            None => Err(ApiError::NotFound),
        };
    };
    mark_migrated(&mut tx, auth.id).await?;
    tx.commit().await?;
    Ok(Json(json!({ "id": id, "revision": revision })).into_response())
}

async fn current_row(
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

#[derive(Deserialize)]
struct DeleteParams {
    base_revision: i64,
}

/// Soft delete: the row stays as a tombstone (no ciphertext) with a new
/// revision, so other devices learn about the deletion on their next pull.
async fn delete_item(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<Uuid>,
    Query(params): Query<DeleteParams>,
) -> Result<Response> {
    require_cloud_plan(&state, auth.id).await?;
    let mut tx = begin_owner_tx(&state, auth.id).await?;
    let existing = sqlx::query_as::<_, LockedRow>(
        "SELECT owner_id, collection_id, revision FROM vault_items WHERE id = $1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    match existing {
        Some(row) if row.owner_id == Some(auth.id) && row.collection_id.is_none() => {
            if row.revision != params.base_revision {
                let current = current_row(&mut tx, id).await?;
                return Ok(conflict(current.as_ref()));
            }
        }
        _ => return Err(ApiError::NotFound),
    }
    let revision: i64 = sqlx::query_scalar(
        "UPDATE vault_items
         SET encrypted_item = '', deleted_at = NOW(),
             revision = nextval('vault_revision_seq'), updated_at = NOW()
         WHERE id = $1 RETURNING revision",
    )
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    // Its shared copies go with it (docs/sharing.md).
    sqlx::query("DELETE FROM shares WHERE owner_id = $1 AND item_id = $2")
        .bind(auth.id)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(json!({ "id": id, "revision": revision })).into_response())
}

#[derive(Deserialize)]
struct BatchItem {
    id: Uuid,
    record: Value,
    #[serde(default = "default_true")]
    counts_for_limit: bool,
}

#[derive(Deserialize)]
struct BatchRequest {
    items: Vec<BatchItem>,
}

/// Creates many new items at once (the v1 migration, imports). Ids that
/// already exist are never overwritten — they come back in `conflicts` for the
/// client to resolve through the single-item endpoint.
async fn create_batch(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(body): Json<BatchRequest>,
) -> Result<Json<Value>> {
    require_cloud_plan(&state, auth.id).await?;
    if body.items.len() > MAX_BATCH {
        return Err(ApiError::BadRequest(format!(
            "at most {MAX_BATCH} items per batch"
        )));
    }
    let records = body
        .items
        .iter()
        .map(|i| validate_record(&i.record))
        .collect::<Result<Vec<_>>>()?;

    let mut tx = begin_owner_tx(&state, auth.id).await?;
    let mut created = Vec::new();
    let mut conflicts = Vec::new();
    for (item, record) in body.items.iter().zip(&records) {
        let revision: Option<i64> = sqlx::query_scalar(
            "INSERT INTO vault_items (id, owner_id, encrypted_item, counts_for_limit)
             VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING RETURNING revision",
        )
        .bind(item.id)
        .bind(auth.id)
        .bind(record)
        .bind(item.counts_for_limit)
        .fetch_optional(&mut *tx)
        .await?;
        match revision {
            Some(revision) => created.push(json!({ "id": item.id, "revision": revision })),
            None => conflicts.push(item.id),
        }
    }
    if !created.is_empty() {
        mark_migrated(&mut tx, auth.id).await?;
    }
    tx.commit().await?;
    Ok(Json(json!({ "created": created, "conflicts": conflicts })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record() -> Value {
        json!({ "id": "x", "v": 2, "key": { "iv": "aXY=", "ct": "Y3Q=" }, "data": { "iv": "aXY=", "ct": "Y3Q=" } })
    }

    #[test]
    fn accepts_a_well_formed_envelope() {
        assert!(validate_record(&record()).is_ok());
    }

    #[test]
    fn rejects_envelopes_missing_parts() {
        for broken in [
            json!({ "v": 2, "key": { "iv": "a", "ct": "b" } }),
            json!({ "v": "2", "key": { "iv": "a", "ct": "b" }, "data": { "iv": "a", "ct": "b" } }),
            json!({ "v": 2, "key": { "iv": "a" }, "data": { "iv": "a", "ct": "b" } }),
            json!("just a string"),
        ] {
            assert!(validate_record(&broken).is_err(), "{broken}");
        }
    }

    #[test]
    fn rejects_oversized_records() {
        let mut r = record();
        r["data"]["ct"] = json!("A".repeat(MAX_RECORD_BYTES));
        assert!(validate_record(&r).is_err());
    }
}

/// End-to-end tests of the vault endpoints against a real Postgres, through
/// the router and the JWT extractor. `cargo test --features db-tests`
/// (needs DATABASE_URL; CI provides a service container).
#[cfg(all(test, feature = "db-tests"))]
mod db_tests {
    use super::*;
    use crate::test_support::{call, create_user, test_db, test_state, TestDb};
    use axum::http::Method;

    fn record(tag: &str) -> Value {
        json!({ "v": 2, "key": { "iv": "aXY=", "ct": "a2V5" }, "data": { "iv": "aXY=", "ct": tag } })
    }

    // Keep the returned TestDb alive for the whole test: dropping it drops the
    // database.
    async fn app() -> (Router, sqlx::PgPool, TestDb) {
        let db = test_db().await;
        let pool = db.pool.clone();
        (router().with_state(test_state(pool.clone())), pool, db)
    }

    #[tokio::test]
    async fn create_update_and_conflict() {
        let (app, db, _guard) = app().await;
        let user = create_user(&db, "personal").await;
        let id = Uuid::new_v4();
        let uri = format!("/vault/items/{id}");

        let (s, created) = call(
            &app,
            user,
            Method::PUT,
            &uri,
            Some(json!({ "record": record("a") })),
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        let rev1 = created["revision"].as_i64().unwrap();

        // An update must name the revision it's based on.
        let (s, body) = call(
            &app,
            user,
            Method::PUT,
            &uri,
            Some(json!({ "record": record("b") })),
        )
        .await;
        assert_eq!(s, StatusCode::CONFLICT);
        assert_eq!(body["item"]["revision"], rev1);

        let (s, updated) = call(
            &app,
            user,
            Method::PUT,
            &uri,
            Some(json!({ "record": record("b"), "base_revision": rev1 })),
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        let rev2 = updated["revision"].as_i64().unwrap();
        assert!(rev2 > rev1);

        // A stale base revision is refused and returns the server's version.
        let (s, body) = call(
            &app,
            user,
            Method::PUT,
            &uri,
            Some(json!({ "record": record("c"), "base_revision": rev1 })),
        )
        .await;
        assert_eq!(s, StatusCode::CONFLICT);
        assert_eq!(body["item"]["record"]["data"]["ct"], "b");
    }

    #[tokio::test]
    async fn another_users_item_is_invisible_and_untouched() {
        let (app, db, _guard) = app().await;
        let alice = create_user(&db, "personal").await;
        let mallory = create_user(&db, "personal").await;
        let id = Uuid::new_v4();
        let uri = format!("/vault/items/{id}");
        call(
            &app,
            alice,
            Method::PUT,
            &uri,
            Some(json!({ "record": record("alice") })),
        )
        .await;

        let (s, _) = call(
            &app,
            mallory,
            Method::PUT,
            &uri,
            Some(json!({ "record": record("mallory"), "base_revision": 1 })),
        )
        .await;
        assert_eq!(s, StatusCode::NOT_FOUND);
        let (s, _) = call(
            &app,
            mallory,
            Method::DELETE,
            &format!("{uri}?base_revision=1"),
            None,
        )
        .await;
        assert_eq!(s, StatusCode::NOT_FOUND);
        let (_, list) = call(&app, mallory, Method::GET, "/vault/items", None).await;
        assert_eq!(list["items"].as_array().unwrap().len(), 0);

        let (_, list) = call(&app, alice, Method::GET, "/vault/items", None).await;
        assert_eq!(list["items"][0]["record"]["data"]["ct"], "alice");
    }

    #[tokio::test]
    async fn incremental_pull_includes_deletions() {
        let (app, db, _guard) = app().await;
        let user = create_user(&db, "personal").await;
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let (_, ra) = call(
            &app,
            user,
            Method::PUT,
            &format!("/vault/items/{a}"),
            Some(json!({ "record": record("a") })),
        )
        .await;
        let (_, first) = call(&app, user, Method::GET, "/vault/items?since=0", None).await;
        let cursor = first["revision"].as_i64().unwrap();
        assert_eq!(first["items"].as_array().unwrap().len(), 1);

        call(
            &app,
            user,
            Method::PUT,
            &format!("/vault/items/{b}"),
            Some(json!({ "record": record("b") })),
        )
        .await;
        let rev_a = ra["revision"].as_i64().unwrap();
        let (s, _) = call(
            &app,
            user,
            Method::DELETE,
            &format!("/vault/items/{a}?base_revision={rev_a}"),
            None,
        )
        .await;
        assert_eq!(s, StatusCode::OK);

        let (_, next) = call(
            &app,
            user,
            Method::GET,
            &format!("/vault/items?since={cursor}"),
            None,
        )
        .await;
        let items = next["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        let deleted = items.iter().find(|i| i["id"] == a.to_string()).unwrap();
        assert_eq!(deleted["deleted"], true);
        assert_eq!(deleted["record"], Value::Null);
        assert_eq!(next["more"], false);
    }

    #[tokio::test]
    async fn batch_creates_new_and_reports_existing() {
        let (app, db, _guard) = app().await;
        let user = create_user(&db, "personal").await;
        let existing = Uuid::new_v4();
        call(
            &app,
            user,
            Method::PUT,
            &format!("/vault/items/{existing}"),
            Some(json!({ "record": record("old") })),
        )
        .await;
        let fresh = Uuid::new_v4();
        let (s, body) = call(
            &app,
            user,
            Method::POST,
            "/vault/items/batch",
            Some(json!({ "items": [
            { "id": fresh, "record": record("new"), "counts_for_limit": false },
            { "id": existing, "record": record("overwrite?") },
        ] })),
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(body["created"].as_array().unwrap().len(), 1);
        assert_eq!(body["conflicts"], json!([existing]));
        let (_, list) = call(&app, user, Method::GET, "/vault/items", None).await;
        let old = list["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["id"] == existing.to_string())
            .unwrap()
            .clone();
        assert_eq!(old["record"]["data"]["ct"], "old");
        let counts: bool =
            sqlx::query_scalar("SELECT counts_for_limit FROM vault_items WHERE id = $1")
                .bind(fresh)
                .fetch_one(&db)
                .await
                .unwrap();
        assert!(!counts);
        let version: i16 = sqlx::query_scalar("SELECT vault_version FROM users WHERE id = $1")
            .bind(user)
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(version, 2);
    }

    #[tokio::test]
    async fn batches_up_to_8_mib_pass_and_larger_ones_are_refused() {
        let (app, db, _guard) = app().await;
        let user = create_user(&db, "personal").await;
        // Valid records (each under MAX_RECORD_BYTES) of ~80 KiB.
        let chunk = "A".repeat(80 * 1024);
        let batch = |n: usize| -> Value {
            json!({ "items": (0..n).map(|_| json!({ "id": Uuid::new_v4(), "record": record(&chunk) })).collect::<Vec<_>>() })
        };
        // ~4 MiB: above Axum's 2 MiB default, below our 8 MiB cap.
        let (s, body) = call(
            &app,
            user,
            Method::POST,
            "/vault/items/batch",
            Some(batch(50)),
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(body["created"].as_array().unwrap().len(), 50);
        // ~9.6 MiB: over the cap.
        let (s, _) = call(
            &app,
            user,
            Method::POST,
            "/vault/items/batch",
            Some(batch(120)),
        )
        .await;
        assert_eq!(s, StatusCode::PAYLOAD_TOO_LARGE);

        let (s, _) = call(
            &app,
            user,
            Method::PUT,
            &format!("/vault/items/{}", Uuid::new_v4()),
            Some(json!({ "record": { "v": 2 } })),
        )
        .await;
        assert_eq!(s, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn free_plan_cannot_sync_the_vault() {
        let (app, db, _guard) = app().await;
        let user = create_user(&db, "free").await;
        let (s, _) = call(&app, user, Method::GET, "/vault/items", None).await;
        assert_eq!(s, StatusCode::FORBIDDEN);
        let (s, _) = call(
            &app,
            user,
            Method::PUT,
            &format!("/vault/items/{}", Uuid::new_v4()),
            Some(json!({ "record": record("x") })),
        )
        .await;
        assert_eq!(s, StatusCode::FORBIDDEN);
    }

    /// The race begin_owner_tx() prevents: a slow write takes revision N and
    /// hasn't committed when a later write takes N+1. Without the per-owner lock
    /// the later one commits first, a pull moves the cursor to N+1, and N is
    /// never pulled. Here the slow write is a manual transaction that does what
    /// a handler does (lock, then nextval) and commits only after a pull.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_pull_during_a_slow_write_never_skips_it() {
        let (app, db, _guard) = app().await;
        let user = create_user(&db, "personal").await;
        let slow = Uuid::new_v4();

        let mut tx = db.begin().await.unwrap();
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext('vault_items'), hashtext($1::text))")
            .bind(user)
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query("INSERT INTO vault_items (id, owner_id, encrypted_item) VALUES ($1, $2, $3)")
            .bind(slow)
            .bind(user)
            .bind(record("slow").to_string())
            .execute(&mut *tx)
            .await
            .unwrap();

        let later = Uuid::new_v4();
        let put = {
            let app = app.clone();
            tokio::spawn(async move {
                call(
                    &app,
                    user,
                    Method::PUT,
                    &format!("/vault/items/{later}"),
                    Some(json!({ "record": record("later") })),
                )
                .await
            })
        };
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;

        // A device pulls while the slow write is still open.
        let (_, mid) = call(&app, user, Method::GET, "/vault/items?since=0", None).await;
        let cursor = mid["revision"].as_i64().unwrap();

        tx.commit().await.unwrap();
        let (s, _) = put.await.unwrap();
        assert_eq!(s, StatusCode::OK);

        // Continuing from that cursor must still deliver both writes.
        let (_, next) = call(
            &app,
            user,
            Method::GET,
            &format!("/vault/items?since={cursor}"),
            None,
        )
        .await;
        let mut ids: Vec<String> = next["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["id"].as_str().unwrap().to_string())
            .collect();
        let pulled_mid: Vec<String> = mid["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["id"].as_str().unwrap().to_string())
            .collect();
        ids.extend(pulled_mid);
        assert!(
            ids.contains(&slow.to_string()),
            "the slow write was skipped"
        );
        assert!(ids.contains(&later.to_string()));
    }
}
