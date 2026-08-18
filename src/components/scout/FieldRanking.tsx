import { useEffect, useMemo, useRef, useState } from 'react';
import { TeamMetrics } from '../../utils/teamMetrics';
import { ScoutData } from './useScoutData';
import { PicklistState } from './usePicklistState';
import { fmtPts } from '../picklist/insights';
import { denialFor } from '../picklist/allianceModel';
import { roleOf, ROLE_COLOR, useAllianceContext } from '../picklist/roles';
import { BpsFootnote, SourceBadge } from './BpsBits';

interface FieldRankingProps {
  data: ScoutData;
  pick: PicklistState;
  onOpenTeam: (team: number) => void;
}

/**
 * One robot's normal range, drawn as a band that fades out towards the floor
 * and the ceiling: solid through the middle of the distribution, washed out at
 * the extremes it only occasionally reaches.
 */
function bandGradient(t: TeamMetrics): string {
  const core = ROLE_COLOR[roleOf(t)];
  const span = Math.max(1, t.ceiling - t.floor);
  const f1 = ((t.median - t.floor) * 0.45 * 100) / span;
  const f2 = 100 - ((t.ceiling - t.median) * 0.45 * 100) / span;
  const soft = (a: number) => `rgba(0,186,255,${a})`;
  return (
    `linear-gradient(90deg, ${soft(0.05)} 0%, ${soft(0.85)} ${(f1 * 0.5).toFixed(1)}%, ` +
    `${core} ${f1.toFixed(1)}%, ${core} ${f2.toFixed(1)}%, ` +
    `${soft(0.85)} ${(f2 + (100 - f2) * 0.5).toFixed(1)}%, ${soft(0.05)} 100%)`
  );
}

/**
 * The field, ordered.
 *
 * Above the defence line teams are ranked by what they score; below it, by how
 * much they deny. The line itself is draggable because where it belongs is a
 * judgement call about this specific field — there is no threshold that is
 * right at every event, and the strategy team is the one who knows whether the
 * 9th-best scorer is really a better pick than the best defender.
 */
export function FieldRanking({ data, pick, onOpenTeam }: FieldRankingProps) {
  const { metrics, hasBps } = data;
  const ctx = useAllianceContext(data);

  const listRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);

  /** Teams that are actually at this event, best scorers first. */
  const byOffense = useMemo(
    () =>
      metrics
        .filter((m) => m.hasData || m.matchesScheduled > 0)
        .sort((a, b) => b.adjMean - a.adjMean),
    [metrics]
  );

  const divider = Math.max(1, Math.min(Math.max(1, byOffense.length - 1), pick.defenseLine));

  const ordered = useMemo(
    () => [
      ...byOffense.slice(0, divider),
      ...byOffense.slice(divider).sort((a, b) => denialFor(b, ctx) - denialFor(a, ctx)),
    ],
    [byOffense, divider, ctx]
  );

  /** Shared axis so every band on the screen is directly comparable. */
  const scaleMax = useMemo(() => {
    const top = Math.max(...metrics.map((m) => m.ceiling), 0);
    return Math.max(50, Math.ceil((top * 1.05) / 10) * 10);
  }, [metrics]);

  const pct = (v: number) => `${Math.min(100, (v / scaleMax) * 100)}%`;

  // Dragging the defence line is tracked on the window, not the handle: the
  // pointer routinely leaves the thin strip mid-drag, and a handle-local
  // listener would drop the gesture the moment it did.
  useEffect(() => {
    if (!dragging) return;
    const move = (ev: MouseEvent | TouchEvent) => {
      const el = listRef.current;
      if (!el || byOffense.length === 0) return;
      const pt = 'touches' in ev ? ev.touches[0] : ev;
      const rect = el.getBoundingClientRect();
      const rowH = rect.height / byOffense.length;
      const idx = Math.round((pt.clientY - rect.top) / rowH);
      const next = Math.max(1, Math.min(byOffense.length - 1, idx));
      if (next !== pick.defenseLine) pick.setDefenseLine(next);
      if (ev.cancelable) ev.preventDefault();
    };
    const up = () => setDragging(false);
    window.addEventListener('mousemove', move);
    window.addEventListener('touchmove', move, { passive: false });
    window.addEventListener('mouseup', up);
    window.addEventListener('touchend', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('touchmove', move as EventListener);
      window.removeEventListener('mouseup', up);
      window.removeEventListener('touchend', up);
    };
  }, [dragging, byOffense.length, pick]);

  return (
    <div className="pl-body">
      <div className="pl-title-row">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <span className="pl-eyebrow">Step 1 — read the field</span>
          <h1 className="pl-h1">FIELD RANKING</h1>
        </div>
        <div className="pl-fr-legend">
          <span><i className="pl-fr-key-band" />floor → ceiling</span>
          <span><i className="pl-fr-key-med" />median</span>
          <span><i className="pl-fr-key-dots" />match by match</span>
        </div>
      </div>

      <div className="pl-card pl-fr-card">
        {ordered.length === 0 && (
          <div className="pl-empty">
            No teams yet. Import an event under <strong>Select Matches</strong>.
          </div>
        )}

        <div
          ref={listRef}
          className="pl-fr-list"
          style={{ userSelect: dragging ? 'none' : 'auto' }}
        >
          {ordered.map((t, i) => {
            const isDef = i >= divider;
            const core = ROLE_COLOR[roleOf(t)];
            const denied = denialFor(t, ctx);
            const isUs = t.teamNumber === pick.ourTeam;
            const isDnp = pick.dnpTeams.has(t.teamNumber);
            const slots = Math.max(t.matchesScheduled, t.matches.length, 1);

            return (
              <div key={t.teamKey} className="pl-fr-rowwrap">
                <div
                  className={`pl-fr-row${isDef ? ' def' : ''}${isUs ? ' us' : ''}${
                    isDnp ? ' dnp' : ''
                  }`}
                >
                  <span
                    className="pl-fr-rank"
                    style={{ color: i < 8 ? 'var(--blue-600)' : 'var(--text-faint)' }}
                  >
                    {i + 1}
                  </span>

                  <span className="pl-fr-team">
                    <button className="pl-fr-team-num" onClick={() => onOpenTeam(t.teamNumber)}>
                      {t.team}
                    </button>
                    <span className="pl-fr-team-sub">
                      {t.hasData ? `${t.matchesPlayed} scouted` : 'unscouted'}
                      {t.isSynthetic ? ' · reconstructed' : ''} <SourceBadge team={t} />
                    </span>
                  </span>

                  <span className="pl-fr-viz">
                    <span className="pl-fr-band">
                      <span className="pl-fr-band-track" />
                      {t.hasData && (
                        <>
                          <span
                            className="pl-fr-band-fill"
                            style={{
                              left: pct(t.floor),
                              width: pct(Math.max(1, t.ceiling - t.floor)),
                              background: bandGradient(t),
                            }}
                          />
                          <span className="pl-fr-whisker" style={{ left: pct(t.floor) }} />
                          <span className="pl-fr-whisker" style={{ left: pct(t.ceiling) }} />
                          <span
                            className="pl-fr-median"
                            style={{ left: `calc(${pct(t.median)} - 2.5px)` }}
                          />
                        </>
                      )}
                    </span>
                    <span className="pl-fr-dots">
                      {Array.from({ length: slots }, (_, k) => {
                        const m = t.matches[k];
                        const tip = m
                          ? `${m.label} · ${Math.round(m.points)} pts${m.died ? ' · died' : ''}`
                          : 'not scouted';
                        const color = !m
                          ? 'var(--border)'
                          : m.died
                            ? '#000'
                            : m.points >= t.median
                              ? core
                              : '#cfe0e6';
                        return (
                          <span
                            key={k}
                            className="pl-fr-dot"
                            title={tip}
                            style={{ background: color }}
                          />
                        );
                      })}
                    </span>
                  </span>

                  <span className="pl-fr-metric">
                    <span
                      className="pl-fr-metric-num"
                      style={{ color: isDef ? 'var(--teal-500)' : 'var(--text)' }}
                    >
                      {isDef ? fmtPts(denied) : fmtPts(t.adjMean)}
                    </span>
                    <span className="pl-fr-metric-label">{isDef ? 'pts denied' : 'avg pts'}</span>
                  </span>
                </div>

                {i === divider - 1 && (
                  <div
                    className={`pl-fr-divider${dragging ? ' dragging' : ''}`}
                    onMouseDown={(e) => { e.stopPropagation(); setDragging(true); }}
                    onTouchStart={(e) => { e.stopPropagation(); setDragging(true); }}
                  >
                    <span className="pl-fr-divider-tag">Defense line ⇕</span>
                    <span className="pl-fr-divider-rule" />
                    <span className="pl-fr-divider-hint">Below: ranked by denial</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {!ctx.hasBps && ordered.length > 0 && (
        <p className="pl-note">
          No CV-fused matches yet, so “pts denied” below the defence line is estimated from the
          scouters' 0–4 defence rating rather than from measured defensive time.
        </p>
      )}

      {data.hasSynthetic && <SyntheticFootnote />}
      {hasBps && <BpsFootnote />}
    </div>
  );
}

/** Standing disclaimer wherever reconstructed data can appear. */
export function SyntheticFootnote() {
  return (
    <p className="pl-note pl-synth-note">
      Rows marked <strong>reconstructed</strong> were rebuilt from an exported season-averages CSV.
      Their auto/teleop averages, climb rates and death counts are real; the match-to-match spread
      (band, floor, ceiling, consistency) is illustrative rather than observed.
    </p>
  );
}
