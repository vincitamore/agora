/**
 * The room store: the one loaded room (its messages and horizon), the seat's peers, and the
 * jump target SEARCH hands to ROOM. Reads go through the injected `RoomClient`; members never
 * touch the client directly, so which client serves a room is decided in `index.tsx` by the
 * room's config, not in any member.
 *
 * Reads run in effects, never in render. Polling is owned by the members and gated on their
 * `active` flag, so a hidden member does not churn. A client that can subscribe is followed
 * instead of polled: after the first read the store subscribes from the position that read was
 * complete through, appends what the subscription delivers, and stops polling while it is live.
 * The subscription's end is a fault the store keeps as itself: `dark` (the channel) or `refused`
 * (the service's answer), never folded into one "error"; the next poll tick tries again.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { RoomFaultError, type HumanActor, type Horizon, type Message, type PeerRow, type RoomClient, type RoomFault, type RoomInfo, type Subscription } from "./room-client";
import { shown, shownError } from "./safe-text";

export interface RoomStore {
  client: RoomClient;
  actor: HumanActor;
  rooms: RoomInfo[];
  alias: string | undefined;
  messages: Message[];
  horizon: Horizon | undefined;
  /** An ordinary failure of a read, redacted. Faults from a client with outcomes go to `fault`. */
  error: string | undefined;
  /** Why the room is not answering: dark or refused, by the channel, redacted. */
  fault: RoomFault | undefined;
  /** True while a subscription delivers the loaded room's events. */
  live: boolean;
  peers: PeerRow[];
  peersError: string | undefined;
  selectRoom: (alias: string) => void;
  /** Read the room now (and subscribe when the client can). */
  refresh: () => Promise<void>;
  /** What a poll tick does: nothing while live, a read otherwise. */
  poll: () => Promise<void>;
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
  const [fault, setFault] = useState<RoomFault | undefined>(undefined);
  const [live, setLive] = useState(false);
  const [peers, setPeers] = useState<PeerRow[]>([]);
  const [peersError, setPeersError] = useState<string | undefined>(undefined);
  const [jump, setJump] = useState<string | undefined>(undefined);
  const [actor, setActorState] = useState<HumanActor>(client.actor());
  const [actorEpoch, setActorEpoch] = useState(0);
  const inflight = useRef(false);
  const subscription = useRef<Subscription | undefined>(undefined);
  // a generation per subscription attempt: a late result or event from an older one is dropped
  const generation = useRef(0);

  const dropSubscription = useCallback(() => {
    generation.current += 1;
    const s = subscription.current;
    subscription.current = undefined;
    if (s) s.close();
    setLive(false);
  }, []);

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
      dropSubscription();
    };
  }, [client, dropSubscription]);

  const refresh = useCallback(async () => {
    if (!alias || inflight.current) return;
    inflight.current = true;
    try {
      const r = await client.read(alias, { limit: READ_LIMIT });
      setMessages(r.messages);
      setHorizon(r.horizon);
      setError(undefined);
      setFault(undefined);
      if (client.subscribe && !subscription.current) {
        const since = r.horizon.readTo ?? r.messages[r.messages.length - 1]?.cursor;
        if (since) {
          const gen = generation.current;
          const sub = await client.subscribe(alias, since, {
            onMessages: (got) => {
              if (gen !== generation.current) return;
              setMessages((prev) => {
                const seen = new Set(prev.map((m) => m.id));
                const add = got.filter((m) => !seen.has(m.id));
                return add.length ? [...prev, ...add] : prev;
              });
              const last = got[got.length - 1];
              if (last) setHorizon((h) => (h ? { ...h, readTo: last.cursor } : h));
            },
            onFault: (f) => {
              if (gen !== generation.current) return;
              subscription.current = undefined;
              setLive(false);
              setFault({ kind: f.kind, reason: shown(f.reason) });
            },
          });
          if (sub) {
            if (gen !== generation.current) sub.close();
            else {
              subscription.current = sub;
              setLive(true);
            }
          }
        }
      }
    } catch (e) {
      if (e instanceof RoomFaultError) setFault({ kind: e.kind, reason: shown(e.reason) });
      else setError(shownError(e));
    } finally {
      inflight.current = false;
    }
  }, [client, alias]);

  const poll = useCallback(async () => {
    if (live) return;
    await refresh();
  }, [live, refresh]);

  const refreshPeers = useCallback(async () => {
    try {
      setPeers(await client.peers());
      setPeersError(undefined);
    } catch (e) {
      setPeersError(shownError(e));
    }
  }, [client]);

  const selectRoom = useCallback(
    (next: string) => {
      dropSubscription();
      setAlias(next);
      setMessages([]);
      setHorizon(undefined);
      setFault(undefined);
      setError(undefined);
    },
    [dropSubscription],
  );

  const requestJump = useCallback((id: string) => setJump(id), []);
  const clearJump = useCallback(() => setJump(undefined), []);
  const setActor = useCallback((a: HumanActor) => {
    setActorState(a);
    setActorEpoch((n) => n + 1);
  }, []);

  const value = useMemo<RoomStore>(
    () => ({ client, actor, rooms, alias, messages, horizon, error, fault, live, peers, peersError, selectRoom, refresh, poll, refreshPeers, jump, requestJump, clearJump, actorEpoch, setActor }),
    [client, actor, rooms, alias, messages, horizon, error, fault, live, peers, peersError, selectRoom, refresh, poll, refreshPeers, jump, requestJump, clearJump, actorEpoch, setActor],
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
