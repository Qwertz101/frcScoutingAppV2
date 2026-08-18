import { TeamMetrics } from '../../utils/teamMetrics';
import { AllianceSlot } from '../../services/picklistService';

/**
 * The alliance-selection model behind the Alliance Selection screen.
 *
 * Two things live here, both pure functions of the board plus the current
 * ranking, so the screen itself stays presentational:
 *
 *   1. CAPTAIN DERIVATION. Captains are never stored. Alliance n's captain is
 *      its first seated robot if it has one, otherwise the highest-ranked team
 *      still free. That is what makes promotion work: when a captain accepts a
 *      higher alliance's offer, its own slot vacates and the next free team
 *      moves up, exactly as it does in the arena (manual 10.6).
 *
 *   2. THE DRAFT SIMULATION that answers "accept or decline?". Both sides of
 *      that question are full three-robot projections — accept means we take
 *      this offer and the rest of the draft plays out around us; decline means
 *      we stay on the board and land wherever the remaining picks put us,
 *      including as captain of a slot that vacated behind us.
 */

export interface AllianceContext {
  metricsFor: (team: number) => TeamMetrics | undefined;
  /**
   * Field-wide scoring rate used to convert defensive seconds into points
   * denied. See `denialFor`.
   */
  ptsPerSecond: number;
  hasBps: boolean;
}

/**
 * Estimated points a robot denies per match.
 *
 * With BPS data this is real: seconds spent playing defence multiplied by what
 * a typical robot scores per second. Without it there is no measured defensive
 * time at all, so we fall back to the legacy 0-4 scouter rating on a nominal
 * 5-points-per-step scale — enough to order defenders sensibly against each
 * other, and labelled as an estimate wherever it is shown.
 */
export function denialFor(t: TeamMetrics, ctx: { ptsPerSecond: number; hasBps: boolean }): number {
  if (ctx.hasBps && t.avgDefenseSeconds > 0) return t.avgDefenseSeconds * ctx.ptsPerSecond;
  return t.defenseAvg * 5;
}

/**
 * What an alliance is worth, in points.
 *
 * Not a plain sum of averages: only two robots really cycle, so the second
 * robot is discounted and the third counts for little offensively. A strong
 * defender or a reliable climber is credited separately, which is why a
 * complementary third robot can beat a higher-scoring one.
 */
export function allianceScore(teams: number[], ctx: AllianceContext): number {
  const ts = teams.map(ctx.metricsFor).filter((m): m is TeamMetrics => !!m);
  if (!ts.length) return 0;
  const meds = ts.map((t) => t.median).sort((a, b) => b - a);
  const offense = (meds[0] || 0) + 0.82 * (meds[1] || 0) + 0.3 * (meds[2] || 0);
  const denial = 0.75 * Math.max(0, ...ts.map((t) => denialFor(t, ctx)));
  const climb = 8 * ts.filter((t) => t.towerAvg >= 15).length;
  return offense + denial + climb;
}

const marginal = (roster: number[], cand: number, ctx: AllianceContext) =>
  allianceScore([...roster, cand], ctx) - allianceScore(roster, ctx);

/** team -> 1-based alliance number, for every robot already on the board. */
export function seatedMap(board: AllianceSlot[]): Record<number, number> {
  const out: Record<number, number> = {};
  board.forEach((a, i) => {
    if (a.captain != null) out[a.captain] = i + 1;
    a.picks.forEach((p) => {
      out[p] = i + 1;
    });
  });
  return out;
}

/** The eight rosters as flat arrays, captain first. */
const rostersOf = (board: AllianceSlot[]): number[][] =>
  board.map((a) => (a.captain != null ? [a.captain, ...a.picks] : []));

/**
 * Captains for all eight alliances given who is already gone.
 * `rosters` overrides the board when simulating a draft in progress.
 */
function capsOf(
  board: AllianceSlot[],
  ranked: number[],
  gone: Record<number, unknown>,
  rosters?: number[][]
): (number | null)[] {
  const base = rostersOf(board);
  const caps: (number | null)[] = [];
  for (let i = 0; i < 8; i++) {
    const seated = rosters && rosters[i].length ? rosters[i] : base[i];
    if (seated.length && caps.indexOf(seated[0]) < 0) {
      caps.push(seated[0]);
      continue;
    }
    const next = ranked.find((t) => !gone[t] && caps.indexOf(t) < 0);
    caps.push(next ?? null);
  }
  return caps;
}

export function deriveCaptains(board: AllianceSlot[], ranked: number[]): (number | null)[] {
  return capsOf(board, ranked, seatedMap(board));
}

interface DraftOptions {
  /** Seat `pose` on this 1-based alliance before the draft runs (accept). */
  poseSlot?: number | null;
  /** Whether `pose` may be drafted by anyone (decline). */
  poseFree?: boolean;
  /** An alliance that must not take `pose` — the offer being declined. */
  forbidSlot?: number | null;
}

/**
 * Play the remaining draft out to the end.
 *
 * Captains pick in 1->8 order and then 8->1. A captain may take a *lower*
 * captain that has not yet picked, which vacates that slot; captains are
 * therefore re-derived after every single selection rather than once up front.
 * Each pick is the robot that adds the most to *that* roster, so alliances
 * build complementary lineups instead of all chasing the same top scorer.
 */
export function runDraft(
  board: AllianceSlot[],
  ranked: number[],
  pose: number,
  ctx: AllianceContext,
  opts: DraftOptions = {}
): { caps: (number | null)[]; rosters: number[][] } {
  const onBoard = seatedMap(board);
  const gone: Record<number, unknown> = { ...onBoard };
  const rosters = rostersOf(board).map((r) => r.slice());

  const seatCaptains = () => {
    const caps = capsOf(board, ranked, gone, rosters);
    caps.forEach((c, i) => {
      if (c != null && !rosters[i].length) rosters[i] = [c];
    });
    return caps;
  };

  let caps = seatCaptains();
  if (opts.poseSlot) {
    const i = opts.poseSlot - 1;
    if (rosters[i].indexOf(pose) < 0) rosters[i].push(pose);
    gone[pose] = true;
  }

  const order: number[] = [];
  for (let n = 1; n <= 8; n++) order.push(n);
  for (let n = 8; n >= 1; n--) order.push(n);

  order.forEach((n) => {
    caps = seatCaptains();
    const i = n - 1;
    if (caps[i] == null || rosters[i].length >= 3) return;
    const above = caps.slice(0, i).filter((c): c is number => c != null);
    const pool = ranked.filter((t) => {
      if (onBoard[t] || gone[t]) return false;
      if (above.indexOf(t) >= 0) return false;
      if (t === pose && !opts.poseFree) return false;
      if (t === pose && opts.forbidSlot === n) return false;
      const ci = caps.indexOf(t);
      if (ci >= 0) {
        // A lower captain can be drafted — their slot then vacates — but only
        // while they still have both picks in hand.
        if (ci <= i) return false;
        return rosters[ci].length <= 1;
      }
      return !rosters.some((r) => r.indexOf(t) >= 0);
    });
    if (!pool.length) return;

    let best = pool[0];
    let bestGain = -Infinity;
    pool.forEach((t) => {
      const g = marginal(rosters[i], t, ctx);
      if (g > bestGain) {
        bestGain = g;
        best = t;
      }
    });
    rosters[i].push(best);
    gone[best] = true;

    const wasCap = caps.indexOf(best);
    if (wasCap >= 0 && wasCap !== i) rosters[wasCap] = [];
  });

  return { caps: seatCaptains(), rosters };
}

export interface Scenario {
  /** 1-based alliance we end up on. */
  n: number;
  captain: number;
  asCaptain: boolean;
  ev: number;
  roster: number[];
  /** The roster minus us. */
  picks: number[];
}

/** What accepting alliance `n`'s offer is worth. */
export function acceptScenario(
  n: number,
  board: AllianceSlot[],
  ranked: number[],
  pose: number,
  ctx: AllianceContext
): Scenario {
  const { rosters } = runDraft(board, ranked, pose, ctx, { poseSlot: n, poseFree: true });
  const roster = rosters[n - 1];
  return {
    n,
    captain: roster[0],
    asCaptain: roster[0] === pose,
    ev: Math.round(allianceScore(roster, ctx)),
    roster,
    picks: roster.filter((t) => t !== pose),
  };
}

/**
 * Where we land if we turn alliance `n` down (or, with `n` null, the baseline
 * "nobody has offered yet" case). Null when declining leaves us unpicked.
 */
export function declineScenario(
  n: number | null,
  board: AllianceSlot[],
  ranked: number[],
  pose: number,
  ctx: AllianceContext
): Scenario | null {
  const { rosters } = runDraft(board, ranked, pose, ctx, { poseFree: true, forbidSlot: n });
  const slot = rosters.findIndex((r) => r.indexOf(pose) >= 0);
  if (slot < 0) return null;
  const roster = rosters[slot];
  return {
    n: slot + 1,
    captain: roster[0],
    asCaptain: roster[0] === pose,
    ev: Math.round(allianceScore(roster, ctx)),
    roster,
    picks: roster.filter((t) => t !== pose),
  };
}
