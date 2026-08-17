import { MATCH_LEN, ScoutingData, TimelineScoutingData } from '../types';
import {
  BpsReport,
  MatchPointsMap,
  actionTotals,
  matchPointsFromTimeline,
  matchPointsKey,
} from '../services/bps';
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
 *
 * DUAL SOURCE
 * ===========
 * There are two independent scouting models in the app and both must keep
 * working, because the 2026 season was scouted entirely with the first one:
 *
 *   legacy — a `ScoutingData` row per scouter per match (fuel counts, climb
 *            level, defense rating), scored by `utils/scoring.ts`. It has no
 *            CV stream and never will, so it can never produce a BPS value.
 *   bps    — a `TimelineScoutingData` action timeline fused with a `CvMatchLog`
 *            through `services/bps`, which solves a points-per-second rate per
 *            robot and multiplies it by the seconds that robot was flagged
 *            scoring.
 *
 * The choice is made PER MATCH, not per team: a match uses the BPS path when
 * this team has a timeline for it *and* the solver actually fused that match
 * (it appears in `report.windows`, which requires a CV log). Everything else
 * falls back to legacy. A team may therefore be `'legacy'`, `'bps'` or
 * `'mixed'` — `TeamMetrics.source` says which, and every screen labels it.
 *
 * Crucially, all the distribution statistics below (mean, median, IQR, floor,
 * ceiling, outliers, consistency, deaths) are computed over the COMBINED
 * per-match series afterwards, exactly as before. With no timelines and no CV
 * logs the BPS branch contributes nothing and the output is bit-identical to
 * the legacy-only implementation.
 */

/** Which model produced a number. */
export type MetricSource = 'legacy' | 'bps' | 'mixed';

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
  /**
   * Which model produced `points` for this single match.
   *
   * On a BPS match `autoFuel`/`teleopFuel` hold auto and teleop POINTS rather
   * than fuel counts — the solver attributes scoreboard points, and the two
   * fields are the closest existing home for that split.
   */
  source: 'legacy' | 'bps';
  /** Seconds in each action. BPS matches only; 0 on legacy matches. */
  shootSeconds: number;
  passSeconds: number;
  defSeconds: number;
  oofSeconds: number;
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

  /* ---- BPS path (all 0 for a legacy-only team) ---- */

  /** Solved points per second, whole match. */
  bps: number;
  autoBps: number;
  teleopBps: number;
  /** Solver windows this team appeared in. Low counts mean a shaky estimate. */
  bpsWindows: number;
  /** Total seconds flagged SHOOTING across this team's timelines. */
  scoringSeconds: number;
  passSeconds: number;
  defSeconds: number;
  oofSeconds: number;
  /**
   * Estimated fuel passed to allies per match.
   *
   * Inferred, not measured: passing puts nothing on the scoreboard, so the
   * solver cannot see it. Assumes a robot moves fuel at the same rate whether
   * shooting or feeding, and fuel is 1 point in 2026, so its solved teleop
   * rate doubles as a fuel-per-second handling rate. Label it as an estimate
   * wherever it is shown.
   */
  passedFuelPerMatch: number;
  /** Where this team's per-match points came from. */
  source: MetricSource;
  hasBps: boolean;
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
    source: 'legacy',
    shootSeconds: 0,
    passSeconds: 0,
    defSeconds: 0,
    oofSeconds: 0,
  };
}

/* ------------------------------------------------------------------ *
 * BPS path
 * ------------------------------------------------------------------ */

/**
 * Collapse one team's timelines for one match into the same TeamMatchPoint
 * shape the legacy path produces, so every downstream statistic is unchanged.
 *
 * Concept mapping (see the module header for why this is per match):
 *   autoFuel   ← AUTO fuel points, after anchoring (a points figure, not a
 *                fuel count)
 *   teleopFuel ← TELEOP fuel points, likewise
 *   towerPoints← this robot's own auto + endgame tower points, from TBA's
 *                per-robot attribution
 *   points     ← autoFuel + teleopFuel + towerPoints, i.e. the robot's whole
 *                contribution. Climb IS included now: the fuel figures were
 *                anchored to TBA's climb-free total, so adding the climb back
 *                completes the picture instead of double-counting it. (Before
 *                anchoring existed, the CV scoreboard the solver fitted still
 *                contained the climb, which is why the old code had to leave
 *                towerPoints out of the total.)
 *   autoClimbed← true when this robot's TBA auto tower credit is nonzero
 *   climbLevel ← 1 when its TBA endgame tower credit is nonzero. TBA records
 *                the level string too, but nothing downstream consumes more
 *                than "did they score" — see `climbRate`.
 *   died       ← the match contains an `oof` segment
 *
 * `matchPoints` is precomputed per alliance-match because anchoring needs the
 * whole alliance at once, and this function only ever sees one robot. When it
 * has no entry — no TBA key, or results not published yet — the raw solved
 * figures are used unanchored and the climb is simply absent.
 */
function collapseBpsMatch(
  matchKey: string,
  timelines: TimelineScoutingData[],
  report: BpsReport,
  teamKey: string,
  matchPoints?: MatchPointsMap
): TeamMatchPoint {
  const { label, number } = matchLabel(matchKey);
  const rates = report.byTeam[teamKey];
  const totals = timelines.map(actionTotals);
  const oof = mean(totals.map((t) => t.oof ?? 0));

  const anchored = matchPoints?.[matchPointsKey(matchKey, teamKey)];
  // Unanchored fallback: the solver's own per-timeline figure, no climb.
  const raw = timelines.map((t) => matchPointsFromTimeline(t, rates));
  const autoFuel = anchored ? anchored.auto : round2(mean(raw.map((p) => p.auto)));
  const teleopFuel = anchored ? anchored.teleop : round2(mean(raw.map((p) => p.teleop)));
  const towerPoints = anchored ? anchored.climb : 0;

  return {
    matchKey,
    label,
    matchNumber: number,
    points: Math.round(autoFuel + teleopFuel + towerPoints),
    autoFuel,
    teleopFuel,
    towerPoints,
    autoClimbed: anchored ? anchored.climbAuto > 0 : false,
    climbLevel: anchored && anchored.climbEndgame > 0 ? 1 : 0,
    died: oof > 0,
    scouters: timelines.length,
    source: 'bps',
    shootSeconds: round2(mean(totals.map((t) => t.shoot ?? 0))),
    passSeconds: round2(mean(totals.map((t) => t.pass ?? 0))),
    defSeconds: round2(mean(totals.map((t) => t.def ?? 0))),
    oofSeconds: round2(oof),
  };
}

/**
 * A 0–4 defense rating from time spent on contact defense, so BPS teams land
 * on the same scale as the legacy `none/bad/ok/great` picker. Half the match
 * or more on defense reads as a full 4; nothing at all reads as 0.
 */
function defenseRatingFromSeconds(secondsPerMatch: number): number {
  if (secondsPerMatch <= 0) return 0;
  return round2(Math.min(4, (secondsPerMatch / (MATCH_LEN / 2)) * 4));
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
    bps: 0,
    autoBps: 0,
    teleopBps: 0,
    bpsWindows: 0,
    scoringSeconds: 0,
    passSeconds: 0,
    defSeconds: 0,
    oofSeconds: 0,
    passedFuelPerMatch: 0,
    source: 'legacy',
    hasBps: false,
  };
}

/** The extra BPS stream for one team, if any. */
export interface TeamBpsInput {
  /** This team's action timelines, across every match. */
  timelines: TimelineScoutingData[];
  /** The one solved report for the whole event. */
  report: BpsReport | null;
}

/**
 * Build metrics for a single team.
 *
 * `bpsInput` is optional. Omitting it — or passing empty timelines / a null
 * report — makes this function behave exactly as the legacy-only version did.
 */
export function buildTeamMetrics(
  teamKey: string,
  entries: ScoutingData[],
  matchesScheduled = 0,
  bpsInput?: TeamBpsInput,
  matchPoints?: MatchPointsMap
): TeamMetrics {
  const report = bpsInput?.report ?? null;
  const teamTimelines = bpsInput?.timelines ?? [];

  // Only matches the solver actually fused (timeline + CV log) can be scored
  // by the BPS path; a timeline with no CV log for its match stays legacy.
  const solvedMatches = report ? new Set(report.windows.map((w) => w.matchKey)) : new Set<string>();

  const bpsByMatch: Record<string, TimelineScoutingData[]> = {};
  if (report) {
    teamTimelines.forEach((t) => {
      if (!solvedMatches.has(t.matchKey)) return;
      bpsByMatch[t.matchKey] = bpsByMatch[t.matchKey] || [];
      bpsByMatch[t.matchKey].push(t);
    });
  }
  const bpsMatchKeys = Object.keys(bpsByMatch);

  if (!entries.length && !bpsMatchKeys.length) {
    return emptyMetrics(teamKey, matchesScheduled);
  }

  const byMatch: Record<string, ScoutingData[]> = {};
  entries.forEach((e) => {
    byMatch[e.matchKey] = byMatch[e.matchKey] || [];
    byMatch[e.matchKey].push(e);
  });

  const matches = [
    // Legacy matches, minus any the BPS path also covers — BPS wins there.
    ...Object.keys(byMatch)
      .filter((k) => !bpsByMatch[k])
      .map((k) => collapseMatch(k, byMatch[k])),
    ...bpsMatchKeys.map((k) => collapseBpsMatch(k, bpsByMatch[k], report!, teamKey, matchPoints)),
  ].sort((a, b) => a.matchNumber - b.matchNumber);

  const points = matches.map((m) => m.points);
  const avg = mean(points);
  // Classification only: the Tukey fence that decides which matches are
  // outliers has to be computed from the FULL set, same as any Tukey fence —
  // it would be circular to classify outliers using quartiles that already
  // exclude them.
  const clsQ1 = percentile(points, 0.25);
  const clsQ3 = percentile(points, 0.75);
  const lowFence = clsQ1 - 1.5 * (clsQ3 - clsQ1);

  // A match is excluded from the "normal range" if the robot died or the
  // score fell below the lower Tukey fence.
  const isOutlier = (m: TeamMatchPoint) => m.died || m.points < lowFence;
  const outliers = matches.filter(isOutlier);
  const kept = matches.filter((m) => !isOutlier(m));
  const keptPoints = kept.length ? kept.map((m) => m.points) : points;

  const adjMean = mean(keptPoints);
  const adjSd = stdDev(keptPoints, adjMean);

  // Display quartiles: computed from keptPoints, the SAME set floor/ceiling
  // use, so floor <= q1 <= median <= q3 <= ceiling holds by construction.
  // Computing these from the full `points` instead (as `clsQ1`/`clsQ3` do,
  // deliberately, for classification) can place them outside a floor/ceiling
  // that excluded an outlier — a team down to one kept match after an
  // exclusion collapses floor and ceiling to that single value while the
  // full-set quartiles sit elsewhere entirely, which is what was producing
  // DistributionBar's band as a tiny mispositioned blob disconnected from
  // its own whiskers rather than a coherent (if extremely narrow) band.
  const q1 = percentile(keptPoints, 0.25);
  const q3 = percentile(keptPoints, 0.75);
  const iqr = q3 - q1;

  const bpsMatches = matches.filter((m) => m.source === 'bps');
  const hasBps = bpsMatches.length > 0;
  const source: MetricSource = !hasBps
    ? 'legacy'
    : bpsMatches.length === matches.length
    ? 'bps'
    : 'mixed';
  // Rates are only surfaced once at least one of this team's matches was
  // actually fused; a timeline with no CV log leaves the team on legacy.
  const rates = hasBps ? report?.byTeam[teamKey] : undefined;

  // Action seconds are totals over every timeline we hold for this team,
  // matching how the solver reports scoringSeconds.
  const allTotals = teamTimelines.map(actionTotals);
  const secTotal = (k: string) => round2(sum(allTotals.map((t) => t[k] ?? 0)));

  /**
   * Defense stays on the legacy definition whenever legacy rows exist, so no
   * existing team's rating can move. Only a team with none — i.e. scouted
   * purely on timelines — falls back to the time-derived rating.
   */
  const legacyDefenseSeconds = Math.round(
    mean(entries.map((e) => Number((e.teleop as any)?.defense?.duration || 0)))
  );
  const bpsDefenseSeconds = bpsMatches.length
    ? Math.round(mean(bpsMatches.map((m) => m.defSeconds)))
    : 0;

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
    // A solved BPS match is observed, so it disqualifies the label.
    isSynthetic: entries.length > 0 && !hasBps && entries.every((e) => !!(e as any).synthetic),

    mean: round2(avg),
    adjMean: round2(adjMean),
    sd: round2(stdDev(points, avg)),
    adjSd: round2(adjSd),
    // Same basis as q1/q3 above — the normal range's own median, not the
    // full set's (which an excluded outlier could pull outside floor..ceiling).
    median: round2(percentile(keptPoints, 0.5)),
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
    defenseAvg: entries.length
      ? round2(mean(entries.map((e) => defenseScore(e.defense)).filter((v) => v > 0)))
      : defenseRatingFromSeconds(bpsDefenseSeconds),
    avgDefenseSeconds: entries.length ? legacyDefenseSeconds : bpsDefenseSeconds,

    bps: rates?.bps ?? 0,
    autoBps: rates?.autoBps ?? 0,
    teleopBps: rates?.teleopBps ?? 0,
    bpsWindows: rates?.windows ?? 0,
    scoringSeconds: secTotal('shoot'),
    passSeconds: secTotal('pass'),
    defSeconds: secTotal('def'),
    oofSeconds: secTotal('oof'),
    // Per-match, straight off the solver so the two agree exactly.
    passedFuelPerMatch: rates?.passedFuelPerMatch ?? 0,
    source,
    hasBps,
  };
}

/**
 * Build metrics for every team, including teams with no scouting data yet
 * (so the full event field shows up on the picklist board).
 */
export function buildAllTeamMetrics(
  rows: ScoutingData[],
  teamKeys: string[],
  matches: any[] = [],
  timelines: TimelineScoutingData[] = [],
  report: BpsReport | null = null,
  matchPoints: MatchPointsMap = {}
): TeamMetrics[] {
  const byTeam: Record<string, ScoutingData[]> = {};
  rows.forEach((r) => {
    byTeam[r.teamKey] = byTeam[r.teamKey] || [];
    byTeam[r.teamKey].push(r);
  });

  const timelinesByTeam: Record<string, TimelineScoutingData[]> = {};
  timelines.forEach((t) => {
    timelinesByTeam[t.teamKey] = timelinesByTeam[t.teamKey] || [];
    timelinesByTeam[t.teamKey].push(t);
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

  // Teams that only ever appear on a timeline still deserve a row.
  // With no timelines this is `teamKeys` unchanged, order included.
  //
  // A team_key can come out empty when a scout is assigned to a match whose
  // schedule is missing that alliance slot (LiveMatch guards against this
  // going forward, but stray rows saved before that guard existed can still
  // be sitting on the server). Filtering here — the single place every
  // roster gets assembled — means a row like that can never again render as
  // a numberless "team #0" no matter which path produced it.
  const isRealTeamKey = (tk: string) => /^frc\d+$/.test(tk);
  const allKeys = [...new Set([...teamKeys, ...Object.keys(timelinesByTeam)])].filter(
    isRealTeamKey
  );

  return allKeys.map((tk) =>
    buildTeamMetrics(
      tk,
      byTeam[tk] || [],
      scheduledFor(tk),
      { timelines: timelinesByTeam[tk] || [], report },
      matchPoints
    )
  );
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
