/**
 * The browser-only edge of the CV pipeline.
 *
 * Everything in `imagePipeline.ts`, `scoreboardOcr.core.ts` and
 * `matchClock.ts` is plain typed-array maths that compiles for Node as well as
 * the browser. The two things that genuinely need a DOM — turning a `<video>`
 * into pixels, and turning a grayscale plane into something a canvas can
 * paint — are collected here so that boundary is a file rather than a
 * convention. A Node worker imports everything except this module.
 */

import { GrayPlane, grayToRgba } from './imagePipeline';

/** Wrap a grayscale plane as `ImageData` for painting into a preview canvas. */
export function grayToImageData(plane: GrayPlane): ImageData {
  return new ImageData(grayToRgba(plane), plane.width, plane.height);
}

/**
 * Draw a video frame (or any drawable) into a scratch canvas and read it back.
 *
 * Throws `SecurityError` when the source is cross-origin, because the canvas
 * is tainted and the browser refuses `getImageData`. Callers must catch that
 * and explain it — it is the single most confusing failure in this pipeline,
 * since the video plays perfectly while being unreadable.
 */
export function captureFrame(
  source: CanvasImageSource,
  width: number,
  height: number
): ImageData | null {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}
