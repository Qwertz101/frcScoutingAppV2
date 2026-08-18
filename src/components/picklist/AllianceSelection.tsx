import { useMemo, useState } from 'react';
import { ScoutData } from '../scout/useScoutData';
import { PicklistState } from '../scout/usePicklistState';
import {
  Scenario,
  acceptScenario,
  allianceScore,
  declineScenario,
  deriveCaptains,
  seatedMap,
} from './allianceModel';
import { useAllianceContext } from './roles';
import { useTeamPhotos } from './useTeamPhotos';

interface AllianceSelectionProps {
  data: ScoutData;
  pick: PicklistState;
}

/** Under this many points the two options are not meaningfully different. */
const COIN_FLIP = 10;

/**
 * Alliance selection, live in the arena.
 *
 * Log each pick as it is announced and everything else re-derives: captains
 * promote when one gets drafted, saved branches strike through as their teams
 * disappear, and every open offer is re-scored as accept-versus-decline with
 * both sides projected as full three-robot alliances.
 */
export function AllianceSelection({ data, pick }: AllianceSelectionProps) {
  const { metricsFor, rankedTeams } = data;
  const ctx = useAllianceContext(data);
  const { board, branches, ourTeam, markTeam, setMarkTeam, assignTo, unassign, resetBoard } = pick;

  const [showWhy, setShowWhy] = useState<number | null>(null);

  /** Ranking restricted to robots we actually have numbers for. */
  const ranked = useMemo(
    () => rankedTeams.filter((t) => metricsFor(t)?.hasData || metricsFor(t)?.matchesScheduled),
    [rankedTeams, metricsFor]
  );

  const seated = useMemo(() => seatedMap(board), [board]);
  const captains = useMemo(() => deriveCaptains(board, ranked), [board, ranked]);
  const photos = useTeamPhotos(
    useMemo(() => branches.map((b) => b.first).filter((t): t is number => t != null), [branches])
  );

  const ourRankIdx = ranked.indexOf(ourTeam);

  /**
   * One decline projection for the whole screen plus one per open offer.
   * Each is a full draft simulation, so they are memoised together on the
   * board — re-running eight of them on every render would be visible.
   */
  const scenarios = useMemo(() => {
    const accept: Record<number, Scenario> = {};
    const decline: Record<number, Scenario | null> = {};
    const offer: boolean[] = [];

    for (let n = 1; n <= 8; n++) {
      const cap = captains[n - 1];
      const roster = board[n - 1];
      const size = (roster.captain != null ? 1 : 0) + roster.picks.length;
      const open =
        cap != null &&
        cap !== ourTeam &&
        ourRankIdx >= 0 &&
        ranked.indexOf(cap) < ourRankIdx &&
        size < 3 &&
        !seated[ourTeam];
      offer[n - 1] = open;
      if (!open) continue;
      accept[n] = acceptScenario(n, board, ranked, ourTeam, ctx);
      decline[n] = declineScenario(n, board, ranked, ourTeam, ctx);
    }
    return {
      accept,
      decline,
      offer,
      base: declineScenario(null, board, ranked, ourTeam, ctx),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board, ranked, ourTeam, ctx, captains]);

  const liveBranches = branches.filter(
    (b) => !(b.first != null && seated[b.first]) && !(b.seconds.length > 0 && b.seconds.every((s) => seated[s]))
  ).length;

  const roster = (n: number): number[] => {
    const slot = board[n - 1];
    const cap = slot.captain ?? captains[n - 1];
    return cap != null ? [cap, ...slot.picks] : [];
  };

  const assignTarget = markTeam ?? ourTeam;

  return (
    <div className="pl-body">
      <div className="pl-title-row">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <span className="pl-eyebrow">Step 3 — live in the arena</span>
          <h1 className="pl-h1">ALLIANCE SELECTION</h1>
        </div>
        <span className="pl-as-live">
          {liveBranches} of {branches.length} branch{branches.length === 1 ? '' : 'es'} still live
        </span>
      </div>

      <div className="pl-card pl-as-card">
        <div className="pl-as-head">
          <span className="pl-card-label">Alliance board</span>
          <span className="pl-header-spacer" />
          <span className="pl-as-pose">
            Deciding for <b>{ourTeam}</b>
            {ourRankIdx >= 0 ? ` · rank #${ourRankIdx + 1}` : ' · not in this field'}
          </span>
          <button className="pl-pill-btn" onClick={resetBoard}>
            Reset board
          </button>
        </div>

        <div className="pl-as-board">
          {Array.from({ length: 8 }, (_, i) => {
            const n = i + 1;
            const members = roster(n);
            const isOffer = scenarios.offer[i];
            const a = scenarios.accept[n];
            const d = scenarios.decline[n];
            const gap = a && d ? a.ev - d.ev : null;
            const verdict =
              !isOffer || !a ? '' : gap == null ? 'YES' : Math.abs(gap) < COIN_FLIP ? '?' : gap > 0 ? 'YES' : 'NO';
            const total = members
              .map(metricsFor)
              .filter((m) => m)
              .reduce((s, m) => s + (m?.median ?? 0), 0);

            return (
              <div
                key={n}
                className={`pl-as-slotcard${members.includes(ourTeam) ? ' ours' : ''}${
                  members.length >= 3 ? ' full' : ''
                }`}
              >
                <div className="pl-as-slot-head">
                  <span className="pl-as-slot-num">A{n}</span>
                  {verdict && (
                    <span className={`pl-as-verdict v${verdict === 'YES' ? 'yes' : verdict === 'NO' ? 'no' : 'maybe'}`}>
                      {verdict === '?' ? 'TOSS-UP' : verdict}
                    </span>
                  )}
                </div>

                {['captain', '1st pick', '2nd pick'].map((role, k) => {
                  const team = members[k];
                  return (
                    <button
                      key={role}
                      className={`pl-as-seat${team == null ? ' empty' : ''}${
                        team === ourTeam ? ' ours' : ''
                      }${k === 0 && team != null ? ' captain' : ''}`}
                      onClick={() => team != null && setMarkTeam(team)}
                      title={team != null ? `Select ${team} for assignment` : 'Not picked yet'}
                    >
                      <span className="pl-as-seat-role">{role}</span>
                      <span className="pl-as-seat-team">{team ?? '—'}</span>
                    </button>
                  );
                })}

                <span className="pl-as-total">{total ? `${Math.round(total)} med` : '—'}</span>

                {isOffer && a && (
                  <div className="pl-as-ev">
                    <div className="pl-as-ev-row">
                      <span>Accept</span>
                      <b style={{ color: 'var(--blue-600)' }}>{a.ev}</b>
                    </div>
                    <span className="pl-as-ev-roster">{a.roster.join(' · ')}</span>
                    <div className="pl-as-ev-row">
                      <span>Decline</span>
                      <b style={{ color: 'var(--teal-500)' }}>{d ? d.ev : '—'}</b>
                    </div>
                    <span className="pl-as-ev-roster">
                      {d
                        ? `A${d.n}${d.asCaptain ? ' as captain: ' : ': '}${d.roster.join(' · ')}`
                        : 'goes unpicked'}
                    </span>
                    <button className="pl-as-why" onClick={() => setShowWhy(showWhy === n ? null : n)}>
                      {showWhy === n ? 'hide' : 'why?'}
                    </button>
                    {showWhy === n && (
                      <p className="pl-as-why-text">
                        {!d
                          ? `Declining leaves ${ourTeam} outside the top 8 — take the offer.`
                          : gap != null && gap >= 0
                            ? `Worth ${gap} more than ${
                                d.asCaptain ? `captaining A${d.n}` : `being A${d.n}'s pick`
                              } with ${d.picks.join(' + ') || 'nobody left'}.`
                            : `${d.asCaptain ? `Captaining A${d.n}` : `Going to A${d.n}`} with ${
                                d.picks.join(' + ') || 'nobody left'
                              } scores ${Math.abs(gap ?? 0)} more.`}
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="pl-as-assign">
          <span className="pl-card-label">Assign</span>
          <select
            className="pl-as-select"
            value={String(assignTarget)}
            onChange={(e) => setMarkTeam(Number(e.target.value))}
          >
            {ranked.map((t, i) => (
              <option key={t} value={String(t)}>
                #{i + 1} · {t}
                {t === ourTeam ? ' · us' : ''}
              </option>
            ))}
          </select>
          <span className="pl-as-assign-mid">picked by</span>
          <div className="pl-as-assign-btns">
            {Array.from({ length: 8 }, (_, i) => (
              <button
                key={i}
                className={`pl-as-assign-btn${roster(i + 1).includes(assignTarget) ? ' on' : ''}`}
                onClick={() => assignTo(i, assignTarget, captains[i])}
              >
                A{i + 1}
              </button>
            ))}
          </div>
          <button className="pl-pill-btn" onClick={() => unassign(assignTarget)}>
            Un-assign
          </button>
        </div>

        <p className="pl-note" style={{ margin: 0 }}>
          Accept and Decline are both full three-robot projections: accept means {ourTeam} takes
          that offer and the rest of the draft plays out around it; decline means {ourTeam} stays on
          the board and lands wherever the remaining picks put it
          {scenarios.base ? `, currently A${scenarios.base.n}` : ''}. Treat gaps under about{' '}
          {COIN_FLIP} points as a coin flip.
        </p>
      </div>

      <div className="pl-card pl-as-card">
        <span className="pl-card-label">Pick tree</span>
        {branches.length === 0 && (
          <p className="pl-empty" style={{ padding: 0 }}>
            No branches yet — build them on the Picklist page.
          </p>
        )}

        {branches.map((br) => {
          const first = br.first != null ? metricsFor(br.first) : undefined;
          const gone = br.first != null ? seated[br.first] : undefined;
          const allSecondsGone = br.seconds.length > 0 && br.seconds.every((s) => seated[s]);
          const dead = !!gone || allSecondsGone;
          const bestLive = br.seconds.find((s) => !seated[s]);
          const projected =
            br.first != null && !gone && bestLive != null
              ? Math.round(allianceScore([ourTeam, br.first, bestLive], ctx))
              : null;

          return (
            <div key={br.id} className={`pl-as-branch${dead ? ' dead' : ''}`}>
              <div className="pl-as-branch-head">
                <div className="pl-as-branch-photo">
                  {br.first != null && photos[br.first] ? (
                    <img src={photos[br.first]!} alt="" loading="lazy" />
                  ) : (
                    <span>{br.first ?? '—'}</span>
                  )}
                </div>
                <div className="pl-as-branch-id">
                  <span className="pl-as-branch-label">1st pick</span>
                  <span className={`pl-as-branch-team${gone ? ' struck' : ''}`}>{br.first}</span>
                  <span className="pl-as-branch-sub">
                    {first?.hasData ? `${Math.round(first.adjMean)} avg pts` : 'unscouted'}
                  </span>
                </div>
                <span className="pl-header-spacer" />
                {projected != null && (
                  <span className="pl-as-branch-proj">{projected} projected</span>
                )}
                {gone && <span className="pl-as-branch-gone">Gone · alliance {gone}</span>}
                <button
                  className="pl-as-branch-del"
                  title="Delete branch"
                  onClick={() => pick.removeBranch(br.id)}
                >
                  ×
                </button>
              </div>

              <div className="pl-as-branch-seconds">
                <span className="pl-as-branch-label">2nd pick order</span>
                {br.seconds.map((s, i) => {
                  const sg = seated[s];
                  return (
                    <span key={s} className={`pl-as-second${sg ? ' taken' : ''}`}>
                      <span className="pl-as-second-ord">#{i + 1}</span>
                      <span className={sg ? 'struck' : ''}>{s}</span>
                      {sg && <span className="pl-as-second-a">A{sg}</span>}
                    </span>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
