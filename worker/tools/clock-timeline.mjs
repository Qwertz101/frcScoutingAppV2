/**
 * What does the match clock actually do across this recording?
 *
 * The scanner's job is to find green flags, and when it gets that wrong the
 * symptom downstream is indirect -- a match logged over half its seconds, or
 * one missed entirely -- which is very hard to reason about from the summary.
 * This answers the prior question directly: read the clock every few seconds
 * for the whole file and print what it says.
 *
 * A countdown that resets to full is a match starting, so the timeline shows
 * every real start whether or not `scan.mjs` found it. That makes it possible
 * to grade the scanner against the truth instead of against a guess.
 *
 *   node worker/tools/clock-timeline.mjs <file> [--layout iri] [--step 3]
 *                                        [--start 0] [--duration 1800]
 *
 * Prints one line per sample where the clock was readable, plus a summary of
 * inferred match starts (a reading that jumped UP, i.e. a fresh countdown).
 */

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { frames, probe } from '../src/ffmpeg.mjs';
import { createPool, defaultWorkers } from '../src/ocr.mjs';
import {
  detectScoreRegionsStable,
  rectifyToGray,
  recognizeTimer,
  SCORE_RECT_W,
  SCORE_RECT_H,
  REPO_ROOT,
  LAYOUTS,
  FRC_BROADCAST,
  AUTO_LEN,
  TELEOP_LEN,
} from '../src/core.mjs';

const flag = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
};

const input = process.argv[2];
if (!input) {
  console.error('usage: node worker/tools/clock-timeline.mjs <file> [--layout n] [--step s]');
  process.exit(1);
}
const layout = LAYOUTS[flag('layout', FRC_BROADCAST.name)];
if (!layout) {
  console.error('unknown layout. known: ' + Object.keys(LAYOUTS).join(', '));
  process.exit(1);
}
const step = Number(flag('step', 3));
const start = Number(flag('start', 0));

const meta = await probe(input);
const duration = Number(flag('duration', meta.duration - start));
console.error(
  meta.width + 'x' + meta.height + '  layout=' + layout.name +
    '  sampling every ' + step + 's from ' + start + ' for ' + duration.toFixed(0) + 's'
);

/**
 * Quads once, from a window where the overlay is actually up.
 *
 * Sampling seven frames spread across the whole recording does NOT work: most
 * of an event is not a match, so the spread lands mostly on crowd shots and
 * pit footage and consensus is never reached. Walk forward in match-length
 * windows instead and take the first that agrees with itself -- the overlay
 * does not move once found, so one window's answer serves the whole file.
 */
async function findQuads() {
  const WIN = 180;
  for (let from = start; from < start + duration; from += WIN) {
    const shots = [];
    for (let i = 0; i < 7; i++) {
      const at = from + (WIN * (i + 0.5)) / 7;
      for await (const f of frames(input, { start: at, duration: 1, fps: 1, width: meta.width, height: meta.height })) {
        shots.push({ data: f.data, width: f.width, height: f.height });
        break;
      }
    }
    if (shots.length < 3) continue;
    const q = detectScoreRegionsStable(shots, layout);
    if (q) {
      console.error('quads from the window at ' + Math.round(from) + 's');
      return q;
    }
  }
  return null;
}

const quads = await findQuads();
if (!quads) {
  console.error('no stable quads anywhere — cannot read a clock');
  process.exit(1);
}

const pool = await createPool(defaultWorkers());
const samples = [];

try {
  for await (const f of frames(input, {
    start, duration, fps: 1 / step, width: meta.width, height: meta.height,
  })) {
    const gray = rectifyToGray(f, quads.timer, SCORE_RECT_W, SCORE_RECT_H);
    if (!gray) continue;
    const plane = { data: gray, width: SCORE_RECT_W, height: SCORE_RECT_H };
    const t = await pool.run((w) => recognizeTimer(w, plane));
    samples.push({ at: f.at, text: t?.text ?? '', remaining: t ? t.remaining : null });
  }
} finally {
  await pool.terminate();
}

const readable = samples.filter((s) => s.remaining !== null);
console.error(
  '\n' + readable.length + ' of ' + samples.length + ' samples readable (' +
    ((readable.length / Math.max(1, samples.length)) * 100).toFixed(0) + '%)\n'
);

for (const s of samples) {
  console.log(
    String(Math.round(s.at)).padStart(6) + 's  ' +
      (s.remaining === null ? '(unreadable)' : String(s.remaining).padStart(4) + 's left') +
      '   "' + s.text.replace(/\n/g, ' ') + '"'
  );
}

// A fresh countdown is one that reads HIGHER than the previous sample: the
// clock only ever counts down within a match, so an increase means a new one
// began. Reported with the sample before it, since the true start lies between.
console.error('\ninferred match starts (clock jumped up):');
let prev = null;
for (const s of readable) {
  if (prev && s.remaining > prev.remaining + step) {
    const phase = s.remaining > AUTO_LEN + 5 ? 'teleop' : 'auto';
    console.error(
      '  between ' + Math.round(prev.at) + 's and ' + Math.round(s.at) + 's  ' +
        '(' + prev.remaining + 's left -> ' + s.remaining + 's left, looks like ' + phase + ')'
    );
  }
  prev = s;
}
console.error('\nAUTO_LEN=' + AUTO_LEN + '  TELEOP_LEN=' + TELEOP_LEN);
