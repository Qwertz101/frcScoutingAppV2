/**
 * The Blue Alliance, Node side.
 *
 * Deliberately not `src/services/tbaApi.ts`: that reads `import.meta.env` and
 * is written for a browser that has a user waiting. This one keeps the *raw*
 * match objects — including `actual_time` and `predicted_time`, which the app's
 * `dataService.saveMatches` discards — because match identification falls back
 * to wall-clock when the team numbers are ambiguous.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, WORKER_DIR } from './core.mjs';

const BASE = 'https://www.thebluealliance.com/api/v3';

/**
 * Read a key from `worker/.env` or the app's `.env.local`.
 *
 * Reusing `.env.local` means the worker does not need a second copy of the TBA
 * key lying around, and there is exactly one place to rotate it. Both files are
 * gitignored.
 */
export function readEnv(name) {
  if (process.env[name]) return process.env[name];
  const files = [
    join(WORKER_DIR, '.env'),
    join(REPO_ROOT, '.env.local'),
    join(REPO_ROOT, '.env'),
  ];
  for (const f of files) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      const key = m[1];
      const value = m[2].trim().replace(/^["']|["']$/g, '');
      // The app prefixes its vars for Vite; accept either spelling.
      if (key === name || key === 'VITE_' + name) return value;
    }
  }
  return null;
}

async function tba(path) {
  const key = readEnv('TBA_API_KEY');
  if (!key) throw new Error('no TBA_API_KEY in worker/.env or .env.local');
  const res = await fetch(BASE + path, { headers: { 'X-TBA-Auth-Key': key } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('TBA ' + res.status + ' for ' + path);
  return res.json();
}

/**
 * `frc604` -> 604, and `frc604B` -> 604.
 *
 * The suffix matters: offseason events field B-teams routinely and TBA keys
 * them `frc604B`, which `Number()` turns into NaN. 2026sunshow alone has three
 * (604B, 5507B, 6884B), and a NaN in the schedule is a team that can never be
 * matched -- silently capping identification at 5 of 6 for every match those
 * teams play, with no error anywhere to explain it.
 *
 * Dropping the suffix is right because it is what the OCR can see: the digit
 * whitelist reads `604B` as `604` regardless. It does mean an event fielding
 * both 604 and 604B (2026sunshow does) has one genuinely ambiguous team, which
 * is exactly the case the set-match margin rule exists to survive -- the other
 * five teams decide it.
 */
const teamNumber = (key) => Number(String(key).replace(/^frc/, '').replace(/\D.*$/, ''));

/**
 * The qualification schedule for an event, in the shape identification wants.
 *
 * Quals only, matching the tracker's existing filter and the scope this
 * pipeline was specified for.
 */
export async function fetchQualSchedule(eventKey) {
  const raw = await tba('/event/' + eventKey + '/matches/simple');
  if (!raw) return null;
  return raw
    .filter((m) => m.comp_level === 'qm')
    .map((m) => ({
      matchKey: m.key,
      matchNumber: m.match_number,
      blue: (m.alliances?.blue?.team_keys ?? []).map(teamNumber),
      red: (m.alliances?.red?.team_keys ?? []).map(teamNumber),
      teams: [
        ...(m.alliances?.blue?.team_keys ?? []),
        ...(m.alliances?.red?.team_keys ?? []),
      ].map(teamNumber),
      // Kept because the wall-clock fallback needs them, and because TBA's
      // actual_time is the only independent check on a start we measured
      // ourselves.
      actualTime: m.actual_time ?? null,
      predictedTime: m.predicted_time ?? null,
      // Present once TBA has posted results, null before. `/matches/simple`
      // already carries this -- the reconcile pass (worker/src/reconcile.mjs)
      // re-fetches this same endpoint later, once scores exist, rather than
      // needing the heavier `/matches` + `score_breakdown`.
      blueScore: m.alliances?.blue?.score ?? null,
      redScore: m.alliances?.red?.score ?? null,
    }))
    .sort((a, b) => a.matchNumber - b.matchNumber);
}

const invokedDirectly =
  process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('worker/src/tba.mjs');

if (invokedDirectly) {
  const eventKey = process.argv[2];
  if (!eventKey) {
    console.error('usage: node worker/src/tba.mjs <eventKey>');
    process.exit(1);
  }
  const sched = await fetchQualSchedule(eventKey);
  if (!sched) {
    console.error(eventKey + ': not found on TBA');
    process.exit(1);
  }
  console.error(eventKey + ': ' + sched.length + ' qualification matches');
  for (const m of sched.slice(0, 10)) {
    console.error(
      '  ' + String(m.matchNumber).padStart(3) + '  blue ' + m.blue.join(' ') +
        '   red ' + m.red.join(' ')
    );
  }
}
