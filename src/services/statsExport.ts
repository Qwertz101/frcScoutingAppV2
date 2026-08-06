import { ScoutingData } from '../types';
import { DataService } from './dataService';

/**
 * Team-stats CSV export — the season backup, lifted out of the retired Data
 * Analysis screen.
 *
 * The exact byte format matters: `statsImport.ts` parses this file back in, and
 * the header deliberately contains an *unquoted* comma inside two logical
 * columns (`Auto Climb (max, %)` / `Tele Climb (max, %)`) whose values are
 * written the same way (`0, 0.0%`). Header and data rows therefore split into
 * the same number of fields, which is what the importer's header-walking column
 * map relies on. Do not "fix" the quoting without changing the importer.
 *
 * Aggregation is ported verbatim from DataAnalysis rather than reusing
 * `utils/teamMetrics.ts`, because those helpers compute different numbers:
 *  - teamMetrics averages fuel per *match* (collapsing scouters first); the
 *    export averages per *entry*.
 *  - teamMetrics counts only qualification matches as scheduled; the export
 *    counts every scheduled match.
 *  - teamMetrics reports a median climb level and a climb *rate*; the export
 *    reports max level + percent of entries that climbed.
 * Substituting them would silently change every number in the backup file.
 */

export interface TeamStatsRow {
  teamKey: string;
  team: string;
  count: number;
  avgAutoFuel: number;
  autoMaxClimb: number;
  autoClimbedPercent: number;
  teleMaxClimb: number;
  teleClimbedPercent: number;
  avgTeleopFuel: number;
  avgTotalFuel: number;
  matchesPlayed: number;
  matchesScheduled: number;
  diedCount: number;
  defense: string;
}

const sum = (arr: number[]) => arr.reduce((s, v) => s + v, 0);
const avg = (arr: number[]) => (arr.length === 0 ? 0 : sum(arr) / arr.length);
const round2 = (v: number) => Math.round(v * 100) / 100;

/** 0 = not rated; 1..4 = none/bad/ok/great. */
const mapDefense = (v: any) => (v === 'none' ? 1 : v === 'bad' ? 2 : v === 'ok' ? 3 : v === 'great' ? 4 : 0);

/** Average of the rated entries only; 0 when nobody rated the team. */
const avgOrNA = (arr: number[]) => {
  const nonZero = arr.filter((v) => v > 0);
  if (nonZero.length === 0) return 0;
  return round2(sum(nonZero) / nonZero.length);
};

const mapBackDefense = (v: number) => (v <= 1.5 ? 'None/Bad' : v <= 2.5 ? 'OK' : 'Great');

/** Auto climb: legacy boolean/number, plus the current 'level<N>' dropdown. */
const mapAutoLevel = (v: any): number => {
  if (!v) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    if (v === 'didnt_climb' || v === 'none') return 0;
    if (v === 'climbed') return 1; // shorthand used by older rows
    const m = v.match(/level(\d+)/);
    if (m) return Number(m[1]);
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  return 0;
};

/** Match/teleop climb. Note: no boolean or 'climbed' fallback here, matching the original. */
const mapMatchLevel = (v: any): number => {
  if (!v) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    if (v === 'didnt_climb' || v === 'none') return 0;
    const m = v.match(/level(\d+)/);
    if (m) return Number(m[1]);
  }
  return 0;
};

/**
 * The team list the export covers: every team in the schedule, plus manually
 * added teams, falling back to whatever teams the rows mention.
 *
 * DataAnalysis also folded in team keys discovered from server `pit_data`; that
 * required an async fetch and only ever *added* teams with no scouting rows
 * (all-zero lines), so it is omitted here to keep export synchronous.
 */
function collectTeamKeys(rows: ScoutingData[], matches: any[]): string[] {
  const teamSet = new Set<string>();
  matches.forEach((m: any) => {
    (['red', 'blue'] as const).forEach((a) => {
      (m.alliances?.[a]?.team_keys || []).forEach((tk: string) => teamSet.add(tk));
    });
  });
  (DataService.getTeams() || []).forEach((t) => teamSet.add(t.teamKey));
  if (teamSet.size === 0) rows.forEach((r) => teamSet.add(r.teamKey));
  return Array.from(teamSet).sort((a, b) => a.localeCompare(b));
}

/** Per-team aggregation, ported from DataAnalysis' `teamStats` useMemo. */
export function buildTeamStatsRows(rows: ScoutingData[]): TeamStatsRow[] {
  const byTeam: Record<string, ScoutingData[]> = {};
  rows.forEach((r) => {
    byTeam[r.teamKey] = byTeam[r.teamKey] || [];
    byTeam[r.teamKey].push(r);
  });

  const matchesList = (DataService.getMatches() || []).filter((m: any) => !m.deletedAt);
  const teamKeys = collectTeamKeys(rows, matchesList);

  const stats = teamKeys.map((tk) => {
    const entries = byTeam[tk] || [];

    const byMatch: Record<string, ScoutingData[]> = {};
    entries.forEach((e) => {
      byMatch[e.matchKey] = byMatch[e.matchKey] || [];
      byMatch[e.matchKey].push(e);
    });
    const matchesPlayed = Object.keys(byMatch).length;

    const matchesScheduled = matchesList.filter((m: any) => {
      const keys: string[] = [
        ...(m.alliances?.red?.team_keys || []),
        ...(m.alliances?.blue?.team_keys || []),
      ];
      return keys.includes(tk);
    }).length;

    const autoFuelArr = entries.map((e) => (typeof e.auto?.fuel === 'number' ? e.auto.fuel : 0));
    const teleopOffence = entries.map((e) =>
      typeof e.teleop?.offence?.fuel === 'number' ? e.teleop.offence.fuel : 0
    );

    const autoLevels = entries.map((e) => mapAutoLevel((e.auto as any)?.climbed));
    const autoMaxClimb = autoLevels.length === 0 ? 0 : Math.max(...autoLevels);
    const autoClimbedPercent =
      autoLevels.length === 0 ? 0 : (autoLevels.filter((l) => l > 0).length / autoLevels.length) * 100;

    const teleLevels = entries.map((e) =>
      mapMatchLevel((e as any).matchClimbed ?? (e.endgame && (e.endgame as any).climb))
    );
    const teleMaxClimb = teleLevels.length === 0 ? 0 : Math.max(...teleLevels);
    const teleClimbedPercent =
      teleLevels.length === 0 ? 0 : (teleLevels.filter((l) => l > 0).length / teleLevels.length) * 100;

    const avgDefense = avgOrNA(entries.map((e) => mapDefense(e.defense)));

    return {
      teamKey: tk,
      team: tk.replace(/^frc/, ''),
      count: entries.length,
      avgAutoFuel: round2(avg(autoFuelArr)),
      autoMaxClimb,
      autoClimbedPercent: round2(autoClimbedPercent),
      teleMaxClimb,
      teleClimbedPercent: round2(teleClimbedPercent),
      avgTeleopFuel: round2(avg(teleopOffence)),
      avgTotalFuel: round2(avg(autoFuelArr.map((v, i) => v + teleopOffence[i]))),
      matchesPlayed,
      matchesScheduled,
      // Endgame death tracking was removed from the scouting form; the column is
      // kept (always 0) because the importer reads it positionally.
      diedCount: 0,
      defense: avgDefense === 0 ? 'N/A' : mapBackDefense(avgDefense),
    };
  });

  // DataAnalysis exported its on-screen table, whose default sort is team key
  // ascending as a *string* (so 10936 sorts before 1160). Kept as-is.
  return stats.sort((a, b) => a.team.localeCompare(b.team));
}

/**
 * Build the CSV text. `showAuto`/`showTeleop` mirror the old screen's column
 * toggles; both default on, which is the full-fidelity backup format.
 */
export function buildTeamStatsCsv(
  rows: ScoutingData[],
  opts: { showAuto?: boolean; showTeleop?: boolean } = {}
): string {
  const showAuto = opts.showAuto !== false;
  const showTeleop = opts.showTeleop !== false;

  const headers = ['Team', 'Count'];
  if (showAuto) headers.push('Auto Avg Fuel', 'Auto Climb (max, %)', 'Tele Climb (max, %)');
  if (showTeleop) headers.push('Teleop Avg Fuel', 'Total Avg Fuel');
  headers.push('Matches Scouted', 'Died (count/matches)', 'Defense');

  const rowsCsv = buildTeamStatsRows(rows).map((t) => {
    const base: (string | number)[] = [t.team, t.count];
    if (showAuto)
      base.push(
        t.avgAutoFuel,
        `${t.autoMaxClimb}, ${t.autoClimbedPercent.toFixed(1)}%`,
        `${t.teleMaxClimb}, ${t.teleClimbedPercent.toFixed(1)}%`
      );
    if (showTeleop) base.push(t.avgTeleopFuel, t.avgTotalFuel);
    base.push(`${t.matchesPlayed}/${t.matchesScheduled}`, `${t.diedCount}/${t.matchesPlayed}`, t.defense);
    return base;
  });

  return [headers, ...rowsCsv].map((r) => r.join(',')).join('\n');
}

export function teamStatsFilename(date = new Date()): string {
  return `frc-team-stats-${date.toISOString().split('T')[0]}.csv`;
}

/** Build the CSV and hand it to the browser as a download. */
export function downloadTeamStatsCsv(
  rows: ScoutingData[],
  opts?: { showAuto?: boolean; showTeleop?: boolean }
): void {
  const csv = buildTeamStatsCsv(rows, opts);
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = teamStatsFilename();
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
