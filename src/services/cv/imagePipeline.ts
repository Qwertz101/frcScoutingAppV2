/**
 * The image half of the CV Scoreboard Tracker.
 *
 * Everything here is plain canvas / typed-array maths — no image library. The
 * chain is: video frame -> perspective-rectify the operator's 4-point quad ->
 * split into a blue crop and a red crop -> grayscale, contrast-stretch, upscale
 * and binarize each crop -> hand the result to tesseract.
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

export const DEFAULT_QUAD: Quad = [
  { x: 0.28, y: 0.06 },
  { x: 0.72, y: 0.06 },
  { x: 0.72, y: 0.2 },
  { x: 0.28, y: 0.2 },
];

/** Rectified scoreboard size. Wide and short — it is a score strip. */
export const RECT_W = 640;
export const RECT_H = 160;

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
  frame: ImageData,
  quadFrac: Quad,
  w = RECT_W,
  h = RECT_H
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
 * Keep only the blobs that could be a numeral and redraw them on clean white.
 *
 * This is where most of the accuracy comes from. The two things that wrecked the
 * naive pipeline were (a) leftover speckle, and (b) the alliance-colour block
 * edge and centre divider surviving as tall solid bars that tesseract happily
 * read as `1`. Both are trivially separable from a digit by shape:
 *
 *   - a digit is a decent fraction of the strip height, but not all of it;
 *   - a digit is taller than it is wide (or close to square), never a slab;
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
      cw <= ch * 1.6 && // not a slab
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

  const gap = Math.max(4, Math.round(medH * gapFactor));
  const baseline = Math.max(...onLine.map((k) => k.c.y1));
  const top = Math.min(...onLine.map((k) => k.c.y0));
  const oh = baseline - top + 1;

  const widths = onLine.map((k) => k.c.x1 - k.c.x0 + 1);
  const ow = widths.reduce((a, b) => a + b, 0) + gap * (onLine.length - 1);
  const out = new Uint8ClampedArray(Math.max(1, ow) * oh).fill(255);

  let penX = 0;
  for (let gi = 0; gi < onLine.length; gi++) {
    const { id, c } = onLine[gi];
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
  return { plane: { data: out, width: ow, height: oh }, count: onLine.length };
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
  const binary = sauvolaThreshold(upscale(gray, o.upscaleBy), undefined, o.sauvolaK);

  const line = segmentDigits(binary, o.gapFactor);
  if (!line) return null;
  return {
    plane: padWhite(scaleToHeight(line.plane, o.targetH), 24),
    digitCount: line.count,
  };
}

/** Wrap a grayscale plane back into RGBA ImageData for canvas / tesseract. */
export function grayToImageData(plane: GrayPlane): ImageData {
  const rgba = new Uint8ClampedArray(plane.width * plane.height * 4);
  for (let i = 0; i < plane.data.length; i++) {
    const v = plane.data[i];
    rgba[i * 4] = v;
    rgba[i * 4 + 1] = v;
    rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
  return new ImageData(rgba, plane.width, plane.height);
}

/* ------------------------------------------------------------------ *
 * Crop geometry
 * ------------------------------------------------------------------ */

export interface CropLayout {
  /** Fraction of the rectified width where the blue/red halves meet. */
  split: number;
  /** True when red is drawn on the left of the scoreboard. */
  swapped: boolean;
}

export const DEFAULT_LAYOUT: CropLayout = { split: 0.5, swapped: false };

/**
 * Split the rectified strip into the two score crops.
 *
 * The inset either side of the split is what keeps the centre furniture — the
 * divider and, far more dangerously, the match clock — out of both crops. It is
 * deliberately generous: a 3% inset let a digit of the "1:23" clock leak into
 * the red crop, and since the clock is present in every frame the leak was
 * perfectly consistent, so a red score of 39 read as 139 for an entire match
 * with nothing downstream able to tell it was wrong. The scores themselves sit
 * well out toward the ends of the strip, so there is nothing to lose here.
 */
const SPLIT_INSET = 0.09;
export function splitCrops(
  rect: GrayPlane,
  layout: CropLayout
): { blue: GrayPlane; red: GrayPlane } {
  const mid = Math.round(rect.width * Math.min(Math.max(layout.split, 0.15), 0.85));
  const inset = Math.round(rect.width * SPLIT_INSET);

  const left = cropGray(rect, 0, 0, Math.max(1, mid - inset), rect.height);
  const right = cropGray(rect, mid + inset, 0, Math.max(1, rect.width - mid - inset), rect.height);

  return layout.swapped ? { blue: right, red: left } : { blue: left, red: right };
}
