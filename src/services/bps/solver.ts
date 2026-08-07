import { BpsWindow } from '../../types';
import {
  Matrix,
  Vector,
  normalEquations,
  solveBoxConstrained,
  solveGaussian,
  weightedRss,
  zeros,
} from './linalg';

/**
 * Weighted ridge regression with non-negativity and per-team caps.
 *
 *   β = argmin ‖W^½(Xβ − y)‖² + λ‖β‖²   subject to   0 ≤ βⱼ ≤ capⱼ
 *
 * Each row of X is one window: entry (w, i) is the window length when team i
 * was flagged as scoring, and 0 otherwise, so the row encodes both Aw and Lw
 * from the per-window equation Σ BPSᵢ·Lw ≈ Sw.
 */

export interface SolveOptions {
  /**
   * Upper bound on any team's points-per-second. Defaults to a generous
   * ceiling; per-team caps override it where a robot's mechanism is known.
   */
  defaultCap?: number;
  capsByTeam?: Record<string, number>;
  /** Shrink toward these values instead of toward zero (the two-pass prior). */
  priors?: Record<string, number>;
  /** Strength of the pull toward `priors`, relative to the ridge penalty. */
  priorWeight?: number;
  /** Fix λ instead of searching for it. */
  lambda?: number;
}

export interface SolveOutput {
  teams: string[];
  bps: Vector;
  lambda: number;
  /** Windows each team appeared in. */
  windowCounts: Record<string, number>;
  rss: number;
}

/**
 * A physical ceiling, not a statistical one. Even an extremely strong 2026
 * robot scoring continuously sits far below this; the cap exists to stop a
 * near-singular alliance matrix from parking all of an alliance's points on
 * one robot.
 */
const DEFAULT_CAP = 6;

export function solveBps(windows: BpsWindow[], opts: SolveOptions = {}): SolveOutput {
  const teams = [...new Set(windows.flatMap((w) => w.teams))].sort();
  if (!teams.length || !windows.length) {
    return { teams, bps: [], lambda: 0, windowCounts: {}, rss: 0 };
  }

  const index = new Map(teams.map((t, i) => [t, i]));
  const rows = windows.length;
  const cols = teams.length;

  const X: Matrix = Array.from({ length: rows }, () => new Array(cols).fill(0));
  const y: Vector = zeros(rows);
  const w: Vector = zeros(rows);
  const windowCounts: Record<string, number> = {};

  windows.forEach((win, r) => {
    for (const team of win.teams) {
      const c = index.get(team);
      if (c === undefined) continue;
      // The design entry is the window length: over Lw seconds a team
      // contributes BPSᵢ·Lw points.
      X[r][c] = win.length;
      windowCounts[team] = (windowCounts[team] ?? 0) + 1;
    }
    y[r] = win.score;
    w[r] = Math.max(0, win.weight);
  });

  const defaultCap = opts.defaultCap ?? DEFAULT_CAP;
  const lower = zeros(cols);
  const upper = teams.map((t) => Math.max(0, opts.capsByTeam?.[t] ?? defaultCap));

  // Prior shrinkage enters as extra diagonal mass plus a matching push on the
  // right-hand side — algebraically identical to adding a row per team that
  // says βᵢ ≈ priorᵢ, which is what pass 2 wants.
  const priorWeight = opts.priors ? opts.priorWeight ?? 0 : 0;
  const priorVec = teams.map((t) => opts.priors?.[t] ?? 0);

  const build = (lambda: number) => {
    const { A, rhs } = normalEquations(X, y, w, lambda);
    if (priorWeight > 0) {
      for (let i = 0; i < cols; i++) {
        A[i][i] += priorWeight;
        rhs[i] += priorWeight * priorVec[i];
      }
    }
    return { A, rhs };
  };

  const lambda = opts.lambda ?? chooseLambda(X, y, w, build, cols);
  const { A, rhs } = build(lambda);

  // Unconstrained ridge solve first — a warm start that lands coordinate
  // descent near the answer, and the spec's named Gaussian-elimination step.
  const warm = solveGaussian(A, rhs) ?? undefined;
  const bps = solveBoxConstrained(A, rhs, lower, upper, warm);

  return {
    teams,
    bps,
    lambda,
    windowCounts,
    rss: weightedRss(X, y, w, bps),
  };
}

/**
 * Adaptive ridge penalty.
 *
 * Alliance matrices are near-singular whenever the same three robots always
 * appear together, which is common early in an event. We take the smallest λ
 * on a log ladder whose system is both solvable and not wildly scaled — small
 * enough to stay faithful to the data, large enough to stay stable.
 */
function chooseLambda(
  X: Matrix,
  y: Vector,
  w: Vector,
  build: (lambda: number) => { A: Matrix; rhs: Vector },
  cols: number
): number {
  // Scale the ladder to the problem: λ is only meaningful relative to the
  // magnitudes in XᵀWX, which grow with window length and weight.
  const { A: base } = normalEquations(X, y, w, 0);
  let trace = 0;
  for (let i = 0; i < cols; i++) trace += base[i][i];
  const scale = Math.max(1e-9, trace / cols);

  for (const factor of [1e-6, 1e-5, 1e-4, 1e-3, 1e-2, 1e-1, 1]) {
    const lambda = factor * scale;
    const { A, rhs } = build(lambda);
    const sol = solveGaussian(A, rhs);
    if (!sol) continue;
    // Reject solutions that only "work" by producing absurd magnitudes — a
    // tell-tale of an ill-conditioned system that elimination did not catch.
    const maxAbs = sol.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    if (maxAbs < 1e3) return lambda;
  }

  return scale;
}

/** Convenience: solved rates keyed by team. */
export function toRateMap(out: SolveOutput): Record<string, number> {
  const map: Record<string, number> = {};
  out.teams.forEach((t, i) => {
    map[t] = out.bps[i] ?? 0;
  });
  return map;
}
