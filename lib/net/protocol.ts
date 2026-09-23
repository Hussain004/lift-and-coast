import type { TrackLimitStage } from "../race/trackLimitSequence";

// Plan section 16 (online multiplayer): wire protocol. Rooms are a star:
// every guest holds exactly one reliable, ordered PeerJS data connection
// to the host (the room leader), and the host relays nothing guest-to-
// guest - snapshots fan out from the host, inputs fan in. All messages
// are plain JSON objects with a `type` tag; every inbound message is
// validated by its guard below before anything reads a field, so a stale
// client, a hand-crafted link or a corrupted packet degrades to a dropped
// message, never a crash. Versioned (`PROTOCOL_VERSION`) so a mismatched
// client gets a clean rejection instead of a silent misread.

// v2: adds the ready/go start handshake (guests acknowledge their scene
// is live before lights-out - the host no longer races off while a guest
// is still loading) and guest->host pose authority (the host blends its
// copy of a guest's car toward the guest's own reported pose, which ends
// the guest-side correction jitter). Cross-version rooms are rejected at
// hello, so v1 peers can never half-understand a v2 room.
export const PROTOCOL_VERSION = 2;

/** Room codes are short, URL-safe, and human-readable over voice. */
export const ROOM_CODE_LENGTH = 6;

export function isRoomCode(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === ROOM_CODE_LENGTH &&
    /^[A-Z0-9]+$/.test(value)
  );
}

export function makeRoomCode(random: () => number = Math.random): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += alphabet[Math.floor(random() * alphabet.length)];
  }
  return code;
}

/** PeerJS peer id for a room code - prefixed so app peers never collide
 * with anything else on the shared cloud. */
export function roomPeerId(code: string): string {
  return `lift-and-coast-room-${code}`;
}

export type NetRole = "host" | "guest";

export interface NetDriverInfo {
  code: string;
  name: string;
  teamId: string;
  color: string;
}

export interface NetSettings {
  track: string;
  mode: "race";
  laps: number;
  rivals: number;
  tod: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export interface RosterMember {
  peerId: string;
  driver: NetDriverInfo;
}

function isRosterMember(value: unknown): value is RosterMember {
  return isRecord(value) && typeof value.peerId === "string" && isNetDriverInfo(value.driver);
}

function isNetDriverInfo(value: unknown): value is NetDriverInfo {
  if (!isRecord(value)) return false;
  return (
    typeof value.code === "string" &&
    typeof value.name === "string" &&
    typeof value.teamId === "string" &&
    typeof value.color === "string"
  );
}

function isNetSettings(value: unknown): value is NetSettings {
  if (!isRecord(value)) return false;
  return (
    typeof value.track === "string" &&
    value.mode === "race" &&
    typeof value.laps === "number" &&
    Number.isInteger(value.laps) &&
    typeof value.rivals === "number" &&
    Number.isInteger(value.rivals) &&
    typeof value.tod === "string"
  );
}

export type NetMessage =
  | { type: "hello"; version: number; driver: NetDriverInfo }
  | { type: "welcome"; version: number; slot: number; settings: NetSettings; roster: RosterMember[] }
  | { type: "roster"; roster: RosterMember[] }
  | { type: "settings"; settings: NetSettings }
  | { type: "start"; settings: NetSettings; slots: Record<string, number>; atMs: number }
  /** Guest -> host: my scene is live, I can take a lights-out time. */
  | { type: "ready" }
  /** Host -> all: lights-out alignment time (see RaceStartCountdown). */
  | { type: "go"; atMs: number }
  /** Guest -> host: authoritative pose for the guest's own car. */
  | {
      type: "pose";
      slot: number;
      position: [number, number, number];
      rotation: [number, number, number, number];
      linvel: [number, number, number];
      speedMs: number;
    }
  | { type: "input"; seq: number; throttle: number; brake: number; steer: number }
  | { type: "snapshot"; tick: number; cars: NetCarSnapshot[]; tower: NetTowerRow[] }
  /**
   * Finishing board, keyed by grid slot (String(slot) -> position). Slots,
   * not driver codes: two humans may pick the same driver (same defaults),
   * and codes would collide - slots are unique by construction.
   */
  | { type: "results"; positions: Record<string, number>; winnerCode: string }
  | { type: "bye"; reason: string }
  | { type: "error"; reason: string };

export interface NetCarSnapshot {
  /** Grid slot (0-based): the join-order-independent car identity. */
  slot: number;
  position: [number, number, number];
  rotation: [number, number, number, number];
  linvel: [number, number, number];
  /** Signed forward speed for HUD gear/rpm readouts. */
  speedMs: number;
  lapCount: number;
  progressMeters: number;
  /** Broadcast timing fields; optional for compatibility with older peers. */
  lastLapSeconds?: number | null;
  bestLapSeconds?: number | null;
  trackLimitStage?: TrackLimitStage;
  trackLimitWarningNumber?: number | null;
}

export interface NetTowerRow {
  slot: number;
  code: string;
  color: string;
  position: number;
  gapSeconds: number | null;
  lapsDown: number;
  isPlayer: boolean;
}

function isVec3(value: unknown): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every((e) => typeof e === "number");
}

function isVec4(value: unknown): value is [number, number, number, number] {
  return Array.isArray(value) && value.length === 4 && value.every((e) => typeof e === "number");
}

function isNetCarSnapshot(value: unknown): value is NetCarSnapshot {
  if (!isRecord(value)) return false;
  const optionalNumber = (field: unknown): boolean =>
    field === undefined || field === null || typeof field === "number";
  const stage = value.trackLimitStage;
  const validStage =
    stage === undefined ||
    stage === "clear" ||
    stage === "warning" ||
    stage === "black-white" ||
    stage === "penalty";
  return (
    typeof value.slot === "number" &&
    isVec3(value.position) &&
    isVec4(value.rotation) &&
    isVec3(value.linvel) &&
    typeof value.speedMs === "number" &&
    typeof value.lapCount === "number" &&
    typeof value.progressMeters === "number" &&
    optionalNumber(value.lastLapSeconds) &&
    optionalNumber(value.bestLapSeconds) &&
    optionalNumber(value.trackLimitWarningNumber) &&
    validStage
  );
}

function isNetTowerRow(value: unknown): value is NetTowerRow {
  if (!isRecord(value)) return false;
  return (
    typeof value.slot === "number" &&
    typeof value.code === "string" &&
    typeof value.color === "string" &&
    typeof value.position === "number" &&
    (typeof value.gapSeconds === "number" || value.gapSeconds === null) &&
    typeof value.lapsDown === "number" &&
    typeof value.isPlayer === "boolean"
  );
}

/** Validates an inbound message, returning it typed or null to drop. */
export function parseNetMessage(value: unknown): NetMessage | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  const numberField = (v: unknown): v is number => typeof v === "number";
  switch (value.type) {
    case "hello":
      if (value.version !== PROTOCOL_VERSION || !isNetDriverInfo(value.driver)) return null;
      return { type: "hello", version: value.version, driver: value.driver };
    case "welcome": {
      if (value.version !== PROTOCOL_VERSION) return null;
      if (!numberField(value.slot)) return null;
      if (!isNetSettings(value.settings)) return null;
      if (!Array.isArray(value.roster) || !value.roster.every(isRosterMember)) return null;
      return { type: "welcome", version: value.version, slot: value.slot, settings: value.settings, roster: value.roster };
    }
    case "roster":
      if (!Array.isArray(value.roster) || !value.roster.every(isRosterMember)) return null;
      return { type: "roster", roster: value.roster };
    case "settings":
      if (!isNetSettings(value.settings)) return null;
      return { type: "settings", settings: value.settings };
    case "start": {
      if (!isNetSettings(value.settings)) return null;
      if (!isRecord(value.slots)) return null;
      const slots: Record<string, number> = {};
      for (const [k, v] of Object.entries(value.slots)) {
        if (typeof v !== "number" || !Number.isInteger(v)) return null;
        slots[k] = v;
      }
      if (!numberField(value.atMs)) return null;
      return { type: "start", settings: value.settings, slots, atMs: value.atMs };
    }
    case "ready":
      return { type: "ready" };
    case "go":
      if (!numberField(value.atMs)) return null;
      return { type: "go", atMs: value.atMs };
    case "pose": {
      if (
        !numberField(value.slot) ||
        !isVec3(value.position) ||
        !isVec4(value.rotation) ||
        !isVec3(value.linvel) ||
        !numberField(value.speedMs)
      ) {
        return null;
      }
      return {
        type: "pose",
        slot: value.slot,
        position: [value.position[0], value.position[1], value.position[2]],
        rotation: [value.rotation[0], value.rotation[1], value.rotation[2], value.rotation[3]],
        linvel: [value.linvel[0], value.linvel[1], value.linvel[2]],
        speedMs: value.speedMs,
      };
    }
    case "input":
      if (
        !numberField(value.seq) ||
        !numberField(value.throttle) ||
        !numberField(value.brake) ||
        !numberField(value.steer)
      ) {
        return null;
      }
      return {
        type: "input",
        seq: value.seq,
        throttle: Math.min(1, Math.max(0, value.throttle)),
        brake: Math.min(1, Math.max(0, value.brake)),
        steer: Math.min(1, Math.max(-1, value.steer)),
      };
    case "snapshot": {
      if (!numberField(value.tick)) return null;
      if (!Array.isArray(value.cars) || !value.cars.every(isNetCarSnapshot)) return null;
      if (!Array.isArray(value.tower) || !value.tower.every(isNetTowerRow)) return null;
      return { type: "snapshot", tick: value.tick, cars: value.cars, tower: value.tower };
    }
    case "results": {
      if (!isRecord(value.positions)) return null;
      const positions: Record<string, number> = {};
      for (const [k, v] of Object.entries(value.positions)) {
        // Slot keys only (see the type note): driver codes never land here.
        if (!/^\d+$/.test(k)) return null;
        if (typeof v !== "number" || !Number.isInteger(v)) return null;
        positions[k] = v;
      }
      if (typeof value.winnerCode !== "string") return null;
      return { type: "results", positions, winnerCode: value.winnerCode };
    }
    case "bye":
      if (typeof value.reason !== "string") return null;
      return { type: "bye", reason: value.reason };
    case "error":
      if (typeof value.reason !== "string") return null;
      return { type: "error", reason: value.reason };
    default:
      return null;
  }
}

/**
 * Totally-ordered lobby membership: the host is always first, guests follow
 * in join order. Slots (grid order) derive from this list, so every peer
 * computes the same slots independently - no assignment round-trip.
 */
export function slotForPeer(members: readonly string[], peerId: string): number {
  return members.indexOf(peerId);
}
