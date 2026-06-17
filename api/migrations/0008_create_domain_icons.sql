CREATE TABLE domain_icons (
  domain       TEXT        PRIMARY KEY,
  status       TEXT        NOT NULL,          -- 'ok' | 'none'  (none = no icon found, negative cache)
  storage_key  TEXT,                          -- e.g. icons/github.com.png (null when status='none')
  content_type TEXT,                          -- image/png
  etag         TEXT,
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
