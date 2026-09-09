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

// Single source of truth for chassis + tuning constants, shared by the
// real game (Car.tsx) and the headless stability harness (lib/ai/harness.ts)
// so both always simulate the exact same car.
export const CHASSIS_HALF_EXTENTS: [number, number, number] = [0.9, 0.4, 2];
export const CHASSIS_MASS = 220;
export const LINEAR_DAMPING = 0.05;
export const ANGULAR_DAMPING = 6;
export const DEFAULT_ENGINE_FORCE = 250;
export const DEFAULT_BRAKE_FORCE = 40;
export const DEFAULT_STABILIZE_STRENGTH = 30;
// Snap back to the start line past this distance off-track - see the usage
// site (Car.tsx, and the harness below) for why.
export const OFF_TRACK_RESET_METERS = 300;

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
    controller.setWheelSuspensionStiffness(i, 30);
    controller.setWheelSuspensionCompression(i, 0.6);
    controller.setWheelSuspensionRelaxation(i, 0.7);
    controller.setWheelMaxSuspensionTravel(i, 0.22);
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
  maxEngineForce: number,
  maxBrakeForce: number,
  currentSpeedMs: number
) {
  const steerAngle = steer * MAX_STEER_ANGLE * speedSensitiveSteerScale(currentSpeedMs);
  CAR_WHEELS.forEach((wheel, i) => {
    controller.setWheelEngineForce(i, wheel.isDriven ? throttle * maxEngineForce : 0);
    controller.setWheelBrake(i, brake * maxBrakeForce);
    controller.setWheelSteering(i, wheel.isSteering ? steerAngle : 0);
  });
}
