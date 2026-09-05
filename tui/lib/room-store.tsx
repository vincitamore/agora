/**
 * The room store: the one loaded room (its messages and horizon), the seat's peers, and the
 * jump target SEARCH hands to ROOM. Reads go through the injected `RoomClient`; members never
 * touch the client directly, so swapping the local reader for the seat service client is a
 * change in `index.tsx`, not in any member.
 *
 * Reads run in effects, never in render. Polling is owned by the members and gated on their
 * `active` flag, so a hidden member does not churn.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { HumanActor, Horizon, Message, PeerRow, RoomClient, RoomInfo } from "./room-client";
import { shownError } from "./safe-text";

export interface RoomStore {
  client: RoomClient;
  actor: HumanActor;
  rooms: RoomInfo[];
  alias: string | undefined;
  messages: Message[];
  horizon: Horizon | undefined;
  error: string | undefined;
  peers: PeerRow[];
  peersError: string | undefined;
  selectRoom: (alias: string) => void;
  refresh: () => Promise<void>;
  refreshPeers: () => Promise<void>;
  /** A message id ROOM should move its cursor to on its next render, then clear. */
  jump: string | undefined;
  requestJump: (id: string) => void;
  clearJump: () => void;
  /** Bumped after a name lands so consumers re-read the actor. */
  actorEpoch: number;
  setActor: (a: HumanActor) => void;
}

const RoomStoreContext = createContext<RoomStore | null>(null);

const READ_LIMIT = 1000;

export function RoomStoreProvider({ client, initialAlias, children }: { client: RoomClient; initialAlias?: string; children: ReactNode }) {
  const [rooms, setRooms] = useState<RoomInfo[]>([]);
  const [alias, setAlias] = useState<string | undefined>(initialAlias);
  const [messages, setMessages] = useState<Message[]>([]);
  const [horizon, setHorizon] = useState<Horizon | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [peers, setPeers] = useState<PeerRow[]>([]);
  const [peersError, setPeersError] = useState<string | undefined>(undefined);
  const [jump, setJump] = useState<string | undefined>(undefined);
  const [actor, setActorState] = useState<HumanActor>(client.actor());
  const [actorEpoch, setActorEpoch] = useState(0);
  const inflight = useRef(false);

  useEffect(() => {
    let alive = true;
    client
      .rooms()
      .then((list) => {
        if (!alive) return;
        setRooms(list);
        setAlias((cur) => cur ?? list[0]?.alias);
      })
      .catch((e: unknown) => alive && setError(shownError(e)));
    return () => {
      alive = false;
    };
  }, [client]);

  const refresh = useCallback(async () => {
    if (!alias || inflight.current) return;
    inflight.current = true;
    try {
      const r = await client.read(alias, { limit: READ_LIMIT });
      setMessages(r.messages);
      setHorizon(r.horizon);
      setError(undefined);
    } catch (e) {
      setError(shownError(e));
    } finally {
      inflight.current = false;
    }
  }, [client, alias]);

  const refreshPeers = useCallback(async () => {
    try {
      setPeers(await client.peers());
      setPeersError(undefined);
    } catch (e) {
      setPeersError(shownError(e));
    }
  }, [client]);

  const selectRoom = useCallback((next: string) => {
    setAlias(next);
    setMessages([]);
    setHorizon(undefined);
  }, []);

  const requestJump = useCallback((id: string) => setJump(id), []);
  const clearJump = useCallback(() => setJump(undefined), []);
  const setActor = useCallback((a: HumanActor) => {
    setActorState(a);
    setActorEpoch((n) => n + 1);
  }, []);

  const value = useMemo<RoomStore>(
    () => ({ client, actor, rooms, alias, messages, horizon, error, peers, peersError, selectRoom, refresh, refreshPeers, jump, requestJump, clearJump, actorEpoch, setActor }),
    [client, actor, rooms, alias, messages, horizon, error, peers, peersError, selectRoom, refresh, refreshPeers, jump, requestJump, clearJump, actorEpoch, setActor],
  );

  return <RoomStoreContext.Provider value={value}>{children}</RoomStoreContext.Provider>;
}

export function useRoomStore(): RoomStore {
  const s = useContext(RoomStoreContext);
  if (!s) throw new Error("useRoomStore must be used within a <RoomStoreProvider>");
  return s;
}

/** Poll `fn` every `ms` while `active`, with one immediate call on activation. */
export function usePollWhileActive(active: boolean, fn: () => Promise<void> | void, ms: number): void {
  useEffect(() => {
    if (!active) return;
    let alive = true;
    void fn();
    const t = setInterval(() => {
      if (alive) void fn();
    }, ms);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [active, fn, ms]);
}
