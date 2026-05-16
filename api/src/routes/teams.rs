use crate::AppState;
use axum::{routing::get, Json, Router};
use serde_json::{json, Value};

pub fn router() -> Router<AppState> {
    Router::new().route("/teams", get(stub))
}

// Fase 3
async fn stub() -> Json<Value> {
    Json(json!({ "status": "coming in phase 3" }))
}
