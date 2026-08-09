import { useMemo } from 'react';
import { ArrowLeft } from 'lucide-react';
import { TeamMetrics } from '../../utils/teamMetrics';
import { ScoutData } from './useScoutData';
import { PicklistState } from './usePicklistState';
import { DistributionBar } from './DistributionBar';
import { tagsFor, noteFor, fmtPts } from '../picklist/insights';
import { RP_THRESHOLDS } from '../../utils/scoring';
import { BpsBadge, BpsFootnote, SourceBadge } from './BpsBits';

/**
 * BPS rates and the action-time breakdown for one robot.
 *
 * Rendered only when the team actually has solved matches, so a legacy-only
 * robot's deep dive is byte-for-byte the page it has always been.
 */
function BpsPanel({ team }: { team: TeamMetrics }) {
  const tracked =
    team.scoringSeconds + team.passSeconds + team.defSeconds + team.oofSeconds;
  const pct = (v: number) => (tracked > 0 ? (v / tracked) * 100 : 0);
  const secs = (v: number) => `${Math.round(v)}s`;

  return (
    <div className="pl-card" style={{ marginBottom: 14 }}>
      <div className="pl-card-head">
        <span className="pl-card-label">
          Solved rate <BpsBadge />
        </span>
        <span className="pl-card-hint">
          {team.bpsWindows} solver window{team.bpsWindows === 1 ? '' : 's'}
          {team.bpsWindows > 0 && team.bpsWindows < 6 ? ' — few, treat as provisional' : ''}
        </span>
      </div>

      <div className="pl-bps-grid">
        {[
          ['BPS', team.bps.toFixed(2), 'points per second, whole match'],
          ['Auto BPS', team.autoBps.toFixed(2), 'first 20 seconds'],
          ['Teleop BPS', team.teleopBps.toFixed(2), 'remaining 140 seconds'],
          ['Scoring time', secs(team.scoringSeconds), 'flagged shooting'],
        ].map(([label, value, sub]) => (
          <div key={label} className="pl-bps-cell">
            <span className="pl-stat-label">{label}</span>
            <span className="pl-bps-num">{value}</span>
            <span className="pl-card-hint">{sub}</span>
          </div>
        ))}
      </div>

      <div style={{ padding: '0 18px 16px' }}>
        <span className="pl-stat-label">Where the time went</span>
        <div className="pl-act-bar" title="Share of tracked time in each action">
          <span className="shoot" style={{ width: `${pct(team.scoringSeconds)}%` }} />
          <span className="pass" style={{ width: `${pct(team.passSeconds)}%` }} />
          <span className="def" style={{ width: `${pct(team.defSeconds)}%` }} />
          <span className="oof" style={{ width: `${pct(team.oofSeconds)}%` }} />
        </div>
        <div className="pl-act-key">
          <span><i className="shoot" />shooting {secs(team.scoringSeconds)}</span>
          <span><i className="pass" />passing {secs(team.passSeconds)}</span>
          <span><i className="def" />defense {secs(team.defSeconds)}</span>
          <span><i className="oof" />out of order {secs(team.oofSeconds)}</span>
        </div>

        {team.passSeconds > 0 && (
          <div className="pl-pass-est">
            <div>
              <span className="pl-stat-label">Fuel passed per match</span>
              <span className="pl-pass-num">~{team.passedFuelPerMatch.toFixed(0)}</span>
            </div>
            <p className="pl-card-hint">
              Estimated, not measured. Passing scores nothing, so the solver cannot see it
              directly — this assumes the robot moves fuel just as fast feeding an ally as
              shooting, and applies its {team.teleopBps.toFixed(2)}/s teleop rate to{' '}
              {secs(team.passSeconds)} of passing.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

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

  /**
   * Tallest per-match total, for scaling the auto/teleop stacked bars.
   *
   * The stack height is taken from the segments rather than `points` because on
   * a BPS match the tower estimate is deliberately not folded into `points`
   * (the CV scoreboard already contains the climb) — scaling by `points` alone
   * would let those stacks overflow their track.
   */
  const barMax = useMemo(
    () =>
      Math.max(
        // Legacy matches keep their existing scaling exactly.
        ...team.matches.map((m) =>
          m.source === 'bps'
            ? Math.max(m.points, m.autoFuel + m.teleopFuel + m.towerPoints)
            : m.points
        ),
        1
      ),
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
          <h1 className="pl-h1">
            {team.team} <SourceBadge team={team} />
          </h1>
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
          // On a BPS or mixed team these averages mix fuel counts with solved
          // points, so the sub-label has to stop claiming "fuel".
          ['Auto avg', fmtPts(team.autoAvg), team.hasBps ? 'fuel / BPS pts' : 'fuel'],
          ['Teleop avg', fmtPts(team.teleopAvg), team.hasBps ? 'fuel / BPS pts' : 'fuel'],
          ['Climb', `${Math.round(team.climbRate)}%`, `tower ${fmtPts(team.towerAvg)} pts`],
        ].map(([label, value, sub]) => (
          <div key={label} className="pl-dd-stat">
            <span className="pl-stat-label">{label}</span>
            <span className="pl-dd-stat-num">{value}</span>
            <span className="pl-card-hint">{sub}</span>
          </div>
        ))}
      </div>

      {team.hasBps && <BpsPanel team={team} />}

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
            {team.hasBps &&
              ` · ${team.matches.filter((m) => m.source === 'bps').length} solved from BPS`}
          </span>
        </div>

        {team.matches.length === 0 ? (
          <div className="pl-empty">No matches scouted.</div>
        ) : (
          <div className={`pl-mbm${team.isSynthetic ? ' synthetic' : ''}`} data-source={team.source}>
            {team.matches.map((m) => {
              const autoH = (m.autoFuel / barMax) * 100;
              const teleH = (m.teleopFuel / barMax) * 100;
              const towerH = (m.towerPoints / barMax) * 100;
              return (
                <div
                  key={m.matchKey}
                  className="pl-mbm-col"
                  title={
                    m.source === 'bps'
                      ? `${m.label}: ${m.points} pts from BPS (auto ${m.autoFuel}, teleop ${m.teleopFuel}; climb ${m.towerPoints ? 'yes' : 'no'}, already inside the total)${m.died ? ' — went out of order' : ''}`
                      : `${m.label}: ${m.points} pts (auto ${m.autoFuel}, teleop ${m.teleopFuel}, tower ${m.towerPoints})${m.died ? ' — died' : ''}`
                  }
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

      {team.hasBps && <BpsFootnote />}

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
