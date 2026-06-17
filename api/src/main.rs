mod db;
mod email;
mod error;
mod middleware;
mod routes;

use axum::{http::Method, Router};
use std::collections::HashMap;
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[derive(Clone)]
pub struct AppState {
    pub db: sqlx::PgPool,
    /// kid → DecodingKey, built from Supabase JWKS at startup
    pub jwt_keys: Arc<HashMap<String, jsonwebtoken::DecodingKey>>,
    pub stripe_secret_key: String,
    pub stripe_webhook_secret: String,
    pub stripe_personal_price_id: String,
    pub success_url: String,
    pub cancel_url: String,
    pub resend_api_key: Option<String>,
    pub from_email: String,
    pub send_emails: bool,
    pub supabase_url: String,
    pub supabase_service_key: String,
    /// S3/R2 store for domain favicons. None when not configured (feature disabled).
    pub icons: Option<routes::icons::IconStore>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();

    let _sentry = std::env::var("SENTRY_DSN").ok().map(|dsn| {
        sentry::init((
            dsn,
            sentry::ClientOptions {
                release: sentry::release_name!(),
                traces_sample_rate: 1.0,
                enable_logs: true,
                ..Default::default()
            },
        ))
    });

    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "api=info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let db = db::connect().await?;
    sqlx::migrate!("./migrations").run(&db).await?;

    // Finish any deletions where Supabase succeeded but the DB DELETE did not.
    let _ = sqlx::query("DELETE FROM users WHERE pending_deletion_at IS NOT NULL")
        .execute(&db)
        .await;

    let supabase_url = std::env::var("SUPABASE_URL").expect("SUPABASE_URL must be set");
    let jwks_url = format!("{}/auth/v1/.well-known/jwks.json", supabase_url);
    let jwks: jsonwebtoken::jwk::JwkSet = reqwest::get(&jwks_url).await?.json().await?;

    let mut jwt_keys = HashMap::new();
    for jwk in &jwks.keys {
        let kid = jwk.common.key_id.clone().unwrap_or_default();
        match jsonwebtoken::DecodingKey::from_jwk(jwk) {
            Ok(key) => {
                tracing::info!("loaded JWKS key kid={kid}");
                jwt_keys.insert(kid, key);
            }
            Err(e) => tracing::warn!("skipping JWKS key kid={kid}: {e}"),
        }
    }
    assert!(!jwt_keys.is_empty(), "no usable keys in Supabase JWKS");

    let stripe_secret_key =
        std::env::var("STRIPE_SECRET_KEY").expect("STRIPE_SECRET_KEY must be set");
    let stripe_webhook_secret =
        std::env::var("STRIPE_WEBHOOK_SECRET").expect("STRIPE_WEBHOOK_SECRET must be set");
    let stripe_personal_price_id =
        std::env::var("STRIPE_PERSONAL_PRICE_ID").expect("STRIPE_PERSONAL_PRICE_ID must be set");
    let success_url = std::env::var("SUCCESS_URL")
        .unwrap_or_else(|_| "http://localhost:5173/dashboard?upgraded=1".into());
    let cancel_url =
        std::env::var("CANCEL_URL").unwrap_or_else(|_| "http://localhost:5173/dashboard".into());
    let resend_api_key = std::env::var("RESEND_API_KEY").ok();
    let from_email = std::env::var("FROM_EMAIL").unwrap_or_else(|_| "noreply@otpilot.app".into());
    let send_emails = std::env::var("SEND_EMAILS")
        .map(|v| v == "true" || v == "1")
        .unwrap_or(false);
    let supabase_service_key =
        std::env::var("SUPABASE_SERVICE_ROLE_KEY").expect("SUPABASE_SERVICE_ROLE_KEY must be set");

    let icons = routes::icons::IconStore::from_env();

    let state = AppState {
        db,
        jwt_keys: Arc::new(jwt_keys),
        stripe_secret_key,
        stripe_webhook_secret,
        stripe_personal_price_id,
        success_url,
        cancel_url,
        resend_api_key,
        from_email,
        send_emails,
        supabase_url,
        supabase_service_key,
        icons,
    };

    let cors = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE])
        .allow_headers(Any)
        .allow_origin(Any);

    let app = Router::new()
        .merge(routes::auth::router())
        .merge(routes::accounts::router())
        .merge(routes::teams::router())
        .merge(routes::billing::router())
        .merge(routes::devices::router())
        .merge(routes::icons::router())
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let port = std::env::var("PORT").unwrap_or_else(|_| "8082".to_string());
    let addr = format!("0.0.0.0:{port}");
    tracing::info!("listening on {addr}");

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
