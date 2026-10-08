-- 2.0: Personal is a subscription ($3/mo or $30/yr) instead of a one-time
-- purchase. has_personal_cloud keeps meaning "entitled to Personal" (it is
-- what a team downgrade falls back to); this id ties it to the Stripe
-- subscription, so its cancellation can clear it. Grandfathered one-time
-- buyers have the flag without an id.
ALTER TABLE users ADD COLUMN personal_subscription_id TEXT;
CREATE UNIQUE INDEX users_personal_subscription_id ON users (personal_subscription_id)
  WHERE personal_subscription_id IS NOT NULL;

-- Subscriptions Stripe reported as ended. Webhooks can arrive out of order:
-- a checkout completing for a subscription already deleted must not grant
-- the plan.
CREATE TABLE stripe_ended_subscriptions (
  subscription_id TEXT PRIMARY KEY,
  ended_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
