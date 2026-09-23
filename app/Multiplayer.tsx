"use client";

import { Suspense, useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { netRoom, type RoomSnapshot } from "@/lib/net/peer";
import {
  MAX_NET_HUMANS,
  initialLobbyState,
  lobbyReducer,
  lobbySlots,
  setHostDriver,
} from "@/lib/net/lobby";
import {
  PROTOCOL_VERSION,
  isRoomCode,
  roomPeerId,
  type NetDriverInfo,
  type NetSettings,
} from "@/lib/net/protocol";
import { parseDriverCode, parseTeamId, resolveRosterSelection, useRosterSelection } from "@/lib/race/roster";
import {
  MAX_RIVALS,
  loadSessionSetupPrefs,
  useSessionSetupPrefs,
} from "@/lib/race/sessionSetup";
import { parseTrackId } from "@/lib/tracks/registry";
import { getTrackName } from "@/lib/tracks/registry";
import styles from "./page.module.css";

function useRoomSnapshot(): RoomSnapshot {
  return useSyncExternalStore(
    (notify) => netRoom.subscribe(notify),
    () => netRoom.getState(),
    () => netRoom.getState()
  );
}

function myDriver(teamId: string, driverCode: string): NetDriverInfo {
  const { team, driver } = resolveRosterSelection(parseTeamId(teamId), parseDriverCode(driverCode));
  return { code: driver.code, name: driver.name, teamId: team.id, color: team.primaryColor };
}

function liveSettings(): NetSettings {
  const prefs = loadSessionSetupPrefs();
  return {
    track: parseTrackId(prefs.trackId),
    mode: "race",
    laps: prefs.raceLaps,
    rivals: prefs.rivals,
    tod: prefs.timeOfDay,
  };
}

function raceUrl(settings: NetSettings, room: string, role: "host" | "guest", slot: number, teamId: string, driverCode: string, goAtMs: number): string {
  const query = new URLSearchParams();
  query.set("track", settings.track);
  query.set("mode", "race");
  query.set("laps", String(settings.laps));
  query.set("tod", settings.tod);
  query.set("rivals", String(settings.rivals));
  query.set("team", teamId);
  query.set("driver", driverCode);
  query.set("room", room);
  query.set("role", role);
  query.set("slot", String(slot));
  query.set("goAt", String(goAtMs));
  return `/race?${query.toString()}`;
}

/**
 * Plan section 16 (online multiplayer): the home-screen lobby. Creating
 * is one click (room code + share link); joining is a link or a code -
 * either way the leader's panel below is the same garage/map/session
 * pickers the solo game uses, broadcast live to guests. The leader
 * starts a race for everyone at once; the race page (see ?room=) takes
 * it from there. Rooms die with the host (documented v1 limit) and hold
 * at most MAX_NET_HUMANS humans - AI fills the rest of the grid.
 */
export function Multiplayer() {
  const room = useRoomSnapshot();
  const { teamId, driverCode } = useRosterSelection();
  const router = useRouter();

  if (room.status === "idle" || room.status === "closed") {
    return (
      <div className={styles.championship}>
        <span className={styles.championshipHeading}>MULTIPLAYER</span>
        <p className={styles.championshipNote}>
          Race friends in real time: create a room, share the link, and the
          leader&apos;s track pick starts the race for everyone. Up to{" "}
          {MAX_NET_HUMANS} humans - AI fills the rest of the grid.
        </p>
        <Suspense fallback={null}>
          <JoinFromLink />
        </Suspense>
        <Suspense fallback={null}>
          <RejoinLast />
        </Suspense>
        <CreateRoom teamId={teamId} driverCode={driverCode} />
        <JoinByCode teamId={teamId} driverCode={driverCode} />
        {room.status === "closed" && room.notice && (
          <p className={styles.championshipNote}>{room.notice}</p>
        )}
      </div>
    );
  }

  if (room.status === "opening" || room.status === "error") {
    return (
      <div className={styles.championship}>
        <span className={styles.championshipHeading}>MULTIPLAYER</span>
        <p className={styles.championshipNote}>
          {room.status === "opening" ? "Joining room…" : (room.notice ?? "Could not join.")}
        </p>
        <button type="button" className={styles.championshipButton} onClick={() => netRoom.leave()}>
          Back
        </button>
      </div>
    );
  }

  return (
    <div className={styles.championship}>
      <span className={styles.championshipHeading}>
        ROOM {room.code} — {room.role === "host" ? "LEADER" : "RIDER"}
      </span>
      <button
        type="button"
        className={styles.championshipButton}
        onClick={() => {
          const link = `${window.location.origin}/?room=${room.code}`;
          void navigator.clipboard?.writeText(link).catch(() => {});
        }}
      >
        Copy invite link
      </button>
      <div className={styles.championshipStandings}>
        {room.members.map((m) => (
          <div className={styles.championshipRow} key={m.peerId}>
            <span className={styles.championshipLabel}>{m.driver.code}</span>
            <span className={styles.championshipValue}>{m.driver.name}</span>
          </div>
        ))}
      </div>
      {room.role === "host" ? (
        <HostLobby room={room} teamId={teamId} driverCode={driverCode} routerPush={(url: string) => router.push(url)} />
      ) : (
        <GuestLobby room={room} routerPush={(url: string) => router.push(url)} />
      )}
      <button
        type="button"
        className={styles.championshipButton}
        onClick={() => {
          forgetRoom();
          netRoom.leave(room.role === "host" ? "Leader left the room." : "Rider left.");
        }}
      >
        Leave room
      </button>
    </div>
  );
}

/** Tab-scoped memory of the last joined room: a refresh mid-lobby loses
 * the PeerJS connection (new peer id), so the home panel offers one-click
 * rejoin instead of making the guest retype the code. Cleared on any
 * deliberate leave/kick - only an accidental unload keeps it. */
const LAST_ROOM_KEY = "lift-coast-last-room";

function rememberRoom(code: string): void {
  try {
    sessionStorage.setItem(LAST_ROOM_KEY, code);
  } catch {
    /* private mode etc: rejoin just won't be offered */
  }
}

function lastRoom(): string | null {
  try {
    const code = sessionStorage.getItem(LAST_ROOM_KEY);
    return code !== null && isRoomCode(code) ? code : null;
  } catch {
    return null;
  }
}

function forgetRoom(): void {
  try {
    sessionStorage.removeItem(LAST_ROOM_KEY);
  } catch {
    /* ignore */
  }
}

/** Picks up ?room=CODE shared links: pre-fills joining, one click to enter. */
function JoinFromLink() {
  const searchParams = useSearchParams();
  const code = searchParams.get("room");
  const { teamId, driverCode } = useRosterSelection();
  const [joining, setJoining] = useState(false);
  if (code === null || !isRoomCode(code)) return null;
  if (netRoom.getState().status !== "idle" && netRoom.getState().status !== "closed") return null;
  return (
    <button
      type="button"
      className={styles.championshipButton}
      disabled={joining}
      onClick={() => {
        setJoining(true);
        netRoom
          .joinRoom(code, myDriver(teamId, driverCode))
          .then(() => rememberRoom(code))
          .catch(() => setJoining(false));
      }}
    >
      {joining ? "Joining…" : `Join room ${code}`}
    </button>
  );
}

/** One-click return after an accidental refresh mid-lobby (see LAST_ROOM_KEY). */
function RejoinLast() {
  const { teamId, driverCode } = useRosterSelection();
  const [joining, setJoining] = useState(false);
  const [code] = useState(lastRoom);
  if (code === null) return null;
  if (netRoom.getState().status !== "idle" && netRoom.getState().status !== "closed") return null;
  return (
    <button
      type="button"
      className={styles.championshipButton}
      disabled={joining}
      onClick={() => {
        setJoining(true);
        netRoom
          .joinRoom(code, myDriver(teamId, driverCode))
          .then(() => rememberRoom(code))
          .catch(() => {
            // Dead code (room long gone): stop offering it.
            forgetRoom();
            setJoining(false);
          });
      }}
    >
      {joining ? "Joining…" : `Rejoin room ${code}`}
    </button>
  );
}

function CreateRoom({ teamId, driverCode }: { teamId: string; driverCode: string }) {
  const [creating, setCreating] = useState(false);
  return (
    <button
      type="button"
      className={styles.championshipButton}
      disabled={creating}
      onClick={() => {
        setCreating(true);
        netRoom
          .hostRoom(myDriver(teamId, driverCode), liveSettings())
          .then(() => setCreating(false))
          .catch(() => setCreating(false));
      }}
    >
      {creating ? "Creating…" : "Create room"}
    </button>
  );
}

function JoinByCode({ teamId, driverCode }: { teamId: string; driverCode: string }) {
  const [code, setCode] = useState("");
  const [joining, setJoining] = useState(false);
  const clean = code.trim().toUpperCase();
  return (
    <div className={styles.championshipButtons}>
      <input
        aria-label="Room code"
        value={code}
        onChange={(e) => setCode(e.target.value.toUpperCase())}
        placeholder="CODE"
        maxLength={6}
        className={styles.codeInput}
      />
      <button
        type="button"
        className={styles.championshipButton}
        disabled={joining || !isRoomCode(clean)}
        onClick={() => {
          setJoining(true);
          netRoom
            .joinRoom(clean, myDriver(teamId, driverCode))
            .then(() => rememberRoom(clean))
            .catch(() => setJoining(false));
        }}
      >
        {joining ? "Joining…" : "Join"}
      </button>
    </div>
  );
}

function SettingsLine({ settings }: { settings: NetSettings }) {
  return (
    <p className={styles.championshipNote}>
      {getTrackName(settings.track)} — {settings.laps} lap{settings.laps === 1 ? "" : "s"} ·{" "}
      {settings.rivals + 1} cars · {settings.tod}
    </p>
  );
}

function HostLobby({
  room,
  teamId,
  driverCode,
  routerPush,
}: {
  room: RoomSnapshot;
  teamId: string;
  driverCode: string;
  routerPush: (url: string) => void;
}) {
  // Host-owned membership (pure reducer, tested in netLobby.test.ts).
  // Settings always follow the live home panels (track/map/session/team
  // below) - no separate lobby copy to drift; guests see them via the
  // broadcast mirror effect below and the snapshot at START.
  const [lobby, dispatch] = useReducer(
    lobbyReducer,
    undefined as unknown as Parameters<typeof lobbyReducer>[0],
    () => initialLobbyState(true, liveSettings())
  );
  const self = myDriver(teamId, driverCode);
  const effective =
    room.selfId !== null ? setHostDriver({ ...lobby, selfId: room.selfId }, self) : lobby;
  const prefs = useSessionSetupPrefs();
  // Ref mirror so the hello handler (registered once) always sees current
  // membership for the full-room check.
  const membersRef = useRef(effective.members);
  useEffect(() => {
    membersRef.current = effective.members;
  });
  const welcomedRef = useRef<Set<string>>(new Set());

  // Wire hello/leave traffic into the reducer; answer newcomers.
  useEffect(() => {
    const offMessage = netRoom.onMessage((fromPeerId, msg) => {
      if (msg.type !== "hello") return;
      if (msg.version !== PROTOCOL_VERSION) {
        netRoom.dropPeer(fromPeerId, "Client version mismatch - refresh the game.");
        return;
      }
      const current = membersRef.current;
      if (!current.some((m) => m.peerId === fromPeerId) && current.length >= MAX_NET_HUMANS) {
        netRoom.dropPeer(fromPeerId, "Room is full.");
        return;
      }
      dispatch({ type: "member-joined", peerId: fromPeerId, driver: msg.driver });
    });
    const offClose = netRoom.onPeerClose((peerId) => {
      welcomedRef.current.delete(peerId);
      dispatch({ type: "member-left", peerId });
    });
    return () => {
      offMessage();
      offClose();
    };
  }, []);

  // Mirror membership + live settings into the shared room and out to
  // guests. Idempotent on their side (same roster object re-applied),
  // and this effect only runs on discrete changes (joins, leaves, panel
  // picks), never per frame.
  const membersKey = JSON.stringify(effective.members);
  const settingsKey = JSON.stringify({
    track: parseTrackId(prefs.trackId),
    laps: prefs.raceLaps,
    tod: prefs.timeOfDay,
    rivals: prefs.rivals,
  });
  useEffect(() => {
    netRoom.setMembers(effective.members);
    const settings: NetSettings = {
      track: parseTrackId(prefs.trackId),
      mode: "race",
      laps: prefs.raceLaps,
      rivals: prefs.rivals,
      tod: prefs.timeOfDay,
    };
    netRoom.setSettings(settings);
    netRoom.broadcast({ type: "roster", roster: effective.members });
    netRoom.broadcast({ type: "settings", settings });
    // Answer any newcomer the reducer just accepted: dispatch is
    // synchronous, so a member present here without a welcome yet is new
    // since the last mirror. Track welcomed peers to send exactly once.
    for (const m of effective.members) {
      if (m.peerId !== room.selfId && !welcomedRef.current.has(m.peerId)) {
        welcomedRef.current.add(m.peerId);
        netRoom.sendTo(m.peerId, {
          type: "welcome",
          version: PROTOCOL_VERSION,
          slot: lobbySlots(effective)[m.peerId] ?? 1,
          settings,
          roster: effective.members,
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [membersKey, settingsKey]);

  const ready = effective.members.length >= 2;
  return (
    <>
      <SettingsLine
        settings={{
          track: parseTrackId(prefs.trackId),
          mode: "race",
          laps: prefs.raceLaps,
          rivals: Math.min(MAX_RIVALS, Math.max(prefs.rivals, effective.members.length - 1)),
          tod: prefs.timeOfDay,
        }}
      />
      <p className={styles.championshipNote}>
        {ready
          ? "Everyone picks their own team below - you start the race for the whole room."
          : "Share the invite link above. Need at least one rider to start."}
      </p>
      <div className={styles.championshipButtons}>
        <button
          type="button"
          className={styles.championshipButton}
          disabled={!ready}
          onClick={() => {
            const settings: NetSettings = {
              track: parseTrackId(prefs.trackId),
              mode: "race",
              laps: prefs.raceLaps,
              rivals: Math.min(MAX_RIVALS, Math.max(prefs.rivals, effective.members.length - 1)),
              tod: prefs.timeOfDay,
            };
            const slots = lobbySlots(effective);
            // The go time travels for compatibility only: the race page's
            // countdown holds on "3" until the room is actually ready (every
            // guest reports that its scene is live), then runs one 3-2-1 off
            // one host-stamped instant - see NetHost.signalGo/NetClient.
            // A fixed offset from here used to let the host launch while a
            // cold guest was still loading three.js and rapier.
            const atMs = Date.now() + 4000;
            netRoom.broadcast({ type: "start", settings, slots, atMs });
            netRoom.setSettings(settings);
            netRoom.markRacing();
            routerPush(raceUrl(settings, room.code ?? "", "host", 0, teamId, driverCode, atMs));
          }}
        >
          Start race
        </button>
      </div>
    </>
  );
}

function GuestLobby({
  room,
  routerPush,
}: {
  room: RoomSnapshot;
  routerPush: (url: string) => void;
}) {
  const { teamId, driverCode } = useRosterSelection();
  const teamDriverRef = useRef({ teamId, driverCode });
  useEffect(() => {
    teamDriverRef.current = { teamId, driverCode };
  });
  // Roster/settings mirror into the shared room (survives navigation to
  // the race page); start navigates with our own slot; bye or a dead
  // socket tears down with the reason kept on screen (see shutdown).
  useEffect(() => {
    const off = netRoom.onMessage((_, msg) => {
      if (msg.type === "roster") {
        netRoom.setMembers(msg.roster);
      } else if (msg.type === "settings") {
        netRoom.setSettings(msg.settings);
      } else if (msg.type === "start") {
        const selfId = netRoom.getState().selfId;
        const mySlot = selfId !== null ? (msg.slots[selfId] ?? 1) : 1;
        const { teamId: tid, driverCode: dc } = teamDriverRef.current;
        netRoom.markRacing();
        routerPush(raceUrl(msg.settings, room.code ?? "", "guest", mySlot, tid, dc, msg.atMs));
      } else if (msg.type === "bye") {
        forgetRoom();
        netRoom.shutdown(msg.reason);
      }
    });
    // Host closed the tab (no clean bye): the socket dying is the signal.
    const offClose = netRoom.onPeerClose((peerId) => {
      const state = netRoom.getState();
      if (state.status !== "lobby" || state.role !== "guest") return;
      if (state.code === null || peerId !== roomPeerId(state.code)) return;
      forgetRoom();
      netRoom.shutdown("Leader left the room.");
    });
    return () => {
      off();
      offClose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!room.settings) return null;
  return (
    <>
      <SettingsLine settings={room.settings} />
      <p className={styles.championshipNote}>Waiting for the leader to start the race…</p>
    </>
  );
}
