/**
 * Video -> RGBA frames, as an async iterator.
 *
 * The browser tracker seeks the <video> element once per sample because a media
 * element offers no other way to get at an arbitrary frame. Node has no such
 * constraint, and repeating that pattern here would be the worst decision
 * available: one long-lived sequential decode is far faster than N seeks, and
 * it gives *better* timestamps, because frame n is deterministically at
 * `start + n / fps` rather than wherever the decoder happened to land.
 *
 * Nothing is written to disk. Frames exist only while the consumer holds them.
 */

import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

/* ------------------------------------------------------------------ *
 * Locating the binaries
 * ------------------------------------------------------------------ */

/**
 * winget installs ffmpeg into a versioned per-user folder and then edits the
 * user PATH, which an already-running process never sees. Checking the install
 * location directly means the worker runs immediately after `winget install`
 * rather than only after a reboot -- exactly the sort of thing that otherwise
 * wastes an hour at 8am on match day.
 */
function wingetCandidates(exe) {
  const packages = join(homedir(), 'AppData/Local/Microsoft/WinGet/Packages');
  const roots = [
    'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe',
    'yt-dlp.yt-dlp_Microsoft.Winget.Source_8wekyb3d8bbwe',
  ];
  const out = [];
  for (const r of roots) {
    out.push(join(packages, r, exe + '.exe'));
    for (const sub of ['ffmpeg-9.0-full_build', 'ffmpeg-7.1-full_build']) {
      out.push(join(packages, r, sub, 'bin', exe + '.exe'));
    }
  }
  // Streamlink's winget package does not use the WinGet Packages layout at
  // all -- it installs under AppData/Local/Programs like a conventional
  // Windows installer, so it needs its own candidate path.
  out.push(join(homedir(), 'AppData/Local/Programs/Streamlink/bin', exe + '.exe'));
  return out;
}

const resolved = new Map();

/** Absolute path to `exe`, honouring an explicit env override first. */
export function resolveBin(exe) {
  if (resolved.has(exe)) return resolved.get(exe);
  const envKey = exe.replace(/-/g, '_').toUpperCase() + '_PATH';
  const candidates = [process.env[envKey], ...wingetCandidates(exe)].filter(Boolean);
  const hit = candidates.find((p) => existsSync(p)) ?? exe; // else trust PATH
  resolved.set(exe, hit);
  return hit;
}

/* ------------------------------------------------------------------ *
 * Probing
 * ------------------------------------------------------------------ */

/** Frame size and duration, straight from the container. */
export async function probe(input) {
  const { stdout } = await execFileAsync(
    resolveBin('ffprobe'),
    [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,avg_frame_rate:format=duration',
      '-of', 'json',
      input,
    ],
    { maxBuffer: 1 << 20 }
  );
  const j = JSON.parse(stdout);
  const s = j.streams && j.streams[0];
  if (!s || !s.width || !s.height) throw new Error('no video stream in ' + input);
  return {
    width: s.width,
    height: s.height,
    duration: Number(j.format && j.format.duration) || 0,
    frameRate: s.avg_frame_rate,
  };
}

/* ------------------------------------------------------------------ *
 * Frame iteration
 * ------------------------------------------------------------------ */

/**
 * Yield one object per output frame, shaped so it satisfies `RgbaFrame`
 * structurally and goes straight into `readFrame` with no adapter -- the same
 * shape the browser's `ImageData` satisfies.
 *
 * Backpressure matters more than it looks: 1080p RGBA is 8.3 MB per frame and
 * OCR is ~1s per frame against a decode that runs far faster than realtime.
 * stdout is paused while the consumer works, so ffmpeg blocks on the pipe
 * instead of Node buffering gigabytes of frames nobody has looked at yet.
 */
export async function* frames(input, opts = {}) {
  const { start = 0, duration, fps = 1, scaleWidth, stdin } = opts;

  let width = opts.width;
  let height = opts.height;
  if (!width || !height) {
    const p = await probe(input);
    width = p.width;
    height = p.height;
  }
  if (scaleWidth && scaleWidth < width) {
    height = Math.round((height * scaleWidth) / width / 2) * 2;
    width = scaleWidth;
  }

  const filters = ['fps=' + fps];
  if (scaleWidth) filters.push('scale=' + width + ':' + height);

  const args = ['-hide_banner', '-loglevel', 'error'];
  // `-ss` BEFORE `-i` is input seeking: ffmpeg jumps in the container rather
  // than decoding and discarding everything up to `start`. On a 6-hour VOD that
  // is the difference between instant and minutes.
  if (start > 0) args.push('-ss', String(start));
  args.push('-i', input);
  if (duration != null) args.push('-t', String(duration));
  args.push('-vf', filters.join(','), '-f', 'rawvideo', '-pix_fmt', 'rgba', '-');

  const child = spawn(resolveBin('ffmpeg'), args, {
    stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  if (stdin) {
    // The upstream source (yt-dlp, streamlink) is a separate process from
    // ffmpeg, and a live consumer aborts by killing both -- there is no way to
    // guarantee ffmpeg's stdin is still open by the time the last chunk from
    // upstream arrives. Without these handlers that ordinary race is an
    // unhandled 'error' event on a raw Socket, which kills the whole worker
    // process rather than just ending this one attempt.
    stdin.on('error', () => {});
    child.stdin.on('error', () => {});
    stdin.pipe(child.stdin);
  }

  let stderr = '';
  child.stderr.on('data', (b) => {
    stderr += b.toString();
    if (stderr.length > 8192) stderr = stderr.slice(-8192);
  });

  const frameBytes = width * height * 4;
  const chunks = [];
  let pending = 0;
  let index = 0;
  let done = false;
  let failure = null;
  let wake = null;

  const notify = () => {
    const w = wake;
    wake = null;
    if (w) w();
  };

  child.stdout.on('data', (c) => {
    chunks.push(c);
    pending += c.length;
    if (pending >= frameBytes) child.stdout.pause();
    notify();
  });
  child.stdout.on('end', () => { done = true; notify(); });
  child.on('error', (e) => { failure = e; done = true; notify(); });
  child.on('close', (code) => {
    if (code && !failure) failure = new Error('ffmpeg exited ' + code + ': ' + stderr.trim());
    done = true;
    notify();
  });

  /** Pull exactly one frame's worth of bytes out of the chunk queue. */
  const take = () => {
    const buf = Buffer.allocUnsafe(frameBytes);
    let off = 0;
    while (off < frameBytes) {
      const c = chunks[0];
      const need = frameBytes - off;
      if (c.length <= need) {
        c.copy(buf, off);
        off += c.length;
        chunks.shift();
      } else {
        c.copy(buf, off, 0, need);
        chunks[0] = c.subarray(need);
        off += need;
      }
    }
    pending -= frameBytes;
    return buf;
  };

  try {
    for (;;) {
      while (pending < frameBytes && !done) {
        child.stdout.resume();
        await new Promise((r) => { wake = r; });
      }
      if (failure) throw failure;
      // A trailing partial frame is discarded rather than padded: half a frame
      // of pixels would read as a plausible-looking wrong number.
      if (pending < frameBytes) break;

      const buf = take();
      yield {
        data: new Uint8ClampedArray(buf.buffer, buf.byteOffset, frameBytes),
        width,
        height,
        at: start + index / fps,
        index: index++,
      };
    }
  } finally {
    if (!child.killed) child.kill('SIGKILL');
  }
}

/**
 * Single frames as encoded JPEGs, for showing a human.
 *
 * Distinct from `frames()` above, which yields raw RGBA for the detector to
 * measure. This exists because calibration happens in a browser, and a browser
 * cannot read a YouTube page pixel-by-pixel -- so the frames a person calibrates
 * against have to come from here, where ffmpeg already has the video open.
 *
 * One ffmpeg invocation per timestamp rather than a filter graph: the seeks are
 * far apart, each is `-ss` before `-i` so it is a fast keyframe seek, and a
 * failed grab then costs one frame instead of the whole set.
 */
export async function grabJpegs(input, times, opts = {}) {
  const width = opts.width ?? 1280;
  const quality = opts.quality ?? 4;
  const out = [];

  for (const at of times) {
    const buf = await new Promise((resolve) => {
      const child = spawn(
        resolveBin('ffmpeg'),
        [
          '-hide_banner', '-loglevel', 'error',
          '-ss', String(Math.max(0, at)),
          '-i', input,
          '-frames:v', '1',
          '-vf', 'scale=' + width + ':-2',
          '-q:v', String(quality),
          '-f', 'image2', '-c:v', 'mjpeg',
          'pipe:1',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
      const chunks = [];
      child.stdout.on('data', (c) => chunks.push(c));
      child.on('error', () => resolve(null));
      child.on('close', () => {
        const b = Buffer.concat(chunks);
        resolve(b.length ? b : null);
      });
      opts.signal?.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
    });
    if (buf) out.push({ at, dataUrl: 'data:image/jpeg;base64,' + buf.toString('base64') });
  }

  return out;
}
