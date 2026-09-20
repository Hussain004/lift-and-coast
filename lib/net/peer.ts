// Plan section 16 (online multiplayer): live room transport. One module
// singleton (not React state) so the connection survives client-side
// navigation home <-> race - the lobby lives on `/` and the race on
// `/race`, but the PeerJS peer and its data connections must not drop
// between them. Pure lobby/shape logic lives in ./lobby and ./protocol
// (both unit-tested); this module owns PeerJS lifecycle and routing only.
//
// Signaling runs over PeerJS's free cloud (no accounts, no backend to
// maintain - right-sized for friends-scale rooms). Trade-offs, stated
// plainly: NAT traversal is STUN-first, so symmetric-NAT peers may fail
// to connect, and the free cloud owes no uptime SLA. The protocol guards
// every message (see protocol.ts), so a flaky cloud degrades to dropped
// messages and clean errors, never corrupt state. A self-hosted
// PeerServer or a Supabase channel can replace this file later without
// touching the UI or the race sync - the message shapes are the contract.
import {
  MAX_NET_HUMANS,
  type LobbyMember,
} from "./lobby";
import {
  PROTOCOL_VERSION,
  isRoomCode,
  makeRoomCode,
  parseNetMessage,
  roomPeerId,
  type NetDriverInfo,
  type NetMessage,
  type NetRole,
  type NetSettings,
} from "./protocol";

export type RoomStatus = "idle" | "opening" | "lobby" | "racing" | "closed" | "error";

export interface RoomSnapshot {
  status: RoomStatus;
  role: NetRole | null;
  code: string | null;
  selfId: string | null;
  members: LobbyMember[];
  settings: NetSettings | null;
  notice: string | null;
}

// PeerJS types without importing the package at module scope (it touches
// browser APIs on import - dynamically imported inside connect paths so
// SSR/prerender never evaluates it and it stays out of the initial bundle).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PeerInstance = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Connection = any;

type Listener = (snapshot: RoomSnapshot) => void;

const DEFAULT_SETTINGS: NetSettings = { track: "silverstone", mode: "race", laps: 3, rivals: 1, tod: "day" };

class NetRoom {
  private peer: PeerInstance | null = null;
  private conns = new Map<string, Connection>();
  private listeners = new Set<Listener>();
  private messageHandlers = new Set<(fromPeerId: string, msg: NetMessage) => void>();
  private state: RoomSnapshot = {
    status: "idle",
    role: null,
    code: null,
    selfId: null,
    members: [],
    settings: null,
    notice: null,
  };
  /** Latest settings broadcast, so late joiners and race-page mounts read them. */
  private lastSettings: NetSettings | null = null;

  getState(): RoomSnapshot {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Raw message subscription for race-sync components (snapshots, inputs). */
  onMessage(handler: (fromPeerId: string, msg: NetMessage) => void): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  private setState(patch: Partial<RoomSnapshot>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  private async loadPeer(): Promise<typeof import("peerjs")> {
    return await import("peerjs");
  }

  private attachPeerCommon(peer: PeerInstance): void {
    peer.on("error", (err: { type?: string }) => {
      const type = err?.type ?? "unknown";
      if (type === "peer-unavailable") {
        this.setState({ status: "error", notice: "Room not found. Check the code." });
      } else if (type === "unavailable-id" || type === "taken") {
        this.setState({ status: "error", notice: "Room code taken - retrying." });
      } else if (type === "network" || type === "server-error" || type === "socket-error") {
        this.setState({ status: "error", notice: "Network hiccup - check connection and retry." });
      }
    });
  }

  private dispatch(fromPeerId: string, raw: unknown): void {
    const msg = parseNetMessage(raw);
    if (!msg) return;
    for (const handler of this.messageHandlers) handler(fromPeerId, msg);
  }

  private trackConnection(peerId: string, conn: Connection): void {
    conn.on("open", () => {
      this.conns.set(peerId, conn);
    });
    conn.on("data", (raw: unknown) => this.dispatch(peerId, raw));
    const drop = () => {
      this.conns.delete(peerId);
      for (const cb of this.peerCloseHandlers) cb(peerId);
    };
    conn.on("close", drop);
    conn.on("error", drop);
  }

  private peerCloseHandlers = new Set<(peerId: string) => void>();

  /** Notified when a data connection drops (guest left / network lost). */
  onPeerClose(handler: (peerId: string) => void): () => void {
    this.peerCloseHandlers.add(handler);
    return () => {
      this.peerCloseHandlers.delete(handler);
    };
  }

  /** Host path: claim a room code and wait for guests. Resolves the code. */
  async hostRoom(driver: NetDriverInfo, settings: NetSettings): Promise<string> {
    this.leave();
    const { Peer } = await this.loadPeer();
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = makeRoomCode();
      let peer: PeerInstance | null = null;
      try {
        peer = new Peer(roomPeerId(code));
        this.peer = peer;
        this.attachPeerCommon(peer);
        await new Promise<void>((resolve, reject) => {
          peer.on("open", () => resolve());
          peer.on("error", (err: { type?: string }) => {
            if (err?.type === "unavailable-id" || err?.type === "taken") reject(new Error("taken"));
          });
        });
        this.setState({
          status: "lobby",
          role: "host",
          code,
          selfId: peer.id,
          members: [{ peerId: peer.id, driver }],
          settings,
          notice: null,
        });
        this.lastSettings = settings;
        peer.on("connection", (conn: Connection) => this.trackConnection(conn.peer, conn));
        return code;
      } catch {
        try {
          peer?.destroy();
        } catch {
          /* ignore */
        }
      }
    }
    this.setState({ status: "error", notice: "Could not claim a room code - retry." });
    throw new Error("room-claim-failed");
  }

  /** Guest path: connect to a room and introduce ourselves. Resolves once
   * the host accepts (welcome) or rejects/stalls (error/timeout). */
  async joinRoom(code: string, driver: NetDriverInfo): Promise<void> {
    if (!isRoomCode(code)) {
      this.setState({ status: "error", notice: "That code doesn't look right." });
      throw new Error("bad-code");
    }
    this.leave();
    const { Peer } = await this.loadPeer();
    const peer: PeerInstance = new Peer();
    this.peer = peer;
    this.attachPeerCommon(peer);
    this.setState({ status: "opening", role: "guest", code, notice: null });
    await new Promise<void>((resolve, reject) => {
      peer.on("open", () => resolve());
      peer.on("error", () => reject(new Error("open-failed")));
      setTimeout(() => reject(new Error("open-timeout")), 15000);
    });
    const conn: Connection = peer.connect(roomPeerId(code), { reliable: true });
    this.trackConnection(roomPeerId(code), conn);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("join-timeout")), 15000);
      const onOpen = () => {
        conn.send({ type: "hello", version: PROTOCOL_VERSION, driver });
      };
      const onData = (raw: unknown) => {
        const msg = parseNetMessage(raw);
        if (!msg) return;
        if (msg.type === "welcome") {
          if (msg.version !== PROTOCOL_VERSION) {
            clearTimeout(timeout);
            reject(new Error("version-mismatch"));
            return;
          }
          clearTimeout(timeout);
          this.setState({
            status: "lobby",
            selfId: peer.id,
            members: [{ peerId: peer.id, driver }],
            settings: msg.settings,
            notice: null,
          });
          this.lastSettings = msg.settings;
          // Roster arrives via welcome and follow-up roster broadcasts.
          for (const handler of this.messageHandlers) {
            handler(roomPeerId(code), { type: "roster", roster: msg.roster });
          }
          resolve();
          return;
        }
        if (msg.type === "error") {
          clearTimeout(timeout);
          this.setState({ status: "error", notice: msg.reason });
          reject(new Error(msg.reason));
        }
      };
      conn.on("open", onOpen);
      conn.on("data", onData);
    });
    peer.on("connection", (c: Connection) => this.trackConnection(c.peer, c));
  }

  /** Current lobby members (host-first), for roster derivation. */
  members(): LobbyMember[] {
    return this.state.members;
  }

  memberPeerIds(): string[] {
    return this.state.members.map((m) => m.peerId);
  }

  setMembers(members: LobbyMember[]): void {
    this.setState({ members });
  }

  setSettings(settings: NetSettings): void {
    this.lastSettings = settings;
    this.setState({ settings });
  }

  getSettings(): NetSettings | null {
    return this.state.settings ?? this.lastSettings ?? DEFAULT_SETTINGS;
  }

  setNotice(notice: string | null): void {
    this.setState({ notice });
  }

  markRacing(): void {
    this.setState({ status: "racing" });
  }

  markLobby(): void {
    this.setState({ status: "lobby" });
  }

  sendTo(peerId: string, msg: NetMessage): void {
    this.conns.get(peerId)?.send(msg);
  }

  /** Rejects a peer (room full, version mismatch): error first so they
   * see why, then drop the socket. */
  dropPeer(peerId: string, reason: string): void {
    try {
      this.conns.get(peerId)?.send({ type: "error", reason });
    } catch {
      /* ignore */
    }
    try {
      this.conns.get(peerId)?.close();
    } catch {
      /* ignore */
    }
    this.conns.delete(peerId);
  }

  broadcast(msg: NetMessage): void {
    for (const conn of this.conns.values()) {
      try {
        conn.send(msg);
      } catch {
        /* a dead socket degrades to a dropped message */
      }
    }
  }

  /** Human headcount guard shared by host accept paths. */
  static roomFull(memberCount: number): boolean {
    return memberCount >= MAX_NET_HUMANS;
  }

  /**
   * Voluntary leave: say bye first (so guests see why), then tear down to
   * idle. For the kicked/host-left path use shutdown() instead - it keeps
   * the reason on screen instead of wiping it.
   */
  leave(reason = "Leader left the room."): void {
    try {
      this.broadcast({ type: "bye", reason });
    } catch {
      /* ignore */
    }
    try {
      for (const conn of this.conns.values()) conn.close();
    } catch {
      /* ignore */
    }
    this.conns.clear();
    try {
      this.peer?.destroy();
    } catch {
      /* ignore */
    }
    this.peer = null;
    this.lastSettings = null;
    this.setState({
      status: "idle",
      role: null,
      code: null,
      selfId: null,
      members: [],
      settings: null,
      notice: null,
    });
  }

  /**
   * Kicked / host-left teardown: same teardown as leave() but no bye
   * broadcast (the other side is already gone) and the reason survives on
   * the idle panel (status "closed") instead of being wiped - otherwise a
   * kicked guest lands back on create/join with no idea why.
   */
  shutdown(notice: string): void {
    try {
      for (const conn of this.conns.values()) conn.close();
    } catch {
      /* ignore */
    }
    this.conns.clear();
    try {
      this.peer?.destroy();
    } catch {
      /* ignore */
    }
    this.peer = null;
    this.lastSettings = null;
    this.setState({
      status: "closed",
      role: null,
      code: null,
      selfId: null,
      members: [],
      settings: null,
      notice,
    });
  }
}

export const netRoom = new NetRoom();
