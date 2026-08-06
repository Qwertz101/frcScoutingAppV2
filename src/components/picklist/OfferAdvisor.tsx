import { AllianceSlot } from '../../services/picklistService';
import { TeamMetrics, projectAlliance } from '../../utils/teamMetrics';

interface OfferAdvisorProps {
  board: AllianceSlot[];
  metricsFor: (team: number) => TeamMetrics | undefined;
  ourTeam: number;
}

/**
 * "If they pick us" — for every alliance that still has an open slot and
 * hasn't taken us, what would our alliance look like if they called our number.
 */
export function OfferAdvisor({ board, metricsFor, ourTeam }: OfferAdvisorProps) {
  const us = metricsFor(ourTeam);

  const membersOf = (a: AllianceSlot) =>
    [a.captain, ...a.picks]
      .filter((t): t is number => t != null)
      .map(metricsFor)
      .filter((m): m is TeamMetrics => !!m);

  const alreadyPlaced = board.some((a) =>
    [a.captain, ...a.picks].filter((t) => t != null).includes(ourTeam)
  );

  const offers = board
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => a.captain != null && a.picks.length < 2 && a.captain !== ourTeam)
    .filter(({ a }) => !a.picks.includes(ourTeam))
    .map(({ a, i }) => {
      const current = membersOf(a);
      const withUs = us ? projectAlliance([...current, us]) : projectAlliance(current);
      return { idx: i, cap: a.captain as number, withUs, current: projectAlliance(current) };
    })
    .sort((x, y) => y.withUs.pts - x.withUs.pts);

  const best = offers.length ? offers[0].withUs.pts : 0;

  const recFor = (pts: number) => {
    if (!best) return { label: 'unknown', bg: 'var(--border-strong)' };
    const ratio = pts / best;
    if (ratio >= 0.97) return { label: 'accept', bg: '#00baff' };
    if (ratio >= 0.88) return { label: 'strong', bg: '#1179ee' };
    if (ratio >= 0.75) return { label: 'consider', bg: '#33becc' };
    return { label: 'weakest', bg: '#000' };
  };

  return (
    <div className="pl-card">
      <div className="pl-card-head" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
        <span className="pl-card-label">If they pick us</span>
        <span className="pl-card-hint">
          {alreadyPlaced
            ? `${ourTeam} is already on a alliance — these are the alternatives.`
            : offers.length
            ? 'Projected trio strength if each captain calls our number.'
            : 'Seed the captains to see offers.'}
        </span>
      </div>

      {offers.length === 0 && (
        <div className="pl-empty">No alliance has an open slot right now.</div>
      )}

      {offers.map((o) => {
        const rec = recFor(o.withUs.pts);
        const gain = o.withUs.pts - o.current.pts;
        return (
          <div key={o.idx} className="pl-offer">
            <span className="pl-offer-cap">{o.cap}</span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
              <span style={{ fontSize: 11, fontWeight: 700 }}>
                Alliance {o.idx + 1} · {o.withUs.pts} pts with us
              </span>
              <span className="pl-offer-why">
                We add {gain > 0 ? `${gain} pts` : 'depth'} to their lineup · floor{' '}
                {o.withUs.floor} / ceiling {o.withUs.ceiling}
                {o.withUs.lineup.length > 3 ? ' · we would be depth, not a starter' : ''}
              </span>
            </div>
            <span className="pl-rec" style={{ background: rec.bg }}>
              {rec.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
