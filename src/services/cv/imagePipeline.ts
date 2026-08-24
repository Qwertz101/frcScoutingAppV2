/**
 * The image half of the CV Scoreboard Tracker.
 *
 * Everything here is plain canvas / typed-array maths — no image library. The
 * chain is: video frame -> perspective-rectify *each* of the two operator quads
 * (one per alliance score plate) -> grayscale, contrast-stretch, upscale and
 * binarize each crop -> hand the result to tesseract.
 *
 * Tesseract is dramatically more accurate on large, high-contrast, binarized
 * digits than on a raw 40px-tall broadcast overlay, so the preprocessing is not
 * cosmetic — it is most of the accuracy.
 */

/** A corner of the operator's quad, in 0..1 fractions of the video frame. */
export interface QuadPoint {
  x: number;
  y: number;
}

/** Clockwise from top-left: TL, TR, BR, BL. */
export type Quad = [QuadPoint, QuadPoint, QuadPoint, QuadPoint];

/**
 * A raw RGBA frame.
 *
 * Structurally identical to the browser's `ImageData`, which satisfies it
 * without a cast — but naming it here is what lets every function below be
 * compiled for Node, where the DOM `ImageData` type does not exist. ffmpeg
 * hands out exactly this shape.
 */
export interface RgbaFrame {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

/** Axis-aligned quad helper, TL/TR/BR/BL, in 0..1 frame fractions. */
export function rectQuad(x0: number, y0: number, x1: number, y1: number): Quad {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

/**
 * Default score-plate regions.
 *
 * There are two of them, and that is the whole point. An FRC broadcast bar reads
 *
 *   [rank] │ NEWTON  413 │ 0:52 │ 254  ARCHIMEDES │ … │ [rank]
 *
 * so the two scores are *not* adjacent halves of one box — they are separated by
 * the match timer and flanked by alliance names, with a sub-row of team numbers
 * beneath. A single quad over the whole bar, split 50/50, puts alliance-name
 * letters and clock digits into both crops; segmentation then finds letter
 * components, the digit-count cross-check disagrees with the recogniser, and the
 * pipeline abstains on every frame. Measured on a real 640×360 broadcast that
 * model read 0 of 12 samples; tight per-score quads read them.
 *
 * These numbers are the score plates measured off that broadcast (an FRC
 * Championship feed). They are a starting point — the operator drags them, and
 * "Auto-detect regions" finds them from the frame's colour.
 */
export const DEFAULT_BLUE_QUAD: Quad = rectQuad(0.405, 0.057, 0.461, 0.121);
export const DEFAULT_RED_QUAD: Quad = rectQuad(0.529, 0.057, 0.59, 0.121);

/**
 * The match timer plate, which sits *between* the two score plates.
 *
 * Reading it is what lets a sample's timestamp come from the same pixels as its
 * score, so OCR latency can no longer stretch the timeline. The plate is the
 * inverse of the score plates — black `M:SS` on white — which
 * `normalizePolarity` already handles without a hint, because it decides
 * polarity from the grayscale median and the plate is the majority of the crop.
 *
 * Measured off the same 640x360 reference broadcast as the score quads: the
 * white plate occupies x 300..339, y 20..44 px. The `2 / 6  :08` sub-row below
 * it is deliberately excluded — it is a second line of text and would give the
 * segmenter far more than three blobs, which `segmentDigits` refuses outright.
 */
export const DEFAULT_TIMER_QUAD: Quad = rectQuad(301 / 640, 21 / 360, 338 / 640, 43 / 360);

/**
 * Rectified size of ONE score plate.
 *
 * Roughly the aspect of a 3-digit plate (37×23 px on the reference broadcast),
 * blown up ~7×. Aspect matters: the old 640×160 strip stretched a 37px-wide box
 * horizontally by 17× and vertically by only 7×, which made each numeral wider
 * than it was tall and pushed it against `digitComponents`' anti-slab filter.
 */
export const SCORE_RECT_W = 256;
export const SCORE_RECT_H = 160;

/** How much the crop is blown up before binarizing, to smooth the glyph edges. */
export const UPSCALE = 2;

/**
 * Digit height handed to tesseract, in pixels.
 *
 * This is not "bigger is better". Tesseract's LSTM models are trained around a
 * ~30-50px cap height; feeding it 250px-tall numerals measurably *hurts*, so
 * the segmented digits are rescaled to a fixed height rather than left at
 * whatever the upscale produced.
 */
export const TARGET_DIGIT_H = 48;

/* ------------------------------------------------------------------ *
 * Perspective transform
 * ------------------------------------------------------------------ */

/**
 * Solve an n×n linear system by Gauss-Jordan with partial pivoting.
 * n is 8 here, so the naive O(n³) is free.
 */
function solve(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    }
    if (Math.abs(m[piv][col]) < 1e-12) return null; // degenerate quad
    [m[col], m[piv]] = [m[piv], m[col]];

    const d = m[col][col];
    for (let c = col; c <= n; c++) m[col][c] /= d;

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }

  return m.map((row) => row[n]);
}

/**
 * The 3×3 homography mapping the *destination* rectangle back into the source
 * quad. We build the inverse map (dest -> src) because rectifying is done by
 * walking every destination pixel and sampling where it came from; the forward
 * map would leave holes.
 *
 * `src` is the quad in source-image pixels, TL/TR/BR/BL. `w`/`h` are the
 * destination rectangle's dimensions.
 *
 * Returns the 9 coefficients row-major (h8 fixed at 1), or null if the quad is
 * degenerate (three points collinear, zero area, etc).
 */
export function homographyDestToSrc(src: Quad, w: number, h: number): number[] | null {
  const dst: QuadPoint[] = [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ];

  // For each correspondence (u,v) -> (x,y):
  //   x = (h0 u + h1 v + h2) / (h6 u + h7 v + 1)
  //   y = (h3 u + h4 v + h5) / (h6 u + h7 v + 1)
  // which linearises into two rows per point.
  const A: number[][] = [];
  const B: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x: u, y: v } = dst[i];
    const { x, y } = src[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]);
    B.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]);
    B.push(y);
  }

  const sol = solve(A, B);
  if (!sol || sol.some((n) => !Number.isFinite(n))) return null;
  return [...sol, 1];
}

/** Bilinear sample of an RGBA buffer; returns luma 0..255. Clamped at edges. */
function sampleLuma(data: Uint8ClampedArray, w: number, h: number, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;

  const cx0 = Math.min(Math.max(x0, 0), w - 1);
  const cy0 = Math.min(Math.max(y0, 0), h - 1);
  const cx1 = Math.min(cx0 + 1, w - 1);
  const cy1 = Math.min(cy0 + 1, h - 1);

  const at = (px: number, py: number) => {
    const i = (py * w + px) * 4;
    // Rec.601 luma — matches how broadcast overlays are authored.
    return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  };

  const a = at(cx0, cy0);
  const b = at(cx1, cy0);
  const c = at(cx0, cy1);
  const d = at(cx1, cy1);

  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

/**
 * Rectify the quad out of a full frame into an upright `w`×`h` grayscale plane.
 * Returns one byte per pixel (luma), or null for a degenerate quad.
 */
export function rectifyToGray(
  frame: RgbaFrame,
  quadFrac: Quad,
  w = SCORE_RECT_W,
  h = SCORE_RECT_H
): Uint8ClampedArray | null {
  const src = quadFrac.map((p) => ({
    x: p.x * frame.width,
    y: p.y * frame.height,
  })) as Quad;

  const H = homographyDestToSrc(src, w, h);
  if (!H) return null;

  const out = new Uint8ClampedArray(w * h);
  for (let v = 0; v < h; v++) {
    for (let u = 0; u < w; u++) {
      // Sample at pixel centres so the rectified image is not half a pixel off.
      const uu = u + 0.5;
      const vv = v + 0.5;
      const den = H[6] * uu + H[7] * vv + H[8];
      if (den === 0) continue;
      const sx = (H[0] * uu + H[1] * vv + H[2]) / den;
      const sy = (H[3] * uu + H[4] * vv + H[5]) / den;
      out[v * w + u] = sampleLuma(frame.data, frame.width, frame.height, sx, sy);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Preprocessing
 * ------------------------------------------------------------------ */

export interface GrayPlane {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Cut a sub-rectangle out of a grayscale plane. */
export function cropGray(
  plane: GrayPlane,
  x0: number,
  y0: number,
  w: number,
  h: number
): GrayPlane {
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(Math.max(y0 + y, 0), plane.height - 1);
    for (let x = 0; x < w; x++) {
      const sx = Math.min(Math.max(x0 + x, 0), plane.width - 1);
      out[y * w + x] = plane.data[sy * plane.width + sx];
    }
  }
  return { data: out, width: w, height: h };
}

/**
 * Linear contrast stretch between the 2nd and 98th percentile.
 *
 * Percentiles rather than min/max: a single specular highlight or one dead
 * black pixel would otherwise pin the range and flatten the digits.
 */
export function contrastStretch(plane: GrayPlane): GrayPlane {
  const hist = new Uint32Array(256);
  for (let i = 0; i < plane.data.length; i++) hist[plane.data[i]]++;

  const total = plane.data.length;
  const loTarget = total * 0.02;
  const hiTarget = total * 0.98;

  let acc = 0;
  let lo = 0;
  let hi = 255;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= loTarget) {
      lo = v;
      break;
    }
  }
  acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= hiTarget) {
      hi = v;
      break;
    }
  }
  if (hi - lo < 8) return plane; // flat crop — stretching it just amplifies noise

  const lut = new Uint8ClampedArray(256);
  const scale = 255 / (hi - lo);
  for (let v = 0; v < 256; v++) lut[v] = Math.round((v - lo) * scale);

  const out = new Uint8ClampedArray(plane.data.length);
  for (let i = 0; i < plane.data.length; i++) out[i] = lut[plane.data[i]];
  return { data: out, width: plane.width, height: plane.height };
}

/** Bilinear upscale by an integer factor. */
export function upscale(plane: GrayPlane, factor = UPSCALE): GrayPlane {
  const w = plane.width * factor;
  const h = plane.height * factor;
  const out = new Uint8ClampedArray(w * h);

  for (let y = 0; y < h; y++) {
    const sy = (y + 0.5) / factor - 0.5;
    const y0 = Math.min(Math.max(Math.floor(sy), 0), plane.height - 1);
    const y1 = Math.min(y0 + 1, plane.height - 1);
    const fy = Math.min(Math.max(sy - y0, 0), 1);
    for (let x = 0; x < w; x++) {
      const sx = (x + 0.5) / factor - 0.5;
      const x0 = Math.min(Math.max(Math.floor(sx), 0), plane.width - 1);
      const x1 = Math.min(x0 + 1, plane.width - 1);
      const fx = Math.min(Math.max(sx - x0, 0), 1);

      const a = plane.data[y0 * plane.width + x0];
      const b = plane.data[y0 * plane.width + x1];
      const c = plane.data[y1 * plane.width + x0];
      const d = plane.data[y1 * plane.width + x1];
      out[y * w + x] =
        a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
    }
  }
  return { data: out, width: w, height: h };
}

/**
 * Sauvola adaptive threshold.
 *
 * A plain local-mean threshold is unusable here: over a flat region (the empty
 * half of the score bar, a patch of carpet) the mean sits *in* the noise and
 * every pixel gets thresholded into salt-and-pepper, which tesseract then reads
 * as glyphs. Sauvola scales the threshold by the local standard deviation, so
 * flat regions collapse to background and only genuinely high-contrast edges
 * become ink.
 *
 *   T = mean * (1 + k * (stddev / R - 1))
 */
export function sauvolaThreshold(plane: GrayPlane, radius?: number, k = 0.2, R = 128): GrayPlane {
  const { width: w, height: h, data } = plane;
  const r = Math.max(4, Math.round(radius ?? h / 3));

  const iw = w + 1;
  const sum = new Float64Array(iw * (h + 1));
  const sqSum = new Float64Array(iw * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowS = 0;
    let rowQ = 0;
    for (let x = 0; x < w; x++) {
      const v = data[y * w + x];
      rowS += v;
      rowQ += v * v;
      sum[(y + 1) * iw + (x + 1)] = sum[y * iw + (x + 1)] + rowS;
      sqSum[(y + 1) * iw + (x + 1)] = sqSum[y * iw + (x + 1)] + rowQ;
    }
  }

  const box = (arr: Float64Array, x0: number, y0: number, x1: number, y1: number) =>
    arr[(y1 + 1) * iw + (x1 + 1)] -
    arr[y0 * iw + (x1 + 1)] -
    arr[(y1 + 1) * iw + x0] +
    arr[y0 * iw + x0];

  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(y - r, 0);
    const y1 = Math.min(y + r, h - 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(x - r, 0);
      const x1 = Math.min(x + r, w - 1);
      const area = (y1 - y0 + 1) * (x1 - x0 + 1);
      const mean = box(sum, x0, y0, x1, y1) / area;
      const variance = Math.max(box(sqSum, x0, y0, x1, y1) / area - mean * mean, 0);
      const t = mean * (1 + k * (Math.sqrt(variance) / R - 1));
      // Ink is dark: below the local threshold becomes black.
      out[y * w + x] = data[y * w + x] < t ? 0 : 255;
    }
  }
  return { data: out, width: w, height: h };
}

/**
 * Force dark-ink-on-white *before* thresholding.
 *
 * Deciding polarity after binarizing was the original bug: a noisy binarized
 * background is close to 50/50 black/white, so the majority-class test coin-flips.
 * On the grayscale the question is unambiguous — a broadcast score bar is a dark
 * plate with bright numerals, so a below-mid median luma means "invert".
 */
export function normalizePolarity(plane: GrayPlane): GrayPlane {
  const hist = new Uint32Array(256);
  for (let i = 0; i < plane.data.length; i++) hist[plane.data[i]]++;
  let acc = 0;
  let median = 128;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= plane.data.length / 2) {
      median = v;
      break;
    }
  }
  // The plate is the majority of the crop, so the median IS the plate colour.
  if (median >= 128) return plane;

  const out = new Uint8ClampedArray(plane.data.length);
  for (let i = 0; i < plane.data.length; i++) out[i] = 255 - plane.data[i];
  return { data: out, width: plane.width, height: plane.height };
}

/**
 * Force the binarized ink to be the minority class, after thresholding.
 *
 * `normalizePolarity` guesses polarity from the *grayscale* median against a
 * fixed 128 — which assumes the plate is either clearly dark or clearly light.
 * A washed-out plate (stage lighting glare, a phone's auto-exposure blowing
 * out a saturated colour, both seen on real audience footage) breaks that
 * assumption: the background can measure well above 128 while the numerals,
 * being pure white, are brighter still. Both classes land on the "light" side
 * of the fixed cutoff, so the guess leaves the image unflipped — and Sauvola,
 * which has no notion of "ink colour" and only marks whichever pixel is
 * darker than its local neighbourhood, then marks the plate as ink and the
 * numerals as background. `digitComponents` finds nothing digit-shaped in
 * that image, or at best a handful of stray dark speckle.
 *
 * There is no grayscale-level fix for this — the two classes are genuinely
 * both bright, in absolute terms, on this footage. But post-threshold there
 * is an assumption that always holds regardless of either class's brightness:
 * glyph ink is a small fraction of any real digit crop's area, never close to
 * half. So whichever binary class is the *majority* is the plate, and
 * whichever is the minority is ink — a purely relative test, immune to the
 * plate's actual colour or exposure.
 */
export function fixBinaryPolarity(plane: GrayPlane): GrayPlane {
  let black = 0;
  for (let i = 0; i < plane.data.length; i++) if (plane.data[i] === 0) black++;
  if (black <= plane.data.length / 2) return plane;

  const out = new Uint8ClampedArray(plane.data.length);
  for (let i = 0; i < plane.data.length; i++) out[i] = plane.data[i] === 0 ? 255 : 0;
  return { data: out, width: plane.width, height: plane.height };
}

/* ------------------------------------------------------------------ *
 * Digit segmentation
 * ------------------------------------------------------------------ */

interface Component {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  pixels: number;
}

/** 8-connected components of the ink (black) pixels, via an explicit stack. */
function inkComponents(plane: GrayPlane): { labels: Int32Array; comps: Component[] } {
  const { width: w, height: h, data } = plane;
  const labels = new Int32Array(w * h).fill(-1);
  const comps: Component[] = [];
  const stack: number[] = [];

  for (let start = 0; start < data.length; start++) {
    if (data[start] !== 0 || labels[start] !== -1) continue;
    const id = comps.length;
    const comp: Component = {
      x0: start % w,
      y0: (start / w) | 0,
      x1: start % w,
      y1: (start / w) | 0,
      pixels: 0,
    };
    labels[start] = id;
    stack.push(start);

    while (stack.length) {
      const i = stack.pop() as number;
      const x = i % w;
      const y = (i / w) | 0;
      comp.pixels++;
      if (x < comp.x0) comp.x0 = x;
      if (x > comp.x1) comp.x1 = x;
      if (y < comp.y0) comp.y0 = y;
      if (y > comp.y1) comp.y1 = y;

      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w || (dx === 0 && dy === 0)) continue;
          const ni = ny * w + nx;
          if (data[ni] === 0 && labels[ni] === -1) {
            labels[ni] = id;
            stack.push(ni);
          }
        }
      }
    }
    comps.push(comp);
  }

  return { labels, comps };
}

/**
 * Widest a kept blob may be, as a multiple of its own height.
 *
 * This has to clear a *pair* of touching numerals, not a single one. Two
 * digits that merge when binarized form one blob roughly twice as wide as a
 * digit — and `recognizePlane` is explicitly built to handle that case, by
 * accepting a read whose character count exceeds the blob count. But it only
 * ever gets the chance if the merged blob survives this filter in the first
 * place. At the old 1.6 the merged pair was discarded outright, which loses
 * *both* digits rather than merging them: measured on real audience footage,
 * a red score of `254` came back as `2`, `164` as `1` and `377` as `3`, every
 * one of them at 96% confidence, because only the one un-merged leading digit
 * was left standing.
 *
 * Merging is more likely on this footage than on a clean broadcast for two
 * compounding reasons — a washed-out plate binarizes with fatter strokes, and
 * `rectifyToGray` stretches a narrow operator box out to the fixed 256x160
 * target, widening every glyph in it. So the operator's box aspect ratio
 * silently decided whether digits survived, which is not a judgement a hand-
 * drawn rectangle should be making.
 *
 * 2.6 clears a two-digit merge while still rejecting a three-digit run (~3.3x)
 * and the full-width plate bars this filter exists to catch — those are caught
 * by the edge and fill tests below regardless.
 */
const MAX_GLYPH_ASPECT = 2.6;

/**
 * Keep only the blobs that could be a numeral and redraw them on clean white.
 *
 * This is where most of the accuracy comes from. The two things that wrecked the
 * naive pipeline were (a) leftover speckle, and (b) the alliance-colour block
 * edge and centre divider surviving as tall solid bars that tesseract happily
 * read as `1`. Both are trivially separable from a digit by shape:
 *
 *   - a digit is a decent fraction of the strip height, but not all of it;
 *   - a digit (or a merged pair) is not a wide slab — see MAX_GLYPH_ASPECT;
 *   - a digit's bounding box is not ~100% filled — a solid bar is.
 *
 * Returns null when nothing digit-like survives, which the caller treats as a
 * failed read rather than guessing.
 */
function digitComponents(
  plane: GrayPlane
): { labels: Int32Array; onLine: { id: number; c: Component }[]; medH: number } | null {
  const { width: w, height: h } = plane;
  const { labels, comps } = inkComponents(plane);

  const keep = comps.map((c, id) => {
    const cw = c.x1 - c.x0 + 1;
    const ch = c.y1 - c.y0 + 1;
    const fill = c.pixels / (cw * ch);
    // A blob running into the left or right edge of the crop is the centre
    // divider or the alliance-colour block boundary bleeding in, not a numeral.
    // Left unfiltered it survives as a phantom leading digit and — because it is
    // present every single frame — does so *consistently*, which is worse than
    // noise: the whole match reads high and nothing ever contradicts it.
    const touchesSide = c.x0 <= 1 || c.x1 >= w - 2;
    // Thinness is judged against the blob's OWN height, not the crop's.
    //
    // This is what finally killed the worst failure in the whole pipeline. The
    // boundary between the alliance colour block and the plate is a vertical
    // high-contrast edge sitting *inside* the crop, so no border test catches
    // it, and it segmented as a tall thin bar that tesseract read as a leading
    // `1` — turning a red score of 32 into 132 on every single frame of a
    // match. Because it was perfectly consistent, no amount of voting,
    // monotonicity or re-syncing could see it as an error. The narrowest real
    // numeral (a `1`) is still about a fifth as wide as it is tall; a rendering
    // artifact is a fortieth.
    const ok =
      !touchesSide &&
      ch >= h * 0.3 && // not speckle
      ch <= h * 0.95 && // not a full-height bar
      cw <= ch * MAX_GLYPH_ASPECT && // not a slab
      cw >= ch * 0.12 && // not an edge artifact
      cw >= 3 &&
      fill <= 0.93 && // a solid rectangle is not a glyph
      fill >= 0.12;
    return { id, c, ok };
  });

  const kept = keep.filter((k) => k.ok);
  if (!kept.length) return null;

  // Digits sit on a common baseline; a survivor far off it is a stray mark.
  const heights = kept.map((k) => k.c.y1 - k.c.y0 + 1).sort((a, b) => a - b);
  const medH = heights[heights.length >> 1];
  const onLine = kept.filter((k) => {
    const ch = k.c.y1 - k.c.y0 + 1;
    return ch >= medH * 0.55 && ch <= medH * 1.6;
  });
  if (!onLine.length) return null;

  onLine.sort((a, b) => a.c.x0 - b.c.x0);
  return { labels, onLine, medH };
}

/**
 * The digits redrawn as one clean, evenly-spaced line.
 *
 * Recognising each glyph in isolation (PSM 10) was tried and measured *worse*
 * — 54% against 79% — because tesseract's LSTM is a sequence model and a
 * context-free single character collapses to whatever prior dominates (every
 * digit came back as `4`). So the line is kept, but rebuilt.
 */
export function segmentDigits(
  plane: GrayPlane,
  gapFactor = 0.28
): { plane: GrayPlane; count: number } | null {
  const seg = digitComponents(plane);
  if (!seg) return null;
  const { labels, onLine, medH } = seg;
  // Four blobs cannot be an FRC score; the extras are scoreboard furniture that
  // survived the shape filter, and guessing from them is worse than not reading.
  if (onLine.length > 3) return null;
  const w = plane.width;

  // Re-lay-out rather than crop.
  //
  // Copying the original bounding box wholesale preserves the overlay's kerning,
  // and condensed broadcast faces (Impact and friends) set numerals almost
  // touching. Tesseract then merges or drops one — the "112 read as 12" class of
  // failure. Redrawing each glyph into its own cell with a uniform gap and a
  // shared baseline removes that entire failure mode.
  onLine.sort((a, b) => a.c.x0 - b.c.x0);
  return { plane: redrawLine(labels, w, onLine, medH, gapFactor), count: onLine.length };
}

/** One glyph, as `digitComponents` reports it. */
type Glyph = { id: number; c: { x0: number; y0: number; x1: number; y1: number } };

/**
 * Redraw a run of glyphs as one clean, evenly-spaced line.
 *
 * Shared by the score reader and the team-number reader so that both feed
 * tesseract images with identical spacing characteristics — the spacing is a
 * large part of why this works at all, and having two versions drift apart
 * would show up as one of them mysteriously reading worse.
 */
function redrawLine(
  labels: Int32Array,
  w: number,
  glyphs: Glyph[],
  medH: number,
  gapFactor: number
): GrayPlane {
  const gap = Math.max(4, Math.round(medH * gapFactor));
  const baseline = Math.max(...glyphs.map((k) => k.c.y1));
  const top = Math.min(...glyphs.map((k) => k.c.y0));
  const oh = baseline - top + 1;

  const widths = glyphs.map((k) => k.c.x1 - k.c.x0 + 1);
  const ow = widths.reduce((a, b) => a + b, 0) + gap * (glyphs.length - 1);
  const out = new Uint8ClampedArray(Math.max(1, ow) * oh).fill(255);

  let penX = 0;
  for (let gi = 0; gi < glyphs.length; gi++) {
    const { id, c } = glyphs[gi];
    // Only x moves: keeping each glyph's original row preserves the one baseline
    // they already share, without re-deriving it per glyph.
    for (let y = c.y0; y <= c.y1; y++) {
      for (let x = c.x0; x <= c.x1; x++) {
        if (labels[y * w + x] !== id) continue;
        out[(y - top) * ow + (penX + x - c.x0)] = 0;
      }
    }
    penX += widths[gi] + gap;
  }
  return { data: out, width: ow, height: oh };
}

/** One run of digits found in a wide band, with where it sat. */
export interface NumberGroup {
  plane: GrayPlane;
  count: number;
  /** Horizontal extent in the source plane, for left/right side tests. */
  x0: number;
  x1: number;
}

/**
 * Split a wide crop into the separate numbers printed across it.
 *
 * `segmentDigits` reads *one* number and refuses more than three glyphs,
 * because a fourth blob on a score plate is scoreboard furniture. A team-number
 * row is the opposite situation: several numbers of three to five digits, laid
 * out side by side with logos between them. So the glyphs are clustered by the
 * gaps between them instead — within a number the gap is kerning, between
 * numbers it is layout, and the two differ by a lot more than the noise does.
 *
 * Groups whose digit count could not be a team number are dropped here rather
 * than passed on, because every surviving group is about to be OCR'd and a
 * spurious one costs a full recognize call and an opportunity to be wrong.
 */
export function segmentNumberGroups(
  plane: GrayPlane,
  opts: {
    /** Gap, in median glyph heights, that separates two numbers. */
    splitGap?: number;
    minDigits?: number;
    maxDigits?: number;
    gapFactor?: number;
  } = {}
): NumberGroup[] {
  const { splitGap = 0.55, minDigits = 2, maxDigits = 5, gapFactor = 0.28 } = opts;
  const seg = digitComponents(plane);
  if (!seg) return [];
  const { labels, onLine, medH } = seg;
  if (!onLine.length) return [];

  const sorted = [...onLine].sort((a, b) => a.c.x0 - b.c.x0);
  const threshold = medH * splitGap;

  const groups: Glyph[][] = [];
  let current: Glyph[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].c.x0 - sorted[i - 1].c.x1;
    if (gap > threshold) {
      groups.push(current);
      current = [];
    }
    current.push(sorted[i]);
  }
  groups.push(current);

  const out: NumberGroup[] = [];
  for (const g of groups) {
    if (g.length < minDigits || g.length > maxDigits) continue;
    out.push({
      plane: redrawLine(labels, plane.width, g, medH, gapFactor),
      count: g.length,
      x0: Math.min(...g.map((k) => k.c.x0)),
      x1: Math.max(...g.map((k) => k.c.x1)),
    });
  }
  return out;
}

/** Resample a binary plane so its height matches `target`, then re-binarize. */
export function scaleToHeight(plane: GrayPlane, target = TARGET_DIGIT_H): GrayPlane {
  if (plane.height === target) return plane;
  const factor = target / plane.height;
  const w = Math.max(1, Math.round(plane.width * factor));
  const out = new Uint8ClampedArray(w * target);

  for (let y = 0; y < target; y++) {
    const sy = Math.min(Math.max((y + 0.5) / factor - 0.5, 0), plane.height - 1);
    const y0 = Math.floor(sy);
    const y1 = Math.min(y0 + 1, plane.height - 1);
    const fy = sy - y0;
    for (let x = 0; x < w; x++) {
      const sx = Math.min(Math.max((x + 0.5) / factor - 0.5, 0), plane.width - 1);
      const x0 = Math.floor(sx);
      const x1 = Math.min(x0 + 1, plane.width - 1);
      const fx = sx - x0;
      const v =
        plane.data[y0 * plane.width + x0] * (1 - fx) * (1 - fy) +
        plane.data[y0 * plane.width + x1] * fx * (1 - fy) +
        plane.data[y1 * plane.width + x0] * (1 - fx) * fy +
        plane.data[y1 * plane.width + x1] * fx * fy;
      out[y * w + x] = v < 128 ? 0 : 255;
    }
  }
  return { data: out, width: w, height: target };
}

/** Surround with white so tesseract sees a normal text margin, not a bleed edge. */
export function padWhite(plane: GrayPlane, pad = 16): GrayPlane {
  const w = plane.width + pad * 2;
  const h = plane.height + pad * 2;
  const out = new Uint8ClampedArray(w * h).fill(255);
  for (let y = 0; y < plane.height; y++) {
    out.set(plane.data.subarray(y * plane.width, (y + 1) * plane.width), (y + pad) * w + pad);
  }
  return { data: out, width: w, height: h };
}

export interface PrepOptions {
  targetH: number;
  gapFactor: number;
  sauvolaK: number;
  upscaleBy: number;
}

/**
 * Preprocessing variants used for the read-three-and-vote strategy.
 *
 * These three were the top performers in a parameter sweep over digit height,
 * glyph spacing, Sauvola k and upscale factor. They disagree on *different*
 * inputs, which is what makes voting across them worth the extra passes.
 */
export const PREP_VARIANTS: PrepOptions[] = [
  { targetH: 48, gapFactor: 0.28, sauvolaK: 0.2, upscaleBy: 2 },
  { targetH: 64, gapFactor: 0.45, sauvolaK: 0.15, upscaleBy: 3 },
  { targetH: 40, gapFactor: 0.35, sauvolaK: 0.3, upscaleBy: 2 },
];

/**
 * The full crop -> OCR-ready image chain.
 *
 * Returns null when segmentation finds nothing digit-like, e.g. the operator's
 * quad is off the scoreboard or the overlay is not on screen yet. That is
 * reported as a failed read, never guessed at.
 */
export interface PreparedCrop {
  plane: GrayPlane;
  /**
   * How many glyphs the segmentation found. Connected components are a far more
   * reliable digit *counter* than tesseract is — this is what lets a read that
   * returns "16" for a three-glyph crop be rejected instead of believed.
   */
  digitCount: number;
}

export function preprocessCrop(crop: GrayPlane, opts?: Partial<PrepOptions>): PreparedCrop | null {
  const o = { ...PREP_VARIANTS[0], ...opts };

  const gray = normalizePolarity(contrastStretch(crop));
  const binary = fixBinaryPolarity(sauvolaThreshold(upscale(gray, o.upscaleBy), undefined, o.sauvolaK));

  const line = segmentDigits(binary, o.gapFactor);
  if (!line) return null;
  return {
    plane: padWhite(scaleToHeight(line.plane, o.targetH), 24),
    digitCount: line.count,
  };
}

/** A prepared team-number crop, and where across the band it was found. */
export interface PreparedGroup extends PreparedCrop {
  x0: number;
  x1: number;
}

/**
 * The wide-crop -> several-OCR-ready-images chain.
 *
 * The team-number counterpart of `preprocessCrop`, sharing every stage with it
 * except the segmentation: same polarity handling, same Sauvola threshold, same
 * scale-and-pad, so a tuning fix to one is a tuning fix to both. Only the split
 * differs, because this crop holds several numbers rather than one.
 *
 * The per-group `digitCount` is the point of doing it this way. It flows into
 * `recognizePlane`'s length guard, which is what makes a dropped digit an
 * abstention rather than a different, entirely plausible team number.
 */
export function prepareNumberGroups(
  crop: GrayPlane,
  opts?: Partial<PrepOptions> & { splitGap?: number; minDigits?: number; maxDigits?: number }
): PreparedGroup[] {
  const o = { ...PREP_VARIANTS[0], ...opts };
  const gray = normalizePolarity(contrastStretch(crop));
  const binary = fixBinaryPolarity(sauvolaThreshold(upscale(gray, o.upscaleBy), undefined, o.sauvolaK));

  return segmentNumberGroups(binary, {
    gapFactor: o.gapFactor,
    splitGap: opts?.splitGap,
    minDigits: opts?.minDigits,
    maxDigits: opts?.maxDigits,
  }).map((g) => ({
    plane: padWhite(scaleToHeight(g.plane, o.targetH), 24),
    digitCount: g.count,
    // Reported in the *binarized* plane's coordinates, which are `upscaleBy`
    // times the crop's. Normalised so callers do not have to know that.
    x0: g.x0 / binary.width,
    x1: g.x1 / binary.width,
  }));
}

/**
 * Expand a grayscale plane to RGBA bytes.
 *
 * Kept separate from wrapping those bytes in an `ImageData` — that wrapper is
 * DOM-only and lives in `browserCanvas.ts`, so that this file stays compilable
 * for Node.
 */
export function grayToRgba(plane: GrayPlane): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(plane.width * plane.height * 4);
  for (let i = 0; i < plane.data.length; i++) {
    const v = plane.data[i];
    rgba[i * 4] = v;
    rgba[i * 4 + 1] = v;
    rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

/* ------------------------------------------------------------------ *
 * Plate colour — overlay presence and region auto-detection
 * ------------------------------------------------------------------ */

export type PlateSide = 'blue' | 'red';

/**
 * Coarse colour class of one pixel.
 *
 * The FRC overlay's alliance plates are strongly saturated and, crucially, far
 * more saturated than anything the camera sees behind them — carpet, bumpers and
 * arena lighting are all comparatively washed out at broadcast bitrates. So a
 * hue test plus a saturation floor separates "plate" from "everything else"
 * without needing to know anything about the venue.
 */
function classifyPixel(r: number, g: number, b: number): 0 | 1 | 2 {
  const mx = Math.max(r, g, b);
  if (mx < 60) return 0;
  const sat = (mx - Math.min(r, g, b)) / mx;
  if (sat < 0.35) return 0;
  if (b === mx && b - r > 45 && b - g > 25) return 1; // blue plate
  if (r === mx && r - b > 55 && r - g > 55) return 2; // red plate
  return 0;
}

/**
 * How far either side of the score the plate is allowed to reach, as a multiple
 * of the score box's own width.
 */
export const MAX_PLATE_SPAN = 4;

/**
 * How far the alliance plate extends either side of the score.
 *
 * `detectScoreRegions` deliberately reports the *contiguous* colour run around
 * the numerals, which stops at the first thing that is not plate colour — on a
 * broadcast overlay that is the nearest team logo, and on an arena scoreboard
 * it is the timer or a divider. That is exactly right for cropping a score and
 * exactly wrong for finding the team numbers, which live in the rest of the
 * plate on the far side of those logos.
 *
 * So walk outwards from the score instead, treating a column as plate when
 * enough of the score's own rows are the alliance colour, and stepping over
 * gaps up to `maxGap` of the frame width. The logos are islands a few percent
 * wide; the end of the plate is everything after it.
 *
 * Returns normalised `[x0, x1]`.
 */
export function plateExtent(
  frame: RgbaFrame,
  scoreQuad: Quad,
  side: PlateSide,
  maxGap = 0.045,
  maxSpan = MAX_PLATE_SPAN
): [number, number] {
  const want = side === 'blue' ? 1 : 2;
  const W = frame.width;
  const xs = scoreQuad.map((p) => p.x * W);
  const ys = scoreQuad.map((p) => p.y * frame.height);
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const y1 = Math.min(frame.height - 1, Math.ceil(Math.max(...ys)));
  const rows = y1 - y0 + 1;
  if (rows < 2) return [Math.min(...xs) / W, Math.max(...xs) / W];

  const isPlate = (x: number): boolean => {
    let hit = 0;
    for (let y = y0; y <= y1; y++) {
      const i = (y * W + x) * 4;
      if (classifyPixel(frame.data[i], frame.data[i + 1], frame.data[i + 2]) === want) hit++;
    }
    return hit >= rows * 0.5;
  };

  const gapLimit = Math.max(2, Math.round(maxGap * W));
  // A venue whose walls are alliance-coloured — and plenty are — classifies as
  // plate for hundreds of columns, so the walk needs a stop other than "ran out
  // of colour". Measured on this footage a real plate is 4-5x the score box it
  // contains; Qual6's red wall took the walk to 8x before this cap existed.
  const scoreW = Math.max(1, Math.max(...xs) - Math.min(...xs));
  const reach = scoreW * maxSpan;

  const walk = (from: number, step: number): number => {
    let edge = from;
    let gap = 0;
    for (let x = from + step; x >= 0 && x < W; x += step) {
      if (Math.abs(x - from) > reach) break;
      if (isPlate(x)) {
        edge = x;
        gap = 0;
      } else if (++gap > gapLimit) {
        break;
      }
    }
    return edge;
  };

  const left = walk(Math.max(0, Math.floor(Math.min(...xs))), -1);
  const right = walk(Math.min(W - 1, Math.ceil(Math.max(...xs))), 1);
  return [left / W, right / W];
}

/**
 * Fraction of the quad's bounding box that is the expected plate colour.
 *
 * Used for two things: deciding whether the overlay is on screen at all, and
 * sanity-checking an auto-detected region.
 */
export function plateCoverage(frame: RgbaFrame, quad: Quad, side: PlateSide): number {
  const want = side === 'blue' ? 1 : 2;
  const xs = quad.map((p) => p.x * frame.width);
  const ys = quad.map((p) => p.y * frame.height);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const x1 = Math.min(frame.width - 1, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const y1 = Math.min(frame.height - 1, Math.ceil(Math.max(...ys)));
  if (x1 <= x0 || y1 <= y0) return 0;

  let hit = 0;
  let total = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * frame.width + x) * 4;
      if (classifyPixel(frame.data[i], frame.data[i + 1], frame.data[i + 2]) === want) hit++;
      total++;
    }
  }
  return total ? hit / total : 0;
}

/**
 * Minimum plate coverage for the overlay to count as "on screen".
 *
 * A score plate is mostly plate colour — white numerals cover maybe a third of
 * it — so a correctly-placed quad sits comfortably above 0.4 in practice. A
 * replay, a crowd shot or a pit camera lands near zero. The threshold is set low
 * enough that a slightly mis-dragged quad still counts as present (better to
 * attempt the read and let the digit-count guard abstain) but high enough that
 * an absent overlay is never mistaken for a hard OCR failure.
 */
export const OVERLAY_MIN_COVERAGE = 0.18;

export function isOverlayPresent(frame: RgbaFrame, blueQuad: Quad, redQuad: Quad): boolean {
  return (
    plateCoverage(frame, blueQuad, 'blue') >= OVERLAY_MIN_COVERAGE &&
    plateCoverage(frame, redQuad, 'red') >= OVERLAY_MIN_COVERAGE
  );
}

export interface DetectedRegions {
  blue: Quad;
  red: Quad;
  /**
   * The match timer plate. Auto-detect already *measures* the gap between the
   * two alliance masses — that gap is the ruler it sizes the score boxes with —
   * so the timer's location is a by-product of work already done, not a second
   * search.
   */
  timer: Quad;
}

/** Contiguous runs of `arr` at or above `thr`, at least `minLen` long. */
function runsAbove(arr: Int32Array, thr: number, minLen: number): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] >= thr) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      if (i - start >= minLen) out.push([start, i - 1]);
      start = -1;
    }
  }
  if (start >= 0 && arr.length - start >= minLen) out.push([start, arr.length - 1]);
  return out;
}

function longestRun(runs: [number, number][]): [number, number] | null {
  let best: [number, number] | null = null;
  for (const r of runs) if (!best || r[1] - r[0] > best[1] - best[0]) best = r;
  return best;
}

/* ---- detector tuning constants -------------------------------------------
 *
 * These were all measured, not guessed — see `analyzeBands` below, which is the
 * diagnostic that produced them.
 */

/**
 * How far down the frame to look for the bar.
 *
 * A clean broadcast puts it in the top few percent, but a camera pointed at a
 * venue's own screen from the stands does not: on real Championship footage the
 * bar sat at 24.5–30% of frame height, which the old 0.25 window bisected. 0.45
 * covers that comfortably while still keeping the field carpet — which is
 * alliance-coloured and enormous — out of the search.
 */
const SEARCH_DEPTH = 0.45;

/**
 * Minimum both-colours-on-one-row mass, as a fraction of frame width, for a row
 * to join a candidate band.
 *
 * Lower than the old 0.08 on purpose. The old value was doing double duty as a
 * *filter*, which it is bad at — it admitted a 70-row lighting truss while very
 * nearly excluding the real 7-row scoreboard sliver. Filtering is now the
 * scoring pass's job, so this only has to be permissive enough to not lose the
 * true band.
 */
const BAND_MIN_MASS = 0.03;

/**
 * A scoreboard bar is a thin graphic. An arena lit blue on one side and red on
 * the other is a tall diffuse mass, and that is the single cheapest way to tell
 * them apart before doing any real work.
 */
const BAND_MAX_HEIGHT = 0.12;

/** Timer-plate gap width, as a fraction of frame width. */
const GAP_MIN = 0.015;
const GAP_MAX = 0.14;

/**
 * The timer plate is white or near-white, and it is the one feature stage
 * lighting cannot fake: an arena has no flat bright panel sitting exactly
 * between its blue and red halves. This is the decisive rejection test.
 */
const PLATE_MIN_LUMA = 150;
const PLATE_MIN_FLAT_FRACTION = 0.4;
/** Saturation below this counts as "not an alliance colour". */
const PLATE_FLAT_SAT = 0.2;

/** Samples per axis for the white-plate test. See `flatBrightness`. */
const PLATE_SAMPLE_SIDE = 24;

/**
 * The two alliance blocks are near-identical widths by design. Two unrelated
 * lighting blobs are not.
 */
const MIN_SYMMETRY = 0.65;

/** Fraction of a run's bounding box that must actually be its own colour. */
const MIN_FILL = 0.3;

/**
 * Band-to-surroundings contrast: an opaque graphic has hard edges, light fades.
 * Scoring only — see the note at its use site for why it must not be a filter.
 */
const SHARPNESS_CLAMP = 6;
const MIN_SHARPNESS_TERM = 0.15;

/** Rows the two plates must share for the pair to be one bar. */
const MIN_PLATE_ROWS = 4;

/**
 * Window heights tried at every offset, as fractions of frame height, and the
 * stride as a fraction of the window height.
 *
 * The bar's apparent height depends entirely on how much of the frame the
 * scoreboard occupies — a broadcast overlay and a phone pointed at the venue's
 * own screen differ by several times over — so the search is multi-scale.
 */
const WINDOW_HEIGHTS = [0.03, 0.05, 0.08, 0.12];
const WINDOW_STRIDE = 0.34;

/**
 * Widest N runs of each colour considered as possible plates within one band.
 *
 * Bounds the pair search. In practice a band has a handful of runs at most, and
 * the plate is always among the wider ones — it just is not reliably the
 * widest, which is the whole reason the search exists.
 */
const MAX_RUNS_PER_COLOUR = 8;

/** Per-band diagnostics, exported for tuning. See `analyzeBands`. */
export interface BandDiagnostic {
  by0: number;
  by1: number;
  bandH: number;
  reject: string | null;
  blueRun?: [number, number];
  redRun?: [number, number];
  gap?: number;
  plateLuma?: number;
  plateFlat?: number;
  symmetry?: number;
  fill?: number;
  sharpness?: number;
  score?: number;
  /** Set when a profile expected the clock below the score row and none was found. */
  timerFallback?: boolean;
}

/** Near-white is "glyph ink" on a colour plate. */
const GLYPH_LUMA = 175;
/** Rows below this fraction of the peak white count are between glyph bands. */
const GLYPH_ROW_FLOOR = 0.15;
/** Padding added around the found digits, as a fraction of their height. */
const GLYPH_PAD = 0.18;

/**
 * The rows actually occupied by the score's numerals, within one x range.
 *
 * Measuring the *plate* instead was the subtler half of the venue-footage
 * failure, and it survived the first fix because a plate is genuinely found —
 * just not the part of it that matters. The alliance-name label sits on the
 * same coloured plate as the score, so a colour-based vertical extent has no
 * way to tell "NEWTON" from "332" and lands somewhere between them: measured
 * on real footage the chosen rows cut the digits in half horizontally, which
 * reads as confident garbage rather than as a failure.
 *
 * The numerals are white on colour, so they can be found directly. Of the
 * white row-bands in the box — the broadcast title, the alliance label, the
 * score — the score is the one with the most ink, because being the largest
 * text in the box is what makes it the score. That holds on both layouts we
 * have footage for: a Championship overlay with the label above the score, and
 * a district broadcast with team numbers inline beside it.
 */
function glyphRows(
  frame: RgbaFrame,
  x0: number,
  x1: number,
  ySearchLo: number,
  ySearchHi: number
): { top: number; bottom: number; mass: number } | null {
  const W = frame.width;
  const ax0 = Math.max(0, Math.round(x0));
  const ax1 = Math.min(W - 1, Math.round(x1));
  const ay0 = Math.max(0, Math.round(ySearchLo));
  const ay1 = Math.min(frame.height - 1, Math.round(ySearchHi));
  if (ax1 <= ax0 || ay1 <= ay0) return null;

  const counts = new Int32Array(ay1 - ay0 + 1);
  let peak = 0;
  for (let y = ay0; y <= ay1; y++) {
    let n = 0;
    for (let x = ax0; x <= ax1; x++) {
      const i = (y * W + x) * 4;
      if (frame.data[i] > GLYPH_LUMA && frame.data[i + 1] > GLYPH_LUMA && frame.data[i + 2] > GLYPH_LUMA) {
        n++;
      }
    }
    counts[y - ay0] = n;
    if (n > peak) peak = n;
  }
  if (peak === 0) return null;

  const floor = peak * GLYPH_ROW_FLOOR;
  let best: { top: number; bottom: number; mass: number } | null = null;
  let start = -1;
  let mass = 0;
  for (let i = 0; i <= counts.length; i++) {
    const v = i < counts.length ? counts[i] : -1;
    if (v >= floor) {
      if (start < 0) start = i;
      mass += v;
    } else if (start >= 0) {
      if (!best || mass > best.mass) best = { top: ay0 + start, bottom: ay0 + i - 1, mass };
      start = -1;
      mass = 0;
    }
  }
  return best;
}

/** Mean luma and desaturated fraction of a rectangle — the timer-plate test. */
function flatBrightness(
  frame: RgbaFrame,
  x0: number,
  x1: number,
  y0: number,
  y1: number
): { luma: number; flat: number } {
  const W = frame.width;
  const ax0 = Math.max(0, Math.round(x0));
  const ax1 = Math.min(W - 1, Math.round(x1));
  const ay0 = Math.max(0, Math.round(y0));
  const ay1 = Math.min(frame.height - 1, Math.round(y1));
  if (ax1 <= ax0 || ay1 <= ay0) return { luma: 0, flat: 0 };

  // Subsampled. This is a mean and a fraction over a solid-coloured plate, so a
  // few hundred samples answer it as well as sixty thousand do, and this runs
  // inside the innermost candidate loop.
  const stepX = Math.max(1, Math.floor((ax1 - ax0 + 1) / PLATE_SAMPLE_SIDE));
  const stepY = Math.max(1, Math.floor((ay1 - ay0 + 1) / PLATE_SAMPLE_SIDE));

  let lumaSum = 0;
  let flat = 0;
  let n = 0;
  for (let y = ay0; y <= ay1; y += stepY) {
    for (let x = ax0; x <= ax1; x += stepX) {
      const i = (y * W + x) * 4;
      const r = frame.data[i];
      const g = frame.data[i + 1];
      const b = frame.data[i + 2];
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      lumaSum += 0.299 * r + 0.587 * g + 0.114 * b;
      if (mx === 0 || (mx - mn) / mx < PLATE_FLAT_SAT) flat++;
      n++;
    }
  }
  return { luma: lumaSum / n, flat: flat / n };
}

/**
 * Score one candidate band and, if it survives, build the regions from it.
 *
 * Split out of `detectScoreRegions` because the fix for venue footage was to
 * stop trusting the *longest* band and start evaluating every candidate on its
 * merits — which requires running the whole geometry per candidate, not once.
 */
/**
 * How one event's scoreboard is laid out.
 *
 * Four real broadcasts in, the detector's core assumptions have held up well --
 * find the two colour masses, use the gap between them as a ruler -- but the
 * *proportions* around that skeleton are an art-direction choice, and every
 * event makes it differently. Rather than keep widening one set of constants
 * until it fits everything and fits nothing well (which regressed a validated
 * reference set once already), the parts that genuinely vary are named here and
 * selected per event.
 *
 * What deliberately is NOT in here: which alliance is on the left. That is
 * derived from pixel colour and already works -- Sunset Showdown puts red on
 * the left and the detector handled it with no changes at all.
 */
export interface LayoutProfile {
  name: string;
  /**
   * The score box, measured from the timer gap.
   *
   * `ratio` is its width as a multiple of the gap; `inset` shifts its inner
   * edge outward, also as a multiple of the gap.
   *
   * Both are derived from the gap because the gap is *stable*: it is fixed by
   * the layout and does not move as the score changes. That matters more than
   * it looks. Measuring the numerals directly was tried and abandoned -- it
   * frames any score perfectly in a single frame, but the box then changes
   * width every time the score gains a digit, and `detectScoreRegionsStable`
   * decides which frames agree by comparing quad centre and width. A Sunset
   * Showdown match running 41 -> 187 -> 192 produced boxes from 121px to 310px
   * wide and never reached consensus, so the scanner fell back to a guessed
   * start and the read collapsed to 13%. A fixed box that is merely *big
   * enough* beats a snug one that moves.
   *
   * `inset` exists because a plate's colour run does not always begin where the
   * score does. Sunset Showdown's circular timer badge overlaps the plate at
   * exactly the score's rows -- the badge is a circle and is widest there -- so
   * the run starts some 45px inside the badge, and a box anchored at the run
   * edge spends its first third on the badge and clips the outermost digit.
   */
  scoreBox: { mode: 'gap'; ratio: number; inset?: number };
  /**
   * Where the clock sits relative to the score row.
   *
   * `inline` means it shares the row, which is what a rectangular timer plate
   * between two score plates does. `below` is for a timer drawn as a tall badge
   * with the clock under a logo -- reusing the score's rows there reads the
   * logo instead of the time.
   */
  timer: { mode: 'inline' } | { mode: 'below' };
}

/** The FRC-season broadcast layout. Default, and the behaviour before profiles existed. */
export const FRC_BROADCAST: LayoutProfile = {
  name: 'frc-broadcast',
  scoreBox: { mode: 'gap', ratio: 0.95 },
  timer: { mode: 'inline' },
};

/**
 * Sunset Showdown: red on the left, a circular timer badge with the clock below
 * the event logo, and a score drawn wider than that badge.
 *
 * Both numbers are measured, not guessed. The badge overlaps each plate's
 * colour run by roughly a third of the gap at the score's rows, and the digits
 * then run a little over a gap's width beyond that.
 */
const SUNSET_SCORE_INSET = 0.16;
const SUNSET_SCORE_RATIO = 1.15;

export const SUNSET_SHOWDOWN: LayoutProfile = {
  name: 'sunset-showdown',
  scoreBox: { mode: 'gap', ratio: SUNSET_SCORE_RATIO, inset: SUNSET_SCORE_INSET },
  timer: { mode: 'below' },
};

export const LAYOUTS: Record<string, LayoutProfile> = {
  [FRC_BROADCAST.name]: FRC_BROADCAST,
  [SUNSET_SHOWDOWN.name]: SUNSET_SHOWDOWN,
};

/** Dark enough to be clock digits printed on a white badge. */
const TIMER_DARK_LUMA = 110;
/** A row this fraction of the peak dark count is part of the clock. */
const TIMER_ROW_FLOOR = 0.1;

const lumaAt = (d: Uint8ClampedArray, i: number) =>
  (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;

/** How bright a row must mostly be to still count as inside the timer badge. */
const BADGE_BRIGHT_FRACTION = 0.3;

/**
 * How far the bright timer badge extends below `fromY`.
 *
 * The bound `darkRowBand` needs. Rows holding the clock are still mostly
 * bright -- the digits are thin strokes on a light badge -- so the threshold is
 * low enough not to stop at the text, while the dark bar under the scoreboard
 * drops to essentially zero bright pixels and ends the walk cleanly.
 */
function brightExtentDown(
  frame: RgbaFrame,
  x0: number,
  x1: number,
  fromY: number,
  maxY: number
): number {
  const W = frame.width;
  const xa = Math.max(0, Math.round(x0));
  const xb = Math.min(W - 1, Math.round(x1));
  const cols = xb - xa + 1;
  const start = Math.max(0, Math.round(fromY));
  if (cols < 2) return start;

  let last = start;
  for (let y = start; y <= Math.min(frame.height - 1, Math.round(maxY)); y++) {
    let bright = 0;
    for (let x = xa; x <= xb; x++) {
      if (lumaAt(frame.data, (y * W + x) * 4) >= PLATE_MIN_LUMA) bright++;
    }
    if (bright < cols * BADGE_BRIGHT_FRACTION) break;
    last = y;
  }
  return last;
}

/**
 * The rows of dark text below the score row -- a clock printed on a light
 * badge. Returns the densest contiguous run, so a logo above it loses.
 *
 * Only meaningful when `sy1` is bounded to the badge itself: below it lie the
 * event-name bar and the field, which are a much larger dark mass than the
 * clock and win outright otherwise.
 */
function darkRowBand(
  frame: RgbaFrame,
  x0: number,
  x1: number,
  sy0: number,
  sy1: number
): readonly [number, number] | null {
  const W = frame.width;
  const xa = Math.max(0, Math.round(x0));
  const xb = Math.min(W - 1, Math.round(x1));
  const ya = Math.max(0, Math.round(sy0));
  const yb = Math.min(frame.height - 1, Math.round(sy1));
  const cols = xb - xa + 1;
  if (cols < 2 || yb - ya < 2) return null;

  const counts = new Int32Array(yb - ya + 1);
  let peak = 0;
  for (let y = ya; y <= yb; y++) {
    let n = 0;
    for (let x = xa; x <= xb; x++) {
      if (lumaAt(frame.data, (y * W + x) * 4) <= TIMER_DARK_LUMA) n++;
    }
    counts[y - ya] = n;
    if (n > peak) peak = n;
  }
  if (peak < cols * TIMER_ROW_FLOOR) return null;

  const thr = Math.max(1, peak * 0.25);
  let best: readonly [number, number] | null = null;
  let bestMass = 0;
  let start = -1;
  let mass = 0;
  for (let i = 0; i <= counts.length; i++) {
    const on = i < counts.length && counts[i] >= thr;
    if (on) {
      if (start < 0) {
        start = i;
        mass = 0;
      }
      mass += counts[i];
    } else if (start >= 0) {
      if (mass > bestMass) {
        bestMass = mass;
        best = [ya + start, ya + i - 1] as const;
      }
      start = -1;
    }
  }
  return best;
}

function evaluateBand(
  frame: RgbaFrame,
  cls: Uint8Array,
  both: Int32Array,
  prefB: Int32Array,
  prefR: Int32Array,
  by0: number,
  by1: number,
  diag: BandDiagnostic,
  profile: LayoutProfile
): { regions: DetectedRegions; score: number } | null {
  const W = frame.width;
  const H = frame.height;
  const bandH = by1 - by0 + 1;
  const reject = (why: string) => {
    diag.reject = why;
    return null;
  };

  if (bandH > H * BAND_MAX_HEIGHT) return reject('band too tall');

  // Column profiles from the prefix sums: O(W) per band instead of O(W*bandH).
  // That is what makes evaluating ~100 overlapping candidate windows per frame
  // affordable, which is in turn what makes the bar findable when it is fused
  // with the crowd behind it.
  const colB = new Int32Array(W);
  const colR = new Int32Array(W);
  const lo = by0 * W;
  const hi = (by1 + 1) * W;
  for (let x = 0; x < W; x++) {
    colB[x] = prefB[hi + x] - prefB[lo + x];
    colR[x] = prefR[hi + x] - prefR[lo + x];
  }

  // Edge contrast is a property of the band, not of any one run — compute it
  // once. An opaque graphic has hard edges; stage lighting fades into its
  // surroundings.
  const meanOf = (a: number, b: number) => {
    let s = 0;
    let n = 0;
    for (let y = Math.max(0, a); y <= Math.min(both.length - 1, b); y++) {
      s += both[y];
      n++;
    }
    return n ? s / n : 0;
  };
  const inside = meanOf(by0, by1);
  const outside = meanOf(by0 - bandH, by0 - 1) + meanOf(by1 + 1, by1 + bandH);
  const sharpness = inside / (outside + 1);
  diag.sharpness = sharpness;
  // Soft term, not a hard filter. A window carved out of a larger fused mass —
  // which is exactly the case this detector has to survive — has no edge
  // contrast by construction, so rejecting on it would throw away the right
  // answer. The white-plate test is what actually discriminates; sharpness only
  // breaks ties in favour of a band that really does stand alone.
  const sharpTerm = Math.max(
    MIN_SHARPNESS_TERM,
    Math.min(1, sharpness / SHARPNESS_CLAMP)
  );

  // Every run of each colour, widest first — NOT just the widest.
  //
  // Taking the widest was the second half of the venue-footage failure. Inside
  // the correct band, an arena lit blue on one side and red on the other puts a
  // crowd-lit run far wider than the actual score plate in both colour
  // profiles, so the "widest" pair bracketed most of the frame and the gap test
  // rejected a band that was in fact exactly right. Which run is the plate is
  // not knowable from width; it is knowable from the pair geometry, so enumerate
  // pairs and let the same scoreboard tests choose.
  const byWidth = (runs: [number, number][]) =>
    runs.sort((a, b) => b[1] - b[0] - (a[1] - a[0])).slice(0, MAX_RUNS_PER_COLOUR);
  const blueRuns = byWidth(runsAbove(colB, bandH * 0.25, 8));
  const redRuns = byWidth(runsAbove(colR, bandH * 0.25, 8));
  if (!blueRuns.length || !redRuns.length) return reject('no colour runs');

  let bestPair: {
    blueRun: [number, number];
    redRun: [number, number];
    blueFirst: boolean;
    gapStart: number;
    gapEnd: number;
    gap: number;
    score: number;
    symmetry: number;
    fill: number;
    plate: { luma: number; flat: number };
  } | null = null;
  let lastReject = 'no viable run pair';

  for (const blueRun of blueRuns) {
    for (const redRun of redRuns) {
      // Blue left of red, or mirrored — either way the facing edges bracket the
      // timer. Overlapping runs cannot be the two halves of one bar.
      const blueFirst = blueRun[1] < redRun[0];
      const disjoint = blueFirst || redRun[1] < blueRun[0];
      if (!disjoint) {
        lastReject = 'runs overlap';
        continue;
      }
      const gapStart = blueFirst ? blueRun[1] : redRun[1];
      const gapEnd = blueFirst ? redRun[0] : blueRun[0];
      const gap = gapEnd - gapStart;
      if (gap < W * GAP_MIN || gap > W * GAP_MAX) {
        lastReject = 'gap out of range';
        continue;
      }

      // Cheapest tests first. The white-plate test is by far the most expensive
      // — it reads pixels, where these only read the already-computed column
      // profile — and this loop runs for every run pair of every candidate
      // window, so ordering it last is the difference between the detector
      // taking milliseconds and taking most of a second per frame.
      const wB = blueRun[1] - blueRun[0] + 1;
      const wR = redRun[1] - redRun[0] + 1;
      const symmetry = 1 - Math.abs(wB - wR) / Math.max(wB, wR);
      if (symmetry < MIN_SYMMETRY) {
        lastReject = 'runs asymmetric';
        continue;
      }

      let bHit = 0;
      let rHit = 0;
      for (let x = blueRun[0]; x <= blueRun[1]; x++) bHit += colB[x];
      for (let x = redRun[0]; x <= redRun[1]; x++) rHit += colR[x];
      const fill = Math.min(bHit / (wB * bandH), rHit / (wR * bandH));
      if (fill < MIN_FILL) {
        lastReject = 'runs too sparse';
        continue;
      }

      // Only now: is there actually a white timer plate in that gap? This is
      // the decisive test, but it is also the only one that touches pixels.
      const plate = flatBrightness(frame, gapStart, gapEnd, by0, by1);
      if (plate.luma < PLATE_MIN_LUMA || plate.flat < PLATE_MIN_FLAT_FRACTION) {
        lastReject = 'no white plate in gap';
        continue;
      }

      const score = symmetry * fill * sharpTerm;
      if (!bestPair || score > bestPair.score) {
        bestPair = { blueRun, redRun, blueFirst, gapStart, gapEnd, gap, score, symmetry, fill, plate };
      }
    }
  }

  if (!bestPair) return reject(lastReject);

  const { blueRun, redRun, blueFirst, gapStart, gapEnd, gap, score } = bestPair;
  diag.blueRun = blueRun;
  diag.redRun = redRun;
  diag.gap = gap;
  diag.plateLuma = bestPair.plate.luma;
  diag.plateFlat = bestPair.plate.flat;
  diag.symmetry = bestPair.symmetry;
  diag.fill = bestPair.fill;
  diag.score = score;

  // Both edges walk outward from the plate's inner edge: `inset` past whatever
  // the layout puts there before the score starts, then `ratio` of box.
  const boxW = gap * profile.scoreBox.ratio;
  const off = gap * (profile.scoreBox.inset ?? 0);
  const outward = (edge: number, dir: 1 | -1) =>
    [edge + dir * off, edge + dir * (off + boxW)] as const;
  const ordered = (r: readonly [number, number]) =>
    (r[0] <= r[1] ? r : ([r[1], r[0]] as const));

  const blueX = ordered(outward(blueFirst ? blueRun[1] : blueRun[0], blueFirst ? -1 : 1));
  const redX = ordered(outward(blueFirst ? redRun[0] : redRun[1], blueFirst ? 1 : -1));

  // Vertical extent: the score plate is solid colour on the main row and gives
  // way to the darker team-number sub-row beneath, so walk down the score box's
  // own columns until the colour stops.
  //
  // Searched over a generous margin ABOVE and BELOW the band, not just inside
  // it. The band is now whichever search window happened to win, and window
  // offsets are quantised by the stride — so clipping the plate's extent to the
  // window made the reported height jump around by tens of pixels between
  // otherwise identical frames, which is exactly the jitter that stops
  // `detectScoreRegionsStable` from ever reaching consensus. Growing outward
  // measures the plate itself, so the answer no longer depends on which window
  // found it.
  const yLimit = cls.length / W - 1;
  const plateRows = (xa: number, xb: number, want: number): [number, number] => {
    const x0 = Math.max(0, Math.round(xa));
    const x1 = Math.min(W - 1, Math.round(xb));
    const span = Math.max(1, x1 - x0 + 1);
    const sy0 = Math.max(0, by0 - bandH);
    const sy1 = Math.min(yLimit, by1 + bandH);
    const rows = new Int32Array(sy1 - sy0 + 1);
    for (let y = sy0; y <= sy1; y++) {
      let n = 0;
      for (let x = x0; x <= x1; x++) if (cls[y * W + x] === want) n++;
      rows[y - sy0] = n;
    }
    // Of the runs that actually overlap the band we scored, take the longest —
    // overlap is what keeps this from wandering onto a different graphic in the
    // margin we just opened up.
    const runs = runsAbove(rows, span * 0.4, 3)
      .map(([a, b]) => [sy0 + a, sy0 + b] as [number, number])
      .filter(([a, b]) => b >= by0 && a <= by1);
    const run = longestRun(runs);
    return run ?? [by0, by1];
  };

  // Search the plate's colour extent first, then find the numerals inside it.
  // The colour pass sets a sane window; the glyph pass is what actually decides
  // the crop, because only it can tell the score from the label sharing its
  // plate.
  const [pbTop, pbBot] = plateRows(blueX[0], blueX[1], 1);
  const [prTop, prBot] = plateRows(redX[0], redX[1], 2);
  const searchLo = Math.min(pbTop, prTop) - bandH;
  const searchHi = Math.max(pbBot, prBot) + bandH;

  const bGlyph = glyphRows(frame, blueX[0], blueX[1], searchLo, searchHi);
  const rGlyph = glyphRows(frame, redX[0], redX[1], searchLo, searchHi);
  if (!bGlyph || !rGlyph) return reject('no numerals in plates');

  // Both scores sit on one baseline at one cap height, so the two independent
  // measurements should overlap. When they do, their union is the row range —
  // it recovers a short digit ("1") from its taller neighbour. When they do
  // not, the pair is not one scoreboard and is rejected rather than averaged
  // into something that crops both.
  const overlap =
    Math.min(bGlyph.bottom, rGlyph.bottom) - Math.max(bGlyph.top, rGlyph.top) + 1;
  if (overlap < MIN_PLATE_ROWS) return reject('numeral rows disagree');

  const gTop = Math.min(bGlyph.top, rGlyph.top);
  const gBot = Math.max(bGlyph.bottom, rGlyph.bottom);
  const pad = Math.max(2, Math.round((gBot - gTop + 1) * GLYPH_PAD));
  const byTop = gTop - pad;
  const byBot = gBot + pad;
  const [ryTop, ryBot] = [byTop, byBot];

  // Inset to drop the plate's own border, which otherwise segments as a
  // full-height bar and is read as a leading `1`.
  const inset = (a: number, b: number, f: number) => {
    const d = (b - a) * f;
    return [a + d, b - d] as const;
  };
  const [bx0, bx1] = inset(blueX[0], blueX[1], 0.04);
  const [rx0, rx1] = inset(redX[0], redX[1], 0.04);
  // No vertical inset any more: the 6% shrink existed to pull the crop off a
  // colour-measured plate's own border, and the rows are now measured from the
  // numerals themselves and already padded outward by `GLYPH_PAD`. Insetting
  // here would eat that padding straight back off the digits.
  const [byA, byB] = [byTop, byBot + 1];
  const [ryA, ryB] = [ryTop, ryBot + 1];

  // The timer plate fills the gap. Its vertical extent is the alliance plates'
  // main row — the sub-row underneath (`2 / 6  :08` on the reference feed) is a
  // second line of text and must stay out of the crop — so the blue plate's own
  // rows are reused rather than re-measured off a white plate whose colour the
  // classifier deliberately ignores.
  const [tx0, tx1] = inset(gapStart, gapEnd, 0.07);

  // A timer drawn as a tall badge puts the clock under a logo, so the score's
  // own rows land on the logo. Find the clock as the densest run of dark text
  // beneath the score row instead.
  let tyA = byA;
  let tyB = byB;
  if (profile.timer.mode === 'below') {
    // Bounded to the badge, not to a multiple of the row height: below the
    // badge sit the event-name bar and the field, and searching into them
    // found a dark mass hundreds of rows tall instead of the clock.
    const badgeBottom = brightExtentDown(frame, tx0, tx1, byB, H - 1);
    const found =
      badgeBottom > byB + 4 ? darkRowBand(frame, tx0, tx1, byB, badgeBottom) : null;
    if (found) {
      const padT = Math.max(2, Math.round((found[1] - found[0] + 1) * GLYPH_PAD));
      tyA = found[0] - padT;
      tyB = found[1] + padT + 1;
    } else {
      diag.timerFallback = true;
    }
  }

  return {
    score,
    regions: {
      blue: rectQuad(bx0 / W, byA / H, bx1 / W, byB / H),
      red: rectQuad(rx0 / W, ryA / H, rx1 / W, ryB / H),
      timer: rectQuad(tx0 / W, tyA / H, tx1 / W, tyB / H),
    },
  };
}

/**
 * Shared front half of the search: classify the strip, build the column prefix
 * sums, and enumerate candidate bands.
 *
 * Candidates are the natural runs of both-colour rows *plus* a multi-scale
 * sliding window over the whole strip. The sliding window is not redundant: a
 * single row-profile threshold cannot separate the bar from what is behind it.
 * On real Championship footage the crowd directly below the scoreboard is lit
 * blue on the left and red on the right — a giant, low-contrast copy of the
 * scoreboard's own colour layout — so the two fuse into one 300-row run and no
 * choice of threshold carves the bar back out. Enumerating windows regardless
 * of the profile, and letting the white-plate and geometry tests pick the
 * winner, is what finds it.
 *
 * The prefix sums are what make that affordable: with them each candidate costs
 * O(width) rather than O(width × height), so ~100 overlapping windows is a few
 * hundred thousand operations rather than tens of millions.
 */
function bandCandidates(frame: RgbaFrame): {
  cls: Uint8Array;
  both: Int32Array;
  prefB: Int32Array;
  prefR: Int32Array;
  bands: [number, number][];
} {
  const W = frame.width;
  const H = frame.height;
  const yMax = Math.max(8, Math.round(H * SEARCH_DEPTH));

  const cls = new Uint8Array(W * yMax);
  const rowB = new Int32Array(yMax);
  const rowR = new Int32Array(yMax);
  // Row y of the prefix arrays holds the count over rows [0, y), so a band
  // [y0, y1] is pref[(y1+1)*W + x] - pref[y0*W + x].
  const prefB = new Int32Array(W * (yMax + 1));
  const prefR = new Int32Array(W * (yMax + 1));

  for (let y = 0; y < yMax; y++) {
    const row = y * W;
    const next = (y + 1) * W;
    for (let x = 0; x < W; x++) {
      const i = (row + x) * 4;
      const c = classifyPixel(frame.data[i], frame.data[i + 1], frame.data[i + 2]);
      cls[row + x] = c;
      if (c === 1) rowB[y]++;
      else if (c === 2) rowR[y]++;
      prefB[next + x] = prefB[row + x] + (c === 1 ? 1 : 0);
      prefR[next + x] = prefR[row + x] + (c === 2 ? 1 : 0);
    }
  }

  // The bar is a band with a lot of BOTH colours on the same rows. Requiring
  // both is what rejects a purple-lit crowd and a blue-only banner.
  const both = new Int32Array(yMax);
  for (let y = 0; y < yMax; y++) both[y] = Math.min(rowB[y], rowR[y]);

  const maxH = Math.round(H * BAND_MAX_HEIGHT);
  const bands: [number, number][] = [];
  const seen = new Set<number>();
  const push = (a: number, b: number) => {
    if (a < 0 || b >= yMax || b - a + 1 < 3) return;
    const key = a * 100000 + b;
    if (seen.has(key)) return;
    seen.add(key);
    bands.push([a, b]);
  };

  for (const [a, b] of runsAbove(both, W * BAND_MIN_MASS, 3)) {
    if (b - a + 1 <= maxH) push(a, b);
  }
  for (const frac of WINDOW_HEIGHTS) {
    const h = Math.max(4, Math.round(H * frac));
    if (h > yMax) continue;
    const stride = Math.max(2, Math.round(h * WINDOW_STRIDE));
    for (let y = 0; y + h - 1 < yMax; y += stride) push(y, y + h - 1);
  }

  return { cls, both, prefB, prefR, bands };
}

/**
 * Every candidate band with its metrics and rejection reason — the tuning
 * instrument for the constants above, and the first thing to reach for when
 * the detector picks the wrong thing on new footage.
 */
export function analyzeBands(
  frame: RgbaFrame,
  profile: LayoutProfile = FRC_BROADCAST
): BandDiagnostic[] {
  const { cls, both, prefB, prefR, bands } = bandCandidates(frame);
  return bands.map(([by0, by1]) => {
    const diag: BandDiagnostic = { by0, by1, bandH: by1 - by0 + 1, reject: null };
    evaluateBand(frame, cls, both, prefB, prefR, by0, by1, diag, profile);
    return diag;
  });
}

/**
 * Find the two score plates in a frame, with no operator input.
 *
 * The geometry that makes this tractable is that the bar is *symmetric about the
 * match timer*: a blue mass, a non-alliance-coloured timer plate, then a red
 * mass. So rather than trying to tell a score plate from an alliance-name plate
 * by colour — they are the same colour — we find the gap between the two masses
 * and use it as the ruler. The timer plate and the two score plates are all
 * about one 3-digit box wide, so the score box is the gap's width taken inward
 * from each mass's facing edge.
 *
 * Every candidate band is scored and the best one wins. It used to take the
 * *longest* band, which is a proxy for "most scoreboard-like" that holds only
 * on a clean broadcast: in an arena lit blue on one side and red on the other,
 * the ceiling lighting truss is a far longer both-colours band than the actual
 * scoreboard, so the detector confidently measured the lighting rig and
 * returned null when the geometry made no sense. Length was never the signal —
 * the white timer plate bracketed by two same-width colour blocks is.
 *
 * Returns null when the frame does not look like a scoreboard at all, which the
 * caller reports rather than silently leaving the quads where they were.
 */
export function detectScoreRegions(
  frame: RgbaFrame,
  profile: LayoutProfile = FRC_BROADCAST
): DetectedRegions | null {
  const { cls, both, prefB, prefR, bands } = bandCandidates(frame);

  let best: { regions: DetectedRegions; score: number } | null = null;
  for (const [by0, by1] of bands) {
    const diag: BandDiagnostic = { by0, by1, bandH: by1 - by0 + 1, reject: null };
    const cand = evaluateBand(frame, cls, both, prefB, prefR, by0, by1, diag, profile);
    if (cand && (!best || cand.score > best.score)) best = cand;
  }
  return best ? best.regions : null;
}

/** How closely two detections must agree to count as the same, as a frame fraction. */
const STABLE_TOLERANCE = 0.01;
/** Fraction of supplied frames that must agree. */
const STABLE_QUORUM = 0.6;

/** Centre of a quad, in 0..1 frame fractions. */
function quadCentre(q: Quad): { x: number; y: number } {
  return {
    x: q.reduce((s, p) => s + p.x, 0) / 4,
    y: q.reduce((s, p) => s + p.y, 0) / 4,
  };
}

/**
 * Detect across several frames and return the consensus.
 *
 * A single frame is a coin flip on footage this noisy — a camera cut, a replay
 * wipe or one flicker of stage lighting is enough to move or lose the answer.
 * The scoreboard, by contrast, is pinned to one screen position for an entire
 * broadcast, so agreement across frames spread over tens of seconds is very
 * strong evidence and disagreement is very cheap to detect. This costs only
 * colour maths, no OCR, so unattended callers should always prefer it over the
 * single-frame version.
 *
 * Returns the median detection among the agreeing majority, or null if no
 * majority agrees.
 */
export function detectScoreRegionsStable(
  frames: RgbaFrame[],
  profile: LayoutProfile = FRC_BROADCAST
): DetectedRegions | null {
  const found = frames
    .map((f) => detectScoreRegions(f, profile))
    .filter((r): r is DetectedRegions => r !== null);
  if (!found.length) return null;

  const need = Math.max(2, Math.ceil(frames.length * STABLE_QUORUM));

  // Cluster on horizontal position and width, NOT on vertical extent.
  //
  // Those answer different questions. Where a plate sits horizontally, and how
  // wide it is, say *which object* the detector locked onto — the scoreboard
  // and a mis-detected patch of lit crowd are hundreds of pixels and a
  // multiple of width apart, so they never cluster together. The plate's
  // vertical extent, by contrast, is a noisy measurement of the *same* object:
  // it shifts by tens of pixels frame to frame as the digits change and the
  // alliance-name label above merges or does not. Clustering on it rejected
  // frames that had found exactly the right thing, and no consensus was ever
  // reached. So agreement is judged on x, and the y extent is then taken as the
  // median across the agreeing frames — which is precisely how you should treat
  // repeated noisy measurements of one quantity.
  const width = (q: Quad) => Math.max(...q.map((p) => p.x)) - Math.min(...q.map((p) => p.x));
  let bestCluster: DetectedRegions[] = [];
  for (const anchor of found) {
    const ab = quadCentre(anchor.blue);
    const ar = quadCentre(anchor.red);
    const aw = width(anchor.blue);
    const cluster = found.filter((r) => {
      const b = quadCentre(r.blue);
      const rc = quadCentre(r.red);
      return (
        Math.abs(b.x - ab.x) <= STABLE_TOLERANCE &&
        Math.abs(rc.x - ar.x) <= STABLE_TOLERANCE &&
        Math.abs(width(r.blue) - aw) <= STABLE_TOLERANCE
      );
    });
    if (cluster.length > bestCluster.length) bestCluster = cluster;
  }
  if (bestCluster.length < need) return null;

  // Median rather than mean: one outlier that squeaked into the cluster should
  // not drag the answer, and the quads are axis-aligned so this is well-defined.
  const median = (vals: number[]) => {
    const s = [...vals].sort((a, b) => a - b);
    return s[s.length >> 1];
  };
  const medQuad = (pick: (r: DetectedRegions) => Quad): Quad =>
    [0, 1, 2, 3].map((i) => ({
      x: median(bestCluster.map((r) => pick(r)[i].x)),
      y: median(bestCluster.map((r) => pick(r)[i].y)),
    })) as Quad;

  return {
    blue: medQuad((r) => r.blue),
    red: medQuad((r) => r.red),
    timer: medQuad((r) => r.timer),
  };
}
