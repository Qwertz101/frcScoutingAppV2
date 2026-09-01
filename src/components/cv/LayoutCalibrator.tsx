import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CalibratedLayout,
  LAYOUT_ELEMENTS,
  LayoutBoxes,
  LayoutCorrection,
  LayoutElementId,
  LayoutRect,
  fetchLayout,
  isMeaningfulMove,
  logCorrections,
  rectDelta,
  saveLayout,
  seasonOf,
} from '../../services/cv/layoutStore';

/**
 * Teaching the software where a competition's scoreboard is.
 *
 * A one-time setup per event. The detector proposes what it can, a human fixes
 * what it got wrong, and the result is stored centrally so every machine
 * scanning that event uses it.
 *
 * Two things about the interaction are deliberate, and both come from watching
 * the old three-boxes-at-once editor fail:
 *
 * **One box is editable at a time.** The blue, timer and red boxes meet at
 * shared edges, and the browser hit-tests by paint order, not by which handle
 * is nearest — so a drag aimed at blue's inner corner would silently move the
 * timer. Here the other boxes are drawn but inert.
 *
 * **The numbers are small, so nudging is a first-class control.** Arrow keys
 * move one pixel; with Shift they move the nearest edge instead of the whole
 * box. The magnifier shows the active edge at up to 8x, because getting a box
 * within a couple of pixels by trackpad drag alone is genuinely hard.
 */

type Corner = 0 | 1 | 2 | 3;

const DEFAULT_BOX: Record<LayoutElementId, LayoutRect> = {
  blueScore: { x0: 0.33, y0: 0.14, x1: 0.44, y1: 0.23 },
  redScore: { x0: 0.56, y0: 0.14, x1: 0.67, y1: 0.23 },
  timer: { x0: 0.45, y0: 0.14, x1: 0.55, y1: 0.23 },
  blueTeam1: { x0: 0.03, y0: 0.09, x1: 0.11, y1: 0.13 },
  blueTeam2: { x0: 0.12, y0: 0.09, x1: 0.20, y1: 0.13 },
  blueTeam3: { x0: 0.21, y0: 0.09, x1: 0.29, y1: 0.13 },
  redTeam1: { x0: 0.71, y0: 0.09, x1: 0.79, y1: 0.13 },
  redTeam2: { x0: 0.80, y0: 0.09, x1: 0.88, y1: 0.13 },
  redTeam3: { x0: 0.89, y0: 0.09, x1: 0.97, y1: 0.13 },
};

const boxesToMap = (b: LayoutBoxes): Record<LayoutElementId, LayoutRect> => ({
  blueScore: b.blueScore,
  redScore: b.redScore,
  timer: b.timer,
  blueTeam1: b.blueTeams[0],
  blueTeam2: b.blueTeams[1],
  blueTeam3: b.blueTeams[2],
  redTeam1: b.redTeams[0],
  redTeam2: b.redTeams[1],
  redTeam3: b.redTeams[2],
});

const mapToBoxes = (m: Record<LayoutElementId, LayoutRect>): LayoutBoxes => ({
  blueScore: m.blueScore,
  redScore: m.redScore,
  timer: m.timer,
  blueTeams: [m.blueTeam1, m.blueTeam2, m.blueTeam3],
  redTeams: [m.redTeam1, m.redTeam2, m.redTeam3],
});

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Seconds as h:mm:ss (or m:ss under an hour) — how a person reads a VOD timeline. */
function fmtTime(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return (h ? h + ':' : '') + mm + ':' + String(ss).padStart(2, '0');
}

/**
 * Parse what someone types after reading a timestamp off a VOD.
 *
 * Accepts `1:23:45`, `12:30`, `750`, and comma- or space-separated lists of
 * them, because the fastest route to a usable frame is usually pasting the
 * times of a few matches you already know — not scrubbing blind, which on a
 * remote VOD costs several seconds per look.
 */
function parseStamps(text: string): number[] {
  const out: number[] = [];
  for (const raw of text.split(/[,\s]+/)) {
    const t = raw.trim();
    if (!t) continue;
    const parts = t.split(':').map((p) => Number(p));
    if (parts.some((n) => !Number.isFinite(n) || n < 0)) continue;
    let sec = 0;
    for (const p of parts) sec = sec * 60 + p;
    out.push(sec);
  }
  return out;
}

/** Tone drives the outline colour: alliance colours mean alliance, nothing else. */
function toneOf(id: LayoutElementId): 'blue' | 'red' | 'timer' {
  if (id.startsWith('blue')) return 'blue';
  if (id.startsWith('red')) return 'red';
  return 'timer';
}

interface Props {
  eventKey: string;
  /** Frames sampled across a match. More than one, always — see the header. */
  frames: string[];
  /** Seconds into the source each frame came from, index-aligned with `frames`. */
  frameTimes?: number[];
  /** Length of the source, so the scrubber knows how far it reaches. */
  duration?: number;
  /**
   * Fetch one more frame at a chosen moment.
   *
   * Absent when the source cannot be scrubbed (a live screen share has no
   * timeline), in which case the hunting controls are hidden rather than shown
   * broken.
   */
  onGrabFrameAt?: (seconds: number) => Promise<string | null>;
  frameSize: { width: number; height: number } | null;
  sourceLabel?: string;
  /**
   * What the detector found on these frames, if anything. Boxes start here, and
   * the difference between this and what gets saved is exactly the correction
   * worth recording.
   */
  detected?: Partial<Record<LayoutElementId, LayoutRect>>;
  onClose: () => void;
  onSaved?: (layout: CalibratedLayout) => void;
}

export function LayoutCalibrator({
  eventKey,
  frames,
  frameTimes,
  duration,
  onGrabFrameAt,
  frameSize,
  sourceLabel,
  detected,
  onClose,
  onSaved,
}: Props) {
  const [boxes, setBoxes] = useState<Record<LayoutElementId, LayoutRect>>(DEFAULT_BOX);
  /** What the detector offered, kept so a correction can be measured against it. */
  const [proposed, setProposed] = useState<Partial<Record<LayoutElementId, LayoutRect>>>({});
  const [confirmed, setConfirmed] = useState<Set<LayoutElementId>>(new Set());
  const [active, setActive] = useState<LayoutElementId>('blueScore');
  const [frameIndex, setFrameIndex] = useState(0);
  const [zoom, setZoom] = useState(8);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  /**
   * Saving writes over whatever layout the event already has, and it is easy
   * to reach this screen with the app's selected event NOT the one just
   * calibrated — the CV tab shows the boxes against whatever `eventKey` the
   * app has selected, not against the video, so nothing stops a Sunset
   * calibration from being saved onto an IRI event left selected from the
   * last run. This makes that a deliberate second click that names the event
   * out loud, rather than a slip nobody notices until the next scan.
   */
  const [confirmingSave, setConfirmingSave] = useState(false);

  /**
   * The frames on screen, which start as whatever was sampled and grow as a
   * person hunts down better ones. Held locally rather than pushed back up,
   * because finding a usable frame is part of calibrating, not part of the
   * capture the parent set up.
   */
  const [shots, setShots] = useState<{ url: string; at: number }[]>([]);
  const [seekTo, setSeekTo] = useState(0);
  const [stamp, setStamp] = useState('');
  const [grabbing, setGrabbing] = useState(false);
  const [grabNote, setGrabNote] = useState<string | null>(null);

  // A stale confirmation must not carry over if the event changes underneath
  // it — "yes, save to 2026iri" should never fire a save to 2026sunshow.
  useEffect(() => {
    setConfirmingSave(false);
  }, [eventKey]);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ corner: Corner | 'move'; startX: number; startY: number; rect: LayoutRect } | null>(null);

  const season = seasonOf(eventKey);
  const activeRect = boxes[active];

  // Seed from what the parent sampled, and re-seed if it samples again.
  useEffect(() => {
    setShots(frames.map((url, i) => ({ url, at: frameTimes?.[i] ?? 0 })));
    setFrameIndex(0);
  }, [frames, frameTimes]);

  // Order of preference: a layout already saved for this event, then whatever
  // the detector proposes, then the defaults. A saved layout wins because it
  // was confirmed by a person and the detector was not.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let existing: CalibratedLayout | null = null;
      try {
        existing = await fetchLayout(eventKey);
      } catch {
        /* Supabase unreachable — fall through to the detector's proposal */
      }
      if (cancelled) return;

      if (existing) {
        setBoxes(boxesToMap(existing.boxes));
        setConfirmed(new Set(LAYOUT_ELEMENTS.map((e) => e.id)));
        setStatus(`Loaded the saved layout for ${eventKey}. Adjust anything that has moved.`);
      } else if (detected && Object.keys(detected).length) {
        setProposed(detected);
        setBoxes((b) => ({ ...b, ...detected }));
        // Only what the detector actually offered counts as pre-filled; the
        // rest stay unconfirmed so nobody saves a default box by accident.
        setConfirmed(new Set(Object.keys(detected) as LayoutElementId[]));
        setStatus(
          `The detector placed ${Object.keys(detected).length} of ${LAYOUT_ELEMENTS.length} boxes. ` +
            'Check each one, and place the rest.'
        );
      }
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [eventKey, detected]);

  const setActiveRect = useCallback(
    (next: LayoutRect) => setBoxes((b) => ({ ...b, [active]: next })),
    [active]
  );

  /* ---------------- dragging ---------------- */

  const local = (e: React.PointerEvent) => {
    const box = stageRef.current?.getBoundingClientRect();
    if (!box || !box.width || !box.height) return null;
    return { x: clamp01((e.clientX - box.left) / box.width), y: clamp01((e.clientY - box.top) / box.height) };
  };

  const onDown = (corner: Corner | 'move') => (e: React.PointerEvent) => {
    const p = local(e);
    if (!p) return;
    drag.current = { corner, startX: p.x, startY: p.y, rect: { ...activeRect } };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  };

  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const p = local(e);
    if (!p) return;
    const d = drag.current;
    const r = { ...d.rect };
    if (d.corner === 'move') {
      const dx = p.x - d.startX;
      const dy = p.y - d.startY;
      const w = r.x1 - r.x0;
      const h = r.y1 - r.y0;
      r.x0 = clamp01(r.x0 + dx);
      r.y0 = clamp01(r.y0 + dy);
      r.x1 = clamp01(r.x0 + w);
      r.y1 = clamp01(r.y0 + h);
    } else {
      if (d.corner === 0 || d.corner === 3) r.x0 = p.x;
      else r.x1 = p.x;
      if (d.corner === 0 || d.corner === 1) r.y0 = p.y;
      else r.y1 = p.y;
    }
    // Normalise so a corner dragged past its opposite does not invert the box.
    setActiveRect({
      x0: Math.min(r.x0, r.x1),
      y0: Math.min(r.y0, r.y1),
      x1: Math.max(r.x0, r.x1),
      y1: Math.max(r.y0, r.y1),
    });
  };

  const endDrag = () => {
    drag.current = null;
  };

  /* ---------------- keyboard nudging ---------------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const dirs: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      };
      const dir = dirs[e.key];
      if (!dir) return;
      e.preventDefault();

      // One screen pixel, expressed in fractions, so the step means the same
      // thing whatever the frame's resolution.
      const w = frameSize?.width || 1920;
      const h = frameSize?.height || 1080;
      const step = e.altKey ? 5 : 1;
      const dx = (dir[0] * step) / w;
      const dy = (dir[1] * step) / h;

      const r = { ...boxes[active] };
      if (e.shiftKey) {
        // Move the trailing edge only — the usual "just a bit wider" correction.
        if (dir[0] < 0) r.x0 = clamp01(r.x0 + dx);
        else if (dir[0] > 0) r.x1 = clamp01(r.x1 + dx);
        if (dir[1] < 0) r.y0 = clamp01(r.y0 + dy);
        else if (dir[1] > 0) r.y1 = clamp01(r.y1 + dy);
      } else {
        r.x0 = clamp01(r.x0 + dx);
        r.x1 = clamp01(r.x1 + dx);
        r.y0 = clamp01(r.y0 + dy);
        r.y1 = clamp01(r.y1 + dy);
      }
      setBoxes((b) => ({ ...b, [active]: r }));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, boxes, frameSize]);

  /* ---------------- finding a usable frame ---------------- */

  const addShots = async (times: number[]) => {
    if (!onGrabFrameAt || !times.length) return;
    setGrabbing(true);
    setGrabNote(null);
    try {
      const added: { url: string; at: number }[] = [];
      for (const t of times.slice(0, 8)) {
        const url = await onGrabFrameAt(t);
        if (url) added.push({ url, at: t });
      }
      if (!added.length) {
        setGrabNote('No frame came back for that time.');
        return;
      }
      setShots((prev) => {
        // Keep the strip in timeline order and drop anything landing on a
        // second already covered, so repeated grabs at the same spot do not
        // pile up identical thumbnails.
        const merged = [...prev];
        for (const a of added) {
          const dup = merged.findIndex((m) => Math.abs(m.at - a.at) < 1);
          if (dup >= 0) merged[dup] = a;
          else merged.push(a);
        }
        merged.sort((x, y) => x.at - y.at);
        const idx = merged.findIndex((m) => Math.abs(m.at - added[0].at) < 1);
        if (idx >= 0) setFrameIndex(idx);
        return merged;
      });
      setGrabNote(
        added.length === 1
          ? `Added the frame at ${fmtTime(added[0].at)}.`
          : `Added ${added.length} frames.`
      );
    } finally {
      setGrabbing(false);
    }
  };

  const dropShot = (i: number) => {
    setShots((prev) => {
      const next = prev.filter((_, n) => n !== i);
      setFrameIndex((cur) => Math.max(0, Math.min(cur, next.length - 1)));
      return next;
    });
  };

  /* ---------------- save ---------------- */

  const confirmActive = () => {
    setConfirmed((c) => new Set(c).add(active));
    const order = LAYOUT_ELEMENTS.map((e) => e.id);
    const next = order[order.indexOf(active) + 1];
    if (next) setActive(next);
  };

  const save = async () => {
    setBusy(true);
    setStatus(null);
    setConfirmingSave(false);
    try {
      const layout: CalibratedLayout = {
        eventKey,
        season,
        label: sourceLabel ?? '',
        boxes: mapToBoxes(boxes),
        sourceLabel,
        frameSize: frameSize ?? undefined,
      };
      await saveLayout(layout);

      // Log only what a human actually moved. An accepted proposal is not a
      // correction, and recording it as one would drown the real signal.
      const corrections: LayoutCorrection[] = [];
      for (const { id } of LAYOUT_ELEMENTS) {
        const before = proposed[id] ?? null;
        const after = boxes[id];
        if (!isMeaningfulMove(before, after)) continue;
        corrections.push({
          eventKey,
          season,
          element: id,
          proposed: before,
          corrected: after,
          delta: rectDelta(before, after),
        });
      }
      const logErr = await logCorrections(corrections);

      onSaved?.(layout);
      setStatus(
        `Saved. Every machine scanning ${eventKey} will use this layout.` +
          (corrections.length ? ` ${corrections.length} correction(s) recorded.` : '') +
          (logErr ? ` (Corrections could not be recorded: ${logErr})` : '')
      );
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /* ---------------- render ---------------- */

  const pxRect = useMemo(() => {
    const w = frameSize?.width || 1920;
    const h = frameSize?.height || 1080;
    return {
      x0: Math.round(activeRect.x0 * w),
      y0: Math.round(activeRect.y0 * h),
      x1: Math.round(activeRect.x1 * w),
      y1: Math.round(activeRect.y1 * h),
    };
  }, [activeRect, frameSize]);

  const frameSrc = shots[Math.min(frameIndex, Math.max(0, shots.length - 1))]?.url;
  const groups = [...new Set(LAYOUT_ELEMENTS.map((e) => e.group))];

  return (
    <div className="cal-root">
      <div className="cal-head">
        <div>
          <span className="cal-title">Scoreboard layout</span>
          <span className="cal-sub">
            {eventKey || 'no event selected'}
            {season ? ` · ${season} season` : ''}
            {sourceLabel ? ` · ${sourceLabel}` : ''}
          </span>
        </div>
        <div className="cal-head-right">
          <span className="cal-progress">
            {confirmed.size} of {LAYOUT_ELEMENTS.length} confirmed
          </span>
          <button className="cv-btn-outline" onClick={onClose}>
            Close
          </button>
        </div>
      </div>

      {!eventKey && (
        <div className="cv-notice warn">
          Pick an event first — a layout is saved against its event key, and layouts differ between
          competitions and between seasons.
        </div>
      )}

      <div className="cal-cols">
        {/* elements */}
        <div className="cal-col">
          <span className="cal-col-label">Elements</span>
          <div className="cal-elist">
            {groups.map((g) => (
              <div key={g}>
                <div className="cal-egroup">{g}</div>
                {LAYOUT_ELEMENTS.filter((e) => e.group === g).map((e) => (
                  <button
                    key={e.id}
                    className={`cal-eitem${e.id === active ? ' active' : ''}`}
                    onClick={() => setActive(e.id)}
                  >
                    <i
                      className={`cal-dot ${
                        e.id === active ? 'live' : confirmed.has(e.id) ? 'ok' : 'todo'
                      }`}
                    />
                    <span className="cal-ename">{e.label}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
          <div className="cal-legend">
            <span>
              <i className="cal-dot live" /> Editing
            </span>
            <span>
              <i className="cal-dot ok" /> Confirmed
            </span>
            <span>
              <i className="cal-dot todo" /> Not yet
            </span>
          </div>
        </div>

        {/* stage */}
        <div className="cal-col">
          <span className="cal-col-label">
            Frame {shots.length ? frameIndex + 1 : 0} of {shots.length}
            {shots.length > 1 ? ' · check the box on every one' : ''}
          </span>

          <div className="cal-stage" ref={stageRef} onPointerMove={onMove} onPointerUp={endDrag}>
            {frameSrc ? (
              <img className="cal-frame" src={frameSrc} alt="" draggable={false} />
            ) : (
              <div className="cal-frame cal-frame-empty">
                Load footage, then capture frames to calibrate against.
              </div>
            )}

            {/* the other boxes: visible for context, deliberately not grabbable */}
            {LAYOUT_ELEMENTS.filter((e) => e.id !== active).map((e) => {
              const r = boxes[e.id];
              return (
                <div
                  key={e.id}
                  className={`cal-box ghost ${toneOf(e.id)}${confirmed.has(e.id) ? ' done' : ''}`}
                  style={{
                    left: `${r.x0 * 100}%`,
                    top: `${r.y0 * 100}%`,
                    width: `${(r.x1 - r.x0) * 100}%`,
                    height: `${(r.y1 - r.y0) * 100}%`,
                  }}
                />
              );
            })}

            {/* the one live box */}
            <div
              className={`cal-box live ${toneOf(active)}`}
              style={{
                left: `${activeRect.x0 * 100}%`,
                top: `${activeRect.y0 * 100}%`,
                width: `${(activeRect.x1 - activeRect.x0) * 100}%`,
                height: `${(activeRect.y1 - activeRect.y0) * 100}%`,
              }}
              onPointerDown={onDown('move')}
            >
              <span className="cal-box-tag">
                {LAYOUT_ELEMENTS.find((e) => e.id === active)?.label}
              </span>
              {([0, 1, 2, 3] as Corner[]).map((c) => (
                <span
                  key={c}
                  className={`cal-handle h${c}`}
                  onPointerDown={onDown(c)}
                  onPointerMove={onMove}
                  onPointerUp={endDrag}
                />
              ))}
            </div>

            {/* magnifier — the active box, blown up */}
            {frameSrc && (
              <div className="cal-loupe">
                <div className="cal-loupe-view">
                  <img
                    src={frameSrc}
                    alt=""
                    draggable={false}
                    style={{
                      position: 'absolute',
                      width: `${zoom * 100}%`,
                      left: `${-activeRect.x0 * zoom * 100 + 50 - ((activeRect.x1 - activeRect.x0) * zoom * 100) / 2}%`,
                      top: `${-activeRect.y0 * zoom * 100 + 50 - ((activeRect.y1 - activeRect.y0) * zoom * 100) / 2}%`,
                      maxWidth: 'none',
                    }}
                  />
                  <span
                    className="cal-loupe-frame"
                    style={{
                      width: `${(activeRect.x1 - activeRect.x0) * zoom * 100}%`,
                      height: `${(activeRect.y1 - activeRect.y0) * zoom * 100}%`,
                    }}
                  />
                </div>
                <div className="cal-loupe-cap">
                  <span>{zoom}× magnified</span>
                  <span>
                    {pxRect.x1 - pxRect.x0} × {pxRect.y1 - pxRect.y0} px
                  </span>
                </div>
              </div>
            )}
          </div>

          {onGrabFrameAt && (
            <div className="cal-hunt">
              <span className="cal-col-label">Find the scoreboard</span>
              <p className="cal-hint">
                Most of an event is not a match, so the frames above are often crowd shots, sponsor
                cards or the post-match results screen — none of which show the live overlay. Jump
                to a moment where a match is actually running.
              </p>

              <div className="cal-hunt-row">
                <input
                  className="cv-input cal-stamp"
                  placeholder="Timestamps, e.g. 12:30, 1:04:15"
                  value={stamp}
                  onChange={(e) => setStamp(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void addShots(parseStamps(stamp));
                  }}
                  disabled={grabbing}
                />
                <button
                  className="cv-btn-grad"
                  disabled={grabbing || !parseStamps(stamp).length}
                  onClick={() => void addShots(parseStamps(stamp))}
                >
                  {grabbing ? 'Grabbing…' : 'Grab'}
                </button>
              </div>

              {duration ? (
                <div className="cal-hunt-row">
                  <input
                    className="cal-scrub"
                    type="range"
                    min={0}
                    max={Math.floor(duration)}
                    step={1}
                    value={seekTo}
                    onChange={(e) => setSeekTo(Number(e.target.value))}
                    disabled={grabbing}
                  />
                  <span className="cal-scrub-time">{fmtTime(seekTo)}</span>
                  <button
                    className="cv-btn-outline"
                    disabled={grabbing}
                    onClick={() => void addShots([seekTo])}
                  >
                    Grab here
                  </button>
                </div>
              ) : null}

              {grabNote && <span className="cal-hint">{grabNote}</span>}
            </div>
          )}

          {shots.length > 1 && (
            <div className="cal-strip">
              {shots.map((sh, i) => (
                <button
                  key={i}
                  className={`cal-shot${i === frameIndex ? ' active' : ''}`}
                  onClick={() => setFrameIndex(i)}
                  title={`Frame ${i + 1} · ${fmtTime(sh.at)}`}
                >
                  <img src={sh.url} alt="" draggable={false} />
                  <span
                    className="cal-shot-box"
                    style={{
                      left: `${activeRect.x0 * 100}%`,
                      top: `${activeRect.y0 * 100}%`,
                      width: `${(activeRect.x1 - activeRect.x0) * 100}%`,
                      height: `${(activeRect.y1 - activeRect.y0) * 100}%`,
                    }}
                  />
                  <span className="cal-shot-time">{fmtTime(sh.at)}</span>
                  {/* Clearing out the frames with no scoreboard is most of the
                      value here — a strip of crowd shots is worse than useless,
                      because "check every frame" then means checking noise. */}
                  <span
                    className="cal-shot-drop"
                    role="button"
                    tabIndex={0}
                    title="Remove this frame"
                    onClick={(e) => {
                      e.stopPropagation();
                      dropShot(i);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.stopPropagation();
                        dropShot(i);
                      }
                    }}
                  >
                    ×
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* inspector */}
        <div className="cal-col">
          <span className="cal-col-label">
            {LAYOUT_ELEMENTS.find((e) => e.id === active)?.label}
          </span>

          <div className="cal-field">
            <span className="cal-field-label">Box, in pixels</span>
            <div className="cal-coords">
              <span className="cal-coord">
                <b>left</b> {pxRect.x0}
              </span>
              <span className="cal-coord">
                <b>top</b> {pxRect.y0}
              </span>
              <span className="cal-coord">
                <b>right</b> {pxRect.x1}
              </span>
              <span className="cal-coord">
                <b>bottom</b> {pxRect.y1}
              </span>
            </div>
          </div>

          <div className="cal-field">
            <span className="cal-field-label">Zoom</span>
            <div className="cal-btnrow">
              {[2, 4, 8].map((z) => (
                <button
                  key={z}
                  className={z === zoom ? 'cv-btn-grad' : 'cv-btn-outline'}
                  onClick={() => setZoom(z)}
                >
                  {z}×
                </button>
              ))}
            </div>
          </div>

          <p className="cal-hint">
            Drag the box or its corners. Arrow keys move it one pixel; hold <kbd>Shift</kbd> to move
            just the nearest edge, or <kbd>Alt</kbd> to move five pixels at a time.
          </p>

          <div className="cal-btnrow">
            <button className="cv-btn-grad" onClick={confirmActive}>
              Confirm &amp; next
            </button>
            <button
              className="cv-btn-outline"
              onClick={() => {
                const p = proposed[active];
                if (p) setBoxes((b) => ({ ...b, [active]: p }));
              }}
              disabled={!proposed[active]}
            >
              Reset
            </button>
          </div>

          <div className="cal-save">
            {!confirmingSave ? (
              <button
                className="cv-btn-grad"
                disabled={busy || !eventKey || !loaded}
                onClick={() => setConfirmingSave(true)}
              >
                Save layout
              </button>
            ) : (
              <div className="cal-confirm">
                <p className="cal-confirm-text">
                  Save this layout for <strong>{eventKey}</strong>?
                  {confirmed.size < LAYOUT_ELEMENTS.length && (
                    <>
                      {' '}
                      {LAYOUT_ELEMENTS.length - confirmed.size} element(s) are still unconfirmed and
                      will save wherever their box currently sits.
                    </>
                  )}
                </p>
                <div className="cal-btnrow">
                  <button className="cv-btn-grad" disabled={busy} onClick={save}>
                    {busy ? 'Saving…' : `Yes, save to ${eventKey}`}
                  </button>
                  <button
                    className="cv-btn-outline"
                    disabled={busy}
                    onClick={() => setConfirmingSave(false)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            <span className="cal-hint">
              Stored against <strong>{eventKey || '—'}</strong> so any machine scanning this event
              picks it up. Double-check that is the event you actually calibrated — the boxes are
              saved against whichever event is selected in the app, not against the video itself.
            </span>
          </div>

          {status && <div className="cv-notice info">{status}</div>}
        </div>
      </div>
    </div>
  );
}
