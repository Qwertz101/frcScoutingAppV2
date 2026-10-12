import {
  AUTO_LEN,
  ClimbByMatch,
  MATCH_LEN,
  TimelineScoutingData,
} from '../../types';
import type { BpsReport } from './index';
import type { ScoreAttribution } from './attribution';

/**
 * Per-robot match points from the joined streams.
 *
 * Live workspace: use per-second observed score allocations from attribution.ts.
 * Older callers without an attribution report retain rate × shooting duration.
 * TBA's fuel total calibrates a completely scouted alliance; if any observed
 * score is unassigned, calibration can only reduce the assigned total, never
 * spread that unexplained score over the known shooters. Tower credit is added
 * separately from TBA's per-robot breakdown. Before TBA publishes, scoreboard
 * shares are provisional: the overlay itself cannot separate fuel/fouls/climbs.
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
  /** Observed scoreboard allocation, when both streams have been joined. */
  source?: 'scoreboard' | 'rate';
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
  climbByMatch: ClimbByMatch = {},
  attribution?: ScoreAttribution
): MatchPointsMap {
  const out: MatchPointsMap = {};
  if (!report) return out;
  attribution ??= report.attribution;

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
      if (attribution) {
        const split = attribution.byRobot[matchPointsKey(matchKey, teamKey)];
        if (split) raws.push({ teamKey, ...split });
        continue;
      }
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
    const fullCoverage = raws.length === ALLIANCE_SIZE;
    const canAnchor =
      fullCoverage && Number.isFinite(target) && target >= 0 && rawTotal > 1e-9;
    // A missing/unexplained score must never be redistributed to known shooters.
    const hasUnassigned = (attribution?.byAlliance[unitKey]?.unassigned ?? 0) > 1e-9;
    const factor = canAnchor ? (hasUnassigned ? Math.min(1, target / rawTotal) : target / rawTotal) : 1;

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
        source: attribution ? 'scoreboard' : 'rate',
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
