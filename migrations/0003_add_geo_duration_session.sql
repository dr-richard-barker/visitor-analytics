-- Adds: finer geography (city/region), network operator ("who" — an ISP or
-- institution name, never a person), time-on-page (duration_sec, filled in by
-- client heartbeats), and session grouping (pageview_id, session_id) for
-- bounce rate / pages-per-session. One-time migration for a database created
-- before these existed; schema.sql already includes them for fresh installs.
ALTER TABLE pageviews ADD COLUMN city TEXT;
ALTER TABLE pageviews ADD COLUMN region TEXT;
ALTER TABLE pageviews ADD COLUMN asn_org TEXT;
ALTER TABLE pageviews ADD COLUMN duration_sec INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pageviews ADD COLUMN pageview_id TEXT;
ALTER TABLE pageviews ADD COLUMN session_id TEXT;
CREATE INDEX IF NOT EXISTS idx_pageviews_pageview_id ON pageviews(pageview_id);
CREATE INDEX IF NOT EXISTS idx_pageviews_session_id ON pageviews(session_id);
