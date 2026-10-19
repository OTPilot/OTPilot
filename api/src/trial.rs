//! Free trial of Personal: 30 days of sync, no card.
//!
//! While it runs the user's `plan` is `'personal'` with `has_personal_cloud =
//! false` and no `personal_subscription_id`, so everything that reads the plan
//! (sync gating, limits) treats them as Personal without knowing about trials.
//! `trial_ends_at` is never cleared: it also records that the trial was used
//! (one per account). Subscribing during the trial sets `has_personal_cloud`,
//! which ends the trial as far as this module is concerned (no expiry, no
//! emails); the checkout carries the remaining days over as a Stripe trial.
//!
//! `spawn` runs `tick` every hour: expire ended trials, then send the
//! reminder (`REMINDER_DAYS` before the end) and the "trial ended" email.
//! Each email is claimed by setting its column in the same UPDATE that picks
//! the users, so two API instances never send one twice; one the email queue
//! drops (full) is released for the next run. `sync-user` also
//! expires the caller's trial on the spot (`expire`), so a client sees Free
//! right at the end rather than up to an hour later.

use std::time::Duration;

use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{error::Result, AppState};

pub const TRIAL_DAYS: i32 = 30;
/// How many days before the end the reminder email goes out.
pub const REMINDER_DAYS: i32 = 3;
/// A trial that ended longer ago than this gets no "trial ended" email (the
/// user was on a team then, and has left it since).
const ENDED_EMAIL_DAYS: i32 = 7;
const TICK: Duration = Duration::from_secs(3600);

/// Starts the caller's trial when they can still have one (Free, never had
/// one, never entitled to Personal, not being deleted). Returns its end, or
/// None when nothing started.
pub async fn start(db: &PgPool, user: Uuid) -> Result<Option<DateTime<Utc>>> {
    Ok(sqlx::query_scalar(
        "UPDATE users SET plan = 'personal', trial_ends_at = NOW() + make_interval(days => $2)
         WHERE id = $1 AND plan = 'free' AND trial_ends_at IS NULL
           AND NOT has_personal_cloud AND deletion_started_at IS NULL
         RETURNING trial_ends_at",
    )
    .bind(user)
    .bind(TRIAL_DAYS)
    .fetch_optional(db)
    .await?)
}

/// Moves ended trials back to Free: one user's, or everyone's (`None`).
pub async fn expire(db: &PgPool, user: Option<Uuid>) -> Result<u64> {
    Ok(sqlx::query(
        "UPDATE users SET plan = 'free'
         WHERE plan = 'personal' AND NOT has_personal_cloud AND personal_subscription_id IS NULL
           AND trial_ends_at <= NOW() AND ($1::uuid IS NULL OR id = $1)",
    )
    .bind(user)
    .execute(db)
    .await?
    .rows_affected())
}

/// Starts the hourly job (first run right away).
pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        let mut every = tokio::time::interval(TICK);
        loop {
            every.tick().await;
            if let Err(e) = tick(&state).await {
                tracing::warn!("[trial] {e:?}");
            }
        }
    });
}

/// A user an email is due for, with what it says (counted in the claiming
/// UPDATE itself: no per-user query can fail after the claim).
#[derive(sqlx::FromRow)]
struct Due {
    id: Uuid,
    email: String,
    trial_ends_at: DateTime<Utc>,
    /// Synced items (reminder) / items the Free limit counts (ended). None
    /// when only a 1.x client synced (its `accounts` blob can't be counted).
    items: Option<i64>,
    devices: i64,
}

/// The item count of `Due`, NULL for a vault synced only through `/accounts`.
fn items_sql(filter: &str) -> String {
    format!(
        "CASE WHEN EXISTS (SELECT 1 FROM vault_items v WHERE v.owner_id = users.id)
                OR NOT EXISTS (SELECT 1 FROM accounts a WHERE a.user_id = users.id)
         THEN (SELECT COUNT(*) FROM vault_items v
               WHERE v.owner_id = users.id AND v.deleted_at IS NULL{filter}) END AS items"
    )
}

/// Un-claims emails the queue dropped, so the next run sends them.
async fn release(db: &PgPool, column: &str, ids: &[Uuid]) -> Result<()> {
    if !ids.is_empty() {
        tracing::warn!(
            "[trial] {} {column} email(s) dropped, retrying next run",
            ids.len()
        );
        sqlx::query(&format!(
            "UPDATE users SET {column} = NULL WHERE id = ANY($1)"
        ))
        .bind(ids)
        .execute(db)
        .await?;
    }
    Ok(())
}

/// One pass: expire, then the reminder and "ended" emails due now.
pub async fn tick(state: &AppState) -> Result<()> {
    let expired = expire(&state.db, None).await?;
    if expired > 0 {
        tracing::info!("[trial] {expired} trial(s) ended");
    }

    let reminders = sqlx::query_as::<_, Due>(&format!(
        "UPDATE users SET trial_reminder_sent_at = NOW()
         WHERE plan = 'personal' AND NOT has_personal_cloud
           AND trial_ends_at > NOW() AND trial_ends_at <= NOW() + make_interval(days => $1)
           AND trial_reminder_sent_at IS NULL AND email IS NOT NULL AND deletion_started_at IS NULL
         RETURNING id, email, trial_ends_at, {},
           (SELECT COUNT(*) FROM devices d WHERE d.user_id = users.id) AS devices",
        items_sql("")
    ))
    .bind(REMINDER_DAYS)
    .fetch_all(&state.db)
    .await?;
    let mut dropped = Vec::new();
    for due in reminders {
        let queued = crate::email::send_trial_reminder_email(
            state.send_emails,
            state.resend_api_key.as_deref(),
            &state.from_email,
            &due.email,
            due.trial_ends_at,
            due.items,
            due.devices,
        )
        .await;
        if !queued {
            dropped.push(due.id);
        }
    }
    release(&state.db, "trial_reminder_sent_at", &dropped).await?;

    let ended = sqlx::query_as::<_, Due>(&format!(
        "UPDATE users SET trial_ended_sent_at = NOW()
         WHERE plan = 'free' AND NOT has_personal_cloud
           AND trial_ends_at <= NOW() AND trial_ends_at > NOW() - make_interval(days => $1)
           AND trial_ended_sent_at IS NULL AND email IS NOT NULL AND deletion_started_at IS NULL
         RETURNING id, email, trial_ends_at, {}, 0::bigint AS devices",
        items_sql(" AND v.counts_for_limit")
    ))
    .bind(ENDED_EMAIL_DAYS)
    .fetch_all(&state.db)
    .await?;
    let mut dropped = Vec::new();
    for due in ended {
        let queued = crate::email::send_trial_ended_email(
            state.send_emails,
            state.resend_api_key.as_deref(),
            &state.from_email,
            &due.email,
            due.items,
        )
        .await;
        if !queued {
            dropped.push(due.id);
        }
    }
    release(&state.db, "trial_ended_sent_at", &dropped).await?;
    Ok(())
}

#[cfg(all(test, feature = "db-tests"))]
mod tests {
    use super::*;
    use crate::test_support::*;

    async fn row(db: &PgPool, user: Uuid) -> (String, Option<DateTime<Utc>>, bool, bool) {
        sqlx::query_as(
            "SELECT plan, trial_ends_at, trial_reminder_sent_at IS NOT NULL, trial_ended_sent_at IS NOT NULL
             FROM users WHERE id = $1",
        )
        .bind(user)
        .fetch_one(db)
        .await
        .unwrap()
    }

    async fn ends_in(db: &PgPool, user: Uuid, hours: i32) {
        sqlx::query("UPDATE users SET trial_ends_at = NOW() + make_interval(hours => $2), email = 'a@b.c' WHERE id = $1")
            .bind(user)
            .bind(hours)
            .execute(db)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn a_trial_starts_once() {
        let db = test_db().await;
        let user = create_user(&db.pool, "free").await;
        let end = start(&db.pool, user).await.unwrap().expect("started");
        let hours = (end - Utc::now()).num_hours();
        assert!((719..=720).contains(&hours), "{hours}");
        assert_eq!(row(&db.pool, user).await.0, "personal");

        // Over and back to Free: no second trial.
        ends_in(&db.pool, user, -1).await;
        assert_eq!(expire(&db.pool, Some(user)).await.unwrap(), 1);
        assert_eq!(row(&db.pool, user).await.0, "free");
        assert!(start(&db.pool, user).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn no_trial_for_paid_or_entitled_users() {
        let db = test_db().await;
        let team = create_user(&db.pool, "team_lite").await;
        assert!(start(&db.pool, team).await.unwrap().is_none());
        // Grandfathered 1.x Personal (or one whose team ended).
        let entitled = create_user(&db.pool, "free").await;
        sqlx::query("UPDATE users SET has_personal_cloud = true WHERE id = $1")
            .bind(entitled)
            .execute(&db.pool)
            .await
            .unwrap();
        assert!(start(&db.pool, entitled).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn expiry_leaves_subscribers_alone() {
        let db = test_db().await;
        let user = create_user(&db.pool, "free").await;
        start(&db.pool, user).await.unwrap();
        // Subscribed during the trial.
        sqlx::query("UPDATE users SET has_personal_cloud = true, personal_subscription_id = 'sub_1' WHERE id = $1")
            .bind(user)
            .execute(&db.pool)
            .await
            .unwrap();
        ends_in(&db.pool, user, -1).await;
        assert_eq!(expire(&db.pool, None).await.unwrap(), 0);
        assert_eq!(row(&db.pool, user).await.0, "personal");
    }

    #[tokio::test]
    async fn the_job_reminds_then_ends_once_each() {
        let db = test_db().await;
        let state = test_state(db.pool.clone());
        let user = create_user(&db.pool, "free").await;
        start(&db.pool, user).await.unwrap();

        // Far from the end: nothing.
        ends_in(&db.pool, user, 24 * 10).await;
        tick(&state).await.unwrap();
        assert!(!row(&db.pool, user).await.2);

        // Within the reminder window: claimed once.
        ends_in(&db.pool, user, 24 * REMINDER_DAYS - 1).await;
        tick(&state).await.unwrap();
        let r = row(&db.pool, user).await;
        assert_eq!((r.0.as_str(), r.2, r.3), ("personal", true, false));

        // Over: back to Free, "ended" claimed once.
        ends_in(&db.pool, user, -1).await;
        tick(&state).await.unwrap();
        let r = row(&db.pool, user).await;
        assert_eq!((r.0.as_str(), r.3), ("free", true));
        // Expiring again is a no-op.
        assert_eq!(expire(&db.pool, None).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn a_trial_that_ended_on_a_team_gets_no_email() {
        let db = test_db().await;
        let state = test_state(db.pool.clone());
        let user = create_user(&db.pool, "free").await;
        start(&db.pool, user).await.unwrap();
        sqlx::query("UPDATE users SET plan = 'team_lite' WHERE id = $1")
            .bind(user)
            .execute(&db.pool)
            .await
            .unwrap();
        ends_in(&db.pool, user, -1).await;
        tick(&state).await.unwrap();
        let r = row(&db.pool, user).await;
        assert_eq!((r.0.as_str(), r.3), ("team_lite", false));
    }
}
