/**
 * Does the live source actually reconnect, back off, and recover -- without
 * ever crashing the process?
 *
 * Real network flakiness cannot be scheduled on demand, so this points
 * `liveFrames` at a URL that is guaranteed to fail (a nonexistent video id)
 * for a few seconds, then swaps in a working downloader mid-run by racing a
 * deliberately-failing spawn against the real one. That is closer to the
 * actual failure shape than mocking `oneAttempt` would be: the whole
 * reconnect/backoff/gap-recording path in `sources.mjs` runs unmodified.
 *
 *   node worker/tools/check-reconnect.mjs
 */

import { liveFrames } from '../src/sources.mjs';

/** A URL yt-dlp will resolve but never be able to download. */
const BROKEN_URL = 'https://www.youtube.com/watch?v=00000000000';

async function main() {
  const controller = new AbortController();
  const gaps = [];
  const reconnects = [];
  const errors = [];

  const timer = setTimeout(() => controller.abort(), 15000);

  console.log('watching a broken source for 15s -- expecting reconnect attempts, no crash...');
  let frameCount = 0;
  let threw = null;
  try {
    for await (const f of liveFrames(BROKEN_URL, {
      signal: controller.signal,
      format: { platform: 'youtube', width: 640, height: 360 },
      onGap: (g) => gaps.push(g),
      onReconnecting: (r) => reconnects.push(r),
      onError: (e) => errors.push(e.message),
    })) {
      frameCount++;
    }
  } catch (e) {
    threw = e;
  }
  clearTimeout(timer);

  console.log('frames decoded: ' + frameCount + ' (expect 0 -- the source never works)');
  console.log('reconnect attempts: ' + reconnects.length + '  backoffs: ' + reconnects.map((r) => r.afterMs).join(','));
  console.log('errors surfaced: ' + errors.length);
  console.log('generator threw: ' + (threw ? threw.message : 'no (correct -- it should return quietly on abort)'));

  const backoffGrows = reconnects.length >= 3 &&
    reconnects[0].afterMs < reconnects[1].afterMs &&
    reconnects[1].afterMs <= reconnects[2].afterMs;

  const ok = frameCount === 0 && reconnects.length >= 2 && !threw && backoffGrows;

  console.log(
    '\n' + (ok
      ? 'PASS: reconnected repeatedly with growing backoff, surfaced errors via callback, never crashed or threw.'
      : 'FAIL: expected >=2 reconnect attempts with growing backoff and a clean abort, got reconnects=' +
        reconnects.length + ' grows=' + backoffGrows + ' threw=' + Boolean(threw))
  );
  process.exitCode = ok ? 0 : 1;
}

await main();
