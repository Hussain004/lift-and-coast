import type Rapier from "@dimforge/rapier3d-compat";
import type { RigidBody } from "@dimforge/rapier3d-compat";
import { Quaternion, Vector3 } from "three";
import { loadSensitivityScale } from "./tireModel";
import { aeroGripMultiplier, computeDragN, type AeroMode } from "./aero";
import {
  engineTorqueMultiplier,
  gearThrustFactor,
  rpmForGear,
  updateGearbox,
  type GearboxState,
} from "./gearbox";

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

/**
 * The four wheels' ground-plane positions (x, z) in CAR_WHEELS order, for the
 * surface sampler (lib/tracks/surfaces.ts) and the all-four-wheels-off check.
 * Suspension travel is ignored: a wheel is classified by where its contact
 * patch is, and up to ~0.25m of travel is immaterial against a 7-18m track
 * width, whereas reading every wheel's live suspension length back out of the
 * controller each step is not free. Shared by Car.tsx, AICar.tsx and the
 * headless harness so all three classify the same four points.
 */
export function wheelGroundPositions(body: RigidBody): { x: number; z: number }[] {
  const t = body.translation();
  const r = body.rotation();
  const rotation = new Quaternion(r.x, r.y, r.z, r.w);
  return CAR_WHEELS.map((wheel) => {
    const local = new Vector3(...wheel.position).applyQuaternion(rotation);
    return { x: t.x + local.x, z: t.z + local.z };
  });
}

export const SUSPENSION_REST_LENGTH = 0.18;
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

// Front wheels pin at their mechanical floor under sustained high-speed
// downforce + braking weight transfer: with only 0.22 travel the floor sits
// at 0.18 - 0.22 = -0.04 length, and the front needs ~0.9-1.0kN of support
// there, so it rests ON the hard floor instead of reaching a force-balance
// equilibrium. That is the same "pinned at the mechanical limit" state the
// rear had before REAR_MAX_SUSPENSION_TRAVEL fixed it (force calc glitches
// to 0 for a step and kicks the chassis pitch); on the front it additionally
// rides the body low enough (~y 0.57) that the chassis cuboid nose scrapes
// the trimesh at ~50 m/s, which the per-wheel telemetry diagnostic proved to
// be the AI flip mechanism (see tests/aiTelemetry.test.ts and memory
// [[lift_and_coast_ai_flip_nose_scrape]]).
//
// The fix is the SAME direction as the rear: give the front enough travel
// (0.5) that it reaches a real equilibrium instead of bottoming out. The
// front's force-balance point (~0.23 compression) is only just past the old
// 0.22 stop, so ride height barely moves - what changes is the hard floor
// disappearing, along with the stop-impact pitch kicks that drive the nose
// into the track. Directionally symmetric with the rear fix; verified at
// 150s on both the baseline and the failing cross-track-gain perturbation.
const FRONT_MAX_SUSPENSION_TRAVEL = 0.5;

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
// to stay near peak thrust past 200 km/h. This constant is now the per-gear
// torque curve's BASE force: gearbox.ts multiplies it by a torque curve
// over rpm (plan section 5, depth feature 4: manual gears), peaking at
// exactly this value in 1st gear so the validated launch feel is preserved.
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
// and 0-200 time (~4.5-4.8s) - the per-gear torque curve that closes that
// second gap now exists (gearbox.ts, plan section 5 depth feature 4), with
// this same 1450N as its curve's peak, so it stays a ceiling concern only.
// Capping the boosted force here keeps boost safe in the meantime while
// still giving it a real, felt kick over unboosted driving.
export const BOOSTED_ENGINE_FORCE_CAP = 1750;
// Peak brake torque per wheel, shared evenly front/rear. Swept 10/15/20/25/40
// against instant full brake from top speed (~62 m/s) on the flat plane, in
// both aero modes, measuring peak decel, max pitch, and rear-both-airborne
// steps (the player's "the back lifts up" report: with ABS on, braking from
// high speed held the rear off the ground for 0.88s continuous at 0.19 rad;
// ABS-off flipped outright at maxTilt 1.03):
//   40: 3.1-4.6g, rear airborne up to 44% of braking (4.9s worst run in
//       low-drag), flips - the old value, far past the lockup cliff.
//   25: 2.1-2.6g, ZERO rear-airborne steps in high-downforce (instant and
//       ramped, 40 and 62 m/s entries), tilt <= 0.13; low-drag keeps only
//       scattered steps (worst 0.3s continuous) at tilt <= 0.15, 4x under
//       the flip threshold.
//   20: anomalous - worse than 25 at high speed (48 rear-airborne steps).
//       Lockup dynamics near the threshold are non-monotonic, so this value
//       sits where measured, not where interpolated.
//   15 and below: clean but stops stretch toward 50m+ from 40 m/s.
// Stops from 40 m/s take 39m at 25 vs 33m at 40 - still very strong
// brakes, just no longer strong enough to pole-vault the car.
// Front brake bias was tried as the textbook alternative (0.6-0.7 front):
// it made things strictly worse (near-flips at 0.59 rad where 50/50 is
// clean), because in this tire model the pitch torque follows front-axle
// force - loading the axle that already carries the transferred weight
// overloads it. Even split stays.
export const DEFAULT_BRAKE_FORCE = 25;
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
// can run off the finite grass entirely while still reading well under
// OFF_TRACK_RESET_METERS off the ribbon. Found via exactly this failure after
// raising DEFAULT_ENGINE_FORCE: a cycling-steer scenario crossed the real
// grass edge and fell into unbounded freefall (the same NaN-inducing failure
// as leaving any finite ground plane) while its ribbon-relative off-track
// distance was still under 700m. This checks absolute distance from the
// origin directly - a backstop independent of track shape or heading - and
// the grass field is sized from this same radius plus
// TERRAIN_OUTER_MARGIN_METERS (see lib/tracks/terrain.ts), so the reset
// always fires while the car is still standing on ground.
export const WORLD_EDGE_RESET_METERS = 1150;

/**
 * How far past the circuit's own furthest point the world-edge backstop
 * above is allowed to sit. Some circuits are larger than
 * WORLD_EDGE_RESET_METERS from their own projection origin - Monza's
 * centerline reaches 1217m - and the old fixed radius teleported the car
 * back to the start line part way around them (verified in the harness:
 * Monza's AI never completed a lap, it was reset at a legitimate corner
 * every time; the per-track gate never noticed because it only checks
 * distance travelled, which the resets don't subtract). See
 * worldEdgeResetMeters in trackLimits.ts, which is what Scene.tsx and the
 * harness actually call.
 */
export const TRACK_EDGE_MARGIN_METERS = 150;

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
      CAR_WHEELS[i].isDriven ? REAR_MAX_SUSPENSION_TRAVEL : FRONT_MAX_SUSPENSION_TRAVEL
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
 * aero.ts) - tire compound degradation (compoundGripMultiplier, see
 * computeCompoundGripMultiplier in tireModel.ts), surface grip
 * (surfaceGripMultiplier, see the surface zones in lib/tracks/surfaces.ts),
 * and impact damage (damageGripMultiplier, see applyImpactDamage in
 * damage.ts), each defaulting to 1 (fresh tire, on track, undamaged - no
 * change from before these parameters existed). All five scales only ever
 * multiply below 1x on top of each other, so the sideFrictionStiffness
 * safety ceiling still holds no matter how worn the tires are, how far
 * off-track the car has gone, or how damaged it is.
 *
 * surfaceGripMultiplier accepts either one scale for the whole car (the
 * chassis-center approximation this used before per-wheel surfaces existed)
 * or one per wheel in CAR_WHEELS order. Per-wheel is what the live game and
 * the harness both pass now: a wheel on a kerb, in grass, or in a gravel trap
 * loses grip on its own, which is what makes running wide with one side
 * unsettle the car instead of merely slowing it. Keep every entry <= 1.
 */
export function applyLoadSensitiveFriction(
  controller: Rapier.DynamicRayCastVehicleController,
  aeroMode: AeroMode = "high-downforce",
  compoundGripMultiplier: number = 1,
  surfaceGripMultiplier: number | readonly number[] = 1,
  damageGripMultiplier: number = 1
) {
  const sharedGripScale =
    aeroGripMultiplier(aeroMode) *
    compoundGripMultiplier *
    damageGripMultiplier;
  for (let i = 0; i < CAR_WHEELS.length; i++) {
    const surfaceScale =
      typeof surfaceGripMultiplier === "number"
        ? surfaceGripMultiplier
        : (surfaceGripMultiplier[i] ?? 1);
    const gripScale = sharedGripScale * surfaceScale;
    const loadN = controller.wheelSuspensionForce(i) ?? STATIC_WHEEL_LOAD_N;
    const scale = loadSensitivityScale(loadN, STATIC_WHEEL_LOAD_N) * gripScale;
    controller.setWheelFrictionSlip(i, BASE_FRICTION_SLIP * scale);
    controller.setWheelSideFrictionStiffness(
      i,
      Math.min(BASE_SIDE_FRICTION_STIFFNESS, BASE_SIDE_FRICTION_STIFFNESS * scale)
    );
  }
}

/**
 * Emulates a wheel riding up onto a raised kerb, in CAR_WHEELS order, as a
 * per-wheel ride height in meters (0 for a wheel not on a kerb).
 *
 * A raised kerb is a real surface height change, but it is *not* modelled as
 * collider geometry: a kerb strip is an overlapping collider that meets the
 * ribbon at one edge and the grass field at the other, and this project has
 * already been bitten once by a 5cm step between two overlapping ground
 * colliders (see GRASS_BELOW_TRACK_METERS in lib/tracks/mesh.ts - a raycast
 * wheel ping-pongs between them and the car twitches). Shortening the
 * suspension's rest length instead raises the chassis by exactly that much
 * with no collider change at all, no raycast ambiguity, and no energy
 * injection - it is a position input, so it cannot flip the car the way a
 * vertical impulse can.
 *
 * It is deliberately called every step with the sample's own rise (0 when
 * off a kerb), so a wheel that leaves a kerb is restored in the same step.
 */
export function applyKerbRideHeights(
  controller: Rapier.DynamicRayCastVehicleController,
  rises: readonly number[]
) {
  for (let i = 0; i < CAR_WHEELS.length; i++) {
    controller.setWheelSuspensionRestLength(i, SUSPENSION_REST_LENGTH - (rises[i] ?? 0));
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

// Plan section 5, depth feature 5: traction control as a difficulty/assist
// toggle, defaulting ON (the plan's "off by default on Pro" refers to a
// difficulty tier that doesn't exist yet - on is the right default until
// it does). Gated on actual steering input, not just low speed: real
// wheelspin-related instability in this project only shows up as power-on
// oversteer during corner exit, and this project's raycast wheels don't
// model true slip-based wheelspin on a straight line at all - a cap that
// fired on every launch would silently slow the already-tuned, verified
// straight-line 0-100 time (2.47s) for zero benefit, since there's no
// wheelspin to correct there. Below TC_STEER_THRESHOLD (near dead-center
// steering), this always returns 1 - a pure straight-line launch is
// completely unaffected by this toggle regardless of speed.
const TC_STEER_THRESHOLD = 0.15;
const TC_LOW_SPEED_MS = 15;
const TC_MIN_THROTTLE_SCALE = 0.7;

export function tractionControlThrottleScale(
  speedMs: number,
  steer: number,
  enabled: boolean
): number {
  if (!enabled || Math.abs(steer) < TC_STEER_THRESHOLD) return 1;
  const speed = Math.abs(speedMs);
  if (speed >= TC_LOW_SPEED_MS) return 1;
  const t = speed / TC_LOW_SPEED_MS;
  return TC_MIN_THROTTLE_SCALE + t * (1 - TC_MIN_THROTTLE_SCALE);
}

/**
 * Yaw-only heading extracted from a quaternion, ignoring pitch/roll - the
 * same formula Scene.tsx's ChaseCamera uses for its own yaw-only chase/
 * cockpit follow, and the convention track data's startPos.headingRad
 * matches (see computeSectorGates's own comment, and CAR_WHEELS' layout
 * above: forward is -Z at yaw 0). Shared so the camera and anything else
 * that needs heading (e.g. the minimap) can't drift apart into two
 * independently-typo'd copies of the same atan2 formula.
 */
export function yawFromQuaternion(x: number, y: number, z: number, w: number): number {
  return Math.atan2(2 * (w * y + x * z), 1 - 2 * (y * y + z * z));
}

/**
 * A reliable, signed "forward speed" (positive = moving forward, negative =
 * reversing), computed directly from linear velocity and heading. Use it
 * wherever a *signed* speed is consumed as a control input - the AI's
 * target-speed following (pathFollower.ts), AICar.tsx, and the harness's own
 * DriveState / reported final speed. Rapier's controller.currentVehicleSpeed()
 * intermittently reports the wrong SIGN at sustained high speed on the real
 * trimesh (magnitude stays correct), found via a 10s+ full-throttle headless
 * run (see tests/aiOpponent.test.ts) and confirmed against the chassis's raw
 * linear velocity, which stayed smooth while the reported speed flipped sign
 * every few frames.
 *
 * The player's own Car.tsx call sites deliberately still read the raw
 * controller.currentVehicleSpeed(): every consumer there takes Math.abs or
 * squares it (speedSensitiveSteerScale, tractionControlThrottleScale,
 * rpmForGear/updateGearbox, computeDownforceN, the km/h HUD, tire-wear
 * distance), so a wrong sign cannot reach the control path.
 * tests/speedSignInsensitivity.test.ts guards that property. This helper is
 * for signed consumers only, and is never what drives the wheels.
 */
export function computeSignedForwardSpeed(
  linvel: { x: number; z: number },
  yawRad: number
): number {
  const forwardX = -Math.sin(yawRad);
  const forwardZ = -Math.cos(yawRad);
  return linvel.x * forwardX + linvel.z * forwardZ;
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
 * Spin damping for AI cars (see AICar.tsx): the stabilizing torque above
 * only rights TILT - a side contact leaves yaw spinning freely, which is
 * how a bumped AI ends up broadside with the car behind driving into its
 * flank. This is a yaw-only damper that stays completely inert through
 * normal driving: a car pulling 1.2g at 60 m/s corners at ~1.5 rad/s and a
 * hairpin turn-in peaks near 1.9, so the threshold sits above both, and
 * only the rates a genuine contact (or a spin) produces are damped. The
 * torque ramps from the threshold to SPIN_DAMPING_STRENGTH over the next
 * 1.5 rad/s and is capped there, so a flick can never fight a real slide
 * harder than a fixed ceiling.
 */
const SPIN_DAMPING_THRESHOLD_RAD_S = 2.2;
const SPIN_DAMPING_FULL_RAD_S = 3.7;
const SPIN_DAMPING_STRENGTH = 900;

export function resolveYawDampingTorque(angvelY: number): number {
  const magnitude = Math.abs(angvelY);
  if (magnitude <= SPIN_DAMPING_THRESHOLD_RAD_S) return 0;
  const ramp = Math.min(
    1,
    (magnitude - SPIN_DAMPING_THRESHOLD_RAD_S) /
      (SPIN_DAMPING_FULL_RAD_S - SPIN_DAMPING_THRESHOLD_RAD_S)
  );
  return -Math.sign(angvelY) * ramp * SPIN_DAMPING_STRENGTH;
}

/**
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

/**
 * Speed-proportional drag for whatever surface the car is standing on,
 * separate from the aero drag above because the two have nothing to do with
 * each other: aero drag is a function of body speed and aero mode, this is a
 * function of grip surface. `dragCoefficient` is N per (m/s) - see
 * lib/tracks/surfaces.ts for grass's and gravel's values, and its own comment
 * for why gravel's is large enough to actually bog the car. Takes the mean
 * over the four wheels, so a car with one wheel in a trap is dragged a
 * quarter as hard as one fully in it.
 */
export function applySurfaceDragImpulse(
  body: RigidBody,
  dragCoefficient: number,
  timestep: number
) {
  if (dragCoefficient <= 0) return;
  const v = body.linvel();
  const speed = Math.hypot(v.x, v.z);
  if (speed < 0.01) return;
  const dragN = dragCoefficient * speed;
  const scale = (dragN * timestep) / speed;
  body.applyImpulse({ x: -v.x * scale, y: 0, z: -v.z * scale }, true);
}

/**
 * Optional gearbox wiring for applyCarControls (plan section 5, depth
 * feature 4: manual gears, implemented in gearbox.ts). `state` is mutated
 * in place every call so the caller's gear selection persists across ticks.
 */
export interface GearboxControl {
  state: GearboxState;
  /** Edge-triggered shift-up request (manual mode only - see gearbox.ts). */
  shiftUp: boolean;
  /** Edge-triggered shift-down request (manual mode only - see gearbox.ts). */
  shiftDown: boolean;
}

export function applyCarControls(
  controller: Rapier.DynamicRayCastVehicleController,
  { throttle, brake, steer }: { throttle: number; brake: number; steer: number },
  baseEngineForce: number,
  boostMultiplier: number,
  maxBrakeForce: number,
  currentSpeedMs: number,
  tractionControlEnabled: boolean,
  // Plan section 5 depth feature 4 (manual gears): when given, the engine's
  // fixed base force becomes a per-gear torque curve (see gearbox.ts) - the
  // gearbox state is mutated here so the caller's gear selection persists
  // across ticks, and the resulting force never exceeds the same
  // BOOSTED_ENGINE_FORCE_CAP ceiling (peak thrust in 1st at peak torque is
  // exactly baseEngineForce). When omitted, behaves exactly as before the
  // gearbox existed - the legacy flat-force model.
  gearbox?: GearboxControl
) {
  const steerAngle = steer * MAX_STEER_ANGLE * speedSensitiveSteerScale(currentSpeedMs);
  let engineForce = Math.min(baseEngineForce * boostMultiplier, BOOSTED_ENGINE_FORCE_CAP);
  if (gearbox) {
    updateGearbox(gearbox.state, {
      speedMs: currentSpeedMs,
      shiftUp: gearbox.shiftUp,
      shiftDown: gearbox.shiftDown,
    });
    const rpm = rpmForGear(currentSpeedMs, gearbox.state.gear);
    engineForce = Math.min(
      baseEngineForce * boostMultiplier * engineTorqueMultiplier(rpm) * gearThrustFactor(gearbox.state.gear),
      BOOSTED_ENGINE_FORCE_CAP
    );
  }
  const throttleScale = tractionControlThrottleScale(currentSpeedMs, steer, tractionControlEnabled);
  CAR_WHEELS.forEach((wheel, i) => {
    controller.setWheelEngineForce(i, wheel.isDriven ? throttle * throttleScale * engineForce : 0);
    controller.setWheelBrake(i, brake * maxBrakeForce);
    controller.setWheelSteering(i, wheel.isSteering ? steerAngle : 0);
  });
}
