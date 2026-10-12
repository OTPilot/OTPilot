//! Authentication of OTPilot MCP servers (AI agents): an opaque bearer token
//! (`otpa_…`) handed out once, when the agent's pairing is approved; only its
//! SHA-256 is stored. A revoked agent is deleted, so its token stops working.

use axum::{extract::FromRequestParts, http::request::Parts};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{error::ApiError, AppState};

pub const TOKEN_PREFIX: &str = "otpa_";

#[derive(Debug, Clone)]
pub struct AgentAuth {
    pub agent_id: Uuid,
}

/// Hex SHA-256, how pair secrets and tokens are stored.
pub fn hash_secret(secret: &str) -> String {
    Sha256::digest(secret.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// A random secret with `prefix`: two v4 UUIDs (244 random bits).
pub fn new_secret(prefix: &str) -> String {
    format!(
        "{prefix}{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    )
}

impl FromRequestParts<AppState> for AgentAuth {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let token = parts
            .headers
            .get("Authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .filter(|t| t.starts_with(TOKEN_PREFIX))
            .ok_or(ApiError::Unauthorized)?;
        let agent_id: Option<Uuid> =
            sqlx::query_scalar("SELECT id FROM agents WHERE token_hash = $1 AND status = 'active'")
                .bind(hash_secret(token))
                .fetch_optional(&state.db)
                .await?;
        let agent_id = agent_id.ok_or(ApiError::Unauthorized)?;
        Ok(AgentAuth { agent_id })
    }
}
