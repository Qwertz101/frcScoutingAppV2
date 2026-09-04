import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AUTO_LEN, CvMatchLog, CvScoreSample, MATCH_LEN } from '../../types';
import { DataService } from '../../services/dataService';
import { fetchCvLogs, getCvLog, getCvLogs, saveCvLog } from '../../services/bpsStore';
import {
  DEFAULT_BLUE_QUAD,
  DEFAULT_RED_QUAD,
  DEFAULT_TIMER_QUAD,
  GrayPlane,
  Quad,
  detectScoreRegions,
} from '../../services/cv/imagePipeline';
import { OcrHandle, ScoreGate, getOcr, readFrame } from '../../services/cv/scoreboardOcr';
import { captureFrame } from '../../services/cv/browserCanvas';
import { MatchClock, MatchPhase } from '../../services/cv/matchClock';
import {
  JobMode,
  WorkerState,
  cancelJob as cancelWorkerJob,
  fetchCalibrationFrames,
  getWorkerState,
  submitJob,
} from '../../services/cv/captureWorker';

export type SourceKind = 'none' | 'file' | 'url' | 'screen';

/**
 * A path on the worker machine's own disk, rather than something for the
 * browser to fetch. `worker/src/sources.mjs#isRemoteSource` already treats
 * anything that is not a YouTube/Twitch page URL as exactly this and reads it
 * directly with ffmpeg -- most usefully, a file already sitting in
 * `worker/downloads/` from a previous run's "keep download", so re-running
 * against the same footage never has to re-fetch it. Matched loosely (any
 * absolute Windows or POSIX path ending in a common video extension) because
 * this only decides which side of the app handles the string; the worker is
 * what actually opens the file and reports a clear error if it is not there.
 */
const isLocalWorkerPath = (url: string) => {
  const s = url.trim();
  const drivePath = /^[a-zA-Z]:[\\/]/.test(s); // C:\... or C:/...
  const uncOrPosixPath = s.startsWith('\\\\') || s.startsWith('/');
  const videoExt = /\.(mp4|mkv|mov|webm|m4v|ts|avi)$/i.test(s);
  return (drivePath || uncOrPosixPath) && videoExt && !/\s/.test(s);
};

/** Does this link belong to the capture worker rather than the <video> element? */
export const isStreamLink = (url: string) =>
  /youtube\.com|youtu\.be|twitch\.tv/i.test(url) || isLocalWorkerPath(url);

/**
 * Quad positions survive a reload.
 *
 * A broadcast's overlay geometry is fixed for a whole event, so making the
 * operator re-drag two boxes before every match is pure friction — and a hurried
 * re-drag is exactly how a region ends up a few pixels off, which is the
 * difference between reading every frame and reading none.
 */
const QUAD_STORE_KEY = 'cv.scoreQuads.v2';

/**
 * How many consecutive seconds the scoreboard has to sit still after the buzzer
 * before recording stops.
 *
 * 0:00 is not the end of scoring. Climbs and the last cycle's points settle for
 * several seconds after the horn, and the old tracker's counter ran out before
 * they landed — on the reference broadcast it stopped with blue on 581 against
 * a true 641, and red on 375 against 420. Those 60 and 45 points were the
 * endgame, and they are exactly what this window recovers.
 */
const SETTLE_SECONDS = 6;

/**
 * Consecutive readable frames with an unreadable clock before the tracker gives
 * up on the timer and falls back to the old counter.
 *
 * Deliberately generous: the clock plate can be briefly obscured by a lower
 * third or a graphic wipe, and dropping to a mode that produces wrongly-timed
 * data over a couple of bad frames would be much worse than waiting.
 */
const TIMER_GIVE_UP_AFTER = 25;

function isQuad(q: unknown): q is Quad {
  return (
    Array.isArray(q) &&
    q.length === 4 &&
    q.every(
      (p) =>
        p &&
        typeof (p as Quad[0]).x === 'number' &&
        typeof (p as Quad[0]).y === 'number' &&
        Number.isFinite((p as Quad[0]).x) &&
        Number.isFinite((p as Quad[0]).y)
    )
  );
}

function loadQuads(): { blue: Quad; red: Quad; timer: Quad } {
  try {
    const raw = localStorage.getItem(QUAD_STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (isQuad(parsed?.blue) && isQuad(parsed?.red)) {
        return {
          blue: parsed.blue,
          red: parsed.red,
          // A v1 payload has no timer box; the default is a better starting
          // point than refusing the whole stored pair.
          timer: isQuad(parsed?.timer) ? parsed.timer : DEFAULT_TIMER_QUAD,
        };
      }
    }
  } catch {
    /* corrupt or unavailable storage just falls back to the defaults */
  }
  return { blue: DEFAULT_BLUE_QUAD, red: DEFAULT_RED_QUAD, timer: DEFAULT_TIMER_QUAD };
}

export interface TrackerMatch {
  key: string;
  label: string;
  number: number;
}

/**
 * All of the CV screen's behaviour, kept out of the view.
 *
 * The one non-obvious rule in here: sampling is keyed to the *video's* clock,
 * never wall-clock. The procedure calls for reviewing footage at up to 3x to
 * save time, and a wall-clock timer at 3x playback would log one sample per
 * three match-seconds. Screen capture is the exception — a live MediaStream has
 * no seekable timeline, so there wall-clock is the only clock there is, and it
 * is also the correct one because the stream really is realtime.
 */
export function useCvTracker() {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const eventKey = DataService.getSelectedEvent() || '';
  const [matches, setMatches] = useState<TrackerMatch[]>([]);
  const [activeMatch, setActiveMatch] = useState<string>('');
  const [uploaded, setUploaded] = useState<Set<string>>(new Set());
  /**
   * Logs the capture worker wrote, split by whether it trusts them.
   *
   * Three states rather than two, because "a log exists" stopped being the
   * useful question once the worker started writing them unattended. A log the
   * worker flagged needs a person; a log a person already touched does not.
   */
  const [autoFlagged, setAutoFlagged] = useState<Set<string>>(new Set());
  const [autoClean, setAutoClean] = useState<Set<string>>(new Set());
  const [reviewQueue, setReviewQueue] = useState<
    { matchKey: string; label: string; score: number | null; reasons: string[] }[]
  >([]);

  const [sourceKind, setSourceKind] = useState<SourceKind>('none');
  const [sourceLabel, setSourceLabel] = useState('no source');
  const [urlInput, setUrlInput] = useState('');
  const [speed, setSpeed] = useState(3);

  /**
   * What the capture worker on this machine is doing, or null if it is not
   * running.
   *
   * Null is the normal state on any machine that is not the workshop PC, so it
   * is shown as "not running" with instructions rather than as an error — the
   * manual Upload/Share Screen paths do not need the worker and must keep
   * working without it.
   */
  const [worker, setWorker] = useState<WorkerState | null>(null);
  const [workerBusy, setWorkerBusy] = useState(false);
  /** Whether a submitted job should save to the database. Dry run by default. */
  const [workerWrite, setWorkerWrite] = useState(false);
  /**
   * Optional window bounds, in minutes into the recording. Both blank means
   * scan the whole thing.
   *
   * A multi-hour VOD is affordable to scan when the source is a local file,
   * but every seek against a remote YouTube URL is a network round trip, and
   * that dominates: measured at roughly 1.5x the wall time of the footage
   * itself. Bounding the window is what keeps "read this VOD" from meaning
   * "wait most of a day" -- there is no dial for reading faster, only for
   * reading less.
   */
  const [windowStart, setWindowStart] = useState('');
  const [windowDuration, setWindowDuration] = useState('');
  /**
   * Fetch the footage locally before reading it.
   *
   * On by default because it is the faster path in nearly every case and the
   * temp file is deleted when the job ends. Turn it off to stream instead —
   * worth doing when disk is tight, since a bounded window still lands as a
   * real file for the length of the run.
   */
  const [workerDownload, setWorkerDownload] = useState(true);
  /**
   * Keep the fetched footage instead of deleting it when the job ends.
   *
   * Off by default: the files are gigabytes and the common case is one pass
   * over a window. Worth turning on while iterating on the same footage, where
   * re-fetching the same 2 GB for every attempt is pure waste.
   */
  const [workerKeepDownload, setWorkerKeepDownload] = useState(false);

  /**
   * Frames captured for calibration, as data URLs, plus what the detector made
   * of the first one.
   *
   * Several frames, never one. Every layout mistake in this pipeline so far came
   * from confirming a box against a single frame and finding it wrong the moment
   * the match moved on — a replay cutaway, a phase change, a graphic sliding in.
   */
  const [calFrames, setCalFrames] = useState<string[]>([]);
  /** Seconds into the source each calibration frame came from, index-aligned. */
  const [calTimes, setCalTimes] = useState<number[]>([]);
  /** Length of the source, so the scrubber knows how far it can reach. */
  const [calDuration, setCalDuration] = useState(0);
  const [calFrameSize, setCalFrameSize] = useState<{ width: number; height: number } | null>(null);
  const [calDetected, setCalDetected] = useState<Record<string, { x0: number; y0: number; x1: number; y1: number }>>({});
  const [calibrating, setCalibrating] = useState(false);

  const refreshWorker = useCallback(async () => {
    try {
      setWorker(await getWorkerState());
    } catch {
      // Unreachable is a state, not a failure: see the note on `worker` above.
      setWorker(null);
    }
  }, []);

  // Two seconds matches the worker's own dashboard. A scan of a multi-hour
  // recording reports progress roughly that often, so polling faster would show
  // the same numbers again and slower would feel stalled.
  useEffect(() => {
    void refreshWorker();
    const id = setInterval(() => void refreshWorker(), 2000);
    return () => clearInterval(id);
  }, [refreshWorker]);

  const stored = useRef(loadQuads());
  const [blueQuad, setBlueQuad] = useState<Quad>(stored.current.blue);
  const [redQuad, setRedQuad] = useState<Quad>(stored.current.red);
  const [timerQuad, setTimerQuad] = useState<Quad>(stored.current.timer);

  const [running, setRunning] = useState(false);
  const [samples, setSamples] = useState<CvScoreSample[]>([]);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('');
  const [rejections, setRejections] = useState(0);
  /** Frames where the overlay was not on screen at all — replays, crowd shots. */
  const [skipped, setSkipped] = useState(0);
  const [previews, setPreviews] = useState<{
    blue: GrayPlane | null;
    red: GrayPlane | null;
    timer: GrayPlane | null;
  }>({ blue: null, red: null, timer: null });

  /** What the clock plate currently says, and whether it is driving the log. */
  const [timerText, setTimerText] = useState('');
  const [clockStarted, setClockStarted] = useState(false);
  const [phase, setPhase] = useState<MatchPhase>('auto');
  /**
   * True when the timer could not be read and the tracker reverted to counting
   * seconds off the video. Surfaced loudly: the resulting log is only as
   * well-aligned as the operator's Start press, which is precisely the thing
   * this whole path exists to stop depending on.
   */
  const [timerFallback, setTimerFallback] = useState(false);
  const [timerReads, setTimerReads] = useState({ ok: 0, tried: 0 });

  // Refs for everything the sampling loop reads, so the loop never restarts (and
  // never drops a second) just because a piece of UI state changed.
  const ocrRef = useRef<OcrHandle | null>(null);
  const blueGate = useRef(new ScoreGate(0));
  const redGate = useRef(new ScoreGate(0));
  const lastSec = useRef(-1);
  const startOffset = useRef(0);
  const wallStart = useRef(0);
  const blueQuadRef = useRef(blueQuad);
  const redQuadRef = useRef(redQuad);
  const timerQuadRef = useRef(timerQuad);
  const runningRef = useRef(false);
  const clockRef = useRef(new MatchClock());
  /** Consecutive readable frames whose clock plate came back empty. */
  const timerMisses = useRef(0);
  const fallbackRef = useRef(false);
  /** Post-buzzer settle detector: last seen scores and how long they held. */
  const settle = useRef({ blue: -1, red: -1, held: 0 });
  const objectUrl = useRef<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  blueQuadRef.current = blueQuad;
  redQuadRef.current = redQuad;
  timerQuadRef.current = timerQuad;

  useEffect(() => {
    try {
      localStorage.setItem(
        QUAD_STORE_KEY,
        JSON.stringify({ blue: blueQuad, red: redQuad, timer: timerQuad })
      );
    } catch {
      /* private mode / quota — the quads just will not persist */
    }
  }, [blueQuad, redQuad, timerQuad]);

  /* ---------------- match schedule ---------------- */

  const refreshMatches = useCallback(() => {
    const all: any[] = DataService.getMatches() || [];
    const quals = all
      .filter((m) => (m.comp_level ?? 'qm') === 'qm')
      .map((m) => ({
        key: m.key as string,
        number: Number(m.match_number) || 0,
        label: `Q${m.match_number}`,
      }))
      .sort((a, b) => a.number - b.number);

    setMatches(quals);

    // Only this event's logs. The counter used to take every log in storage
    // while the chips could only ever colour a key on this event's schedule,
    // so the two disagreed by construction: a laptop still holding five
    // Glendale logs showed "5 / 52 uploaded" against a Sunset schedule with
    // every chip blank -- a progress bar claiming work that had not been done
    // here. Filtering on the schedule's own keys keeps the count and the
    // colours describing the same thing, whatever `eventKey` is set to.
    const keys = new Set(quals.map((q) => q.key));
    const logs = getCvLogs().filter((l) => keys.has(l.matchKey));
    setUploaded(new Set(logs.map((l) => l.matchKey)));

    // `source` is what distinguishes a worker log from a hand-made one; the
    // worker prefixes every log it writes, and the writer refuses to overwrite
    // anything that is not so prefixed.
    const isAuto = (l: CvMatchLog) => (l.source ?? '').startsWith('auto-worker');
    setAutoFlagged(new Set(logs.filter((l) => isAuto(l) && l.flagged).map((l) => l.matchKey)));
    setAutoClean(new Set(logs.filter((l) => isAuto(l) && !l.flagged).map((l) => l.matchKey)));

    const label = (k: string) => quals.find((q) => q.key === k)?.label ?? k;
    setReviewQueue(
      logs
        .filter((l) => l.flagged)
        // Worst first: a review queue whose top row is nearly fine is a list,
        // not a queue.
        .sort((a, b) => (a.quality?.score ?? 1) - (b.quality?.score ?? 1))
        .map((l) => ({
          matchKey: l.matchKey,
          label: label(l.matchKey),
          score: l.quality?.score ?? null,
          reasons: l.quality?.reasons ?? [],
        }))
    );

    setActiveMatch((cur) => cur || quals[0]?.key || '');
  }, []);

  useEffect(refreshMatches, [refreshMatches]);

  /**
   * Pull what the capture worker wrote, so its matches show up here.
   *
   * `refreshMatches` reads `getCvLogs()`, which is localStorage -- and the
   * worker does not write to localStorage. It writes to Supabase, on a
   * different machine's process, so a match it captured left the upload log
   * showing nothing at all: the count, the chip colours and the review queue
   * were all describing this browser's own history rather than the event's.
   *
   * One pull on open, merged into local storage by `fetchCvLogs`, then
   * `refreshMatches` again to recolour from the merged set. Failure is
   * deliberately quiet -- an offline laptop should still show the local logs
   * and let the manual path work, exactly as it did before.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await fetchCvLogs();
        if (!cancelled) refreshMatches();
      } catch {
        /* offline, or Supabase not configured — local logs still render */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshMatches]);

  /* ---------------- OCR worker ---------------- */

  // Lazy: nothing about tesseract is fetched until this screen mounts.
  useEffect(() => {
    let cancelled = false;
    setStatus('loading OCR engine…');
    getOcr((s, p) => {
      if (!cancelled && p < 1) setStatus(`${s} ${Math.round(p * 100)}%`);
    })
      .then((handle) => {
        if (cancelled) return;
        ocrRef.current = handle;
        setStatus('OCR ready');
      })
      .catch((e) => {
        if (!cancelled) setError(`Could not start the OCR engine: ${e?.message || e}`);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Only tear the worker down when the screen closes for good.
  useEffect(
    () => () => {
      ocrRef.current?.terminate().catch(() => {});
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    },
    []
  );

  /* ---------------- loading the active match's saved log ---------------- */

  useEffect(() => {
    if (!activeMatch) return;
    const existing = getCvLog(activeMatch);
    setSamples(existing?.samples ?? []);
    setDirty(false);
    setRejections(0);
    setSkipped(0);
    const last = existing?.samples?.[existing.samples.length - 1];
    blueGate.current = new ScoreGate(last?.blue ?? 0);
    redGate.current = new ScoreGate(last?.red ?? 0);
    lastSec.current = last ? last.sec : -1;
    // The clock is re-derived from the footage, not resumed from the log: match
    // elapsed now comes from the scoreboard, so there is no counter to restore.
    clockRef.current = new MatchClock();
    timerMisses.current = 0;
    fallbackRef.current = false;
    settle.current = { blue: -1, red: -1, held: 0 };
    setTimerFallback(false);
    setClockStarted(false);
    setTimerText('');
    setTimerReads({ ok: 0, tried: 0 });
  }, [activeMatch]);

  /* ---------------- source selection ---------------- */

  const clearSource = () => {
    if (objectUrl.current) {
      URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    const v = videoRef.current;
    if (v) {
      v.srcObject = null;
      v.removeAttribute('src');
      v.load();
    }
  };

  const loadFile = (file: File) => {
    setError(null);
    clearSource();
    const url = URL.createObjectURL(file);
    objectUrl.current = url;
    const v = videoRef.current;
    if (!v) return;
    v.crossOrigin = '';
    v.src = url;
    v.playbackRate = speed;
    setSourceKind('file');
    setSourceLabel(file.name);
  };

  /**
   * Send a stream or VOD link to the capture worker.
   *
   * This is the whole point of the link box now. The browser genuinely cannot
   * read a YouTube or Twitch page pixel-by-pixel, so rather than explain that
   * and leave the operator to go find a terminal, the link goes to the worker
   * process on this machine, which has ffmpeg and yt-dlp and no such limit.
   */
  const submitToWorker = async (mode: JobMode) => {
    const url = urlInput.trim();
    if (!url) return;
    setError(null);
    setWorkerBusy(true);
    try {
      const startMin = windowStart.trim() ? Number(windowStart) : undefined;
      const durationMin = windowDuration.trim() ? Number(windowDuration) : undefined;
      await submitJob({
        url,
        eventKey,
        mode,
        write: workerWrite,
        start: startMin != null ? startMin * 60 : undefined,
        duration: durationMin != null ? durationMin * 60 : undefined,
        // Only meaningful for a finished recording. A live broadcast is
        // consumed as it arrives and there is nothing to fetch ahead of.
        download: mode === 'vod' ? workerDownload : undefined,
        keepDownload: mode === 'vod' ? workerKeepDownload : undefined,
      });
      // Poll immediately rather than waiting for the next tick, so the panel
      // shows "running" the instant the button is released.
      await refreshWorker();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorkerBusy(false);
    }
  };

  const cancelWorker = async () => {
    setWorkerBusy(true);
    try {
      await cancelWorkerJob();
      await refreshWorker();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorkerBusy(false);
    }
  };

  /**
   * Direct video URLs only. A YouTube or Twitch page goes to the worker above;
   * anything else is loaded into the <video> element, where a cross-origin file
   * still has to be served with permissive CORS or the canvas is tainted.
   */
  const loadUrl = () => {
    const url = urlInput.trim();
    if (!url) return;
    setError(null);

    if (isStreamLink(url)) {
      void submitToWorker('vod');
      return;
    }

    clearSource();
    const v = videoRef.current;
    if (!v) return;
    // Required for a cross-origin video to be readable at all; the server still
    // has to send permissive CORS headers, and we surface it if it does not.
    v.crossOrigin = 'anonymous';
    v.src = url;
    v.playbackRate = speed;
    setSourceKind('url');
    setSourceLabel(url.split('/').pop() || 'remote video');
  };

  /** The realistic live-event path: operator shares the tab playing the stream. */
  const shareScreen = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });
      clearSource();
      streamRef.current = stream;
      const v = videoRef.current;
      if (!v) return;
      v.srcObject = stream;
      await v.play().catch(() => {});
      setSourceKind('screen');
      setSourceLabel('shared screen');
      // A captured stream is realtime; playback rate is meaningless.
      setSpeed(1);
    } catch (e: any) {
      if (e?.name !== 'NotAllowedError') {
        setError(`Screen share failed: ${e?.message || e}`);
      }
    }
  };

  useEffect(() => {
    const v = videoRef.current;
    if (v && sourceKind !== 'screen') v.playbackRate = speed;
  }, [speed, sourceKind]);

  /* ---------------- the sampling loop ---------------- */

  /**
   * Read one frame and, if it belongs to the match, log it.
   *
   * `at` is the *video* time of the frame — used only as a ruler for the clock,
   * never as the sample's timestamp. Returns true when recording is finished.
   */
  const sampleOnce = useCallback(async (at: number): Promise<boolean> => {
    const worker = ocrRef.current?.worker;
    const v = videoRef.current;
    if (!worker || !v) return false;

    const w = v.videoWidth;
    const h = v.videoHeight;
    if (!w || !h) return false;

    // Pixels are obtained HERE rather than inside `readFrame`, which now takes
    // raw pixels so that the identical recognition code can run in a Node
    // worker against ffmpeg-decoded frames. That moves the tainted-canvas
    // failure up to this call: `getImageData` is what throws, and it now sits
    // on this side of the boundary.
    let frame;
    try {
      frame = captureFrame(v, w, h);
    } catch (e: any) {
      // getImageData throws SecurityError on a tainted (cross-origin) canvas.
      if (e?.name === 'SecurityError') {
        setError(
          'This video is cross-origin, so the browser will not let the page read its pixels. Upload the file directly, or use Share Screen.'
        );
        return true;
      }
      throw e;
    }
    if (!frame) return false;

    const result = await readFrame(
      worker,
      frame,
      blueQuadRef.current,
      redQuadRef.current,
      // Once we have given up on the clock there is no point paying for it.
      fallbackRef.current ? null : timerQuadRef.current,
      blueGate.current,
      redGate.current
    );
    if (!result) return false;

    // The overlay is not on screen — a replay, a crowd cut, a pit interview.
    // Nothing was attempted, so this is not a rejection and it is not a sample:
    // logging a held score here would invent a flat second the match never had.
    if (!result.overlayPresent) {
      setSkipped((n) => n + 1);
      return false;
    }

    setPreviews({ blue: result.bluePlane, red: result.redPlane, timer: result.timer.preview });
    setRejections(blueGate.current.rejections + redGate.current.rejections);

    /* ---- when is this frame? ---- */
    let sec: number;
    let samplePhase: MatchPhase;
    let finished = false;

    if (!fallbackRef.current) {
      const clock = clockRef.current;
      if (result.timer.remaining === null) timerMisses.current++;
      else timerMisses.current = 0;

      clock.feed(result.timer.remaining, at);
      const state = clock.state;
      setTimerReads({ ok: clock.accepted, tried: clock.offered });
      setTimerText(
        result.timer.remaining === null
          ? '--:--'
          : `${Math.floor(result.timer.remaining / 60)}:${String(result.timer.remaining % 60).padStart(2, '0')}`
      );

      if (!state.started) {
        // Pre-match, the intro banner, a frozen graphic. Nothing here belongs in
        // the log, and there is no operator Start press to get wrong.
        if (timerMisses.current >= TIMER_GIVE_UP_AFTER) {
          fallbackRef.current = true;
          setTimerFallback(true);
          // The counter has to start somewhere; the operator's Start press is
          // all we have left, which is exactly why this is flagged in the UI.
          startOffset.current = at;
        }
        return false;
      }

      setClockStarted(true);
      setPhase(state.phase);
      samplePhase = state.phase;
      // Extrapolated from the last *accepted* clock reading, so a frame whose
      // plate was obscured still gets a defensible timestamp.
      sec = Math.round(clock.elapsedAt(at));

      /* ---- 0:00 is not the end of scoring ---- */
      if (state.ended) {
        if (result.blue === settle.current.blue && result.red === settle.current.red) {
          settle.current.held++;
        } else {
          settle.current = { blue: result.blue, red: result.red, held: 0 };
        }
        // Trailing points are attributed to the final match second rather than
        // to invented times past the end, so downstream windows still close at
        // MATCH_LEN.
        sec = MATCH_LEN;
        finished = settle.current.held >= SETTLE_SECONDS;
      }
    } else {
      sec = Math.floor(at - startOffset.current);
      if (sec < 0) return false;
      samplePhase = sec < AUTO_LEN ? 'auto' : 'teleop';
      if (sec > MATCH_LEN) return true;
      finished = sec >= MATCH_LEN;
    }

    lastSec.current = Math.max(lastSec.current, sec);

    /* ---- log it ---- */
    // Upsert, then rebuild every delta from the score series. Sampling by video
    // second against a clock read from the frame means two samples can land in
    // the same match second (and, after the buzzer, many do); the later read is
    // the better one, and recomputing deltas wholesale is the only way to keep
    // them consistent with the scores they are supposed to describe.
    setSamples((prev) => {
      const next = prev.filter((s) => s.sec !== sec);
      next.push({ sec, phase: samplePhase, blue: result.blue, red: result.red, db: 0, dr: 0 });
      next.sort((a, b) => a.sec - b.sec);
      let pb = 0;
      let pr = 0;
      return next.map((s) => {
        const row = { ...s, db: Math.max(0, s.blue - pb), dr: Math.max(0, s.red - pr) };
        pb = s.blue;
        pr = s.red;
        return row;
      });
    });
    setDirty(true);
    return finished;
  }, []);

  /** Resolve when the element has actually landed on `t`. */
  const seekTo = (v: HTMLVideoElement, t: number) =>
    new Promise<void>((resolve) => {
      const on = () => {
        v.removeEventListener('seeked', on);
        resolve();
      };
      v.addEventListener('seeked', on);
      v.currentTime = t;
    });

  const sourceKindRef = useRef(sourceKind);
  sourceKindRef.current = sourceKind;
  const nextAt = useRef(0);

  /**
   * Drive sampling off the video's own clock, one second at a time.
   *
   * Recorded footage is *seeked* to each target rather than played at it. A
   * playback-and-poll loop silently stretches or shreds the timeline the moment
   * a pass runs long — at 3x it would ask for one sample per three match
   * seconds — whereas an explicit seek makes a slow pass cost wall time and
   * nothing else. Every second of the video gets looked at exactly once.
   *
   * Screen capture is the exception: a live MediaStream has no seekable
   * timeline, so it is paced by wall clock, which there is also the correct
   * clock because the stream really is realtime.
   */
  const pump = useCallback(async () => {
    const v = videoRef.current;
    if (!v) return;

    while (runningRef.current) {
      let at: number;

      if (sourceKindRef.current === 'screen') {
        const now = (performance.now() - wallStart.current) / 1000;
        const wait = Math.max(0, (Math.ceil(now) - now) * 1000);
        if (wait > 1) await new Promise((r) => setTimeout(r, wait));
        at = (performance.now() - wallStart.current) / 1000;
      } else {
        if (Number.isFinite(v.duration) && nextAt.current > v.duration) break;
        await seekTo(v, nextAt.current);
        at = v.currentTime;
        nextAt.current += 1;
      }

      if (!runningRef.current) break;
      let done = false;
      try {
        done = await sampleOnce(at);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        break;
      }
      if (done) break;
    }

    runningRef.current = false;
    setRunning(false);
    videoRef.current?.pause();
  }, [sampleOnce]);

  const start = () => {
    if (!ocrRef.current) {
      setError('The OCR engine is still loading.');
      return;
    }
    if (sourceKind === 'none') {
      setError('Load a video, or share a screen, before recording.');
      return;
    }
    setError(null);

    const v = videoRef.current;
    if (sourceKind === 'screen') {
      wallStart.current = performance.now();
    } else if (v) {
      // Sampling seeks; a playing element would only fight it.
      v.pause();
      nextAt.current = v.currentTime;
    }

    runningRef.current = true;
    setRunning(true);
    void pump();
  };

  const stop = () => {
    runningRef.current = false;
    setRunning(false);
    videoRef.current?.pause();
    // Saving is a deliberate action now (the Save button), not implicit in
    // stopping — the operator reviews/corrects the log first, then commits it.
  };

  const reset = () => {
    runningRef.current = false;
    setRunning(false);
    setSamples([]);
    setRejections(0);
    setSkipped(0);
    setPreviews({ blue: null, red: null, timer: null });
    blueGate.current = new ScoreGate(0);
    redGate.current = new ScoreGate(0);
    lastSec.current = -1;
    clockRef.current = new MatchClock();
    timerMisses.current = 0;
    fallbackRef.current = false;
    settle.current = { blue: -1, red: -1, held: 0 };
    nextAt.current = 0;
    setTimerFallback(false);
    setClockStarted(false);
    setTimerText('');
    setTimerReads({ ok: 0, tried: 0 });
    setPhase('auto');
    setDirty(false);
  };

  const resetQuad = () => {
    setBlueQuad(DEFAULT_BLUE_QUAD);
    setRedQuad(DEFAULT_RED_QUAD);
    setTimerQuad(DEFAULT_TIMER_QUAD);
  };

  /**
   * Snap both regions onto the score plates using the current frame's colour.
   *
   * Placement precision matters more than it looks — a region a few pixels wide
   * of the plate drops the read rate off a cliff — so this exists to get the
   * operator to "almost right" instantly, after which the handles are for
   * nudging rather than for finding the scoreboard from scratch.
   */
  /**
   * Grab several frames spread across the footage, for calibrating against.
   *
   * Seeks a recorded video to evenly spaced points; for a live screen share
   * there is nothing to seek, so it samples over a few seconds of wall time
   * instead. Either way the point is the same: a box has to be right on more
   * than the one frame that happened to be showing.
   */
  /**
   * One frame at one moment, for hunting down the scoreboard by hand.
   *
   * The evenly-spread default is a guess, and on a real broadcast it is usually
   * a bad one: most of an event is not a match, so six frames spread across a
   * window land on crowd shots, sponsor cards, the title card and the
   * post-match results graphic — none of which show the live overlay, and the
   * results screen is actively misleading because it looks like a scoreboard
   * while having a completely different layout. This is how a person says "no,
   * THIS moment", either by scrubbing or by typing a timestamp they already
   * know from watching the video elsewhere.
   *
   * Returns the frame, or null with `error` set.
   */
  const grabCalibrationFrameAt = async (seconds: number): Promise<string | null> => {
    const link = urlInput.trim();
    setError(null);

    if (isStreamLink(link)) {
      try {
        const got = await fetchCalibrationFrames({ url: link, times: [seconds] });
        const shot = got.frames[0];
        if (!shot) {
          setError('The worker could not read a frame at that point.');
          return null;
        }
        if (got.duration) setCalDuration(got.duration);
        setCalFrameSize(got.frameSize);
        return shot.dataUrl;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return null;
      }
    }

    // Local file: seek the element we already have rather than asking the
    // worker for something it may not even have a copy of.
    const v = videoRef.current;
    if (!v || !v.videoWidth || !Number.isFinite(v.duration)) {
      setError('This source cannot be scrubbed — grab frames from a link or an uploaded file.');
      return null;
    }
    try {
      const wasPaused = v.paused;
      v.pause();
      await new Promise<void>((resolve) => {
        const done = () => {
          v.removeEventListener('seeked', done);
          resolve();
        };
        v.addEventListener('seeked', done);
        v.currentTime = Math.max(0, Math.min(seconds, v.duration - 0.1));
      });
      const canvas = document.createElement('canvas');
      canvas.width = v.videoWidth;
      canvas.height = v.videoHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL('image/jpeg', 0.85);
      if (!wasPaused) void v.play().catch(() => {});
      return url;
    } catch {
      setError('The browser would not let this video be read pixel-by-pixel.');
      return null;
    }
  };

  const captureCalibrationFrames = async (count = 6) => {
    // A stream or VOD has no browser-readable video, so the worker supplies the
    // frames. This is the primary path -- the local capture below only covers
    // an uploaded file or a shared screen.
    const link = urlInput.trim();
    if (isStreamLink(link)) {
      setError(null);
      setWorkerBusy(true);
      try {
        const startMin = windowStart.trim() ? Number(windowStart) * 60 : undefined;
        const durMin = windowDuration.trim() ? Number(windowDuration) * 60 : undefined;
        const got = await fetchCalibrationFrames({
          url: link,
          count,
          start: startMin,
          duration: durMin,
        });
        if (!got.frames.length) {
          setError('The worker could not read any frames from that link.');
          return;
        }
        setCalFrames(got.frames.map((f) => f.dataUrl));
        setCalTimes(got.frames.map((f) => f.at));
        setCalDuration(got.duration || 0);
        setCalFrameSize(got.frameSize);
        // No proposal for a stream: the detector runs in the worker, not here,
        // and offering a guess this side would mean decoding the video twice.
        setCalDetected({});
        setCalibrating(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setWorkerBusy(false);
      }
      return;
    }

    const v = videoRef.current;
    if (!v || !v.videoWidth || !v.videoHeight) {
      setError('Load footage first, and let a frame with the scoreboard on screen show.');
      return;
    }
    setError(null);

    const shots: string[] = [];
    const shotTimes: number[] = [];
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const grab = () => {
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      // JPEG, not PNG: these are photographs of a broadcast, and six 1080p PNGs
      // is tens of megabytes of state to hold in a React component.
      return canvas.toDataURL('image/jpeg', 0.85);
    };

    const seekable = sourceKind !== 'screen' && Number.isFinite(v.duration) && v.duration > 1;
    try {
      if (seekable) {
        const wasPaused = v.paused;
        v.pause();
        const start = v.duration * 0.1;
        const span = v.duration * 0.8;
        for (let i = 0; i < count; i++) {
          const at = start + (span * i) / Math.max(1, count - 1);
          await new Promise<void>((resolve) => {
            const done = () => {
              v.removeEventListener('seeked', done);
              resolve();
            };
            v.addEventListener('seeked', done);
            v.currentTime = Math.min(at, v.duration - 0.1);
          });
          shots.push(grab());
          shotTimes.push(v.currentTime);
        }
        if (!wasPaused) void v.play().catch(() => {});
      } else {
        for (let i = 0; i < count; i++) {
          shots.push(grab());
          // A live screen share has no timeline to point at, so the "time" is
          // just how far into the sampling we were.
          shotTimes.push(i * 0.7);
          await new Promise((r) => setTimeout(r, 700));
        }
      }
    } catch {
      setError(
        'The browser would not let this video be read pixel-by-pixel. Upload the file directly, or use Share Screen.'
      );
      return;
    }

    setCalFrames(shots);
    setCalTimes(shotTimes);
    setCalDuration(Number.isFinite(v.duration) ? v.duration : 0);
    setCalFrameSize({ width: v.videoWidth, height: v.videoHeight });

    // Offer the detector's guess as a starting point. Failure here is fine and
    // expected on an unfamiliar layout — that is why a human is being asked.
    try {
      const frame = captureFrame(v, v.videoWidth, v.videoHeight);
      const found = frame ? detectScoreRegions(frame) : null;
      if (found) {
        const box = (q: Quad) => ({
          x0: Math.min(...q.map((p) => p.x)),
          y0: Math.min(...q.map((p) => p.y)),
          x1: Math.max(...q.map((p) => p.x)),
          y1: Math.max(...q.map((p) => p.y)),
        });
        setCalDetected({
          blueScore: box(found.blue),
          redScore: box(found.red),
          timer: box(found.timer),
        });
      } else {
        setCalDetected({});
      }
    } catch {
      setCalDetected({});
    }

    setCalibrating(true);
  };

  const autoDetect = () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth || !v.videoHeight) {
      setError('Load footage and let a frame with the scoreboard on screen show first.');
      return;
    }
    let frame: ImageData | null;
    try {
      frame = captureFrame(v, v.videoWidth, v.videoHeight);
    } catch {
      setError(
        'This video is cross-origin, so the browser will not let the page read its pixels. Upload the file directly, or use Share Screen.'
      );
      return;
    }
    if (!frame) return;

    const found = detectScoreRegions(frame);
    if (!found) {
      setError(
        'Could not find the two score plates in this frame. Pause on a frame with the scoreboard fully visible and try again, or drag the regions by hand.'
      );
      return;
    }
    setError(null);
    setBlueQuad(found.blue);
    setRedQuad(found.red);
    setTimerQuad(found.timer);
  };

  /* ---------------- persistence ---------------- */

  const buildLog = useCallback(
    (): CvMatchLog => ({
      matchKey: activeMatch,
      eventKey,
      samples,
      source:
        sourceKind === 'screen'
          ? 'Live stream (screen capture)'
          : sourceKind === 'file'
            ? `Recorded video — ${sourceLabel}`
            : sourceKind === 'url'
              ? `Recorded video — ${sourceLabel}`
              : 'unknown',
      createdAt: getCvLog(activeMatch)?.createdAt || Date.now(),
    }),
    [activeMatch, eventKey, samples, sourceKind, sourceLabel]
  );

  const persist = useCallback(() => {
    if (!activeMatch || !samples.length) return;
    saveCvLog(buildLog());
    setUploaded((prev) => new Set(prev).add(activeMatch));
    setDirty(false);
  }, [activeMatch, samples.length, buildLog]);

  /**
   * Manual correction.
   *
   * OCR will be wrong occasionally and the whole downstream solver depends on
   * this stream, so an edit rewrites the running score from that second onward
   * and recomputes every delta — otherwise a corrected value would contradict
   * the deltas around it and make the log internally inconsistent.
   */
  const correct = (sec: number, side: 'blue' | 'red', value: number) => {
    if (!Number.isFinite(value) || value < 0) return;
    setSamples((prev) => {
      const next = prev.map((s) => (s.sec === sec ? { ...s, [side]: value } : s));
      let pb = 0;
      let pr = 0;
      const rebuilt = next.map((s) => {
        const row = { ...s, db: Math.max(0, s.blue - pb), dr: Math.max(0, s.red - pr) };
        pb = s.blue;
        pr = s.red;
        return row;
      });
      // Keep the live tracker consistent with the corrected tail, so recording
      // can resume without immediately fighting the operator's fix.
      const last = rebuilt[rebuilt.length - 1];
      if (last) {
        blueGate.current.override(last.blue);
        redGate.current.override(last.red);
      }
      return rebuilt;
    });
    setDirty(true);
  };

  const importLog = (log: CvMatchLog) => {
    saveCvLog(log);
    setUploaded((prev) => new Set(prev).add(log.matchKey));
    if (log.matchKey === activeMatch) setSamples(log.samples);
    refreshMatches();
  };

  /* ---------------- derived ---------------- */

  const latest = samples[samples.length - 1];
  const clock = useMemo(() => {
    const sec = latest ? latest.sec : 0;
    const remaining = Math.max(0, MATCH_LEN - sec);
    return `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
  }, [latest]);

  return {
    videoRef,
    eventKey,
    matches,
    activeMatch,
    setActiveMatch,
    uploaded,
    autoFlagged,
    autoClean,
    reviewQueue,
    refreshMatches,
    sourceKind,
    sourceLabel,
    urlInput,
    setUrlInput,
    speed,
    setSpeed,
    worker,
    workerBusy,
    workerWrite,
    setWorkerWrite,
    windowStart,
    setWindowStart,
    windowDuration,
    setWindowDuration,
    workerDownload,
    setWorkerDownload,
    workerKeepDownload,
    setWorkerKeepDownload,
    submitToWorker,
    cancelWorker,
    refreshWorker,
    blueQuad,
    setBlueQuad,
    redQuad,
    setRedQuad,
    timerQuad,
    setTimerQuad,
    timerText,
    timerFallback,
    timerReads,
    clockStarted,
    phase,
    running,
    samples,
    dirty,
    error,
    setError,
    status,
    rejections,
    skipped,
    previews,
    blue: latest?.blue ?? 0,
    red: latest?.red ?? 0,
    clock,
    loadFile,
    loadUrl,
    shareScreen,
    start,
    stop,
    reset,
    resetQuad,
    autoDetect,
    calFrames,
    calTimes,
    calDuration,
    calFrameSize,
    calDetected,
    grabCalibrationFrameAt,
    calibrating,
    setCalibrating,
    captureCalibrationFrames,
    persist,
    buildLog,
    correct,
    importLog,
  };
}
