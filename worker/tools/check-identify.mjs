/**
 * Can the worker name the match it just watched?
 *
 * The clips are named after the quals they are, so the answer is checkable —
 * but nothing in the pipeline is told the name. It reads the plates, matches
 * the numbers against the event's real schedule from TBA, and has to land on
 * the right key out of 74.
 *
 * Two failures are counted separately and they are not equally bad. An
 * ABSTENTION costs a dashboard row for a human to assign. A WRONG key upserts
 * over a good log and destroys it. The bar for this to pass is zero wrong, and
 * abstentions merely reported.
 *
 *   node worker/tools/check-identify.mjs [eventKey]
 */

import { identify, matchBySet } from '../src/identify.mjs';
import { fetchQualSchedule } from '../src/tba.mjs';
import { scan } from '../src/scan.mjs';
import { probe } from '../src/ffmpeg.mjs';
import { createPool } from '../src/ocr.mjs';
import { join } from 'node:path';

const CLIP_DIR = process.env.CLIP_DIR || 'C:/Users/kianz/OneDrive/Desktop/GlendaleVids';
const EVENT = process.argv[2] || '2026cagle';

/** clip -> the qual it actually is, from the filename. */
const CLIPS = [
  ['Qual2.mp4', 2],
  ['Qual3.mp4', 3],
  ['Qual6.mp4', 6],
  ['Qual9.mp4', 9],
];

const schedule = await fetchQualSchedule(EVENT);
if (!schedule) {
  console.error(EVENT + ': not on TBA');
  process.exit(1);
}
console.log(EVENT + ': ' + schedule.length + ' qualification matches\n');

const pool = await createPool();
let correct = 0;
let abstained = 0;
let wrong = 0;

try {
  for (const [file, truthNumber] of CLIPS) {
    const input = join(CLIP_DIR, file);
    const meta = await probe(input);

    // The green flag comes from the scanner, not from a constant: this is the
    // handoff the live pipeline actually makes.
    const found = await scan(input, { pool, meta, log: () => {} });
    const t0 = found.length ? found[0].greenFlagAt : 0;
    const quads = found.length ? found[0].quads : undefined;

    const r = await identify(input, t0, schedule, { pool, meta, quads });
    const want = EVENT + '_qm' + truthNumber;

    let verdict;
    if (r.matchKey === null) {
      verdict = 'ABSTAIN';
      abstained++;
    } else if (r.matchKey === want) {
      verdict = 'ok';
      correct++;
    } else {
      verdict = 'WRONG';
      wrong++;
    }

    console.log(
      file.padEnd(11) + ' t0=' + String(t0).padStart(5) +
        '  -> ' + String(r.matchKey ?? '(none)').padEnd(16) +
        ' want ' + want.padEnd(16) + verdict
    );
    if (r.seen) {
      console.log('     read blue [' + r.seen.blue.join(' ') + ']  red [' + r.seen.red.join(' ') + ']');
    }
    if (r.matchKey) console.log('     score ' + r.score + '/6, runner-up ' + r.runnerUp);
    else console.log('     ' + r.reason);
  }
} finally {
  await pool.terminate();
}

console.log(
  '\n' + correct + ' correct, ' + abstained + ' abstained, ' + wrong + ' wrong'
);
if (wrong) console.log('FAIL — a wrong key overwrites a good log.');
process.exit(wrong === 0 ? 0 : 1);
