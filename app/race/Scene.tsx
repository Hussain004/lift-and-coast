"use client";

import { useRef } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Physics, RigidBody, type RapierRigidBody } from "@react-three/rapier";
import { Car } from "./Car";
import { Track } from "./Track";
import silverstone from "@/data/tracks/silverstone.json";
import type { TrackData } from "@/lib/tracks/types";
import { GRASS_BELOW_TRACK_METERS } from "@/lib/tracks/mesh";
import type { CameraMode } from "@/lib/input/useDriveInput";
import type { MinimapProjection } from "@/lib/tracks/minimap";

const track = silverstone as TrackData;

// Half of the box geometry's height below (see GRASS_BELOW_TRACK_METERS for
// why the ground surface isn't flush with the track trimesh).
const GROUND_HALF_HEIGHT = 0.5;

function Ground() {
  return (
    <RigidBody
      type="fixed"
      colliders="cuboid"
      friction={0.6}
      position={[0, -(GROUND_HALF_HEIGHT + GRASS_BELOW_TRACK_METERS), 0]}
    >
      <mesh receiveShadow>
        <boxGeometry args={[2500, GROUND_HALF_HEIGHT * 2, 2500]} />
        <meshStandardMaterial color="#2b2b2b" />
      </mesh>
    </RigidBody>
  );
}

// Chase: classic third-person, camera behind and above looking at the car
// (plan section 9). Cockpit: camera near the driver's seat looking ahead
// along the car's own heading, for the "steep FOV... speed sensation" feel
// the plan calls for - a wider FOV than chase makes the same speed read as
// faster, the standard cockpit-cam trick.
const CHASE_OFFSET = new THREE.Vector3(0, 2.2, 7);
const COCKPIT_OFFSET = new THREE.Vector3(0, 0.65, -0.3);
const CHASE_FOV = 65;
const COCKPIT_FOV = 85;

// A plain helper (not inlined at the call site) so the mutation below isn't
// a direct assignment to a property of the value useThree() returns, which
// the React Compiler's lint rule flags even though mutating the live
// camera instance in place is the standard, correct R3F way to change FOV
// at runtime (there's no reactive prop for it - Canvas's own `camera` prop
// only sets the INITIAL fov).
function setPerspectiveFov(camera: THREE.Camera, fov: number) {
  if (camera instanceof THREE.PerspectiveCamera && camera.fov !== fov) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }
}

function ChaseCamera({
  target,
  cameraMode,
}: {
  target: React.RefObject<THREE.Object3D | null>;
  cameraMode: React.RefObject<CameraMode>;
}) {
  const { camera } = useThree();
  const desiredPos = useRef(new THREE.Vector3(0, 3, 8));
  const lookAt = useRef(new THREE.Vector3());
  const offset = useRef(new THREE.Vector3());
  const forward = useRef(new THREE.Vector3());
  const worldPos = useRef(new THREE.Vector3());
  const worldQuat = useRef(new THREE.Quaternion());

  useFrame((_, dt) => {
    const object = target.current;
    if (!object) return;
    const mode = cameraMode.current;
    // Reads the chassis MESH's own interpolated world transform (see
    // visualRef in Car.tsx), not the raw physics body. react-three-rapier
    // smooths each RigidBody's rendered object between physics steps
    // (Physics defaults to interpolate: true) for visual stability at any
    // render framerate, but the raw rigid body always reports the latest
    // completed physics step - a camera built from the raw body disagreed
    // with what was actually on screen by up to one physics step's worth
    // of motion, on every render frame that didn't land exactly on a step
    // boundary. That gap is proportional to speed - invisible standing
    // still, worse the faster the car goes - which matches the reported
    // "galloping"/"steering out on its own" far better than anything
    // tried before: present even driving dead straight, a slight twitch
    // in high-downforce, much worse in low-drag (its higher top speed),
    // and impossible to reproduce in this project's headless harness,
    // which has no rendering pipeline and so no interpolation to disagree
    // with in the first place.
    object.getWorldPosition(worldPos.current);
    object.getWorldQuaternion(worldQuat.current);
    const t = worldPos.current;
    const r = worldQuat.current;
    // Yaw only - a chase camera rigidly following the chassis's full
    // rotation amplifies every bit of pitch/roll (suspension squat, kerb
    // bump, cornering lean) into a much larger swing of camera position,
    // since the offset arm is several meters long. A ~2 degree chassis
    // pitch under throttle was reading as a dramatic lurch in the view.
    const yaw = Math.atan2(
      2 * (r.w * r.y + r.x * r.z),
      1 - 2 * (r.y * r.y + r.z * r.z)
    );

    // Same offset-then-rotate-then-add-to-t construction for both modes -
    // only the offset vector and lookAt target differ. Position is NOT
    // smoothed in either mode - it snaps directly every frame. A
    // first-order lag filter (lerp toward a moving target at a fixed rate)
    // settles at a steady-state distance BEHIND the target of
    // speed * timeConstant - i.e. exponential position smoothing makes the
    // camera trail further back the faster the car goes, and catch up the
    // instant it slows. That produced a real, continuous zoom-out/zoom-in
    // tied to every acceleration/deceleration (confirmed by measuring the
    // car's on-screen size across a recording: it shrank monotonically
    // with speed, from a 213px bounding box at 11 km/h down to ~80px at
    // 170 km/h), which through a chase camera reads exactly like the
    // original "galloping"/"steering out on its own" bug report - worse
    // after a turn (biggest speed swings), worse in low-drag (higher top
    // speed), and invisible to any headless test, since none of them run
    // a camera. desiredPos is already derived from the mesh's own
    // interpolated transform (see above), so it doesn't need a second
    // smoothing pass on top of that for stability - and neither does the
    // look-at aim point below, for the same reason (see its comment). Any
    // future camera mode must keep this unsmoothed - it's the fix for a
    // real, previously-shipped bug, not a style choice.
    if (mode === "cockpit") {
      offset.current.copy(COCKPIT_OFFSET).applyEuler(new THREE.Euler(0, yaw, 0));
      desiredPos.current.set(t.x + offset.current.x, t.y + offset.current.y, t.z + offset.current.z);
      camera.position.copy(desiredPos.current);

      // Looks where the car is heading, not at the car itself (there's
      // nothing behind the camera to look back at in this mode) - a point
      // far ahead along the same yaw-only forward direction the position
      // offset above uses, for the same reason position stays yaw-only
      // (a pitching/rolling look target would whip the horizon around on
      // every bump).
      forward.current.set(0, 0, -1).applyEuler(new THREE.Euler(0, yaw, 0));
      lookAt.current.set(
        desiredPos.current.x + forward.current.x * 20,
        desiredPos.current.y,
        desiredPos.current.z + forward.current.z * 20
      );
      camera.lookAt(lookAt.current);
      setPerspectiveFov(camera, COCKPIT_FOV);
    } else {
      offset.current.copy(CHASE_OFFSET).applyEuler(new THREE.Euler(0, yaw, 0));
      desiredPos.current.set(t.x + offset.current.x, t.y + offset.current.y, t.z + offset.current.z);
      camera.position.copy(desiredPos.current);

      // lookAt is NOT smoothed either, for the same reason position isn't:
      // this filter was left in after the position fix and reintroduced
      // the exact same bug in the other half of the camera. A lagged
      // lookAt chases a moving aim point, settling speed * timeConstant
      // behind the car - at 68 m/s and this filter's ~0.125s time constant
      // that's ~8.5m, farther back than the camera itself sits (7m). The
      // camera ends up aiming at a point behind its own position, i.e.
      // looking backward and down past the car - worse the faster the car
      // goes, which is exactly "hold W and the view pans down until the
      // car disappears". Both terms now come from the same frame's
      // interpolated transform with no filter on either, so no
      // speed-dependent gap can open between them.
      lookAt.current.set(t.x, t.y + 0.5, t.z);
      camera.lookAt(lookAt.current);
      setPerspectiveFov(camera, CHASE_FOV);
    }
  });

  return null;
}

export function Scene({
  speedRef,
  lapRef,
  deltaRef,
  sectorsRef,
  trackLimitRef,
  energyRef,
  aeroModeRef,
  tireRef,
  assistsRef,
  minimapProjection,
  minimapDotRef,
}: {
  speedRef: React.RefObject<HTMLDivElement | null>;
  lapRef: React.RefObject<HTMLDivElement | null>;
  deltaRef: React.RefObject<HTMLDivElement | null>;
  sectorsRef: React.RefObject<HTMLDivElement | null>;
  trackLimitRef: React.RefObject<HTMLDivElement | null>;
  energyRef: React.RefObject<HTMLDivElement | null>;
  aeroModeRef: React.RefObject<HTMLDivElement | null>;
  tireRef: React.RefObject<HTMLDivElement | null>;
  assistsRef: React.RefObject<HTMLDivElement | null>;
  minimapProjection: MinimapProjection;
  minimapDotRef: React.RefObject<SVGCircleElement | null>;
}) {
  const chassisRef = useRef<RapierRigidBody>(null);
  const visualRef = useRef<THREE.Mesh>(null);
  const cameraModeRef = useRef<CameraMode>("chase");

  return (
    <Canvas
      shadows
      camera={{
        fov: 65,
        position: [track.startPos.x, 3, track.startPos.z + 8],
        far: 3000,
      }}
    >
      <color attach="background" args={["#87ceeb"]} />
      <fog attach="fog" args={["#87ceeb", 40, 220]} />
      <ambientLight intensity={0.6} />
      <directionalLight position={[50, 80, 20]} intensity={1.2} castShadow />
      <Physics gravity={[0, -9.81, 0]} timeStep={1 / 60}>
        <Ground />
        <Track track={track} />
        <Car
          chassisRef={chassisRef}
          visualRef={visualRef}
          cameraModeRef={cameraModeRef}
          speedRef={speedRef}
          lapRef={lapRef}
          deltaRef={deltaRef}
          sectorsRef={sectorsRef}
          trackLimitRef={trackLimitRef}
          energyRef={energyRef}
          aeroModeRef={aeroModeRef}
          tireRef={tireRef}
          assistsRef={assistsRef}
          minimapProjection={minimapProjection}
          minimapDotRef={minimapDotRef}
          track={track}
        />
      </Physics>
      <ChaseCamera target={visualRef} cameraMode={cameraModeRef} />
    </Canvas>
  );
}
