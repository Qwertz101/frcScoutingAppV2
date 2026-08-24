/**
 * A pool of tesseract workers.
 *
 * The arithmetic that forces this to exist: a match is ~163 samples, each
 * costing ~5 `recognize` calls (two score plates x a 2-of-3 vote, plus the
 * timer), at roughly 1s per call. That is ~13.6 minutes single-threaded against
 * a ~7 minute match cadence -- i.e. the worker would fall further behind with
 * every match played and never catch up.
 *
 * What makes the fix safe is that per-frame OCR is genuinely independent: every
 * frame is rectified and recognised from its own pixels alone. Only `ScoreGate`
 * and `MatchClock` carry state across frames, and both are pure, sequential and
 * microsecond-cheap. So OCR fans out and the stateful part stays strictly
 * ordered -- see `process.mjs`, which is where that ordering is enforced.
 */

import { availableParallelism } from 'node:os';
import { bootOcr, nodeOcrConfig } from './core.mjs';
import { ensureTessdata } from './tessdata.mjs';

/**
 * Default pool size.
 *
 * Leaves headroom rather than taking every core: ffmpeg is decoding on the same
 * machine, and on match day so is AnyDesk's screen encoder.
 */
export function defaultWorkers() {
  const env = Number(process.env.OCR_WORKERS);
  if (Number.isFinite(env) && env > 0) return Math.floor(env);
  return Math.max(1, Math.min(8, availableParallelism() - 2));
}

/**
 * Boot `size` workers and hand out leases.
 *
 * Deliberately a lease queue rather than a task queue: callers do not submit
 * jobs, they borrow a worker and run whatever sequence of `recognize` calls
 * they need against it. That keeps the *whole* of one frame's recognition --
 * plates, vote, timer -- on a single worker, so the existing voting logic in
 * the core is reused verbatim instead of being reimplemented as a scheduler.
 */
export async function createPool(size = defaultWorkers(), onProgress) {
  ensureTessdata();
  const handles = await Promise.all(
    Array.from({ length: size }, (_, i) =>
      bootOcr(nodeOcrConfig(i === 0 ? onProgress : undefined))
    )
  );

  const idle = handles.slice();
  const waiting = [];
  let closed = false;

  const acquire = () =>
    new Promise((resolve) => {
      if (closed) throw new Error('pool is closed');
      const h = idle.pop();
      if (h) resolve(h);
      else waiting.push(resolve);
    });

  const release = (h) => {
    const next = waiting.shift();
    if (next) next(h);
    else idle.push(h);
  };

  return {
    size,

    /** Borrow a worker for the duration of `fn`. */
    async run(fn) {
      const h = await acquire();
      try {
        return await fn(h.worker);
      } finally {
        release(h);
      }
    },

    /**
     * Map `fn` over an async iterable with at most `size` in flight, yielding
     * results in **input order**.
     *
     * Order is the whole point. The results feed `ScoreGate`, which is a
     * monotonicity gate -- handing it frames out of order would make it reject
     * every legitimate score as a backwards jump, and the failure would look
     * exactly like bad OCR rather than like a scheduling bug.
     */
    async *ordered(source, fn) {
      const inflight = [];
      try {
        for await (const item of source) {
          inflight.push(this.run((w) => fn(w, item)));
          if (inflight.length >= size) yield await inflight.shift();
        }
        while (inflight.length) yield await inflight.shift();
      } finally {
        // The consumer is allowed to stop early -- `process.mjs` breaks as soon
        // as the score settles -- and when it does there are still up to `size`
        // recognitions in flight. Without draining them here they outlive the
        // loop and the pool gets terminated out from under them: those calls
        // then land on a null worker and take the process down *after* a
        // perfectly good log has already been written. Settling is the normal
        // way a match ends on real footage, so this is the common path.
        await Promise.allSettled(inflight);
      }
    },

    async terminate() {
      closed = true;
      await Promise.all(handles.map((h) => h.terminate()));
    },
  };
}
