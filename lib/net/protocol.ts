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
//
// v3: adds the multiplayer polish set - a lobby READY check (roadmap 11.14),
// per-member ping, a rematch request, safety-car state broadcast, and an
// explicit host-left message so a guest can classify the race instead of
// just being dumped back to the menu. Every one of them is a NEW message type
// with a guard in parseNetMessage below, and the bump matters: an old v2 guest
// would silently ignore a `ready` it does not understand and then sit at the
// start line forever, because it has no way to know it is out of date. Bumping
// means it is rejected at hello with a clear reason instead.
export const PROTOCOL_VERSION = 3;

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
  /** Optional weather preset; older rooms omit it and use clear conditions. */
  weather?: string;
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
    typeof value.tod === "string" &&
    (value.weather === undefined || typeof value.weather === "string")
  );
}

export type NetMessage =
  | { type: "hello"; version: number; driver: NetDriverInfo }
  | { type: "welcome"; version: number; slot: number; settings: NetSettings; roster: RosterMember[] }
  | { type: "roster"; roster: RosterMember[] }
  | { type: "settings"; settings: NetSettings }
  | { type: "start"; settings: NetSettings; slots: Record<string, number>; atMs: number }
  /** Guest -> host: my scene is live, I can take a lights-out time. */
  /**
   * Guest -> host: my scene is live AND I have chosen my driver, so count me
   * in the start. This is the lobby READY CHECK (roadmap 11.14), and it is
   * deliberately the SAME message the v2 start handshake already used rather
   * than a new one.
   *
   * Reusing it is the point: the host already waited on `ready` before
   * sending `go`, so a lobby readiness check is that same wait moved earlier
   * and given a visible state instead of being invisible. A second message
   * would have meant two independent notions of "ready" in one protocol,
   * which is exactly how a start goes out with half the room still loading.
   * `driver` is what lets the host show a per-member car preview before the
   * race exists; it is optional so a client that has not picked yet can still
   * report ready.
   */
  | { type: "ready"; driver?: NetDriverInfo }
  /**
   * Host -> guest: the roster with each member's readiness and last measured
   * latency, so every peer can render the same lobby table without each
   * guessing. Sent on every join/leave/ready change, which at lobby scale (a
   * handful of humans) is a handful of small messages, not a stream.
   */
  | { type: "lobby-state"; members: NetLobbyRow[] }
  /** Either direction: a ping probe carrying the sender's clock. */
  | { type: "ping"; atMs: number; token: number }
  /** Either direction: the reply. RTT is (now - atMs), so no clock sync. */
  | { type: "pong"; atMs: number; token: number }
  /**
   * Guest -> host: I would like to run it again. The host owns the grid and
   * the settings, so a guest can only ask - which is why this is a distinct
   * type and not a `start` the guest is trusted to send.
   */
  | { type: "rematch" }
  /**
   * Host -> all: a new race is being set up on the same room, with the same
   * shape as `start` so the existing start path is reused verbatim.
   */
  | { type: "restart"; settings: NetSettings; slots: Record<string, number>; atMs: number }
  /**
   * Host -> all: the safety car / VSC state, so guests see the same neutral-
   * isation the host is running. The host is the only peer that simulates the
   * state machine, which keeps the star topology: guests never negotiate it
   * with each other.
   */
  | { type: "safety-car"; phase: string; kind: string }
  /**
   * Host -> all: I am gone. Distinct from `bye` (a voluntary leave) because
   * the response is different: a guest that loses the host mid-race has to
   * CLASSIFY the race at that point and show a result, not return to the
   * menu as if nothing had happened.
   */
  | { type: "host-left"; reason: string }
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

/** One row of the lobby table, as broadcast by the host. */
export interface NetLobbyRow {
  peerId: string;
  driver: NetDriverInfo;
  /** True once that member's scene is live and it is willing to start. */
  ready: boolean;
  /** Last measured round-trip to the host in ms, null if never measured. */
  pingMs: number | null;
}

function isNetLobbyRow(value: unknown): value is NetLobbyRow {
  if (!isRecord(value)) return false;
  return (
    typeof value.peerId === "string" &&
    isNetDriverInfo(value.driver) &&
    typeof value.ready === "boolean" &&
    (value.pingMs === null || (typeof value.pingMs === "number" && Number.isFinite(value.pingMs)))
  );
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
      // `driver` is optional (see the message note): a client that has joined
      // but not yet picked reports ready without one, and a present one must
      // still be a well-formed driver or the message is dropped whole rather
      // than half-applied.
      if (value.driver === undefined) return { type: "ready" };
      if (!isNetDriverInfo(value.driver)) return null;
      return { type: "ready", driver: value.driver };
    case "lobby-state":
      if (!Array.isArray(value.members) || !value.members.every(isNetLobbyRow)) return null;
      return { type: "lobby-state", members: value.members };
    case "ping":
    case "pong":
      // Both carry the same shape, and both are validated identically: a pong
      // is only ever used to compute a round trip, so there is no reason for
      // one to accept a field the other would reject.
      if (!numberField(value.atMs) || !numberField(value.token)) return null;
      return { type: value.type, atMs: value.atMs, token: value.token };
    case "rematch":
      return { type: "rematch" };
    case "restart": {
      // Same shape and same validation as `start`, deliberately: a rematch is
      // a start on the same room, and having one code path means the grid
      // assignment and the go-at time cannot drift between the two.
      if (!isNetSettings(value.settings)) return null;
      if (!isRecord(value.slots)) return null;
      const slots: Record<string, number> = {};
      for (const [k, v] of Object.entries(value.slots)) {
        if (typeof v !== "number" || !Number.isInteger(v)) return null;
        slots[k] = v;
      }
      if (!numberField(value.atMs)) return null;
      return { type: "restart", settings: value.settings, slots, atMs: value.atMs };
    }
    case "safety-car":
      // Narrow on purpose: this is display state, so a value outside the
      // known set is dropped rather than shown as an unknown neutralisation
      // the player would race against.
      if (value.phase !== "none" && value.phase !== "active" && value.phase !== "ending") return null;
      if (value.kind !== "sc" && value.kind !== "vsc") return null;
      return { type: "safety-car", phase: value.phase, kind: value.kind };
    case "host-left":
      if (typeof value.reason !== "string") return null;
      return { type: "host-left", reason: value.reason };
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
