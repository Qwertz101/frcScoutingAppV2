import { useMemo } from 'react';
import { ArrowLeft } from 'lucide-react';
import { TeamMetrics } from '../../utils/teamMetrics';
import { ScoutData } from './useScoutData';
import { PicklistState } from './usePicklistState';
import { DistributionBar } from './DistributionBar';
import { tagsFor, noteFor, fmtPts } from '../picklist/insights';
import { RP_THRESHOLDS } from '../../utils/scoring';

interface TeamDeepDiveProps {
  team: TeamMetrics;
  data: ScoutData;
  pick: PicklistState;
  onBack: () => void;
  onFocusTeam: (team: number) => void;
}

export function TeamDeepDive({ team, data, pick, onBack, onFocusTeam }: TeamDeepDiveProps) {
  const { metrics, fieldMedian } = data;
  const scored = useMemo(() => metrics.filter((m) => m.hasData), [metrics]);

  const rank = useMemo(
    () => [...scored].sort((a, b) => b.adjMean - a.adjMean).findIndex((t) => t.teamKey === team.teamKey) + 1,
    [scored, team.teamKey]
  );

  const percentile = useMemo(() => {
    if (scored.length < 2) return 100;
    const below = scored.filter((o) => o.adjMean < team.adjMean).length;
    return Math.round((below / (scored.length - 1)) * 100);
  }, [scored, team.adjMean]);

  const scaleMax = useMemo(() => {
    const top = Math.max(...metrics.map((m) => m.ceiling), 0);
    return Math.max(50, Math.ceil((top * 1.05) / 10) * 10);
  }, [metrics]);

  /** Tallest per-match total, for scaling the auto/teleop stacked bars. */
  const barMax = useMemo(
    () => Math.max(...team.matches.map((m) => m.points), 1),
    [team.matches]
  );

  const inPick = pick.tier1.includes(team.teamNumber);
  const inCmp = pick.compare.includes(team.teamNumber);
  const isDnp = pick.dnpTeams.has(team.teamNumber);

  return (
    <div className="pl-body">
      <div className="pl-title-row">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <button className="pl-pill-btn" onClick={onBack} style={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 6 }}>
            <ArrowLeft className="w-4 h-4" />
            All teams
          </button>
          <span className="pl-eyebrow">
            Rank {rank || '—'} of {scored.length} · {percentile}th percentile
          </span>
          <h1 className="pl-h1">{team.team}</h1>
          <div className="pl-tags">
            {tagsFor(team, fieldMedian).map((t) => (
              <span key={t.label} className="pl-tag" style={{ background: t.bg, color: t.fg }}>
                {t.label}
              </span>
            ))}
          </div>
        </div>

        <div className="pl-rank-actions" style={{ alignSelf: 'flex-end' }}>
          <button className={`pl-act${inPick ? ' on' : ''}`} title="Add to 1st-pick shortlist" onClick={() => pick.addToPicklist(team.teamNumber)}>+</button>
          <button className={`pl-act${inCmp ? ' on' : ''}`} title="Add to compare" onClick={() => pick.toggleCompare(team.teamNumber)}>‖</button>
          <button className={`pl-act${isDnp ? ' on danger' : ''}`} title="Do not pick" onClick={() => pick.toggleDnp(team.teamNumber)}>×</button>
        </div>
      </div>

      <div className="pl-dd-stats">
        {[
          ['Avg pts', fmtPts(team.adjMean), team.matchesPlayed > 1 ? `±${Math.round(team.adjSd)}` : ''],
          ['Median', fmtPts(team.median), `IQR ${fmtPts(team.q1)}–${fmtPts(team.q3)}`],
          ['Range', `${fmtPts(team.floor)}–${fmtPts(team.ceiling)}`, 'normal range'],
          ['Auto avg', fmtPts(team.autoAvg), 'fuel'],
          ['Teleop avg', fmtPts(team.teleopAvg), 'fuel'],
          ['Climb', `${Math.round(team.climbRate)}%`, `tower ${fmtPts(team.towerAvg)} pts`],
        ].map(([label, value, sub]) => (
          <div key={label} className="pl-dd-stat">
            <span className="pl-stat-label">{label}</span>
            <span className="pl-dd-stat-num">{value}</span>
            <span className="pl-card-hint">{sub}</span>
          </div>
        ))}
      </div>

      <div className="pl-card" style={{ padding: '16px 18px', marginBottom: 14 }}>
        <div className="pl-card-head" style={{ border: 'none', padding: 0, marginBottom: 8 }}>
          <span className="pl-card-label">Match-point distribution</span>
          <span className="pl-card-hint">
            Energized RP threshold {RP_THRESHOLDS.regional.energized} shown for reference
          </span>
        </div>
        <DistributionBar
          team={team}
          scaleMax={scaleMax}
          threshold={RP_THRESHOLDS.regional.energized}
          height={56}
        />
      </div>

      <div className="pl-card" style={{ padding: '16px 18px', marginBottom: 14 }}>
        <div className="pl-card-head" style={{ border: 'none', padding: 0, marginBottom: 12 }}>
          <span className="pl-card-label">Match by match · auto vs teleop</span>
          <span className="pl-card-hint">
            {team.isSynthetic ? 'reconstructed from season averages' : `${team.matchesPlayed} scouted matches`}
          </span>
        </div>

        {team.matches.length === 0 ? (
          <div className="pl-empty">No matches scouted.</div>
        ) : (
          <div className={`pl-mbm${team.isSynthetic ? ' synthetic' : ''}`}>
            {team.matches.map((m) => {
              const autoH = (m.autoFuel / barMax) * 100;
              const teleH = (m.teleopFuel / barMax) * 100;
              const towerH = (m.towerPoints / barMax) * 100;
              return (
                <div
                  key={m.matchKey}
                  className="pl-mbm-col"
                  title={`${m.label}: ${m.points} pts (auto ${m.autoFuel}, teleop ${m.teleopFuel}, tower ${m.towerPoints})${m.died ? ' — died' : ''}`}
                >
                  <div className="pl-mbm-stack">
                    <span className="pl-mbm-tower" style={{ height: `${towerH}%` }} />
                    <span className="pl-mbm-tele" style={{ height: `${teleH}%` }} />
                    <span className="pl-mbm-auto" style={{ height: `${autoH}%` }} />
                    {m.died && <span className="pl-mbm-dead" />}
                  </div>
                  <span className="pl-mbm-label">{m.label}</span>
                </div>
              );
            })}
          </div>
        )}

        <div className="pl-mbm-key">
          <span><i className="pl-mbm-auto" />auto fuel</span>
          <span><i className="pl-mbm-tele" />teleop fuel</span>
          <span><i className="pl-mbm-tower" />tower</span>
        </div>
      </div>

      {team.outliers.length > 0 && (
        <div className="pl-card" style={{ marginBottom: 14 }}>
          <div className="pl-card-head">
            <span className="pl-card-label">Flagged matches</span>
            <span className="pl-card-hint">excluded from the average</span>
          </div>
          {team.outliers.map((o) => (
            <div key={o.matchKey} className="pl-dnp-row">
              <span className="pl-dnp-team" style={{ textDecoration: 'none' }}>{o.label}</span>
              <span className="pl-dnp-reason" style={{ padding: '0 8px' }}>
                {o.points} pts — {o.died ? 'robot died mid-match' : 'below normal range'}
              </span>
            </div>
          ))}
        </div>
      )}

      <p className="pl-note">{noteFor(team, fieldMedian)}</p>

      <div className="pl-card" style={{ marginTop: 14 }}>
        <div className="pl-card-head">
          <span className="pl-card-label">Jump to</span>
        </div>
        <div className="pl-pool">
          {[...scored]
            .sort((a, b) => b.adjMean - a.adjMean)
            .map((t) => (
              <button
                key={t.teamKey}
                className="pl-pool-chip"
                onClick={() => onFocusTeam(t.teamNumber)}
                style={t.teamNumber === team.teamNumber ? { borderColor: 'var(--blue-600)' } : undefined}
              >
                <span className="pl-pool-team">{t.team}</span>
                <span className="pl-pool-mean">{fmtPts(t.adjMean)}</span>
              </button>
            ))}
        </div>
      </div>
    </div>
  );
}
