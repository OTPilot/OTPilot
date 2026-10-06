//! 2.0 vault sync: one encrypted record per item, pulled incrementally by a
//! global revision number. The server never sees plaintext — `record` is the
//! client's `{ v, key, data }` ciphertext envelope (see extension/vaultCrypto.js),
//! stored as-is. Personal items only for now; team collections come later.

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
const MAX_RECORD_BYTES: usize = 128 * 1024;
const MAX_BATCH: usize = 500;
/// Request body cap for a batch. Clients split uploads by count (MAX_BATCH)
/// and by size, so a full vault goes up in several batches.
const MAX_BATCH_BYTES: usize = 8 * 1024 * 1024;
const PAGE_SIZE: i64 = 1000;

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
struct ItemRow {
    id: Uuid,
    encrypted_item: String,
    revision: i64,
    deleted_at: Option<DateTime<Utc>>,
    updated_at: DateTime<Utc>,
}

#[derive(sqlx::FromRow)]
struct LockedRow {
    owner_id: Uuid,
    revision: i64,
}

fn item_json(r: &ItemRow) -> Value {
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
fn validate_record(record: &Value) -> Result<String> {
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

fn conflict(current: Option<&ItemRow>) -> Response {
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
         WHERE owner_id = $1 AND revision > $2 ORDER BY revision LIMIT $3",
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
        "SELECT owner_id, revision FROM vault_items WHERE id = $1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;

    let revision: Option<i64> = match existing {
        // Another user's id: answer as if it didn't exist, without touching it.
        Some(row) if row.owner_id != auth.id => return Err(ApiError::NotFound),
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
             WHERE id = $1 AND owner_id = $2",
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
        "SELECT owner_id, revision FROM vault_items WHERE id = $1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    match existing {
        Some(row) if row.owner_id == auth.id => {
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
