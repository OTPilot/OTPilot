-- Persist the user's email (previously only read from the Supabase JWT) so team
-- features can show member / sharer / actor emails. Populated on each sync-user;
-- existing rows fill in on the user's next sync.
ALTER TABLE users ADD COLUMN email TEXT;
