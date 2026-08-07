/**
 * Dense linear algebra for the BPS solver.
 *
 * Small by design: the normal-equation system is (teams × teams), so at an
 * event that is at most ~50×50. Dense arrays beat any sparse machinery here,
 * and keeping it dependency-free keeps the PWA bundle small.
 */

export type Matrix = number[][];
export type Vector = number[];

export const zeros = (n: number): Vector => new Array(n).fill(0);

export const zeroMatrix = (rows: number, cols: number): Matrix =>
  Array.from({ length: rows }, () => new Array(cols).fill(0));

/**
 * Solve `A x = b` by Gaussian elimination with partial pivoting — the method
 * the procedure spec names for the ridge system.
 *
 * Returns null when the system is singular to working precision. Callers are
 * expected to respond by raising the ridge penalty, which is exactly what the
 * adaptive-λ search in solver.ts does.
 */
export function solveGaussian(A: Matrix, b: Vector): Vector | null {
  const n = b.length;
  if (n === 0) return [];

  // Work on copies — callers reuse A across λ candidates.
  const M: Matrix = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    // Partial pivot: largest magnitude in this column at or below the diagonal.
    let pivotRow = col;
    let best = Math.abs(M[col][col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(M[r][col]);
      if (v > best) {
        best = v;
        pivotRow = r;
      }
    }

    // Scale-aware singularity test. An absolute epsilon would misjudge systems
    // whose entries are all large (long windows) or all small (short ones).
    const scale = rowScale(M, col, n);
    if (best <= 1e-12 * Math.max(1, scale)) return null;

    if (pivotRow !== col) {
      const tmp = M[pivotRow];
      M[pivotRow] = M[col];
      M[col] = tmp;
    }

    const pivot = M[col][col];
    for (let r = col + 1; r < n; r++) {
      const factor = M[r][col] / pivot;
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }

  // Back-substitution.
  const x = zeros(n);
  for (let i = n - 1; i >= 0; i--) {
    let acc = M[i][n];
    for (let j = i + 1; j < n; j++) acc -= M[i][j] * x[j];
    x[i] = acc / M[i][i];
  }

  return x.every(Number.isFinite) ? x : null;
}

function rowScale(M: Matrix, from: number, n: number): number {
  let s = 0;
  for (let r = from; r < n; r++) {
    for (let c = from; c < n; c++) s = Math.max(s, Math.abs(M[r][c]));
  }
  return s;
}

/**
 * Build the weighted normal equations for
 *   min ‖W^½(Xβ − y)‖² + λ‖β‖²
 * returning A = XᵀWX + λI and rhs = XᵀWy.
 *
 * Forming them explicitly is safe here because the system is tiny and the
 * ridge term keeps the conditioning in hand.
 */
export function normalEquations(
  X: Matrix,
  y: Vector,
  w: Vector,
  lambda: number
): { A: Matrix; rhs: Vector } {
  const rows = X.length;
  const cols = rows ? X[0].length : 0;
  const A = zeroMatrix(cols, cols);
  const rhs = zeros(cols);

  for (let r = 0; r < rows; r++) {
    const wr = w[r];
    if (!wr) continue;
    const row = X[r];
    for (let i = 0; i < cols; i++) {
      const xi = row[i];
      if (!xi) continue;
      const wxi = wr * xi;
      rhs[i] += wxi * y[r];
      // Symmetric — fill the upper triangle and mirror.
      for (let j = i; j < cols; j++) {
        const xj = row[j];
        if (!xj) continue;
        A[i][j] += wxi * xj;
      }
    }
  }

  for (let i = 0; i < cols; i++) {
    for (let j = i + 1; j < cols; j++) A[j][i] = A[i][j];
    A[i][i] += lambda;
  }

  return { A, rhs };
}

/**
 * Box-constrained solve of the same system: minimise ½βᵀAβ − rhsᵀβ subject to
 * `lower ≤ β ≤ upper`, by cyclic coordinate descent with clamping.
 *
 * Gaussian elimination alone cannot honour the non-negativity and per-team
 * caps the spec requires (robots cannot score negative points, and a given
 * mechanism has a real throughput ceiling). Coordinate descent converges
 * reliably because the ridge term makes A positive definite, and each step is
 * an exact 1-D minimisation, so the objective decreases monotonically.
 */
export function solveBoxConstrained(
  A: Matrix,
  rhs: Vector,
  lower: Vector,
  upper: Vector,
  init?: Vector,
  maxIter = 500,
  tol = 1e-9
): Vector {
  const n = rhs.length;
  if (n === 0) return [];

  const beta = init
    ? init.map((v, i) => clamp(v, lower[i], upper[i]))
    : lower.map((lo, i) => clamp(0, lo, upper[i]));

  for (let iter = 0; iter < maxIter; iter++) {
    let maxDelta = 0;

    for (let j = 0; j < n; j++) {
      const ajj = A[j][j];
      // A column with no weight at all: pin to the lower bound rather than
      // dividing by ~0. Happens when a team never appears in any window.
      if (ajj <= 1e-12) {
        if (beta[j] !== lower[j]) {
          maxDelta = Math.max(maxDelta, Math.abs(beta[j] - lower[j]));
          beta[j] = lower[j];
        }
        continue;
      }

      let acc = rhs[j];
      const rowJ = A[j];
      for (let k = 0; k < n; k++) {
        if (k !== j) acc -= rowJ[k] * beta[k];
      }

      const next = clamp(acc / ajj, lower[j], upper[j]);
      maxDelta = Math.max(maxDelta, Math.abs(next - beta[j]));
      beta[j] = next;
    }

    if (maxDelta < tol) break;
  }

  return beta;
}

export const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

/** Weighted residual sum of squares, ‖W^½(Xβ − y)‖². */
export function weightedRss(X: Matrix, y: Vector, w: Vector, beta: Vector): number {
  let acc = 0;
  for (let r = 0; r < X.length; r++) {
    const row = X[r];
    let pred = 0;
    for (let c = 0; c < row.length; c++) pred += row[c] * beta[c];
    const resid = pred - y[r];
    acc += w[r] * resid * resid;
  }
  return acc;
}
