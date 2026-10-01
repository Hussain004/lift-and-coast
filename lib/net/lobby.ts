// Plan section 16 (online multiplayer): lobby membership as a pure
// reducer - members, leader, settings and start readiness with no I/O,
// so the whole flow is unit-testable and both the host panel and the
// guest panel derive from one state shape. PeerJS wiring lives in the
// React layer (see app/Multiplayer.tsx); this module never touches the
// network.

import type { NetDriverInfo, NetLobbyRow, NetSettings } from "./protocol";

/** Full-room cap: host + 7 guests. Grids stay within the 20-car field
 * (AI fills the rest), so no other layer needs a cap check - START clamps
 * rivals to at least members-1 (see Multiplayer.tsx). */
export const MAX_NET_HUMANS = 8;

export interface LobbyMember {
  /** PeerJS peer id (stable per browser session). */
  peerId: string;
  driver: NetDriverInfo;
}

export interface LobbyState {
  /** Room code (see protocol.makeRoomCode), null until created. */
  code: string | null;
  /** Local peer id, null until PeerJS opens. */
  selfId: string | null;
  /** True on the peer that created the room. */
  isHost: boolean;
  /** Ordered members: host first, guests in join order (see slotForPeer). */
  members: LobbyMember[];
  settings: NetSettings;
  /** Guest-side: latest settings broadcast from the host. */
  started: boolean;
  /** Last rejection/error notice for the panel, null when clear. */
  notice: string | null;
}

export function initialLobbyState(isHost: boolean, settings: NetSettings): LobbyState {
  return {
    code: null,
    selfId: null,
    isHost,
    members: [],
    settings,
    started: false,
    notice: null,
  };
}

export type LobbyEvent =
  | { type: "opened"; selfId: string; code: string }
  | { type: "member-joined"; peerId: string; driver: NetDriverInfo }
  | { type: "member-left"; peerId: string }
  | { type: "settings"; settings: NetSettings }
  | { type: "start" }
  | { type: "notice"; notice: string }
  | { type: "clear-notice" };

/**
 * Applies one lobby event. Joining beyond the human cap (or twice) is
 * refused by returning the state unchanged plus a notice - the caller
 * sends the rejection; the reducer itself stays side-effect free.
 * Unknown members leaving is a no-op (stale disconnects race joins).
 *
 * Generic over the state so a CALLER'S EXTRA FIELDS SURVIVE. That is not
 * decoration: `ReadyLobbyState` extends this with a per-member `presence`
 * map, and a reducer that widened the type back to LobbyState would silently
 * drop it on the first join or leave - which is exactly the bug the presence
 * map exists to avoid.
 */
export function lobbyReducer<T extends LobbyState>(state: T, event: LobbyEvent): T {
  switch (event.type) {
    case "opened":
      return { ...state, selfId: event.selfId, code: event.code };
    case "member-joined": {
      if (state.members.some((m) => m.peerId === event.peerId)) return state;
      if (state.members.length >= MAX_NET_HUMANS) {
        return { ...state, notice: "Room is full." };
      }
      return { ...state, members: [...state.members, { peerId: event.peerId, driver: event.driver }], notice: null };
    }
    case "member-left":
      return { ...state, members: state.members.filter((m) => m.peerId !== event.peerId) };
    case "settings":
      return state.isHost ? state : { ...state, settings: event.settings };
    case "start":
      return { ...state, started: true };
    case "notice":
      return { ...state, notice: event.notice };
    case "clear-notice":
      return { ...state, notice: null };
  }
}

/** The host's own seat: called with the roster pick right after the peer
 * opens, so member ordering (host-first) holds from the first render. */
export function setHostDriver<T extends LobbyState>(state: T, driver: NetDriverInfo): T {
  if (!state.isHost || state.selfId === null) return state;
  return {
    ...state,
    members: [{ peerId: state.selfId, driver }, ...state.members.filter((m) => m.peerId !== state.selfId)],
  };
}

/** Grid slots for every member, derived from join order (see slotForPeer). */
export function lobbySlots(state: LobbyState): Record<string, number> {
  const slots: Record<string, number> = {};
  state.members.forEach((m, index) => {
    slots[m.peerId] = index;
  });
  return slots;
}

/*
 * READINESS AND LATENCY (roadmap 11.14). Both are per-member and both are
 * kept HERE rather than in the PeerJS layer, because the host has to be able
 * to answer "can I start yet" and "how is the connection" from the same pure
 * state the panel renders - a second, parallel truth in the transport would
 * be one more thing to keep in sync and one more thing to get wrong under a
 * flaky cloud.
 */

export interface MemberPresence {
  /** The member's scene is live and it is willing to start. */
  ready: boolean;
  /** Latest measured round-trip in ms, null until first measured. */
  pingMs: number | null;
}

export interface ReadyLobbyState extends LobbyState {
  presence: Record<string, MemberPresence>;
}

export function createReadyLobbyState(isHost: boolean, settings: NetSettings): ReadyLobbyState {
  return { ...initialLobbyState(isHost, settings), presence: {} };
}

export type ReadyLobbyEvent =
  | LobbyEvent
  | { type: "member-ready"; peerId: string; driver?: NetDriverInfo }
  | { type: "member-ping"; peerId: string; pingMs: number }
  | { type: "member-unready"; peerId: string };

/**
 * Preserves `presence` across every membership change.
 *
 * This is the whole reason the ready state is a separate map keyed by peer id
 * rather than a field on the member: members are rebuilt wholesale on every
 * join and leave, so anything stored on the member object would be thrown away
 * by a routine roster update. Presence that forgets itself is a lobby that
 * deadlocks on a start nobody is ready for.
 */
function withPresence(state: ReadyLobbyState, next: LobbyState): ReadyLobbyState {
  const presence: Record<string, MemberPresence> = {};
  for (const member of next.members) {
    presence[member.peerId] = state.presence[member.peerId] ?? { ready: false, pingMs: null };
  }
  return { ...next, presence };
}

export function readyLobbyReducer(state: ReadyLobbyState, event: ReadyLobbyEvent): ReadyLobbyState {
  switch (event.type) {
    case "member-ready": {
      // A peer that is not in the roster is ignored rather than given an
      // entry: a stale `ready` from someone who already left must not be
      // able to reappear as a phantom row.
      if (!state.members.some((m) => m.peerId === event.peerId)) return state;
      const previous = state.presence[event.peerId] ?? { ready: false, pingMs: null };
      // The driver is taken from `ready` when present, because it is the only
      // message a guest sends that is guaranteed to arrive before the race
      // exists - which is what makes the pre-race car preview possible.
      const members = event.driver
        ? state.members.map((m) => (m.peerId === event.peerId ? { ...m, driver: event.driver as NetDriverInfo } : m))
        : state.members;
      return {
        ...state,
        members,
        presence: { ...state.presence, [event.peerId]: { ...previous, ready: true } },
      };
    }
    case "member-unready": {
      if (!state.members.some((m) => m.peerId === event.peerId)) return state;
      const previous = state.presence[event.peerId];
      if (!previous) return state;
      return {
        ...state,
        presence: { ...state.presence, [event.peerId]: { ...previous, ready: false } },
      };
    }
    case "member-ping": {
      if (!state.members.some((m) => m.peerId === event.peerId)) return state;
      const previous = state.presence[event.peerId] ?? { ready: false, pingMs: null };
      return {
        ...state,
        presence: { ...state.presence, [event.peerId]: { ...previous, pingMs: event.pingMs } },
      };
    }
    default:
      return withPresence(state, lobbyReducer(state, event));
  }
}

/**
 * Every GUEST currently willing to start.
 *
 * The host is excluded deliberately and this was a bug the first time round:
 * the host's readiness is implicit (it is the one running the room, see
 * hostIsReady) and is never sent as a `ready`, so including it here meant
 * `allReady` was permanently false and `canStart` could never fire - the
 * start button would simply never light up. Use `canStart` to ask the real
 * question, which is host AND every guest.
 */
export function allReady(state: ReadyLobbyState): boolean {
  const guests = state.members.filter((m) => m.peerId !== state.selfId);
  return guests.length > 0 && guests.every((m) => state.presence[m.peerId]?.ready === true);
}

/**
 * Guests who have not reported ready yet, for the host's "waiting on" list.
 * The host is not in it - it is not waiting on itself.
 */
export function membersNotReady(state: ReadyLobbyState): LobbyMember[] {
  return state.members.filter(
    (m) => m.peerId !== state.selfId && state.presence[m.peerId]?.ready !== true
  );
}

/** The host's own readiness is implicit: it is running, so it is ready. */
export function hostIsReady(state: ReadyLobbyState): boolean {
  return state.isHost && state.selfId !== null;
}

/** Whether the host may send the go. */
export function canStart(state: ReadyLobbyState): boolean {
  return hostIsReady(state) && allReady(state);
}

/**
 * The broadcast table, in the same order as `members` (host first).
 *
 * The host's own row is reported as ready: it is the peer running the room,
 * and a guest rendering the table that showed the host as still loading would
 * be waiting on someone who is never going to send anything.
 */
export function lobbyRows(state: ReadyLobbyState): NetLobbyRow[] {
  return state.members.map((m) => ({
    peerId: m.peerId,
    driver: m.driver,
    ready: m.peerId === state.selfId ? hostIsReady(state) : state.presence[m.peerId]?.ready === true,
    pingMs: state.presence[m.peerId]?.pingMs ?? null,
  }));
}
