import {
  AUTO_LEN,
  ClimbByMatch,
  MATCH_LEN,
  TimelineScoutingData,
} from '../../types';
import type { BpsReport } from './index';

/**
 * From solved rates to a robot's POINTS in one match.
 *
 * Three stages, in order:
 *
 *   1. RAW — the solver's rate times the seconds this robot was flagged
 *      shooting, split auto/teleop. This is fuel scoring only.
 *   2. ANCHOR — rescale the alliance's three raw figures so they sum to the
 *      alliance's published auto+teleop total from TBA. Climb and fouls are
 *      excluded from that target, so this stage stays purely about fuel.
 *   3. CLIMB — add this robot's own auto + endgame tower points, straight
 *      from TBA's per-robot attribution.
 *
 * WHY ANCHOR
 * ==========
 * A robot's predicted points are rate x flagged-seconds, and both factors are
 * estimated from noisy scouting. Their errors are largely COMMON across an
 * alliance — same scoreboard lag, same crew, same habits — so the three
 * predictions rarely sum to what the alliance really scored. They do not have
 * to: that total is published.
 *
 *     scaled_i = raw_i * (published_fuel_total / SUM_j raw_j)
 *
 * One multiplicative factor applied to all three, so every robot's SHARE of
 * the alliance score is preserved EXACTLY — a robot credited with 30% of the
 * work still has 30% afterwards. Only the common magnitude changes, which is
 * the part the model is worst at and the scoreboard already knows. The model
 * is demoted from "estimate the points" to "estimate the split".
 *
 * THE COVERAGE GUARD — not optional
 * =================================
 * Scaling assumes the robots being predicted for are the robots that produced
 * the score. If one of three is unscouted, its points have nowhere to go and
 * get redistributed onto its teammates, inflating them by roughly half. In
 * simulation this was the single worst failure measured — 57% error unguarded
 * against 19% guarded at partial coverage. So an alliance is anchored ONLY
 * when all three of its robots have a timeline for that match. Skipping is
 * always safe; the unanchored raw figure is simply used as-is.
 */

/** Fuel points a robot is credited with in one match, before anchoring. */
interface RawSplit {
  teamKey: string;
  auto: number;
  teleop: number;
}

export interface MatchPointsEntry {
  /** Auto fuel points after anchoring. */
  auto: number;
  /** Teleop fuel points after anchoring. */
  teleop: number;
  /** auto + teleop — the non-climb, non-foul contribution. */
  nonClimb: number;
  /** TBA-attributed auto + endgame tower points for this robot. */
  climb: number;
  /** The two halves of `climb`, kept apart so screens can tell them apart. */
  climbAuto: number;
  climbEndgame: number;
  /** nonClimb + climb — what the workspace shows as this match's points. */
  total: number;
  /** True when the alliance total was rescaled to TBA's published figure. */
  anchored: boolean;
  /** The multiplicative factor applied. 1 when unanchored. */
  scaleFactor: number;
}

/** "matchKey|teamKey" -> that robot's points for that match. */
export type MatchPointsMap = Record<string, MatchPointsEntry>;

export const matchPointsKey = (matchKey: string, teamKey: string) => `${matchKey}|${teamKey}`;

/** Robots per alliance — the coverage guard's threshold. */
const ALLIANCE_SIZE = 3;

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Seconds this timeline was flagged shooting, split at the auto boundary. */
function shootSeconds(t: TimelineScoutingData): { auto: number; teleop: number } {
  let auto = 0;
  let teleop = 0;
  for (const s of t.segments) {
    if (s.action !== 'shoot') continue;
    const start = Math.max(0, Math.min(MATCH_LEN, s.start));
    const end = Math.max(0, Math.min(MATCH_LEN, s.end));
    if (end <= start) continue;
    auto += Math.max(0, Math.min(end, AUTO_LEN) - Math.min(start, AUTO_LEN));
    teleop += Math.max(0, end - Math.max(start, AUTO_LEN));
  }
  return { auto, teleop };
}

/**
 * Build every scouted robot's per-match points.
 *
 * Only alliance-matches the solver actually fused appear here, and within
 * them only robots that were scouted — which is also what gates TBA climb
 * data. A match nobody scouted contributes nothing, so scouting an event
 * progressively reveals its climb data match by match rather than exposing
 * results for matches that have not been worked yet.
 */
export function buildMatchPoints(
  timelines: TimelineScoutingData[],
  report: BpsReport | null,
  anchorByAlliance: Record<string, number> = {},
  climbByMatch: ClimbByMatch = {}
): MatchPointsMap {
  const out: MatchPointsMap = {};
  if (!report) return out;

  // Only matches the solver fused can be scored at all.
  const solved = new Set(report.windows.map((w) => w.matchKey));

  const byUnit = new Map<string, TimelineScoutingData[]>();
  for (const t of timelines) {
    if (!solved.has(t.matchKey)) continue;
    if (!/^frc\d+$/.test(t.teamKey)) continue;
    const key = `${t.matchKey}|${t.alliance}`;
    const list = byUnit.get(key);
    if (list) list.push(t);
    else byUnit.set(key, [t]);
  }

  for (const [unitKey, group] of byUnit) {
    const [matchKey, alliance] = unitKey.split('|');

    // One timeline per robot, matching how the solver deduped.
    const byTeam = new Map<string, TimelineScoutingData[]>();
    for (const t of group) {
      const list = byTeam.get(t.teamKey);
      if (list) list.push(t);
      else byTeam.set(t.teamKey, [t]);
    }

    const raws: RawSplit[] = [];
    for (const [teamKey, tls] of byTeam) {
      const rates = report.byTeam[teamKey];
      // Average across duplicate coverage of the same robot.
      let auto = 0;
      let teleop = 0;
      for (const t of tls) {
        const secs = shootSeconds(t);
        auto += secs.auto * (rates?.autoBps ?? 0);
        teleop += secs.teleop * (rates?.teleopBps ?? 0);
      }
      raws.push({ teamKey, auto: auto / tls.length, teleop: teleop / tls.length });
    }

    const target = anchorByAlliance[`${matchKey}|${alliance}`];
    const rawTotal = raws.reduce((s, r) => s + r.auto + r.teleop, 0);
    const fullCoverage = raws.length >= ALLIANCE_SIZE;
    const canAnchor =
      fullCoverage && typeof target === 'number' && target > 0 && rawTotal > 1e-9;
    const factor = canAnchor ? target / rawTotal : 1;

    for (const r of raws) {
      const auto = r.auto * factor;
      const teleop = r.teleop * factor;
      const credit = climbByMatch[matchKey]?.[r.teamKey];
      const climbAuto = credit?.auto ?? 0;
      const climbEndgame = credit?.endgame ?? 0;
      const climb = climbAuto + climbEndgame;
      out[matchPointsKey(matchKey, r.teamKey)] = {
        auto: round2(auto),
        teleop: round2(teleop),
        nonClimb: round2(auto + teleop),
        climb: round2(climb),
        climbAuto: round2(climbAuto),
        climbEndgame: round2(climbEndgame),
        total: round2(auto + teleop + climb),
        anchored: canAnchor,
        scaleFactor: round2(factor),
      };
    }
  }

  return out;
}

/** How much of the solve was anchored — surfaced as a data-quality signal. */
export function anchorSummary(points: MatchPointsMap) {
  const entries = Object.values(points);
  const anchored = entries.filter((e) => e.anchored);
  return {
    total: entries.length,
    anchored: anchored.length,
    /** Mean |factor - 1| over anchored entries: how far off the raw fit was. */
    meanDrift: anchored.length
      ? round2(anchored.reduce((s, e) => s + Math.abs(e.scaleFactor - 1), 0) / anchored.length)
      : 0,
  };
}
