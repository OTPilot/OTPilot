//! Teams + shared OTP codes (Team Lite).
//!
//! Shared codes use a 2-of-2 key split: the secret is encrypted client-side with
//! a key K; per recipient the server stores K2 (server_share) and an opaque
//! K1-wrapped-to-the-recipient blob (encrypted_user_share). To produce a live
//! TOTP the recipient sends K1, the server reconstructs K = K1 XOR K2, decrypts
//! the secret, generates the code, and discards K. Neither side can decrypt alone.

use axum::{
    extract::{Path, State},
    routing::{delete, get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    error::{ApiError, Result},
    middleware::auth::AuthUser,
    AppState,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/teams", post(create_team).get(get_my_team))
        .route(
            "/teams/{id}",
            get(get_team).patch(rename_team).delete(delete_team),
        )
        .route("/teams/{id}/invite", post(invite_member))
        .route("/teams/accept/{token}", post(accept_invite))
        .route("/teams/{id}/leave", delete(leave_team))
        .route("/teams/{id}/members/{uid}", delete(remove_member))
        .route("/teams/{id}/audit", get(get_audit))
        .route(
            "/teams/{id}/codes",
            post(share_code).get(list_shared_with_me),
        )
        .route("/teams/{id}/codes/mine", get(list_my_shares))
        .route("/teams/{id}/codes/{cid}", delete(revoke_code))
        .route(
            "/teams/{id}/codes/{cid}/access/{uid}",
            delete(revoke_access),
        )
        .route("/teams/{id}/codes/{cid}/totp", post(generate_totp))
}

// ── Plan helpers ──────────────────────────────────────────────────────────────

#[derive(sqlx::FromRow)]
struct PlanRow {
    plan: String,
}

async fn user_plan(db: &sqlx::PgPool, user_id: Uuid) -> Result<String> {
    let row = sqlx::query_as::<_, PlanRow>("SELECT plan FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(db)
        .await?
        .ok_or(ApiError::Unauthorized)?;
    Ok(row.plan)
}

fn is_team_plan(plan: &str) -> bool {
    matches!(plan, "team_lite" | "team_pro")
}

/// After leaving/losing a team, restore the user to 'personal' if they paid for
/// Personal Cloud, else 'free'.
pub(crate) async fn downgrade_user(db: &sqlx::PgPool, user_id: Uuid) -> Result<()> {
    sqlx::query(
        "UPDATE users SET plan = CASE WHEN has_personal_cloud THEN 'personal' ELSE 'free' END WHERE id = $1",
    )
    .bind(user_id)
    .execute(db)
    .await?;
    Ok(())
}

async fn audit(
    db: &sqlx::PgPool,
    team_id: Uuid,
    actor_id: Uuid,
    action: &str,
    target_id: Option<Uuid>,
    metadata: Value,
) {
    let _ = sqlx::query(
        "INSERT INTO audit_logs (team_id, actor_id, action, target_id, metadata) VALUES ($1,$2,$3,$4,$5)",
    )
    .bind(team_id)
    .bind(actor_id)
    .bind(action)
    .bind(target_id)
    .bind(metadata)
    .execute(db)
    .await;
}

// ── Membership / team lookup ────────────────────────────────────────────────────

#[derive(sqlx::FromRow, Serialize)]
pub(crate) struct TeamRow {
    id: Uuid,
    name: String,
    owner_id: Uuid,
    seat_limit: i32,
    stripe_subscription_id: Option<String>,
}

/// Returns the team the user owns or belongs to (1 team per owner model).
async fn find_user_team(db: &sqlx::PgPool, user_id: Uuid) -> Result<Option<TeamRow>> {
    let row = sqlx::query_as::<_, TeamRow>(
        r#"
        SELECT t.id, t.name, t.owner_id, t.seat_limit, t.stripe_subscription_id
        FROM teams t
        JOIN team_members m ON m.team_id = t.id
        WHERE m.user_id = $1
        LIMIT 1
        "#,
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    Ok(row)
}

async fn require_member(db: &sqlx::PgPool, team_id: Uuid, user_id: Uuid) -> Result<()> {
    let ok: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2)",
    )
    .bind(team_id)
    .bind(user_id)
    .fetch_one(db)
    .await?;
    if ok {
        Ok(())
    } else {
        Err(ApiError::Forbidden)
    }
}

async fn require_owner(db: &sqlx::PgPool, team_id: Uuid, user_id: Uuid) -> Result<()> {
    let owner: Option<Uuid> = sqlx::query_scalar("SELECT owner_id FROM teams WHERE id = $1")
        .bind(team_id)
        .fetch_optional(db)
        .await?;
    match owner {
        Some(o) if o == user_id => Ok(()),
        Some(_) => Err(ApiError::Forbidden),
        None => Err(ApiError::NotFound),
    }
}

// ── Team CRUD ───────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct CreateTeamRequest {
    #[serde(default)]
    name: Option<String>,
}

/// Idempotent: if the user already has a team, returns it. Requires a team plan
/// (set by the Stripe team-subscription webhook). Primarily a dev/manual path —
/// in production the team is auto-created by the webhook.
async fn create_team(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(body): Json<CreateTeamRequest>,
) -> Result<Json<Value>> {
    if let Some(existing) = find_user_team(&state.db, auth.id).await? {
        return Ok(Json(json!(existing)));
    }
    let plan = user_plan(&state.db, auth.id).await?;
    if !is_team_plan(&plan) {
        return Err(ApiError::Forbidden);
    }
    let name = body.name.unwrap_or_else(|| "My Team".to_string());
    let team = create_team_row(&state.db, auth.id, &name, None).await?;
    Ok(Json(json!(team)))
}

/// Creates a team + adds the owner as a member. Shared by create_team and the
/// billing webhook. Caller is responsible for the "1 team per owner" check.
pub(crate) async fn create_team_row(
    db: &sqlx::PgPool,
    owner_id: Uuid,
    name: &str,
    stripe_subscription_id: Option<&str>,
) -> Result<TeamRow> {
    let team = sqlx::query_as::<_, TeamRow>(
        r#"
        INSERT INTO teams (name, owner_id, stripe_subscription_id)
        VALUES ($1, $2, $3)
        RETURNING id, name, owner_id, seat_limit, stripe_subscription_id
        "#,
    )
    .bind(name)
    .bind(owner_id)
    .bind(stripe_subscription_id)
    .fetch_one(db)
    .await?;

    sqlx::query(
        "INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING",
    )
    .bind(team.id)
    .bind(owner_id)
    .execute(db)
    .await?;

    Ok(team)
}

#[derive(sqlx::FromRow, Serialize)]
struct MemberRow {
    user_id: Uuid,
    email: Option<String>,
    role: String,
    joined_at: chrono::DateTime<chrono::Utc>,
    /// Recipient's ECDH public key, needed to wrap a shared-code user share to them.
    public_key: Option<String>,
}

async fn get_my_team(State(state): State<AppState>, auth: AuthUser) -> Result<Json<Value>> {
    match find_user_team(&state.db, auth.id).await? {
        Some(t) => Ok(Json(json!(t))),
        None => Ok(Json(json!(null))),
    }
}

async fn get_team(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    require_member(&state.db, id, auth.id).await?;
    let team = sqlx::query_as::<_, TeamRow>(
        "SELECT id, name, owner_id, seat_limit, stripe_subscription_id FROM teams WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(ApiError::NotFound)?;

    let members = sqlx::query_as::<_, MemberRow>(
        r#"
        SELECT m.user_id, u.email, m.role, m.joined_at, u.public_key
        FROM team_members m JOIN users u ON u.id = m.user_id
        WHERE m.team_id = $1 ORDER BY m.joined_at
        "#,
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;

    let used_seats: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM team_members WHERE team_id = $1")
            .bind(id)
            .fetch_one(&state.db)
            .await?;

    Ok(Json(json!({
        "team": team,
        "members": members,
        "used_seats": used_seats,
    })))
}

#[derive(Deserialize)]
struct RenameRequest {
    name: String,
}

async fn rename_team(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<Uuid>,
    Json(body): Json<RenameRequest>,
) -> Result<Json<Value>> {
    require_owner(&state.db, id, auth.id).await?;
    sqlx::query("UPDATE teams SET name = $1 WHERE id = $2")
        .bind(&body.name)
        .bind(id)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

async fn delete_team(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    require_owner(&state.db, id, auth.id).await?;

    // Downgrade every member before the cascade removes the membership rows.
    let member_ids: Vec<Uuid> =
        sqlx::query_scalar("SELECT user_id FROM team_members WHERE team_id = $1")
            .bind(id)
            .fetch_all(&state.db)
            .await?;

    sqlx::query("DELETE FROM teams WHERE id = $1")
        .bind(id)
        .execute(&state.db)
        .await?;

    for uid in member_ids {
        downgrade_user(&state.db, uid).await?;
    }
    Ok(Json(json!({ "ok": true })))
}

// ── Members / invites ───────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct InviteRequest {
    email: String,
}

async fn invite_member(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<Uuid>,
    Json(body): Json<InviteRequest>,
) -> Result<Json<Value>> {
    require_owner(&state.db, id, auth.id).await?;

    let team = sqlx::query_as::<_, TeamRow>(
        "SELECT id, name, owner_id, seat_limit, stripe_subscription_id FROM teams WHERE id = $1",
    )
    .bind(id)
    .fetch_one(&state.db)
    .await?;

    // Seats: current members + outstanding (unexpired, unaccepted) invites.
    let used: i64 = sqlx::query_scalar(
        r#"
        SELECT (SELECT COUNT(*) FROM team_members WHERE team_id = $1)
             + (SELECT COUNT(*) FROM pending_invites
                WHERE team_id = $1 AND accepted_at IS NULL AND expires_at > NOW())
        "#,
    )
    .bind(id)
    .fetch_one(&state.db)
    .await?;
    if used >= team.seat_limit as i64 {
        return Err(ApiError::BadRequest("seat_limit_reached".into()));
    }

    let email = body.email.trim().to_lowercase();
    let token = Uuid::new_v4().simple().to_string();
    sqlx::query(
        "INSERT INTO pending_invites (email, team_id, invited_by, token) VALUES ($1,$2,$3,$4)",
    )
    .bind(&email)
    .bind(id)
    .bind(auth.id)
    .bind(&token)
    .execute(&state.db)
    .await?;

    let accept_url = format!("{}/teams/accept/{}", state.app_base_url, token);
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE email = $1)")
        .bind(&email)
        .fetch_one(&state.db)
        .await
        .unwrap_or(false);
    crate::email::send_team_invite_email(
        state.send_emails,
        state.resend_api_key.as_deref(),
        &state.from_email,
        &email,
        auth.email.as_deref().unwrap_or("A teammate"),
        &team.name,
        &accept_url,
        exists,
    )
    .await;

    audit(
        &state.db,
        id,
        auth.id,
        "invite",
        None,
        json!({ "email": email }),
    )
    .await;
    Ok(Json(json!({ "ok": true })))
}

async fn accept_invite(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(token): Path<String>,
) -> Result<Json<Value>> {
    let email = auth.email.clone().unwrap_or_default().to_lowercase();
    // Accept any matching, unexpired, unaccepted invite for this user's email.
    let team_id = accept_invite_inner(&state.db, &token, auth.id, &email).await?;
    audit(
        &state.db,
        team_id,
        auth.id,
        "accept",
        Some(auth.id),
        json!({}),
    )
    .await;
    Ok(Json(json!({ "ok": true, "team_id": team_id })))
}

/// Shared with the auth.rs auto-accept path. Validates token + email, enforces
/// seats, inserts membership, sets plan = team_lite. Returns the team id.
pub(crate) async fn accept_invite_inner(
    db: &sqlx::PgPool,
    token: &str,
    user_id: Uuid,
    email: &str,
) -> Result<Uuid> {
    #[derive(sqlx::FromRow)]
    struct Inv {
        team_id: Uuid,
        invite_email: String,
    }
    let inv = sqlx::query_as::<_, Inv>(
        r#"
        SELECT team_id, email AS invite_email FROM pending_invites
        WHERE token = $1 AND accepted_at IS NULL AND expires_at > NOW()
        "#,
    )
    .bind(token)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| ApiError::BadRequest("invite invalid or expired".into()))?;

    if inv.invite_email.to_lowercase() != email.to_lowercase() {
        return Err(ApiError::Forbidden);
    }

    let used: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM team_members WHERE team_id = $1")
        .bind(inv.team_id)
        .fetch_one(db)
        .await?;
    let limit: i32 = sqlx::query_scalar("SELECT seat_limit FROM teams WHERE id = $1")
        .bind(inv.team_id)
        .fetch_one(db)
        .await?;
    if used >= limit as i64 {
        return Err(ApiError::BadRequest("seat_limit_reached".into()));
    }

    sqlx::query(
        "INSERT INTO team_members (team_id, user_id, role) VALUES ($1,$2,'member') ON CONFLICT DO NOTHING",
    )
    .bind(inv.team_id)
    .bind(user_id)
    .execute(db)
    .await?;
    sqlx::query("UPDATE pending_invites SET accepted_at = NOW() WHERE token = $1")
        .bind(token)
        .execute(db)
        .await?;
    sqlx::query("UPDATE users SET plan = 'team_lite' WHERE id = $1")
        .bind(user_id)
        .execute(db)
        .await?;
    Ok(inv.team_id)
}

async fn leave_team(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    require_member(&state.db, id, auth.id).await?;
    // The owner can't leave; they must delete the team.
    if require_owner(&state.db, id, auth.id).await.is_ok() {
        return Err(ApiError::BadRequest(
            "owner cannot leave; delete the team".into(),
        ));
    }
    sqlx::query("DELETE FROM team_members WHERE team_id = $1 AND user_id = $2")
        .bind(id)
        .bind(auth.id)
        .execute(&state.db)
        .await?;
    downgrade_user(&state.db, auth.id).await?;
    audit(&state.db, id, auth.id, "leave", Some(auth.id), json!({})).await;
    Ok(Json(json!({ "ok": true })))
}

async fn remove_member(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((id, uid)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>> {
    require_owner(&state.db, id, auth.id).await?;
    if uid == auth.id {
        return Err(ApiError::BadRequest(
            "owner cannot remove themselves".into(),
        ));
    }
    sqlx::query("DELETE FROM team_members WHERE team_id = $1 AND user_id = $2")
        .bind(id)
        .bind(uid)
        .execute(&state.db)
        .await?;
    downgrade_user(&state.db, uid).await?;
    audit(
        &state.db,
        id,
        auth.id,
        "remove_member",
        Some(uid),
        json!({}),
    )
    .await;
    Ok(Json(json!({ "ok": true })))
}

// ── Audit log ───────────────────────────────────────────────────────────────────

#[derive(sqlx::FromRow, Serialize)]
struct AuditRow {
    actor_email: Option<String>,
    action: String,
    metadata: Option<Value>,
    created_at: chrono::DateTime<chrono::Utc>,
}

async fn get_audit(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    require_owner(&state.db, id, auth.id).await?;
    let rows = sqlx::query_as::<_, AuditRow>(
        r#"
        SELECT u.email AS actor_email, a.action, a.metadata, a.created_at
        FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
        WHERE a.team_id = $1 ORDER BY a.created_at DESC LIMIT 200
        "#,
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!(rows)))
}

// ── Shared codes ────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct Recipient {
    user_id: Uuid,
    server_share: String,         // K2, base64 (32 bytes)
    encrypted_user_share: String, // K1 wrapped to recipient pubkey, opaque
}

#[derive(Deserialize)]
struct ShareCodeRequest {
    account_name: String,
    #[serde(default)]
    account_email: Option<String>,
    encrypted_secret: String, // AES-GCM(secret, K), base64
    iv: String,               // base64 (12 bytes)
    recipients: Vec<Recipient>,
}

async fn share_code(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<Uuid>,
    Json(body): Json<ShareCodeRequest>,
) -> Result<Json<Value>> {
    require_member(&state.db, id, auth.id).await?;

    let code_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO shared_codes (owner_id, team_id, account_name, account_email, encrypted_secret, sharing_key_iv)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING id
        "#,
    )
    .bind(auth.id)
    .bind(id)
    .bind(&body.account_name)
    .bind(&body.account_email)
    .bind(&body.encrypted_secret)
    .bind(&body.iv)
    .fetch_one(&state.db)
    .await?;

    for r in &body.recipients {
        // Recipients must be members of this team.
        require_member(&state.db, id, r.user_id).await?;
        sqlx::query(
            r#"
            INSERT INTO share_access (shared_code_id, user_id, server_share, encrypted_user_share)
            VALUES ($1,$2,$3,$4)
            "#,
        )
        .bind(code_id)
        .bind(r.user_id)
        .bind(&r.server_share)
        .bind(&r.encrypted_user_share)
        .execute(&state.db)
        .await?;
    }

    audit(
        &state.db,
        id,
        auth.id,
        "share",
        Some(code_id),
        json!({ "account_name": body.account_name, "recipients": body.recipients.len() }),
    )
    .await;
    Ok(Json(json!({ "id": code_id })))
}

#[derive(sqlx::FromRow, Serialize)]
struct SharedWithMeRow {
    id: Uuid,
    account_name: String,
    account_email: Option<String>,
    owner_email: Option<String>,
    encrypted_user_share: String,
}

async fn list_shared_with_me(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    require_member(&state.db, id, auth.id).await?;
    let rows = sqlx::query_as::<_, SharedWithMeRow>(
        r#"
        SELECT c.id, c.account_name, c.account_email, u.email AS owner_email, sa.encrypted_user_share
        FROM share_access sa
        JOIN shared_codes c ON c.id = sa.shared_code_id
        JOIN users u ON u.id = c.owner_id
        WHERE c.team_id = $1 AND sa.user_id = $2 AND sa.revoked_at IS NULL AND c.active
        ORDER BY c.created_at DESC
        "#,
    )
    .bind(id)
    .bind(auth.id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!(rows)))
}

#[derive(sqlx::FromRow, Serialize)]
struct MyShareRow {
    id: Uuid,
    account_name: String,
    account_email: Option<String>,
    recipients: i64,
}

async fn list_my_shares(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    require_member(&state.db, id, auth.id).await?;
    let rows = sqlx::query_as::<_, MyShareRow>(
        r#"
        SELECT c.id, c.account_name, c.account_email,
               (SELECT COUNT(*) FROM share_access sa WHERE sa.shared_code_id = c.id AND sa.revoked_at IS NULL) AS recipients
        FROM shared_codes c
        WHERE c.team_id = $1 AND c.owner_id = $2 AND c.active
        ORDER BY c.created_at DESC
        "#,
    )
    .bind(id)
    .bind(auth.id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!(rows)))
}

async fn revoke_code(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((id, cid)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>> {
    let owner: Option<Uuid> =
        sqlx::query_scalar("SELECT owner_id FROM shared_codes WHERE id = $1 AND team_id = $2")
            .bind(cid)
            .bind(id)
            .fetch_optional(&state.db)
            .await?;
    match owner {
        Some(o) if o == auth.id => {}
        Some(_) => return Err(ApiError::Forbidden),
        None => return Err(ApiError::NotFound),
    }
    sqlx::query("DELETE FROM shared_codes WHERE id = $1")
        .bind(cid)
        .execute(&state.db)
        .await?;
    audit(&state.db, id, auth.id, "revoke_code", Some(cid), json!({})).await;
    Ok(Json(json!({ "ok": true })))
}

async fn revoke_access(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((id, cid, uid)): Path<(Uuid, Uuid, Uuid)>,
) -> Result<Json<Value>> {
    let owner: Option<Uuid> =
        sqlx::query_scalar("SELECT owner_id FROM shared_codes WHERE id = $1 AND team_id = $2")
            .bind(cid)
            .bind(id)
            .fetch_optional(&state.db)
            .await?;
    // The code owner can revoke anyone; a recipient can remove their own access.
    match owner {
        Some(o) if o == auth.id || uid == auth.id => {}
        Some(_) => return Err(ApiError::Forbidden),
        None => return Err(ApiError::NotFound),
    }
    // Deleting the share_access row orphans the recipient's K1 (no K2 → can't reconstruct K).
    sqlx::query("DELETE FROM share_access WHERE shared_code_id = $1 AND user_id = $2")
        .bind(cid)
        .bind(uid)
        .execute(&state.db)
        .await?;
    audit(
        &state.db,
        id,
        auth.id,
        "revoke_access",
        Some(uid),
        json!({ "code_id": cid }),
    )
    .await;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct TotpRequest {
    user_share: String, // K1, base64 (32 bytes)
    /// Why the code was fetched. Only an explicit user action (copy/autofill/
    /// refresh) is audited — passive display/auto-refresh sends nothing.
    #[serde(default)]
    reason: Option<String>,
}

async fn generate_totp(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((id, cid)): Path<(Uuid, Uuid)>,
    Json(body): Json<TotpRequest>,
) -> Result<Json<Value>> {
    // The requester must have an active share_access row for this code.
    #[derive(sqlx::FromRow)]
    struct Access {
        server_share: String,
        encrypted_secret: String,
        sharing_key_iv: String,
    }
    let acc = sqlx::query_as::<_, Access>(
        r#"
        SELECT sa.server_share, c.encrypted_secret, c.sharing_key_iv
        FROM share_access sa JOIN shared_codes c ON c.id = sa.shared_code_id
        WHERE sa.shared_code_id = $1 AND sa.user_id = $2 AND c.team_id = $3
          AND sa.revoked_at IS NULL AND c.active
        "#,
    )
    .bind(cid)
    .bind(auth.id)
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(ApiError::Forbidden)?;

    let code = reconstruct_and_totp(
        &body.user_share,
        &acc.server_share,
        &acc.encrypted_secret,
        &acc.sharing_key_iv,
    )?;

    // Only log explicit user actions, not passive display / 30s auto-refresh.
    if let Some(reason) = body.reason.as_deref() {
        if matches!(reason, "copy" | "autofill" | "refresh") {
            audit(
                &state.db,
                id,
                auth.id,
                "totp_access",
                Some(cid),
                json!({ "reason": reason }),
            )
            .await;
        }
    }
    Ok(Json(json!({ "code": code })))
}

/// Reconstructs K = K1 XOR K2, AES-GCM-decrypts the TOTP secret, generates the
/// current code, and lets K/secret drop out of scope immediately.
fn reconstruct_and_totp(
    k1_b64: &str,
    k2_b64: &str,
    encrypted_secret_b64: &str,
    iv_b64: &str,
) -> Result<String> {
    use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
    use totp_rs::{Algorithm, Secret, TOTP};

    let bad = |_| ApiError::BadRequest("invalid share material".into());
    let k1 = B64.decode(k1_b64).map_err(bad)?;
    let k2 = B64.decode(k2_b64).map_err(bad)?;
    if k1.len() != 32 || k2.len() != 32 {
        return Err(ApiError::BadRequest("invalid key share length".into()));
    }
    let k: Vec<u8> = k1.iter().zip(k2.iter()).map(|(a, b)| a ^ b).collect();

    let ct = B64.decode(encrypted_secret_b64).map_err(bad)?;
    let iv = B64.decode(iv_b64).map_err(bad)?;
    if iv.len() != 12 {
        return Err(ApiError::BadRequest("invalid iv length".into()));
    }
    let cipher = Aes256Gcm::new_from_slice(&k)
        .map_err(|_| ApiError::BadRequest("invalid key length".into()))?;
    let plain = cipher
        .decrypt(Nonce::from_slice(&iv), ct.as_ref())
        .map_err(|_| ApiError::BadRequest("decrypt failed".into()))?;
    let secret_str =
        String::from_utf8(plain).map_err(|_| ApiError::BadRequest("invalid secret".into()))?;

    let secret_bytes = Secret::Encoded(secret_str)
        .to_bytes()
        .map_err(|_| ApiError::BadRequest("invalid base32 secret".into()))?;
    // new_unchecked: many real TOTP secrets are 80-bit (16 base32 chars, e.g.
    // Google) which TOTP::new rejects under the RFC 128-bit minimum. They work
    // fine in practice, so skip that length check.
    let totp = TOTP::new_unchecked(Algorithm::SHA1, 6, 1, 30, secret_bytes);
    totp.generate_current()
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("totp gen: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
    use totp_rs::{Algorithm, Secret, TOTP};

    #[test]
    fn two_of_two_roundtrip_matches_direct_totp() {
        let secret = "JBSWY3DPEHPK3PXP"; // base32 TOTP secret
        let k: [u8; 32] = [7u8; 32];
        let k1: [u8; 32] = [3u8; 32];
        let k2: Vec<u8> = k.iter().zip(k1.iter()).map(|(a, b)| a ^ b).collect();
        let iv = [9u8; 12];

        let cipher = Aes256Gcm::new_from_slice(&k).unwrap();
        let ct = cipher
            .encrypt(Nonce::from_slice(&iv), secret.as_bytes())
            .unwrap();

        let code = reconstruct_and_totp(
            &B64.encode(k1),
            &B64.encode(&k2),
            &B64.encode(&ct),
            &B64.encode(iv),
        )
        .unwrap();

        // Must equal a TOTP generated directly from the secret.
        let bytes = Secret::Encoded(secret.to_string()).to_bytes().unwrap();
        let expected = TOTP::new_unchecked(Algorithm::SHA1, 6, 1, 30, bytes)
            .generate_current()
            .unwrap();
        assert_eq!(code, expected);
        assert_eq!(code.len(), 6);
    }

    #[test]
    fn wrong_share_fails_to_decrypt() {
        let secret = "JBSWY3DPEHPK3PXP";
        let k: [u8; 32] = [7u8; 32];
        let k1: [u8; 32] = [3u8; 32];
        let k2: Vec<u8> = k.iter().zip(k1.iter()).map(|(a, b)| a ^ b).collect();
        let iv = [9u8; 12];
        let cipher = Aes256Gcm::new_from_slice(&k).unwrap();
        let ct = cipher
            .encrypt(Nonce::from_slice(&iv), secret.as_bytes())
            .unwrap();

        // Tamper K1 → reconstructed K is wrong → decrypt must fail.
        let bad_k1 = [4u8; 32];
        let res = reconstruct_and_totp(
            &B64.encode(bad_k1),
            &B64.encode(&k2),
            &B64.encode(&ct),
            &B64.encode(iv),
        );
        assert!(res.is_err());
    }
}
