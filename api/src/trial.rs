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
//! reminder (`REMINDER_DAYS` before the end), the "trial ended" email and,
//! `OFFER_AFTER_DAYS` after the end, one offer of 50% off the first year
//! (only with `STRIPE_TRIAL_OFFER_COUPON_ID` set; `offer_open` says whether
//! the checkout applies it).
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
/// Days after the end of a trial the discount offer goes out.
pub const OFFER_AFTER_DAYS: i32 = 7;
/// A trial that ended longer ago than this gets no offer (sent late, or
/// the user was on a team then).
const OFFER_LATEST_DAYS: i32 = 14;
/// How long the offer stays open after its email.
pub const OFFER_OPEN_DAYS: i32 = 7;
const TICK: Duration = Duration::from_secs(3600);

/// Who the offer is still open to: its email went out less than
/// `OFFER_OPEN_DAYS` ago and they're Free and never paid (`subscribed_at`:
/// a subscription cancelled since doesn't reopen it). A SQL condition on
/// the `users` row named `t` (binds nothing).
pub fn offer_open_sql(t: &str) -> String {
    format!(
        "({t}.plan = 'free' AND NOT {t}.has_personal_cloud AND {t}.subscribed_at IS NULL
          AND {t}.trial_offer_sent_at > NOW() - make_interval(days => {OFFER_OPEN_DAYS}))"
    )
}

/// When the caller's offer closes, while it's open.
pub async fn offer_until(db: &PgPool, user: Uuid) -> Result<Option<DateTime<Utc>>> {
    Ok(sqlx::query_scalar(&format!(
        "SELECT users.trial_offer_sent_at + make_interval(days => {OFFER_OPEN_DAYS})
         FROM users WHERE id = $1 AND {}",
        offer_open_sql("users")
    ))
    .bind(user)
    .fetch_optional(db)
    .await?)
}

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
    /// Synced items (reminder only; NULL for the ended email). None when only
    /// a 1.x client synced (its `accounts` blob can't be counted).
    items: Option<i64>,
    devices: i64,
}

/// The item count of `Due`, NULL for a vault synced only through `/accounts`.
fn items_sql() -> String {
    "CASE WHEN EXISTS (SELECT 1 FROM vault_items v WHERE v.owner_id = users.id)
                OR NOT EXISTS (SELECT 1 FROM accounts a WHERE a.user_id = users.id)
         THEN (SELECT COUNT(*) FROM vault_items v
               WHERE v.owner_id = users.id AND v.deleted_at IS NULL) END AS items"
        .to_string()
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
        items_sql()
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

    let ended = sqlx::query_as::<_, Due>(
        "UPDATE users SET trial_ended_sent_at = NOW()
         WHERE plan = 'free' AND NOT has_personal_cloud
           AND trial_ends_at <= NOW() AND trial_ends_at > NOW() - make_interval(days => $1)
           AND trial_ended_sent_at IS NULL AND email IS NOT NULL AND deletion_started_at IS NULL
         RETURNING id, email, trial_ends_at, NULL::bigint AS items, 0::bigint AS devices",
    )
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
        )
        .await;
        if !queued {
            dropped.push(due.id);
        }
    }
    release(&state.db, "trial_ended_sent_at", &dropped).await?;

    // The offer: only when the checkout can apply it.
    if state.stripe_trial_offer_coupon_id.is_empty()
        || state.stripe_personal_annual_price_id.is_empty()
    {
        return Ok(());
    }
    let offers = sqlx::query_as::<_, (Uuid, String, DateTime<Utc>)>(
        "UPDATE users SET trial_offer_sent_at = NOW()
         WHERE plan = 'free' AND NOT has_personal_cloud AND subscribed_at IS NULL
           AND trial_ended_sent_at IS NOT NULL
           AND trial_ends_at <= NOW() - make_interval(days => $1)
           AND trial_ends_at > NOW() - make_interval(days => $2)
           AND trial_offer_sent_at IS NULL AND email IS NOT NULL AND deletion_started_at IS NULL
         RETURNING id, email, NOW() + make_interval(days => $3)",
    )
    .bind(OFFER_AFTER_DAYS)
    .bind(OFFER_LATEST_DAYS)
    .bind(OFFER_OPEN_DAYS)
    .fetch_all(&state.db)
    .await?;
    let mut dropped = Vec::new();
    for (id, email, until) in offers {
        let queued = crate::email::send_trial_offer_email(
            state.send_emails,
            state.resend_api_key.as_deref(),
            &state.from_email,
            &email,
            until,
        )
        .await;
        if !queued {
            dropped.push(id);
        }
    }
    release(&state.db, "trial_offer_sent_at", &dropped).await?;
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
    #[tokio::test]
    async fn a_dropped_email_is_released_for_the_next_run() {
        let db = test_db().await;
        let state = test_state(db.pool.clone());
        let user = create_user(&db.pool, "free").await;
        start(&db.pool, user).await.unwrap();
        ends_in(&db.pool, user, 24 * REMINDER_DAYS - 1).await;
        tick(&state).await.unwrap();
        assert!(row(&db.pool, user).await.2);

        release(&db.pool, "trial_reminder_sent_at", &[user])
            .await
            .unwrap();
        assert!(!row(&db.pool, user).await.2);
        // Claimed again on the next run.
        tick(&state).await.unwrap();
        assert!(row(&db.pool, user).await.2);
    }

    async fn offer_sent(db: &PgPool, user: Uuid) -> bool {
        sqlx::query_scalar("SELECT trial_offer_sent_at IS NOT NULL FROM users WHERE id = $1")
            .bind(user)
            .fetch_one(db)
            .await
            .unwrap()
    }

    fn offer_state(db: &PgPool) -> AppState {
        let mut state = test_state(db.clone());
        state.stripe_trial_offer_coupon_id = "trial-offer-50".into();
        state
    }

    /// A trial that ended `days` ago, its "ended" email sent.
    async fn ended_days_ago(db: &PgPool, days: i32) -> Uuid {
        let user = create_user(db, "free").await;
        sqlx::query(
            "UPDATE users SET email = 'a@b.c', trial_ends_at = NOW() - make_interval(days => $2),
                              trial_ended_sent_at = NOW() - make_interval(days => $2)
             WHERE id = $1",
        )
        .bind(user)
        .bind(days)
        .execute(db)
        .await
        .unwrap();
        user
    }

    #[tokio::test]
    async fn the_offer_goes_once_a_week_after_the_end() {
        let db = test_db().await;
        let state = offer_state(&db.pool);
        let user = ended_days_ago(&db.pool, OFFER_AFTER_DAYS - 1).await;
        tick(&state).await.unwrap();
        assert!(!offer_sent(&db.pool, user).await);
        assert!(offer_until(&db.pool, user).await.unwrap().is_none());

        sqlx::query(
            "UPDATE users SET trial_ends_at = NOW() - make_interval(days => $2) WHERE id = $1",
        )
        .bind(user)
        .bind(OFFER_AFTER_DAYS)
        .execute(&db.pool)
        .await
        .unwrap();
        tick(&state).await.unwrap();
        assert!(offer_sent(&db.pool, user).await);
        let until = offer_until(&db.pool, user).await.unwrap().expect("open");
        let hours = (until - Utc::now()).num_hours();
        assert!((24 * OFFER_OPEN_DAYS as i64 - 1..=24 * OFFER_OPEN_DAYS as i64).contains(&hours));

        // Closed once its week is over.
        sqlx::query("UPDATE users SET trial_offer_sent_at = NOW() - make_interval(days => $2) WHERE id = $1")
            .bind(user)
            .bind(OFFER_OPEN_DAYS)
            .execute(&db.pool)
            .await
            .unwrap();
        assert!(offer_until(&db.pool, user).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn no_offer_without_a_coupon_for_subscribers_or_old_trials() {
        let db = test_db().await;
        // No coupon configured: nothing is sent.
        let user = ended_days_ago(&db.pool, OFFER_AFTER_DAYS).await;
        tick(&test_state(db.pool.clone())).await.unwrap();
        assert!(!offer_sent(&db.pool, user).await);

        let state = offer_state(&db.pool);
        let old = ended_days_ago(&db.pool, OFFER_LATEST_DAYS + 1).await;
        let subscribed = ended_days_ago(&db.pool, OFFER_AFTER_DAYS).await;
        sqlx::query("UPDATE users SET plan = 'personal', has_personal_cloud = true WHERE id = $1")
            .bind(subscribed)
            .execute(&db.pool)
            .await
            .unwrap();
        // Paid once, cancelled since: Free again, but not offered.
        let former = ended_days_ago(&db.pool, OFFER_AFTER_DAYS).await;
        sqlx::query("UPDATE users SET subscribed_at = NOW() - interval '2 days' WHERE id = $1")
            .bind(former)
            .execute(&db.pool)
            .await
            .unwrap();
        let team = ended_days_ago(&db.pool, OFFER_AFTER_DAYS).await;
        sqlx::query("UPDATE users SET plan = 'team_lite' WHERE id = $1")
            .bind(team)
            .execute(&db.pool)
            .await
            .unwrap();
        tick(&state).await.unwrap();
        assert!(offer_sent(&db.pool, user).await);
        assert!(!offer_sent(&db.pool, old).await);
        assert!(!offer_sent(&db.pool, subscribed).await);
        assert!(!offer_sent(&db.pool, team).await);
        assert!(!offer_sent(&db.pool, former).await);

        // Subscribing closes an open offer.
        assert!(offer_until(&db.pool, user).await.unwrap().is_some());
        sqlx::query("UPDATE users SET plan = 'personal', has_personal_cloud = true WHERE id = $1")
            .bind(user)
            .execute(&db.pool)
            .await
            .unwrap();
        assert!(offer_until(&db.pool, user).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn a_vault_synced_only_by_1x_has_no_count() {
        let db = test_db().await;
        let user = create_user(&db.pool, "free").await;
        let count = |pool: PgPool| async move {
            sqlx::query_scalar::<_, Option<i64>>(&format!(
                "SELECT {} FROM users WHERE id = $1",
                items_sql()
            ))
            .bind(user)
            .fetch_one(&pool)
            .await
            .unwrap()
        };
        assert_eq!(count(db.pool.clone()).await, Some(0));
        sqlx::query("INSERT INTO accounts (user_id, encrypted_blob) VALUES ($1, 'x')")
            .bind(user)
            .execute(&db.pool)
            .await
            .unwrap();
        assert_eq!(count(db.pool.clone()).await, None);
    }
}
