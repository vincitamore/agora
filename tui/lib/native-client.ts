/**
 * NativeRoomClient: the human's client of the seat service, over the service's own socket, for
 * the rooms the config names `transport: native`. It is a client and nothing more: it holds no
 * token (the config's token fields are never read), never signs as an agent, never touches a
 * session record or a cursor file, and never writes the shared config.
 *
 * Hello is the subscriber's: the descriptor at `<state>/native/service.json` names the endpoint
 * and the seat-private nonce, the service proves possession first over a fresh transcript, and
 * the client answers with its own proof (`connectSeatService`). The nonce stays inside this
 * object; the one thing it is used for besides the proof is refusing a draft that carries it.
 *
 * Read honours the service's read coverage: what the surface shows as "read to" is the
 * coverage's `toInclusive` when the result carries a coverage block, and the checkpoint's
 * position otherwise (PROTOCOL.md: the checkpoint equals `toInclusive`); it is a cursor, never a
 * count. Subscribe rides `openNativeSubscription`, so dark and refused are told apart the way the
 * subscriber tells them apart: `ServiceDarkError` is the channel, anything else is an answer.
 *
 * Append goes to the service as the human actor, `authorKind: "human"`, under an operation id
 * this client mints and retains while acceptance is unknown, so an identical resend reuses it and
 * the host deduplicates. The receipt is checked against the operation it answers
 * (`assertReceiptContext`: the id derivation and the epoch), so a service cannot hand back a
 * receipt for something else.
 *
 * Requests the service does not serve yet are named seams (`SEAT_SERVICE_SEAMS`): the client
 * sends the request and turns the service's refusal into `SeamUnservedError`; nothing pretends.
 */

import { randomUUID } from "node:crypto";
import { connectSeatService, nativeMessage, openNativeSubscription, ServiceDarkError } from "../../src/wake/subscriber.mjs";
import { parseNativeCursor } from "../../src/native-protocol.mjs";
import { validateNativeCheckpoint, validateNativeReadCoverage } from "../../src/protocol/read.mjs";
import { assertReceiptContext, validateNativeCommitReceipt } from "../../src/protocol/receipt.mjs";
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

type Connect = typeof NativeServiceClient.connect;

export interface NativeClientOptions {
  /** Injected for tests; the subscriber's default is the real socket connect. */
  connect?: Connect;
  now?: () => Date;
  /** How long a subscription pump waits between drains when nothing arrives. */
  waitMs?: number;
  /** How long a live socket is kept before an idle client is closed; 0 keeps it. */
  timeoutMs?: number;
}

interface Endpoint {
  accountId: string;
  seatLabel: string;
  path: string;
}

/**
 * Dark or refused, decided by the channel. `ServiceDarkError` is the subscriber's own verdict;
 * a rejected request whose socket is gone is dark too; everything else arrived on a live socket.
 */
export function classifyFault(e: unknown, socketGone: () => boolean): RoomFault {
  const reason = e instanceof Error ? e.message : String(e);
  if (e instanceof ServiceDarkError || socketGone()) return { kind: "dark", reason };
  return { kind: "refused", reason };
}

const mintOperationId = () => randomUUID().replaceAll("-", "");

export class NativeRoomClient implements RoomClient {
  readonly kind = "native";
  private human: HumanActor;
  private readonly stateRoot: string;
  private readonly rooms_: NativeRoom[];
  private readonly connect?: Connect;
  private readonly now: () => Date;
  private readonly waitMs: number;
  private connecting: Promise<{ client: NativeServiceClient; endpoint: Endpoint }> | undefined;
  /** The seat-private nonce, once a hello has run. Never returned, never rendered. */
  private nonce: string | undefined;
  /** The live epoch per alias, learned from reads; the receipt check needs it. */
  private readonly epochs = new Map<string, string>();
  /** Operation ids retained while acceptance is unknown, keyed by alias and the exact text. */
  private readonly retained = new Map<string, string>();
  private readonly subscriptions = new Set<{ close(): void }>();

  constructor(human: HumanActor, view: { stateRoot: string; native: NativeRoom[] }, opts: NativeClientOptions = {}) {
    this.human = { name: human.name, kind: "human" };
    this.stateRoot = view.stateRoot;
    this.rooms_ = view.native;
    this.connect = opts.connect;
    this.now = opts.now ?? (() => new Date());
    this.waitMs = opts.waitMs ?? 1000;
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

  /** One request socket, made on first use and remade after it closes. The hello is inside. */
  private conn(): Promise<{ client: NativeServiceClient; endpoint: Endpoint }> {
    if (!this.connecting) {
      this.connecting = connectSeatService(this.stateRoot, { connect: this.connect }).then(
        ({ client, descriptor }) => {
          this.nonce = descriptor.nonce;
          client.socket.once("close", () => {
            this.connecting = undefined;
          });
          return { client, endpoint: { accountId: descriptor.accountId, seatLabel: descriptor.seatLabel, path: descriptor.path } };
        },
        (e) => {
          this.connecting = undefined;
          throw e;
        },
      );
    }
    return this.connecting;
  }

  draftRefusal(text: string): string | undefined {
    return nonceRefusal(text, this.nonce);
  }

  async read(alias: string, opts: { since?: string; limit?: number } = {}): Promise<ReadResult> {
    const roomId = this.roomId(alias);
    let c: NativeServiceClient;
    let endpoint: Endpoint;
    try {
      ({ client: c, endpoint } = await this.conn());
    } catch (e) {
      throw new RoomFaultError("dark", e instanceof Error ? e.message : String(e));
    }
    let result: Record<string, unknown>;
    try {
      result = (await c.request("read", { roomId, ...(opts.since ? { since: opts.since } : {}), ...(opts.limit ? { limit: opts.limit } : {}) })) as Record<string, unknown>;
    } catch (e) {
      const f = classifyFault(e, () => c.socket.destroyed);
      throw new RoomFaultError(f.kind, f.reason);
    }
    const messages = (Array.isArray(result.messages) ? result.messages : []).map((m) => nativeMessage(m) as unknown as Message);
    let checkpoint: ReturnType<typeof validateNativeCheckpoint>;
    try {
      checkpoint = validateNativeCheckpoint(result.checkpoint);
    } catch (e) {
      throw new RoomFaultError("refused", `read result carried no valid checkpoint (${e instanceof Error ? e.message : String(e)})`);
    }
    if (checkpoint.roomId !== roomId) throw new RoomFaultError("refused", "read result answered for another room");
    let readTo = `${checkpoint.epoch}:${checkpoint.sequence}`;
    let committedThrough: string | undefined;
    if (result.coverage !== undefined) {
      let coverage: ReturnType<typeof validateNativeReadCoverage>;
      try {
        coverage = validateNativeReadCoverage(result.coverage);
      } catch (e) {
        throw new RoomFaultError("refused", `read result carried an invalid coverage block (${e instanceof Error ? e.message : String(e)})`);
      }
      if (coverage.room.roomId !== roomId || coverage.room.epoch !== checkpoint.epoch) throw new RoomFaultError("refused", "read coverage names another room or epoch");
      if (parseNativeCursor(coverage.toInclusive).sequence !== checkpoint.sequence) throw new RoomFaultError("refused", "read coverage and checkpoint disagree on the position read to");
      readTo = coverage.toInclusive;
      committedThrough = coverage.committedThrough;
    }
    this.epochs.set(alias, checkpoint.epoch);
    return {
      messages,
      horizon: {
        alias,
        oldestTs: messages[0]?.ts,
        oldestCursor: messages[0]?.cursor,
        readAt: this.now().toISOString(),
        source: `seat service ${endpoint.seatLabel}`,
        readTo,
        ...(committedThrough ? { committedThrough } : {}),
      },
    };
  }

  async subscribe(alias: string, since: string, handlers: SubscribeHandlers): Promise<Subscription> {
    const roomId = this.roomId(alias);
    let sub: Awaited<ReturnType<typeof openNativeSubscription>>;
    try {
      sub = await openNativeSubscription({ stateRoot: this.stateRoot, roomId, since, connect: this.connect });
    } catch (e) {
      const f = classifyFault(e, () => false);
      throw new RoomFaultError(f.kind, f.reason);
    }
    let open = true;
    const handle = {
      close: () => {
        if (!open) return;
        open = false;
        this.subscriptions.delete(handle);
        sub.close();
      },
    };
    this.subscriptions.add(handle);
    void (async () => {
      while (open) {
        await sub.wait(this.waitMs);
        if (!open) return;
        let got: Message[];
        try {
          got = (await sub.read()) as unknown as Message[];
        } catch (e) {
          if (!open) return;
          const f = classifyFault(e, () => true);
          handle.close();
          handlers.onFault(f);
          return;
        }
        if (got.length) handlers.onMessages(got);
      }
    })();
    return handle;
  }

  async post(alias: string, text: string, opts: { thread?: string } = {}): Promise<PostResult> {
    const roomId = this.roomId(alias);
    const key = `${alias} ${text}`;
    const operationId = this.retained.get(key) ?? mintOperationId();
    this.retained.set(key, operationId);
    const operation = { operationId, authorName: this.human.name, authorKind: "human" as const, text, ...(opts.thread ? { thread: opts.thread } : {}) };
    const attempt = async (): Promise<PostResult> => {
      let c: NativeServiceClient;
      let endpoint: Endpoint;
      try {
        ({ client: c, endpoint } = await this.conn());
      } catch (e) {
        throw new PostFaultError("dark", `room-dark: ${e instanceof Error ? e.message : String(e)}; nothing was posted and no cursor was issued`, operationId);
      }
      if (c.socket.destroyed || !c.socket.writable) throw new PostFaultError("dark", "room-dark: the seat service socket is closed; nothing was posted and no cursor was issued", operationId);
      let ack: Record<string, unknown>;
      try {
        ack = (await c.request("append", { roomId, operation })) as Record<string, unknown>;
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        // the request was written: a socket that died afterwards, or a silence, leaves acceptance
        // unknown, and the same operation id is what makes the retry safe
        if (c.socket.destroyed || !c.socket.writable) throw new PostFaultError("unknown-acceptance", reason, operationId);
        if (e instanceof ServiceDarkError) throw new PostFaultError("unknown-acceptance", reason, operationId);
        throw new PostFaultError("refused", reason, operationId);
      }
      const receipt = { roomId, accountId: endpoint.accountId, operationId, id: ack.id, cursor: ack.cursor };
      try {
        const epoch = this.epochs.get(alias);
        if (epoch) assertReceiptContext(receipt, { roomId, accountId: endpoint.accountId, operationId, epoch });
        else validateNativeCommitReceipt(receipt);
      } catch (e) {
        throw new PostFaultError("refused", `the receipt does not answer this operation (${e instanceof Error ? e.message : String(e)})`, operationId);
      }
      return { id: String(ack.id), cursor: String(ack.cursor), duplicate: ack.duplicate === true, operationId };
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

  /** A request the service does not serve yet, sent anyway so the refusal is the service's. */
  private async seam<T>(request: "search" | "roster", fields: Record<string, unknown>): Promise<T> {
    let c: NativeServiceClient;
    try {
      ({ client: c } = await this.conn());
    } catch (e) {
      throw new RoomFaultError("dark", e instanceof Error ? e.message : String(e));
    }
    try {
      return (await c.request(request, fields)) as T;
    } catch (e) {
      const f = classifyFault(e, () => c.socket.destroyed);
      if (f.kind === "dark") throw new RoomFaultError("dark", f.reason);
      throw new SeamUnservedError(request, f.reason);
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
    const { endpoint } = await this.conn();
    return {
      rows,
      horizon: { alias, oldestTs: rows[0]?.ts, oldestCursor: coverage.fromExclusive, readAt: this.now().toISOString(), source: `seat service ${endpoint.seatLabel} index`, readTo: coverage.toInclusive, committedThrough: coverage.committedThrough },
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
    if (pending) void pending.then(({ client }) => client.close(), () => undefined);
  }
}
