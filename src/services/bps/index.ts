import {
  AUTO_LEN,
  BpsResult,
  BpsWindow,
  CvMatchLog,
  MATCH_LEN,
  TimelineScoutingData,
} from '../../types';
import {
  buildWindows,
  matchCountByTeam,
  scoringSecondsByTeam,
  secondsByTeam,
  shiftSamples,
} from './windows';
import { SolveOptions, solveBps, toRateMap } from './solver';

export { buildWindows, buildAllianceWindows } from './windows';
export { solveBps, toRateMap } from './solver';
export type { SolveOptions, SolveOutput } from './solver';
export { runFuzzyPipeline, occupancy, buildUnits } from './fuzzy';
export { buildMatchPoints, matchPointsKey, anchorSummary } from './matchPoints';
export type { MatchPointsMap, MatchPointsEntry } from './matchPoints';

/**
 * The full BPS pipeline: fuse the two streams, then run the four optimisation
 * passes the procedure spec calls for.
 *
 *   1. Two-pass prior shrinkage — event-wide baseline, then per-match re-solve
 *      shrunk toward it, so one anomalous match cannot define a team.
 *   2. Time-sync auto-tuning — small per-match shift absorbing livestream lag.
 *   3. Per-phase breakdown — independent auto and teleop rates.
 *   4. Anomaly cleanup — unattributable score removed, sustained misflags
 *      down-weighted.
 */

export interface BpsPipelineOptions extends SolveOptions {
  /** Largest per-match time correction to consider, in seconds. */
  maxTimeShift?: number;
  timeShiftStep?: number;
  /** How hard pass 2 pulls a match toward the event-wide prior. */
  priorStrength?: number;
  /** Skip passes — useful for diagnosing what a pass is contributing. */
  passes?: {
    priorShrinkage?: boolean;
    timeSync?: boolean;
    perPhase?: boolean;
    anomalyCleanup?: boolean;
  };
}

export interface BpsReport {
  results: BpsResult[];
  byTeam: Record<string, BpsResult>;
  windows: BpsWindow[];
  lambda: number;
  /** Per-match time corrections chosen by pass 2, in seconds. */
  timeShifts: Record<string, number>;
  diagnostics: {
    matches: number;
    teams: number;
    windowCount: number;
    /** Alliance-seconds where score moved with nobody flagged. */
    orphanScore: number;
    droppedWindows: number;
  };
}

const DEFAULTS = {
  /**
   * Widest per-match time correction considered, in seconds.
   *
   * The spec suggests ±3s, sized for livestream lag. That was the right bound
   * when both streams were machine-timed, but the human stream is not: a scout
   * starts their clock by hand at the buzzer, and being several seconds late
   * on a noisy field is ordinary. Once the CV stream derives its timestamps
   * from the scoreboard clock it is the accurate side of the pair, so what
   * this pass now mostly absorbs is scout reaction time — which needs more
   * room than lag did.
   *
   * The search still prefers zero on ties, so a well-timed match is left alone.
   */
  maxTimeShift: 8,
  timeShiftStep: 0.5,
  priorStrength: 0.35,
};

export function runBpsPipeline(
  timelines: TimelineScoutingData[],
  cvLogs: CvMatchLog[],
  opts: BpsPipelineOptions = {}
): BpsReport {
  const passes = {
    priorShrinkage: true,
    timeSync: true,
    perPhase: true,
    anomalyCleanup: true,
    ...(opts.passes ?? {}),
  };

  const activeLogs = cvLogs.filter((l) => !l.deletedAt && l.samples.length);

  // ---- Pass 0: baseline fit -------------------------------------------
  let windows = buildWindows(timelines, activeLogs);
  const orphanScore = countOrphanScore(timelines, activeLogs);

  let dropped = 0;
  if (passes.anomalyCleanup) {
    const cleaned = stripAnomalies(windows);
    dropped = windows.length - cleaned.length;
    windows = cleaned;
  }

  if (!windows.length) {
    return emptyReport(timelines, orphanScore, dropped);
  }

  const baseline = solveBps(windows, opts);
  let priors = toRateMap(baseline);
  let lambda = baseline.lambda;

  // ---- Pass 2: time-sync auto-tuning ----------------------------------
  // Run before prior shrinkage so the shrinkage pass sees correctly aligned
  // windows; a mis-timed match would otherwise poison the priors it shrinks to.
  //
  // Gated on having at least two solved matches. The pass searches for a
  // per-match shift that best fits `priors` — but with only one match solved,
  // those priors ARE that match's own baseline fit, so the search is scoring
  // each shift against itself. Verified this is a real failure mode, not a
  // theoretical one: on a single real match with three scouted robots, a
  // shift that cut aggregate weighted residual ~19% took one robot's rate
  // from a clean, well-evidenced 1.09 to a hard 0 — not because its evidence
  // vanished (13 solo-scored windows summing to 32 points barely moved), but
  // because three independent scouts each pressed Start with their own
  // reaction-time lag, and one shared match-wide shift can only fit the
  // dominant scorer's timing at the others' expense. A second match with
  // frc3255 in it gives the shrinkage pass an external prior to check the
  // shift against instead of just this match's own fit; short of that, not
  // shifting at all is the safer default.
  const solvedMatchCount = new Set(windows.map((w) => w.matchKey)).size;
  const timeShifts: Record<string, number> = {};
  if (passes.timeSync && solvedMatchCount >= 2) {
    const tuned = tuneTimeShifts(timelines, activeLogs, priors, opts);
    Object.assign(timeShifts, tuned.shifts);
    if (tuned.changed) {
      windows = tuned.windows;
      if (passes.anomalyCleanup) {
        const cleaned = stripAnomalies(windows);
        dropped += windows.length - cleaned.length;
        windows = cleaned;
      }
      const refit = solveBps(windows, opts);
      priors = toRateMap(refit);
      lambda = refit.lambda;
    }
  }

  // ---- Pass 1: two-pass prior shrinkage -------------------------------
  let finalRates = priors;
  let windowCounts = baseline.windowCounts;
  if (passes.priorShrinkage) {
    const shrunk = solveBps(windows, {
      ...opts,
      priors,
      priorWeight: (opts.priorStrength ?? DEFAULTS.priorStrength) * averageDiagonal(windows),
    });
    finalRates = toRateMap(shrunk);
    windowCounts = shrunk.windowCounts;
    lambda = shrunk.lambda;
  }

  // ---- Pass 3: per-phase breakdown ------------------------------------
  let autoRates: Record<string, number> = {};
  let teleopRates: Record<string, number> = {};
  if (passes.perPhase) {
    const autoWindows = windows.filter((w) => w.phase === 'auto');
    const teleopWindows = windows.filter((w) => w.phase === 'teleop');
    // Each phase is shrunk toward the overall rate: auto contributes only 20s
    // per match, far too little to stand on its own.
    autoRates = phaseRates(autoWindows, finalRates, opts);
    teleopRates = phaseRates(teleopWindows, finalRates, opts);
  }

  const seconds = scoringSecondsByTeam(timelines);
  const passSecs = secondsByTeam(timelines, 'pass');
  const matchCounts = matchCountByTeam(timelines);
  const teams = [...new Set([...Object.keys(finalRates), ...seconds.keys()])].sort();

  const results: BpsResult[] = teams.map((teamKey) => {
    const bps = round3(finalRates[teamKey] ?? 0);
    const passSeconds = round3(passSecs.get(teamKey) ?? 0);
    // Teleop rate, not overall: passing happens in teleop, and the auto rate
    // is solved from only 20s a match so it is far noisier.
    const handlingRate = teleopRates[teamKey] ?? finalRates[teamKey] ?? 0;
    const passedFuel = passSeconds * handlingRate;
    const matches = matchCounts.get(teamKey) ?? 0;

    return {
      teamKey,
      bps,
      autoBps: round3(autoRates[teamKey] ?? finalRates[teamKey] ?? 0),
      teleopBps: round3(handlingRate),
      windows: windowCounts[teamKey] ?? 0,
      scoringSeconds: round3(seconds.get(teamKey) ?? 0),
      passSeconds,
      passedFuel: round3(passedFuel),
      passedFuelPerMatch: matches ? round3(passedFuel / matches) : 0,
    };
  });

  const byTeam: Record<string, BpsResult> = {};
  for (const r of results) byTeam[r.teamKey] = r;

  return {
    results,
    byTeam,
    windows,
    lambda,
    timeShifts,
    diagnostics: {
      matches: new Set(windows.map((w) => w.matchKey)).size,
      teams: teams.length,
      windowCount: windows.length,
      orphanScore,
      droppedWindows: dropped,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Pass 4 — anomaly cleanup
 * ------------------------------------------------------------------ */

/**
 * Remove windows that cannot inform the fit.
 *
 * Two cases, both scouting noise rather than robot behaviour:
 *  - Sub-second slivers, which are almost always a scout's finger bouncing
 *    between buttons rather than a real change of activity.
 *  - Long stretches where the whole alliance was flagged scoring and the
 *    scoreboard never moved. One of those is ordinary (a dry spell); a
 *    persistent pattern is a stuck button, so we drop the most extreme.
 */
function stripAnomalies(windows: BpsWindow[]): BpsWindow[] {
  const kept = windows.filter((w) => w.length >= 0.4);

  const zeroLong = kept.filter((w) => w.score === 0 && w.length >= 15);
  if (zeroLong.length > kept.length * 0.5) {
    // More than half the evidence is empty long windows — the event is just
    // low-scoring. Trust the data rather than gutting it.
    return kept;
  }
  const drop = new Set(zeroLong.filter((w) => w.length >= 25));
  return kept.filter((w) => !drop.has(w));
}

/** Alliance score that moved while no robot was flagged as scoring. */
function countOrphanScore(
  timelines: TimelineScoutingData[],
  cvLogs: CvMatchLog[]
): number {
  const all = buildWindows(timelines, cvLogs);
  const covered = new Map<string, Array<[number, number]>>();
  for (const w of all) {
    const key = `${w.matchKey}|${w.alliance}`;
    const list = covered.get(key) ?? [];
    list.push([w.start, w.start + w.length]);
    covered.set(key, list);
  }

  let orphan = 0;
  for (const log of cvLogs) {
    for (const alliance of ['blue', 'red'] as const) {
      const spans = covered.get(`${log.matchKey}|${alliance}`) ?? [];
      for (const s of log.samples) {
        const d = alliance === 'blue' ? s.db : s.dr;
        if (d <= 0) continue;
        const inside = spans.some(([a, b]) => s.sec > a && s.sec <= b);
        if (!inside) orphan += d;
      }
    }
  }
  return orphan;
}

/* ------------------------------------------------------------------ *
 * Pass 2 — time-sync auto-tuning
 * ------------------------------------------------------------------ */

/**
 * Livestream video lags the field by a variable second or two, so the CV
 * timestamps and the human flags drift apart. For each match we try small
 * shifts and keep the one that best explains the score under current rates.
 */
function tuneTimeShifts(
  timelines: TimelineScoutingData[],
  cvLogs: CvMatchLog[],
  priors: Record<string, number>,
  opts: BpsPipelineOptions
): { windows: BpsWindow[]; shifts: Record<string, number>; changed: boolean } {
  const maxShift = opts.maxTimeShift ?? DEFAULTS.maxTimeShift;
  const step = opts.timeShiftStep ?? DEFAULTS.timeShiftStep;

  const shifts: Record<string, number> = {};
  const out: BpsWindow[] = [];
  let changed = false;

  const byMatch = new Map<string, TimelineScoutingData[]>();
  for (const t of timelines) {
    const list = byMatch.get(t.matchKey) ?? [];
    list.push(t);
    byMatch.set(t.matchKey, list);
  }

  for (const log of cvLogs) {
    const matchTimelines = byMatch.get(log.matchKey);
    if (!matchTimelines?.length) continue;

    let bestShift = 0;
    let bestErr = Infinity;
    let bestWindows: BpsWindow[] = [];

    for (let s = -maxShift; s <= maxShift + 1e-9; s += step) {
      const shifted: CvMatchLog = { ...log, samples: shiftSamples(log.samples, s) };
      const w = buildWindows(matchTimelines, [shifted]);
      if (!w.length) continue;

      const err = residualUnder(w, priors);
      // Prefer no shift on ties: only move time when the data asks for it.
      if (err < bestErr - 1e-9 || (Math.abs(err - bestErr) <= 1e-9 && s === 0)) {
        bestErr = err;
        bestShift = s;
        bestWindows = w;
      }
    }

    if (bestWindows.length) {
      out.push(...bestWindows);
      shifts[log.matchKey] = round3(bestShift);
      if (bestShift !== 0) changed = true;
    }
  }

  return { windows: out, shifts, changed };
}

/** Weighted squared error of a window set under fixed rates. */
function residualUnder(windows: BpsWindow[], rates: Record<string, number>): number {
  let acc = 0;
  for (const w of windows) {
    let pred = 0;
    for (const t of w.teams) pred += (rates[t] ?? 0) * w.length;
    const r = pred - w.score;
    acc += w.weight * r * r;
  }
  return acc;
}

/* ------------------------------------------------------------------ *
 * Pass 3 — per-phase rates
 * ------------------------------------------------------------------ */

function phaseRates(
  windows: BpsWindow[],
  overall: Record<string, number>,
  opts: BpsPipelineOptions
): Record<string, number> {
  if (!windows.length) return {};
  const solved = solveBps(windows, {
    ...opts,
    priors: overall,
    priorWeight: 0.6 * averageDiagonal(windows),
  });
  return toRateMap(solved);
}

/* ------------------------------------------------------------------ */

/**
 * Typical magnitude of a diagonal entry of XᵀWX, so prior strength can be
 * expressed as a fraction of the evidence rather than an absolute number.
 */
function averageDiagonal(windows: BpsWindow[]): number {
  if (!windows.length) return 1;
  let acc = 0;
  for (const w of windows) acc += w.weight * w.length * w.length;
  const teams = new Set(windows.flatMap((w) => w.teams)).size || 1;
  return Math.max(1e-6, acc / teams);
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

function emptyReport(
  timelines: TimelineScoutingData[],
  orphanScore: number,
  dropped: number
): BpsReport {
  const seconds = scoringSecondsByTeam(timelines);
  const passSecs = secondsByTeam(timelines, 'pass');
  // With no solved rate there is no handling rate either, so passed fuel stays
  // 0 rather than being guessed from seconds alone.
  const results: BpsResult[] = [...seconds.keys()].sort().map((teamKey) => ({
    teamKey,
    bps: 0,
    autoBps: 0,
    teleopBps: 0,
    windows: 0,
    scoringSeconds: round3(seconds.get(teamKey) ?? 0),
    passSeconds: round3(passSecs.get(teamKey) ?? 0),
    passedFuel: 0,
    passedFuelPerMatch: 0,
  }));
  const byTeam: Record<string, BpsResult> = {};
  for (const r of results) byTeam[r.teamKey] = r;

  return {
    results,
    byTeam,
    windows: [],
    lambda: 0,
    timeShifts: {},
    diagnostics: {
      matches: 0,
      teams: results.length,
      windowCount: 0,
      orphanScore,
      droppedWindows: dropped,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Derived per-match numbers
 * ------------------------------------------------------------------ */

/**
 * Points a robot is credited with in one match: its solved rate times the
 * seconds it was flagged scoring in that match, split by phase.
 */
export function matchPointsFromTimeline(
  timeline: TimelineScoutingData,
  rates: BpsResult | undefined
): { auto: number; teleop: number; total: number } {
  if (!rates) return { auto: 0, teleop: 0, total: 0 };

  let autoSec = 0;
  let teleopSec = 0;
  for (const s of timeline.segments) {
    if (s.action !== 'shoot') continue;
    const start = Math.max(0, Math.min(MATCH_LEN, s.start));
    const end = Math.max(0, Math.min(MATCH_LEN, s.end));
    if (end <= start) continue;
    autoSec += Math.max(0, Math.min(end, AUTO_LEN) - Math.min(start, AUTO_LEN));
    teleopSec += Math.max(0, end - Math.max(start, AUTO_LEN));
  }

  const auto = autoSec * rates.autoBps;
  const teleop = teleopSec * rates.teleopBps;
  return { auto: round3(auto), teleop: round3(teleop), total: round3(auto + teleop) };
}

/** Seconds spent in each action, for summary tiles. */
export function actionTotals(timeline: TimelineScoutingData): Record<string, number> {
  const out: Record<string, number> = { shoot: 0, pass: 0, def: 0, oof: 0 };
  for (const s of timeline.segments) {
    out[s.action] = (out[s.action] ?? 0) + Math.max(0, s.end - s.start);
  }
  return out;
}
