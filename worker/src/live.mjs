/**
 * Watch a live stream and turn it into scored, identified match logs, forever.
 *
 * The VOD scanner (`scan.mjs`) exists because seeking a six-hour recording and
 * OCR-ing every second of it would take longer than the event did, so it works
 * in two tiers to spend OCR calls only where something is probably happening.
 * Live monitoring has no such problem: every frame arrives whether or not
 * anything is on screen, so the "coarse pass, then fine pass" split buys
 * nothing here. What live monitoring needs instead, and what a VOD never
 * does, is a way to read the FIRST few seconds of a match that were already
 * playing by the time the clock corroborated its own lock -- which is what the
 * ring buffer is for.
 *
 * **A match window that spans a reconnect gap is rejected outright, never
 * stitched.** A silently bridged gap produces a plausible-looking timeline
 * that is wrong; no data at all is a smaller failure than wrong data written
 * with confidence, and the whole M6 write path exists to avoid exactly that
 * class of mistake.
 *
 * Nothing is written to disk. Frames pass through a bounded in-memory ring
 * buffer and are discarded once a match window has consumed them or they have
 * aged out.
 */

import {
  MATCH_LEN,
  MatchClock,
  isOverlayPresent,
  detectScoreRegionsStable,
  rectQuad,
  rectifyToGray,
  recognizeTimer,
  SCORE_RECT_W,
  SCORE_RECT_H,
  FRC_BROADCAST,
} from './core.mjs';
import { liveFrames, probeLiveFormat } from './sources.mjs';
import { recognizeWindow } from './process.mjs';
import { voteTeams, matchBySet } from './identify.mjs';
import { scoreQuality } from './quality.mjs';
import { fetchQualSchedule } from './tba.mjs';
import { upsertCvLog, checkSchema } from './supabase.mjs';
import { createPool, defaultWorkers } from './ocr.mjs';
import { startDashboard } from './dashboard.mjs';

/** Lead-in kept before a locked green flag, matching the VOD path's PREROLL. */
const PREROLL = 20;
/** How long past the buzzer to keep reading. Same measured reason as process.mjs. */
const POSTROLL = 75;
/** Ring buffer horizon: PREROLL plus corroboration lag plus margin. */
const RING_SECONDS = 40;
/** Frames to sample for quad consensus once the overlay appears. */
const QUAD_SAMPLES = 7;
/**
 * Team-number votes needed before a number is believed.
 *
 * Lower than the VOD path's 5: identification samples whatever the ring
 * buffer still holds from the match, which can be fewer than 5 frames if the
 * lock happened close to the window's edge. Voting still separates a real
 * number (which shows up in nearly every sampled frame) from a logo fragment
 * (which does not), just with a smaller margin.
 */
const LIVE_MIN_VOTES = 3;

/**
 * A crude, wide net used only until the real quads are found.
 *
 * `isOverlayPresent` needs *some* quad to test colour under; before the first
 * `detectScoreRegionsStable` succeeds there is no real one yet. This is
 * deliberately generous -- roughly "somewhere in the top-left eighth of the
 * frame is blue, somewhere in the top-right eighth is red" -- because a false
 * positive here only triggers an extra (cheap) quad-detection attempt, while a
 * false negative would mean never looking for the scoreboard at all.
 */
const BOOTSTRAP_QUAD = {
  blue: rectQuad(0.05, 0.02, 0.45, 0.16),
  red: rectQuad(0.55, 0.02, 0.95, 0.16),
};

/**
 * A fixed-horizon, time-indexed frame buffer.
 *
 * Keyed by `Math.round(at)` rather than pushed as a plain array, because a
 * live source's frame rate is nominal, not exact -- two frames landing in the
 * same integer second should overwrite, not double up, matching exactly how
 * `recognizeWindow`'s own upsert-by-second behaves downstream.
 */
export class RingBuffer {
  constructor(seconds) {
    this.seconds = seconds;
    this.map = new Map();
  }
  push(frame) {
    this.map.set(Math.round(frame.at), frame);
    const cutoff = frame.at - this.seconds;
    for (const k of this.map.keys()) if (k < cutoff) this.map.delete(k);
  }
  get(at) {
    return this.map.get(Math.round(at));
  }
  /** Frames from `from` to `to` (inclusive), in order. Missing ones are skipped. */
  slice(from, to) {
    const out = [];
    for (let t = Math.ceil(from); t <= Math.floor(to); t++) {
      const f = this.map.get(t);
      if (f) out.push(f);
    }
    return out;
  }
  oldestAt() {
    let min = Infinity;
    for (const k of this.map.keys()) min = Math.min(min, k);
    return Number.isFinite(min) ? min : null;
  }
}

/** Recorded reconnect gaps, in the live source's video-timeline seconds. */
export class GapLog {
  constructor() {
    this.gaps = [];
  }
  record(g) {
    this.gaps.push(g);
  }
  /** Does any recorded gap fall inside [from, to]? */
  overlaps(from, to) {
    return this.gaps.find((g) => g.start < to && g.start + g.seconds > from) ?? null;
  }
}

/** Thrown from inside `windowFrames()` to signal a gap landed mid-window. */
export class GapDuringWindow extends Error {}

function readTimerGray(frame, quads) {
  const gray = rectifyToGray(frame, quads.timer, SCORE_RECT_W, SCORE_RECT_H);
  return gray ? { data: gray, width: SCORE_RECT_W, height: SCORE_RECT_H } : null;
}

/**
 * Feed `recognizeWindow` the buffered preroll immediately, then keep pulling
 * from the live source until the window closes -- pushing every frame into the
 * ring buffer along the way, exactly as the caller's own loop does, since this
 * temporarily takes over consuming `source`.
 */
export async function assembleAndProcess({ source, ring, gaps, quads, t0, windowFrom, windowTo, pool, signal, log }) {
  const preroll = ring.slice(windowFrom, windowTo);
  let lastYielded = preroll.at(-1)?.at ?? windowFrom;

  async function* windowFrames() {
    for (const f of preroll) yield f;

    for await (const f of source) {
      if (signal?.aborted) return;
      ring.push(f);
      if (f.at <= lastYielded) continue; // already covered by the preroll slice
      const gap = gaps.overlaps(lastYielded, f.at);
      if (gap) throw new GapDuringWindow();
      lastYielded = f.at;
      if (f.at > windowTo) return;
      yield f;
    }
  }

  try {
    return await recognizeWindow(windowFrames(), quads, { pool, t0 });
  } catch (e) {
    if (e instanceof GapDuringWindow) return 'gap';
    if (signal?.aborted) return 'aborted';
    log('error processing match window: ' + (e?.message ?? e));
    // Any hard failure is treated the same as a gap: reject and move on rather
    // than write a log built from a partial or corrupted read.
    return 'gap';
  }
}

/**
 * Watch one live source and process every match it shows.
 *
 * Runs until `opts.signal` aborts -- an event lasts hours, so "the stream
 * dropped" is retried forever rather than treated as the end of the run. See
 * `sources.mjs` for the reconnect/backoff behaviour that rests on.
 */
export async function monitorLive(url, opts = {}) {
  const write = Boolean(opts.write);
  const force = Boolean(opts.force);
  const eventKey = opts.eventKey ?? '';
  const log = opts.log ?? (() => {});
  const onMatch = opts.onMatch ?? (() => {});

  const format = opts.format ?? (await probeLiveFormat(url, opts));
  log('source: ' + format.platform + '  ' + format.width + 'x' + format.height + '  "' + format.title + '"');

  const schema = write ? await checkSchema().catch(() => ({ ok: false, message: 'Supabase unreachable' })) : null;
  if (write && !schema.ok) log('cannot write yet: ' + schema.message);

  const schedule = eventKey ? await fetchQualSchedule(eventKey) : null;
  log(
    schedule
      ? eventKey + ': ' + schedule.length + ' qual matches on TBA'
      : eventKey
        ? eventKey + ' not on TBA'
        : 'no --event given, matches will not be identified'
  );

  const pool = opts.pool ?? (await createPool(opts.workers ?? defaultWorkers()));
  const ownPool = !opts.pool;

  const gaps = new GapLog();
  const ring = new RingBuffer(RING_SECONDS);

  let clock = new MatchClock();
  let quads = null;
  let overlaySeenAt = null;
  let matchesProcessed = 0;

  const resetForNextMatch = () => {
    clock = new MatchClock();
    quads = null;
    overlaySeenAt = null;
  };

  // `opts.frameSource` is the seam that lets this whole loop be exercised in
  // tests against real decoded footage without shelling out to a downloader --
  // see worker/tools/check-live-monitor.mjs. Production just leaves it unset
  // and gets the real reconnecting live source.
  const makeSource = opts.frameSource ?? liveFrames;
  const source = makeSource(url, {
    ...opts,
    format,
    onGap: (g) => {
      gaps.record(g);
      log('gap: ' + g.seconds.toFixed(1) + 's starting at video t=' + g.start.toFixed(1));
    },
    onReconnecting: (r) => log('reconnecting in ' + r.afterMs + 'ms (attempt ' + r.attempt + ')'),
    onError: (e) => log('source error: ' + e.message),
  });

  let framesSeen = 0;
  let lastHeartbeat = Date.now();

  try {
    for await (const frame of source) {
      if (opts.signal?.aborted) break;
      ring.push(frame);
      framesSeen++;

      // Silence is the normal state for long stretches -- most of an event is
      // not a match. Without this, a scouting lead watching the dashboard has
      // no way to tell "quietly watching pre-show footage" from "hung", which
      // for an unattended process left running for hours is exactly the
      // distinction that matters.
      if (Date.now() - lastHeartbeat > 30000) {
        lastHeartbeat = Date.now();
        log('watching... ' + framesSeen + ' frames seen, video t=' + frame.at.toFixed(0) + (quads ? ' (scoreboard visible)' : ' (no scoreboard on screen)'));
      }

      const present = isOverlayPresent(frame, quads?.blue ?? BOOTSTRAP_QUAD.blue, quads?.red ?? BOOTSTRAP_QUAD.red);
      if (present && overlaySeenAt === null) overlaySeenAt = frame.at;
      if (!present) overlaySeenAt = null;

      // (Re)acquire quads once the overlay has been up for a moment. Cheap --
      // it only runs when there is a reason to, and the consensus check
      // rejects a single-frame fluke on its own.
      if (present && !quads) {
        const shots = ring.slice(frame.at - QUAD_SAMPLES + 1, frame.at);
        if (shots.length >= 3) {
          const found = detectScoreRegionsStable(shots, opts.layout ?? FRC_BROADCAST);
          if (found) {
            quads = found;
            log('scoreboard located');
          }
        }
      }

      if (!present || !quads) continue;

      // Timer-only read, exactly as the VOD scanner's fine pass does -- the
      // score plates are not worth paying for until the clock has actually
      // locked onto a real, ticking match.
      const gray = readTimerGray(frame, quads);
      const timer = gray ? await pool.run((w) => recognizeTimer(w, gray)) : null;
      clock.feed(timer ? timer.remaining : null, frame.at);

      if (!clock.state.started || clock.greenFlagAt === null) continue;

      const t0 = clock.greenFlagAt;
      const windowFrom = t0 - PREROLL;
      const windowTo = t0 + MATCH_LEN + POSTROLL;
      log('clock locked: green flag at video t=' + t0.toFixed(1));

      const gapBefore = gaps.overlaps(windowFrom, frame.at);
      if (gapBefore) {
        log(
          'REJECTED: match window spans a reconnect gap (' + gapBefore.seconds.toFixed(1) +
            's at t=' + gapBefore.start.toFixed(1) + ') -- no log written'
        );
        resetForNextMatch();
        continue;
      }

      const oldest = ring.oldestAt();
      if (oldest !== null && oldest > windowFrom + 1) {
        log(
          'note: ring buffer only reaches back to t=' + oldest.toFixed(1) +
            ' -- preroll is short by ' + (oldest - windowFrom).toFixed(1) + 's'
        );
      }

      const result = await assembleAndProcess({
        source, ring, gaps, quads, t0, windowFrom, windowTo, pool, signal: opts.signal, log,
      });

      if (result === 'gap') {
        log('REJECTED: a reconnect gap landed inside the match while it was still being read');
        resetForNextMatch();
        continue;
      }
      if (result === 'aborted') break;

      const { samples, rawReads, diagnostics } = result;

      let ident = null;
      if (schedule) {
        const teamShots = ring.slice(t0 + 20, t0 + MATCH_LEN - 10);
        if (teamShots.length >= 2) {
          const seen = await voteTeams(teamShots, quads, pool, { minVotes: LIVE_MIN_VOTES });
          ident = matchBySet(schedule, seen);
        } else {
          ident = { matchKey: null, method: 'none', reason: 'too few buffered frames to read team numbers' };
        }
      }

      const matchLog = {
        matchKey: ident?.matchKey ?? '',
        eventKey,
        samples,
        source: 'auto-worker - live: ' + format.title,
        createdAt: Date.now(),
      };

      const quality = scoreQuality(matchLog, diagnostics, ident);
      matchLog.quality = quality;
      matchLog.flagged = quality.flagged;
      matchLog.rawReads = rawReads;

      matchesProcessed++;
      const last = samples[samples.length - 1];
      log(
        '[' + matchesProcessed + '] ' + (matchLog.matchKey || 'UNIDENTIFIED') + '  ' +
          (last ? last.blue + '-' + last.red : 'n/a') + '  q=' + quality.score.toFixed(2) +
          (quality.flagged ? ' FLAGGED' : '')
      );

      let writeResult = { written: false, reason: 'dry run' };
      if (write && schema?.ok) {
        writeResult = await upsertCvLog(matchLog, { force });
        if (!writeResult.written) log('  ! ' + writeResult.reason);
      }

      onMatch({ log: matchLog, quality, write: writeResult });
      resetForNextMatch();
    }
  } finally {
    if (ownPool) await pool.terminate();
  }

  return { matchesProcessed };
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function flag(name, fallbackValue) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallbackValue;
}
const has = (name) => process.argv.includes('--' + name);

const invokedDirectly =
  process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('worker/src/live.mjs');

if (invokedDirectly) {
  const url = process.argv[2];
  if (!url) {
    console.error(
      'usage: node worker/src/live.mjs <url> --event 2026cagle [--write] [--force] [--no-dashboard]'
    );
    process.exit(1);
  }
  const eventKey = flag('event', '');
  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());

  /** What the dashboard shows -- same shape main.mjs's VOD run uses. */
  const state = { eventKey, at: Date.now(), unmigrated: false, unidentified: 0, rows: [] };

  if (!has('no-dashboard')) {
    const dash = await startDashboard({ eventKey, getState: async () => state });
    console.error('dashboard: ' + dash.url + '  (loopback only -- reach it over AnyDesk)');
  }

  await monitorLive(url, {
    eventKey,
    write: has('write'),
    force: has('force'),
    signal: controller.signal,
    log: (m) => {
      console.error(m);
      state.at = Date.now();
    },
    onMatch: ({ log, quality, write }) => {
      if (!log.matchKey) state.unidentified++;
      const last = log.samples[log.samples.length - 1];
      state.rows.unshift({
        match_key: log.matchKey,
        event_key: eventKey,
        source: log.source,
        quality,
        flagged: quality.flagged,
        final: last ? { blue: last.blue, red: last.red } : null,
        write: write.written ? (write.replaced ? 'replaced' : 'written') : write.reason,
        updated_at: new Date().toISOString(),
      });
      state.at = Date.now();
    },
  });
}
