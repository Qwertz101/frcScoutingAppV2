/**
 * The one-shot CLI: one recording in, logs in Supabase out, nobody watching.
 *
 *   node worker/src/main.mjs <video> --event 2026cagle            # dry run
 *   node worker/src/main.mjs <video> --event 2026cagle --write    # actually write
 *
 * `<video>` can be a local file OR a finished YouTube VOD's page URL --
 * `resolveVodUrl` (sources.mjs) resolves it to a direct, byte-range-servable
 * CDN URL first, and everything downstream (scan, process, identify) treats
 * it exactly like a local file, because ffmpeg does. That is a genuinely
 * different code path from `live.mjs`: this one can seek, so the same
 * two-tier scanner that makes a six-hour local VOD affordable applies
 * unchanged to a multi-hour YouTube recording. `live.mjs` is for a broadcast
 * still in progress, which cannot be seeked because there is nothing yet to
 * seek into.
 *
 * `--start`/`--duration` bound the scan to a known window (seconds into the
 * video). Worth using on a long recording once you know roughly where the
 * matches you care about are -- scanning is colour-only and cheap per frame,
 * but a multi-hour window still means multi-hour worth of network bytes to
 * fetch and decode.
 *
 * **Dry by default.** Writing is opt-in because `match_key` is a primary key
 * and an upsert replaces whatever is there; a flag you have to type is a cheap
 * way to make sure nobody discovers that by accident.
 *
 * For match day, prefer `worker/src/server.mjs` -- same pipeline, but running
 * in the background so the scouting lead can start a capture from the app's CV
 * tab instead of a shell.
 */

import { runVod } from './run.mjs';
import { startDashboard } from './dashboard.mjs';
import { resolveLayout } from './layouts.mjs';
import { defaultWorkers } from './ocr.mjs';

function flag(name, fallbackValue) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallbackValue;
}
const has = (name) => process.argv.includes('--' + name);

const input = process.argv[2];
if (!input || input.startsWith('--')) {
  console.error(
    'usage: node worker/src/main.mjs <video-or-youtube-url> --event <eventKey> ' +
      '[--start sec] [--duration sec] [--download] [--keep-download] [--write] [--force] [--no-dashboard]'
  );
  process.exit(1);
}

const eventKey = flag('event', '');
const write = has('write');
const layout = resolveLayout(eventKey, flag('layout', null));

/** What the dashboard shows. Mutated in place as the run proceeds. */
const state = {
  eventKey,
  at: Date.now(),
  unmigrated: false,
  unidentified: 0,
  allowWrite: write,
  source: { label: input, status: 'starting' },
  job: null,
  logLines: [],
  rows: [],
};

const log = (m) => {
  console.error(m);
  state.source.status = m;
  state.logLines.push(m);
  if (state.logLines.length > 500) state.logLines.shift();
  state.at = Date.now();
};

let dash = null;
if (!has('no-dashboard')) {
  dash = await startDashboard({ eventKey, getState: async () => state });
  console.error('dashboard: ' + dash.url + '  (loopback only — reach it over AnyDesk)');
}

const res = await runVod(input, {
  eventKey,
  write,
  force: has('force'),
  workers: Number(flag('workers', String(defaultWorkers()))),
  start: flag('start', null),
  duration: flag('duration', null),
  download: has('download'),
  keepDownload: has('keep-download'),
  layout,
  log,
  onSchema: (s) => {
    state.unmigrated = !s.ok;
  },
  onRow: (row) => {
    state.rows.push(row);
    if (!row.match_key) state.unidentified++;
    state.at = Date.now();
  },
});

if (!write) console.error('Pass --write to persist.');
if (res.matches === 0) console.error('No matches were found — check --start/--duration and --event.');

if (dash) {
  console.error('\ndashboard still serving on ' + dash.url + ' — ctrl-c to stop.');
} else {
  process.exit(0);
}
