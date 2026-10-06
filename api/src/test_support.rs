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
use sqlx::{postgres::PgConnectOptions, Executor, PgPool};
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

/// A fresh database on the DATABASE_URL server with every migration applied.
/// Dropped when this guard goes out of scope — also when the test panics,
/// since Drop runs during unwinding.
pub struct TestDb {
    pub pool: PgPool,
    name: String,
    admin: PgConnectOptions,
}

impl Drop for TestDb {
    fn drop(&mut self) {
        let (name, admin) = (self.name.clone(), self.admin.clone());
        // Drop can't await, and the test's runtime may be shutting down: use a
        // short-lived runtime on its own thread. FORCE ends the test's pool
        // connections (Postgres 13+).
        let _ = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(async {
                if let Ok(pool) = PgPool::connect_with(admin).await {
                    let _ = pool
                        .execute(format!("DROP DATABASE IF EXISTS {name} WITH (FORCE)").as_str())
                        .await;
                }
            });
        })
        .join();
    }
}

pub async fn test_db() -> TestDb {
    let url = std::env::var("DATABASE_URL").expect("db-tests need DATABASE_URL");
    // Parse once and only swap the database name, keeping any query settings
    // (sslmode, a socket `host=…`, …) for both connections.
    let admin: PgConnectOptions = url.parse().expect("valid DATABASE_URL");
    let name = format!("otpilot_test_{}", Uuid::new_v4().simple());
    let server = PgPool::connect_with(admin.clone())
        .await
        .expect("connect to test server");
    server
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .expect("create test database");
    server.close().await;
    let pool = PgPool::connect_with(admin.clone().database(&name))
        .await
        .expect("connect to test database");
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("migrate");
    TestDb { pool, name, admin }
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
