//! Helpers for DB-backed integration tests (`--features db-tests`).
//!
//! Each test gets its own freshly created database with every migration
//! applied, and requests go through the real router and the real `AuthUser`
//! extractor, using tokens signed with a fixed test key.

use std::{collections::HashMap, sync::Arc};

use axum::{
    body::{to_bytes, Body},
    http::{Method, Request, StatusCode},
    Router,
};
use jsonwebtoken::{encode, Algorithm, DecodingKey, EncodingKey, Header};
use serde_json::{json, Value};
use sqlx::{Executor, PgPool};
use tower::ServiceExt;
use uuid::Uuid;

use crate::AppState;

const SUPABASE_URL: &str = "https://test.supabase.local";
const KID: &str = "test-key";
// Test-only ES256 keypair (never used outside tests).
const PRIVATE_PEM: &str = "-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgqzagUnLjxpDZyd88
zgU77hz553DekKBfVKVdJUhOTrGhRANCAAQbuDqKsGRa2UkUGymBcGfOl8s3YUw7
tEJDB0m5sgtCKuATgtOlpDvfZ70PaUqcXW3o248/QUxNQr6v61aEcCC9
-----END PRIVATE KEY-----";
const PUBLIC_PEM: &str = "-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEG7g6irBkWtlJFBspgXBnzpfLN2FM
O7RCQwdJubILQirgE4LTpaQ732e9D2lKnF1t6NuPP0FMTUK+r+tWhHAgvQ==
-----END PUBLIC KEY-----";

/// A new database on the DATABASE_URL server, with all migrations applied.
pub async fn test_pool() -> PgPool {
    let url = std::env::var("DATABASE_URL").expect("db-tests need DATABASE_URL");
    let admin = PgPool::connect(&url).await.expect("connect to test server");
    let name = format!("otpilot_test_{}", Uuid::new_v4().simple());
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .expect("create test database");
    let base = url.rsplit_once('/').map(|(b, _)| b).unwrap_or(&url);
    let pool = PgPool::connect(&format!("{base}/{name}"))
        .await
        .expect("connect to test database");
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("migrate");
    pool
}

pub fn test_state(db: PgPool) -> AppState {
    let mut jwt_keys = HashMap::new();
    jwt_keys.insert(
        KID.to_string(),
        DecodingKey::from_ec_pem(PUBLIC_PEM.as_bytes()).unwrap(),
    );
    AppState {
        db,
        jwt_keys: Arc::new(jwt_keys),
        stripe_secret_key: String::new(),
        stripe_webhook_secret: String::new(),
        stripe_personal_price_id: String::new(),
        stripe_team_lite_monthly_price_id: String::new(),
        stripe_team_lite_annual_price_id: String::new(),
        stripe_extra_seat_price_id: String::new(),
        app_base_url: String::new(),
        success_url: String::new(),
        cancel_url: String::new(),
        resend_api_key: None,
        from_email: String::new(),
        send_emails: false,
        supabase_url: SUPABASE_URL.to_string(),
        supabase_service_key: String::new(),
        icons: None,
        rate_limiter: Arc::new(crate::middleware::rate_limit::RateLimiter::new()),
    }
}

/// A users row with the given plan; returns its id.
pub async fn create_user(db: &PgPool, plan: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO users (id, plan) VALUES ($1, $2)")
        .bind(id)
        .bind(plan)
        .execute(db)
        .await
        .unwrap();
    id
}

pub fn token_for(user: Uuid) -> String {
    let mut header = Header::new(Algorithm::ES256);
    header.kid = Some(KID.into());
    let claims = json!({
        "sub": user.to_string(),
        "aud": "authenticated",
        "iss": format!("{SUPABASE_URL}/auth/v1"),
        "exp": chrono::Utc::now().timestamp() + 3600,
    });
    encode(
        &header,
        &claims,
        &EncodingKey::from_ec_pem(PRIVATE_PEM.as_bytes()).unwrap(),
    )
    .unwrap()
}

/// Sends one request through the router as `user`; returns status + JSON body
/// (Null when the body isn't JSON).
pub async fn call(
    app: &Router,
    user: Uuid,
    method: Method,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let req = Request::builder()
        .method(method)
        .uri(uri)
        .header("authorization", format!("Bearer {}", token_for(user)))
        .header("content-type", "application/json")
        .body(body.map_or_else(Body::empty, |b| Body::from(b.to_string())))
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = to_bytes(res.into_body(), usize::MAX).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
