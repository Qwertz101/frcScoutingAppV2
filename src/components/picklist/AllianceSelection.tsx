import { useMemo, useState } from 'react';
import { ScoutData } from '../scout/useScoutData';
import { PicklistState } from '../scout/usePicklistState';
import { editAllianceSeat } from '../../services/allianceBoard';
import {
  Scenario,
  acceptScenario,
  allianceScore,
  declineScenario,
  deriveCaptains,
  seatedMap,
} from './allianceModel';
import { useAllianceContext } from './roles';
import './allianceSelection.css';

interface AllianceSelectionProps {
  data: ScoutData;
  pick: PicklistState;
}

/** Under this many points the two options are not meaningfully different. */
const COIN_FLIP = 10;

/** Seats in an alliance, in the order the board shows them. */
const SEATS = ['capt', '1st', '2nd'] as const;

/**
 * Alliance selection, live in the arena.
 *
 * Log each pick as it is announced and everything else re-derives: captains
 * promote when one gets drafted, saved branches strike through as their teams
 * disappear, and every open offer is re-scored as accept-versus-decline with
 * both sides projected as full three-robot alliances.
 *
 * The layout is the "arena display" — a dark board shaped like the field
 * projection, so the laptop matches the room. Two ways in: tap a robot in
 * AVAILABLE TEAMS to seat it with whichever alliance is on the clock, or type
 * a team number straight into a board cell when the announcement outruns you.
 */
export function AllianceSelection({ data, pick }: AllianceSelectionProps) {
  const { metricsFor, rankedTeams } = data;
  const ctx = useAllianceContext(data);
  const {
    board,
    setBoard,
    branches,
    setBranches,
    ourTeam,
    setOurTeam,
    resetBoard,
  } = pick;

  /** The accept/decline call is opt-in: during a fast draft it is noise. */
  const [showCall, setShowCall] = useState(true);
  /** Cell being typed into, so a half-typed number is not fought by re-renders. */
  const [editing, setEditing] = useState<{ key: string; value: string } | null>(null);
  /** A typed value the board refused, so the cell can say why. */
  const [rejected, setRejected] = useState<{ key: string; text: string } | null>(null);

  /** Ranking restricted to robots we actually have numbers for. */
  const ranked = useMemo(
    () => rankedTeams.filter((t) => metricsFor(t)?.hasData || metricsFor(t)?.matchesScheduled),
    [rankedTeams, metricsFor]
  );

  const seated = useMemo(() => seatedMap(board), [board]);
  const captains = useMemo(() => deriveCaptains(board, ranked), [board, ranked]);

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

  /** Robots still on the table, best first. */
  const available = useMemo(() => ranked.filter((t) => !seated[t]), [ranked, seated]);

  /**
   * Teams offerable in the "scouting for" picker.
   *
   * `ourTeam` is included even when it is not in `ranked`, which happens
   * whenever we have no scouting data for our own robot at this event. Without
   * it the `<select>` has no option matching its value and silently falls back
   * to displaying the first — the header said "our team 6560" while the picker
   * read "#1 · 581", which reads as though the pose had been changed.
   */
  const poseOptions = useMemo(
    () => (ranked.includes(ourTeam) ? ranked : [ourTeam, ...ranked]),
    [ranked, ourTeam]
  );

  /**
   * Which alliance is on the clock, counting derived captains.
   *
   * The shared hook's `onTheClock` only counts a captain that has been written
   * to the board, but this screen shows the eight captains the ranking implies
   * before anyone types anything — so on a fresh board it reported "nobody",
   * and tapping a robot did nothing at all. Round 1 runs A1 → A8 and round 2
   * runs A8 → A1 (manual §10.6.1), same as the hook.
   */
  const effectiveClock = useMemo(() => {
    const capOf = (i: number) => board[i].captain ?? captains[i];
    for (let i = 0; i < board.length; i++) {
      if (capOf(i) != null && board[i].picks.length === 0) return i;
    }
    for (let i = board.length - 1; i >= 0; i--) {
      if (capOf(i) != null && board[i].picks.length === 1) return i;
    }
    return -1;
  }, [board, captains]);

  /**
   * Write one seat directly.
   *
   * `assignTo` in the shared hook appends to `picks`, which is right for the
   * "picked by A3" button it was built for but wrong for a grid whose three
   * cells are addressed individually — typing into the 2nd-pick cell of an
   * alliance with no 1st pick would land in the 1st. This addresses the seat
   * the operator actually clicked, and clears the team from anywhere else
   * first so a mis-keyed number is corrected by retyping it in the right box.
   */
  const setSeat = (allianceIdx: number, seat: number, team: number | null) => {
    const current = seat === 0 ? board[allianceIdx].captain : board[allianceIdx].picks[seat - 1];
    if (current === team) return;
    const next = editAllianceSeat(board, captains, allianceIdx, seat, team);
    if (next === board && team != null) {
      setRejected({ key: allianceIdx + ':' + seat, text: 'Fill the first pick before the second; choose a team other than the captain.' });
      return;
    }
    setBoard(next);
  };

  const undoLast = pick.undoBoard;

  /** Move a 2nd-pick option to the front of its branch's order. */
  const promoteSecond = (branchId: number, team: number) =>
    setBranches(
      branches.map((b) =>
        b.id === branchId ? { ...b, seconds: [team, ...b.seconds.filter((s) => s !== team)] } : b
      )
    );

  /**
   * Commit a typed cell, refusing a team that is not at this event.
   *
   * A board cell takes free text, so a mistyped digit could seat a robot that
   * does not exist here -- 9733 for 973 -- and nothing downstream could tell
   * it from a real pick. It has no metrics, so it scores zero: it quietly drags
   * that alliance's projection down and holds a seat the real robot should be
   * in. `metricsFor` is the event's own roster, so anything it does not know is
   * a typo. `ourTeam` is allowed through because the whole screen is written
   * from its point of view and it is legitimately absent from an event we are
   * only modelling.
   */
  const commitCell = (allianceIdx: number, seat: number, raw: string, key: string) => {
    const trimmed = raw.trim();
    if (!trimmed) {
      setSeat(allianceIdx, seat, null);
      setRejected(null);
      return;
    }
    const team = Number(trimmed);
    if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(team) || team <= 0) {
      setRejected({ key, text: `"${trimmed}" is not a team number` });
      return;
    }
    if (!metricsFor(team) && team !== ourTeam) {
      setRejected({ key, text: `${team} is not at this event — check the number` });
      return;
    }
    setRejected(null);
    setSeat(allianceIdx, seat, team);
  };

  const roster = (n: number): number[] => {
    const slot = board[n - 1];
    const cap = slot.captain ?? captains[n - 1];
    return cap != null ? [cap, ...slot.picks] : [];
  };

  const liveBranches = branches.filter(
    (b) =>
      !(b.first != null && seated[b.first]) &&
      !(b.seconds.length > 0 && b.seconds.every((s) => seated[s]))
  ).length;

  /* Where we land if we turn everything down — the honest version of the
     design's "odds we captain", which nothing here can compute as a real
     probability. This is a full draft projection, so it is a fact about the
     current board rather than a guess. */
  const base = scenarios.base;
  const fallback = base ? `A${base.n}` : '—';
  const fallbackNote = base ? (base.asCaptain ? 'as captain' : 'as a pick') : 'outside the top 8';

  return (
    <div className="pl-body as-wrap">
      <div className="pl-title-row">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <span className="pl-eyebrow">Step 3 — live in the arena</span>
          <h1 className="pl-h1">ALLIANCE SELECTION</h1>
        </div>
        <span className="pl-as-live">
          {liveBranches} of {branches.length} branch{branches.length === 1 ? '' : 'es'} still live
        </span>
      </div>

      <div className="as-panel">
        {/* ---------------- header strip ---------------- */}
        <div className="as-top">
          <span className="as-kicker">Scouting for</span>
          <select
            className="as-select"
            value={String(ourTeam)}
            onChange={(e) => setOurTeam(Number(e.target.value))}
          >
            {poseOptions.map((t) => {
              const r = ranked.indexOf(t);
              return (
                <option key={t} value={String(t)}>
                  {r >= 0 ? `#${r + 1} · ${t}` : `${t} · no data here`}
                </option>
              );
            })}
          </select>

          <span className="as-spacer" />

          <div className="as-stat">
            <span className="as-stat-label">If we decline · {fallbackNote}</span>
            <span className="as-stat-value">{fallback}</span>
          </div>

          <button
            className={`as-toggle${showCall ? ' on' : ''}`}
            onClick={() => setShowCall((v) => !v)}
          >
            {showCall ? 'Call on' : 'Call off'}
          </button>
          <button className="as-undo" onClick={resetBoard}>
            Reset
          </button>
        </div>

        {/* ---------------- available / board ---------------- */}
        <div className="as-split">
          <div className="as-col">
            <span className="as-h">AVAILABLE TEAMS</span>
            <div className="as-pool">
              {available.map((t) => {
                const idx = ranked.indexOf(t);
                return (
                  <button
                    key={t}
                    className={`as-chip${t === ourTeam ? ' ours' : ''}${
                      idx < 8 ? ' captainly' : ''
                    }`}
                    onClick={() =>
                      effectiveClock >= 0 && (() => {
                        const captainIndex = captains.indexOf(t);
                        if (captainIndex >= 0 && (captainIndex <= effectiveClock || board[captainIndex].picks.length > 0)) {
                          setRejected({ key: 'pool', text: t + ' is not available to this alliance.' });
                          return;
                        }
                        setRejected(null);
                        setSeat(effectiveClock, board[effectiveClock].picks.length + 1, t);
                      })()
                    }
                    disabled={effectiveClock < 0}
                    title={
                      effectiveClock < 0
                        ? 'Every alliance is full — nothing left on the clock'
                        : `Seat ${t} with A${effectiveClock + 1}`
                    }
                  >
                    <span className="as-chip-idx">{idx + 1}</span>
                    <span className="as-chip-team">{t}</span>
                  </button>
                );
              })}
            </div>
            <span className="as-hint">
              {available.length} robots unpicked ·{' '}
              {effectiveClock >= 0
                ? `tap one to seat it with A${effectiveClock + 1}, on the clock`
                : 'every alliance is full'}
            </span>
          </div>

          <div className="as-col">
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span className="as-h">ALLIANCES</span>
              <span className="as-spacer" />
              <button className="as-undo" onClick={undoLast} title="Undo last pick">
                Undo
              </button>
            </div>

            <div className="as-board-head">
              <span />
              {SEATS.map((s) => (
                <span key={s}>{s}</span>
              ))}
              <span>{showCall ? 'yes/no' : ''}</span>
            </div>

            <div className="as-rows">
              {Array.from({ length: 8 }, (_, i) => {
                const n = i + 1;
                const slot = board[i];
                const members = roster(n);
                const isOffer = scenarios.offer[i];
                const a = scenarios.accept[n];
                const d = scenarios.decline[n];
                const gap = a && d ? a.ev - d.ev : null;
                const verdict =
                  !isOffer || !a
                    ? ''
                    : gap == null
                      ? 'YES'
                      : Math.abs(gap) < COIN_FLIP
                        ? '?'
                        : gap > 0
                          ? 'YES'
                          : 'NO';
                const callColor =
                  verdict === 'YES'
                    ? 'var(--cyan-500, #00baff)'
                    : verdict === 'NO'
                      ? '#ff8f6b'
                      : '#a9bcc4';

                return (
                  <div className="as-row" key={n}>
                    <span
                      className={`as-num${members.includes(ourTeam) ? ' ours' : ''}${
                        effectiveClock === i ? ' clock' : ''
                      }`}
                      title={effectiveClock === i ? 'On the clock' : undefined}
                    >
                      {n}
                    </span>

                    {SEATS.map((_, seat) => {
                      const explicit = seat === 0 ? slot.captain : slot.picks[seat - 1];
                      const derived = seat === 0 ? captains[i] : null;
                      const key = `${i}:${seat}`;
                      const isEditing = editing?.key === key;
                      const shown = isEditing
                        ? editing.value
                        : explicit != null
                          ? String(explicit)
                          : '';
                      return (
                        <input
                          key={seat}
                          className={`as-cell${explicit === ourTeam ? ' ours' : ''}${
                            explicit == null && derived != null ? ' derived' : ''
                          }${rejected?.key === key ? ' bad' : ''}`}
                          inputMode="numeric"
                          value={shown}
                          placeholder={explicit == null && derived != null ? String(derived) : '—'}
                          title={
                            explicit == null && derived != null
                              ? `${derived} is the derived captain — type to confirm or override`
                              : undefined
                          }
                          onChange={(e) => {
                            if (rejected?.key === key) setRejected(null);
                            setEditing({ key, value: e.target.value });
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              (e.target as HTMLInputElement).blur();
                            } else if (e.key === 'Escape') {
                              setEditing(null);
                            }
                          }}
                          onBlur={(e) => {
                            if (isEditing) commitCell(i, seat, e.target.value, key);
                            setEditing(null);
                          }}
                        />
                      );
                    })}

                    <span className="as-call">
                      {showCall && verdict ? (
                        <>
                          <span className="as-call-delta" style={{ color: callColor }}>
                            {gap == null ? '—' : `${gap > 0 ? '+' : ''}${gap}`}
                          </span>
                          <span className="as-call-word" style={{ color: callColor }}>
                            {verdict === '?' ? 'toss-up' : verdict}
                          </span>
                        </>
                      ) : null}
                    </span>
                  </div>
                );
              })}
            </div>

            {rejected && <span className="as-reject">{rejected.text}</span>}
          </div>
        </div>

        <div className="as-rule" />

        {/* ---------------- pick tree ---------------- */}
        <div className="as-tree">
          <div className="as-tree-head">
            <span className="as-h">PICK TREE</span>
            <span className="as-tree-note">
              If {ourTeam} captains — first pick, then second picks in order
            </span>
            <span className="as-spacer" />
            <span className="as-tree-aside">
              Built on the Picklist page — reorder or drop them here
            </span>
          </div>

          {branches.length === 0 && (
            <span className="as-empty">No branches yet — build them on the Picklist page.</span>
          )}

          <div className="as-branches">
            {branches.map((br) => {
              const firstM = br.first != null ? metricsFor(br.first) : undefined;
              const gone = br.first != null ? seated[br.first] : undefined;
              const allSecondsGone = br.seconds.length > 0 && br.seconds.every((s) => seated[s]);
              const dead = !!gone || allSecondsGone;
              const bestLive = br.seconds.find((s) => !seated[s]);

              const vecTeams = [ourTeam, br.first, bestLive].filter(
                (t): t is number => t != null
              );
              const vec = vecTeams.map((t) => {
                const m = metricsFor(t);
                return {
                  team: t,
                  auto: m ? Math.round(m.autoAvg) : 0,
                  tele: m ? Math.round(m.teleopAvg) : 0,
                  end: m ? Math.round(m.towerAvg) : 0,
                  def: m ? m.defenseAvg : 0,
                  hasData: !!m?.hasData,
                };
              });
              const colAuto = vec.reduce((s, v) => s + v.auto, 0);
              const colTele = vec.reduce((s, v) => s + v.tele, 0);
              const colEnd = vec.reduce((s, v) => s + v.end, 0);
              const colDef = vec.length
                ? (vec.reduce((s, v) => s + v.def, 0) / vec.length).toFixed(1)
                : '0.0';

              const total =
                br.first != null && !gone && bestLive != null
                  ? Math.round(allianceScore([ourTeam, br.first, bestLive], ctx))
                  : null;

              /* Auto plan, stated from the numbers rather than asserted: who
                 actually puts points up before teleop. */
              const autoLine = vec.length
                ? vec.map((v) => `${v.team} ${v.hasData ? v.auto : '?'}`).join(' · ') +
                  ' pts in auto'
                : 'no teams to plan with yet';

              return (
                <div className={`as-branch${dead ? ' dead' : ''}`} key={br.id}>
                  <div className="as-branch-top">
                    <div className="as-branch-id">
                      <span className="as-mini">1st pick</span>
                      <span className={`as-branch-team${gone ? ' struck' : ''}`}>
                        {br.first ?? '—'}
                      </span>
                      <span className="as-branch-sub">
                        {firstM?.hasData ? `${Math.round(firstM.adjMean)} avg pts` : 'unscouted'}
                      </span>
                    </div>
                    <span className="as-spacer" />
                    <div className="as-branch-right">
                      <span className={`as-status ${dead ? 'gone' : 'live'}`}>
                        {gone ? `gone · A${gone}` : allSecondsGone ? 'seconds gone' : 'live'}
                      </span>
                      <button
                        className="as-del"
                        title="Delete branch"
                        onClick={() => pick.removeBranch(br.id)}
                      >
                        ×
                      </button>
                    </div>
                  </div>

                  <div className="as-seconds">
                    <span className="as-mini">2nd pick order</span>
                    <div className="as-seconds-row">
                      {br.seconds.map((s) => {
                        const taken = seated[s];
                        return (
                          <button
                            key={s}
                            className={`as-second${taken ? ' taken' : ''}${
                              s === bestLive ? ' next' : ''
                            }`}
                            title={taken ? `Taken by A${taken}` : 'Move to front'}
                            disabled={!!taken}
                            onClick={() => promoteSecond(br.id, s)}
                          >
                            {s}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="as-vec">
                    <div className="as-vec-names">
                      {vec.map((v) => (
                        <span
                          key={v.team}
                          className={`as-vec-name${v.team === ourTeam ? ' ours' : ''}`}
                        >
                          {v.team}
                        </span>
                      ))}
                    </div>

                    <div className="as-vec-col">
                      <span className="as-vec-cap" style={{ color: 'var(--cyan-500, #00baff)' }}>
                        auto
                      </span>
                      <div className="as-vec-stack">
                        {vec.map((v) => (
                          <span className="as-vec-val" key={v.team}>
                            {v.auto}
                          </span>
                        ))}
                      </div>
                    </div>

                    <div className="as-op">
                      <span className="as-op-pad">.</span>
                      <span className="as-op-sign">+</span>
                    </div>

                    <div className="as-vec-col">
                      <span className="as-vec-cap" style={{ color: 'var(--blue-600, #1179ee)' }}>
                        tele
                      </span>
                      <div className="as-vec-stack">
                        {vec.map((v) => (
                          <span className="as-vec-val" key={v.team}>
                            {v.tele}
                          </span>
                        ))}
                      </div>
                    </div>

                    <div className="as-op">
                      <span className="as-op-pad">.</span>
                      <span className="as-op-sign">+</span>
                    </div>

                    <div className="as-vec-col">
                      <span className="as-vec-cap" style={{ color: 'var(--blue-600, #1179ee)' }}>
                        climb
                      </span>
                      <div className="as-vec-stack">
                        {vec.map((v) => (
                          <span className="as-vec-val" key={v.team}>
                            {v.end}
                          </span>
                        ))}
                      </div>
                    </div>

                    <div className="as-op">
                      <span className="as-op-pad">.</span>
                      <span className="as-op-sign">=</span>
                    </div>

                    <div className="as-total">
                      <span className="as-total-val">{total ?? '—'}</span>
                      <span className="as-total-label">alliance</span>
                    </div>
                  </div>

                  <div className="as-cols">
                    <span style={{ color: 'var(--cyan-500, #00baff)' }}>auto {colAuto}</span>
                    <span style={{ color: 'var(--blue-600, #1179ee)' }}>teleop {colTele}</span>
                    <span style={{ color: 'var(--blue-600, #1179ee)' }}>climb {colEnd}</span>
                    <span style={{ color: 'var(--teal-500, #33becc)' }}>defense {colDef}</span>
                  </div>

                  <div className="as-auto-plan">
                    <span className="as-mini">Auto plan</span>
                    <span className="as-auto-line">{autoLine}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <p className="pl-note" style={{ margin: 0 }}>
        The yes/no column is a full three-robot projection on both sides: accept means {ourTeam}{' '}
        takes that offer and the rest of the draft plays out around it; decline means {ourTeam}{' '}
        stays on the board and lands wherever the remaining picks put it
        {base ? `, currently A${base.n}` : ''}. Treat gaps under about {COIN_FLIP} points as a coin
        flip.
      </p>
    </div>
  );
}
