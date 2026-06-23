-- Store the shared account's email so two accounts on the same site (e.g. two
-- Twitter logins) can be told apart in the team UI.
ALTER TABLE shared_codes ADD COLUMN account_email TEXT;
