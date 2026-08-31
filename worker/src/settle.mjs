/**
 * The points the scoreboard never showed us.
 *
 * Every match this pipeline reads finishes a little short, and always in the
 * same direction: IRI qm54 -20/-7, qm55 0/-3, qm56 -4/-19, Sunset qm2 -10/-21.
 * Never over. The cause is physical rather than an OCR fault -- fuel still in
 * flight when the buzzer goes is counted by the field afterwards, and the
 * broadcast has usually cut away from the scoreboard by the time it lands.
 *
 * So the shortfall is real scoring that happened, and dropping it makes every
 * auto-captured match disagree with the official result. This adds it back at
 * the end of the match, where it was actually earned.
 *
 * **Three guards, because inventing points is worse than missing them.**
 *
 * The gap is only back-filled when the match is identified (an unidentified log
 * has no official score to trust), when the gap is positive (reading OVER the
 * official total is a different bug and must not be papered over), and when it
 * is small enough to be settling rather than a misread. A 300-point "shortfall"
 * is not fuel landing late, it is a broken read, and silently topping it up to
 * the right answer would hide exactly the failure the quality score exists to
 * surface.
 *
 * Back-filled points are recorded on the log as `settleBackfill`, so nothing
 * downstream mistakes them for something the tracker watched happen.
 */

import { MATCH_LEN } from './core.mjs';

/**
 * Largest gap that will be treated as late-landing fuel.
 *
 * Measured gaps across four graded matches run 0-21 points. This sits well
 * above that so a normal settle always passes, and well below the couple of
 * hundred points that separates a genuine read from a broken one. A late climb
 * can also land here legitimately, which is the other reason not to set it
 * tight.
 */
export const MAX_BACKFILL = 60;

/** How many seconds at the end of the match the gap is spread across. */
export const BACKFILL_SECONDS = 3;

/**
 * Add the difference between the official score and the last reading to the
 * final seconds of a match.
 *
 * Mutates `log.samples` and sets `log.settleBackfill`. Returns a description of
 * what happened -- including when nothing did, and why, since "we chose not to"
 * is worth surfacing.
 */
export function backfillSettle(log, tbaBlue, tbaRed) {
  const samples = log?.samples;
  if (!samples?.length) return { applied: false, reason: 'no samples' };
  if (!log.matchKey) return { applied: false, reason: 'match not identified' };
  if (tbaBlue == null || tbaRed == null) {
    return { applied: false, reason: 'no official score yet' };
  }

  const last = samples[samples.length - 1];
  const dBlue = tbaBlue - last.blue;
  const dRed = tbaRed - last.red;

  if (dBlue === 0 && dRed === 0) return { applied: false, reason: 'already matches' };
  if (dBlue < 0 || dRed < 0) {
    // Over-reading is not a settle problem. It means a digit was misread or the
    // wrong match was identified, and adding a negative would quietly "fix" the
    // total while leaving the real fault in place.
    return {
      applied: false,
      reason: 'read higher than the official score (' + dBlue + '/' + dRed + ') — not a settle gap',
      overread: true,
    };
  }
  if (dBlue > MAX_BACKFILL || dRed > MAX_BACKFILL) {
    return {
      applied: false,
      reason:
        'gap too large to be settling (' + dBlue + '/' + dRed + ', limit ' + MAX_BACKFILL + ')',
      tooLarge: true,
    };
  }

  // The seconds to spread across, ending at the match's last second. Created if
  // the read stopped before them, which is the usual case -- that is precisely
  // why the points are missing.
  const endSec = Math.max(last.sec, MATCH_LEN);
  const secs = [];
  for (let i = BACKFILL_SECONDS - 1; i >= 0; i--) secs.push(endSec - i);

  const byId = new Map(samples.map((s) => [s.sec, s]));
  for (const sec of secs) {
    if (byId.has(sec)) continue;
    const row = {
      sec,
      phase: 'teleop',
      blue: last.blue,
      red: last.red,
      db: 0,
      dr: 0,
    };
    samples.push(row);
    byId.set(sec, row);
  }
  samples.sort((a, b) => a.sec - b.sec);

  // Spread as evenly as whole points allow, remainder onto the final second.
  const share = (total, i) => {
    const base = Math.floor(total / BACKFILL_SECONDS);
    return i === BACKFILL_SECONDS - 1 ? total - base * (BACKFILL_SECONDS - 1) : base;
  };

  let addedBlue = 0;
  let addedRed = 0;
  for (let i = 0; i < secs.length; i++) {
    addedBlue += share(dBlue, i);
    addedRed += share(dRed, i);
    const row = byId.get(secs[i]);
    row.blue += addedBlue;
    row.red += addedRed;
  }

  // Everything after the back-filled window carries the full total too, so the
  // series stays monotonic and the last sample is the official score.
  for (const s of samples) {
    if (s.sec > secs[secs.length - 1]) {
      s.blue = Math.max(s.blue, tbaBlue);
      s.red = Math.max(s.red, tbaRed);
    }
  }

  // Deltas rebuilt wholesale, for the same reason process.mjs rebuilds them:
  // an incrementally maintained delta stops agreeing with the scores it
  // describes as soon as anything is inserted.
  let pb = 0;
  let pr = 0;
  for (const s of samples) {
    s.db = Math.max(0, s.blue - pb);
    s.dr = Math.max(0, s.red - pr);
    pb = s.blue;
    pr = s.red;
  }

  log.settleBackfill = {
    blue: dBlue,
    red: dRed,
    seconds: secs,
    source: 'tba',
    at: Date.now(),
  };

  return { applied: true, blue: dBlue, red: dRed, seconds: secs };
}
