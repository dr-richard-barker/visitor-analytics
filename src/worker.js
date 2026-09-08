// Visitor analytics collector + dashboard for GitHub Pages sites.
// Single Worker, three routes:
//   GET  /a.js        -> client tracking snippet (public)
//   POST /collect      -> ingest one pageview beacon (public)
//   GET  /api/stats    -> aggregated JSON, Basic-Auth gated
//   GET  /, /dashboard -> dashboard UI, Basic-Auth gated
//
// Privacy: no cookies, no persistent client-side ID, no raw IP stored.
// "Unique visitors" is approximated with a salted hash of (IP + UA + calendar day),
// computed on the edge and discarded immediately after hashing; the salt rotates
// daily so the hash cannot be used to follow anyone across days.

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
    var seg = location.pathname.split('/').filter(Boolean)[0] || '(root)';
    var refHost = '';
    if (document.referrer) { try { refHost = new URL(document.referrer).hostname; } catch (e) {} }
    var payload = JSON.stringify({
      site: seg,
      path: location.pathname,
      t: document.title ? document.title.slice(0, 120) : '',
      ref: refHost,
      lang: (navigator.language || '').slice(0, 5)
    });
    var url = '${origin}/collect';
    if (navigator.sendBeacon) {
      navigator.sendBeacon(url, new Blob([payload], { type: 'text/plain' }));
    } else {
      fetch(url, { method: 'POST', body: payload, keepalive: true, headers: { 'Content-Type': 'text/plain' } }).catch(function () {});
    }
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

  const site = String(body.site || '(root)').slice(0, 64);
  const path = String(body.path || '/').slice(0, 512);
  const title = body.t ? String(body.t).slice(0, 120) : null;
  const referrerHost = body.ref ? String(body.ref).slice(0, 255) : '';
  const lang = body.lang ? String(body.lang).slice(0, 5) : null;

  const { device, browser, os } = parseUA(ua);
  const country = (request.cf && request.cf.country) || 'XX';
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const visitorHash = await hashVisitor(ip, ua, env.HASH_SALT || 'default-salt-change-me');

  ctx.waitUntil(
    env.DB.prepare(
      `INSERT INTO pageviews (ts, site, path, title, referrer_host, country, device, browser, os, lang, visitor_hash)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    )
      .bind(Date.now(), site, path, title, referrerHost, country, device, browser, os, lang, visitorHash)
      .run()
  );

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

  const [totals, daily, sites, paths, referrers, countries, devices, browsers, oses, allSites] = await env.DB.batch([
    q(`SELECT COUNT(*) AS views, COUNT(DISTINCT visitor_hash) AS visitors FROM pageviews ${where}`),
    q(`SELECT CAST(ts/86400000 AS INTEGER) AS day, COUNT(*) AS views, COUNT(DISTINCT visitor_hash) AS visitors
       FROM pageviews ${where} GROUP BY day ORDER BY day`),
    q(`SELECT site, COUNT(*) AS views, COUNT(DISTINCT visitor_hash) AS visitors FROM pageviews ${where} GROUP BY site ORDER BY views DESC LIMIT 20`),
    q(`SELECT site, path, COUNT(*) AS views FROM pageviews ${where} GROUP BY site, path ORDER BY views DESC LIMIT 20`),
    q(`SELECT referrer_host, COUNT(*) AS views FROM pageviews ${where} AND referrer_host != '' GROUP BY referrer_host ORDER BY views DESC LIMIT 15`),
    q(`SELECT country, COUNT(*) AS views FROM pageviews ${where} GROUP BY country ORDER BY views DESC LIMIT 15`),
    q(`SELECT device, COUNT(*) AS views FROM pageviews ${where} GROUP BY device ORDER BY views DESC`),
    q(`SELECT browser, COUNT(*) AS views FROM pageviews ${where} GROUP BY browser ORDER BY views DESC LIMIT 10`),
    q(`SELECT os, COUNT(*) AS views FROM pageviews ${where} GROUP BY os ORDER BY views DESC LIMIT 10`),
    env.DB.prepare(`SELECT DISTINCT site FROM pageviews ORDER BY site`),
  ]);

  const body = {
    days,
    site,
    totals: totals.results[0] || { views: 0, visitors: 0 },
    daily: daily.results,
    sites: sites.results,
    paths: paths.results,
    referrers: referrers.results,
    countries: countries.results,
    devices: devices.results,
    browsers: browsers.results,
    oses: oses.results,
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
    --bg: #f7f7f8; --panel: #ffffff; --text: #1a1a1e; --muted: #6b6b76;
    --border: #e4e4e8; --accent: #4f46e5; --bar: #c7c2fb;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #16161a; --panel: #1f1f24; --text: #f0f0f2; --muted: #9a9aa4; --border: #2e2e35; --accent: #8b7ffb; --bar: #3a3560; }
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
  .bars { display: flex; align-items: flex-end; gap: 2px; height: 100px; }
  .bars .bar { flex: 1; background: var(--accent); border-radius: 2px 2px 0 0; min-height: 1px; }
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
    <h2>Pageviews per day</h2>
    <div class="bars" id="bars"></div>
  </div>
  <div class="grid">
    <div class="panel"><h2>Top sites</h2><table><tbody id="tblSites"></tbody></table></div>
    <div class="panel"><h2>Top pages</h2><table><tbody id="tblPaths"></tbody></table></div>
    <div class="panel"><h2>Referrers</h2><table><tbody id="tblReferrers"></tbody></table></div>
    <div class="panel"><h2>Countries</h2><table><tbody id="tblCountries"></tbody></table></div>
    <div class="panel"><h2>Devices</h2><table><tbody id="tblDevices"></tbody></table></div>
    <div class="panel"><h2>Browsers</h2><table><tbody id="tblBrowsers"></tbody></table></div>
    <div class="panel"><h2>Operating systems</h2><table><tbody id="tblOses"></tbody></table></div>
  </div>
</main>
<script>
function el(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }

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

function fillCards(totals, dayCount) {
  var cards = document.getElementById('cards');
  cards.textContent = '';
  var items = [
    ['Pageviews', totals.views],
    ['Unique visitors', totals.visitors],
    ['Avg. views / day', dayCount ? Math.round(totals.views / dayCount) : 0]
  ];
  items.forEach(function (pair) {
    var card = el('div', 'card');
    var num = el('div', 'num'); num.textContent = pair[1];
    var label = el('div', 'label'); label.textContent = pair[0];
    card.appendChild(num); card.appendChild(label);
    cards.appendChild(card);
  });
}

function fillBars(daily) {
  var bars = document.getElementById('bars');
  bars.textContent = '';
  if (!daily || !daily.length) return;
  var max = daily.reduce(function (m, d) { return Math.max(m, d.views); }, 1);
  daily.forEach(function (d) {
    var b = el('div', 'bar');
    b.style.height = Math.max(2, 100 * d.views / max) + '%';
    var date = new Date(d.day * 86400000);
    b.title = date.toISOString().slice(0, 10) + ': ' + d.views + ' views, ' + d.visitors + ' visitors';
    bars.appendChild(b);
  });
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
  fillCards(data.totals, data.daily.length);
  fillBars(data.daily);
  fillSiteOptions(data.allSites, site);
  fillTable('tblSites', data.sites, 'site', 'views');
  fillTable('tblPaths', data.paths.map(function(p){ return { label: p.site + p.path, views: p.views }; }), 'label', 'views');
  fillTable('tblReferrers', data.referrers, 'referrer_host', 'views');
  fillTable('tblCountries', data.countries, 'country', 'views');
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
