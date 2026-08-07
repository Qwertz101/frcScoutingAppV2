import { useMemo, useState } from 'react';
import { TeamMetrics, percentile } from '../../utils/teamMetrics';
import { ScoutData } from './useScoutData';
import { PicklistState } from './usePicklistState';
import { DistributionBar } from './DistributionBar';
import { SyntheticFootnote } from './FieldRanking';
import { RP_THRESHOLDS } from '../../utils/scoring';
import { tagsFor, fmtPts } from '../picklist/insights';
import { readableMatchLabel } from '../../utils/match';
import { BpsFootnote, SourceBadge } from './BpsBits';

interface MatchStrategyProps {
  data: ScoutData;
  pick: PicklistState;
  onOpenTeam: (team: number) => void;
}

/**
 * Per-match plan built on a deliberately pessimistic framing: we are modelled at
 * our 25th-percentile match (a bad day for us) and the opponent at their 75th
 * (a good day for them). If the margin still looks fine there, the match is
 * genuinely comfortable rather than comfortable-on-average.
 */
export function MatchStrategy({ data, pick, onOpenTeam }: MatchStrategyProps) {
  const { matches, metricsFor, fieldMedian, hasSynthetic, hasBps, metrics } = data;
  const ourKey = `frc${pick.ourTeam}`;

  const ourMatches = useMemo(
    () =>
      matches
        .filter((m: any) => {
          const keys = [
            ...(m.alliances?.red?.team_keys || []),
            ...(m.alliances?.blue?.team_keys || []),
          ];
          return keys.includes(ourKey);
        })
        .sort((a: any, b: any) => (a.match_number ?? 0) - (b.match_number ?? 0)),
    [matches, ourKey]
  );

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const match = useMemo(
    () => ourMatches.find((m: any) => m.key === selectedKey) ?? ourMatches[0],
    [ourMatches, selectedKey]
  );

  const scaleMax = useMemo(() => {
    const top = Math.max(...metrics.map((m) => m.ceiling), 0);
    return Math.max(50, Math.ceil((top * 1.05) / 10) * 10);
  }, [metrics]);

  if (!ourMatches.length) {
    return (
      <div className="pl-body">
        <h1 className="pl-h1">MATCH STRATEGY</h1>
        <div className="pl-card" style={{ marginTop: 14 }}>
          <div className="pl-empty">
            Team {pick.ourTeam} is not in the loaded schedule. Import an event under{' '}
            <strong>Select Matches</strong>, or set your team number in the header.
          </div>
        </div>
      </div>
    );
  }

  const ourColor: 'red' | 'blue' =
    (match.alliances?.red?.team_keys || []).includes(ourKey) ? 'red' : 'blue';
  const oppColor = ourColor === 'red' ? 'blue' : 'red';

  const toMetrics = (keys: string[]): TeamMetrics[] =>
    keys
      .map((k) => metricsFor(Number(k.replace(/^frc/, ''))))
      .filter((m): m is TeamMetrics => !!m);

  const us = toMetrics(match.alliances?.[ourColor]?.team_keys || []);
  const them = toMetrics(match.alliances?.[oppColor]?.team_keys || []);

  /** Percentile of a robot's own scouted matches; falls back to its average. */
  const atPercentile = (t: TeamMetrics, p: number) =>
    t.hasData && t.matches.length
      ? percentile(t.matches.map((m) => m.points), p)
      : t.adjMean;

  const usFloor = us.reduce((s, t) => s + atPercentile(t, 0.25), 0);
  const themCeil = them.reduce((s, t) => s + atPercentile(t, 0.75), 0);
  const margin = Math.round(usFloor - themCeil);
  const winning = usFloor >= themCeil;

  // Energized RP is earned on active-hub FUEL, not total match points.
  const ourFuelFloor = us.reduce(
    (s, t) => s + (t.autoAvg + t.teleopAvg) * (t.hasData ? 0.8 : 1),
    0
  );
  const energizedTarget = RP_THRESHOLDS.regional.energized;
  const energizedCleared = ourFuelFloor >= energizedTarget;

  /**
   * Independent cross-check, NOT a replacement for the P25/P75 framing above.
   *
   * A robot's expected contribution under the solver is simply its rate times
   * the time it typically spends scoring. Summed over an alliance that gives a
   * second opinion on the same match built from a completely different data
   * path — if the two disagree badly, one of the two models is wrong and the
   * strategy call deserves a second look.
   */
  const bpsProjection = (teams: TeamMetrics[]) => {
    const covered = teams.filter((t) => t.hasBps);
    if (!covered.length) return null;
    const pts = covered.reduce((s, t) => {
      const solved = t.matches.filter((m) => m.source === 'bps');
      const secs = solved.length
        ? solved.reduce((a, m) => a + m.shootSeconds, 0) / solved.length
        : 0;
      return s + t.bps * secs;
    }, 0);
    return { pts: Math.round(pts), covered: covered.length, of: teams.length };
  };

  const usBps = bpsProjection(us);
  const themBps = bpsProjection(them);

  const barMax = Math.max(usFloor, themCeil, 1) * 1.15;
  const w = (v: number) => `${Math.max(4, (v / barMax) * 100).toFixed(1)}%`;

  const AllianceSide = ({
    label,
    teams,
    tone,
    pctl,
    total,
  }: {
    label: string;
    teams: TeamMetrics[];
    tone: 'us' | 'them';
    pctl: number;
    total: number;
  }) => (
    <div className="pl-card">
      <div className="pl-card-head">
        <span className="pl-card-label">{label}</span>
        <span className="pl-card-hint">
          {tone === 'us' ? 'P25 — a bad day for us' : 'P75 — a good day for them'}
        </span>
      </div>
      {teams.map((t) => (
        <div key={t.teamKey} className="pl-ms-row">
          <div className="pl-ms-team">
            <button className="pl-cmp-team" onClick={() => onOpenTeam(t.teamNumber)}>
              {t.team}
            </button>
            <span className="pl-card-hint">
              {fmtPts(atPercentile(t, pctl))} pts at P{pctl * 100}
            </span>
            <SourceBadge team={t} />
          </div>
          <DistributionBar team={t} scaleMax={scaleMax} height={34} />
          <div className="pl-tags">
            {tagsFor(t, fieldMedian).slice(0, 2).map((tag) => (
              <span key={tag.label} className="pl-tag" style={{ background: tag.bg, color: tag.fg }}>
                {tag.label}
              </span>
            ))}
          </div>
        </div>
      ))}
      <div className="pl-ms-total">
        <span className="pl-card-label">{tone === 'us' ? 'Alliance floor' : 'Opponent ceiling'}</span>
        <span className="pl-ms-total-num">{Math.round(total)}</span>
      </div>
    </div>
  );

  return (
    <div className="pl-body">
      <div className="pl-title-row">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="pl-eyebrow">Step 4 — plan the match</span>
          <h1 className="pl-h1">MATCH STRATEGY</h1>
        </div>
        <p className="pl-lede">
          Modelled pessimistically on purpose: us at our 25th-percentile match, them at their 75th.
          A margin that survives this is a genuinely safe match.
        </p>
      </div>

      <div className="pl-card" style={{ marginBottom: 14 }}>
        <div className="pl-card-head">
          <span className="pl-card-label">Our {ourMatches.length} matches</span>
          <span className="pl-card-hint">tap to plan</span>
        </div>
        <div className="pl-pool">
          {ourMatches.map((m: any) => (
            <button
              key={m.key}
              className="pl-pool-chip"
              onClick={() => setSelectedKey(m.key)}
              style={m.key === match.key ? { borderColor: 'var(--blue-600)' } : undefined}
            >
              <span className="pl-pool-team" style={{ fontSize: 13 }}>
                {readableMatchLabel(m)}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className={`pl-verdict ${winning ? 'good' : 'bad'}`}>
        <div>
          <span className="pl-card-label" style={{ color: 'inherit', opacity: 0.8 }}>
            Pessimistic margin
          </span>
          <div className="pl-verdict-num">
            {margin > 0 ? '+' : ''}
            {margin}
          </div>
          <span className="pl-verdict-text">
            {winning
              ? 'Cushion even in the worst case'
              : 'Deficit even before things go wrong'}
          </span>
        </div>
        <div className="pl-verdict-bars">
          <div className="pl-verdict-bar">
            <span>Us · P25 floor</span>
            <span className="pl-verdict-track">
              <span className="us" style={{ width: w(usFloor) }} />
            </span>
            <strong>{Math.round(usFloor)}</strong>
          </div>
          <div className="pl-verdict-bar">
            <span>Them · P75 ceiling</span>
            <span className="pl-verdict-track">
              <span className="them" style={{ width: w(themCeil) }} />
            </span>
            <strong>{Math.round(themCeil)}</strong>
          </div>
          <div className={`pl-energized ${energizedCleared ? 'on' : ''}`}>
            Energized RP at our floor: {Math.round(ourFuelFloor)} fuel ·{' '}
            {energizedCleared
              ? 'cleared'
              : `needs ${Math.ceil(energizedTarget - ourFuelFloor)} more`}{' '}
            (threshold {energizedTarget})
          </div>

          {(usBps || themBps) && (
            <div className="pl-bps-check">
              <span className="pl-src-badge bps">BPS</span>
              <span>cross-check · expected points, not a floor or ceiling:</span>
              {usBps && (
                <span title={`${usBps.covered} of ${usBps.of} robots have solved rates`}>
                  us <strong>{usBps.pts}</strong> ({usBps.covered}/{usBps.of} robots)
                </span>
              )}
              {themBps && (
                <span title={`${themBps.covered} of ${themBps.of} robots have solved rates`}>
                  them <strong>{themBps.pts}</strong> ({themBps.covered}/{themBps.of} robots)
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="pl-two-col" style={{ marginTop: 14 }}>
        <AllianceSide label={`Our alliance · ${ourColor}`} teams={us} tone="us" pctl={0.25} total={usFloor} />
        <AllianceSide label={`Opponent · ${oppColor}`} teams={them} tone="them" pctl={0.75} total={themCeil} />
      </div>

      {hasSynthetic && <SyntheticFootnote />}
      {hasBps && <BpsFootnote />}
    </div>
  );
}
