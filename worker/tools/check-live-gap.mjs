/**
 * Does a match window that spans a reconnect gap actually get rejected?
 *
 * This is the one property in the live path that matters more than any
 * other -- the plan is explicit that a bridged gap must never be silently
 * stitched into a plausible-looking wrong timeline. It cannot be tested by
 * waiting for a real network drop to happen at the right moment, so it is
 * tested directly against the REAL functions `live.mjs` uses at runtime
 * (`assembleAndProcess`, `GapLog`, `RingBuffer` — all exported from live.mjs
 * for exactly this), fed real decoded frames from Qual2 so the scoreboard and
 * clock are genuine, not simulated.
 *
 *   node worker/tools/check-live-gap.mjs
 */

import { frames, probe } from '../src/ffmpeg.mjs';
import { createPool } from '../src/ocr.mjs';
import {
  MatchClock,
  detectScoreRegionsStable,
  isOverlayPresent,
  rectifyToGray,
  recognizeTimer,
  SCORE_RECT_W,
  SCORE_RECT_H,
} from '../src/core.mjs';
import { assembleAndProcess, GapLog, RingBuffer } from '../src/live.mjs';

const CLIP = process.env.CLIP || 'C:/Users/kianz/OneDrive/Desktop/GlendaleVids/Qual2.mp4';
const GAP_AT_OFFSET = 40; // seconds into the window where the gap is injected

async function findT0AndQuads(meta, pool) {
  const shots = [];
  for (const at of [5, 20, 40]) {
    for await (const f of frames(CLIP, { start: at, duration: 1, fps: 1, width: meta.width, height: meta.height })) shots.push(f);
  }
  const quads = detectScoreRegionsStable(shots);
  if (!quads) throw new Error('could not find quads on ' + CLIP);

  const clock = new MatchClock();
  for await (const f of frames(CLIP, { start: 0, duration: 15, fps: 1, width: meta.width, height: meta.height })) {
    if (!isOverlayPresent(f, quads.blue, quads.red)) continue;
    const gray = rectifyToGray(f, quads.timer, SCORE_RECT_W, SCORE_RECT_H);
    if (!gray) continue;
    const timer = await pool.run((w) => recognizeTimer(w, { data: gray, width: SCORE_RECT_W, height: SCORE_RECT_H }));
    clock.feed(timer.remaining, f.at);
    if (clock.state.started) return { t0: clock.greenFlagAt, quads };
  }
  throw new Error('clock never locked in the first 15s of ' + CLIP);
}

/** A live-shaped frame source over a slice of the real clip. */
async function* fakeLiveSource(meta, from, to) {
  for await (const f of frames(CLIP, { start: from, duration: to - from, fps: 1, width: meta.width, height: meta.height })) {
    yield f;
  }
}

async function main() {
  const pool = await createPool(4);
  try {
    const meta = await probe(CLIP);
    const { t0, quads } = await findT0AndQuads(meta, pool);
    console.log('green flag at t=' + t0.toFixed(1) + 's, window from t=' + (t0 - 5).toFixed(1));

    const windowFrom = Math.max(0, t0 - 5);
    const windowTo = t0 + 60; // short window is enough to prove the point

    /* ---- Case A: no gap -- assembleAndProcess must complete normally ---- */
    {
      const ring = new RingBuffer(40);
      const gaps = new GapLog();
      const result = await assembleAndProcess({
        source: fakeLiveSource(meta, windowFrom, windowTo),
        ring, gaps, quads, t0, windowFrom, windowTo, pool,
        log: () => {},
      });
      const ok = result !== 'gap' && result !== 'aborted' && result.samples.length > 0;
      console.log('no-gap case: ' + (ok ? (result.samples.length + ' samples -- completed normally') : 'FAILED to complete'));
      if (!ok) process.exitCode = 1;
    }

    /* ---- Case B: identical window, but a gap was recorded mid-window ---- */
    {
      const ring = new RingBuffer(40);
      const gaps = new GapLog();
      // Exactly what sources.mjs's onGap callback does on a real reconnect:
      // record a gap in absolute video-timeline seconds.
      gaps.record({ start: windowFrom + GAP_AT_OFFSET, seconds: 8 });

      const result = await assembleAndProcess({
        source: fakeLiveSource(meta, windowFrom, windowTo),
        ring, gaps, quads, t0, windowFrom, windowTo, pool,
        log: () => {},
      });

      const rejected = result === 'gap';
      console.log('gap-at-+' + GAP_AT_OFFSET + 's case: ' + (rejected ? 'REJECTED as designed' : 'NOT rejected -- BUG, got ' + JSON.stringify(result).slice(0, 80)));
      if (!rejected) process.exitCode = 1;
    }

    /* ---- Case C: a gap recorded well BEFORE the window -- must NOT reject ---- */
    // The window only cares about gaps that overlap it. A gap from ten minutes
    // ago should not poison every match processed afterwards.
    {
      const ring = new RingBuffer(40);
      const gaps = new GapLog();
      gaps.record({ start: windowFrom - 300, seconds: 8 });

      const result = await assembleAndProcess({
        source: fakeLiveSource(meta, windowFrom, windowTo),
        ring, gaps, quads, t0, windowFrom, windowTo, pool,
        log: () => {},
      });
      const ok = result !== 'gap' && result !== 'aborted' && result.samples.length > 0;
      console.log('unrelated-earlier-gap case: ' + (ok ? 'correctly ignored, completed normally' : 'FAILED -- an unrelated gap wrongly rejected the window'));
      if (!ok) process.exitCode = 1;
    }

    console.log(
      process.exitCode
        ? '\nFAIL'
        : '\nPASS: gap-during-window rejects; no-gap and unrelated-gap windows complete normally.'
    );
  } finally {
    await pool.terminate();
  }
}

await main();
