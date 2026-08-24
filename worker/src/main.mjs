/**
 * The supervisor: one recording in, logs in Supabase out, nobody watching.
 *
 * This is the whole pipeline in the order it actually runs — scan for match
 * starts, process each one, work out which match it was, score how much to
 * trust it, and write it — with the dashboard serving live state alongside so
 * the scouting lead can see it happening over AnyDesk.
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
 */

import { scan } from './scan.mjs';
import { processMatch } from './process.mjs';
import { identify } from './identify.mjs';
import { scoreQuality } from './quality.mjs';
import { fetchQualSchedule } from './tba.mjs';
import { upsertCvLog, checkSchema } from './supabase.mjs';
import { startDashboard } from './dashboard.mjs';
import { probe } from './ffmpeg.mjs';
import { createPool, defaultWorkers } from './ocr.mjs';
import { isRemoteSource, resolveVodUrl } from './sources.mjs';
import { resolveLayout } from './layouts.mjs';

function flag(name, fallbackValue) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallbackValue;
}
const has = (name) => process.argv.includes('--' + name);

let input = process.argv[2];
if (!input || input.startsWith('--')) {
  console.error(
    'usage: node worker/src/main.mjs <video-or-youtube-url> --event <eventKey> ' +
      '[--start sec] [--duration sec] [--write] [--force] [--no-dashboard]'
  );
  process.exit(1);
}

const eventKey = flag('event', '');
const write = has('write');
const force = has('force');
const workers = Number(flag('workers', String(defaultWorkers())));
const scanStart = flag('start', null);
const scanDuration = flag('duration', null);
// Bound to the event, with --layout as an escape hatch for a broadcast whose
// event key is not yet in the table.
const layout = resolveLayout(eventKey, flag('layout', null));

// The resolved googlevideo URL is a kilobyte-long signed query string -- fine
// for ffmpeg, useless as a label. Every place this run identifies its source
// to a human (the dashboard, the log rows, the CvMatchLog itself) uses
// `sourceLabel`, never `input`, once resolution has happened.
const sourceLabel = input;
if (isRemoteSource(input)) {
  console.error('resolving direct URL for ' + input + ' ...');
  input = await resolveVodUrl(input);
  console.error('resolved');
}

/** What the dashboard shows. Mutated in place as the run proceeds. */
const state = {
  eventKey,
  at: Date.now(),
  unmigrated: false,
  unidentified: 0,
  source: { label: sourceLabel, status: 'starting' },
  rows: [],
};
const touch = () => (state.at = Date.now());

const log = (m) => {
  console.error(m);
  state.source.status = m;
  touch();
};

let dash = null;
if (!has('no-dashboard')) {
  dash = await startDashboard({ eventKey, getState: async () => state });
  console.error('dashboard: ' + dash.url + '  (loopback only — reach it over AnyDesk)');
}

const schema = await checkSchema().catch(() => ({ ok: false, message: 'Supabase unreachable' }));
state.unmigrated = !schema.ok;
if (write && !schema.ok) {
  console.error('\ncannot write: ' + schema.message);
  console.error('continuing as a dry run.\n');
}

const schedule = eventKey ? await fetchQualSchedule(eventKey) : null;
if (eventKey && !schedule) console.error('warning: ' + eventKey + ' not on TBA — matches cannot be identified');
else if (schedule) console.error(eventKey + ': ' + schedule.length + ' qual matches on TBA');

const meta = await probe(input);
console.error(sourceLabel + '  ' + meta.width + 'x' + meta.height + '  ' + (meta.duration / 60).toFixed(1) + ' min\n');

const pool = await createPool(workers);
const began = Date.now();

try {
  log('scanning for match starts…');
  const found = await scan(input, {
    pool,
    meta,
    layout,
    start: scanStart != null ? Number(scanStart) : undefined,
    duration: scanDuration != null ? Number(scanDuration) : undefined,
    log: (m) => console.error(m),
  });
  log(found.length + ' match(es) found');

  for (let i = 0; i < found.length; i++) {
    const f = found[i];
    const tag = '[' + (i + 1) + '/' + found.length + '] t0=' + f.greenFlagAt;

    log(tag + ' processing…');
    const out = await processMatch(input, f.greenFlagAt, {
      pool,
      meta,
      quads: f.quads,
      layout,
      eventKey,
      // The friendly label captured before URL resolution, not the resolved
      // googlevideo URL -- see the comment where sourceLabel is declared.
      sourceLabel: isRemoteSource(sourceLabel) ? sourceLabel : sourceLabel.split(/[\\/]/).pop(),
    });

    let ident = null;
    if (schedule) {
      log(tag + ' identifying…');
      ident = await identify(input, f.greenFlagAt, schedule, {
        pool, meta, quads: f.quads, layout,
      });
      if (ident.matchKey) out.log.matchKey = ident.matchKey;
    }

    const q = scoreQuality(out.log, out.diagnostics, ident);
    out.log.quality = q;
    out.log.flagged = q.flagged;
    out.log.rawReads = out.rawReads;

    const last = out.log.samples[out.log.samples.length - 1];
    const row = {
      match_key: out.log.matchKey || '',
      event_key: eventKey,
      source: out.log.source,
      quality: q,
      flagged: q.flagged,
      final: last ? { blue: last.blue, red: last.red } : null,
      updated_at: new Date().toISOString(),
    };

    if (!out.log.matchKey) state.unidentified++;

    if (write && schema.ok) {
      const res = await upsertCvLog(out.log, { force });
      row.write = res.written ? (res.replaced ? 'replaced' : 'written') : 'refused';
      if (!res.written) {
        row.quality = { ...q, reasons: [...q.reasons, res.reason] };
        row.flagged = true;
        console.error('    ! ' + res.reason);
      }
    } else {
      row.write = 'dry run';
    }

    state.rows.push(row);
    touch();

    console.error(
      '    ' + (out.log.matchKey || 'UNIDENTIFIED').padEnd(16) +
        (last ? last.blue + '-' + last.red : 'n/a').padEnd(10) +
        'q=' + q.score.toFixed(2) + (q.flagged ? ' FLAGGED' : '') + '  ' + row.write
    );
    for (const r of q.reasons) console.error('      - ' + r);
  }

  const flagged = state.rows.filter((r) => r.flagged).length;
  log('done');
  console.error(
    '\n' + state.rows.length + ' match(es) in ' + ((Date.now() - began) / 1000 / 60).toFixed(1) +
      ' min · ' + flagged + ' flagged · ' + state.unidentified + ' unidentified'
  );
  if (!write) console.error('dry run — nothing was written. Pass --write to persist.');
} finally {
  await pool.terminate();
}

if (dash) {
  console.error('\ndashboard still serving on ' + dash.url + ' — ctrl-c to stop.');
} else {
  process.exit(0);
}
