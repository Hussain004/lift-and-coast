export type RaceControlIncident =
  | "track-limits"
  | "unsafe-rejoin"
  | "pit-speeding"
  | "red-flag";

/**
 * How a penalty is served, mirroring the FIA's penalty toolbox: a time
 * penalty is added to the race/classification time, a drive-through must be
 * served in the pit lane (modelled as a flat time cost at pit-lane speed),
 * and a stop-go adds a standing stop on top.
 */
export type PenaltySeverity = "time" | "drive-through" | "stop-go" | "none";

export interface RaceControlDecision {
  code: string;
  incident: RaceControlIncident;
  message: string;
  penaltySeconds: number;
  penaltyPoints: number;
  severity: PenaltySeverity;
  invalidatedLap: boolean;
  disqualified: boolean;
  atSeconds: number;
}

export interface RaceControlState {
  penaltySeconds: number;
  penaltyPoints: number;
  disqualified: boolean;
  flag: "green" | "yellow" | "red";
  decisions: RaceControlDecision[];
  lastDecision: RaceControlDecision | null;
}

/**
 * FIA super-license: a driver who collects 12 penalty points inside a
 * rolling 12-month window receives an automatic race ban. This game models
 * the ban as disqualification once the season's points reach the threshold.
 */
export const LICENSE_BAN_POINTS = 12;

/**
 * Drive-through / stop-go time costs. A drive-through costs roughly 20s
 * against the leader at pit-lane speed (the pit lane itself is a marked
 * service window in this build - see strategy.ts), and a stop-go adds a
 * standing stop on top of the transit.
 */
export const DRIVE_THROUGH_SECONDS = 20;
export const STOP_GO_SECONDS = 30;

export function createRaceControlSystem() {
  const state: RaceControlState = {
    penaltySeconds: 0,
    penaltyPoints: 0,
    disqualified: false,
    flag: "green",
    decisions: [],
    lastDecision: null,
  };

  function reportIncident(
    incident: RaceControlIncident,
    atSeconds = 0,
    details: {
      penaltySeconds?: number;
      penaltyPoints?: number;
      severity?: PenaltySeverity;
      message?: string;
    } = {}
  ): RaceControlDecision {
    const defaults = {
      "track-limits": {
        seconds: 5,
        points: 2,
        severity: "time" as PenaltySeverity,
        message: "Track limits: time penalty",
      },
      "unsafe-rejoin": {
        seconds: DRIVE_THROUGH_SECONDS,
        points: 2,
        severity: "drive-through" as PenaltySeverity,
        message: "Unsafe rejoin: drive-through penalty",
      },
      "pit-speeding": {
        seconds: DRIVE_THROUGH_SECONDS,
        points: 1,
        severity: "drive-through" as PenaltySeverity,
        message: "Pit lane speeding: drive-through penalty",
      },
      "red-flag": { seconds: 0, points: 0, severity: "none" as PenaltySeverity, message: "Race control: red flag" },
    } as const;
    const preset = defaults[incident];
    const decision: RaceControlDecision = {
      code: `${incident.toUpperCase()}-${state.decisions.length + 1}`,
      incident,
      message: details.message ?? preset.message,
      penaltySeconds: details.penaltySeconds ?? preset.seconds,
      penaltyPoints: details.penaltyPoints ?? preset.points,
      severity: details.severity ?? preset.severity,
      invalidatedLap: incident === "unsafe-rejoin" || incident === "track-limits",
      disqualified: false,
      atSeconds: Math.max(0, atSeconds),
    };
    state.penaltySeconds += decision.penaltySeconds;
    state.penaltyPoints += decision.penaltyPoints;
    if (incident === "red-flag") state.flag = "red";
    if (state.penaltyPoints >= LICENSE_BAN_POINTS) {
      state.disqualified = true;
      decision.disqualified = true;
      decision.message += " · RACE BAN (12 PT)";
    }
    state.decisions.push(decision);
    state.lastDecision = decision;
    return { ...decision };
  }

  function clearFlag() {
    state.flag = "green";
  }

  function snapshot(): RaceControlState {
    return {
      ...state,
      decisions: state.decisions.map((decision) => ({ ...decision })),
      lastDecision: state.lastDecision ? { ...state.lastDecision } : null,
    };
  }

  return { state, reportIncident, clearFlag, snapshot };
}

export function raceControlSummary(state: RaceControlState): string {
  if (state.disqualified) return "RACE BAN";
  if (state.flag === "red") return "RED FLAG";
  if (state.penaltySeconds > 0 || state.penaltyPoints > 0) {
    return `PENALTY ${state.penaltySeconds}s · ${state.penaltyPoints} PT`;
  }
  return "GREEN";
}
