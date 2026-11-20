-- A week after a Personal trial ends without a subscription, one email offers
-- 50% off the first year of the annual plan (a Stripe coupon applied by
-- POST /billing/checkout, never a code the user types). Claimed by setting
-- trial_offer_sent_at first, like the other trial emails; the offer is open
-- for trial::OFFER_OPEN_DAYS after it.
--
-- subscribed_at: when the user first paid (a Personal subscription, a team,
-- or a 1.x purchase). Never cleared, so a subscription cancelled during the
-- offer doesn't reopen it, and a former customer never gets it.
ALTER TABLE users
    ADD COLUMN trial_offer_sent_at TIMESTAMPTZ,
    ADD COLUMN subscribed_at TIMESTAMPTZ;

UPDATE users SET subscribed_at = NOW()
WHERE has_personal_cloud OR personal_subscription_id IS NOT NULL
   OR stripe_customer_id IS NOT NULL
   OR id IN (SELECT owner_id FROM teams);
