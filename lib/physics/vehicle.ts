import type Rapier from "@dimforge/rapier3d-compat";
import type { RigidBody } from "@dimforge/rapier3d-compat";

export interface WheelLayout {
  /** Position of the wheel relative to the chassis center. */
  position: [number, number, number];
  radius: number;
  isSteering: boolean;
  isDriven: boolean;
}

// Forward is -Z (chase camera sits behind the car at +Z looking toward -Z).
// Front wheels (leading edge, -Z) steer; rear wheels (+Z) are driven.
export const CAR_WHEELS: WheelLayout[] = [
  { position: [-0.7, -0.35, -1.3], radius: 0.34, isSteering: true, isDriven: false },
  { position: [0.7, -0.35, -1.3], radius: 0.34, isSteering: true, isDriven: false },
  { position: [-0.7, -0.35, 1.3], radius: 0.34, isSteering: false, isDriven: true },
  { position: [0.7, -0.35, 1.3], radius: 0.34, isSteering: false, isDriven: true },
];

const SUSPENSION_REST_LENGTH = 0.3;

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
    controller.setWheelSuspensionStiffness(i, 24);
    controller.setWheelSuspensionCompression(i, 0.6);
    controller.setWheelSuspensionRelaxation(i, 0.7);
    controller.setWheelMaxSuspensionTravel(i, 0.35);
    controller.setWheelSideFrictionStiffness(i, 1.6);
    controller.setWheelFrictionSlip(i, 3);
  }

  return controller;
}

export interface CarControls {
  engineForce: number;
  brakeForce: number;
  steerAngle: number;
}

const MAX_STEER_ANGLE = 0.55;

export function applyCarControls(
  controller: Rapier.DynamicRayCastVehicleController,
  { throttle, brake, steer }: { throttle: number; brake: number; steer: number },
  maxEngineForce: number,
  maxBrakeForce: number
) {
  CAR_WHEELS.forEach((wheel, i) => {
    controller.setWheelEngineForce(i, wheel.isDriven ? throttle * maxEngineForce : 0);
    controller.setWheelBrake(i, brake * maxBrakeForce);
    controller.setWheelSteering(i, wheel.isSteering ? steer * MAX_STEER_ANGLE : 0);
  });
}
