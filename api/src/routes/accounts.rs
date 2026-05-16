use axum::{extract::State, routing::get, Json, Router};
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

#[derive(Deserialize, Serialize)]
struct PutAccountsRequest {
    encrypted_blob: String,
    /// Client's local updated_at — used for last-write-wins conflict resolution.
    updated_at: chrono::DateTime<Utc>,
}

async fn get_accounts(State(state): State<AppState>, auth: AuthUser) -> Result<Json<Value>> {
    require_cloud_plan(&state, auth.id).await?;

    let row = sqlx::query_as::<_, AccountRow>(
        "SELECT encrypted_blob, updated_at FROM accounts WHERE user_id = $1",
    )
    .bind(auth.id)
    .fetch_optional(&state.db)
    .await?;

    match row {
        Some(r) => Ok(Json(json!({
            "encrypted_blob": r.encrypted_blob,
            "updated_at": r.updated_at,
        }))),
        None => Ok(Json(json!(null))),
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

    Ok(Json(json!({
        "conflict": false,
        "updated_at": body.updated_at,
    })))
}

/// Checks that the user has a plan that allows cloud sync (personal or team).
async fn require_cloud_plan(state: &AppState, user_id: uuid::Uuid) -> Result<()> {
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
