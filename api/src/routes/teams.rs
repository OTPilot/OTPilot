use axum::{Router, routing::get, Json};
use serde_json::{json, Value};
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/teams", get(stub))
}

// Fase 3
async fn stub() -> Json<Value> {
    Json(json!({ "status": "coming in phase 3" }))
}
