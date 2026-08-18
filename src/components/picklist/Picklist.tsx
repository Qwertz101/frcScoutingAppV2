import { useMemo } from 'react';
import { TeamMetrics, percentile } from '../../utils/teamMetrics';
import { ScoutData } from '../scout/useScoutData';
import { PicklistState } from '../scout/usePicklistState';
import { SyntheticFootnote } from '../scout/FieldRanking';
import { seatedMap } from './allianceModel';
import { roleOf, ROLE_LABEL } from './roles';
import { useTeamPhotos } from './useTeamPhotos';
import './picklist.css';

interface PicklistProps {
  data: ScoutData;
  pick: PicklistState;
}

interface Shelf {
  label: string;
  color: string;
  teams: TeamMetrics[];
}

/**
 * Build the branches we will actually pick from.
 *
 * A picklist is not a single ordered list — on the clock you get whoever is
 * left, so what you need is "if we get X, then take Y, else Z". Tapping a card
 * sets the 1st-pick target and every tap after that ranks a 2nd-pick option
 * for that branch. Saved branches are read back on the Alliance Selection
 * screen, where they get struck through as teams come off the board.
 */
export function Picklist({ data, pick }: PicklistProps) {
  const { metrics, hasSynthetic } = data;
  const {
    ourTeam, board, dnpTeams,
    builderFirst, builderSeconds, tapCard, clearBuilder, saveBranch,
  } = pick;

  const field = useMemo(
    () => metrics.filter((m) => m.hasData || m.matchesScheduled > 0),
    [metrics]
  );

  const photos = useTeamPhotos(useMemo(() => field.map((t) => t.teamNumber), [field]));
  const seated = useMemo(() => seatedMap(board), [board]);

  /**
   * Tiers are cut from this field's own distribution rather than from fixed
   * point thresholds: 250 points is a captain at one event and a mid-tier
   * robot at another, and a picklist that mislabels the whole field is worse
   * than no labels at all. Teams marked do-not-pick are forced to the bottom
   * shelf however well they score.
   */
  const shelves = useMemo<Shelf[]>(() => {
    const scored = field.filter((t) => t.hasData).map((t) => t.adjMean);
    const cut = (p: number) => (scored.length ? percentile(scored, p) : 0);
    const bands = [
      { label: 'CAPTAIN TIER', color: '#1179ee', min: cut(0.75) },
      { label: '1ST PICK', color: '#00baff', min: cut(0.5) },
      { label: '2ND PICK', color: '#33becc', min: cut(0.25) },
      { label: 'DO NOT PICK', color: '#8a9aa2', min: -Infinity },
    ];
    const tiers = bands.map((b, i) => {
      const upper = i === 0 ? Infinity : bands[i - 1].min;
      const last = i === bands.length - 1;
      return {
        label: b.label,
        color: b.color,
        teams: field.filter((t) => {
          if (dnpTeams.has(t.teamNumber)) return last;
          if (!t.hasData) return false;
          return t.adjMean >= b.min && (i === 0 ? true : t.adjMean < upper);
        }),
      };
    });
    // Robots nobody has scouted yet get their own shelf. Dropping them into
    // DO NOT PICK would read as a judgement the data does not support — we
    // know nothing about them, which is not the same as knowing they are bad.
    const unscouted = field.filter((t) => !t.hasData && !dnpTeams.has(t.teamNumber));
    return unscouted.length
      ? [...tiers, { label: 'NOT SCOUTED YET', color: '#8a9aa2', teams: unscouted }]
      : tiers;
  }, [field, dnpTeams]);

  const scaleMax = useMemo(() => {
    const top = Math.max(...field.map((t) => t.ceiling), 0);
    return Math.max(50, Math.ceil((top * 1.05) / 10) * 10);
  }, [field]);

  const pct = (v: number) => `${Math.min(100, (v / scaleMax) * 100)}%`;
  const canSave = builderFirst != null && builderSeconds.length > 0;

  return (
    <div className="pl-body">
      <div className="pl-title-row">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <span className="pl-eyebrow">Step 2 — build branches</span>
          <h1 className="pl-h1">PICKLIST</h1>
        </div>
        <div className="pl-pk-actions">
          <span className="pl-pk-hint">
            {builderFirst != null
              ? `${builderSeconds.length} second-pick option${
                  builderSeconds.length === 1 ? '' : 's'
                } ranked`
              : 'Tap a card to start a branch'}
          </span>
          <button
            className={`pl-pk-save${canSave ? ' on' : ''}`}
            onClick={saveBranch}
            disabled={!canSave}
          >
            Save branch
          </button>
          <button className="pl-pill-btn" onClick={clearBuilder}>
            Clear
          </button>
        </div>
      </div>

      <div className="pl-pk-builder">
        <span className="pl-pk-builder-label">Building</span>
        {builderFirst != null && (
          <>
            <span className="pl-pk-chip first">
              <span className="pl-pk-chip-ord">1st</span>
              <span className="pl-pk-chip-team">{builderFirst}</span>
            </span>
            <span className="pl-pk-arrow">→</span>
          </>
        )}
        {builderSeconds.map((t, i) => (
          <span key={t} className="pl-pk-chip second">
            <span className="pl-pk-chip-ord">#{i + 1}</span>
            <span className="pl-pk-chip-team">{t}</span>
          </span>
        ))}
        {builderFirst == null && builderSeconds.length === 0 && (
          <span className="pl-pk-builder-empty">
            Tap a card to set the 1st pick, then tap cards in order to rank its 2nd-pick options.
          </span>
        )}
      </div>

      <div className="pl-card pl-pk-card">
        {field.length === 0 && (
          <div className="pl-empty">
            No teams yet. Import an event under <strong>Select Matches</strong>.
          </div>
        )}

        {shelves.map((sh) => (
          <div key={sh.label} className="pl-pk-shelf">
            <div className="pl-pk-shelf-head">
              <span className="pl-pk-shelf-label" style={{ color: sh.color }}>
                {sh.label}
              </span>
              <span className="pl-pk-shelf-rule" />
              <span className="pl-pk-shelf-count">
                {sh.teams.length} robot{sh.teams.length === 1 ? '' : 's'} ·{' '}
                {sh.teams.some((t) => t.hasData)
                  ? `${Math.round(Math.min(...sh.teams.filter((t) => t.hasData).map((t) => t.adjMean)))}–${Math.round(
                      Math.max(...sh.teams.filter((t) => t.hasData).map((t) => t.adjMean))
                    )} pts`
                  : '—'}
              </span>
            </div>

            <div className="pl-pk-shelf-cards">
              {sh.teams.map((t) => {
                const isFirst = builderFirst === t.teamNumber;
                const secondIdx = builderSeconds.indexOf(t.teamNumber);
                const isSecond = secondIdx >= 0;
                const gone = seated[t.teamNumber];
                const badge = isFirst
                  ? '1st'
                  : isSecond
                    ? `#${secondIdx + 1}`
                    : gone
                      ? `A${gone}`
                      : t.teamNumber === ourTeam
                        ? 'us'
                        : dnpTeams.has(t.teamNumber)
                          ? 'dnp'
                          : null;
                const photo = photos[t.teamNumber];
                const slots = Math.max(t.matchesScheduled, t.matches.length, 1);

                return (
                  <div
                    key={t.teamKey}
                    className={`pl-pk-cardw${isFirst ? ' first' : ''}${isSecond ? ' second' : ''}${
                      gone ? ' gone' : ''
                    }`}
                  >
                    <div className="pl-pk-photo">
                      {photo ? (
                        <img src={photo} alt="" loading="lazy" />
                      ) : (
                        <span className="pl-pk-photo-empty">{t.team}</span>
                      )}
                      <span className="pl-pk-photo-team">{t.team}</span>
                      {badge && <span className="pl-pk-badge">{badge}</span>}
                    </div>

                    <button className="pl-pk-tap" onClick={() => tapCard(t.teamNumber)}>
                      <span className="pl-pk-tap-top">
                        <span className="pl-pk-role">{ROLE_LABEL[roleOf(t)]}</span>
                        <span className="pl-pk-pts" style={{ color: isFirst || isSecond ? '#fff' : sh.color }}>
                          {t.hasData ? Math.round(t.adjMean) : '—'}
                        </span>
                      </span>
                      <span className="pl-pk-track">
                        {t.hasData && (
                          <>
                            <span
                              className="pl-pk-track-fill"
                              style={{
                                left: pct(t.floor),
                                width: pct(Math.max(1, t.ceiling - t.floor)),
                                background: isFirst || isSecond ? '#fff' : sh.color,
                              }}
                            />
                            <span className="pl-pk-track-med" style={{ left: pct(t.median) }} />
                          </>
                        )}
                      </span>
                      <span className="pl-pk-dots">
                        {Array.from({ length: slots }, (_, k) => {
                          const m = t.matches[k];
                          const color = !m
                            ? 'rgba(0,0,0,.08)'
                            : m.died
                              ? '#000'
                              : m.points >= t.median
                                ? isFirst || isSecond
                                  ? '#fff'
                                  : sh.color
                                : isFirst || isSecond
                                  ? 'rgba(255,255,255,.3)'
                                  : '#cfe0e6';
                          return <span key={k} className="pl-pk-dot" style={{ background: color }} />;
                        })}
                      </span>
                    </button>
                  </div>
                );
              })}
              {sh.teams.length === 0 && <span className="pl-pk-shelf-empty">nothing here yet</span>}
            </div>
          </div>
        ))}
      </div>

      <p className="pl-note" style={{ marginTop: 14, maxWidth: 900 }}>
        Tiers are cut from this field's own point distribution — top quarter, then each quarter
        below it. Match points follow the 2026 <em>REBUILT</em> scoring table: fuel is 1 point in
        both AUTO and TELEOP, an AUTO tower climb is 15, and a TELEOP climb is 10 / 20 / 30 for
        levels 1–3.
      </p>

      {hasSynthetic && <SyntheticFootnote />}
    </div>
  );
}
