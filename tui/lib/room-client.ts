/**
 * RoomClient is the one seam between the members and wherever the room bytes come from. Today
 * `LocalRoomClient` (local-client.ts) reads and appends the NDJSON file of a `local` room through
 * agora's own transport; the seat service client (`DaemonClient`) replaces it behind this same
 * interface, and the members do not change. `StubRoomClient` is the in-memory shape the smokes
 * render against.
 *
 * The wire shapes mirror `src/core.mjs` (Message, Author, Attachment); they are restated here as
 * TypeScript so the TUI type-checks on its own without pulling the JavaScript package into tsc.
 */

export type ActorKind = "human" | "agent" | "unknown" | "system";

export interface Author {
  id: string;
  name: string;
  kind: ActorKind;
}

export interface Attachment {
  id: string;
  name: string;
  kind: "image" | "file";
  mimetype?: string;
  size?: number;
  width?: number;
  height?: number;
  url?: string;
  path?: string;
  digest?: string;
  error?: string;
}

export interface Message {
  id: string;
  room: string;
  thread?: string;
  author: Author;
  text: string;
  signedAs?: string;
  ts: string;
  cursor: string;
  url?: string;
  attachments?: Attachment[];
  raw?: unknown;
}

/** The actor this surface posts as. Always `kind: human`; the name is the seat's human.json. */
export interface HumanActor {
  name: string;
  kind: "human";
}

export interface RoomInfo {
  alias: string;
  transport: string;
  /** The transport's own name for the room (a file path for `local`). */
  room: string;
  note?: string;
}

/**
 * What a read could and could not see. Every result set carries its horizon, so an absence in
 * the rows is never read as proof of absence in the room: the oldest position the read held and
 * the moment it was taken.
 */
export interface Horizon {
  alias: string;
  oldestTs?: string;
  oldestCursor?: string;
  readAt: string;
  /** Where the rows came from, in words: `local file` today, `seat service` later. */
  source: string;
}

export interface ReadResult {
  messages: Message[];
  horizon: Horizon;
}

export type PeerState = "live" | "dark" | "unknown";

export interface PeerRow {
  bearer: string;
  slug: string;
  state: PeerState;
  pid?: number;
  lastSeen?: string;
  label?: string;
  /** True for the session record the running process itself would resolve to, when known. */
  here?: boolean;
}

export interface PostResult {
  id: string;
  cursor: string;
}

export interface RoomClient {
  /** `local` today; `daemon` once the seat service serves the same requests. */
  readonly kind: string;
  /** The human this surface posts as. Never read from the shared config. */
  actor(): HumanActor;
  /** Take the name the person just gave; every later post carries it. */
  adopt(actor: HumanActor): void;
  rooms(): Promise<RoomInfo[]>;
  read(alias: string, opts?: { since?: string; limit?: number }): Promise<ReadResult>;
  /** Append `text` as the human actor. The text arrives already signed and already guarded. */
  post(alias: string, text: string, opts?: { thread?: string }): Promise<PostResult>;
  /** This seat's sessions, as far as the local records say. Remote seats are unknown here. */
  peers(): Promise<PeerRow[]>;
}

/** An in-memory client for smokes: seeded rooms, posts stamped with the human actor. */
export class StubRoomClient implements RoomClient {
  readonly kind = "stub";
  private human: HumanActor;
  private readonly store = new Map<string, Message[]>();
  private readonly info: RoomInfo[];
  private readonly peerRows: PeerRow[];
  readonly posted: Array<{ alias: string; text: string; thread?: string }> = [];
  private clock: () => Date;

  constructor(opts: { name: string; rooms: Record<string, Message[]>; peers?: PeerRow[]; now?: () => Date }) {
    this.human = { name: opts.name, kind: "human" };
    this.info = Object.keys(opts.rooms).map((alias) => ({ alias, transport: "stub", room: `stub:${alias}` }));
    for (const [alias, msgs] of Object.entries(opts.rooms)) this.store.set(alias, [...msgs]);
    this.peerRows = opts.peers ?? [];
    this.clock = opts.now ?? (() => new Date());
  }

  actor(): HumanActor {
    return this.human;
  }

  adopt(actor: HumanActor): void {
    this.human = { name: actor.name, kind: "human" };
  }

  async rooms(): Promise<RoomInfo[]> {
    return this.info;
  }

  async read(alias: string, opts: { since?: string; limit?: number } = {}): Promise<ReadResult> {
    const all = this.store.get(alias) ?? [];
    const start = opts.since ? Number(opts.since) : 0;
    const rows = all.slice(start).map((m, i) => ({ ...m, cursor: String(start + i + 1) }));
    const limit = opts.limit ?? 1000;
    const messages = opts.since ? rows.slice(0, limit) : rows.slice(-limit);
    return {
      messages,
      horizon: {
        alias,
        oldestTs: messages[0]?.ts,
        oldestCursor: messages[0]?.cursor,
        readAt: this.clock().toISOString(),
        source: "stub",
      },
    };
  }

  async post(alias: string, text: string, opts: { thread?: string } = {}): Promise<PostResult> {
    const list = this.store.get(alias) ?? [];
    const id = `stub-${list.length + 1}`;
    const m: Message = {
      id,
      room: `stub:${alias}`,
      thread: opts.thread,
      author: { id: this.human.name, name: this.human.name, kind: "human" },
      text,
      ts: this.clock().toISOString(),
      cursor: String(list.length + 1),
    };
    list.push(m);
    this.store.set(alias, list);
    this.posted.push({ alias, text, thread: opts.thread });
    return { id, cursor: m.cursor };
  }

  async peers(): Promise<PeerRow[]> {
    return this.peerRows;
  }

  /** Test seam: append a message as some other author, as a peer would. */
  seed(alias: string, m: Omit<Message, "room" | "cursor">): void {
    const list = this.store.get(alias) ?? [];
    list.push({ ...m, room: `stub:${alias}`, cursor: String(list.length + 1) });
    this.store.set(alias, list);
  }
}
