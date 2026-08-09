import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AUTO_LEN, CvMatchLog, CvScoreSample, MATCH_LEN } from '../../types';
import { DataService } from '../../services/dataService';
import { getCvLog, getCvLogs, saveCvLog } from '../../services/bpsStore';
import {
  DEFAULT_BLUE_QUAD,
  DEFAULT_RED_QUAD,
  GrayPlane,
  Quad,
  detectScoreRegions,
} from '../../services/cv/imagePipeline';
import { OcrHandle, ScoreGate, getOcr, readFrame } from '../../services/cv/scoreboardOcr';

export type SourceKind = 'none' | 'file' | 'url' | 'screen';

/**
 * Quad positions survive a reload.
 *
 * A broadcast's overlay geometry is fixed for a whole event, so making the
 * operator re-drag two boxes before every match is pure friction — and a hurried
 * re-drag is exactly how a region ends up a few pixels off, which is the
 * difference between reading every frame and reading none.
 */
const QUAD_STORE_KEY = 'cv.scoreQuads.v1';

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

function loadQuads(): { blue: Quad; red: Quad } {
  try {
    const raw = localStorage.getItem(QUAD_STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (isQuad(parsed?.blue) && isQuad(parsed?.red)) {
        return { blue: parsed.blue, red: parsed.red };
      }
    }
  } catch {
    /* corrupt or unavailable storage just falls back to the defaults */
  }
  return { blue: DEFAULT_BLUE_QUAD, red: DEFAULT_RED_QUAD };
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

  const [running, setRunning] = useState(false);
  const [samples, setSamples] = useState<CvScoreSample[]>([]);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('');
  const [rejections, setRejections] = useState(0);
  /** Frames where the overlay was not on screen at all — replays, crowd shots. */
  const [skipped, setSkipped] = useState(0);
  const [previews, setPreviews] = useState<{ blue: GrayPlane | null; red: GrayPlane | null }>({
    blue: null,
    red: null,
  });

  // Refs for everything the sampling loop reads, so the loop never restarts (and
  // never drops a second) just because a piece of UI state changed.
  const ocrRef = useRef<OcrHandle | null>(null);
  const blueGate = useRef(new ScoreGate(0));
  const redGate = useRef(new ScoreGate(0));
  const busy = useRef(false);
  const lastSec = useRef(-1);
  const startOffset = useRef(0);
  const wallStart = useRef(0);
  const blueQuadRef = useRef(blueQuad);
  const redQuadRef = useRef(redQuad);
  const runningRef = useRef(false);
  const objectUrl = useRef<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  blueQuadRef.current = blueQuad;
  redQuadRef.current = redQuad;

  useEffect(() => {
    try {
      localStorage.setItem(QUAD_STORE_KEY, JSON.stringify({ blue: blueQuad, red: redQuad }));
    } catch {
      /* private mode / quota — the quads just will not persist */
    }
  }, [blueQuad, redQuad]);

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

  const matchSecond = useCallback((): number => {
    if (sourceKind === 'screen') {
      return Math.floor((performance.now() - wallStart.current) / 1000);
    }
    const v = videoRef.current;
    if (!v) return -1;
    return Math.floor(v.currentTime - startOffset.current);
  }, [sourceKind]);

  const sampleOnce = useCallback(async (sec: number) => {
    const worker = ocrRef.current?.worker;
    const v = videoRef.current;
    if (!worker || !v) return;

    const w = v.videoWidth;
    const h = v.videoHeight;
    if (!w || !h) return;

    const prevBlue = blueGate.current.value;
    const prevRed = redGate.current.value;

    let result;
    try {
      result = await readFrame(
        worker,
        v,
        w,
        h,
        blueQuadRef.current,
        redQuadRef.current,
        blueGate.current,
        redGate.current
      );
    } catch (e: any) {
      // getImageData throws SecurityError on a tainted (cross-origin) canvas.
      if (e?.name === 'SecurityError') {
        runningRef.current = false;
        setRunning(false);
        setError(
          'This video is cross-origin, so the browser will not let the page read its pixels. Upload the file directly, or use Share Screen.'
        );
        return;
      }
      throw e;
    }
    if (!result) return;

    // The overlay is not on screen — a replay, a crowd cut, a pit interview.
    // Nothing was attempted, so this is not a rejection and it is not a sample:
    // logging a held score here would invent a flat second the match never had.
    if (!result.overlayPresent) {
      setSkipped((n) => n + 1);
      return;
    }

    setPreviews({ blue: result.bluePlane, red: result.redPlane });
    setRejections(blueGate.current.rejections + redGate.current.rejections);

    setSamples((prev) => {
      if (prev.some((s) => s.sec === sec)) return prev;
      const next: CvScoreSample = {
        sec,
        phase: sec < AUTO_LEN ? 'auto' : 'teleop',
        blue: result.blue,
        red: result.red,
        db: Math.max(0, result.blue - prevBlue),
        dr: Math.max(0, result.red - prevRed),
      };
      return [...prev, next].sort((a, b) => a.sec - b.sec);
    });
    setDirty(true);
  }, []);

  useEffect(() => {
    if (!running) return;
    let raf = 0;

    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (!runningRef.current || busy.current) return;

      const sec = matchSecond();
      if (sec < 0 || sec <= lastSec.current) return;
      if (sec >= MATCH_LEN) {
        runningRef.current = false;
        setRunning(false);
        return;
      }

      lastSec.current = sec;
      busy.current = true;
      sampleOnce(sec)
        .catch((e) => setError(String(e?.message || e)))
        .finally(() => {
          busy.current = false;
        });
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [running, matchSecond, sampleOnce]);

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
    // Resume where the log left off rather than restarting the match.
    const resumeAt = lastSec.current + 1;
    if (sourceKind === 'screen') {
      wallStart.current = performance.now() - resumeAt * 1000;
    } else if (v) {
      startOffset.current = v.currentTime - resumeAt;
      v.playbackRate = speed;
      void v.play().catch(() => {});
    }

    runningRef.current = true;
    setRunning(true);
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
    setPreviews({ blue: null, red: null });
    blueGate.current = new ScoreGate(0);
    redGate.current = new ScoreGate(0);
    lastSec.current = -1;
    setDirty(false);
  };

  const resetQuad = () => {
    setBlueQuad(DEFAULT_BLUE_QUAD);
    setRedQuad(DEFAULT_RED_QUAD);
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
