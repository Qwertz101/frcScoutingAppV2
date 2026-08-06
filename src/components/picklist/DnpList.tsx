import { DnpEntry } from '../../services/picklistService';

interface DnpListProps {
  entries: DnpEntry[];
  onRestore: (team: number) => void;
  onReasonChange: (team: number, reason: string) => void;
}

export function DnpList({ entries, onRestore, onReasonChange }: DnpListProps) {
  return (
    <div className="pl-card">
      <div className="pl-card-head" style={{ alignItems: 'center', justifyContent: 'flex-start', gap: 8 }}>
        <span className="pl-dnp-mark" />
        <span className="pl-card-label">Do not pick</span>
      </div>

      {entries.length === 0 && (
        <div className="pl-empty">
          Nobody ruled out yet. Remove a team from a tier list to add them here.
        </div>
      )}

      {entries.map((d) => (
        <div key={d.team} className="pl-dnp-row">
          <span className="pl-dnp-team">{d.team}</span>
          <input
            className="pl-dnp-reason"
            value={d.reason}
            placeholder="why not?"
            onChange={(e) => onReasonChange(d.team, e.target.value)}
          />
          <button className="pl-link-btn" onClick={() => onRestore(d.team)}>
            restore
          </button>
        </div>
      ))}
    </div>
  );
}
