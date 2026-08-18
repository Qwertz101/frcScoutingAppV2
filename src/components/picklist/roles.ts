import { useMemo } from 'react';
import { TeamMetrics, percentile } from '../../utils/teamMetrics';
import { ScoutData } from '../scout/useScoutData';
import { AllianceContext, denialFor } from './allianceModel';

/**
 * The one-word role a robot plays, used for colour coding across the picklist
 * screens. Deliberately coarse — it is a reading aid, not a judgement.
 */
export type Role = 'climb' | 'score' | 'defend';

export const ROLE_COLOR: Record<Role, string> = {
  climb: '#1179ee',
  score: '#00baff',
  defend: '#33becc',
};

export const ROLE_LABEL: Record<Role, string> = {
  climb: 'climber',
  score: 'scorer',
  defend: 'defender',
};

/**
 * A robot climbs if it reliably banks tower points; it defends if it spends
 * real time denying; otherwise it cycles. Climbing wins the tie because a
 * climb is guaranteed points an alliance can plan around.
 */
export function roleOf(t: TeamMetrics): Role {
  if (t.towerAvg >= 15) return 'climb';
  if (t.defenseAvg >= 3 || (t.avgDefenseSeconds > 0 && t.avgDefenseSeconds >= 40)) return 'defend';
  return 'score';
}

/**
 * Shared context for the alliance-value model.
 *
 * `ptsPerSecond` is the field's median teleop scoring rate — what a typical
 * robot would have scored in the time a defender took away from it. Using the
 * median rather than the mean keeps one runaway robot from inflating what
 * every defender appears to be worth.
 */
export function useAllianceContext(data: ScoutData): AllianceContext {
  const { metricsFor, metrics, hasBps } = data;
  return useMemo(() => {
    const rates = metrics.filter((m) => m.hasBps && m.teleopBps > 0).map((m) => m.teleopBps);
    return {
      metricsFor,
      ptsPerSecond: rates.length ? percentile(rates, 0.5) : 0,
      hasBps: hasBps && rates.length > 0,
    };
  }, [metricsFor, metrics, hasBps]);
}

/** Sort key used wherever defenders are ranked against each other. */
export const denialOf = denialFor;
