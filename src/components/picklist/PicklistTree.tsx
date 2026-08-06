import { useState } from 'react';
import { TreeBranch, AllianceSlot } from '../../services/picklistService';
import { TeamMetrics, projectAlliance } from '../../utils/teamMetrics';
import { fmtPts } from './insights';

interface PicklistTreeProps {
  branches: TreeBranch[];
  board: AllianceSlot[];
  metricsFor: (team: number) => TeamMetrics | undefined;
  ourTeam: number;
  onSetSlot: (id: number, slot: 'cap' | 'second', team: number | null) => void;
  onAddBranch: () => void;
  onRemoveBranch: (id: number) => void;
}

/**
 * Hypothetical "captain + us + 2nd pick" permutations. Dragging a team from a
 * tier list copies it in — teams stay in the pool so they can be reused across
 * branches.
 */
export function PicklistTree({
  branches,
  board,
  metricsFor,
  ourTeam,
  onSetSlot,
  onAddBranch,
  onRemoveBranch,
}: PicklistTreeProps) {
  const [dragOver, setDragOver] = useState<string | null>(null);

  const takenElsewhere = (team: number) =>
    board.some((a) => [a.captain, ...a.picks].filter((t) => t != null).includes(team));

  const readTeam = (e: React.DragEvent) => {
    const raw = e.dataTransfer.getData('text/plain');
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const usMetrics = metricsFor(ourTeam);

  const renderSlot = (b: TreeBranch, slot: 'cap' | 'second', hint: string) => {
    const team = b[slot];
    const key = `${b.id}-${slot}`;
    const m = team != null ? metricsFor(team) : undefined;

    return (
      <div
        className={`pl-slot${dragOver === key ? ' over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          setDragOver(key);
        }}
        onDragLeave={() => setDragOver((k) => (k === key ? null : k))}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(null);
          const n = readTeam(e);
          if (n != null) onSetSlot(b.id, slot, n);
        }}
      >
        {team == null ? (
          <span className="pl-slot-hint">{hint}</span>
        ) : (
          <>
            <button
              className="pl-slot-team"
              title="Clear this slot"
              onClick={() => onSetSlot(b.id, slot, null)}
            >
              {team}
            </button>
            <span className="pl-slot-mean">{m ? `${fmtPts(m.adjMean)} pts` : 'no data'}</span>
            {takenElsewhere(team) && <span className="pl-slot-warn">Taken elsewhere</span>}
          </>
        )}
      </div>
    );
  };

  return (
    <div className="pl-tree">
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 16,
          marginBottom: 10,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span className="pl-card-label">Picklist tree</span>
          <span className="pl-card-hint">
            Drag a team from the tier lists into a slot below. Dragging copies it — it stays in the
            pool so you can reuse it in other branches.
          </span>
        </div>
        <button className="pl-pill-btn" onClick={onAddBranch}>
          + Add permutation
        </button>
      </div>

      {branches.map((b) => {
        const members = [b.cap, ourTeam, b.second]
          .filter((t): t is number => t != null)
          .map(metricsFor)
          .filter((m): m is TeamMetrics => !!m);
        const hasTotal = b.cap != null && b.second != null && members.length > 0;
        const total = hasTotal ? projectAlliance(members).pts : 0;

        return (
          <div key={b.id} className="pl-tree-row">
            {renderSlot(b, 'cap', 'drop captain')}
            <span className="pl-connector" />
            <div className="pl-slot us">
              <span className="pl-slot-team">{ourTeam}</span>
              <span className="pl-slot-us-label">
                us · {usMetrics ? `${fmtPts(usMetrics.adjMean)} pts` : '1st'}
              </span>
            </div>
            {renderSlot(b, 'second', 'drop 2nd pick')}
            <div className="pl-tree-total">
              {hasTotal && (
                <span className="pl-trio">
                  trio <strong>{total}</strong>
                </span>
              )}
              <button
                className="pl-icon-btn danger"
                title="Remove permutation"
                style={{ width: 26, height: 26, marginLeft: 'auto' }}
                onClick={() => onRemoveBranch(b.id)}
              >
                ×
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
