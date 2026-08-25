/**
 * What the scouting lead watches over AnyDesk.
 *
 * A web page rather than a terminal UI, deliberately: a redrawing TUI over a
 * remote-desktop session on venue wifi is painful to read, while a static page
 * that repaints every couple of seconds survives a bad connection fine.
 *
 * **Bound to 127.0.0.1 and nothing else.** There is no authentication here and
 * there should not be — AnyDesk is the auth boundary, and the person watching
 * has already authenticated to the machine. Binding this to 0.0.0.0 at a venue
 * would put an unauthenticated write endpoint on the event wifi.
 *
 * The write endpoints are all things only a human can decide: starting a
 * capture from a link, cancelling one, assigning a match key the worker refused
 * to guess, and asking for a reprocess.
 *
 * **CORS is open to a short, explicit allow-list.** The app's dev server is
 * `http://localhost:5173`, and the deployed app the team actually uses day to
 * day is `https://qwertz101.github.io` (GitHub Pages) -- both are cross-origin
 * from this worker's point of view, so the browser will not let the CV tab
 * read a response without permission. Reflecting only those origins (plus
 * loopback in general, for other local dev setups) keeps that from becoming a
 * hole: combined with the loopback bind, a page on the open internet can still
 * fire a request here but cannot read the answer, and cannot forge an origin
 * header to change that -- only a browser tab actually pointed at one of these
 * addresses gets the response.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, sep } from 'node:path';
import { fetchCvLogs, isWorkerRow, checkSchema } from './supabase.mjs';
import { REPO_ROOT } from './core.mjs';

export const DASHBOARD_PORT = 7654;
const HOST = '127.0.0.1';

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>Capture worker</title>
<style>
  :root { color-scheme: dark; --bg:#12141a; --card:#1b1e26; --line:#2b303c;
          --fg:#e7e9ee; --dim:#9aa1b1; --ok:#4ade80; --warn:#fbbf24; --bad:#f87171; }
  * { box-sizing: border-box; }
  body { margin:0; padding:20px; background:var(--bg); color:var(--fg);
         font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif; }
  h1 { font-size:16px; margin:0 0 4px; font-weight:600; }
  .sub { color:var(--dim); font-size:12px; margin-bottom:16px; }
  .banner { background:#3a2a12; border:1px solid #7c5a1e; color:#f4d192;
            padding:10px 12px; border-radius:8px; margin-bottom:16px; font-size:13px; }
  .cards { display:flex; gap:12px; flex-wrap:wrap; margin-bottom:18px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px;
          padding:12px 14px; min-width:150px; }
  .card .k { color:var(--dim); font-size:11px; text-transform:uppercase; letter-spacing:.06em; }
  .card .v { font-size:20px; font-weight:600; margin-top:2px; }
  .wrap { overflow-x:auto; }
  table { border-collapse:collapse; width:100%; min-width:760px; }
  th,td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); font-size:13px; }
  th { color:var(--dim); font-weight:500; font-size:11px; text-transform:uppercase; letter-spacing:.06em; }
  td.num { font-variant-numeric:tabular-nums; }
  .pill { display:inline-block; padding:1px 8px; border-radius:999px; font-size:11px; }
  .pill.ok   { background:#14351f; color:var(--ok); }
  .pill.warn { background:#3a2a12; color:var(--warn); }
  .pill.bad  { background:#3a1717; color:var(--bad); }
  .pill.human{ background:#1e2a3a; color:#93c5fd; }
  .reasons { color:var(--dim); font-size:12px; }
  input,button { font:inherit; background:#12151c; color:var(--fg);
                 border:1px solid var(--line); border-radius:6px; padding:4px 8px; }
  button { cursor:pointer; }
  button:hover { border-color:#4b5566; }
  .empty { color:var(--dim); padding:24px 0; }
  form.job { background:var(--card); border:1px solid var(--line); border-radius:10px;
             padding:12px 14px; margin-bottom:18px; display:flex; gap:8px; flex-wrap:wrap;
             align-items:center; }
  form.job input[type=text] { flex:1; min-width:260px; }
  form.job label { color:var(--dim); font-size:12px; display:flex; gap:5px; align-items:center; }
  .jobline { color:var(--dim); font-size:12px; margin:-10px 0 16px; }
  pre.log { background:#0d0f14; border:1px solid var(--line); border-radius:10px;
            padding:12px 14px; margin-top:18px; max-height:280px; overflow:auto;
            font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--dim);
            white-space:pre-wrap; }
</style>
<h1>Capture worker</h1>
<div class="sub" id="sub">loading…</div>
<div id="banner"></div>
<form class="job" id="job">
  <input type="text" id="url" placeholder="YouTube VOD or livestream link" autocomplete="off">
  <input type="text" id="event" placeholder="event key" size="12" autocomplete="off">
  <label><input type="radio" name="mode" value="vod" checked> recording</label>
  <label><input type="radio" name="mode" value="live"> live</label>
  <label><input type="checkbox" id="write"> save to database</label>
  <button type="submit" id="go">Start</button>
  <button type="button" id="cancel" style="display:none">Cancel</button>
</form>
<div class="jobline" id="jobline"></div>
<div class="cards" id="cards"></div>
<div class="wrap"><table>
  <thead><tr>
    <th>Match</th><th>Final</th><th>Quality</th><th>Source</th><th>Notes</th><th></th>
  </tr></thead>
  <tbody id="rows"></tbody>
</table></div>
<pre class="log" id="log"></pre>
<script>
const $ = (id) => document.getElementById(id);

function pill(cls, text) { return '<span class="pill ' + cls + '">' + text + '</span>'; }

function qualityPill(row) {
  if (!isWorker(row)) return pill('human', 'human');
  const q = row.quality;
  if (!q) return pill('warn', '—');
  const cls = row.flagged ? 'bad' : q.score >= 0.85 ? 'ok' : 'warn';
  return pill(cls, q.score.toFixed(2) + (row.flagged ? ' flagged' : ''));
}

const isWorker = (r) => typeof r.source === 'string' && r.source.startsWith('auto-worker');

/** True while the operator is mid-edit, so a poll never yanks the text away. */
let touched = false;
for (const id of ['url', 'event']) $(id).addEventListener('input', () => (touched = true));

let seededEvent = false;

function renderJob(s) {
  const j = s.job;
  const running = j && (j.status === 'running' || j.status === 'cancelling');

  $('go').disabled = Boolean(running);
  $('go').textContent = running ? 'Running…' : 'Start';
  $('cancel').style.display = running ? '' : 'none';
  // The server decides whether writing is permitted at all; the checkbox can
  // only decline it. Showing it enabled when the server was started without
  // --write would promise something we cannot deliver.
  $('write').disabled = !s.allowWrite;
  $('write').parentElement.title = s.allowWrite
    ? 'Uncheck for a dry run'
    : 'This worker was started without --write, so every job is a dry run';

  if (!seededEvent && !touched && s.eventKey) {
    $('event').value = s.eventKey;
    seededEvent = true;
  }
  if (running && !touched) $('url').value = j.url;

  if (!j) {
    $('jobline').textContent = 'Idle — paste a link above, or use the CV tab in the app.';
    return;
  }
  const secs = ((j.finishedAt ?? Date.now()) - j.startedAt) / 1000;
  const bits = [
    j.status + ' · ' + j.mode,
    j.matches + ' match(es)',
    secs > 90 ? (secs / 60).toFixed(1) + ' min' : secs.toFixed(0) + 's',
  ];
  const span = j.progress ? j.progress.to - j.progress.from : 0;
  if (span > 0) {
    bits.push(
      'scanned ' +
        Math.min(100, Math.round(((j.progress.at - j.progress.from) / span) * 100)) + '%'
    );
  }
  if (!j.write) bits.push('dry run');
  if (j.error) bits.push('error: ' + j.error);
  $('jobline').textContent = bits.join(' · ') + (j.lastLine ? ' — ' + j.lastLine : '');
}

$('job').onsubmit = async (e) => {
  e.preventDefault();
  const body = {
    url: $('url').value.trim(),
    eventKey: $('event').value.trim(),
    mode: document.querySelector('input[name=mode]:checked').value,
    write: $('write').checked,
  };
  if (!body.url) return;
  $('go').disabled = true;
  const r = await fetch('/api/job', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    $('jobline').textContent = 'could not start: ' + (j.error || r.status);
    $('go').disabled = false;
  }
  touched = false;
  tick();
};

$('cancel').onclick = async () => {
  await fetch('/api/job/cancel', { method: 'POST' });
  tick();
};

function render(s) {
  renderJob(s);
  const logEl = $('log');
  // Only follow the tail if the reader is already at it — otherwise scrolling
  // back to read something gets undone twice a second.
  const pinned = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
  // Double-escaped on purpose: this whole page is a template literal, so a
  // single backslash-n would be a real newline in the emitted HTML and would
  // split this string across two lines, which is a syntax error in the browser.
  logEl.textContent = (s.logLines ?? []).join('\\n');
  logEl.style.display = (s.logLines ?? []).length ? '' : 'none';
  if (pinned) logEl.scrollTop = logEl.scrollHeight;

  $('sub').textContent =
    (s.eventKey || 'all events') + ' · ' + s.rows.length + ' logs · updated ' +
    new Date(s.at).toLocaleTimeString();

  $('banner').innerHTML = s.unmigrated
    ? '<div class="banner">The database has not had the capture-worker columns added yet, so ' +
      'quality and flags are blank. Run the <code>alter table</code> statements at the top of ' +
      '<code>supabase/schema-bps.sql</code>.</div>'
    : '';

  const worker = s.rows.filter(isWorker);
  const flagged = s.rows.filter((r) => r.flagged);
  const cards = [
    ['logs', s.rows.length],
    ['by worker', worker.length],
    ['needs review', flagged.length],
    ['unidentified', s.unidentified ?? 0],
  ];
  $('cards').innerHTML = cards
    .map((c) => '<div class="card"><div class="k">' + c[0] + '</div><div class="v">' + c[1] + '</div></div>')
    .join('');

  if (!s.rows.length) {
    $('rows').innerHTML = '<tr><td colspan="6" class="empty">Nothing logged yet.</td></tr>';
    return;
  }

  // Worst first: a review queue is only useful if the thing needing attention
  // is at the top.
  const rows = [...s.rows].sort((a, b) => {
    if (a.flagged !== b.flagged) return a.flagged ? -1 : 1;
    return (a.quality?.score ?? 2) - (b.quality?.score ?? 2);
  });

  $('rows').innerHTML = rows.map((r) => {
    const reasons = (r.quality?.reasons ?? []).join(' · ');
    const key = r.match_key || '';
    return '<tr>' +
      '<td class="num">' + (key || '<em>unidentified</em>') + '</td>' +
      '<td class="num">' + (r.final ? r.final.blue + '–' + r.final.red : '—') + '</td>' +
      '<td>' + qualityPill(r) + '</td>' +
      '<td class="reasons">' + (r.source || '') + '</td>' +
      '<td class="reasons">' + reasons + '</td>' +
      '<td><button data-reprocess="' + key + '" data-t0="' +
        (r.greenFlagAt ?? '') + '">Reprocess</button></td>' +
      '</tr>';
  }).join('');

  for (const b of document.querySelectorAll('[data-reprocess]')) {
    b.onclick = async () => {
      b.disabled = true;
      b.textContent = 'reading…';
      const r = await fetch('/api/reprocess', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          matchKey: b.dataset.reprocess,
          greenFlagAt: b.dataset.t0 === '' ? undefined : Number(b.dataset.t0),
        }),
      });
      // A refusal here is nearly always a real answer — "that was a live
      // capture, its frames are gone" — so it belongs on screen, not swallowed.
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        $('jobline').textContent = 'reprocess failed: ' + (j.error || r.status);
        b.disabled = false;
        b.textContent = 'Reprocess';
      }
      tick();
    };
  }
}

async function tick() {
  try {
    render(await (await fetch('/api/state')).json());
  } catch (e) {
    $('sub').textContent = 'worker not responding — ' + e.message;
  }
}
tick();
setInterval(tick, 2000);
</script>`;

/** Only a loopback page may read our responses. See the header. */
/**
 * Origins allowed to read this server's responses, beyond loopback dev
 * addresses. The deployed app is the one the scouting lead actually opens on
 * match day, so it has to be here explicitly -- CORS matches an origin, not a
 * path, so `/frcScoutingAppV2/` (the GitHub Pages base path) is irrelevant to
 * this check.
 */
const EXTRA_ALLOWED_ORIGINS = ['https://qwertz101.github.io'];

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin) return {};
  const loopback = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
  if (!loopback && !EXTRA_ALLOWED_ORIGINS.includes(origin)) return {};
  const headers = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
  // Chrome's Private Network Access: a page on the public internet reaching a
  // machine-local address is a separate permission from CORS, and is refused
  // outright unless the target opts in here. The deployed app is exactly that
  // case -- https://qwertz101.github.io asking for 127.0.0.1 -- and without
  // this it fails as ERR_BLOCKED_BY_CLIENT before CORS is even consulted.
  // Granted only to origins that already passed the allow-list above.
  if (req.headers['access-control-request-private-network'] === 'true') {
    headers['Access-Control-Allow-Private-Network'] = 'true';
  }
  return headers;
}

function send(res, status, body, type = 'application/json', req = null) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    ...(req ? corsHeaders(req) : {}),
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

/**
 * Serve the built app from the worker itself, so the CV tab is same-origin.
 *
 * The deployed copy at `https://qwertz101.github.io` **cannot** talk to this
 * worker, and no header fixes it: a page on the public internet reaching a
 * machine-local address is blocked by the browser before CORS is consulted
 * (verified -- `ERR_BLOCKED_BY_CLIENT`, with the same request succeeding from
 * an `http://localhost` origin and `curl` reaching the worker fine throughout).
 * Chrome's Private Network Access opt-in did not lift it either.
 *
 * Rather than fight that, remove the cross-origin hop: serve `dist/` from this
 * same server, so the app the operator opens is on `http://127.0.0.1:7654` and
 * every worker call is same-origin. No CORS, no mixed content, no private
 * network transition.
 *
 * Mounted at the app's Vite `base` (`/frcScoutingAppV2/`) because the built
 * `index.html` references its assets by absolute path; serving it anywhere else
 * would 404 every asset. `/app` redirects there so nobody has to remember it.
 */
const APP_BASE = '/frcScoutingAppV2/';
const DIST = join(REPO_ROOT, 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.traineddata': 'application/octet-stream',
  '.gz': 'application/gzip',
};

async function serveApp(req, res, pathname) {
  let rel = pathname.slice(APP_BASE.length);
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';

  // Refuse anything that climbs out of dist/. `normalize` resolves the `..`
  // segments first, so this checks where the path actually lands rather than
  // whether it looked suspicious.
  const target = normalize(join(DIST, rel));
  if (!target.startsWith(DIST + sep)) return send(res, 403, { error: 'forbidden' });

  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': body.length,
      // The build fingerprints its assets, so the only thing that must never be
      // cached is the entry document that names them.
      'Cache-Control': rel.endsWith('index.html') ? 'no-store' : 'public, max-age=3600',
    });
    res.end(body);
  } catch {
    // A single-page app owns its own routing: an unknown path is a route, not
    // a missing file. Assets are the exception -- a 404 there is a real bug and
    // should look like one rather than silently returning HTML.
    if (extname(rel)) return send(res, 404, { error: 'not found: ' + rel });
    try {
      const html = await readFile(join(DIST, 'index.html'));
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
      res.end(html);
    } catch {
      send(res, 404, {
        error: 'the app has not been built yet — run "npm run build" in the repo root',
      });
    }
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

/**
 * Start the dashboard.
 *
 * `getState` supplies whatever the supervisor knows; by default it reads the
 * logs straight out of Supabase, so the page is useful before the supervisor
 * exists. `onAssign` and `onReprocess` are the only ways in.
 */
export function startDashboard(opts = {}) {
  const port = opts.port ?? DASHBOARD_PORT;
  const eventKey = opts.eventKey ?? '';

  const getState =
    opts.getState ??
    (async () => {
      const rows = await fetchCvLogs(eventKey);
      return {
        eventKey,
        at: Date.now(),
        unmigrated: rows.some((r) => r.unmigrated),
        unidentified: 0,
        rows,
      };
    });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://' + HOST);
    try {
      if (req.method === 'OPTIONS') return send(res, 204, '', 'text/plain', req);

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return send(res, 200, PAGE, 'text/html; charset=utf-8', req);
      }
      // The scouting app, served from here so it is same-origin with the API.
      if (req.method === 'GET' && (url.pathname === '/app' || url.pathname === '/app/')) {
        res.writeHead(302, { Location: APP_BASE });
        return res.end();
      }
      if (req.method === 'GET' && url.pathname.startsWith(APP_BASE)) {
        return serveApp(req, res, url.pathname);
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        return send(res, 200, await getState(), 'application/json', req);
      }
      // A cheap "is the worker there?" that the app can poll without dragging
      // the whole state payload across on every tick.
      if (req.method === 'GET' && url.pathname === '/api/ping') {
        return send(res, 200, { ok: true, jobs: Boolean(opts.onSubmitJob) }, 'application/json', req);
      }
      if (req.method === 'POST' && url.pathname === '/api/job') {
        const body = await readBody(req);
        if (!opts.onSubmitJob) return send(res, 501, { error: 'this dashboard cannot start captures — run worker/src/server.mjs instead' }, 'application/json', req);
        if (!body.url) return send(res, 400, { error: 'need a url' }, 'application/json', req);
        return send(res, 200, (await opts.onSubmitJob(body)) ?? { ok: true }, 'application/json', req);
      }
      if (req.method === 'POST' && url.pathname === '/api/job/cancel') {
        if (!opts.onCancelJob) return send(res, 501, { error: 'cancel not wired up' }, 'application/json', req);
        return send(res, 200, (await opts.onCancelJob()) ?? { ok: true }, 'application/json', req);
      }
      if (req.method === 'POST' && url.pathname === '/api/assign') {
        const body = await readBody(req);
        if (!body.clipId || !body.matchKey) {
          return send(res, 400, { error: 'need clipId and matchKey' }, 'application/json', req);
        }
        if (!opts.onAssign) return send(res, 501, { error: 'assign not wired up' }, 'application/json', req);
        return send(res, 200, (await opts.onAssign(body)) ?? { ok: true }, 'application/json', req);
      }
      if (req.method === 'POST' && url.pathname === '/api/reprocess') {
        const body = await readBody(req);
        if (!opts.onReprocess) return send(res, 501, { error: 'reprocess not wired up' }, 'application/json', req);
        return send(res, 200, (await opts.onReprocess(body)) ?? { ok: true }, 'application/json', req);
      }
      send(res, 404, { error: 'not found' }, 'application/json', req);
    } catch (e) {
      send(res, 500, { error: String(e.message ?? e) }, 'application/json', req);
    }
  });

  return new Promise((resolve) => {
    // Loopback only. See the header — this is a security boundary, not a default.
    server.listen(port, HOST, () => resolve({ server, url: 'http://' + HOST + ':' + port }));
  });
}

const invokedDirectly =
  process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('worker/src/dashboard.mjs');

if (invokedDirectly) {
  const { url } = await startDashboard({ eventKey: process.argv[2] ?? '' });
  const schema = await checkSchema();
  console.error('dashboard on ' + url + (schema.ok ? '' : '  (database not migrated — see the banner)'));
  console.error('loopback only; reach it over AnyDesk, not over the network.');
}
