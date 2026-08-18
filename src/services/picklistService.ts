/**
 * Local persistence for the alliance-selection picklist.
 *
 * Everything lives in localStorage for now — the Supabase schema for this app
 * does not exist yet, so server sync would fail. State survives reloads and is
 * shared across tabs via the same storage-event pattern used by DataService.
 */

const STORAGE_KEYS = {
  TIER1: 'frc-picklist-tier1',
  TIER2: 'frc-picklist-tier2',
  DNP: 'frc-picklist-dnp',
  BOARD: 'frc-picklist-board',
  BRANCHES: 'frc-picklist-branches',
  OUR_TEAM: 'frc-picklist-our-team',
} as const;

/** Team 6560 — matches the `admin6560` login convention. */
export const DEFAULT_OUR_TEAM = 6560;

export const PICKLIST_UPDATED_EVENT = 'picklist-updated';

export interface DnpEntry {
  team: number;
  reason: string;
}

/** One of the eight alliances on the selection board. */
export interface AllianceSlot {
  /** Alliance lead. `null` until seeded from rankings. */
  captain: number | null;
  /** Teams the captain has taken, in pick order. */
  picks: number[];
}

/**
 * One planned pick branch: a 1st-pick target and the 2nd-pick options ranked
 * for the case where that 1st pick is still on the board when we are on the
 * clock.
 */
export interface TreeBranch {
  id: number;
  /** The 1st-pick target this branch is built around. */
  first: number | null;
  /** 2nd-pick options in priority order. */
  seconds: number[];
}

/** The pre-v2 branch shape, kept only so saved branches survive the upgrade. */
interface LegacyTreeBranch {
  id: number;
  cap?: number | null;
  second?: number | null;
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    window.dispatchEvent(new CustomEvent(PICKLIST_UPDATED_EVENT, { detail: { key } }));
  } catch {
    // storage full or unavailable — keep the in-memory state working
  }
}

export const emptyBoard = (): AllianceSlot[] =>
  Array.from({ length: 8 }, () => ({ captain: null, picks: [] }));

export class PicklistService {
  static getTier1(): number[] {
    return read<number[]>(STORAGE_KEYS.TIER1, []);
  }
  static setTier1(teams: number[]): void {
    write(STORAGE_KEYS.TIER1, teams);
  }

  static getTier2(): number[] {
    return read<number[]>(STORAGE_KEYS.TIER2, []);
  }
  static setTier2(teams: number[]): void {
    write(STORAGE_KEYS.TIER2, teams);
  }

  static getDnp(): DnpEntry[] {
    return read<DnpEntry[]>(STORAGE_KEYS.DNP, []);
  }
  static setDnp(entries: DnpEntry[]): void {
    write(STORAGE_KEYS.DNP, entries);
  }

  static getBoard(): AllianceSlot[] {
    const board = read<AllianceSlot[]>(STORAGE_KEYS.BOARD, []);
    if (!Array.isArray(board) || board.length !== 8) return emptyBoard();
    return board.map((a) => ({
      captain: a?.captain ?? null,
      picks: Array.isArray(a?.picks) ? a.picks : [],
    }));
  }
  static setBoard(board: AllianceSlot[]): void {
    write(STORAGE_KEYS.BOARD, board);
  }

  /**
   * Saved branches, upgraded in place from the old `{ cap, second }` shape.
   *
   * Branches used to be a single captain plus a single 2nd pick; they are now
   * a 1st-pick target with an ordered list of 2nd-pick options. Old entries
   * are mapped rather than dropped so a team that planned its picks before
   * this build does not lose them, and empty ones are discarded because the
   * new builder has no notion of a blank branch.
   */
  static getBranches(): TreeBranch[] {
    const raw = read<(TreeBranch & LegacyTreeBranch)[]>(STORAGE_KEYS.BRANCHES, []);
    if (!Array.isArray(raw)) return [];
    return raw
      .map((b, i) => ({
        id: typeof b?.id === 'number' ? b.id : i + 1,
        first: b?.first ?? b?.cap ?? null,
        seconds: Array.isArray(b?.seconds)
          ? b.seconds
          : b?.second != null
            ? [b.second]
            : [],
      }))
      .filter((b) => b.first != null);
  }
  static setBranches(branches: TreeBranch[]): void {
    write(STORAGE_KEYS.BRANCHES, branches);
  }

  static getOurTeam(): number {
    const raw = localStorage.getItem(STORAGE_KEYS.OUR_TEAM);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_OUR_TEAM;
  }
  static setOurTeam(team: number): void {
    try {
      localStorage.setItem(STORAGE_KEYS.OUR_TEAM, String(team));
      window.dispatchEvent(
        new CustomEvent(PICKLIST_UPDATED_EVENT, { detail: { key: STORAGE_KEYS.OUR_TEAM } })
      );
    } catch {
      // ignore
    }
  }

  /** Clear the board and tree, keeping tier ordering and DNP notes. */
  static resetBoard(): void {
    PicklistService.setBoard(emptyBoard());
    PicklistService.setBranches([]);
  }

  /** Wipe every picklist decision. */
  static resetAll(): void {
    Object.values(STORAGE_KEYS).forEach((k) => {
      try {
        localStorage.removeItem(k);
      } catch {
        // ignore
      }
    });
    window.dispatchEvent(new CustomEvent(PICKLIST_UPDATED_EVENT, { detail: { key: 'all' } }));
  }
}
