import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AUTO_LEN, CvMatchLog, CvScoreSample, MATCH_LEN } from '../../types';
import { DataService } from '../../services/dataService';
import { getCvLog, getCvLogs, saveCvLog } from '../../services/bpsStore';
import {
  DEFAULT_BLUE_QUAD,
  DEFAULT_RED_QUAD,
  DEFAULT_TIMER_QUAD,
  GrayPlane,
  Quad,
  detectScoreRegions,
} from '../../services/cv/imagePipeline';
import { OcrHandle, ScoreGate, getOcr, readFrame } from '../../services/cv/scoreboardOcr';
import { MatchClock, MatchPhase } from '../../services/cv/matchClock';

export type SourceKind = 'none' | 'file' | 'url' | 'screen';

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

  const [sourceKind, setSourceKind] = useState<SourceKind>('none');
  const [sourceLabel, setSourceLabel] = useState('no source');
  const [urlInput, setUrlInput] = useState('');
  const [speed, setSpeed] = useState(3);

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
    setUploaded(new Set(getCvLogs().map((l) => l.matchKey)));
    setActiveMatch((cur) => cur || quals[0]?.key || '');
  }, []);

  useEffect(refreshMatches, [refreshMatches]);

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
   * Direct video URLs only. A YouTube or Twitch page is an embed, not a video
   * file, and even a real cross-origin file taints the canvas — so we say so
   * rather than silently producing nothing.
   */
  const loadUrl = () => {
    const url = urlInput.trim();
    if (!url) return;
    setError(null);

    if (/youtube\.com|youtu\.be|twitch\.tv/i.test(url)) {
      setError(
        'YouTube and Twitch pages cannot be read pixel-by-pixel — the browser blocks it, and no amount of permission changes that. Use Share Screen with the stream playing in another tab, or upload a downloaded file.'
      );
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

    let result;
    try {
      result = await readFrame(
        worker,
        v,
        w,
        h,
        blueQuadRef.current,
        redQuadRef.current,
        // Once we have given up on the clock there is no point paying for it.
        fallbackRef.current ? null : timerQuadRef.current,
        blueGate.current,
        redGate.current
      );
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
    if (samples.length) persist();
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
  const autoDetect = () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth || !v.videoHeight) {
      setError('Load footage and let a frame with the scoreboard on screen show first.');
      return;
    }
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(v, 0, 0, c.width, c.height);

    let frame: ImageData;
    try {
      frame = ctx.getImageData(0, 0, c.width, c.height);
    } catch {
      setError(
        'This video is cross-origin, so the browser will not let the page read its pixels. Upload the file directly, or use Share Screen.'
      );
      return;
    }

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
    sourceKind,
    sourceLabel,
    urlInput,
    setUrlInput,
    speed,
    setSpeed,
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
    persist,
    buildLog,
    correct,
    importLog,
  };
}
