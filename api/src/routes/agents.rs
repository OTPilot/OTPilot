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
//! **Plans.** Free: one agent (`FREE_AGENTS`; over it after a downgrade what
//! exists keeps working, only adding is refused), any number of accounts, and
//! `FREE_AGENT_USES` uses a UTC month (mirrored in web/src/lib/agents.ts). A
//! use is one `browser_login` or `run` tool call, counted where the copies are
//! handed out: `POST /agent/grants/open` (`agent_usage`, one row per user and
//! month, so no rollover). On Free that is the only path that gives a copy
//! (`GET /agent/grants` lists labels only). Paid plans and the trial are never
//! counted. It's a meter, not a security boundary: an MCP could keep the
//! copies it opened.
//!
//! **MCP version.** The MCP sends `x-otpilot-mcp: <version>` (`MCP_HEADER`);
//! only its presence is checked. An MCP without it (≤ 0.2.0) still gets copies
//! from `GET /agent/grants` on a paid plan (legacy; TODO: remove once old MCPs
//! are gone), and on Free is told to update (426) when it asks for a use.

use std::time::Duration;

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use chrono::{DateTime, Months, NaiveDate, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    error::{ApiError, Result},
    middleware::{
        agent_auth::{hash_secret, new_secret, AgentAuth, TOKEN_PREFIX},
        auth::AuthUser,
    },
    routes::{collections::lock_team, vault::validate_record},
    AppState,
};

pub const FREE_AGENTS: i64 = 1;
/// Agent uses (a `browser_login` or a `run`) a Free account gets per UTC month.
pub const FREE_AGENT_USES: i32 = 10;
/// Sent by the MCP (≥ 0.3.0) on every call, with its version.
const MCP_HEADER: &str = "x-otpilot-mcp";
/// How long a tool call's `use_id` may be replayed (a retried request).
const REPLAY_MINUTES: i32 = 10;
const MAX_OPEN_ITEMS: usize = 20;
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
        .route(
            "/agents/{id}",
            axum::routing::delete(remove_agent).patch(rename_agent),
        )
        .route("/agents/{id}/approve", post(approve))
        .route("/agents/{id}/activity", get(agent_activity))
        .route(
            "/agents/{id}/grants/{item_id}",
            put(put_grant).delete(remove_grant),
        )
        .route("/agents/requests/{id}", post(decide_request))
        // The MCP server, with its token.
        .route("/agent/me", get(agent_me))
        .route("/agent/grants", get(agent_grants))
        .route("/agent/grants/open", post(open_grants))
        .route("/agent/requests", post(agent_request))
        .route("/agent/requests/{id}", get(agent_request_status))
        .route("/agent/uses", post(agent_use))
        .route("/agent/client", post(agent_client))
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

/// Whether the call comes from an MCP that opens copies with
/// `POST /agent/grants/open` (it sends `MCP_HEADER`).
fn from_new_mcp(headers: &HeaderMap) -> bool {
    headers
        .get(MCP_HEADER)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| !v.trim().is_empty())
}

/// An error body with a machine-readable `code` and more fields.
fn coded(status: StatusCode, error: &str, code: &str, mut extra: Value) -> Response {
    extra["error"] = json!(error);
    extra["code"] = json!(code);
    (status, Json(extra)).into_response()
}

const OUTDATED: &str = "This OTPilot MCP is out of date. Restart your AI agent so it runs the latest @otpilot/mcp (npx -y @otpilot/mcp@latest), then try again.";

fn outdated() -> Response {
    coded(
        StatusCode::UPGRADE_REQUIRED,
        OUTDATED,
        "mcp_outdated",
        json!({}),
    )
}

/// A Free account's agent uses this month. `None` on a paid plan or the trial.
struct FreeUsage {
    used: i32,
    /// The 1st of the month counted (UTC).
    month: NaiveDate,
    /// The Personal trial can still be started (with `trial_enabled`).
    trial_available: bool,
}

impl FreeUsage {
    /// The 1st of next month: when the uses renew.
    fn renews(&self) -> NaiveDate {
        self.month + Months::new(1)
    }

    fn resets_at(&self) -> String {
        self.renews().format("%Y-%m-%dT00:00:00Z").to_string()
    }

    /// "Jul 1".
    fn renews_on(&self) -> String {
        self.renews().format("%b %-d").to_string()
    }

    fn left(&self) -> i32 {
        (FREE_AGENT_USES - self.used).max(0)
    }

    /// What the agent gets (`GET /agent/grants`, `POST /agent/grants/open`):
    /// `notice` is the line `list_accounts` shows.
    fn for_agent(&self, state: &AppState) -> Value {
        let notice = match self.left() {
            0 => format!(
                "Free plan: no uses left this month (renews {}). Upgrade: {}",
                self.renews_on(),
                upgrade_url(state)
            ),
            left => format!(
                "Free plan: {left} of {FREE_AGENT_USES} uses left this month (renews {}).",
                self.renews_on()
            ),
        };
        json!({
            "used": self.used, "limit": FREE_AGENT_USES,
            "resets_at": self.resets_at(), "notice": notice,
        })
    }

    /// What the user's extension gets (`GET /agents`).
    fn for_user(&self, state: &AppState) -> Value {
        json!({
            "used": self.used, "limit": FREE_AGENT_USES, "resets_at": self.resets_at(),
            "trial_available": state.trial_enabled && self.trial_available,
        })
    }

    /// 402: this month's uses are all used.
    fn exhausted(&self, state: &AppState) -> Response {
        let url = upgrade_url(state);
        let trial = state.trial_enabled && self.trial_available;
        let mut error = format!(
            "You've used your {FREE_AGENT_USES} free agent uses for this month. They renew on {}. \
             Upgrade to Personal for unlimited uses ($3/month or $30/year) at {url}",
            self.renews_on()
        );
        if trial {
            error.push_str(&format!(
                ", or start the free {}-day trial there, no card needed.",
                crate::trial::TRIAL_DAYS
            ));
        } else {
            error.push('.');
        }
        coded(
            StatusCode::PAYMENT_REQUIRED,
            &error,
            "agent_uses_exhausted",
            json!({
                "used": self.used, "limit": FREE_AGENT_USES, "resets_at": self.resets_at(),
                "upgrade_url": url, "trial_available": trial,
                "trial_days": crate::trial::TRIAL_DAYS,
            }),
        )
    }
}

fn upgrade_url(state: &AppState) -> String {
    format!(
        "{}/dashboard/billing",
        state.app_base_url.trim_end_matches('/')
    )
}

/// `user`'s uses this month when they're on Free (a missing users row reads
/// as Free, like `is_free`), `None` on a paid plan or the trial. Call
/// `trial::expire` first so a trial that just ended counts at once.
async fn free_usage<'e, E: sqlx::PgExecutor<'e>>(db: E, user: Uuid) -> Result<Option<FreeUsage>> {
    let (plan, trial_available, month, used): (String, bool, NaiveDate, i32) = sqlx::query_as(
        "SELECT COALESCE(u.plan, 'free'),
                COALESCE(u.trial_ends_at IS NULL AND NOT u.has_personal_cloud, false),
                m.month, COALESCE(c.uses, 0)
         FROM (SELECT date_trunc('month', NOW() AT TIME ZONE 'UTC')::date AS month) m
         LEFT JOIN users u ON u.id = $1
         LEFT JOIN agent_usage c ON c.user_id = $1 AND c.month = m.month",
    )
    .bind(user)
    .fetch_one(db)
    .await?;
    Ok((plan == "free").then_some(FreeUsage {
        used,
        month,
        trial_available,
    }))
}

/// The user an (active, so claimed) agent belongs to.
async fn agent_user(db: &sqlx::PgPool, agent: Uuid) -> Result<Uuid> {
    sqlx::query_scalar::<_, Option<Uuid>>("SELECT user_id FROM agents WHERE id = $1")
        .bind(agent)
        .fetch_optional(db)
        .await?
        .flatten()
        .ok_or(ApiError::Unauthorized)
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
    // Answered requests are kept a day, then forgotten (the activity log is
    // `agent_uses`): never one whose released copy is still in use.
    sqlx::query(
        "DELETE FROM agent_requests WHERE status <> 'pending'
           AND COALESCE(decided_at, created_at) < NOW() - INTERVAL '1 day'
           AND (released_until IS NULL OR released_until < NOW())",
    )
    .execute(db)
    .await?;
    // A tool call's use_id is only replayed for minutes.
    sqlx::query("DELETE FROM agent_use_tokens WHERE created_at < NOW() - INTERVAL '1 day'")
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

#[derive(Deserialize)]
struct ActivityParams {
    limit: Option<i64>,
    /// The `id` of the last use already shown: the page goes on from there.
    before: Option<i64>,
}

#[derive(sqlx::FromRow)]
struct UsePage {
    id: i64,
    item_id: Option<Uuid>,
    action: String,
    detail: String,
    created_at: DateTime<Utc>,
}

/// One agent's activity, newest first, a page at a time: `{ items, more }`.
async fn agent_activity(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<Uuid>,
    Query(params): Query<ActivityParams>,
) -> Result<Json<Value>> {
    let limit = params.limit.unwrap_or(10).clamp(1, 100);
    let mine: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM agents WHERE id = $1 AND user_id = $2)")
            .bind(id)
            .bind(auth.id)
            .fetch_one(&state.db)
            .await?;
    if !mine {
        return Err(ApiError::NotFound);
    }
    let mut rows = sqlx::query_as::<_, UsePage>(
        "SELECT id, item_id, action, detail, created_at FROM agent_uses
         WHERE agent_id = $1 AND ($2::BIGINT IS NULL OR id < $2)
         ORDER BY id DESC LIMIT $3",
    )
    .bind(id)
    .bind(params.before)
    .bind(limit + 1)
    .fetch_all(&state.db)
    .await?;
    let more = rows.len() as i64 > limit;
    rows.truncate(limit as usize);
    Ok(Json(json!({
        "items": rows.iter().map(|u| json!({
            "id": u.id, "item_id": u.item_id, "action": u.action,
            "detail": u.detail, "created_at": u.created_at,
        })).collect::<Vec<_>>(),
        "more": more,
    })))
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
    client: Option<String>,
    client_version: Option<String>,
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
/// activity, the plan's limits and (Free) this month's agent uses.
async fn list(State(state): State<AppState>, auth: AuthUser) -> Result<Json<Value>> {
    expire(&state.db).await?;
    crate::trial::expire(&state.db, Some(auth.id)).await?;
    let agents = sqlx::query_as::<_, AgentRow>(
        "SELECT id, name, machine, public_key, status, created_at, approved_at, last_used_at,
                client, client_version
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
    let usage = free_usage(&state.db, auth.id).await?;
    Ok(Json(json!({
        "agents": agents.iter().map(|a| json!({
            "id": a.id, "name": a.name, "machine": a.machine, "public_key": a.public_key,
            "status": a.status, "created_at": a.created_at, "approved_at": a.approved_at,
            "last_used_at": a.last_used_at,
            "client": a.client, "client_version": a.client_version,
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
        "limits": if usage.is_some() {
            json!({ "agents": FREE_AGENTS, "uses": FREE_AGENT_USES })
        } else {
            json!({ "agents": null, "uses": null })
        },
        "usage": usage.as_ref().map(|u| u.for_user(&state)),
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
    /// Rewriting a copy the client read (an item changed): only while the
    /// grant is still there at this revision — one the user removed or
    /// changed meanwhile is never brought back (404).
    #[serde(default)]
    base_revision: Option<i64>,
    /// Moving the grant of item `move_from` to this item (the vault gave the
    /// item a new id): in one step, only while that grant is still at
    /// `base_revision`.
    #[serde(default)]
    move_from: Option<Uuid>,
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

/// Writes the agent's copy of one of the user's items (new or updated). An
/// item shared with the user (a share or a collection item, not one of their
/// own vault items) only while they open it: 404 otherwise, so a stale or
/// concurrent write never brings back a copy a revocation took away.
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
    // Lock order (see "Losing a shared item" below): the shared item's team
    // lock(s), the users row, the share / collection item row, the grant row.
    let teams = shared_item_teams(&mut tx, auth.id, item_id).await?;
    for team in &teams {
        lock_team(&mut tx, *team).await?;
    }
    lock_user(&mut tx, auth.id).await?;
    if own_agent(&mut tx, auth.id, id).await? != "active" {
        return Err(ApiError::NotFound);
    }
    if !teams.is_empty() && !still_reaches(&mut tx, auth.id, item_id).await? {
        return Err(ApiError::NotFound);
    }
    let revision_of = |item: Uuid| {
        sqlx::query_scalar::<_, i64>(
            "SELECT revision FROM agent_grants WHERE agent_id = $1 AND item_id = $2 FOR UPDATE",
        )
        .bind(id)
        .bind(item)
    };
    if let Some(from) = body.move_from {
        // Both grant rows locked in (agent_id, item_id) order, as
        // `revoke_lost_agent_copies` does, so the two wait for each other
        // instead of deadlocking.
        let locked: Vec<(Uuid, i64)> = sqlx::query_as(
            "SELECT item_id, revision FROM agent_grants
             WHERE agent_id = $1 AND item_id IN ($2, $3)
             ORDER BY agent_id, item_id FOR UPDATE",
        )
        .bind(id)
        .bind(from)
        .bind(item_id)
        .fetch_all(&mut *tx)
        .await?;
        // The source must still be there as read; it goes, this takes its place.
        let source = locked.iter().find(|(i, _)| *i == from).map(|(_, r)| *r);
        if source.is_none() || (body.base_revision.is_some() && body.base_revision != source) {
            return Err(ApiError::NotFound);
        }
        sqlx::query("DELETE FROM agent_grants WHERE agent_id = $1 AND item_id = $2")
            .bind(id)
            .bind(from)
            .execute(&mut *tx)
            .await?;
        // As when a grant is removed: an approval of the old item releases nothing later.
        sqlx::query(
            "UPDATE agent_requests SET released_until = NULL
             WHERE agent_id = $1 AND item_id = $2 AND released_until IS NOT NULL",
        )
        .bind(id)
        .bind(from)
        .execute(&mut *tx)
        .await?;
    } else {
        let current: Option<i64> = revision_of(item_id).fetch_optional(&mut *tx).await?;
        if body.base_revision.is_some() && body.base_revision != current {
            return Err(ApiError::NotFound);
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
    /// Not expired.
    live: bool,
    /// Its copy may be handed out now (`RELEASED`).
    open: bool,
}

impl AgentGrantRow {
    fn json(&self, with_record: bool) -> Value {
        json!({
            "item_id": self.item_id, "scope": self.scope, "expires_at": self.expires_at,
            "ask_every_time": self.ask_every_time, "commands": self.commands,
            "revision": self.revision,
            "record": if with_record { serde_json::from_str::<Value>(&self.encrypted_item).unwrap_or(Value::Null) } else { Value::Null },
            "label": serde_json::from_str::<Value>(&self.label).unwrap_or(Value::Null),
            "wrapped_key": self.wrapped_key,
        })
    }
}

/// Whether grant `g` is still in force (not expired). No input in it.
const LIVE: &str = "(g.expires_at IS NULL OR g.expires_at > NOW())";

/// Whether grant `g` (in force) hands out its copy now: it doesn't ask every
/// time, or a one-time approval of it is still in its window (handing the
/// copy out doesn't end the window). The one rule for `GET /agent/grants` and
/// `POST /agent/grants/open`. No input in it.
const RELEASED: &str = "(NOT g.ask_every_time OR EXISTS(SELECT 1 FROM agent_requests r
                WHERE r.agent_id = g.agent_id AND r.item_id = g.item_id
                  AND r.status = 'allowed' AND r.released_until > NOW()))";

fn grant_rows_sql(filter: &str) -> String {
    format!(
        "SELECT g.item_id, g.scope, g.encrypted_item, g.label, g.wrapped_key, g.expires_at,
                g.ask_every_time, g.commands, g.revision, {LIVE} AS live, {RELEASED} AS open
         FROM agent_grants g
         WHERE g.agent_id = $1 AND {filter}
         ORDER BY g.created_at"
    )
}

/// The agent's grants. An expired grant isn't listed. Each comes with its
/// label (title, sites); its copy (`record`) only for an MCP without
/// `MCP_HEADER` on a paid plan, while the grant releases it (legacy: newer
/// MCPs open copies with `POST /agent/grants/open`, and Free only gets them
/// there, where uses are counted). `usage`: this month's uses on Free.
async fn agent_grants(
    State(state): State<AppState>,
    agent: AgentAuth,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let user = agent_user(&state.db, agent.agent_id).await?;
    crate::trial::expire(&state.db, Some(user)).await?;
    let usage = free_usage(&state.db, user).await?;
    // TODO: once MCPs ≤ 0.2.0 are gone, never hand out copies here.
    let legacy = usage.is_none() && !from_new_mcp(&headers);
    let rows = sqlx::query_as::<_, AgentGrantRow>(&grant_rows_sql(LIVE))
        .bind(agent.agent_id)
        .fetch_all(&state.db)
        .await?;
    Ok(Json(json!({
        "grants": rows.iter().map(|g| g.json(legacy && g.open)).collect::<Vec<_>>(),
        "usage": usage.as_ref().map(|u| u.for_agent(&state)),
    })))
}

/// Opens per agent per hour (a loop of calls can't grow the tables or the log).
const OPEN_PER_HOUR: u32 = 300;

#[derive(Deserialize)]
struct OpenBody {
    use_id: Uuid,
    tool: String,
    item_ids: Vec<Uuid>,
}

/// Hands out the copies one tool call uses (`browser_login`, or a `run` with
/// one or more accounts), all or none, and on Free counts it as one use.
/// `use_id` is the call's: a retry with the same id, tool and accounts within
/// `REPLAY_MINUTES` gets them again without counting.
async fn open_grants(
    State(state): State<AppState>,
    agent: AgentAuth,
    body: std::result::Result<Json<OpenBody>, axum::extract::rejection::JsonRejection>,
) -> Result<Response> {
    if !state.rate_limiter.check(
        &format!("agent-open:{}", agent.agent_id),
        OPEN_PER_HOUR,
        Duration::from_secs(3600),
    ) {
        return Err(ApiError::TooManyRequests);
    }
    let Json(body) = body.map_err(|e| ApiError::BadRequest(e.body_text()))?;
    if !matches!(body.tool.as_str(), "browser_login" | "run") {
        return Err(ApiError::BadRequest(
            "tool must be browser_login or run".into(),
        ));
    }
    let mut ids = body.item_ids.clone();
    ids.sort();
    ids.dedup();
    if ids.is_empty() || ids.len() > MAX_OPEN_ITEMS || ids.len() != body.item_ids.len() {
        return Err(ApiError::BadRequest(format!(
            "item_ids: 1-{MAX_OPEN_ITEMS} different ids"
        )));
    }
    let user = agent_user(&state.db, agent.agent_id).await?;
    crate::trial::expire(&state.db, Some(user)).await?;
    let mut tx = state.db.begin().await?;
    let rows = sqlx::query_as::<_, AgentGrantRow>(&grant_rows_sql("g.item_id = ANY($2)"))
        .bind(agent.agent_id)
        .bind(&ids)
        .fetch_all(&mut *tx)
        .await?;
    let missing: Vec<Uuid> = ids
        .iter()
        .filter(|id| !rows.iter().any(|g| g.item_id == **id && g.live))
        .copied()
        .collect();
    if !missing.is_empty() {
        return Ok(coded(
            StatusCode::NOT_FOUND,
            "not allowed (any more): ask the user with request_access",
            "not_granted",
            json!({ "item_ids": missing }),
        ));
    }
    let held: Vec<Uuid> = rows.iter().filter(|g| !g.open).map(|g| g.item_id).collect();
    if !held.is_empty() {
        return Ok(coded(
            StatusCode::CONFLICT,
            "this use needs the user's approval (it asks every time)",
            "approval_needed",
            json!({ "item_ids": held }),
        ));
    }
    let mut usage = free_usage(&mut *tx, user).await?;
    // Only a counted call (Free) needs a token for its retry; paid and trial
    // calls just open again, so nothing is written for them.
    let mut counted_new = false;
    if usage.is_some() {
        let new: Option<Uuid> = sqlx::query_scalar(
            "INSERT INTO agent_use_tokens (id, agent_id, user_id, tool, item_ids)
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING RETURNING id",
        )
        .bind(body.use_id)
        .bind(agent.agent_id)
        .bind(user)
        .bind(&body.tool)
        .bind(&ids)
        .fetch_optional(&mut *tx)
        .await?;
        if new.is_none() {
            // A retry of the same call, or an id used for something else.
            let replay: bool = sqlx::query_scalar(&format!(
                "SELECT EXISTS(SELECT 1 FROM agent_use_tokens
                   WHERE id = $1 AND agent_id = $2 AND tool = $3 AND item_ids = $4
                     AND created_at > NOW() - INTERVAL '{REPLAY_MINUTES} minutes')"
            ))
            .bind(body.use_id)
            .bind(agent.agent_id)
            .bind(&body.tool)
            .bind(&ids)
            .fetch_one(&mut *tx)
            .await?;
            if !replay {
                return Ok(coded(
                    StatusCode::BAD_REQUEST,
                    "use_id was already used for another call: send a new one",
                    "use_id_reused",
                    json!({}),
                ));
            }
        }
        counted_new = new.is_some();
    }
    if let (Some(u), true) = (usage.as_mut(), counted_new) {
        // One at a time per user (the row's lock): at the last use left,
        // only one of two calls gets it.
        let counted: Option<i32> = sqlx::query_scalar(
            "INSERT INTO agent_usage (user_id, month, uses) VALUES ($1, $2, 1)
             ON CONFLICT (user_id, month) DO UPDATE SET uses = agent_usage.uses + 1
               WHERE agent_usage.uses < $3
             RETURNING uses",
        )
        .bind(user)
        .bind(u.month)
        .bind(FREE_AGENT_USES)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(used) = counted else {
            // Rolled back, the token too: nothing was used.
            u.used = FREE_AGENT_USES;
            return Ok(u.exhausted(&state));
        };
        u.used = used;
    }
    tx.commit().await?;
    Ok(Json(json!({
        "grants": rows.iter().map(|g| g.json(true)).collect::<Vec<_>>(),
        "usage": usage.as_ref().map(|u| u.for_agent(&state)),
    }))
    .into_response())
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
/// of an "ask every time" grant (`item_id`). On Free, a use is only asked for
/// by an MCP that counts it (426 otherwise) and while one is left (402: the
/// user isn't asked to approve what `open_grants` would refuse; nothing is
/// counted here).
async fn agent_request(
    State(state): State<AppState>,
    agent: AgentAuth,
    headers: HeaderMap,
    Json(body): Json<AgentRequestBody>,
) -> Result<Response> {
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
    let usage = match body.item_id {
        Some(_) => {
            let user = agent_user(&state.db, agent.agent_id).await?;
            crate::trial::expire(&state.db, Some(user)).await?;
            free_usage(&state.db, user).await?
        }
        None => None,
    };
    if usage.is_some() && !from_new_mcp(&headers) {
        return Ok(outdated());
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
        if let Some(u) = usage.filter(|u| u.left() == 0) {
            return Ok(u.exhausted(&state));
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
    Ok(Json(json!({ "id": id, "status": "pending" })).into_response())
}

async fn agent_request_status(
    State(state): State<AppState>,
    agent: AgentAuth,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    expire(&state.db).await?;
    // `released`: this request's approval still releases the copy now (an
    // allowed request whose window passed isn't one to use any more).
    let row: Option<(String, Option<Uuid>, bool)> = sqlx::query_as(
        "SELECT status, item_id, COALESCE(released_until > NOW(), false)
         FROM agent_requests WHERE id = $1 AND agent_id = $2",
    )
    .bind(id)
    .bind(agent.agent_id)
    .fetch_optional(&state.db)
    .await?;
    let (status, item_id, released) = row.ok_or(ApiError::NotFound)?;
    Ok(Json(
        json!({ "id": id, "status": status, "item_id": item_id, "released": released }),
    ))
}

#[derive(Deserialize)]
struct RenameBody {
    name: String,
}

/// The user renames one of their agents (any status).
async fn rename_agent(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<Uuid>,
    Json(body): Json<RenameBody>,
) -> Result<Json<Value>> {
    let name = text(&body.name, 60);
    if name.is_empty() {
        return Err(ApiError::BadRequest("name is required".into()));
    }
    let done = sqlx::query("UPDATE agents SET name = $3 WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(auth.id)
        .bind(&name)
        .execute(&state.db)
        .await?;
    if done.rows_affected() == 0 {
        return Err(ApiError::NotFound);
    }
    Ok(Json(json!({ "id": id, "name": name })))
}

#[derive(Deserialize)]
struct ClientBody {
    name: String,
    #[serde(default)]
    version: String,
}

/// The MCP server reports the client it runs in (its MCP `clientInfo`) when
/// a session starts, so the user can tell agents apart.
async fn agent_client(
    State(state): State<AppState>,
    agent: AgentAuth,
    Json(body): Json<ClientBody>,
) -> Result<Json<Value>> {
    let name = text(&body.name, 60);
    if name.is_empty() {
        return Err(ApiError::BadRequest("name is required".into()));
    }
    sqlx::query("UPDATE agents SET client = $2, client_version = $3 WHERE id = $1")
        .bind(agent.agent_id)
        .bind(&name)
        .bind(Some(text(&body.version, 40)).filter(|v| !v.is_empty()))
        .execute(&state.db)
        .await?;
    Ok(Json(json!({ "ok": true })))
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

// ── Losing a shared item ───────────────────────────────────────────────────
//
// An agent's copy of an item shared with its user (a share or a collection
// item, `g.item_id` = the share / collection item id) goes in the same
// transaction as the user losing access to that item. Access is lost through
// statements, FK cascades and triggers (`share_grant_removed`,
// `collection_member_removed`), so this runs in two steps around the change:
// `agent_copies_at_risk` before it (the grants whose user opens the item
// right now), `revoke_lost_agent_copies` as the transaction's last write (the
// ones whose user no longer does). A grant never goes because its item isn't
// found: a Free user's own items aren't on the server, and they're never on
// the step-1 list (their user doesn't open them as a share or collection
// item).
//
// Every path that can take access away calls the pair:
// shares::delete_share, shares::remove_grant, vault::delete_item (the
// owner's item and so its shares), collections::delete_collection,
// collections::remove_member, collections::delete_item,
// collections::convert_item, teams::remove_member_atomic,
// teams::dissolve_team. A new one must too.
//
// The other half is `put_grant`: a grant of a share or collection item is
// only written while its user opens it, so one exists only while they do
// (a share deleted altogether, or a deleted collection's item, leaves no row:
// its id reads like a Free vault's item, and a new write of it is accepted;
// a rewrite with `base_revision` isn't, its grant being gone).
// A write racing a revocation must not slip between the revocation's step 1
// and its change. Before step 1 every path holds a lock `put_grant` takes
// before its own check: the team lock (`collections::lock_team`: shares
// writes, collection membership / deletion, convert, team departure and
// dissolution), or the item's row FOR UPDATE where no team lock is taken
// (vault::delete_item locks the shares of the item, collections::delete_item
// the collection item; `put_grant` holds them FOR SHARE). `put_grant`'s
// order — team lock(s), users row, share / item row, grant row — follows the
// paths' (team lock before the users rows they downgrade, rows before the
// grants they delete; `revoke_lost_agent_copies` locks those in
// (agent_id, item_id) order), so they wait instead of deadlocking.

/// Whether `g.item_id` is one of the grant's user's own personal vault items:
/// a share or collection item with the same id (ids are client-chosen) never
/// makes it theirs to lose. No input in it.
const OWN: &str = "(EXISTS (SELECT 1 FROM vault_items o
                WHERE o.id = g.item_id AND o.collection_id IS NULL AND o.owner_id = a.user_id))";

/// Whether the grant's user (`a.user_id`) opens `g.item_id` today as a share
/// (directly or through a collection, never their own: as
/// `shares::list_with_me`) or as a collection item. No input in it.
const REACH: &str = "(EXISTS (SELECT 1 FROM shares s JOIN share_grants sg ON sg.share_id = s.id
                LEFT JOIN collection_members m
                  ON m.collection_id = sg.collection_id AND m.user_id = a.user_id
                WHERE s.id = g.item_id AND s.owner_id <> a.user_id
                  AND (sg.user_id = a.user_id OR m.user_id IS NOT NULL))
  OR EXISTS (SELECT 1 FROM vault_items v
                JOIN collection_members m ON m.collection_id = v.collection_id
                WHERE v.id = g.item_id AND v.deleted_at IS NULL AND m.user_id = a.user_id))";

/// The teams of `item` when it's a share or a collection item and not one of
/// `user`'s own vault items (empty: an own item, or one the server doesn't
/// have, like a Free vault's), in id order: the team locks `put_grant` takes.
async fn shared_item_teams(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user: Uuid,
    item: Uuid,
) -> Result<Vec<Uuid>> {
    Ok(sqlx::query_scalar(&format!(
        "SELECT t FROM (SELECT team_id FROM shares WHERE id = $1
                        UNION SELECT c.team_id FROM vault_items v
                              JOIN collections c ON c.id = v.collection_id WHERE v.id = $1) x(t)
         WHERE NOT EXISTS (SELECT 1 FROM (SELECT $1::uuid AS item_id) g, (SELECT $2::uuid AS user_id) a
                           WHERE {OWN})
         ORDER BY t"
    ))
    .bind(item)
    .bind(user)
    .fetch_all(&mut **tx)
    .await?)
}

/// Whether `user` opens shared `item` now, under its team lock(s): the share
/// or collection item row is held FOR SHARE until the grant commits, so a
/// deletion that doesn't take the team lock waits for it (or was seen).
async fn still_reaches(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user: Uuid,
    item: Uuid,
) -> Result<bool> {
    sqlx::query("SELECT 1 FROM shares WHERE id = $1 FOR SHARE")
        .bind(item)
        .fetch_all(&mut **tx)
        .await?;
    sqlx::query("SELECT 1 FROM vault_items WHERE id = $1 AND collection_id IS NOT NULL FOR SHARE")
        .bind(item)
        .fetch_all(&mut **tx)
        .await?;
    Ok(sqlx::query_scalar(&format!(
        "SELECT {REACH} FROM (SELECT $1::uuid AS item_id) g, (SELECT $2::uuid AS user_id) a"
    ))
    .bind(item)
    .bind(user)
    .fetch_one(&mut **tx)
    .await?)
}

/// Which shared items a change may take away from someone.
pub(crate) enum SharedScope<'a> {
    /// Share ids or collection item ids.
    Ids(&'a [Uuid]),
    /// The shares of one of `owner`'s items.
    SharesOfItem { owner: Uuid, item: Uuid },
    /// A collection's items and the shares granted to it.
    Collection(Uuid),
    /// A team's shares and its collections' items.
    Team(Uuid),
}

/// The (agent, item) grants whose user opened the item before the change.
#[must_use = "call revoke_lost_agent_copies after the change"]
pub(crate) struct AtRisk(Vec<(Uuid, Uuid)>);

/// Step 1, before the change: the agent copies of the scope's shared items
/// whose user can open them now.
pub(crate) async fn agent_copies_at_risk(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    scope: SharedScope<'_>,
) -> Result<AtRisk> {
    let candidates = match scope {
        SharedScope::Ids(_) => "SELECT unnest($1::uuid[])",
        SharedScope::SharesOfItem { .. } => {
            "SELECT id FROM shares WHERE owner_id = $1 AND item_id = $2"
        }
        SharedScope::Collection(_) => {
            "SELECT id FROM vault_items WHERE collection_id = $1 AND deleted_at IS NULL
             UNION SELECT share_id FROM share_grants WHERE collection_id = $1"
        }
        SharedScope::Team(_) => {
            "SELECT id FROM shares WHERE team_id = $1
             UNION SELECT v.id FROM vault_items v JOIN collections c ON c.id = v.collection_id
                   WHERE c.team_id = $1 AND v.deleted_at IS NULL"
        }
    };
    let sql = format!(
        "WITH c(id) AS ({candidates})
         SELECT g.agent_id, g.item_id FROM agent_grants g JOIN agents a ON a.id = g.agent_id
         WHERE g.item_id IN (SELECT id FROM c) AND {REACH} AND NOT {OWN}"
    );
    let query = sqlx::query_as::<_, (Uuid, Uuid)>(&sql);
    let query = match scope {
        SharedScope::Ids(ids) => query.bind(ids),
        SharedScope::SharesOfItem { owner, item } => query.bind(owner).bind(item),
        SharedScope::Collection(id) | SharedScope::Team(id) => query.bind(id),
    };
    Ok(AtRisk(query.fetch_all(&mut **tx).await?))
}

/// Step 2, the transaction's last write: deletes the copies on the step-1
/// list whose user no longer opens the item, and ends their one-time
/// releases (as `remove_grant`). Returns how many went.
pub(crate) async fn revoke_lost_agent_copies(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    at_risk: AtRisk,
) -> Result<u64> {
    if at_risk.0.is_empty() {
        return Ok(0);
    }
    let (agents, items): (Vec<Uuid>, Vec<Uuid>) = at_risk.0.into_iter().unzip();
    // Locked first in a stable order: two revocations over the same grants
    // wait for each other instead of deadlocking.
    sqlx::query(
        "SELECT 1 FROM agent_grants g
         JOIN UNNEST($1::uuid[], $2::uuid[]) AS r(agent_id, item_id)
           ON g.agent_id = r.agent_id AND g.item_id = r.item_id
         ORDER BY g.agent_id, g.item_id FOR UPDATE OF g",
    )
    .bind(&agents)
    .bind(&items)
    .fetch_all(&mut **tx)
    .await?;
    let gone: Vec<(Uuid, Uuid)> = sqlx::query_as(&format!(
        "DELETE FROM agent_grants g
         USING agents a, UNNEST($1::uuid[], $2::uuid[]) AS r(agent_id, item_id)
         WHERE g.agent_id = r.agent_id AND g.item_id = r.item_id AND a.id = g.agent_id
           AND NOT {REACH} AND NOT {OWN}
         RETURNING g.agent_id, g.item_id"
    ))
    .bind(&agents)
    .bind(&items)
    .fetch_all(&mut **tx)
    .await?;
    if gone.is_empty() {
        return Ok(0);
    }
    let (agents, items): (Vec<Uuid>, Vec<Uuid>) = gone.iter().copied().unzip();
    sqlx::query(
        "UPDATE agent_requests q SET released_until = NULL
         FROM UNNEST($1::uuid[], $2::uuid[]) AS d(agent_id, item_id)
         WHERE q.agent_id = d.agent_id AND q.item_id = d.item_id
           AND q.released_until IS NOT NULL",
    )
    .bind(&agents)
    .bind(&items)
    .execute(&mut **tx)
    .await?;
    Ok(gone.len() as u64)
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
        send(app, bearer, false, method, uri, body).await
    }

    /// An agent-token call from a current MCP (it sends `MCP_HEADER`).
    async fn mcp(
        app: &Router,
        token: &str,
        method: Method,
        uri: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        send(app, Some(token), true, method, uri, body).await
    }

    async fn send(
        app: &Router,
        bearer: Option<&str>,
        new_mcp: bool,
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
        if new_mcp {
            req = req.header(MCP_HEADER, "0.3.0");
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
    async fn a_grant_moves_to_a_new_item_id_in_one_step() {
        let db = test_db().await;
        let app = app(db.pool.clone());
        let ana = create_user(&db.pool, "free").await;
        let (agent, _token) = connect(&app, ana).await;
        let items: Vec<Uuid> = (0..3).map(|_| Uuid::new_v4()).collect();
        let mut revs = vec![];
        for item in &items {
            let (s, b) = grant(&app, ana, agent, *item, json!({})).await;
            assert_eq!(s, StatusCode::OK);
            revs.push(b["revision"].as_i64().unwrap());
        }
        // Free: a move goes through like any rewrite.
        let moved = Uuid::new_v4();
        let (s, _) = grant(
            &app,
            ana,
            agent,
            moved,
            json!({ "move_from": items[0], "base_revision": revs[0] }),
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        let ids: Vec<Uuid> =
            sqlx::query_scalar("SELECT item_id FROM agent_grants WHERE agent_id = $1")
                .bind(agent)
                .fetch_all(&db.pool)
                .await
                .unwrap();
        assert_eq!(ids.len(), 3);
        assert!(ids.contains(&moved) && !ids.contains(&items[0]));
        // A source changed meanwhile: no move.
        grant(
            &app,
            ana,
            agent,
            items[1],
            json!({ "scope": { "kind": "login" } }),
        )
        .await;
        let (s, _) = grant(
            &app,
            ana,
            agent,
            Uuid::new_v4(),
            json!({ "move_from": items[1], "base_revision": revs[1] }),
        )
        .await;
        assert_eq!(s, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn a_rewrite_never_brings_back_a_removed_or_changed_grant() {
        let db = test_db().await;
        let app = app(db.pool.clone());
        let ana = create_user(&db.pool, "personal").await;
        let (agent, _token) = connect(&app, ana).await;
        let item = Uuid::new_v4();
        let (s, first) = grant(&app, ana, agent, item, json!({})).await;
        assert_eq!(s, StatusCode::OK);
        let rev = first["revision"].as_i64().unwrap();
        // Changed meanwhile (the user narrowed it): a rewrite of the old revision is refused.
        let (_, second) = grant(
            &app,
            ana,
            agent,
            item,
            json!({ "scope": { "kind": "login" } }),
        )
        .await;
        let (s, _) = grant(&app, ana, agent, item, json!({ "base_revision": rev })).await;
        assert_eq!(s, StatusCode::NOT_FOUND);
        // Removed meanwhile: not recreated.
        call(
            &app,
            ana,
            Method::DELETE,
            &format!("/agents/{agent}/grants/{item}"),
            None,
        )
        .await;
        let (s, _) = grant(
            &app,
            ana,
            agent,
            item,
            json!({ "base_revision": second["revision"] }),
        )
        .await;
        assert_eq!(s, StatusCode::NOT_FOUND);
        let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM agent_grants WHERE agent_id = $1")
            .bind(agent)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(left, 0);
    }

    #[tokio::test]
    async fn an_agent_reports_its_client_and_the_user_renames_it() {
        let db = test_db().await;
        let app = app(db.pool.clone());
        let ana = create_user(&db.pool, "personal").await;
        let bob = create_user(&db.pool, "personal").await;
        let (agent, token) = connect(&app, ana).await;
        let (s, _) = raw(
            &app,
            Some(&token),
            Method::POST,
            "/agent/client",
            Some(json!({ "name": "claude-code", "version": "2.1.7" })),
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        let (s, _) = call(
            &app,
            ana,
            Method::PATCH,
            &format!("/agents/{agent}"),
            Some(json!({ "name": "  Work laptop  " })),
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        let (_, list) = call(&app, ana, Method::GET, "/agents", None).await;
        let a = &list["agents"][0];
        assert_eq!(
            [&a["name"], &a["client"], &a["client_version"]],
            [
                &json!("Work laptop"),
                &json!("claude-code"),
                &json!("2.1.7")
            ]
        );
        let (s, _) = call(
            &app,
            ana,
            Method::PATCH,
            &format!("/agents/{agent}"),
            Some(json!({ "name": " " })),
        )
        .await;
        assert_eq!(s, StatusCode::BAD_REQUEST);
        let (s, _) = call(
            &app,
            bob,
            Method::PATCH,
            &format!("/agents/{agent}"),
            Some(json!({ "name": "Mine" })),
        )
        .await;
        assert_eq!(s, StatusCode::NOT_FOUND);
        let (s, _) = raw(
            &app,
            None,
            Method::POST,
            "/agent/client",
            Some(json!({ "name": "x" })),
        )
        .await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn an_agents_activity_comes_a_page_at_a_time() {
        let db = test_db().await;
        let app = app(db.pool.clone());
        let ana = create_user(&db.pool, "personal").await;
        let bob = create_user(&db.pool, "personal").await;
        let (agent, token) = connect(&app, ana).await;
        for i in 0..13 {
            let (s, _) = raw(
                &app,
                Some(&token),
                Method::POST,
                "/agent/uses",
                Some(json!({ "action": "run", "detail": format!("cmd {i}") })),
            )
            .await;
            assert_eq!(s, StatusCode::OK);
        }
        let details = |b: &Value| {
            b["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|u| u["detail"].as_str().unwrap().to_string())
                .collect::<Vec<_>>()
        };
        let (s, first) = call(
            &app,
            ana,
            Method::GET,
            &format!("/agents/{agent}/activity"),
            None,
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{first}");
        assert_eq!(
            details(&first),
            (3..13)
                .rev()
                .map(|i| format!("cmd {i}"))
                .collect::<Vec<_>>()
        );
        assert_eq!(first["more"], true);
        let last = first["items"][9]["id"].as_i64().unwrap();
        let (_, rest) = call(
            &app,
            ana,
            Method::GET,
            &format!("/agents/{agent}/activity?before={last}"),
            None,
        )
        .await;
        assert_eq!(details(&rest), vec!["cmd 2", "cmd 1", "cmd 0"]);
        assert_eq!(rest["more"], false);
        let (s, _) = call(
            &app,
            bob,
            Method::GET,
            &format!("/agents/{agent}/activity"),
            None,
        )
        .await;
        assert_eq!(s, StatusCode::NOT_FOUND);
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
    async fn free_plan_has_one_agent_and_any_number_of_accounts() {
        let db = test_db().await;
        let app = app(db.pool.clone());
        let ana = create_user(&db.pool, "free").await;
        let (agent, _) = connect(&app, ana).await;
        for _ in 0..6 {
            let (s, b) = grant(&app, ana, agent, Uuid::new_v4(), json!({})).await;
            assert_eq!(s, StatusCode::OK, "{b}");
        }
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
        let (s, b) = call(
            &app,
            ana,
            Method::POST,
            &format!("/agents/pair/{id}/claim"),
            None,
        )
        .await;
        assert_eq!(s, StatusCode::BAD_REQUEST);
        assert!(b["error"]
            .as_str()
            .unwrap()
            .starts_with("free plan limit: one connected agent"));
        let (_, list) = call(&app, ana, Method::GET, "/agents", None).await;
        assert_eq!(
            list["limits"],
            json!({ "agents": FREE_AGENTS, "uses": FREE_AGENT_USES })
        );
        assert_eq!(
            list["usage"],
            json!({ "used": 0, "limit": 10, "resets_at": next_month(), "trial_available": false })
        );
    }

    // ── Agent uses (Free: 10 a month) ──────────────────────────────────────

    /// The app with the trial on and a real base URL (the 402's link).
    fn uses_app(db: sqlx::PgPool, trial: bool) -> Router {
        let mut state = test_state(db);
        state.trial_enabled = trial;
        state.app_base_url = "https://otpilot.app/".into();
        router().with_state(state)
    }

    /// "2026-12-01T00:00:00Z": the 1st of next month, UTC.
    fn next_month() -> String {
        let now = Utc::now().date_naive();
        (NaiveDate::from_ymd_opt(now.year(), now.month(), 1).unwrap() + Months::new(1))
            .format("%Y-%m-%dT00:00:00Z")
            .to_string()
    }

    /// "Jul 1": when the uses renew.
    fn renews_on() -> String {
        let next: NaiveDate = next_month()[..10].parse().unwrap();
        next.format("%b %-d").to_string()
    }

    use chrono::Datelike;

    async fn open(app: &Router, token: &str, tool: &str, items: &[Uuid]) -> (StatusCode, Value) {
        open_as(app, token, Uuid::new_v4(), tool, items).await
    }

    async fn open_as(
        app: &Router,
        token: &str,
        use_id: Uuid,
        tool: &str,
        items: &[Uuid],
    ) -> (StatusCode, Value) {
        mcp(
            app,
            token,
            Method::POST,
            "/agent/grants/open",
            Some(json!({ "use_id": use_id, "tool": tool, "item_ids": items })),
        )
        .await
    }

    async fn uses(db: &sqlx::PgPool, user: Uuid) -> i32 {
        sqlx::query_scalar("SELECT COALESCE(SUM(uses), 0)::int FROM agent_usage WHERE user_id = $1")
            .bind(user)
            .fetch_one(db)
            .await
            .unwrap()
    }

    async fn set_uses(db: &sqlx::PgPool, user: Uuid, month: &str, n: i32) {
        sqlx::query(&format!(
            "INSERT INTO agent_usage (user_id, month, uses) VALUES ($1, {month}, $2)
             ON CONFLICT (user_id, month) DO UPDATE SET uses = EXCLUDED.uses"
        ))
        .bind(user)
        .bind(n)
        .execute(db)
        .await
        .unwrap();
    }

    const THIS_MONTH: &str = "date_trunc('month', NOW() AT TIME ZONE 'UTC')::date";

    #[tokio::test]
    async fn free_counts_each_tool_call_as_one_use_up_to_ten() {
        let db = test_db().await;
        let app = uses_app(db.pool.clone(), false);
        let ana = create_user(&db.pool, "free").await;
        let (agent, token) = connect(&app, ana).await;
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        give(&app, ana, agent, a).await;
        give(&app, ana, agent, b).await;
        // Listing gives labels only, and the uses left.
        let (_, list) = mcp(&app, &token, Method::GET, "/agent/grants", None).await;
        assert_eq!(list["grants"][0]["record"], Value::Null);
        assert_eq!(list["grants"][0]["label"], label());
        assert_eq!(
            list["usage"]["notice"],
            format!(
                "Free plan: 10 of 10 uses left this month (renews {}).",
                renews_on()
            )
        );
        // A run with two accounts is one use; it gets exactly those copies.
        let (s, r) = open(&app, &token, "run", &[a, b]).await;
        assert_eq!(s, StatusCode::OK, "{r}");
        assert_eq!(r["grants"].as_array().unwrap().len(), 2);
        assert_eq!(r["grants"][0]["record"], record());
        assert_eq!(r["grants"][0]["wrapped_key"], "wk");
        assert_eq!(r["usage"]["used"], 1);
        assert_eq!(r["usage"]["limit"], 10);
        assert_eq!(r["usage"]["resets_at"], next_month());
        for n in 2..=9 {
            let (s, r) = open(&app, &token, "browser_login", &[a]).await;
            assert_eq!(s, StatusCode::OK, "{r}");
            assert_eq!(r["usage"]["used"], n);
            assert_eq!(r["grants"].as_array().unwrap().len(), 1);
        }
        let (_, list) = mcp(&app, &token, Method::GET, "/agent/grants", None).await;
        assert_eq!(
            list["usage"]["notice"],
            format!(
                "Free plan: 1 of 10 uses left this month (renews {}).",
                renews_on()
            )
        );
        let (s, r) = open(&app, &token, "run", &[b]).await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(r["usage"]["used"], 10);
        assert_eq!(
            r["usage"]["notice"],
            format!(
                "Free plan: no uses left this month (renews {}). Upgrade: https://otpilot.app/dashboard/billing",
                renews_on()
            )
        );
        // The 11th is refused, and nothing is counted or kept.
        let use_id = Uuid::new_v4();
        let (s, r) = open_as(&app, &token, use_id, "run", &[a]).await;
        assert_eq!(s, StatusCode::PAYMENT_REQUIRED, "{r}");
        assert_eq!(
            r,
            json!({
                "error": format!("You've used your 10 free agent uses for this month. They renew on {}. Upgrade to Personal for unlimited uses ($3/month or $30/year) at https://otpilot.app/dashboard/billing.", renews_on()),
                "code": "agent_uses_exhausted", "used": 10, "limit": 10,
                "resets_at": next_month(), "upgrade_url": "https://otpilot.app/dashboard/billing",
                "trial_available": false, "trial_days": 30,
            })
        );
        assert!(r.get("grants").is_none());
        assert_eq!(uses(&db.pool, ana).await, 10);
        let kept: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM agent_use_tokens WHERE id = $1")
            .bind(use_id)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(kept, 0);
        // Free calls stay free; GET /agents shows the count.
        let (s, _) = mcp(&app, &token, Method::GET, "/agent/grants", None).await;
        assert_eq!(s, StatusCode::OK);
        let (_, list) = call(&app, ana, Method::GET, "/agents", None).await;
        assert_eq!(list["usage"]["used"], 10);
    }

    #[tokio::test]
    async fn the_402_offers_the_trial_when_it_can_start() {
        let db = test_db().await;
        let app = uses_app(db.pool.clone(), true);
        let ana = create_user(&db.pool, "free").await;
        let (agent, token) = connect(&app, ana).await;
        let a = Uuid::new_v4();
        give(&app, ana, agent, a).await;
        set_uses(&db.pool, ana, THIS_MONTH, 10).await;
        let (s, r) = open(&app, &token, "run", &[a]).await;
        assert_eq!(s, StatusCode::PAYMENT_REQUIRED);
        assert_eq!(r["trial_available"], true);
        assert_eq!(
            r["error"],
            format!("You've used your 10 free agent uses for this month. They renew on {}. Upgrade to Personal for unlimited uses ($3/month or $30/year) at https://otpilot.app/dashboard/billing, or start the free 30-day trial there, no card needed.", renews_on())
        );
        let (_, list) = call(&app, ana, Method::GET, "/agents", None).await;
        assert_eq!(list["usage"]["trial_available"], true);
        // Had one already: no offer.
        sqlx::query("UPDATE users SET trial_ends_at = NOW() - INTERVAL '40 days' WHERE id = $1")
            .bind(ana)
            .execute(&db.pool)
            .await
            .unwrap();
        let (_, r) = open(&app, &token, "run", &[a]).await;
        assert_eq!(r["trial_available"], false);
        assert!(r["error"]
            .as_str()
            .unwrap()
            .ends_with("/dashboard/billing."));
        let (_, list) = call(&app, ana, Method::GET, "/agents", None).await;
        assert_eq!(list["usage"]["trial_available"], false);
    }

    #[tokio::test]
    async fn two_calls_at_the_last_use_get_one_between_them() {
        let db = test_db().await;
        let app = uses_app(db.pool.clone(), false);
        let ana = create_user(&db.pool, "free").await;
        let (agent, token) = connect(&app, ana).await;
        let a = Uuid::new_v4();
        give(&app, ana, agent, a).await;
        set_uses(&db.pool, ana, THIS_MONTH, 9).await;
        let calls: Vec<_> = (0..2)
            .map(|_| {
                let (app, token) = (app.clone(), token.clone());
                tokio::spawn(async move { open(&app, &token, "run", &[a]).await.0 })
            })
            .collect();
        let mut got = vec![];
        for c in calls {
            got.push(c.await.unwrap());
        }
        got.sort();
        assert_eq!(got, vec![StatusCode::OK, StatusCode::PAYMENT_REQUIRED]);
        assert_eq!(uses(&db.pool, ana).await, 10);
    }

    #[tokio::test]
    async fn a_retried_call_is_counted_once_for_the_same_accounts_only() {
        let db = test_db().await;
        let app = uses_app(db.pool.clone(), false);
        let ana = create_user(&db.pool, "free").await;
        let (agent, token) = connect(&app, ana).await;
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        give(&app, ana, agent, a).await;
        give(&app, ana, agent, b).await;
        let use_id = Uuid::new_v4();
        let (s, _) = open_as(&app, &token, use_id, "run", &[a, b]).await;
        assert_eq!(s, StatusCode::OK);
        // The same call again (ids in another order): the copies, not counted.
        let (s, r) = open_as(&app, &token, use_id, "run", &[b, a]).await;
        assert_eq!(s, StatusCode::OK, "{r}");
        assert_eq!(r["grants"].as_array().unwrap().len(), 2);
        assert_eq!(r["usage"]["used"], 1);
        // Even with the month used up meanwhile.
        set_uses(&db.pool, ana, THIS_MONTH, 10).await;
        let (s, _) = open_as(&app, &token, use_id, "run", &[a, b]).await;
        assert_eq!(s, StatusCode::OK);
        set_uses(&db.pool, ana, THIS_MONTH, 1).await;
        // Other accounts, or another tool, with that id: refused.
        for (tool, items) in [("run", vec![a]), ("browser_login", vec![a, b])] {
            let (s, r) = open_as(&app, &token, use_id, tool, &items).await;
            assert_eq!(s, StatusCode::BAD_REQUEST, "{r}");
            assert_eq!(r["code"], "use_id_reused");
        }
        // Too old to be a retry.
        sqlx::query(
            "UPDATE agent_use_tokens SET created_at = NOW() - INTERVAL '11 minutes' WHERE id = $1",
        )
        .bind(use_id)
        .execute(&db.pool)
        .await
        .unwrap();
        let (s, r) = open_as(&app, &token, use_id, "run", &[a, b]).await;
        assert_eq!(s, StatusCode::BAD_REQUEST);
        assert_eq!(r["code"], "use_id_reused");
        // Another agent can't replay it either (both Free: only counted calls keep a token).
        let bob = create_user(&db.pool, "free").await;
        let (bob_agent, bob_token) = connect(&app, bob).await;
        give(&app, bob, bob_agent, a).await;
        let fresh = Uuid::new_v4();
        assert_eq!(
            open_as(&app, &token, fresh, "run", &[a]).await.0,
            StatusCode::OK
        );
        let (s, r) = open_as(&app, &bob_token, fresh, "run", &[a]).await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "{r}");
        assert_eq!(uses(&db.pool, ana).await, 2);
    }

    #[tokio::test]
    async fn opening_is_all_or_nothing_and_never_counts_a_refusal() {
        let db = test_db().await;
        let app = uses_app(db.pool.clone(), false);
        let ana = create_user(&db.pool, "free").await;
        let (agent, token) = connect(&app, ana).await;
        let (a, ask, old, unknown) = (
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
        );
        give(&app, ana, agent, a).await;
        grant(&app, ana, agent, ask, json!({ "ask_every_time": true })).await;
        grant(
            &app,
            ana,
            agent,
            old,
            json!({ "expires_at": "2020-01-01T00:00:00Z" }),
        )
        .await;
        let (s, r) = open(&app, &token, "run", &[a, old, unknown]).await;
        assert_eq!(s, StatusCode::NOT_FOUND, "{r}");
        assert_eq!(r["code"], "not_granted");
        let mut missing: Vec<Uuid> = serde_json::from_value(r["item_ids"].clone()).unwrap();
        missing.sort();
        assert_eq!(missing, sorted(vec![old, unknown]));
        let (s, r) = open(&app, &token, "run", &[a, ask]).await;
        assert_eq!(s, StatusCode::CONFLICT, "{r}");
        assert_eq!(r["code"], "approval_needed");
        assert_eq!(r["item_ids"], json!([ask]));
        assert_eq!(uses(&db.pool, ana).await, 0);
        // Approved once: opened (and counted), and its window isn't spent by it.
        let (s, req) = mcp(
            &app,
            &token,
            Method::POST,
            "/agent/requests",
            Some(json!({ "item_id": ask, "tool": "run" })),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{req}");
        ok(
            &app,
            ana,
            Method::POST,
            &format!("/agents/requests/{}", req["id"].as_str().unwrap()),
            Some(json!({ "decision": "allow" })),
        )
        .await;
        let (s, r) = open(&app, &token, "run", &[a, ask]).await;
        assert_eq!(s, StatusCode::OK, "{r}");
        assert_eq!(r["grants"].as_array().unwrap().len(), 2);
        let (_, list) = mcp(&app, &token, Method::GET, "/agent/grants", None).await;
        assert!(list["grants"]
            .as_array()
            .unwrap()
            .iter()
            .all(|g| g["record"].is_null()));
        assert_eq!(uses(&db.pool, ana).await, 1);
        // Malformed calls.
        for body in [
            json!({ "use_id": Uuid::new_v4(), "tool": "totp", "item_ids": [a] }),
            json!({ "use_id": Uuid::new_v4(), "tool": "run", "item_ids": [] }),
            json!({ "use_id": Uuid::new_v4(), "tool": "run", "item_ids": [a, a] }),
            json!({ "use_id": Uuid::new_v4(), "tool": "run", "item_ids": (0..21).map(|_| Uuid::new_v4()).collect::<Vec<_>>() }),
            json!({ "use_id": "nope", "tool": "run", "item_ids": [a] }),
            json!({ "tool": "run", "item_ids": [a] }),
        ] {
            let (s, r) = mcp(&app, &token, Method::POST, "/agent/grants/open", Some(body)).await;
            assert_eq!(s, StatusCode::BAD_REQUEST, "{r}");
            assert!(r["error"].is_string());
        }
        assert_eq!(uses(&db.pool, ana).await, 1);
    }

    #[tokio::test]
    async fn paid_plans_and_the_trial_are_never_counted() {
        let db = test_db().await;
        let app = uses_app(db.pool.clone(), true);
        let paid = create_user(&db.pool, "personal").await;
        let trial = create_user(&db.pool, "free").await;
        crate::trial::start(&db.pool, trial).await.unwrap();
        for user in [paid, trial] {
            let (agent, token) = connect(&app, user).await;
            let a = Uuid::new_v4();
            give(&app, user, agent, a).await;
            for _ in 0..12 {
                let (s, r) = open(&app, &token, "run", &[a]).await;
                assert_eq!(s, StatusCode::OK, "{r}");
                assert_eq!(r["usage"], Value::Null);
            }
            assert_eq!(uses(&db.pool, user).await, 0);
            // Nothing counted, so no retry token is kept either.
            let tokens: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM agent_use_tokens WHERE agent_id = $1")
                    .bind(agent)
                    .fetch_one(&db.pool)
                    .await
                    .unwrap();
            assert_eq!(tokens, 0);
            // A current MCP lists labels only; an old one still gets copies.
            let (_, list) = mcp(&app, &token, Method::GET, "/agent/grants", None).await;
            assert_eq!(list["grants"][0]["record"], Value::Null);
            assert_eq!(list["usage"], Value::Null);
            let (_, list) = raw(&app, Some(&token), Method::GET, "/agent/grants", None).await;
            assert_eq!(list["grants"][0]["record"], record());
            let (_, list) = call(&app, user, Method::GET, "/agents", None).await;
            assert_eq!(list["limits"], json!({ "agents": null, "uses": null }));
            assert_eq!(list["usage"], Value::Null);
        }
    }

    #[tokio::test]
    async fn opens_are_rate_limited_per_agent() {
        let db = test_db().await;
        let app = uses_app(db.pool.clone(), true);
        let user = create_user(&db.pool, "personal").await;
        let (agent, token) = connect(&app, user).await;
        let a = Uuid::new_v4();
        give(&app, user, agent, a).await;
        for _ in 0..OPEN_PER_HOUR {
            let (s, r) = open(&app, &token, "run", &[a]).await;
            assert_eq!(s, StatusCode::OK, "{r}");
        }
        let (s, _) = open(&app, &token, "run", &[a]).await;
        assert_eq!(s, StatusCode::TOO_MANY_REQUESTS);
    }

    #[tokio::test]
    async fn uses_renew_each_month_and_an_ended_trial_counts_at_once() {
        let db = test_db().await;
        let app = uses_app(db.pool.clone(), true);
        let ana = create_user(&db.pool, "free").await;
        let (agent, token) = connect(&app, ana).await;
        let a = Uuid::new_v4();
        give(&app, ana, agent, a).await;
        // Last month used up: this one starts at 0.
        set_uses(
            &db.pool,
            ana,
            &format!("({THIS_MONTH} - INTERVAL '1 month')::date"),
            10,
        )
        .await;
        let (s, r) = open(&app, &token, "run", &[a]).await;
        assert_eq!(s, StatusCode::OK, "{r}");
        assert_eq!(r["usage"]["used"], 1);

        // A trial that ended a minute ago (the hourly job hasn't run): Free
        // at once, counted from 0, and an old MCP gets no copy.
        let juan = create_user(&db.pool, "free").await;
        crate::trial::start(&db.pool, juan).await.unwrap();
        let (agent, token) = connect(&app, juan).await;
        let a = Uuid::new_v4();
        give(&app, juan, agent, a).await;
        assert_eq!(
            open(&app, &token, "run", &[a]).await.1["usage"],
            Value::Null
        );
        sqlx::query("UPDATE users SET trial_ends_at = NOW() - INTERVAL '1 minute' WHERE id = $1")
            .bind(juan)
            .execute(&db.pool)
            .await
            .unwrap();
        let (_, list) = raw(&app, Some(&token), Method::GET, "/agent/grants", None).await;
        assert_eq!(list["grants"][0]["record"], Value::Null);
        assert_eq!(list["usage"]["used"], 0);
        let (s, r) = open(&app, &token, "run", &[a]).await;
        assert_eq!(s, StatusCode::OK, "{r}");
        assert_eq!(r["usage"]["used"], 1);
        let (_, list) = call(&app, juan, Method::GET, "/agents", None).await;
        assert_eq!(list["usage"]["trial_available"], false);
    }

    #[tokio::test]
    async fn on_free_an_old_mcp_is_told_to_update_before_asking_for_a_use() {
        let db = test_db().await;
        let app = uses_app(db.pool.clone(), false);
        let ana = create_user(&db.pool, "free").await;
        let (agent, token) = connect(&app, ana).await;
        let ask = Uuid::new_v4();
        grant(&app, ana, agent, ask, json!({ "ask_every_time": true })).await;
        let use_of = |item: Uuid| Some(json!({ "item_id": item, "tool": "run" }));
        // No header: 426, before the grant is even looked up.
        for item in [ask, Uuid::new_v4()] {
            let (s, r) = raw(
                &app,
                Some(&token),
                Method::POST,
                "/agent/requests",
                use_of(item),
            )
            .await;
            assert_eq!(s, StatusCode::UPGRADE_REQUIRED, "{r}");
            assert_eq!(r, json!({ "error": OUTDATED, "code": "mcp_outdated" }));
        }
        assert_eq!(
            r#"This OTPilot MCP is out of date. Restart your AI agent so it runs the latest @otpilot/mcp (npx -y @otpilot/mcp@latest), then try again."#,
            OUTDATED
        );
        // Asking for an account is always fine.
        let (s, _) = raw(
            &app,
            Some(&token),
            Method::POST,
            "/agent/requests",
            Some(json!({ "query": "github" })),
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        // With the header: not granted 404, then used up 402 (nothing asked).
        let (s, _) = mcp(
            &app,
            &token,
            Method::POST,
            "/agent/requests",
            use_of(Uuid::new_v4()),
        )
        .await;
        assert_eq!(s, StatusCode::NOT_FOUND);
        set_uses(&db.pool, ana, THIS_MONTH, 10).await;
        let (s, r) = mcp(&app, &token, Method::POST, "/agent/requests", use_of(ask)).await;
        assert_eq!(s, StatusCode::PAYMENT_REQUIRED, "{r}");
        assert_eq!(r["code"], "agent_uses_exhausted");
        let asked: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM agent_requests WHERE agent_id = $1 AND item_id IS NOT NULL",
        )
        .bind(agent)
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert_eq!(asked, 0);
        set_uses(&db.pool, ana, THIS_MONTH, 9).await;
        let (s, _) = mcp(&app, &token, Method::POST, "/agent/requests", use_of(ask)).await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(uses(&db.pool, ana).await, 9, "asking counts nothing");
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
            // A request for a new account releases no copy.
            json!({ "id": rid, "status": "allowed", "item_id": item, "released": false })
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

    // ── Losing a shared item revokes the agents' copies ────────────────────────

    fn shared_app(db: sqlx::PgPool) -> Router {
        router()
            .merge(crate::routes::shares::router())
            .merge(crate::routes::collections::router())
            .merge(crate::routes::teams::router())
            .merge(crate::routes::vault::router())
            .with_state(test_state(db))
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

    /// A collection of `team` with these members and roles.
    async fn collection(db: &sqlx::PgPool, team: Uuid, members: &[(Uuid, &str)]) -> Uuid {
        let cid = Uuid::new_v4();
        sqlx::query("INSERT INTO collections (id, team_id, encrypted_name) VALUES ($1, $2, 'n')")
            .bind(cid)
            .bind(team)
            .execute(db)
            .await
            .unwrap();
        for (u, role) in members {
            sqlx::query(
                "INSERT INTO collection_members (collection_id, user_id, role, wrapped_key)
                 VALUES ($1, $2, $3, 'ck')",
            )
            .bind(cid)
            .bind(u)
            .bind(role)
            .execute(db)
            .await
            .unwrap();
        }
        cid
    }

    /// An item stored in collection `cid`.
    async fn collection_item(db: &sqlx::PgPool, cid: Uuid) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO vault_items (id, owner_id, collection_id, encrypted_item, counts_for_limit)
             VALUES ($1, NULL, $2, 'x', false)",
        )
        .bind(id)
        .bind(cid)
        .execute(db)
        .await
        .unwrap();
        id
    }

    async fn revision(db: &sqlx::PgPool, id: Uuid) -> i64 {
        sqlx::query_scalar("SELECT revision FROM vault_items WHERE id = $1")
            .bind(id)
            .fetch_one(db)
            .await
            .unwrap()
    }

    /// `owner` shares `item` as share `id` (POST /shares).
    async fn share_as(app: &Router, owner: Uuid, id: Uuid, item: Uuid, grants: Value) -> Uuid {
        let (s, b) = call(
            app,
            owner,
            Method::POST,
            "/shares",
            Some(json!({ "id": id, "item_id": item, "whole": true, "record": record(), "grants": grants })),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{b}");
        id
    }

    async fn share(app: &Router, owner: Uuid, item: Uuid, grants: Value) -> Uuid {
        share_as(app, owner, Uuid::new_v4(), item, grants).await
    }

    fn to(user: Uuid) -> Value {
        json!({ "user_id": user, "role": "edit", "wrapped_key": "k" })
    }

    fn to_collection(cid: Uuid) -> Value {
        json!({ "collection_id": cid, "role": "edit", "wrapped_key": "k" })
    }

    /// Grants `agent` (of `user`) a copy of `item`.
    async fn give(app: &Router, user: Uuid, agent: Uuid, item: Uuid) {
        let (s, b) = grant(app, user, agent, item, json!({})).await;
        assert_eq!(s, StatusCode::OK, "{b}");
    }

    /// The item ids an agent gets (`GET /agent/grants`), sorted.
    async fn copies(app: &Router, token: &str) -> Vec<Uuid> {
        let (s, b) = raw(app, Some(token), Method::GET, "/agent/grants", None).await;
        assert_eq!(s, StatusCode::OK, "{b}");
        let mut ids: Vec<Uuid> = b["grants"]
            .as_array()
            .unwrap()
            .iter()
            .map(|g| g["item_id"].as_str().unwrap().parse().unwrap())
            .collect();
        ids.sort();
        ids
    }

    fn sorted(mut ids: Vec<Uuid>) -> Vec<Uuid> {
        ids.sort();
        ids
    }

    async fn ok(app: &Router, user: Uuid, method: Method, uri: &str, body: Option<Value>) {
        let (s, b) = call(app, user, method, uri, body).await;
        assert_eq!(s, StatusCode::OK, "{uri}: {b}");
    }

    /// A grant written straight to the table (data the routes no longer let in).
    async fn grant_row(db: &sqlx::PgPool, agent: Uuid, item: Uuid) {
        sqlx::query(
            "INSERT INTO agent_grants (agent_id, item_id, scope, encrypted_item, wrapped_key)
             VALUES ($1, $2, '{\"kind\": \"2fa\"}', $3, 'wk')",
        )
        .bind(agent)
        .bind(item)
        .bind(record().to_string())
        .execute(db)
        .await
        .unwrap();
    }

    async fn grant_count(db: &sqlx::PgPool, agent: Uuid, item: Uuid) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM agent_grants WHERE agent_id = $1 AND item_id = $2")
            .bind(agent)
            .bind(item)
            .fetch_one(db)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn revoking_a_share_deletes_the_grantees_agent_copy_and_its_release() {
        let db = test_db().await;
        let app = shared_app(db.pool.clone());
        let (owner, ceci) = (
            create_user(&db.pool, "team_lite").await,
            create_user(&db.pool, "team_lite").await,
        );
        team(&db.pool, owner, &[ceci]).await;
        let sid = share(&app, owner, item(&db.pool, owner).await, json!([to(ceci)])).await;
        let (agent, token) = connect(&app, ceci).await;
        let (s, b) = grant(&app, ceci, agent, sid, json!({ "ask_every_time": true })).await;
        assert_eq!(s, StatusCode::OK, "{b}");
        // A one-time use, allowed: the copy is released.
        let (_, r) = raw(
            &app,
            Some(&token),
            Method::POST,
            "/agent/requests",
            Some(json!({ "item_id": sid, "tool": "run" })),
        )
        .await;
        let rid = r["id"].as_str().unwrap().to_string();
        ok(
            &app,
            ceci,
            Method::POST,
            &format!("/agents/requests/{rid}"),
            Some(json!({ "decision": "allow" })),
        )
        .await;
        let (_, b) = raw(&app, Some(&token), Method::GET, "/agent/grants", None).await;
        assert_eq!(b["grants"][0]["record"], record());

        ok(&app, owner, Method::DELETE, &format!("/shares/{sid}"), None).await;
        assert!(copies(&app, &token).await.is_empty());
        let released: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM agent_requests WHERE agent_id = $1 AND released_until IS NOT NULL",
        )
        .bind(agent)
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert_eq!(released, 0);
    }

    #[tokio::test]
    async fn removing_a_grantee_or_the_grantee_leaving_deletes_their_copy() {
        let db = test_db().await;
        let app = shared_app(db.pool.clone());
        let (owner, ceci, juan) = (
            create_user(&db.pool, "team_lite").await,
            create_user(&db.pool, "team_lite").await,
            create_user(&db.pool, "team_lite").await,
        );
        team(&db.pool, owner, &[ceci, juan]).await;
        let sid = share(
            &app,
            owner,
            item(&db.pool, owner).await,
            json!([to(ceci), to(juan)]),
        )
        .await;
        let (ceci_agent, ceci_token) = connect(&app, ceci).await;
        let (juan_agent, juan_token) = connect(&app, juan).await;
        give(&app, ceci, ceci_agent, sid).await;
        give(&app, juan, juan_agent, sid).await;
        // The owner removes Ceci: hers goes, Juan's stays.
        ok(
            &app,
            owner,
            Method::DELETE,
            &format!("/shares/{sid}/grants?user_id={ceci}"),
            None,
        )
        .await;
        assert!(copies(&app, &ceci_token).await.is_empty());
        assert_eq!(copies(&app, &juan_token).await, vec![sid]);
        // Juan leaves the share himself.
        ok(
            &app,
            juan,
            Method::DELETE,
            &format!("/shares/{sid}/grants?user_id={juan}"),
            None,
        )
        .await;
        assert!(copies(&app, &juan_token).await.is_empty());
    }

    #[tokio::test]
    async fn a_copy_stays_while_another_route_still_opens_the_share() {
        let db = test_db().await;
        let app = shared_app(db.pool.clone());
        let (owner, ceci) = (
            create_user(&db.pool, "team_lite").await,
            create_user(&db.pool, "team_lite").await,
        );
        let t = team(&db.pool, owner, &[ceci]).await;
        let k1 = collection(&db.pool, t, &[(owner, "manage"), (ceci, "view")]).await;
        let k2 = collection(&db.pool, t, &[(owner, "manage"), (ceci, "edit")]).await;
        let (agent, token) = connect(&app, ceci).await;

        // Directly and through a collection.
        let direct = share(
            &app,
            owner,
            item(&db.pool, owner).await,
            json!([to(ceci), to_collection(k1)]),
        )
        .await;
        give(&app, ceci, agent, direct).await;
        ok(
            &app,
            owner,
            Method::DELETE,
            &format!("/shares/{direct}/grants?user_id={ceci}"),
            None,
        )
        .await;
        assert_eq!(
            copies(&app, &token).await,
            vec![direct],
            "k1 still opens it"
        );
        ok(
            &app,
            owner,
            Method::DELETE,
            &format!("/shares/{direct}/grants?collection_id={k1}"),
            None,
        )
        .await;
        assert!(copies(&app, &token).await.is_empty());

        // Through two collections.
        let both = share(
            &app,
            owner,
            item(&db.pool, owner).await,
            json!([to_collection(k1), to_collection(k2)]),
        )
        .await;
        give(&app, ceci, agent, both).await;
        ok(
            &app,
            owner,
            Method::DELETE,
            &format!("/shares/{both}/grants?collection_id={k1}"),
            None,
        )
        .await;
        assert_eq!(copies(&app, &token).await, vec![both], "k2 still opens it");
    }

    #[tokio::test]
    async fn a_role_change_keeps_the_agent_copy() {
        let db = test_db().await;
        let app = shared_app(db.pool.clone());
        let (owner, ceci, juan) = (
            create_user(&db.pool, "team_lite").await,
            create_user(&db.pool, "team_lite").await,
            create_user(&db.pool, "team_lite").await,
        );
        let t = team(&db.pool, owner, &[ceci, juan]).await;
        let k = collection(&db.pool, t, &[(owner, "manage"), (juan, "edit")]).await;
        let sid = share(
            &app,
            owner,
            item(&db.pool, owner).await,
            json!([to(ceci), to_collection(k)]),
        )
        .await;
        let (ceci_agent, ceci_token) = connect(&app, ceci).await;
        let (juan_agent, juan_token) = connect(&app, juan).await;
        give(&app, ceci, ceci_agent, sid).await;
        give(&app, juan, juan_agent, sid).await;
        for target in [json!({ "user_id": ceci }), json!({ "collection_id": k })] {
            let mut body = target.clone();
            body["role"] = json!("view");
            ok(
                &app,
                owner,
                Method::PATCH,
                &format!("/shares/{sid}/grants"),
                Some(body),
            )
            .await;
        }
        ok(
            &app,
            owner,
            Method::PUT,
            &format!("/collections/{k}/members/{juan}"),
            Some(json!({ "role": "view" })),
        )
        .await;
        assert_eq!(copies(&app, &ceci_token).await, vec![sid]);
        assert_eq!(copies(&app, &juan_token).await, vec![sid]);
    }

    #[tokio::test]
    async fn deleting_the_owners_item_revokes_agent_copies_of_its_shares() {
        let db = test_db().await;
        let app = shared_app(db.pool.clone());
        let (owner, ceci) = (
            create_user(&db.pool, "team_lite").await,
            create_user(&db.pool, "team_lite").await,
        );
        team(&db.pool, owner, &[ceci]).await;
        let (it, other) = (item(&db.pool, owner).await, item(&db.pool, owner).await);
        let sid = share(&app, owner, it, json!([to(ceci)])).await;
        let kept = share(&app, owner, other, json!([to(ceci)])).await;
        let (agent, token) = connect(&app, ceci).await;
        give(&app, ceci, agent, sid).await;
        give(&app, ceci, agent, kept).await;
        ok(
            &app,
            owner,
            Method::DELETE,
            &format!(
                "/vault/items/{it}?base_revision={}",
                revision(&db.pool, it).await
            ),
            None,
        )
        .await;
        assert_eq!(copies(&app, &token).await, vec![kept]);
    }

    #[tokio::test]
    async fn removing_or_leaving_a_collection_revokes_its_items_and_shares() {
        let db = test_db().await;
        let app = shared_app(db.pool.clone());
        let (owner, ceci, juan) = (
            create_user(&db.pool, "team_lite").await,
            create_user(&db.pool, "team_lite").await,
            create_user(&db.pool, "team_lite").await,
        );
        let t = team(&db.pool, owner, &[ceci, juan]).await;
        let k = collection(
            &db.pool,
            t,
            &[(owner, "manage"), (ceci, "edit"), (juan, "view")],
        )
        .await;
        let x = collection_item(&db.pool, k).await;
        let sid = share(
            &app,
            owner,
            item(&db.pool, owner).await,
            json!([to_collection(k)]),
        )
        .await;
        let (ceci_agent, ceci_token) = connect(&app, ceci).await;
        let (juan_agent, juan_token) = connect(&app, juan).await;
        for (user, agent) in [(ceci, ceci_agent), (juan, juan_agent)] {
            give(&app, user, agent, x).await;
            give(&app, user, agent, sid).await;
        }
        // Removed by a manager: Ceci's go, Juan's stay.
        ok(
            &app,
            owner,
            Method::DELETE,
            &format!("/collections/{k}/members/{ceci}"),
            None,
        )
        .await;
        assert!(copies(&app, &ceci_token).await.is_empty());
        assert_eq!(copies(&app, &juan_token).await, sorted(vec![x, sid]));
        // Juan leaves.
        ok(
            &app,
            juan,
            Method::DELETE,
            &format!("/collections/{k}/members/{juan}"),
            None,
        )
        .await;
        assert!(copies(&app, &juan_token).await.is_empty());
        // The last member leaving deletes the collection: theirs go too.
        let alone = collection(&db.pool, t, &[(ceci, "manage")]).await;
        let y = collection_item(&db.pool, alone).await;
        give(&app, ceci, ceci_agent, y).await;
        ok(
            &app,
            ceci,
            Method::DELETE,
            &format!("/collections/{alone}/members/{ceci}"),
            None,
        )
        .await;
        let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM collections WHERE id = $1")
            .bind(alone)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(left, 0);
        assert!(copies(&app, &ceci_token).await.is_empty());
    }

    #[tokio::test]
    async fn deleting_a_collection_revokes_every_members_copies() {
        let db = test_db().await;
        let app = shared_app(db.pool.clone());
        let (owner, ceci) = (
            create_user(&db.pool, "team_lite").await,
            create_user(&db.pool, "team_lite").await,
        );
        let t = team(&db.pool, owner, &[ceci]).await;
        let k = collection(&db.pool, t, &[(owner, "manage"), (ceci, "edit")]).await;
        let x = collection_item(&db.pool, k).await;
        let sid = share(
            &app,
            ceci,
            item(&db.pool, ceci).await,
            json!([to_collection(k)]),
        )
        .await;
        let (owner_agent, owner_token) = connect(&app, owner).await;
        let (ceci_agent, ceci_token) = connect(&app, ceci).await;
        give(&app, owner, owner_agent, x).await;
        give(&app, owner, owner_agent, sid).await;
        give(&app, ceci, ceci_agent, x).await;
        ok(
            &app,
            owner,
            Method::DELETE,
            &format!("/collections/{k}"),
            None,
        )
        .await;
        assert!(copies(&app, &owner_token).await.is_empty());
        assert!(copies(&app, &ceci_token).await.is_empty());
    }

    #[tokio::test]
    async fn deleting_a_collection_item_revokes_copies_of_it() {
        let db = test_db().await;
        let app = shared_app(db.pool.clone());
        let (owner, ceci) = (
            create_user(&db.pool, "team_lite").await,
            create_user(&db.pool, "team_lite").await,
        );
        let t = team(&db.pool, owner, &[ceci]).await;
        let k = collection(&db.pool, t, &[(owner, "manage"), (ceci, "view")]).await;
        let (x, kept) = (
            collection_item(&db.pool, k).await,
            collection_item(&db.pool, k).await,
        );
        let (owner_agent, owner_token) = connect(&app, owner).await;
        let (ceci_agent, ceci_token) = connect(&app, ceci).await;
        for (user, agent) in [(owner, owner_agent), (ceci, ceci_agent)] {
            give(&app, user, agent, x).await;
            give(&app, user, agent, kept).await;
        }
        ok(
            &app,
            owner,
            Method::DELETE,
            &format!(
                "/collections/{k}/items/{x}?base_revision={}",
                revision(&db.pool, x).await
            ),
            None,
        )
        .await;
        assert_eq!(copies(&app, &owner_token).await, vec![kept]);
        assert_eq!(copies(&app, &ceci_token).await, vec![kept]);
    }

    #[tokio::test]
    async fn converting_a_collection_item_revokes_copies_of_the_old_id() {
        let db = test_db().await;
        let app = shared_app(db.pool.clone());
        let (owner, ceci) = (
            create_user(&db.pool, "team_lite").await,
            create_user(&db.pool, "team_lite").await,
        );
        let t = team(&db.pool, owner, &[ceci]).await;
        let k = collection(&db.pool, t, &[(owner, "manage"), (ceci, "edit")]).await;
        let x = collection_item(&db.pool, k).await;
        let (owner_agent, owner_token) = connect(&app, owner).await;
        let (ceci_agent, ceci_token) = connect(&app, ceci).await;
        give(&app, owner, owner_agent, x).await;
        give(&app, ceci, ceci_agent, x).await;
        let (new_item, new_share) = (Uuid::new_v4(), Uuid::new_v4());
        ok(
            &app,
            owner,
            Method::POST,
            &format!("/collections/{k}/items/{x}/convert"),
            Some(json!({
                "base_revision": revision(&db.pool, x).await,
                "item": { "id": new_item, "record": record() },
                "share": { "id": new_share, "record": record(), "wrapped_key": "k" },
            })),
        )
        .await;
        assert!(copies(&app, &owner_token).await.is_empty());
        assert!(copies(&app, &ceci_token).await.is_empty());
        // Nothing was moved to the new ids.
        let moved: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM agent_grants WHERE item_id = ANY($1)")
                .bind(vec![new_item, new_share])
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(moved, 0);
    }

    #[tokio::test]
    async fn leaving_or_being_removed_from_the_team_revokes_shared_copies() {
        let db = test_db().await;
        let app = shared_app(db.pool.clone());
        let (owner, ceci, juan) = (
            create_user(&db.pool, "team_lite").await,
            create_user(&db.pool, "team_lite").await,
            create_user(&db.pool, "team_lite").await,
        );
        let t = team(&db.pool, owner, &[ceci, juan]).await;
        let k = collection(
            &db.pool,
            t,
            &[(owner, "manage"), (ceci, "edit"), (juan, "view")],
        )
        .await;
        let x = collection_item(&db.pool, k).await;
        // Shared by Ceci, who leaves; and by the owner, with her and Juan.
        let by_ceci = share(
            &app,
            ceci,
            item(&db.pool, ceci).await,
            json!([to(juan), to_collection(k)]),
        )
        .await;
        let to_ceci = share(
            &app,
            owner,
            item(&db.pool, owner).await,
            json!([to(ceci), to(juan)]),
        )
        .await;
        let (owner_agent, owner_token) = connect(&app, owner).await;
        let (ceci_agent, ceci_token) = connect(&app, ceci).await;
        let (juan_agent, juan_token) = connect(&app, juan).await;
        give(&app, owner, owner_agent, by_ceci).await;
        give(&app, owner, owner_agent, x).await;
        for (user, agent) in [(ceci, ceci_agent), (juan, juan_agent)] {
            give(&app, user, agent, x).await;
            give(&app, user, agent, to_ceci).await;
        }
        give(&app, juan, juan_agent, by_ceci).await;

        ok(
            &app,
            ceci,
            Method::DELETE,
            &format!("/teams/{t}/leave"),
            None,
        )
        .await;
        // Hers go; the teammates' copies of what she shared go too.
        assert!(copies(&app, &ceci_token).await.is_empty());
        assert_eq!(copies(&app, &owner_token).await, vec![x]);
        assert_eq!(copies(&app, &juan_token).await, sorted(vec![x, to_ceci]));

        // Juan is removed by the owner.
        ok(
            &app,
            owner,
            Method::DELETE,
            &format!("/teams/{t}/members/{juan}"),
            None,
        )
        .await;
        assert!(copies(&app, &juan_token).await.is_empty());
        assert_eq!(copies(&app, &owner_token).await, vec![x]);
    }

    #[tokio::test]
    async fn dissolving_the_team_revokes_every_members_shared_copies() {
        let db = test_db().await;
        let app = shared_app(db.pool.clone());
        let (owner, ceci) = (
            create_user(&db.pool, "team_lite").await,
            create_user(&db.pool, "team_lite").await,
        );
        let t = team(&db.pool, owner, &[ceci]).await;
        let k = collection(&db.pool, t, &[(owner, "manage"), (ceci, "edit")]).await;
        let x = collection_item(&db.pool, k).await;
        let own = item(&db.pool, owner).await;
        let sid = share(&app, owner, own, json!([to(ceci)])).await;
        let by_ceci = share(&app, ceci, item(&db.pool, ceci).await, json!([to(owner)])).await;
        let (owner_agent, owner_token) = connect(&app, owner).await;
        let (ceci_agent, ceci_token) = connect(&app, ceci).await;
        give(&app, owner, owner_agent, own).await;
        give(&app, owner, owner_agent, x).await;
        give(&app, owner, owner_agent, by_ceci).await;
        give(&app, ceci, ceci_agent, x).await;
        give(&app, ceci, ceci_agent, sid).await;
        crate::routes::teams::dissolve_team(&db.pool, t)
            .await
            .unwrap();
        assert!(copies(&app, &ceci_token).await.is_empty());
        assert_eq!(copies(&app, &owner_token).await, vec![own], "own item kept");
    }

    #[tokio::test]
    async fn own_items_are_never_revoked() {
        let db = test_db().await;
        let app = shared_app(db.pool.clone());
        let (owner, ceci, free) = (
            create_user(&db.pool, "team_lite").await,
            create_user(&db.pool, "team_lite").await,
            create_user(&db.pool, "free").await,
        );
        let t = team(&db.pool, owner, &[ceci, free]).await;
        // A Free vault doesn't sync: the item isn't on the server.
        let free_item = Uuid::new_v4();
        let (free_agent, free_token) = connect(&app, free).await;
        give(&app, free, free_agent, free_item).await;
        // Ceci's own item, and the owner's own shared item.
        let ceci_item = item(&db.pool, ceci).await;
        let (ceci_agent, ceci_token) = connect(&app, ceci).await;
        give(&app, ceci, ceci_agent, ceci_item).await;
        let owner_item = item(&db.pool, owner).await;
        let (owner_agent, owner_token) = connect(&app, owner).await;
        give(&app, owner, owner_agent, owner_item).await;

        // Every path, in their team.
        let k = collection(
            &db.pool,
            t,
            &[(owner, "manage"), (ceci, "edit"), (free, "view")],
        )
        .await;
        let x = collection_item(&db.pool, k).await;
        let sid = share(&app, owner, owner_item, json!([to(free), to_collection(k)])).await;
        ok(
            &app,
            owner,
            Method::DELETE,
            &format!("/shares/{sid}/grants?user_id={free}"),
            None,
        )
        .await;
        ok(&app, owner, Method::DELETE, &format!("/shares/{sid}"), None).await;
        ok(
            &app,
            owner,
            Method::DELETE,
            &format!(
                "/collections/{k}/items/{x}?base_revision={}",
                revision(&db.pool, x).await
            ),
            None,
        )
        .await;
        ok(
            &app,
            owner,
            Method::DELETE,
            &format!("/collections/{k}/members/{free}"),
            None,
        )
        .await;
        ok(
            &app,
            owner,
            Method::DELETE,
            &format!("/collections/{k}"),
            None,
        )
        .await;
        crate::routes::teams::remove_member_atomic(&db.pool, t, free)
            .await
            .unwrap();
        crate::routes::teams::dissolve_team(&db.pool, t)
            .await
            .unwrap();

        assert_eq!(copies(&app, &free_token).await, vec![free_item]);
        assert_eq!(copies(&app, &ceci_token).await, vec![ceci_item]);
        assert_eq!(copies(&app, &owner_token).await, vec![owner_item]);
    }

    #[tokio::test]
    async fn another_users_agents_are_untouched() {
        let db = test_db().await;
        let app = shared_app(db.pool.clone());
        let (owner, ceci, outsider) = (
            create_user(&db.pool, "team_lite").await,
            create_user(&db.pool, "team_lite").await,
            create_user(&db.pool, "team_lite").await,
        );
        let t = team(&db.pool, owner, &[ceci]).await;
        let other_owner = create_user(&db.pool, "team_lite").await;
        team(&db.pool, other_owner, &[outsider]).await;
        let k = collection(&db.pool, t, &[(owner, "manage"), (ceci, "edit")]).await;
        let x = collection_item(&db.pool, k).await;
        let sid = share(&app, owner, item(&db.pool, owner).await, json!([to(ceci)])).await;
        let (ceci_agent, ceci_token) = connect(&app, ceci).await;
        let (outsider_agent, outsider_token) = connect(&app, outsider).await;
        for id in [x, sid] {
            give(&app, ceci, ceci_agent, id).await;
            // The same ids, held by someone outside the team (a Free vault's
            // ids, written before these existed: today it's refused).
            assert_eq!(
                grant(&app, outsider, outsider_agent, id, json!({})).await.0,
                StatusCode::NOT_FOUND
            );
            grant_row(&db.pool, outsider_agent, id).await;
        }
        ok(&app, owner, Method::DELETE, &format!("/shares/{sid}"), None).await;
        ok(
            &app,
            owner,
            Method::DELETE,
            &format!("/collections/{k}"),
            None,
        )
        .await;
        crate::routes::teams::dissolve_team(&db.pool, t)
            .await
            .unwrap();
        assert!(copies(&app, &ceci_token).await.is_empty());
        assert_eq!(copies(&app, &outsider_token).await, sorted(vec![x, sid]));
    }

    #[tokio::test]
    async fn a_share_reusing_an_own_item_id_is_refused_and_never_revokes_it() {
        let db = test_db().await;
        let app = shared_app(db.pool.clone());
        let (owner, ceci) = (
            create_user(&db.pool, "team_lite").await,
            create_user(&db.pool, "team_lite").await,
        );
        let t = team(&db.pool, owner, &[ceci]).await;
        let ceci_item = item(&db.pool, ceci).await;
        let (agent, token) = connect(&app, ceci).await;
        give(&app, ceci, agent, ceci_item).await;
        // A teammate's share can't take Ceci's item id…
        let (s, b) = call(
            &app,
            owner,
            Method::POST,
            "/shares",
            Some(json!({ "id": ceci_item, "item_id": item(&db.pool, owner).await, "whole": true, "record": record(), "grants": [to(ceci)] })),
        )
        .await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "{b}");
        // …nor a conversion's new share; its new item can't take a share's id.
        let k = collection(&db.pool, t, &[(owner, "manage"), (ceci, "edit")]).await;
        let x = collection_item(&db.pool, k).await;
        let existing = share(&app, owner, item(&db.pool, owner).await, json!([to(ceci)])).await;
        for (new_item, new_share) in [(Uuid::new_v4(), ceci_item), (existing, Uuid::new_v4())] {
            let (s, b) = call(
                &app,
                owner,
                Method::POST,
                &format!("/collections/{k}/items/{x}/convert"),
                Some(json!({
                    "base_revision": revision(&db.pool, x).await,
                    "item": { "id": new_item, "record": record() },
                    "share": { "id": new_share, "record": record(), "wrapped_key": "k" },
                })),
            )
            .await;
            assert_eq!(s, StatusCode::BAD_REQUEST, "{b}");
        }
        let live: bool =
            sqlx::query_scalar("SELECT deleted_at IS NULL FROM vault_items WHERE id = $1")
                .bind(x)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert!(live, "nothing converted");

        // One made before the check, granted to her: still her own item.
        sqlx::query(
            "INSERT INTO shares (id, team_id, owner_id, item_id, whole, encrypted_item)
             VALUES ($1, $2, $3, $4, true, 'x')",
        )
        .bind(ceci_item)
        .bind(t)
        .bind(owner)
        .bind(item(&db.pool, owner).await)
        .execute(&db.pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO share_grants (share_id, user_id, role, wrapped_key, granted_by)
             VALUES ($1, $2, 'view', 'k', $3)",
        )
        .bind(ceci_item)
        .bind(ceci)
        .bind(owner)
        .execute(&db.pool)
        .await
        .unwrap();
        give(&app, ceci, agent, ceci_item).await; // rewritten as her own
        ok(
            &app,
            owner,
            Method::DELETE,
            &format!("/shares/{ceci_item}"),
            None,
        )
        .await;
        crate::routes::teams::dissolve_team(&db.pool, t)
            .await
            .unwrap();
        assert_eq!(copies(&app, &token).await, vec![ceci_item]);
    }

    #[tokio::test]
    async fn a_new_item_never_takes_a_shares_id() {
        let db = test_db().await;
        let app = shared_app(db.pool.clone());
        let (owner, ceci) = (
            create_user(&db.pool, "team_lite").await,
            create_user(&db.pool, "team_lite").await,
        );
        let t = team(&db.pool, owner, &[ceci]).await;
        let k = collection(&db.pool, t, &[(owner, "manage"), (ceci, "edit")]).await;
        let sid = share(&app, owner, item(&db.pool, owner).await, json!([to(ceci)])).await;
        // The grantee (or anyone, its owner too) can't create an item with it:
        // a personal one…
        for user in [ceci, owner] {
            let (s, b) = call(
                &app,
                user,
                Method::PUT,
                &format!("/vault/items/{sid}"),
                Some(json!({ "record": record() })),
            )
            .await;
            assert_eq!(s, StatusCode::BAD_REQUEST, "{b}");
            // …in a batch (`taken`: the extension moves its item to a new id)…
            let fresh = Uuid::new_v4();
            let (s, b) = call(
                &app,
                user,
                Method::POST,
                "/vault/items/batch",
                Some(json!({ "items": [
                    { "id": sid, "record": record() },
                    { "id": fresh, "record": record() },
                ] })),
            )
            .await;
            assert_eq!(s, StatusCode::OK, "{b}");
            assert_eq!(b["taken"], json!([sid]));
            assert_eq!(b["conflicts"], json!([]));
            assert_eq!(b["created"][0]["id"], json!(fresh));
            // …or a collection's.
            let (s, b) = call(
                &app,
                user,
                Method::PUT,
                &format!("/collections/{k}/items/{sid}"),
                Some(json!({ "record": record() })),
            )
            .await;
            assert_eq!(s, StatusCode::BAD_REQUEST, "{b}");
        }
        let items: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM vault_items WHERE id = $1")
            .bind(sid)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(items, 0);
        // So her agent's grant of it is the share's, and goes with her grant.
        let (agent, token) = connect(&app, ceci).await;
        give(&app, ceci, agent, sid).await;
        ok(
            &app,
            owner,
            Method::DELETE,
            &format!("/shares/{sid}/grants?user_id={ceci}"),
            None,
        )
        .await;
        assert!(copies(&app, &token).await.is_empty());

        // An item of hers with a share's id from before this rule stays hers:
        // still updatable, in a batch a conflict (pulled, not moved), and its
        // agent copy is kept when the share grant goes (it's her item's).
        let other = share(&app, owner, item(&db.pool, owner).await, json!([to(ceci)])).await;
        sqlx::query("INSERT INTO vault_items (id, owner_id, encrypted_item) VALUES ($1, $2, $3)")
            .bind(other)
            .bind(ceci)
            .bind(record().to_string())
            .execute(&db.pool)
            .await
            .unwrap();
        let (s, b) = call(
            &app,
            ceci,
            Method::PUT,
            &format!("/vault/items/{other}"),
            Some(json!({ "record": record(), "base_revision": revision(&db.pool, other).await })),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{b}");
        let (_, b) = call(
            &app,
            ceci,
            Method::POST,
            "/vault/items/batch",
            Some(json!({ "items": [{ "id": other, "record": record() }] })),
        )
        .await;
        assert_eq!(b["conflicts"], json!([other]));
        assert_eq!(b["taken"], json!([]));
        give(&app, ceci, agent, other).await;
        ok(
            &app,
            owner,
            Method::DELETE,
            &format!("/shares/{other}/grants?user_id={ceci}"),
            None,
        )
        .await;
        assert_eq!(copies(&app, &token).await, vec![other]);
    }

    #[tokio::test]
    async fn a_grant_of_a_shared_item_is_only_written_while_its_user_opens_it() {
        let db = test_db().await;
        let app = shared_app(db.pool.clone());
        let (owner, ceci, juan, eve) = (
            create_user(&db.pool, "team_lite").await,
            create_user(&db.pool, "team_lite").await,
            create_user(&db.pool, "team_lite").await,
            create_user(&db.pool, "team_lite").await,
        );
        let t = team(&db.pool, owner, &[ceci, juan]).await;
        let k = collection(&db.pool, t, &[(owner, "manage"), (ceci, "view")]).await;
        let x = collection_item(&db.pool, k).await;
        let sid = share(
            &app,
            owner,
            item(&db.pool, owner).await,
            json!([to(ceci), to(juan)]),
        )
        .await;
        let gone = share(&app, owner, item(&db.pool, owner).await, json!([to(ceci)])).await;
        // Someone who doesn't open them (outside the team, or the owner of
        // the share): nothing written.
        let (eve_agent, _) = connect(&app, eve).await;
        let (owner_agent, _) = connect(&app, owner).await;
        for (user, agent, id) in [
            (eve, eve_agent, x),
            (eve, eve_agent, sid),
            (owner, owner_agent, sid),
        ] {
            let (s, _) = grant(&app, user, agent, id, json!({})).await;
            assert_eq!(s, StatusCode::NOT_FOUND);
            assert_eq!(grant_count(&db.pool, agent, id).await, 0);
        }
        // Ceci opens them.
        let (agent, token) = connect(&app, ceci).await;
        let mut revs = vec![];
        for id in [sid, x, gone] {
            let (s, b) = grant(&app, ceci, agent, id, json!({})).await;
            assert_eq!(s, StatusCode::OK, "{b}");
            revs.push(b["revision"].as_i64().unwrap());
        }
        // She loses them: removed from the share (Juan keeps it), from the
        // collection, and the other share deleted.
        ok(
            &app,
            owner,
            Method::DELETE,
            &format!("/shares/{sid}/grants?user_id={ceci}"),
            None,
        )
        .await;
        ok(
            &app,
            owner,
            Method::DELETE,
            &format!("/collections/{k}/members/{ceci}"),
            None,
        )
        .await;
        ok(
            &app,
            owner,
            Method::DELETE,
            &format!("/shares/{gone}"),
            None,
        )
        .await;
        assert!(copies(&app, &token).await.is_empty());
        // Her extension, before it sees the loss: a stale rewrite, or a new
        // write, brings nothing back.
        for (id, rev) in [(sid, revs[0]), (x, revs[1]), (gone, revs[2])] {
            let (s, _) = grant(&app, ceci, agent, id, json!({ "base_revision": rev })).await;
            assert_eq!(s, StatusCode::NOT_FOUND);
            assert_eq!(grant_count(&db.pool, agent, id).await, 0);
        }
        for id in [sid, x] {
            let (s, _) = grant(&app, ceci, agent, id, json!({})).await;
            assert_eq!(s, StatusCode::NOT_FOUND);
            assert_eq!(grant_count(&db.pool, agent, id).await, 0);
        }
        // Nor moved onto one: the source stays.
        let own = item(&db.pool, ceci).await;
        let (_, b) = grant(&app, ceci, agent, own, json!({})).await;
        let (s, _) = grant(
            &app,
            ceci,
            agent,
            x,
            json!({ "move_from": own, "base_revision": b["revision"] }),
        )
        .await;
        assert_eq!(s, StatusCode::NOT_FOUND);
        assert_eq!(copies(&app, &token).await, vec![own]);
    }

    #[tokio::test]
    async fn a_grant_written_during_a_revocation_waits_for_it() {
        let db = test_db().await;
        let app = shared_app(db.pool.clone());
        let (owner, ceci, juan) = (
            create_user(&db.pool, "team_lite").await,
            create_user(&db.pool, "team_lite").await,
            create_user(&db.pool, "team_lite").await,
        );
        let t = team(&db.pool, owner, &[ceci, juan]).await;
        let (agent, _) = connect(&app, ceci).await;
        let write = |id: Uuid| {
            let app = app.clone();
            tokio::spawn(async move { grant(&app, ceci, agent, id, json!({})).await.0 })
        };
        // A path holding the team lock (removing her grant).
        let sid = share(
            &app,
            owner,
            item(&db.pool, owner).await,
            json!([to(ceci), to(juan)]),
        )
        .await;
        let mut removal = db.pool.begin().await.unwrap();
        sqlx::query(
            "SELECT pg_advisory_xact_lock(hashtext('team_membership'), hashtext($1::text))",
        )
        .bind(t)
        .execute(&mut *removal)
        .await
        .unwrap();
        let writing = write(sid);
        crate::test_support::wait_for_lock_waits(&db.pool, 1).await;
        sqlx::query("DELETE FROM share_grants WHERE share_id = $1 AND user_id = $2")
            .bind(sid)
            .bind(ceci)
            .execute(&mut *removal)
            .await
            .unwrap();
        removal.commit().await.unwrap();
        assert_eq!(writing.await.unwrap(), StatusCode::NOT_FOUND);
        assert_eq!(grant_count(&db.pool, agent, sid).await, 0);
        // A path holding only the share row (the owner deleting the item).
        let other = item(&db.pool, owner).await;
        let sid = share(&app, owner, other, json!([to(ceci), to(juan)])).await;
        let mut deletion = db.pool.begin().await.unwrap();
        sqlx::query("SELECT 1 FROM shares WHERE id = $1 FOR UPDATE")
            .bind(sid)
            .execute(&mut *deletion)
            .await
            .unwrap();
        let writing = write(sid);
        crate::test_support::wait_for_lock_waits(&db.pool, 1).await;
        sqlx::query("DELETE FROM shares WHERE id = $1")
            .bind(sid)
            .execute(&mut *deletion)
            .await
            .unwrap();
        deletion.commit().await.unwrap();
        assert_eq!(writing.await.unwrap(), StatusCode::NOT_FOUND);
        assert_eq!(grant_count(&db.pool, agent, sid).await, 0);
        // A path holding a collection item's row (deleting it).
        let k = collection(&db.pool, t, &[(owner, "manage"), (ceci, "view")]).await;
        let x = collection_item(&db.pool, k).await;
        let mut deletion = db.pool.begin().await.unwrap();
        sqlx::query("SELECT 1 FROM vault_items WHERE id = $1 FOR UPDATE")
            .bind(x)
            .execute(&mut *deletion)
            .await
            .unwrap();
        let writing = write(x);
        crate::test_support::wait_for_lock_waits(&db.pool, 1).await;
        sqlx::query("UPDATE vault_items SET deleted_at = NOW(), encrypted_item = '' WHERE id = $1")
            .bind(x)
            .execute(&mut *deletion)
            .await
            .unwrap();
        deletion.commit().await.unwrap();
        assert_eq!(writing.await.unwrap(), StatusCode::NOT_FOUND);
        assert_eq!(grant_count(&db.pool, agent, x).await, 0);
    }

    #[tokio::test]
    async fn a_refused_conversion_or_deletion_keeps_the_copies() {
        let db = test_db().await;
        let app = shared_app(db.pool.clone());
        let (owner, ceci) = (
            create_user(&db.pool, "team_lite").await,
            create_user(&db.pool, "team_lite").await,
        );
        let t = team(&db.pool, owner, &[ceci]).await;
        let k = collection(&db.pool, t, &[(owner, "manage"), (ceci, "edit")]).await;
        let other = collection(&db.pool, t, &[(owner, "manage")]).await;
        let x = collection_item(&db.pool, k).await;
        let (agent, token) = connect(&app, ceci).await;
        give(&app, ceci, agent, x).await;
        let rev = revision(&db.pool, x).await;
        let taken = item(&db.pool, owner).await;
        for (cid, base, share_id, want) in [
            (k, rev - 1, Uuid::new_v4(), StatusCode::CONFLICT),
            (other, rev, Uuid::new_v4(), StatusCode::NOT_FOUND),
            // Refused after the at-risk list and the new item were written.
            (k, rev, taken, StatusCode::BAD_REQUEST),
        ] {
            let (s, b) = call(
                &app,
                owner,
                Method::POST,
                &format!("/collections/{cid}/items/{x}/convert"),
                Some(json!({
                    "base_revision": base,
                    "item": { "id": Uuid::new_v4(), "record": record() },
                    "share": { "id": share_id, "record": record(), "wrapped_key": "k" },
                })),
            )
            .await;
            assert_eq!(s, want, "{b}");
        }
        let (s, _) = call(
            &app,
            owner,
            Method::DELETE,
            &format!("/collections/{k}/items/{x}?base_revision={}", rev - 1),
            None,
        )
        .await;
        assert_eq!(s, StatusCode::CONFLICT);
        assert_eq!(copies(&app, &token).await, vec![x]);
        assert_eq!(revision(&db.pool, x).await, rev);
    }

    #[tokio::test]
    async fn deleting_an_account_revokes_teammates_copies_of_its_shares() {
        let db = test_db().await;
        // Supabase's admin API, answering yes (no Stripe: nobody pays here).
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().fallback(|| async { StatusCode::OK }),
            )
            .await
            .unwrap()
        });
        let mut state = test_state(db.pool.clone());
        state.supabase_admin_base = base;
        let app = router()
            .merge(crate::routes::shares::router())
            .merge(crate::routes::auth::router())
            .with_state(state);
        let (owner, ceci, juan) = (
            create_user(&db.pool, "team_lite").await,
            create_user(&db.pool, "team_lite").await,
            create_user(&db.pool, "team_lite").await,
        );
        let t = team(&db.pool, owner, &[ceci, juan]).await;
        let k = collection(
            &db.pool,
            t,
            &[(owner, "manage"), (ceci, "edit"), (juan, "view")],
        )
        .await;
        let by_ceci = share(&app, ceci, item(&db.pool, ceci).await, json!([to(owner)])).await;
        let via_k = share(
            &app,
            ceci,
            item(&db.pool, ceci).await,
            json!([to_collection(k)]),
        )
        .await;
        let by_owner = share(&app, owner, item(&db.pool, owner).await, json!([to(juan)])).await;
        let (owner_agent, owner_token) = connect(&app, owner).await;
        let (juan_agent, juan_token) = connect(&app, juan).await;
        give(&app, owner, owner_agent, by_ceci).await;
        give(&app, juan, juan_agent, via_k).await;
        give(&app, juan, juan_agent, by_owner).await;
        // A member deletes her account (she leaves the team).
        let (s, b) = call(&app, ceci, Method::DELETE, "/users/me", None).await;
        assert_eq!(s, StatusCode::NO_CONTENT, "{b}");
        assert!(copies(&app, &owner_token).await.is_empty());
        assert_eq!(copies(&app, &juan_token).await, vec![by_owner]);
        // The owner deletes theirs (the team is dissolved).
        let (s, b) = call(&app, owner, Method::DELETE, "/users/me", None).await;
        assert_eq!(s, StatusCode::NO_CONTENT, "{b}");
        assert!(copies(&app, &juan_token).await.is_empty());
    }
}
