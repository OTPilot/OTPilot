use axum::{
    extract::FromRequestParts,
    http::{request::Parts, HeaderMap},
};
use jsonwebtoken::{decode, decode_header, Algorithm, Validation};
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

        // Pin the allowed algorithms to the asymmetric ones Supabase signs with.
        // The header's `alg` is attacker-controlled, so reject anything else up
        // front — in particular any symmetric (HS*) algorithm, which would enable
        // an alg-substitution attack (sign with the public key as an HMAC secret).
        // This guard is the pinning: `Validation::new(header.alg)` below then only
        // accepts that exact (now-constrained) algorithm. We deliberately don't set
        // `validation.algorithms` to the full list — jsonwebtoken rejects a list
        // that mixes key families (RSA vs EC) against an EC key with InvalidAlgorithm.
        const ALLOWED_ALGS: [Algorithm; 2] = [Algorithm::ES256, Algorithm::RS256];
        if !ALLOWED_ALGS.contains(&header.alg) {
            tracing::warn!("JWT alg {:?} not allowed", header.alg);
            return Err(ApiError::Unauthorized);
        }

        let kid = header.kid.as_deref().unwrap_or("");
        let key = state.jwt_keys.get(kid).ok_or_else(|| {
            tracing::warn!("JWT kid={kid} not found in key set");
            ApiError::Unauthorized
        })?;

        let mut validation = Validation::new(header.alg);
        validation.set_audience(&["authenticated"]);
        // Supabase sets `iss` to `<SUPABASE_URL>/auth/v1` (confirmed against a live
        // token); pin it so a token from any other issuer is rejected.
        validation.set_issuer(&[format!(
            "{}/auth/v1",
            state.supabase_url.trim_end_matches('/')
        )]);

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
