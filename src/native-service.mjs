// @ts-check
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { AgoraError } from "./core.mjs";
import { NativeFrameDecoder, NATIVE_PROTOCOL, encodeNativeFrame, nativeHandshakeProof, parseNativeCursor,
  validateNativeEnvelope, validateNativeId, verifyNativeHandshakeProof } from "./native-protocol.mjs";
import { NativeRoomStore } from "./native-store.mjs";

const MAX_PENDING_WRITE = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const ENDPOINT_PROBE_TIMEOUT_MS = 500;

/** @param {string} endpoint */
function reclaimArbiterPort(endpoint) {
  return 49152 + createHash("sha256").update(endpoint).digest().readUInt16BE(0) % 16384;
}

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

/**
 * The filesystem path is itself the exclusion primitive on POSIX. Windows
 * named pipes do not live in the filesystem, so their stable name is derived
 * from the physical state root plus the seat account rather than caller path
 * spelling.
 * @param {string} root @param {string} accountId @param {NodeJS.Platform} [platform]
 */
export async function nativeServiceEndpoint(root, accountId, platform = process.platform) {
  validateNativeId(accountId, "service account id");
  await mkdir(path.resolve(root), { recursive: true, mode: 0o700 });
  const physicalRoot = await realpath(path.resolve(root));
  if (platform === "win32") {
    const seat = createHash("sha256").update(`${physicalRoot.toLowerCase()}\0${accountId}`).digest("hex").slice(0, 32);
    return `\\\\.\\pipe\\agora-${seat}`;
  }
  const nativeDirectory = path.join(physicalRoot, "native");
  await mkdir(nativeDirectory, { recursive: true, mode: 0o700 });
  return path.join(nativeDirectory, "service.sock");
}

/** @param {net.Server} server @param {string} endpoint */
function listenOnce(server, endpoint) {
  return new Promise((resolve, reject) => {
    const onError = (/** @type {Error} */ error) => { cleanup(); reject(error); };
    const onListening = () => { cleanup(); resolve(undefined); };
    const cleanup = () => { server.off("error", onError); server.off("listening", onListening); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ path: endpoint, exclusive: true });
  });
}

/** @param {string} endpoint */
function endpointAcceptsConnections(endpoint) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: endpoint });
    const timer = setTimeout(() => finish(true), ENDPOINT_PROBE_TIMEOUT_MS);
    timer.unref?.();
    const finish = (/** @type {boolean} */ live, /** @type {unknown} */ error = undefined) => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      if (error) reject(error); else resolve(live);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", (error) => {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      if (["ECONNREFUSED", "ENOENT", "ENOTSOCK", "EINVAL"].includes(code ?? "")) finish(false);
      else finish(false, error);
    });
  });
}

/**
 * Abrupt death leaves a Unix socket pathname behind. Reclaim moves the exact
 * stale directory entry aside before binding; it never unlinks a path that a
 * racing successor may already have rebound.
 * @param {net.Server} server @param {string} endpoint
 */
async function listenOwnedEndpoint(server, endpoint) {
  try { await listenOnce(server, endpoint); return; }
  catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EADDRINUSE") throw error;
  }
  if (await endpointAcceptsConnections(endpoint)) {
    throw new AgoraError(`native service endpoint ${endpoint} is already active or occupied`);
  }
  if (process.platform === "win32") {
    throw new AgoraError(`native service endpoint ${endpoint} is occupied but not accepting connections`);
  }
  // Probing and moving a stale Unix socket are two operations. Serialize that
  // tiny recovery window with a kernel-owned loopback bind so two starters
  // cannot each move the other's newly-bound endpoint. The arbiter is released
  // as soon as the Unix socket is bound; the socket bind is the resident lock.
  const arbiter = net.createServer();
  try {
    try { await new Promise((resolve, reject) => {
      const cleanup = () => { arbiter.off("error", onError); arbiter.off("listening", onListening); };
      const onError = (/** @type {Error} */ error) => { cleanup(); reject(error); };
      const onListening = () => { cleanup(); resolve(undefined); };
      arbiter.once("error", onError); arbiter.once("listening", onListening);
      arbiter.listen({ host: "127.0.0.1", port: reclaimArbiterPort(endpoint), exclusive: true });
    }); }
    catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === "EADDRINUSE")
        throw new AgoraError(`native service endpoint ${endpoint} reclamation is already in progress or its arbiter is occupied`);
      throw error;
    }
    if (await endpointAcceptsConnections(endpoint))
      throw new AgoraError(`native service endpoint ${endpoint} became active during reclamation`);
    const quarantine = `${endpoint}.stale-${process.pid}-${randomUUID()}`;
    try {
      try { await rename(endpoint, quarantine); }
      catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") throw error;
      }
      try { await listenOnce(server, endpoint); }
      catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code === "EADDRINUSE")
          throw new AgoraError(`native service endpoint ${endpoint} was taken by another starter`);
        throw error;
      }
    } finally { await rm(quarantine, { force: true }); }
  } finally {
    await new Promise((resolve) => {
      if (!arbiter.listening) resolve(undefined);
      else arbiter.close(() => resolve(undefined));
    });
  }
}

/** @param {net.Socket} socket @param {number} timeoutMs @param {string} label */
function readHandshakeFrame(socket, timeoutMs, label) {
  const decoder = new NativeFrameDecoder();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(undefined, new AgoraError(`native service ${label} timed out`)), timeoutMs);
    timer.unref?.();
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData); socket.off("error", onError); socket.off("close", onClose);
    };
    const finish = (/** @type {Record<string, unknown> | undefined} */ frame, /** @type {unknown} */ error = undefined) => {
      cleanup();
      if (error) reject(error); else resolve(frame);
    };
    const onData = (/** @type {Buffer} */ bytes) => {
      try {
        const frames = decoder.push(bytes);
        if (!frames.length) return;
        if (frames.length !== 1) throw new AgoraError(`native service ${label} sent extra handshake frames`);
        finish(validateNativeEnvelope(frames[0]));
      } catch (error) { finish(undefined, error); }
    };
    const onError = (/** @type {Error} */ error) => finish(undefined, error);
    const onClose = () => finish(undefined, new AgoraError(`native service closed during ${label}`));
    socket.on("data", onData); socket.once("error", onError); socket.once("close", onClose);
  });
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
    this.descriptorPath = path.join(this.nativeDirectory, "service.json");
    /** @type {string | null} */
    this.endpointPath = null;
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
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    this.root = await realpath(this.root);
    this.nativeDirectory = path.join(this.root, "native");
    this.descriptorPath = path.join(this.nativeDirectory, "service.json");
    await mkdir(this.nativeDirectory, { recursive: true, mode: 0o700 });
    this.endpointPath = await nativeServiceEndpoint(this.root, this.accountId);
    try {
      this.server = net.createServer((socket) => this.#accept(socket));
      this.server.maxConnections = 128;
      await listenOwnedEndpoint(this.server, this.endpointPath);
      await writeAtomic(this.descriptorPath, this.descriptor());
      this.running = true;
      return this.descriptor();
    } catch (e) {
      await this.#releaseFiles();
      throw e;
    }
  }

  descriptor() {
    return { protocol: NATIVE_PROTOCOL, path: this.endpointPath,
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
    const requestId = randomUUID().replaceAll("-", "");
    const serverChallenge = randomUUID().replaceAll("-", "");
    const serverTranscript = { bootEpoch: this.bootEpoch, requestId, serverChallenge,
      accountId: this.accountId, seatLabel: this.seatLabel };
    if (!sendFrame(socket, { protocol: NATIVE_PROTOCOL, type: "server-hello", ...serverTranscript,
      proof: nativeHandshakeProof(this.nonce, "server", serverTranscript) })) return;
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
            if (frame.type !== "client-hello" || frame.requestId !== requestId || frame.bootEpoch !== this.bootEpoch
              || frame.serverChallenge !== serverChallenge) throw new AgoraError("native service client hello did not match this handshake");
            const clientChallenge = requiredString(frame.clientChallenge, "client challenge");
            validateNativeId(clientChallenge, "client challenge");
            const transcript = { ...serverTranscript, clientChallenge };
            if (!verifyNativeHandshakeProof(frame.proof, this.nonce, "client", transcript))
              throw new AgoraError("native service client did not prove the transcript");
            greeted = true;
            sendFrame(socket, { protocol: NATIVE_PROTOCOL, type: "welcome", ...transcript,
              proof: nativeHandshakeProof(this.nonce, "welcome", transcript) });
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
    if (!this.server) return;
    this.running = false;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear(); this.subscriptions.clear();
    for (const store of this.rooms.values()) await store.close();
    this.rooms.clear();
    await this.#releaseFiles();
  }

  async #releaseFiles() {
    try {
      const descriptor = JSON.parse(await readFile(this.descriptorPath, "utf8"));
      if (descriptor.nonce === this.nonce && descriptor.bootEpoch === this.bootEpoch) await rm(this.descriptorPath, { force: true });
    } catch {}
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise((resolve) => {
      if (!server.listening) resolve(undefined);
      else server.close(() => resolve(undefined));
    });
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

  /** @param {{ path: string, nonce: string, bootEpoch: string, accountId: string, seatLabel: string, timeoutMs?: number }} endpoint */
  static async connect(endpoint) {
    if (typeof endpoint.path !== "string" || !endpoint.path) throw new AgoraError("native service descriptor has no endpoint path");
    validateNativeId(endpoint.nonce, "service secret");
    validateNativeId(endpoint.bootEpoch, "service boot epoch");
    validateNativeId(endpoint.accountId, "service account id");
    if (typeof endpoint.seatLabel !== "string" || !endpoint.seatLabel.trim() || endpoint.seatLabel.length > 120)
      throw new AgoraError("native service descriptor has no bounded seat label");
    const timeoutMs = endpoint.timeoutMs ?? REQUEST_TIMEOUT_MS;
    const socket = net.createConnection({ path: endpoint.path });
    try {
      await Promise.race([
        once(socket, "connect"),
        once(socket, "error").then(([error]) => Promise.reject(error)),
      ]);
      const hello = /** @type {Record<string, any>} */ (await readHandshakeFrame(socket, timeoutMs, "server proof"));
      if (hello.type !== "server-hello" || hello.bootEpoch !== endpoint.bootEpoch
        || hello.accountId !== endpoint.accountId || hello.seatLabel !== endpoint.seatLabel)
        throw new AgoraError("native service server proof did not match the descriptor");
      const requestId = requiredString(hello.requestId, "handshake request id");
      const serverChallenge = requiredString(hello.serverChallenge, "server challenge");
      validateNativeId(serverChallenge, "server challenge");
      const serverTranscript = { bootEpoch: endpoint.bootEpoch, requestId, serverChallenge,
        accountId: endpoint.accountId, seatLabel: endpoint.seatLabel };
      if (!verifyNativeHandshakeProof(hello.proof, endpoint.nonce, "server", serverTranscript))
        throw new AgoraError("native service server proof was invalid");
      const clientChallenge = randomUUID().replaceAll("-", "");
      const transcript = { ...serverTranscript, clientChallenge };
      if (!sendFrame(socket, { protocol: NATIVE_PROTOCOL, type: "client-hello", ...transcript,
        proof: nativeHandshakeProof(endpoint.nonce, "client", transcript) }))
        throw new AgoraError("native service closed before client authentication");
      const welcome = /** @type {Record<string, any>} */ (await readHandshakeFrame(socket, timeoutMs, "welcome proof"));
      if (welcome.type !== "welcome" || welcome.requestId !== requestId || welcome.bootEpoch !== endpoint.bootEpoch
        || welcome.serverChallenge !== serverChallenge || welcome.clientChallenge !== clientChallenge
        || welcome.accountId !== endpoint.accountId || welcome.seatLabel !== endpoint.seatLabel
        || !verifyNativeHandshakeProof(welcome.proof, endpoint.nonce, "welcome", transcript))
        throw new AgoraError("native service welcome did not prove the fresh transcript");
      return new NativeServiceClient(socket, timeoutMs);
    } catch (error) {
      socket.destroy();
      throw error;
    }
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
