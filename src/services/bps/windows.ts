import {
  ActionSegment,
  AUTO_LEN,
  BpsWindow,
  CvMatchLog,
  DataConfidence,
  MATCH_LEN,
  TimelineScoutingData,
} from '../../types';

/**
 * Stream fusion — the step that makes per-robot attribution possible.
 *
 * The human stream says *who* was scoring at each moment; the CV stream says
 * *when* the alliance score moved. Neither alone attributes a point to a
 * robot. Slicing the match wherever the active-scorer set changes turns one
 * match into dozens of equations instead of OPR's single per-match aggregate.
 */

/** How much a scout's self-reported confidence scales their windows' weight. */
const CONFIDENCE_WEIGHT: Record<DataConfidence, number> = {
  high: 1,
  moderate: 0.6,
  low: 0.25,
};

/** Floating-point slop when comparing second boundaries. */
const EPS = 1e-6;

/**
 * Only `shoot` marks a robot as an active scorer.
 *
 * `pass` deliberately does not: a robot feeding a teammate is not the one
 * putting points on the board, and crediting it would smear attribution
 * across both robots. `def` and `oof` are likewise non-scoring, and the spec
 * requires `oof` stretches be excluded from a robot's eligible windows.
 */
const isScoring = (s: ActionSegment) => s.action === 'shoot';

interface AllianceInput {
  matchKey: string;
  alliance: 'red' | 'blue';
  timelines: TimelineScoutingData[];
  /** Per-second CV samples for this match. */
  samples: CvMatchLog['samples'];
}

/**
 * Total positive score the alliance gained strictly inside [start, end).
 *
 * CV samples are stamped at the second the scoreboard changed, so a sample at
 * second `t` reports points earned during the second ending at `t`. We credit
 * it to the window containing `t`.
 */
function scoreInWindow(
  samples: CvMatchLog['samples'],
  alliance: 'red' | 'blue',
  start: number,
  end: number
): number {
  let acc = 0;
  for (const s of samples) {
    if (s.sec > start + EPS && s.sec <= end + EPS) {
      const d = alliance === 'blue' ? s.db : s.dr;
      if (d > 0) acc += d;
    }
  }
  return acc;
}

/** Every instant where any robot's scoring flag flips, plus phase boundaries. */
function breakpoints(timelines: TimelineScoutingData[]): number[] {
  const marks = new Set<number>([0, AUTO_LEN, MATCH_LEN]);

  for (const t of timelines) {
    for (const seg of t.segments) {
      // `oof` boundaries matter too: a robot dying mid-window changes the
      // active set even though it was not scoring on either side.
      const a = clampTime(seg.start);
      const b = clampTime(seg.end);
      if (b - a > EPS) {
        marks.add(a);
        marks.add(b);
      }
    }
  }

  return [...marks].sort((x, y) => x - y);
}

const clampTime = (v: number) => Math.max(0, Math.min(MATCH_LEN, v));

/** Was this robot flagged as scoring across the whole of [start, end)? */
function scoringDuring(t: TimelineScoutingData, start: number, end: number): boolean {
  const mid = (start + end) / 2;
  return t.segments.some((s) => isScoring(s) && s.start <= mid + EPS && s.end >= mid - EPS);
}

/**
 * Build one alliance's windows for one match.
 *
 * Windows with no flagged scorer are dropped rather than kept as zero rows:
 * if the alliance scored while nobody was flagged, that is a scouting miss,
 * and the anomaly pass in passes.ts is where such score is dealt with.
 */
export function buildAllianceWindows({
  matchKey,
  alliance,
  timelines,
  samples,
}: AllianceInput): BpsWindow[] {
  if (!timelines.length || !samples.length) return [];

  const marks = breakpoints(timelines);
  const windows: BpsWindow[] = [];

  for (let i = 0; i < marks.length - 1; i++) {
    const start = marks[i];
    const end = marks[i + 1];
    const length = end - start;
    if (length <= EPS) continue;

    const active = timelines.filter((t) => scoringDuring(t, start, end));
    if (!active.length) continue;

    const score = scoreInWindow(samples, alliance, start, end);

    // Confidence enters through the least-confident contributing scout: one
    // unreliable timeline compromises the whole equation, not a third of it.
    const conf = active.reduce(
      (lo, t) => Math.min(lo, CONFIDENCE_WEIGHT[t.confidence] ?? 0.5),
      1
    );

    windows.push({
      matchKey,
      alliance,
      start,
      length,
      phase: start < AUTO_LEN - EPS ? 'auto' : 'teleop',
      teams: active.map((t) => t.teamKey),
      score,
      // Longer windows average out CV lag; windows with fewer simultaneous
      // scorers attribute more sharply. Both are what "more isolated" buys.
      weight: (length / active.length) * conf,
    });
  }

  return windows;
}

/**
 * Build every window across a set of matches.
 *
 * Timelines are grouped by match and alliance. A match contributes nothing
 * unless it has a CV log — without the score stream there is no right-hand
 * side to fit against.
 */
export function buildWindows(
  timelines: TimelineScoutingData[],
  cvLogs: CvMatchLog[]
): BpsWindow[] {
  const logByMatch = new Map<string, CvMatchLog>();
  for (const log of cvLogs) {
    if (log.deletedAt) continue;
    logByMatch.set(log.matchKey, log);
  }

  const grouped = new Map<string, TimelineScoutingData[]>();
  for (const t of timelines) {
    const key = `${t.matchKey}|${t.alliance}`;
    const list = grouped.get(key);
    if (list) list.push(t);
    else grouped.set(key, [t]);
  }

  const out: BpsWindow[] = [];
  for (const [key, group] of grouped) {
    const [matchKey, alliance] = key.split('|') as [string, 'red' | 'blue'];
    const log = logByMatch.get(matchKey);
    if (!log) continue;

    out.push(
      ...buildAllianceWindows({
        matchKey,
        alliance,
        timelines: dedupeByTeam(group),
        samples: log.samples,
      })
    );
  }

  return out;
}

/**
 * Keep one timeline per team per match — the most confident, then the most
 * recent. Two scouts occasionally cover the same robot; counting both would
 * double its presence in the active set and distort the split.
 */
function dedupeByTeam(group: TimelineScoutingData[]): TimelineScoutingData[] {
  const best = new Map<string, TimelineScoutingData>();
  for (const t of group) {
    const prev = best.get(t.teamKey);
    if (!prev) {
      best.set(t.teamKey, t);
      continue;
    }
    const a = CONFIDENCE_WEIGHT[t.confidence] ?? 0.5;
    const b = CONFIDENCE_WEIGHT[prev.confidence] ?? 0.5;
    if (a > b || (a === b && t.timestamp > prev.timestamp)) best.set(t.teamKey, t);
  }
  return [...best.values()];
}

/**
 * Shift a match's CV samples in time. Used by the time-sync tuning pass to
 * absorb livestream lag between the human flags and the scoreboard.
 */
export function shiftSamples(
  samples: CvMatchLog['samples'],
  deltaSeconds: number
): CvMatchLog['samples'] {
  if (!deltaSeconds) return samples;
  return samples.map((s) => ({ ...s, sec: s.sec + deltaSeconds }));
}

/** Seconds each team spent in one action, summed across their timelines. */
export function secondsByTeam(
  timelines: TimelineScoutingData[],
  action: ActionSegment['action']
): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of timelines) {
    let acc = out.get(t.teamKey) ?? 0;
    for (const s of t.segments) {
      if (s.action === action) acc += Math.max(0, s.end - s.start);
    }
    out.set(t.teamKey, acc);
  }
  return out;
}

/** Seconds each team spent flagged as actively scoring. */
export function scoringSecondsByTeam(
  timelines: TimelineScoutingData[]
): Map<string, number> {
  return secondsByTeam(timelines, 'shoot');
}

/** Matches each team has a timeline for — the denominator for per-match rates. */
export function matchCountByTeam(
  timelines: TimelineScoutingData[]
): Map<string, number> {
  const seen = new Map<string, Set<string>>();
  for (const t of timelines) {
    const set = seen.get(t.teamKey) ?? new Set<string>();
    set.add(t.matchKey);
    seen.set(t.teamKey, set);
  }
  return new Map([...seen].map(([k, v]) => [k, v.size]));
}
