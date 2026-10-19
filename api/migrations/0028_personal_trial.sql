-- Free trial of Personal (30 days, no card). While it runs the user's plan is
-- 'personal' with has_personal_cloud = false and no personal_subscription_id;
-- trial_ends_at is never cleared, so it also means "the trial was used".
-- The reminder / ended emails are claimed by setting their column first.
ALTER TABLE users
    ADD COLUMN trial_ends_at TIMESTAMPTZ,
    ADD COLUMN trial_reminder_sent_at TIMESTAMPTZ,
    ADD COLUMN trial_ended_sent_at TIMESTAMPTZ;

CREATE INDEX users_trial_ends_at ON users (trial_ends_at)
    WHERE trial_ends_at IS NOT NULL AND trial_ended_sent_at IS NULL;
