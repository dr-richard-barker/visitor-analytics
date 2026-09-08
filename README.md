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

- No cookies, no `localStorage`, no persistent client-side identifier.
- No raw IP address is ever written to the database. `visitor_hash` is
  `sha256(ip + user-agent + calendar-day + secret salt)`, computed on the
  edge and immediately discarded after hashing. The salt (and therefore the
  hash) is scoped to a single calendar day, so it cannot be used to follow
  the same person across days or correlate them with anything else.
- Country comes from Cloudflare's own edge geolocation
  (`request.cf.country`) — no IP geolocation database, no stored IP.
- The client snippet checks `navigator.doNotTrack` and does nothing if it's set.
- Obvious bots/crawlers/link-preview fetchers are filtered server-side by
  User-Agent before any row is written.
- All visitor-supplied fields (`site`, `path`, referrer, language) are
  rendered in the dashboard via `textContent`, never `innerHTML` — the
  `/collect` endpoint is public and unauthenticated by necessity, so its
  input is treated as untrusted throughout.

## What's in this repo

- `src/worker.js` — the entire system: `/collect` (ingest), `/a.js` (client
  snippet, served with the correct absolute URL for wherever it's deployed),
  `/api/stats` (aggregated JSON, Basic-Auth gated), `/` (dashboard, same auth).
- `schema.sql` — the one `pageviews` table.
- `wrangler.toml` — Worker + D1 binding config. `ALLOWED_ORIGIN` is set to
  `https://dr-richard-barker.github.io`; change it if you ever host a site
  elsewhere.

Tested locally end-to-end (bot filtering, UA parsing, aggregation, dashboard
rendering, and XSS-safety of the dashboard against a hostile `/collect`
payload) via `wrangler dev` with local D1 emulation — see git history / dev
notes for what was checked.

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
prompted. Filter by site or date range (7/30/90 days); see pageviews,
unique visitors, a daily chart, and breakdowns by page, referrer, country,
device, browser, and OS.
