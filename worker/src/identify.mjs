/**
 * Which match is this?
 *
 * `cv_logs.match_key` is the PRIMARY KEY and the writer upserts on it, so a
 * wrong answer here does not add a bad row — it *destroys a good one*. That
 * shapes the whole module: it abstains readily, it never falls back to "the
 * next match number" without saying so, and every acceptance needs a margin
 * over the runner-up rather than merely being the best of a bad set.
 *
 * The signal is the team numbers printed on the alliance plates, matched as a
 * SET against the event's qualification schedule. A set is the right shape for
 * this because the failure mode of the OCR is dropping a number, not inventing
 * a plausible one, and six teams appear together in exactly one qual match.
 */

import {
  detectScoreRegionsStable,
  plateExtent,
  prepareNumberGroups,
  recognizePlane,
  rectQuad,
  rectifyToGray,
  PREP_VARIANTS,
  MATCH_LEN,
  FRC_BROADCAST,
} from './core.mjs';
import { frames, probe } from './ffmpeg.mjs';

/** Rectified size of a team-number band. Wide, because it holds three numbers. */
const BAND_W = 1024;
const BAND_H = 96;

/**
 * Digit counts a team number can have.
 *
 * Not 3–5, which was the first guess and is wrong: 2026cagle alone fields team
 * 22 and team 4. Allowing one- and two-digit groups costs a few extra recognize
 * calls on logo fragments, and those lose on votes; excluding them makes two
 * teams permanently invisible and silently caps identification at 5/6.
 */
const MIN_DIGITS = 1;
const MAX_DIGITS = 5;

/** Frames sampled across the match, and the votes needed to believe a number. */
const SAMPLE_AT = [30, 60, 90, 120, 150];
/**
 * Confident numbers score 10–15 votes across 5 frames x 3 preparation variants;
 * logo fragments and half-read digits score 1–4. The gap is wide enough that
 * the exact cut hardly matters, which is the point.
 */
const MIN_VOTES = 5;

/** Accepting an identification needs both of these. */
const MIN_SCORE = 4;
const MIN_MARGIN = 2;

/**
 * Read the team numbers off both alliance plates.
 *
 * Returns votes per side, so the matcher can use *where* a number appeared as
 * evidence and not merely that it appeared.
 *
 * Gathering the frames (a seek per sample point) and voting on them are split
 * into two functions -- `voteTeams` below does the actual reading and is the
 * part live monitoring also needs, over frames it already has buffered rather
 * than frames worth seeking for. This wrapper is the VOD-specific half: it
 * turns `t0` into seek points.
 */
export async function readTeams(input, t0, opts = {}) {
  const meta = opts.meta ?? (await probe(input));
  const pool = opts.pool;
  if (!pool) throw new Error('readTeams needs an OCR pool');

  const shots = [];
  for (const dt of SAMPLE_AT) {
    const at = t0 + dt;
    if (meta.duration && at > meta.duration - 1) continue;
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
  if (shots.length < 2) return null;

  const quads = opts.quads ?? detectScoreRegionsStable(shots, opts.layout ?? FRC_BROADCAST);
  if (!quads) return null;

  return voteTeams(shots, quads, pool, opts);
}

/**
 * Vote team numbers out of a set of already-in-hand frames.
 *
 * `opts.minVotes` defaults to the VOD threshold (5, over 5 sample frames x 3
 * prep variants). Live monitoring has fewer buffered samples to draw on and
 * passes a lower one -- see `live.mjs`.
 */
export async function voteTeams(shots, quads, pool, opts = {}) {
  const minVotes = opts.minVotes ?? MIN_VOTES;
  const votes = { blue: new Map(), red: new Map() };

  for (const frame of shots) {
    for (const side of ['blue', 'red']) {
      const sq = side === 'blue' ? quads.blue : quads.red;
      const [px0, px1] = plateExtent(frame, sq, side);
      const sx0 = Math.min(...sq.map((p) => p.x));
      const sx1 = Math.max(...sq.map((p) => p.x));
      const top = Math.min(...sq.map((p) => p.y));
      const bot = Math.max(...sq.map((p) => p.y));

      // The teams occupy the plate either side of the score: to its left on the
      // blue plate, to its right on the red one, mirrored about the timer.
      const tx0 = side === 'blue' ? px0 : sx1;
      const tx1 = side === 'blue' ? sx0 : px1;
      if (tx1 - tx0 < 0.02) continue;

      const gray = rectifyToGray(frame, rectQuad(tx0, top, tx1, bot), BAND_W, BAND_H);
      if (!gray) continue;
      const band = { data: gray, width: BAND_W, height: BAND_H };

      // Every preparation variant, not just the default. Measured: one clip's
      // overlay over-inks at k=0.2 badly enough that all three of its numbers
      // merge into single blobs and none segment at all.
      for (const variant of PREP_VARIANTS) {
        const groups = prepareNumberGroups(band, {
          ...variant,
          minDigits: MIN_DIGITS,
          maxDigits: MAX_DIGITS,
        });
        for (const g of groups) {
          const r = await pool.run((w) => recognizePlane(w, g));
          if (r.value === null || r.value < 1) continue;
          const m = votes[side];
          m.set(r.value, (m.get(r.value) || 0) + 1);
        }
      }
    }
  }

  const confident = (m) =>
    [...m.entries()].filter(([, n]) => n >= minVotes).map(([v]) => v);

  return {
    blue: confident(votes.blue),
    red: confident(votes.red),
    rawVotes: {
      blue: Object.fromEntries(votes.blue),
      red: Object.fromEntries(votes.red),
    },
    quads,
    frames: shots.length,
  };
}

/**
 * Score one schedule match against what was read.
 *
 * Side-aware: a number seen on the blue plate counts only towards that match's
 * blue alliance. Two matches can share five of six teams — 2026cagle has plenty
 * of near-repeats — but sharing them on the *same sides* is far rarer, so this
 * is what produces the margin that acceptance depends on.
 */
function scoreMatch(m, seen) {
  let score = 0;
  for (const t of seen.blue) if (m.blue.includes(t)) score++;
  for (const t of seen.red) if (m.red.includes(t)) score++;
  return score;
}

/**
 * Resolve a read against the schedule.
 *
 * Returns `{ matchKey, method, score, runnerUp }`, or a `null` matchKey with
 * the reason. A null is a dashboard row for a human to assign; a wrong key is
 * silent data loss. They are not close to equivalent, so the bar is high.
 */
export function matchBySet(schedule, seen) {
  if (!seen || (!seen.blue.length && !seen.red.length)) {
    return { matchKey: null, method: 'none', reason: 'no team numbers read' };
  }

  const scored = schedule
    .map((m) => ({ m, score: scoreMatch(m, seen) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const runnerUp = scored[1] ? scored[1].score : 0;

  if (best.score < MIN_SCORE) {
    return {
      matchKey: null,
      method: 'none',
      reason: 'best match only agreed on ' + best.score + ' of 6 teams',
      score: best.score,
      runnerUp,
    };
  }
  if (best.score - runnerUp < MIN_MARGIN) {
    return {
      matchKey: null,
      method: 'none',
      reason:
        'ambiguous: ' + best.m.matchKey + ' scored ' + best.score +
        ' but another match scored ' + runnerUp,
      score: best.score,
      runnerUp,
    };
  }

  return {
    matchKey: best.m.matchKey,
    matchNumber: best.m.matchNumber,
    method: 'teams',
    score: best.score,
    runnerUp,
  };
}

/**
 * Read a match's teams and resolve them against the schedule.
 *
 * `t0` is the green flag, as the scanner reports it.
 */
export async function identify(input, t0, schedule, opts = {}) {
  const seen = await readTeams(input, t0, opts);
  if (!seen) {
    return { matchKey: null, method: 'none', reason: 'could not read the plates' };
  }
  return { ...matchBySet(schedule, seen), seen };
}

export { MATCH_LEN };
