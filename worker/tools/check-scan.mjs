/**
 * Score the scanner against the synthetic multi-match VOD.
 *
 * Two things have to be true, and they are different claims:
 *
 *   1. The right NUMBER of matches, in the right places. Missing one loses a
 *      match; inventing one from a replay or the lighting truss is worse,
 *      because it goes on to be processed and identified as something.
 *
 *   2. The starts have to be accurate enough to process from. The ground truth
 *      is not hand-labelled -- each clip is scanned standalone first, and the
 *      expected position in the VOD is that clip's own green flag plus the
 *      offset the VOD was built at. So this checks the scanner against itself
 *      under a much harder condition: 1280x720 instead of ~2630 native, with
 *      75 seconds of scoreboard-free arena footage on either side.
 *
 * Build the VOD first:
 *   node worker/tools/make-synthetic-vod.mjs
 *   node worker/tools/check-scan.mjs
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { scan } from '../src/scan.mjs';
import { probe } from '../src/ffmpeg.mjs';
import { createPool } from '../src/ocr.mjs';

const CLIP_DIR = process.env.CLIP_DIR || 'C:/Users/kianz/OneDrive/Desktop/GlendaleVids';
const VOD = process.argv[2] || join(CLIP_DIR, 'synthetic', 'synthetic-vod.mp4');
const MANIFEST = VOD.replace(/\.mp4$/, '.json');

/** How far a detected start may sit from the truth and still be usable. */
const TOLERANCE = 3;

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const pool = await createPool();

try {
  /* ---- ground truth: each clip's own green flag, measured standalone ---- */

  console.log('measuring each clip standalone...');
  const truth = [];
  for (const m of manifest.matches) {
    const clip = join(CLIP_DIR, m.clip + '.mp4');
    const found = await scan(clip, { pool });
    if (found.length !== 1) {
      console.log('  ! ' + m.clip + ': expected 1 match standalone, got ' + found.length);
    }
    const t0 = found.length ? found[0].greenFlagAt : null;
    truth.push({ ...m, clipT0: t0, expected: t0 === null ? null : m.offset + t0 });
    console.log(
      '  ' + m.clip.padEnd(11) + ' green flag ' + (t0 === null ? '??' : t0 + 's') +
        ' into the clip  ->  expect ' + (t0 === null ? '??' : (m.offset + t0).toFixed(1)) + 's in the VOD'
    );
  }

  /* ---- the scan under test ---- */

  const meta = await probe(VOD);
  console.log(
    '\nscanning ' + meta.width + 'x' + meta.height + ', ' +
      (meta.duration / 60).toFixed(1) + ' min...'
  );
  const began = Date.now();
  const found = await scan(VOD, { pool, meta, log: () => {} });
  const secs = ((Date.now() - began) / 1000).toFixed(1);

  /* ---- score ---- */

  console.log('\nfound ' + found.length + ' match(es) in ' + secs + 's, expected ' + truth.length);

  const used = new Set();
  let ok = 0;
  for (const t of truth) {
    if (t.expected === null) continue;
    let best = -1;
    let bestErr = Infinity;
    found.forEach((f, i) => {
      if (used.has(i)) return;
      const err = Math.abs(f.greenFlagAt - t.expected);
      if (err < bestErr) {
        bestErr = err;
        best = i;
      }
    });
    const hit = best >= 0 && bestErr <= TOLERANCE;
    if (hit) {
      used.add(best);
      ok++;
    }
    console.log(
      '  ' + t.clip.padEnd(11) +
        ' expect ' + t.expected.toFixed(1).padStart(7) +
        '  got ' + (best >= 0 ? String(found[best].greenFlagAt).padStart(7) : '   none') +
        '  err ' + (bestErr === Infinity ? '--' : bestErr.toFixed(2) + 's').padStart(7) +
        '  ' + (hit ? 'ok' : 'MISS') +
        (best >= 0 ? '  [' + found[best].method + ']' : '')
    );
  }

  const spurious = found.length - used.size;
  console.log(
    '\n' + ok + '/' + truth.length + ' matched within ' + TOLERANCE + 's,  ' +
      spurious + ' spurious'
  );
  process.exit(ok === truth.length && spurious === 0 ? 0 : 1);
} finally {
  await pool.terminate();
}
