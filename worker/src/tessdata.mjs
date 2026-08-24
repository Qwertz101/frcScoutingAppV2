/**
 * Materialise `./eng.traineddata`, relative to wherever `node` was invoked.
 *
 * That relative path is not a choice made anywhere in this codebase -- it is
 * where the compiled tesseract engine looks, hardcoded, when neither
 * `TESSDATA_PREFIX` nor an explicit datapath reaches its own init call.
 * `cachePath`/`dataPath` in tesseract.js's Node worker options do NOT reach
 * it either: tried pointing both at a stable directory under `worker/`, and
 * setting `TESSDATA_PREFIX` to match, and the engine kept reporting the same
 * hardcoded relative path while the directory those options supposedly
 * control stayed empty. Whatever tesseract.js's own fetch-on-first-boot path
 * does differently, it was not observably working in this stack either -- the
 * file was present only because some earlier session's boot had, apparently
 * once, produced it by a route this investigation did not fully trace, and
 * deleting that file (mistaken for stray repo debris, since nothing in this
 * codebase names or owns it) took the whole OCR pool down.
 *
 * So: stop depending on an unreliable fetch-and-cache path for something this
 * repo already has a known-good source for. `public/tesseract/eng.traineddata.gz`
 * is committed and is the exact file the browser downloads -- decompressing it
 * directly with `node:zlib`, no tesseract.js internals involved, is a handful
 * of lines and cannot silently regress the way the implicit path did.
 */

import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { REPO_ROOT } from './core.mjs';

const SOURCE_GZ = join(REPO_ROOT, 'public/tesseract/eng.traineddata.gz');
/** A real eng.traineddata (fast model) is ~4MB. Anything smaller is not it. */
const MIN_PLAUSIBLE_BYTES = 1_000_000;

/**
 * Ensure `./eng.traineddata` exists and is plausible, regenerating it from the
 * committed source if not. Idempotent and cheap once the file is in place --
 * safe to call at the top of every entrypoint that boots an OCR worker.
 */
export function ensureTessdata() {
  const dest = join(process.cwd(), 'eng.traineddata');

  if (existsSync(dest) && statSync(dest).size >= MIN_PLAUSIBLE_BYTES) return dest;

  if (!existsSync(SOURCE_GZ)) {
    throw new Error(
      SOURCE_GZ + ' is missing -- it is tracked in git (not on npm), so this ' +
        'usually means a bad checkout. See scripts/copy-tesseract.mjs for how ' +
        'to restore it.'
    );
  }

  const decompressed = gunzipSync(readFileSync(SOURCE_GZ));
  writeFileSync(dest, decompressed);
  return dest;
}
