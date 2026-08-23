/**
 * Bridge to the shared CV core.
 *
 * `worker/gen` is a throwaway CommonJS compile of the same `src/services/cv`
 * files the browser app ships — not a copy, not a port. That is the entire
 * point of the M2 refactor: there is one implementation of the recognition
 * chain, and a bug fixed for the operator is fixed for the worker in the same
 * commit. Follows the pattern already proven in `research/bps-fuzzy/run.mjs`.
 *
 * Run `npm run worker:build` after touching anything under `src/services/cv`.
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

export const WORKER_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
export const REPO_ROOT = dirname(WORKER_DIR);

const GEN = join(WORKER_DIR, 'gen');
if (!existsSync(GEN)) {
  throw new Error('worker/gen is missing. Run: npm run worker:build');
}

export const pipeline = require(join(GEN, 'services/cv/imagePipeline.js'));
export const ocrCore = require(join(GEN, 'services/cv/scoreboardOcr.core.js'));
export const clock = require(join(GEN, 'services/cv/matchClock.js'));
export const types = require(join(GEN, 'types/index.js'));

export const { detectScoreRegions, detectScoreRegionsStable, isOverlayPresent } = pipeline;
export const { bootOcr, createOcr, readFrame, recognizeTimer, recognizeCrop, ScoreGate } = ocrCore;
export const { MatchClock, parseTimerText } = clock;
export const { AUTO_LEN, MATCH_LEN, TELEOP_LEN } = types;

/**
 * Where tesseract's assets live for Node.
 *
 * `langPath` deliberately points at `public/tesseract`, the *same*
 * `eng.traineddata.gz` the browser downloads. Pointing Node at a separately
 * fetched copy would be the easiest possible way to make the worker and the
 * app disagree about what a digit looks like.
 */
export function nodeOcrConfig(logger) {
  return {
    workerPath: join(REPO_ROOT, 'node_modules/tesseract.js/src/worker-script/node/index.js'),
    corePath: join(REPO_ROOT, 'node_modules/tesseract.js-core'),
    langPath: join(REPO_ROOT, 'public/tesseract'),
    workerBlobURL: false,
    logger,
  };
}
