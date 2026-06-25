-- Personal Cloud and Team are independent plans. has_personal_cloud survives a
-- team downgrade so a user who paid for Personal keeps sync after leaving a team.
ALTER TABLE users ADD COLUMN has_personal_cloud BOOLEAN NOT NULL DEFAULT false;

-- Backfill: anyone currently on the personal plan paid for Personal Cloud.
UPDATE users SET has_personal_cloud = true WHERE plan = 'personal';
