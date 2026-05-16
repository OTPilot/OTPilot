use axum::{extract::State, routing::post, Json, Router};
use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::{error::Result, middleware::auth::AuthUser, AppState};

pub fn router() -> Router<AppState> {
    Router::new().route("/auth/sync-user", post(sync_user))
}

#[derive(Serialize, Deserialize, sqlx::FromRow)]
struct UserRow {
    id: uuid::Uuid,
    plan: String,
    created_at: chrono::DateTime<Utc>,
}

/// Called by the extension after login to ensure a `users` row exists.
async fn sync_user(State(state): State<AppState>, auth: AuthUser) -> Result<Json<UserRow>> {
    sqlx::query(
        r#"
        INSERT INTO users (id, plan, created_at)
        VALUES ($1, 'free', $2)
        ON CONFLICT (id) DO NOTHING
        "#,
    )
    .bind(auth.id)
    .bind(Utc::now())
    .execute(&state.db)
    .await?;

    let user = sqlx::query_as::<_, UserRow>("SELECT id, plan, created_at FROM users WHERE id = $1")
        .bind(auth.id)
        .fetch_one(&state.db)
        .await?;

    Ok(Json(user))
}
