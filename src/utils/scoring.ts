import { ScoutingData } from '../types';

/**
 * 2026 REBUILT (presented by Haas) scoring rules.
 *
 * Single source of truth for turning a scouting entry into match points.
 * All values below come from the 2026 FIRST Robotics Competition Game Manual,
 * Version TU22 — Table 6-4 (point values) and Table 6-5 (bonus RP thresholds).
 */

/** Table 6-4 — REBUILT point values. */
export const SCORING = {
  /** FUEL scored in an ACTIVE hub. Fuel scored in an inactive hub is worth 0. */
  fuel: {
    auto: 1,
    teleop: 1,
  },
  /**
   * TOWER points per ROBOT.
   *
   * Per manual 6.5.2: a robot may only earn LEVEL 1 during AUTO (max 2 robots
   * per alliance), and only a single LEVEL during TELEOP. A robot that climbs
   * in AUTO is still eligible for teleop tower points, so the per-robot
   * maximum is 15 + 30 = 45.
   */
  tower: {
    auto: { level1: 15, level2: 0, level3: 0 },
    teleop: { level1: 10, level2: 20, level3: 30 },
  },
} as const;

/** Table 6-5 — BONUS RP thresholds by event tier. */
export const RP_THRESHOLDS = {
  regional: { energized: 100, supercharged: 360, traversal: 50 },
  districtChampionship: { energized: 240, supercharged: 360, traversal: 50 },
  championship: { energized: 360, supercharged: 500, traversal: 50 },
} as const;

/** Table 6-4 — Ranking points awarded on match outcome. */
export const RP_AWARD = { win: 3, tie: 1, loss: 0 } as const;

/** Maximum tower points a single robot can earn in one match (auto L1 + teleop L3). */
export const MAX_ROBOT_TOWER_POINTS =
  SCORING.tower.auto.level1 + SCORING.tower.teleop.level3;

/**
 * Parse an AUTO climb value into a tower level (0 = no climb).
 *
 * Handles every shape the scouting form has stored over time: legacy booleans
 * and numbers, the shorthand 'climbed', and 'level1'..'level3'.
 */
export function autoClimbLevel(value: unknown): number {
  if (!value) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    if (value === 'didnt_climb' || value === 'none') return 0;
    if (value === 'climbed') return 1;
    const m = value.match(/level(\d+)/);
    if (m) return Number(m[1]);
  }
  return 0;
}

/** Parse a TELEOP/match climb value into a tower level (0 = no climb). */
export function teleopClimbLevel(value: unknown): number {
  if (!value) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (value === 'didnt_climb' || value === 'none') return 0;
    const m = value.match(/level(\d+)/);
    if (m) return Number(m[1]);
  }
  return 0;
}

/** Fuel scored during AUTO. */
export function autoFuelOf(entry: ScoutingData): number {
  return typeof entry.auto?.fuel === 'number' ? entry.auto.fuel : 0;
}

/**
 * Fuel scored during TELEOP.
 *
 * NOTE: the scouting form records a single teleop fuel total with no
 * hub-active context, so every recorded teleop fuel is treated as
 * active-hub fuel (1 pt). This is intentional — scouts only tally fuel that
 * actually scored, and fuel put into an inactive hub scores nothing, so it
 * would not be counted in the first place. Do not "fix" this by discounting.
 */
export function teleopFuelOf(entry: ScoutingData): number {
  const offence = (entry.teleop as any)?.offence?.fuel;
  const endgame = (entry.teleop as any)?.endgame?.fuel;
  const a = typeof offence === 'number' ? offence : 0;
  const b = typeof endgame === 'number' ? endgame : 0;
  return a + b;
}

/** TOWER points earned during AUTO. Only LEVEL 1 is possible in AUTO. */
export function autoTowerPointsOf(entry: ScoutingData): number {
  const level = autoClimbLevel((entry.auto as any)?.climbed);
  return level > 0 ? SCORING.tower.auto.level1 : 0;
}

/** TOWER points earned during TELEOP, for the single level achieved. */
export function teleopTowerPointsOf(entry: ScoutingData): number {
  const raw = (entry as any).matchClimbed ?? (entry.endgame as any)?.climb;
  const level = teleopClimbLevel(raw);
  if (level >= 3) return SCORING.tower.teleop.level3;
  if (level === 2) return SCORING.tower.teleop.level2;
  if (level === 1) return SCORING.tower.teleop.level1;
  return 0;
}

/** Total TOWER points for this robot across both periods. */
export function towerPointsFor(entry: ScoutingData): number {
  return autoTowerPointsOf(entry) + teleopTowerPointsOf(entry);
}

/**
 * Total MATCH points contributed by one robot in one match.
 *
 * fuel (auto + teleop, 1 pt each) + tower points (auto L1 and/or teleop level).
 */
export function matchPointsFor(entry: ScoutingData): number {
  return (
    autoFuelOf(entry) * SCORING.fuel.auto +
    teleopFuelOf(entry) * SCORING.fuel.teleop +
    towerPointsFor(entry)
  );
}

/** True when the robot stopped working at some point in the match. */
export function robotDiedIn(entry: ScoutingData): boolean {
  const died = (entry.endgame as any)?.died;
  if (died === 'partway' || died === 'start') return true;
  const shutdown = (entry as any).robotShutdown;
  return shutdown === 'part' || shutdown === 'full';
}
