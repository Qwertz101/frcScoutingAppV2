import { ScoutingData } from '../types';
import { DataService } from './dataService';
import { migrateLocalToServer } from './syncService';
import { TeamAggregate, synthesizeAll } from '../utils/synthesizeMatches';

/**
 * Import a team-stats CSV produced by DataAnalysis' "Export CSV" button.
 *
 * Format note: the exporter writes `Auto Climb (max, %)` and its values as
 * `0, 0.0%` — an unquoted comma *inside* a logical column. So a plain
 * comma-split yields more fields than there are named columns, and header and
 * data rows happen to line up because both are split the same way. Columns are
 * therefore located by walking the header rather than by fixed index, which
 * also handles exports made with the Auto/Teleop toggles turned off.
 */

/** Positions of each logical column within the comma-split fields. */
interface ColumnMap {
  team: number;
  count: number;
  autoAvgFuel: number;
  autoClimbMax: number;
  autoClimbPct: number;
  teleClimbMax: number;
  teleClimbPct: number;
  teleopAvgFuel: number;
  totalAvgFuel: number;
  matchesScouted: number;
  died: number;
  defense: number;
}

function mapColumns(headerLine: string): ColumnMap {
  const fields = headerLine.split(',').map((f) => f.trim());
  const map: Partial<ColumnMap> = {};

  fields.forEach((f, i) => {
    if (f === 'Team') map.team = i;
    else if (f === 'Count') map.count = i;
    else if (f === 'Auto Avg Fuel') map.autoAvgFuel = i;
    else if (f.startsWith('Auto Climb (max')) {
      // spans two fields: "<max>" then "<pct>%"
      map.autoClimbMax = i;
      map.autoClimbPct = i + 1;
    } else if (f.startsWith('Tele Climb (max')) {
      map.teleClimbMax = i;
      map.teleClimbPct = i + 1;
    } else if (f === 'Teleop Avg Fuel') map.teleopAvgFuel = i;
    else if (f === 'Total Avg Fuel') map.totalAvgFuel = i;
    else if (f === 'Matches Scouted') map.matchesScouted = i;
    else if (f.startsWith('Died (')) map.died = i;
    else if (f === 'Defense') map.defense = i;
  });

  if (map.team == null) {
    throw new Error("Not a team-stats CSV: no 'Team' column found.");
  }
  return map as ColumnMap;
}

const num = (v: string | undefined): number => {
  if (v == null) return 0;
  const n = Number(String(v).replace('%', '').trim());
  return Number.isFinite(n) ? n : 0;
};

/** Parse "12/12" into its two parts. */
const ratio = (v: string | undefined): [number, number] => {
  const [a, b] = String(v ?? '').split('/');
  return [num(a), num(b)];
};

export function parseStatsCsv(text: string): TeamAggregate[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length < 2) throw new Error('CSV appears to be empty.');

  const cols = mapColumns(lines[0]);

  return lines.slice(1).map((line) => {
    const f = line.split(',').map((s) => s.trim());
    const team = num(f[cols.team]);
    const [played, scheduled] = ratio(f[cols.matchesScouted]);
    const [died] = ratio(f[cols.died]);

    return {
      team,
      teamKey: `frc${team}`,
      entries: num(f[cols.count]),
      avgAutoFuel: num(f[cols.autoAvgFuel]),
      autoMaxClimb: num(f[cols.autoClimbMax]),
      autoClimbPct: num(f[cols.autoClimbPct]),
      teleMaxClimb: num(f[cols.teleClimbMax]),
      teleClimbPct: num(f[cols.teleClimbPct]),
      avgTeleopFuel: num(f[cols.teleopAvgFuel]),
      avgTotalFuel: num(f[cols.totalAvgFuel]),
      matchesPlayed: played,
      matchesScheduled: scheduled || played,
      diedCount: died,
      defense: f[cols.defense] ?? 'N/A',
    } as TeamAggregate;
  }).filter((a) => a.team > 0);
}

export interface ImportPreview {
  aggregates: TeamAggregate[];
  teams: number;
  rowsToCreate: number;
  teamsWithoutSchedule: number[];
}

/** Match keys a team is actually scheduled for, in match order. */
function scheduledMatchKeys(teamKey: string): string[] {
  const matches = (DataService.getMatches() || []).filter((m: any) => !m.deletedAt);
  return matches
    .filter((m: any) => {
      const keys: string[] = [
        ...(m.alliances?.red?.team_keys || []),
        ...(m.alliances?.blue?.team_keys || []),
      ];
      return keys.includes(teamKey);
    })
    .sort((a: any, b: any) => (a.match_number ?? 0) - (b.match_number ?? 0))
    .map((m: any) => m.key);
}

/** Dry run — what an import would do, so the user can confirm first. */
export function previewImport(text: string): ImportPreview {
  const aggregates = parseStatsCsv(text);
  const teamsWithoutSchedule: number[] = [];
  let rowsToCreate = 0;

  aggregates.forEach((a) => {
    const keys = scheduledMatchKeys(a.teamKey);
    if (keys.length === 0) teamsWithoutSchedule.push(a.team);
    rowsToCreate += Math.min(a.matchesPlayed || keys.length, keys.length);
  });

  return { aggregates, teams: aggregates.length, rowsToCreate, teamsWithoutSchedule };
}

/**
 * Expand the aggregates into synthetic per-match rows, store them locally, and
 * push them to the server.
 *
 * Existing synthetic rows from a previous import are replaced; genuinely
 * scouted rows are left untouched so a re-import never destroys real data.
 *
 * The push matters: once Supabase is reachable, performFullRefresh treats the
 * server as authoritative and overwrites local scouting data with whatever it
 * finds there. A CSV import that only wrote to localStorage would survive
 * exactly until the next login, then vanish — so the new rows are queued and
 * pushed immediately rather than left to the next background sync tick.
 */
export async function commitImport(aggregates: TeamAggregate[]): Promise<{
  created: number;
  keptReal: number;
  synced: boolean;
  syncError: string | null;
}> {
  const rows = synthesizeAll(aggregates, scheduledMatchKeys);

  const existing = (DataService.getScoutingData() || []) as any[];
  const keptReal = existing.filter((r) => !r?.synthetic);

  DataService.replaceScoutingData([...keptReal, ...rows] as any[]);

  const stillPending = DataService.getPendingScouting().filter((id: string) =>
    keptReal.some((r) => r.id === id)
  );
  DataService.setPendingScouting([...stillPending, ...rows.map((r) => r.id)]);

  let synced = false;
  let syncError: string | null = null;
  try {
    await migrateLocalToServer();
    synced = true;
  } catch (e: any) {
    syncError = String(e?.message || e);
  }

  return { created: rows.length, keptReal: keptReal.length, synced, syncError };
}

/** True when a set of rows came from the CSV importer rather than real scouting. */
export function isSyntheticRow(row: ScoutingData | any): boolean {
  return !!row?.synthetic;
}
