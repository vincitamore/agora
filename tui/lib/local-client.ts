/**
 * LocalRoomClient: the first slice's reader and writer, over agora's own `local` transport (an
 * append-only NDJSON file). It imports the transport rather than spawning the CLI because the
 * CLI's `post` stamps `author.kind` from the shared config's actor and `--as` replaces only the
 * name, so no CLI invocation can post `kind: human`; and every CLI verb touches the seat's
 * session record, which would register the human as a bearer. The transport, built with the
 * human actor, stamps the author from that actor and nothing else.
 *
 * The shared config is opened for one thing: the room aliases and their paths. The actor field
 * is never read; nothing is ever written to it.
 *
 * The seat service client replaces this class behind `RoomClient`; see README "swap plan".
 */

import { loadConfig, stateDir } from "../../src/core.mjs";
import { localTransport } from "../../src/transports/local.mjs";
import { listRecords } from "../../src/session.mjs";
import type { HumanActor, Message, PeerRow, PostResult, ReadResult, RoomClient, RoomInfo } from "./room-client";

type Transport = ReturnType<typeof localTransport>;

interface LocalRoom extends RoomInfo {
  path: string;
}

export interface NativeRoom extends RoomInfo {
  transport: "native";
  roomId: string;
}

const NATIVE_ROOM_ID = /^[a-f0-9]{32}$/;

/** The pieces of the shared config this surface is allowed to hold. */
export interface RoomsView {
  stateRoot: string;
  rooms: LocalRoom[];
  /** Rooms the config names `transport: native` with a roomId; the seat service client serves them. */
  native: NativeRoom[];
  /** Aliases the config names on transports this surface cannot read, so they are shown, not hidden. */
  elsewhere: RoomInfo[];
}

/**
 * Read the shared config for its rooms and state root only; the actor never leaves this function,
 * and no token field is looked at: a room's `tokenEnv` / `tokenFile` are not read, resolved or
 * copied, so this surface never holds one.
 */
export async function roomsFromConfig(explicit?: string): Promise<RoomsView> {
  const cfg = await loadConfig(explicit);
  const rooms: LocalRoom[] = [];
  const native: NativeRoom[] = [];
  const elsewhere: RoomInfo[] = [];
  for (const [alias, r] of Object.entries(cfg.rooms)) {
    const note = typeof r.note === "string" ? r.note : undefined;
    if (r.transport === "local" && typeof r.path === "string") rooms.push({ alias, transport: "local", room: r.path, path: r.path, note });
    else if (r.transport === "native" && typeof r.roomId === "string" && NATIVE_ROOM_ID.test(r.roomId)) native.push({ alias, transport: "native", room: r.roomId, roomId: r.roomId, note });
    else elsewhere.push({ alias, transport: r.transport, room: String(r.channel ?? r.repo ?? r.path ?? r.roomId ?? ""), note });
  }
  return { stateRoot: stateDir(cfg), rooms, native, elsewhere };
}

export class LocalRoomClient implements RoomClient {
  readonly kind = "local";
  private human: HumanActor;
  private readonly view: RoomsView;
  private readonly transports = new Map<string, Transport>();
  private readonly now: () => Date;

  constructor(human: HumanActor, view: RoomsView, opts: { now?: () => Date } = {}) {
    this.human = { name: human.name, kind: "human" };
    this.view = view;
    this.now = opts.now ?? (() => new Date());
  }

  actor(): HumanActor {
    return this.human;
  }

  /** The transports were built with the old actor; drop them so the next post carries the name. */
  adopt(actor: HumanActor): void {
    this.human = { name: actor.name, kind: "human" };
    this.transports.clear();
  }

  get stateRoot(): string {
    return this.view.stateRoot;
  }

  async rooms(): Promise<RoomInfo[]> {
    return [...this.view.rooms.map(({ alias, transport, room, note }) => ({ alias, transport, room, note })), ...this.view.elsewhere];
  }

  private transport(alias: string): Transport {
    const have = this.transports.get(alias);
    if (have) return have;
    const room = this.view.rooms.find((r) => r.alias === alias);
    if (!room) {
      const other = this.view.elsewhere.find((r) => r.alias === alias);
      if (other) throw new Error(`room ${alias} is on ${other.transport}; this surface reads local rooms only until the seat service serves it`);
      throw new Error(`no room named ${alias} in the config`);
    }
    const t = localTransport({ transport: "local", path: room.path }, { actor: this.human, now: this.now });
    this.transports.set(alias, t);
    return t;
  }

  async read(alias: string, opts: { since?: string; limit?: number } = {}): Promise<ReadResult> {
    const t = this.transport(alias);
    const messages = (await t.read({ since: opts.since, limit: opts.limit })) as unknown as Message[];
    return {
      messages,
      horizon: {
        alias,
        oldestTs: messages[0]?.ts,
        oldestCursor: messages[0]?.cursor,
        readAt: this.now().toISOString(),
        source: "local file",
      },
    };
  }

  async post(alias: string, text: string, opts: { thread?: string } = {}): Promise<PostResult> {
    const r = await this.transport(alias).post(text, { thread: opts.thread });
    return { id: r.id, cursor: r.cursor };
  }

  async peers(): Promise<PeerRow[]> {
    const rows = await listRecords(this.view.stateRoot);
    return rows.map((r) => ({
      bearer: r.record?.bearer ?? "(unregistered)",
      slug: r.slug,
      state: r.state === "live" ? "live" : r.state === "gone" ? "dark" : "unknown",
      pid: r.record?.pid,
      lastSeen: r.record?.lastSeen,
      label: r.record?.label,
    }));
  }
}
