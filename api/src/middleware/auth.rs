use axum::{
    extract::FromRequestParts,
    http::{request::Parts, HeaderMap},
};
use jsonwebtoken::{decode, decode_header, Validation};
use serde::Deserialize;
use uuid::Uuid;

use crate::{error::ApiError, AppState};

#[derive(Debug, Deserialize)]
struct Claims {
    sub: String,
    email: Option<String>,
    #[allow(dead_code)]
    exp: usize,
}

#[derive(Debug, Clone)]
pub struct AuthUser {
    pub id: Uuid,
    pub email: Option<String>,
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let token = extract_bearer(&parts.headers).ok_or(ApiError::Unauthorized)?;

        // Decode header first to get kid + alg without verifying signature yet.
        let header = decode_header(token).map_err(|e| {
            tracing::warn!("JWT decode_header failed: {e}");
            ApiError::Unauthorized
        })?;

        let kid = header.kid.as_deref().unwrap_or("");
        let key = state.jwt_keys.get(kid).ok_or_else(|| {
            tracing::warn!("JWT kid={kid} not found in key set");
            ApiError::Unauthorized
        })?;

        let mut validation = Validation::new(header.alg);
        validation.set_audience(&["authenticated"]);

        let data = decode::<Claims>(token, key, &validation).map_err(|e| {
            tracing::warn!("JWT validation failed: {e}");
            ApiError::Unauthorized
        })?;

        let id = Uuid::parse_str(&data.claims.sub).map_err(|_| ApiError::Unauthorized)?;
        Ok(AuthUser {
            id,
            email: data.claims.email,
        })
    }
}

fn extract_bearer(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get("Authorization")?.to_str().ok()?;
    value.strip_prefix("Bearer ")
}
