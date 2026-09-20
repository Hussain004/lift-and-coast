// Plan section 16 (online multiplayer): lobby membership as a pure
// reducer - members, leader, settings and start readiness with no I/O,
// so the whole flow is unit-testable and both the host panel and the
// guest panel derive from one state shape. PeerJS wiring lives in the
// React layer (see app/Multiplayer.tsx); this module never touches the
// network.

import type { NetDriverInfo, NetSettings } from "./protocol";

/** Turn A cap: host + 1 guest. Raised once the sync core is proven. */
export const MAX_NET_HUMANS = 2;

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
 */
export function lobbyReducer(state: LobbyState, event: LobbyEvent): LobbyState {
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
export function setHostDriver(state: LobbyState, driver: NetDriverInfo): LobbyState {
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
