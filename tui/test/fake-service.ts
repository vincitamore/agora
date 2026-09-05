/**
 * A fake seat service for the smokes: the real wire (length-prefixed frames, the server-first
 * hello with the real proofs from `src/native-protocol.mjs`, `status` / `read` / `subscribe` /
 * `append` answered the way `src/native-service.mjs` answers them) over a pipe of its own, with
 * knobs the real service has no reason to expose: a read result that carries the protocol's
 * `coverage` block with `toInclusive` past the last message, a request type to refuse, an append
 * that is never acknowledged, and a link that is dropped on command. Every frame a client sends
 * is kept, so a test can assert what went over the wire and what never did.
 *
 * It is a double, not a second implementation: it refuses every request it does not know
 * (`search`, `roster`, anything else) with `request-refused`, exactly as the service does today,
 * so a seam is exhibited by the service's own refusal and never by a pretended answer.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  NATIVE_PROTOCOL,
  NativeFrameDecoder,
  encodeNativeFrame,
  nativeCursor,
  nativeHandshakeProof,
  parseNativeCursor,
  validateNativeEnvelope,
  verifyNativeHandshakeProof,
} from "../../src/native-protocol.mjs";

export interface FakeMessage {
  id: string;
  room: string;
  author: { id: string; name: string; kind: string };
  text: string;
  ts: string;
  cursor: string;
  thread?: string;
}

export interface FakeServiceOptions {
  root: string;
  roomId: string;
  epoch: string;
  accountId?: string;
  seatLabel?: string;
  /** Answer `read` with the protocol's coverage block, `toInclusive` this many events past the last message. */
  coverageAhead?: number;
  /** Request types to refuse with `request-refused` even though the fake knows them. */
  refuse?: string[];
  /** Hold every `append` without an ack (acceptance stays unknown until the link is dropped). */
  holdAppend?: boolean;
  now?: () => Date;
}

export interface FakeService {
  readonly descriptor: { path: string; nonce: string; bootEpoch: string; accountId: string; seatLabel: string };
  readonly nonce: string;
  readonly accountId: string;
  readonly messages: FakeMessage[];
  /** Every frame a client sent after its hello, in order, across connections. */
  readonly frames: Array<Record<string, unknown>>;
  /** Every client-hello frame, kept apart so a test can grep the wire without them. */
  readonly hellos: Array<Record<string, unknown>>;
  /** Append a message as a peer would and push it to every subscriber. */
  seed(author: { name: string; kind: string }, text: string, opts?: { thread?: string }): FakeMessage;
  /** Drop every live connection; the listener stays, so the next connect succeeds. */
  dropSockets(): void;
  /** Hold or release the append ack. A held append is committed; only its ack is withheld. */
  setHoldAppend(hold: boolean): void;
  /** Answer appends with a receipt whose id derives from some other operation. */
  setForgeReceipt(forge: boolean): void;
  setRefuse(types: string[]): void;
  /** Stop listening, drop everything, remove the descriptor: dark. */
  stop(): Promise<void>;
}

const hex32 = () => randomUUID().replaceAll("-", "");

function pipePath(): string {
  const tag = `agora-tui-fake-${process.pid}-${hex32().slice(0, 12)}`;
  if (process.platform === "win32") return `\\\\.\\pipe\\${tag}`;
  return path.join(tmpdir(), `${tag}.sock`);
}

export async function startFakeService(opts: FakeServiceOptions): Promise<FakeService> {
  const accountId = opts.accountId ?? "seat_account_fake";
  const seatLabel = opts.seatLabel ?? "fake-seat";
  const nonce = hex32();
  const bootEpoch = hex32();
  const now = opts.now ?? (() => new Date());
  const endpoint = pipePath();
  const messages: FakeMessage[] = [];
  const frames: Array<Record<string, unknown>> = [];
  const hellos: Array<Record<string, unknown>> = [];
  const operations = new Map<string, FakeMessage>();
  const sockets = new Set<net.Socket>();
  const subscriptions = new Map<net.Socket, Map<string, number>>();
  let refuse = new Set(opts.refuse ?? []);
  let holdAppend = opts.holdAppend ?? false;
  let forgeReceipt = false;

  const send = (socket: net.Socket, value: unknown) => {
    if (socket.destroyed || !socket.writable) return false;
    socket.write(encodeNativeFrame(value));
    return true;
  };
  const checkpoint = (sequence: number) => ({
    roomId: opts.roomId,
    epoch: opts.epoch,
    sequence,
    digest: sequence === 0 ? null : `sha256:${createHash("sha256").update(`fake-${sequence}`).digest("hex")}`,
  });
  // the host's committed frontier counts every record; `coverageAhead` places that many
  // board-only records after the seeded messages at the first read, so a later message commits
  // past them and the coverage of a tail read sits past the last message
  let committedSeq = 0;
  let placedAhead = false;
  const seqOf = (m: FakeMessage) => parseNativeCursor(m.cursor).sequence;
  const placeAhead = () => {
    if (placedAhead || !opts.coverageAhead) return;
    placedAhead = true;
    committedSeq += opts.coverageAhead;
  };
  const committed = () => committedSeq;
  const commit = (author: { name: string; kind: string }, text: string, operationId: string, thread?: string): FakeMessage => {
    committedSeq += 1;
    const sequence = committedSeq;
    const id = createHash("sha256").update(`${opts.roomId}\0${accountId}\0${operationId}`).digest("hex");
    const m: FakeMessage = { id, room: opts.roomId, author: { id: accountId, name: author.name, kind: author.kind }, text, ts: now().toISOString(), cursor: nativeCursor(opts.epoch, sequence), ...(thread ? { thread } : {}) };
    messages.push(m);
    operations.set(operationId, m);
    for (const [socket, rooms] of subscriptions) {
      const previous = rooms.get(opts.roomId);
      if (previous === undefined || sequence <= previous) continue;
      if (send(socket, { protocol: NATIVE_PROTOCOL, type: "event", requestId: m.id, roomId: opts.roomId, message: m })) rooms.set(opts.roomId, sequence);
    }
    return m;
  };
  const readSince = (since: string | undefined, limit: number) => {
    if (!since) return messages.slice(-limit);
    const c = parseNativeCursor(since);
    if (c.epoch !== opts.epoch) throw new Error(`native room cursor belongs to epoch ${c.epoch}, not live epoch ${opts.epoch}; recover explicitly without advancing`);
    if (c.sequence > committedSeq) throw new Error(`native room cursor ${c.sequence} exceeds committed sequence ${committedSeq}; recover explicitly without advancing`);
    return messages.filter((m) => seqOf(m) > c.sequence).slice(0, limit);
  };

  const dispatch = (socket: net.Socket, frame: Record<string, unknown>) => {
    const type = String(frame.type);
    const requestId = String(frame.requestId);
    const fail = (message: string) => send(socket, { protocol: NATIVE_PROTOCOL, type: "error", requestId, reason: "request-refused", message });
    if (refuse.has(type)) return fail(`native service does not support request type ${JSON.stringify(type)}`);
    if (frame.roomId !== opts.roomId && ["status", "read", "subscribe", "append"].includes(type)) return fail(`native room ${String(frame.roomId)} is not hosted here`);
    if (type === "status") {
      return send(socket, { protocol: NATIVE_PROTOCOL, type: "status-result", requestId, status: { roomId: opts.roomId, epoch: opts.epoch, hostAccountId: accountId, committed: committed(), latestCursor: nativeCursor(opts.epoch, committed()) } });
    }
    if (type === "read") {
      const since = typeof frame.since === "string" ? frame.since : undefined;
      const limit = typeof frame.limit === "number" ? frame.limit : 1000;
      let rows: FakeMessage[];
      try {
        rows = readSince(since, limit);
      } catch (e) {
        return fail((e as Error).message);
      }
      // the checkpoint is the position read to: the last row when the page stops short of the
      // frontier, the frontier itself when the page reaches it (past the last message when the
      // records after it are not messages)
      placeAhead();
      const last = rows.length ? seqOf(rows[rows.length - 1]!) : since ? parseNativeCursor(since).sequence : committed();
      const to = messages.some((m) => seqOf(m) > last) ? last : committed();
      const from = rows.length ? seqOf(rows[0]!) - 1 : since ? parseNativeCursor(since).sequence : to;
      const result: Record<string, unknown> = { protocol: NATIVE_PROTOCOL, type: "read-result", requestId, roomId: opts.roomId, messages: rows, checkpoint: checkpoint(to) };
      if (opts.coverageAhead !== undefined) {
        result.coverage = {
          room: { host: { scheme: "native", authority: seatLabel, id: accountId }, roomId: opts.roomId, epoch: opts.epoch },
          fromExclusive: nativeCursor(opts.epoch, from),
          toInclusive: nativeCursor(opts.epoch, to),
          committedThrough: nativeCursor(opts.epoch, committed()),
        };
      }
      return send(socket, result);
    }
    if (type === "subscribe") {
      const since = typeof frame.since === "string" ? frame.since : undefined;
      if (!since) return fail("native subscription needs an explicit cursor");
      let backlog: FakeMessage[];
      try {
        backlog = readSince(since, 10_000);
      } catch (e) {
        return fail((e as Error).message);
      }
      for (const m of backlog) send(socket, { protocol: NATIVE_PROTOCOL, type: "event", requestId: m.id, roomId: opts.roomId, message: m });
      subscriptions.get(socket)?.set(opts.roomId, committed());
      return send(socket, { protocol: NATIVE_PROTOCOL, type: "subscribe-result", requestId, roomId: opts.roomId, messages: [], checkpoint: checkpoint(committed()) });
    }
    if (type === "append") {
      const op = frame.operation as Record<string, unknown> | undefined;
      if (!op || typeof op.operationId !== "string" || typeof op.text !== "string" || typeof op.authorName !== "string") return fail("native append needs an operation object");
      const existing = operations.get(op.operationId);
      const m = existing ?? commit({ name: op.authorName, kind: typeof op.authorKind === "string" ? op.authorKind : "agent" }, op.text, op.operationId, typeof op.thread === "string" ? op.thread : undefined);
      if (holdAppend) return true;
      const id = forgeReceipt ? createHash("sha256").update(`${opts.roomId}\0${accountId}\0${hex32()}`).digest("hex") : m.id;
      return send(socket, { protocol: NATIVE_PROTOCOL, type: "append-ack", requestId, roomId: opts.roomId, id, cursor: m.cursor, duplicate: existing !== undefined });
    }
    return fail(`native service does not support request type ${JSON.stringify(type)}`);
  };

  const server = net.createServer((socket) => {
    sockets.add(socket);
    subscriptions.set(socket, new Map());
    const decoder = new NativeFrameDecoder();
    let greeted = false;
    const requestId = hex32();
    const serverChallenge = hex32();
    const serverTranscript = { bootEpoch, requestId, serverChallenge, accountId, seatLabel };
    send(socket, { protocol: NATIVE_PROTOCOL, type: "server-hello", ...serverTranscript, proof: nativeHandshakeProof(nonce, "server", serverTranscript) });
    socket.on("data", (bytes) => {
      let values: unknown[];
      try {
        values = decoder.push(bytes as Uint8Array);
      } catch {
        socket.destroy();
        return;
      }
      for (const raw of values) {
        let frame: Record<string, unknown>;
        try {
          frame = validateNativeEnvelope(raw);
        } catch {
          socket.destroy();
          return;
        }
        if (!greeted) {
          hellos.push(frame);
          const clientChallenge = String(frame.clientChallenge ?? "");
          const transcript = { ...serverTranscript, clientChallenge };
          if (frame.type !== "client-hello" || frame.requestId !== requestId || !verifyNativeHandshakeProof(frame.proof, nonce, "client", transcript)) {
            send(socket, { protocol: NATIVE_PROTOCOL, type: "error", requestId, reason: "hello-refused", message: "native service client did not prove the transcript" });
            socket.end();
            return;
          }
          greeted = true;
          send(socket, { protocol: NATIVE_PROTOCOL, type: "welcome", ...transcript, proof: nativeHandshakeProof(nonce, "welcome", transcript) });
          continue;
        }
        frames.push(frame);
        dispatch(socket, frame);
      }
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      sockets.delete(socket);
      subscriptions.delete(socket);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ path: endpoint, exclusive: true }, () => resolve());
  });
  const descriptor = { protocol: NATIVE_PROTOCOL, path: endpoint, nonce, pid: process.pid, bootEpoch, accountId, seatLabel, startedAt: now().toISOString() };
  const descriptorFile = path.join(opts.root, "native", "service.json");
  await mkdir(path.dirname(descriptorFile), { recursive: true, mode: 0o700 });
  await writeFile(descriptorFile, `${JSON.stringify(descriptor, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

  return {
    descriptor,
    nonce,
    accountId,
    messages,
    frames,
    hellos,
    seed: (author, text, o = {}) => commit(author, text, hex32(), o.thread),
    dropSockets: () => {
      for (const s of sockets) s.destroy();
    },
    setHoldAppend: (hold) => {
      holdAppend = hold;
    },
    setForgeReceipt: (forge) => {
      forgeReceipt = forge;
    },
    setRefuse: (types) => {
      refuse = new Set(types);
    },
    stop: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(descriptorFile, { force: true });
    },
  };
}
