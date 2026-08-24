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
 * Exactly two write endpoints exist, both of them things only a human can
 * decide: assigning a match key the worker refused to guess, and asking for a
 * reprocess.
 */

import { createServer } from 'node:http';
import { fetchCvLogs, isWorkerRow, checkSchema } from './supabase.mjs';

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
</style>
<h1>Capture worker</h1>
<div class="sub" id="sub">loading…</div>
<div id="banner"></div>
<div class="cards" id="cards"></div>
<div class="wrap"><table>
  <thead><tr>
    <th>Match</th><th>Final</th><th>Quality</th><th>Source</th><th>Notes</th><th></th>
  </tr></thead>
  <tbody id="rows"></tbody>
</table></div>
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

function render(s) {
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
      '<td><button data-reprocess="' + key + '">Reprocess</button></td>' +
      '</tr>';
  }).join('');

  for (const b of document.querySelectorAll('[data-reprocess]')) {
    b.onclick = async () => {
      b.disabled = true;
      b.textContent = 'queued';
      await fetch('/api/reprocess', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matchKey: b.dataset.reprocess }),
      });
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

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
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
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return send(res, 200, PAGE, 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        return send(res, 200, await getState());
      }
      if (req.method === 'POST' && url.pathname === '/api/assign') {
        const body = await readBody(req);
        if (!body.clipId || !body.matchKey) {
          return send(res, 400, { error: 'need clipId and matchKey' });
        }
        if (!opts.onAssign) return send(res, 501, { error: 'assign not wired up' });
        return send(res, 200, (await opts.onAssign(body)) ?? { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/reprocess') {
        const body = await readBody(req);
        if (!opts.onReprocess) return send(res, 501, { error: 'reprocess not wired up' });
        return send(res, 200, (await opts.onReprocess(body)) ?? { ok: true });
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      send(res, 500, { error: String(e.message ?? e) });
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
