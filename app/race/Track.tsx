"use client";

import { useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { RigidBody, TrimeshCollider, type RapierRigidBody } from "@react-three/rapier";
import { buildEdgeLineGeometry, buildKerbGeometry, buildRibbonGeometry, RIBBON_COLOR } from "@/lib/tracks/mesh";
import {
  buildRacingLineRibbon,
  computeRacingLine,
  updateLiveZoneColors,
  type ThrottleZone,
} from "@/lib/tracks/racingLine";
import type { TrackData } from "@/lib/tracks/types";

// Lifts the racing line's rendered geometry just above the track surface
// (the racing line carries the centerline's own y, and so does the ribbon's
// cross-section - see mesh.ts) so it doesn't z-fight with it.
const RACING_LINE_HEIGHT_OFFSET = 0.05;
// Same lift for the painted edge lines, one step lower: where the racing
// line sweeps across an edge the throttle-map colors must win, and a 1cm
// separation is plenty for the depth buffer this close to the camera.
const EDGE_LINE_HEIGHT_OFFSET = 0.035;
// Wide colored stripe (like an F1 game's throttle map), not a thin wire -
// half this value each side of the line's own center. 1.3 (2.6m total)
// looked too wide against this track's 13m width once actually driven -
// cut roughly in half.
const RACING_LINE_HALF_WIDTH_METERS = 0.6;

// 0-1 RGB, matching this project's existing HUD palette (SECTOR_COLOR_HEX
// in Car.tsx uses the same green/yellow; red matches the trackLimit HUD).
const ZONE_COLOR: Record<ThrottleZone, [number, number, number]> = {
  throttle: [0.22, 1, 0.53], // #39ff88
  lift: [1, 0.82, 0.25], // #ffd23f
  "brake-medium": [1, 0.45, 0.1], // orange
  "brake-hard": [1, 0.23, 0.23], // #ff3b3b
};

// How far ahead of the car (meters) the racing line's real-time color
// readout extends, like an F1 game's ideal-line overlay - not the whole
// visible horizon. Picked by feel, comfortably short of the scene's own
// 220m fog distance (Scene.tsx) so the "unpainted" static color further
// ahead is never visible fading in at the edge of view.
const LIVE_COLOR_LOOKAHEAD_METERS = 150;

function RacingLine({
  track,
  chassisRef,
  racingLineVisibleRef,
}: {
  track: TrackData;
  chassisRef?: React.RefObject<RapierRigidBody | null>;
  /** Toggled by useDriveInput's own "L" key - see its own comment. */
  racingLineVisibleRef?: React.RefObject<boolean>;
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  const { geometry, line } = useMemo(() => {
    const line = computeRacingLine(track);
    const { positions, colors, indices } = buildRacingLineRibbon(
      line,
      RACING_LINE_HALF_WIDTH_METERS,
      ZONE_COLOR
    );
    // Lift every vertex above the track surface - positions are
    // [x, y, z, ...] triples, so the y component is every 3rd value
    // starting at index 1.
    for (let i = 1; i < positions.length; i += 3) {
      positions[i] += RACING_LINE_HEIGHT_OFFSET;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const colorAttr = new THREE.BufferAttribute(colors, 3);
    // Colors are rewritten every frame below - hints three.js to allocate
    // the GPU buffer for frequent updates instead of a static one.
    colorAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("color", colorAttr);
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    return { geometry: geo, line };
  }, [track]);

  useFrame(() => {
    const visible = racingLineVisibleRef?.current ?? true;
    if (meshRef.current) {
      meshRef.current.visible = visible;
    }
    // Skip the per-frame color rewrite entirely while hidden - it walks
    // LIVE_COLOR_LOOKAHEAD_METERS of line points and re-uploads the color
    // buffer to the GPU every frame, which a toggle meant to turn this
    // overlay off should also turn off the cost of.
    if (!visible) return;
    const body = chassisRef?.current;
    if (!body) return;
    const t = body.translation();
    const lv = body.linvel();
    // Horizontal speed magnitude, not the signed forward speed used for
    // control (computeSignedForwardSpeed) - this is a read-only cosmetic
    // readout, so it doesn't need that value's sign-bug workaround, and a
    // plain magnitude is exactly what "how fast is the car going" means
    // for a color overlay the driver reads.
    const speedMs = Math.hypot(lv.x, lv.z);
    const colorAttr = geometry.getAttribute("color") as THREE.BufferAttribute;
    updateLiveZoneColors(
      line,
      colorAttr.array as Float32Array,
      t.x,
      t.z,
      speedMs,
      LIVE_COLOR_LOOKAHEAD_METERS,
      ZONE_COLOR
    );
    colorAttr.needsUpdate = true;
  });

  return (
    <mesh ref={meshRef} geometry={geometry}>
      {/* vertexColors, not a single material color - each vertex carries
          its own throttle/brake zone color (see ZONE_COLOR). basic (not
          standard) so scene lighting doesn't tint or darken the colors -
          this is a flat HUD-style overlay, not a lit surface. */}
      <meshBasicMaterial vertexColors />
    </mesh>
  );
}

export function Track({
  track,
  chassisRef,
  racingLineVisibleRef,
}: {
  track: TrackData;
  chassisRef?: React.RefObject<RapierRigidBody | null>;
  racingLineVisibleRef?: React.RefObject<boolean>;
}) {
  const { positions, indices, geometry, kerbGeometry, edgeLineGeometry } = useMemo(() => {
    const { positions, indices } = buildRibbonGeometry(track);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    // Visual kerb strips (plan section 4 point 6) - everything about how the
    // kerbs are placed and shaped lives in lib/tracks/surfaces.ts; this is
    // only geometry. The strips are NOT physics colliders: riding a kerb is
    // emulated per-wheel in the vehicle code (see applyKerbRideHeights) so
    // the collider set stays exactly ribbon + terrain, and no raycast wheel
    // ever meets two surfaces at one point. Plain material, single-sided:
    // the stripe quads are wound with their outward face toward the strip's
    // own side of the track, so both runs of quads show their front faces.
    const { positions: kerbPositions, colors: kerbColors, indices: kerbIndices } =
      buildKerbGeometry(track);
    const kerbGeometry = new THREE.BufferGeometry();
    kerbGeometry.setAttribute("position", new THREE.BufferAttribute(kerbPositions, 3));
    kerbGeometry.setAttribute("color", new THREE.BufferAttribute(kerbColors, 3));
    kerbGeometry.setIndex(new THREE.BufferAttribute(kerbIndices, 1));
    kerbGeometry.computeVertexNormals();
    // Painted edge lines (see buildEdgeLineGeometry) - lifted just above
    // the asphalt like the racing line overlay, but below it, so the
    // throttle-map colors always win where the line sweeps across an edge.
    const { positions: edgeLinePositions, indices: edgeLineIndices } =
      buildEdgeLineGeometry(track);
    for (let i = 1; i < edgeLinePositions.length; i += 3) {
      edgeLinePositions[i] += EDGE_LINE_HEIGHT_OFFSET;
    }
    const edgeLineGeometry = new THREE.BufferGeometry();
    edgeLineGeometry.setAttribute("position", new THREE.BufferAttribute(edgeLinePositions, 3));
    edgeLineGeometry.setIndex(new THREE.BufferAttribute(edgeLineIndices, 1));
    return { positions, indices, geometry, kerbGeometry, edgeLineGeometry };
  }, [track]);

  return (
    <>
      <RigidBody type="fixed" colliders={false} friction={1.3}>
        <TrimeshCollider args={[positions, indices]} />
        <mesh geometry={geometry} receiveShadow>
          <meshStandardMaterial color={RIBBON_COLOR} />
        </mesh>
      </RigidBody>
      <mesh geometry={kerbGeometry}>
        <meshStandardMaterial vertexColors />
      </mesh>
      <mesh geometry={edgeLineGeometry}>
        {/* basic (unlit) white, like the racing line overlay below: an edge
            line must read against any grass brightness or shade, and lighting
            it would let a sun-facing slope wash it out exactly when the
            asphalt/grass boundary is hardest to see. */}
        <meshBasicMaterial color="white" />
      </mesh>
      <RacingLine track={track} chassisRef={chassisRef} racingLineVisibleRef={racingLineVisibleRef} />
    </>
  );
}
