/**
 * Copy the tesseract.js worker + tesseract.js-core WASM builds into
 * `public/tesseract/` so the CV Scoreboard Tracker runs entirely offline.
 *
 * tesseract.js otherwise pulls these from jsDelivr at runtime, which is exactly
 * what we cannot rely on at a competition venue. Re-run this after bumping
 * either package (`node scripts/copy-tesseract.mjs`).
 *
 * The language data (`eng.traineddata.gz`) is NOT on npm — it is committed
 * alongside these files, fetched once from tessdata:
 *   https://tessdata.projectnaptha.com/4.0.0_fast/eng.traineddata.gz
 */
import { copyFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'tesseract');
mkdirSync(out, { recursive: true });

// Only the LSTM cores: we never enable the legacy engine, and the non-LSTM
// builds are dead weight. All three SIMD tiers ship because getCore() picks
// one based on the operator's browser.
const files = [
  ['node_modules/tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ['node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js', 'tesseract-core-lstm.wasm.js'],
  ['node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js'],
  [
    'node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js',
    'tesseract-core-relaxedsimd-lstm.wasm.js',
  ],
];

for (const [from, to] of files) {
  const src = join(root, from);
  if (!existsSync(src)) {
    console.error(`copy-tesseract: missing ${from} — run npm install first`);
    process.exit(1);
  }
  copyFileSync(src, join(out, to));
  console.log(`copied ${to} (${(statSync(src).size / 1e6).toFixed(2)} MB)`);
}

// Fail rather than warn. Without the language data the OCR worker still
// starts and then reads nothing, which looks like "the CV tracker is broken"
// at a competition rather than "a file is missing" at build time.
if (!existsSync(join(out, 'eng.traineddata.gz'))) {
  console.error(
    'copy-tesseract: public/tesseract/eng.traineddata.gz is missing.\n' +
      'It is tracked in git (not on npm), so this usually means a bad checkout.\n' +
      'Restore it with:\n' +
      '  curl -sSL -o public/tesseract/eng.traineddata.gz \\\n' +
      '    https://tessdata.projectnaptha.com/4.0.0_fast/eng.traineddata.gz'
  );
  process.exit(1);
}
