"use client";

import { useEffect, useRef } from "react";
import type { RapierRigidBody } from "@react-three/rapier";
import { netRoom } from "@/lib/net/peer";
import {
  INPUT_HZ,
  POSE_HZ,
  SNAPSHOT_HZ,
  pushSnapshot,
  type CarPose,
  type TimedSnapshot,
} from "@/lib/net/snapshots";
import {
  buildTowerEntries,
  computeRacePositions,
  towerOpponents,
  type RaceProgress,
  type RaceState,
} from "@/lib/race/racePosition";
import type { NetCarSnapshot, NetMessage, NetTowerRow } from "@/lib/net/protocol";
import type { TrackData } from "@/lib/tracks/types";
import type { RemoteCarFrame } from "./RemoteCar";

export interface NetInputState {
  throttle: number;
  brake: number;
  steer: number;
  atMs: number;
}

export interface NetResultState {
  positions: Record<string, number>;
  winnerCode: string;
}

/**
 * A guest's authoritative car pose, stamped on arrival. The host blends
 * its locally-simulated copy of that car toward this (see AICar's
 * netPoseRef), so what the host sees - and broadcasts - tracks the guest's
 * own simulation instead of drifting with input latency.
 */
export interface NetPoseState {
  atMs: number;
  pose: CarPose;
  speedMs: number;
}

/** Lights-out is broadcast this long after the last guest reports ready. */
const GO_DELAY_MS = 1800;
/** Safety valve: a guest whose scene never mounts can't stall the room. */
const READY_TIMEOUT_MS = 20000;

/**
 * Host side of plan section 16: broadcasts the world the host simulates.
 * Snapshots (every car pose + lap/progress/speed) fan out at SNAPSHOT_HZ;
 * the tower rebuilds from the same race state the HUD reads; results go
 * once when the leader finishes. Inbound guest inputs route by join-order
 * slot into the per-car refs Scene hands each net-driven AICar - inputs
 * older than the AICar's own 500ms staleness window read as a dropped
 * guest there, so this side just records arrival time, never judges.
 */
export function NetHost({
  raceRef,
  carPosesRef,
  track,
  raceLaps,
  playerCode,
  playerColor,
  playerSlot,
  rivals,
  aiSlots,
  netResultRef,
  netInputRefs,
  netPoseRefs,
  goAtRef,
  goSignalledRef,
}: {
  raceRef: React.RefObject<RaceState>;
  carPosesRef: React.RefObject<Record<number, CarPose>>;
  track: TrackData;
  raceLaps: number;
  playerCode: string;
  playerColor: string;
  playerSlot: number;
  /** Non-player cars in raceRef.opponents order (see towerOpponents). */
  rivals: { code: string; color: string }[];
  /** Grid slot per rivals entry (see Scene.tsx). */
  aiSlots: number[];
  netResultRef: React.RefObject<NetResultState | null>;
  /** Per-rivals-entry input ref, written by grid slot. */
  netInputRefs: { current: NetInputState | null }[];
  /** Per-rivals-entry authoritative guest pose, written by grid slot. */
  netPoseRefs?: React.RefObject<NetPoseState | null>[];
  /** Shared lights-out stamp + gate (see RaceStartCountdown's goGate). */
  goAtRef: React.RefObject<number>;
  goSignalledRef: React.RefObject<boolean>;
}) {
  // Frozen join-order roster for input routing: members may leave mid-race,
  // but slots must not shift under running cars.
  const memberPeerIds = useRef<string[]>(netRoom.memberPeerIds());
  const sentResultsRef = useRef(false);

  /**
   * Ready/go start handshake. The lobby's "start" carries no go-time any
   * more; the guests navigate, their scenes mount, and each reports
   * "ready". Only when every human is ready (or the safety valve fires)
   * does the host broadcast "go" with a lights-out timestamp - host and
   * guests both feed it to RaceStartCountdown. Previously the START
   * message carried atMs = Date.now() + 4000, but a cold guest takes
   * longer than 4s to load three.js + rapier WASM: the host was mid-lap
   * while the guest sat on the grid, which read as a +1390m gap.
   */
  const expectedGuestsRef = useRef(0);
  const readyPeersRef = useRef<Set<string>>(new Set());
  const goSentRef = useRef(false);

  /**
   * The single place lights-out is decided. One shared stamp is broadcast
   * and stamped locally, so host and guests all run the same 3-2-1 from the
   * same instant (see Scene's goGate) instead of each off its own clock.
   */
  const signalGo = () => {
    if (goSentRef.current) return;
    goSentRef.current = true;
    const atMs = Date.now() + GO_DELAY_MS;
    netRoom.broadcast({ type: "go", atMs });
    goAtRef.current = atMs;
    goSignalledRef.current = true;
  };

  useEffect(() => {
    const expected = Math.max(0, memberPeerIds.current.length - 1);
    expectedGuestsRef.current = expected;
    // Host-only room (defensive - the lobby blocks this): nothing to wait
    // for, go now.
    if (expected <= 0) {
      signalGo();
      return;
    }
    // Safety valve: a guest whose scene never mounts (dead tab, endless
    // load, a lost "ready") can't hold the room hostage - go with whatever
    // we have after the timeout.
    const id = setTimeout(signalGo, READY_TIMEOUT_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () =>
      netRoom.onMessage((fromPeerId, msg: NetMessage) => {
        if (msg.type === "input") {
          const slot = memberPeerIds.current.indexOf(fromPeerId);
          if (slot <= 0) return;
          const atMs = Date.now();
          for (let k = 0; k < aiSlots.length; k++) {
            if (aiSlots[k] === slot) {
              netInputRefs[k].current = {
                throttle: msg.throttle,
                brake: msg.brake,
                steer: msg.steer,
                atMs,
              };
            }
          }
        } else if (msg.type === "pose") {
          // The guest is authoritative over its own car: stage the pose
          // for AICar's blend (its physics still runs so collisions and
          // suspension stay alive; this only corrects drift).
          if (netPoseRefs) {
            for (let k = 0; k < aiSlots.length; k++) {
              if (aiSlots[k] === msg.slot) {
                netPoseRefs[k].current = {
                  atMs: Date.now(),
                  pose: { position: msg.position, rotation: msg.rotation, linvel: msg.linvel },
                  speedMs: msg.speedMs,
                };
              }
            }
          }
        } else if (msg.type === "ready") {
          if (memberPeerIds.current.indexOf(fromPeerId) <= 0) return;
          readyPeersRef.current.add(fromPeerId);
          if (readyPeersRef.current.size >= expectedGuestsRef.current) signalGo();
        } else if (msg.type === "hello") {
          // No late joins mid-race: the grid was set at START.
          netRoom.dropPeer(fromPeerId, "Race already started - wait in the lobby.");
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // Guest dropped mid-race (tab closed, network lost): clear their inputs
  // at once so the path-follower fallback (see AICar's netInputRef) takes
  // the car immediately instead of after the staleness window. Slots stay
  // frozen - the car keeps racing as AI to the flag.
  useEffect(
    () =>
      netRoom.onPeerClose((peerId) => {
        const slot = memberPeerIds.current.indexOf(peerId);
        if (slot <= 0) return;
        for (let k = 0; k < aiSlots.length; k++) {
          if (aiSlots[k] === slot) {
            netInputRefs[k].current = null;
            if (netPoseRefs) netPoseRefs[k].current = null;
          }
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  useEffect(() => {
    const id = setInterval(() => {
      const race = raceRef.current;
      const poses = carPosesRef.current;
      if (!race || !poses) return;
      const progresses: RaceProgress[] = [race.player, ...race.opponents];
      const cars: NetCarSnapshot[] = [];
      const pushCar = (
        slot: number,
        progress: RaceProgress | undefined,
        fallback: RaceProgress
      ) => {
        const pose = poses[slot];
        if (!pose) return;
        const p = progress ?? fallback;
        cars.push({
          slot,
          position: [pose.position[0], pose.position[1], pose.position[2]],
          rotation: [pose.rotation[0], pose.rotation[1], pose.rotation[2], pose.rotation[3]],
          linvel: [pose.linvel[0], pose.linvel[1], pose.linvel[2]],
          speedMs: p.speedMs ?? 0,
          lapCount: p.lapCount,
          progressMeters: p.progressMeters,
        });
      };
      pushCar(playerSlot, race.player, { lapCount: 0, progressMeters: 0 });
      rivals.forEach((_, k) => {
        pushCar(aiSlots[k], race.opponents[k], { lapCount: 0, progressMeters: 0 });
      });
      const entries = buildTowerEntries(
        { code: playerCode, color: playerColor, progress: race.player },
        towerOpponents(rivals, race.opponents),
        track.lengthMeters
      );
      const tower: NetTowerRow[] = entries.map((entry) => ({
        slot: entry.isPlayer ? playerSlot : (aiSlots[rivals.findIndex((r) => r.code === entry.code)] ?? -1),
        code: entry.code,
        color: entry.color,
        position: entry.position,
        gapSeconds: entry.gapSeconds,
        lapsDown: entry.lapsDown,
        isPlayer: false,
      }));
      netRoom.broadcast({ type: "snapshot", tick: Date.now(), cars, tower });
      // Chequered flag: the leader's lap count settles the whole room,
      // backmarkers included - computed here, shown everywhere via
      // netResultRef (host banner) and the results broadcast (guests).
      // Keyed by grid slot, not driver code: two humans may share a code
      // (same defaults), and codes would collide.
      if (!sentResultsRef.current) {
        const leaderLap = Math.max(...progresses.map((p) => p.lapCount));
        if (leaderLap >= raceLaps) {
          sentResultsRef.current = true;
          const positions = computeRacePositions(progresses, track.lengthMeters);
          const board: Record<string, number> = { [String(playerSlot)]: positions[0] };
          rivals.forEach((_, k) => {
            board[String(aiSlots[k])] = positions[k + 1];
          });
          const winnerIndex = positions.indexOf(1);
          const winnerCode = winnerIndex === 0 ? playerCode : (rivals[winnerIndex - 1]?.code ?? playerCode);
          const results = { positions: board, winnerCode };
          if (netResultRef) netResultRef.current = results;
          netRoom.broadcast({ type: "results", ...results });
        }
      }
    }, 1000 / SNAPSHOT_HZ);
    return () => clearInterval(id);
  }, [raceRef, carPosesRef, track, raceLaps, playerCode, playerColor, playerSlot, rivals, aiSlots, netResultRef]);

  return null;
}

/**
 * Guest side of plan section 16: uploads inputs, applies snapshots.
 * The guest's own car is simulated locally (zero input lag - see Car.tsx)
 * while everything else renders from host snapshots (see RemoteCar):
 * - inputs upload at INPUT_HZ from the shared player-input tap,
 * - each snapshot refreshes the remote buffers plus the tower inputs
 *   (guest Car ranks the same field from the same data),
 * - the player's own body gets a soft blend toward host truth past 2.5m
 *   of divergence (rubber-banding without the snap),
 * - host results and host-leaves flow into the shared result/banner refs.
 */
export function NetClient({
  raceRef,
  playerInputRef,
  chassisRef,
  remoteBuffersRef,
  netResultRef,
  raceResultRef,
  playerSlot,
  slotToOpponent,
  goAtRef,
  goSignalledRef,
}: {
  raceRef: React.RefObject<RaceState>;
  playerInputRef: React.RefObject<{ throttle: number; brake: number; steer: number } | null>;
  chassisRef: React.RefObject<RapierRigidBody | null>;
  remoteBuffersRef: React.RefObject<Record<number, TimedSnapshot<RemoteCarFrame>[]>>;
  netResultRef: React.RefObject<NetResultState | null>;
  raceResultRef?: React.RefObject<HTMLDivElement | null>;
  /** This guest's grid slot (from the start message, via the URL). */
  playerSlot: number;
  /** Grid slot -> raceRef.opponents index, for feeding remote progress. */
  slotToOpponent: Record<number, number>;
  /** Shared lights-out stamp + gate (see RaceStartCountdown's goGate). */
  goAtRef: React.RefObject<number>;
  goSignalledRef: React.RefObject<boolean>;
}) {
  const seqRef = useRef(0);
  // Host's peer id at mount (members are host-first join order): the only
  // close that ends the race for us. A dead host means no more snapshots,
  // so the remotes freeze and the guest drives on solo under a banner.
  const hostIdRef = useRef<string | null>(netRoom.memberPeerIds()[0] ?? null);
  // Last host snapshot arrival: an abrupt host kill (tab closed, no clean
  // bye) often takes many seconds to surface as a socket close, so silence
  // itself is the signal. 5s tolerates background-tab timer throttling on
  // the host while still calling the race within a corner or two.
  const lastSnapshotRef = useRef<number>(0);
  const hostLostRef = useRef(false);

  // Mount stamp for the watchdog (effects, not render, may read the clock).
  useEffect(() => {
    lastSnapshotRef.current = Date.now();
  }, []);

  /**
   * Ready handshake (see NetHost): this component only mounts once the
   * guest's scene is live - three.js, rapier and the track mesh all built -
   * which is exactly when the host may safely set a lights-out time. The
   * ready is re-sent on a slow tick until the go arrives, so one dropped
   * datagram costs a moment, not the race.
   */
  useEffect(() => {
    const send = () => {
      if (goSignalledRef.current) return;
      const host = hostIdRef.current;
      if (host === null) return;
      netRoom.sendTo(host, { type: "ready" });
    };
    send();
    const id = setInterval(send, 1500);
    return () => clearInterval(id);
  }, [goSignalledRef]);

  /**
   * Guest pose uplink: our own car's truth, from our own simulation. The
   * host nudges its copy of this car toward these samples, so what every
   * other driver sees of us matches what we see of ourselves instead of
   * drifting with input latency (a starved or laggy link used to leave the
   * host's copy AI-driving, and the guest's own correction fighting it -
   * the jitter). Low rate, gross-error correction only: never a teleport.
   */
  useEffect(() => {
    const id = setInterval(() => {
      if (!goSignalledRef.current) return;
      const body = chassisRef.current;
      const host = hostIdRef.current;
      if (!body || host === null || hostLostRef.current) return;
      const p = body.translation();
      const r = body.rotation();
      const v = body.linvel();
      netRoom.sendTo(host, {
        type: "pose",
        slot: playerSlot,
        position: [p.x, p.y, p.z],
        rotation: [r.x, r.y, r.z, r.w],
        linvel: [v.x, v.y, v.z],
        speedMs: Math.hypot(v.x, v.z),
      });
    }, 1000 / POSE_HZ);
    return () => clearInterval(id);
  }, [chassisRef, playerSlot, goSignalledRef]);

  function declareHostLost(): void {
    if (hostLostRef.current) return;
    hostLostRef.current = true;
    if (raceResultRef?.current && raceResultRef.current.textContent === "") {
      raceResultRef.current.textContent = "HOST LEFT THE ROOM — DRIVING ON SOLO";
    }
    netRoom.leave();
  }

  useEffect(() => {
    const id = setInterval(() => {
      const input = playerInputRef.current;
      if (!input) return;
      const members = netRoom.memberPeerIds();
      if (members.length === 0) return;
      seqRef.current += 1;
      netRoom.sendTo(members[0], {
        type: "input",
        seq: seqRef.current,
        throttle: input.throttle,
        brake: input.brake,
        steer: input.steer,
      });
    }, 1000 / INPUT_HZ);
    return () => clearInterval(id);
  }, [playerInputRef]);

  useEffect(
    () =>
      netRoom.onPeerClose((peerId) => {
        if (peerId !== hostIdRef.current) return;
        if (netRoom.getState().status !== "racing") return;
        declareHostLost();
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  useEffect(() => {
    const id = setInterval(() => {
      if (netRoom.getState().status !== "racing") return;
      if (hostIdRef.current === null) return;
      // Only after lights-out: before the go, silence is expected (the room
      // is waiting on readiness), not a dead host.
      if (!goSignalledRef.current) return;
      if (Date.now() - lastSnapshotRef.current > 5000) declareHostLost();
    }, 1000);
    return () => clearInterval(id);
  }, [goSignalledRef]);

  useEffect(
    () =>
      netRoom.onMessage((_, msg) => {
        if (msg.type === "go") {
          // Lights-out alignment from the host (see NetHost.signalGo): stamp
          // it and open the countdown gate. The watchdog baseline restarts
          // here too - snapshots only matter once cars are running.
          goAtRef.current = msg.atMs;
          goSignalledRef.current = true;
          lastSnapshotRef.current = Date.now();
          return;
        }
        if (msg.type === "snapshot") {
          const now = Date.now();
          lastSnapshotRef.current = now;
          for (const car of msg.cars) {
            const buffers = remoteBuffersRef.current;
            if (!buffers) continue;
            const buffer = buffers[car.slot] ?? (buffers[car.slot] = []);
            pushSnapshot(
              buffer,
              now,
              {
                pose: {
                  position: car.position,
                  rotation: car.rotation,
                  linvel: car.linvel,
                },
                speedMs: car.speedMs,
              }
            );
            // Feed the tower/position computation (see Car.tsx): every
            // rival's progress, refreshed at snapshot rate. The player's
            // own entry stays local (exact), never overwritten here.
            const oppIndex = slotToOpponent[car.slot];
            if (oppIndex !== undefined && raceRef.current) {
              raceRef.current.opponents[oppIndex] = {
                lapCount: car.lapCount,
                progressMeters: car.progressMeters,
                speedMs: car.speedMs,
              };
            }
          }
          // Soft correction for the guest's own body: the host's copy is
          // input-driven and we keep uploading our own pose, so the two
          // simulations only part ways on a contact the host resolved
          // differently. Past 3m of divergence, blend a quarter of the way
          // across per snapshot (velocities untouched - it reads as a nudge,
          // never a teleport); inside 3m, do nothing at all, because chasing
          // tiny differences is exactly what made the car jitter.
          const self = msg.cars.find((car) => car.slot === playerSlot);
          const body = chassisRef.current;
          if (self && body && goSignalledRef.current) {
            const p = body.translation();
            const dx = self.position[0] - p.x;
            const dy = self.position[1] - p.y;
            const dz = self.position[2] - p.z;
            if (Math.hypot(dx, dy, dz) > 3) {
              body.setTranslation(
                { x: p.x + dx * 0.25, y: p.y + dy * 0.25, z: p.z + dz * 0.25 },
                true
              );
            }
          }
        } else if (msg.type === "results") {
          if (netResultRef) {
            netResultRef.current = { positions: msg.positions, winnerCode: msg.winnerCode };
          }
        } else if (msg.type === "bye") {
          if (raceResultRef?.current && raceResultRef.current.textContent === "") {
            raceResultRef.current.textContent = "HOST LEFT THE ROOM";
          }
          netRoom.leave();
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  return null;
}
