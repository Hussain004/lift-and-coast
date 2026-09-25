"use client";

import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { RigidBody, TrimeshCollider, type RapierRigidBody } from "@react-three/rapier";
import { buildEdgeLineGeometry, buildKerbGeometry, buildRibbonGeometry, RIBBON_COLOR } from "@/lib/tracks/mesh";
import { buildStructureGeometry, buildBarrierWallMesh } from "@/lib/tracks/structures";
import { buildTerrainGeometry } from "@/lib/tracks/terrain";
import { buildFlora, type FloraBuild } from "@/lib/tracks/flora";
import {
  buildRacingLineRibbon,
  updateLiveZoneColors,
  type ThrottleZone,
} from "@/lib/tracks/racingLine";
import { getRacingLine } from "@/lib/tracks/racingLineCache";
import type { TrackData } from "@/lib/tracks/types";
import type { AIDifficulty } from "@/lib/ai/personalities";
import { chunkMesh, chunkPoints, thin } from "@/lib/render/chunks";
import { asphaltTexture, planarUvs } from "@/lib/render/textures";
import { SurfaceMaterial, useQuality } from "./renderQuality";

/** Cell size for circuit-wide static geometry (see lib/render/chunks.ts). */
const CHUNK_METERS = 180;

// Lifts the racing line's rendered geometry just above the track surface
// (the racing line carries the centerline's own y, and so does the ribbon's
// cross-section - see mesh.ts) so it doesn't z-fight with it.
const RACING_LINE_HEIGHT_OFFSET = 0.05;
// Same lift for the painted edge lines, one step lower: where the racing
// line sweeps across an edge the throttle-map colors must win, and a 1cm
// separation is plenty for the depth buffer this close to the camera.
const EDGE_LINE_HEIGHT_OFFSET = 0.035;
// Compact broadcast stripe: 0.6m each side keeps the ideal line readable
// without covering the racing surface or competing with the track edge.
const RACING_LINE_HALF_WIDTH_METERS = 0.6;

// Restrained broadcast-style shades: cool green for throttle, amber for a
// lift, orange for trail braking, and a deep red for a genuine hard-braking
// zone. The darker red is intentionally distinct from the warning HUD red.
const ZONE_COLOR: Record<ThrottleZone, [number, number, number]> = {
  throttle: [0.08, 0.78, 0.55], // #14c78c
  lift: [0.95, 0.68, 0.12], // #f2ad1f
  "brake-medium": [0.98, 0.32, 0.06], // #fa5110
  "brake-hard": [0.78, 0.03, 0.12], // #c7071f
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
  difficulty = "pro",
}: {
  track: TrackData;
  chassisRef?: React.RefObject<RapierRigidBody | null>;
  difficulty?: AIDifficulty;
  /** Toggled by useDriveInput's own "L" key - see its own comment. */
  racingLineVisibleRef?: React.RefObject<boolean>;
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  // Warm start for the per-frame live-zone repaint (see
  // updateLiveZoneColors): this component's last nearest-line index. The
  // player's nearest point moves a couple of line points per frame, so
  // the next frame's windowed search is equivalent to the full scan.
  const nearestIdxRef = useRef(0);
  const { geometry, line } = useMemo(() => {
    const line = getRacingLine(
      track,
      difficulty === "ace" ? "ace" : difficulty === "pro" ? "pro" : "default"
    );
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
  }, [track, difficulty]);

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
    const nearest = updateLiveZoneColors(
      line,
      colorAttr.array as Float32Array,
      t.x,
      t.z,
      speedMs,
      LIVE_COLOR_LOOKAHEAD_METERS,
      ZONE_COLOR,
      nearestIdxRef.current
    );
    nearestIdxRef.current = nearest;
    colorAttr.needsUpdate = true;
  });

  return (
    <mesh ref={meshRef} geometry={geometry}>
      {/* vertexColors, not a single material color - each vertex carries
          its own throttle/brake zone color (see ZONE_COLOR). basic (not
          standard) so scene lighting doesn't tint or darken the colors -
          this is a flat HUD-style overlay, not a lit surface. */}
      <meshBasicMaterial vertexColors toneMapped={false} />
    </mesh>
  );
}

function PitBoxMarker({ track }: { track: TrackData }) {
  const geometry = useMemo(() => {
    const n = track.centerline.length;
    const center = track.centerline[0];
    const before = track.centerline[n - 1];
    const after = track.centerline[1];
    const tx = after[0] - before[0];
    const tz = after[2] - before[2];
    const length = Math.hypot(tx, tz) || 1;
    const rightX = -tz / length;
    const rightZ = tx / length;
    const halfWidth = track.width[0] / 2;
    const lateral = Math.max(0, halfWidth - 1.7);
    const along = 11;
    const across = 1.25;
    const x = center[0] + rightX * lateral;
    const z = center[2] + rightZ * lateral;
    const y = center[1] + 0.07;
    const points = [
      [x - (tx / length) * along - rightX * across, y, z - (tz / length) * along - rightZ * across],
      [x + (tx / length) * along - rightX * across, y, z + (tz / length) * along - rightZ * across],
      [x + (tx / length) * along + rightX * across, y, z + (tz / length) * along + rightZ * across],
      [x - (tx / length) * along + rightX * across, y, z - (tz / length) * along + rightZ * across],
    ];
    const positions = new Float32Array(points.flat());
    const result = new THREE.BufferGeometry();
    result.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    result.setIndex([0, 1, 2, 0, 2, 3]);
    return result;
  }, [track]);
  return (
    <mesh geometry={geometry} position={[0, 0, 0]}>
      <meshBasicMaterial color="#ffd23f" transparent opacity={0.75} toneMapped={false} />
    </mesh>
  );
}

export function Track({
  track,
  chassisRef,
  racingLineVisibleRef,
  difficulty = "pro",
}: {
  track: TrackData;
  chassisRef?: React.RefObject<RapierRigidBody | null>;
  racingLineVisibleRef?: React.RefObject<boolean>;
  difficulty?: AIDifficulty;
}) {
  const { positions, indices, geometry, kerbGeometry, edgeLineGeometry } = useMemo(() => {
    const { positions, indices } = buildRibbonGeometry(track);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(planarUvs(positions, 6), 2));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    // Visual kerb strips (plan section 4 point 6) - everything about how the
    // kerbs are placed and shaped lives in lib/tracks/surfaces.ts; this is
    // only geometry. The strips are NOT physics colliders: riding a kerb is
    // emulated per-wheel in the vehicle code (see applyKerbRideHeights) so
    // the collider set stays ribbon + terrain + structures, and no raycast
    // wheel ever meets two surfaces at one point. Plain material, single-sided:
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
          <SurfaceMaterial color={RIBBON_COLOR} map={asphaltTexture()} />
        </mesh>
      </RigidBody>
      <BarrierWalls track={track} />
      <Structures track={track} />
      <Flora track={track} />
      <mesh geometry={kerbGeometry}>
        <SurfaceMaterial vertexColors />
      </mesh>
      <mesh geometry={edgeLineGeometry}>
        {/* basic (unlit) white, like the racing line overlay below: an edge
            line must read against any grass brightness or shade, and lighting
            it would let a sun-facing slope wash it out exactly when the
            asphalt/grass boundary is hardest to see. */}
        <meshBasicMaterial color="white" />
      </mesh>
      <RacingLine
        track={track}
        chassisRef={chassisRef}
        racingLineVisibleRef={racingLineVisibleRef}
        difficulty={difficulty}
      />
      <PitBoxMarker track={track} />
    </>
  );
}

/**
 * The barrier line as physics. The grandstand/building massing below stays
 * visual-only, but the wall a car actually runs into has to be solid: one
 * static trimesh, built from the same per-track profile (setback, style,
 * thickness) as the visible barrier, so the wall you see is the wall you hit.
 *
 * Friction is low and restitution zero on purpose. A barrier should scrub
 * speed and deflect, not launch the car back onto the circuit - a
 * springy wall reads as a trampoline, which is not what armco does.
 */
function BarrierWalls({ track }: { track: TrackData }) {
  const mesh = useMemo(
    () => buildBarrierWallMesh(track, buildTerrainGeometry(track)),
    [track]
  );
  if (mesh.positions.length === 0) return null;
  return (
    <RigidBody type="fixed" colliders={false}>
      <TrimeshCollider args={[mesh.positions, mesh.indices]} friction={0.4} restitution={0} />
    </RigidBody>
  );
}

/**
 * Trackside massing (plan section 4, circuit detail): pit buildings,
 * grandstands, walls and landmarks from lib/tracks/structures, merged into
 * two meshes. This massing is VISUAL ONLY, and the distinction from
 * <BarrierWalls> is deliberate: massing stands beyond the barrier line, in
 * territory a car only reaches by having already left the road, and a car
 * loose in the scenery should be slowed by the surface rather than stopped
 * by a grandstand. The barrier itself is physical (see lib/tracks/
 * environment.ts for the per-track run-off setbacks that keep it well clear
 * of anywhere the car is actually driving).
 */
function Structures({ track }: { track: TrackData }) {
  const { solid, visual } = useMemo(() => {
    const { solid, visual } = buildStructureGeometry(track);
    const make = (positions: Float32Array, indices: Uint32Array, colors: Float32Array) =>
      positions.length === 0
        ? []
        : chunkMesh({ positions, indices, colors }, CHUNK_METERS).map((chunk) => {
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute("position", new THREE.BufferAttribute(chunk.positions, 3));
            geometry.setAttribute("color", new THREE.BufferAttribute(chunk.colors!, 3));
            geometry.setIndex(new THREE.BufferAttribute(chunk.indices, 1));
            geometry.computeVertexNormals();
            geometry.computeBoundingSphere();
            return geometry;
          });
    return {
      solid: make(solid.positions, solid.indices, solid.colors),
      visual: make(visual.positions, visual.indices, visual.colors),
    };
  }, [track]);

  return (
    <>
      {solid.map((geometry, i) => (
        <mesh key={`s${i}`} geometry={geometry} castShadow receiveShadow>
          <SurfaceMaterial vertexColors />
        </mesh>
      ))}
      {visual.map((geometry, i) => (
        <mesh key={`v${i}`} geometry={geometry}>
          <SurfaceMaterial vertexColors />
        </mesh>
      ))}
    </>
  );
}

/**
 * Trackside flora (plan section 4, circuit detail): seeded low-poly trees,
 * instanced per species and per map cell, so stands behind the camera (or
 * outside the sun's shadow box) are culled. The graphics tier thins the
 * forest evenly (see thin) - the same trees always survive.
 */
function Flora({ track }: { track: TrackData }) {
  const { floraDensity } = useQuality();
  const builds = useMemo(() => buildFlora(track), [track]);
  const chunks = useMemo(
    () =>
      builds.flatMap((build, s) => {
        const items = thin(
          build.instances.map((instance, i) => ({ ...instance, color: build.colors[i] })),
          floraDensity
        );
        return chunkPoints(items, CHUNK_METERS).map((cell, c) => ({ key: `${s}:${c}`, build, cell }));
      }),
    [builds, floraDensity]
  );
  return (
    <>
      {chunks.map(({ key, build, cell }) => (
        <FloraChunkMesh key={key} geometry={build.geometry} cell={cell} />
      ))}
    </>
  );
}

function FloraChunkMesh({
  geometry,
  cell,
}: {
  geometry: FloraBuild["geometry"];
  cell: { x: number; y: number; z: number; yaw: number; scale: number; color: string }[];
}) {
  const ref = useRef<THREE.InstancedMesh | null>(null);
  const count = cell.length;
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const dummy = new THREE.Object3D();
    const tint = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const inst = cell[i];
      dummy.position.set(inst.x, inst.y, inst.z);
      dummy.rotation.set(0, inst.yaw, 0);
      dummy.scale.setScalar(inst.scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, tint.set(inst.color));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    // Bounds over this cell's instances (three computes them from the
    // instance matrices), so the cell can be culled as a unit.
    mesh.computeBoundingSphere();
  }, [cell, count]);
  return (
    <instancedMesh ref={ref} args={[geometry, undefined, count]} castShadow receiveShadow>
      <SurfaceMaterial vertexColors />
    </instancedMesh>
  );
}
