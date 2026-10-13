//! 2.1 OTPilot for AI agents (docs/agents/plan.md).
//!
//! **Pairing.** The OTPilot MCP server registers itself (`POST /agents/pair`,
//! public) with its public key and gets a pair secret; the user opens the
//! connect link signed in and claims it (`/agents/pair/{id}/claim`), then
//! approves it in the extension after checking the verification code (derived
//! from the public key, computed on both sides, so the server can't swap it).
//! The MCP polls with its pair secret and collects its bearer token once.
//!
//! **Grants.** The extension writes, per agent and item, a copy of the item
//! projected to what the agent may use, encrypted under a key wrapped to the
//! agent's public key. Expiry, "ask every time" and revocation are enforced
//! here: the copy is only handed out while the grant allows it.
//!
//! **Plans.** Free: one agent, three granted items (`FREE_AGENTS`,
//! `FREE_AGENT_ITEMS`, mirrored in web/src/lib/agents.ts). Over the limit
//! (after a downgrade) what exists keeps working; only adding is refused.

use std::time::Duration;

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
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
    middleware::{
        agent_auth::{hash_secret, new_secret, AgentAuth, TOKEN_PREFIX},
        auth::AuthUser,
    },
    routes::vault::validate_record,
    AppState,
};

pub const FREE_AGENTS: i64 = 1;
pub const FREE_AGENT_ITEMS: i64 = 3;
/// How long a pairing waits to be claimed, then approved.
const PAIRING_MINUTES: i32 = 15;
/// How long a request waits for the user's answer.
const REQUEST_MINUTES: i32 = 10;
/// How long a one-time approval hands out the copy.
const RELEASE_SECONDS: i32 = 120;
const MAX_PENDING_REQUESTS: i64 = 10;
const MAX_KEY_BYTES: usize = 4096;
const MAX_COMMANDS: usize = 20;
const KEEP_USES: i64 = 200;

pub fn router() -> Router<AppState> {
    Router::new()
        // The MCP server, before it has a token.
        .route("/agents/pair", post(pair))
        .route("/agent/pair/{id}/token", post(collect_token))
        // The signed-in user (web: claim; extension: everything else).
        .route("/agents/pair/{id}", get(pairing_of))
        .route("/agents/pair/{id}/claim", post(claim))
        .route("/agents", get(list))
        .route("/agents/{id}", axum::routing::delete(remove_agent))
        .route("/agents/{id}/approve", post(approve))
        .route(
            "/agents/{id}/grants/{item_id}",
            put(put_grant).delete(remove_grant),
        )
        .route("/agents/requests/{id}", post(decide_request))
        // The MCP server, with its token.
        .route("/agent/me", get(agent_me))
        .route("/agent/grants", get(agent_grants))
        .route("/agent/requests", post(agent_request))
        .route("/agent/requests/{id}", get(agent_request_status))
        .route("/agent/uses", post(agent_use))
}

// ── Helpers ────────────────────────────────────────────────────────────────

/// Trimmed, capped at `max` characters.
fn text(v: &str, max: usize) -> String {
    v.trim().chars().take(max).collect()
}

/// A public key as the extension stores them (`keys.js`): base64 of the raw
/// P-256 point (65 bytes → 88 characters).
fn valid_public_key(k: &str) -> bool {
    use base64::Engine;
    k.len() <= 200
        && base64::engine::general_purpose::STANDARD
            .decode(k)
            .is_ok_and(|b| {
                b.len() == 65 && b[0] == 4 && p256::PublicKey::from_sec1_bytes(&b).is_ok()
            })
}

async fn is_free<'e, E: sqlx::PgExecutor<'e>>(db: E, user: Uuid) -> Result<bool> {
    let plan: Option<String> = sqlx::query_scalar("SELECT plan FROM users WHERE id = $1")
        .bind(user)
        .fetch_optional(db)
        .await?;
    Ok(plan.as_deref().unwrap_or("free") == "free")
}

/// Locks the user's row: plan-limit checks and the writes they guard happen
/// one at a time per user.
async fn lock_user(tx: &mut sqlx::Transaction<'_, sqlx::Postgres>, user: Uuid) -> Result<()> {
    sqlx::query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE")
        .bind(user)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(ApiError::Forbidden)?;
    Ok(())
}

fn limit_error(what: &str) -> ApiError {
    ApiError::BadRequest(format!(
        "free plan limit: {what} (upgrade to Personal for unlimited agents)"
    ))
}

/// Forgets pairings nobody claimed or approved in time, and requests nobody
/// answered (they read as denied to the agent).
async fn expire(db: &sqlx::PgPool) -> Result<()> {
    sqlx::query(&format!(
        "DELETE FROM agents WHERE status IN ('pairing', 'pending')
           AND created_at < NOW() - INTERVAL '{PAIRING_MINUTES} minutes'"
    ))
    .execute(db)
    .await?;
    sqlx::query(&format!(
        "UPDATE agent_requests SET status = 'denied', decided_at = NOW()
         WHERE status = 'pending' AND created_at < NOW() - INTERVAL '{REQUEST_MINUTES} minutes'"
    ))
    .execute(db)
    .await?;
    Ok(())
}

/// The caller's agent `id` (any status), or 404.
async fn own_agent(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user: Uuid,
    id: Uuid,
) -> Result<String> {
    sqlx::query_scalar("SELECT status FROM agents WHERE id = $1 AND user_id = $2 FOR UPDATE")
        .bind(id)
        .bind(user)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(ApiError::NotFound)
}

// ── Pairing ────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct PairRequest {
    public_key: String,
    name: String,
    #[serde(default)]
    machine: String,
}

/// Public: an MCP server registers itself. Rate-limited per sender and overall.
async fn pair(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PairRequest>,
) -> Result<Json<Value>> {
    let sender = headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(str::trim)
        .unwrap_or("unknown");
    let hour = Duration::from_secs(3600);
    if !state
        .rate_limiter
        .check(&format!("agent-pair:{sender}"), 20, hour)
        || !state.rate_limiter.check("agent-pair:all", 2000, hour)
    {
        return Err(ApiError::TooManyRequests);
    }
    if !valid_public_key(&body.public_key) {
        return Err(ApiError::BadRequest("invalid public_key".into()));
    }
    let name = text(&body.name, 60);
    if name.is_empty() {
        return Err(ApiError::BadRequest("name is required".into()));
    }
    expire(&state.db).await?;
    let id = Uuid::new_v4();
    let secret = new_secret("otpp_");
    sqlx::query(
        "INSERT INTO agents (id, name, machine, public_key, status, pair_secret_hash)
         VALUES ($1, $2, $3, $4, 'pairing', $5)",
    )
    .bind(id)
    .bind(&name)
    .bind(text(&body.machine, 100))
    .bind(&body.public_key)
    .bind(hash_secret(&secret))
    .execute(&state.db)
    .await?;
    Ok(Json(json!({
        "id": id,
        "pair_secret": secret,
        "connect_url": format!("{}/agents/connect?p={id}", state.app_base_url.trim_end_matches('/')),
        "expires_in": PAIRING_MINUTES * 60,
    })))
}

#[derive(Deserialize)]
struct CollectRequest {
    pair_secret: String,
}

/// The MCP polls with its pair secret: 202 while waiting, its token once
/// approved (only the first time), 404 when denied or expired.
async fn collect_token(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(body): Json<CollectRequest>,
) -> Result<Response> {
    let mut tx = state.db.begin().await?;
    let row: Option<(String, String, Option<String>, DateTime<Utc>)> = sqlx::query_as(
        "SELECT status, pair_secret_hash, token_hash, created_at FROM agents WHERE id = $1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((status, secret_hash, token_hash, created_at)) = row else {
        return Err(ApiError::NotFound);
    };
    if secret_hash != hash_secret(&body.pair_secret) {
        return Err(ApiError::NotFound);
    }
    if status != "active" {
        let expired = Utc::now() - created_at > chrono::Duration::minutes(PAIRING_MINUTES.into());
        if expired {
            return Err(ApiError::NotFound);
        }
        return Ok((StatusCode::ACCEPTED, Json(json!({ "status": status }))).into_response());
    }
    if token_hash.is_some() {
        // Already collected: the secret is spent.
        return Err(ApiError::NotFound);
    }
    let token = new_secret(TOKEN_PREFIX);
    sqlx::query("UPDATE agents SET token_hash = $2 WHERE id = $1")
        .bind(id)
        .bind(hash_secret(&token))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(json!({ "status": "active", "token": token })).into_response())
}

/// What the connect page shows before claiming: a pairing still unclaimed.
async fn pairing_of(
    State(state): State<AppState>,
    _auth: AuthUser,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    expire(&state.db).await?;
    let row: Option<(String, String, String)> = sqlx::query_as(
        "SELECT name, machine, public_key FROM agents WHERE id = $1 AND status = 'pairing'",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?;
    let (name, machine, public_key) = row.ok_or(ApiError::NotFound)?;
    Ok(Json(
        json!({ "id": id, "name": name, "machine": machine, "public_key": public_key }),
    ))
}

/// The signed-in user takes an unclaimed pairing; it waits for their approval
/// in the extension.
async fn claim(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    expire(&state.db).await?;
    let mut tx = state.db.begin().await?;
    lock_user(&mut tx, auth.id).await?;
    if is_free(&mut *tx, auth.id).await? {
        let agents: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM agents WHERE user_id = $1 AND status = 'active'",
        )
        .bind(auth.id)
        .fetch_one(&mut *tx)
        .await?;
        if agents >= FREE_AGENTS {
            return Err(limit_error("one connected agent"));
        }
    }
    let done = sqlx::query(
        "UPDATE agents SET user_id = $2, status = 'pending', claimed_at = NOW()
         WHERE id = $1 AND status = 'pairing'",
    )
    .bind(id)
    .bind(auth.id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if done == 0 {
        return Err(ApiError::NotFound);
    }
    tx.commit().await?;
    Ok(Json(json!({ "id": id, "status": "pending" })))
}

// ── The user ───────────────────────────────────────────────────────────────

#[derive(sqlx::FromRow)]
struct AgentRow {
    id: Uuid,
    name: String,
    machine: String,
    public_key: String,
    status: String,
    created_at: DateTime<Utc>,
    approved_at: Option<DateTime<Utc>>,
    last_used_at: Option<DateTime<Utc>>,
}

#[derive(sqlx::FromRow)]
struct GrantMeta {
    agent_id: Uuid,
    item_id: Uuid,
    scope: Value,
    expires_at: Option<DateTime<Utc>>,
    ask_every_time: bool,
    commands: Vec<String>,
    revision: i64,
    updated_at: DateTime<Utc>,
}

#[derive(sqlx::FromRow)]
struct RequestRow {
    id: Uuid,
    agent_id: Uuid,
    query: String,
    reason: String,
    tool: String,
    item_id: Option<Uuid>,
    status: String,
    created_at: DateTime<Utc>,
}

#[derive(sqlx::FromRow)]
struct UseRow {
    agent_id: Uuid,
    item_id: Option<Uuid>,
    action: String,
    detail: String,
    created_at: DateTime<Utc>,
}

/// Everything the extension's Agents view shows: agents (pending ones
/// included), their grants (without ciphertext), pending requests, recent
/// activity and the plan's limits.
async fn list(State(state): State<AppState>, auth: AuthUser) -> Result<Json<Value>> {
    expire(&state.db).await?;
    let agents = sqlx::query_as::<_, AgentRow>(
        "SELECT id, name, machine, public_key, status, created_at, approved_at, last_used_at
         FROM agents WHERE user_id = $1 ORDER BY created_at",
    )
    .bind(auth.id)
    .fetch_all(&state.db)
    .await?;
    let grants = sqlx::query_as::<_, GrantMeta>(
        "SELECT g.agent_id, g.item_id, g.scope, g.expires_at, g.ask_every_time, g.commands,
                g.revision, g.updated_at
         FROM agent_grants g JOIN agents a ON a.id = g.agent_id
         WHERE a.user_id = $1 ORDER BY g.created_at",
    )
    .bind(auth.id)
    .fetch_all(&state.db)
    .await?;
    let requests = sqlx::query_as::<_, RequestRow>(
        "SELECT r.id, r.agent_id, r.query, r.reason, r.tool, r.item_id, r.status, r.created_at
         FROM agent_requests r JOIN agents a ON a.id = r.agent_id
         WHERE a.user_id = $1 AND a.status = 'active' AND r.status = 'pending'
         ORDER BY r.created_at",
    )
    .bind(auth.id)
    .fetch_all(&state.db)
    .await?;
    let uses = sqlx::query_as::<_, UseRow>(
        "SELECT u.agent_id, u.item_id, u.action, u.detail, u.created_at
         FROM agent_uses u JOIN agents a ON a.id = u.agent_id
         WHERE a.user_id = $1 ORDER BY u.id DESC LIMIT 50",
    )
    .bind(auth.id)
    .fetch_all(&state.db)
    .await?;
    let free = is_free(&state.db, auth.id).await?;
    Ok(Json(json!({
        "agents": agents.iter().map(|a| json!({
            "id": a.id, "name": a.name, "machine": a.machine, "public_key": a.public_key,
            "status": a.status, "created_at": a.created_at, "approved_at": a.approved_at,
            "last_used_at": a.last_used_at,
            "grants": grants.iter().filter(|g| g.agent_id == a.id).map(|g| json!({
                "item_id": g.item_id, "scope": g.scope, "expires_at": g.expires_at,
                "ask_every_time": g.ask_every_time, "commands": g.commands,
                "revision": g.revision, "updated_at": g.updated_at,
            })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "requests": requests.iter().map(|r| json!({
            "id": r.id, "agent_id": r.agent_id, "query": r.query, "reason": r.reason,
            "tool": r.tool, "item_id": r.item_id, "created_at": r.created_at,
            "status": r.status,
        })).collect::<Vec<_>>(),
        "activity": uses.iter().map(|u| json!({
            "agent_id": u.agent_id, "item_id": u.item_id, "action": u.action,
            "detail": u.detail, "created_at": u.created_at,
        })).collect::<Vec<_>>(),
        "limits": if free {
            json!({ "agents": FREE_AGENTS, "items": FREE_AGENT_ITEMS })
        } else {
            json!({ "agents": null, "items": null })
        },
    })))
}

/// Approves a claimed agent (after the user checked its code).
async fn approve(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    expire(&state.db).await?;
    let mut tx = state.db.begin().await?;
    lock_user(&mut tx, auth.id).await?;
    match own_agent(&mut tx, auth.id, id).await?.as_str() {
        "pending" => {}
        "active" => return Ok(Json(json!({ "id": id, "status": "active" }))),
        _ => return Err(ApiError::NotFound),
    }
    if is_free(&mut *tx, auth.id).await? {
        let agents: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM agents WHERE user_id = $1 AND status = 'active'",
        )
        .bind(auth.id)
        .fetch_one(&mut *tx)
        .await?;
        if agents >= FREE_AGENTS {
            return Err(limit_error("one connected agent"));
        }
    }
    sqlx::query("UPDATE agents SET status = 'active', approved_at = NOW() WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(json!({ "id": id, "status": "active" })))
}

/// Denies a pending agent or revokes an active one: its grants, requests and
/// activity go with it, and its token stops working.
async fn remove_agent(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let done = sqlx::query("DELETE FROM agents WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(auth.id)
        .execute(&state.db)
        .await?
        .rows_affected();
    if done == 0 {
        return Err(ApiError::NotFound);
    }
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct GrantRequest {
    record: Value,
    /// The item's title and sites, encrypted like `record` (always handed out).
    label: Value,
    wrapped_key: String,
    scope: Value,
    #[serde(default)]
    expires_at: Option<DateTime<Utc>>,
    #[serde(default)]
    ask_every_time: bool,
    #[serde(default)]
    commands: Vec<String>,
}

fn check_scope(scope: &Value) -> Result<()> {
    let kind = scope.get("kind").and_then(Value::as_str);
    let ok = matches!(kind, Some("2fa" | "login" | "fields"))
        && serde_json::to_string(scope).is_ok_and(|s| s.len() <= 2048);
    if ok {
        Ok(())
    } else {
        Err(ApiError::BadRequest(
            "scope must be { kind: 2fa | login | fields, … }".into(),
        ))
    }
}

/// Writes the agent's copy of one of the user's items (new or updated).
async fn put_grant(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((id, item_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<GrantRequest>,
) -> Result<Json<Value>> {
    let record = validate_record(&body.record)?;
    let label = validate_record(&body.label)?;
    if body.wrapped_key.is_empty() || body.wrapped_key.len() > MAX_KEY_BYTES {
        return Err(ApiError::BadRequest(format!(
            "wrapped_key must be 1-{MAX_KEY_BYTES} bytes"
        )));
    }
    check_scope(&body.scope)?;
    if body.commands.len() > MAX_COMMANDS
        || body
            .commands
            .iter()
            .any(|c| c.trim().is_empty() || c.len() > 200)
    {
        return Err(ApiError::BadRequest(format!(
            "commands: up to {MAX_COMMANDS}, 1-200 characters each"
        )));
    }
    let mut tx = state.db.begin().await?;
    lock_user(&mut tx, auth.id).await?;
    if own_agent(&mut tx, auth.id, id).await? != "active" {
        return Err(ApiError::NotFound);
    }
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM agent_grants WHERE agent_id = $1 AND item_id = $2)",
    )
    .bind(id)
    .bind(item_id)
    .fetch_one(&mut *tx)
    .await?;
    if !exists && is_free(&mut *tx, auth.id).await? {
        let items: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM agent_grants g JOIN agents a ON a.id = g.agent_id
             WHERE a.user_id = $1",
        )
        .bind(auth.id)
        .fetch_one(&mut *tx)
        .await?;
        if items >= FREE_AGENT_ITEMS {
            return Err(limit_error("three accounts for agents"));
        }
    }
    let commands: Vec<String> = body.commands.iter().map(|c| c.trim().to_string()).collect();
    let revision: i64 = sqlx::query_scalar(
        "INSERT INTO agent_grants
           (agent_id, item_id, scope, encrypted_item, wrapped_key, expires_at, ask_every_time, commands, label)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (agent_id, item_id) DO UPDATE SET
           scope = EXCLUDED.scope, encrypted_item = EXCLUDED.encrypted_item, label = EXCLUDED.label,
           wrapped_key = EXCLUDED.wrapped_key, expires_at = EXCLUDED.expires_at,
           ask_every_time = EXCLUDED.ask_every_time, commands = EXCLUDED.commands,
           revision = nextval('vault_revision_seq'), updated_at = NOW()
         RETURNING revision",
    )
    .bind(id)
    .bind(item_id)
    .bind(&body.scope)
    .bind(&record)
    .bind(&body.wrapped_key)
    .bind(body.expires_at)
    .bind(body.ask_every_time)
    .bind(&commands)
    .bind(&label)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(json!({ "item_id": item_id, "revision": revision })))
}

async fn remove_grant(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((id, item_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>> {
    let mut tx = state.db.begin().await?;
    let done = sqlx::query(
        "DELETE FROM agent_grants g USING agents a
         WHERE g.agent_id = $1 AND g.item_id = $2 AND a.id = g.agent_id AND a.user_id = $3",
    )
    .bind(id)
    .bind(item_id)
    .bind(auth.id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if done == 0 {
        return Err(ApiError::NotFound);
    }
    // A one-time approval belongs to the grant it answered: a grant written
    // again later needs a new one.
    sqlx::query(
        "UPDATE agent_requests SET released_until = NULL
         WHERE agent_id = $1 AND item_id = $2 AND released_until IS NOT NULL",
    )
    .bind(id)
    .bind(item_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct DecideRequest {
    /// `allow` (the grant was written first; `item_id` says which), `deny`.
    decision: String,
    #[serde(default)]
    item_id: Option<Uuid>,
}

/// Answers an agent's request. For a one-time use of an "ask every time"
/// grant, `allow` hands the copy out for `RELEASE_SECONDS`.
async fn decide_request(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<Uuid>,
    Json(body): Json<DecideRequest>,
) -> Result<Json<Value>> {
    let mut tx = state.db.begin().await?;
    let row: Option<(Uuid, Option<Uuid>, String, DateTime<Utc>)> = sqlx::query_as(
        "SELECT r.agent_id, r.item_id, r.status, r.created_at FROM agent_requests r
         JOIN agents a ON a.id = r.agent_id
         WHERE r.id = $1 AND a.user_id = $2 FOR UPDATE OF r",
    )
    .bind(id)
    .bind(auth.id)
    .fetch_optional(&mut *tx)
    .await?;
    let (agent_id, requested_item, status, created_at) = row.ok_or(ApiError::NotFound)?;
    if status != "pending" {
        return Err(ApiError::BadRequest("already answered".into()));
    }
    // Past its wait, a request is denied whether or not expire() ran yet.
    if Utc::now() - created_at > chrono::Duration::minutes(REQUEST_MINUTES.into()) {
        return Err(ApiError::BadRequest("this request has expired".into()));
    }
    match body.decision.as_str() {
        "deny" => {
            sqlx::query(
                "UPDATE agent_requests SET status = 'denied', decided_at = NOW() WHERE id = $1",
            )
            .bind(id)
            .execute(&mut *tx)
            .await?;
        }
        "allow" => {
            // The grant this answers: the one asked for, or the one just written.
            let item = requested_item
                .or(body.item_id)
                .ok_or_else(|| ApiError::BadRequest("item_id is required".into()))?;
            // Allowing hands out the copy once when the grant asks every time
            // (whether the request asked for that use or for a new account).
            let ask_every_time: Option<bool> = sqlx::query_scalar(
                "SELECT ask_every_time FROM agent_grants WHERE agent_id = $1 AND item_id = $2",
            )
            .bind(agent_id)
            .bind(item)
            .fetch_optional(&mut *tx)
            .await?;
            let Some(release) = ask_every_time else {
                return Err(ApiError::BadRequest("write the grant first".into()));
            };
            sqlx::query(&format!(
                "UPDATE agent_requests SET status = 'allowed', decided_at = NOW(), item_id = $2,
                   released_until = CASE WHEN $3 THEN NOW() + INTERVAL '{RELEASE_SECONDS} seconds' END
                 WHERE id = $1"
            ))
            .bind(id)
            .bind(item)
            .bind(release)
            .execute(&mut *tx)
            .await?;
        }
        _ => {
            return Err(ApiError::BadRequest(
                "decision must be allow or deny".into(),
            ))
        }
    }
    tx.commit().await?;
    Ok(Json(json!({ "ok": true })))
}

// ── The agent (MCP server) ─────────────────────────────────────────────────

async fn agent_me(State(state): State<AppState>, agent: AgentAuth) -> Result<Json<Value>> {
    let (name, machine): (String, String) =
        sqlx::query_as("SELECT name, machine FROM agents WHERE id = $1")
            .bind(agent.agent_id)
            .fetch_one(&state.db)
            .await?;
    Ok(Json(
        json!({ "id": agent.agent_id, "name": name, "machine": machine }),
    ))
}

#[derive(sqlx::FromRow)]
struct AgentGrantRow {
    item_id: Uuid,
    scope: Value,
    encrypted_item: String,
    label: String,
    wrapped_key: String,
    expires_at: Option<DateTime<Utc>>,
    ask_every_time: bool,
    commands: Vec<String>,
    revision: i64,
    released: bool,
}

/// The agent's grants. An expired grant isn't listed; an "ask every time"
/// grant is listed with its label (title, sites) but without its copy unless
/// a one-time approval is live.
async fn agent_grants(State(state): State<AppState>, agent: AgentAuth) -> Result<Json<Value>> {
    let rows = sqlx::query_as::<_, AgentGrantRow>(
        "SELECT g.item_id, g.scope, g.encrypted_item, g.label, g.wrapped_key, g.expires_at,
                g.ask_every_time, g.commands, g.revision,
                EXISTS(SELECT 1 FROM agent_requests r
                       WHERE r.agent_id = g.agent_id AND r.item_id = g.item_id
                         AND r.status = 'allowed' AND r.released_until > NOW()) AS released
         FROM agent_grants g
         WHERE g.agent_id = $1 AND (g.expires_at IS NULL OR g.expires_at > NOW())
         ORDER BY g.created_at",
    )
    .bind(agent.agent_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!({
        "grants": rows.iter().map(|g| {
            let open = !g.ask_every_time || g.released;
            json!({
                "item_id": g.item_id, "scope": g.scope, "expires_at": g.expires_at,
                "ask_every_time": g.ask_every_time, "commands": g.commands,
                "revision": g.revision,
                "record": if open { serde_json::from_str::<Value>(&g.encrypted_item).unwrap_or(Value::Null) } else { Value::Null },
                "label": serde_json::from_str::<Value>(&g.label).unwrap_or(Value::Null),
                "wrapped_key": g.wrapped_key,
            })
        }).collect::<Vec<_>>(),
    })))
}

#[derive(Deserialize)]
struct AgentRequestBody {
    #[serde(default)]
    query: String,
    #[serde(default)]
    reason: String,
    #[serde(default)]
    tool: String,
    #[serde(default)]
    item_id: Option<Uuid>,
}

/// The agent asks for an account it doesn't have (free text), or for one use
/// of an "ask every time" grant (`item_id`).
async fn agent_request(
    State(state): State<AppState>,
    agent: AgentAuth,
    Json(body): Json<AgentRequestBody>,
) -> Result<Json<Value>> {
    if !state.rate_limiter.check(
        &format!("agent-request:{}", agent.agent_id),
        60,
        Duration::from_secs(3600),
    ) {
        return Err(ApiError::TooManyRequests);
    }
    let query = text(&body.query, 200);
    if body.item_id.is_none() && query.is_empty() {
        return Err(ApiError::BadRequest("query or item_id is required".into()));
    }
    expire(&state.db).await?;
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT 1 FROM agents WHERE id = $1 FOR UPDATE")
        .bind(agent.agent_id)
        .execute(&mut *tx)
        .await?;
    if let Some(item) = body.item_id {
        let granted: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM agent_grants WHERE agent_id = $1 AND item_id = $2
                             AND (expires_at IS NULL OR expires_at > NOW()))",
        )
        .bind(agent.agent_id)
        .bind(item)
        .fetch_one(&mut *tx)
        .await?;
        if !granted {
            return Err(ApiError::NotFound);
        }
    }
    let pending: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM agent_requests WHERE agent_id = $1 AND status = 'pending'",
    )
    .bind(agent.agent_id)
    .fetch_one(&mut *tx)
    .await?;
    if pending >= MAX_PENDING_REQUESTS {
        return Err(ApiError::TooManyRequests);
    }
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent_requests (id, agent_id, query, reason, tool, item_id)
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(id)
    .bind(agent.agent_id)
    .bind(&query)
    .bind(text(&body.reason, 500))
    .bind(text(&body.tool, 40))
    .bind(body.item_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(json!({ "id": id, "status": "pending" })))
}

async fn agent_request_status(
    State(state): State<AppState>,
    agent: AgentAuth,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    expire(&state.db).await?;
    let row: Option<(String, Option<Uuid>)> = sqlx::query_as(
        "SELECT status, item_id FROM agent_requests WHERE id = $1 AND agent_id = $2",
    )
    .bind(id)
    .bind(agent.agent_id)
    .fetch_optional(&state.db)
    .await?;
    let (status, item_id) = row.ok_or(ApiError::NotFound)?;
    Ok(Json(
        json!({ "id": id, "status": status, "item_id": item_id }),
    ))
}

#[derive(Deserialize)]
struct UseBody {
    #[serde(default)]
    item_id: Option<Uuid>,
    action: String,
    #[serde(default)]
    detail: String,
}

/// Records what the agent did (shown in the extension's activity log).
async fn agent_use(
    State(state): State<AppState>,
    agent: AgentAuth,
    Json(body): Json<UseBody>,
) -> Result<Json<Value>> {
    if !matches!(
        body.action.as_str(),
        "browser_login" | "login_attempt" | "run" | "totp"
    ) {
        return Err(ApiError::BadRequest("unknown action".into()));
    }
    let mut tx = state.db.begin().await?;
    sqlx::query(
        "INSERT INTO agent_uses (agent_id, item_id, action, detail) VALUES ($1, $2, $3, $4)",
    )
    .bind(agent.agent_id)
    .bind(body.item_id)
    .bind(&body.action)
    .bind(text(&body.detail, 200))
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "DELETE FROM agent_uses WHERE agent_id = $1 AND id <= (
           SELECT id FROM agent_uses WHERE agent_id = $1 ORDER BY id DESC OFFSET $2 LIMIT 1)",
    )
    .bind(agent.agent_id)
    .bind(KEEP_USES)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE agents SET last_used_at = NOW() WHERE id = $1")
        .bind(agent.agent_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(json!({ "ok": true })))
}

/// Pending work for the user's badge: agents waiting for approval and
/// requests waiting for an answer (`GET /notifications`).
pub(crate) async fn pending_counts(db: &sqlx::PgPool, user: Uuid) -> Result<(i64, i64)> {
    expire(db).await?;
    Ok(sqlx::query_as(
        "SELECT
           (SELECT COUNT(*) FROM agents WHERE user_id = $1 AND status = 'pending'),
           (SELECT COUNT(*) FROM agent_requests r JOIN agents a ON a.id = r.agent_id
             WHERE a.user_id = $1 AND a.status = 'active' AND r.status = 'pending')",
    )
    .bind(user)
    .fetch_one(db)
    .await?)
}

#[cfg(all(test, feature = "db-tests"))]
mod tests {
    use super::*;
    use crate::test_support::{call, create_user, test_db, test_state};
    use axum::body::{to_bytes, Body};
    use axum::http::{Method, Request};
    use tower::ServiceExt;

    // A real P-256 public key (raw point), from a fixed secret scalar.
    fn pubkey() -> String {
        use base64::Engine;
        use p256::elliptic_curve::sec1::ToEncodedPoint;
        let secret = p256::SecretKey::from_slice(&[7u8; 32]).unwrap();
        let point = secret.public_key().to_encoded_point(false);
        base64::engine::general_purpose::STANDARD.encode(point.as_bytes())
    }

    fn record() -> Value {
        json!({ "v": 1, "key": { "iv": "a", "ct": "b" }, "data": { "iv": "c", "ct": "d" } })
    }

    // A label distinct from record(): a swap between the two would show.
    fn label() -> Value {
        json!({ "v": 1, "key": { "iv": "l", "ct": "m" }, "data": { "iv": "n", "ct": "o" } })
    }

    fn app(db: sqlx::PgPool) -> Router {
        router()
            .merge(crate::routes::notifications::router())
            .with_state(test_state(db))
    }

    /// An unauthenticated or agent-token call.
    async fn raw(
        app: &Router,
        bearer: Option<&str>,
        method: Method,
        uri: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut req = Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json");
        if let Some(b) = bearer {
            req = req.header("authorization", format!("Bearer {b}"));
        }
        let res = app
            .clone()
            .oneshot(
                req.body(body.map_or_else(Body::empty, |b| Body::from(b.to_string())))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = res.status();
        let bytes = to_bytes(res.into_body(), usize::MAX).await.unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    /// Pairs, claims and approves an agent for `user`; returns (id, token).
    async fn connect(app: &Router, user: Uuid) -> (Uuid, String) {
        let (s, p) = raw(
            app,
            None,
            Method::POST,
            "/agents/pair",
            Some(json!({ "public_key": pubkey(), "name": "Claude Code", "machine": "mac" })),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{p}");
        let id: Uuid = p["id"].as_str().unwrap().parse().unwrap();
        let secret = p["pair_secret"].as_str().unwrap().to_string();
        let poll = |app: Router, secret: String| async move {
            raw(
                &app,
                None,
                Method::POST,
                &format!("/agent/pair/{id}/token"),
                Some(json!({ "pair_secret": secret })),
            )
            .await
        };
        assert_eq!(
            poll(app.clone(), secret.clone()).await.0,
            StatusCode::ACCEPTED
        );
        let (s, b) = call(
            app,
            user,
            Method::POST,
            &format!("/agents/pair/{id}/claim"),
            None,
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{b}");
        assert_eq!(
            poll(app.clone(), secret.clone()).await.0,
            StatusCode::ACCEPTED
        );
        let (s, b) = call(
            app,
            user,
            Method::POST,
            &format!("/agents/{id}/approve"),
            None,
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{b}");
        let (s, b) = poll(app.clone(), secret.clone()).await;
        assert_eq!(s, StatusCode::OK, "{b}");
        let token = b["token"].as_str().unwrap().to_string();
        assert!(token.starts_with(TOKEN_PREFIX));
        // The secret is spent once the token is out.
        assert_eq!(poll(app.clone(), secret).await.0, StatusCode::NOT_FOUND);
        (id, token)
    }

    async fn grant(
        app: &Router,
        user: Uuid,
        agent: Uuid,
        item: Uuid,
        extra: Value,
    ) -> (StatusCode, Value) {
        let mut body = json!({ "record": record(), "label": label(), "wrapped_key": "wk", "scope": { "kind": "2fa" } });
        for (k, v) in extra.as_object().unwrap() {
            body[k] = v.clone();
        }
        call(
            app,
            user,
            Method::PUT,
            &format!("/agents/{agent}/grants/{item}"),
            Some(body),
        )
        .await
    }

    #[tokio::test]
    async fn pair_claim_approve_and_use_a_grant() {
        let db = test_db().await;
        let app = app(db.pool.clone());
        let ana = create_user(&db.pool, "personal").await;
        let (agent, token) = connect(&app, ana).await;

        let item = Uuid::new_v4();
        let (s, b) = grant(&app, ana, agent, item, json!({ "commands": ["psql"] })).await;
        assert_eq!(s, StatusCode::OK, "{b}");

        let (s, b) = raw(&app, Some(&token), Method::GET, "/agent/grants", None).await;
        assert_eq!(s, StatusCode::OK);
        let g = &b["grants"][0];
        assert_eq!(g["item_id"], json!(item));
        assert_eq!(g["record"], record());
        assert_eq!(g["wrapped_key"], "wk");
        assert_eq!(g["commands"], json!(["psql"]));

        let (s, _) = raw(
            &app,
            Some(&token),
            Method::POST,
            "/agent/uses",
            Some(json!({ "item_id": item, "action": "run", "detail": "psql" })),
        )
        .await;
        assert_eq!(s, StatusCode::OK);

        let (_, list) = call(&app, ana, Method::GET, "/agents", None).await;
        assert_eq!(list["agents"][0]["status"], "active");
        assert_eq!(list["agents"][0]["grants"][0]["item_id"], json!(item));
        assert!(list["agents"][0]["grants"][0].get("record").is_none());
        assert_eq!(list["activity"][0]["detail"], "psql");
        assert_eq!(list["limits"]["agents"], Value::Null);

        // Revoked: the token stops working.
        let (s, _) = call(&app, ana, Method::DELETE, &format!("/agents/{agent}"), None).await;
        assert_eq!(s, StatusCode::OK);
        let (s, _) = raw(&app, Some(&token), Method::GET, "/agent/grants", None).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn a_user_token_is_not_an_agent_token_and_agents_are_private() {
        let db = test_db().await;
        let app = app(db.pool.clone());
        let ana = create_user(&db.pool, "personal").await;
        let bob = create_user(&db.pool, "personal").await;
        let (agent, _) = connect(&app, ana).await;
        // Bob can't touch Ana's agent.
        let (s, _) = grant(&app, bob, agent, Uuid::new_v4(), json!({})).await;
        assert_eq!(s, StatusCode::NOT_FOUND);
        let (s, _) = call(&app, bob, Method::DELETE, &format!("/agents/{agent}"), None).await;
        assert_eq!(s, StatusCode::NOT_FOUND);
        let (_, list) = call(&app, bob, Method::GET, "/agents", None).await;
        assert_eq!(list["agents"], json!([]));
        // A garbage bearer is refused.
        let (s, _) = raw(&app, Some("otpa_nope"), Method::GET, "/agent/grants", None).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn a_pairing_is_claimed_once_and_needs_a_valid_key() {
        let db = test_db().await;
        let app = app(db.pool.clone());
        let ana = create_user(&db.pool, "personal").await;
        let bob = create_user(&db.pool, "personal").await;
        let (s, _) = raw(
            &app,
            None,
            Method::POST,
            "/agents/pair",
            Some(json!({ "public_key": "abc", "name": "x" })),
        )
        .await;
        assert_eq!(s, StatusCode::BAD_REQUEST);
        // 65 bytes starting with 0x04, but not a point on the curve.
        let bogus = {
            use base64::Engine;
            let mut b = vec![4u8];
            b.extend(std::iter::repeat_n(7u8, 64));
            base64::engine::general_purpose::STANDARD.encode(b)
        };
        let (s, _) = raw(
            &app,
            None,
            Method::POST,
            "/agents/pair",
            Some(json!({ "public_key": bogus, "name": "x" })),
        )
        .await;
        assert_eq!(s, StatusCode::BAD_REQUEST);
        let (_, p) = raw(
            &app,
            None,
            Method::POST,
            "/agents/pair",
            Some(json!({ "public_key": pubkey(), "name": "Codex" })),
        )
        .await;
        let id = p["id"].as_str().unwrap();
        let (s, b) = call(&app, ana, Method::GET, &format!("/agents/pair/{id}"), None).await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(b["name"], "Codex");
        assert_eq!(
            call(
                &app,
                ana,
                Method::POST,
                &format!("/agents/pair/{id}/claim"),
                None
            )
            .await
            .0,
            StatusCode::OK
        );
        assert_eq!(
            call(
                &app,
                bob,
                Method::POST,
                &format!("/agents/pair/{id}/claim"),
                None
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
        // Bob can't approve Ana's pending agent either.
        assert_eq!(
            call(
                &app,
                bob,
                Method::POST,
                &format!("/agents/{id}/approve"),
                None
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
        // Ana sees it pending, also in her notifications.
        let (_, n) = call(&app, ana, Method::GET, "/notifications", None).await;
        assert_eq!(n["agents"]["pending"], 1);
    }

    #[tokio::test]
    async fn free_plan_limits_agents_and_accounts() {
        let db = test_db().await;
        let app = app(db.pool.clone());
        let ana = create_user(&db.pool, "free").await;
        let (agent, _) = connect(&app, ana).await;
        for _ in 0..FREE_AGENT_ITEMS {
            assert_eq!(
                grant(&app, ana, agent, Uuid::new_v4(), json!({})).await.0,
                StatusCode::OK
            );
        }
        let (s, b) = grant(&app, ana, agent, Uuid::new_v4(), json!({})).await;
        assert_eq!(s, StatusCode::BAD_REQUEST);
        assert!(b["error"].as_str().unwrap().contains("free plan"));
        // A second agent can't be claimed.
        let (_, p) = raw(
            &app,
            None,
            Method::POST,
            "/agents/pair",
            Some(json!({ "public_key": pubkey(), "name": "Codex" })),
        )
        .await;
        let id = p["id"].as_str().unwrap();
        assert_eq!(
            call(
                &app,
                ana,
                Method::POST,
                &format!("/agents/pair/{id}/claim"),
                None
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        let (_, list) = call(&app, ana, Method::GET, "/agents", None).await;
        assert_eq!(
            list["limits"],
            json!({ "agents": FREE_AGENTS, "items": FREE_AGENT_ITEMS })
        );
    }

    #[tokio::test]
    async fn expired_and_ask_every_time_grants_hold_back_the_copy() {
        let db = test_db().await;
        let app = app(db.pool.clone());
        let ana = create_user(&db.pool, "personal").await;
        let (agent, token) = connect(&app, ana).await;
        let (old, ask) = (Uuid::new_v4(), Uuid::new_v4());
        grant(
            &app,
            ana,
            agent,
            old,
            json!({ "expires_at": "2020-01-01T00:00:00Z" }),
        )
        .await;
        grant(&app, ana, agent, ask, json!({ "ask_every_time": true })).await;

        let (_, b) = raw(&app, Some(&token), Method::GET, "/agent/grants", None).await;
        let grants = b["grants"].as_array().unwrap();
        assert_eq!(grants.len(), 1, "the expired grant isn't listed");
        assert_eq!(grants[0]["item_id"], json!(ask));
        assert_eq!(grants[0]["record"], Value::Null);
        assert_eq!(
            grants[0]["label"],
            label(),
            "its name is readable to ask for it"
        );
        assert_eq!(grants[0]["wrapped_key"], "wk");

        // The agent asks for one use; the user allows it.
        let (s, r) = raw(
            &app,
            Some(&token),
            Method::POST,
            "/agent/requests",
            Some(json!({ "item_id": ask, "tool": "run" })),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{r}");
        let rid = r["id"].as_str().unwrap().to_string();
        let (_, n) = call(&app, ana, Method::GET, "/notifications", None).await;
        assert_eq!(n["agents"]["requests"], 1);
        let (s, _) = call(
            &app,
            ana,
            Method::POST,
            &format!("/agents/requests/{rid}"),
            Some(json!({ "decision": "allow" })),
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        let (_, st) = raw(
            &app,
            Some(&token),
            Method::GET,
            &format!("/agent/requests/{rid}"),
            None,
        )
        .await;
        assert_eq!(st["status"], "allowed");
        let (_, b) = raw(&app, Some(&token), Method::GET, "/agent/grants", None).await;
        assert_eq!(b["grants"][0]["record"], record());
        assert_eq!(b["grants"][0]["label"], label());
        // Rewritten: the label follows the new value, apart from the copy.
        let new_label =
            json!({ "v": 1, "key": { "iv": "x", "ct": "y" }, "data": { "iv": "z", "ct": "w" } });
        grant(
            &app,
            ana,
            agent,
            ask,
            json!({ "ask_every_time": true, "label": new_label }),
        )
        .await;
        let (_, b) = raw(&app, Some(&token), Method::GET, "/agent/grants", None).await;
        assert_eq!(b["grants"][0]["label"], new_label);
        assert_eq!(b["grants"][0]["record"], record());
        // Asking for an item it has no grant for isn't possible.
        let (s, _) = raw(
            &app,
            Some(&token),
            Method::POST,
            "/agent/requests",
            Some(json!({ "item_id": old })),
        )
        .await;
        assert_eq!(s, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn deleting_the_vault_item_deletes_its_agent_grants() {
        let db = test_db().await;
        let app = app(db.pool.clone())
            .merge(crate::routes::vault::router().with_state(test_state(db.pool.clone())));
        let ana = create_user(&db.pool, "personal").await;
        let (agent, token) = connect(&app, ana).await;
        let item = Uuid::new_v4();
        let (s, b) = call(
            &app,
            ana,
            Method::PUT,
            &format!("/vault/items/{item}"),
            Some(json!({ "record": record() })),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{b}");
        let rev = b["revision"].as_i64().unwrap();
        grant(&app, ana, agent, item, json!({})).await;
        let (s, _) = call(
            &app,
            ana,
            Method::DELETE,
            &format!("/vault/items/{item}?base_revision={rev}"),
            None,
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        let (_, b) = raw(&app, Some(&token), Method::GET, "/agent/grants", None).await;
        assert_eq!(b["grants"], json!([]));
    }

    #[tokio::test]
    async fn a_new_ask_every_time_grant_is_released_once_and_removing_it_ends_the_release() {
        let db = test_db().await;
        let app = app(db.pool.clone());
        let ana = create_user(&db.pool, "personal").await;
        let (agent, token) = connect(&app, ana).await;
        let (_, r) = raw(
            &app,
            Some(&token),
            Method::POST,
            "/agent/requests",
            Some(json!({ "query": "bank" })),
        )
        .await;
        let rid = r["id"].as_str().unwrap().to_string();
        let item = Uuid::new_v4();
        grant(&app, ana, agent, item, json!({ "ask_every_time": true })).await;
        let (s, _) = call(
            &app,
            ana,
            Method::POST,
            &format!("/agents/requests/{rid}"),
            Some(json!({ "decision": "allow", "item_id": item })),
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        let (_, b) = raw(&app, Some(&token), Method::GET, "/agent/grants", None).await;
        assert_eq!(b["grants"][0]["record"], record(), "released for this use");
        // Removed and written again: the old approval doesn't open the new one.
        call(
            &app,
            ana,
            Method::DELETE,
            &format!("/agents/{agent}/grants/{item}"),
            None,
        )
        .await;
        grant(&app, ana, agent, item, json!({ "ask_every_time": true })).await;
        let (_, b) = raw(&app, Some(&token), Method::GET, "/agent/grants", None).await;
        assert_eq!(b["grants"][0]["record"], Value::Null);
    }

    #[tokio::test]
    async fn an_expired_request_cant_be_answered() {
        let db = test_db().await;
        let app = app(db.pool.clone());
        let ana = create_user(&db.pool, "personal").await;
        let (_, token) = connect(&app, ana).await;
        let (_, r) = raw(
            &app,
            Some(&token),
            Method::POST,
            "/agent/requests",
            Some(json!({ "query": "x" })),
        )
        .await;
        let rid: Uuid = r["id"].as_str().unwrap().parse().unwrap();
        sqlx::query(
            "UPDATE agent_requests SET created_at = NOW() - INTERVAL '1 hour' WHERE id = $1",
        )
        .bind(rid)
        .execute(&db.pool)
        .await
        .unwrap();
        let (s, b) = call(
            &app,
            ana,
            Method::POST,
            &format!("/agents/requests/{rid}"),
            Some(json!({ "decision": "deny" })),
        )
        .await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "{b}");
    }

    #[tokio::test]
    async fn a_request_for_a_new_account_is_answered_with_a_grant() {
        let db = test_db().await;
        let app = app(db.pool.clone());
        let ana = create_user(&db.pool, "personal").await;
        let (agent, token) = connect(&app, ana).await;
        let (_, r) = raw(
            &app,
            Some(&token),
            Method::POST,
            "/agent/requests",
            Some(json!({ "query": "github", "reason": "test login" })),
        )
        .await;
        let rid = r["id"].as_str().unwrap().to_string();
        let (_, list) = call(&app, ana, Method::GET, "/agents", None).await;
        assert_eq!(list["requests"][0]["query"], "github");
        let item = Uuid::new_v4();
        // Allowing needs the grant first.
        let (s, _) = call(
            &app,
            ana,
            Method::POST,
            &format!("/agents/requests/{rid}"),
            Some(json!({ "decision": "allow", "item_id": item })),
        )
        .await;
        assert_eq!(s, StatusCode::BAD_REQUEST);
        grant(&app, ana, agent, item, json!({})).await;
        let (s, _) = call(
            &app,
            ana,
            Method::POST,
            &format!("/agents/requests/{rid}"),
            Some(json!({ "decision": "allow", "item_id": item })),
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        let (_, st) = raw(
            &app,
            Some(&token),
            Method::GET,
            &format!("/agent/requests/{rid}"),
            None,
        )
        .await;
        assert_eq!(
            st,
            json!({ "id": rid, "status": "allowed", "item_id": item })
        );
        // Answered once.
        let (s, _) = call(
            &app,
            ana,
            Method::POST,
            &format!("/agents/requests/{rid}"),
            Some(json!({ "decision": "deny" })),
        )
        .await;
        assert_eq!(s, StatusCode::BAD_REQUEST);
    }
}
