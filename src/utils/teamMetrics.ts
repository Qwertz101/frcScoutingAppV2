import { ScoutingData } from '../types';
import {
  matchPointsFor,
  autoFuelOf,
  teleopFuelOf,
  towerPointsFor,
  autoClimbLevel,
  teleopClimbLevel,
  robotDiedIn,
} from './scoring';

/**
 * Per-team performance metrics derived from real scouted matches.
 *
 * Every distribution here (median, IQR band, floor/ceiling, low outliers,
 * dead-robot marks) is computed from actual per-match scouting rows rather
 * than reconstructed from season averages.
 */

export interface TeamMatchPoint {
  matchKey: string;
  label: string;
  matchNumber: number;
  points: number;
  autoFuel: number;
  teleopFuel: number;
  towerPoints: number;
  autoClimbed: boolean;
  climbLevel: number;
  died: boolean;
  /** How many scouters contributed to this match's numbers. */
  scouters: number;
}

export interface TeamMetrics {
  teamKey: string;
  team: string;
  teamNumber: number;
  /** Raw scouting entries (may be several per match). */
  entries: number;
  matches: TeamMatchPoint[];
  matchesPlayed: number;
  matchesScheduled: number;
  hasData: boolean;
  /**
   * True when these numbers were reconstructed from a stats-CSV import rather
   * than scouted match by match. The averages are real; the spread between
   * matches is illustrative. Screens must label this — see synthesizeMatches.ts.
   */
  isSynthetic: boolean;

  mean: number;
  /** Mean with low outliers and dead matches removed — the "normal range" average. */
  adjMean: number;
  sd: number;
  adjSd: number;
  median: number;
  q1: number;
  q3: number;
  iqr: number;
  /** Lowest / highest points inside the normal range. */
  floor: number;
  ceiling: number;
  /** Best single match, including outliers. */
  max: number;

  outliers: TeamMatchPoint[];
  deaths: TeamMatchPoint[];

  /** 0–1. Higher means more repeatable match to match. */
  consistency: number;
  autoAvg: number;
  teleopAvg: number;
  towerAvg: number;
  /** Percentages, 0–100. */
  climbRate: number;
  autoClimbRate: number;
  deathRate: number;
  /** Average defense rating on a 0–4 scale (0 = never played defense). */
  defenseAvg: number;
  avgDefenseSeconds: number;
}

const sum = (arr: number[]) => arr.reduce((s, v) => s + v, 0);
const mean = (arr: number[]) => (arr.length ? sum(arr) / arr.length : 0);
const round2 = (v: number) => Math.round(v * 100) / 100;

/** Linear-interpolated percentile. */
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function stdDev(values: number[], avg: number): number {
  if (values.length < 2) return 0;
  return Math.sqrt(sum(values.map((v) => (v - avg) * (v - avg))) / values.length);
}

const defenseScore = (v: unknown) =>
  v === 'great' ? 4 : v === 'ok' ? 3 : v === 'bad' ? 2 : v === 'none' ? 1 : 0;

function matchLabel(matchKey: string): { label: string; number: number } {
  const m = matchKey.match(/_(qm|qf|sf|f)(\d+)/i);
  if (!m) return { label: matchKey, number: 0 };
  const prefix = m[1].toLowerCase() === 'qm' ? 'Q' : m[1].toUpperCase();
  return { label: `${prefix}${m[2]}`, number: Number(m[2]) };
}

/**
 * Collapse the scouting entries for one team in one match into a single
 * data point, averaging fuel across scouters and taking the majority view
 * on climb and robot death.
 */
function collapseMatch(matchKey: string, entries: ScoutingData[]): TeamMatchPoint {
  const { label, number } = matchLabel(matchKey);
  const majority = (fn: (e: ScoutingData) => boolean) =>
    entries.filter(fn).length / entries.length >= 0.5;

  const climbLevels = entries.map((e) =>
    teleopClimbLevel((e as any).matchClimbed ?? (e.endgame as any)?.climb)
  );
  climbLevels.sort((a, b) => a - b);
  const medianClimb = climbLevels[Math.floor(climbLevels.length / 2)] ?? 0;

  return {
    matchKey,
    label,
    matchNumber: number,
    points: Math.round(mean(entries.map(matchPointsFor))),
    autoFuel: round2(mean(entries.map(autoFuelOf))),
    teleopFuel: round2(mean(entries.map(teleopFuelOf))),
    towerPoints: Math.round(mean(entries.map(towerPointsFor))),
    autoClimbed: majority((e) => autoClimbLevel((e.auto as any)?.climbed) > 0),
    climbLevel: medianClimb,
    died: majority(robotDiedIn),
    scouters: entries.length,
  };
}

function emptyMetrics(teamKey: string, matchesScheduled: number): TeamMetrics {
  return {
    teamKey,
    team: teamKey.replace(/^frc/, ''),
    teamNumber: Number(teamKey.replace(/^frc/, '')) || 0,
    entries: 0,
    matches: [],
    matchesPlayed: 0,
    matchesScheduled,
    hasData: false,
    isSynthetic: false,
    mean: 0,
    adjMean: 0,
    sd: 0,
    adjSd: 0,
    median: 0,
    q1: 0,
    q3: 0,
    iqr: 0,
    floor: 0,
    ceiling: 0,
    max: 0,
    outliers: [],
    deaths: [],
    consistency: 0,
    autoAvg: 0,
    teleopAvg: 0,
    towerAvg: 0,
    climbRate: 0,
    autoClimbRate: 0,
    deathRate: 0,
    defenseAvg: 0,
    avgDefenseSeconds: 0,
  };
}

/** Build metrics for a single team from its scouting entries. */
export function buildTeamMetrics(
  teamKey: string,
  entries: ScoutingData[],
  matchesScheduled = 0
): TeamMetrics {
  if (!entries.length) return emptyMetrics(teamKey, matchesScheduled);

  const byMatch: Record<string, ScoutingData[]> = {};
  entries.forEach((e) => {
    byMatch[e.matchKey] = byMatch[e.matchKey] || [];
    byMatch[e.matchKey].push(e);
  });

  const matches = Object.keys(byMatch)
    .map((k) => collapseMatch(k, byMatch[k]))
    .sort((a, b) => a.matchNumber - b.matchNumber);

  const points = matches.map((m) => m.points);
  const avg = mean(points);
  const q1 = percentile(points, 0.25);
  const q3 = percentile(points, 0.75);
  const iqr = q3 - q1;
  const lowFence = q1 - 1.5 * iqr;

  // A match is excluded from the "normal range" if the robot died or the
  // score fell below the lower Tukey fence.
  const isOutlier = (m: TeamMatchPoint) => m.died || m.points < lowFence;
  const outliers = matches.filter(isOutlier);
  const kept = matches.filter((m) => !isOutlier(m));
  const keptPoints = kept.length ? kept.map((m) => m.points) : points;

  const adjMean = mean(keptPoints);
  const adjSd = stdDev(keptPoints, adjMean);

  return {
    teamKey,
    team: teamKey.replace(/^frc/, ''),
    teamNumber: Number(teamKey.replace(/^frc/, '')) || 0,
    entries: entries.length,
    matches,
    matchesPlayed: matches.length,
    matchesScheduled,
    hasData: true,
    // Reconstructed if every contributing row came from the CSV importer.
    isSynthetic: entries.length > 0 && entries.every((e) => !!(e as any).synthetic),

    mean: round2(avg),
    adjMean: round2(adjMean),
    sd: round2(stdDev(points, avg)),
    adjSd: round2(adjSd),
    median: round2(percentile(points, 0.5)),
    q1: round2(q1),
    q3: round2(q3),
    iqr: round2(iqr),
    floor: Math.min(...keptPoints),
    ceiling: Math.max(...keptPoints),
    max: Math.max(...points),

    outliers,
    deaths: matches.filter((m) => m.died),

    consistency: adjMean > 0 ? round2(Math.max(0, 1 - adjSd / adjMean)) : 0,
    autoAvg: round2(mean(matches.map((m) => m.autoFuel))),
    teleopAvg: round2(mean(matches.map((m) => m.teleopFuel))),
    towerAvg: round2(mean(matches.map((m) => m.towerPoints))),
    climbRate: round2((matches.filter((m) => m.climbLevel > 0).length / matches.length) * 100),
    autoClimbRate: round2((matches.filter((m) => m.autoClimbed).length / matches.length) * 100),
    deathRate: round2((matches.filter((m) => m.died).length / matches.length) * 100),
    defenseAvg: round2(mean(entries.map((e) => defenseScore(e.defense)).filter((v) => v > 0))),
    avgDefenseSeconds: Math.round(
      mean(entries.map((e) => Number((e.teleop as any)?.defense?.duration || 0)))
    ),
  };
}

/**
 * Build metrics for every team, including teams with no scouting data yet
 * (so the full event field shows up on the picklist board).
 */
export function buildAllTeamMetrics(
  rows: ScoutingData[],
  teamKeys: string[],
  matches: any[] = []
): TeamMetrics[] {
  const byTeam: Record<string, ScoutingData[]> = {};
  rows.forEach((r) => {
    byTeam[r.teamKey] = byTeam[r.teamKey] || [];
    byTeam[r.teamKey].push(r);
  });

  /**
   * Qualification matches only.
   *
   * Reliability and ranking are qualification-round concepts, and playoff
   * matches would otherwise inflate the count for teams that advanced — a
   * finalist showed 17 "scheduled" against 12 quals, which overflowed the
   * per-match reliability strip past its column.
   */
  const scheduledFor = (teamKey: string) =>
    matches.filter((m: any) => {
      if ((m.comp_level ?? 'qm') !== 'qm') return false;
      const keys: string[] = [
        ...(m.alliances?.red?.team_keys || []),
        ...(m.alliances?.blue?.team_keys || []),
      ];
      return keys.includes(teamKey);
    }).length;

  return teamKeys.map((tk) => buildTeamMetrics(tk, byTeam[tk] || [], scheduledFor(tk)));
}

/** Collect every team appearing in the match schedule. */
export function teamsFromMatches(matches: any[]): string[] {
  const set = new Set<string>();
  matches.forEach((m: any) => {
    (['red', 'blue'] as const).forEach((a) => {
      (m.alliances?.[a]?.team_keys || []).forEach((tk: string) => set.add(tk));
    });
  });
  return Array.from(set).sort(
    (a, b) => Number(a.replace(/^frc/, '')) - Number(b.replace(/^frc/, ''))
  );
}

/**
 * Projected match points for a lineup of robots.
 *
 * Only three robots play at a time, so a 4-team alliance counts its best three.
 * Floor and ceiling combine the individual normal ranges; sd adds in quadrature.
 */
export function projectAlliance(members: TeamMetrics[]) {
  const lineup = [...members].sort((a, b) => b.adjMean - a.adjMean).slice(0, 3);
  const pts = sum(lineup.map((t) => t.adjMean));
  const sd = Math.sqrt(sum(lineup.map((t) => t.adjSd * t.adjSd)));
  return {
    lineup,
    pts: Math.round(pts),
    sd: Math.round(sd),
    floor: Math.round(sum(lineup.map((t) => t.floor))),
    ceiling: Math.round(sum(lineup.map((t) => t.ceiling))),
    fuel: Math.round(sum(lineup.map((t) => t.autoAvg + t.teleopAvg))),
    tower: Math.round(sum(lineup.map((t) => t.towerAvg))),
  };
}

/**
 * Rough win probability for one alliance against another, from the difference
 * of two normal distributions.
 */
export function winProbability(
  a: { pts: number; sd: number },
  b: { pts: number; sd: number }
): number {
  const spread = Math.sqrt(a.sd * a.sd + b.sd * b.sd) || 1;
  const z = (a.pts - b.pts) / spread;
  // Logistic approximation of the normal CDF.
  return Math.round((1 / (1 + Math.exp(-1.702 * z))) * 100);
}
