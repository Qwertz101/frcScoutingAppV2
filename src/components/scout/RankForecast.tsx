import { useMemo, useState } from 'react';
import { TeamMetrics } from '../../utils/teamMetrics';
import { ScoutData } from './useScoutData';
import { PicklistState } from './usePicklistState';
import { SyntheticFootnote } from './FieldRanking';
import { RP_THRESHOLDS, RP_AWARD } from '../../utils/scoring';

interface RankForecastProps {
  data: ScoutData;
  pick: PicklistState;
  onOpenTeam: (team: number) => void;
}

type CaseKey = 'pessimistic' | 'expected' | 'optimistic';

const CASES: { key: CaseKey; label: string; sub: string; accent: string }[] = [
  { key: 'pessimistic', label: 'Rough weekend', sub: 'every robot at its floor', accent: '#000' },
  { key: 'expected', label: 'Expected', sub: 'every robot at its average', accent: '#1179ee' },
  { key: 'optimistic', label: 'Everything clicks', sub: 'every robot at its ceiling', accent: '#00baff' },
];

interface Projection {
  points: number;
  fuel: number;
  tower: number;
}

/**
 * Scale a robot's fuel and tower contributions to match the case being modelled,
 * so a "floor" scenario is internally consistent rather than mixing a bad points
 * total with average fuel.
 */
function projectTeam(t: TeamMetrics, when: CaseKey): Projection {
  const base = t.adjMean || 0;
  const points =
    when === 'pessimistic' ? t.floor : when === 'optimistic' ? t.ceiling : base;
  const scale = base > 0 ? points / base : 1;
  return {
    points,
    fuel: (t.autoAvg + t.teleopAvg) * scale,
    tower: t.towerAvg * scale,
  };
}

const sumProj = (ps: Projection[]): Projection =>
  ps.reduce(
    (a, p) => ({ points: a.points + p.points, fuel: a.fuel + p.fuel, tower: a.tower + p.tower }),
    { points: 0, fuel: 0, tower: 0 }
  );

export function RankForecast({ data, pick, onOpenTeam }: RankForecastProps) {
  const { matches, metricsFor, hasSynthetic } = data;
  const [activeCase, setActiveCase] = useState<CaseKey>('expected');

  const thresholds = RP_THRESHOLDS.regional;

  /**
   * Simulate every scheduled qualification match under one scenario and roll the
   * results up into a Ranking Score per manual §10.5.3
   * (total RP ÷ matches scheduled).
   */
  const forecast = useMemo(() => {
    const run = (when: CaseKey) => {
      const rp = new Map<number, number>();
      const played = new Map<number, number>();

      const quals = matches.filter((m: any) => (m.comp_level ?? 'qm') === 'qm');

      quals.forEach((m: any) => {
        const side = (color: 'red' | 'blue'): TeamMetrics[] =>
          ((m.alliances?.[color]?.team_keys || []) as string[])
            .map((k) => metricsFor(Number(k.replace(/^frc/, ''))))
            .filter((t): t is TeamMetrics => !!t);

        const red = side('red');
        const blue = side('blue');
        if (!red.length || !blue.length) return;

        const redP = sumProj(red.map((t) => projectTeam(t, when)));
        const blueP = sumProj(blue.map((t) => projectTeam(t, when)));

        const award = (teams: TeamMetrics[], own: Projection, opp: Projection) => {
          let earned =
            own.points > opp.points
              ? RP_AWARD.win
              : own.points === opp.points
              ? RP_AWARD.tie
              : RP_AWARD.loss;

          if (own.fuel >= thresholds.energized) earned += 1;
          if (own.fuel >= thresholds.supercharged) earned += 1;
          if (own.tower >= thresholds.traversal) earned += 1;

          teams.forEach((t) => {
            rp.set(t.teamNumber, (rp.get(t.teamNumber) ?? 0) + earned);
            played.set(t.teamNumber, (played.get(t.teamNumber) ?? 0) + 1);
          });
        };

        award(red, redP, blueP);
        award(blue, blueP, redP);
      });

      const rows = Array.from(rp.entries()).map(([team, total]) => {
        const n = played.get(team) || 1;
        return { team, rp: total, matches: n, rs: Math.round((total / n) * 100) / 100 };
      });

      rows.sort((a, b) => b.rs - a.rs);
      return rows.map((r, i) => ({ ...r, rank: i + 1 }));
    };

    return {
      pessimistic: run('pessimistic'),
      expected: run('expected'),
      optimistic: run('optimistic'),
    } as Record<CaseKey, { team: number; rp: number; matches: number; rs: number; rank: number }[]>;
  }, [matches, metricsFor, thresholds]);

  const rows = forecast[activeCase];
  const ourRow = rows.find((r) => r.team === pick.ourTeam);
  const caseMeta = CASES.find((c) => c.key === activeCase)!;

  const ourSeeds = CASES.map((c) => ({
    ...c,
    rank: forecast[c.key].find((r) => r.team === pick.ourTeam)?.rank ?? null,
    rs: forecast[c.key].find((r) => r.team === pick.ourTeam)?.rs ?? null,
  }));

  if (!rows.length) {
    return (
      <div className="pl-body">
        <h1 className="pl-h1">RANK FORECAST</h1>
        <div className="pl-card" style={{ marginTop: 14 }}>
          <div className="pl-empty">
            Nothing to project yet — a match schedule and some scouting data are both needed.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pl-body">
      <div className="pl-title-row">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="pl-eyebrow">Step 5 — where we land</span>
          <h1 className="pl-h1">RANK FORECAST</h1>
        </div>
        <p className="pl-lede">
          Every scheduled qualification match simulated from current scouting, then scored under the
          2026 rules: win {RP_AWARD.win} RP, tie {RP_AWARD.tie}, plus Energized (
          {thresholds.energized} fuel), Supercharged ({thresholds.supercharged}) and Traversal (
          {thresholds.traversal} tower). Ranking Score is total RP ÷ matches.
        </p>
      </div>

      <div className="pl-forecast-cases">
        {ourSeeds.map((c) => (
          <button
            key={c.key}
            className={`pl-forecast-case${activeCase === c.key ? ' active' : ''}`}
            onClick={() => setActiveCase(c.key)}
            style={activeCase === c.key ? { borderColor: c.accent } : undefined}
          >
            <span className="pl-stat-label">{c.label}</span>
            <span className="pl-forecast-seed" style={{ color: c.accent }}>
              {c.rank ? `#${c.rank}` : '—'}
            </span>
            <span className="pl-card-hint">{c.sub}</span>
            <span className="pl-card-hint">{c.rs != null ? `${c.rs} RS` : ''}</span>
          </button>
        ))}
      </div>

      <div className="pl-card" style={{ marginTop: 14 }}>
        <div className="pl-card-head">
          <span className="pl-card-label">
            Projected standings · {caseMeta.label.toLowerCase()}
          </span>
          <span className="pl-card-hint">
            {ourRow
              ? `${pick.ourTeam} projects to seed ${ourRow.rank} of ${rows.length} (${ourRow.rs} RS)`
              : `${pick.ourTeam} is not in this schedule`}
          </span>
        </div>

        <div className="pl-forecast-table">
          <div className="pl-forecast-head">
            <span>Seed</span>
            <span>Team</span>
            <span style={{ textAlign: 'right' }}>Ranking score</span>
            <span style={{ textAlign: 'right' }}>Total RP</span>
            <span style={{ textAlign: 'right' }}>Matches</span>
            <span />
          </div>
          {rows.map((r) => {
            const isUs = r.team === pick.ourTeam;
            const captain = r.rank <= 8;
            return (
              <div
                key={r.team}
                className={`pl-forecast-row${isUs ? ' us' : ''}${captain ? ' captain' : ''}`}
              >
                <span className="pl-rank-num" style={{ fontSize: 17 }}>{r.rank}</span>
                <button className="pl-cmp-team" onClick={() => onOpenTeam(r.team)}>
                  {r.team}
                </button>
                <span style={{ textAlign: 'right', fontWeight: 700 }}>{r.rs}</span>
                <span style={{ textAlign: 'right' }}>{r.rp}</span>
                <span style={{ textAlign: 'right' }}>{r.matches}</span>
                <span className="pl-forecast-flag">
                  {captain ? 'alliance lead' : ''}
                  {isUs ? ' · us' : ''}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <p className="pl-note" style={{ marginTop: 14, maxWidth: 900 }}>
        <strong>How to read this:</strong> results are simulated, not actual. Every scheduled
        qualification match is replayed with each robot fixed at its floor, average or ceiling — real
        matches mix good and bad performances, so true standings will sit between these cases. Ties
        are resolved by ranking score alone here; the official tiebreakers (average match points,
        then auto fuel, then tower points) are not modelled.
      </p>

      {hasSynthetic && <SyntheticFootnote />}
    </div>
  );
}
