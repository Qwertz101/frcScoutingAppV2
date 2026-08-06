import { ScoutingData } from '../types';

/**
 * Reconstruct per-match scouting rows from per-team season aggregates.
 *
 * WHY THIS EXISTS
 * The only surviving copy of the 2026 season's scouting is a stats CSV exported
 * from the Data Analysis screen, which stores *averages only*. The distribution
 * visuals (IQR bands, reliability strips, match-by-match bars) need per-match
 * rows, so this module expands each aggregate back into plausible matches.
 *
 * WHAT IS REAL AND WHAT IS NOT
 *  - REAL: every average this produces reproduces the CSV exactly — auto fuel,
 *    teleop fuel, climb rates and death counts are anchored to what was scouted.
 *  - NOT REAL: the *shape* of the spread between matches is invented. A team's
 *    floor, ceiling and consistency here are illustrative, not observed.
 *
 * Every row is stamped `synthetic: true` so the UI can label it and so the
 * distinction survives a round trip through Supabase. Do not strip that flag.
 */

export const SYNTHETIC_SOURCE = 'frc-team-stats CSV import';

export interface TeamAggregate {
  team: number;
  teamKey: string;
  entries: number;
  avgAutoFuel: number;
  autoMaxClimb: number;
  autoClimbPct: number;
  teleMaxClimb: number;
  teleClimbPct: number;
  avgTeleopFuel: number;
  avgTotalFuel: number;
  matchesPlayed: number;
  matchesScheduled: number;
  diedCount: number;
  defense: string;
}

/** Deterministic PRNG so a given team always reconstructs identically. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Approximately normal deviate in roughly [-1, 1]. */
function gaussish(rand: () => number): number {
  return (rand() + rand() + rand() - 1.5) / 1.5;
}

/**
 * Spread width relative to the mean. Low scorers are proportionally noisier
 * than high scorers, which matches how FRC scoring actually behaves.
 */
function coefficientOfVariation(mean: number): number {
  if (mean > 40) return 0.35;
  if (mean > 10) return 0.52;
  return 0.8;
}

/**
 * Build n values whose mean is *exactly* `target`.
 *
 * Deviations are generated first, dead matches are suppressed, values are
 * clamped non-negative, and only then is the whole series rescaled so the mean
 * lands exactly on target. Rescaling last is what guarantees the CSV average is
 * preserved regardless of what the shaping steps did.
 *
 * Values stay fractional on purpose: with an average like 44.8 over 12 matches
 * there is no set of integers with that exact mean, and preserving the real
 * average matters more than pretending each row was a whole fuel count. These
 * rows are flagged synthetic precisely so this is not mistaken for raw input.
 */
function seriesWithExactMean(
  target: number,
  n: number,
  rand: () => number,
  deadIdx: Set<number>
): number[] {
  if (n <= 0) return [];
  if (target <= 0) return new Array(n).fill(0);

  const cv = coefficientOfVariation(target);
  const raw = Array.from({ length: n }, (_, i) => {
    let v = target * (1 + cv * gaussish(rand));
    if (deadIdx.has(i)) v *= 0.1; // a dead robot still scores a little before dying
    return Math.max(0, v);
  });

  const sum = raw.reduce((s, v) => s + v, 0);
  if (sum === 0) return new Array(n).fill(target);

  const scale = (target * n) / sum;
  return raw.map((v) => Math.round(v * scale * 100) / 100);
}

/** Spread k picks across n slots deterministically, without clustering. */
function pickIndices(k: number, n: number, seed: number): Set<number> {
  const out = new Set<number>();
  if (k <= 0 || n <= 0) return out;
  const count = Math.min(k, n);
  const stride = n / count;
  for (let i = 0; i < count; i++) {
    out.add(Math.min(n - 1, Math.floor(i * stride + (seed % Math.max(1, Math.floor(stride))))));
  }
  // Fill any collisions caused by the offset.
  let probe = 0;
  while (out.size < count && probe < n) {
    if (!out.has(probe)) out.add(probe);
    probe++;
  }
  return out;
}

const defenseFromLabel = (label: string): ScoutingData['defense'] => {
  const v = (label || '').trim().toLowerCase();
  if (v === 'great') return 'great';
  if (v === 'ok') return 'ok';
  if (v === 'none/bad' || v === 'bad') return 'bad';
  return 'none';
};

const climbLevel = (maxLevel: number): 'level1' | 'level2' | 'level3' =>
  maxLevel >= 3 ? 'level3' : maxLevel === 2 ? 'level2' : 'level1';

/**
 * Expand one team's aggregate into per-match scouting rows.
 *
 * `matchKeys` should be the team's real scheduled matches so the reconstruction
 * lines up with the actual schedule. Rows are capped at the number of matches
 * the CSV says were scouted.
 */
export function synthesizeTeamMatches(
  agg: TeamAggregate,
  matchKeys: string[],
  now = Date.now()
): ScoutingData[] {
  const n = Math.min(agg.matchesPlayed || matchKeys.length, matchKeys.length);
  if (n <= 0) return [];

  const rand = mulberry32(agg.team * 2654435761);

  const deadIdx = pickIndices(agg.diedCount, n, agg.team);
  const autoClimbCount = Math.round((agg.autoClimbPct / 100) * n);
  const teleClimbCount = Math.round((agg.teleClimbPct / 100) * n);
  const autoClimbIdx = pickIndices(autoClimbCount, n, agg.team + 1);
  const teleClimbIdx = pickIndices(teleClimbCount, n, agg.team + 2);

  const autoSeries = seriesWithExactMean(agg.avgAutoFuel, n, rand, deadIdx);
  const teleSeries = seriesWithExactMean(agg.avgTeleopFuel, n, rand, deadIdx);
  const defense = defenseFromLabel(agg.defense);

  return matchKeys.slice(0, n).map((matchKey, i) => {
    const died = deadIdx.has(i);
    // A robot that died cannot have climbed.
    const didAutoClimb = autoClimbIdx.has(i) && !died;
    const didTeleClimb = teleClimbIdx.has(i) && !died;

    return {
      id: `synthetic-${agg.teamKey}-${matchKey}`,
      matchKey,
      teamKey: agg.teamKey,
      scouter: 'CSV import',
      alliance: 'red',
      position: 1,
      auto: {
        fuel: autoSeries[i],
        climbed: didAutoClimb ? climbLevel(agg.autoMaxClimb) : 'didnt_climb',
      },
      teleop: {
        offence: { fuel: teleSeries[i] },
        defense: { defense: 'na', duration: 0 },
      },
      endgame: {
        climb: didTeleClimb ? climbLevel(agg.teleMaxClimb) : 'none',
        died: died ? 'partway' : 'none',
      },
      robotShutdown: died ? 'full' : 'no',
      defense,
      timestamp: now - (n - i) * 60_000,
      // Provenance — see the module header. The UI reads this to label the row.
      synthetic: true,
      syntheticSource: SYNTHETIC_SOURCE,
    } as unknown as ScoutingData;
  });
}

/** Expand every aggregate, mapping each team onto its own scheduled matches. */
export function synthesizeAll(
  aggregates: TeamAggregate[],
  matchKeysForTeam: (teamKey: string) => string[]
): ScoutingData[] {
  const now = Date.now();
  return aggregates.flatMap((agg) =>
    synthesizeTeamMatches(agg, matchKeysForTeam(agg.teamKey), now)
  );
}
