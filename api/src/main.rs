mod db;
mod error;
mod middleware;
mod routes;

use std::collections::HashMap;
use std::sync::Arc;
use axum::{Router, http::Method};
use tower_http::cors::{CorsLayer, Any};
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
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();

    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| "api=debug,tower_http=debug".into()))
        .with(tracing_subscriber::fmt::layer())
        .init();

    let db = db::connect().await?;
    sqlx::migrate!("./migrations").run(&db).await?;

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

    let stripe_secret_key        = std::env::var("STRIPE_SECRET_KEY").expect("STRIPE_SECRET_KEY must be set");
    let stripe_webhook_secret    = std::env::var("STRIPE_WEBHOOK_SECRET").expect("STRIPE_WEBHOOK_SECRET must be set");
    let stripe_personal_price_id = std::env::var("STRIPE_PERSONAL_PRICE_ID").expect("STRIPE_PERSONAL_PRICE_ID must be set");
    let success_url              = std::env::var("SUCCESS_URL").unwrap_or_else(|_| "http://localhost:5173/dashboard?upgraded=1".into());
    let cancel_url               = std::env::var("CANCEL_URL").unwrap_or_else(|_| "http://localhost:5173/dashboard".into());

    let state = AppState {
        db,
        jwt_keys: Arc::new(jwt_keys),
        stripe_secret_key,
        stripe_webhook_secret,
        stripe_personal_price_id,
        success_url,
        cancel_url,
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
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let port = std::env::var("PORT").unwrap_or_else(|_| "8080".to_string());
    let addr = format!("0.0.0.0:{port}");
    tracing::info!("listening on {addr}");

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
