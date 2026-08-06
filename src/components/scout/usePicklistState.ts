import { useMemo, useRef, useState, useEffect } from 'react';
import {
  PicklistService,
  AllianceSlot,
  DnpEntry,
  TreeBranch,
  emptyBoard,
} from '../../services/picklistService';

/**
 * Alliance-selection state shared by the Picklist and Field Ranking tabs.
 *
 * Field Ranking's +/compare/x buttons and the Picklist's lists mutate the same
 * store, so this lives in the shell rather than in either screen. Every setter
 * writes straight through to localStorage so nothing is lost on reload.
 */
export function usePicklistState(rankedTeams: number[], ready: boolean) {
  const [ourTeam, setOurTeamState] = useState(() => PicklistService.getOurTeam());
  const [tier1, setTier1State] = useState<number[]>(() => PicklistService.getTier1());
  const [tier2, setTier2State] = useState<number[]>(() => PicklistService.getTier2());
  const [dnp, setDnpState] = useState<DnpEntry[]>(() => PicklistService.getDnp());
  const [board, setBoardState] = useState<AllianceSlot[]>(() => PicklistService.getBoard());
  const [branches, setBranchesState] = useState<TreeBranch[]>(() =>
    PicklistService.getBranches()
  );
  /** Teams selected for side-by-side comparison on the Team Analysis tab. */
  const [compare, setCompare] = useState<number[]>([]);

  const seeded = useRef(false);

  const setTier1 = (v: number[]) => { setTier1State(v); PicklistService.setTier1(v); };
  const setTier2 = (v: number[]) => { setTier2State(v); PicklistService.setTier2(v); };
  const setDnp = (v: DnpEntry[]) => { setDnpState(v); PicklistService.setDnp(v); };
  const setBoard = (v: AllianceSlot[]) => { setBoardState(v); PicklistService.setBoard(v); };
  const setBranches = (v: TreeBranch[]) => { setBranchesState(v); PicklistService.setBranches(v); };
  const setOurTeam = (v: number) => { setOurTeamState(v); PicklistService.setOurTeam(v); };

  // One-time seed once ranking data exists. Never overwrites saved decisions.
  useEffect(() => {
    if (seeded.current || !ready || rankedTeams.length === 0) return;
    seeded.current = true;

    const captains = rankedTeams.slice(0, 8);
    if (board.every((a) => a.captain == null && a.picks.length === 0)) {
      setBoard(captains.map((c) => ({ captain: c ?? null, picks: [] })));
    }
    if (tier1.length === 0) setTier1(captains.filter((t) => t !== ourTeam));
    if (tier2.length === 0) {
      setTier2(rankedTeams.filter((t) => !captains.includes(t) && t !== ourTeam).slice(0, 16));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, rankedTeams]);

  const dnpTeams = useMemo(() => new Set(dnp.map((d) => d.team)), [dnp]);

  const takenTeams = useMemo(() => {
    const set = new Set<number>();
    board.forEach((a) => {
      if (a.captain != null) set.add(a.captain);
      a.picks.forEach((p) => set.add(p));
    });
    return set;
  }, [board]);

  const pool = useMemo(
    () => rankedTeams.filter((t) => !takenTeams.has(t) && !dnpTeams.has(t)),
    [rankedTeams, takenTeams, dnpTeams]
  );

  /**
   * Which alliance is on the clock, following the real selection order:
   * round 1 runs alliance 1 → 8, round 2 runs 8 → 1 (manual §10.6.1).
   */
  const onTheClock = useMemo(() => {
    if (!board.some((a) => a.captain != null)) return -1;
    for (let i = 0; i < board.length; i++) {
      if (board[i].captain != null && board[i].picks.length === 0) return i;
    }
    for (let i = board.length - 1; i >= 0; i--) {
      if (board[i].captain != null && board[i].picks.length === 1) return i;
    }
    return -1;
  }, [board]);

  const addToClock = (team: number) => {
    if (onTheClock < 0) return;
    setBoard(board.map((a, i) => (i === onTheClock ? { ...a, picks: [...a.picks, team] } : a)));
  };

  const removePick = (allianceIdx: number, team: number) =>
    setBoard(
      board.map((a, i) =>
        i === allianceIdx ? { ...a, picks: a.picks.filter((p) => p !== team) } : a
      )
    );

  const move = (list: number[], team: number, delta: number) => {
    const i = list.indexOf(team);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return list;
    const copy = [...list];
    [copy[i], copy[j]] = [copy[j], copy[i]];
    return copy;
  };

  const tierHandlers = (
    list: number[],
    setList: (v: number[]) => void,
    other: number[],
    setOther: (v: number[]) => void
  ) => ({
    onMoveUp: (team: number) => setList(move(list, team, -1)),
    onMoveDown: (team: number) => setList(move(list, team, 1)),
    onMoveTier: (team: number) => {
      setList(list.filter((t) => t !== team));
      if (!other.includes(team)) setOther([...other, team]);
    },
    onRemove: (team: number) => {
      setList(list.filter((t) => t !== team));
      if (!dnpTeams.has(team)) setDnp([...dnp, { team, reason: '' }]);
    },
    onDragStart: () => {
      /* payload travels in dataTransfer */
    },
  });

  const toggleDnp = (team: number, reason = '') => {
    if (dnpTeams.has(team)) {
      setDnp(dnp.filter((d) => d.team !== team));
    } else {
      setDnp([...dnp, { team, reason }]);
      setTier1(tier1.filter((t) => t !== team));
      setTier2(tier2.filter((t) => t !== team));
    }
  };

  const restoreDnp = (team: number) => {
    setDnp(dnp.filter((d) => d.team !== team));
    if (!tier2.includes(team) && !tier1.includes(team)) setTier2([...tier2, team]);
  };

  /** Add to the 1st-pick shortlist from the Field Ranking table. */
  const addToPicklist = (team: number) => {
    if (tier1.includes(team)) setTier1(tier1.filter((t) => t !== team));
    else setTier1([...tier1, team]);
  };

  const toggleCompare = (team: number) =>
    setCompare((c) => (c.includes(team) ? c.filter((t) => t !== team) : [...c, team]));

  /**
   * Clear the board and re-seed the eight captains from the current ranking.
   *
   * Seeding happens here rather than by re-arming the mount effect: that effect
   * is keyed on [ready, rankedTeams], neither of which changes on a reset, so
   * relying on it would leave the board permanently empty.
   */
  const resetBoard = () => {
    const captains = rankedTeams.slice(0, 8);
    setBoard(
      captains.length
        ? emptyBoard().map((slot, i) => ({ ...slot, captain: captains[i] ?? null }))
        : emptyBoard()
    );
    setBranches([
      { id: 1, cap: null, second: null },
      { id: 2, cap: null, second: null },
    ]);
  };

  return {
    ourTeam, setOurTeam,
    tier1, setTier1,
    tier2, setTier2,
    dnp, setDnp, dnpTeams, toggleDnp, restoreDnp,
    board, setBoard, takenTeams, pool, onTheClock, addToClock, removePick, resetBoard,
    branches, setBranches,
    compare, setCompare, toggleCompare,
    tierHandlers,
    addToPicklist,
  };
}

export type PicklistState = ReturnType<typeof usePicklistState>;
