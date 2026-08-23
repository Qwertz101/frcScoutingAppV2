/**
 * Browser adapter over the DOM-free OCR core.
 *
 * The core (`scoreboardOcr.core.ts`) knows how to read a scoreboard out of raw
 * pixels and nothing else — no asset paths, no canvas, no `import.meta`. That
 * is what lets a Node worker run the identical recognition code against
 * ffmpeg-decoded frames instead of maintaining a second implementation that
 * would drift.
 *
 * This file supplies the two browser-specific answers: where the self-hosted
 * tesseract assets live under the app's deploy sub-path, and how to turn a
 * `<video>` into pixels. Everything else is re-exported unchanged, so the
 * module path every component already imports stays exactly as it was.
 */

import { OcrConfig, OcrHandle, createOcr } from './scoreboardOcr.core';

export * from './scoreboardOcr.core';

/**
 * Where the self-hosted assets live. `BASE_URL` matters: this app deploys under
 * a GitHub Pages sub-path, so an absolute `/tesseract/` would 404 in production.
 */
function assetBase(): string {
  const base = import.meta.env.BASE_URL || '/';
  return `${base.replace(/\/$/, '')}/tesseract`;
}

/** Browser asset layout for the tesseract worker. */
export function browserOcrConfig(
  onProgress?: (status: string, progress: number) => void
): OcrConfig {
  const base = assetBase();
  return {
    workerPath: `${base}/worker.min.js`,
    corePath: base,
    langPath: base,
    workerBlobURL: true,
    logger: onProgress,
  };
}

/** Boot (or reuse) the digit-only OCR worker, with the browser's asset paths. */
export function getOcr(
  onProgress?: (status: string, progress: number) => void
): Promise<OcrHandle> {
  return createOcr(browserOcrConfig(onProgress));
}
