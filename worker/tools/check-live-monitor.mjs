/**
 * Does the real `monitorLive` loop -- overlay detection, quad lock, clock
 * lock, ring-buffered window assembly, identification, quality scoring --
 * actually complete end to end?
 *
 * `sources.mjs`'s piping to a real platform is already proven separately
 * (against the real IRI stream) and so is gap rejection (against the real
 * `assembleAndProcess`). What is not yet proven is the orchestration loop in
 * `monitorLive` itself: the overlay bootstrap, the quad-acquisition timing,
 * the clock-feed loop, and the handoff into window assembly, all running
 * together rather than unit by unit.
 *
 * Rather than mock any of that, `monitorLive`'s `opts.frameSource` seam is
 * used to hand it a generator that decodes REAL frames from Qual2.mp4 one at a
 * time -- the same bytes production would see, just not fetched from a
 * network. `--event` is left unset so no TBA schedule is fetched and no write
 * is attempted; this is a live-shaped dry run.
 *
 *   node worker/tools/check-live-monitor.mjs
 */

import { monitorLive } from '../src/live.mjs';
import { frames, probe } from '../src/ffmpeg.mjs';

const CLIP = process.env.CLIP || 'C:/Users/kianz/OneDrive/Desktop/GlendaleVids/Qual2.mp4';

/** Wraps a VOD as a "live" source: decodes forward only, no seeking, `at` in the VOD's own timeline. */
async function* fileAsLiveSource(_url, opts) {
  const meta = await probe(CLIP);
  for await (const f of frames(CLIP, { start: 0, fps: opts.fps ?? 1, width: meta.width, height: meta.height })) {
    yield f;
  }
}

async function main() {
  const matches = [];
  const controller = new AbortController();
  // Qual2 is 172s; give it a comfortable ceiling and rely on completion to end sooner.
  const timer = setTimeout(() => controller.abort(), 240000);

  const result = await monitorLive('file://irrelevant', {
    frameSource: fileAsLiveSource,
    format: { platform: 'file', width: 0, height: 0, title: 'Qual2.mp4 (as live)' },
    write: false,
    signal: controller.signal,
    log: (m) => console.log('  ' + m),
    onMatch: ({ log, quality }) => {
      matches.push({ matchKey: log.matchKey, samples: log.samples.length, quality: quality.score });
      // One match is all this clip has; stop as soon as it lands rather than
      // waiting for the abort timer.
      controller.abort();
    },
  });
  clearTimeout(timer);

  console.log('\nmatchesProcessed (loop-local counter): ' + result.matchesProcessed);
  console.log('matches observed via onMatch: ' + JSON.stringify(matches));

  const last = matches[0];
  const ok = matches.length >= 1 && last.samples > 100;
  console.log(
    '\n' + (ok
      ? 'PASS: monitorLive detected the overlay, locked the clock, assembled a window, and produced a scored log with ' + last.samples + ' samples.'
      : 'FAIL: expected at least one processed match with >100 samples, got ' + JSON.stringify(matches))
  );
  process.exitCode = ok ? 0 : 1;
}

await main();
