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
        .route("/billing/checkout/team", post(create_team_checkout))
        .route("/billing/extra-seat", post(add_extra_seat))
        .route("/billing/portal", post(billing_portal))
        .route("/billing/webhook", post(webhook))
}

/// Seats included in the base Team Lite subscription (owner + 4).
const BASE_SEATS: i32 = 5;

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
    // params.push(("allow_promotion_codes", "true"));

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

/// Team Lite subscription checkout. Body `{ "annual": bool }`.
async fn create_team_checkout(
    State(state): State<AppState>,
    auth: AuthUser,
    body: axum::body::Bytes,
) -> Result<Json<Value>> {
    let annual = serde_json::from_slice::<Value>(&body)
        .ok()
        .and_then(|v| v["annual"].as_bool())
        .unwrap_or(false);

    let plan = sqlx::query_scalar::<_, String>("SELECT plan FROM users WHERE id = $1")
        .bind(auth.id)
        .fetch_optional(&state.db)
        .await?
        .ok_or(ApiError::Unauthorized)?;
    if matches!(plan.as_str(), "team_lite" | "team_pro") {
        return Err(ApiError::BadRequest("Already on a team plan".into()));
    }

    let price = if annual {
        state.stripe_team_lite_annual_price_id.as_str()
    } else {
        state.stripe_team_lite_monthly_price_id.as_str()
    };
    let client = reqwest::Client::new();
    let user_id = auth.id.to_string();
    let email = auth.email.unwrap_or_default();
    let mut params = vec![
        ("mode", "subscription"),
        ("success_url", state.success_url.as_str()),
        ("cancel_url", state.cancel_url.as_str()),
        ("line_items[0][price]", price),
        ("line_items[0][quantity]", "1"),
        ("client_reference_id", user_id.as_str()),
        ("automatic_tax[enabled]", "true"),
    ];
    if !email.is_empty() {
        params.push(("customer_email", email.as_str()));
    }

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

/// Adds one extra seat to the owner's Team Lite subscription (Stripe addon item).
/// seat_limit is reconciled by the `customer.subscription.updated` webhook.
async fn add_extra_seat(State(state): State<AppState>, auth: AuthUser) -> Result<Json<Value>> {
    let sub_id: Option<String> =
        sqlx::query_scalar("SELECT stripe_subscription_id FROM teams WHERE owner_id = $1")
            .bind(auth.id)
            .fetch_optional(&state.db)
            .await?
            .flatten();
    let sub_id =
        sub_id.ok_or_else(|| ApiError::BadRequest("no active team subscription".into()))?;

    let client = reqwest::Client::new();
    // Find an existing extra-seat item to bump, else create one.
    let sub: Value = client
        .get(format!("https://api.stripe.com/v1/subscriptions/{sub_id}"))
        .basic_auth(&state.stripe_secret_key, Some(""))
        .send()
        .await
        .map_err(|e| ApiError::Internal(e.into()))?
        .json()
        .await
        .map_err(|e| ApiError::Internal(e.into()))?;

    let extra_price = state.stripe_extra_seat_price_id.as_str();
    let existing = sub["items"]["data"].as_array().and_then(|items| {
        items
            .iter()
            .find(|it| it["price"]["id"].as_str() == Some(extra_price))
    });

    let resp = if let Some(item) = existing {
        let item_id = item["id"].as_str().unwrap_or_default();
        let qty = item["quantity"].as_i64().unwrap_or(0) + 1;
        let qty_s = qty.to_string();
        client
            .post(format!(
                "https://api.stripe.com/v1/subscription_items/{item_id}"
            ))
            .basic_auth(&state.stripe_secret_key, Some(""))
            .form(&[("quantity", qty_s.as_str())])
            .send()
            .await
    } else {
        client
            .post("https://api.stripe.com/v1/subscription_items")
            .basic_auth(&state.stripe_secret_key, Some(""))
            .form(&[
                ("subscription", sub_id.as_str()),
                ("price", extra_price),
                ("quantity", "1"),
            ])
            .send()
            .await
    }
    .map_err(|e| ApiError::Internal(e.into()))?;

    if !resp.status().is_success() {
        let b = resp.text().await.unwrap_or_default();
        return Err(ApiError::Internal(anyhow::anyhow!("Stripe: {b}")));
    }
    // Optimistic bump; the subscription.updated webhook reconciles the exact count.
    sqlx::query("UPDATE teams SET seat_limit = seat_limit + 1 WHERE owner_id = $1")
        .bind(auth.id)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

/// Stripe Billing Portal session — lets the user manage/cancel their subscription
/// and download invoices.
async fn billing_portal(State(state): State<AppState>, auth: AuthUser) -> Result<Json<Value>> {
    let customer_id: Option<String> =
        sqlx::query_scalar("SELECT stripe_customer_id FROM users WHERE id = $1")
            .bind(auth.id)
            .fetch_optional(&state.db)
            .await?
            .flatten();
    let customer_id =
        customer_id.ok_or_else(|| ApiError::BadRequest("no billing account yet".into()))?;

    let res = reqwest::Client::new()
        .post("https://api.stripe.com/v1/billing_portal/sessions")
        .basic_auth(&state.stripe_secret_key, Some(""))
        .form(&[
            ("customer", customer_id.as_str()),
            ("return_url", state.cancel_url.as_str()),
        ])
        .send()
        .await
        .map_err(|e| ApiError::Internal(e.into()))?;
    if !res.status().is_success() {
        let b = res.text().await.unwrap_or_default();
        return Err(ApiError::Internal(anyhow::anyhow!("Stripe: {b}")));
    }
    let session: Value = res.json().await.map_err(|e| ApiError::Internal(e.into()))?;
    let url = session["url"]
        .as_str()
        .ok_or_else(|| ApiError::Internal(anyhow::anyhow!("No portal URL")))?;
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

    let event_type = event["type"].as_str().unwrap_or("");
    let obj = &event["data"]["object"];

    match event_type {
        "checkout.session.completed" => {
            let user_id_str = obj["client_reference_id"]
                .as_str()
                .ok_or_else(|| ApiError::BadRequest("missing client_reference_id".into()))?;
            let user_id = uuid::Uuid::parse_str(user_id_str)
                .map_err(|_| ApiError::BadRequest("invalid user id".into()))?;
            let customer_id = obj["customer"].as_str().unwrap_or("");
            let email = obj["customer_details"]["email"]
                .as_str()
                .or_else(|| obj["customer_email"].as_str())
                .unwrap_or("")
                .to_string();

            if obj["mode"].as_str() == Some("subscription") {
                // Team Lite: upgrade + auto-create the team (1 per owner).
                let sub_id = obj["subscription"].as_str().unwrap_or("");
                sqlx::query(
                    "UPDATE users SET plan = 'team_lite', stripe_customer_id = $1 WHERE id = $2",
                )
                .bind(customer_id)
                .bind(user_id)
                .execute(&state.db)
                .await?;

                let has_team: bool =
                    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM teams WHERE owner_id = $1)")
                        .bind(user_id)
                        .fetch_one(&state.db)
                        .await
                        .unwrap_or(true);
                if !has_team {
                    let default_name = email
                        .split('@')
                        .next()
                        .filter(|s| !s.is_empty())
                        .map(|s| format!("{s}'s Team"))
                        .unwrap_or_else(|| "My Team".to_string());
                    let _ = crate::routes::teams::create_team_row(
                        &state.db,
                        user_id,
                        &default_name,
                        Some(sub_id),
                    )
                    .await;
                }
                tracing::info!("upgraded user {user_id} to team_lite");
            } else {
                // Personal Cloud (one-time): set plan + the persistent flag.
                sqlx::query(
                    "UPDATE users SET plan = 'personal', has_personal_cloud = true, stripe_customer_id = $1 WHERE id = $2",
                )
                .bind(customer_id)
                .bind(user_id)
                .execute(&state.db)
                .await?;
                tracing::info!("upgraded user {user_id} to personal plan");
                if !email.is_empty() {
                    crate::email::send_personal_upgrade_email(
                        state.send_emails,
                        state.resend_api_key.as_deref(),
                        &state.from_email,
                        &email,
                    )
                    .await;
                }
            }
        }
        "customer.subscription.deleted" => {
            // Team subscription canceled → downgrade everyone + dissolve the team.
            let sub_id = obj["id"].as_str().unwrap_or("");
            let team: Option<(uuid::Uuid,)> =
                sqlx::query_as("SELECT id FROM teams WHERE stripe_subscription_id = $1")
                    .bind(sub_id)
                    .fetch_optional(&state.db)
                    .await?;
            if let Some((team_id,)) = team {
                let members: Vec<uuid::Uuid> =
                    sqlx::query_scalar("SELECT user_id FROM team_members WHERE team_id = $1")
                        .bind(team_id)
                        .fetch_all(&state.db)
                        .await?;
                sqlx::query("DELETE FROM teams WHERE id = $1")
                    .bind(team_id)
                    .execute(&state.db)
                    .await?;
                for uid in members {
                    crate::routes::teams::downgrade_user(&state.db, uid).await?;
                }
                tracing::info!("team {team_id} dissolved on subscription cancel");
            }
        }
        "customer.subscription.updated" => {
            // Reconcile seat_limit = base + extra-seat item quantity.
            let sub_id = obj["id"].as_str().unwrap_or("");
            let extra: i64 = obj["items"]["data"]
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .filter(|it| {
                            it["price"]["id"].as_str()
                                == Some(state.stripe_extra_seat_price_id.as_str())
                        })
                        .map(|it| it["quantity"].as_i64().unwrap_or(0))
                        .sum()
                })
                .unwrap_or(0);
            let seat_limit = BASE_SEATS as i64 + extra;
            sqlx::query("UPDATE teams SET seat_limit = $1 WHERE stripe_subscription_id = $2")
                .bind(seat_limit as i32)
                .bind(sub_id)
                .execute(&state.db)
                .await?;
        }
        _ => {}
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
