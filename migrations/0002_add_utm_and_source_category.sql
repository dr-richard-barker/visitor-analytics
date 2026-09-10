-- Adds traffic-source detail: UTM params (for tagged campaign links) and a
-- server-computed source_category (Direct/Search/Social/Internal/Referral/Other).
-- One-time migration for a database created before this existed; schema.sql
-- already includes these columns for fresh installs.
ALTER TABLE pageviews ADD COLUMN utm_source TEXT;
ALTER TABLE pageviews ADD COLUMN utm_medium TEXT;
ALTER TABLE pageviews ADD COLUMN utm_campaign TEXT;
ALTER TABLE pageviews ADD COLUMN source_category TEXT;
CREATE INDEX IF NOT EXISTS idx_pageviews_source_category ON pageviews(source_category, ts);
