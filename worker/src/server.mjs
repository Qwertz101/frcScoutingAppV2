/**
 * The always-on worker: paste a link in the app, this reads the match.
 *
 * Until now the pipeline was only reachable by typing a command. That is fine
 * for debugging one broadcast and wrong for match day, where the person who
 * needs to start a capture is the scouting lead with the app open, not someone
 * at a shell. So this runs in the background all event, and the CV tab's link
 * box POSTs to it.
 *
 *   node worker/src/server.mjs --event 2026cagle
 *   node worker/src/server.mjs --event 2026cagle --write
 *
 * **One job at a time, deliberately.** OCR already saturates the machine's
 * cores, and two concurrent runs would not go faster — they would go slower and
 * make the dashboard incomprehensible. A second submission while one is running
 * is refused with a clear message rather than queued, because at an event the
 * right answer to "it's already running" is almost always to wait, not to line
 * something up behind it.
 *
 * **Still loopback-only, and still dry unless told otherwise.** See
 * `dashboard.mjs` on why the bind address is a security boundary. `--write` is
 * the server-wide default for jobs; a job can ask for a dry run regardless, but
 * it cannot turn writing *on* if the server was not started with it. That
 * asymmetry is on purpose: a web form should not be able to escalate what the
 * process was launched to be allowed to do.
 */

import { startDashboard } from './dashboard.mjs';
import { runVod, reprocessOne } from './run.mjs';
import { monitorLive } from './live.mjs';
import { resolveLayout } from './layouts.mjs';
import { isRemoteSource, detectPlatform, resolveVodUrl } from './sources.mjs';
import { probe, grabJpegs } from './ffmpeg.mjs';
import { createPool, defaultWorkers } from './ocr.mjs';
import { checkSchema, fetchCvLogs } from './supabase.mjs';

function flag(name, fallbackValue) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallbackValue;
}
const has = (name) => process.argv.includes('--' + name);

const defaultEventKey = flag('event', '');
const allowWrite = has('write');
const allowForce = has('force');
const workers = Number(flag('workers', String(defaultWorkers())));
// Lets a second worker run alongside one already serving -- useful for trying a
// change without stopping a capture someone else is watching.
const port = Number(flag('port', '7654'));

/** How many log lines to keep. Enough to see a whole run, bounded so an
 *  all-day process cannot grow without limit. */
const LOG_LIMIT = 500;

const state = {
  eventKey: defaultEventKey,
  at: Date.now(),
  unmigrated: false,
  unidentified: 0,
  allowWrite,
  source: { label: 'idle', status: 'waiting for a link' },
  job: null,
  logLines: [],
  rows: [],
};

const touch = () => (state.at = Date.now());

function log(line) {
  const stamped = new Date().toLocaleTimeString() + '  ' + line;
  console.error(line);
  state.logLines.push(stamped);
  if (state.logLines.length > LOG_LIMIT) state.logLines.splice(0, state.logLines.length - LOG_LIMIT);
  if (state.job) state.job.lastLine = line;
  touch();
}

/** The one running job, or null. */
let current = null;

function jobView() {
  if (!state.job) return null;
  return { ...state.job };
}

/**
 * Decide how to read a link.
 *
 * A YouTube URL can be either a finished VOD (seekable, so the cheap two-tier
 * scanner applies) or a broadcast still in progress (forward-only, so the live
 * monitor applies). Those are genuinely different code paths, and no amount of
 * inspecting the URL tells them apart reliably — `/watch?v=` is used for both.
 * So `mode` is asked for rather than guessed, defaulting to `vod` because that
 * is both the commoner case and the safe one to be wrong about: pointing the
 * VOD path at a live stream fails quickly and loudly, whereas pointing the live
 * monitor at a finished recording quietly reads it at download speed and
 * produces a timeline that is neither live nor seekable.
 */
function normalizeMode(mode) {
  const m = String(mode ?? 'vod').toLowerCase();
  if (m !== 'vod' && m !== 'live') throw new Error('mode must be "vod" or "live"');
  return m;
}

async function startJob(body) {
  if (current) throw new Error('a capture is already running — cancel it first');

  const url = String(body.url ?? '').trim();
  if (!url) throw new Error('need a url');
  if (isRemoteSource(url)) detectPlatform(url); // throws with a clear message if unsupported

  const mode = normalizeMode(body.mode);
  const eventKey = String(body.eventKey ?? defaultEventKey ?? '').trim();
  // A job may decline to write; it may not grant itself permission to. See the
  // header.
  const write = allowWrite && body.write !== false;
  const layout = resolveLayout(eventKey, body.layout ?? null);

  if (mode === 'live' && detectPlatform(url) === 'twitch') {
    log(
      'note: Twitch live capture has never been run against a real broadcast — ' +
        'it is built but unproven. Expect to babysit this one.'
    );
  }

  const controller = new AbortController();
  const job = {
    id: String(Date.now()),
    url,
    mode,
    eventKey,
    write,
    download: Boolean(body.download),
    keepDownload: Boolean(body.keepDownload),
    layout: layout?.name ?? null,
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
    lastLine: '',
    progress: null,
    matches: 0,
  };

  state.job = job;
  state.rows = [];
  state.unidentified = 0;
  state.logLines = [];
  state.source = { label: url, status: mode === 'live' ? 'watching live' : 'reading recording' };
  touch();

  log(
    'starting ' + mode + ' capture: ' + url +
      (eventKey ? '  event=' + eventKey : '  (no event — matches cannot be identified)') +
      (write ? '  WRITING' : '  (dry run)')
  );

  const pool = await createPool(workers);

  const finish = (status, error) => {
    job.status = status;
    job.error = error ? String(error.message ?? error) : null;
    job.finishedAt = Date.now();
    state.source.status = status === 'done' ? 'finished' : status;
    current = null;
    touch();
  };

  const work = (async () => {
    try {
      if (mode === 'vod') {
        const res = await runVod(url, {
          eventKey, write, force: allowForce, layout, pool,
          signal: controller.signal,
          start: body.start, duration: body.duration,
          download: Boolean(body.download),
          keepDownload: Boolean(body.keepDownload),
          log,
          onSchema: (s) => {
            state.unmigrated = !s.ok;
          },
          onProgress: (p) => {
            job.progress = p;
            touch();
          },
          onRow: (row) => {
            state.rows.push(row);
            job.matches = state.rows.length;
            if (!row.match_key) state.unidentified++;
            touch();
          },
        });
        job.matches = res.matches;
      } else {
        await monitorLive(url, {
          eventKey, write, force: allowForce, layout, pool,
          signal: controller.signal,
          log,
          onMatch: ({ log: matchLog, quality, write: w }) => {
            const last = matchLog.samples[matchLog.samples.length - 1];
            const row = {
              match_key: matchLog.matchKey || '',
              event_key: eventKey,
              source: matchLog.source,
              quality,
              flagged: quality.flagged,
              final: last ? { blue: last.blue, red: last.red } : null,
              write: w.written ? 'written' : w.reason,
              updated_at: new Date().toISOString(),
            };
            state.rows.push(row);
            job.matches = state.rows.length;
            if (!row.match_key) state.unidentified++;
            touch();
          },
        });
      }
      finish(controller.signal.aborted ? 'cancelled' : 'done');
      log(controller.signal.aborted ? 'cancelled' : 'finished');
    } catch (e) {
      log('FAILED: ' + (e.message ?? e));
      finish('error', e);
    } finally {
      await pool.terminate().catch(() => {});
    }
  })();

  current = { job, controller, work };
  return jobView();
}

function cancelJob() {
  if (!current) throw new Error('nothing is running');
  log('cancelling…');
  current.controller.abort();
  current.job.status = 'cancelling';
  touch();
  return jobView();
}

/**
 * Re-read one match. Only meaningful for a recording — a live stream's frames
 * are long gone by the time anyone clicks the button, which is the cost of
 * never writing video to disk and is worth it.
 */
async function reprocess(body) {
  if (current) throw new Error('a capture is already running — wait for it to finish');

  const row = state.rows.find((r) => r.match_key === body.matchKey);
  const url = body.url ?? state.job?.url;
  const greenFlagAt = body.greenFlagAt ?? row?.greenFlagAt;

  if (!url) throw new Error('nothing has been captured yet, so there is nothing to reprocess');
  if (state.job?.mode === 'live') {
    throw new Error('a live capture cannot be reprocessed — its frames were never stored');
  }
  if (greenFlagAt == null) {
    throw new Error('no green-flag time recorded for ' + (body.matchKey || 'that match'));
  }

  log('reprocessing ' + (body.matchKey || 't0=' + greenFlagAt) + ' …');
  const res = await reprocessOne(url, Number(greenFlagAt), {
    eventKey: state.job?.eventKey ?? defaultEventKey,
    matchKey: body.matchKey || undefined,
    write: allowWrite && body.write !== false,
    force: allowForce,
    workers,
    log,
  });

  if (row) {
    const last = res.log.samples[res.log.samples.length - 1];
    row.quality = res.quality;
    row.flagged = res.quality.flagged;
    row.final = last ? { blue: last.blue, red: last.red } : null;
    row.write = res.write.written ? 'written' : res.write.reason;
    row.updated_at = new Date().toISOString();
  }
  touch();
  return { ok: true, matchKey: res.log.matchKey, quality: res.quality };
}

/**
 * Frames for the layout calibrator.
 *
 * The browser cannot read a YouTube page pixel-by-pixel, so a person
 * calibrating against a stream or VOD has to be shown frames from here, where
 * ffmpeg already has the video open. Spread across the middle of the recording
 * rather than clustered: calibration has to hold on more than one frame, and
 * frames a few seconds apart all show the same moment of the same match.
 *
 * Refused while a capture is running -- the OCR pool already has the machine,
 * and seeking a remote VOD alongside it would slow both.
 */
async function grabFrames(body) {
  if (current) throw new Error('a capture is running — wait for it to finish, then grab frames');

  const url = String(body.url ?? '').trim();
  if (!url) throw new Error('need a url');

  const count = Math.min(12, Math.max(1, Number(body.count) || 6));
  let input = url;
  if (isRemoteSource(url)) {
    detectPlatform(url);
    log('resolving ' + url + ' for calibration frames…');
    input = await resolveVodUrl(url);
  }

  const meta = await probe(input);

  // Explicit timestamps win over an even spread, because an even spread is a
  // guess and these are not. Most of an event is NOT a match -- crowd shots,
  // sponsor cards, the post-match results graphic -- so sampling evenly across
  // a window routinely returns six frames with no live scoreboard in any of
  // them, and there is then nothing for a person to calibrate against. When
  // someone has found the moment they want, take it.
  const times = [];
  if (Array.isArray(body.times) && body.times.length) {
    for (const t of body.times.slice(0, 12)) {
      const n = Number(t);
      if (Number.isFinite(n) && n >= 0) times.push(Math.min(n, Math.max(0, meta.duration - 0.5)));
    }
  }
  if (!times.length) {
    const from = body.start != null ? Number(body.start) : meta.duration * 0.1;
    const span =
      body.duration != null ? Number(body.duration) : Math.max(1, meta.duration * 0.8);
    for (let i = 0; i < count; i++) times.push(from + (span * i) / Math.max(1, count - 1));
  }

  log('grabbing ' + times.length + ' calibration frame(s)…');
  const shots = await grabJpegs(input, times, { width: Math.min(1280, meta.width) });
  log('grabbed ' + shots.length + ' frame(s)');

  return {
    frames: shots,
    frameSize: { width: meta.width, height: meta.height },
    duration: meta.duration,
  };
}

/* ------------------------------------------------------------------ *
 * Serve
 * ------------------------------------------------------------------ */

const schema = await checkSchema().catch(() => ({ ok: false, message: 'Supabase unreachable' }));
state.unmigrated = !schema.ok;
if (allowWrite && !schema.ok) {
  console.error('warning: --write was passed but ' + schema.message);
  console.error('jobs will run as dry runs until that is fixed.\n');
}

// Before any job has run, show whatever is already in the database — the same
// thing a bare `node worker/src/dashboard.mjs` shows. Otherwise the page is
// blank on a fresh start and looks broken rather than idle.
const seeded = await fetchCvLogs(defaultEventKey).catch(() => []);
state.rows = seeded;

const dash = await startDashboard({
  port,
  eventKey: defaultEventKey,
  getState: async () => ({ ...state, job: jobView() }),
  onSubmitJob: startJob,
  onCancelJob: async () => cancelJob(),
  onReprocess: reprocess,
  onFrames: grabFrames,
});

console.error('capture worker ready on ' + dash.url);
console.error('  · paste a link in the app\'s CV tab, or use the form on that page');
console.error('  · ' + (allowWrite ? 'WRITING to Supabase' : 'dry run — pass --write to persist'));
console.error('  · loopback only; reach it over AnyDesk, not over the network.');
