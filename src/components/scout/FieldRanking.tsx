import { useMemo, useState } from 'react';
import { TeamMetrics } from '../../utils/teamMetrics';
import { ScoutData } from './useScoutData';
import { PicklistState } from './usePicklistState';
import { DistributionBar } from './DistributionBar';
import { RP_THRESHOLDS } from '../../utils/scoring';
import { tagsFor, fmtPts } from '../picklist/insights';

type SortKey = 'adj' | 'cons' | 'auto' | 'ceil';

interface FieldRankingProps {
  data: ScoutData;
  pick: PicklistState;
  onOpenTeam: (team: number) => void;
}

/** Reliability strip: one cell per scheduled match, coloured by outcome. */
function ReliabilityStrip({ team }: { team: TeamMetrics }) {
  const slots = Math.max(team.matchesScheduled, team.matchesPlayed, 1);
  const byIndex = team.matches;

  return (
    <div className="pl-rel">
      {Array.from({ length: slots }, (_, i) => {
        const m = byIndex[i];
        let cls = 'empty';
        let tip = 'not scouted';
        if (m) {
          if (m.died) { cls = 'dead'; tip = `${m.label}: died`; }
          else if (team.outliers.some((o) => o.matchKey === m.matchKey)) { cls = 'low'; tip = `${m.label}: ${m.points} pts (low)`; }
          else if (m.points >= team.q3) { cls = 'high'; tip = `${m.label}: ${m.points} pts`; }
          else { cls = 'ok'; tip = `${m.label}: ${m.points} pts`; }
        }
        return <span key={i} className={`pl-rel-cell ${cls}`} title={tip} />;
      })}
    </div>
  );
}

export function FieldRanking({ data, pick, onOpenTeam }: FieldRankingProps) {
  const [sortBy, setSortBy] = useState<SortKey>('adj');
  const { metrics, fieldMedian, hasSynthetic } = data;

  const sorted = useMemo(() => {
    const copy = metrics.filter((m) => m.hasData || m.matchesScheduled > 0);
    const key: Record<SortKey, (t: TeamMetrics) => number> = {
      adj: (t) => t.adjMean,
      cons: (t) => t.consistency,
      auto: (t) => t.autoAvg,
      ceil: (t) => t.ceiling,
    };
    return copy.sort((a, b) => key[sortBy](b) - key[sortBy](a));
  }, [metrics, sortBy]);

  /** Shared axis so every distribution bar is directly comparable. */
  const scaleMax = useMemo(() => {
    const top = Math.max(...metrics.map((m) => m.ceiling), 0);
    return Math.max(50, Math.ceil((top * 1.05) / 10) * 10);
  }, [metrics]);

  const sortBtn = (k: SortKey, label: string) => (
    <button
      className={`pl-sort${sortBy === k ? ' active' : ''}`}
      onClick={() => setSortBy(k)}
    >
      {label}
    </button>
  );

  return (
    <div className="pl-body">
      <div className="pl-title-row">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="pl-eyebrow">Step 1 — read the field</span>
          <h1 className="pl-h1">EVERY ROBOT, EVERY MATCH</h1>
          <p className="pl-lede" style={{ textAlign: 'left', flexBasis: 'auto', maxWidth: 640 }}>
            Blue deepens with percentile — bottom 25%, middle 50% (IQR), top 25% — across each
            robot's normal range. Low-performing matches outside that range are excluded from the
            band and flagged with a “!” instead.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {sortBtn('adj', 'Avg pts')}
          {sortBtn('cons', 'Consistency')}
          {sortBtn('auto', 'Auto')}
          {sortBtn('ceil', 'Ceiling')}
        </div>
      </div>

      <div className="pl-legend">
        <span><span className="pl-legend-band" />outer 25% · middle 50%</span>
        <span><span className="pl-legend-median" />median</span>
        <span><span className="pl-legend-whisker" />floor / ceiling</span>
        <span><span className="pl-legend-out">!</span>low outlier</span>
        <span><span className="pl-legend-death" />died mid-match</span>
      </div>

      <div className="pl-card">
        <div className="pl-rank-scroll">
          {/*
            The header lives inside the same scrolling box as the rows (rather
            than as a sibling above it) so both share the exact scrollbar
            gutter — as a sibling, the vertical scrollbar shrinks the rows'
            available width but not the header's, and every column drifts out
            of alignment by the scrollbar's width.
          */}
          <div className="pl-rank-head">
            <span>Rank</span>
            <span>Team</span>
            {/* Padding matches .pl-dist's own horizontal margins so both the
                label and the threshold caption sit over the bar they describe. */}
            <span className="pl-rank-head-dist">
              <span>Match-point distribution</span>
              <span className="pl-rank-head-rp">
                Energized RP · {RP_THRESHOLDS.regional.energized} pts
              </span>
            </span>
            <span style={{ textAlign: 'center' }}>Flags</span>
            <span style={{ textAlign: 'right', paddingRight: 8 }}>Avg pts</span>
            <span style={{ textAlign: 'center' }}>Reliability</span>
            <span style={{ paddingLeft: 12 }}>Role</span>
            <span style={{ textAlign: 'right' }}>Actions</span>
          </div>

          {sorted.length === 0 && (
            <div className="pl-empty">
              No teams yet. Import an event under <strong>Select Matches</strong>.
            </div>
          )}

          {sorted.map((t, i) => {
            const isDnp = pick.dnpTeams.has(t.teamNumber);
            const inPick = pick.tier1.includes(t.teamNumber);
            const inCmp = pick.compare.includes(t.teamNumber);
            const isUs = t.teamNumber === pick.ourTeam;

            return (
              <div
                key={t.teamKey}
                className={`pl-rank-row${isUs ? ' us' : ''}${isDnp ? ' dnp' : ''}`}
              >
                <span className="pl-rank-num">{i + 1}</span>

                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <button className="pl-rank-team" onClick={() => onOpenTeam(t.teamNumber)}>
                    {t.team}
                  </button>
                  <span className="pl-rank-sub">
                    {t.hasData ? `${t.matchesPlayed} scouted` : 'unscouted'}
                    {t.isSynthetic ? ' · reconstructed' : ''}
                  </span>
                </div>

                <DistributionBar
                  team={t}
                  scaleMax={scaleMax}
                  threshold={RP_THRESHOLDS.regional.energized}
                />

                <div className="pl-rank-flags">
                  {t.outliers.length > 0 ? (
                    <span
                      className="pl-flag"
                      title={t.outliers.map((o) => `${o.label}: ${o.points} pts`).join(', ')}
                    >
                      <span className="pl-flag-mark">!</span>
                      {t.outliers.length} low
                    </span>
                  ) : (
                    <span className="pl-dash">—</span>
                  )}
                </div>

                <div className="pl-rank-mean">
                  <span className="pl-rank-mean-num">{fmtPts(t.adjMean)}</span>
                  <span className="pl-rank-mean-sub">
                    auto {fmtPts(t.autoAvg)} · climb {Math.round(t.climbRate)}%
                  </span>
                </div>

                <div className="pl-rank-rel">
                  <ReliabilityStrip team={t} />
                </div>

                <div className="pl-rank-tags">
                  {tagsFor(t, fieldMedian).slice(0, 3).map((tag) => (
                    <span
                      key={tag.label}
                      className="pl-tag"
                      style={{ background: tag.bg, color: tag.fg }}
                    >
                      {tag.label}
                    </span>
                  ))}
                </div>

                <div className="pl-rank-actions">
                  <button
                    className={`pl-act${inPick ? ' on' : ''}`}
                    title="Add to 1st-pick shortlist"
                    onClick={() => pick.addToPicklist(t.teamNumber)}
                  >
                    +
                  </button>
                  <button
                    className={`pl-act${inCmp ? ' on' : ''}`}
                    title="Add to compare"
                    onClick={() => pick.toggleCompare(t.teamNumber)}
                  >
                    ‖
                  </button>
                  <button
                    className={`pl-act${isDnp ? ' on danger' : ''}`}
                    title="Do not pick"
                    onClick={() => pick.toggleDnp(t.teamNumber)}
                  >
                    ×
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {hasSynthetic && <SyntheticFootnote />}
    </div>
  );
}

/** Standing disclaimer wherever reconstructed data can appear. */
export function SyntheticFootnote() {
  return (
    <p className="pl-note pl-synth-note">
      Rows marked <strong>reconstructed</strong> were rebuilt from an exported season-averages CSV.
      Their auto/teleop averages, climb rates and death counts are real; the match-to-match spread
      (band, floor, ceiling, consistency) is illustrative rather than observed. Distribution bars for
      these teams are drawn dashed.
    </p>
  );
}
