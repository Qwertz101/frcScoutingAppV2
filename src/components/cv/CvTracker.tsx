import { useEffect, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { AUTO_LEN, CvScoreSample, MATCH_LEN } from '../../types';
import { downloadCvLog, parseCvJson } from '../../services/bpsStore';
import { GrayPlane, Quad, grayToImageData } from '../../services/cv/imagePipeline';
import { useCvTracker } from './useCvTracker';
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

interface QuadEditorProps {
  quad: Quad;
  onChange: (q: Quad) => void;
}

/**
 * The four draggable corners.
 *
 * Pointer events rather than mouse events, and capture on the handle, so a drag
 * keeps tracking when the finger or cursor leaves the box — which it will, since
 * the corners live on the edges.
 */
function QuadHandles({ quad, onChange }: QuadEditorProps) {
  const drag = useRef<number | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const move = (e: React.PointerEvent) => {
    if (drag.current === null) return;
    const box = boxRef.current?.getBoundingClientRect();
    if (!box || !box.width || !box.height) return;

    const x = Math.min(Math.max((e.clientX - box.left) / box.width, 0), 1);
    const y = Math.min(Math.max((e.clientY - box.top) / box.height, 0), 1);

    const next = quad.map((p, i) => (i === drag.current ? { x, y } : p)) as Quad;
    onChange(next);
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
        <polygon className="cv-quad" points={quad.map((p) => `${p.x * 100},${p.y * 100}`).join(' ')} />
      </svg>

      {quad.map((p, i) => (
        <div
          key={i}
          className="cv-handle"
          style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
          onPointerDown={(e) => {
            drag.current = i;
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            e.preventDefault();
          }}
          onPointerMove={move}
          onPointerUp={(e) => {
            drag.current = null;
            (e.target as HTMLElement).releasePointerCapture(e.pointerId);
          }}
        />
      ))}
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

interface CvTrackerProps {
  onBack: () => void;
}

export function CvTracker({ onBack }: CvTrackerProps) {
  const t = useCvTracker();
  const [importMsg, setImportMsg] = useState<string | null>(null);

  const activeLabel = t.matches.find((m) => m.key === t.activeMatch)?.label ?? '—';
  const done = t.uploaded.size;
  const total = t.matches.length;
  const rows = [...t.samples].reverse().slice(0, 60);

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
              placeholder="Paste YouTube / Twitch / recorded match URL"
              value={t.urlInput}
              onChange={(e) => t.setUrlInput(e.target.value)}
            />
            <button className="cv-btn-grad" onClick={t.loadUrl}>
              Load Video
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
            <select
              className="cv-select"
              value={t.speed}
              onChange={(e) => t.setSpeed(Number(e.target.value))}
              disabled={t.sourceKind === 'screen'}
            >
              <option value={1}>1.0×</option>
              <option value={3}>3.0×</option>
              <option value={5}>5.0×</option>
            </select>
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
        {!t.error && t.sourceKind === 'none' && (
          <div className="cv-notice info">
            YouTube and Twitch embeds cannot be read pixel-by-pixel — the browser blocks canvas
            access to cross-origin video. Upload a downloaded match file, paste a direct video URL
            served with permissive CORS, or use <strong>Share Screen</strong> and pick the tab
            playing the stream.
          </div>
        )}

        <div className="cv-grid">
          <div className="cv-col">
            <div className="cv-card">
              <div className="cv-card-head">
                <span className="cv-card-title">Scoreboard Region — 4-Point Quad</span>
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
                <QuadHandles quad={t.quad} onChange={t.setQuad} />
                <span className="cv-region-tag">Scoreboard Region</span>
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
                <button className="cv-btn-outline" onClick={t.resetQuad}>
                  Reset Quad
                </button>
                <div className="cv-controls-spacer" />
                <span className="cv-clock">{t.clock}</span>
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

              <div className="cv-tune">
                <label>
                  Split
                  <input
                    type="range"
                    min={20}
                    max={80}
                    value={Math.round(t.layout.split * 100)}
                    onChange={(e) =>
                      t.setLayout({ ...t.layout, split: Number(e.target.value) / 100 })
                    }
                  />
                  {Math.round(t.layout.split * 100)}%
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={t.layout.swapped}
                    onChange={(e) => t.setLayout({ ...t.layout, swapped: e.target.checked })}
                  />
                  Red on the left
                </label>
                <span>
                  {t.status}
                  {t.rejections > 0 && ` · ${t.rejections} reads rejected`}
                </span>
                <span>{t.dirty ? 'unsaved' : t.samples.length ? 'saved' : ''}</span>
              </div>

              <div className="cv-previews">
                <CropPreview plane={t.previews.blue} label="Blue crop as OCR sees it" />
                <CropPreview plane={t.previews.red} label="Red crop as OCR sees it" />
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
                        : t.uploaded.has(m.key)
                          ? ' uploaded'
                          : ''
                    }`}
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
                  <i className="cv-dot" style={{ background: '#1179ee' }} /> Uploaded
                </span>
                <span>
                  <i className="cv-dot" style={{ background: '#fff', border: '1.5px solid #d9d9d9' }} />{' '}
                  Remaining
                </span>
              </div>
            </div>

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
                    Nothing logged yet. Load footage, drag the quad over the scoreboard, then press
                    Start.
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
