-- The favicon fetcher now sends a browser User-Agent, follows a homepage's icon
-- to another host (a CDN) and falls back to a favicon service: ask again for
-- every domain it found no icon for.
DELETE FROM domain_icons WHERE status = 'none';
