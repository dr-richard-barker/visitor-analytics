-- Adds new-vs-returning visitor tracking. client_id is an opaque random
-- value the client stores in localStorage (the system's first persistent
-- identifier — everything else is either request-scoped or rotates daily).
-- It carries no other data and is used only to look up first_seen_ts here.
ALTER TABLE pageviews ADD COLUMN client_id TEXT;
CREATE INDEX IF NOT EXISTS idx_pageviews_client_id ON pageviews(client_id);

CREATE TABLE IF NOT EXISTS visitor_first_seen (
  client_id     TEXT PRIMARY KEY,
  first_seen_ts INTEGER NOT NULL
);
