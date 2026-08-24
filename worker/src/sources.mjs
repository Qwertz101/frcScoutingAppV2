/**
 * Live stream -> RGBA frames, with reconnects.
 *
 * `worker/src/ffmpeg.mjs` already decodes a piped stdin (`frames('-', {
 * stdin, width, height, ... })`) -- that machinery does not care whether the
 * bytes come from a local file or a live process, and nothing here duplicates
 * it. What this file adds is everything specific to *live*: finding the actual
 * media URL behind a Twitch or YouTube page, and staying attached to a source
 * that can drop out for reasons that have nothing to do with this program --
 * a venue wifi hiccup, a streamer's encoder restarting, an ad break that
 * briefly serves a different manifest.
 *
 * **Nothing is written to disk.** `yt-dlp`/`streamlink` are run in pipe mode
 * (`-o -`), so the compressed stream passes straight through this process's
 * memory into ffmpeg's stdin and is discarded as soon as it is decoded.
 */

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveBin } from './ffmpeg.mjs';
import { frames } from './ffmpeg.mjs';

const execFileAsync = promisify(execFile);

/** Which downloader understands this URL. */
export function detectPlatform(url) {
  if (/twitch\.tv/i.test(url)) return 'twitch';
  if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube';
  throw new Error('unrecognised source: ' + url + ' (expected a twitch.tv or youtube.com URL)');
}

/**
 * The frame size the live source will decode at, and which format to request.
 *
 * Asked of `yt-dlp`/`streamlink` up front rather than left to ffprobe, because
 * ffprobe needs a seekable input and a live pipe is not one -- by the time
 * enough of it has arrived to sniff, that data is already gone downstream.
 *
 * Video-only, capped at 1080p by default.
 *
 * Measured against a real event VOD (18GB+ of DASH/HLS-served 1080p): a plain
 * `-f best` fails outright with "Requested format is not available", because
 * a stream this large is only offered as separate video and audio tracks, not
 * a combined one. Requesting video-only sidesteps that and is also just the
 * right choice on its own merits -- OCR never looks at audio, and skipping the
 * mux means ffmpeg gets a single elementary stream instead of two that would
 * need combining.
 */
const YT_FORMAT = (maxHeight) => 'bv*[height<=' + maxHeight + ']';

export async function probeLiveFormat(url, opts = {}) {
  const platform = detectPlatform(url);
  const maxHeight = opts.maxHeight ?? 1080;
  if (platform === 'youtube') {
    const { stdout } = await execFileAsync(
      resolveBin('yt-dlp'),
      ['-J', '--no-warnings', '-f', YT_FORMAT(maxHeight), url],
      { maxBuffer: 1 << 24 }
    );
    const j = JSON.parse(stdout);
    if (!j.width || !j.height) throw new Error('yt-dlp reported no dimensions for ' + url);
    return { platform, width: j.width, height: j.height, title: j.title ?? '' };
  }

  // streamlink --json describes the stream table but not pixel dimensions
  // directly on every plugin; the 'best' entry's resolution field usually has
  // them as e.g. "1920x1080". Falling back to a 1280-wide guess if it does not
  // is safe -- ffmpeg's own -vf scale filter is what actually fixes the output
  // size, this is only for sizing the frame buffer up front.
  const { stdout } = await execFileAsync(
    resolveBin('streamlink'),
    ['--json', url, 'best'],
    { maxBuffer: 1 << 24 }
  );
  const j = JSON.parse(stdout);
  const res = j?.metadata?.title ? null : null; // streamlink rarely exposes this cleanly
  const m = /(\d+)x(\d+)/.exec(JSON.stringify(j));
  return {
    platform,
    width: m ? Number(m[1]) : 1280,
    height: m ? Number(m[2]) : 720,
    title: j?.metadata?.title ?? '',
  };
}

/** Spawn the platform downloader in pipe mode. Its stdout is the raw stream. */
function spawnDownloader(url, platform, opts = {}) {
  const maxHeight = opts.maxHeight ?? 1080;
  if (platform === 'youtube') {
    return spawn(
      resolveBin('yt-dlp'),
      ['-f', YT_FORMAT(maxHeight), '-o', '-', '--no-warnings', url],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
  }
  // -O: write the stream to stdout instead of a file.
  return spawn(resolveBin('streamlink'), [url, 'best', '-O', '--loglevel', 'error'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** 1s, 2s, 4s, 8s, 16s, then capped -- long enough not to hammer a dead source. */
const BACKOFF_STEPS = [1000, 2000, 4000, 8000, 16000, 30000];

/**
 * Decode one attempt at the live stream into frames.
 *
 * Just the piped-stdin path `ffmpeg.mjs` already supports, with an `at` that
 * starts from zero for THIS attempt -- `liveFrames` below is what turns that
 * into a single continuous wall-clock timeline across reconnects.
 */
async function* oneAttempt(url, platform, format, opts) {
  const child = spawnDownloader(url, platform, opts);
  let stderr = '';
  child.stderr.on('data', (b) => {
    stderr += b.toString();
    if (stderr.length > 4096) stderr = stderr.slice(-4096);
  });
  // Surfaced through the frame source's failure, not thrown here: a
  // downloader exiting is the normal shape of a stream ending or dropping,
  // not a bug, and the caller (liveFrames) is what decides whether that is a
  // gap to reconnect through.
  child.on('error', () => {});

  try {
    yield* frames('-', {
      stdin: child.stdout,
      width: format.width,
      height: format.height,
      fps: opts.fps ?? 1,
      scaleWidth: opts.scaleWidth,
    });
  } finally {
    if (!child.killed) child.kill('SIGKILL');
  }
  if (stderr.trim()) opts.onStderr?.(stderr.trim());
}

/**
 * The live frame source: reconnects forever, and tells the caller about every
 * gap rather than papering over it.
 *
 * `at` is seconds since this generator started, continuous across reconnects.
 * A frame immediately after a gap does NOT resume where the dropped stream's
 * internal clock left off -- it picks up at real wall-clock time, because
 * that is the only clock a viewer watching live actually has. Any match
 * window whose frames span a gap must be rejected outright by the caller: see
 * `live.mjs`, and the plan this implements, on why stitching across one would
 * produce a plausible-looking but wrong timeline.
 *
 * Ends only when `opts.signal` aborts. A live monitor is meant to run for the
 * length of an event, so "the source is unreachable" is handled by retrying
 * forever with backoff, not by giving up.
 */
export async function* liveFrames(url, opts = {}) {
  const platform = detectPlatform(url);
  const format = opts.format ?? (await probeLiveFormat(url, opts));
  opts.onFormat?.(format);

  const started = Date.now();
  const at = () => (Date.now() - started) / 1000;

  let backoff = 0;
  let lastGoodAt = null;

  for (;;) {
    if (opts.signal?.aborted) return;

    const attemptStartedAt = at();
    let gotAny = false;

    try {
      for await (const f of oneAttempt(url, platform, format, opts)) {
        if (opts.signal?.aborted) return;
        gotAny = true;
        backoff = 0;
        lastGoodAt = at();
        // Re-timestamped to wall clock AT ARRIVAL, not to `attemptStartedAt +
        // f.at`. That looked like the same thing and is not: `f.at` is
        // video-content-relative-to-this-attempt, which only tracks wall time
        // 1:1 when the source is paced to real time. A genuinely live,
        // low-latency broadcast is; but this was measured against an archived
        // VOD served through a "live" URL, which yt-dlp downloads as fast as
        // bandwidth allows -- five-plus times faster than playback. Adding a
        // content-relative offset to a wall-clock base produced a timeline
        // that was neither, and drifted differently on every reconnect: gap
        // bookkeeping (which already used pure `at()`) and the frame timeline
        // handed to callers disagreed about what "now" meant, so a live
        // monitor's ring buffer and gap-overlap checks could not trust
        // `frame.at` to mean the same thing twice. `lastGoodAt` above is
        // already the correct value for this; the frame timeline should match
        // it exactly, so it does.
        yield { ...f, at: lastGoodAt };
      }
    } catch (e) {
      opts.onError?.(e);
    }

    if (opts.signal?.aborted) return;

    const gapStart = lastGoodAt ?? attemptStartedAt;
    const gapSeconds = at() - gapStart;
    if (gotAny || gapSeconds > 0.5) {
      opts.onGap?.({ start: gapStart, seconds: gapSeconds });
    }

    const wait = BACKOFF_STEPS[Math.min(backoff, BACKOFF_STEPS.length - 1)];
    backoff++;
    opts.onReconnecting?.({ afterMs: wait, attempt: backoff });
    await new Promise((r) => setTimeout(r, wait));
  }
}

const invokedDirectly =
  process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('worker/src/sources.mjs');

if (invokedDirectly) {
  const url = process.argv[2];
  if (!url) {
    console.error('usage: node worker/src/sources.mjs <url> [seconds]');
    process.exit(1);
  }
  const seconds = Number(process.argv[3] ?? 15);

  console.error('probing format...');
  const format = await probeLiveFormat(url);
  console.error('  ' + format.platform + '  ' + format.width + 'x' + format.height + '  "' + format.title + '"');

  console.error('decoding ' + seconds + 's...');
  const controller = new AbortController();
  setTimeout(() => controller.abort(), seconds * 1000);

  let n = 0;
  const began = Date.now();
  try {
    for await (const f of liveFrames(url, {
      format,
      signal: controller.signal,
      onGap: (g) => console.error('  gap: ' + g.seconds.toFixed(1) + 's'),
      onReconnecting: (r) => console.error('  reconnecting in ' + r.afterMs + 'ms (attempt ' + r.attempt + ')'),
      onError: (e) => console.error('  error: ' + e.message),
    })) {
      n++;
      if (n % 5 === 0) console.error('  frame ' + n + '  at=' + f.at.toFixed(1) + 's');
    }
  } catch (e) {
    console.error('stopped: ' + e.message);
  }
  console.error(
    '\n' + n + ' frame(s) in ' + ((Date.now() - began) / 1000).toFixed(1) + 's wall'
  );
}
