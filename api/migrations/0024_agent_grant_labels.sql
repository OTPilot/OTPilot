-- 2.1 AI agents: each grant also carries a label — the item's title and sites,
-- encrypted under the same key as the copy (wrapped_key) — so an agent can
-- name an "ask every time" account it can't open yet, and ask for it.
ALTER TABLE agent_grants ADD COLUMN label TEXT NOT NULL DEFAULT '';
