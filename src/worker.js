// Visitor analytics collector + dashboard for GitHub Pages sites.
// Single Worker, three routes:
//   GET  /a.js        -> client tracking snippet (public)
//   POST /collect      -> ingest one pageview beacon (public)
//   GET  /api/stats    -> aggregated JSON, Basic-Auth gated
//   GET  /, /dashboard -> dashboard UI, Basic-Auth gated
//
// Privacy: no cookies, no raw IP stored. "Unique visitors" is approximated
// with a salted hash of (IP + UA + calendar day), computed on the edge and
// discarded immediately after hashing; the salt rotates daily so the hash
// cannot be used to follow anyone across days. The one deliberate exception
// is `client_id` (localStorage, opaque random value) used only to classify
// new vs. returning visitors — see clientSnippet() and visitor_first_seen.

import { WORLD_PATHS, COUNTRY_NAMES } from './world_map_data.js';

function parseUA(ua) {
  ua = ua || '';
  let device = 'desktop';
  if (/iPad|Tablet(?!.*Mobile)|Nexus 7|Nexus 10|KFAPWI/i.test(ua)) device = 'tablet';
  else if (/Mobi|iPhone|iPod|Android.*Mobile|Windows Phone|BlackBerry/i.test(ua)) device = 'mobile';

  let browser = 'Other';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(ua)) browser = 'Opera';
  else if (/SamsungBrowser/.test(ua)) browser = 'Samsung Internet';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/CriOS/.test(ua)) browser = 'Chrome';
  else if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) browser = 'Chrome';
  else if (/Chromium/.test(ua)) browser = 'Chromium';
  else if (/Safari\//.test(ua) && /Version\//.test(ua)) browser = 'Safari';
  else if (/MSIE|Trident/.test(ua)) browser = 'Internet Explorer';

  let os = 'Other';
  if (/Windows/.test(ua)) os = 'Windows';
  else if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
  else if (/Mac OS X/.test(ua)) os = 'macOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/CrOS/.test(ua)) os = 'ChromeOS';
  else if (/Linux/.test(ua)) os = 'Linux';

  return { device, browser, os };
}

function isBot(ua) {
  return /bot|crawl|spider|slurp|preview|monitor|facebookexternalhit|slackbot|twitterbot|discordbot|whatsapp|telegrambot|applebot|googlebot|bingbot|duckduckbot|baiduspider|yandexbot|ia_archiver|headless/i.test(
    ua || ''
  );
}

// Bounded to exactly these 6 values — /collect is public and unauthenticated,
// so this must never grow from raw attacker input (that's how a chart's color
// legend blows past 8 series). utm_medium can steer classification even when
// referrer_host is empty or ambiguous, but only into one of the 6 buckets.
function categorizeSource(referrerHost, utmMedium) {
  const um = (utmMedium || '').toLowerCase();
  if (um === 'social') return 'Social';
  if (um === 'search' || um === 'cpc' || um === 'ppc') return 'Search';
  if (!referrerHost) return 'Direct';
  const h = referrerHost.toLowerCase();
  if (h === 'dr-richard-barker.github.io') return 'Internal';
  if (/(^|\.)scholar\.google\.\w+$|(^|\.)researchgate\.net$|(^|\.)orcid\.org$|(^|\.)doi\.org$|(^|\.)pubmed\.ncbi\.nlm\.nih\.gov$|(^|\.)biorxiv\.org$/.test(h))
    return 'Scholarly';
  if (/(^|\.)google\.\w+$|(^|\.)bing\.com$|(^|\.)duckduckgo\.com$|(^|\.)search\.yahoo\.com$|(^|\.)baidu\.com$|(^|\.)yandex\.\w+$|(^|\.)ecosia\.org$/.test(h))
    return 'Search';
  if (/(^|\.)(x|twitter)\.com$|(^|\.)t\.co$|(^|\.)facebook\.com$|(^|\.)linkedin\.com$|(^|\.)reddit\.com$|(^|\.)mastodon\.\w+$|(^|\.)bsky\.app$|(^|\.)threads\.net$|(^|\.)news\.ycombinator\.com$|(^|\.)lobste\.rs$/.test(h))
    return 'Social';
  return 'Referral';
}

async function hashVisitor(ip, ua, salt) {
  const day = Math.floor(Date.now() / 86400000);
  const data = `${ip}|${ua}|${day}|${salt}`;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

function checkAuth(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Basic ')) return false;
  try {
    const decoded = atob(auth.slice(6));
    const idx = decoded.indexOf(':');
    const pass = idx >= 0 ? decoded.slice(idx + 1) : decoded;
    return env.DASHBOARD_PASSWORD && pass === env.DASHBOARD_PASSWORD;
  } catch {
    return false;
  }
}

function unauthorized() {
  return new Response('Authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="analytics"' },
  });
}

function clientSnippet(origin) {
  return `(function(){
  try {
    if (navigator.doNotTrack === "1" || window.doNotTrack === "1" || navigator.msDoNotTrack === "1") return;
    var url = '${origin}/collect';
    function send(payload) {
      var body = JSON.stringify(payload);
      if (navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }));
      } else {
        fetch(url, { method: 'POST', body: body, keepalive: true, headers: { 'Content-Type': 'text/plain' } }).catch(function () {});
      }
    }

    // Per-page-load id (random, single-use — only correlates this page's own
    // heartbeats, never reused). Per-tab session id lives in sessionStorage:
    // cleared when the tab closes, never sent as a cookie, and — because every
    // one of these sites shares the same origin — it naturally groups a visit
    // that hops between different projects in one sitting.
    function rid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
    var pid = (crypto && crypto.randomUUID) ? crypto.randomUUID() : rid();
    var sid = '';
    try {
      sid = sessionStorage.getItem('va_sid') || '';
      if (!sid) { sid = rid(); sessionStorage.setItem('va_sid', sid); }
    } catch (e) {}

    // Opaque, persistent, single-purpose: the only piece of state here that
    // survives closing the browser. It carries nothing but a random value —
    // used only to tell new visits from returning ones. Cleared by clearing
    // site data, a different browser/device, or private browsing all just
    // look like a new visitor again, which is the expected trade-off.
    var cid = '';
    try {
      cid = localStorage.getItem('va_cid') || '';
      if (!cid) { cid = (crypto && crypto.randomUUID) ? crypto.randomUUID() : rid(); localStorage.setItem('va_cid', cid); }
    } catch (e) {}

    var seg = location.pathname.split('/').filter(Boolean)[0] || '(root)';
    var refHost = '';
    var refSite = '';
    if (document.referrer) { 
      try { 
        var ru = new URL(document.referrer);
        refHost = ru.hostname; 
        if (refHost === location.hostname) {
          refSite = ru.pathname.split('/').filter(Boolean)[0] || '(root)';
        }
      } catch (e) {} 
    }
    var q = new URLSearchParams(location.search);
    send({
      site: seg,
      path: location.pathname,
      t: document.title ? document.title.slice(0, 120) : '',
      ref: refHost,
      refs: refSite,
      lang: (navigator.language || '').slice(0, 5),
      us: q.get('utm_source') || '',
      um: q.get('utm_medium') || '',
      uc: q.get('utm_campaign') || '',
      pid: pid,
      sid: sid,
      cid: cid
    });

    // Engaged-time heartbeat: only while the tab is actually visible, capped
    // at 1 hour of pings. This is an estimate, not a stopwatch — same
    // approach real privacy-respecting analytics tools use, since unload
    // events are unreliable (especially on mobile).
    var pings = 0;
    var timer = setInterval(function () {
      if (document.visibilityState !== 'visible') return;
      pings++;
      if (pings > 240) { clearInterval(timer); return; }
      send({ k: 'hb', pid: pid });
    }, 15000);
  } catch (e) {}
})();
`;
}

async function handleCollect(request, env, ctx) {
  let body;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return new Response(null, { status: 204 });
  }

  const ua = request.headers.get('User-Agent') || '';
  const origin = env.ALLOWED_ORIGIN || 'https://dr-richard-barker.github.io';
  const corsHeaders = { 'Access-Control-Allow-Origin': origin };

  if (isBot(ua)) return new Response(null, { status: 204, headers: corsHeaders });

  if (body.k === 'hb') {
    const pageviewId = body.pid ? String(body.pid).slice(0, 64) : '';
    if (pageviewId) {
      ctx.waitUntil(
        env.DB.prepare(
          `UPDATE pageviews SET duration_sec = MIN(duration_sec + 15, 3600) WHERE pageview_id = ?`
        )
          .bind(pageviewId)
          .run()
      );
    }
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const site = String(body.site || '(root)').slice(0, 64);
  const path = String(body.path || '/').slice(0, 512);
  const title = body.t ? String(body.t).slice(0, 120) : null;
  const referrerHost = body.ref ? String(body.ref).slice(0, 255) : '';
  const referrerSite = body.refs ? String(body.refs).slice(0, 255) : null;
  const lang = body.lang ? String(body.lang).slice(0, 5) : null;
  const utmSource = body.us ? String(body.us).slice(0, 100) : null;
  const utmMedium = body.um ? String(body.um).slice(0, 100) : null;
  const utmCampaign = body.uc ? String(body.uc).slice(0, 100) : null;
  const pageviewId = body.pid ? String(body.pid).slice(0, 64) : null;
  const sessionId = body.sid ? String(body.sid).slice(0, 64) : null;
  const clientId = body.cid ? String(body.cid).slice(0, 64) : null;

  const { device, browser, os } = parseUA(ua);
  const cf = request.cf || {};
  const country = cf.country || null;
  const city = cf.city || null;
  const region = cf.region || null;
  const asnOrg = cf.asOrganization || null;
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const visitorHash = await hashVisitor(ip, ua, env.HASH_SALT || 'default-salt-change-me');
  const sourceCategory = categorizeSource(referrerHost, utmMedium);

  ctx.waitUntil(
    env.DB.prepare(
      `INSERT INTO pageviews (ts, site, path, title, referrer_host, country, device, browser, os, lang, visitor_hash, utm_source, utm_medium, utm_campaign, source_category, referrer_site, city, region, asn_org, pageview_id, session_id, client_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
      .bind(Date.now(), site, path, title, referrerHost, country, device, browser, os, lang, visitorHash, utmSource, utmMedium, utmCampaign, sourceCategory, referrerSite, city, region, asnOrg, pageviewId, sessionId, clientId)
      .run()
  );

  if (clientId) {
    ctx.waitUntil(
      env.DB.prepare(
        `INSERT INTO visitor_first_seen (client_id, first_seen_ts) VALUES (?, ?) ON CONFLICT(client_id) DO NOTHING`
      )
        .bind(clientId, Date.now())
        .run()
    );
  }

  return new Response(null, { status: 204, headers: corsHeaders });
}

async function handleStats(request, env) {
  const url = new URL(request.url);
  const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '30', 10) || 30, 1), 365);
  const site = url.searchParams.get('site') || null;
  const since = Date.now() - days * 86400000;

  const where = site ? 'WHERE ts >= ? AND site = ?' : 'WHERE ts >= ?';
  const params = site ? [since, site] : [since];
  const q = (sql) => env.DB.prepare(sql).bind(...params);

  // first_seen_ts >= since => their first-ever visit falls in this window (New);
  // otherwise they already existed before it (Returning). since appears twice.
  const returningParams = site ? [since, since, site] : [since, since];
  const returningQuery = env.DB.prepare(
    `SELECT CASE WHEN vfs.first_seen_ts >= ? THEN 'New' ELSE 'Returning' END AS visitorType,
            COUNT(DISTINCT p.client_id) AS visitors
     FROM pageviews p JOIN visitor_first_seen vfs ON vfs.client_id = p.client_id
     WHERE p.ts >= ? ${site ? 'AND p.site = ?' : ''} AND p.client_id IS NOT NULL AND p.client_id != ''
     GROUP BY visitorType`
  ).bind(...returningParams);

  const [
    totals, daily, sites, paths, referrers, sourceBreakdown, campaigns, countries,
    cities, networks, languages, devices, browsers, oses, engagement, hourOfDay, returning, internalFlow, allSites,
  ] = await env.DB.batch([
    q(`SELECT COUNT(*) AS views, COUNT(DISTINCT visitor_hash) AS visitors, AVG(duration_sec) AS avgDuration FROM pageviews ${where}`),
    q(`SELECT CAST(ts/86400000 AS INTEGER) AS day, COUNT(*) AS views, COUNT(DISTINCT visitor_hash) AS visitors
       FROM pageviews ${where} GROUP BY day ORDER BY day`),
    q(`SELECT site, COUNT(*) AS views, COUNT(DISTINCT visitor_hash) AS visitors FROM pageviews ${where} GROUP BY site ORDER BY views DESC LIMIT 20`),
    q(`SELECT site, path, COUNT(*) AS views FROM pageviews ${where} GROUP BY site, path ORDER BY views DESC LIMIT 20`),
    q(`SELECT referrer_host, COUNT(*) AS views FROM pageviews ${where} AND referrer_host != '' GROUP BY referrer_host ORDER BY views DESC LIMIT 15`),
    q(`SELECT COALESCE(NULLIF(source_category, ''), 'Other') AS category, COUNT(*) AS views
       FROM pageviews ${where} GROUP BY category ORDER BY views DESC`),
    q(`SELECT utm_source, utm_campaign, utm_medium, COUNT(*) AS views FROM pageviews ${where}
       AND utm_source IS NOT NULL AND utm_source != '' GROUP BY utm_source, utm_campaign, utm_medium ORDER BY views DESC LIMIT 15`),
    // No LIMIT: the map needs every country that has any data, not just a top-N —
    // there are at most ~249 possible values, so this is inherently bounded.
    q(`SELECT country, COUNT(*) AS views, COUNT(DISTINCT visitor_hash) AS visitors, AVG(duration_sec) AS avgDuration
       FROM pageviews ${where} GROUP BY country ORDER BY views DESC`),
    q(`SELECT city, country, COUNT(*) AS views FROM pageviews ${where}
       AND city IS NOT NULL AND city != '' GROUP BY city, country ORDER BY views DESC LIMIT 15`),
    q(`SELECT asn_org, COUNT(*) AS views FROM pageviews ${where}
       AND asn_org IS NOT NULL AND asn_org != '' GROUP BY asn_org ORDER BY views DESC LIMIT 15`),
    q(`SELECT lang, COUNT(*) AS views FROM pageviews ${where} AND lang IS NOT NULL AND lang != '' GROUP BY lang ORDER BY views DESC LIMIT 10`),
    q(`SELECT device, COUNT(*) AS views FROM pageviews ${where} GROUP BY device ORDER BY views DESC`),
    q(`SELECT browser, COUNT(*) AS views FROM pageviews ${where} GROUP BY browser ORDER BY views DESC LIMIT 10`),
    q(`SELECT os, COUNT(*) AS views FROM pageviews ${where} GROUP BY os ORDER BY views DESC LIMIT 10`),
    q(`SELECT AVG(cnt) AS avgPagesPerSession, COUNT(*) AS sessionCount,
              100.0 * SUM(CASE WHEN cnt = 1 THEN 1 ELSE 0 END) / COUNT(*) AS bounceRatePct
       FROM (SELECT session_id, COUNT(*) AS cnt FROM pageviews ${where}
             AND session_id IS NOT NULL AND session_id != '' GROUP BY session_id)`),
    q(`SELECT CAST(strftime('%H', ts/1000, 'unixepoch') AS INTEGER) AS hour, COUNT(*) AS views
       FROM pageviews ${where} GROUP BY hour ORDER BY hour`),
    returningQuery,
    q(`SELECT referrer_site AS from_site, site AS to_site, COUNT(*) AS transitions
       FROM pageviews ${where} AND source_category = 'Internal' AND referrer_site IS NOT NULL AND referrer_site != '' AND referrer_site != site
       GROUP BY from_site, to_site ORDER BY transitions DESC LIMIT 15`),
    env.DB.prepare(`SELECT DISTINCT site FROM pageviews ORDER BY site`),
  ]);

  const body = {
    days,
    site,
    totals: totals.results[0] || { views: 0, visitors: 0, avgDuration: 0 },
    daily: daily.results,
    hourOfDay: hourOfDay.results,
    sites: sites.results,
    paths: paths.results,
    referrers: referrers.results,
    sourceBreakdown: sourceBreakdown.results,
    internalFlow: internalFlow.results,
    returning: returning.results,
    campaigns: campaigns.results,
    countries: countries.results,
    cities: cities.results,
    networks: networks.results,
    languages: languages.results,
    devices: devices.results,
    browsers: browsers.results,
    oses: oses.results,
    engagement: engagement.results[0] || { avgPagesPerSession: 0, sessionCount: 0, bounceRatePct: 0 },
    allSites: allSites.results.map((r) => r.site),
  };

  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Visitor Analytics</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #fafafa; --panel: #fff; --text: #1a1a1e; --muted: #6b6b76; --border: #e2e2e8; --accent: #6554c0; --bar: #e8e8f0;
    --src-direct: #2a78d6; --src-search: #eb6834; --src-social: #1baf7a;
    --src-referral: #eda100; --src-internal: #e87ba4; --src-scholarly: #9b59b6; --src-other: #008300;
    --ret-new: #4a3aa7; --ret-returning: #e34948;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #16161a; --panel: #1f1f24; --text: #f0f0f2; --muted: #9a9aa4; --border: #2e2e35; --accent: #8b7ffb; --bar: #3a3560;
      --src-direct: #3987e5; --src-search: #d95926; --src-social: #199e70;
      --src-referral: #c98500; --src-internal: #d55181; --src-scholarly: #8e44ad; --src-other: #008300;
      --ret-new: #9085e9; --ret-returning: #e66767;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  header { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; padding: 20px 24px; border-bottom: 1px solid var(--border); }
  h1 { font-size: 18px; margin: 0; }
  .controls { display: flex; gap: 8px; }
  select { background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font-size: 13px; }
  main { padding: 24px; max-width: 1100px; margin: 0 auto; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
  .card .num { font-size: 24px; font-weight: 600; }
  .card .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  .chart { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 20px; }
  .chart h2 { font-size: 13px; margin: 0 0 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  .barchart { display: flex; gap: 8px; }
  .barchart-y { flex: none; width: 34px; height: 100px; display: flex; flex-direction: column; justify-content: space-between; text-align: right; font-size: 10px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .barchart-main { flex: 1; min-width: 0; }
  .bars { display: flex; align-items: flex-end; gap: 2px; height: 100px; border-left: 1px solid var(--border); border-bottom: 1px solid var(--border); }
  .bars .bar { flex: 1; background: var(--accent); border-radius: 2px 2px 0 0; min-height: 1px; }
  .barchart-x { display: flex; gap: 2px; margin-top: 4px; }
  .barchart-x span { flex: 1; text-align: center; font-size: 10px; color: var(--muted); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .chartrow { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; margin-bottom: 20px; }
  .chartrow .chart { margin-bottom: 0; }
  .mapwrap { width: 100%; position: relative; }
  #worldMap { width: 100%; height: auto; display: block; }
  #worldMap path { stroke: var(--panel); stroke-width: 0.5; transition: filter .1s; }
  #worldMap path.has-data { cursor: pointer; }
  #worldMap path.hovered { filter: brightness(1.25); stroke: var(--text); stroke-width: 1; }
  .maplegend { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; margin-top: 12px; font-size: 12px; color: var(--muted); }
  .maplegend .swatch { width: 16px; height: 10px; border-radius: 2px; display: inline-block; }
  .maptip { position: absolute; z-index: 10; pointer-events: none; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; font-size: 12px; box-shadow: 0 4px 16px rgba(0,0,0,.18); min-width: 150px; }
  .maptip[hidden] { display: none; }
  .maptip .tip-title { font-size: 13px; font-weight: 600; margin-bottom: 6px; color: var(--text); }
  .maptip .tip-row { display: flex; justify-content: space-between; gap: 16px; padding: 1px 0; }
  .maptip .tip-row .tip-val { font-weight: 600; color: var(--text); font-variant-numeric: tabular-nums; }
  .maptip .tip-row .tip-label { color: var(--muted); }
  .srcbar { display: flex; height: 28px; border-radius: 6px; overflow: hidden; background: var(--border); gap: 2px; }
  .srcbar .seg { min-width: 3px; }
  .srclegend { display: flex; flex-wrap: wrap; gap: 6px 18px; margin-top: 14px; font-size: 13px; }
  .srclegend .item { display: flex; align-items: center; gap: 7px; }
  .srclegend .swatch { width: 10px; height: 10px; border-radius: 2px; flex: none; }
  .srclegend .pct { color: var(--muted); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
  .panel h2 { font-size: 13px; margin: 0 0 10px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  td { padding: 5px 0; border-bottom: 1px solid var(--border); position: relative; }
  td.n { text-align: right; color: var(--muted); width: 50px; white-space: nowrap; }
  td.label { position: relative; }
  td.label span.bg { position: absolute; left: 0; top: 0; bottom: 0; background: var(--bar); opacity: .35; z-index: 0; }
  td.label span.txt { position: relative; z-index: 1; }
  .empty { color: var(--muted); padding: 8px 0; }
</style>
</head>
<body>
<header>
  <h1>Visitor Analytics</h1>
  <div class="controls">
    <select id="siteSel"><option value="">All sites</option></select>
    <select id="daysSel">
      <option value="7">Last 7 days</option>
      <option value="30" selected>Last 30 days</option>
      <option value="90">Last 90 days</option>
    </select>
  </div>
</header>
<main>
  <div class="cards" id="cards"></div>
  <div class="chart">
    <h2>Visitors by country</h2>
    <div class="mapwrap">
      <svg id="worldMap" viewBox="0 0 960 480" xmlns="http://www.w3.org/2000/svg"></svg>
      <div class="maptip" id="mapTip" hidden></div>
    </div>
    <div class="maplegend" id="mapLegend"></div>
  </div>
  <div class="chartrow">
    <div class="chart">
      <h2>Traffic sources</h2>
      <div class="srcbar" id="srcBar"></div>
      <div class="srclegend" id="srcLegend"></div>
    </div>
    <div class="chart">
      <h2>New vs. returning</h2>
      <div class="srcbar" id="retBar"></div>
      <div class="srclegend" id="retLegend"></div>
    </div>
  </div>
  <div class="chartrow">
    <div class="chart">
      <h2>Pageviews per day</h2>
      <div class="barchart">
        <div class="barchart-y" id="barsY"></div>
        <div class="barchart-main">
          <div class="bars" id="bars"></div>
          <div class="barchart-x" id="barsX"></div>
        </div>
      </div>
    </div>
    <div class="chart">
      <h2>Pageviews by hour of day (UTC)</h2>
      <div class="barchart">
        <div class="barchart-y" id="hourBarsY"></div>
        <div class="barchart-main">
          <div class="bars" id="hourBars"></div>
          <div class="barchart-x" id="hourBarsX"></div>
        </div>
      </div>
    </div>
  </div>
  <div class="grid">
    <div class="panel"><h2>Referring sites</h2><table><tbody id="tblReferrers"></tbody></table></div>
    <div class="panel"><h2>Internal flow (Project &rarr; Project)</h2><table><tbody id="tblInternalFlow"></tbody></table></div>
    <div class="panel" id="panelCampaigns" hidden><h2>Campaigns</h2><table><tbody id="tblCampaigns"></tbody></table></div>
    <div class="panel"><h2>Top sites</h2><table><tbody id="tblSites"></tbody></table></div>
    <div class="panel"><h2>Top pages</h2><table><tbody id="tblPaths"></tbody></table></div>
    <div class="panel"><h2>Countries</h2><table><tbody id="tblCountries"></tbody></table></div>
    <div class="panel"><h2>Cities</h2><table><tbody id="tblCities"></tbody></table></div>
    <div class="panel"><h2>Networks</h2><table><tbody id="tblNetworks"></tbody></table></div>
    <div class="panel"><h2>Languages</h2><table><tbody id="tblLanguages"></tbody></table></div>
    <div class="panel"><h2>Devices</h2><table><tbody id="tblDevices"></tbody></table></div>
    <div class="panel"><h2>Browsers</h2><table><tbody id="tblBrowsers"></tbody></table></div>
    <div class="panel"><h2>Operating systems</h2><table><tbody id="tblOses"></tbody></table></div>
  </div>
</main>
<script>
var WORLD_PATHS = ${JSON.stringify(WORLD_PATHS)};
var COUNTRY_NAMES = ${JSON.stringify(COUNTRY_NAMES)};

function el(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }

var SRC_ORDER = ['Direct', 'Search', 'Social', 'Scholarly', 'Referral', 'Internal', 'Other'];
var SRC_COLORS = {
  Direct: 'var(--src-direct)', Search: 'var(--src-search)', Social: 'var(--src-social)',
  Scholarly: 'var(--src-scholarly)', Referral: 'var(--src-referral)', Internal: 'var(--src-internal)', Other: 'var(--src-other)'
};
var RET_ORDER = ['New', 'Returning'];
var RET_COLORS = { New: 'var(--ret-new)', Returning: 'var(--ret-returning)' };

// rows: [{ [catKey]: 'Direct', [valueKey]: 42 }, ...] — unmatched categories
// categories in "order" not present in rows are simply omitted (zero-width segment, no legend row).
function fillCategoryBar(barId, legendId, rows, catKey, valueKey, order, colors, unitLabel) {
  var bar = document.getElementById(barId);
  var legend = document.getElementById(legendId);
  bar.textContent = '';
  legend.textContent = '';
  var byCategory = {};
  var total = 0;
  (rows || []).forEach(function (r) { byCategory[r[catKey]] = r[valueKey]; total += r[valueKey]; });
  if (!total) {
    var empty = el('div', 'empty'); empty.textContent = 'No data yet';
    legend.appendChild(empty);
    return;
  }
  order.forEach(function (cat) {
    var val = byCategory[cat] || 0;
    if (!val) return;
    var pct = 100 * val / total;
    var seg = el('div', 'seg');
    seg.style.width = pct + '%';
    seg.style.background = colors[cat];
    seg.title = cat + ': ' + val + ' ' + unitLabel + ' (' + pct.toFixed(1) + '%)';
    bar.appendChild(seg);

    var item = el('div', 'item');
    var swatch = el('span', 'swatch'); swatch.style.background = colors[cat];
    var label = el('span'); label.textContent = cat;
    var pctSpan = el('span', 'pct'); pctSpan.textContent = val + ' · ' + pct.toFixed(1) + '%';
    item.appendChild(swatch); item.appendChild(label); item.appendChild(pctSpan);
    legend.appendChild(item);
  });
}

function fillTable(tbodyId, rows, labelKey, valueKey) {
  var tbody = document.getElementById(tbodyId);
  tbody.textContent = '';
  if (!rows || !rows.length) {
    var tr = el('tr'); var td = el('td'); td.colSpan = 2; td.className = 'empty'; td.textContent = 'No data yet';
    tr.appendChild(td); tbody.appendChild(tr); return;
  }
  var max = rows.reduce(function (m, r) { return Math.max(m, r[valueKey]); }, 1);
  rows.forEach(function (r) {
    var tr = el('tr');
    var tdLabel = el('td', 'label');
    var bg = el('span', 'bg'); bg.style.width = (100 * r[valueKey] / max) + '%';
    var txt = el('span', 'txt'); txt.textContent = (r[labelKey] === '' || r[labelKey] == null) ? '(none)' : String(r[labelKey]);
    tdLabel.appendChild(bg); tdLabel.appendChild(txt);
    var tdNum = el('td', 'n'); tdNum.textContent = r[valueKey];
    tr.appendChild(tdLabel); tr.appendChild(tdNum);
    tbody.appendChild(tr);
  });
}

function formatDuration(sec) {
  sec = Math.round(sec || 0);
  var m = Math.floor(sec / 60), s = sec % 60;
  return m + ':' + String(s).padStart(2, '0');
}

function fillCards(totals, dayCount, engagement, returning) {
  var cards = document.getElementById('cards');
  cards.textContent = '';
  var newCount = 0, returningCount = 0;
  (returning || []).forEach(function (r) {
    if (r.visitorType === 'New') newCount = r.visitors; else returningCount = r.visitors;
  });
  var knownVisitors = newCount + returningCount;
  var returningRate = knownVisitors ? Math.round(100 * returningCount / knownVisitors) + '%' : '—';
  var items = [
    ['Pageviews', totals.views],
    ['Unique visitors', totals.visitors],
    ['Avg. views / day', dayCount ? Math.round(totals.views / dayCount) : 0],
    ['Avg. time on page', formatDuration(totals.avgDuration)],
    ['Pages / session', (engagement.avgPagesPerSession || 0).toFixed(1)],
    ['Bounce rate', Math.round(engagement.bounceRatePct || 0) + '%'],
    ['Returning rate', returningRate]
  ];
  items.forEach(function (pair) {
    var card = el('div', 'card');
    var num = el('div', 'num'); num.textContent = pair[1];
    var label = el('div', 'label'); label.textContent = pair[0];
    card.appendChild(num); card.appendChild(label);
    cards.appendChild(card);
  });
}

// Rounds up to a "clean" axis max (1/2/5/10/20/50/100...) rather than the raw data max.
function niceMax(v) {
  if (v <= 0) return 1;
  var mag = Math.pow(10, Math.floor(Math.log10(v)));
  var norm = v / mag;
  var nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return nice * mag;
}

function fillYAxis(yId, max) {
  var yAxis = document.getElementById(yId);
  yAxis.textContent = '';
  [max, max / 2, 0].forEach(function (v) {
    var t = el('span'); t.textContent = Math.round(v).toLocaleString();
    yAxis.appendChild(t);
  });
}

// Shows every Nth label (not all — with up to 90 daily bars every label would
// overlap) but keeps an empty flex slot per bar so the shown ones still align.
function fillXAxisLabels(xId, labels) {
  var xAxis = document.getElementById(xId);
  xAxis.textContent = '';
  var n = labels.length;
  var every = Math.max(1, Math.ceil(n / 6));
  labels.forEach(function (label, i) {
    var s = el('span');
    if (i % every === 0 || i === n - 1) s.textContent = label;
    xAxis.appendChild(s);
  });
}

function fillBars(daily) {
  var bars = document.getElementById('bars');
  bars.textContent = '';
  if (!daily || !daily.length) { fillYAxis('barsY', 1); fillXAxisLabels('barsX', []); return; }
  var max = niceMax(daily.reduce(function (m, d) { return Math.max(m, d.views); }, 0));
  fillYAxis('barsY', max);
  var labels = [];
  daily.forEach(function (d) {
    var b = el('div', 'bar');
    b.style.height = Math.max(2, 100 * d.views / max) + '%';
    var date = new Date(d.day * 86400000);
    b.title = date.toISOString().slice(0, 10) + ': ' + d.views + ' views, ' + d.visitors + ' visitors';
    bars.appendChild(b);
    labels.push(date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
  });
  fillXAxisLabels('barsX', labels);
}

function fillHourBars(hourOfDay) {
  var bars = document.getElementById('hourBars');
  bars.textContent = '';
  var byHour = {};
  (hourOfDay || []).forEach(function (h) { byHour[h.hour] = h.views; });
  var max = niceMax(Math.max.apply(null, [0].concat((hourOfDay || []).map(function (h) { return h.views; }))));
  fillYAxis('hourBarsY', max);
  var labels = [];
  for (var hour = 0; hour < 24; hour++) {
    var views = byHour[hour] || 0;
    var b = el('div', 'bar');
    b.style.height = Math.max(2, 100 * views / max) + '%';
    b.title = String(hour).padStart(2, '0') + ':00–' + String(hour).padStart(2, '0') + ':59 UTC: ' + views + ' views';
    bars.appendChild(b);
    labels.push(String(hour));
  }
  fillXAxisLabels('hourBarsX', labels);
}

// Log-scaled 7-step blue ramp (dataviz skill's sequential default, light->dark).
var MAP_RAMP = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];
function colorForCount(count, maxCount) {
  if (!count) return null;
  if (maxCount <= 1) return MAP_RAMP[3];
  var t = Math.log(count + 1) / Math.log(maxCount + 1);
  var idx = Math.min(MAP_RAMP.length - 1, Math.floor(t * MAP_RAMP.length));
  return MAP_RAMP[idx];
}

var mapBuilt = false;
// Mutated (not reassigned by reference elsewhere) on every fillMap() call so
// the hover handlers below — attached once — always read the latest slice,
// including after the date-range/site filters change.
var mapCountryStats = {};
var mapTopCity = {};

// The map is a pointer/touch-enhanced supplement, not a keyboard tab-stop:
// 174 individual tab stops would hurt keyboard users far more than it helps,
// and every number it shows is already reachable via the Countries/Cities
// tables below (textContent throughout, same as elsewhere on this dashboard).
function showMapTip(evt, cc) {
  var tip = document.getElementById('mapTip');
  var stats = mapCountryStats[cc];
  tip.textContent = '';
  var title = el('div', 'tip-title'); title.textContent = COUNTRY_NAMES[cc] || cc;
  tip.appendChild(title);
  var rows = stats
    ? [
        ['Views', stats.views.toLocaleString()],
        ['Unique visitors', stats.visitors.toLocaleString()],
        ['Avg. time on page', formatDuration(stats.avgDuration)],
        ['Top city', mapTopCity[cc] || '(unknown)'],
      ]
    : [['', 'No visits recorded']];
  rows.forEach(function (pair) {
    var row = el('div', 'tip-row');
    var label = el('span', 'tip-label'); label.textContent = pair[0];
    var val = el('span', 'tip-val'); val.textContent = pair[1];
    row.appendChild(label); row.appendChild(val);
    tip.appendChild(row);
  });
  tip.hidden = false;
  positionMapTip(evt);
}

function positionMapTip(evt) {
  var tip = document.getElementById('mapTip');
  var wrapRect = tip.parentElement.getBoundingClientRect();
  var tipRect = tip.getBoundingClientRect();
  var x = evt.clientX - wrapRect.left + 14;
  var y = evt.clientY - wrapRect.top + 14;
  if (x + tipRect.width > wrapRect.width) x = evt.clientX - wrapRect.left - tipRect.width - 14;
  if (y + tipRect.height > wrapRect.height) y = evt.clientY - wrapRect.top - tipRect.height - 14;
  tip.style.left = Math.max(0, x) + 'px';
  tip.style.top = Math.max(0, y) + 'px';
}

function hideMapTip() {
  document.getElementById('mapTip').hidden = true;
}

function fillMap(countries, cities) {
  var svg = document.getElementById('worldMap');
  var legend = document.getElementById('mapLegend');
  mapCountryStats = {};
  var max = 1;
  (countries || []).forEach(function (c) {
    mapCountryStats[c.country] = { views: c.views, visitors: c.visitors, avgDuration: c.avgDuration };
    max = Math.max(max, c.views);
  });
  mapTopCity = {};
  (cities || []).forEach(function (c) {
    if (!mapTopCity[c.country]) mapTopCity[c.country] = c.city; // cities[] already sorted by views DESC
  });

  if (!mapBuilt) {
    svg.textContent = '';
    Object.keys(WORLD_PATHS).forEach(function (cc) {
      var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', WORLD_PATHS[cc]);
      path.setAttribute('data-cc', cc);
      path.addEventListener('pointerenter', function (evt) { path.classList.add('hovered'); showMapTip(evt, cc); });
      path.addEventListener('pointermove', positionMapTip);
      path.addEventListener('pointerleave', function () { path.classList.remove('hovered'); hideMapTip(); });
      svg.appendChild(path);
    });
    mapBuilt = true;
  }

  var noData = getComputedStyle(document.documentElement).getPropertyValue('--border').trim() || '#e4e4e8';
  var paths = svg.querySelectorAll('path[data-cc]');
  paths.forEach(function (path) {
    var cc = path.getAttribute('data-cc');
    var views = mapCountryStats[cc] ? mapCountryStats[cc].views : 0;
    var color = colorForCount(views, max);
    path.setAttribute('fill', color || noData);
    path.classList.toggle('has-data', !!color);
  });

  legend.textContent = '';
  if (countries && countries.length) {
    var lowLabel = el('span'); lowLabel.textContent = 'Fewer';
    legend.appendChild(lowLabel);
    MAP_RAMP.forEach(function (color) {
      var sw = el('span', 'swatch'); sw.style.background = color;
      legend.appendChild(sw);
    });
    var highLabel = el('span'); highLabel.textContent = 'More';
    legend.appendChild(highLabel);
  } else {
    var empty = el('span'); empty.textContent = 'No data yet';
    legend.appendChild(empty);
  }
}

function fillSiteOptions(sites, current) {
  var sel = document.getElementById('siteSel');
  var keep = sel.value;
  sel.textContent = '';
  var optAll = el('option'); optAll.value = ''; optAll.textContent = 'All sites'; sel.appendChild(optAll);
  sites.forEach(function (s) {
    var o = el('option'); o.value = s; o.textContent = s;
    sel.appendChild(o);
  });
  sel.value = current || keep || '';
}

async function load() {
  var days = document.getElementById('daysSel').value;
  var site = document.getElementById('siteSel').value;
  var qs = 'days=' + encodeURIComponent(days) + (site ? '&site=' + encodeURIComponent(site) : '');
  var res = await fetch('/api/stats?' + qs);
  if (!res.ok) return;
  var data = await res.json();
  fillCards(data.totals, data.daily.length, data.engagement, data.returning);
  fillMap(data.countries, data.cities);
  fillCategoryBar('srcBar', 'srcLegend', data.sourceBreakdown, 'category', 'views', SRC_ORDER, SRC_COLORS, 'views');
  fillCategoryBar('retBar', 'retLegend', data.returning, 'visitorType', 'visitors', RET_ORDER, RET_COLORS, 'visitors');
  fillBars(data.daily);
  fillHourBars(data.hourOfDay);
  fillSiteOptions(data.allSites, site);
  fillTable('tblSites', data.sites, 'site', 'views');
  fillTable('tblPaths', data.paths.map(function(p){ return { label: p.site + p.path, views: p.views }; }), 'label', 'views');
  fillTable('tblReferrers', data.referrers, 'referrer_host', 'views');
  fillTable('tblInternalFlow', (data.internalFlow || []).map(function(f) {
    return { label: f.from_site + ' → ' + f.to_site, views: f.transitions };
  }), 'label', 'views');
  document.getElementById('panelCampaigns').hidden = !(data.campaigns && data.campaigns.length);
  fillTable('tblCampaigns', (data.campaigns || []).map(function (c) {
    var label = c.utm_source + (c.utm_campaign ? ' / ' + c.utm_campaign : '') + (c.utm_medium ? ' (' + c.utm_medium + ')' : '');
    return { label: label, views: c.views };
  }), 'label', 'views');
  fillTable('tblCountries', data.countries, 'country', 'views');
  fillTable('tblCities', (data.cities || []).map(function (c) {
    return { label: c.city + ', ' + c.country, views: c.views };
  }), 'label', 'views');
  fillTable('tblNetworks', data.networks, 'asn_org', 'views');
  fillTable('tblLanguages', data.languages, 'lang', 'views');
  fillTable('tblDevices', data.devices, 'device', 'views');
  fillTable('tblBrowsers', data.browsers, 'browser', 'views');
  fillTable('tblOses', data.oses, 'os', 'views');
}

document.getElementById('daysSel').addEventListener('change', load);
document.getElementById('siteSel').addEventListener('change', load);
load();
</script>
</body>
</html>`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === '/collect' && request.method === 'POST') {
      return handleCollect(request, env, ctx);
    }
    if (pathname === '/a.js') {
      return new Response(clientSnippet(url.origin), {
        headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
      });
    }
    if (pathname === '/api/stats') {
      if (!checkAuth(request, env)) return unauthorized();
      return handleStats(request, env);
    }
    if (pathname === '/' || pathname === '/dashboard') {
      if (!checkAuth(request, env)) return unauthorized();
      return new Response(DASHBOARD_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    return new Response('Not found', { status: 404 });
  },
};
