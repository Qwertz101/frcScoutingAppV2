/**
 * Match time, derived from the scoreboard's own clock.
 *
 * The tracker used to stamp each score sample with a counter it bumped once per
 * processed frame, which is not match time and cannot be made into match time.
 * Measured on a real 214s broadcast, that produced three separate defects:
 *
 *   - an ~11s constant offset, because the operator pressed Start during the
 *     intro banner rather than at the green flag;
 *   - ~2s of *accumulating* drift across the match, because OCR compute time
 *     leaked into the timeline — a score got stamped with the time processing
 *     finished, not the time the frame depicted;
 *   - truncation, because the counter hit its own 160 while the real match still
 *     had 11 seconds (and every climb) left to score.
 *
 * Reading `M:SS` out of the frame fixes all three by construction. The
 * timestamp and the score now come from the same pixels, so no amount of
 * processing latency can desynchronise them; and no operator has to press
 * anything at the right moment, which is the part that is genuinely hard live.
 *
 * What is *not* free is the AUTO/TELEOP ambiguity: `0:20` is both the start of
 * AUTO and the 20-seconds-left mark of TELEOP. That cannot be resolved from one
 * frame, so it is resolved from the sequence — see `MatchClock`.
 *
 * `elapsedFrom` computes TELEOP elapsed as `MATCH_LEN - remaining`, and that
 * is already correct for the real `AUTO_TELEOP_DELAY` between AUTO and
 * TELEOP (manual §6.4 — see `types/index.ts`), with no special-casing needed
 * here: `MATCH_LEN` is the TRUE total match length, delay included, so the
 * formula is just "how long ago did the plate read what it reads now,
 * counting from true zero" — the plate itself shows 2:20 the instant TELEOP
 * truly starts, 3 real seconds after AUTO ended, and that arrives at the
 * right elapsed value on its own. Nothing here needs to know the delay
 * happened; it falls out of `MATCH_LEN` alone.
 */

import { AUTO_LEN, MATCH_LEN, TELEOP_LEN } from '../../types';

export type MatchPhase = 'auto' | 'teleop';

/** Longest legal reading on the plate: 2:20 at the start of TELEOP. */
export const MAX_REMAINING = TELEOP_LEN;

/**
 * Parse the digit string OCR read off the timer plate into seconds remaining.
 *
 * The recogniser is digit-only and the colon is inferred by position rather
 * than read. Two reasons: the tesseract worker's character whitelist is a
 * global parameter shared with the score plates, so adding `:` would put a
 * punctuation class back into *their* confusion set for no gain; and the colon
 * survives segmentation as two dots far below the digit-height floor, so
 * `digitComponents` already discards it for free. `M:SS` is fixed-width, so
 * position is all the information the colon was carrying.
 *
 * Returns null for anything implausible, which the caller treats as an
 * unreadable frame rather than a guess.
 */
export function parseTimerText(text: string): number | null {
  if (!/^\d+$/.test(text)) return null;
  let mins: number;
  let secs: number;
  if (text.length === 3) {
    mins = Number(text[0]);
    secs = Number(text.slice(1));
  } else if (text.length === 2) {
    // The overlay always renders the leading `0`, so a two-digit read means
    // segmentation dropped it. Assuming `0:SS` recovers the last minute of a
    // period; if the assumption is wrong the sequence guard below rejects it.
    mins = 0;
    secs = Number(text);
  } else {
    return null;
  }
  if (secs > 59) return null;
  const remaining = mins * 60 + secs;
  if (remaining > MAX_REMAINING) return null;
  return remaining;
}

/** How far a read may sit from where the countdown says it should, in seconds. */
const TOLERANCE = 2;
/** Agreeing reads needed to override the sequence guard and re-sync. */
const RESYNC_AFTER = 2;
/** Agreeing reads needed to declare the match started, or the phase changed. */
const CORROBORATION = 2;
/**
 * A reading this high can only be TELEOP: AUTO's plate never exceeds 0:20, so
 * anything near 2:20 is the post-AUTO reset, not a misread of an AUTO frame.
 */
const TELEOP_RESET_MIN = 100;

export interface ClockState {
  /** True once a real, ticking match clock has been seen. */
  started: boolean;
  phase: MatchPhase;
  /** Seconds since the green flag, 0..MATCH_LEN. */
  matchElapsed: number;
  /** True once TELEOP's clock has reached 0:00. */
  ended: boolean;
}

/**
 * Turns a stream of timer readings into match elapsed seconds.
 *
 * Everything here is about not letting one bad frame do lasting damage. A
 * single misread must not move the clock, must not flip the phase, and must not
 * end the match — so every state change requires corroboration from a second,
 * independently-consistent reading, while an ordinary tick is accepted
 * immediately because it agrees with the countdown already in progress.
 */
export class MatchClock {
  private started = false;
  private phase: MatchPhase = 'auto';
  private ended = false;

  /** Last accepted reading, and the video time it was read at. */
  private lastRemaining = -1;
  private lastAt = -1;

  /** A reading the guard refused, held in case the next one agrees with it. */
  private candRemaining = -1;
  private candAt = -1;
  private candHits = 0;

  /** Consecutive reads that look like the post-AUTO reset to 2:20. */
  private teleopHits = 0;

  /** Readings offered vs readings accepted — surfaced as the timer read rate. */
  offered = 0;
  accepted = 0;

  /**
   * Video time of the green flag, once the clock has locked on.
   *
   * This is what lets a scanner say *where* a match began rather than merely
   * that one is in progress. It is derived from the reading that started the
   * clock — `at` minus however far into the match that reading says we are —
   * so it is back-dated to the real start even though corroboration means we
   * only find out about it a couple of frames late. That lag costs latency,
   * not accuracy.
   */
  greenFlagAt: number | null = null;

  /**
   * The reading currently being corroborated, if any.
   *
   * Exposed for the scanner's coarse pass, which wants to know that something
   * clock-shaped is happening before it pays for a fine pass, and would
   * otherwise have to infer it from `state.started` staying false.
   */
  get pending(): { remaining: number; at: number; hits: number } | null {
    if (this.candHits <= 0 || this.candRemaining < 0) return null;
    return { remaining: this.candRemaining, at: this.candAt, hits: this.candHits };
  }

  get state(): ClockState {
    return {
      started: this.started,
      phase: this.phase,
      matchElapsed: this.elapsedFrom(this.lastRemaining),
      ended: this.ended,
    };
  }

  private elapsedFrom(remaining: number): number {
    if (remaining < 0) return 0;
    const e = this.phase === 'auto' ? AUTO_LEN - remaining : MATCH_LEN - remaining;
    // AUTO cannot report past its own end even if the clock sat at 0:00 for a
    // while: the field is paused, not scoring.
    const cap = this.phase === 'auto' ? AUTO_LEN : MATCH_LEN;
    return Math.min(cap, Math.max(0, e));
  }

  /**
   * Match elapsed for a frame at video time `at`, whether or not its own clock
   * reading was believed.
   *
   * A frame whose plate was obscured or misread still has a score worth
   * logging, so the time is extrapolated from the last *accepted* reading using
   * video time. This cannot accumulate error the way a frame counter does,
   * because every accepted reading re-anchors it — the extrapolation only ever
   * spans the gap since the last good look at the clock.
   */
  elapsedAt(at: number): number {
    if (!this.started) return 0;
    if (this.ended) return MATCH_LEN;
    return this.elapsedFrom(this.lastRemaining - (at - this.lastAt));
  }

  /**
   * Offer one frame's reading.
   *
   * `remaining` is the parsed plate value (null when it could not be read) and
   * `at` is the *video* time of the frame, used only as a sanity ruler for how
   * far the countdown should have moved. Returns the accepted state, or null
   * when this frame did not produce a usable time.
   */
  feed(remaining: number | null, at: number): ClockState | null {
    this.offered++;
    if (remaining === null) return null;

    // --- not started yet: wait for a clock that is demonstrably ticking ------
    // The intro banner, a frozen pre-match plate and a stray misread all read as
    // *a* number; only a real match clock counts down in step with wall time.
    if (!this.started) {
      if (this.candHits > 0 && this.isTicking(remaining, at, this.candRemaining, this.candAt)) {
        this.candHits++;
        if (this.candHits >= CORROBORATION) {
          this.started = true;
          // AUTO's plate tops out at 0:20, so anything above that is TELEOP.
          // A recording begun in the final 20s of TELEOP would be misread as
          // AUTO here; nothing in a single frame can distinguish them, and an
          // operator who starts that late has already lost the match anyway.
          this.phase = remaining > AUTO_LEN ? 'teleop' : 'auto';
          // After `phase`, never before: `elapsedFrom` measures against AUTO's
          // 20s or the full 163s depending on it, so computing this a line
          // earlier would silently back-date the flag by the whole of AUTO.
          this.greenFlagAt = at - this.elapsedFrom(remaining);
          this.commit(remaining, at);
          return this.state;
        }
      } else {
        this.candHits = 1;
      }
      this.candRemaining = remaining;
      this.candAt = at;
      return null;
    }

    // --- AUTO -> TELEOP: the one place the clock legitimately jumps UP -------
    if (this.phase === 'auto' && remaining >= TELEOP_RESET_MIN) {
      this.teleopHits++;
      if (this.teleopHits >= CORROBORATION) {
        this.phase = 'teleop';
        this.teleopHits = 0;
        this.commit(remaining, at);
        return this.state;
      }
      return null;
    }
    this.teleopHits = 0;

    // --- ordinary tick ------------------------------------------------------
    // Either the clock is where the countdown says it should be, or it is
    // holding (0:00 between periods, or a paused field) — both are normal.
    const expected = this.lastRemaining - (at - this.lastAt);
    if (remaining === this.lastRemaining || Math.abs(remaining - expected) <= TOLERANCE) {
      // Within a period the clock never runs backwards.
      if (remaining <= this.lastRemaining) {
        this.commit(remaining, at);
        return this.state;
      }
    }

    // --- disagreement: believe it only if it corroborates itself ------------
    // A one-off misread never survives, because the next frame disagrees with
    // it and resets the count. A genuinely stale anchor loses to two readings
    // that are consistent with each other.
    if (this.candHits > 0 && this.isTicking(remaining, at, this.candRemaining, this.candAt)) {
      this.candHits++;
      if (this.candHits >= RESYNC_AFTER) {
        this.commit(remaining, at);
        return this.state;
      }
    } else {
      this.candHits = 1;
    }
    this.candRemaining = remaining;
    this.candAt = at;
    return null;
  }

  /** Is `remaining` at `at` a plausible continuation of `prev` at `prevAt`? */
  private isTicking(remaining: number, at: number, prev: number, prevAt: number): boolean {
    if (prev < 0 || prevAt < 0) return false;
    const dt = at - prevAt;
    if (dt <= 0 || dt > 10) return false;
    const drop = prev - remaining;
    // Counting down, roughly one second of clock per second of video, and
    // actually moving — a frozen graphic is not a running match.
    return drop > 0 && Math.abs(drop - dt) <= TOLERANCE;
  }

  private commit(remaining: number, at: number): void {
    this.lastRemaining = remaining;
    this.lastAt = at;
    this.candHits = 0;
    this.candRemaining = -1;
    this.candAt = -1;
    this.accepted++;
    if (this.phase === 'teleop' && remaining <= 0) this.ended = true;
  }
}
