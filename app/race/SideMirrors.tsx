"use client";

import { useEffect, useMemo, useRef, type RefObject } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";

const MIRROR_WIDTH = 320;
const MIRROR_HEIGHT = 124;
const MIRROR_ASPECT = MIRROR_WIDTH / MIRROR_HEIGHT;
const DISPLAY_DISTANCE_METERS = 1;
/** On-screen frame size in camera-space metres at the 1m overlay distance. */
const FRAME_WIDTH = 0.42;
const FRAME_HEIGHT = FRAME_WIDTH / MIRROR_ASPECT;
const GLASS_INSET = 0.03;

function makeMirrorTarget() {
  const target = new THREE.WebGLRenderTarget(MIRROR_WIDTH, MIRROR_HEIGHT, {
    depthBuffer: true,
    stencilBuffer: false,
  });
  target.texture.colorSpace = THREE.SRGBColorSpace;
  target.texture.flipY = true;
  target.texture.minFilter = THREE.LinearFilter;
  target.texture.magFilter = THREE.LinearFilter;
  return target;
}

/**
 * Two live side-camera views drawn over the main camera. Each mirror gets a
 * render target and its own camera mounted just outside the car, aimed
 * rearward/outward. The display planes are positioned in the main camera's
 * local frame every frame, so they stay pinned to the top-left and top-right
 * corners without coupling the driving camera to screen-space DOM layout.
 *
 * Sizing: FRAME_WIDTH is the on-screen width in camera-space metres at the 1m
 * overlay distance, so a wider FOV or a narrower viewport shrinks the mirror
 * rather than letting it overflow the frame. The render target is 320x160 (a
 * little above the display size) so the glass stays sharp when the frame is
 * scaled up on wide screens.
 */
export function SideMirrors({
  target,
  enabled,
}: {
  target: RefObject<THREE.Object3D | null>;
  enabled: boolean;
}) {
  const { gl, scene, camera, size } = useThree();
  const rendererRef = useRef(gl);
  const targetRef = useRef(target);
  const targets = useMemo(() => [makeMirrorTarget(), makeMirrorTarget()], []);
  const mirrorCameras = useMemo(
    () => [
      new THREE.PerspectiveCamera(58, MIRROR_ASPECT, 0.08, 600),
      new THREE.PerspectiveCamera(58, MIRROR_ASPECT, 0.08, 600),
    ],
    []
  );
  const frameGeometry = useMemo(() => new THREE.PlaneGeometry(FRAME_WIDTH, FRAME_HEIGHT), []);
  const glassGeometry = useMemo(
    () => new THREE.PlaneGeometry(FRAME_WIDTH - GLASS_INSET * 2, FRAME_HEIGHT - GLASS_INSET * 2),
    []
  );
  const frameMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: "#07090d",
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }),
    []
  );
  const glassMaterials = useMemo(
    () =>
      targets.map(
        (renderTarget) =>
          new THREE.MeshBasicMaterial({
            map: renderTarget.texture,
            depthTest: false,
            depthWrite: false,
            toneMapped: false,
          })
      ),
    [targets]
  );
  const displayGroupRef = useRef<THREE.Group>(null);
  const leftDisplayRef = useRef<THREE.Group>(null);
  const rightDisplayRef = useRef<THREE.Group>(null);
  const lastRenderAt = useRef(-Infinity);

  const carPosition = useMemo(() => new THREE.Vector3(), []);
  const carQuaternion = useMemo(() => new THREE.Quaternion(), []);
  const mirrorPosition = useMemo(() => new THREE.Vector3(), []);
  const mirrorDirection = useMemo(() => new THREE.Vector3(), []);
  const mirrorLookAt = useMemo(() => new THREE.Vector3(), []);
  const cameraPosition = useMemo(() => new THREE.Vector3(), []);
  const cameraQuaternion = useMemo(() => new THREE.Quaternion(), []);

  useEffect(() => {
    return () => {
      targets.forEach((renderTarget) => renderTarget.dispose());
      frameGeometry.dispose();
      glassGeometry.dispose();
      frameMaterial.dispose();
      glassMaterials.forEach((material) => material.dispose());
    };
  }, [frameGeometry, frameMaterial, glassGeometry, glassMaterials, mirrorCameras, targets]);

  useFrame(({ clock }) => {
    const renderer = rendererRef.current;
    const displayGroup = displayGroupRef.current;
    const car = targetRef.current.current;
    if (!displayGroup || !car) {
      if (displayGroup) displayGroup.visible = false;
      return;
    }

    displayGroup.visible = enabled;
    if (!enabled) return;

    car.getWorldPosition(carPosition);
    car.getWorldQuaternion(carQuaternion);

    // The sculpted mirror stalks sit around x=+/-0.6, y=0.34, z=-0.15.
    // Aim each camera slightly outboard and rearward so the view contains the
    // adjacent lane and rear quarter rather than only the car's own body.
    for (let i = 0; i < mirrorCameras.length; i++) {
      const side = i === 0 ? -1 : 1;
      mirrorPosition.set(side * 0.68, 0.36, 0.16).applyQuaternion(carQuaternion).add(carPosition);
      mirrorDirection.set(side * 0.82, -0.08, 1).normalize().applyQuaternion(carQuaternion);
      mirrorLookAt.copy(mirrorPosition).add(mirrorDirection);
      const mirrorCamera = mirrorCameras[i];
      mirrorCamera.position.copy(mirrorPosition);
      mirrorCamera.lookAt(mirrorLookAt);
      mirrorCamera.updateMatrixWorld();
    }

    // Place the display planes relative to the actual main camera, including
    // its current FOV/aspect. This keeps them in the corners on wide desktop
    // and narrow landscape phone screens without a second DOM coordinate
    // system. The camera looks down its local -Z axis.
    camera.getWorldPosition(cameraPosition);
    camera.getWorldQuaternion(cameraQuaternion);
    displayGroup.position.copy(cameraPosition);
    displayGroup.quaternion.copy(cameraQuaternion);
    const perspective = camera instanceof THREE.PerspectiveCamera ? camera : null;
    const halfHeight = perspective
      ? Math.tan(THREE.MathUtils.degToRad(perspective.fov * 0.5)) * DISPLAY_DISTANCE_METERS
      : 0.6;
    const halfWidth = perspective ? halfHeight * perspective.aspect : 1;
    // Mirrors are sized off the narrower screen axis first: the FRAME_WIDTH cap
    // reads well on desktop, and the 52% rule keeps them usable (not slivers)
    // on narrow landscape phones.
    const displayWidth = Math.min(FRAME_WIDTH, halfWidth * 0.52);
    const displayHeight = displayWidth / MIRROR_ASPECT;
    // The DOM HUD paints above this canvas and the minimap owns the top-right
    // corner (170px at 16px inset on desktop, 96px on coarse pointers), so a
    // mirror pinned flush to the corner would sit behind it. Inset by a
    // viewport-proportional margin instead - a pixel margin, not a fraction of
    // the frustum, so the gap looks the same on a 4K monitor and a phone. The
    // cap is the desktop minimap height plus its inset and a small gap; short
    // viewports clamp to the lower bound and accept a sliver of overlap
    // rather than pushing the mirrors halfway down the screen.
    const topMarginPx = THREE.MathUtils.clamp(size.height * 0.185, 112, 200);
    const sideMarginPx = THREE.MathUtils.clamp(size.width * 0.022, 10, 26);
    // NDC of the gap edges: +1 is the right/top of the frame, so an inset of
    // `m` pixels on an `s`-pixel axis sits at 1 - 2m/s.
    const topEdgeNdc = 1 - (2 * topMarginPx) / Math.max(1, size.height);
    const outerEdgeNdc = 1 - (2 * sideMarginPx) / Math.max(1, size.width);
    // Back out from the edge to the plane's centre, in camera-space metres.
    const centerX = (outerEdgeNdc - displayWidth / halfWidth / 2) * halfWidth;
    const centerY = (topEdgeNdc - displayHeight / halfHeight / 2) * halfHeight;
    const leftDisplay = leftDisplayRef.current;
    const rightDisplay = rightDisplayRef.current;
    if (leftDisplay && rightDisplay) {
      leftDisplay.position.set(-centerX, centerY, -DISPLAY_DISTANCE_METERS);
      rightDisplay.position.set(centerX, centerY, -DISPLAY_DISTANCE_METERS);
      leftDisplay.scale.set(displayWidth / FRAME_WIDTH, displayHeight / FRAME_HEIGHT, 1);
      rightDisplay.scale.set(displayWidth / FRAME_WIDTH, displayHeight / FRAME_HEIGHT, 1);
    }

    // A 30Hz mirror refresh is plenty for rear-quarter views and keeps two
    // extra scene traversals from needlessly competing with the 60Hz race
    // simulation on phones.
    if (clock.elapsedTime - lastRenderAt.current < 1 / 30) return;
    lastRenderAt.current = clock.elapsedTime;

    // Render the mirror cameras before R3F's main render. Hide both the
    // display planes and the player's own body during these passes so a
    // mirror never recursively samples itself or shows the inside of the
    // player's chassis. The main render immediately afterwards restores the
    // normal scene and updates the shadow map once.
    const previousTarget = renderer.getRenderTarget();
    const previousAutoClear = renderer.autoClear;
    const previousShadowAutoUpdate = renderer.shadowMap.autoUpdate;
    const playerWasVisible = car.visible;
    car.visible = false;
    displayGroup.visible = false;
    renderer.autoClear = true;
    renderer.shadowMap.autoUpdate = false;
    try {
      for (let i = 0; i < mirrorCameras.length; i++) {
        renderer.setRenderTarget(targets[i]);
        renderer.clear();
        renderer.render(scene, mirrorCameras[i]);
      }
    } finally {
      renderer.setRenderTarget(previousTarget);
      renderer.autoClear = previousAutoClear;
      renderer.shadowMap.autoUpdate = previousShadowAutoUpdate;
      car.visible = playerWasVisible;
      displayGroup.visible = enabled;
    }
  });

  return (
    <group ref={displayGroupRef} visible={false} frustumCulled={false} renderOrder={1000}>
      <group ref={leftDisplayRef}>
        <mesh geometry={frameGeometry} material={frameMaterial} frustumCulled={false} renderOrder={1000} />
        <mesh geometry={glassGeometry} material={glassMaterials[0]} position={[0, 0, 0.001]} frustumCulled={false} renderOrder={1001} />
      </group>
      <group ref={rightDisplayRef}>
        <mesh geometry={frameGeometry} material={frameMaterial} frustumCulled={false} renderOrder={1000} />
        <mesh geometry={glassGeometry} material={glassMaterials[1]} position={[0, 0, 0.001]} frustumCulled={false} renderOrder={1001} />
      </group>
    </group>
  );
}
