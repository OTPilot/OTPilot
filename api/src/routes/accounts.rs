use axum::{
    extract::{Query, State},
    routing::get,
    Json, Router,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    error::{ApiError, Result},
    middleware::auth::AuthUser,
    AppState,
};

pub fn router() -> Router<AppState> {
    Router::new().route("/accounts", get(get_accounts).put(put_accounts))
}

#[derive(sqlx::FromRow)]
struct AccountRow {
    encrypted_blob: String,
    updated_at: chrono::DateTime<Utc>,
}

#[derive(sqlx::FromRow)]
struct AccountTimestampRow {
    updated_at: chrono::DateTime<Utc>,
}

#[derive(sqlx::FromRow)]
struct UserPlanRow {
    plan: String,
}

#[derive(sqlx::FromRow)]
struct PendingCmdRow {
    pending_action: String,
    pending_nonce: String,
}

#[derive(Deserialize)]
struct GetAccountsParams {
    device_id: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct PutAccountsRequest {
    encrypted_blob: String,
    /// Client's local updated_at — used for last-write-wins conflict resolution.
    updated_at: chrono::DateTime<Utc>,
    #[serde(default)]
    device_id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    os: Option<String>,
    #[serde(default)]
    browser: Option<String>,
    #[serde(default)]
    accounts_count: Option<i32>,
}

async fn get_accounts(
    State(state): State<AppState>,
    auth: AuthUser,
    Query(params): Query<GetAccountsParams>,
) -> Result<Json<Value>> {
    require_cloud_plan(&state, auth.id).await?;

    let row = sqlx::query_as::<_, AccountRow>(
        "SELECT encrypted_blob, updated_at FROM accounts WHERE user_id = $1",
    )
    .bind(auth.id)
    .fetch_optional(&state.db)
    .await?;

    let command = pending_command(&state.db, auth.id, params.device_id.as_deref()).await;

    match row {
        Some(r) => Ok(Json(json!({
            "encrypted_blob": r.encrypted_blob,
            "updated_at": r.updated_at,
            "command": command,
        }))),
        None => {
            if let Some(cmd) = command {
                Ok(Json(json!({ "command": cmd })))
            } else {
                Ok(Json(json!(null)))
            }
        }
    }
}

async fn put_accounts(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(body): Json<PutAccountsRequest>,
) -> Result<Json<Value>> {
    require_cloud_plan(&state, auth.id).await?;

    // Last-write-wins: only update if incoming timestamp is newer than stored.
    let existing = sqlx::query_as::<_, AccountTimestampRow>(
        "SELECT updated_at FROM accounts WHERE user_id = $1",
    )
    .bind(auth.id)
    .fetch_optional(&state.db)
    .await?;

    if let Some(row) = existing {
        if body.updated_at <= row.updated_at {
            // Client is behind — return current server state so client can merge.
            let current = sqlx::query_as::<_, AccountRow>(
                "SELECT encrypted_blob, updated_at FROM accounts WHERE user_id = $1",
            )
            .bind(auth.id)
            .fetch_one(&state.db)
            .await?;
            return Ok(Json(json!({
                "conflict": true,
                "encrypted_blob": current.encrypted_blob,
                "updated_at": current.updated_at,
            })));
        }
    }

    sqlx::query(
        r#"
        INSERT INTO accounts (user_id, encrypted_blob, updated_at)
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id) DO UPDATE
        SET encrypted_blob = EXCLUDED.encrypted_blob,
            updated_at     = EXCLUDED.updated_at
        "#,
    )
    .bind(auth.id)
    .bind(&body.encrypted_blob)
    .bind(body.updated_at)
    .execute(&state.db)
    .await?;

    if let (Some(device_id), Some(name), Some(os), Some(browser)) = (
        body.device_id.as_deref(),
        body.name.as_deref(),
        body.os.as_deref(),
        body.browser.as_deref(),
    ) {
        let is_new: bool = sqlx::query_scalar(
            "SELECT NOT EXISTS(SELECT 1 FROM devices WHERE user_id = $1 AND device_id = $2)",
        )
        .bind(auth.id)
        .bind(device_id)
        .fetch_one(&state.db)
        .await
        .unwrap_or(false);

        let _ = sqlx::query(
            r#"
            INSERT INTO devices (user_id, device_id, name, os, browser)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (user_id, device_id) DO UPDATE
            SET name = EXCLUDED.name, os = EXCLUDED.os, browser = EXCLUDED.browser,
                last_seen_at = NOW()
            "#,
        )
        .bind(auth.id)
        .bind(device_id)
        .bind(name)
        .bind(os)
        .bind(browser)
        .execute(&state.db)
        .await;

        let _ = sqlx::query(
            "INSERT INTO sync_logs (user_id, device_id, action, accounts_count) VALUES ($1, $2, 'push', $3)",
        )
        .bind(auth.id)
        .bind(device_id)
        .bind(body.accounts_count.unwrap_or(0))
        .execute(&state.db)
        .await;

        if is_new {
            if let Some(email) = auth.email.as_deref() {
                let plan: String = sqlx::query_scalar("SELECT plan FROM users WHERE id = $1")
                    .bind(auth.id)
                    .fetch_one(&state.db)
                    .await
                    .unwrap_or_else(|_| "free".to_string());
                crate::email::send_new_device_email(
                    state.send_emails,
                    state.resend_api_key.as_deref(),
                    &state.from_email,
                    email,
                    name,
                    &plan,
                )
                .await;
            }
        }
    }

    let command = pending_command(&state.db, auth.id, body.device_id.as_deref()).await;

    Ok(Json(json!({
        "conflict": false,
        "updated_at": body.updated_at,
        "command": command,
    })))
}

async fn pending_command(
    db: &sqlx::PgPool,
    user_id: uuid::Uuid,
    device_id: Option<&str>,
) -> Option<Value> {
    let device_id = device_id?;
    sqlx::query_as::<_, PendingCmdRow>(
        "SELECT pending_action, pending_nonce FROM devices
         WHERE user_id = $1 AND device_id = $2 AND pending_action IS NOT NULL",
    )
    .bind(user_id)
    .bind(device_id)
    .fetch_optional(db)
    .await
    .ok()
    .flatten()
    .map(|r| json!({ "action": r.pending_action, "nonce": r.pending_nonce }))
}

/// Checks that the user has a plan that allows cloud sync (personal or team).
pub(crate) async fn require_cloud_plan(state: &AppState, user_id: uuid::Uuid) -> Result<()> {
    let user = sqlx::query_as::<_, UserPlanRow>("SELECT plan FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or(ApiError::Unauthorized)?;

    if !matches!(user.plan.as_str(), "personal" | "team_lite" | "team_pro") {
        return Err(ApiError::Forbidden);
    }
    Ok(())
}
