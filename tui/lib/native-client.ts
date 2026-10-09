/**
 * NativeRoomClient: the human's client of the seat service, for the rooms the config names
 * `transport: native`. It is the first consumer of `agora/client` (src/client.mjs) and adds only
 * what this surface needs on top: the human actor, the horizon each read renders, one resend of an
 * append whose acceptance is unknown, and the RoomClient seam's fault types. It holds no token (the
 * config's token fields are never read), never signs as an agent, never touches a session record or
 * a cursor file, and never writes the shared config.
 *
 * Through the client: the hello (the service proves itself first, from the descriptor), reads with
 * their coverage ("read to" is the position the read accounts for, never a count), the pushed
 * subscription with dark told apart from refused by the channel, and appends as `authorKind: human`
 * under an operation id this surface retains while acceptance is unknown, with the receipt checked
 * against the operation it answers.
 *
 * Beside the client, for what it deliberately does not cover: the seat's session records (PEERS),
 * the descriptor's nonce (the compose guard refuses a draft that carries it; the client never hands
 * the secret out), and the requests the service does not serve yet (`SEAT_SERVICE_SEAMS`), sent on
 * a connection of their own so the refusal is the service's and nothing pretends.
 */

import { randomUUID } from "node:crypto";
import { ClientError, connect, type Client } from "../../src/client.mjs";
import { connectSeatService, nativeMessage, readServiceDescriptor } from "../../src/wake/subscriber.mjs";
import { validateNativeReadCoverage } from "../../src/protocol/read.mjs";
import { listRecords } from "../../src/session.mjs";
import type { NativeServiceClient } from "../../src/native-service.mjs";
import { nonceRefusal } from "./compose-guard";
import type { NativeRoom } from "./local-client";
import {
  PostFaultError,
  RoomFaultError,
  SeamUnservedError,
  type HumanActor,
  type Message,
  type PeerRow,
  type PostResult,
  type ReadResult,
  type RoomClient,
  type RoomFault,
  type RoomInfo,
  type SearchResult,
  type SubscribeHandlers,
  type Subscription,
} from "./room-client";

export interface NativeClientOptions {
  now?: () => Date;
}

/** The client's outcome as this surface's fault: refused is an answer, everything else is dark. */
function roomFault(e: unknown): RoomFaultError {
  if (e instanceof ClientError) return new RoomFaultError(e.outcome === "refused" ? "refused" : "dark", e.message);
  return new RoomFaultError("dark", e instanceof Error ? e.message : String(e));
}

const mintOperationId = () => randomUUID().replaceAll("-", "");

export class NativeRoomClient implements RoomClient {
  readonly kind = "native";
  private human: HumanActor;
  private readonly stateRoot: string;
  private readonly rooms_: NativeRoom[];
  private readonly now: () => Date;
  private connecting: Promise<Client> | undefined;
  private seamConnecting: Promise<NativeServiceClient> | undefined;
  /** The seat-private nonce, once the descriptor has been read. Never returned, never rendered. */
  private nonce: string | undefined;
  /** Operation ids retained while acceptance is unknown, keyed by alias and the exact text. */
  private readonly retained = new Map<string, string>();
  private readonly subscriptions = new Set<{ close(): void }>();

  constructor(human: HumanActor, view: { stateRoot: string; native: NativeRoom[] }, opts: NativeClientOptions = {}) {
    this.human = { name: human.name, kind: "human" };
    this.stateRoot = view.stateRoot;
    this.rooms_ = view.native;
    this.now = opts.now ?? (() => new Date());
  }

  actor(): HumanActor {
    return this.human;
  }

  adopt(actor: HumanActor): void {
    this.human = { name: actor.name, kind: "human" };
  }

  async rooms(): Promise<RoomInfo[]> {
    return this.rooms_.map(({ alias, transport, room, roomId, note }) => ({ alias, transport, room, roomId, note }));
  }

  private roomId(alias: string): string {
    const room = this.rooms_.find((r) => r.alias === alias);
    if (!room) throw new RoomFaultError("refused", `no native room named ${alias} in the config`);
    return room.roomId;
  }

  /** The client, made on first use and made again after a failed connect; it redials by itself. */
  private client(): Promise<Client> {
    if (!this.connecting) {
      const attempt = connect({ state: this.stateRoot }).then(async (c) => {
        await this.learnNonce();
        return c;
      });
      attempt.catch(() => {
        if (this.connecting === attempt) this.connecting = undefined;
      });
      this.connecting = attempt;
    }
    return this.connecting;
  }

  /** The descriptor's nonce, for the compose guard only. */
  private async learnNonce(): Promise<void> {
    try {
      this.nonce = (await readServiceDescriptor(this.stateRoot)).nonce;
    } catch {
      /* a guard with nothing to compare against refuses nothing; the client refuses it on append */
    }
  }

  draftRefusal(text: string): string | undefined {
    return nonceRefusal(text, this.nonce);
  }

  async read(alias: string, opts: { since?: string; limit?: number } = {}): Promise<ReadResult> {
    const roomId = this.roomId(alias);
    let c: Client;
    try {
      c = await this.client();
    } catch (e) {
      throw roomFault(e);
    }
    let r: Awaited<ReturnType<Client["read"]>>;
    try {
      r = await c.read({ roomId }, { ...(opts.since ? { since: opts.since } : {}), ...(opts.limit ? { limit: opts.limit } : {}) });
    } catch (e) {
      throw roomFault(e);
    }
    const messages = r.messages as unknown as Message[];
    return {
      messages,
      horizon: {
        alias,
        oldestTs: messages[0]?.ts,
        oldestCursor: messages[0]?.cursor,
        readAt: this.now().toISOString(),
        source: `seat service ${c.seat.label}`,
        readTo: r.through,
        ...(r.committedThrough ? { committedThrough: r.committedThrough } : {}),
      },
    };
  }

  async subscribe(alias: string, since: string, handlers: SubscribeHandlers): Promise<Subscription> {
    const roomId = this.roomId(alias);
    let c: Client;
    try {
      c = await this.client();
    } catch (e) {
      throw roomFault(e);
    }
    let open = true;
    let sub: Awaited<ReturnType<Client["subscribe"]>> | undefined;
    const handle = {
      close: () => {
        if (!open) return;
        open = false;
        this.subscriptions.delete(handle);
        sub?.close();
      },
    };
    const ended = (kind: RoomFault["kind"]) => (e: ClientError) => {
      if (!open) return;
      open = false;
      this.subscriptions.delete(handle);
      handlers.onFault({ kind, reason: e.message });
    };
    this.subscriptions.add(handle);
    try {
      sub = await c.subscribe({ roomId }, { since }, {
        message: (m) => {
          if (open) handlers.onMessages([m as unknown as Message]);
        },
        dark: ended("dark"),
        refused: ended("refused"),
      });
    } catch (e) {
      this.subscriptions.delete(handle);
      throw roomFault(e);
    }
    if (!open) sub.close();
    return handle;
  }

  async post(alias: string, text: string, opts: { thread?: string } = {}): Promise<PostResult> {
    const roomId = this.roomId(alias);
    const key = `${alias}\u0000${text}`;
    const operationId = this.retained.get(key) ?? mintOperationId();
    this.retained.set(key, operationId);
    const attempt = async (): Promise<PostResult> => {
      let c: Client;
      try {
        c = await this.client();
      } catch (e) {
        throw new PostFaultError("dark", `room-dark: ${e instanceof Error ? e.message : String(e)}; nothing was posted and no cursor was issued`, operationId);
      }
      try {
        const r = await c.append({ roomId }, { text, author: { kind: "human", name: this.human.name }, operationId, ...(opts.thread ? { thread: opts.thread } : {}) });
        return { id: r.id, cursor: r.cursor, duplicate: r.duplicate, operationId: r.operationId };
      } catch (e) {
        if (e instanceof ClientError) throw new PostFaultError(e.outcome, e.message, operationId);
        throw e;
      }
    };
    try {
      const r = await attempt();
      this.retained.delete(key);
      return r;
    } catch (e) {
      if (e instanceof PostFaultError && e.outcome === "unknown-acceptance") {
        // one more try on a fresh socket under the same operation id: the host returns the
        // original receipt when it had committed, and appends once when it had not
        try {
          const r = await attempt();
          this.retained.delete(key);
          return r;
        } catch (again) {
          if (again instanceof PostFaultError && again.outcome === "refused") {
            this.retained.delete(key);
            throw again;
          }
          throw new PostFaultError("unknown-acceptance", `${e.reason}; operation ${operationId} is retained and an identical resend reuses it`, operationId);
        }
      }
      if (e instanceof PostFaultError && e.outcome === "refused") this.retained.delete(key);
      throw e;
    }
  }

  async peers(): Promise<PeerRow[]> {
    const rows = await listRecords(this.stateRoot);
    return rows.map((r) => ({
      bearer: r.record?.bearer ?? "(unregistered)",
      slug: r.slug,
      state: r.state === "live" ? "live" : r.state === "gone" ? "dark" : "unknown",
      pid: r.record?.pid,
      lastSeen: r.record?.lastSeen,
      label: r.record?.label,
    }));
  }

  /** The seam connection: a request socket of its own, for requests the client does not carry. */
  private seamClient(): Promise<NativeServiceClient> {
    if (!this.seamConnecting) {
      const attempt = connectSeatService(this.stateRoot).then(({ client, descriptor }) => {
        this.nonce = descriptor.nonce;
        client.socket.once("close", () => {
          if (this.seamConnecting === attempt) this.seamConnecting = undefined;
        });
        return client;
      });
      attempt.catch(() => {
        if (this.seamConnecting === attempt) this.seamConnecting = undefined;
      });
      this.seamConnecting = attempt;
    }
    return this.seamConnecting;
  }

  /** A request the service does not serve yet, sent anyway so the refusal is the service's. */
  private async seam<T>(request: "search" | "roster", fields: Record<string, unknown>): Promise<T> {
    let c: NativeServiceClient;
    try {
      c = await this.seamClient();
    } catch (e) {
      throw new RoomFaultError("dark", e instanceof Error ? e.message : String(e));
    }
    try {
      return (await c.request(request, fields)) as T;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      if (c.socket.destroyed) throw new RoomFaultError("dark", reason);
      throw new SeamUnservedError(request, reason);
    }
  }

  /**
   * `search` through the service: `{roomId, query, limit}` answered by `search-result` carrying
   * `rows` (messages, verbatim) and `coverage` (the per-room horizon). The service refuses the
   * request today; the refusal is `SeamUnservedError`, and SEARCH says so on its horizon line.
   */
  async search(alias: string, query: string, opts: { limit?: number } = {}): Promise<SearchResult> {
    const roomId = this.roomId(alias);
    const result = await this.seam<Record<string, unknown>>("search", { roomId, query, ...(opts.limit ? { limit: opts.limit } : {}) });
    const rows = (Array.isArray(result.rows) ? result.rows : []).map((m) => nativeMessage(m) as unknown as Message);
    const coverage = validateNativeReadCoverage(result.coverage);
    if (coverage.room.roomId !== roomId) throw new RoomFaultError("refused", "search coverage names another room");
    const c = await this.client();
    return {
      rows,
      horizon: { alias, oldestTs: rows[0]?.ts, oldestCursor: coverage.fromExclusive, readAt: this.now().toISOString(), source: `seat service ${c.seat.label} index`, readTo: coverage.toInclusive, committedThrough: coverage.committedThrough },
    };
  }

  /** `roster` through the service; refused today, so PEERS reads this seat's records. */
  async roster(): Promise<PeerRow[]> {
    const result = await this.seam<Record<string, unknown>>("roster", {});
    return Array.isArray(result.rows) ? (result.rows as PeerRow[]) : [];
  }

  /** Drop every socket. A client exit disconnects only; it never stops the service. */
  close(): void {
    for (const s of [...this.subscriptions]) s.close();
    const pending = this.connecting;
    this.connecting = undefined;
    if (pending) void pending.then((c) => c.close(), () => undefined);
    const seam = this.seamConnecting;
    this.seamConnecting = undefined;
    if (seam) void seam.then((c) => c.close(), () => undefined);
  }
}
