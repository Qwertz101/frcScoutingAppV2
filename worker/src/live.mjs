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
  rectifyToGray,
  recognizeTimer,
  SCORE_RECT_W,
  SCORE_RECT_H,
} from './core.mjs';
import { liveFrames } from './sources.mjs';
import { resolveLayout, eventQuads } from './layouts.mjs';
import { recognizeWindow } from './process.mjs';
import { voteTeams, matchBySet } from './identify.mjs';
import { scoreQuality } from './quality.mjs';
import { fetchQualSchedule } from './tba.mjs';
import { upsertCvLog, checkSchema } from './supabase.mjs';
import { createPool, defaultWorkers } from './ocr.mjs';
import { saveLocalLog } from './localLogs.mjs';
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
    return [...this.map.values()]
      .filter((f) => f.at >= from && f.at <= to)
      .sort((a, b) => a.at - b.at);
  }
  oldestAt() {
    let min = Infinity;
    for (const f of this.map.values()) min = Math.min(min, f.at);
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
  const teamShots = [];
  const rememberTeams = (f) => {
    if (f.at >= t0 + 20 && f.at <= t0 + MATCH_LEN - 10 &&
        (!teamShots.length || f.at - teamShots.at(-1).at >= 10)) teamShots.push(f);
  };
  let lastYielded = preroll.at(-1)?.at ?? windowFrom;

  async function* windowFrames() {
    for (const f of preroll) { rememberTeams(f); yield f; }

    // Borrow the shared iterator without calling return() at window end.
    // for-await would close the entire broadcast after the first match.
    for (;;) {
      const { value: f, done } = await source.next();
      if (done || signal?.aborted) return;
      ring.push(f);
      if (f.at <= lastYielded) continue; // already covered by the preroll slice
      const gap = gaps.overlaps(lastYielded, f.at);
      if (gap) throw new GapDuringWindow();
      lastYielded = f.at;
      if (f.at > windowTo) return;
      rememberTeams(f);
      yield f;
    }
  }

  try {
    const result = await recognizeWindow(windowFrames(), quads, { pool, t0 });
    if (signal?.aborted) return 'aborted';
    if (!result.diagnostics.finished) {
      log('incomplete match window: final score did not settle');
      return 'gap';
    }
    return { ...result, teamShots };
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

  const format = opts.format;
  const layout = opts.layout ?? resolveLayout(eventKey);
  log('source: ' + url);

  const schema = write ? await checkSchema().catch(() => ({ ok: false, message: 'Supabase unreachable' })) : null;
  if (write && !schema.ok) log('cannot write yet: ' + schema.message);

  const schedule = opts.schedule ?? (eventKey ? await fetchQualSchedule(eventKey).catch((e) => {
    log('match identification unavailable: ' + e.message + '; continuing OCR without assigning match keys');
    return null;
  }) : null);
  log(
    schedule
      ? eventKey + ': ' + schedule.length + ' qual matches on TBA'
      : eventKey
        ? eventKey + ': no schedule available; logs remain unidentified'
        : 'no --event given, matches will not be identified'
  );

  const pool = opts.pool ?? (await createPool(opts.workers ?? defaultWorkers()));
  const ownPool = !opts.pool;

  const gaps = new GapLog();
  const ring = new RingBuffer(RING_SECONDS);

  let clock = new MatchClock();
  const initialQuads = opts.quads ?? (opts.layout && opts.layout.name !== resolveLayout(eventKey).name ? null : eventQuads(eventKey));
  let quads = initialQuads;
  let overlayMissingAt = null;
  let matchesProcessed = 0;

  const resetForNextMatch = () => {
    clock = new MatchClock();
    quads = initialQuads;
    overlayMissingAt = null;
  };

  // `opts.frameSource` is the seam that lets this whole loop be exercised in
  // tests against real decoded footage without shelling out to a downloader --
  // see worker/tools/check-live-monitor.mjs. Production just leaves it unset
  // and gets the real reconnecting live source.
  const makeSource = opts.frameSource ?? liveFrames;
  opts.onSourceStatus?.('checking whether the stream is online');
  const source = makeSource(url, {
    ...opts,
    format,
    onGap: (g) => {
      gaps.record(g);
      log('gap: ' + g.seconds.toFixed(1) + 's starting at video t=' + g.start.toFixed(1));
    },
    onFormat: (f) => {
      opts.onSourceStatus?.('stream online — waiting for a match');
      opts.onFormat?.(f);
    },
    onReconnecting: (r) => {
      opts.onSourceStatus?.('stream unavailable — retrying automatically');
      log('reconnecting in ' + r.afterMs + 'ms (attempt ' + r.attempt + ')');
    },
    onError: (e) => {
      opts.onSourceStatus?.('stream unavailable — waiting for it to start');
      log('source error: ' + e.message);
    },
  });

  let framesSeen = 0;
  let lastHeartbeat = Date.now();

  try {
    for await (const frame of source) {
      if (opts.signal?.aborted) break;
      opts.onSourceStatus?.(clock.state.started ? 'match in progress' : 'stream online — waiting for a match');
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

      // Discover before testing colour: SoCal has RED on the left. A fixed
      // blue-left bootstrap prevented discovery entirely on this broadcast.
      if (!quads) {
        const shots = ring.slice(frame.at - QUAD_SAMPLES + 1, frame.at);
        if (shots.length >= 3) quads = detectScoreRegionsStable(shots, layout);
        if (quads) log('scoreboard located');
      }
      const present = quads && isOverlayPresent(frame, quads.blue, quads.red);
      if (present) overlayMissingAt = null;
      else {
        overlayMissingAt ??= frame.at;
        if (frame.at - overlayMissingAt > 5) resetForNextMatch();
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
      opts.onSourceStatus?.('match in progress — collecting scoreboard data');
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
        const teamShots = result.teamShots;
        if (teamShots.length >= 2) {
          const seen = await voteTeams(teamShots, quads, pool, {
            minVotes: LIVE_MIN_VOTES,
            layout,
          });
          ident = matchBySet(schedule, seen);
        } else {
          ident = { matchKey: null, method: 'none', reason: 'too few buffered frames to read team numbers' };
        }
      }

      const matchLog = {
        matchKey: ident?.matchKey ?? '',
        eventKey,
        samples,
        source: 'auto-worker - live: ' + url,
        video: { url, timeBase: frame.timeBase ?? 'source-media', greenFlagAt: t0 },
        createdAt: Date.now(),
      };

      const quality = scoreQuality(matchLog, diagnostics, ident);
      quality.signals.videoUrl = url;
      quality.signals.timeBase = matchLog.video.timeBase;
      quality.signals.greenFlagAt = diagnostics.greenFlagAt ?? t0;
      matchLog.video.greenFlagAt = diagnostics.greenFlagAt ?? t0;
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

      const localPath = await saveLocalLog(matchLog, opts.logDir);
      log('saved local match log: ' + localPath);
      let writeResult = { written: false, reason: 'dry run' };
      if (write && schema?.ok) {
        writeResult = await upsertCvLog(matchLog, { force }).catch((e) => ({
          written: false, reason: 'write failed: ' + e.message,
        }));
        if (!writeResult.written) log('  ! ' + writeResult.reason);
      }

      onMatch({ log: matchLog, quality, write: writeResult, localPath });
      resetForNextMatch();
      opts.onSourceStatus?.('stream online — waiting for the next match');
    }
  } finally {
    await source.return?.();
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
