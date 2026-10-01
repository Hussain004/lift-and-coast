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
  type NetLobbyRow,
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

  /** Latency sampling runs for as long as the room is open (see startPinging). */
  private dispatch(fromPeerId: string, raw: unknown): void {
    const msg = parseNetMessage(raw);
    if (!msg) return;
    // Ping/pong are consumed HERE rather than handed to the message handlers:
    // they are transport-level, and leaking two round trips a second into the
    // race-sync consumers would mean every listener had to know to ignore
    // them.
    // Any message at all is proof of life, recorded BEFORE the type is
    // examined (see lastHeard).
    this.lastHeard.set(fromPeerId, Date.now());
    if (msg.type === "ping" || msg.type === "pong") {
      this.handleLatencyMessage(fromPeerId, msg);
      return;
    }
    // The host is the only peer that tracks readiness - it is the one that has
    // to decide whether the start can go out - so a guest hearing `ready`
    // from the host (the broadcast) does not record it locally.
    if (msg.type === "lobby-state" && this.state.role !== "host") {
      // A guest adopts the host's table wholesale. Guarded by parseNetMessage
      // upstream, and deliberately not merged with local state: a half-merged
      // table is exactly the second truth this replaces.
      this.hostRows = msg.members;
      this.notifyPresence();
      return;
    }
    // A guest that has just been kicked or has seen a roster change re-derives
    // its own row immediately, so the very first paint is not stale.
    if (msg.type === "ready" && this.state.role === "host") {
      this.markReady(fromPeerId, true);
      if (msg.driver) {
        this.setMembers(
          this.state.members.map((m) => (m.peerId === fromPeerId ? { ...m, driver: msg.driver as NetDriverInfo } : m))
        );
      }
    }
    for (const handler of this.messageHandlers) handler(fromPeerId, msg);
  }

  private trackConnection(peerId: string, conn: Connection): void {
    conn.on("open", () => {
      this.conns.set(peerId, conn);
      // Start the liveness clock now: from this moment the peer has ~6s to
      // prove it is alive or it gets reaped.
      this.lastHeard.set(peerId, Date.now());
      // Probe immediately rather than waiting a full interval: a player who
      // just joined should not stare at a blank latency cell for two seconds.
      this.sendPing(peerId);
    });
    conn.on("data", (raw: unknown) => this.dispatch(peerId, raw));
    const drop = () => {
      this.conns.delete(peerId);
      this.lastHeard.delete(peerId);
      this.latencies.delete(peerId);
      this.readiness.delete(peerId);
      for (const cb of this.peerCloseHandlers) cb(peerId);
    };
    conn.on("close", drop);
    conn.on("error", drop);
  }

  private peerCloseHandlers = new Set<(peerId: string) => void>();

  /*
   * LATENCY (roadmap 11.14). Ping is deliberately a round trip measured from
   * the PROBE'S OWN timestamp rather than a clock the two sides agree on:
   * RTT is (now - atMs) computed by the same peer that sent it, so it needs
   * no clock synchronisation and cannot be skewed by the two browsers having
   * different system clocks. That is the whole reason a ping/pong exists
   * instead of reading a shared time base.
   *
   * The token is echoed so a reply can be matched to its probe: connections
   * are reliable and ordered, so in practice a single in-flight probe is
   * enough, but matching on the token means a reordered or duplicated reply
   * cannot be mistaken for a fresh one.
   */
  private pingToken = 1;
  private readonly PING_INTERVAL_MS = 2000;
  private readonly PING_TIMEOUT_MS = 6000;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pendingPings = new Map<number, number>();
  private latencies = new Map<string, number>();
  /**
   * Last time ANY message arrived from a peer, in ms. This is the liveness
   * signal, and it is deliberately not ping-specific: a guest at 30Hz
   * snapshots is obviously alive, and treating those as missed pings would
   * declare a busy peer dead.
   */
  private lastHeard = new Map<string, number>();

  /** Latest measured round-trip to a peer, or null if never measured. */
  pingMs(peerId: string): number | null {
    return this.latencies.get(peerId) ?? null;
  }

  /**
   * Per-member readiness, held here because the HOST is the only peer that
   * knows whether everyone is loaded. A guest's own readiness is trivially
   * true; the host's copy of every guest's comes from their `ready` message.
   */
  private readiness = new Map<string, boolean>();
  private presenceHandlers = new Set<() => void>();
  /**
   * The host's broadcast readiness table, on a guest.
   *
   * A guest CANNOT work this out for itself. Live two-tab testing showed the
   * host row rendering as "LOADING" on the guest's screen while the host was
   * obviously sitting in a ready lobby - because a guest only ever hears the
   * host's pings, and readiness is not a thing a ping can carry. The guest was
   * inferring the host's state from its own socket, which is a second truth
   * that is simply wrong.
   *
   * So the host publishes the table (see broadcastLobbyState) and the guest
   * renders it verbatim. One authority, one answer, and the same table the
   * start decision is made from.
   */
  private hostRows: NetLobbyRow[] | null = null;

  /** Called when readiness or a latency reading changes. */
  onPresenceChange(handler: () => void): () => void {
    this.presenceHandlers.add(handler);
    return () => {
      this.presenceHandlers.delete(handler);
    };
  }

  private notifyPresence(): void {
    for (const handler of this.presenceHandlers) handler();
  }

  /**
   * One member's presence, from whichever authority knows it.
   *
   * On the host that is its own record. On a guest it is the host's broadcast
   * row, falling back to the local guess ONLY for the guest's own row - the
   * one thing a guest genuinely does know, because it is the one that pressed
   * the button. Every other row, including the host's, comes from the host.
   */
  presenceOf(peerId: string): { ready: boolean; pingMs: number | null } {
    if (this.state.role !== "host" && this.hostRows !== null) {
      const row = this.hostRows.find((r) => r.peerId === peerId);
      if (row) return { ready: row.ready, pingMs: row.pingMs };
      if (peerId === this.state.selfId) return { ready: true, pingMs: this.latencies.get(peerId) ?? null };
    }
    return {
      ready: peerId === this.state.selfId || this.readiness.get(peerId) === true,
      pingMs: this.latencies.get(peerId) ?? null,
    };
  }

  /**
   * The host publishes its readiness table so every guest renders the same
   * lobby rather than each guessing who is loaded from its own connection.
   * Cheap at lobby scale: a handful of rows, sent only when something changed.
   */
  broadcastLobbyState(rows: NetLobbyRow[]): void {
    this.broadcast({ type: "lobby-state", members: rows });
  }

  markReady(peerId: string, ready: boolean): void {
    if (this.readiness.get(peerId) === ready) return;
    this.readiness.set(peerId, ready);
    this.notifyPresence();
    // Republish immediately: a guest's screen is showing the host's table, so
    // a readiness change the host does not broadcast is a readiness change
    // nobody else can see.
    if (this.state.role === "host") this.broadcastLobbyState(this.hostLobbyRows());
  }

  /** Every guest has reported ready, so the start can go out. */
  everyoneReady(): boolean {
    const guests = this.state.members.filter((m) => m.peerId !== this.state.selfId);
    return guests.length > 0 && guests.every((m) => this.readiness.get(m.peerId) === true);
  }

  private sendPing(peerId: string): void {
    const conn = this.conns.get(peerId);
    if (!conn) return;
    const token = this.pingToken++;
    this.pendingPings.set(token, Date.now());
    try {
      conn.send({ type: "ping", atMs: Date.now(), token });
    } catch {
      // A dead socket degrades to "no latency reported", which is exactly
      // what the previous reading already said.
      this.pendingPings.delete(token);
    }
  }

  /**
   * Starts probing every connected guest. Host and guest both run this: the
   * star topology is preserved because a guest only ever pings the HOST, and
   * the host's measurement of a guest is what the lobby shows.
   */
  /**
   * Probes every connected peer, and reaps the ones that have stopped
   * answering.
   *
   * The reaping is the load-bearing half, and it is here because of a bug
   * found by live two-tab testing rather than by reasoning: when the host
   * closed its tab, the guest was STRANDED. WebRTC data channels have no
   * "peer went away" signal, so the socket never fires `close` and the guest
   * sat in the lobby forever showing a host row for a host that no longer
   * existed, with no notice and no way out. The ping already existed; it was
   * just only being used to display a number.
   *
   * So the same probe now doubles as the heartbeat. The threshold is three
   * missed rounds rather than one, which is a deliberate trade: a backgrounded
   * browser tab throttles its timers, so a short timeout would evict a
   * perfectly healthy player who alt-tabbed away. Three missed rounds costs
   * detection latency (6-8s worst case) and buys tolerance for a throttled
   * tab. A stranded guest is a far worse failure than an 8s delay in noticing
   * one, so the bias is deliberate - but the honest cost is that a player
   * whose tab is frozen for more than ~6s can be dropped from the room.
   */
  startPinging(): void {
    if (this.pingTimer !== null || typeof window === "undefined") return;
    this.pingTimer = setInterval(() => {
      const now = Date.now();
      for (const peerId of this.conns.keys()) this.sendPing(peerId);
      // Anything still outstanding after the timeout is dropped rather than
      // allowed to accumulate, so a peer that stops answering does not leave
      // an unbounded map of promises that will never resolve.
      const cutoff = now - this.PING_TIMEOUT_MS;
      for (const [token, sentAt] of this.pendingPings) {
        if (sentAt < cutoff) this.pendingPings.delete(token);
      }
      for (const [peerId, heardAt] of [...this.lastHeard]) {
        if (!this.conns.has(peerId)) {
          this.lastHeard.delete(peerId);
          continue;
        }
        if (now - heardAt >= this.PING_TIMEOUT_MS) this.reapPeer(peerId);
      }
    }, this.PING_INTERVAL_MS);
  }

  /**
   * Treats a silent peer as gone: drops the connection and fires the same
   * close handlers a real socket close would, so every existing "the host
   * left" path - lobby shutdown, race classification - works unchanged for a
   * peer that vanished without a clean close.
   */
  private reapPeer(peerId: string): void {
    const conn = this.conns.get(peerId);
    this.conns.delete(peerId);
    this.lastHeard.delete(peerId);
    this.latencies.delete(peerId);
    this.readiness.delete(peerId);
    try {
      conn?.close();
    } catch {
      /* already gone, which is the premise */
    }
    this.notifyPresence();
    for (const cb of this.peerCloseHandlers) cb(peerId);
  }

  stopPinging(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.pendingPings.clear();
    this.lastHeard.clear();
  }

  /** Handles an inbound ping/pong pair. Exposed for tests and for the guest
   *  path, which receives the host's probes on the same dispatch as the host's. */
  handleLatencyMessage(peerId: string, msg: Extract<NetMessage, { type: "ping" | "pong" }>): void {
    if (msg.type === "ping") {
      this.sendTo(peerId, { type: "pong", atMs: msg.atMs, token: msg.token });
      return;
    }
    const sentAt = this.pendingPings.get(msg.token);
    if (sentAt === undefined) return;
    this.pendingPings.delete(msg.token);
    this.latencies.set(peerId, Math.max(0, Date.now() - sentAt));
    // A latency reading is lobby-visible, so it has to wake the panel - and
    // republish it, because a guest is reading the ping figure out of the
    // host's table rather than measuring the host itself.
    this.notifyPresence();
    if (this.state.role === "host") this.broadcastLobbyState(this.hostLobbyRows());
  }

  /**
   * Announces that this peer is the host and is going away, so the guests
   * running can classify the race rather than being dropped silently.
   * Distinct from leave()'s voluntary `bye` because the RESPONSE differs: a
   * guest that loses the host mid-race shows a classified result, not an
   * empty menu.
   */
  announceHostLeft(reason: string): void {
    try {
      this.broadcast({ type: "host-left", reason });
    } catch {
      /* a dead socket is the normal case here - that is why they left */
    }
  }

  private hostLeftNoticeArmed = false;

  /**
   * Tells the browser to deliver a `host-left` when this tab goes away.
   *
   * This is the FAST path and it is genuinely best-effort: `pagehide` fires on
   * a closed tab, a reload and a bfcache eviction, but there is no guarantee
   * a WebRTC data channel flushes a send during teardown. So this is an
   * optimisation, NOT the mechanism - the ping watchdog in startPinging is what
   * actually guarantees a guest finds out, and it works even when the host
   * crashes without ever running this handler. Shipping only this would have
   * looked correct in a graceful-shutdown test and stranded every guest whose
   * host force-quit.
   */
  private armHostLeftNotice(): void {
    if (this.hostLeftNoticeArmed || typeof window === "undefined") return;
    this.hostLeftNoticeArmed = true;
    window.addEventListener("pagehide", () => {
      this.announceHostLeft("The host closed the tab.");
    });
  }

  /** Broadcasts the host's safety car / VSC state to every guest. */
  broadcastSafetyCar(phase: "none" | "active" | "ending", kind: "sc" | "vsc"): void {
    this.broadcast({ type: "safety-car", phase, kind });
  }

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
    this.armHostLeftNotice();
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
        // Latency probing starts with the room, so the lobby table has a
        // figure from the first moment there is anyone to measure against.
        this.startPinging();
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
            // The welcome carries the host's full host-first roster - adopt
            // it wholesale. Previously this listed only ourselves, and the
            // synthetic roster dispatch below fired before any race-side
            // listener existed, so the guest stayed alone in its own member
            // list: rivals were built from [self] (the host became an AI
            // ghost), inputs routed to members[0] = ourselves (the host's
            // copy of our car fell back to AI and "drove itself"), and the
            // self-correction fought that diverging copy (jitter).
            members: msg.roster.length > 0 ? msg.roster : [{ peerId: peer.id, driver }],
            settings: msg.settings,
            notice: null,
          });
          this.lastSettings = msg.settings;
          // Roster arrives via welcome and follow-up roster broadcasts.
          for (const handler of this.messageHandlers) {
            handler(roomPeerId(code), { type: "roster", roster: msg.roster });
          }
          // A guest probes the host too, so the host's own view of the link
          // (and therefore the number it shows the room) is measured rather
          // than asserted. Star topology is intact: the guest only ever
          // talks to the host.
          this.startPinging();
          resolve();
          return;
        }
        if (msg.type === "error") {
          clearTimeout(timeout);
          this.stopPinging();
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
    // Drop presence for anyone no longer in the room, so a peer that left and
    // came back is not still shown as the ready, high-latency member it was.
    const present = new Set(members.map((m) => m.peerId));
    for (const peerId of [...this.readiness.keys()]) {
      if (!present.has(peerId)) this.readiness.delete(peerId);
    }
    this.notifyPresence();
    // Roster changed, so the published table is stale: republish. Without
    // this a guest keeps rendering a departed peer until the next ping, and a
    // host that has just been joined keeps telling the room the new member
    // does not exist.
    if (this.state.role === "host") this.broadcastLobbyState(this.hostLobbyRows());
  }

  /**
   * The host's rows, derived from its own record. This is what gets broadcast
   * (see broadcastLobbyState) and therefore what the start decision is made
   * from - one function, so the table a guest sees and the table the host acts
   * on cannot be built by different code.
   */
  hostLobbyRows(): NetLobbyRow[] {
    return this.state.members.map((m) => ({
      peerId: m.peerId,
      driver: m.driver,
      ready: m.peerId === this.state.selfId || this.readiness.get(m.peerId) === true,
      pingMs: this.latencies.get(m.peerId) ?? null,
    }));
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
    this.stopPinging();
    this.readiness.clear();
    try {
      for (const conn of this.conns.values()) conn.close();
    } catch {
      /* ignore */
    }
    this.conns.clear();
    this.latencies.clear();
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
    this.stopPinging();
    try {
      for (const conn of this.conns.values()) conn.close();
    } catch {
      /* ignore */
    }
    this.conns.clear();
    this.latencies.clear();
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
