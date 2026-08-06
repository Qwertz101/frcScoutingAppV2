import { TeamMetrics } from '../../utils/teamMetrics';

/**
 * Turns raw team metrics into the short tags and one-line notes the picklist
 * shows next to each team. All thresholds are relative to what we actually
 * scouted, so they stay meaningful at any event.
 */

export interface Tag {
  label: string;
  bg: string;
  fg: string;
}

const TAG_STYLES = {
  cyan: { bg: '#00baff', fg: '#fff' },
  blue: { bg: '#1179ee', fg: '#fff' },
  teal: { bg: '#33becc', fg: '#fff' },
  black: { bg: '#000', fg: '#fff' },
  soft: { bg: 'var(--pill-bg)', fg: 'var(--text-muted)' },
} as const;

const tag = (label: string, style: keyof typeof TAG_STYLES): Tag => ({
  label,
  ...TAG_STYLES[style],
});

export function tagsFor(t: TeamMetrics, fieldMedianPoints: number): Tag[] {
  if (!t.hasData) return [tag('no data', 'soft')];

  const tags: Tag[] = [];

  if (t.adjMean >= fieldMedianPoints * 1.5) tags.push(tag('high scorer', 'cyan'));
  else if (t.adjMean >= fieldMedianPoints) tags.push(tag('above median', 'blue'));

  if (t.climbRate >= 60) tags.push(tag('climber', 'teal'));
  else if (t.climbRate >= 30) tags.push(tag('climbs sometimes', 'soft'));

  if (t.autoClimbRate >= 30) tags.push(tag('auto climb', 'teal'));

  if (t.matchesPlayed >= 3) {
    if (t.consistency >= 0.8) tags.push(tag('consistent', 'blue'));
    else if (t.consistency < 0.5) tags.push(tag('volatile', 'black'));
  }

  if (t.deathRate > 0) tags.push(tag(`${t.deaths.length} dead`, 'black'));
  if (t.defenseAvg >= 3) tags.push(tag('defender', 'soft'));

  return tags.length ? tags : [tag('baseline', 'soft')];
}

/** A plain-English read on the robot, written from the numbers we have. */
export function noteFor(t: TeamMetrics, fieldMedianPoints: number): string {
  if (!t.hasData) {
    return t.matchesScheduled
      ? `No scouting data yet — ${t.matchesScheduled} matches scheduled.`
      : 'No scouting data yet.';
  }

  const parts: string[] = [];
  const scale = fieldMedianPoints || 1;

  if (t.adjMean >= scale * 1.5) parts.push('Top-tier output');
  else if (t.adjMean >= scale) parts.push('Above-median scorer');
  else if (t.adjMean >= scale * 0.6) parts.push('Mid-tier scorer');
  else parts.push('Low scorer');

  parts.push(`${Math.round(t.adjMean)} pts avg over ${t.matchesPlayed} scouted`);

  if (t.matchesPlayed >= 3) {
    if (t.consistency >= 0.8) parts.push('very repeatable match to match');
    else if (t.consistency < 0.5) parts.push(`swings ${Math.round(t.floor)}–${Math.round(t.ceiling)}`);
  }

  if (t.climbRate >= 60) parts.push(`climbs in ${Math.round(t.climbRate)}% of matches`);
  else if (t.climbRate === 0) parts.push('no climb');

  if (t.deaths.length) {
    parts.push(`died in ${t.deaths.map((d) => d.label).join(', ')}`);
  }

  return parts.join(' · ') + '.';
}

/** Short capability badge shown beside the team number. */
export function badgeFor(t: TeamMetrics): Tag {
  if (!t.hasData) return tag('unscouted', 'soft');
  if (t.deathRate > 25) return tag('risky', 'black');
  if (t.consistency >= 0.8) return tag('steady', 'blue');
  if (t.ceiling >= t.adjMean * 1.6) return tag('high ceiling', 'cyan');
  return tag(`${t.matchesPlayed} scouted`, 'soft');
}

/** Colour used for the dot on pool chips — brighter means higher scoring. */
export function colorFor(t: TeamMetrics, fieldMedianPoints: number): string {
  if (!t.hasData) return 'var(--border-strong)';
  if (t.adjMean >= fieldMedianPoints * 1.5) return '#00baff';
  if (t.adjMean >= fieldMedianPoints) return '#1179ee';
  if (t.adjMean >= fieldMedianPoints * 0.6) return '#33becc';
  return 'var(--border-strong)';
}

export const fmtPts = (n: number) => `${Math.round(n)}`;
export const fmtSd = (n: number) => `±${Math.round(n)}`;
