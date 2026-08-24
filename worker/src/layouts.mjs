/**
 * Which scoreboard layout an event uses.
 *
 * The detector's shared engine -- find the two colour masses, use the gap
 * between them as a ruler -- has held across every broadcast tried. What has
 * not held is the art direction around it, and the lesson from trying to make
 * one set of constants serve everything is that it does not: widening the glyph
 * search to fix IRI moved the found band on the Cagle reference clips and
 * dropped identification from 3/4 to 1/4. So the parts that genuinely vary are
 * named in `LayoutProfile` (see `src/services/cv/imagePipeline.ts`) and bound to
 * an event here.
 *
 * Adding an event is deliberately a two-step job: probe it, then name it.
 *
 *   node worker/tools/layout-probe.mjs <url> <seconds> probe --layout <name>
 *
 * Render the crops it writes and confirm they hold the score and the clock
 * before adding a row below. The failure this guards against is not a crash --
 * it is a detector that returns plausible-looking numbers read off the wrong
 * part of the overlay, which no summary statistic reveals.
 */

import { LAYOUTS, FRC_BROADCAST } from './core.mjs';

/**
 * Event key -> layout name. Anything absent gets `frc-broadcast`, which is the
 * FRC-season layout and the behaviour that predates profiles existing.
 */
export const EVENT_LAYOUTS = {
  // Red on the left, a circular timer badge with the clock under the event
  // logo, and a score drawn wider than that badge. Verified 2026-08-24 against
  // the Saturday broadcast: red 613, clock 1:17, blue 301.
  '2026sunshow': 'sunset-showdown',
};

/** The profile for an event, honouring an explicit override first. */
export function resolveLayout(eventKey, override) {
  const name =
    override ?? EVENT_LAYOUTS[String(eventKey ?? '').toLowerCase()] ?? FRC_BROADCAST.name;
  const profile = LAYOUTS[name];
  if (!profile) {
    throw new Error(
      'unknown layout "' + name + '". known: ' + Object.keys(LAYOUTS).join(', ')
    );
  }
  return profile;
}
