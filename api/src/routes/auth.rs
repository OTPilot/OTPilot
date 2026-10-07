use axum::{
    extract::State,
    http::StatusCode,
    routing::{delete, get, post},
    Json, Router,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::{
    error::{ApiError, Result},
    middleware::auth::AuthUser,
    AppState,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/auth/sync-user", post(sync_user))
        .route("/users/me", delete(delete_user))
        .route("/users/me/deletion", get(deletion_preview))
}

#[derive(Serialize, sqlx::FromRow)]
struct SyncUserResponse {
    id: uuid::Uuid,
    plan: String,
    /// Has a Personal subscription of their own (also while on a team), so
    /// the dashboard can offer to manage it.
    personal_subscription: bool,
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
            u.id, u.plan, (u.personal_subscription_id IS NOT NULL) AS personal_subscription, u.created_at,
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

#[derive(sqlx::FromRow)]
struct TeamRef {
    id: uuid::Uuid,
    name: String,
    stripe_subscription_id: Option<String>,
    members: i64,
}

/// What deleting the caller's account would do, for the confirmation
/// dialog: subscriptions cancelled now, the team they own dissolved (with how
/// many members), the team they'd leave.
async fn deletion_preview(
    State(state): State<AppState>,
    auth: AuthUser,
) -> Result<Json<serde_json::Value>> {
    let personal: Option<String> =
        sqlx::query_scalar("SELECT personal_subscription_id FROM users WHERE id = $1")
            .bind(auth.id)
            .fetch_optional(&state.db)
            .await?
            .flatten();
    let owned = owned_teams(&state.db, auth.id).await?;
    let member_of: Option<String> = sqlx::query_scalar(
        "SELECT t.name FROM teams t JOIN team_members m ON m.team_id = t.id
         WHERE m.user_id = $1 AND t.owner_id <> $1 LIMIT 1",
    )
    .bind(auth.id)
    .fetch_optional(&state.db)
    .await?;
    Ok(Json(serde_json::json!({
        "personal_subscription": personal.is_some(),
        "owned_teams": owned.iter().map(|t| serde_json::json!({
            "name": t.name, "members": t.members, "subscription": t.stripe_subscription_id.is_some(),
        })).collect::<Vec<_>>(),
        "member_of": member_of,
    })))
}

async fn owned_teams(db: &sqlx::PgPool, user: uuid::Uuid) -> Result<Vec<TeamRef>> {
    Ok(sqlx::query_as::<_, TeamRef>(
        "SELECT t.id, t.name, t.stripe_subscription_id,
                (SELECT COUNT(*) FROM team_members m WHERE m.team_id = t.id) AS members
         FROM teams t WHERE t.owner_id = $1",
    )
    .bind(user)
    .fetch_all(db)
    .await?)
}

/// Steps 1–3 of `delete_user`: billing, then teams.
async fn prepare_deletion(state: &AppState, user: uuid::Uuid) -> Result<()> {
    let personal: Option<String> =
        sqlx::query_scalar("SELECT personal_subscription_id FROM users WHERE id = $1")
            .bind(user)
            .fetch_optional(&state.db)
            .await?
            .flatten();
    let owned = owned_teams(&state.db, user).await?;
    let mut cancelled: Vec<&str> = Vec::new();
    let failed = |what: &str, cancelled: &[&str]| {
        let done = if cancelled.is_empty() {
            String::new()
        } else {
            format!(" Already cancelled: {}.", cancelled.join(", "))
        };
        ApiError::ServiceUnavailable(format!(
            "Could not cancel {what}; your account was not deleted.{done} Try again in a moment."
        ))
    };
    if let Some(sub) = personal.as_deref() {
        crate::routes::billing::cancel_subscription_now(state, sub)
            .await
            .map_err(|_| failed("your Personal subscription", &cancelled))?;
        sqlx::query("UPDATE users SET personal_subscription_id = NULL, has_personal_cloud = false WHERE id = $1")
            .bind(user)
            .execute(&state.db)
            .await?;
        cancelled.push("your Personal subscription");
    }
    for team in &owned {
        if let Some(sub) = team.stripe_subscription_id.as_deref() {
            crate::routes::billing::cancel_subscription_now(state, sub)
                .await
                .map_err(|_| failed("the team subscription", &cancelled))?;
            sqlx::query("UPDATE teams SET stripe_subscription_id = NULL WHERE id = $1")
                .bind(team.id)
                .execute(&state.db)
                .await?;
            cancelled.push("the team subscription");
        }
    }
    for team in &owned {
        crate::routes::teams::dissolve_team(&state.db, team.id).await?;
        tracing::info!(
            "team {} dissolved: its owner deleted their account",
            team.id
        );
    }
    let memberships: Vec<uuid::Uuid> =
        sqlx::query_scalar("SELECT team_id FROM team_members WHERE user_id = $1")
            .bind(user)
            .fetch_all(&state.db)
            .await?;
    for team_id in memberships {
        crate::routes::teams::remove_member_atomic(&state.db, team_id, user).await?;
    }
    Ok(())
}

/// Deletes the caller's account:
/// 0. `deletion_started_at` is set first: from then on no checkout or team
///    creation is accepted, and a checkout completing anyway cancels its
///    subscription (billing.rs webhook) — so nothing is missed below;
/// 1. every subscription they pay for is cancelled now in Stripe (Personal,
///    and the team's if they own one). Each one is recorded as cancelled as
///    soon as Stripe confirms, so if a later one fails the request stops,
///    says what was already cancelled, and a retry continues from there;
/// 2. a team they own is dissolved (members go back to Personal/Free and
///    lose its shared items; their own vaults are untouched);
/// 3. a team they belong to is left;
/// 4. the Supabase user and the database row are deleted (cascades take
///    their vault, devices, invites and shares — migration 0019).
async fn delete_user(State(state): State<AppState>, auth: AuthUser) -> Result<StatusCode> {
    sqlx::query("UPDATE users SET deletion_started_at = NOW() WHERE id = $1")
        .bind(auth.id)
        .execute(&state.db)
        .await?;
    match prepare_deletion(&state, auth.id).await {
        Ok(()) => {}
        Err(e) => {
            let _ = sqlx::query("UPDATE users SET deletion_started_at = NULL WHERE id = $1")
                .bind(auth.id)
                .execute(&state.db)
                .await;
            return Err(e);
        }
    }
    // Mark for deletion first. If the DELETE below fails after Supabase succeeds,
    // the flag survives and the startup cleanup in main() finishes the job.
    sqlx::query("UPDATE users SET pending_deletion_at = NOW() WHERE id = $1")
        .bind(auth.id)
        .execute(&state.db)
        .await?;

    let url = format!(
        "{}/auth/v1/admin/users/{}",
        state.supabase_admin_base, auth.id
    );
    let sb_res = reqwest::Client::new()
        .delete(&url)
        .header("apikey", &state.supabase_service_key)
        .bearer_auth(&state.supabase_service_key)
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("Supabase request failed: {e}"))?;

    if !sb_res.status().is_success() {
        // Supabase deletion failed — clear the flag so the user can retry.
        let _ = sqlx::query(
            "UPDATE users SET pending_deletion_at = NULL, deletion_started_at = NULL WHERE id = $1",
        )
        .bind(auth.id)
        .execute(&state.db)
        .await;
        let status = sb_res.status();
        return Err(anyhow::anyhow!("Supabase deletion returned {status}").into());
    }

    // Supabase user is gone — remove DB row (CASCADE handles the rest).
    // If this fails the startup cleanup will finish it.
    if let Err(e) = sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(auth.id)
        .execute(&state.db)
        .await
    {
        tracing::error!("deleting user row {}: {e}", auth.id);
    }

    Ok(StatusCode::NO_CONTENT)
}

#[cfg(all(test, feature = "db-tests"))]
mod db_tests {
    use super::*;
    use crate::test_support::{call, create_user, test_db, test_state, TestDb};
    use axum::http::Method;
    use std::sync::{Arc, Mutex};
    use uuid::Uuid;

    /// A local stand-in for Stripe (DELETE /v1/subscriptions/:id; ids
    /// starting with `sub_fail` answer 500) and Supabase's admin API
    /// (DELETE /auth/v1/admin/users/:id). Returns its base URL and the
    /// requests it received.
    async fn stand_in() -> (String, Arc<Mutex<Vec<String>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        let app = Router::new().fallback(move |req: axum::extract::Request| {
            let log = log.clone();
            async move {
                let path = req.uri().path().to_string();
                log.lock()
                    .unwrap()
                    .push(format!("{} {}", req.method(), path));
                if path.contains("/sub_fail") {
                    StatusCode::INTERNAL_SERVER_ERROR
                } else {
                    StatusCode::OK
                }
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (base, seen)
    }

    async fn app() -> (Router, sqlx::PgPool, TestDb, Arc<Mutex<Vec<String>>>) {
        let db = test_db().await;
        let pool = db.pool.clone();
        let (base, seen) = stand_in().await;
        let mut state = test_state(pool.clone());
        state.stripe_secret_key = "sk_test".into();
        state.stripe_api_base = base.clone();
        state.supabase_admin_base = base;
        (router().with_state(state), pool, db, seen)
    }

    async fn exists(db: &sqlx::PgPool, sql: &str, id: Uuid) -> bool {
        sqlx::query_scalar::<_, bool>(&format!("SELECT EXISTS({sql})"))
            .bind(id)
            .fetch_one(db)
            .await
            .unwrap()
    }

    /// A team owned by `owner` (subscription `sub`) with `member`; the owner
    /// shared a code with the member and invited someone.
    async fn team(db: &sqlx::PgPool, owner: Uuid, member: Uuid, sub: &str) -> Uuid {
        let t: Uuid = sqlx::query_scalar(
            "INSERT INTO teams (name, owner_id, stripe_subscription_id) VALUES ('Acme', $1, $2) RETURNING id",
        )
        .bind(owner)
        .bind(sub)
        .fetch_one(db)
        .await
        .unwrap();
        for (u, role) in [(owner, "owner"), (member, "member")] {
            sqlx::query("INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3)")
                .bind(t)
                .bind(u)
                .bind(role)
                .execute(db)
                .await
                .unwrap();
        }
        let code: Uuid = sqlx::query_scalar(
            "INSERT INTO shared_codes (owner_id, team_id, account_name, encrypted_secret, sharing_key_iv)
             VALUES ($1, $2, 'GitHub', 'x', 'y') RETURNING id",
        )
        .bind(owner).bind(t).fetch_one(db).await.unwrap();
        sqlx::query("INSERT INTO share_access (shared_code_id, user_id) VALUES ($1, $2)")
            .bind(code)
            .bind(member)
            .execute(db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO pending_invites (email, team_id, invited_by, token) VALUES ('new@x.com', $1, $2, $3)")
            .bind(t).bind(owner).bind(Uuid::new_v4().to_string()).execute(db).await.unwrap();
        t
    }

    #[tokio::test]
    async fn the_owner_deleting_their_account_cancels_billing_and_dissolves_the_team() {
        let (app, db, _g, seen) = app().await;
        let (owner, member) = (
            create_user(&db, "team_lite").await,
            create_user(&db, "team_lite").await,
        );
        sqlx::query("UPDATE users SET has_personal_cloud = true, personal_subscription_id = 'sub_personal' WHERE id = $1")
            .bind(owner).execute(&db).await.unwrap();
        let t = team(&db, owner, member, "sub_team").await;

        let (_, preview) = call(&app, owner, Method::GET, "/users/me/deletion", None).await;
        assert_eq!(preview["personal_subscription"], true);
        assert_eq!(preview["owned_teams"][0]["name"], "Acme");
        assert_eq!(preview["owned_teams"][0]["members"], 2);

        let (s, _) = call(&app, owner, Method::DELETE, "/users/me", None).await;
        assert_eq!(s, StatusCode::NO_CONTENT);
        let calls = seen.lock().unwrap().clone();
        assert!(
            calls.contains(&"DELETE /v1/subscriptions/sub_personal".to_string()),
            "{calls:?}"
        );
        assert!(
            calls.contains(&"DELETE /v1/subscriptions/sub_team".to_string()),
            "{calls:?}"
        );
        assert!(
            calls.contains(&format!("DELETE /auth/v1/admin/users/{owner}")),
            "{calls:?}"
        );

        assert!(!exists(&db, "SELECT 1 FROM users WHERE id = $1", owner).await);
        assert!(!exists(&db, "SELECT 1 FROM teams WHERE id = $1", t).await);
        let plan: String = sqlx::query_scalar("SELECT plan FROM users WHERE id = $1")
            .bind(member)
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(plan, "free");
        assert!(!exists(&db, "SELECT 1 FROM share_access WHERE user_id = $1", member).await);
    }

    #[tokio::test]
    async fn a_member_deleting_their_account_leaves_the_team_which_carries_on() {
        let (app, db, _g, seen) = app().await;
        let (owner, member) = (
            create_user(&db, "team_lite").await,
            create_user(&db, "team_lite").await,
        );
        let t = team(&db, owner, member, "sub_team").await;
        // The member shared a code of their own with the owner.
        let theirs: Uuid = sqlx::query_scalar(
            "INSERT INTO shared_codes (owner_id, team_id, account_name, encrypted_secret, sharing_key_iv)
             VALUES ($1, $2, 'AWS', 'x', 'y') RETURNING id",
        )
        .bind(member)
        .bind(t)
        .fetch_one(&db)
        .await
        .unwrap();
        sqlx::query("INSERT INTO share_access (shared_code_id, user_id) VALUES ($1, $2)")
            .bind(theirs)
            .bind(owner)
            .execute(&db)
            .await
            .unwrap();
        let (s, _) = call(&app, member, Method::DELETE, "/users/me", None).await;
        assert_eq!(s, StatusCode::NO_CONTENT);
        assert!(!seen
            .lock()
            .unwrap()
            .iter()
            .any(|c| c.contains("/v1/subscriptions/")));
        assert!(!exists(&db, "SELECT 1 FROM users WHERE id = $1", member).await);
        assert!(exists(&db, "SELECT 1 FROM teams WHERE id = $1", t).await);
        assert!(exists(&db, "SELECT 1 FROM shared_codes WHERE team_id = $1", t).await);
        // The code they shared went with them (and the owner's access to it).
        assert!(!exists(&db, "SELECT 1 FROM shared_codes WHERE id = $1", theirs).await);
    }

    #[tokio::test]
    async fn if_stripe_cannot_cancel_nothing_is_deleted() {
        let (app, db, _g, seen) = app().await;
        let (owner, member) = (
            create_user(&db, "team_lite").await,
            create_user(&db, "team_lite").await,
        );
        let t = team(&db, owner, member, "sub_fail_team").await;
        let (s, _) = call(&app, owner, Method::DELETE, "/users/me", None).await;
        assert_eq!(s, StatusCode::SERVICE_UNAVAILABLE);
        assert!(!seen
            .lock()
            .unwrap()
            .iter()
            .any(|c| c.contains("/auth/v1/admin/users/")));
        assert!(exists(&db, "SELECT 1 FROM users WHERE id = $1 AND pending_deletion_at IS NULL AND deletion_started_at IS NULL", owner).await);
        assert!(exists(&db, "SELECT 1 FROM teams WHERE id = $1", t).await);
    }

    #[tokio::test]
    async fn a_second_cancellation_failing_says_what_was_cancelled_and_a_retry_continues() {
        let (app, db, _g, seen) = app().await;
        let (owner, member) = (
            create_user(&db, "team_lite").await,
            create_user(&db, "team_lite").await,
        );
        sqlx::query("UPDATE users SET has_personal_cloud = true, personal_subscription_id = 'sub_personal' WHERE id = $1")
            .bind(owner).execute(&db).await.unwrap();
        let t = team(&db, owner, member, "sub_fail_team").await;

        let (s, body) = call(&app, owner, Method::DELETE, "/users/me", None).await;
        assert_eq!(s, StatusCode::SERVICE_UNAVAILABLE);
        let msg = body["error"].as_str().unwrap();
        assert!(
            msg.contains("Could not cancel the team subscription"),
            "{msg}"
        );
        assert!(
            msg.contains("Already cancelled: your Personal subscription"),
            "{msg}"
        );
        // Personal is recorded as cancelled; the team is untouched; the
        // account can still be used and deleted again.
        assert!(exists(&db, "SELECT 1 FROM users WHERE id = $1 AND personal_subscription_id IS NULL AND deletion_started_at IS NULL", owner).await);
        assert!(
            exists(
                &db,
                "SELECT 1 FROM teams WHERE id = $1 AND stripe_subscription_id = 'sub_fail_team'",
                t
            )
            .await
        );

        // Stripe works again: the retry only cancels what's left.
        sqlx::query("UPDATE teams SET stripe_subscription_id = 'sub_team_ok' WHERE id = $1")
            .bind(t)
            .execute(&db)
            .await
            .unwrap();
        seen.lock().unwrap().clear();
        let (s, _) = call(&app, owner, Method::DELETE, "/users/me", None).await;
        assert_eq!(s, StatusCode::NO_CONTENT);
        let calls = seen.lock().unwrap().clone();
        assert!(
            calls.contains(&"DELETE /v1/subscriptions/sub_team_ok".to_string()),
            "{calls:?}"
        );
        assert!(
            !calls.iter().any(|c| c.contains("sub_personal")),
            "{calls:?}"
        );
        assert!(!exists(&db, "SELECT 1 FROM users WHERE id = $1", owner).await);
    }

    #[tokio::test]
    async fn without_a_stripe_key_a_paid_account_is_not_deleted() {
        let db = test_db().await;
        let (base, _) = stand_in().await;
        let mut state = test_state(db.pool.clone());
        state.stripe_api_base = base.clone();
        state.supabase_admin_base = base; // stripe_secret_key stays empty
        let app = router().with_state(state);
        let user = create_user(&db.pool, "personal").await;
        sqlx::query("UPDATE users SET personal_subscription_id = 'sub_personal' WHERE id = $1")
            .bind(user)
            .execute(&db.pool)
            .await
            .unwrap();
        let (s, _) = call(&app, user, Method::DELETE, "/users/me", None).await;
        assert_eq!(s, StatusCode::SERVICE_UNAVAILABLE);
        assert!(
            exists(
                &db.pool,
                "SELECT 1 FROM users WHERE id = $1 AND personal_subscription_id = 'sub_personal'",
                user
            )
            .await
        );
    }
}
