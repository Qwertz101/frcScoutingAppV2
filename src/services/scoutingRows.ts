import { ScoutingData } from '../types';
import { DataService } from './dataService';
import { fetchServerScouting } from './syncService';

/**
 * Normalisation for raw Supabase `scouting_records` rows.
 *
 * The payload shape has changed across seasons, so this keeps the legacy
 * fallbacks (`l1..l4`, `net`, `prosser`) alongside the current `fuel` fields.
 * Shared by the Scout workspace and the stats CSV export so both read
 * identical numbers.
 */
export function mapServerRow(r: any): ScoutingData {
  const rawAuto = r.payload?.auto || {};
  const legacyAutoSum =
    (rawAuto.l1 || 0) +
    (rawAuto.l2 || 0) +
    (rawAuto.l3 || 0) +
    (rawAuto.l4 || 0) +
    (typeof rawAuto.net === 'number' ? rawAuto.net : rawAuto.net ? 1 : 0);
  const autoFuel = typeof rawAuto.fuel === 'number' ? rawAuto.fuel : legacyAutoSum;

  const rawTele = r.payload?.teleop || {};
  const legacyTeleSum =
    (rawTele.l1 || 0) +
    (rawTele.l2 || 0) +
    (rawTele.l3 || 0) +
    (rawTele.l4 || 0) +
    (typeof rawTele.net === 'number' ? rawTele.net : rawTele.net ? 1 : 0) +
    (typeof rawTele.prosser === 'number' ? rawTele.prosser : rawTele.prosser ? 1 : 0);

  return {
    id: r.id,
    matchKey: r.match_key,
    teamKey: r.team_key,
    scouter: r.scouter_name,
    alliance: r.alliance,
    position: r.position,
    auto: {
      fuel: autoFuel,
      neutralZone: !!rawAuto.neutralZone,
      depot: !!rawAuto.depot,
      outpost: !!rawAuto.outpost,
      // preserve the original climbed value (string level or legacy boolean/number)
      climbed: rawAuto.climbed,
    },
    // prefer explicit match-level climb saved in payload (top-level or inside endgame)
    matchClimbed:
      r.payload?.matchClimbed ??
      r.payload?.endgame?.climb ??
      (typeof rawAuto.climbed === 'string'
        ? rawAuto.climbed
        : rawAuto.climbed
        ? 'level1'
        : 'didnt_climb'),
    teleop: {
      offence: {
        fuel:
          typeof rawTele.offence?.fuel === 'number' ? rawTele.offence.fuel : legacyTeleSum,
      },
      defense: {
        defense: rawTele.defense?.defense ?? 'na',
        duration: rawTele.defense?.duration ?? 0,
      },
    },
    endgame: r.payload?.endgame ?? { climb: 'none' },
    robotShutdown: r.payload?.robotShutdown,
    defense: r.payload?.defense || 'none',
    timestamp: r.timestamp ? Date.parse(r.timestamp) : Date.now(),
    // Preserved so reconstructed rows stay labelled after a server round trip.
    synthetic: !!r.payload?.synthetic,
    syntheticSource: r.payload?.syntheticSource,
  } as any;
}

/**
 * Load scouting rows, preferring the server and falling back to whatever is
 * cached locally.
 *
 * An *empty* server result also falls back to local. Two cases make this
 * necessary, and both are silent failures otherwise:
 *  - `fetchServerScouting` holds a module-level lock and returns `[]` (not an
 *    error) when another fetch is already in flight — which is exactly what
 *    happens when `performFullRefresh` runs during login.
 *  - A configured-but-empty database would otherwise blank out local rows that
 *    have not synced yet.
 *
 * The server only wins when it actually has data.
 */
export async function loadScoutingRows(): Promise<{
  rows: ScoutingData[];
  error: string | null;
  fromServer: boolean;
}> {
  const local = (DataService.getScoutingData() || []) as ScoutingData[];

  try {
    const serverRows: any[] = await fetchServerScouting();
    if (serverRows.length > 0) {
      return { rows: serverRows.map(mapServerRow), error: null, fromServer: true };
    }
    return { rows: local, error: null, fromServer: false };
  } catch (e: any) {
    return {
      rows: local,
      // Only surface an error when there is nothing to show; otherwise local
      // data is a perfectly good answer and a warning would just be noise.
      error: local.length ? null : String(e?.message || e),
      fromServer: false,
    };
  }
}
