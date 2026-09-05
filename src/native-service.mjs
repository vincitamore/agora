// @ts-check
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { AgoraError } from "./core.mjs";
import { NativeFrameDecoder, NATIVE_PROTOCOL, encodeNativeFrame, parseNativeCursor, validateNativeEnvelope, validateNativeId } from "./native-protocol.mjs";
import { NativeRoomStore } from "./native-store.mjs";

const MAX_PENDING_WRITE = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

/** @param {string} file @param {unknown} value */
async function writeAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temp, file);
  } finally { await rm(temp, { force: true }); }
}

/** @param {net.Socket} socket @param {unknown} value */
function sendFrame(socket, value) {
  const frame = encodeNativeFrame(value);
  if (socket.destroyed || !socket.writable || socket.writableLength + frame.length > MAX_PENDING_WRITE) {
    socket.destroy(new AgoraError("native service client is dark or its pending output exceeded the bound"));
    return false;
  }
  socket.write(frame);
  return true;
}

/** @param {unknown} value @param {string} label */
function requiredString(value, label) {
  if (typeof value !== "string" || !value) throw new AgoraError(`native ${label} is required`);
  return value;
}

export class NativeRoomService {
  /** @param {{ root: string, accountId: string, seatLabel: string, now?: () => Date, nonce?: string }} options */
  constructor(options) {
    validateNativeId(options.accountId, "service account id");
    if (!options.seatLabel?.trim() || options.seatLabel.length > 120) throw new AgoraError("native service needs a bounded seat label");
    this.root = path.resolve(options.root);
    this.accountId = options.accountId;
    this.seatLabel = options.seatLabel.trim();
    this.now = options.now ?? (() => new Date());
    this.nonce = options.nonce ?? randomUUID().replaceAll("-", "");
    validateNativeId(this.nonce, "service nonce");
    this.bootEpoch = randomUUID().replaceAll("-", "");
    this.startedAt = this.now().toISOString();
    this.nativeDirectory = path.join(this.root, "native");
    this.lockPath = path.join(this.nativeDirectory, "service.lock");
    this.descriptorPath = path.join(this.nativeDirectory, "service.json");
    /** @type {import('node:fs/promises').FileHandle | null} */
    this.lock = null;
    /** @type {net.Server | null} */
    this.server = null;
    /** @type {Map<string, NativeRoomStore>} */
    this.rooms = new Map();
    /** @type {Map<string, Promise<NativeRoomStore>>} */
    this.roomOpenings = new Map();
    /** @type {Set<net.Socket>} */
    this.sockets = new Set();
    /** @type {Map<net.Socket, Map<string, number>>} */
    this.subscriptions = new Map();
    this.running = false;
  }

  async start() {
    if (this.running) return this.descriptor();
    await mkdir(this.nativeDirectory, { recursive: true, mode: 0o700 });
    try { this.lock = await open(this.lockPath, "wx", 0o600); }
    catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code === "EEXIST")
        throw new AgoraError(`native service lock already exists at ${this.lockPath}; inspect the recorded service before explicit recovery`);
      throw e;
    }
    try {
      await this.lock.writeFile(`${JSON.stringify({ pid: process.pid, nonce: this.nonce, bootEpoch: this.bootEpoch })}\n`, "utf8");
      await this.lock.sync();
      this.server = net.createServer((socket) => this.#accept(socket));
      this.server.maxConnections = 128;
      this.server.listen({ host: "127.0.0.1", port: 0, exclusive: true });
      await Promise.race([
        once(this.server, "listening"),
        once(this.server, "error").then(([error]) => Promise.reject(error)),
      ]);
      this.running = true;
      await writeAtomic(this.descriptorPath, this.descriptor());
      return this.descriptor();
    } catch (e) {
      await this.#releaseFiles();
      throw e;
    }
  }

  descriptor() {
    const address = this.server?.address();
    return { protocol: NATIVE_PROTOCOL, host: "127.0.0.1", port: typeof address === "object" && address ? address.port : null,
      nonce: this.nonce, pid: process.pid, bootEpoch: this.bootEpoch, accountId: this.accountId, seatLabel: this.seatLabel,
      startedAt: this.startedAt };
  }

  /** @param {{ roomId?: string, epoch?: string }} [options] */
  async createRoom(options = {}) {
    if (!this.running) throw new AgoraError("native service is dark; start it explicitly before creating a room");
    if (options.roomId && (this.rooms.has(options.roomId) || this.roomOpenings.has(options.roomId)))
      throw new AgoraError(`native room ${options.roomId} is already open on this service`);
    const store = await NativeRoomStore.create({ root: this.root, roomId: options.roomId, epoch: options.epoch,
      hostAccountId: this.accountId, now: this.now });
    this.rooms.set(store.manifest.roomId, store);
    return store.status();
  }

  /** @param {string} roomId */
  async openRoom(roomId) {
    if (!this.running) throw new AgoraError("native service is dark; start it explicitly before opening a room");
    const existing = this.rooms.get(roomId);
    if (existing) return existing;
    const opening = this.roomOpenings.get(roomId) ?? NativeRoomStore.open({ root: this.root, roomId, now: this.now });
    this.roomOpenings.set(roomId, opening);
    try {
      const store = await opening;
      this.rooms.set(roomId, store);
      return store;
    } finally { this.roomOpenings.delete(roomId); }
  }

  /** @param {net.Socket} socket */
  #accept(socket) {
    socket.setNoDelay(true);
    this.sockets.add(socket);
    this.subscriptions.set(socket, new Map());
    const decoder = new NativeFrameDecoder();
    let greeted = false;
    let chain = Promise.resolve();
    const fail = (/** @type {unknown} */ error, /** @type {string | undefined} */ requestId) => {
      const message = error instanceof Error ? error.message : "native service request failed";
      sendFrame(socket, { protocol: NATIVE_PROTOCOL, type: "error", requestId: requestId ?? randomUUID().replaceAll("-", ""),
        reason: greeted ? "request-refused" : "hello-refused", message: message.slice(0, 500) });
    };
    socket.on("data", (bytes) => {
      let frames;
      try { frames = decoder.push(bytes); }
      catch (error) { fail(error, undefined); socket.destroy(); return; }
      for (const raw of frames) {
        chain = chain.then(async () => {
          const frame = validateNativeEnvelope(raw);
          if (!greeted) {
            if (frame.type !== "hello" || frame.nonce !== this.nonce) throw new AgoraError("native service hello did not prove the local service nonce");
            greeted = true;
            sendFrame(socket, { protocol: NATIVE_PROTOCOL, type: "welcome", requestId: frame.requestId,
              bootEpoch: this.bootEpoch, accountId: this.accountId, seatLabel: this.seatLabel });
            return;
          }
          await this.#dispatch(socket, frame);
        }).catch((error) => {
          const requestId = raw && typeof raw === "object" && "requestId" in raw && typeof raw.requestId === "string" ? raw.requestId : undefined;
          fail(error, requestId);
          if (!greeted) socket.end();
        });
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => { this.sockets.delete(socket); this.subscriptions.delete(socket); });
  }

  /** @param {net.Socket} socket @param {Record<string, unknown>} frame */
  async #dispatch(socket, frame) {
    const roomId = requiredString(frame.roomId, "room id");
    const store = await this.openRoom(roomId);
    if (frame.type === "status") {
      sendFrame(socket, { protocol: NATIVE_PROTOCOL, type: "status-result", requestId: frame.requestId, status: store.status() });
      return;
    }
    if (frame.type === "read" || frame.type === "subscribe") {
      const since = frame.since === undefined ? undefined : requiredString(frame.since, "cursor");
      const limit = frame.limit === undefined ? undefined : Number(frame.limit);
      const messages = store.read({ ...(since ? { since } : {}), ...(limit !== undefined ? { limit } : {}) });
      const sequence = messages.length ? parseNativeCursor(messages.at(-1).cursor).sequence
        : since ? parseNativeCursor(since).sequence : store.status().committed;
      sendFrame(socket, { protocol: NATIVE_PROTOCOL, type: frame.type === "subscribe" ? "subscribe-result" : "read-result",
        requestId: frame.requestId, roomId, messages, checkpoint: store.checkpoint(sequence) });
      if (frame.type === "subscribe") this.subscriptions.get(socket)?.set(roomId, sequence);
      return;
    }
    if (frame.type === "append") {
      const operation = frame.operation;
      if (!operation || typeof operation !== "object" || Array.isArray(operation)) throw new AgoraError("native append needs an operation object");
      const receipt = await store.append(/** @type {any} */ (operation), { accountId: this.accountId });
      const message = store.read({ since: `${store.manifest.epoch}:${parseNativeCursor(receipt.cursor).sequence - 1}`, limit: 1 })[0];
      sendFrame(socket, { protocol: NATIVE_PROTOCOL, type: "append-ack", requestId: frame.requestId, roomId, ...receipt });
      this.#broadcast(roomId, message);
      return;
    }
    throw new AgoraError(`native service does not support request type ${JSON.stringify(frame.type)}`);
  }

  /** @param {string} roomId @param {any} message */
  #broadcast(roomId, message) {
    const sequence = parseNativeCursor(message.cursor).sequence;
    for (const [socket, rooms] of this.subscriptions) {
      const previous = rooms.get(roomId);
      if (previous === undefined || sequence <= previous) continue;
      if (sendFrame(socket, { protocol: NATIVE_PROTOCOL, type: "event", requestId: message.id, roomId, message })) rooms.set(roomId, sequence);
    }
  }

  async stop() {
    if (!this.server && !this.lock) return;
    this.running = false;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear(); this.subscriptions.clear();
    if (this.server) {
      const server = this.server; this.server = null;
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    }
    for (const store of this.rooms.values()) await store.close();
    this.rooms.clear();
    await this.#releaseFiles();
  }

  async #releaseFiles() {
    if (this.server) {
      if (this.server.listening) this.server.close();
      this.server = null;
    }
    if (this.lock) { await this.lock.close(); this.lock = null; }
    try {
      const descriptor = JSON.parse(await readFile(this.descriptorPath, "utf8"));
      if (descriptor.nonce === this.nonce) await rm(this.descriptorPath, { force: true });
    } catch {}
    try {
      const lock = JSON.parse(await readFile(this.lockPath, "utf8"));
      if (lock.nonce === this.nonce) await rm(this.lockPath, { force: true });
    } catch {}
  }
}

export class NativeServiceClient {
  /** @param {net.Socket} socket @param {number} timeoutMs */
  constructor(socket, timeoutMs) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.decoder = new NativeFrameDecoder();
    /** @type {Map<string, { type: string, resolve: (value: any) => void, reject: (error: Error) => void, timer: NodeJS.Timeout }>} */
    this.pending = new Map();
    /** @type {Map<string, Set<(message: any) => void>>} */
    this.listeners = new Map();
    socket.on("data", (bytes) => this.#receive(bytes));
    socket.on("error", (error) => this.#close(error));
    socket.on("close", () => this.#close(new AgoraError("native service connection closed")));
  }

  /** @param {{ host: string, port: number, nonce: string, timeoutMs?: number }} endpoint */
  static async connect(endpoint) {
    if (!Number.isSafeInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) throw new AgoraError("native service endpoint has an invalid port");
    const socket = net.createConnection({ host: endpoint.host, port: endpoint.port });
    await Promise.race([
      once(socket, "connect"),
      once(socket, "error").then(([error]) => Promise.reject(error)),
    ]);
    const client = new NativeServiceClient(socket, endpoint.timeoutMs ?? REQUEST_TIMEOUT_MS);
    await client.request("hello", { nonce: endpoint.nonce });
    return client;
  }

  /** @param {string} type @param {Record<string, unknown>} [fields] */
  request(type, fields = {}) {
    if (this.socket.destroyed) return Promise.reject(new AgoraError("native service is dark; request was not sent"));
    const requestId = randomUUID().replaceAll("-", "");
    const frame = { ...fields, protocol: NATIVE_PROTOCOL, type, requestId };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new AgoraError(type === "append" ? `native append ${requestId} timed out with unknown acceptance`
          : `native service request ${requestId} timed out`));
      }, this.timeoutMs);
      this.pending.set(requestId, { type, resolve, reject, timer });
      if (!sendFrame(this.socket, frame)) {
        clearTimeout(timer); this.pending.delete(requestId);
        reject(new AgoraError("native service is dark; request was not sent"));
      }
    });
  }

  /** @param {string} roomId @param {string} since @param {(message: any) => void} listener */
  async subscribe(roomId, since, listener) {
    const listeners = this.listeners.get(roomId) ?? new Set();
    listeners.add(listener); this.listeners.set(roomId, listeners);
    try { return await this.request("subscribe", { roomId, since }); }
    catch (e) { listeners.delete(listener); throw e; }
  }

  /** @param {Uint8Array} bytes */
  #receive(bytes) {
    let frames;
    try { frames = this.decoder.push(bytes); }
    catch (error) { this.socket.destroy(error instanceof Error ? error : undefined); return; }
    for (const value of frames) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const frame = /** @type {Record<string, any>} */ (value);
      if (frame.type === "event") {
        for (const listener of this.listeners.get(frame.roomId) ?? []) listener(frame.message);
        continue;
      }
      const pending = typeof frame.requestId === "string" ? this.pending.get(frame.requestId) : undefined;
      if (!pending) continue;
      clearTimeout(pending.timer); this.pending.delete(frame.requestId);
      if (frame.type === "error") pending.reject(new AgoraError(`${frame.reason ?? "request-refused"}: ${frame.message ?? "native service refused the request"}`));
      else pending.resolve(frame);
    }
  }

  /** @param {Error} error */
  #close(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(pending.type === "append" ? new AgoraError("native service connection closed with unknown append acceptance") : error);
    }
    this.pending.clear();
  }

  close() { this.socket.destroy(); }
}
