import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionKind,
  ActionSegment,
  AUTO_LEN,
  AUTO_TELEOP_DELAY,
  ClimbResult,
  DataConfidence,
  MATCH_LEN,
  Match,
  TELEOP_LEN,
  TimelineScoutingData,
  User,
} from '../types';
import { readableMatchLabel } from '../utils/match';
import { findTimeline, saveTimeline } from '../services/bpsStore';
import { actionTotals } from '../services/bps';
import { BoltMark } from './cc/CCChrome';
import '../styles/cc.css';
import '../styles/livematch.css';

/**
 * Stream 1 of the time-windowed BPS methodology: one scout watches one robot
 * and holds the button matching what it is doing right now. Every press is
 * time-stamped, producing a per-robot action timeline that the solver later
 * fuses with the CV scoreboard log.
 *
 * Four phases live in this one screen — pre-match, live tracking, confidence,
 * and the export summary — because a scout in the stands should never have
 * to navigate anywhere mid-match.
 *
 * There used to be a fifth phase asking whether the robot climbed. It is
 * gone: TBA's published score breakdown names which robot occupied the auto
 * and endgame tower slots, which is ground truth rather than a scout's
 * estimate, so the app imports it instead of asking — see
 * `services/tbaApi.fetchEventClimbData` and `utils/teamMetrics.ts`.
 */

interface LiveMatchProps {
  match: Match;
  user: User;
  onBack: () => void;
  onSubmit: () => void;
  /** A previously scouted record, passed through by App/MatchList. */
  existing?: any;
}

type Phase = 'pre' | 'live' | 'confidence' | 'summary';

interface ActionMeta {
  kind: ActionKind;
  label: string;
  color: string;
  /** OOF reads as a neutral state, so its idle text is muted rather than grey-on-white. */
  idleText?: string;
}

const ACTIONS: ActionMeta[] = [
  { kind: 'shoot', label: 'SHOOTING', color: '#00baff' },
  { kind: 'pass', label: 'PASSING', color: '#1179ee' },
  { kind: 'def', label: 'CONTACT\nDEFENSE', color: '#33becc' },
  { kind: 'oof', label: 'OOF', color: '#d9d9d9', idleText: '#5b6b73' },
];

const META: Record<ActionKind, ActionMeta> = ACTIONS.reduce((acc, a) => {
  acc[a.kind] = a;
  return acc;
}, {} as Record<ActionKind, ActionMeta>);

/**
 * 2026 REBUILT shift boundaries — first entry whose `until` exceeds elapsed.
 * AUTO 0:20; a 3s SCORING DELAY; then TELEOP's 2:20 splits into a 10s
 * TRANSITION SHIFT, four 25s SHIFTS, and a 30s END GAME (manual, Table 6-2).
 */
const SEGMENTS: Array<{ until: number; label: string }> = [
  { until: AUTO_LEN, label: 'AUTO' },
  { until: AUTO_LEN + AUTO_TELEOP_DELAY, label: 'SCORING DELAY' },
  { until: AUTO_LEN + AUTO_TELEOP_DELAY + 10, label: 'TRANSITION SHIFT' },
  { until: AUTO_LEN + AUTO_TELEOP_DELAY + 35, label: 'SHIFT 1' },
  { until: AUTO_LEN + AUTO_TELEOP_DELAY + 60, label: 'SHIFT 2' },
  { until: AUTO_LEN + AUTO_TELEOP_DELAY + 85, label: 'SHIFT 3' },
  { until: AUTO_LEN + AUTO_TELEOP_DELAY + 110, label: 'SHIFT 4' },
  { until: MATCH_LEN, label: 'END GAME' },
];

/** Anything this short is a finger bouncing between buttons, not an action. */
const MIN_SEGMENT = 0.15;

const IDLE_TEXT = '#5e8f96';
const IDLE_BORDER = '#39494c';

function fmt(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function segmentLabel(elapsed: number): string {
  return (SEGMENTS.find((s) => s.until > elapsed) ?? SEGMENTS[SEGMENTS.length - 1]).label;
}

export function LiveMatch({ match, user, onBack, onSubmit, existing }: LiveMatchProps) {
  // The robot this scout is assigned: their seat in their alliance's line-up.
  // Same derivation the old ScoutingForm used, so assignments do not shift.
  const teamKey = match.alliances[user.alliance].team_keys[user.position - 1] || '';
  const teamNumber = teamKey.replace('frc', '') || '—';
  const matchLabel = readableMatchLabel(match);
  const shortMatch = matchLabel.replace('Qualification', 'Q').replace(/\s+/g, '');

  const [phase, setPhase] = useState<Phase>('pre');
  const [elapsed, setElapsed] = useState(0);
  const [segments, setSegments] = useState<ActionSegment[]>([]);
  const [active, setActive] = useState<ActionKind | null>(null);
  // No longer collected from the scout — TBA's score breakdown supplies real
  // climb points instead (see the module doc above). Kept as a fixed value
  // only because TimelineScoutingData.climb is still part of the record shape.
  const climb: ClimbResult = 'none';
  const [confidence, setConfidence] = useState<DataConfidence>('high');
  const [endedEarly, setEndedEarly] = useState(false);
  const [saved, setSaved] = useState<TimelineScoutingData | null>(null);

  const startedAt = useRef(0);
  const openAt = useRef<number | null>(null);
  const openKind = useRef<ActionKind | null>(null);

  /**
   * Seconds since the match started, at this instant — plain wall-clock time,
   * uncorrected. `MATCH_LEN` already includes `AUTO_TELEOP_DELAY`, so this
   * needs no pausing or compression: it is true elapsed time by
   * construction, on the same timeline the CV stream computes (see
   * `AUTO_TELEOP_DELAY`'s doc in `types/index.ts`). What the delay actually
   * requires is refusing to record anything while it is in progress — see
   * `holdStart` and the force-close in the tick effect below — not any
   * adjustment to the clock itself.
   */
  const now = useCallback(
    () => (startedAt.current ? Math.min(MATCH_LEN, (Date.now() - startedAt.current) / 1000) : 0),
    []
  );

  /** True while the field is in the silent AUTO->TELEOP handoff. */
  const inDelay = (t: number) => t >= AUTO_LEN && t < AUTO_LEN + AUTO_TELEOP_DELAY;

  // Resume: one timeline per scouter/robot/match, so an already-scouted match
  // opens on its summary rather than silently starting a second recording.
  useEffect(() => {
    // A record handed down from MatchList wins over the local index only when
    // it is already a timeline; legacy count-based records have nothing to resume.
    const prior: TimelineScoutingData | undefined =
      existing && Array.isArray(existing.segments)
        ? (existing as TimelineScoutingData)
        : findTimeline(match.key, teamKey, user.username);
    if (!prior) return;
    setSaved(prior);
    setSegments(prior.segments);
    setConfidence(prior.confidence);
    setEndedEarly(!!prior.endedEarly);
    setElapsed(MATCH_LEN);
    setPhase('summary');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Close whatever is being held, discarding fat-finger slivers. */
  const closeOpen = useCallback((at: number) => {
    const kind = openKind.current;
    const from = openAt.current;
    openKind.current = null;
    openAt.current = null;
    setActive(null);
    if (kind == null || from == null) return;
    const end = Math.min(MATCH_LEN, at);
    if (end - from < MIN_SEGMENT) return;
    setSegments((prev) => [...prev, { action: kind, start: from, end }]);
  }, []);

  const finishMatch = useCallback(
    (early: boolean) => {
      closeOpen(now());
      setEndedEarly(early);
      setPhase('confidence');
    },
    [closeOpen, now]
  );

  // 100ms tick: elapsed counts up 0 -> MATCH_LEN, the display counts down.
  useEffect(() => {
    if (phase !== 'live') return;
    const id = window.setInterval(() => {
      const e = now();
      // A hold still open exactly as AUTO ends cannot legitimately continue
      // into the delay — the field goes quiet, drivers do not have control,
      // and nothing recorded in [AUTO_LEN, AUTO_LEN+AUTO_TELEOP_DELAY) would
      // mean anything. Force-close at the boundary rather than let it run on.
      if (openKind.current != null && elapsed < AUTO_LEN && e >= AUTO_LEN) {
        closeOpen(AUTO_LEN);
      }
      setElapsed(e);
      if (e >= MATCH_LEN) finishMatch(false);
    }, 100);
    return () => window.clearInterval(id);
  }, [phase, now, finishMatch, closeOpen, elapsed]);

  const startMatch = () => {
    startedAt.current = Date.now();
    setSegments([]);
    setElapsed(0);
    setEndedEarly(false);
    setPhase('live');
  };

  // Pointer (not mouse/touch) events plus pointer capture: the scout can drag a
  // thumb off a button mid-hold and the segment still closes exactly once.
  const holdStart = (e: React.PointerEvent<HTMLButtonElement>, kind: ActionKind) => {
    e.preventDefault();
    const at = now();
    // The buttons are visually locked during the delay (see the `locked`
    // render below); this is the actual enforcement — nothing can start
    // recording while drivers do not have control.
    if (inDelay(at)) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort; the up/cancel handlers still fire */
    }
    closeOpen(at);
    openKind.current = kind;
    openAt.current = at;
    setActive(kind);
  };

  const holdEnd = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      /* ignore */
    }
    closeOpen(now());
  };

  const persist = (conf: DataConfidence) => {
    const record = saveTimeline({
      id: saved?.id,
      matchKey: match.key,
      teamKey,
      scouter: user.username,
      alliance: user.alliance,
      position: user.position,
      segments,
      climb,
      confidence: conf,
      endedEarly,
      timestamp: Date.now(),
    });
    setSaved(record);
    setPhase('summary');
  };

  const exportJson = () => {
    const payload = {
      version: 1,
      matchKey: match.key,
      teamKey,
      scouter: user.username,
      alliance: user.alliance,
      segments,
      climb,
      confidence,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `timeline-${match.key}-${teamKey}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const scoutAgain = () => {
    setSaved(null);
    setSegments([]);
    setActive(null);
    setConfidence('high');
    setEndedEarly(false);
    setElapsed(0);
    startedAt.current = 0;
    setPhase('pre');
  };

  const locked = inDelay(elapsed);
  const activeColor = active ? META[active].color : null;
  const remaining = elapsed < AUTO_LEN ? AUTO_LEN - elapsed : MATCH_LEN - elapsed;
  const clock = fmt(remaining);
  const digits = [clock[0], clock[2], clock[3]];

  /** Proportional slices for the timeline bar: segments plus the gaps between. */
  const slices = useMemo(() => {
    const span = Math.max(elapsed, ...segments.map((s) => s.end), 1);
    const out: Array<{ color: string | null; flex: number }> = [];
    let cursor = 0;
    for (const s of [...segments].sort((a, b) => a.start - b.start)) {
      if (s.start > cursor) out.push({ color: null, flex: s.start - cursor });
      out.push({ color: META[s.action].color, flex: Math.max(0.01, s.end - s.start) });
      cursor = Math.max(cursor, s.end);
    }
    if (span > cursor) out.push({ color: null, flex: span - cursor });
    return out;
  }, [segments, elapsed]);

  const totals = useMemo(
    () =>
      actionTotals({
        segments,
        climb,
        confidence,
      } as TimelineScoutingData),
    [segments, climb, confidence]
  );

  const header = (
    <header className="cc-header">
      <div className="cc-brand">
        <BoltMark />
        <div className="cc-brand-text">
          <span className="cc-brand-name">SCOUT 6560</span>
          <span className="cc-brand-sub">Live Action Tracking</span>
        </div>
      </div>

      <div className="cc-header-spacer" />

      <div className="cc-header-right">
        <span className={`lm-match-pill${user.alliance === 'blue' ? ' blue' : ''}`}>
          {shortMatch} · {teamNumber} · {user.alliance === 'blue' ? 'Blue' : 'Red'} {user.position}
        </span>
        <button
          className="cc-header-ghost"
          onClick={() => (phase === 'live' ? finishMatch(true) : onBack())}
        >
          {phase === 'live' ? 'End Match' : 'Back'}
        </button>
      </div>
    </header>
  );

  /* ---------------- 01 pre-match ---------------- */
  if (phase === 'pre') {
    // A match with an incomplete schedule (an alliance short a team_key) has
    // no robot to assign this scout to. Recording anyway would save a
    // timeline under an empty team key that can never be attributed to
    // anyone and shows up as a numberless "team" in every downstream screen
    // — better to stop here than let a scout spend three minutes on data
    // nothing can use.
    if (!teamKey) {
      return (
        <div className="cc-root">
          {header}
          <section className="lm-page">
            <div className="lm-center">
              <h1 className="lm-title">TEAM ASSIGNMENT MISSING</h1>
              <p className="lm-lede">
                {matchLabel} doesn&apos;t have a {user.alliance} alliance team in position{' '}
                {user.position} on the loaded schedule, so there is no robot to assign you to. This
                usually means the match schedule for this event is incomplete. Ask your admin to
                re-check &amp; re-save the schedule under Match Selection.
              </p>
            </div>
          </section>
        </div>
      );
    }
    return (
      <div className="cc-root">
        {header}
        <section className="lm-page">
          <div className="lm-center">
            <h1 className="lm-title">
              {matchLabel.toUpperCase()} — TEAM {teamNumber}
            </h1>
            <p className="lm-lede">
              Track one robot for the whole match. Hold the segment that matches what it is doing
              right now — only one is active at a time. AUTO runs 0:20, then TELEOP runs 2:20.
            </p>
            <button className="lm-start" onClick={startMatch}>
              START MATCH
            </button>
          </div>
        </section>
      </div>
    );
  }

  /* ---------------- 03 confidence ---------------- */
  if (phase === 'confidence') {
    const choices: Array<{ value: DataConfidence; label: string; bg: string; fg: string }> = [
      { value: 'high', label: 'HIGH — TRACKED CLEANLY', bg: '#00baff', fg: '#000' },
      { value: 'moderate', label: 'MODERATE — SOME GAPS', bg: '#33becc', fg: '#000' },
      { value: 'low', label: 'LOW — LOST THE ROBOT', bg: '#000', fg: '#fff' },
    ];
    return (
      <div className="cc-root">
        {header}
        <section className="lm-page">
          <div className="lm-center">
            <h1 className="lm-title">HOW CONFIDENT ARE YOU IN THIS DATA?</h1>
            <p className="lm-lede">
              Your answer weights this match in the BPS solver. Low-confidence matches can be
              down-weighted or excluded.
            </p>
            {choices.map((c) => (
              <button
                key={c.value}
                className="lm-choice"
                style={{ background: c.bg, color: c.fg }}
                onClick={() => {
                  setConfidence(c.value);
                  persist(c.value);
                }}
              >
                {c.label}
              </button>
            ))}
          </div>
        </section>
      </div>
    );
  }

  /* ---------------- 04 summary ---------------- */
  if (phase === 'summary') {
    const tracked = Object.values(totals).reduce((a, b) => a + b, 0) || 1;

    return (
      <div className="cc-root">
        {header}
        <section className="lm-page">
          <h1 className="lm-title">
            {matchLabel.toUpperCase()} — TEAM {teamNumber} EXPORT
          </h1>

          <div className="lm-badges">
            <span className="lm-badge" style={{ background: '#eaf7fb', color: '#0b4fa0' }}>
              Confidence · {confidence.toUpperCase()}
            </span>
            {endedEarly && (
              <span className="lm-badge" style={{ background: '#fdeeef', color: '#c2323b' }}>
                Ended early
              </span>
            )}
          </div>

          <div className="lm-summary-actions">
            <button className="cc-btn-outline" onClick={scoutAgain}>
              Scout Again
            </button>
            <button className="lm-export" onClick={exportJson}>
              Export Timeline JSON
            </button>
            <button className="cc-btn-outline" onClick={onSubmit}>
              Done
            </button>
          </div>

          <div className="lm-tiles">
            {ACTIONS.map((a) => {
              const sec = totals[a.kind] ?? 0;
              return (
                <div key={a.kind} className="lm-tile" style={{ borderLeftColor: a.color }}>
                  <span className="lm-tile-label">{a.label.replace('\n', ' ')}</span>
                  <span className="lm-tile-value">{sec.toFixed(1)}s</span>
                  <span className="lm-tile-sub">
                    {Math.round((sec / tracked) * 100)}% of match
                  </span>
                </div>
              );
            })}
          </div>

          <div className="lm-card">
            <div className="lm-card-head">
              <span>Per-Robot Timeline (Stream 1 output)</span>
              <span className="lm-card-count">{segments.length} segments</span>
            </div>
            <div className="lm-table">
              <div className="lm-trow head">
                <span>#</span>
                <span>Action</span>
                <span>Phase</span>
                <span>Start</span>
                <span>Dur</span>
              </div>
              {segments.map((s, i) => (
                <div key={i} className={`lm-trow${i % 2 ? ' odd' : ''}`}>
                  <span>{i + 1}</span>
                  <span style={{ color: META[s.action].color, fontWeight: 800 }}>
                    {META[s.action].label.replace('\n', ' ')}
                  </span>
                  <span>{s.start < AUTO_LEN ? 'AUTO' : 'TELEOP'}</span>
                  <span>{fmt(s.start)}</span>
                  <span>{(s.end - s.start).toFixed(1)}s</span>
                </div>
              ))}
              {segments.length === 0 && <div className="lm-empty">No segments recorded.</div>}
            </div>
          </div>
        </section>
      </div>
    );
  }

  /* ---------------- 02 live ---------------- */
  return (
    <div className="cc-root">
      {header}
      <section className="lm-page">
        <div className="lm-panel">
          <div className="lm-panel-top">
            <span className="lm-phase">
              {elapsed < AUTO_LEN ? 'AUTO PERIOD' : locked ? 'SCORING DELAY — LOCKED' : 'TELEOP PERIOD'}
            </span>
            <span className="lm-segment">{segmentLabel(elapsed)}</span>
          </div>

          <div className="lm-clock">
            {digits.map((d, i) => (
              <span
                key={i}
                className="lm-digit"
                style={{
                  color: locked ? '#8a9aa2' : (activeColor ?? IDLE_TEXT),
                  borderColor: locked ? '#8a9aa2' : (activeColor ?? IDLE_BORDER),
                }}
              >
                {d}
              </span>
            ))}
            <span className="lm-colon">
              <i style={{ background: locked ? '#8a9aa2' : (activeColor ?? IDLE_TEXT) }} />
              <i style={{ background: locked ? '#8a9aa2' : (activeColor ?? IDLE_TEXT) }} />
            </span>
          </div>

          {/* Circuit traces: wire k lights only while action k is held. */}
          <div className="lm-circuit">
            <div className="lm-trace" />
            <div className="lm-wires">
              {ACTIONS.map((a) => (
                <span
                  key={a.kind}
                  className={`lm-wire${active === a.kind ? ' on' : ''}`}
                  style={active === a.kind ? { background: a.color } : undefined}
                />
              ))}
            </div>
            <div className="lm-trace" />
            <div className="lm-pins">
              {ACTIONS.map((a) => (
                <span
                  key={a.kind}
                  className="lm-pin"
                  style={active === a.kind ? { background: a.color } : undefined}
                />
              ))}
            </div>
          </div>

          <div className="lm-actions">
            {ACTIONS.map((a) => {
              const on = active === a.kind;
              return (
                <div key={a.kind} className="lm-action-slot">
                  <button
                    className="lm-action"
                    disabled={locked}
                    style={
                      locked
                        ? {
                            background: '#eef4f6',
                            color: '#b3c3c9',
                            boxShadow: 'inset 0 0 0 2.5px #dfe9ec',
                            cursor: 'not-allowed',
                          }
                        : on
                        ? {
                            background: a.color,
                            color: '#000',
                            boxShadow: `0 0 0 4px ${a.color}44`,
                            transform: 'translateY(2px)',
                          }
                        : {
                            background: '#fff',
                            color: a.idleText ?? a.color,
                            boxShadow: `inset 0 0 0 2.5px ${a.color}`,
                          }
                    }
                    onPointerDown={(e) => holdStart(e, a.kind)}
                    onPointerUp={holdEnd}
                    onPointerCancel={holdEnd}
                    onContextMenu={(e) => e.preventDefault()}
                  >
                    {a.label.split('\n').map((line, i) => (
                      <span key={i} style={{ display: 'block' }}>
                        {line}
                      </span>
                    ))}
                  </button>
                </div>
              );
            })}
          </div>

          <div className="lm-panel-bottom">
            <span className="lm-state-label">Current State</span>
            <span
              className="lm-state-value"
              style={{ color: locked ? '#000' : (activeColor ?? '#6a6a6a') }}
            >
              {locked
                ? `LOCKED (${Math.ceil(AUTO_LEN + AUTO_TELEOP_DELAY - elapsed)}s)`
                : active
                ? META[active].label.replace('\n', ' ')
                : 'IDLE'}
            </span>
          </div>
        </div>

        <div className="lm-card">
          <div className="lm-card-head">
            <span>Action Timeline</span>
            <span className="lm-card-count">{segments.length} segments</span>
          </div>
          <div className="lm-bar">
            {slices.map((s, i) => (
              <span
                key={i}
                style={{ flex: s.flex, background: s.color ?? 'var(--border-soft)' }}
              />
            ))}
          </div>
          <div className="lm-bar-foot">
            <span>AUTO {fmt(AUTO_LEN)}</span>
            <span>{fmt(elapsed)} elapsed</span>
            <span>TELEOP {fmt(TELEOP_LEN)}</span>
          </div>
        </div>

        <div className="lm-card">
          <div className="lm-card-head">
            <span>Event Log</span>
            <span className="lm-card-count">{segments.length} segments</span>
          </div>
          <div className="lm-log">
            {segments.length === 0 && (
              <span className="lm-empty">Hold a button to record the first segment.</span>
            )}
            {[...segments].reverse().map((s, i) => (
              <div key={segments.length - i} className="lm-log-row">
                <span className="lm-dot" style={{ background: META[s.action].color }} />
                <span className="lm-log-name">{META[s.action].label.replace('\n', ' ')}</span>
                <span className="lm-log-range">
                  {fmt(s.start)} → {fmt(s.end)}
                </span>
                <span className="lm-log-dur">{(s.end - s.start).toFixed(1)}s</span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

export default LiveMatch;
