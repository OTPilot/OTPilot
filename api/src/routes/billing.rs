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

/// The Stripe customer to attach a checkout to: the user's existing one (so
/// the billing portal shows all their subscriptions), else a new one from the
/// email.
async fn customer_params<'a>(
    db: &sqlx::PgPool,
    user: uuid::Uuid,
    email: &'a str,
    customer: &'a mut Option<String>,
) -> Result<Vec<(&'static str, &'a str)>> {
    *customer = sqlx::query_scalar::<_, Option<String>>(
        "SELECT stripe_customer_id FROM users WHERE id = $1",
    )
    .bind(user)
    .fetch_optional(db)
    .await?
    .flatten()
    .filter(|c| !c.is_empty());
    Ok(match customer.as_deref() {
        Some(c) => vec![("customer", c)],
        None if !email.is_empty() => vec![("customer_email", email)],
        None => vec![],
    })
}

/// Cancels a subscription right away, without a refund. Ok when Stripe
/// confirms it or no longer has it (already cancelled), and when Stripe isn't
/// configured (development). Used by account deletion, which must not leave
/// a subscription charging a deleted account.
pub(crate) async fn cancel_subscription_now(state: &AppState, sub_id: &str) -> Result<()> {
    if sub_id.is_empty() {
        return Ok(());
    }
    if state.stripe_secret_key.is_empty() {
        // A real subscription can't be left charging because the key is
        // missing: fail, so the caller stops.
        return Err(ApiError::ServiceUnavailable(
            "Stripe is not configured; the subscription can't be cancelled".into(),
        ));
    }
    let res = reqwest::Client::new()
        .delete(format!(
            "{}/v1/subscriptions/{sub_id}",
            state.stripe_api_base
        ))
        .basic_auth(&state.stripe_secret_key, Some(""))
        .send()
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("Stripe: {e}")))?;
    match res.status() {
        s if s.is_success() || s == reqwest::StatusCode::NOT_FOUND => {
            tracing::info!("canceled subscription {sub_id}");
            Ok(())
        }
        s => Err(ApiError::Internal(anyhow::anyhow!(
            "Stripe cancel {sub_id}: {s}"
        ))),
    }
}

/// Cancels a subscription right away (best effort: logged on failure).
async fn cancel_subscription(state: &AppState, sub_id: &str) {
    if state.stripe_secret_key.is_empty() || sub_id.is_empty() {
        return;
    }
    let res = reqwest::Client::new()
        .delete(format!(
            "{}/v1/subscriptions/{sub_id}",
            state.stripe_api_base
        ))
        .basic_auth(&state.stripe_secret_key, Some(""))
        .send()
        .await;
    match res {
        Ok(r) if r.status().is_success() => {
            tracing::info!("canceled duplicate subscription {sub_id}")
        }
        Ok(r) => tracing::error!("could not cancel subscription {sub_id}: {}", r.status()),
        Err(e) => tracing::error!("could not cancel subscription {sub_id}: {e}"),
    }
}

/// Seats included in the base Team Lite subscription (owner + 4).
const BASE_SEATS: i32 = 5;

// ── Checkout ───────────────────────────────────────────────────────────────────

#[derive(sqlx::FromRow)]
struct UserPlanRow {
    plan: String,
}

/// Personal subscription checkout ($3/mo or $30/yr). Body `{ "annual": bool }`.
/// Returns the Stripe Checkout URL.
async fn create_checkout(
    State(state): State<AppState>,
    auth: AuthUser,
    body: axum::body::Bytes,
) -> Result<Json<Value>> {
    let annual = serde_json::from_slice::<Value>(&body)
        .ok()
        .and_then(|v| v["annual"].as_bool())
        .unwrap_or(false);

    let user = sqlx::query_as::<_, UserPlanRow>(
        "SELECT plan FROM users WHERE id = $1 AND deletion_started_at IS NULL",
    )
    .bind(auth.id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(ApiError::Forbidden)?; // missing, or being deleted

    if matches!(user.plan.as_str(), "personal" | "team_lite" | "team_pro") {
        return Err(ApiError::BadRequest("Already on a paid plan".into()));
    }

    let price = if annual {
        state.stripe_personal_annual_price_id.as_str()
    } else {
        state.stripe_personal_monthly_price_id.as_str()
    };
    if price.is_empty() {
        return Err(ApiError::ServiceUnavailable(
            "Personal plan is not configured".into(),
        ));
    }

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
        // Tells the webhook this subscription is Personal, not Team Lite.
        ("metadata[plan]", "personal"),
        ("subscription_data[metadata][plan]", "personal"),
    ];
    let mut customer = None;
    params.extend(customer_params(&state.db, auth.id, &email, &mut customer).await?);
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

    let plan = sqlx::query_scalar::<_, String>(
        "SELECT plan FROM users WHERE id = $1 AND deletion_started_at IS NULL",
    )
    .bind(auth.id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(ApiError::Forbidden)?; // missing, or being deleted
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
        ("metadata[plan]", "team_lite"),
        ("subscription_data[metadata][plan]", "team_lite"),
        ("automatic_tax[enabled]", "true"),
    ];
    let mut customer = None;
    params.extend(customer_params(&state.db, auth.id, &email, &mut customer).await?);

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

            let is_subscription = obj["mode"].as_str() == Some("subscription");
            let sub_id = obj["subscription"].as_str().unwrap_or("");
            // Webhooks can arrive out of order: a subscription already
            // reported as ended grants nothing.
            if is_subscription {
                let ended: bool = sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM stripe_ended_subscriptions WHERE subscription_id = $1)",
                )
                .bind(sub_id)
                .fetch_one(&state.db)
                .await?;
                if ended {
                    tracing::warn!("checkout completed for already-ended subscription {sub_id}");
                    return Ok(Json(json!({ "received": true })));
                }
            }
            let personal_sub =
                is_subscription && obj["metadata"]["plan"].as_str() == Some("personal");
            if personal_sub {
                // Personal subscription. A team plan, if any, stays the
                // effective plan; has_personal_cloud is what leaving or
                // losing the team falls back to. Only one Personal
                // subscription per user: a second checkout completing (two
                // tabs) keeps the first, and the new one is canceled.
                let granted = sqlx::query(
                    "UPDATE users SET plan = CASE WHEN plan IN ('team_lite', 'team_pro') THEN plan ELSE 'personal' END, \
                     has_personal_cloud = true, personal_subscription_id = NULLIF($1, ''), stripe_customer_id = $2 \
                     WHERE id = $3 AND deletion_started_at IS NULL
                       AND (personal_subscription_id IS NULL OR personal_subscription_id = $1)",
                )
                .bind(sub_id)
                .bind(customer_id)
                .bind(user_id)
                .execute(&state.db)
                .await?;
                if granted.rows_affected() == 0 {
                    tracing::warn!(
                        "user {user_id} already has a Personal subscription; canceling {sub_id}"
                    );
                    cancel_subscription(&state, sub_id).await;
                    return Ok(Json(json!({ "received": true })));
                }
                tracing::info!("user {user_id} subscribed to personal");
                if !email.is_empty() {
                    crate::email::send_personal_subscription_email(
                        state.send_emails,
                        state.resend_api_key.as_deref(),
                        &state.from_email,
                        &email,
                    )
                    .await;
                }
            } else if is_subscription {
                // Team Lite: upgrade + auto-create the team (1 per owner).
                // An account being deleted (or gone) gets nothing: the new
                // subscription is cancelled instead of left charging.
                let granted = sqlx::query(
                    "UPDATE users SET plan = 'team_lite', stripe_customer_id = $1
                     WHERE id = $2 AND deletion_started_at IS NULL",
                )
                .bind(customer_id)
                .bind(user_id)
                .execute(&state.db)
                .await?;
                if granted.rows_affected() == 0 {
                    tracing::warn!("team checkout for a deleted/deleting account {user_id}; canceling {sub_id}");
                    cancel_subscription(&state, sub_id).await;
                    return Ok(Json(json!({ "received": true })));
                }

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
                // Personal Cloud one-time purchase (1.x; a session created
                // before 2.0 can still complete): set plan + the flag.
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
            // Remembered, so a checkout completion arriving late grants nothing.
            sqlx::query(
                "INSERT INTO stripe_ended_subscriptions (subscription_id) VALUES ($1) ON CONFLICT DO NOTHING",
            )
            .bind(sub_id)
            .execute(&state.db)
            .await?;
            let team: Option<(uuid::Uuid,)> =
                sqlx::query_as("SELECT id FROM teams WHERE stripe_subscription_id = $1")
                    .bind(sub_id)
                    .fetch_optional(&state.db)
                    .await?;
            if let Some((team_id,)) = team {
                // Atomic: downgrade all members + delete the team in one transaction.
                crate::routes::teams::dissolve_team(&state.db, team_id).await?;
                tracing::info!("team {team_id} dissolved on subscription cancel");
            } else {
                // Personal subscription ended: back to Free (a team plan, if
                // any, stays; it no longer falls back to Personal).
                let ended = sqlx::query(
                    "UPDATE users SET has_personal_cloud = false, personal_subscription_id = NULL, \
                     plan = CASE WHEN plan = 'personal' THEN 'free' ELSE plan END \
                     WHERE personal_subscription_id = $1",
                )
                .bind(sub_id)
                .execute(&state.db)
                .await?;
                if ended.rows_affected() > 0 {
                    tracing::info!("personal subscription {sub_id} ended");
                }
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

#[cfg(all(test, feature = "db-tests"))]
mod db_tests {
    use super::*;
    use crate::test_support::{call, create_user, test_db, test_state, TestDb};
    use axum::{
        body::Body,
        http::{Method, Request, StatusCode},
    };
    use tower::ServiceExt;
    use uuid::Uuid;

    const SECRET: &str = "whsec_test";

    async fn app() -> (Router, sqlx::PgPool, TestDb) {
        let db = test_db().await;
        let pool = db.pool.clone();
        let mut state = test_state(pool.clone());
        state.stripe_webhook_secret = SECRET.into();
        (router().with_state(state), pool, db)
    }

    /// Posts a Stripe event signed like Stripe does.
    async fn send_event(app: &Router, event: Value) -> StatusCode {
        let body = event.to_string();
        let ts = chrono::Utc::now().timestamp().to_string();
        let mut mac = Hmac::<Sha256>::new_from_slice(SECRET.as_bytes()).unwrap();
        mac.update(format!("{ts}.{body}").as_bytes());
        let sig = hex_encode(&mac.finalize().into_bytes());
        let req = Request::builder()
            .method(Method::POST)
            .uri("/billing/webhook")
            .header("stripe-signature", format!("t={ts},v1={sig}"))
            .header("content-type", "application/json")
            .body(Body::from(body))
            .unwrap();
        app.clone().oneshot(req).await.unwrap().status()
    }

    fn completed(user: Uuid, plan: &str, sub: &str) -> Value {
        json!({ "type": "checkout.session.completed", "data": { "object": {
            "client_reference_id": user.to_string(), "customer": "cus_1", "mode": "subscription",
            "subscription": sub, "metadata": { "plan": plan }, "customer_details": { "email": "" },
        } } })
    }

    fn deleted(sub: &str) -> Value {
        json!({ "type": "customer.subscription.deleted", "data": { "object": { "id": sub } } })
    }

    async fn row(db: &sqlx::PgPool, user: Uuid) -> (String, bool, Option<String>) {
        sqlx::query_as(
            "SELECT plan, has_personal_cloud, personal_subscription_id FROM users WHERE id = $1",
        )
        .bind(user)
        .fetch_one(db)
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn personal_subscription_starts_and_ends() {
        let (app, db, _guard) = app().await;
        let user = create_user(&db, "free").await;

        assert_eq!(
            send_event(&app, completed(user, "personal", "sub_p1")).await,
            StatusCode::OK
        );
        assert_eq!(
            row(&db, user).await,
            ("personal".into(), true, Some("sub_p1".into()))
        );

        // Another subscription ending changes nothing.
        assert_eq!(send_event(&app, deleted("sub_other")).await, StatusCode::OK);
        assert_eq!(row(&db, user).await.0, "personal");

        assert_eq!(send_event(&app, deleted("sub_p1")).await, StatusCode::OK);
        assert_eq!(row(&db, user).await, ("free".into(), false, None));
    }

    #[tokio::test]
    async fn a_team_member_with_personal_falls_back_to_it_when_the_team_ends() {
        let (app, db, _guard) = app().await;
        let owner = create_user(&db, "free").await;
        assert_eq!(
            send_event(&app, completed(owner, "team_lite", "sub_team")).await,
            StatusCode::OK
        );
        assert_eq!(row(&db, owner).await.0, "team_lite");

        // Personal bought while on the team: the team plan stays effective.
        assert_eq!(
            send_event(&app, completed(owner, "personal", "sub_p2")).await,
            StatusCode::OK
        );
        assert_eq!(
            row(&db, owner).await,
            ("team_lite".into(), true, Some("sub_p2".into()))
        );

        // The team subscription ends: back to Personal, not Free.
        assert_eq!(send_event(&app, deleted("sub_team")).await, StatusCode::OK);
        assert_eq!(row(&db, owner).await.0, "personal");

        // Then Personal ends too.
        assert_eq!(send_event(&app, deleted("sub_p2")).await, StatusCode::OK);
        assert_eq!(row(&db, owner).await, ("free".into(), false, None));
    }

    #[tokio::test]
    async fn personal_ending_while_on_a_team_keeps_the_team_plan() {
        let (app, db, _guard) = app().await;
        let user = create_user(&db, "free").await;
        send_event(&app, completed(user, "team_lite", "sub_team2")).await;
        send_event(&app, completed(user, "personal", "sub_p3")).await;
        send_event(&app, deleted("sub_p3")).await;
        assert_eq!(row(&db, user).await, ("team_lite".into(), false, None));
    }

    #[tokio::test]
    async fn a_completion_arriving_after_the_cancellation_grants_nothing() {
        let (app, db, _guard) = app().await;
        let user = create_user(&db, "free").await;
        assert_eq!(send_event(&app, deleted("sub_gone")).await, StatusCode::OK);
        assert_eq!(
            send_event(&app, completed(user, "personal", "sub_gone")).await,
            StatusCode::OK
        );
        assert_eq!(row(&db, user).await, ("free".into(), false, None));
        // Same for a team subscription: no plan, no team.
        assert_eq!(
            send_event(&app, deleted("sub_team_gone")).await,
            StatusCode::OK
        );
        assert_eq!(
            send_event(&app, completed(user, "team_lite", "sub_team_gone")).await,
            StatusCode::OK
        );
        assert_eq!(row(&db, user).await.0, "free");
        let teams: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM teams WHERE owner_id = $1")
            .bind(user)
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(teams, 0);
    }

    #[tokio::test]
    async fn a_second_personal_subscription_does_not_replace_the_first() {
        let (app, db, _guard) = app().await;
        let user = create_user(&db, "free").await;
        send_event(&app, completed(user, "personal", "sub_first")).await;
        send_event(&app, completed(user, "personal", "sub_second")).await;
        assert_eq!(
            row(&db, user).await,
            ("personal".into(), true, Some("sub_first".into()))
        );
        // The same completion delivered twice is fine.
        send_event(&app, completed(user, "personal", "sub_first")).await;
        assert_eq!(row(&db, user).await.2, Some("sub_first".into()));
    }

    #[tokio::test]
    async fn checkouts_reuse_the_users_stripe_customer() {
        let db = test_db().await;
        let user = create_user(&db.pool, "personal").await;
        let mut customer = None;
        let p = customer_params(&db.pool, user, "me@x.com", &mut customer)
            .await
            .unwrap();
        assert_eq!(p, vec![("customer_email", "me@x.com")]);
        sqlx::query("UPDATE users SET stripe_customer_id = 'cus_9' WHERE id = $1")
            .bind(user)
            .execute(&db.pool)
            .await
            .unwrap();
        let mut customer = None;
        let p = customer_params(&db.pool, user, "me@x.com", &mut customer)
            .await
            .unwrap();
        assert_eq!(p, vec![("customer", "cus_9")]);
    }

    #[tokio::test]
    async fn checkout_answers_503_until_the_personal_prices_are_set() {
        let db = test_db().await;
        let mut state = test_state(db.pool.clone());
        state.stripe_personal_monthly_price_id = String::new();
        let app = router().with_state(state);
        let user = create_user(&db.pool, "free").await;
        let (s, _) = call(
            &app,
            user,
            Method::POST,
            "/billing/checkout",
            Some(json!({ "annual": false })),
        )
        .await;
        assert_eq!(s, StatusCode::SERVICE_UNAVAILABLE);

        let paid = create_user(&db.pool, "personal").await;
        let (s, _) = call(
            &app,
            paid,
            Method::POST,
            "/billing/checkout",
            Some(json!({ "annual": true })),
        )
        .await;
        assert_eq!(s, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn an_account_being_deleted_cannot_check_out_and_a_late_completion_grants_nothing() {
        let (app, db, _guard) = app().await;
        let user = create_user(&db, "free").await;
        sqlx::query("UPDATE users SET deletion_started_at = NOW() WHERE id = $1")
            .bind(user)
            .execute(&db)
            .await
            .unwrap();
        let (s, _) = call(
            &app,
            user,
            Method::POST,
            "/billing/checkout",
            Some(json!({ "annual": false })),
        )
        .await;
        assert_eq!(s, StatusCode::FORBIDDEN);
        let (s, _) = call(
            &app,
            user,
            Method::POST,
            "/billing/checkout/team",
            Some(json!({ "annual": false })),
        )
        .await;
        assert_eq!(s, StatusCode::FORBIDDEN);

        // A checkout opened before the deletion completes now: not granted.
        send_event(&app, completed(user, "personal", "sub_late")).await;
        send_event(&app, completed(user, "team_lite", "sub_late_team")).await;
        assert_eq!(row(&db, user).await, ("free".into(), false, None));
        let teams: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM teams WHERE owner_id = $1")
            .bind(user)
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(teams, 0);
    }
}
