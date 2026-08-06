import { AllianceSlot } from '../../services/picklistService';
import { TeamMetrics, projectAlliance } from '../../utils/teamMetrics';
import { colorFor, fmtPts } from './insights';

interface AllianceBoardProps {
  board: AllianceSlot[];
  metricsFor: (team: number) => TeamMetrics | undefined;
  ourTeam: number;
  /** Index of the alliance currently on the clock, or -1 when the board is full. */
  onTheClock: number;
  pool: number[];
  fieldMedian: number;
  onAddToClock: (team: number) => void;
  onRemovePick: (allianceIdx: number, team: number) => void;
}

/** Alliance depth label read off strength seed, not announcement order. */
function depthLabel(rank: number, total: number): string {
  if (total < 2) return 'unseeded';
  const pct = rank / total;
  if (pct <= 0.25) return 'title contender';
  if (pct <= 0.5) return 'deep run';
  if (pct <= 0.75) return 'winnable bracket';
  return 'needs an upset';
}

export function AllianceBoard({
  board,
  metricsFor,
  ourTeam,
  onTheClock,
  pool,
  fieldMedian,
  onAddToClock,
  onRemovePick,
}: AllianceBoardProps) {
  // Strength for each alliance, then rank them so depth labels reflect seed.
  const strengths = board.map((a) => {
    const members = [a.captain, ...a.picks]
      .filter((t): t is number => t != null)
      .map(metricsFor)
      .filter((m): m is TeamMetrics => !!m);
    return members.length ? projectAlliance(members).pts : 0;
  });

  const ranked = [...strengths].sort((a, b) => b - a);
  const seedOf = (pts: number) => (pts > 0 ? ranked.indexOf(pts) + 1 : 0);
  const filled = strengths.filter((s) => s > 0).length;

  return (
    <>
      <div className="pl-alliances">
        {board.map((a, i) => {
          const members = [a.captain, ...a.picks].filter((t): t is number => t != null);
          const isOurs = members.includes(ourTeam);
          const openSlots = 2 - a.picks.length;
          const seed = seedOf(strengths[i]);

          return (
            <div key={i} className={`pl-alliance${isOurs ? ' ours' : ''}`}>
              <div className="pl-alliance-head">
                <span className="pl-alliance-idx">Alliance {i + 1}</span>
                <span className="pl-alliance-open">
                  {i === onTheClock
                    ? 'on the clock'
                    : openSlots > 0
                    ? `${openSlots} open`
                    : 'full'}
                </span>
              </div>

              <div className="pl-alliance-teams">
                {a.captain != null ? (
                  <span className="pl-captain">{a.captain}</span>
                ) : (
                  <span className="pl-captain empty">no captain</span>
                )}
                {a.picks.map((p) => (
                  <button
                    key={p}
                    className="pl-pick"
                    title="Remove from this alliance"
                    onClick={() => onRemovePick(i, p)}
                  >
                    {p}
                  </button>
                ))}
              </div>

              <div className="pl-alliance-foot">
                <span className="pl-alliance-depth">
                  {strengths[i] > 0 ? depthLabel(seed, Math.max(filled, 1)) : '—'}
                </span>
                <span className="pl-alliance-strength">{fmtPts(strengths[i])} pts</span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="pl-card">
        <div className="pl-card-head">
          <span className="pl-card-label">Still on the board</span>
          <span className="pl-card-hint">
            {onTheClock >= 0
              ? `tap to log a pick for alliance ${onTheClock + 1}`
              : 'all alliances are full'}
          </span>
        </div>
        <div className="pl-pool">
          {pool.length === 0 && <span className="pl-card-hint">Nobody left on the board.</span>}
          {pool.map((team) => {
            const m = metricsFor(team);
            if (!m) return null;
            return (
              <button
                key={team}
                className="pl-pool-chip"
                disabled={onTheClock < 0}
                title={`${fmtPts(m.adjMean)} pts avg · ${m.matchesPlayed} scouted`}
                onClick={() => onAddToClock(team)}
              >
                <span className="pl-dot" style={{ background: colorFor(m, fieldMedian) }} />
                <span className="pl-pool-team">{team}</span>
                <span className="pl-pool-mean">{fmtPts(m.adjMean)}</span>
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}
