import type { TeamMetrics } from '../utils/teamMetrics';

/** Text comparison for the existing compare action; no new workspace panels. */
export function comparisonText(teams: TeamMetrics[]): string {
  if (teams.length === 1) return 'Selected team ' + teams[0].teamNumber +
    '. Open another team and press ‖ to compare. Press ‖ again on a selected team to remove it.';
  const fmt = (v: number) => Number.isFinite(v) ? v.toFixed(1) : '—';
  return 'TEAM COMPARISON\n\n' + teams.map((t) =>
    'Team ' + t.teamNumber + (t.hasData
      ? '\nAverage: ' + fmt(t.adjMean) + ' pts; median: ' + fmt(t.median) +
        '\nAuto: ' + fmt(t.autoAvg) + '; teleop: ' + fmt(t.teleopAvg) +
        '; tower: ' + fmt(t.towerAvg) +
        '\nConsistency: ' + Math.round(t.consistency * 100) + '%; scouted matches: ' + t.matchesPlayed +
        '\nSource: ' + t.source + (t.isSynthetic ? ' (reconstructed averages)' : '')
      : '\nNo scoring data — not a measured zero')
  ).join('\n\n') + '\n\nRemove a team by pressing ‖ again on its detail page.';
}
