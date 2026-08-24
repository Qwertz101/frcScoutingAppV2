/**
 * What does the detector actually see on this footage?
 *
 * Every new event brings a new scoreboard layout, and the failure mode is
 * always the same shape: the detector returns *something*, the numbers look
 * plausible, and only rendering the crop shows it locked onto the alliance
 * label or a bonus counter instead of the score. Guessing from the summary
 * numbers wasted real time on both IRI and Sunset Showdown, so this exists to
 * make the first question "what is it looking at" rather than "why is the
 * score wrong".
 *
 *   node worker/tools/layout-probe.mjs <file-or-url> <seconds> [prefix] [--layout <name>] [--ink]
 *
 * `--ink` prints the per-column ink profile across the scoreboard at the score's
 * own rows. That is the measurement that explains *why* a score box landed
 * where it did, and it is worth reaching for early: on Sunset Showdown it
 * showed in one line that the 19 columns the detector had latched onto were the
 * white timer badge running at ~1.0 ink, brighter than the digits beside it at
 * 0.78 -- so the obvious fix of raising the brightness floor would have kept the
 * badge and dropped the score.
 *
 * Writes, next to each other, into the temp dir:
 *   <prefix>_frame.png   the whole frame
 *   <prefix>_blue.png    what `readFrame` would hand tesseract for blue
 *   <prefix>_red.png     ditto red
 *   <prefix>_timer.png   ditto the clock
 * and prints the quads plus the top scoring band candidates.
 */

import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { frames, probe, resolveBin } from '../src/ffmpeg.mjs';
import { isRemoteSource, resolveVodUrl } from '../src/sources.mjs';
import {
  detectScoreRegionsStable,
  analyzeBands,
  isOverlayPresent,
  rectifyToGray,
  SCORE_RECT_W,
  SCORE_RECT_H,
  REPO_ROOT,
  LAYOUTS,
  FRC_BROADCAST,
} from '../src/core.mjs';

const require = createRequire(import.meta.url);
const pipeline = require(join(REPO_ROOT, 'worker/gen/services/cv/imagePipeline.js'));
const { grayToBmp } = require(join(REPO_ROOT, 'worker/gen/services/cv/encodeImage.js'));

const OUT = tmpdir();

function ff(args) {
  return new Promise((res) =>
    spawn(resolveBin('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      stdio: 'inherit',
    }).on('close', res)
  );
}

async function savePlane(plane, name) {
  const bmp = join(OUT, name + '.bmp');
  writeFileSync(bmp, Buffer.from(grayToBmp(plane)));
  await ff(['-i', bmp, join(OUT, name + '.png')]);
  return join(OUT, name + '.png');
}

const input0 = process.argv[2];
const at = Number(process.argv[3] ?? 0);
const prefix = process.argv[4] && !process.argv[4].startsWith('--') ? process.argv[4] : 'probe';
const showInk = process.argv.includes('--ink');
const li = process.argv.indexOf('--layout');
const layoutName = li >= 0 ? process.argv[li + 1] : FRC_BROADCAST.name;
const profile = LAYOUTS[layoutName];
if (!profile) {
  console.error('unknown layout "' + layoutName + '". known: ' + Object.keys(LAYOUTS).join(', '));
  process.exit(1);
}
if (!input0) {
  console.error('usage: node worker/tools/layout-probe.mjs <file-or-url> <seconds> [prefix]');
  process.exit(1);
}

const input = isRemoteSource(input0) ? await resolveVodUrl(input0) : input0;
const meta = await probe(input);
console.log(
  meta.width + 'x' + meta.height + '  ' + (meta.duration / 3600).toFixed(2) +
    'h  at t=' + at + '  layout=' + profile.name
);

// Three frames a few seconds apart: `detectScoreRegionsStable` is what the
// pipeline actually uses, and it deliberately refuses a single-frame fluke.
const shots = [];
for (const dt of [0, 6, 12]) {
  for await (const f of frames(input, {
    start: at + dt, duration: 1, fps: 1, width: meta.width, height: meta.height,
  })) {
    shots.push({ data: f.data, width: f.width, height: f.height });
    break;
  }
}
console.log('frames grabbed: ' + shots.length);

await ff(['-ss', String(at), '-i', input, '-frames:v', '1', join(OUT, prefix + '_frame.png')]);
console.log('whole frame -> ' + join(OUT, prefix + '_frame.png'));

const quads = detectScoreRegionsStable(shots, profile);
if (!quads) {
  console.log('\ndetectScoreRegionsStable: NO CONSENSUS');
} else {
  const px = (q) => {
    const xs = q.map((p) => p.x * meta.width);
    const ys = q.map((p) => p.y * meta.height);
    return 'x ' + Math.round(Math.min(...xs)) + '-' + Math.round(Math.max(...xs)) +
      '  y ' + Math.round(Math.min(...ys)) + '-' + Math.round(Math.max(...ys));
  };
  console.log('\nquads (pixels):');
  for (const k of ['blue', 'red', 'timer']) console.log('  ' + k.padEnd(6) + px(quads[k]));
  console.log('  overlay present: ' + isOverlayPresent(shots[0], quads.blue, quads.red));

  for (const side of ['blue', 'red', 'timer']) {
    const gray = rectifyToGray(shots[0], quads[side], SCORE_RECT_W, SCORE_RECT_H);
    if (!gray) { console.log('  ' + side + ': rectify failed'); continue; }
    const plane = { data: gray, width: SCORE_RECT_W, height: SCORE_RECT_H };
    // Same chain `preprocessCrop` runs before tesseract sees anything.
    const g = pipeline.normalizePolarity(pipeline.contrastStretch(plane));
    const bin = pipeline.fixBinaryPolarity(
      pipeline.sauvolaThreshold(pipeline.upscale(g, 2), undefined, 0.2)
    );
    console.log('  ' + side + ' crop -> ' + (await savePlane(bin, prefix + '_' + side)));
  }
}

if (showInk && quads) {
  const W = meta.width;
  const f0 = shots[0];
  const lum = (i) => (f0.data[i] * 299 + f0.data[i + 1] * 587 + f0.data[i + 2] * 114) / 1000;
  const ys = quads.blue.map((q) => q.y * meta.height);
  const y0 = Math.round(Math.min(...ys));
  const y1 = Math.round(Math.max(...ys));
  const rows = y1 - y0 + 1;

  // A window centred on the scoreboard: everything between the plates plus as
  // much again either side, which is where the team boxes and any fractions or
  // bonus counters sharing the bar will be.
  const allX = [...quads.blue, ...quads.red].map((q) => q.x * W);
  const lo = Math.min(...allX);
  const hi = Math.max(...allX);
  const span = hi - lo;
  const xa = Math.max(0, Math.round(lo - span * 0.9));
  const xb = Math.min(W - 1, Math.round(hi + span * 0.9));

  const frac = [];
  for (let x = xa; x <= xb; x++) {
    let n = 0;
    for (let y = y0; y <= y1; y++) if (lum((y * W + x) * 4) >= 175) n++;
    frac.push(n / rows);
  }
  let line = '';
  for (let i = 0; i < frac.length; i += 4) {
    const m = Math.max(...frac.slice(i, i + 4));
    line += m === 0 ? '.' : String(Math.min(9, Math.round(m * 9)));
  }
  console.log(
    '\nink profile, rows y=' + y0 + '-' + y1 + ', x=' + xa + '..' + xb +
      '  (one char = 4px, 0-9 = ink fraction, 9 = solid)'
  );
  console.log(line);
  const mark = (q, ch) => {
    const a = Math.round(Math.min(...q.map((pt) => pt.x * W)));
    const b = Math.round(Math.max(...q.map((pt) => pt.x * W)));
    return [Math.floor((a - xa) / 4), Math.floor((b - xa) / 4), ch];
  };
  const marks = [mark(quads.red, 'R'), mark(quads.timer, 'T'), mark(quads.blue, 'B')];
  let ruler = '';
  for (let i = 0; i < line.length; i++) {
    const hit = marks.find((m) => i >= m[0] && i <= m[1]);
    ruler += hit ? hit[2] : ' ';
  }
  console.log(ruler + '   <- R/T/B = where the quads landed');
}

const bands = analyzeBands(shots[0], profile);
const ok = bands.filter((b) => !b.reject).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
console.log('\n' + bands.length + ' candidate bands, ' + ok.length + ' accepted. Top 6:');
for (const b of ok.slice(0, 6)) {
  console.log(
    '  y=' + String(b.by0).padStart(4) + '-' + String(b.by1).padEnd(4) +
      ' h=' + String(b.bandH).padStart(3) +
      '  score=' + (b.score?.toFixed(3) ?? '?') +
      '  sym=' + (b.symmetry?.toFixed(2) ?? '?') +
      '  fill=' + (b.fill?.toFixed(2) ?? '?') +
      '  plateLuma=' + (b.plateLuma?.toFixed(0) ?? '?') +
      '  plateFlat=' + (b.plateFlat?.toFixed(2) ?? '?')
  );
}
const rejectCounts = {};
for (const b of bands) if (b.reject) rejectCounts[b.reject] = (rejectCounts[b.reject] ?? 0) + 1;
console.log('\nrejections: ' + JSON.stringify(rejectCounts));
