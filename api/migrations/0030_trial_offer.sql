-- A week after a Personal trial ends without a subscription, one email offers
-- 50% off the first year of the annual plan (a Stripe coupon applied by
-- POST /billing/checkout, never a code the user types). Claimed by setting
-- this column first, like the other trial emails; the offer is open for
-- trial::OFFER_OPEN_DAYS after it.
ALTER TABLE users ADD COLUMN trial_offer_sent_at TIMESTAMPTZ;
