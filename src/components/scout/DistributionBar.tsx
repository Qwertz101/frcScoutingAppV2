import type { CSSProperties } from 'react';
import { TeamMetrics } from '../../utils/teamMetrics';

interface DistributionBarProps {
  team: TeamMetrics;
  /** Top of the shared axis, so every bar on a screen is comparable. */
  scaleMax: number;
  /** Optional reference line, e.g. the Energized RP threshold. */
  threshold?: number;
  height?: number;
}

/** Reference height the design's pixel geometry was authored against. */
const BASE_HEIGHT = 46;

/** Band gradient stops — outer quartiles fade, the IQR is solid. */
const OUTER = '#00baff';
const INNER = '#3d93f0';

const clampPct = (v: number) => Math.max(0, Math.min(100, v));

/**
 * Match-point distribution for one robot.
 *
 * The band spans the robot's whole normal range (floor → ceiling) and the blue
 * *deepens with percentile*: it feathers in from transparent across the bottom
 * 25%, holds solid through the middle 50% (the IQR), then feathers back out
 * across the top 25%. Whiskers mark floor and ceiling, a black tick marks the
 * median, and matches excluded from the normal range are drawn on the track as
 * "!" outliers or solid bars for a dead robot.
 *
 * Geometry and the gradient maths are ported from the Charging Champions design
 * source (`Scout 6560 - Picklist.dc.html`) so this renders identically. Sizes
 * are expressed as ratios of BASE_HEIGHT so the bar stays proportional when a
 * screen asks for a shorter row.
 */
export function DistributionBar({ team, scaleMax, threshold, height = BASE_HEIGHT }: DistributionBarProps) {
  const P = (v: number) => clampPct((v / (scaleMax || 1)) * 100);
  const pct = (v: number) => `${P(v).toFixed(2)}%`;

  // Scale the design's pixel geometry to whatever height this screen asked for.
  const k = height / BASE_HEIGHT;
  const px = (n: number) => `${Math.round(n * k * 10) / 10}px`;
  const vars = {
    height,
    '--dist-track-h': px(6),
    '--dist-band-h': px(16),
    '--dist-whisker-h': px(22),
    '--dist-median-h': px(30),
    '--dist-death-h': px(42),
    '--dist-outlier-d': px(18),
  } as CSSProperties;

  if (!team.hasData) {
    return (
      <div className="pl-dist" style={vars}>
        <div className="pl-dist-track" />
        <span className="pl-dist-nodata">no scouting data</span>
      </div>
    );
  }

  const minP = P(team.floor);
  const q1P = P(team.q1);
  const q3P = P(team.q3);
  const maxP = P(team.ceiling);

  // Extend the band slightly past floor/ceiling so the feathered ends fade out
  // *around* those marks rather than being clipped flat at them.
  const overlap = 1.5;
  const eMin = Math.max(0, minP - overlap);
  const eMax = Math.min(100, maxP + overlap);
  const bandW = Math.max(0.5, eMax - eMin);

  // Quartile stops, re-expressed as percentages *of the band* rather than the axis.
  const lq1 = clampPct(((q1P - eMin) / bandW) * 100);
  const lq3 = clampPct(((q3P - eMin) / bandW) * 100);

  // Two blends share the room between the band's edge and the IQR:
  // transparent->OUTER (width = feather), then OUTER->INNER (width = lq1 -
  // feather). A team with a tight IQR sitting close to its floor or ceiling
  // has little room on that side, and greedily spending the whole gap on
  // the first blend — feather approaching or equal to lq1 — collapses the
  // second to zero width, which reads as a hard color line rather than a
  // fade. Splitting the gap keeps both visible no matter how tight it is;
  // the final clamp is a hard guarantee feather can never reach lq1 itself,
  // independent of the floor/ceiling picked above.
  const halfGap = Math.min(lq1, 100 - lq3);
  const featherTarget = Math.max(1, Math.min(halfGap * 0.45, 8));
  const feather = Math.min(featherTarget, Math.max(0, halfGap - 0.15));

  const bandBg =
    `linear-gradient(90deg, transparent 0%, ${OUTER} ${feather.toFixed(2)}%, ` +
    `${INNER} ${lq1.toFixed(2)}%, ${INNER} ${lq3.toFixed(2)}%, ` +
    `${OUTER} ${(100 - feather).toFixed(2)}%, transparent 100%)`;

  return (
    <div
      className="pl-dist"
      style={vars}
      title={
        team.isSynthetic
          ? `Average ${Math.round(team.adjMean)} pts is real; the spread is reconstructed from season averages`
          : `${team.matchesPlayed} scouted matches · median ${Math.round(team.median)} · IQR ${Math.round(team.q1)}–${Math.round(team.q3)}`
      }
    >
      <div className="pl-dist-track" />

      {threshold != null && threshold > 0 && (
        <div className="pl-dist-threshold" style={{ left: pct(threshold) }} />
      )}

      <div
        className="pl-dist-band"
        style={{ left: `${eMin.toFixed(2)}%`, width: `${bandW.toFixed(2)}%`, background: bandBg }}
      />

      {/* floor / ceiling */}
      <div className="pl-dist-whisker" style={{ left: pct(team.floor) }} />
      <div className="pl-dist-whisker" style={{ left: pct(team.ceiling) }} />

      <div className="pl-dist-median" style={{ left: pct(team.median) }} />

      {team.deaths.map((d) => (
        <span
          key={`d-${d.matchKey}`}
          className="pl-dist-death"
          title={`${d.label}: robot died mid-match (${d.points} pts)`}
          style={{ left: pct(d.points) }}
        />
      ))}

      {team.outliers
        .filter((o) => !o.died)
        .map((o) => (
          <span
            key={`o-${o.matchKey}`}
            className="pl-dist-outlier"
            title={`${o.label}: ${o.points} pts — below normal range`}
            style={{ left: pct(o.points) }}
          >
            !
          </span>
        ))}
    </div>
  );
}

/** Shared 0..scaleMax axis, aligned to the bars beneath it. */
export function DistributionAxis({ scaleMax, steps = 4 }: { scaleMax: number; steps?: number }) {
  const values = Array.from({ length: steps + 1 }, (_, i) => Math.round((scaleMax / steps) * i));
  return (
    <div className="pl-dist-axis">
      {values.map((v, i) => (
        <span key={i} style={{ left: `${(i / steps) * 100}%` }}>
          {v}
        </span>
      ))}
    </div>
  );
}
