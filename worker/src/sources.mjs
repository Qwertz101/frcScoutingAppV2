/**
 * Turning a Twitch/YouTube page URL into pixels, two different ways for two
 * different situations.
 *
 * `worker/src/ffmpeg.mjs` already decodes a piped stdin (`frames('-', {
 * stdin, width, height, ... })`) and seeks any URL ffmpeg can open directly
 * (`frames(url, { start, duration, ... })`) -- that machinery does not care
 * where the bytes come from, and nothing here duplicates it. What this file
 * adds is everything specific to finding those bytes on a real platform:
 *
 * **`liveFrames`** is for a broadcast still in progress: pipe mode
 * (`yt-dlp`/`streamlink -o -`), reconnect with backoff when it drops, report
 * every gap rather than absorb it. No seeking is possible -- there is nothing
 * yet to seek into.
 *
 * **`resolveVodUrl`** is for a finished recording: ask `yt-dlp` for the direct,
 * signed CDN URL behind the page (`yt-dlp -g`) and hand that back as a plain
 * string. A finished YouTube VOD is byte-range servable, so ffmpeg can `-ss`
 * seek into it exactly like a local file -- measured at ~3s to seek three
 * hours into a real 9.8-hour event recording and pull a frame, against a
 * ~0.7s to probe its duration. That is what lets `scan.mjs`'s two-tier
 * VOD scanner run directly against a YouTube URL: nothing downstream of this
 * function needs to know the input was ever a URL at all.
 *
 * **Nothing is written to disk either way.** Live pipes bytes straight through
 * to ffmpeg's stdin; VOD resolution never downloads anything up front, only a
 * signed URL that ffmpeg then makes its own byte-range requests against.
 */

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveBin } from './ffmpeg.mjs';
import { frames } from './ffmpeg.mjs';

const execFileAsync = promisify(execFile);

/** Which downloader understands this URL. */
export function detectPlatform(url) {
  if (/twitch\.tv/i.test(url)) return 'twitch';
  if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube';
  throw new Error('unrecognised source: ' + url + ' (expected a twitch.tv or youtube.com URL)');
}

/** Is this a Twitch/YouTube page URL rather than a local file path? */
export function isRemoteSource(input) {
  return /^https?:\/\//i.test(input) && (/twitch\.tv/i.test(input) || /youtube\.com|youtu\.be/i.test(input));
}

/**
 * Resolve a finished YouTube VOD to a direct, seekable URL.
 *
 * `protocol=https` is the deliberate choice, not `bv*[height<=1080]` alone:
 * that alone can resolve to an HLS (`m3u8`) manifest for a large archive, and
 * while ffmpeg can read HLS, seeking into it is nowhere near as clean or fast
 * as a plain byte-range-servable file. Excluding it up front is what got the
 * ~3-second three-hour seek; letting yt-dlp pick freely did not.
 *
 * The signed URL expires (~6 hours, measured) -- fine for one scan-and-process
 * run over an event's matches, not something to cache across runs.
 *
 * Twitch VODs are not handled here: Twitch does not expose a comparably simple
 * direct-URL resolution the way YouTube's `-g` does, and there was no Twitch
 * VOD to validate against this session. `liveFrames` still covers a Twitch
 * broadcast in progress.
 */
export async function resolveVodUrl(url, opts = {}) {
  const platform = detectPlatform(url);
  if (platform !== 'youtube') {
    throw new Error(platform + ' VOD resolution is not implemented -- only a live pipe is available for it');
  }
  const maxHeight = opts.maxHeight ?? 1080;
  const { stdout } = await execFileAsync(
    resolveBin('yt-dlp'),
    ['-g', '-f', 'bv*[protocol=https][height<=' + maxHeight + ']', '--no-warnings', url],
    { maxBuffer: 1 << 20 }
  );
  const direct = stdout.trim().split('\n')[0];
  if (!direct) throw new Error('yt-dlp returned no direct URL for ' + url);
  return direct;
}

/**
 * Fetch a VOD (or one window of it) to a temp file, and hand back a cleanup.
 *
 * **This is the one place the "no video is ever stored" rule bends, and it
 * bends deliberately and temporarily.** The rule exists so this project never
 * accumulates a footage archive; a file that lives inside a single job's
 * `try/finally` and is deleted before that job returns is not an archive. What
 * it buys is real: seeking a remote VOD costs an HTTP range request every time,
 * which dominates everything else and puts a scan at roughly 1.5x the wall time
 * of the footage. Local seeking is close to free, so the same scan runs many
 * times faster -- the cost moves to one big sequential download, which is the
 * shape networks are good at.
 *
 * `start`/`duration` (seconds) are passed to yt-dlp as a download section, so a
 * bounded window fetches only that window rather than the whole recording. The
 * cut lands on a keyframe rather than exactly on the requested second, so the
 * returned `offset` is the *requested* start and the file may actually begin a
 * few seconds earlier. That imprecision is fine here and is the reason
 * `--force-keyframes-at-cuts` (which would re-encode, and cost more than the
 * seeking this exists to avoid) is not used: `t0` only ever has to be roughly
 * right, because `MatchClock` derives the true match start from the on-screen
 * timer rather than trusting the number it was handed.
 *
 * Returns `{ path, offset, bytes, cleanup }`. **Always call `cleanup`.**
 */
export async function downloadVod(url, opts = {}) {
  const platform = detectPlatform(url);
  if (platform !== 'youtube') {
    throw new Error(platform + ' downloads are not implemented -- only YouTube VODs can be fetched locally');
  }

  const maxHeight = opts.maxHeight ?? 1080;
  const log = opts.log ?? (() => {});
  const dir = await mkdtemp(join(tmpdir(), 'frc-capture-'));
  const cleanup = async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  };

  try {
    const args = ['-f', YT_FORMAT(maxHeight), '--no-warnings', '-o', join(dir, 'vod.%(ext)s')];

    let offset = 0;
    if (opts.start != null || opts.duration != null) {
      const from = Number(opts.start ?? 0);
      // yt-dlp wants an end, not a length. No duration means "to the end",
      // which its section syntax spells as an open range.
      const to = opts.duration != null ? from + Number(opts.duration) : null;
      args.push('--download-sections', '*' + from + '-' + (to ?? 'inf'));
      offset = from;
      // A partial download is done by ffmpeg, and yt-dlp will only look for it
      // on PATH -- which is exactly where winget's per-user install is not.
      // `resolveBin` already knows how to find it (see ffmpeg.mjs), so hand
      // over the answer rather than requiring a PATH edit and a new shell.
      // yt-dlp wants the directory holding the binary, not the binary itself.
      args.push('--ffmpeg-location', dirname(resolveBin('ffmpeg')));
    }
    args.push(url);

    // How long the requested window actually is, for turning ffmpeg's
    // position into a percentage. Open-ended ("to the end") has no known
    // length up front, so percentage is not available for it -- only a
    // heartbeat (see below).
    const sectionLen = opts.duration != null ? Number(opts.duration) : null;

    log(
      'downloading' + (offset ? ' from ' + (offset / 60).toFixed(0) + ' min' : '') +
        (sectionLen ? ' for ' + (sectionLen / 60).toFixed(0) + ' min' : ' to the end of the recording') +
        '…'
    );

    await new Promise((resolve, reject) => {
      const child = spawn(resolveBin('yt-dlp'), args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let lastPct = -1;
      let stderr = '';
      let lastHeartbeat = 0;
      let lastSize = '';

      // A download with no --download-sections (the whole recording, no
      // window given at all) goes through yt-dlp's own downloader, which
      // reports a real percentage here. **A download WITH sections is copied
      // by ffmpeg instead** -- confirmed by capturing real output -- and
      // yt-dlp only ever prints one summary line for that, at the very end.
      // Kept as the one true source of "finished successfully" either way.
      child.stdout.on('data', (b) => {
        const m = /\[download\]\s+(\d+(?:\.\d+)?)%/.exec(b.toString());
        if (!m) return;
        const pct = Math.floor(Number(m[1]) / 10) * 10;
        if (pct > lastPct) {
          lastPct = pct;
          log('  downloaded ' + pct + '%');
          opts.onProgress?.({ phase: 'download', at: Number(m[1]), from: 0, to: 100, total: 100 });
        }
      });

      // ffmpeg's own progress, for the sectioned case. One line, rewritten in
      // place with \r, like: "frame=179 ... size=1792KiB time=-00:00:01.98
      // ... elapsed=0:00:03.10". `time` counts from the *requested* start and
      // is negative until ffmpeg reaches it -- the cut needs a keyframe before
      // that point, so it has to decode some lead-in first. Only once it
      // turns positive does it mean "seconds into the section actually kept".
      child.stderr.on('data', (b) => {
        const text = b.toString();
        stderr += text;
        if (stderr.length > 4096) stderr = stderr.slice(-4096);

        const timeM = /time=(-?\d+):(\d+):(\d+\.\d+)/.exec(text);
        const sizeM = /size=\s*([\d.]+)\s*(KiB|MiB|GiB)/.exec(text);
        if (sizeM) lastSize = sizeM[1] + ' ' + sizeM[2];

        if (timeM && sectionLen) {
          const sign = timeM[1].startsWith('-') ? -1 : 1;
          const secs = sign * (Math.abs(Number(timeM[1])) * 3600 + Number(timeM[2]) * 60 + Number(timeM[3]));
          if (secs >= 0) {
            const pct = Math.min(100, Math.floor((secs / sectionLen) * 100));
            const step = Math.floor(pct / 10) * 10;
            if (step > lastPct) {
              lastPct = step;
              log('  downloaded ' + step + '%');
              opts.onProgress?.({ phase: 'download', at: pct, from: 0, to: 100, total: 100 });
            }
          }
          return;
        }

        // No known section length (an open-ended fetch to the end of the
        // recording) or ffmpeg is still in the negative lead-in: there is no
        // percentage to report, so at least confirm it is alive. Every ~15s
        // rather than on every rewritten line, which would be most of them.
        const now = Date.now();
        if (lastSize && now - lastHeartbeat > 15000) {
          lastHeartbeat = now;
          log('  still downloading… ' + lastSize + ' so far');
        }
      });

      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error('yt-dlp exited ' + code + (stderr.trim() ? ': ' + stderr.trim() : '')));
      });

      opts.signal?.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
    });

    if (opts.signal?.aborted) throw new Error('cancelled during download');

    const found = (await readdir(dir)).find((f) => f.startsWith('vod.'));
    if (!found) throw new Error('yt-dlp produced no file for ' + url);
    const path = join(dir, found);
    const { size } = await stat(path);
    log('downloaded ' + (size / 1e9).toFixed(2) + ' GB');

    return { path, offset, bytes: size, cleanup };
  } catch (e) {
    await cleanup();
    throw e;
  }
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
