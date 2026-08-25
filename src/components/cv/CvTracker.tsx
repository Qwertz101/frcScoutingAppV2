import { useEffect, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { AUTO_LEN, CvScoreSample, MATCH_LEN } from '../../types';
import { downloadCvLog, parseCvJson } from '../../services/bpsStore';
import { GrayPlane, Quad } from '../../services/cv/imagePipeline';
import { grayToImageData } from '../../services/cv/browserCanvas';
import { isStreamLink, useCvTracker } from './useCvTracker';
import { WORKER_DASHBOARD_URL } from '../../services/cv/captureWorker';
import '../../styles/cvtracker.css';

const BoltMark = () => (
  <svg className="cv-bolt" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <defs>
      <linearGradient id="cv-bolt-grad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stopColor="#00baff" />
        <stop offset="100%" stopColor="#1179ee" />
      </linearGradient>
    </defs>
    <path d="M13.5 2 4 13.5h6L9.5 22 20 10h-6.5z" fill="url(#cv-bolt-grad)" />
  </svg>
);

/** Renders a binarized crop so the operator can see exactly what OCR reads. */
function CropPreview({ plane, label }: { plane: GrayPlane | null; label: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const c = ref.current;
    if (!c || !plane) return;
    c.width = plane.width;
    c.height = plane.height;
    c.getContext('2d')?.putImageData(grayToImageData(plane), 0, 0);
  }, [plane]);

  return (
    <div className="cv-preview">
      <span>{label}</span>
      {plane ? <canvas ref={ref} /> : <span style={{ opacity: 0.5 }}>no digits found</span>}
    </div>
  );
}

interface QuadSpec {
  quad: Quad;
  onChange: (q: Quad) => void;
  /** Which region this is — drives the stroke colour. */
  tone: 'blue' | 'red' | 'timer';
  label: string;
}

/**
 * The draggable corners of all three score regions, in one shared overlay.
 *
 * These used to be three independent overlays stacked directly on top of one
 * another (one per region, each covering the whole video). That made corner
 * dragging flaky wherever two regions' edges meet — the blue/timer and
 * timer/red boundaries — because the browser's hit-test just returns
 * whichever element is topmost in paint order at that pixel, which is a fact
 * about DOM order, not about which corner the operator's cursor is actually
 * nearest to. The timer region, rendered last, silently won every such
 * conflict; a drag aimed at blue's or red's inner corner would move the timer
 * plate instead, with no visual cue for why "nothing happened" to the box
 * being watched.
 *
 * The fix is to hit-test in application space instead of relying on the DOM:
 * on pointerdown, find the single closest handle across all three quads (in
 * real pixels, since the box need not be square) and drag that one,
 * regardless of which element the browser happened to report as the target.
 */
function QuadOverlay({ quads }: { quads: QuadSpec[] }) {
  const drag = useRef<{ quadIndex: number; pointIndex: number } | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const toLocal = (e: React.PointerEvent) => {
    const box = boxRef.current?.getBoundingClientRect();
    if (!box || !box.width || !box.height) return null;
    return {
      x: Math.min(Math.max((e.clientX - box.left) / box.width, 0), 1),
      y: Math.min(Math.max((e.clientY - box.top) / box.height, 0), 1),
      box,
    };
  };

  const move = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const local = toLocal(e);
    if (!local) return;
    const { quadIndex, pointIndex } = drag.current;
    const spec = quads[quadIndex];
    const next = spec.quad.map((p, i) =>
      i === pointIndex ? { x: local.x, y: local.y } : p
    ) as Quad;
    spec.onChange(next);
  };

  const onHandleDown = (e: React.PointerEvent) => {
    const local = toLocal(e);
    if (!local) return;
    const { box } = local;
    const candidates: { quadIndex: number; pointIndex: number; d: number }[] = [];
    quads.forEach((spec, qi) => {
      spec.quad.forEach((p, pi) => {
        const dx = (p.x - local.x) * box.width;
        const dy = (p.y - local.y) * box.height;
        candidates.push({ quadIndex: qi, pointIndex: pi, d: dx * dx + dy * dy });
      });
    });
    const best = candidates.reduce((a, b) => (b.d < a.d ? b : a));
    drag.current = { quadIndex: best.quadIndex, pointIndex: best.pointIndex };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onHandleUp = (e: React.PointerEvent) => {
    drag.current = null;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  };

  return (
    <div
      ref={boxRef}
      className="cv-overlay"
      onPointerMove={move}
      onPointerUp={() => {
        drag.current = null;
      }}
      style={{ pointerEvents: drag.current === null ? 'none' : 'auto' }}
    >
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
      >
        {quads.map((spec) => (
          <polygon
            key={spec.tone}
            className={`cv-quad ${spec.tone}`}
            points={spec.quad.map((p) => `${p.x * 100},${p.y * 100}`).join(' ')}
          />
        ))}
      </svg>

      {quads.map((spec) => (
        <span
          key={spec.tone}
          className={`cv-quad-tag ${spec.tone}`}
          style={{
            left: `${Math.min(...spec.quad.map((p) => p.x)) * 100}%`,
            top: `${Math.min(...spec.quad.map((p) => p.y)) * 100}%`,
          }}
        >
          {spec.label}
        </span>
      ))}

      {quads.map((spec) =>
        spec.quad.map((p, i) => (
          <div
            key={`${spec.tone}-${i}`}
            className={`cv-handle ${spec.tone}`}
            style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
            onPointerDown={onHandleDown}
            onPointerMove={move}
            onPointerUp={onHandleUp}
          />
        ))
      )}
    </div>
  );
}

/** The score-over-time plot. */
function ScorePlot({ samples }: { samples: CvScoreSample[] }) {
  const peak = Math.max(30, ...samples.map((s) => Math.max(s.blue, s.red)));
  const px = (sec: number) => (sec / MATCH_LEN) * 300;
  const py = (v: number) => 150 - (v / peak) * 140;
  const line = (pick: (s: CvScoreSample) => number) =>
    samples.map((s) => `${px(s.sec).toFixed(1)},${py(pick(s)).toFixed(1)}`).join(' ');

  return (
    <div className="cv-plot">
      <svg viewBox="0 0 300 150" preserveAspectRatio="none">
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1="0" x2="300" y1={150 * f} y2={150 * f} stroke="#e3edf1" strokeWidth="1" />
        ))}
        <line
          x1={(AUTO_LEN / MATCH_LEN) * 300}
          x2={(AUTO_LEN / MATCH_LEN) * 300}
          y1="0"
          y2="150"
          stroke="#33becc"
          strokeWidth="1.5"
          strokeDasharray="4 3"
        />
        {samples.length > 1 && (
          <>
            <polyline
              points={line((s) => s.blue)}
              stroke="#1179ee"
              strokeWidth="2.5"
              fill="none"
              vectorEffect="non-scaling-stroke"
            />
            <polyline
              points={line((s) => s.red)}
              stroke="#c2323b"
              strokeWidth="2.5"
              fill="none"
              vectorEffect="non-scaling-stroke"
            />
          </>
        )}
      </svg>
    </div>
  );
}

/**
 * What the capture worker is doing right now.
 *
 * Deliberately shows the worker's own log lines rather than a summarised
 * status. A capture takes minutes and most of that is one long scan; a
 * spinner would be indistinguishable from a hang, and the thing an operator
 * actually wants to know — "has it found any matches yet" — is right there in
 * the log.
 */
function CaptureWorkerPanel({ t }: { t: ReturnType<typeof useCvTracker> }) {
  const w = t.worker;
  const logRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    // Follow the tail only when already at it, so scrolling back to read
    // something is not undone by the next poll.
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 60) el.scrollTop = el.scrollHeight;
  }, [w?.logLines.length]);

  if (!w) return null;

  const job = w.job;
  const running = job?.status === 'running' || job?.status === 'cancelling';
  const span = job?.progress ? job.progress.to - job.progress.from : 0;
  const pct =
    job?.progress && span > 0
      ? Math.min(100, Math.round(((job.progress.at - job.progress.from) / span) * 100))
      : null;

  return (
    <div className="cv-card cv-worker">
      <div className="cv-card-head">
        <span className="cv-card-title">Capture Worker</span>
        <span className="cv-card-note">
          <a href={WORKER_DASHBOARD_URL} target="_blank" rel="noreferrer">
            full dashboard ↗
          </a>
        </span>
      </div>

      <div className="cv-worker-row">
        <span className={`cv-pill${running ? ' recording' : ''}`}>
          {job ? job.status : 'idle'}
        </span>
        <span className="cv-worker-label">{job ? job.url : 'waiting for a link'}</span>
        {job && (
          <span className="cv-worker-meta">
            {job.mode === 'live' ? 'live' : 'recording'} · {job.matches} match
            {job.matches === 1 ? '' : 'es'}
            {pct !== null && running ? ` · scanned ${pct}%` : ''}
            {job.write ? '' : ' · dry run'}
          </span>
        )}
        <div className="cv-controls-spacer" />
        {/* Writing can only be declined here, never granted: the worker
            decides whether it is allowed to write at all when it starts. */}
        <label className="cv-worker-check" title={
          w.allowWrite
            ? 'Uncheck to read the footage without saving anything'
            : 'This worker was started without --write, so every capture is a dry run'
        }>
          <input
            type="checkbox"
            checked={w.allowWrite && t.workerWrite}
            disabled={!w.allowWrite || running}
            onChange={(e) => t.setWorkerWrite(e.target.checked)}
          />
          Save to database
        </label>
        {running && (
          <button className="cv-btn-outline" disabled={t.workerBusy} onClick={t.cancelWorker}>
            Cancel
          </button>
        )}
      </div>

      {job?.error && <div className="cv-notice warn">{job.error}</div>}

      {w.unmigrated && (
        <div className="cv-notice warn">
          The database is missing the capture-worker columns, so quality and flags cannot be
          saved. Run the <code>alter table</code> statements at the top of{' '}
          <code>supabase/schema-bps.sql</code>.
        </div>
      )}

      {w.rows.length > 0 && (
        <div className="cv-worker-results">
          {w.rows.map((r, i) => (
            <div key={(r.match_key || 'row') + i} className="cv-worker-result">
              <span className="cv-worker-match">{r.match_key || 'unidentified'}</span>
              <span className="cv-worker-score">
                {r.final ? `${r.final.blue}–${r.final.red}` : '—'}
              </span>
              <span className={`cv-worker-q${r.flagged ? ' flagged' : ''}`}>
                {r.quality ? r.quality.score.toFixed(2) : '—'}
                {r.flagged ? ' flagged' : ''}
              </span>
              <span className="cv-worker-write">{r.write ?? ''}</span>
            </div>
          ))}
        </div>
      )}

      {w.logLines.length > 0 && (
        <pre className="cv-worker-log" ref={logRef}>
          {w.logLines.join('\n')}
        </pre>
      )}
    </div>
  );
}

interface CvTrackerProps {
  onBack: () => void;
}

export function CvTracker({ onBack }: CvTrackerProps) {
  const t = useCvTracker();
  const [importMsg, setImportMsg] = useState<string | null>(null);

  const jobRunning =
    t.worker?.job?.status === 'running' || t.worker?.job?.status === 'cancelling';
  const activeLabel = t.matches.find((m) => m.key === t.activeMatch)?.label ?? '—';
  const done = t.uploaded.size;
  const total = t.matches.length;
  // Newest-first, full match — the container scrolls (see .cv-log in
  // cvtracker.css), so nothing needs to be clipped to stay usable.
  const rows = [...t.samples].reverse();

  const onImport = async (file: File) => {
    try {
      const log = parseCvJson(await file.text(), t.eventKey);
      t.importLog(log);
      setImportMsg(`Imported ${log.samples.length} samples for ${log.matchKey}.`);
    } catch (e: any) {
      setImportMsg(`Could not import ${file.name}: ${e?.message || e}`);
    }
  };

  return (
    <div className="cv-root">
      <header className="cv-header">
        <button className="cv-back" onClick={onBack}>
          <ArrowLeft size={14} /> Back
        </button>

        <div className="cv-brand">
          <BoltMark />
          <div className="cv-brand-text">
            <span className="cv-brand-name">SCOUT 6560</span>
            <span className="cv-brand-sub">CV Scoreboard Tracker</span>
          </div>
        </div>

        <div className="cv-header-spacer" />

        <span className="cv-header-meta">
          {(t.eventKey || 'no event').toUpperCase()} · {activeLabel}
        </span>
        <span className={`cv-pill${t.running ? ' recording' : ''}`}>
          {t.running ? 'Recording' : 'Stopped'}
        </span>
      </header>

      <section className="cv-page">
        <div className="cv-card">
          <div className="cv-source">
            <span className="cv-source-label">Footage Source</span>
            <input
              className="cv-input"
              placeholder="Paste a YouTube VOD or livestream link — the capture worker reads it"
              value={t.urlInput}
              onChange={(e) => t.setUrlInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') t.loadUrl();
              }}
            />
            {/* Recording vs live is asked, not guessed: a YouTube /watch?v= URL
                looks identical either way, and the two take genuinely different
                paths through the worker (seekable two-tier scan vs. forward-only
                monitor). Getting it wrong is recoverable but wastes a run. */}
            <button
              className="cv-btn-grad"
              disabled={!isStreamLink(t.urlInput) || t.workerBusy || jobRunning}
              onClick={() => t.submitToWorker('vod')}
            >
              Read Recording
            </button>
            <button
              className="cv-btn-outline"
              disabled={!isStreamLink(t.urlInput) || t.workerBusy || jobRunning}
              onClick={() => t.submitToWorker('live')}
            >
              Watch Live
            </button>
            <label className="cv-btn-outline cv-file-btn">
              Upload File
              <input
                type="file"
                accept="video/*"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) t.loadFile(f);
                  e.target.value = '';
                }}
              />
            </label>
            <button className="cv-btn-outline" onClick={t.shareScreen}>
              Share Screen
            </button>
            {/* No playback-speed control any more: recorded footage is seeked
                to each target second rather than played at it, so it is read as
                fast as OCR allows and a slow pass costs wall time instead of
                bending the timeline. */}
            <label className="cv-btn-outline cv-file-btn">
              Import JSON
              <input
                type="file"
                accept="application/json,.json"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onImport(f);
                  e.target.value = '';
                }}
              />
            </label>
          </div>
        </div>

        {t.error && <div className="cv-notice warn">{t.error}</div>}
        {importMsg && <div className="cv-notice info">{importMsg}</div>}

        <CaptureWorkerPanel t={t} />

        {!t.error && t.sourceKind === 'none' && !t.worker && (
          <div className="cv-notice info">
            A stream link needs the capture worker running on this machine — start it with{' '}
            <code>npm run worker:serve</code>. Without it you can still{' '}
            <strong>Upload File</strong>, paste a direct video URL served with permissive CORS, or
            use <strong>Share Screen</strong> and pick the tab playing the stream.
          </div>
        )}

        <div className="cv-grid">
          <div className="cv-col">
            <div className="cv-card">
              <div className="cv-card-head">
                <span className="cv-card-title">Score Regions — One Quad Per Alliance</span>
                <span className="cv-card-note">{t.sourceLabel}</span>
              </div>

              <div className="cv-stage">
                <video ref={t.videoRef} playsInline muted controls={t.sourceKind !== 'screen'} />
                {t.sourceKind === 'none' && (
                  <div className="cv-stage-empty">
                    No footage loaded.
                    <br />
                    Upload a file, paste a direct video URL, or share your screen.
                  </div>
                )}
                <QuadOverlay
                  quads={[
                    { quad: t.blueQuad, onChange: t.setBlueQuad, tone: 'blue', label: 'Blue' },
                    { quad: t.redQuad, onChange: t.setRedQuad, tone: 'red', label: 'Red' },
                    // The clock plate is a first-class region: it is what
                    // stamps every sample with a real match time, so a
                    // mis-dragged box here costs the whole log its alignment.
                    { quad: t.timerQuad, onChange: t.setTimerQuad, tone: 'timer', label: 'Timer' },
                  ]}
                />
              </div>

              <div className="cv-controls">
                <button
                  className={t.running ? 'cv-btn-dark' : 'cv-btn-grad'}
                  onClick={t.running ? t.stop : t.start}
                >
                  {t.running ? 'Stop' : 'Start'}
                </button>
                <button className="cv-btn-outline" onClick={t.reset}>
                  Reset
                </button>
                <button className="cv-btn-outline" onClick={t.autoDetect}>
                  Auto-detect Regions
                </button>
                <button className="cv-btn-outline" onClick={t.resetQuad}>
                  Reset Quad
                </button>
                <div className="cv-controls-spacer" />
                {/* The plate as read, next to the match time derived from it. */}
                <span className="cv-clock">{t.timerText || t.clock}</span>
                {/* Saving is deliberate: nothing writes to the server until this
                    is clicked, so the operator can review/correct the log first. */}
                <button className="cv-btn-outline" disabled={!t.samples.length} onClick={t.persist}>
                  Save
                </button>
                <button
                  className="cv-btn-grad"
                  disabled={!t.samples.length}
                  onClick={() => {
                    t.persist();
                    downloadCvLog(t.buildLog());
                  }}
                >
                  Export JSON
                </button>
              </div>

              {/* Wrongly-timed data is worse than no data, so the fallback is
                  never silent: if the clock could not be read, the log's
                  alignment is only as good as the operator's Start press. */}
              {t.timerFallback && (
                <div className="cv-notice warn">
                  The match timer could not be read, so times are being counted from when you
                  pressed Start rather than taken from the scoreboard. Drag the <strong>Timer</strong>{' '}
                  box onto the clock and re-record, or expect this log to be offset.
                </div>
              )}

              <div className="cv-tune">
                <span>{t.status}</span>
                {t.clockStarted && !t.timerFallback && (
                  <span>
                    clock locked · {t.phase} · {t.timerReads.ok}/{t.timerReads.tried} clock ticks
                    accepted
                  </span>
                )}
                {t.rejections > 0 && <span>{t.rejections} reads rejected</span>}
                {/* Kept separate from rejections on purpose: a replay or crowd cut
                    means the pipeline was never asked to read anything, so
                    counting it as a failure would make a healthy run look broken. */}
                {t.skipped > 0 && <span>{t.skipped} frames with no scoreboard</span>}
                <span>{t.dirty ? 'unsaved' : t.samples.length ? 'saved' : ''}</span>
              </div>

              <div className="cv-previews">
                <CropPreview plane={t.previews.blue} label="Blue score as OCR sees it" />
                <CropPreview plane={t.previews.red} label="Red score as OCR sees it" />
                <CropPreview plane={t.previews.timer} label="Match timer as OCR sees it" />
              </div>
            </div>

            <div className="cv-card">
              <div className="cv-card-head">
                <span className="cv-card-title">Alliance Score Over Time</span>
                <span className="cv-card-note">
                  Blue {t.blue} · Red {t.red}
                </span>
              </div>
              <ScorePlot samples={t.samples} />
              <div className="cv-legend">
                <span>
                  <i className="cv-swatch" style={{ background: '#1179ee' }} /> Blue alliance
                </span>
                <span>
                  <i className="cv-swatch" style={{ background: '#c2323b' }} /> Red alliance
                </span>
                <span>
                  <i className="cv-swatch" style={{ background: '#33becc' }} /> End of auto
                </span>
              </div>
            </div>
          </div>

          <div className="cv-col">
            <div className="cv-card">
              <div className="cv-card-head">
                <span className="cv-card-title">Scoreboard Upload Log</span>
                <span className="cv-card-note" style={{ color: '#1179ee' }}>
                  {done} / {total} uploaded
                </span>
              </div>

              <div className="cv-progress">
                <div
                  className="cv-progress-fill"
                  style={{ width: total ? `${(done / total) * 100}%` : '0%' }}
                />
              </div>

              <div className="cv-chips">
                {t.matches.map((m) => (
                  <button
                    key={m.key}
                    className={`cv-chip${
                      m.key === t.activeMatch
                        ? ' active'
                        : t.autoFlagged.has(m.key)
                          ? ' auto-flagged'
                          : t.autoClean.has(m.key)
                            ? ' auto-clean'
                            : t.uploaded.has(m.key)
                              ? ' uploaded'
                              : ''
                    }`}
                    title={
                      t.autoFlagged.has(m.key)
                        ? 'Written automatically, flagged for review'
                        : t.autoClean.has(m.key)
                          ? 'Written automatically'
                          : t.uploaded.has(m.key)
                            ? 'Reviewed by hand'
                            : undefined
                    }
                    onClick={() => t.setActiveMatch(m.key)}
                  >
                    {m.label}
                  </button>
                ))}
                {!t.matches.length && (
                  <span className="cv-empty">
                    No qualification matches imported yet — load the schedule from Select Matches.
                  </span>
                )}
              </div>

              <div className="cv-chip-legend">
                <span>
                  <i className="cv-dot" style={{ background: '#00baff' }} /> Active
                </span>
                <span>
                  <i className="cv-dot" style={{ background: '#1179ee' }} /> Reviewed
                </span>
                <span>
                  <i className="cv-dot" style={{ background: '#22c55e' }} /> Auto
                </span>
                <span>
                  <i className="cv-dot" style={{ background: '#f59e0b' }} /> Needs review
                </span>
                <span>
                  <i className="cv-dot" style={{ background: '#fff', border: '1.5px solid #d9d9d9' }} />{' '}
                  Remaining
                </span>
              </div>
            </div>

            {t.reviewQueue.length > 0 && (
              <div className="cv-card">
                <div className="cv-card-head">
                  <span className="cv-card-title">Needs Review</span>
                  <span className="cv-card-note" style={{ color: '#f59e0b' }}>
                    {t.reviewQueue.length} flagged
                  </span>
                </div>
                {/*
                  Deliberately clicks into the existing editor rather than being a
                  second review tool: selecting the match is all this does, and the
                  correction UI below is the one the operator already knows.
                */}
                <div className="cv-review-queue">
                  {t.reviewQueue.map((r) => (
                    <button
                      key={r.matchKey}
                      className={`cv-review-row${r.matchKey === t.activeMatch ? ' active' : ''}`}
                      onClick={() => t.setActiveMatch(r.matchKey)}
                    >
                      <span className="cv-review-match">{r.label}</span>
                      <span className="cv-review-score">
                        {r.score === null ? '—' : r.score.toFixed(2)}
                      </span>
                      <span className="cv-review-why">
                        {r.reasons[0] ?? 'flagged by the capture worker'}
                        {r.reasons.length > 1 ? ` (+${r.reasons.length - 1} more)` : ''}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="cv-card">
              <div className="cv-card-head">
                <span className="cv-card-title">Per-Second Log</span>
                <span className="cv-card-note">{t.samples.length} rows</span>
              </div>

              <div className="cv-log">
                <div className="cv-log-head">
                  <span>Sec</span>
                  <span>Phase</span>
                  <span>Blue</span>
                  <span>Red</span>
                  <span>ΔB</span>
                  <span>ΔR</span>
                </div>

                {rows.map((s, i) => (
                  <div key={s.sec} className={`cv-log-row${i % 2 ? ' alt' : ''}`}>
                    <span>{s.sec}</span>
                    <span className={`cv-phase${s.phase === 'auto' ? ' auto' : ''}`}>{s.phase}</span>
                    <input
                      className="cv-cell"
                      type="number"
                      min={0}
                      value={s.blue}
                      onChange={(e) => t.correct(s.sec, 'blue', Number(e.target.value))}
                    />
                    <input
                      className="cv-cell"
                      type="number"
                      min={0}
                      value={s.red}
                      onChange={(e) => t.correct(s.sec, 'red', Number(e.target.value))}
                    />
                    <span className={`cv-delta${s.db ? ' blue' : ' zero'}`}>
                      {s.db ? `+${s.db}` : '—'}
                    </span>
                    <span className={`cv-delta${s.dr ? ' red' : ' zero'}`}>
                      {s.dr ? `+${s.dr}` : '—'}
                    </span>
                  </div>
                ))}

                {!t.samples.length && (
                  <div className="cv-empty">
                    Nothing logged yet. Load footage, press Auto-detect Regions (or drag the blue and
                    red boxes onto the two score numbers), then press Start.
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
