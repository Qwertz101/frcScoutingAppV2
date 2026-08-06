import { AllianceSlot } from '../../services/picklistService';
import { TeamMetrics, projectAlliance } from '../../utils/teamMetrics';

interface ProjectedAllianceProps {
  board: AllianceSlot[];
  metricsFor: (team: number) => TeamMetrics | undefined;
  ourTeam: number;
  /** Top of the points axis — scaled from the strongest alliance on the board. */
  scaleMax: number;
}

export function ProjectedAlliance({
  board,
  metricsFor,
  ourTeam,
  scaleMax,
}: ProjectedAllianceProps) {
  const ourIdx = board.findIndex((a) =>
    [a.captain, ...a.picks].filter((t) => t != null).includes(ourTeam)
  );

  const roster =
    ourIdx >= 0
      ? [board[ourIdx].captain, ...board[ourIdx].picks].filter((t): t is number => t != null)
      : [];

  const members = roster
    .map(metricsFor)
    .filter((m): m is TeamMetrics => !!m);

  const proj = members.length ? projectAlliance(members) : null;
  const starters = new Set(proj?.lineup.map((t) => t.teamNumber) ?? []);

  const pct = (v: number) => `${Math.min(100, Math.max(0, (v / scaleMax) * 100)).toFixed(1)}%`;

  return (
    <div className="pl-projected">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span className="pl-card-label" style={{ color: 'var(--teal-500)' }}>
          Projected alliance
        </span>
        <div className="pl-roster">
          {roster.length === 0 && <span className="pl-card-hint">Not on an alliance yet.</span>}
          {roster.map((t) => (
            <span
              key={t}
              className={`pl-roster-team${starters.has(t) ? '' : ' backup'}`}
              title={starters.has(t) ? 'Starter' : 'Depth — not counted in the total'}
            >
              {t}
            </span>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10 }}>
        <span className="pl-gradient-num">{proj?.pts ?? 0}</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1, paddingBottom: 6 }}>
          <span style={{ fontSize: 11, fontWeight: 700 }}>
            match points {proj ? `±${proj.sd}` : ''}
          </span>
          <span style={{ fontSize: 10.5, fontWeight: 500, color: 'var(--text-muted)' }}>
            floor {proj?.floor ?? 0} · ceiling {proj?.ceiling ?? 0}
          </span>
        </div>
      </div>

      <div>
        <div className="pl-range">
          <div className="pl-range-track" />
          {proj && (
            <>
              <div
                className="pl-range-band"
                style={{ left: pct(proj.floor), width: pct(proj.ceiling - proj.floor) }}
              />
              <div className="pl-range-whisker" style={{ left: pct(proj.floor) }} />
              <div className="pl-range-whisker" style={{ left: pct(proj.ceiling) }} />
              <div className="pl-range-marker" style={{ left: pct(proj.pts) }} />
            </>
          )}
        </div>
        <div className="pl-range-scale">
          <span>0</span>
          <span>{Math.round(scaleMax)} pts</span>
        </div>
      </div>

      <p className="pl-note">
        Three robots play at a time, so totals above are{' '}
        <strong>{proj ? proj.lineup.map((t) => t.team).join(' + ') : '—'}</strong>
        {roster.length > 3 ? ' · the remaining team is depth, not counted' : ''}. Projected fuel{' '}
        {proj?.fuel ?? 0} pts, tower {proj?.tower ?? 0} pts. Playoffs award no ranking points — pick
        for match points, not RP thresholds.
      </p>
    </div>
  );
}
