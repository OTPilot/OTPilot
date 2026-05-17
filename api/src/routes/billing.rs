use axum::{body::Bytes, extract::State, http::HeaderMap, routing::post, Json, Router};
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;

use crate::{
    error::{ApiError, Result},
    middleware::auth::AuthUser,
    AppState,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/billing/checkout", post(create_checkout))
        .route("/billing/webhook", post(webhook))
}

// ── Checkout ───────────────────────────────────────────────────────────────────

#[derive(sqlx::FromRow)]
struct UserPlanRow {
    plan: String,
}

/// Creates a Stripe Checkout session and returns the redirect URL.
async fn create_checkout(State(state): State<AppState>, auth: AuthUser) -> Result<Json<Value>> {
    let user = sqlx::query_as::<_, UserPlanRow>("SELECT plan FROM users WHERE id = $1")
        .bind(auth.id)
        .fetch_optional(&state.db)
        .await?
        .ok_or(ApiError::Unauthorized)?;

    if matches!(user.plan.as_str(), "personal" | "team_lite" | "team_pro") {
        return Err(ApiError::BadRequest("Already on a paid plan".into()));
    }

    let client = reqwest::Client::new();
    let user_id = auth.id.to_string();
    let email = auth.email.unwrap_or_default();
    let mut params = vec![
        ("mode", "payment"),
        ("success_url", state.success_url.as_str()),
        ("cancel_url", state.cancel_url.as_str()),
        (
            "line_items[0][price]",
            state.stripe_personal_price_id.as_str(),
        ),
        ("line_items[0][quantity]", "1"),
        ("client_reference_id", user_id.as_str()),
    ];
    if !email.is_empty() {
        params.push(("customer_email", email.as_str()));
    }
    params.push(("automatic_tax[enabled]", "true"));

    let res = client
        .post("https://api.stripe.com/v1/checkout/sessions")
        .basic_auth(&state.stripe_secret_key, Some(""))
        .form(&params)
        .send()
        .await
        .map_err(|e| ApiError::Internal(e.into()))?;

    if !res.status().is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(ApiError::Internal(anyhow::anyhow!("Stripe: {body}")));
    }

    let session: Value = res.json().await.map_err(|e| ApiError::Internal(e.into()))?;
    let url = session["url"]
        .as_str()
        .ok_or_else(|| ApiError::Internal(anyhow::anyhow!("No URL in Stripe response")))?;

    Ok(Json(json!({ "url": url })))
}

// ── Webhook ────────────────────────────────────────────────────────────────────

/// Stripe calls this when a payment completes.
/// Verifies the signature then upgrades the user's plan on `checkout.session.completed`.
async fn webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Value>> {
    let sig = headers
        .get("stripe-signature")
        .and_then(|v| v.to_str().ok())
        .ok_or(ApiError::Unauthorized)?;

    verify_signature(&body, sig, &state.stripe_webhook_secret)?;

    let event: Value =
        serde_json::from_slice(&body).map_err(|_| ApiError::BadRequest("invalid JSON".into()))?;

    if event["type"].as_str() == Some("checkout.session.completed") {
        let session = &event["data"]["object"];

        let user_id_str = session["client_reference_id"]
            .as_str()
            .ok_or_else(|| ApiError::BadRequest("missing client_reference_id".into()))?;
        let user_id = uuid::Uuid::parse_str(user_id_str)
            .map_err(|_| ApiError::BadRequest("invalid user id".into()))?;

        let customer_id = session["customer"].as_str().unwrap_or("");

        sqlx::query("UPDATE users SET plan = 'personal', stripe_customer_id = $1 WHERE id = $2")
            .bind(customer_id)
            .bind(user_id)
            .execute(&state.db)
            .await?;

        tracing::info!("upgraded user {user_id} to personal plan");
    }

    Ok(Json(json!({ "received": true })))
}

// ── Stripe signature verification ──────────────────────────────────────────────

fn verify_signature(payload: &[u8], sig_header: &str, secret: &str) -> Result<()> {
    let mut timestamp: Option<&str> = None;
    let mut signatures: Vec<&str> = Vec::new();

    for part in sig_header.split(',') {
        if let Some(t) = part.strip_prefix("t=") {
            timestamp = Some(t);
        } else if let Some(v1) = part.strip_prefix("v1=") {
            signatures.push(v1);
        }
    }

    let timestamp =
        timestamp.ok_or_else(|| ApiError::BadRequest("missing t= in stripe-signature".into()))?;

    // Reject events older than 5 minutes (replay attack prevention).
    let ts: i64 = timestamp
        .parse()
        .map_err(|_| ApiError::BadRequest("invalid timestamp".into()))?;
    if (chrono::Utc::now().timestamp() - ts).abs() > 300 {
        return Err(ApiError::Unauthorized);
    }

    // signed_payload = "<timestamp>.<raw_body>"
    let mut signed = timestamp.as_bytes().to_vec();
    signed.push(b'.');
    signed.extend_from_slice(payload);

    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
        .map_err(|_| ApiError::Internal(anyhow::anyhow!("hmac init failed")))?;
    mac.update(&signed);
    let computed = hex_encode(&mac.finalize().into_bytes());

    if signatures.iter().any(|s| *s == computed) {
        Ok(())
    } else {
        Err(ApiError::Unauthorized)
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
