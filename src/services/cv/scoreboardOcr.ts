/**
 * The tesseract half of the CV Scoreboard Tracker.
 *
 * Two things matter here beyond "call recognize":
 *
 *  1. Everything is lazy and self-hosted. tesseract.js is `import()`ed only when
 *     the CV screen mounts, so the rest of this PWA never pays for it, and the
 *     worker / WASM core / language data are served from `public/tesseract/`
 *     rather than jsDelivr — a competition venue's wifi is not something to bet
 *     a scouting stream on.
 *
 *  2. A read is not trusted just because tesseract returned a number. Scores are
 *     monotonic and bounded; an implausible read is discarded in favour of the
 *     previous value and counted, so the operator can see the pipeline degrade
 *     instead of silently logging garbage.
 */

import type { Worker as TesseractWorker } from 'tesseract.js';
import {
  GrayPlane,
  PREP_VARIANTS,
  PreparedCrop,
  Quad,
  SCORE_RECT_H,
  SCORE_RECT_W,
  grayToImageData,
  isOverlayPresent,
  preprocessCrop,
  rectifyToGray,
} from './imagePipeline';

/**
 * Where the self-hosted assets live. `BASE_URL` matters: this app deploys under
 * a GitHub Pages sub-path, so an absolute `/tesseract/` would 404 in production.
 */
function assetBase(): string {
  const base = import.meta.env.BASE_URL || '/';
  return `${base.replace(/\/$/, '')}/tesseract`;
}

export interface OcrHandle {
  worker: TesseractWorker;
  terminate: () => Promise<void>;
}

let loading: Promise<OcrHandle> | null = null;

/**
 * Boot (or reuse) the digit-only OCR worker.
 *
 * PSM 7 (single text line) plus a digits-only whitelist is a large accuracy win:
 * it stops tesseract from proposing layout hypotheses for what is always one
 * short run of numerals, and removes every letter/punctuation confusion
 * (0/O, 1/l/I, 5/S, 8/B) from the candidate set outright.
 */
export function getOcr(onProgress?: (status: string, progress: number) => void): Promise<OcrHandle> {
  if (loading) return loading;

  loading = (async () => {
    const base = assetBase();
    // Dynamic import: this is the only place tesseract.js is referenced, so it
    // lands in its own chunk that the main bundle never requests.
    const Tesseract = await import('tesseract.js');

    const worker = await Tesseract.createWorker('eng', 1 /* OEM.LSTM_ONLY */, {
      workerPath: `${base}/worker.min.js`,
      corePath: base,
      langPath: base,
      gzip: true,
      // Blob-URL workers inherit the page origin, which keeps the copied
      // worker script same-origin and out of the service worker's way.
      workerBlobURL: true,
      logger: onProgress ? (m) => onProgress(m.status, m.progress) : undefined,
    });

    await worker.setParameters({
      tessedit_char_whitelist: '0123456789',
      // PSM 7 = single text line. Measured against PSM 6/8/10/13 on the
      // synthetic set: 7 wins. PSM 10 (single character, fed one segmented glyph
      // at a time) is much worse — 54% against 79% — because the LSTM is a
      // sequence model and a context-free glyph collapses toward one prior.
      tessedit_pageseg_mode: '7' as never,
      // The glyphs are normalised to a fixed pixel height; declaring a DPI stops
      // tesseract second-guessing the point size.
      user_defined_dpi: '300',
    });

    return {
      worker,
      terminate: async () => {
        loading = null;
        await worker.terminate();
      },
    };
  })();

  loading.catch(() => {
    loading = null;
  });

  return loading;
}

export interface RawRead {
  value: number | null;
  confidence: number;
  text: string;
}

/**
 * Recognize one prepared strip.
 *
 * The digit-count cross-check is the single most valuable guard in the whole
 * pipeline. Tesseract's dominant failure mode here is silently dropping a
 * digit — reading `161` as `16`, `142` as `2` — and a plausible-looking wrong
 * score is exactly what the downstream solver cannot survive. Connected-
 * component counting is near-perfect at *how many* digits there are even when
 * the recogniser is unsure *which*, so a length mismatch is an abstention.
 */
export async function recognizePlane(
  worker: TesseractWorker,
  prepared: PreparedCrop
): Promise<RawRead> {
  const { plane, digitCount } = prepared;
  const canvas = document.createElement('canvas');
  canvas.width = plane.width;
  canvas.height = plane.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { value: null, confidence: 0, text: '' };
  ctx.putImageData(grayToImageData(plane), 0, 0);

  const { data } = await worker.recognize(canvas);
  const text = (data.text || '').replace(/\D/g, '');
  const confidence = data.confidence ?? 0;
  if (!text) return { value: null, confidence: 0, text };

  // The check is deliberately asymmetric, because the two directions mean
  // opposite things.
  //
  //   text SHORTER than the blob count  — tesseract dropped a digit. This is
  //     the failure the guard exists for: `161` read as `16` is plausible and
  //     silently wrong. Always abstain.
  //
  //   text LONGER than the blob count   — two numerals touched after
  //     binarizing and merged into one blob, so the *component count* is what
  //     is wrong. Measured on real broadcast footage: `641` binarizes to 2
  //     blobs while tesseract reads all three characters correctly, and the
  //     old symmetric check rejected that correct read on every frame for the
  //     last 9 seconds of the match. Reading more glyphs than blobs is
  //     evidence of correct separation, not of invention.
  //
  // The over-count branch still has to earn it: a high confidence bar, and at
  // most two merges, so a hallucinated run of digits is not waved through.
  // Whatever slips past still faces ScoreGate's monotonic and max-jump rules.
  const merged = text.length - digitCount;
  const acceptable =
    merged === 0 || (merged > 0 && merged <= 2 && confidence >= MERGED_GLYPH_MIN_CONFIDENCE);
  if (!acceptable) {
    return { value: null, confidence: 0, text };
  }

  const value = Number(text);
  return { value: Number.isFinite(value) ? value : null, confidence, text };
}

/**
 * Confidence required to trust a read whose glyphs merged into fewer blobs
 * than characters. Higher than MIN_CONFIDENCE because this path is accepting a
 * read the component count disagrees with.
 */
export const MERGED_GLYPH_MIN_CONFIDENCE = 80;

export interface CropRead {
  read: RawRead;
  /** Variant 0's binarized strip — reused as the operator preview, not recomputed. */
  preview: GrayPlane | null;
}

/**
 * Read one crop through up to three preprocessing variants and vote.
 *
 * A single pass sits around 79% exact on the synthetic set, and its errors come
 * from a threshold or a rescale that happened to eat a stroke — so the variants
 * fail on largely disjoint inputs and an agreement rule converts most of those
 * into a correct read or an honest abstention. Ties abstain rather than pick a
 * winner: no reading is a zero delta, a wrong reading corrupts the solver.
 *
 * The loop stops as soon as two variants agree. That matters for throughput —
 * this has to finish inside one match-second even at 3x playback, and the
 * common case (an unambiguous scoreboard) now costs two passes, not three.
 */
export async function recognizeCrop(worker: TesseractWorker, crop: GrayPlane): Promise<CropRead> {
  const votes = new Map<number, { count: number; conf: number }>();
  let preview: GrayPlane | null = null;

  for (let i = 0; i < PREP_VARIANTS.length; i++) {
    const prepped = preprocessCrop(crop, PREP_VARIANTS[i]);
    if (i === 0) preview = prepped?.plane ?? null;
    if (!prepped) continue;

    const read = await recognizePlane(worker, prepped);
    if (read.value === null) continue;

    const slot = votes.get(read.value) ?? { count: 0, conf: 0 };
    slot.count++;
    slot.conf = Math.max(slot.conf, read.confidence);
    votes.set(read.value, slot);

    if (slot.count >= 2) {
      return {
        read: { value: read.value, confidence: slot.conf, text: String(read.value) },
        preview,
      };
    }
  }

  // Nothing reached two votes: the variants disagreed, so we do not guess.
  return { read: { value: null, confidence: 0, text: '' }, preview };
}

/* ------------------------------------------------------------------ *
 * Plausibility gate
 * ------------------------------------------------------------------ */

/** A single-second gain larger than this is a misread, not a scoring run. */
export const MAX_JUMP = 40;
/** Below this tesseract confidence the read is not worth acting on. */
export const MIN_CONFIDENCE = 45;

export interface GateResult {
  value: number;
  accepted: boolean;
  reason?: 'no-text' | 'low-confidence' | 'negative' | 'decrease' | 'jump';
}

/**
 * Decide whether to believe a read.
 *
 * Holding the previous value is always the safe failure: a held score produces a
 * zero delta for that second, which the downstream solver treats as "nothing
 * happened" — far less damaging than a phantom 60-point swing.
 */
export function gate(read: RawRead, prev: number): GateResult {
  if (read.value === null) return { value: prev, accepted: false, reason: 'no-text' };
  if (read.confidence < MIN_CONFIDENCE)
    return { value: prev, accepted: false, reason: 'low-confidence' };
  if (read.value < 0) return { value: prev, accepted: false, reason: 'negative' };
  // FRC scores never go down mid-match; a drop means a dropped or merged digit.
  if (read.value < prev) return { value: prev, accepted: false, reason: 'decrease' };
  if (read.value - prev > MAX_JUMP) return { value: prev, accepted: false, reason: 'jump' };
  return { value: read.value, accepted: true };
}

/** Consecutive agreeing reads needed to override the gate and re-sync. */
export const RESYNC_AFTER = 3;

/**
 * The gate plus the state needed to recover from being wrong.
 *
 * A stateless gate deadlocks, and the full-match simulation caught it: one early
 * misread (red logged as 16 while the real score climbed past 100) put every
 * subsequent *correct* read outside the jump bound, so the tracker rejected the
 * truth for the rest of the match and finished 164 points out.
 *
 * The fix is to let sustained evidence beat the heuristic. When rejected reads
 * keep telling a story that is self-consistent with *each other* — flat or
 * rising by a plausible amount, `RESYNC_AFTER` samples running — the OCR is
 * describing the real scoreboard and the anchor is what is stale, so the
 * tracker re-syncs to it. A one-off misread never survives that long, because
 * the next second disagrees with it and resets the count.
 *
 * Note the candidate follows the trajectory rather than demanding identical
 * values: an early version required three equal reads, which almost never
 * happens while a match is actively scoring, and it left the tracker 18 points
 * adrift for a whole match.
 */
export class ScoreGate {
  private prev: number;
  private candidate: number | null = null;
  private candidateHits = 0;

  /** Samples the OCR refused to believe. Surfaced so the operator sees drift. */
  rejections = 0;

  constructor(initial = 0) {
    this.prev = initial;
  }

  get value(): number {
    return this.prev;
  }

  feed(read: RawRead): GateResult {
    const result = gate(read, this.prev);

    if (result.accepted) {
      this.prev = result.value;
      this.candidate = null;
      this.candidateHits = 0;
      return result;
    }

    this.rejections++;

    if (read.value !== null && read.value >= 0) {
      const consistent =
        this.candidate !== null &&
        read.value >= this.candidate - 1 &&
        read.value - this.candidate <= MAX_JUMP;

      this.candidateHits = consistent ? this.candidateHits + 1 : 1;
      this.candidate = read.value;

      if (this.candidateHits >= RESYNC_AFTER) {
        this.prev = read.value;
        this.candidate = null;
        this.candidateHits = 0;
        return { value: read.value, accepted: true, reason: result.reason };
      }
    }

    return result;
  }

  /** Adopt an operator's manual correction as the new truth. */
  override(value: number): void {
    this.prev = value;
    this.candidate = null;
    this.candidateHits = 0;
  }
}

/* ------------------------------------------------------------------ *
 * Frame -> scores
 * ------------------------------------------------------------------ */

export interface FrameReadResult {
  blue: number;
  red: number;
  blueAccepted: boolean;
  redAccepted: boolean;
  blueRaw: RawRead;
  redRaw: RawRead;
  /** Segmented crops, for the operator's "what OCR sees" preview. */
  bluePlane: GrayPlane | null;
  redPlane: GrayPlane | null;
  /**
   * False when the score plates are not on screen — a replay, a crowd shot, a
   * pit interview. Distinct from an OCR failure: nothing was attempted, so the
   * caller should drop the sample entirely rather than log a held value or
   * count a rejection.
   */
  overlayPresent: boolean;
}

/**
 * Rectify a frame, read both score plates, and gate the results against the
 * running scores. `source` is any drawable — a `<video>`, or a canvas in tests.
 *
 * Two independent quads, not one quad split in two. See `DEFAULT_BLUE_QUAD`.
 */
export async function readFrame(
  worker: TesseractWorker,
  source: CanvasImageSource,
  sourceW: number,
  sourceH: number,
  blueQuad: Quad,
  redQuad: Quad,
  blueTracker: ScoreGate,
  redTracker: ScoreGate
): Promise<FrameReadResult | null> {
  const frameCanvas = document.createElement('canvas');
  frameCanvas.width = sourceW;
  frameCanvas.height = sourceH;
  const fctx = frameCanvas.getContext('2d', { willReadFrequently: true });
  if (!fctx) return null;
  fctx.drawImage(source, 0, 0, sourceW, sourceH);

  // Throws SecurityError on a cross-origin frame; the caller turns that into
  // the "use upload or screen share" message rather than faking data.
  const frame = fctx.getImageData(0, 0, sourceW, sourceH);

  // Cheap colour test first: if the overlay is not on screen there is nothing to
  // read, and running tesseract on a crowd shot only manufactures rejections.
  if (!isOverlayPresent(frame, blueQuad, redQuad)) {
    return {
      blue: blueTracker.value,
      red: redTracker.value,
      blueAccepted: false,
      redAccepted: false,
      blueRaw: { value: null, confidence: 0, text: '' },
      redRaw: { value: null, confidence: 0, text: '' },
      bluePlane: null,
      redPlane: null,
      overlayPresent: false,
    };
  }

  const blueGray = rectifyToGray(frame, blueQuad, SCORE_RECT_W, SCORE_RECT_H);
  const redGray = rectifyToGray(frame, redQuad, SCORE_RECT_W, SCORE_RECT_H);
  if (!blueGray || !redGray) return null;
  const blue: GrayPlane = { data: blueGray, width: SCORE_RECT_W, height: SCORE_RECT_H };
  const red: GrayPlane = { data: redGray, width: SCORE_RECT_W, height: SCORE_RECT_H };

  const blueCrop = await recognizeCrop(worker, blue);
  const redCrop = await recognizeCrop(worker, red);
  const blueRaw = blueCrop.read;
  const redRaw = redCrop.read;

  const blueGate = blueTracker.feed(blueRaw);
  const redGate = redTracker.feed(redRaw);

  return {
    blue: blueGate.value,
    red: redGate.value,
    blueAccepted: blueGate.accepted,
    redAccepted: redGate.accepted,
    blueRaw,
    redRaw,
    bluePlane: blueCrop.preview,
    redPlane: redCrop.preview,
    overlayPresent: true,
  };
}
