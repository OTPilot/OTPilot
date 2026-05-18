use axum::{
    extract::{Path, State},
    routing::{get, post},
    Json, Router,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    error::{ApiError, Result},
    middleware::auth::AuthUser,
    routes::accounts::require_cloud_plan,
    AppState,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/devices", get(list_devices))
        .route("/devices/{device_id}/logs", get(device_logs))
        .route("/devices/{device_id}/disconnect", post(disconnect_device))
        .route("/devices/{device_id}/erase", post(erase_device))
        .route("/devices/{device_id}/ack", post(ack_device))
        .route("/devices/{device_id}/leave", post(leave_device))
}

#[derive(Serialize, sqlx::FromRow)]
struct DeviceRow {
    id: Uuid,
    device_id: String,
    name: String,
    os: String,
    browser: String,
    first_seen_at: chrono::DateTime<Utc>,
    last_seen_at: chrono::DateTime<Utc>,
    pending_action: Option<String>,
}

#[derive(Serialize, sqlx::FromRow)]
struct SyncLogRow {
    id: Uuid,
    action: String,
    accounts_count: i32,
    created_at: chrono::DateTime<Utc>,
}

#[derive(Deserialize)]
struct AckRequest {
    nonce: String,
}

async fn list_devices(
    State(state): State<AppState>,
    auth: AuthUser,
) -> Result<Json<Vec<DeviceRow>>> {
    require_cloud_plan(&state, auth.id).await?;
    let rows = sqlx::query_as::<_, DeviceRow>(
        "SELECT id, device_id, name, os, browser, first_seen_at, last_seen_at, pending_action
         FROM devices WHERE user_id = $1 ORDER BY last_seen_at DESC",
    )
    .bind(auth.id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

async fn device_logs(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(device_id): Path<String>,
) -> Result<Json<Vec<SyncLogRow>>> {
    require_cloud_plan(&state, auth.id).await?;
    let rows = sqlx::query_as::<_, SyncLogRow>(
        "SELECT id, action, accounts_count, created_at
         FROM sync_logs WHERE user_id = $1 AND device_id = $2
         ORDER BY created_at DESC LIMIT 50",
    )
    .bind(auth.id)
    .bind(&device_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

async fn disconnect_device(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(device_id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    require_cloud_plan(&state, auth.id).await?;
    let nonce = Uuid::new_v4().to_string();
    let res = sqlx::query(
        "UPDATE devices SET pending_action = 'disconnect', pending_nonce = $1
         WHERE user_id = $2 AND device_id = $3",
    )
    .bind(&nonce)
    .bind(auth.id)
    .bind(&device_id)
    .execute(&state.db)
    .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::NotFound);
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn erase_device(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(device_id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    require_cloud_plan(&state, auth.id).await?;
    let nonce = Uuid::new_v4().to_string();
    let res = sqlx::query(
        "UPDATE devices SET pending_action = 'erase', pending_nonce = $1
         WHERE user_id = $2 AND device_id = $3",
    )
    .bind(&nonce)
    .bind(auth.id)
    .bind(&device_id)
    .execute(&state.db)
    .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::NotFound);
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn leave_device(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(device_id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    sqlx::query("DELETE FROM devices WHERE user_id = $1 AND device_id = $2")
        .bind(auth.id)
        .bind(&device_id)
        .execute(&state.db)
        .await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn ack_device(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(device_id): Path<String>,
    Json(body): Json<AckRequest>,
) -> Result<Json<serde_json::Value>> {
    require_cloud_plan(&state, auth.id).await?;
    let nonce_matches: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM devices WHERE user_id = $1 AND device_id = $2 AND pending_nonce = $3)",
    )
    .bind(auth.id)
    .bind(&device_id)
    .bind(&body.nonce)
    .fetch_one(&state.db)
    .await
    .unwrap_or(false);

    if !nonce_matches {
        return Err(ApiError::Forbidden);
    }

    sqlx::query("DELETE FROM devices WHERE user_id = $1 AND device_id = $2")
        .bind(auth.id)
        .bind(&device_id)
        .execute(&state.db)
        .await?;

    Ok(Json(serde_json::json!({ "ok": true })))
}
