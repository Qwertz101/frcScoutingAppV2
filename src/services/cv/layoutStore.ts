/**
 * Scoreboard layouts a human taught the software, shared across machines.
 *
 * The detector infers geometry from pixels, and that is where this pipeline
 * keeps failing: IRI's two-row scoreboard took a night and two wrong fixes to
 * read, and a distorted hand-held recording is harder still. A person looking
 * at one frame settles it in seconds. So a layout is calibrated once per event
 * and stored centrally — any machine that scans that event picks it up without
 * anyone copying a file.
 *
 * **Layouts are per season as well as per event.** A venue can re-skin its
 * overlay between years, so `season` is stored rather than parsed at read time,
 * and nothing here reuses a layout across seasons on its own. Suggesting an
 * older layout to a human who can look at it and agree is fine; adopting one
 * silently is not.
 */

import { supabase } from '../supabaseClient';

/** A box, as fractions of frame width/height, so it survives a resolution change. */
export interface LayoutRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The nine things a human places. */
export interface LayoutBoxes {
  blueScore: LayoutRect;
  redScore: LayoutRect;
  timer: LayoutRect;
  blueTeams: [LayoutRect, LayoutRect, LayoutRect];
  redTeams: [LayoutRect, LayoutRect, LayoutRect];
}

export type LayoutElementId =
  | 'blueScore'
  | 'redScore'
  | 'timer'
  | 'blueTeam1'
  | 'blueTeam2'
  | 'blueTeam3'
  | 'redTeam1'
  | 'redTeam2'
  | 'redTeam3';

export const LAYOUT_ELEMENTS: { id: LayoutElementId; label: string; group: string }[] = [
  { id: 'blueScore', label: 'Blue score', group: 'Scores & clock' },
  { id: 'redScore', label: 'Red score', group: 'Scores & clock' },
  { id: 'timer', label: 'Match clock', group: 'Scores & clock' },
  { id: 'blueTeam1', label: 'Team 1', group: 'Blue alliance' },
  { id: 'blueTeam2', label: 'Team 2', group: 'Blue alliance' },
  { id: 'blueTeam3', label: 'Team 3', group: 'Blue alliance' },
  { id: 'redTeam1', label: 'Team 1', group: 'Red alliance' },
  { id: 'redTeam2', label: 'Team 2', group: 'Red alliance' },
  { id: 'redTeam3', label: 'Team 3', group: 'Red alliance' },
];

/** How each element's read compared with the official result, if checked. */
export interface LayoutVerification {
  matchKey: string;
  ours: { blue: number; red: number };
  tba: { blue: number; red: number };
  /**
   * Foul points TBA recorded, shown as context and never subtracted.
   *
   * The scoreboard already includes fouls awarded while the match ran, so
   * removing them over-corrects — measured on one match as turning a 4-point
   * shortfall into an 11-point overshoot. The comparison stays against the
   * official total, which is what the rest of the app uses, and every observed
   * error against it is a small undershoot from the broadcast cutting away
   * before the last points settle.
   */
  fouls: { blue: number; red: number };
  within: boolean;
  checkedAt: number;
}

export interface CalibratedLayout {
  eventKey: string;
  season: number;
  label: string;
  boxes: LayoutBoxes;
  sourceLabel?: string;
  frameSize?: { width: number; height: number };
  verified?: LayoutVerification | null;
  updatedAt?: string;
}

/** One thing a human moved, kept so the detector can be graded against it later. */
export interface LayoutCorrection {
  eventKey: string;
  season: number;
  element: LayoutElementId;
  /** Null when the detector offered nothing, which is itself worth recording. */
  proposed: LayoutRect | null;
  corrected: LayoutRect;
  delta: { dx0: number; dy0: number; dx1: number; dy1: number } | null;
}

/** `2026iri` -> 2026. Returns 0 when the key does not start with a year. */
export function seasonOf(eventKey: string): number {
  const m = /^(\d{4})/.exec(eventKey.trim());
  return m ? Number(m[1]) : 0;
}

function requireClient() {
  if (!supabase) throw new Error('Supabase is not configured on this device.');
  return supabase;
}

export async function fetchLayout(eventKey: string): Promise<CalibratedLayout | null> {
  const client = requireClient();
  const { data, error } = await client
    .from('cv_layouts')
    .select('*')
    .eq('event_key', eventKey)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return {
    eventKey: data.event_key,
    season: data.season,
    label: data.label ?? '',
    boxes: data.boxes,
    sourceLabel: data.source_label ?? undefined,
    frameSize: data.frame_size ?? undefined,
    verified: data.verified ?? null,
    updatedAt: data.updated_at,
  };
}

/**
 * Layouts from other events, newest first — the starting point for a broadcast
 * that looks like one already taught.
 *
 * Same season only by default. A venue can re-skin between years, and a layout
 * that is subtly wrong is worse than none: it looks calibrated and reads the
 * wrong pixels. Pass `allSeasons` to look further back, but the human still has
 * to confirm what they are copying.
 */
export async function fetchLayoutLibrary(
  season: number,
  opts: { allSeasons?: boolean; limit?: number } = {}
): Promise<CalibratedLayout[]> {
  const client = requireClient();
  let q = client.from('cv_layouts').select('*').order('updated_at', { ascending: false });
  if (!opts.allSeasons) q = q.eq('season', season);
  const { data, error } = await q.limit(opts.limit ?? 25);
  if (error) throw new Error(error.message);
  return (data ?? []).map((d) => ({
    eventKey: d.event_key,
    season: d.season,
    label: d.label ?? '',
    boxes: d.boxes,
    sourceLabel: d.source_label ?? undefined,
    frameSize: d.frame_size ?? undefined,
    verified: d.verified ?? null,
    updatedAt: d.updated_at,
  }));
}

export async function saveLayout(layout: CalibratedLayout): Promise<void> {
  const client = requireClient();
  const { error } = await client.from('cv_layouts').upsert(
    {
      event_key: layout.eventKey,
      season: layout.season || seasonOf(layout.eventKey),
      label: layout.label,
      boxes: layout.boxes,
      source_label: layout.sourceLabel ?? null,
      frame_size: layout.frameSize ?? null,
      verified: layout.verified ?? null,
    },
    { onConflict: 'event_key' }
  );
  if (error) throw new Error(error.message);
}

/**
 * Record what a human had to move.
 *
 * Deliberately never blocks saving a layout: this is data collection, and
 * losing a calibration because the log write failed would be a bad trade. A
 * failure is reported to the caller to surface quietly, not thrown.
 */
export async function logCorrections(rows: LayoutCorrection[]): Promise<string | null> {
  if (!rows.length) return null;
  try {
    const client = requireClient();
    const { error } = await client.from('cv_layout_corrections').insert(
      rows.map((r) => ({
        event_key: r.eventKey,
        season: r.season,
        element: r.element,
        proposed: r.proposed,
        corrected: r.corrected,
        delta: r.delta,
      }))
    );
    return error ? error.message : null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export function rectDelta(proposed: LayoutRect | null, corrected: LayoutRect) {
  if (!proposed) return null;
  return {
    dx0: Number((corrected.x0 - proposed.x0).toFixed(5)),
    dy0: Number((corrected.y0 - proposed.y0).toFixed(5)),
    dx1: Number((corrected.x1 - proposed.x1).toFixed(5)),
    dy1: Number((corrected.y1 - proposed.y1).toFixed(5)),
  };
}

/** Did a human actually move this, or just accept it? Sub-pixel noise is not a correction. */
export function isMeaningfulMove(a: LayoutRect | null, b: LayoutRect): boolean {
  if (!a) return true;
  const eps = 0.002;
  return (
    Math.abs(a.x0 - b.x0) > eps ||
    Math.abs(a.y0 - b.y0) > eps ||
    Math.abs(a.x1 - b.x1) > eps ||
    Math.abs(a.y1 - b.y1) > eps
  );
}
