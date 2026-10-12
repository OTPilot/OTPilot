//! The anonymous "why did you uninstall?" form (the web's /goodbye page,
//! opened by Chrome after the extension is removed). Public: there's no
//! account to sign in with anymore. Answers carry nothing that identifies
//! the user; they're read from the `uninstall_feedback` table.

use std::time::Duration;

use axum::{extract::State, http::HeaderMap, routing::post, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    error::{ApiError, Result},
    AppState,
};

pub const REASONS: &[&str] = &[
    "missed_fill",
    "missing_feature",
    "other_manager",
    "privacy",
    "too_complex",
    "broken",
    "just_trying",
    "other",
];
const PLANS: &[&str] = &["free", "personal", "team_lite", "team_pro"];
const MAX_SITE: usize = 200;
const MAX_COMMENT: usize = 2000;

pub fn router() -> Router<AppState> {
    Router::new().route("/feedback/uninstall", post(uninstall))
}

#[derive(Deserialize)]
struct UninstallRequest {
    reason: String,
    #[serde(default)]
    site: Option<String>,
    #[serde(default)]
    comment: Option<String>,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    days_installed: Option<i32>,
    #[serde(default)]
    plan: Option<String>,
}

/// Trimmed, empty → None, capped at `max` characters.
fn text(v: Option<String>, max: usize) -> Option<String> {
    let t = v?.trim().to_string();
    (!t.is_empty()).then(|| t.chars().take(max).collect())
}

async fn uninstall(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<UninstallRequest>,
) -> Result<Json<Value>> {
    // Per sender (as the proxy reports it) and overall: a public endpoint.
    let sender = headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(str::trim)
        .unwrap_or("unknown");
    let hour = Duration::from_secs(3600);
    if !state
        .rate_limiter
        .check(&format!("uninstall:{sender}"), 5, hour)
        || !state.rate_limiter.check("uninstall:all", 500, hour)
    {
        return Err(ApiError::TooManyRequests);
    }
    if !REASONS.contains(&body.reason.as_str()) {
        return Err(ApiError::BadRequest("unknown reason".into()));
    }
    let version =
        text(body.version, 20).filter(|v| v.chars().all(|c| c.is_ascii_digit() || c == '.'));
    let plan = text(body.plan, 20).filter(|p| PLANS.contains(&p.as_str()));
    let days = body.days_installed.filter(|d| (0..=36500).contains(d));
    sqlx::query(
        "INSERT INTO uninstall_feedback (reason, site, comment, version, days_installed, plan)
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(&body.reason)
    .bind(text(body.site, MAX_SITE))
    .bind(text(body.comment, MAX_COMMENT))
    .bind(version)
    .bind(days)
    .bind(plan)
    .execute(&state.db)
    .await?;
    Ok(Json(json!({ "ok": true })))
}

#[cfg(all(test, feature = "db-tests"))]
mod db_tests {
    use super::*;
    use crate::test_support::{test_db, test_state};
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;

    async fn post(app: &Router, ip: &str, body: Value) -> StatusCode {
        app.clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/feedback/uninstall")
                    .header("content-type", "application/json")
                    .header("x-forwarded-for", ip)
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap()
            .status()
    }

    #[tokio::test]
    async fn an_answer_is_stored_without_anything_that_identifies_the_user() {
        let db = test_db().await;
        let app = router().with_state(test_state(db.pool.clone()));
        let long = "x".repeat(5000);
        let s = post(
            &app,
            "1.2.3.4",
            json!({
                "reason": "missed_fill", "site": "  xstation5.xtb.com ", "comment": long,
                "version": "2.0.3", "days_installed": 12, "plan": "free",
            }),
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        type Row = (
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<i32>,
            Option<String>,
        );
        let row: Row = sqlx::query_as(
            "SELECT reason, site, comment, version, days_installed, plan FROM uninstall_feedback",
        )
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert_eq!(row.0, "missed_fill");
        assert_eq!(row.1.as_deref(), Some("xstation5.xtb.com"));
        assert_eq!(row.2.unwrap().len(), MAX_COMMENT);
        assert_eq!(row.3.as_deref(), Some("2.0.3"));
        assert_eq!(row.4, Some(12));
        assert_eq!(row.5.as_deref(), Some("free"));

        // Junk is dropped, not stored; an unknown reason is refused.
        let s = post(
            &app,
            "1.2.3.5",
            json!({ "reason": "other", "version": "<b>", "plan": "root", "days_installed": -3 }),
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        let junk: (Option<String>, Option<String>, Option<i32>) = sqlx::query_as(
            "SELECT version, plan, days_installed FROM uninstall_feedback WHERE reason = 'other'",
        )
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert_eq!(junk, (None, None, None));
        assert_eq!(
            post(&app, "1.2.3.6", json!({ "reason": "hack" })).await,
            StatusCode::BAD_REQUEST
        );
    }

    #[tokio::test]
    async fn one_sender_is_rate_limited() {
        let db = test_db().await;
        let app = router().with_state(test_state(db.pool.clone()));
        for _ in 0..5 {
            assert_eq!(
                post(&app, "9.9.9.9", json!({ "reason": "other" })).await,
                StatusCode::OK
            );
        }
        assert_eq!(
            post(&app, "9.9.9.9", json!({ "reason": "other" })).await,
            StatusCode::TOO_MANY_REQUESTS
        );
        assert_eq!(
            post(&app, "8.8.8.8", json!({ "reason": "other" })).await,
            StatusCode::OK
        );
    }
}
