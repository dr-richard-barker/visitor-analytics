-- Visitor analytics: pageview log.
-- One row per pageview. No raw IPs, no cookies, no persistent visitor IDs.
CREATE TABLE IF NOT EXISTS pageviews (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,        -- unix ms, server time of receipt
  site          TEXT NOT NULL,           -- first path segment, e.g. "lunar-arcade"; "(root)" for the profile page
  path          TEXT NOT NULL,           -- full pathname
  title         TEXT,                    -- document.title, truncated
  referrer_host TEXT,                    -- hostname only of document.referrer, e.g. "www.google.com"; '' if none
  country       TEXT,                    -- 2-letter country from Cloudflare edge geolocation
  device        TEXT,                    -- 'mobile' | 'tablet' | 'desktop'
  browser       TEXT,                    -- coarse browser family
  os            TEXT,                    -- coarse OS family
  lang          TEXT,                    -- 2-letter primary language subtag
  visitor_hash  TEXT NOT NULL,           -- sha256(ip + UA + daily salt), truncated; rotates every day, never reversible to an IP
  utm_source    TEXT,                    -- ?utm_source= query param, if present
  utm_medium    TEXT,                    -- ?utm_medium= query param, if present
  utm_campaign  TEXT,                    -- ?utm_campaign= query param, if present
  source_category TEXT,                  -- computed server-side: Direct | Search | Social | Internal | Referral | Other
  city          TEXT,                    -- city from Cloudflare edge geolocation (coarse; no lat/long ever stored)
  region        TEXT,                    -- state/province from Cloudflare edge geolocation
  asn_org       TEXT,                    -- network operator name, e.g. "Comcast Cable", "Stanford University" — the network, not a person
  duration_sec  INTEGER NOT NULL DEFAULT 0, -- approximate active time on page, from visibility-gated heartbeats; capped server-side
  pageview_id   TEXT,                    -- random, single-use, generated client-side per page load; correlates heartbeats to this row only
  session_id    TEXT                     -- random, sessionStorage-scoped (cleared when the tab closes); groups pageviews within one visit
);

CREATE INDEX IF NOT EXISTS idx_pageviews_ts   ON pageviews(ts);
CREATE INDEX IF NOT EXISTS idx_pageviews_site ON pageviews(site, ts);
CREATE INDEX IF NOT EXISTS idx_pageviews_source_category ON pageviews(source_category, ts);
CREATE INDEX IF NOT EXISTS idx_pageviews_pageview_id ON pageviews(pageview_id);
CREATE INDEX IF NOT EXISTS idx_pageviews_session_id ON pageviews(session_id);
