import { AllianceSlot } from '../../services/picklistService';
import { TeamMetrics, projectAlliance, winProbability } from '../../utils/teamMetrics';

interface OurAllianceProps {
  board: AllianceSlot[];
  metricsFor: (team: number) => TeamMetrics | undefined;
  ourTeam: number;
}

export function OurAlliance({ board, metricsFor, ourTeam }: OurAllianceProps) {
  const membersOf = (a: AllianceSlot) =>
    [a.captain, ...a.picks]
      .filter((t): t is number => t != null)
      .map(metricsFor)
      .filter((m): m is TeamMetrics => !!m);

  const ourIdx = board.findIndex((a) =>
    [a.captain, ...a.picks].filter((t) => t != null).includes(ourTeam)
  );

  const projections = board.map((a) => {
    const members = membersOf(a);
    return members.length ? projectAlliance(members) : null;
  });

  const ours = ourIdx >= 0 ? projections[ourIdx] : null;

  let seed = 0;
  let winProb = 0;
  if (ours) {
    const strengths = projections.map((p) => p?.pts ?? 0);
    seed = [...strengths].sort((a, b) => b - a).indexOf(ours.pts) + 1;

    const others = projections.filter((p, i) => p && i !== ourIdx) as ReturnType<
      typeof projectAlliance
    >[];
    winProb = others.length
      ? Math.round(
          others.reduce((s, o) => s + winProbability(ours, o), 0) / others.length
        )
      : 0;
  }

  const depth =
    seed === 0
      ? ''
      : seed <= 2
      ? 'title contender'
      : seed <= 4
      ? 'deep run'
      : seed <= 6
      ? 'winnable bracket'
      : 'needs an upset';

  return (
    <div className="pl-dark-card">
      <span className="pl-card-label">Our alliance right now</span>

      {ours ? (
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12 }}>
          <span className="pl-big-num">{ours.pts}</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, paddingBottom: 5 }}>
            <span style={{ fontSize: 11, fontWeight: 700 }}>
              strength seed {seed} of 8
            </span>
            <span
              style={{ fontSize: 10.5, fontWeight: 500, color: 'rgba(255,255,255,.7)' }}
            >
              {depth} · {winProb}% average win odds vs the other seven
            </span>
          </div>
        </div>
      ) : (
        <span
          style={{
            fontSize: 11.5,
            fontWeight: 500,
            color: 'rgba(255,255,255,.75)',
            lineHeight: 1.45,
          }}
        >
          {ourTeam} is not a projected captain and has not been picked yet. Assign us to an
          alliance on the board to see strength, seed, and win odds.
        </span>
      )}

      <div className="pl-rule" />

      <p className="pl-note-light">
        Playoffs run as a double-elimination bracket, so one loss still leaves a route through the
        lower bracket. A trio that reliably wins two of three is worth more than one that
        occasionally wins big. Depth labels read off strength seed, not announcement order.
      </p>
    </div>
  );
}
