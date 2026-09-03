/**
 * Find where matches start inside a long recording.
 *
 * The cost problem this exists to solve: tesseract is roughly 1s per call and a
 * six-hour event VOD is 21,600 seconds. OCR-ing every second to look for a
 * countdown would take longer than the event did. So the search is split, and
 * the expensive half only ever runs where the cheap half has already found
 * something.
 *
 * Tier A -- colour only, no OCR at all. Downscaled to 640 wide and sampled
 * every two seconds, `detectScoreRegions` costs ~3ms a frame, so a whole event
 * scans in well under a minute of CPU. It cannot tell you *when* a match
 * started, only that the scoreboard overlay is on screen, which is enough to
 * reduce six hours to a handful of candidate runs.
 *
 * Tier B -- timer OCR, and only the timer: the two score plates are skipped
 * entirely. A coarse pass looks for a *fresh* clock (near 0:20 for AUTO, near
 * 2:20 for the post-AUTO reset) to bracket the start, then a fine pass at 1fps
 * feeds a real `MatchClock` until it locks on and reports its green flag.
 *
 * That is ~40 recognize calls per match, paid ~80 times an event, instead of
 * 21,600.
 */

import {
  MATCH_LEN,
  AUTO_LEN,
  TELEOP_LEN,
  MatchClock,
  detectScoreRegions,
  detectScoreRegionsStable,
  isOverlayPresent,
  recognizeTimer,
  rectifyToGray,
  FRC_BROADCAST,
  SCORE_RECT_W,
  SCORE_RECT_H,
} from './core.mjs';
import { frames, probe } from './ffmpeg.mjs';
import { createPool } from './ocr.mjs';

/* ---- Tier A ---- */

/** Frame width for the colour pass. Detection measured 100% at 480 and above. */
const SCAN_WIDTH = 640;
/** Colour-pass sample rate. A match holds the overlay 163s; 2s is ample. */
const SCAN_FPS = 0.5;
/**
 * Shortest run that could be a match.
 *
 * A match holds the scoreboard for 163 seconds. Replays, score-reveal graphics
 * and sponsor bumpers show alliance colours for a few seconds at a time, and
 * this is what separates them.
 */
const MIN_RUN = 60;
/**
 * Gaps shorter than this are bridged rather than treated as two runs.
 *
 * Broadcasts cut away mid-match -- a replay, a pit reporter, a crowd reaction --
 * and without this a single match arrives as three candidate fragments, none of
 * them long enough to survive MIN_RUN.
 */
const MERGE_GAP = 20;

/* ---- Tier B ---- */

/** Coarse bracketing rate: one look every five seconds. */
const COARSE_FPS = 0.2;
/** A clock this close to 0:20 is AUTO that has only just begun. */
const FRESH_AUTO = [15, AUTO_LEN];
/** A clock this close to 2:20 is the post-AUTO reset, not a mid-match reading. */
const FRESH_TELEOP = [TELEOP_LEN - 10, TELEOP_LEN + 5];
/** How far before the bracket the fine pass starts. */
const FINE_LEAD = 25;
/** How long the fine pass will look for a lock before giving up. */
const FINE_SPAN = 60;
/**
 * Shortest overlay run that may be *guessed* to be a match, when no clock
 * locked. MIN_RUN answers "is the overlay up"; this answers the much stronger
 * "could a whole match have happened here", so it is tied to the match length
 * rather than to visibility. Set below MATCH_LEN because a run legitimately
 * starts late when the broadcast cuts away over a green flag -- measured on
 * IRI, real matches sat in runs of 136s and up, while the false ones were 92s
 * and 60s.
 */
const MIN_GUESS_RUN = Math.round(MATCH_LEN * 0.75);

/**
 * Read only the match clock out of a frame.
 *
 * Deliberately not `readFrame`: during scanning the scores are irrelevant, and
 * skipping them removes two thirds of the OCR cost of every sample.
 */
async function readTimer(worker, frame, timerQuad) {
  const gray = rectifyToGray(frame, timerQuad, SCORE_RECT_W, SCORE_RECT_H);
  if (!gray) return null;
  return recognizeTimer(worker, { data: gray, width: SCORE_RECT_W, height: SCORE_RECT_H });
}

/* ------------------------------------------------------------------ *
 * Tier A
 * ------------------------------------------------------------------ */

/**
 * Runs of video during which the scoreboard overlay is on screen.
 *
 * Returns `[{ start, end }]` in seconds of video time.
 */
export async function findOverlayRuns(input, opts = {}) {
  const meta = opts.meta ?? (await probe(input));
  const layout = opts.layout ?? FRC_BROADCAST;
  const fps = opts.fps ?? SCAN_FPS;
  const onProgress = opts.onProgress;
  const fixedQuads = opts.fixedQuads ?? null;
  const log = opts.log ?? (() => {});

  const runs = [];
  let open = null;
  let lastSeen = -1;
  let n = 0;
  /** Furthest point actually decoded, which is not the same as what was asked for. */
  let reached = null;

  for await (const f of frames(input, {
    fps,
    scaleWidth: SCAN_WIDTH,
    width: meta.width,
    height: meta.height,
    start: opts.start ?? 0,
    duration: opts.duration,
  })) {
    // Tier A is the long pass — hours of frames on a full event recording — so
    // it is the one place where "stop" has to mean stop promptly rather than at
    // the end. Breaking out closes the frame iterator, which kills ffmpeg.
    if (opts.signal?.aborted) break;

    // Geometry, then colour. `detectScoreRegions` asks "is there something
    // shaped like a scoreboard here", which a gym wall can answer yes to: the
    // championship banners above the bleachers at Sunset Showdown are red and
    // blue blocks with a pale gap between them, and they pass every shape test
    // because they genuinely are that shape. `isOverlayPresent` then asks
    // whether the plates are actually *filled* with alliance colour, which a
    // banner half a frame away and washed out by arena lighting is not.
    //
    // Worth the extra work per frame because of what it saves downstream: a
    // false run costs a full Tier B bracket plus a whole match's OCR before the
    // quality score rejects it, measured at 20 minutes against a remote VOD.
    // The guards further down did catch it — nothing wrong was written — but
    // catching it here means not paying for it at all.
    // With a taught layout the plates are already known, so this reduces to
    // "are those two boxes filled with alliance colour" -- no geometry search
    // at all, and none of the ways that search can pick the wrong thing.
    let present;
    if (fixedQuads) {
      present = isOverlayPresent(f, fixedQuads.blue, fixedQuads.red);
    } else {
      const regions = detectScoreRegions(f, layout);
      present = regions !== null && isOverlayPresent(f, regions.blue, regions.red);
    }
    n++;
    reached = f.at;
    if (onProgress && n % 100 === 0) onProgress(f.at, meta.duration);

    if (present) {
      if (open && f.at - lastSeen <= MERGE_GAP) {
        // Bridge the cutaway rather than closing the run: see MERGE_GAP.
        open.end = f.at;
      } else {
        if (open) runs.push(open);
        open = { start: f.at, end: f.at };
      }
      lastSeen = f.at;
    }
  }
  if (open) runs.push(open);

  // How much of the window was actually looked at.
  //
  // ffmpeg can end a remote read early and exit cleanly -- the connection
  // drops, the server stops serving, the signed URL is throttled -- and the
  // frame iterator then simply stops yielding, which is indistinguishable from
  // having reached the end of the window. Everything downstream reports success
  // over whatever fraction happened to arrive.
  //
  // Measured against a 9.1-hour recording: a 6900-second window scanned this
  // way covered about 400 seconds before the read ended, and the job logged
  // "0 match(es) found ... finished" with nothing to suggest it had seen 6% of
  // what it was asked to look at. A silent partial scan of an event is worse
  // than a failed one, because a failed one gets retried.
  const from = opts.start ?? 0;
  const to = opts.duration != null ? from + Number(opts.duration) : meta.duration;
  const end = Math.min(to, meta.duration);
  const shortfall = end - (reached ?? from);
  const slack = Math.max(30, 4 / fps);
  if (shortfall > slack) {
    const pct = Math.max(0, (((reached ?? from) - from) / Math.max(1, end - from)) * 100);
    log(
      'WARNING: the scan ended early — covered ' + pct.toFixed(0) + '% of the requested window (' +
        'reached ' + (reached ?? from).toFixed(0) + 's of ' + end.toFixed(0) + 's). ' +
        'Any match in the rest of it was never looked at. This is usually a dropped or throttled ' +
        'remote read; downloading the window first avoids it.'
    );
  }

  return runs.filter((r) => r.end - r.start >= MIN_RUN);
}

/* ------------------------------------------------------------------ *
 * Tier B
 * ------------------------------------------------------------------ */

/**
 * Full-resolution quads by consensus over a window.
 *
 * Deliberately taken over a window the length of a match rather than over a
 * whole run. A run can span several matches, and the overlay does not have to
 * be in the same place across all of them — a broadcast that switches feed, or
 * a recording spliced from more than one source, moves it. Averaging across the
 * lot yields a consensus that fits none of them, and the failure is quiet: the
 * quads still look plausible, the clock simply never locks.
 */
async function quadsForWindow(input, from, to, meta, layout = FRC_BROADCAST, fixedQuads = null) {
  // A calibrated layout already answers this, and answers it the same way for
  // every window -- so skip the seven seeks entirely. That is most of Tier B's
  // cost on a remote VOD, and it removes the case where consensus fails on a
  // window that happens to span a replay.
  if (fixedQuads) return fixedQuads;
  const span = Math.max(1, to - from);
  const shots = [];
  for (let i = 0; i < 7; i++) {
    const at = from + (span * (i + 0.5)) / 7;
    for await (const f of frames(input, {
      start: at,
      duration: 1,
      fps: 1,
      width: meta.width,
      height: meta.height,
    })) {
      shots.push({ data: f.data, width: f.width, height: f.height });
      break;
    }
  }
  if (shots.length < 3) return null;
  return detectScoreRegionsStable(shots, layout);
}

const inRange = (v, [lo, hi]) => v !== null && v >= lo && v <= hi;

/**
 * Coarse pass: the first video time whose clock looks freshly started.
 *
 * Returns null when the run never shows a fresh clock -- a scoreboard that was
 * up for a long between-match hold, or a match joined in progress.
 */
async function bracketStart(input, from, until, quads, meta, pool) {
  let found = null;
  for await (const f of frames(input, {
    start: from,
    duration: Math.max(0, until - from),
    fps: COARSE_FPS,
    width: meta.width,
    height: meta.height,
  })) {
    const t = await pool.run((w) => readTimer(w, f, quads.timer));
    const r = t ? t.remaining : null;
    if (inRange(r, FRESH_AUTO) || inRange(r, FRESH_TELEOP)) {
      found = { at: f.at, remaining: r };
      break;
    }
  }
  return found;
}

/**
 * Fine pass: run a real `MatchClock` until it locks, and report its green flag.
 *
 * This is the same clock the processor uses, with the same corroboration rules,
 * so a start it accepts here is one the processor will agree with.
 *
 * NOTE: this locks eagerly, on two consecutive ticking reads, and that is known
 * to be too eager on a scoreboard that sits frozen before a match -- a single
 * OCR slip on a static 0:20 satisfies it and invents a start. Requiring the
 * lock to keep counting for several seconds was tried and made things worse,
 * not better: it rejected the real locks too (including a green flag measured
 * correct to within a second), leaving every match to the far less accurate
 * run-start guess. The eager lock plus a wrong start beats no lock at all, so
 * this stays as it is until the row-selection problem underneath it is fixed.
 */
async function lockClock(input, from, quads, meta, pool) {
  const clock = new MatchClock();
  for await (const f of frames(input, {
    start: Math.max(0, from),
    duration: FINE_SPAN,
    fps: 1,
    width: meta.width,
    height: meta.height,
  })) {
    const t = await pool.run((w) => readTimer(w, f, quads.timer));
    clock.feed(t ? t.remaining : null, f.at);
    if (clock.state.started) return clock;
  }
  return clock.state.started ? clock : null;
}

/* ------------------------------------------------------------------ *
 * Both tiers
 * ------------------------------------------------------------------ */

/**
 * Scan a recording and return the matches in it.
 *
 * Each result carries the green flag, the quads to process it with, and how the
 * start was arrived at -- `clock` when a real countdown was locked onto,
 * `run` when only Tier A had anything to say. A `run` start is a guess at the
 * accuracy of the overlay appearing, and is flagged as such rather than being
 * silently mixed in with measured ones.
 */
export async function scan(input, opts = {}) {
  const meta = opts.meta ?? (await probe(input));
  const layout = opts.layout ?? FRC_BROADCAST;
  const pool = opts.pool ?? (await createPool(opts.workers));
  const ownPool = !opts.pool;
  const log = opts.log ?? (() => {});
  // Supplied when the event has a human-taught layout; see calibrated.mjs.
  const fixedQuads = opts.fixedQuads ?? null;

  try {
    const began = Date.now();
    const runs = await findOverlayRuns(input, { ...opts, meta, layout });
    log(
      'tier A: ' + runs.length + ' candidate run(s) in ' +
        ((Date.now() - began) / 1000).toFixed(1) + 's'
    );

    const out = [];
    for (const run of runs) {
      // One run is not necessarily one match. Broadcasts often leave the
      // scoreboard up between matches -- showing the previous result, or the
      // next lineup -- and MERGE_GAP then quite correctly joins several matches
      // into a single long run. So walk the run, taking matches until no more
      // fresh clocks appear, rather than assuming the first one is the only one.
      let cursor = run.start;
      let inRun = 0;
      // Quads are cached across matches and only re-derived when a search comes
      // up empty. In real footage the overlay does not move for the whole
      // broadcast, so deriving them per window would pay for seven seeks per
      // match to compute the same answer every time — measured at roughly 2.4s
      // a window, which is most of the scan. Re-deriving on failure keeps the
      // correctness that per-window derivation bought without the standing cost.
      let quads = null;

      while (cursor < run.end - MIN_RUN / 2) {
        if (opts.signal?.aborted) return out;

        // Search one match-length at a time. Letting the coarse pass run to the
        // end of the run instead would OCR the whole tail on every iteration,
        // and again on every retry — which is most of the scan's cost for
        // nothing, since a match that starts at all starts within a match
        // length of where we are looking.
        const until = Math.min(cursor + MATCH_LEN, run.end);
        let bracket = null;
        let clock = null;

        for (let attempt = 0; attempt < 2; attempt++) {
          if (!quads || attempt === 1) {
            quads = await quadsForWindow(input, cursor, until, meta, layout, fixedQuads);
            if (!quads) break;
          }
          bracket = await bracketStart(input, cursor, until, quads, meta, pool);
          if (!bracket) continue;
          clock = await lockClock(input, bracket.at - FINE_LEAD, quads, meta, pool);
          if (clock && clock.greenFlagAt !== null) break;
        }

        if (!quads) {
          log('  ' + cursor.toFixed(0) + 's: no stable quads, skipping ahead');
          cursor += MATCH_LEN;
          continue;
        }
        if (!bracket) {
          // Nothing clock-shaped in this window. A long overlay hold looks
          // exactly like this, so step forward rather than concluding the run
          // is over.
          cursor += MATCH_LEN;
          continue;
        }

        if (clock && clock.greenFlagAt !== null) {
          const at = Number(clock.greenFlagAt.toFixed(2));
          out.push({ greenFlagAt: at, method: 'clock', run, quads });
          inRun++;
          log('  match at ' + at.toFixed(1) + 's  (run ' + run.start.toFixed(0) + '-' + run.end.toFixed(0) + 's, clock lock)');
          cursor = at + MATCH_LEN + FINE_LEAD;
        } else {
          // Something clock-shaped that would not lock. Step past it rather
          // than re-bracketing the same frames forever.
          cursor = bracket.at + FINE_SPAN;
        }
      }

      if (inRun === 0) {
        // Nothing locked. Only guess for a run that could actually hold a
        // match: long enough to contain one, and short enough to be a single
        // one. The upper bound was always here -- offering a start for a
        // ten-minute overlay hold invents a match that never happened, and
        // downstream that gets identified as something and written.
        //
        // The lower bound is newer, and MIN_RUN (60s, which is about "is the
        // overlay up at all") was far too permissive to double as "might this
        // be a match". Measured on IRI, where the scoreboard stays up between
        // matches: runs of 92s and 60s each produced a confident-looking start
        // for a match that does not exist there, and a run cannot contain a
        // 163-second match in 60 seconds.
        const runLen = run.end - run.start;
        if (runLen >= MIN_GUESS_RUN && runLen <= 2 * MATCH_LEN) {
          const quads = await quadsForWindow(
            input,
            run.start,
            Math.min(run.start + MATCH_LEN, run.end),
            meta,
            layout,
            fixedQuads
          );
          out.push({ greenFlagAt: Number(run.start.toFixed(2)), method: 'run', run, quads });
          log('  match at ~' + run.start.toFixed(1) + 's  (run ' + run.start.toFixed(0) + '-' + run.end.toFixed(0) + 's, NO clock lock — flagged)');
        } else {
          log(
            '  run ' + run.start.toFixed(0) + '-' + run.end.toFixed(0) + 's (' + runLen.toFixed(0) +
              's): no clock lock, ' + (runLen < MIN_GUESS_RUN ? 'too short to hold a match' : 'too long to guess') +
              ' — skipped'
          );
        }
      }
    }
    return out;
  } finally {
    if (ownPool) await pool.terminate();
  }
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

const invokedDirectly =
  process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('worker/src/scan.mjs');

if (invokedDirectly) {
  const input = process.argv[2];
  if (!input) {
    console.error('usage: node worker/src/scan.mjs <video>');
    process.exit(1);
  }
  const began = Date.now();
  const meta = await probe(input);
  console.error(
    input + '  ' + meta.width + 'x' + meta.height + '  ' + (meta.duration / 60).toFixed(1) + ' min'
  );

  const found = await scan(input, {
    meta,
    log: (m) => console.error(m),
    onProgress: (at, dur) =>
      console.error('  ...' + ((100 * at) / (dur || 1)).toFixed(0) + '%'),
  });

  console.error('\n' + found.length + ' match(es) in ' + ((Date.now() - began) / 1000).toFixed(1) + 's');
  console.log(
    JSON.stringify(
      found.map((f) => ({ greenFlagAt: f.greenFlagAt, method: f.method, run: f.run })),
      null,
      2
    )
  );
}
