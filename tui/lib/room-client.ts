/**
 * RoomClient is the one seam between the members and wherever the room bytes come from.
 * `LocalRoomClient` (local-client.ts) reads and appends the NDJSON file of a `local` room through
 * agora's own transport; `NativeRoomClient` (native-client.ts) is a client of the seat service
 * over its socket for a `native` room; `SeatRoomClient` (seat-client.ts) routes each alias to the
 * one its config names. `StubRoomClient` is the in-memory shape the smokes render against.
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
  /** The transport's own name for the room (a file path for `local`, the room id for `native`). */
  room: string;
  note?: string;
  /** The 32-hex room id of a `native` room. */
  roomId?: string;
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
  /** Where the rows came from, in words: `local file`, `seat service <label>`, `stub`. */
  source: string;
  /**
   * The position the read is complete through: the seat service's read coverage `toInclusive`
   * (the checkpoint of a result without a coverage block). A cursor, never a count; it can sit
   * past the last message shown, because coverage advances over events that are not messages.
   */
  readTo?: string;
  /** What the host had committed when the read was taken, when the service says. */
  committedThrough?: string;
}

export interface ReadResult {
  messages: Message[];
  horizon: Horizon;
}

/**
 * The two ways a room stops answering, told apart by the channel, never by the words: `dark` is
 * the seat service unreachable, closed or gone (the subscriber module's `ServiceDarkError`);
 * `refused` is an answer the service gave on a live socket (a foreign epoch, a future cursor, a
 * request it will not serve). The store renders each as itself.
 */
export type RoomFaultKind = "dark" | "refused";

export interface RoomFault {
  kind: RoomFaultKind;
  reason: string;
}

export class RoomFaultError extends Error implements RoomFault {
  readonly kind: RoomFaultKind;
  readonly reason: string;
  constructor(kind: RoomFaultKind, reason: string) {
    super(`${kind}: ${reason}`);
    this.name = "RoomFaultError";
    this.kind = kind;
    this.reason = reason;
  }
}

/** The three outcomes a post can have besides `sent`, per NATIVE-ROOMS "What sent means". */
export type PostFaultOutcome = "refused" | "unknown-acceptance" | "dark";

export class PostFaultError extends Error {
  readonly outcome: PostFaultOutcome;
  readonly reason: string;
  /** The operation id the post was (or would have been) sent under; retained by the client. */
  readonly operationId?: string;
  constructor(outcome: PostFaultOutcome, reason: string, operationId?: string) {
    super(`${outcome}: ${reason}`);
    this.name = "PostFaultError";
    this.outcome = outcome;
    this.reason = reason;
    this.operationId = operationId;
  }
}

/**
 * A request the TUI makes that the seat service does not serve yet. The client side is built
 * against the request's shape; the join is this named seam, and the double behind it refuses,
 * never pretends. `SEAT_SERVICE_SEAMS` lists them with their owner.
 */
export class SeamUnservedError extends Error {
  readonly request: string;
  constructor(request: string, reason: string) {
    super(`the seat service does not serve ${request} yet: ${reason}`);
    this.name = "SeamUnservedError";
    this.request = request;
  }
}

export const SEAT_SERVICE_SEAMS = {
  search: "P1: `search` through the service over the derived index; rows with a per-room horizon, never a count",
  roster: "P1/P3: `roster` as the service's derived reader over leases; PEERS reads this seat's session records meanwhile",
} as const;

export interface SearchResult {
  rows: Message[];
  horizon: Horizon;
}

export interface SubscribeHandlers {
  /** Messages the room committed after the subscription's cursor, in order, each once. */
  onMessages(messages: Message[]): void;
  /** The subscription ended: dark (the channel) or refused (the service's answer). */
  onFault(fault: RoomFault): void;
}

export interface Subscription {
  close(): void;
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
  /** True when the host had already committed this operation and returned the original receipt. */
  duplicate?: boolean;
  /** The operation id the receipt answers, on transports that have one. */
  operationId?: string;
}

export interface RoomClient {
  /** `local`, `native`, `seat` (the router), `stub`. */
  readonly kind: string;
  /** The human this surface posts as. Never read from the shared config. */
  actor(): HumanActor;
  /** Take the name the person just gave; every later post carries it. */
  adopt(actor: HumanActor): void;
  rooms(): Promise<RoomInfo[]>;
  read(alias: string, opts?: { since?: string; limit?: number }): Promise<ReadResult>;
  /**
   * Append `text` as the human actor. The text arrives already signed and already guarded. A
   * client with outcomes throws `PostFaultError`; anything else thrown is an ordinary failure.
   */
  post(alias: string, text: string, opts?: { thread?: string }): Promise<PostResult>;
  /** This seat's sessions, as far as the local records say. Remote seats are unknown here. */
  peers(): Promise<PeerRow[]>;
  /**
   * Follow the room after `since`: the handlers see every later commit in order, and the fault
   * that ends the subscription. Resolves to nothing for a room that can only be polled.
   */
  subscribe?(alias: string, since: string, handlers: SubscribeHandlers): Promise<Subscription | undefined>;
  /**
   * Search the room through its source. Resolves to nothing for a room with no source beyond
   * what was loaded; throws `SeamUnservedError` while the source's request is a seam.
   */
  search?(alias: string, query: string, opts?: { limit?: number }): Promise<SearchResult | undefined>;
  /** A client-specific reason a draft cannot go (the seat service nonce), or nothing. Never echoes. */
  draftRefusal?(text: string): string | undefined;
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
