export type RaceControlIncident =
  | "track-limits"
  | "unsafe-rejoin"
  | "pit-speeding"
  | "red-flag";

export interface RaceControlDecision {
  code: string;
  incident: RaceControlIncident;
  message: string;
  penaltySeconds: number;
  penaltyPoints: number;
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
    details: { penaltySeconds?: number; penaltyPoints?: number; message?: string } = {}
  ): RaceControlDecision {
    const defaults = {
      "track-limits": { seconds: 5, points: 2, message: "Track limits: time penalty" },
      "unsafe-rejoin": { seconds: 0, points: 2, message: "Unsafe rejoin: lap invalidation" },
      "pit-speeding": { seconds: 5, points: 1, message: "Pit lane speeding: time penalty" },
      "red-flag": { seconds: 0, points: 0, message: "Race control: red flag" },
    } as const;
    const preset = defaults[incident];
    const decision: RaceControlDecision = {
      code: `${incident.toUpperCase()}-${state.decisions.length + 1}`,
      incident,
      message: details.message ?? preset.message,
      penaltySeconds: details.penaltySeconds ?? preset.seconds,
      penaltyPoints: details.penaltyPoints ?? preset.points,
      invalidatedLap: incident === "unsafe-rejoin" || incident === "track-limits",
      disqualified: false,
      atSeconds: Math.max(0, atSeconds),
    };
    state.penaltySeconds += decision.penaltySeconds;
    state.penaltyPoints += decision.penaltyPoints;
    if (incident === "red-flag") state.flag = "red";
    if (state.penaltyPoints >= 5) {
      state.disqualified = true;
      decision.disqualified = true;
      decision.message += " · DSQ";
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
  if (state.disqualified) return "DSQ";
  if (state.flag === "red") return "RED FLAG";
  if (state.penaltySeconds > 0 || state.penaltyPoints > 0) {
    return `PENALTY ${state.penaltySeconds}s · ${state.penaltyPoints} PT`;
  }
  return "GREEN";
}
