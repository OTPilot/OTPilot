-- Team activity is read newest first, a page at a time (/teams/:id/audit?limit=&before=).
CREATE INDEX IF NOT EXISTS audit_logs_team_recent ON audit_logs (team_id, created_at DESC, id DESC);
