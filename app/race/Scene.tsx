"use client";

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import {
  Physics,
  RigidBody,
  TrimeshCollider,
  type RapierRigidBody,
} from "@react-three/rapier";
import { Car } from "./Car";
import { AICar } from "./AICar";
import { Track } from "./Track";
import type { TrackData } from "@/lib/tracks/types";
import { buildTerrainGeometry } from "@/lib/tracks/terrain";
import type { AudioSnapshot } from "@/lib/audio/raceAudio";
import type { CameraMode } from "@/lib/input/useDriveInput";
import type { TimeOfDay } from "@/lib/race/sessionSetup";
import { yawFromQuaternion } from "@/lib/physics/vehicle";
import { buildBroadcastCams, selectBroadcastCam } from "@/lib/race/broadcastCams";
import {
  anchorOrbit,
  clampOrbit,
  orbitPosition,
  type OrbitState,
} from "@/lib/race/orbitCam";
import { createRaceState, type RaceState } from "@/lib/race/racePosition";
import { createQualifyingTimes, type QualifyingTimes } from "@/lib/race/qualifying";
import type { QualifyingFormat } from "@/lib/race/qualifying";
import type { SessionMode } from "@/lib/race/sessionSetup";

// Grid start (plan section 7): counts down on screen, then flips
// raceStartRef so Car.tsx/AICar.tsx unlock throttle at the same instant -
// a synchronized launch instead of whoever's tab finished loading first.
// The grid itself IS staggered (see grid.ts): pole at the line, P2 eight
// metres behind, with the behind car's lap timer forgiving the run up to
// the line (see startsBehindLine in lapTimer.ts).
const COUNTDOWN_SECONDS = 3;
const GO_DISPLAY_SECONDS = 0.75;

function RaceStartCountdown({
  raceStartRef,
  countdownRef,
}: {
  raceStartRef: React.RefObject<boolean>;
  countdownRef: React.RefObject<HTMLDivElement | null>;
}) {
  const elapsedRef = useRef(0);
  const finishedRef = useRef(false);

  useFrame((_, dt) => {
    if (finishedRef.current) return;
    elapsedRef.current += dt;
    const elapsed = elapsedRef.current;

    if (elapsed < COUNTDOWN_SECONDS) {
      if (countdownRef.current) {
        countdownRef.current.textContent = String(Math.ceil(COUNTDOWN_SECONDS - elapsed));
      }
      return;
    }
    // Flip the instant "GO!" appears, not after it fades - the countdown
    // display's own tail shouldn't add extra locked-throttle time.
    if (!raceStartRef.current) raceStartRef.current = true;
    if (elapsed < COUNTDOWN_SECONDS + GO_DISPLAY_SECONDS) {
      if (countdownRef.current) countdownRef.current.textContent = "GO!";
      return;
    }
    finishedRef.current = true;
    if (countdownRef.current) countdownRef.current.textContent = "";
  });

  return null;
}

/**
 * Grass runoff, built from the circuit's own elevation profile so it follows
 * the ribbon up and down the lap instead of sitting at a single altitude (see
 * lib/tracks/terrain.ts for why, and for the exact rule) - a plane at one
 * fixed height would be tens of metres wrong at Spa. Wired to the same
 * trimesh collider the harness uses, so the two cannot disagree.
 */
function Ground({ track }: { track: TrackData }) {
  const { positions, indices, geometry } = useMemo(() => {
    const { positions, indices, colors } = buildTerrainGeometry(track);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    return { positions, indices, geometry };
  }, [track]);

  return (
    <RigidBody type="fixed" colliders={false} friction={0.6}>
      <TrimeshCollider args={[positions, indices]} />
      <mesh geometry={geometry} receiveShadow>
        <meshStandardMaterial vertexColors />
      </mesh>
    </RigidBody>
  );
}

// Chase: classic third-person, camera behind and above looking at the car
// (plan section 9). Cockpit: camera near the driver's seat looking ahead
// along the car's own heading, for the "steep FOV... speed sensation" feel
// the plan calls for - a wider FOV than chase makes the same speed read as
// faster, the standard cockpit-cam trick. Chase sits a little further back
// and higher than the obvious framing: with real F1/track proportions the
// car otherwise fills the frame and reads oversized (player feedback).
// T-cam: the broadcast look - above and just behind the car, staring down
// the track. Same yaw-only unsmoothed construction as the other two modes
// (see below); the chassis stays visible, sitting low in frame the way a
// real T-cam frames the nose.
const CHASE_OFFSET = new THREE.Vector3(0, 2.6, 8.5);
const COCKPIT_OFFSET = new THREE.Vector3(0, 0.65, -0.3);
const TCAM_OFFSET = new THREE.Vector3(0, 2.2, 5.0);
const CHASE_FOV = 65;
const COCKPIT_FOV = 85;
const TCAM_FOV = 70;
const TV_FOV = 55;
const ORBIT_FOV = 60;

// Plan section 8 (Session Setup): time-of-day lighting presets. One table,
// not scattered ternaries, so adding a preset is one row and every light in
// the scene stays consistent by construction. Deliberately no night -
// driving it fairly would need headlights and lit track furniture.
const TIME_OF_DAY_LIGHTING: Record<
  TimeOfDay,
  {
    sky: string;
    ambientColor: string;
    ambientIntensity: number;
    sunColor: string;
    sunIntensity: number;
    sunPosition: [number, number, number];
  }
> = {
  day: {
    sky: "#87ceeb",
    ambientColor: "#ffffff",
    ambientIntensity: 0.45,
    sunColor: "#ffffff",
    sunIntensity: 1.5,
    sunPosition: [50, 80, 20],
  },
  sunset: {
    sky: "#dd8a4e",
    ambientColor: "#ffdcbf",
    ambientIntensity: 0.32,
    sunColor: "#ffc27d",
    sunIntensity: 1.7,
    sunPosition: [90, 22, 10],
  },
  overcast: {
    sky: "#9aa3ab",
    ambientColor: "#cdd5dd",
    ambientIntensity: 0.6,
    sunColor: "#dfe8f2",
    sunIntensity: 0.85,
    sunPosition: [20, 80, -30],
  },
};

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
  raceRef,
  track,
}: {
  target: React.RefObject<THREE.Object3D | null>;
  cameraMode: React.RefObject<CameraMode>;
  /** Car.tsx writes the player's live progress here every frame. */
  raceRef: React.RefObject<RaceState>;
  track: TrackData;
}) {
  const { camera } = useThree();
  const desiredPos = useRef(new THREE.Vector3(0, 3, 8));
  const lookAt = useRef(new THREE.Vector3());
  const offset = useRef(new THREE.Vector3());
  const forward = useRef(new THREE.Vector3());
  const worldPos = useRef(new THREE.Vector3());
  const worldQuat = useRef(new THREE.Quaternion());
  // Free-orbit state (plan section 9 replay cam) plus the mode this frame
  // ran, so entering orbit anchors once on the car's position instead of
  // re-anchoring (and snapping) every frame.
  const orbit = useRef<OrbitState | null>(null);
  const prevMode = useRef<CameraMode>("chase");
  // Fixed trackside stands (see lib/race/broadcastCams.ts) - geometry per
  // track, computed once; the per-frame work is one nearest-ahead lookup.
  const cams = useMemo(() => buildBroadcastCams(track), [track]);
  // Drag-rotate + wheel-zoom for orbit mode, straight onto the stored
  // angles - the frame loop below only ever reads them, so input here can
  // never inject smoothing or lag into any camera.
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    const el = gl.domElement;
    let dragging = false;
    let lx = 0;
    let ly = 0;
    const down = (e: PointerEvent) => {
      dragging = true;
      lx = e.clientX;
      ly = e.clientY;
    };
    const move = (e: PointerEvent) => {
      if (!dragging || cameraMode.current !== "orbit" || !orbit.current) return;
      const o = orbit.current;
      o.yaw -= (e.clientX - lx) * 0.005;
      o.pitch += (e.clientY - ly) * 0.005;
      lx = e.clientX;
      ly = e.clientY;
      orbit.current = clampOrbit(o);
    };
    const up = () => {
      dragging = false;
    };
    const zoom = (e: WheelEvent) => {
      if (cameraMode.current !== "orbit" || !orbit.current) return;
      e.preventDefault();
      const o = orbit.current;
      o.radius *= Math.exp(e.deltaY * 0.001);
      orbit.current = clampOrbit(o);
    };
    el.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    el.addEventListener("wheel", zoom, { passive: false });
    return () => {
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      el.removeEventListener("wheel", zoom);
    };
  }, [gl, cameraMode]);

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
    const yaw = yawFromQuaternion(r.x, r.y, r.z, r.w);

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
    } else if (mode === "t-cam") {
      // Same unsmoothed position + aim construction as cockpit (see above),
      // only higher, further back, and aimed further ahead with a downward
      // tilt so the chassis sits low in frame - no lag filter on either
      // term, for the same speed-dependent-gap reason documented below.
      offset.current.copy(TCAM_OFFSET).applyEuler(new THREE.Euler(0, yaw, 0));
      desiredPos.current.set(t.x + offset.current.x, t.y + offset.current.y, t.z + offset.current.z);
      camera.position.copy(desiredPos.current);

      forward.current.set(0, 0, -1).applyEuler(new THREE.Euler(0, yaw, 0));
      lookAt.current.set(
        desiredPos.current.x + forward.current.x * 30,
        t.y + 0.9,
        desiredPos.current.z + forward.current.z * 30
      );
      camera.lookAt(lookAt.current);
      setPerspectiveFov(camera, TCAM_FOV);
    } else if (mode === "tv") {
      // Broadcast (see lib/race/broadcastCams.ts): a hard cut to whichever
      // fixed stand sits nearest ahead of the car, aiming back at the car
      // itself as it approaches and recedes. A cut is one frame's snap - no
      // blend, no filter - so like every other mode here there is nothing
      // to drift or lag.
      const progress = raceRef.current?.player.progressMeters ?? 0;
      const cam = cams[selectBroadcastCam(cams, progress, track.lengthMeters)];
      camera.position.set(cam.x, cam.y, cam.z);
      camera.lookAt(t.x, t.y + 0.8, t.z);
      setPerspectiveFov(camera, TV_FOV);
    } else if (mode === "orbit") {
      // Free orbit (see above): anchor once on entry, then circle the fixed
      // point - the game (and the car) keeps running underneath, the camera
      // just stops following. Position derives purely from the stored
      // angles, so dragging can never inject smoothing.
      if (prevMode.current !== "orbit" || !orbit.current) {
        orbit.current = anchorOrbit(t.x, t.y, t.z, yaw);
      }
      const p = orbitPosition(orbit.current);
      camera.position.set(p.x, p.y, p.z);
      camera.lookAt(orbit.current.ax, orbit.current.ay, orbit.current.az);
      setPerspectiveFov(camera, ORBIT_FOV);
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
    prevMode.current = mode;
  });

  return null;
}

export function Scene({
  track,
  speedRef,
  lapRef,
  deltaRef,
  sectorsRef,
  trackLimitRef,
  energyRef,
  aeroModeRef,
  tireRef,
  assistsRef,
  damageRef,
  gearRef,
  rpmRef,
  minimapGroupRef,
  minimapMarkerRef,
  aiMinimapMarkerRef,
  positionRef,
  raceResultRef,
  raceLaps,
  champRound,
  sessionMode = "race",
  qualiFormat = "timed",
  playerGridSpot = null,
  countdownRef,
  qualifyingDisplayRef,
  penaltyToastRef,
  playerBodyColor,
  aiBodyColor,
  audioRef,
  timeOfDay = "day",
}: {
  /** Selected circuit - see the home-screen session setup / ?track= param. */
  track: TrackData;
  /** Garage pick (see lib/race/roster.ts) - team primary for the player. */
  playerBodyColor: string;
  /** Garage pick - team secondary for the teammate-opponent. */
  aiBodyColor: string;
  /** Shared with the race audio rig - both cars fill it in every frame. */
  audioRef?: React.RefObject<AudioSnapshot>;
  speedRef: React.RefObject<HTMLDivElement | null>;
  lapRef: React.RefObject<HTMLDivElement | null>;
  deltaRef: React.RefObject<HTMLDivElement | null>;
  sectorsRef: React.RefObject<HTMLDivElement | null>;
  trackLimitRef: React.RefObject<HTMLDivElement | null>;
  energyRef: React.RefObject<HTMLDivElement | null>;
  aeroModeRef: React.RefObject<HTMLDivElement | null>;
  tireRef: React.RefObject<HTMLDivElement | null>;
  assistsRef: React.RefObject<HTMLDivElement | null>;
  damageRef: React.RefObject<HTMLDivElement | null>;
  gearRef: React.RefObject<HTMLDivElement | null>;
  rpmRef: React.RefObject<HTMLDivElement | null>;
  minimapGroupRef: React.RefObject<SVGGElement | null>;
  minimapMarkerRef: React.RefObject<SVGPolygonElement | null>;
  aiMinimapMarkerRef: React.RefObject<SVGCircleElement | null>;
  positionRef: React.RefObject<HTMLDivElement | null>;
  raceResultRef: React.RefObject<HTMLDivElement | null>;
  /** Quick Race lap count - see page.tsx's ?laps= URL param. */
  raceLaps?: number;
  /** Lighting preset - see page.tsx's ?tod= URL param. */
  timeOfDay?: TimeOfDay;
  /** Championship round index from ?champ=, or null for a one-off race. */
  champRound?: number | null;
  /** What kind of session this visit is - see ?mode= (default race). */
  sessionMode?: SessionMode;
  /** Qualifying format from ?qformat= (default timed). */
  qualiFormat?: QualifyingFormat;
  /**
   * The player's grid spot from ?grid= (a qualifying result or the
   * championship panel), or null for the old equal standing start.
   * The AI takes the other spot.
   */
  playerGridSpot?: 1 | 2 | null;
  countdownRef: React.RefObject<HTMLDivElement | null>;
  qualifyingDisplayRef: React.RefObject<HTMLDivElement | null>;
  penaltyToastRef: React.RefObject<HTMLDivElement | null>;
}) {
  const chassisRef = useRef<RapierRigidBody>(null);
  const raceRef = useRef<RaceState>(createRaceState());
  const raceStartRef = useRef(false);
  // Shared rewind flag (see Car.tsx's sharedRewindActiveRef): the player
  // owns the R key, and every AI car scrubs its own past while it's held
  // so a flashback rewinds the whole world, not just the player's car.
  const sharedRewindActiveRef = useRef(false);
  const qualifyingRef = useRef<QualifyingTimes>(createQualifyingTimes());
  const visualRef = useRef<THREE.Group>(null);
  const cameraModeRef = useRef<CameraMode>("chase");
  const racingLineVisibleRef = useRef(true);
  const lighting = TIME_OF_DAY_LIGHTING[timeOfDay] ?? TIME_OF_DAY_LIGHTING.day;

  return (
    <Canvas
      shadows
      camera={{
        fov: 65,
        position: [track.startPos.x, 3, track.startPos.z + 8],
        far: 3000,
      }}
    >
      <color attach="background" args={[lighting.sky]} />
      <fog attach="fog" args={[lighting.sky, 40, 220]} />
      <ambientLight intensity={lighting.ambientIntensity} color={lighting.ambientColor} />
      <directionalLight
        position={lighting.sunPosition}
        intensity={lighting.sunIntensity}
        color={lighting.sunColor}
        castShadow
      />
      <Physics gravity={[0, -9.81, 0]} timeStep={1 / 60}>
        <Ground track={track} />
        <Track track={track} chassisRef={chassisRef} racingLineVisibleRef={racingLineVisibleRef} />
        <Car
          chassisRef={chassisRef}
          visualRef={visualRef}
          cameraModeRef={cameraModeRef}
          racingLineVisibleRef={racingLineVisibleRef}
          speedRef={speedRef}
          lapRef={lapRef}
          deltaRef={deltaRef}
          sectorsRef={sectorsRef}
          trackLimitRef={trackLimitRef}
          energyRef={energyRef}
          aeroModeRef={aeroModeRef}
          tireRef={tireRef}
          assistsRef={assistsRef}
          damageRef={damageRef}
          gearRef={gearRef}
          rpmRef={rpmRef}
          minimapGroupRef={minimapGroupRef}
          minimapMarkerRef={minimapMarkerRef}
          positionRef={positionRef}
          raceResultRef={raceResultRef}
          raceRef={raceRef}
          raceLaps={raceLaps}
          champRound={champRound}
          sessionMode={sessionMode}
          qualiFormat={qualiFormat}
          playerGridSpot={playerGridSpot}
          raceStartRef={raceStartRef}
          sharedRewindActiveRef={sharedRewindActiveRef}
          qualifyingRef={qualifyingRef}
          qualifyingDisplayRef={qualifyingDisplayRef}
          penaltyToastRef={penaltyToastRef}
          track={track}
          bodyColor={playerBodyColor}
          audioRef={audioRef}
        />
        {sessionMode !== "practice" && (
          <AICar
            track={track}
            raceRef={raceRef}
            minimapMarkerRef={aiMinimapMarkerRef}
            raceStartRef={raceStartRef}
            sharedRewindActiveRef={sharedRewindActiveRef}
            qualifyingRef={qualifyingRef}
            playerGridSpot={playerGridSpot}
            bodyColor={aiBodyColor}
            audioRef={audioRef}
          />
        )}
      </Physics>
      <ChaseCamera target={visualRef} cameraMode={cameraModeRef} raceRef={raceRef} track={track} />
      <RaceStartCountdown raceStartRef={raceStartRef} countdownRef={countdownRef} />
    </Canvas>
  );
}
