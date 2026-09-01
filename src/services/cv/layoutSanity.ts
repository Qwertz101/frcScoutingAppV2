/**
 * Does a calibrated layout actually point at the scoreboard?
 *
 * A layout is saved once and then trusted by every machine scanning the event,
 * so a bad one is expensive: it does not fail loudly, it quietly returns wrong
 * numbers for a whole competition. That is not hypothetical — a Sunset Showdown
 * layout was saved with its timer box sitting on the crowd behind the overlay,
 * and the run that used it read the clock on 0% of frames and mis-identified a
 * match, all without a single error.
 *
 * The checks here are deliberately shallow. They do not ask "are these boxes
 * optimal", which needs the OCR stack and a person's judgement; they ask "is
 * there any chance this is the thing you named", which is answerable from a
 * few thousand pixels and catches the failure that actually happens — a box
 * displaced onto bleachers, a label bar, or the empty field.
 */

import type { LayoutRect } from '../../types';

/** A raw RGBA frame. Browser `ImageData` satisfies this structurally. */
export interface SanityFrame {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

export interface SanityWarning {
  element: string;
  message: string;
}

interface Stats {
  r: number;
  g: number;
  b: number;
  luma: number;
  /** Fraction of pixels markedly brighter than the box's own mean — the glyphs. */
  brightFrac: number;
  /** Fraction markedly darker. On a score plate this should be ~nothing. */
  darkFrac: number;
  /** Spread of luma. A flat box (all bleachers, all plate) has very little. */
  contrast: number;
  /** Spread between the mean channels. A white or black plate is ~0; scenery is not. */
  colourfulness: number;
}

function sample(frame: SanityFrame, rect: LayoutRect): Stats | null {
  const x0 = Math.max(0, Math.round(rect.x0 * frame.width));
  const x1 = Math.min(frame.width, Math.round(rect.x1 * frame.width));
  const y0 = Math.max(0, Math.round(rect.y0 * frame.height));
  const y1 = Math.min(frame.height, Math.round(rect.y1 * frame.height));
  if (x1 - x0 < 3 || y1 - y0 < 3) return null;

  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const lumas: number[] = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * frame.width + x) * 4;
      const pr = frame.data[i];
      const pg = frame.data[i + 1];
      const pb = frame.data[i + 2];
      r += pr;
      g += pg;
      b += pb;
      lumas.push(0.299 * pr + 0.587 * pg + 0.114 * pb);
      n++;
    }
  }
  if (!n) return null;
  const luma = lumas.reduce((a, v) => a + v, 0) / n;
  let varSum = 0;
  let bright = 0;
  let dark = 0;
  for (const v of lumas) {
    varSum += (v - luma) * (v - luma);
    if (v > luma + 40) bright++;
    if (v < luma - 45) dark++;
  }
  const mr = r / n;
  const mg = g / n;
  const mb = b / n;
  return {
    r: mr,
    g: mg,
    b: mb,
    luma,
    brightFrac: bright / n,
    darkFrac: dark / n,
    contrast: Math.sqrt(varSum / n),
    colourfulness: Math.max(mr, mg, mb) - Math.min(mr, mg, mb),
  };
}

/**
 * Warnings about a layout, judged against one frame it was drawn on.
 *
 * Advisory, never blocking. The person looking at the frame knows things this
 * cannot — an unusual overlay, a frame caught mid-transition — so the job here
 * is to say "look again at this one", not to overrule them.
 */
export function checkLayout(
  frame: SanityFrame,
  boxes: Record<string, LayoutRect | LayoutRect[]>
): SanityWarning[] {
  const out: SanityWarning[] = [];

  const one = (element: string, rect: LayoutRect, check: (s: Stats) => string | null) => {
    const s = sample(frame, rect);
    if (!s) {
      out.push({ element, message: 'is too small to read anything from.' });
      return;
    }
    const msg = check(s);
    if (msg) out.push({ element, message: msg });
  };

  // An alliance score plate is a large flat block of its own colour. If the
  // box has drifted off it, the colour goes first and most obviously.
  const alliance = (element: string, rect: LayoutRect, want: 'red' | 'blue') =>
    one(element, rect, (s) => {
      const dominant = want === 'red' ? s.r - Math.max(s.g, s.b) : s.b - Math.max(s.r, s.g);
      if (dominant < 25) {
        return `does not look ${want} — the pixels there average rgb(${Math.round(s.r)}, ${Math.round(
          s.g
        )}, ${Math.round(s.b)}). Is it still on the score plate?`;
      }
      // A plate is one flat colour behind bright glyphs and nothing else, so a
      // meaningful dark region means the box has run off its edge — onto the
      // label bar below it, most often, which is what happens when a box is
      // dragged too tall. Measured on Sunset Showdown: 0.15-0.20 of the box
      // dark when it overhung the bar, against 0.000-0.003 once corrected.
      if (s.darkFrac > 0.06) {
        return `is ${Math.round(
          s.darkFrac * 100
        )}% dark pixels. A score plate is one flat colour, so the box has probably run past its edge.`;
      }
      if (s.brightFrac < 0.04) return 'has no bright digits in it — it may be beside the number rather than on it.';
      if (s.brightFrac > 0.62) return 'is almost entirely bright, so it is probably not framing digits.';
      return null;
    });

  if (boxes.redScore && !Array.isArray(boxes.redScore)) alliance('Red score', boxes.redScore, 'red');
  if (boxes.blueScore && !Array.isArray(boxes.blueScore)) alliance('Blue score', boxes.blueScore, 'blue');

  // The timer sits on a light plate with dark digits, which is the single most
  // distinctive patch on the overlay and the one that failed in the field.
  if (boxes.timer && !Array.isArray(boxes.timer)) {
    one('Timer', boxes.timer, (s) => {
      if (s.contrast < 25) return 'is nearly flat — there are no digits inside it.';
      // Neutrality, not brightness, is what separates the clock plate from the
      // scene behind the overlay. The plate is white or near-black; either way
      // its channels agree. Bleachers, floor and crowd never do. This is the
      // check that a real bad layout needed: its timer box averaged
      // rgb(142,121,102) -- brown seating -- at a luma of 125, high enough that
      // a brightness test waved it through.
      if (s.colourfulness > 22) {
        return `averages rgb(${Math.round(s.r)}, ${Math.round(s.g)}, ${Math.round(
          s.b
        )}), which is not the neutral plate the clock sits on. It looks like it is on the scene behind the overlay.`;
      }
      return null;
    });
  }

  for (const key of ['redTeams', 'blueTeams'] as const) {
    const list = boxes[key];
    if (!Array.isArray(list)) continue;
    const label = key === 'redTeams' ? 'Red teams' : 'Blue teams';
    list.forEach((rect, i) => {
      one(`${label} ${i + 1}`, rect, (s) =>
        s.contrast < 18 ? 'is nearly flat — no team number appears to be inside it.' : null
      );
    });
  }

  return out;
}
