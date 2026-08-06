import { TeamMetrics } from '../../utils/teamMetrics';
import { tagsFor, noteFor, badgeFor, fmtPts, fmtSd } from './insights';

interface TierListProps {
  title: string;
  variant: 'tier1' | 'tier2';
  teams: number[];
  metricsFor: (team: number) => TeamMetrics | undefined;
  fieldMedian: number;
  /** Teams already claimed on the alliance board — shown struck through. */
  taken: Set<number>;
  moveLabel: string;
  onMoveUp: (team: number) => void;
  onMoveDown: (team: number) => void;
  onMoveTier: (team: number) => void;
  onRemove: (team: number) => void;
  onDragStart: (team: number) => void;
}

export function TierList({
  title,
  variant,
  teams,
  metricsFor,
  fieldMedian,
  taken,
  moveLabel,
  onMoveUp,
  onMoveDown,
  onMoveTier,
  onRemove,
  onDragStart,
}: TierListProps) {
  return (
    <div className="pl-card">
      <div className={`pl-tier-head ${variant}`}>
        <span className="pl-tier-title">{title}</span>
        <span className="pl-tier-count">{teams.length} ranked</span>
      </div>

      {teams.length === 0 && (
        <div className="pl-empty">
          Nothing here yet — add teams from the board or move them across from the other list.
        </div>
      )}

      {teams.map((team, i) => {
        const m = metricsFor(team);
        if (!m) return null;
        const isTaken = taken.has(team);
        const badge = badgeFor(m);

        return (
          <div key={team} className={`pl-tier-row${isTaken ? ' taken' : ''}`}>
            <div className="pl-tier-line">
              <span
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'copy';
                  e.dataTransfer.setData('text/plain', String(team));
                  onDragStart(team);
                }}
                className={`pl-tier-team${isTaken ? ' struck' : ''}`}
                title="Drag into a picklist tree slot"
              >
                {team}
              </span>
              <span className="pl-tier-mean">
                {fmtPts(m.adjMean)} {m.matchesPlayed > 1 ? fmtSd(m.adjSd) : ''}
              </span>
              <span className="pl-badge" style={{ background: badge.bg, color: badge.fg }}>
                {badge.label}
              </span>
              <div className="pl-spacer" />
              <button
                className="pl-icon-btn"
                title="Move up"
                disabled={i === 0}
                onClick={() => onMoveUp(team)}
              >
                ▲
              </button>
              <button
                className="pl-icon-btn"
                title="Move down"
                disabled={i === teams.length - 1}
                onClick={() => onMoveDown(team)}
              >
                ▼
              </button>
              <button className="pl-move-btn" title={moveLabel} onClick={() => onMoveTier(team)}>
                {moveLabel}
              </button>
              <button
                className="pl-icon-btn danger"
                title="Remove from this list"
                onClick={() => onRemove(team)}
              >
                ×
              </button>
            </div>

            <div className="pl-tags">
              {tagsFor(m, fieldMedian).map((t) => (
                <span key={t.label} className="pl-tag" style={{ background: t.bg, color: t.fg }}>
                  {t.label}
                </span>
              ))}
            </div>

            <p className="pl-note">{noteFor(m, fieldMedian)}</p>
          </div>
        );
      })}
    </div>
  );
}
