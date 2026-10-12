import type { AllianceSlot } from './picklistService';

/** Assign an exact seat, retaining unique teams and contiguous pick order. */
export function editAllianceSeat(board: AllianceSlot[], captains: (number | null)[],
  alliance: number, seat: number, team: number | null): AllianceSlot[] {
  if (!board[alliance] || seat < 0 || seat > 2) return board;
  const next = board.map((a) => ({ captain: a.captain, picks: [...a.picks] }));
  const target = next[alliance];
  const current = seat === 0 ? target.captain : target.picks[seat - 1];
  if (current === team) return board;
  if (seat === 2 && team != null && !target.picks.length) return board;
  if (seat > 0 && team != null && (target.captain ?? captains[alliance]) === team) return board;
  if (seat > 0 && team != null && target.picks.includes(team)) {
    if (current == null) return board;
    target.picks[target.picks.indexOf(team)] = current;
    target.picks[seat - 1] = team;
    return next;
  }
  if (team != null) next.forEach((a) => {
    a.picks = a.picks.filter((p) => p !== team);
    if (a.captain === team) a.captain = a.picks.shift() ?? null;
  });
  if (seat === 0) {
    target.captain = team;
    if (team == null && target.picks.length) target.captain = target.picks.shift() ?? null;
  } else {
    if (team == null) target.picks.splice(seat - 1, 1);
    else target.picks[seat - 1] = team;
    if (team != null && target.captain == null) target.captain = captains[alliance];
  }
  return next;
}
