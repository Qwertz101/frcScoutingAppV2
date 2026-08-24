/**
 * How much should anyone trust this log?
 *
 * The pipeline writes automatically, so something has to decide which logs get
 * a human look. That decision is worth more than the score it produces: a
 * number nobody acts on is decoration, so every signal here either raises a
 * flag with a reason attached or does not belong.
 *
 * Signals combine as a weighted **product**, not an average. A log that is
 * excellent on five measures and catastrophic on the sixth is not "mostly
 * fine" — the catastrophic one is the whole story, and an average would bury
 * it. Multiplying lets any single collapse take the total with it.
 */

import { MATCH_LEN } from './core.mjs';

/** Below this, a log goes in the review queue. */
export const FLAG_BELOW = 0.55;

/** Thresholds that raise a flag in their own right, regardless of the product. */
const MIN_TIMER_ACCEPT = 0.5;
const MIN_READ_RATE = 0.6;
const MIN_COVERAGE = 0.75;
const MAX_RESYNCS = 3;
/** A fallback-timed log is capped here no matter how clean it otherwise looks. */
const FALLBACK_CAP = 0.3;

/** Scale a measured rate into 0..1, reaching 1 at `good` and 0 at `bad`. */
function ramp(v, bad, good) {
  if (!Number.isFinite(v)) return 0;
  if (v <= bad) return 0;
  if (v >= good) return 1;
  return (v - bad) / (good - bad);
}

/**
 * Score a processed match.
 *
 * `identification` is M5's result, or null when identification was not run.
 * `tbaAgreement` is filled in later by the reconcile pass — it is deliberately
 * not computed here, because TBA posts final scores minutes to hours after the
 * match and asking now would score every log against missing data.
 */
export function scoreQuality(log, diagnostics, identification = null) {
  const d = diagnostics;
  const samples = log.samples ?? [];
  const reasons = [];

  /* ---- timer ---- */
  const timerAcceptRate = d.timerOffered ? d.timerAccepted / d.timerOffered : 0;
  if (timerAcceptRate < MIN_TIMER_ACCEPT) {
    reasons.push('clock read only ' + Math.round(timerAcceptRate * 100) + '% of frames');
  }

  /* ---- scores ---- */
  const offered = (d.blueOffered ?? 0) + (d.redOffered ?? 0);
  const rejected = (d.blueRejections ?? 0) + (d.redRejections ?? 0);
  const readRate = offered ? (offered - rejected) / offered : 0;
  if (readRate < MIN_READ_RATE) {
    reasons.push('score OCR believed only ' + Math.round(readRate * 100) + '% of reads');
  }

  /* ---- coverage ---- */
  const distinct = new Set(samples.map((s) => s.sec)).size;
  const coverage = distinct / (MATCH_LEN + 1);
  if (coverage < MIN_COVERAGE) {
    reasons.push('only ' + distinct + ' of ' + (MATCH_LEN + 1) + ' match seconds logged');
  }

  /* ---- resyncs ---- */
  const resyncs = (d.blueResyncs ?? 0) + (d.redResyncs ?? 0);
  if (resyncs > MAX_RESYNCS) {
    reasons.push(resyncs + ' gate resyncs — the anchor moved on refused reads');
  }

  /* ---- monotonicity ---- */
  // Impossible by construction: the gate rejects decreases and the deltas are
  // rebuilt from the score series. A violation therefore does not mean the
  // footage was bad, it means this program has a bug, and the log should not
  // be trusted on any other measure either.
  const violations = samples.filter((s) => s.db < 0 || s.dr < 0).length;
  const monotonic = violations === 0;
  if (!monotonic) {
    reasons.push(violations + ' negative deltas — impossible by construction, so this is a bug');
  }

  /* ---- did it actually finish? ---- */
  // Not a flag on its own, but not free either. A log that stopped before the
  // score settled is very likely short of the real final: this session measured
  // an on-screen 641/420 against TBA's 645/438 purely because the reveal was
  // still climbing when the recording ended. So it costs a term, which is what
  // keeps the number and the stated reason telling the same story.
  const finished = Boolean(d.finished);
  if (!finished) {
    reasons.push('score never settled — the final may be short of the real one');
  }

  /* ---- identification ---- */
  //
  // Deliberately NOT folded into the score, which is a deviation from the plan.
  //
  // The plan had matchIdConfidence as one term in the product. Running it that
  // way produced a log whose scoreboard was read *perfectly* -- Einstein1's
  // 641-420, verified correct -- scoring 0.00 purely because the footage was
  // from a different event than the schedule it was matched against. On a
  // dashboard that reads as "the OCR failed", which is the opposite of true and
  // sends the reviewer looking in the wrong place.
  //
  // So `score` answers "how well was this scoreboard read" and identification
  // is reported beside it. Both still force the flag, so nothing escapes
  // review; only the diagnosis stays honest.
  let identified = null;
  let idConfidence = null;
  if (identification) {
    identified = Boolean(identification.matchKey);
    if (!identified) {
      reasons.push('match not identified: ' + (identification.reason ?? 'unknown'));
    } else if (identification.method === 'sequence') {
      idConfidence = 0.4;
      reasons.push('match identified by sequence position only');
    } else {
      const margin = (identification.score ?? 0) - (identification.runnerUp ?? 0);
      idConfidence = Number(
        (ramp(identification.score ?? 0, 3, 6) * 0.5 + ramp(margin, 1, 3) * 0.5).toFixed(3)
      );
    }
  }

  /* ---- combine ---- */
  const terms = {
    timer: ramp(timerAcceptRate, 0.3, 0.9),
    reads: ramp(readRate, 0.4, 0.95),
    coverage: ramp(coverage, 0.5, 0.95),
    resyncs: ramp(MAX_RESYNCS * 2 - resyncs, 0, MAX_RESYNCS),
    settled: finished ? 1 : 0.75,
  };

  let score = Object.values(terms).reduce((a, b) => a * b, 1);
  if (!monotonic) score = 0;
  if (d.timerFallback) {
    score = Math.min(score, FALLBACK_CAP);
    reasons.push('clock never locked — timing came from a fixed offset, not the scoreboard');
  }

  return {
    score: Number(score.toFixed(3)),
    /** How well the scoreboard was read. Identification is reported separately. */
    identified,
    idConfidence,
    flagged:
      score < FLAG_BELOW ||
      !monotonic ||
      Boolean(d.timerFallback) ||
      identified === false ||
      (idConfidence !== null && idConfidence < 0.5),
    reasons,
    signals: {
      timerAcceptRate: Number(timerAcceptRate.toFixed(3)),
      readRate: Number(readRate.toFixed(3)),
      coverage: Number(coverage.toFixed(3)),
      resyncs,
      monotonic,
      finished,
      timerFallback: Boolean(d.timerFallback),
      matchIdMethod: identification ? identification.method : null,
      matchIdScore: identification ? (identification.score ?? null) : null,
    },
    terms,
    /** Filled in by `worker reconcile`, once TBA has posted the real scores. */
    tbaAgreement: null,
  };
}

/**
 * Compare a log's final score against TBA's, once TBA has it.
 *
 * **Advisory only, and it must stay that way.** This session measured 641/420
 * on screen against TBA's 645/438 for a read that was *perfect* — the overlay
 * was still settling at the video's final frame. A disagreement of tens of
 * points is therefore normal and says nothing about OCR quality, which is why
 * this never lowers `score` and only ever annotates.
 */
export const TBA_TOLERANCE = 25;

export function agreementWithTba(log, tbaBlue, tbaRed) {
  const last = log.samples?.[log.samples.length - 1];
  if (!last || tbaBlue == null || tbaRed == null) return null;
  const db = Math.abs(last.blue - tbaBlue);
  const dr = Math.abs(last.red - tbaRed);
  return {
    ours: { blue: last.blue, red: last.red },
    tba: { blue: tbaBlue, red: tbaRed },
    delta: { blue: last.blue - tbaBlue, red: last.red - tbaRed },
    within: db <= TBA_TOLERANCE && dr <= TBA_TOLERANCE,
  };
}
