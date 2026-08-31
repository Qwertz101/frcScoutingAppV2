/**
 * One match window -> one `CvMatchLog`.
 *
 * This is the Node counterpart of `useCvTracker.sampleOnce`, and it is
 * deliberately the *same* recognition code: `readFrame`, `ScoreGate` and
 * `MatchClock` are imported from the compiled shared core, not reimplemented.
 * What is reimplemented here is only the orchestration -- how frames arrive,
 * and how the work is spread over cores -- because those are the two things
 * that genuinely differ between a browser tab and a workshop PC.
 *
 * The one structural rule:
 *
 *     OCR runs in parallel. The gate and the clock run strictly in order.
 *
 * Every frame is recognised from its own pixels alone, so recognition
 * parallelises freely. `ScoreGate` and `MatchClock` are stateful and order
 * dependent -- feeding them out of order would make the gate reject good
 * scores as backwards jumps, and the damage would look exactly like bad OCR
 * rather than like a scheduling bug. So the pool returns raw reads in input
 * order, and the stateful pass is a plain sequential loop over them.
 *
 *   node worker/src/process.mjs <video> --t0 <seconds> [--match qm1]
 */

import { writeFileSync } from 'node:fs';
import {
  MATCH_LEN,
  AUTO_LEN,
  MatchClock,
  ScoreGate,
  readFrame,
  detectScoreRegionsStable,
  FRC_BROADCAST,
} from './core.mjs';
import { frames, probe } from './ffmpeg.mjs';
import { isRemoteSource, resolveVodUrl } from './sources.mjs';
import { resolveLayout } from './layouts.mjs';
import { createPool, defaultWorkers } from './ocr.mjs';
import { scoreQuality } from './quality.mjs';

/** Consecutive unchanged post-buzzer seconds before the score is called final. */
const SETTLE_SECONDS = 6;
/** Readable frames with an unreadable clock before giving up on the clock. */
const TIMER_GIVE_UP_AFTER = 12;
/**
 * How long past the buzzer to keep reading.
 *
 * Measured, not guessed: on Einstein footage the overlay still read 641/420 at
 * 0:00 while TBA's final was 645/438 -- the scoreboard was still settling when
 * the clip ended. SETTLE_SECONDS needs six *unchanged* seconds, which a slow
 * endgame reveal pushes well past 30.
 */
const POSTROLL = 75;
/** Lead-in before the green flag, so the clock is already locked at t=0. */
const PREROLL = 20;

/* ------------------------------------------------------------------ *
 * Quads
 * ------------------------------------------------------------------ */

/**
 * Find the scoreboard by consensus across the match window.
 *
 * `detectScoreRegionsStable` wants frames that span time, not adjacent ones: it
 * exists to reject the lighting truss and the replay wipes, and seven
 * consecutive frames would agree about a replay wipe just as readily as about
 * a scoreboard.
 */
export async function findQuads(input, t0, meta, layout = FRC_BROADCAST) {
  const step = Math.max(4, Math.floor(MATCH_LEN / 7));
  const shots = [];

  for (let i = 0; i < 7; i++) {
    const at = t0 + 10 + i * step;
    if (meta.duration && at > meta.duration - 1) continue;
    for await (const f of frames(input, {
      start: at,
      duration: 1,
      fps: 1,
      width: meta.width,
      height: meta.height,
    })) {
      // Kept by value rather than by reference: these seven frames outlive
      // their iterators, and holding the yielded objects would also pin seven
      // ffmpeg child processes' worth of surrounding state.
      shots.push({ data: f.data, width: f.width, height: f.height });
      break;
    }
  }
  if (shots.length < 3) return null;
  return detectScoreRegionsStable(shots, layout);
}

/* ------------------------------------------------------------------ *
 * Processing
 * ------------------------------------------------------------------ */

/**
 * Read a match window and return a `CvMatchLog` plus the diagnostics M6 needs.
 *
 * `t0` is the green flag in video time. The window runs from `PREROLL` before
 * it to `POSTROLL` past the buzzer; the clock read out of the pixels decides
 * what is actually in the match, exactly as it does in the browser.
 */
export async function processMatch(input, t0, opts = {}) {
  const meta = opts.meta ?? (await probe(input));
  const quads = opts.quads ?? (await findQuads(input, t0, meta, opts.layout ?? FRC_BROADCAST));
  if (!quads) throw new Error('could not locate the scoreboard');

  const pool = opts.pool ?? (await createPool(opts.workers ?? defaultWorkers()));
  const ownPool = !opts.pool;

  const source = frames(input, {
    start: Math.max(0, t0 - PREROLL),
    duration: PREROLL + MATCH_LEN + POSTROLL,
    fps: 1,
    width: meta.width,
    height: meta.height,
  });

  const result = await recognizeWindow(source, quads, { pool, t0 });
  if (ownPool) await pool.terminate();

  return {
    log: {
      matchKey: opts.matchKey ?? '',
      eventKey: opts.eventKey ?? '',
      samples: result.samples,
      source: 'auto-worker - ' + (opts.sourceLabel ?? input),
      createdAt: Date.now(),
    },
    quads,
    rawReads: result.rawReads,
    diagnostics: { ...result.diagnostics, t0 },
  };
}

/**
 * Recognise one match window from a stream of frames.
 *
 * The part `processMatch` (a VOD's seek-and-decode window) and live monitoring
 * (a ring-buffered replay stitched to a real-time tail) have in common: once
 * there is a sequence of frames to look at, reading a match out of it is
 * identical either way. Only how the frames arrive differs, which is exactly
 * why this takes a bare async iterable rather than a video path.
 *
 * `source` frames must carry `.at` in a single consistent time base for this
 * call -- video-time for a VOD, wall-clock seconds-since-monitor-start for
 * live. `t0` is in that same base, and is used only as the fallback anchor if
 * the clock never locks.
 */
export async function recognizeWindow(source, quads, opts) {
  const { pool, t0 } = opts;

  /* ---- pass 1: recognise, in parallel, in order ---- */

  const reads = pool.ordered(source, async (worker, frame) => {
    // Throwaway gates. `readFrame` folds gating into recognition for the
    // browser's convenience, but gate state must not be built by whichever
    // pool worker happened to take the frame -- that would make the output
    // depend on scheduling. Only the raw reads are kept; the real gates are
    // fed sequentially below.
    const r = await readFrame(
      worker,
      frame,
      quads.blue,
      quads.red,
      quads.timer,
      new ScoreGate(),
      new ScoreGate()
    );
    if (!r) return null;
    return {
      at: frame.at,
      overlayPresent: r.overlayPresent,
      blueRaw: r.blueRaw,
      redRaw: r.redRaw,
      timer: {
        remaining: r.timer.remaining,
        text: r.timer.text,
        confidence: r.timer.confidence,
      },
    };
  });

  /* ---- pass 2: gate and clock, strictly sequential ---- */

  const clock = new MatchClock();
  const blueGate = new ScoreGate();
  const redGate = new ScoreGate();

  const samples = [];
  const rawReads = [];
  const settle = { blue: -1, red: -1, held: 0 };

  let fallback = false;
  let timerMisses = 0;
  let skipped = 0;
  let finished = false;

  for await (const r of reads) {
    if (!r) continue;
    if (!r.overlayPresent) {
      skipped++;
      continue;
    }

    const bg = blueGate.feed(r.blueRaw);
    const rg = redGate.feed(r.redRaw);
    const blue = bg.value;
    const red = rg.value;

    rawReads.push({
      at: Number(r.at.toFixed(3)),
      blueRaw: r.blueRaw.value,
      blueConf: r.blueRaw.confidence,
      redRaw: r.redRaw.value,
      redConf: r.redRaw.confidence,
      timerText: r.timer.text,
      timerRemaining: r.timer.remaining,
    });

    let sec;
    let phase;

    if (!fallback) {
      if (r.timer.remaining === null) timerMisses++;
      else timerMisses = 0;

      clock.feed(r.timer.remaining, r.at);
      const state = clock.state;

      if (!state.started) {
        if (timerMisses >= TIMER_GIVE_UP_AFTER) {
          // Unlike the browser there is no operator Start press to fall back
          // on, so the caller-supplied t0 becomes the anchor -- and this is
          // flagged, because that anchor is only as good as the scanner that
          // produced it.
          fallback = true;
        }
        continue;
      }

      phase = state.phase;
      sec = Math.round(clock.elapsedAt(r.at));

      if (state.ended) {
        if (blue === settle.blue && red === settle.red) {
          settle.held++;
        } else {
          settle.blue = blue;
          settle.red = red;
          settle.held = 0;
        }
        // Trailing points land on the final match second rather than on
        // invented times past the end, so downstream windows still close at
        // MATCH_LEN.
        sec = MATCH_LEN;
        finished = settle.held >= SETTLE_SECONDS;
      }
    } else {
      // Still feed the clock. Falling back is a decision about the frames seen
      // SO FAR, and it must not become a decision about the whole match --
      // measured on Sunset Showdown, a 26-frame unreadable stretch immediately
      // before a match tripped the give-up threshold by one frame, and two
      // frames later the clock was ticking perfectly for the entire match. The
      // scanner's t0 was right; the timing was thrown away anyway.
      clock.feed(r.timer.remaining, r.at);
      if (clock.state.started && clock.greenFlagAt !== null) {
        // The clock came back. It is strictly better than a fixed offset, so
        // take it over -- and re-time everything already collected onto its
        // green flag, since the two bases are not guaranteed to agree.
        fallback = false;
        timerMisses = 0;
        const green = clock.greenFlagAt;
        for (const smp of samples) smp.sec = Math.round(smp.at - green);
        for (let i = samples.length - 1; i >= 0; i--) {
          if (samples[i].sec < 0 || samples[i].sec > MATCH_LEN) samples.splice(i, 1);
        }
        phase = clock.state.phase;
        sec = Math.round(clock.elapsedAt(r.at));
      } else {
        sec = Math.floor(r.at - t0);
        if (sec < 0) continue;
        phase = sec < AUTO_LEN ? 'auto' : 'teleop';
        if (sec > MATCH_LEN) break;
        finished = sec >= MATCH_LEN;
      }
    }

    // Upsert: sampling once per video second against a clock read from the
    // pixels means two frames can land in the same match second, and after the
    // buzzer many do. The later read is the better one.
    const idx = samples.findIndex((s) => s.sec === sec);
    // `at` is carried so a late clock recovery can re-time what came before it;
    // it is stripped before the log is returned.
    const row = { sec, phase, blue, red, db: 0, dr: 0, at: r.at };
    if (idx >= 0) samples[idx] = row;
    else samples.push(row);

    if (finished) break;
  }

  // Deltas are rebuilt wholesale from the score series rather than accumulated
  // as we go: with upserts in play, an incrementally maintained delta stops
  // agreeing with the scores it is supposed to describe.
  samples.sort((a, b) => a.sec - b.sec);
  let pb = 0;
  let pr = 0;
  for (const s of samples) {
    s.db = Math.max(0, s.blue - pb);
    s.dr = Math.max(0, s.red - pr);
    pb = s.blue;
    pr = s.red;
  }

  for (const smp of samples) delete smp.at;

  return {
    samples,
    rawReads,
    diagnostics: {
      skipped,
      timerFallback: fallback,
      timerAccepted: clock.accepted,
      timerOffered: clock.offered,
      blueRejections: blueGate.rejections,
      redRejections: redGate.rejections,
      blueOffered: blueGate.offered,
      redOffered: redGate.offered,
      blueResyncs: blueGate.resyncs,
      redResyncs: redGate.resyncs,
      coverage: samples.length / (MATCH_LEN + 1),
      finished,
    },
  };
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function flag(name, fallbackValue) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallbackValue;
}

const invokedDirectly =
  process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('worker/src/process.mjs');

if (invokedDirectly) {
  let input = process.argv[2];
  if (!input) {
    console.error(
      'usage: node worker/src/process.mjs <video> --t0 <seconds> [--match qm1] [--out log.json]'
    );
    process.exit(1);
  }
  const t0 = Number(flag('t0', '0'));
  const workers = Number(flag('workers', String(defaultWorkers())));
  const eventKey = flag('event', '');
  const layout = resolveLayout(eventKey, flag('layout', null));

  // A YouTube page URL works here exactly as it does in main.mjs -- debugging
  // one match of a real broadcast should not require staging a local file.
  const label = input;
  if (isRemoteSource(input)) input = await resolveVodUrl(input);

  const began = Date.now();
  const meta = await probe(input);
  console.error(
    input + '  ' + meta.width + 'x' + meta.height + '  ' + meta.duration.toFixed(1) + 's  |  ' +
      workers + ' OCR workers'
  );

  const out = await processMatch(input, t0, {
    workers,
    layout,
    matchKey: flag('match', ''),
    eventKey,
    sourceLabel: label.split(/[\\/]/).pop(),
  });

  const d = out.diagnostics;
  const last = out.log.samples[out.log.samples.length - 1];
  console.error(
    '\n' + out.log.samples.length + ' samples  |  final ' +
      (last ? last.blue + '-' + last.red : 'n/a') + '  |  clock ' +
      d.timerAccepted + '/' + d.timerOffered + '  |  rejections ' +
      d.blueRejections + '/' + d.redRejections + '  |  skipped ' + d.skipped +
      '  |  ' + ((Date.now() - began) / 1000).toFixed(1) + 's wall'
  );

  const q = scoreQuality(out.log, d);
  console.error('quality ' + q.score.toFixed(2) + (q.flagged ? '  FLAGGED' : ''));
  for (const r of q.reasons) console.error('  - ' + r);

  const dest = flag('out', null);
  const payload = JSON.stringify(
    { ...out.log, quality: q, flagged: q.flagged, diagnostics: d, rawReads: out.rawReads },
    null,
    2
  );
  if (dest) {
    writeFileSync(dest, payload);
    console.error('wrote ' + dest);
  } else {
    console.log(payload);
  }
}
