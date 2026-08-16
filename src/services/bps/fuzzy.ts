import {
  AUTO_LEN,
  BpsResult,
  BpsWindow,
  CvMatchLog,
  DataConfidence,
  MATCH_LEN,
  TimelineScoutingData,
} from '../../types';
import { solveBoxConstrained, solveGaussian, Matrix, Vector } from './linalg';
import { matchCountByTeam, scoringSecondsByTeam, secondsByTeam } from './windows';
import type { BpsReport } from './index';

/**
 * Fuzzy-occupancy BPS solver — the replacement for sharp windows.
 *
 * WHY SHARP WINDOWS MISATTRIBUTE
 * ==============================
 * `buildWindows()` slices a match wherever the flagged-scorer set changes and
 * credits every point inside a slice to exactly the robots flagged during it.
 * That assumes two things the field does not honour:
 *
 *   1. A point hits the scoreboard the instant the robot scores it. It does
 *      not — ball flight, goal sensing and display refresh add ~0.6-1.2s, and
 *      the lag varies shot to shot.
 *   2. The scout's button edges are the robot's activity edges. They are not,
 *      and two scouts on one alliance have DIFFERENT reaction biases.
 *
 * Simulation against known ground truth (see research/bps-fuzzy) measured the
 * cost: ~18% of all scored points land inside a TEAMMATE's marked window and
 * are credited to the wrong robot. That is not noise that averages out — it
 * moves rate from one team to another.
 *
 * THE FIX: OCCUPANCY INSTEAD OF A BINARY FLAG
 * ===========================================
 * Let a_i(t) be the scout's 0/1 flag. Define this robot's *occupancy* at
 * scoreboard time t as the flag convolved with the lag density g:
 *
 *     rho_i(t) = INTEGRAL a_i(tau) * g(t - tau) d tau
 *
 * g has mean MU (flight + processing) and spread SIGMA, where SIGMA absorbs
 * both flight variance and scout timing jitter — they blur identically from
 * here. Because a_i is a union of boxcars and g is Gaussian, the convolution
 * is ANALYTIC: a difference of two normal CDFs per segment. No numerical
 * integration, no sampling.
 *
 *     rho_i(t) = SUM_segments [ PHI((t - start - MU)/SIGMA)
 *                             - PHI((t - end   - MU)/SIGMA) ]
 *
 * The regression then runs per SECOND rather than per window:
 *
 *     delta_score(t)  ~=  SUM_i beta_i * rho_i(t)
 *
 * A point landing just outside robot A's window still draws most of its
 * credit from A, because rho_A is high there and rho_B, rho_C are not.
 *
 * TUNING — the counter-intuitive part
 * ===================================
 * A kernel sweep found SIGMA (the blur width) dominates accuracy while MU
 * (the shift) barely matters: moving MU across a full 1.35s range changed
 * median error by tenths of a percent, while widening SIGMA roughly doubled
 * it. The corollary, confirmed separately, is that simply shifting the CV
 * stream by the mean lag does NOT help — a global shift moves every robot
 * equally and so cannot change which robot is nearest a given point, and
 * teammate-stealing is a *relative* timing problem. The win comes from
 * softening attribution, not from correcting time.
 */

/** Lag kernel. SIGMA is the load-bearing parameter; see the module note. */
const MU = 0.9;
const SIGMA = 0.8;

/** Occupancy below this leaves a second unattributable — counted as orphan. */
const MIN_COVERAGE = 0.08;

/** Widest per-timeline alignment shift considered, in seconds. */
const MAX_SHIFT = 5;
const SHIFT_STEP = 0.5;

/** Physical ceiling on a robot's points per second — same as the sharp solver. */
const DEFAULT_CAP = 6;

const CONFIDENCE_WEIGHT: Record<DataConfidence, number> = {
  high: 1,
  moderate: 0.6,
  low: 0.25,
};

/* ------------------------------------------------------------------ *
 * Gaussian CDF
 * ------------------------------------------------------------------ */

/** Abramowitz & Stegun 7.1.26 — far more precision than a kernel weight needs. */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-a * a);
  return sign * y;
}

const PHI = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));

/* ------------------------------------------------------------------ *
 * Units and occupancy
 * ------------------------------------------------------------------ */

/** One alliance in one match: its timelines plus that alliance's score deltas. */
interface AllianceUnit {
  matchKey: string;
  alliance: 'red' | 'blue';
  timelines: TimelineScoutingData[];
  /** Indexed by whole second, 1..MATCH_LEN. */
  delta: Float64Array;
  /** Weight floor from the least-confident contributing scout. */
  conf: number;
}

/**
 * Occupancy of one timeline over 1-second bins, evaluated at bin centres.
 *
 * `offset` slides the whole timeline (the per-timeline alignment term). An
 * `oof` stretch suppresses occupancy — a dead robot cannot be the scorer.
 */
export function occupancy(
  timeline: TimelineScoutingData,
  offset = 0,
  mu = MU,
  sigma = SIGMA
): Float64Array {
  const shoot = timeline.segments.filter((s) => s.action === 'shoot');
  const oof = timeline.segments.filter((s) => s.action === 'oof');
  const out = new Float64Array(MATCH_LEN + 1);

  for (let t = 1; t <= MATCH_LEN; t++) {
    const u = t - 0.5;
    let acc = 0;
    for (const s of shoot) {
      acc += PHI((u - (s.start + offset) - mu) / sigma) - PHI((u - (s.end + offset) - mu) / sigma);
    }
    if (acc > 0 && oof.length) {
      let dead = 0;
      for (const s of oof) {
        dead += PHI((u - (s.start + offset) - mu) / sigma) - PHI((u - (s.end + offset) - mu) / sigma);
      }
      acc *= Math.max(0, 1 - Math.min(1, dead));
    }
    out[t] = Math.max(0, Math.min(1, acc));
  }
  return out;
}

/** Per-second positive score deltas for one alliance. */
function deltaSeries(log: CvMatchLog, alliance: 'red' | 'blue'): Float64Array {
  const out = new Float64Array(MATCH_LEN + 1);
  for (const s of log.samples) {
    const sec = Math.round(s.sec);
    if (sec < 1 || sec > MATCH_LEN) continue;
    const d = alliance === 'blue' ? s.db : s.dr;
    if (d > 0) out[sec] += d;
  }
  return out;
}

/**
 * Group timelines into (match, alliance) units and attach their CV series.
 *
 * Duplicate coverage of one robot collapses to the most confident then most
 * recent timeline — identical to `dedupeByTeam` in the sharp path, so the two
 * models always see the same roster.
 */
export function buildUnits(
  timelines: TimelineScoutingData[],
  cvLogs: CvMatchLog[]
): AllianceUnit[] {
  const logByMatch = new Map<string, CvMatchLog>();
  for (const l of cvLogs) {
    if (l.deletedAt || !l.samples?.length) continue;
    logByMatch.set(l.matchKey, l);
  }

  const grouped = new Map<string, TimelineScoutingData[]>();
  for (const t of timelines) {
    const key = `${t.matchKey}|${t.alliance}`;
    const list = grouped.get(key);
    if (list) list.push(t);
    else grouped.set(key, [t]);
  }

  const units: AllianceUnit[] = [];
  for (const [key, group] of grouped) {
    const [matchKey, alliance] = key.split('|') as [string, 'red' | 'blue'];
    const log = logByMatch.get(matchKey);
    if (!log) continue;

    const best = new Map<string, TimelineScoutingData>();
    for (const t of group) {
      const prev = best.get(t.teamKey);
      const a = CONFIDENCE_WEIGHT[t.confidence] ?? 0.5;
      const b = prev ? CONFIDENCE_WEIGHT[prev.confidence] ?? 0.5 : -1;
      if (!prev || a > b || (a === b && t.timestamp > prev.timestamp)) best.set(t.teamKey, t);
    }
    const kept = [...best.values()].filter((t) => /^frc\d+$/.test(t.teamKey));
    if (!kept.length) continue;

    units.push({
      matchKey,
      alliance,
      timelines: kept,
      delta: deltaSeries(log, alliance),
      conf: kept.reduce((lo, t) => Math.min(lo, CONFIDENCE_WEIGHT[t.confidence] ?? 0.5), 1),
    });
  }
  return units;
}

/* ------------------------------------------------------------------ *
 * Design assembly
 * ------------------------------------------------------------------ */

interface Row {
  /** [teamIndex, occupancy] pairs for the teams plausibly active this second. */
  cols: Array<[number, number]>;
  y: number;
  w: number;
  unitKey: string;
  phase: 'auto' | 'teleop';
  /** Unattributable score assigned to this alliance-match, subtracted from y. */
  background: number;
}

/**
 * Row weight: isolation times coverage.
 *
 *   isolation = max rho / sum rho  — 1 when one robot is the only plausible
 *               source, 1/3 when all three are equally plausible.
 *   coverage  = min(1, sum rho)    — kills near-empty seconds, which say
 *               nothing about anyone's rate.
 *
 * At full occupancy this reproduces the sharp weight exactly: one active
 * robot weighs 1 per second, three weigh a third each — which is what
 * `length / active.length` does today. Nothing regresses on clean data; the
 * generalisation only bites at the blurred edges.
 */
function rowWeight(rhos: number[], conf: number): { w: number; sum: number } {
  let sum = 0;
  let max = 0;
  for (const r of rhos) {
    sum += r;
    if (r > max) max = r;
  }
  if (sum <= 1e-9) return { w: 0, sum };
  return { w: conf * (max / sum) * Math.min(1, sum), sum };
}

function buildDesign(
  units: AllianceUnit[],
  teamIndex: Map<string, number>,
  offsets: Map<string, number>
): { rows: Row[]; orphan: number } {
  const rows: Row[] = [];
  let orphan = 0;

  for (const unit of units) {
    const unitKey = `${unit.matchKey}|${unit.alliance}`;
    const occ = unit.timelines.map((t) => occupancy(t, offsets.get(t.id) ?? 0));

    for (let sec = 1; sec <= MATCH_LEN; sec++) {
      const rhos = occ.map((o) => o[sec]);
      const { w, sum } = rowWeight(rhos, unit.conf);
      const y = unit.delta[sec];

      if (sum < MIN_COVERAGE) {
        if (y > 0) orphan += y;
        continue;
      }
      if (w <= 0) continue;

      const cols: Array<[number, number]> = [];
      for (let i = 0; i < rhos.length; i++) {
        if (rhos[i] <= 1e-6) continue;
        const c = teamIndex.get(unit.timelines[i].teamKey);
        if (c === undefined) continue;
        cols.push([c, rhos[i]]);
      }
      if (!cols.length) continue;

      rows.push({
        cols,
        y,
        w,
        unitKey,
        phase: sec <= AUTO_LEN ? 'auto' : 'teleop',
        background: 0,
      });
    }
  }

  return { rows, orphan };
}

/* ------------------------------------------------------------------ *
 * Solve
 * ------------------------------------------------------------------ */

interface SolveOpts {
  priors?: Vector;
  priorStrength?: number;
  lambdaFactor?: number;
}

/** Weighted ridge with non-negativity and a per-team cap, on per-second rows. */
function solveRows(rows: Row[], nTeams: number, opts: SolveOpts = {}): Vector {
  if (!rows.length || !nTeams) return new Array(nTeams).fill(0);

  // Accumulate the normal equations directly — a dense X would be
  // (seconds x teams) and is never needed.
  const A: Matrix = Array.from({ length: nTeams }, () => new Array(nTeams).fill(0));
  const rhs: Vector = new Array(nTeams).fill(0);

  for (const row of rows) {
    const yEff = row.y - row.background;
    for (let a = 0; a < row.cols.length; a++) {
      const [i, xi] = row.cols[a];
      const wxi = row.w * xi;
      rhs[i] += wxi * yEff;
      for (let b = a; b < row.cols.length; b++) {
        const [j, xj] = row.cols[b];
        A[i][j] += wxi * xj;
        if (i !== j) A[j][i] = A[i][j];
      }
    }
  }

  let trace = 0;
  for (let i = 0; i < nTeams; i++) trace += A[i][i];
  const scale = Math.max(1e-9, trace / nTeams);
  const lambda = (opts.lambdaFactor ?? 1e-3) * scale;
  const priorWeight = opts.priors ? (opts.priorStrength ?? 0.35) * scale : 0;

  for (let i = 0; i < nTeams; i++) {
    A[i][i] += lambda + priorWeight;
    if (priorWeight > 0) rhs[i] += priorWeight * (opts.priors?.[i] ?? 0);
  }

  const lower = new Array(nTeams).fill(0);
  const upper = new Array(nTeams).fill(DEFAULT_CAP);
  const warm = solveGaussian(A, rhs) ?? undefined;
  return solveBoxConstrained(A, rhs, lower, upper, warm);
}

/**
 * Per-timeline clock alignment.
 *
 * The sharp pipeline searches ONE shift per match and applies it to the CV
 * stream, which slides all six robots together. Its own source comments
 * record why that is not enough: three scouts on one alliance have three
 * different reaction times, so a shared shift can only fit the loudest
 * scorer's timing at the others' expense. Timing error is a property of a
 * SCOUT ON A MATCH, so that is where the offset belongs.
 *
 * Holding rates fixed, each timeline is slid over a grid and scored by how
 * well its own alliance-match's per-second score is explained. A parabolic
 * refinement through the best grid point and its neighbours gives sub-step
 * resolution without a finer grid. Ties prefer zero, so a well-timed scout is
 * left alone.
 *
 * Measured on simulated data: recovers the needed shift with correlation
 * ~0.70, roughly halving a rookie scout's timing error. It slightly WORSENS
 * an already-accurate scout, because a scalar fitted to noise beats no
 * correction only when there is something real to correct.
 */
function alignTimelines(
  units: AllianceUnit[],
  teamIndex: Map<string, number>,
  beta: Vector,
  offsets: Map<string, number>
): Map<string, number> {
  const next = new Map(offsets);

  for (const unit of units) {
    const occCache = unit.timelines.map((t) => occupancy(t, next.get(t.id) ?? 0));

    unit.timelines.forEach((tl, idx) => {
      const myIdx = teamIndex.get(tl.teamKey);
      const myBeta = myIdx === undefined ? 0 : beta[myIdx] ?? 0;
      // A robot with no solved rate carries no signal to align on.
      if (myBeta <= 1e-6) return;

      const others = new Float64Array(MATCH_LEN + 1);
      unit.timelines.forEach((o, j) => {
        if (j === idx) return;
        const oi = teamIndex.get(o.teamKey);
        const b = oi === undefined ? 0 : beta[oi] ?? 0;
        for (let s = 1; s <= MATCH_LEN; s++) others[s] += b * occCache[j][s];
      });

      const grid: number[] = [];
      for (let s = -MAX_SHIFT; s <= MAX_SHIFT + 1e-9; s += SHIFT_STEP) grid.push(s);

      const errs = grid.map((shift) => {
        const occ = occupancy(tl, shift);
        let err = 0;
        for (let s = 1; s <= MATCH_LEN; s++) {
          const r = others[s] + myBeta * occ[s] - unit.delta[s];
          err += r * r;
        }
        return err;
      });

      let bestErr = Infinity;
      let bestIdx = 0;
      errs.forEach((e, i) => {
        // Prefer no shift on ties: only move time when the data asks for it.
        const tieBreak = Math.abs(grid[i]) * 1e-6;
        if (e + tieBreak < bestErr) {
          bestErr = e + tieBreak;
          bestIdx = i;
        }
      });

      let bestShift = grid[bestIdx];
      if (bestIdx > 0 && bestIdx < grid.length - 1) {
        const [a, b, c] = [errs[bestIdx - 1], errs[bestIdx], errs[bestIdx + 1]];
        const denom = a - 2 * b + c;
        if (Math.abs(denom) > 1e-12) {
          const d = (0.5 * (a - c)) / denom;
          if (Math.abs(d) <= 1) bestShift += d * SHIFT_STEP;
        }
      }
      next.set(tl.id, bestShift);
    });
  }

  return next;
}

/**
 * Score an alliance gained that no flagged robot can explain.
 *
 * An endgame climb is the clean case: points land at once, produced by no
 * shooting at all. With nowhere to put them they inflate whichever robot was
 * still flagged at the buzzer. Estimated per alliance-match as a non-negative
 * constant, alternating with the fit.
 *
 * NOT optional when alignment is on. Alignment alone measured WORSE than
 * plain occupancy, because with no home for a climb lump the aligner does
 * what it is told and slides a timeline forward until it covers points the
 * robot had nothing to do with. The two ship together or not at all.
 */
function estimateBackground(rows: Row[], beta: Vector): void {
  const acc = new Map<string, { resid: number; n: number }>();
  for (const row of rows) {
    let pred = 0;
    for (const [i, x] of row.cols) pred += (beta[i] ?? 0) * x;
    const cur = acc.get(row.unitKey) ?? { resid: 0, n: 0 };
    cur.resid += row.y - pred;
    cur.n += 1;
    acc.set(row.unitKey, cur);
  }
  const bg = new Map<string, number>();
  for (const [k, v] of acc) {
    // Only POSITIVE unexplained score is background. A negative mean residual
    // means the rates over-predict, which is the rates' problem, not a lump's.
    bg.set(k, Math.max(0, v.resid / Math.max(1, v.n)));
  }
  for (const row of rows) row.background = bg.get(row.unitKey) ?? 0;
}

/* ------------------------------------------------------------------ */

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * Run the fuzzy pipeline, returning the same `BpsReport` shape the sharp
 * pipeline produces so every downstream screen keeps working unchanged.
 */
export function runFuzzyPipeline(
  timelines: TimelineScoutingData[],
  cvLogs: CvMatchLog[]
): BpsReport {
  const activeLogs = cvLogs.filter((l) => !l.deletedAt && l.samples?.length);
  const units = buildUnits(timelines, activeLogs);

  const teams = [...new Set(units.flatMap((u) => u.timelines.map((t) => t.teamKey)))].sort();
  const teamIndex = new Map(teams.map((t, i) => [t, i]));

  let offsets = new Map<string, number>();
  let design = buildDesign(units, teamIndex, offsets);
  let beta: Vector = new Array(teams.length).fill(0);

  // Alternate: fit -> absorb unattributable score -> re-align -> refit.
  const OUTER = 3;
  for (let outer = 0; outer < OUTER && teams.length; outer++) {
    if (outer > 0) estimateBackground(design.rows, beta);
    beta = solveRows(design.rows, teams.length, {
      // Shrink toward the previous round's fit once there is one, which keeps
      // the alternation stable.
      priors: outer > 0 ? beta : undefined,
    });
    if (outer < OUTER - 1) {
      offsets = alignTimelines(units, teamIndex, beta, offsets);
      design = buildDesign(units, teamIndex, offsets);
      estimateBackground(design.rows, beta);
    }
  }

  // Per-phase rates, each shrunk toward the overall rate — AUTO contributes
  // only 20s a match and cannot stand on its own.
  const phaseRates = (phase: 'auto' | 'teleop'): Vector => {
    const rows = design.rows.filter((r) => r.phase === phase);
    if (!rows.length) return beta.slice();
    return solveRows(rows, teams.length, { priors: beta, priorStrength: 0.6 });
  };
  const autoBeta = teams.length ? phaseRates('auto') : [];
  const teleopBeta = teams.length ? phaseRates('teleop') : [];

  // One synthetic window per alliance-match so `report.windows` still answers
  // "which matches did the solver actually fuse", which is what teamMetrics
  // keys the BPS-vs-legacy choice on.
  const windows: BpsWindow[] = units.map((u) => {
    let score = 0;
    for (let s = 1; s <= MATCH_LEN; s++) score += u.delta[s];
    return {
      matchKey: u.matchKey,
      alliance: u.alliance,
      start: 0,
      length: MATCH_LEN,
      phase: 'teleop',
      teams: u.timelines.map((t) => t.teamKey),
      score,
      weight: u.conf,
    };
  });

  const seconds = scoringSecondsByTeam(timelines);
  const passSecs = secondsByTeam(timelines, 'pass');
  const matchCounts = matchCountByTeam(timelines);
  const allTeams = [...new Set([...teams, ...seconds.keys()])].sort();

  const results: BpsResult[] = allTeams.map((teamKey) => {
    const i = teamIndex.get(teamKey);
    const bps = i === undefined ? 0 : beta[i] ?? 0;
    const teleop = i === undefined ? bps : teleopBeta[i] ?? bps;
    const passSeconds = round3(passSecs.get(teamKey) ?? 0);
    const passedFuel = passSeconds * teleop;
    const matches = matchCounts.get(teamKey) ?? 0;

    return {
      teamKey,
      bps: round3(bps),
      autoBps: round3(i === undefined ? bps : autoBeta[i] ?? bps),
      teleopBps: round3(teleop),
      // Seconds this robot was plausibly the scorer, which is the fuzzy
      // analogue of "windows I appeared in".
      windows: design.rows.filter((r) => r.cols.some(([c]) => c === i)).length,
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
    lambda: 0,
    timeShifts: Object.fromEntries([...offsets].map(([id, v]) => [id, round3(v)])),
    diagnostics: {
      matches: new Set(units.map((u) => u.matchKey)).size,
      teams: allTeams.length,
      windowCount: design.rows.length,
      orphanScore: round3(design.orphan),
      droppedWindows: 0,
    },
  };
}
