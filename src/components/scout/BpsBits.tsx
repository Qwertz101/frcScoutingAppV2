import { BpsReport } from '../../services/bps';
import { TeamMetrics } from '../../utils/teamMetrics';

/**
 * Shared provenance furniture for the BPS (points-per-second) model.
 *
 * The workspace shows numbers from two different scouting models side by side
 * — see the header of `utils/teamMetrics.ts`. A user must never be unable to
 * tell which model a number came from, so every BPS-derived figure carries a
 * badge and every screen that can show one carries the standing footnote.
 *
 * This mirrors the existing `isSynthetic` / "reconstructed" precedent rather
 * than inventing a second vocabulary for provenance.
 */

/** Inline marker on a single BPS-derived number. */
export function BpsBadge({ title }: { title?: string }) {
  return (
    <span
      className="pl-src-badge bps"
      title={title ?? 'Solved from the action timeline + CV scoreboard (BPS)'}
    >
      BPS
    </span>
  );
}

/** Per-team provenance chip: says which model this team's points came from. */
export function SourceBadge({ team }: { team: TeamMetrics }) {
  if (team.source === 'legacy') return null;
  const mixed = team.source === 'mixed';
  return (
    <span
      className={`pl-src-badge ${mixed ? 'mixed' : 'bps'}`}
      title={
        mixed
          ? 'Some matches solved from BPS, the rest from the legacy scouting form'
          : 'Every match solved from the action timeline + CV scoreboard'
      }
    >
      {mixed ? 'MIXED' : 'BPS'}
    </span>
  );
}

/** Standing disclaimer wherever BPS numbers can appear. */
export function BpsFootnote() {
  return (
    <p className="pl-note pl-bps-note">
      Two scouting models are live at once. <strong>Legacy</strong> numbers come from the match
      scouting form — fuel counts, climb level and defense rating, scored by the 2026 rules.{' '}
      <strong>BPS</strong> numbers are solved: a scout's second-by-second action timeline is fused
      with the CV scoreboard log, and each robot gets a points-per-second rate multiplied by the
      time it was flagged scoring. The choice is made per match, so a team can be
      <strong> mixed</strong>. Anything carrying a <span className="pl-src-badge bps">BPS</span>{' '}
      badge came from the solver; everything else is legacy. BPS matches have no fuel or auto-climb
      breakdown — the solver attributes scoreboard points, not game pieces — and their climb is
      recorded as climbed / not, never by level.
    </p>
  );
}

const fmt = (v: number, dp = 2) => (Number.isFinite(v) ? v.toFixed(dp) : '—');

/**
 * Solver health. Worth a glance before trusting any BPS number: the fit is only
 * as good as the scouts' flagging, and orphan score is the direct measure of
 * how much of the scoreboard they missed.
 */
export function SolverDiagnostics({ report }: { report: BpsReport | null }) {
  if (!report) return null;

  const d = report.diagnostics;
  const totalScore = report.windows.reduce((s, w) => s + w.score, 0);
  const orphanPct = totalScore + d.orphanScore > 0
    ? (d.orphanScore / (totalScore + d.orphanScore)) * 100
    : 0;
  const orphanBad = orphanPct >= 25;
  const shifts = Object.entries(report.timeShifts).filter(([, s]) => s !== 0);

  return (
    <div className="pl-card pl-diag">
      <div className="pl-card-head">
        <span className="pl-card-label">BPS solver diagnostics</span>
        <span className="pl-card-hint">how much the fit can be trusted</span>
      </div>

      <div className="pl-diag-grid">
        {[
          ['Matches solved', String(d.matches), 'timeline + CV log fused'],
          ['Windows', String(d.windowCount), 'equations in the fit'],
          ['Teams', String(d.teams), 'with a solved rate'],
          ['λ (ridge)', fmt(report.lambda, 3), 'regularisation strength'],
          ['Dropped windows', String(d.droppedWindows), 'anomaly cleanup'],
          ['Time shifts', shifts.length ? String(shifts.length) : 'none', 'matches re-aligned'],
        ].map(([label, value, sub]) => (
          <div key={label} className="pl-diag-cell">
            <span className="pl-stat-label">{label}</span>
            <span className="pl-diag-num">{value}</span>
            <span className="pl-card-hint">{sub}</span>
          </div>
        ))}

        <div className={`pl-diag-cell${orphanBad ? ' warn' : ''}`}>
          <span className="pl-stat-label">Orphan score</span>
          <span className="pl-diag-num">{Math.round(d.orphanScore)}</span>
          <span className="pl-card-hint">
            {Math.round(orphanPct)}% of scored points, unattributed
          </span>
        </div>
      </div>

      {orphanBad && (
        <p className="pl-note pl-diag-warn">
          <strong>Warning —</strong> {Math.round(orphanPct)}% of the points the scoreboard recorded
          happened while no robot was flagged as scoring. Scouts are missing scoring events, so the
          solved rates are being pulled downward and distributed unevenly. Treat BPS numbers from
          this event as indicative only until the flagging improves.
        </p>
      )}

      {shifts.length > 0 && (
        <p className="pl-note">
          Time-sync corrections applied (livestream lag):{' '}
          {shifts
            .map(([k, s]) => `${k.replace(/^.*_/, '')} ${s > 0 ? '+' : ''}${s}s`)
            .join(' · ')}
        </p>
      )}
    </div>
  );
}
