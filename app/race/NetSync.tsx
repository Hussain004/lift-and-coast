"use client";

import { useEffect, useRef } from "react";
import type { RapierRigidBody } from "@react-three/rapier";
import { netRoom } from "@/lib/net/peer";
import {
  INPUT_HZ,
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
import type { NetCarSnapshot, NetTowerRow } from "@/lib/net/protocol";
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
}) {
  // Frozen join-order roster for input routing: members may leave mid-race,
  // but slots must not shift under running cars.
  const memberPeerIds = useRef<string[]>(netRoom.memberPeerIds());
  const sentResultsRef = useRef(false);

  useEffect(
    () =>
      netRoom.onMessage((fromPeerId, msg) => {
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
        } else if (msg.type === "hello") {
          // No late joins mid-race: the grid was set at START.
          netRoom.dropPeer(fromPeerId, "Race already started - wait in the lobby.");
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
}) {
  const seqRef = useRef(0);

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
      netRoom.onMessage((_, msg) => {
        if (msg.type === "snapshot") {
          const now = Date.now();
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
          // Soft correction for the guest's own body: blend toward host
          // truth past 2.5m of divergence, velocities untouched so it
          // reads as a nudge, never a teleport.
          const self = msg.cars.find((car) => car.slot === playerSlot);
          const body = chassisRef.current;
          if (self && body) {
            const p = body.translation();
            const dx = self.position[0] - p.x;
            const dy = self.position[1] - p.y;
            const dz = self.position[2] - p.z;
            if (Math.hypot(dx, dy, dz) > 2.5) {
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
