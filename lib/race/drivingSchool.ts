// Driving school: four short drills a new player can follow on a practice
// session, checked from the numbers the HUD already carries. Pure; the widget
// feeds it the snapshot a few times a second.

export type DrillId = "launch" | "brake" | "overtake" | "lap";

export interface Drill {
  id: DrillId;
  title: string;
  instruction: string;
}

export const DRILLS: Drill[] = [
  { id: "launch", title: "Full throttle", instruction: "Hold W on a straight and reach 200 km/h." },
  { id: "brake", title: "Brake in a straight line", instruction: "Now hold S: slow from speed to under 80 km/h without steering." },
  { id: "overtake", title: "Overtake mode", instruction: "Press X to deploy overtake mode (L Shift for ERS) on a straight." },
  { id: "lap", title: "One clean lap", instruction: "Drive a whole lap with all four wheels inside the white lines." },
];

export interface SchoolInput {
  speedKmh: number;
  brake: number;
  steer: number;
  overtakeActive: boolean;
  /** Current lap number (rises when a lap is completed). */
  lap: number;
  lapInvalid: boolean;
}

export interface SchoolState {
  done: Record<DrillId, boolean>;
  /** Highest speed since the launch drill finished, for the brake drill. */
  peakSinceLaunch: number;
  usedBrake: boolean;
  steeredHard: boolean;
  lapAtStart: number | null;
  sawInvalid: boolean;
}

export function createSchool(): SchoolState {
  return {
    done: { launch: false, brake: false, overtake: false, lap: false },
    peakSinceLaunch: 0,
    usedBrake: false,
    steeredHard: false,
    lapAtStart: null,
    sawInvalid: false,
  };
}

export const LAUNCH_SPEED_KMH = 200;
export const BRAKE_TARGET_KMH = 80;
const MIN_BRAKE_FROM_KMH = 150;

/** The drill the player is on now, or null once every drill is done. */
export function currentDrill(state: SchoolState): Drill | null {
  return DRILLS.find((d) => !state.done[d.id]) ?? null;
}

/** Advances the drills; returns the one just completed, if any. */
export function stepSchool(state: SchoolState, input: SchoolInput): Drill | null {
  const drill = currentDrill(state);
  if (!drill) return null;
  if (state.lapAtStart === null) state.lapAtStart = input.lap;
  if (input.lapInvalid) state.sawInvalid = true;
  let finished = false;
  switch (drill.id) {
    case "launch":
      finished = input.speedKmh >= LAUNCH_SPEED_KMH;
      if (finished) state.peakSinceLaunch = input.speedKmh;
      break;
    case "brake":
      state.peakSinceLaunch = Math.max(state.peakSinceLaunch, input.speedKmh);
      if (input.brake > 0.3) state.usedBrake = true;
      if (Math.abs(input.steer) > 0.5) state.steeredHard = true;
      if (input.speedKmh > MIN_BRAKE_FROM_KMH && input.brake < 0.1) {
        // Back on the throttle: the braking zone is over, so start a fresh attempt.
        state.usedBrake = false;
        state.steeredHard = false;
        state.peakSinceLaunch = input.speedKmh;
      }
      finished =
        state.peakSinceLaunch >= MIN_BRAKE_FROM_KMH &&
        state.usedBrake &&
        !state.steeredHard &&
        input.speedKmh <= BRAKE_TARGET_KMH;
      break;
    case "overtake":
      finished = input.overtakeActive;
      break;
    case "lap":
      // Restart the lap attempt whenever a limit is broken.
      if (state.sawInvalid && input.lap > (state.lapAtStart ?? input.lap)) {
        state.lapAtStart = input.lap;
        state.sawInvalid = false;
      }
      finished = input.lap > (state.lapAtStart ?? input.lap) && !state.sawInvalid;
      break;
  }
  if (!finished) return null;
  state.done[drill.id] = true;
  // The next drill starts from a clean slate (the lap drill counts from here).
  state.lapAtStart = input.lap;
  state.sawInvalid = false;
  state.usedBrake = false;
  state.steeredHard = false;
  return drill;
}

export function schoolProgress(state: SchoolState): { done: number; total: number } {
  return { done: DRILLS.filter((d) => state.done[d.id]).length, total: DRILLS.length };
}

const KEY = "lift-and-coast.school.v1";

export function loadSchoolDone(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(KEY) === "done";
  } catch {
    return false;
  }
}

export function saveSchoolDone(): void {
  try {
    window.localStorage.setItem(KEY, "done");
  } catch {
    // Non-fatal: the school can simply be run again.
  }
}
