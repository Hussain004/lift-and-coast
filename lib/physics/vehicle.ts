import type Rapier from "@dimforge/rapier3d-compat";
import type { RigidBody } from "@dimforge/rapier3d-compat";
import { Quaternion, Vector3 } from "three";
import { loadSensitivityScale } from "./tireModel";
import { aeroGripMultiplier, computeDragN, type AeroMode } from "./aero";

export interface WheelLayout {
  /** Position of the wheel relative to the chassis center. */
  position: [number, number, number];
  radius: number;
  isSteering: boolean;
  isDriven: boolean;
}

// Forward is -Z (chase camera sits behind the car at +Z looking toward -Z).
// Front wheels (leading edge, -Z) steer; rear wheels (+Z) are driven.
// Wheel track is widened close to the chassis edges and ride height kept
// low - a narrow, tall stance is what was flipping the car under braking,
// acceleration, and steering alike.
export const CAR_WHEELS: WheelLayout[] = [
  { position: [-0.82, -0.35, -1.3], radius: 0.34, isSteering: true, isDriven: false },
  { position: [0.82, -0.35, -1.3], radius: 0.34, isSteering: true, isDriven: false },
  { position: [-0.82, -0.35, 1.3], radius: 0.34, isSteering: false, isDriven: true },
  { position: [0.82, -0.35, 1.3], radius: 0.34, isSteering: false, isDriven: true },
];

const SUSPENSION_REST_LENGTH = 0.18;
// Lower than this project's original value of 30, so the chassis actually
// rolls visibly under cornering load instead of staying nearly flat. The
// stabilizing torque and angular damping turned out NOT to be the cause of
// the "glued to the road" feeling first reported - a headless sweep of both
// found tilt during hard cornering essentially unchanged whether the
// stabilizing torque was fully disabled or angular damping was cut from 6
// to 1. Lowering suspension stiffness is what actually moved it. At the
// original compression/relaxation below (0.6/0.7, tuned for stiffness 30)
// this was underdamped - see those constants for what that caused and how
// it was fixed. With damping corrected, this stiffness gives real but
// modest roll: about 0.066 rad in a moderate-steer cornering test versus
// about 0.036 rad at stiffness 30 with the same corrected damping - roughly
// 80% more, not the ~2x this comment previously claimed (that number
// included bounce). Verified safe across the full danger-scenario matrix
// (full-lock steer, ramped hard brake, boosted trail-braking, boosted
// low-drag hard steer) - all stayed well under half the 0.6 rad flip
// threshold. Lower still (tested down to 3) starts costing real
// traction/speed without adding more visible roll.
const SUSPENSION_STIFFNESS = 18;

// The rear wheels carry far more sustained load than the front under
// acceleration (weight transfer plus downforce), and at the shared travel
// limit of 0.22 they permanently bottom out under full throttle: traced via
// Rapier's per-wheel wheelSuspensionLength/wheelSuspensionForce, the rear
// suspension sits pinned at exactly restLength - maxTravel = -0.04 (its hard
// mechanical limit) from about 0.4s into any full-throttle run onward,
// generating 850-950N just to hold the car up - it needs to compress
// further to reach real equilibrium but has no room left. Being pinned at
// that limit is an unstable state in the raycast vehicle's force model: at
// real Silverstone speed on the actual track trimesh (not the idealized
// flat test plane this never showed up on), both rear wheels'
// wheelSuspensionForce would occasionally glitch to exactly 0 for 2-3
// consecutive steps while still reporting contact, and the sudden loss of
// ~1800N of rear support kicked the chassis pitch from +0.11 rad to -0.22
// rad in a single 1/60s step - this was the real cause of the
// "galloping"/"hood lifts up and it starts galloping like crazy" reports,
// not the camera (which was by then already lag-free and faithfully
// rendering this real physics glitch).
//
// Raising REAR stiffness instead was tried first and works for the kick,
// but it fights the cornering-roll tuning above (roll dropped from 0.066 to
// 0.036 rad at rear stiffness 30, below the 0.045 floor corneringRoll.test
// requires) since a stiffer rear resists lateral load transfer too, not
// just longitudinal. Giving the rear more TRAVEL instead leaves stiffness
// (and roll) untouched: at 0.5, sustained full throttle settles at a real
// equilibrium of -0.1677 (comfortably off the new -0.32 floor) and boosted
// Push-to-Pass throttle (1.6x, see energy.ts) at -0.2652 (also off the
// floor, ~0.055 margin) - both genuine equilibria confirmed by re-running at
// even more travel and seeing the same numbers, not still-clamped ones.
// Cornering roll stays at 0.0677 rad, close to this stiffness's original
// ~0.066-0.07 baseline. The wheel visual meshes don't move with suspension
// length (see Car.tsx - only steering and spin are animated), so the larger
// travel has no visual side effect.
const REAR_MAX_SUSPENSION_TRAVEL = 0.5;

// Single source of truth for chassis + tuning constants, shared by the
// real game (Car.tsx) and the headless stability harness (lib/ai/harness.ts)
// so both always simulate the exact same car.
export const CHASSIS_HALF_EXTENTS: [number, number, number] = [0.9, 0.4, 2];
export const CHASSIS_MASS = 220;
export const LINEAR_DAMPING = 0.05;
export const ANGULAR_DAMPING = 6;
// Real F1 cars do 0-100 km/h in ~2.5-2.6s, which this constant hits almost
// exactly (2.47-2.53s across measurements). This was lowered to 1100N for
// one session after 1450N's launch was reported as excessive ("the driving
// feel is so much force"), but that violence turned out to be the rear
// suspension bottoming out under load (see REAR_MAX_SUSPENSION_TRAVEL above)
// producing a real single-step chassis kick, not the acceleration itself -
// once that was fixed, 1450N was restored since the underlying complaint's
// actual cause was gone. Push-to-Pass's 1.6x boost (see energy.ts) does NOT
// apply directly to this constant - see BOOSTED_ENGINE_FORCE_CAP below.
//
// This is a single fixed force, not a real car's per-gear torque curve, so
// it can't also hit a real F1 0-200 time (~4.5-4.8s) - quadratic drag makes
// a fixed force taper harder as speed climbs while a real car shifts gears
// to stay near peak thrust past 200 km/h. Closing that gap needs a per-gear
// torque curve (plan section 5, depth feature 4: manual gears), which is
// future work, not a change to this constant.
//
// Stability re-verified at 1450N: a straight-line 15s full-throttle sweep
// shows no instability (well under the 0.6 rad flip threshold). Braking, not
// throttle, is the tighter constraint on how high this can go (instantly
// slamming full brake after building speed pitches the chassis past the
// flip threshold well before a throttle cliff does - see
// BRAKE_RAMP_SECONDS in useDriveInput.ts, and the "realistic (ramped) brake
// input" test in vehicle-stability-track.test.ts). Any future increase to
// this constant must be re-verified against both that braking scenario and
// the felt launch aggression, not just raw stability.
export const DEFAULT_ENGINE_FORCE = 1450;

// Push-to-Pass's 1.6x boost (see energy.ts) applied directly to
// DEFAULT_ENGINE_FORCE would be 2320N - well past a stability cliff found by
// sweeping cold-start force against airborne time on the real track: 1760N
// recovers in 1.1s/0.13 rad, 1900N spirals into a sustained wheelie (front
// wheels lose contact for 3.65s, pitch past 0.5 rad and not recovering).
// A single fixed force can't hit both a real F1 0-100 (~2.5s, needs 1450N)
// and 0-200 time (~4.5-4.8s, needs a per-gear torque curve this game
// doesn't have) - closing that second gap is future work (plan section 5,
// depth feature 4: manual gears), not something to force out of this one
// constant. Capping the boosted force here keeps boost safe in the
// meantime while still giving it a real, felt kick over unboosted driving.
export const BOOSTED_ENGINE_FORCE_CAP = 1750;
export const DEFAULT_BRAKE_FORCE = 40;
export const DEFAULT_STABILIZE_STRENGTH = 30;
// Snap back to the start line past this distance off-track - see the usage
// site (Car.tsx, and the harness below) for why.
//
// Originally 300, but that was calibrated when DEFAULT_ENGINE_FORCE was
// 250: at 850N, a player just holding throttle in a straight line (no spin,
// no mistake) covers 300m off the track's own curvature in about 16s -
// reported as a "twitch" (a jarring reset: position/velocity snap to zero,
// pitch snaps flat, then dives again as it re-accelerates from a stop) on
// every normal test-drive, not just genuine spin-off recovery. Re-measured
// the real crash boundary at 850N by disabling the guard: still position-
// based, not speed-based, so it lands at roughly the same place as before -
// safe through 1183m off-track (36s), crashes by ~1200m (37s). 700 keeps
// about 40% margin below that while giving a normal straight-line test
// (even a deliberate "how fast does this go" run) 20+ seconds before it
// intervenes, only catching genuinely extended off-course driving.
export const OFF_TRACK_RESET_METERS = 700;

// Backstop for a case OFF_TRACK_RESET_METERS alone can miss: that guard
// measures distance from the nearest point on the track's own ribbon, which
// stays fixed once a car drives past the far end of the track's extent - so
// a car continuing in roughly the direction the track was already heading
// can reach the finite grass plane's actual edge (a fixed 1250m half-extent
// in both Scene.tsx and the harness, independent of engine force) while
// still reading well under OFF_TRACK_RESET_METERS off the ribbon. Found via
// exactly this failure after raising DEFAULT_ENGINE_FORCE: a cycling-steer
// scenario crossed the real grass edge and fell into unbounded freefall (the
// same NaN-inducing failure as leaving any finite ground plane) while its
// ribbon-relative off-track distance was still under 700m. This checks
// absolute distance from the origin directly - a backstop independent of
// track shape or heading, with real margin below the actual 1250m edge.
export const WORLD_EDGE_RESET_METERS = 1150;

/**
 * Builds a DynamicRayCastVehicleController on top of an existing chassis
 * rigid body, wired to the CAR_WHEELS layout (indices line up 1:1).
 */
export function createCarController(
  RAPIER: typeof Rapier,
  world: Rapier.World,
  chassis: RigidBody
) {
  const controller = world.createVehicleController(chassis);

  CAR_WHEELS.forEach((wheel) => {
    controller.addWheel(
      new RAPIER.Vector3(...wheel.position),
      new RAPIER.Vector3(0, -1, 0),
      new RAPIER.Vector3(1, 0, 0),
      SUSPENSION_REST_LENGTH,
      wheel.radius
    );
  });

  for (let i = 0; i < CAR_WHEELS.length; i++) {
    controller.setWheelSuspensionStiffness(i, SUSPENSION_STIFFNESS);
    // These were 0.6/0.7 (tuned for stiffness 30) until dropping stiffness
    // to 18 without raising them left the suspension underdamped: a
    // per-frame trace under a throttle boost showed pitch overshoot then
    // spring back (e.g. dive to -0.11 rad, recover to -0.05, both within
    // half a second) - reported by a real player as the car "leaning
    // towards the front and backwards" under boost. Raised in step with the
    // lower stiffness until that overshoot-and-recover pattern disappeared
    // from the trace (it settles smoothly now, no spring-back). Doing this
    // also reduced the peak cornering-roll numbers measured while tuning
    // SUSPENSION_STIFFNESS above, since a real chunk of that peak had been
    // the bounce itself, not settled lean.
    controller.setWheelSuspensionCompression(i, 1.8);
    controller.setWheelSuspensionRelaxation(i, 2.0);
    controller.setWheelMaxSuspensionTravel(
      i,
      CAR_WHEELS[i].isDriven ? REAR_MAX_SUSPENSION_TRAVEL : 0.22
    );
    // Values above 1.0 amplify lateral impulses and are a known flip
    // trigger in Bullet-derived raycast vehicles - keep this at 1.0.
    controller.setWheelSideFrictionStiffness(i, 1.0);
    controller.setWheelFrictionSlip(i, 3);
  }

  return controller;
}

export const BASE_FRICTION_SLIP = 3;
export const BASE_SIDE_FRICTION_STIFFNESS = 1.0;
// Static per-wheel load: total weight over 4 wheels, evenly (no front/rear
// bias modeled). Used only as the reference point for load-sensitivity
// scaling below, not as an authoritative weight-transfer figure - Rapier's
// own suspension already simulates real per-wheel load via
// wheelSuspensionForce, which is what gets compared against this.
export const STATIC_WHEEL_LOAD_N = (CHASSIS_MASS * 9.81) / 4;

/**
 * Plan section 5's tire load sensitivity ("grip doesn't scale linearly with
 * load"), applied to the two friction parameters Rapier's raycast vehicle
 * actually exposes, using its own simulated per-wheel suspension force as
 * the normal load - real weight transfer, not a separate estimate. A more
 * loaded wheel (e.g. the outside wheel mid-corner, or the front axle under
 * braking) gets comparatively less grip per unit load than a lightly
 * loaded one, which is what makes trail-braking and throttle modulation
 * matter instead of grip just being free.
 *
 * sideFrictionStiffness is capped at its existing safe ceiling
 * (BASE_SIDE_FRICTION_STIFFNESS) rather than ever scaled upward - that
 * value is a documented flip trigger above 1.0, and a lightly loaded wheel
 * would otherwise get pushed past it.
 *
 * Also applies the active-aero grip multiplier (aeroGripMultiplier) - a
 * direct mechanical-grip penalty for low-drag mode, since the
 * downforce->load coupling above is negligible at cornering speeds (see
 * aero.ts). Both scales only ever multiply below 1x on top of each other,
 * so the sideFrictionStiffness safety ceiling still holds.
 */
export function applyLoadSensitiveFriction(
  controller: Rapier.DynamicRayCastVehicleController,
  aeroMode: AeroMode = "high-downforce"
) {
  const gripScale = aeroGripMultiplier(aeroMode);
  for (let i = 0; i < CAR_WHEELS.length; i++) {
    const loadN = controller.wheelSuspensionForce(i) ?? STATIC_WHEEL_LOAD_N;
    const scale = loadSensitivityScale(loadN, STATIC_WHEEL_LOAD_N) * gripScale;
    controller.setWheelFrictionSlip(i, BASE_FRICTION_SLIP * scale);
    controller.setWheelSideFrictionStiffness(
      i,
      Math.min(BASE_SIDE_FRICTION_STIFFNESS, BASE_SIDE_FRICTION_STIFFNESS * scale)
    );
  }
}

export interface CarControls {
  engineForce: number;
  brakeForce: number;
  steerAngle: number;
}

const MAX_STEER_ANGLE = 0.45;

// A binary keyboard press commands full lock instantly - fine standing
// still, way too much at speed (plan section 5: "speed-sensitive max
// lock"). Scale steer angle down between these speeds, floored so the car
// stays steerable rather than becoming unresponsive at top speed.
const STEER_FULL_LOCK_SPEED_MS = 8;
const STEER_MIN_LOCK_SPEED_MS = 45;
const STEER_MIN_SCALE = 0.35;

export function speedSensitiveSteerScale(speedMs: number): number {
  const speed = Math.abs(speedMs);
  if (speed <= STEER_FULL_LOCK_SPEED_MS) return 1;
  if (speed >= STEER_MIN_LOCK_SPEED_MS) return STEER_MIN_SCALE;
  const t =
    (speed - STEER_FULL_LOCK_SPEED_MS) /
    (STEER_MIN_LOCK_SPEED_MS - STEER_FULL_LOCK_SPEED_MS);
  return 1 - t * (1 - STEER_MIN_SCALE);
}

const STABILIZE_MIN_TILT_RAD = 0.05;

/**
 * ponytail: the raycast suspension has no explicit weight-transfer model,
 * so a wheel that tops out under hard acceleration or steering just stays
 * off the ground with nothing pulling it back down - a real wheelie/flip,
 * not a bug. This applies a corrective torque toward upright, proportional
 * to tilt, as a stopgap until proper weight transfer exists (plan section
 * 5, depth feature 1).
 */
export function computeStabilizingTorque(
  quaternion: { x: number; y: number; z: number; w: number },
  strength: number
): [number, number, number] {
  const worldUp = new Vector3(0, 1, 0);
  const bodyUp = new Vector3(0, 1, 0).applyQuaternion(
    new Quaternion(quaternion.x, quaternion.y, quaternion.z, quaternion.w)
  );
  const tilt = bodyUp.angleTo(worldUp);
  if (tilt < STABILIZE_MIN_TILT_RAD) return [0, 0, 0];

  const axis = new Vector3().crossVectors(bodyUp, worldUp);
  if (axis.lengthSq() < 1e-8) return [0, 0, 0];
  axis.normalize().multiplyScalar(strength * tilt);
  return [axis.x, axis.y, axis.z];
}

/**
 * Aerodynamic drag opposing the chassis's actual horizontal velocity vector
 * (not just forward speed), so it slows sliding as well as driving. Shared
 * between Car.tsx and the headless harness so both simulate the same car.
 */
export function applyDragImpulse(
  body: RigidBody,
  mode: AeroMode,
  timestep: number
) {
  const v = body.linvel();
  const speed = Math.hypot(v.x, v.z);
  if (speed < 0.01) return;
  const dragN = computeDragN(speed, mode);
  const scale = (dragN * timestep) / speed;
  body.applyImpulse({ x: -v.x * scale, y: 0, z: -v.z * scale }, true);
}

export function applyCarControls(
  controller: Rapier.DynamicRayCastVehicleController,
  { throttle, brake, steer }: { throttle: number; brake: number; steer: number },
  baseEngineForce: number,
  boostMultiplier: number,
  maxBrakeForce: number,
  currentSpeedMs: number
) {
  const steerAngle = steer * MAX_STEER_ANGLE * speedSensitiveSteerScale(currentSpeedMs);
  const engineForce = Math.min(baseEngineForce * boostMultiplier, BOOSTED_ENGINE_FORCE_CAP);
  CAR_WHEELS.forEach((wheel, i) => {
    controller.setWheelEngineForce(i, wheel.isDriven ? throttle * engineForce : 0);
    controller.setWheelBrake(i, brake * maxBrakeForce);
    controller.setWheelSteering(i, wheel.isSteering ? steerAngle : 0);
  });
}
