export interface User {
  username: string;
  alliance: 'red' | 'blue';
  position: 1 | 2 | 3;
  isAdmin: boolean;
}

export interface Match {
  key: string;
  match_number: number;
  comp_level: string;
  alliances: {
    red: {
      team_keys: string[];
    };
    blue: {
      team_keys: string[];
    };
  };
}

export interface ScoutingData {
  id: string;
  matchKey: string;
  teamKey: string;
  scouter: string;
  alliance: 'red' | 'blue';
  position: number;
  auto: {
    // number of fuel scored in the hub during autonomous
    fuel?: number;
    // where fuel was collected from
    neutralZone?: boolean;
    depot?: boolean;
    outpost?: boolean;
    // climbed in auto
    // can be legacy boolean or new string values ('climbed'|'didnt_climb'|'level1'..'level3')
    climbed?: boolean | 'climbed' | 'didnt_climb' | 'level1' | 'level2' | 'level3';
  };
  teleop: {
    offence?: {
      fuel?: number;
    };
    defense?: {
      defense?: 'na' | 'bad' | 'average' | 'good';
      duration?: number;
    };
    endgame?: {
      fuel?: number;
    };
  };
  // match-level fields (UI: "Match Data")
  robotShutdown?: 'no' | 'part' | 'full';
  dataConfidence?: 'confident' | 'a_little_confident' | 'not_confident';
  endgame: {
    climb: 'none' | 'level1' | 'level2' | 'level3';
    // trench capability
    trench?: 'yes' | 'no' | 'na';
    // shooting accuracy
    shootingAccuracy?: 'na' | 'very_inaccurate' | 'inaccurate' | 'moderately_accurate' | 'accurate' | 'very_accurate';
    // shooting speed
    shootingSpeed?: 'na' | 'very_slow' | 'slow' | 'average' | 'moderately_fast' | 'very_fast';
    // intake speed
    intakeSpeed?: 'na' | 'very_slow' | 'slow' | 'average' | 'moderately_fast' | 'very_fast';
    // driving speed
    drivingSpeed?: 'na' | 'very_slow' | 'slow' | 'average' | 'moderately_fast' | 'very_fast';
    // driving skill
    drivingSkill?: 'na' | 'poor' | 'average' | 'good' | 'excellent';
    // robot disability
    robotDisability?: 'none' | 'small_part' | 'about_half' | 'nearly_whole';
    // robot range
    robotRange?: 'na' | 'short' | 'average' | 'long' | 'very_long';
  died?: 'none' | 'partway' | 'start';
  };
  defense: 'none' | 'bad' | 'ok' | 'great';
  timestamp: number;
}

/* ------------------------------------------------------------------ *
 * Time-windowed BPS scouting (Scouting_Procedure.pdf)
 *
 * Two independent streams per match, fused afterward:
 *   Stream 1 (human) — which robot was doing what, second by second.
 *   Stream 2 (CV)    — alliance score deltas, second by second.
 * Neither alone attributes points to a robot; the fusion does.
 * ------------------------------------------------------------------ */

/** The four mutually-exclusive action segments a scout tracks. */
export type ActionKind = 'shoot' | 'pass' | 'def' | 'oof';

/** Match structure, 2026 REBUILT: AUTO 0:20 then TELEOP 2:20. */
export const AUTO_LEN = 20;
export const TELEOP_LEN = 140;

/**
 * Real dead time between AUTO and TELEOP, in seconds — manual §6.4: "There is
 * a 3-second delay between AUTO and TELEOP for scoring purposes." Nothing
 * scores and drivers do not have control during this window.
 *
 * INCLUDED in `MATCH_LEN` — every timestamp in the app, human and CV alike,
 * is real elapsed seconds since the green flag, and the delay really did
 * take 3 real seconds. This is deliberately the opposite of squeezing the
 * delay out of the timeline: `services/cv/matchClock.ts` reads the literal
 * digits off TELEOP's countdown plate and converts via `MATCH_LEN -
 * remaining`, so as long as `MATCH_LEN` is the TRUE total match length that
 * formula already yields true elapsed time with no special-casing — the
 * plate reads 2:20 the instant TELEOP truly starts, 3 real seconds after
 * AUTO ended, and `163 - 140 = 23` falls out on its own.
 *
 * The one place this constant is used directly is `LiveMatch.tsx`, which
 * must refuse to record any action while `elapsed` is inside
 * `[AUTO_LEN, AUTO_LEN + AUTO_TELEOP_DELAY)` — nothing can legitimately be
 * scoring there, since drivers do not yet have control.
 */
export const AUTO_TELEOP_DELAY = 3;

export const MATCH_LEN = AUTO_LEN + AUTO_TELEOP_DELAY + TELEOP_LEN;

/** One continuous stretch of a single action, in seconds from match start. */
export interface ActionSegment {
  action: ActionKind;
  start: number;
  end: number;
}

export type ClimbResult = 'climbed' | 'attempted' | 'none';

/**
 * Auto + endgame tower points TBA attributes to one robot in one match.
 *
 * Ground truth, not a scout's estimate: TBA's `score_breakdown` names which
 * robot occupied each tower slot (`autoTowerRobot1/2/3`,
 * `endGameTowerRobot1/2/3`), positionally matched to that alliance's
 * `team_keys`. This replaced the scout's climb question — see
 * `services/tbaApi.fetchEventClimbData`.
 */
export interface TowerCredit {
  auto: number;
  endgame: number;
}

/** matchKey -> teamKey -> that robot's tower credit for the match. */
export type ClimbByMatch = Record<string, Record<string, TowerCredit>>;

/**
 * Everything the app imports from TBA's published match results.
 *
 * Both halves come from the same `score_breakdown` fetch, and both are
 * ground truth rather than scouted estimates.
 */
export interface TbaMatchScores {
  climbByMatch: ClimbByMatch;
  /**
   * "matchKey|alliance" -> the alliance's AUTO + TELEOP fuel points, with
   * climb, fouls and adjustments excluded. This is the anchor target the
   * per-match points are rescaled to.
   *
   * Verified against every 2026 qualification match at 2026cagle:
   *   hubScore.autoPoints + hubScore.teleopPoints === hubScore.totalPoints
   *   totalPoints === hubScore.totalPoints + totalTowerPoints
   *                   + foulPoints + adjustPoints
   * so `hubScore.totalPoints` is exactly "score minus climb minus fouls".
   */
  fuelByAlliance: Record<string, number>;
}

/**
 * How much the scout trusts their own tracking. Feeds the solver's weight
 * matrix — low-confidence matches can be down-weighted or excluded.
 */
export type DataConfidence = 'high' | 'moderate' | 'low';

/** Stream 1 output: one robot's action timeline for one match. */
export interface TimelineScoutingData {
  id: string;
  matchKey: string;
  teamKey: string;
  scouter: string;
  alliance: 'red' | 'blue';
  position: number;
  segments: ActionSegment[];
  climb: ClimbResult;
  confidence: DataConfidence;
  /** Set when the scout ended the match early rather than running the clock out. */
  endedEarly?: boolean;
  timestamp: number;
}

/** One second of the CV scoreboard read. */
export interface CvScoreSample {
  /** Seconds from match start. */
  sec: number;
  phase: 'auto' | 'teleop';
  blue: number;
  red: number;
  /** Positive score change this second. */
  db: number;
  dr: number;
}

/**
 * One ungated per-second observation, exactly as the OCR reported it.
 *
 * Kept alongside the gated samples because it is what makes a log
 * re-processable without the video, which the capture pipeline never stores.
 * Gate thresholds, clock logic and resync rules are the parts most likely to
 * need fixing later, and every one of them can be re-run from these.
 */
export interface CvRawRead {
  sec: number;
  at: number;
  blueRaw: number | null;
  redRaw: number | null;
  blueConf: number;
  redConf: number;
  timerText: string;
  timerRemaining: number | null;
}

/** The capture worker's assessment of a log it produced. */
export interface CvQuality {
  /** 0..1, a product of per-signal terms so one collapse takes the total. */
  score: number;
  flagged: boolean;
  /** Why, in words. A flag nobody can act on is not worth raising. */
  reasons: string[];
  signals: Record<string, number | boolean | string | null>;
  terms?: Record<string, number>;
  /** Filled in later by the reconcile pass. Advisory only, never punitive. */
  tbaAgreement?: {
    ours: { blue: number; red: number };
    tba: { blue: number; red: number };
    delta: { blue: number; red: number };
    within: boolean;
  } | null;
}

/** Stream 2 output: the per-second scoreboard log for one match. */
export interface CvMatchLog {
  matchKey: string;
  eventKey: string;
  samples: CvScoreSample[];
  /** "Live stream" / "Recorded video" / imported filename. */
  source: string;
  createdAt: number;
  updatedAt?: number;
  deletedAt?: number | null;
  /** Present on logs the capture worker produced; absent on hand-made ones. */
  quality?: CvQuality;
  flagged?: boolean;
  rawReads?: CvRawRead[];
}

/**
 * One equation of the solver: over window w the teams in `teams` were the
 * alliance's flagged scorers for `length` seconds, and the alliance gained
 * `score` points.
 */
export interface BpsWindow {
  matchKey: string;
  alliance: 'red' | 'blue';
  start: number;
  length: number;
  phase: 'auto' | 'teleop';
  teams: string[];
  score: number;
  /** Longer, more isolated, higher-confidence windows carry more weight. */
  weight: number;
}

/** Solved per-team rates. */
export interface BpsResult {
  teamKey: string;
  bps: number;
  autoBps: number;
  teleopBps: number;
  /** Windows this team appeared in — low counts mean a shaky estimate. */
  windows: number;
  /** Seconds this team was flagged as actively scoring. */
  scoringSeconds: number;

  /* --- Passing, inferred rather than observed --------------------------
   * Passing scores nothing, so the solver can never see it directly: a
   * passing robot contributes no points for the regression to attribute.
   *
   * The estimate assumes a robot moves fuel at the same rate whether it is
   * shooting or feeding an ally, so its solved scoring rate doubles as a
   * handling rate. Fuel is worth 1 point in 2026 REBUILT (SCORING.fuel),
   * so points-per-second and fuel-per-second are the same number and
   * `bps × passSeconds` reads directly as fuel.
   *
   * This is an inference from an assumption, not a measurement. Any screen
   * showing it must label it as an estimate.
   * ------------------------------------------------------------------ */
  /** Seconds this team was flagged passing to an ally. */
  passSeconds: number;
  /** Estimated fuel passed across all scouted matches. */
  passedFuel: number;
  /** Estimated fuel passed per match — the headline number. */
  passedFuelPerMatch: number;
}

export interface Scouter {
  id: string;
  name: string;
  alliance: 'red' | 'blue';
  position: 1 | 2 | 3;
  isRemote: boolean;
  updatedAt?: number; // ms since epoch
  deletedAt?: number | null;
}

export interface Event {
  key: string;
  name: string;
  start_date: string;
  end_date: string;
}