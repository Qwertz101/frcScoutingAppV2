import { AUTO_LEN, AUTO_TELEOP_DELAY, CvMatchLog, Match, TimelineScoutingData } from '../../types';
import type { BpsReport } from './index';
import { buildUnits, occupancy } from './fuzzy';

export interface ScoreAllocation {
  matchKey: string;
  alliance: 'red' | 'blue';
  /** Match elapsed second; NOT wall time or YouTube playback position. */
  sec: number;
  phase: 'auto' | 'teleop';
  observed: number;
  teams: Record<string, number>;
  unassigned: number;
  ambiguous: boolean;
  reason?: 'incomplete scouting' | 'no plausible shooter';
}

export interface ScoreAttribution {
  samples: ScoreAllocation[];
  byRobot: Record<string, { auto: number; teleop: number }>;
  byAlliance: Record<string, { observed: number; assigned: number; unassigned: number }>;
}

/** Split OBSERVED deltas, using fitted rates only to weight overlapping shooters.
 * Never invent points from shooting duration or distribute orphan points.
 * Missing robot coverage is deliberately withheld rather than awarded to a teammate.
 */
export function buildScoreAttribution(
  timelines: TimelineScoutingData[], logs: CvMatchLog[], report: BpsReport | null,
  matches: Match[] = []
): ScoreAttribution {
  const out: ScoreAttribution = { samples: [], byRobot: {}, byAlliance: {} };
  if (!report) return out;
  const schedules = new Map(matches.map((m) => [m.key, m]));
  for (const unit of buildUnits(timelines, logs)) {
    const key = `${unit.matchKey}|${unit.alliance}`;
    const summary = out.byAlliance[key] = { observed: 0, assigned: 0, unassigned: 0 };
    const expected = schedules.get(unit.matchKey)?.alliances[unit.alliance].team_keys;
    const full = unit.timelines.length === 3 && (!expected ||
      (expected.length === 3 && expected.every((team) => unit.timelines.some((t) => t.teamKey === team))));
    const occ = unit.timelines.map((t) => occupancy(t, report.timeShifts[t.id] ?? 0));
    const complete = full && unit.timelines.every((t) => !t.endedEarly);
    if (complete) for (const t of unit.timelines) out.byRobot[`${unit.matchKey}|${t.teamKey}`] = { auto: 0, teleop: 0 };
    for (let sec = 1; sec < unit.delta.length; sec++) {
      const observed = unit.delta[sec];
      if (!observed) continue;
      const phase = sec < AUTO_LEN + AUTO_TELEOP_DELAY ? 'auto' : 'teleop';
      const covered = complete;
      // Gaussian tails must not turn a distant score into a robot's points.
      const active = unit.timelines.map((t, i) => ({ t, rho: occ[i][sec] }))
        .filter(({ rho }) => rho >= 0.08);
      const sample: ScoreAllocation = { matchKey: unit.matchKey, alliance: unit.alliance,
        sec, phase, observed, teams: {}, unassigned: observed, ambiguous: active.length > 1 };
      if (!covered) sample.reason = 'incomplete scouting';
      else if (!active.length) sample.reason = 'no plausible shooter';
      else {
        let weights = active.map(({ t, rho }) => {
          const rates = report.byTeam[t.teamKey];
          return rho * Math.max(0, (phase === 'auto' ? rates?.autoBps : rates?.teleopBps) ?? 0);
        });
        // Cold-start identical/zero priors: split by occupancy, with ambiguity retained.
        if (weights.reduce((a, b) => a + b, 0) === 0) weights = active.map(({ rho }) => rho);
        const sum = weights.reduce((a, b) => a + b, 0);
        active.forEach(({ t }, i) => {
          const points = observed * weights[i] / sum;
          sample.teams[t.teamKey] = points;
          out.byRobot[`${unit.matchKey}|${t.teamKey}`][phase] += points;
        });
        sample.unassigned = 0;
      }
      summary.observed += observed;
      summary.unassigned += sample.unassigned;
      summary.assigned += observed - sample.unassigned;
      out.samples.push(sample);
    }
  }
  return out;
}
