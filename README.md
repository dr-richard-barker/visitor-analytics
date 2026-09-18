# visitor-analytics

A self-hosted, privacy-respecting pageview tracker for the GitHub Pages sites
under `dr-richard-barker.github.io`. One Cloudflare Worker serves the tracking
snippet, ingests pageviews into a Cloudflare D1 (SQLite) database, and serves a
password-gated dashboard. No third party ever sees the traffic data.

Because all the sites live under one domain as path-based project pages
(`dr-richard-barker.github.io/<repo>/...`), a single Worker + database covers
the whole portfolio. The tracking snippet reads the first path segment as the
site name automatically, so the same one-line `<script>` tag works on every
site with no per-site configuration.

## Privacy design

- No cookies. No raw IP address is ever written to the database.
  `visitor_hash` is `sha256(ip + user-agent + calendar-day + secret salt)`,
  computed on the edge and immediately discarded after hashing. The salt
  (and therefore the hash) is scoped to a single calendar day, so it cannot
  be used to follow the same person across days.
- The one deliberate exception to "no persistent identifier" is `client_id`:
  an opaque random value in `localStorage`, used *only* to look up
  `first_seen_ts` in `visitor_first_seen` and classify a visit as New or
  Returning for the selected date range. It carries no other data, is never
  shown or exported on its own, and — like everything else here — clearing
  site data, a different browser/device, or private browsing all just look
  like a new visitor again.
- Country/city/region come from Cloudflare's own edge geolocation
  (`request.cf`) — no IP geolocation database, no stored IP, and never
  precise coordinates (no lat/long is ever requested or stored).
- The "Networks" panel (`asn_org`, e.g. "Comcast Cable" or "Stanford
  University") is the network operator serving the request — Cloudflare's own
  `request.cf.asOrganization` — not a person. Thousands of people can share
  one network; this never identifies an individual.
- `session_id` lives in `sessionStorage`, not a cookie: it's per-tab, cleared
  the moment the tab closes, and never transmitted automatically the way a
  cookie would be. Because every tracked site shares one origin
  (`dr-richard-barker.github.io`), the same session id naturally follows a
  visitor who browses between different projects in one sitting — that's
  what makes "pages per session" and "bounce rate" meaningful — but it never
  persists beyond that browser tab.
- `pageview_id` is a random, single-use value generated per page load, sent
  once with the initial beacon and again with each engaged-time heartbeat so
  the server can add time to the right row. It isn't reused across page
  loads and isn't a visitor identifier.
- "Time on page" comes from a heartbeat sent every 15s **only while the tab
  is visible** (`document.visibilityState`), capped at 1 hour — an estimate
  of engaged time, not a precise stopwatch, and it simply stops if the tab is
  backgrounded or closed.
- The client snippet checks `navigator.doNotTrack` and does nothing if it's set.
- Obvious bots/crawlers/link-preview fetchers are filtered server-side by
  User-Agent before any row is written.
- All visitor-supplied fields (`site`, `path`, referrer, language, UTM
  params) are rendered in the dashboard via `textContent`, never
  `innerHTML` — the `/collect` endpoint is public and unauthenticated by
  necessity, so its input is treated as untrusted throughout. Fields Cloudflare
  computes itself (country/city/region/network) aren't attacker-controlled
  the way body fields are, but are rendered the same safe way regardless.

## What's in this repo

- `src/worker.js` — the entire system: `/collect` (ingest), `/a.js` (client
  snippet, served with the correct absolute URL for wherever it's deployed),
  `/api/stats` (aggregated JSON, Basic-Auth gated), `/` (dashboard, same auth).
- `src/world_map_data.js` — static SVG path data for the country choropleth,
  generated once at dev time (not fetched at runtime — the dashboard stays
  fully self-contained). Country outlines from
  [`world-atlas`](https://github.com/topojson/world-atlas) (ISC license,
  Natural Earth data at 110m resolution, itself public domain), reprojected
  equirectangular into a 960×480 viewBox; alpha-2 codes/names from
  [`iso-3166-1`](https://www.npmjs.com/package/iso-3166-1) (MIT). No new
  visitor data was needed for this — it's keyed on the same `country` code
  Cloudflare already provides. 3 disputed territories without an official
  ISO 3166-1 numeric code (Kosovo, Somaliland, N. Cyprus) aren't shaded on
  the map, though they'd still count in the Countries table if Cloudflare
  ever reports them. Regenerating it means re-running the conversion script
  (topojson → equirectangular projection → SVG path per country, joined to
  alpha-2 by numeric code) — not something to hand-edit.
- `schema.sql` — the one `pageviews` table (current shape, for fresh installs).
- `migrations/` — one-time `ALTER TABLE` scripts for a database that
  predates a given feature; `schema.sql` already includes everything for a
  new install, so these only matter for the existing production database.
- `wrangler.toml` — Worker + D1 binding config. `ALLOWED_ORIGIN` is set to
  `https://dr-richard-barker.github.io`; change it if you ever host a site
  elsewhere.

Tested locally end-to-end via `wrangler dev` with local D1 emulation: bot
filtering, UA parsing, aggregation, dashboard rendering, XSS-safety of the
dashboard against a hostile `/collect` payload (including through the UTM
and campaign fields), the traffic-source categorizer, and — using a real
served test page, not just simulated requests — the actual client script's
`sessionStorage` session id, `crypto.randomUUID()` pageview id, and the
visibility-gated heartbeat (confirmed it stays silent while the tab is
hidden and correctly accumulates `duration_sec` while visible).

## Local development

```bash
npm install
npm run db:migrate:local   # applies schema.sql to a local, emulated D1 db
npm run dev                # wrangler dev on http://localhost:8787
```

`.dev.vars` (already present, gitignored) supplies a local
`DASHBOARD_PASSWORD` and `HASH_SALT` for dev only — they are never deployed.

## Deploying to your Cloudflare account

These steps need your own Cloudflare login, so run them yourself:

```bash
npx wrangler login                        # opens a browser to authenticate
npx wrangler d1 create visitor_analytics  # prints a database_id
```

Paste the printed `database_id` into `wrangler.toml` (replacing the
`00000000-...` placeholder), then:

```bash
npm run db:migrate:remote                 # applies schema.sql to the real D1 db
npx wrangler secret put DASHBOARD_PASSWORD
npx wrangler secret put HASH_SALT         # any random string, never shown anywhere
npm run deploy
```

On a database created before UTM/source-category or geo/duration/session
tracking existed, also run the relevant one-time migration(s) from
`migrations/` (e.g. `npm run db:migrate:remote:utm`,
`npm run db:migrate:remote:geo`) — a fresh install via `schema.sql` doesn't
need these.

`wrangler deploy` prints your live Worker URL
(`https://visitor-analytics.<your-subdomain>.workers.dev`). That's your
dashboard URL (prompts for the password you set above) and the base for the
tracking snippet.

## Adding tracking to a site

Add this once, near the end of `<body>`, on every page you want tracked:

```html
<script defer src="https://visitor-analytics.<your-subdomain>.workers.dev/a.js"></script>
```

No per-site parameters needed — the site slug is derived from the URL path
automatically.

## Viewing stats

Visit the Worker URL in a browser, enter the dashboard password when
prompted. Filter by site or date range (7/30/90 days). The dashboard shows:

- **Headline cards**: pageviews, unique visitors, avg. views/day, avg. time
  on page, pages/session, bounce rate, returning rate.
- **Visitors by country**: a world choropleth, log-scaled (a handful of
  countries dominating shouldn't wash out everywhere else) — self-contained
  SVG, no map tiles fetched from anywhere.
- **Traffic sources** and **New vs. returning**: each a compact stacked bar.
  Traffic sources is Direct/Search/Social/Referral/Internal/Other,
  server-computed from the referrer and, if present, UTM medium — see
  Privacy design for why it's bounded to exactly these 6.
- **Campaigns**: only appears if you've used `?utm_source=`/`utm_medium=`/
  `utm_campaign=` tagged links.
- **Pageviews per day** and **pageviews by hour of day** (UTC — visitors
  span every timezone, so UTC is the only globally-consistent choice; there
  isn't a single "local time" that would be correct for a global audience).
- Breakdowns by top sites, top pages, referring sites, country, city,
  network/organization, language, device, browser, and OS.

"Who" and "where" are answered at the level real privacy-respecting
analytics tools use — country/city/network, never an individual. There's
intentionally no way to see a specific person's visits.
