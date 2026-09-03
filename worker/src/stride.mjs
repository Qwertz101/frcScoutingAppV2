/**
 * Finding matches by seeking to a few hundred places, instead of decoding
 * everything.
 *
 * `scan.mjs`'s Tier A samples at `fps=0.5`, which sounds cheap and is not:
 * ffmpeg still decodes every frame of the recording and simply throws most of
 * them away. Measured on a real 1080p event recording, that runs at ~7.4x
 * realtime -- 40.3s of wall time for 300s of video, so about **72 minutes for a
 * nine-hour event** before a single character is OCR'd. The per-frame colour
 * maths the tier is designed around is a rounding error next to the decode it
 * sits on top of.
 *
 * Seeking does not pay that. `-ss` before `-i` jumps in the container, and one
 * seek plus one frame costs ~0.46s on the same file *regardless of how far in
 * it lands*. So the cost stops scaling with the length of the recording and
 * starts scaling with the number of places looked at.
 *
 * How few places can that be? The scoreboard overlay is up for the whole
 * `MATCH_LEN` (163s) of a match, so probes spaced any closer than that cannot
 * step over one: at 135s apart, two consecutive probes cannot both miss a
 * 163-second window. That is ~240 probes for a nine-hour event rather than
 * 16,200 decoded frames, and it turns those 72 minutes into **under two**.
 *
 * The catch, and the reason most of this file is about clocks rather than
 * seeking: a probe lands at an *arbitrary* point in the match. Tier B could
 * always assume it was looking near a freshly-started clock, because its coarse
 * pass went looking for one (`FRESH_AUTO`, `FRESH_TELEOP`). Nothing here can
 * assume that, and `MatchClock` reads phase off a single value --
 *
 *     this.phase = remaining > AUTO_LEN ? 'teleop' : 'auto';
 *
 * -- with a comment conceding that a recording joined in the last 20 seconds of
 * TELEOP would be called AUTO. Under Tier B that was unreachable. Here it is
 * the common case: `0:15` is the 5-second mark of AUTO *and* the 148-second
 * mark of TELEOP, and picking wrong puts the green flag 143 seconds late while
 * looking exactly as confident as a correct read. So the phase is never assumed
 * from one reading -- it is stated as two hypotheses and one of them is
 * disproved against the video. See `resolveGreenFlag`.
 *
 * `MatchClock` is deliberately not used anywhere in this file, for that reason.
 * The processor still uses it, where a match is read start to finish and the
 * phase is established from the countdown's own opening rather than guessed.
 */

import {
  MATCH_LEN,
  AUTO_LEN,
  TELEOP_LEN,
  detectScoreRegions,
  isOverlayPresent,
  recognizeTimer,
  rectifyToGray,
  FRC_BROADCAST,
  SCORE_RECT_W,
  SCORE_RECT_H,
} from './core.mjs';
import { frames, probe } from './ffmpeg.mjs';
import { createPool } from './ocr.mjs';

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

/**
 * Seconds between overlay probes.
 *
 * Must stay below `MATCH_LEN` or a match can fall between two probes and never
 * be looked at. 135s (2:15) leaves 28 seconds of margin against a broadcast
 * that cuts away from the overlay mid-match, which is the only thing that
 * shortens the visible run.
 */
export const STRIDE = 135;

/** Frame width for the overlay probe. Detection measured 100% at 480 and above. */
const PROBE_WIDTH = 640;

/** Frames per overlay probe. One frame can land on a transition; three cannot all. */
const PROBE_FRAMES = 3;

/** Of `PROBE_FRAMES`, how many must show the overlay to call it a hit. */
const PROBE_AGREE = 2;

/**
 * Least fraction of the timer plate that must be clearly brighter than the
 * plate's own average, *and* clearly darker than it, before the plate counts as
 * showing a time.
 *
 * Requiring both is what makes this independent of the graphic's colour scheme:
 * digits on a plate always produce two populations, whether they are dark on
 * white or white on dark, while a plate with no time on it is one flat
 * population either way. Measured on Sunset Showdown, where the pre-match
 * graphic puts a plain white logo disc exactly where the clock later sits:
 * 0.000 on every pre-match and between-match frame, 0.297-0.350 on every
 * in-match one. 0.10 sits in the middle of that gap.
 */
const TIMER_DIGIT_MIN = 0.1;

/**
 * How much to shrink the timer box before measuring it.
 *
 * A person draws the box around the plate, not inside it, so its edge sits on
 * or just past the plate's boundary -- and that boundary is the strongest
 * light/dark transition anywhere near the clock. Include it and a plate with no
 * time on it still yields both populations, from its own rim.
 *
 * That is not hypothetical: the first Sunset Showdown calibration scored 0.000
 * on the pre-match card, and a later one drawn four pixels lower scored 0.224
 * on the very same frames -- over the threshold, purely because it caught the
 * bottom edge of the white logo disc. Measuring the middle of the box instead
 * puts that back to 0.000 while in-match only falls from 0.374 to 0.348, so the
 * gap more than doubles. Anywhere from 10% to 30% behaves the same; the test
 * stops depending on how tightly the box was drawn.
 */
const TIMER_INSET = 0.15;

/** Frames per clock reading. Spans enough seconds to prove the plate is moving. */
const CLOCK_FRAMES = 5;

/**
 * How far apart two clock readings may put "the moment the plate reads 0:00"
 * and still be treated as the same countdown. Absorbs a second of seek slop;
 * anything looser starts accepting a frozen plate.
 */
const ZERO_TOLERANCE = 1.5;

/** Seconds the agreeing readings must span, so a frozen graphic cannot pass. */
const MIN_TICK_SPAN = 3;

/**
 * How far past an ambiguous reading to look when disproving a hypothesis.
 *
 * Chosen so the two hypotheses predict qualitatively different things rather
 * than merely different numbers: 25 seconds after an AUTO reading the match is
 * always in early TELEOP with a plate above 1:58, and 25 seconds after the same
 * reading in late TELEOP the match is over and there is no clock at all.
 */
const DISAMBIG_LEAD = 25;

/**
 * Where to look for a clock, relative to a hit, in order.
 *
 * Offset 0 nearly always answers, because a hit now requires a time to be
 * visible in the first place -- the rest is for a plate that is legible enough
 * to detect but not to OCR, which motion blur on a compressed stream does
 * produce. Outward rather than forward-only: a hit lands anywhere in the match,
 * so a late one runs past the buzzer going forward and an early one runs into
 * the pre-match graphic going back, and only covering both directions handles
 * a hit at either end.
 */
const PROBE_LADDER = [0, 12, -12, 24, -24, 45, -45];

/** Match-elapsed offsets to verify a resolved green flag against, in order. */
const VERIFY_ELAPSED = [60, 90, 45];

/** How far a verification reading may sit from its prediction. */
const VERIFY_TOLERANCE = 4;

/**
 * How far back the fallback sweep starts from the hit.
 *
 * A hit is somewhere inside `[G, G + MATCH_LEN]`, so the green flag can be a
 * full match length earlier -- 163s. Backing off only 150s would undershoot by
 * 13s and begin the sweep after AUTO had already started, which is the one
 * place the sweep cannot recover from. 180s clears it with margin.
 */
const BACKOFF = 180;

/**
 * How far past the hit the sweep will also look.
 *
 * A hit sits inside a match, so the green flag is behind it and backwards is
 * the productive direction -- but only just far enough forward to finish
 * covering a match whose clock is legible only in its later half.
 */
const SWEEP_AHEAD = 60;

/**
 * Spacing of the sweep's probe points.
 *
 * A five-frame cluster at each covers five seconds in twelve, so a countdown
 * legible for any twelve-second stretch of the window will be found. Small
 * enough, too, that stepping past a rejected match cannot skip over the real
 * green flag -- which is what the old `locked + MATCH_LEN` step could do.
 */
const SWEEP_STEP = 12;

/** The handover between AUTO ending and TELEOP's clock appearing. 3s, from the manual. */
const AUTO_TELEOP_DELAY = MATCH_LEN - AUTO_LEN - TELEOP_LEN;

/** Midpoint correction for a plate that only ever shows the second rounded down. */
const PLATE_QUANTISATION = 0.5;

/* ------------------------------------------------------------------ *
 * Match-time arithmetic
 * ------------------------------------------------------------------ */

/**
 * What the timer plate reads at `elapsed` seconds into a match, or null where
 * it reads nothing predictable.
 *
 * Null is a real answer and the disambiguation below depends on it: before the
 * green flag, during the three-second handover, and after the buzzer there is
 * no countdown to predict, and a hypothesis that predicts "no clock" is
 * disproved the moment a clock is read.
 */
export function plateAt(elapsed) {
  if (elapsed < 0 || elapsed > MATCH_LEN) return null;
  if (elapsed <= AUTO_LEN) return AUTO_LEN - elapsed;
  if (elapsed < AUTO_LEN + AUTO_TELEOP_DELAY) return null;
  return MATCH_LEN - elapsed;
}

/** What the plate should read at video time `at`, if the green flag was `g`. */
const predict = (g, at) => plateAt(at - g);

/* ------------------------------------------------------------------ *
 * Reading the video
 * ------------------------------------------------------------------ */

/** Up to `count` frames from `at`, one per second of video. */
async function grabAt(input, at, count, meta, scaleWidth) {
  const out = [];
  for await (const f of frames(input, {
    start: Math.max(0, at),
    duration: count,
    fps: 1,
    width: meta.width,
    height: meta.height,
    scaleWidth,
  })) {
    out.push(f);
    if (out.length >= count) break;
  }
  return out;
}

/**
 * Read only the match clock out of a frame.
 *
 * The score plates are deliberately skipped: while scanning, the scores are
 * irrelevant and reading them would triple the OCR cost of every probe.
 */
async function readTimer(worker, frame, timerQuad) {
  const gray = rectifyToGray(frame, timerQuad, SCORE_RECT_W, SCORE_RECT_H);
  if (!gray) return null;
  return recognizeTimer(worker, { data: gray, width: SCORE_RECT_W, height: SCORE_RECT_H });
}

/**
 * Does the timer plate actually have a time on it?
 *
 * The check that separates a match from a graphic *about* a match. Alliance
 * colour alone does not: the pre-match lineup card carries both alliance blocks
 * and the six team numbers, and so reads as the scoreboard while no match is
 * running. Treating those as hits cost a wasted resolution attempt each, and
 * made "the overlay is up" mean something weaker than "a match is happening"
 * everywhere that phrase is relied on.
 */
/** Shrink a quad toward its own centre, so its edges are not measured. */
function insetQuad(quad, fraction) {
  const cx = quad.reduce((t, p) => t + p.x, 0) / quad.length;
  const cy = quad.reduce((t, p) => t + p.y, 0) / quad.length;
  const f = fraction / 2;
  return quad.map((p) => ({ x: p.x + (cx - p.x) * f, y: p.y + (cy - p.y) * f }));
}

function timerShowsDigits(frame, timerQuad) {
  const gray = rectifyToGray(frame, insetQuad(timerQuad, TIMER_INSET), SCORE_RECT_W, SCORE_RECT_H);
  if (!gray || !gray.length) return false;

  let sum = 0;
  for (let i = 0; i < gray.length; i++) sum += gray[i];
  const mean = sum / gray.length;

  let bright = 0;
  let dark = 0;
  for (let i = 0; i < gray.length; i++) {
    if (gray[i] > mean + 40) bright++;
    else if (gray[i] < mean - 40) dark++;
  }
  return Math.min(bright, dark) / gray.length >= TIMER_DIGIT_MIN;
}

/**
 * Is a match actually running in this frame?
 *
 * Both halves are needed. The colour test says the score plates are there and
 * filled with alliance colour; the digit test says a clock is on screen, which
 * is what distinguishes a match in progress from the card announcing one.
 */
function overlayIn(frame, fixedQuads, layout) {
  // A taught layout removes the geometry search entirely, and with it every way
  // that search can lock onto something scoreboard-shaped that is not the
  // scoreboard -- the red and blue championship banners above the bleachers at
  // Sunset Showdown being the measured example.
  if (fixedQuads) {
    return (
      isOverlayPresent(frame, fixedQuads.blue, fixedQuads.red) &&
      timerShowsDigits(frame, fixedQuads.timer)
    );
  }
  const regions = detectScoreRegions(frame, layout);
  return (
    regions !== null &&
    isOverlayPresent(frame, regions.blue, regions.red) &&
    timerShowsDigits(frame, regions.timer)
  );
}

/**
 * One cluster of clock readings, OCR'd in parallel.
 *
 * Parallel because these are independent: unlike a `MatchClock` sweep, where
 * each reading has to be fed in order, a cluster is five separate questions and
 * the pool can answer them at once.
 */
async function readClockCluster(input, at, quads, meta, pool) {
  const shots = await grabAt(input, at, CLOCK_FRAMES, meta);
  const reads = await Promise.all(
    shots.map((f) =>
      pool.run((w) => readTimer(w, f, quads.timer)).then(
        (t) => ({ r: t ? t.remaining : null, at: f.at }),
        () => ({ r: null, at: f.at })
      )
    )
  );
  return reads;
}

/* ------------------------------------------------------------------ *
 * Clock consensus
 * ------------------------------------------------------------------ */

/**
 * Agree on when this countdown reaches 0:00, or return null.
 *
 * A running clock has an invariant a frozen graphic and a stray misread do not:
 * `remaining + videoTime` is constant, because the plate loses exactly one
 * second per second of video. That constant is the video time the plate will
 * read 0:00 at, and agreeing on it is a far stronger test than agreeing on a
 * value -- two frames a second apart showing the same number agree on the
 * *value* while disagreeing on the invariant, which is exactly the frozen
 * pre-match plate that `lockClock`'s eager two-tick rule is documented as
 * falling for.
 *
 * Requiring the agreeing readings to span `MIN_TICK_SPAN` seconds is what makes
 * that bite: a plate frozen for three seconds puts its zeros three seconds
 * apart, well outside `ZERO_TOLERANCE`.
 */
export function clockConsensus(reads) {
  const seen = reads.filter((x) => x.r !== null).map((x) => ({ ...x, zero: x.r + x.at }));
  if (seen.length < 2) return null;

  let best = null;
  for (const anchor of seen) {
    const agree = seen.filter((x) => Math.abs(x.zero - anchor.zero) <= ZERO_TOLERANCE);
    if (agree.length < 2) continue;
    const span = Math.max(...agree.map((x) => x.at)) - Math.min(...agree.map((x) => x.at));
    if (span < MIN_TICK_SPAN) continue;
    // The plate must actually have moved, not merely been read twice.
    const dropped = Math.max(...agree.map((x) => x.r)) > Math.min(...agree.map((x) => x.r));
    if (!dropped) continue;
    if (!best || agree.length > best.agree.length) {
      const zero = agree.reduce((s, x) => s + x.zero, 0) / agree.length;
      best = { zero, agree, span };
    }
  }
  if (!best) return null;
  return {
    /** Video time at which this countdown reads 0:00, taking each plate value literally. */
    zero: best.zero,
    /** Highest value seen in the agreeing set — the phase evidence. */
    maxRemaining: Math.max(...best.agree.map((x) => x.r)),
    votes: best.agree.length,
  };
}

/* ------------------------------------------------------------------ *
 * Green flag
 * ------------------------------------------------------------------ */

/**
 * Turn one clock consensus into the two green flags it could mean.
 *
 * A countdown reaching zero at video time `zero` is either AUTO's clock, which
 * hits zero `AUTO_LEN` into the match, or TELEOP's, which hits zero at the
 * buzzer. Those are 143 seconds apart and nothing in the reading itself
 * separates them -- except a value above `AUTO_LEN`, which AUTO's plate can
 * never show.
 */
function hypotheses({ zero, maxRemaining }) {
  // Half a second later than `zero` alone says, because the plate quantises:
  // it shows a whole `1:24` for the entire second during which the true
  // remaining falls from 84.999 to 84.000, so a reading of 84 means "somewhere
  // in [84, 85)" and taking it as exactly 84 puts every green flag half a
  // second early. The midpoint is the unbiased estimate of a value we only ever
  // see rounded down. Measured on Sunset Showdown, the uncorrected figure ran
  // 1-2s early on four of five matches.
  const z = zero + PLATE_QUANTISATION;
  const teleop = { phase: 'teleop', greenFlagAt: z - MATCH_LEN };
  if (maxRemaining > AUTO_LEN) return [teleop];
  return [{ phase: 'auto', greenFlagAt: z - AUTO_LEN }, teleop];
}

/**
 * Resolve the green flag for a match known to be on screen at `hitAt`.
 *
 * Cheap by design: most hits land in TELEOP with the plate above 0:20, which is
 * unambiguous on its own, so the common case is one cluster of reads and one
 * verification. Only a hit inside AUTO or the last 20 seconds of TELEOP -- about
 * a quarter of a match between them -- pays for the disambiguation probe.
 *
 * Returns `{ greenFlagAt, phase, method, verified }` or null.
 */
export async function resolveGreenFlag(input, hitAt, quads, meta, pool, opts = {}) {
  const log = opts.log ?? (() => {});
  const duration = meta.duration ?? Infinity;

  // Read the clock at the hit itself, then nearby if the plate is not legible
  // there -- a replay wipe or a lower-third over it, or motion blur bad enough
  // to defeat OCR on a plate whose digits were still clear enough to detect.
  let consensus = null;
  for (const offset of PROBE_LADDER) {
    if (opts.signal?.aborted) return null;
    const at = hitAt + offset;
    if (at + CLOCK_FRAMES > duration) break;
    consensus = clockConsensus(await readClockCluster(input, at, quads, meta, pool));
    if (consensus) break;
  }
  if (!consensus) return null;

  return resolveFromConsensus(input, consensus, quads, meta, pool, opts);
}

/**
 * Everything that follows a clock consensus: pick a phase, prove it, verify it.
 *
 * Split out from `resolveGreenFlag` so the fallback sweep resolves a countdown
 * through exactly the same reasoning rather than through `MatchClock`'s
 * single-frame phase guess. Any countdown found anywhere in the video can be
 * handed to this; deciding whether it belongs to the match we are looking for
 * is the caller's job.
 */
async function resolveFromConsensus(input, consensus, quads, meta, pool, opts = {}) {
  const log = opts.log ?? (() => {});
  const options = hypotheses(consensus);

  // One hypothesis: the reading was above AUTO's ceiling, so it can only have
  // been TELEOP. Nothing to disprove.
  let chosen = options.length === 1 ? options[0] : null;

  if (!chosen) {
    // Two hypotheses, 143 seconds apart. Probe where they disagree about
    // whether a clock exists at all, not merely about what it says.
    chosen = await disambiguate(input, consensus, options, quads, meta, pool, opts);
    if (!chosen) return null;
  }

  // Whichever way we got here, prove it against a part of the video that had no
  // say in choosing it.
  const verified = await verify(input, chosen.greenFlagAt, quads, meta, pool, opts);
  if (verified === false) {
    log(
      '    green flag ' + chosen.greenFlagAt.toFixed(1) + 's rejected: the clock elsewhere in the match disagrees'
    );
    return null;
  }

  return {
    greenFlagAt: chosen.greenFlagAt,
    phase: chosen.phase,
    method: 'clock',
    verified: verified === true,
  };
}

/**
 * Decide between an AUTO and a TELEOP reading of the same countdown.
 *
 * The probe lands `DISAMBIG_LEAD` seconds after the reading, where the two
 * hypotheses do not merely predict different numbers -- they disagree about
 * whether the match is still running. If the reading was AUTO, the match is in
 * early TELEOP there and the plate reads somewhere near 2:00. If it was the end
 * of TELEOP, the buzzer has gone and there is no countdown to read.
 *
 * So a clock that reads at all disproves the TELEOP hypothesis, and a stretch
 * with the overlay gone disproves the AUTO one.
 */
async function disambiguate(input, consensus, options, quads, meta, pool, opts = {}) {
  const log = opts.log ?? (() => {});
  const auto = options.find((o) => o.phase === 'auto');
  const teleop = options.find((o) => o.phase === 'teleop');
  const probeAt = consensus.zero - AUTO_LEN + DISAMBIG_LEAD;

  if (probeAt + CLOCK_FRAMES > (meta.duration ?? Infinity)) {
    // No room to look. A match whose disambiguation window runs past the end of
    // the recording is one we cannot honestly resolve, and guessing here is
    // exactly the 143-second error this file exists to avoid.
    log('    ambiguous clock and no room to disprove it — skipped');
    return null;
  }

  const reads = await readClockCluster(input, probeAt, quads, meta, pool);
  const after = clockConsensus(reads);

  if (after) {
    // A running clock after the probe point. Score both hypotheses against what
    // it actually says rather than assuming AUTO won.
    const scored = [auto, teleop]
      .filter(Boolean)
      .map((o) => {
        const want = predict(o.greenFlagAt, after.zero - after.maxRemaining);
        return { o, err: want === null ? Infinity : Math.abs(want - after.maxRemaining) };
      })
      .sort((a, b) => a.err - b.err);
    if (scored[0].err <= VERIFY_TOLERANCE) return scored[0].o;
    // A clock that fits neither hypothesis means the probe landed in a
    // different match, which makes this hit unresolvable from here.
    log('    ambiguous clock: the probe fits neither reading — skipped');
    return null;
  }

  // No clock at the probe. That is what the TELEOP hypothesis predicts, but a
  // cutaway predicts it too -- so only accept it once the overlay itself is
  // gone, which a cutaway inside a running match does not do for long.
  const shots = await grabAt(input, probeAt, PROBE_FRAMES, meta, PROBE_WIDTH);
  const present = shots.filter((f) => overlayIn(f, opts.fixedQuads, opts.layout ?? FRC_BROADCAST)).length;
  if (present === 0) return teleop;

  log('    ambiguous clock: overlay still up but unreadable — skipped');
  return null;
}

/**
 * Check a green flag against a part of the match that had no say in choosing it.
 *
 * Returns true when a reading agreed, false when one actively disagreed, and
 * null when nothing could be read -- which is not the same thing and must not
 * be treated as one. A broadcast that cut away for the whole verification
 * window has told us nothing, and rejecting a good green flag over it would
 * lose a match we had correctly found.
 */
async function verify(input, greenFlagAt, quads, meta, pool, opts = {}) {
  let sawOverlay = false;

  for (const elapsed of VERIFY_ELAPSED) {
    if (opts.signal?.aborted) return null;
    const want = plateAt(elapsed);
    if (want === null) continue;
    const at = greenFlagAt + elapsed;
    if (at < 0 || at + CLOCK_FRAMES > (meta.duration ?? Infinity)) continue;

    const got = clockConsensus(await readClockCluster(input, at, quads, meta, pool));
    if (got) {
      // Compare at a common instant: what the plate should read where it was read.
      const predicted = predict(greenFlagAt, got.zero - got.maxRemaining);
      if (predicted === null) continue;
      return Math.abs(predicted - got.maxRemaining) <= VERIFY_TOLERANCE;
    }

    // No readable clock here, which on its own means nothing -- a replay or a
    // lower-third covers the plate often enough. But the overlay itself is up
    // for the whole of a real match, so its *absence* mid-match is positive
    // evidence against this green flag rather than a mere absence of evidence.
    // This is what catches a phase mix-up that got past `disambiguate`: a green
    // flag 143 seconds late puts every verification point after the buzzer,
    // where there is no overlay at all.
    const shots = await grabAt(input, at, PROBE_FRAMES, meta, PROBE_WIDTH);
    if (shots.some((f) => overlayIn(f, opts.fixedQuads, opts.layout ?? FRC_BROADCAST))) {
      sawOverlay = true;
    }
  }

  // Nothing legible anywhere. Inconclusive if the overlay was at least up;
  // a rejection if the match it describes leaves no trace on screen.
  return sawOverlay ? null : false;
}

/**
 * Probe points for the fallback sweep, nearest the hit first.
 *
 * Order matters more than coverage. The hit is inside the match we want, so a
 * countdown found near it is far more likely to belong to that match than one
 * found 180 seconds earlier -- which is quite likely to be the *previous*
 * match. Working outwards means the common case never consults the previous
 * match at all, rather than consulting it first and relying on a guard to throw
 * the answer away.
 */
export function sweepPoints(hitAt, backoff, ahead, step, duration) {
  const pts = [];
  for (let d = step; d <= Math.max(backoff, ahead); d += step) {
    if (d <= ahead) pts.push(hitAt + d);
    if (d <= backoff) pts.push(hitAt - d);
  }
  return (
    pts
      .filter((t) => t >= 0 && t + CLOCK_FRAMES <= (duration ?? Infinity))
      // The primary ladder has already read a cluster at each of its offsets and
      // found nothing legible, and a cluster covers `CLOCK_FRAMES` seconds from
      // where it starts. Re-reading those same seconds on the expensive path
      // cannot produce a different answer -- it just costs two more clusters
      // before the sweep reaches anywhere new.
      .filter((t) => !PROBE_LADDER.some((o) => Math.abs(t - (hitAt + o)) < CLOCK_FRAMES))
  );
}

/**
 * Last resort: hunt the window around the hit for any legible countdown.
 *
 * This is the original back-off-and-scrub plan, with the scrubbing done by the
 * same reasoning as the primary path rather than by `MatchClock`. That change
 * closes a real hole. `MatchClock` sets phase from a single value, so a sweep
 * that happened to start in the **last 20 seconds of the previous match** read
 * a countdown below 0:20, called it AUTO, and invented a green flag near that
 * match's *end*. The containment check below did reject it -- the algebra works
 * out to needing 36 seconds of overrun where at most 20 are possible, so a
 * 16-second margin -- but the recovery step was `locked + MATCH_LEN`, a full
 * match length measured from a fabricated start. That lands 17 to 37 seconds
 * before the hit, so any match whose hit sat further than ~37s past its green
 * flag had its real start skipped over and was lost.
 *
 * Resolving through `resolveFromConsensus` removes the fabricated start
 * entirely: a countdown in the previous match now resolves to that match's
 * *correct* green flag, gets rejected by containment for the honest reason that
 * it does not contain the hit, and the search continues at `SWEEP_STEP` rather
 * than leaping a match length from a wrong number.
 */
export async function sweepForStart(input, hitAt, quads, meta, pool, opts = {}) {
  const log = opts.log ?? (() => {});
  const backoff = opts.backoff ?? BACKOFF;
  const points = sweepPoints(hitAt, backoff, SWEEP_AHEAD, SWEEP_STEP, meta.duration);

  // Neighbouring matches already found and rejected. Several probe points land
  // inside the same one, and without this each re-reads its clock and re-pays
  // disambiguation and verification to reach an identical conclusion -- measured
  // at six identical rejections of the match at 1749.5s for one hit at 2025s.
  const rejected = [];

  for (const at of points) {
    if (opts.signal?.aborted) return null;
    if (rejected.some((g) => at >= g - 1 && at <= g + MATCH_LEN + 1)) continue;

    const consensus = clockConsensus(await readClockCluster(input, at, quads, meta, pool));
    if (!consensus) continue;

    const resolved = await resolveFromConsensus(input, consensus, quads, meta, pool, opts);
    if (!resolved) continue;

    // The overlay was up at the hit, so the hit is inside a match. A green flag
    // whose match does not contain it describes a different one -- most often
    // the previous match, which the backoff reaches at a tight cadence.
    if (hitAt >= resolved.greenFlagAt - 1 && hitAt <= resolved.greenFlagAt + MATCH_LEN + 1) {
      return { ...resolved, method: 'sweep' };
    }
    log(
      '    sweep found a match at ' + resolved.greenFlagAt.toFixed(1) +
        's, which does not contain the hit at ' + hitAt.toFixed(1) + 's — looking elsewhere'
    );
    rejected.push(resolved.greenFlagAt);
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * The scan
 * ------------------------------------------------------------------ */

/**
 * Video times at which the scoreboard overlay is on screen, sampled every
 * `STRIDE` seconds.
 */
export async function findHits(input, opts = {}) {
  const meta = opts.meta ?? (await probe(input));
  const layout = opts.layout ?? FRC_BROADCAST;
  const fixedQuads = opts.fixedQuads ?? null;
  const from = opts.start ?? 0;
  const to = opts.duration != null ? from + Number(opts.duration) : meta.duration;
  const stride = opts.stride ?? STRIDE;

  const log = opts.log ?? (() => {});
  const hits = [];
  let probes = 0;
  let failed = 0;

  for (let at = from; at < to; at += stride) {
    if (opts.signal?.aborted) break;
    probes++;
    // One probe is one seek, and a seek against a remote VOD can fail on its
    // own -- a throttled connection, a dropped range request -- without
    // anything being wrong with the recording or the next probe. Letting that
    // escape would abandon the whole scan over one bad read, which is the
    // opposite of what independent probes are for. The count is reported below
    // so a scan that quietly lost half its probes cannot look like a clean one.
    let shots;
    try {
      shots = await grabAt(input, at, PROBE_FRAMES, meta, PROBE_WIDTH);
    } catch (e) {
      failed++;
      const why = String(e.message ?? e).split(/[\r\n]/)[0];
      log('  probe at ' + at.toFixed(0) + 's failed: ' + why);
      continue;
    }
    if (!shots.length) {
      failed++;
      continue;
    }
    const present = shots.filter((f) => overlayIn(f, fixedQuads, layout)).length;
    if (present >= PROBE_AGREE) hits.push(shots[0]?.at ?? at);
    opts.onProgress?.(at, meta.duration);
  }

  if (failed) {
    const pct = (failed / Math.max(1, probes)) * 100;
    log(
      'WARNING: ' + failed + ' of ' + probes + ' probes (' + pct.toFixed(0) + '%) could not be read. ' +
        'A match sitting under one of those was never looked at.'
    );
  }
  return hits;
}

/**
 * Scan a recording and return the matches in it, seeking rather than decoding.
 *
 * Same result shape as `scan()` in `scan.mjs`, so `run.mjs` consumes either
 * without caring which found the matches.
 */
export async function scanStrided(input, opts = {}) {
  const meta = opts.meta ?? (await probe(input));
  const layout = opts.layout ?? FRC_BROADCAST;
  const pool = opts.pool ?? (await createPool(opts.workers));
  const ownPool = !opts.pool;
  const log = opts.log ?? (() => {});
  const fixedQuads = opts.fixedQuads ?? null;

  try {
    const began = Date.now();
    const hits = await findHits(input, { ...opts, meta, layout, fixedQuads });
    log(
      'stride scan: ' + hits.length + ' overlay hit(s) from ' +
        Math.ceil(((opts.duration ?? meta.duration) || 0) / (opts.stride ?? STRIDE)) +
        ' probes in ' + ((Date.now() - began) / 1000).toFixed(1) + 's'
    );

    // Without a taught layout there are no quads to read a clock through, and
    // deriving them is `scan.mjs`'s job. This path is built for the calibrated
    // case; `run.mjs` keeps the old scanner for everything else.
    if (!fixedQuads) {
      log('stride scan needs a calibrated layout to read the clock — falling back');
      return null;
    }

    const out = [];
    const stride = opts.stride ?? STRIDE;

    /**
     * Is this hit already accounted for by a match we have found?
     *
     * Inside `[G, G + MATCH_LEN]` is the ordinary case -- a match is longer than
     * a stride, so consecutive hits routinely name the same match.
     *
     * The stride of lead-in before `G` is defensive rather than routine now
     * that a hit requires a clock on screen. It still costs nothing and still
     * covers a broadcast that counts down to the green flag in the same plate,
     * which would put a hit just before a match it belongs to. One stride of
     * lead-in cannot swallow a real earlier match, because no event runs
     * matches 135 seconds apart.
     */
    const explained = (hitAt) =>
      out.some((m) => hitAt >= m.greenFlagAt - stride && hitAt <= m.greenFlagAt + MATCH_LEN + 1);

    const add = (found, hitAt) => {
      // Two hits either side of a boundary can still resolve to the same start.
      if (out.some((m) => Math.abs(m.greenFlagAt - found.greenFlagAt) < MATCH_LEN / 2)) return;
      const at = Number(found.greenFlagAt.toFixed(2));
      out.push({
        greenFlagAt: at,
        method: found.method,
        verified: found.verified,
        run: { start: at, end: at + MATCH_LEN },
        quads: fixedQuads,
      });
      log(
        '  match at ' + at.toFixed(1) + 's  (' + found.method +
          (found.verified ? ', verified' : ', unverified') + ', hit ' + hitAt.toFixed(0) + 's)'
      );
    };

    // Pass one: the cheap resolution, on every hit.
    const unresolved = [];
    for (const hitAt of hits) {
      if (opts.signal?.aborted) return out;
      if (explained(hitAt)) continue;
      const found = await resolveGreenFlag(input, hitAt, fixedQuads, meta, pool, {
        ...opts, meta, layout, fixedQuads, log,
      });
      if (found) add(found, hitAt);
      else unresolved.push(hitAt);
    }

    // Pass two: sweep only what nothing else explained. Deliberately after the
    // whole of pass one rather than inline, because a sweep is many times the
    // cost of a clock probe and an unresolved hit is often explained by a match
    // that pass one goes on to find from a later hit. That was routine when a
    // lineup card counted as a hit -- the hit at 540s bought a fruitless sweep
    // while the next hit resolved the match at 638s that explained it -- and is
    // rarer now that a hit requires a clock, but the ordering still costs
    // nothing and still pays whenever a match's opening is illegible.
    for (const hitAt of unresolved) {
      if (opts.signal?.aborted) return out;
      if (explained(hitAt)) continue;
      log('  hit at ' + hitAt.toFixed(0) + 's: clock probes inconclusive, sweeping…');
      const found = await sweepForStart(input, hitAt, fixedQuads, meta, pool, { ...opts, meta, log });
      if (found) add(found, hitAt);
      else log('  hit at ' + hitAt.toFixed(0) + 's: no match start could be established — skipped');
    }

    out.sort((a, b) => a.greenFlagAt - b.greenFlagAt);
    return out;
  } finally {
    // `terminate`, matching scan.mjs and run.mjs. Written as `pool.close?.()`
    // first, which is not a method the pool has -- and the optional chaining
    // meant that was not an error, just a silent no-op that left every OCR
    // worker alive and the event loop with it. Two test runs sat idle for
    // hours after printing their results because of it.
    if (ownPool) await pool.terminate();
  }
}
