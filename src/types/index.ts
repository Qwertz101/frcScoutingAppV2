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
export const MATCH_LEN = AUTO_LEN + TELEOP_LEN;

/** One continuous stretch of a single action, in seconds from match start. */
export interface ActionSegment {
  action: ActionKind;
  start: number;
  end: number;
}

export type ClimbResult = 'climbed' | 'attempted' | 'none';

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