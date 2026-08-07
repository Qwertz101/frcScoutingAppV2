import { useMemo } from 'react';
import { TeamMetrics, percentile } from '../../utils/teamMetrics';
import { ScoutData } from './useScoutData';
import { PicklistState } from './usePicklistState';
import { DistributionBar, DistributionAxis } from './DistributionBar';
import { SyntheticFootnote } from './FieldRanking';
import { BpsFootnote, SolverDiagnostics, SourceBadge } from './BpsBits';
import { colorFor, fmtPts } from '../picklist/insights';
import { TeamDeepDive } from './TeamDeepDive';

interface TeamAnalysisProps {
  data: ScoutData;
  pick: PicklistState;
  focusTeam: number | null;
  onFocusTeam: (team: number | null) => void;
}

export function TeamAnalysis({ data, pick, focusTeam, onFocusTeam }: TeamAnalysisProps) {
  const { metrics, metricsFor, fieldMedian, hasSynthetic, hasBps, bpsReport } = data;

  const scored = useMemo(() => metrics.filter((m) => m.hasData), [metrics]);

  /** Compared teams, defaulting to the top four when nothing is selected. */
  const compared = useMemo(() => {
    const chosen = pick.compare
      .map(metricsFor)
      .filter((m): m is TeamMetrics => !!m);
    if (chosen.length) return chosen;
    return [...scored].sort((a, b) => b.adjMean - a.adjMean).slice(0, 4);
  }, [pick.compare, metricsFor, scored]);

  const scaleMax = useMemo(() => {
    const top = Math.max(...metrics.map((m) => m.ceiling), 0);
    return Math.max(50, Math.ceil((top * 1.05) / 10) * 10);
  }, [metrics]);

  const best = (fn: (t: TeamMetrics) => number) => {
    if (!scored.length) return '—';
    const winner = scored.reduce((a, b) => (fn(b) > fn(a) ? b : a));
    return winner.team;
  };

  if (focusTeam != null) {
    const team = metricsFor(focusTeam);
    if (team) {
      return (
        <TeamDeepDive
          team={team}
          data={data}
          pick={pick}
          onBack={() => onFocusTeam(null)}
          onFocusTeam={onFocusTeam}
        />
      );
    }
  }

  return (
    <div className="pl-body">
      <div className="pl-title-row">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="pl-eyebrow">Step 3 — read a robot</span>
          <h1 className="pl-h1">TEAM ANALYSIS</h1>
        </div>
        <div className="pl-stat-row">
          <div className="pl-stat">
            <span className="pl-stat-label">Most points</span>
            <span className="pl-stat-num">{best((t) => t.adjMean)}</span>
          </div>
          <div className="pl-stat">
            <span className="pl-stat-label">Best auto</span>
            <span className="pl-stat-num">{best((t) => t.autoAvg)}</span>
          </div>
          <div className="pl-stat">
            <span className="pl-stat-label">Most consistent</span>
            <span className="pl-stat-num">{best((t) => t.consistency)}</span>
          </div>
          <div className="pl-stat">
            <span className="pl-stat-label">Highest ceiling</span>
            <span className="pl-stat-num">{best((t) => t.ceiling)}</span>
          </div>
        </div>
      </div>

      <div className="pl-card" style={{ padding: '18px 20px 8px' }}>
        <div className="pl-cmp-head">
          <span className="pl-card-label">Same axis</span>
          <div style={{ position: 'relative', height: 14 }}>
            <DistributionAxis scaleMax={scaleMax} />
          </div>
        </div>

        {compared.length === 0 && (
          <div className="pl-empty">
            No scouting data yet. Import a stats CSV from Analyze Data, or scout some matches.
          </div>
        )}

        {compared.map((c) => (
          <div key={c.teamKey} className="pl-cmp-row">
            <div className="pl-cmp-label">
              <span className="pl-dot" style={{ background: colorFor(c, fieldMedian) }} />
              <button className="pl-cmp-team" onClick={() => onFocusTeam(c.teamNumber)}>
                {c.team}
              </button>
              <SourceBadge team={c} />
              {pick.compare.includes(c.teamNumber) && (
                <button
                  className="pl-link-btn"
                  title="Remove from compare"
                  onClick={() => pick.toggleCompare(c.teamNumber)}
                >
                  ×
                </button>
              )}
            </div>
            <div>
              <DistributionBar team={c} scaleMax={scaleMax} height={38} />
              <div className="pl-cmp-meta">
                <span><strong>{fmtPts(c.adjMean)}</strong> avg</span>
                <span>median {fmtPts(c.median)}</span>
                <span>range {fmtPts(c.floor)}–{fmtPts(c.ceiling)}</span>
                <span>{c.matchesPlayed} scouted</span>
                {c.deaths.length > 0 && <span className="pl-warn">{c.deaths.length} dead</span>}
                {c.isSynthetic && <span className="pl-warn">reconstructed</span>}
                {c.hasBps && (
                  <span title="Solved points per second — auto / teleop">
                    <strong>{c.bps.toFixed(2)}</strong> BPS ({c.autoBps.toFixed(2)}/
                    {c.teleopBps.toFixed(2)})
                  </span>
                )}
              </div>
            </div>
          </div>
        ))}

        {pick.compare.length === 0 && compared.length > 0 && (
          <p className="pl-card-hint" style={{ padding: '4px 0 12px' }}>
            Showing the top {compared.length} by average. Use the ‖ button on Field Ranking to pick
            your own comparison set.
          </p>
        )}
      </div>

      <div className="pl-card" style={{ marginTop: 14 }}>
        <div className="pl-card-head">
          <span className="pl-card-label">Where each robot sits</span>
          <span className="pl-card-hint">percentile of average match points across the field</span>
        </div>
        <div className="pl-pctl-grid">
          {[...scored]
            .sort((a, b) => b.adjMean - a.adjMean)
            .map((t) => {
              const below = scored.filter((o) => o.adjMean < t.adjMean).length;
              const pctl = scored.length > 1 ? Math.round((below / (scored.length - 1)) * 100) : 100;
              return (
                <button
                  key={t.teamKey}
                  className="pl-pctl"
                  onClick={() => onFocusTeam(t.teamNumber)}
                  title={`${fmtPts(t.adjMean)} avg pts · ${pctl}th percentile`}
                >
                  <span className="pl-pctl-team">{t.team}</span>
                  <span className="pl-pctl-bar">
                    <span style={{ width: `${pctl}%`, background: colorFor(t, fieldMedian) }} />
                  </span>
                  <span className="pl-pctl-val">{pctl}</span>
                </button>
              );
            })}
        </div>
      </div>

      {/* Solver health lives here rather than on its own tab: this is the
          screen where a scout goes to decide whether to believe a number. */}
      {bpsReport && <SolverDiagnostics report={bpsReport} />}

      {hasSynthetic && <SyntheticFootnote />}
      {hasBps && <BpsFootnote />}
    </div>
  );
}

/** Field percentile for a value within a set of team averages. */
export function percentileOf(values: number[], v: number): number {
  if (values.length < 2) return 100;
  const below = values.filter((x) => x < v).length;
  return Math.round((below / (values.length - 1)) * 100);
}

export { percentile };
