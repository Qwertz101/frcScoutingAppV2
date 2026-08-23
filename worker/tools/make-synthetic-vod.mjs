/**
 * Build a multi-match VOD out of the single-match clips.
 *
 * Every clip we have locally is exactly one match, so there is nothing to test
 * the scanner's actual job against: finding where matches *start* inside a long
 * recording, and — harder — not finding them where they do not.
 *
 * The filler between matches is deliberately not a test pattern. It is the same
 * arena footage, cropped so the scoreboard is off-frame and rescaled back to
 * full size. Two crops are used: the upper part of the frame, which contains
 * the venue lighting truss that the detector originally mistook for a
 * scoreboard, and the lower part, which is field and crowd. A colour-bar filler
 * would be rejected trivially and would prove nothing.
 *
 * Writes the VOD next to a JSON manifest of where each match really begins, so
 * the scanner can be scored rather than eyeballed.
 *
 *   node worker/tools/make-synthetic-vod.mjs [outDir]
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBin, probe } from '../src/ffmpeg.mjs';

const CLIP_DIR = process.env.CLIP_DIR || 'C:/Users/kianz/OneDrive/Desktop/GlendaleVids';
const OUT_DIR = join(CLIP_DIR, 'synthetic');

/**
 * `--hold` builds the harder variant: the filler between matches is a frozen
 * end-of-match scoreboard rather than scoreboard-free footage.
 *
 * This is what real broadcasts do — the overlay stays up showing the previous
 * result or the next lineup — and it is the case that breaks the naive reading
 * of Tier A, because every match then merges into one continuous run and
 * "one run, one match" silently loses four matches out of five.
 */
const HOLD = process.argv.includes('--hold');
const NAME = HOLD ? 'synthetic-vod-hold' : 'synthetic-vod';

/** One consistent stream geometry, as a real broadcast would have. */
const W = 1280;
const H = 720;
const FPS = 30;

const CLIPS = ['Einstein1', 'Qual2', 'Qual3', 'Qual6', 'Qual9'];
/** Seconds of scoreboard-free footage between matches. */
const FILLER = 75;
/** Seconds of filler before the first match, so nothing starts at t=0. */
const LEAD_IN = 45;

function run(args) {
  return new Promise((resolve, reject) => {
    const c = spawn(resolveBin('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    c.on('error', reject);
    c.on('close', (code) => (code ? reject(new Error('ffmpeg exited ' + code)) : resolve()));
  });
}

/** Normalise one segment to the common geometry. */
function encode(input, filter, duration, dest, start) {
  const args = [];
  if (start != null) args.push('-ss', String(start));
  args.push('-i', input);
  if (duration != null) args.push('-t', String(duration));
  args.push(
    '-vf', filter + ',scale=' + W + ':' + H + ',fps=' + FPS,
    '-an',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    dest
  );
  return run(args);
}

mkdirSync(OUT_DIR, { recursive: true });
const work = join(OUT_DIR, 'parts');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

/* ---- filler: real arena footage with the scoreboard cropped away ---- */

const fillerSrc = HOLD
  ? [
      // A frozen final-score plate: the scoreboard is up, the clock reads 0:00
      // and nothing moves. Tier A sees this as continuous overlay.
      { name: 'hold1', clip: 'Einstein1', hold: 170 },
      { name: 'hold2', clip: 'Qual6', hold: 166 },
    ]
  : [
      // Upper frame: keeps the lighting truss, excludes the scoreboard band.
      { name: 'truss', clip: 'Einstein1', filter: 'crop=in_w:380:0:0' },
      // Lower frame: field and crowd.
      { name: 'field', clip: 'Qual6', filter: 'crop=in_w:800:0:686' },
    ];

console.log('building filler (' + (HOLD ? 'scoreboard hold' : 'scoreboard-free') + ')...');
for (const f of fillerSrc) {
  const dest = join(work, f.name + '.mp4');
  if (f.hold != null) {
    // One frame, held. `-loop 1` over a single extracted frame is the most
    // faithful way to get "the overlay is up and completely static".
    const still = join(work, f.name + '.png');
    await run(['-ss', String(f.hold), '-i', join(CLIP_DIR, f.clip + '.mp4'), '-frames:v', '1', still]);
    await run([
      '-loop', '1', '-i', still, '-t', String(FILLER),
      '-vf', 'scale=' + W + ':' + H + ',fps=' + FPS,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', dest,
    ]);
  } else {
    await encode(join(CLIP_DIR, f.clip + '.mp4'), f.filter, FILLER, dest, 40);
  }
}

/* ---- matches ---- */

const parts = [];
const manifest = [];
let cursor = 0;

/** Append a segment and advance the timeline cursor. */
function push(file, duration) {
  parts.push(file);
  const at = cursor;
  cursor += duration;
  return at;
}

console.log('normalising clips...');

// Lead-in, so nothing starts at t=0.
await encode(join(CLIP_DIR, 'Einstein1.mp4'), 'crop=in_w:380:0:0', LEAD_IN, join(work, 'lead.mp4'), 40);
push(join(work, 'lead.mp4'), LEAD_IN);

for (let i = 0; i < CLIPS.length; i++) {
  const name = CLIPS[i];
  const src = join(CLIP_DIR, name + '.mp4');
  const meta = await probe(src);
  const dest = join(work, 'm' + i + '.mp4');
  await encode(src, 'null', null, dest, null);
  const at = push(dest, meta.duration);
  manifest.push({ clip: name, offset: Number(at.toFixed(3)), duration: meta.duration });
  console.log('  ' + name + ' at ' + at.toFixed(1) + 's');

  if (i < CLIPS.length - 1) {
    const f = fillerSrc[i % fillerSrc.length];
    push(join(work, f.name + '.mp4'), FILLER);
  }
}

/* ---- concat ---- */

const listFile = join(work, 'list.txt');
writeFileSync(listFile, parts.map((p) => "file '" + p.replace(/\\/g, '/') + "'").join('\n') + '\n');

const vod = join(OUT_DIR, NAME + '.mp4');
console.log('concatenating -> ' + vod);
await run(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', vod]);

const manifestPath = join(OUT_DIR, NAME + '.json');
writeFileSync(
  manifestPath,
  JSON.stringify(
    {
      note: 'offset is where each clip begins in the VOD. The green flag is a few ' +
        'seconds later, inside the clip -- see clipT0 once measured.',
      width: W,
      height: H,
      fps: FPS,
      filler: HOLD ? 'frozen end-of-match scoreboard' : 'scoreboard-free arena footage',
      fillerSeconds: FILLER,
      leadInSeconds: LEAD_IN,
      matches: manifest,
    },
    null,
    2
  )
);

const total = await probe(vod);
console.log(
  '\n' + vod + '\n  ' + total.width + 'x' + total.height + '  ' +
    (total.duration / 60).toFixed(1) + ' min,  ' + manifest.length + ' matches'
);
console.log('  manifest: ' + manifestPath);
if (existsSync(work)) rmSync(work, { recursive: true, force: true });
