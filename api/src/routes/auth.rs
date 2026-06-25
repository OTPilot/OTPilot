use axum::{
    extract::State,
    http::StatusCode,
    routing::{delete, post},
    Json, Router,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::{error::Result, middleware::auth::AuthUser, AppState};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/auth/sync-user", post(sync_user))
        .route("/users/me", delete(delete_user))
}

#[derive(Serialize, sqlx::FromRow)]
struct SyncUserResponse {
    id: uuid::Uuid,
    plan: String,
    created_at: chrono::DateTime<Utc>,
    last_sync_at: Option<chrono::DateTime<Utc>>,
    accounts_count: i32,
    syncs_this_month: i64,
    devices_count: i64,
}

#[derive(Deserialize, Default)]
struct SyncUserRequest {
    #[serde(default)]
    device_id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    os: Option<String>,
    #[serde(default)]
    browser: Option<String>,
    /// ECDH P-256 public key (SPKI base64) for team shared-code key wrapping.
    #[serde(default)]
    public_key: Option<String>,
}

/// Called by the extension after login to ensure a `users` row exists.
async fn sync_user(
    State(state): State<AppState>,
    auth: AuthUser,
    raw: axum::body::Bytes,
) -> Result<Json<SyncUserResponse>> {
    let body: SyncUserRequest = serde_json::from_slice(&raw).unwrap_or_default();

    let insert = sqlx::query(
        r#"
        INSERT INTO users (id, plan, created_at)
        VALUES ($1, 'free', $2)
        ON CONFLICT (id) DO NOTHING
        "#,
    )
    .bind(auth.id)
    .bind(Utc::now())
    .execute(&state.db)
    .await?;

    // rows_affected == 1 means the row was just inserted → brand-new account.
    let is_new_user = insert.rows_affected() == 1;
    if is_new_user {
        if let Some(email) = auth.email.as_deref() {
            crate::email::send_welcome_email(
                state.send_emails,
                state.resend_api_key.as_deref(),
                &state.from_email,
                email,
            )
            .await;
        }
    }

    // Persist the email (from the JWT) so team features can show it.
    if let Some(email) = auth.email.as_deref() {
        let _ = sqlx::query("UPDATE users SET email = $1 WHERE id = $2")
            .bind(email)
            .bind(auth.id)
            .execute(&state.db)
            .await;
    }

    // Store/refresh the user's public key (for team shared-code key wrapping).
    if let Some(pk) = body.public_key.as_deref() {
        let _ = sqlx::query("UPDATE users SET public_key = $1 WHERE id = $2")
            .bind(pk)
            .bind(auth.id)
            .execute(&state.db)
            .await;
    }

    // Auto-accept a pending team invite addressed to this user's email (e.g. a
    // brand-new account created from an invite link) when not already in a team.
    if let Some(email) = auth.email.as_deref() {
        let already_member: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM team_members WHERE user_id = $1)")
                .bind(auth.id)
                .fetch_one(&state.db)
                .await
                .unwrap_or(true);
        if !already_member {
            let token: Option<String> = sqlx::query_scalar(
                r#"
                SELECT token FROM pending_invites
                WHERE lower(email) = lower($1) AND accepted_at IS NULL AND expires_at > NOW()
                ORDER BY created_at DESC LIMIT 1
                "#,
            )
            .bind(email)
            .fetch_optional(&state.db)
            .await
            .unwrap_or(None);
            if let Some(token) = token {
                let _ =
                    crate::routes::teams::accept_invite_inner(&state.db, &token, auth.id, email)
                        .await;
            }
        }
    }

    let plan: String = sqlx::query_scalar("SELECT plan FROM users WHERE id = $1")
        .bind(auth.id)
        .fetch_one(&state.db)
        .await
        .unwrap_or_else(|_| "free".to_string());

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

        // Skip on the first device of a brand-new account — that user just got
        // the welcome email; this notice is for new devices on existing accounts.
        if is_new && !is_new_user {
            if let Some(email) = auth.email.as_deref() {
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

    let user = sqlx::query_as::<_, SyncUserResponse>(
        r#"
        SELECT
            u.id, u.plan, u.created_at,
            (SELECT updated_at FROM accounts WHERE user_id = u.id) AS last_sync_at,
            COALESCE((
                SELECT accounts_count FROM sync_logs
                WHERE user_id = u.id ORDER BY created_at DESC LIMIT 1
            ), 0) AS accounts_count,
            (SELECT COUNT(*) FROM sync_logs
             WHERE user_id = u.id
               AND created_at >= date_trunc('month', NOW())) AS syncs_this_month,
            (SELECT COUNT(*) FROM devices WHERE user_id = u.id) AS devices_count
        FROM users u
        WHERE u.id = $1
        "#,
    )
    .bind(auth.id)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(user))
}

async fn delete_user(State(state): State<AppState>, auth: AuthUser) -> Result<StatusCode> {
    // Mark for deletion first. If the DELETE below fails after Supabase succeeds,
    // the flag survives and the startup cleanup in main() finishes the job.
    sqlx::query("UPDATE users SET pending_deletion_at = NOW() WHERE id = $1")
        .bind(auth.id)
        .execute(&state.db)
        .await?;

    let url = format!("{}/auth/v1/admin/users/{}", state.supabase_url, auth.id);
    let sb_res = reqwest::Client::new()
        .delete(&url)
        .header("apikey", &state.supabase_service_key)
        .bearer_auth(&state.supabase_service_key)
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("Supabase request failed: {e}"))?;

    if !sb_res.status().is_success() {
        // Supabase deletion failed — clear the flag so the user can retry.
        let _ = sqlx::query("UPDATE users SET pending_deletion_at = NULL WHERE id = $1")
            .bind(auth.id)
            .execute(&state.db)
            .await;
        let status = sb_res.status();
        return Err(anyhow::anyhow!("Supabase deletion returned {status}").into());
    }

    // Supabase user is gone — remove DB row (CASCADE handles the rest).
    // Fire-and-forget: if this fails the startup cleanup will finish it.
    let _ = sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(auth.id)
        .execute(&state.db)
        .await;

    Ok(StatusCode::NO_CONTENT)
}
