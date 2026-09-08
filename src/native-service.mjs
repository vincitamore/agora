// @ts-check
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, link, lstat, mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { AgoraError } from "./core.mjs";
import { NativeFrameDecoder, NATIVE_FRAME_MAX, NATIVE_PROTOCOL, encodeNativeFrame, nativeFramePayloadBytes,
  nativeHandshakeProof, parseNativeCursor,
  validateNativeEnvelope, validateNativeId, verifyNativeHandshakeProof } from "./native-protocol.mjs";
import { NativeRoomStore } from "./native-store.mjs";
import { MEMBER_PHASES, buildRouteBinding, buildRouteDescriptor, memberHandshakeProof, memberMayRequest,
  memberTranscript, mintRouteSecret, removeRouteSecret, routeKey, validatePublicNodeKey,
  verifyMemberHandshakeProof, writeRouteSecret } from "./native-member.mjs";
import { publicNodeKeyDigest } from "./protocol/route.mjs";
import { localTransferIdentity } from "./tailcat.mjs";
import { AuthorityError, readAuthorityRecord, createAuthorityChallenge, verifyAuthorityProof,
  validateAuthorityChallenge, validateAuthorityRequest } from "./authority.mjs";
import { AuthorityJournal } from "./authority-journal.mjs";
import { startMemberRoute } from "./tailcat-routes.mjs";
import { parseSpawnRequest } from "./spawn/request.mjs";
import { ensurePaneAuthority, mintSpawnId, openPane, reapPane } from "./spawn-pane.mjs";

/** A refusal carries one stable code inward and one editable message outward. Keeping the
 * code beside the error at the mint prevents a later wire encoder from recovering control flow
 * from prose. @param {string} code @param {string} detail */
function codedRefusal(code, detail) {
  return Object.assign(new AgoraError(`${code}: ${detail}`), { code });
}

const MAX_PENDING_WRITE = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const ENDPOINT_PROBE_TIMEOUT_MS = 500;

/** Reserve before any effect await, releasing only the reservation this call took.
 * This component grants no authority: the service invokes it only after proof admission.
 * @template T
 * @param {{routes: Map<string, any>, openingRoutes: Set<string>}} registry
 * @param {string} roomId @param {string} key @param {() => Promise<T>} effect */
export async function withRouteReservation(registry, roomId, key, effect) {
  const held = registry.routes.get(key);
  if (held || registry.openingRoutes.has(key)) {
    const state = held ? (held.state === 'closing' ? 'closing' : 'live') : 'opening';
    const error = new AuthorityError('route-already-open');
    error.message = state === 'live'
      ? `route-already-open: ${roomId} already admits this key; close it before opening a new grant`
      : `route-already-open: ${roomId} already admits this key and that route is ${state}; wait for it to settle before opening a new grant`;
    throw error;
  }
  registry.openingRoutes.add(key);
  try { return await effect(); }
  finally { registry.openingRoutes.delete(key); }
}

const RECLAIM_AUTHORITY_FILE = "reclaim-authority.sqlite";
const SEAT_IDENTITY_FILE = "seat-id";
const MAX_PORTABLE_UNIX_SOCKET_PATH_BYTES = 103;

/** @param {string} directory @param {string} label */
async function ensurePrivateStateDirectory(directory, label) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return;
  const before = await stat(directory);
  if (!before.isDirectory()) throw new AgoraError(`native ${label} is not a directory: ${directory}`);
  const uid = process.getuid?.();
  if (uid !== undefined && before.uid !== uid)
    throw new AgoraError(`native ${label} is not owned by this OS user: ${directory}`);
  if ((before.mode & 0o077) !== 0) await chmod(directory, 0o700);
  const after = await stat(directory);
  if ((after.mode & 0o077) !== 0)
    throw new AgoraError(`native ${label} must deny group and other access: chmod 700 ${JSON.stringify(directory)}`);
}

/** @param {string} directory @param {string} label */
async function ensurePrivateRuntimeDirectory(directory, label) {
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST") throw error;
  }
  const before = await lstat(directory, { bigint: true });
  const uid = process.getuid?.();
  if (!before.isDirectory() || before.isSymbolicLink())
    throw new AgoraError(`native ${label} must be a real directory, not a symlink: ${directory}`);
  if (uid === undefined || before.uid !== BigInt(uid))
    throw new AgoraError(`native ${label} is not owned by this OS user: ${directory}`);
  if ((before.mode & 0o77n) !== 0n) await chmod(directory, 0o700);
  const after = await lstat(directory, { bigint: true });
  if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino)
    throw new AgoraError(`native ${label} changed identity while its permissions were checked: ${directory}`);
  if (after.uid !== BigInt(uid) || (after.mode & 0o77n) !== 0n)
    throw new AgoraError(`native ${label} must be owned by this OS user and deny group and other access: ${directory}`);
}

/** @param {string} directory */
async function ensureProtectedRuntimeBase(directory) {
  const info = await stat(directory, { bigint: true });
  const uid = process.getuid?.();
  const sticky = (info.mode & 0o1000n) !== 0n;
  const privatelyOwned = uid !== undefined && info.uid === BigInt(uid) && (info.mode & 0o77n) === 0n;
  if (!info.isDirectory() || (!sticky && !privatelyOwned))
    throw new AgoraError(`native POSIX runtime base must be sticky or private to this OS user: ${directory}`);
}

/** @param {string} nativeDirectory */
async function readOrCreateSeatIdentity(nativeDirectory) {
  const file = path.join(nativeDirectory, SEAT_IDENTITY_FILE);
  const identity = randomUUID().replaceAll("-", "");
  const candidate = `${file}.tmp-${process.pid}-${identity}`;
  const created = await open(candidate, "wx", 0o600);
  try { await created.writeFile(`${identity}\n`, "utf8"); await created.sync(); }
  finally { await created.close(); }
  let published = false;
  try {
    await link(candidate, file);
    published = true;
    const directory = await open(nativeDirectory, "r");
    try { await directory.sync(); }
    finally { await directory.close(); }
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST") throw error;
  } finally {
    await rm(candidate, { force: true });
  }
  if (published) return identity;
  const before = await lstat(file, { bigint: true });
  const uid = process.getuid?.();
  if (!before.isFile() || before.isSymbolicLink() || uid === undefined || before.uid !== BigInt(uid))
    throw new AgoraError(`native seat identity must be a regular file owned by this OS user: ${file}`);
  if ((before.mode & 0o177n) !== 0n) await chmod(file, 0o600);
  const after = await lstat(file, { bigint: true });
  if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino
    || after.uid !== BigInt(uid) || (after.mode & 0o177n) !== 0n)
    throw new AgoraError(`native seat identity changed while it was verified: ${file}`);
  const existingIdentity = (await readFile(file, "utf8")).trim();
  if (!/^[a-f0-9]{32}$/.test(existingIdentity))
    throw new AgoraError(`native seat identity is invalid; stop every Agora process using this state root, remove ${file}, then start again`);
  return existingIdentity;
}

/** @param {string} endpoint @param {string} file */
function unusableReclaimAuthority(endpoint, file) {
  return new AgoraError(`native service endpoint ${endpoint} reclamation authority ${file} is unusable; stop every Agora process using this state root, remove that file, then start again`);
}

/**
 * SQLite is the one zero-dependency cross-process authority available in both
 * supported runtimes. Its OS lock is released on process death; placing the
 * database beside the socket in its state-root-derived 0700 runtime directory
 * keeps the authority at the same principal boundary as the endpoint.
 * @param {string} endpoint
 */
async function acquireReclaimAuthority(endpoint) {
  const moduleName = typeof process.versions.bun === "string" ? "bun:sqlite" : "node:sqlite";
  let sqlite;
  try { sqlite = await import(moduleName); }
  catch {
    throw new AgoraError("native service stale-endpoint recovery needs Node 22.13 or later, or Bun with SQLite support");
  }
  const Database = sqlite.DatabaseSync ?? sqlite.Database;
  if (typeof Database !== "function") throw new AgoraError("native service runtime has no supported SQLite API");
  const file = path.join(path.dirname(endpoint), RECLAIM_AUTHORITY_FILE);
  /** @type {{ exec: (sql: string) => unknown, close: () => void }} */
  let database;
  try { database = new Database(file); }
  catch { throw unusableReclaimAuthority(endpoint, file); }
  let held = false;
  try {
    database.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
    held = true;
    await chmod(file, 0o600);
  } catch (error) {
    try { database.close(); } catch {}
    const sqliteError = /** @type {Error & { code?: string, errno?: number, errcode?: number }} */ (error);
    if (sqliteError.code === "SQLITE_BUSY" || sqliteError.errno === 5 || sqliteError.errcode === 5
      || /database is locked/i.test(sqliteError.message)) {
      throw new AgoraError(`native service endpoint ${endpoint} reclamation authority is already held`);
    }
    throw unusableReclaimAuthority(endpoint, file);
  }
  return {
    file,
    release() {
      if (!held) return;
      held = false;
      try { database.exec("ROLLBACK"); }
      finally { database.close(); }
    },
  };
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

/** Duck-typed on purpose: a member route hands over a Duplex over the Tailcat child's stdio, and
 * every property this uses (destroyed, writable, writableLength, write, destroy) is on both.
 * @param {net.Socket | import("node:stream").Duplex} socket @param {unknown} value */
function sendFrame(socket, value) {
  const frame = encodeNativeFrame(value);
  if (socket.destroyed || !socket.writable || socket.writableLength + frame.length > MAX_PENDING_WRITE) {
    socket.destroy(new AgoraError("native service client is dark or its pending output exceeded the bound"));
    return false;
  }
  socket.write(frame);
  return true;
}

/**
 * The largest number of leading messages whose result frame still fits one native protocol frame.
 *
 * A batch is not a frame. The 1 MiB bound belongs to the wire's length prefix, so "how many rows
 * fit" is a question about the encoded envelope and not about the rows: the envelope's own fields
 * and JSON escaping mean a row's cost is not the sum of its parts, and an accumulating byte count
 * is wrong in the direction that matters. Binary search over the real measurement instead --
 * log2(n) encodings of a result the host was going to encode anyway.
 *
 * Returns 0 when not even the first message fits, which is a different failure and is named as one.
 * @param {(count: number) => unknown} envelope @param {number} total
 */
function largestFittingCount(envelope, total) {
  let low = 0;
  let high = total;
  while (low < high) {
    const middle = low + Math.ceil((high - low) / 2);
    if (nativeFramePayloadBytes(envelope(middle)) <= NATIVE_FRAME_MAX) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** @param {unknown} value @param {string} label */
function requiredString(value, label) {
  if (typeof value !== "string" || !value) throw new AgoraError(`native ${label} is required`);
  return value;
}

/**
 * The filesystem path is itself the exclusion primitive on POSIX. Windows
 * named pipes do not live in the filesystem, so their stable name is derived
 * from the physical state root rather than caller path spelling. The service
 * is seat-global: account identity belongs in its authenticated descriptor,
 * not in the exclusion endpoint, or two accounts can own one root at once.
 * @param {string} root @param {string} accountId @param {NodeJS.Platform} [platform] @param {string} [posixRuntimeBase]
  * @param {string} [name] the endpoint's own name under the seat's runtime directory. Defaults to
 *   `service`, which is byte-identical to what this helper has always returned; a resident MEMBER
 *   client passes its own name so it binds a sibling endpoint under the same private, length-bounded
 *   runtime path rather than duplicating these ownership and sun_path checks somewhere else.
 */
export async function nativeServiceEndpoint(root, accountId, platform = process.platform, posixRuntimeBase = "/tmp", name = "service") {
  validateNativeId(accountId, "service account id");
  await ensurePrivateStateDirectory(path.resolve(root), "state root");
  const physicalRoot = await realpath(path.resolve(root));
  await ensurePrivateStateDirectory(physicalRoot, "state root");
  if (platform === "win32") {
    const seat = createHash("sha256").update(physicalRoot.toLowerCase()).digest("hex").slice(0, 32);
    return name === "service" ? `\\\\.\\pipe\\agora-${seat}` : `\\\\.\\pipe\\agora-${seat}-${name}`;
  }
  const nativeDirectory = path.join(physicalRoot, "native");
  await ensurePrivateStateDirectory(nativeDirectory, "state directory");
  const uid = process.getuid?.();
  if (!Number.isSafeInteger(uid) || Number(uid) < 0) throw new AgoraError("native service cannot determine this POSIX user's uid");
  // Darwin's sockaddr_un.sun_path is only 104 bytes including the terminator.
  // State roots routinely exceed that under /private/var/folders, so bind at a
  // short owner-only runtime path keyed by an Agora-minted identity inside the
  // physical state root. Names and inode numbers can both change or be reused;
  // the protected marker survives aliases and renames but not root recreation.
  await ensureProtectedRuntimeBase(posixRuntimeBase);
  const runtimeRoot = path.join(posixRuntimeBase, `agora-${uid}`);
  await ensurePrivateRuntimeDirectory(runtimeRoot, "runtime root");
  const rootIdentity = await readOrCreateSeatIdentity(nativeDirectory);
  const seat = createHash("sha256").update(rootIdentity).digest("hex").slice(0, 32);
  const runtimeDirectory = path.join(runtimeRoot, seat);
  await ensurePrivateRuntimeDirectory(runtimeDirectory, "runtime directory");
  const endpoint = path.join(runtimeDirectory, `${name}.sock`);
  if (Buffer.byteLength(endpoint, "utf8") > MAX_PORTABLE_UNIX_SOCKET_PATH_BYTES)
    throw new AgoraError(`native service endpoint exceeds the portable Unix-socket path bound: ${endpoint}`);
  return endpoint;
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
  // Probing and moving a stale Unix socket are two operations. Serialize the
  // whole second-probe -> quarantine -> bind window with a crash-releasing
  // SQLite transaction under the same 0700 runtime directory as the endpoint. A TCP
  // port is not equivalent: any local principal can bind it and the OS may
  // allocate it for an unrelated outbound connection.
  const authority = await acquireReclaimAuthority(endpoint);
  try {
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
  } finally { authority.release(); }
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
  /** @param {{ root: string, accountId: string, seatLabel: string, now?: () => Date, nonce?: string, build?: import("./harness.mjs").BuildIdentity, routeOptions?: Record<string, unknown>, authorityId?: string, readLocalIdentity?: (root: string) => Promise<{nodeKey: string}> }} options */
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
    /** @type {import("./harness.mjs").BuildIdentity | undefined} */
    this.build = options.build;
    // Route transport options every wire-path `route-open` uses when the frame carries none (a
    // frame never carries them). Tests inject a faked listener and child here so the verbs can be
    // driven through a real client against a live service; production leaves it undefined.
    this.routeOptions = options.routeOptions;
    this.authorityId = options.authorityId;
    this.readLocalIdentity = options.readLocalIdentity ?? ((root) => localTransferIdentity(root, { create: false }));
    /** @type {Awaited<ReturnType<typeof readAuthorityRecord>> | undefined} */ this.authority = undefined;
    /** @type {AuthorityJournal | undefined} */ this.authorityJournal = undefined;
    /** @type {string | undefined} */ this.localNodeKeyDigest = undefined;
    /** @type {Map<string, {request: ReturnType<typeof import('./authority.mjs').validateAuthorityRequest>, challenge: ReturnType<typeof createAuthorityChallenge>}>} */
    this.routeChallenges = new Map();
    /** @type {Map<string, Promise<unknown>>} */ this.admissions = new Map();
    /** Failed opens with unconfirmed resource cleanup remain owned until service drain.
     * @type {Map<string, {stop: () => Promise<unknown>}>} */ this.failedAdmissions = new Map();
    this.draining = false;
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
    /** @type {Set<Promise<unknown>>} */
    this.roomActivities = new Set();
    /** @type {Set<net.Socket>} */
    this.sockets = new Set();
    /** A member route's stream subscribes like any other client, so this is keyed on both
     * shapes; #broadcast writes through sendFrame, which is duck-typed for the same reason.
     * @type {Map<net.Socket | import("node:stream").Duplex, Map<string, number>>} */
    this.subscriptions = new Map();
    /** @type {number | undefined} */
    this.panePid = undefined;
    /** Admitted member routes, keyed roomId:allowedKeyDigest. The value owns the Tailcat
     * resource handle; a route is never identified by a stored pid.
     * @type {Map<string, { binding: any, secret: string, proofRef: string, descriptor: any, resource: any, descriptorPath: string, secretPath: string, state: 'live' | 'closing', openedAt: string, activation: {active: boolean} }>} */
    this.routes = new Map();
    /** Keys whose open is in flight. Held from the check until the entry is registered, so two
     * concurrent opens for one key cannot both pass.
     * @type {Set<string>} */
    this.openingRoutes = new Set();
    /** Fences every route resource to this service's own lifetime.
     * @type {AbortController | undefined} */
    this.routeOwner = undefined;
    this.running = false;
  }

  async start() {
    if (this.running) return this.descriptor();
    await ensurePrivateStateDirectory(this.root, "state root");
    this.root = await realpath(this.root);
    await ensurePrivateStateDirectory(this.root, "state root");
    this.nativeDirectory = path.join(this.root, "native");
    this.descriptorPath = path.join(this.nativeDirectory, "service.json");
    await ensurePrivateStateDirectory(this.nativeDirectory, "state directory");
    // Startup snapshot is a cooperative replacement-window bound, not a trust anchor.
    // There is deliberately no authority lookup or identity mint on a request path.
    if (this.authorityId) {
      this.authority = await readAuthorityRecord(this.root, this.authorityId);
      this.localNodeKeyDigest = publicNodeKeyDigest((await this.readLocalIdentity(this.root)).nodeKey);
      if (this.authority.boundNodeKeyDigest === this.localNodeKeyDigest)
        throw new AuthorityError('authority-self-refused');
      this.authorityJournal = await AuthorityJournal.load(this.root, this.accountId);
    }
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
      await this.authorityJournal?.close();
      throw e;
    }
  }

  descriptor() {
    return { protocol: NATIVE_PROTOCOL, path: this.endpointPath,
      nonce: this.nonce, pid: process.pid, bootEpoch: this.bootEpoch, accountId: this.accountId, seatLabel: this.seatLabel,
      startedAt: this.startedAt, ...(this.build ? { build: this.build } : {}) };
  }

  /** @param {{ roomId?: string, epoch?: string }} [options] */
  async createRoom(options = {}) {
    if (!this.running) throw new AgoraError("native service is dark; start it explicitly before creating a room");
    if (options.roomId && (this.rooms.has(options.roomId) || this.roomOpenings.has(options.roomId)))
      throw new AgoraError(`native room ${options.roomId} is already open on this service`);
    const activity = (async () => {
      const store = await NativeRoomStore.create({ root: this.root, roomId: options.roomId, epoch: options.epoch,
        hostAccountId: this.accountId, now: this.now });
      if (!this.running) {
        await store.close();
        throw new AgoraError("native service stopped while creating the room; the room was not opened by this service");
      }
      this.rooms.set(store.manifest.roomId, store);
      return store.status();
    })();
    return await this.#trackRoomActivity(activity);
  }

  /** @param {string} roomId */
  async openRoom(roomId) {
    if (!this.running) throw new AgoraError("native service is dark; start it explicitly before opening a room");
    const existing = this.rooms.get(roomId);
    if (existing) return existing;
    let opening = this.roomOpenings.get(roomId);
    if (!opening) {
      opening = this.#trackRoomActivity((async () => {
        const store = await NativeRoomStore.open({ root: this.root, roomId, now: this.now });
        if (!this.running) {
          await store.close();
          throw new AgoraError("native service stopped while opening the room; the room was not retained");
        }
        this.rooms.set(roomId, store);
        return store;
      })());
      this.roomOpenings.set(roomId, opening);
    }
    try {
      return await opening;
    } finally {
      if (this.roomOpenings.get(roomId) === opening) this.roomOpenings.delete(roomId);
    }
  }

  /** @template T @param {Promise<T>} activity @returns {Promise<T>} */
  #trackRoomActivity(activity) {
    this.roomActivities.add(activity);
    activity.then(() => this.roomActivities.delete(activity), () => this.roomActivities.delete(activity));
    return activity;
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
  /** @param {net.Socket | import("node:stream").Duplex} socket @param {any} frame
   * @param {{ binding: any } | undefined} [member] the admitted member route, when this stream is one */
  async #dispatch(socket, frame, member) {
    if (member) {
      // Board operations admitted through this protocol under the remote principal are allowed;
      // direct store or control access is not, so create-room and spawn are absent from the list.
      if (!memberMayRequest(frame.type))
        throw codedRefusal("member-request-refused", `a member session may not request ${JSON.stringify(frame.type)}`);
      // Authorship is by BINDING, never by frame. validateNativeEnvelope admits arbitrary keys, so
      // an identity claim can ride any frame; it is refused by name here rather than silently
      // overwritten downstream, which would leave the guard with nothing observable to fire on.
      const claims = [frame.accountId, frame.authorId,
        /** @type {any} */ (frame.operation)?.accountId, /** @type {any} */ (frame.operation)?.authorId];
      for (const claim of claims)
        if (claim !== undefined && claim !== member.binding.accountId)
          throw codedRefusal("member-actor-mismatch", "this route admits one principal and the frame named another");
      // A member session is authorKind agent BY CONSTRUCTION. The board's `break` is a human verb
      // that trusts this label, so a remote claiming human could break a local holder's lease.
      const operation = /** @type {any} */ (frame.operation);
      // This skips arrays, which is safe ONLY because the append handler below rejects a
      // non-object operation outright. If append ever accepts a batch, this guard stops covering
      // it silently -- the member's author kind would go unchecked for every element.
      if (operation && typeof operation === "object" && !Array.isArray(operation)) {
        if (operation.authorKind !== undefined && operation.authorKind !== "agent")
          throw codedRefusal("member-author-kind-refused", `a member session is an agent; it may not claim ${JSON.stringify(operation.authorKind)}`);
        // Absent is set rather than left to a downstream default: the board records an omitted
        // kind as "unknown", and "unknown" is not what a member is.
        if (operation.authorKind === undefined) operation.authorKind = "agent";
      }
    }
    if (frame.type === "create-room") {
      const requested = frame.roomId === undefined || frame.roomId === null || frame.roomId === ""
        ? undefined
        : requiredString(frame.roomId, "room id");
      const status = await this.createRoom(requested ? { roomId: requested } : {});
      sendFrame(socket, {
        protocol: NATIVE_PROTOCOL,
        type: "create-room-result",
        requestId: frame.requestId,
        roomId: status.roomId,
        epoch: status.epoch,
      });
      return;
    }
    if (frame.type === "route-open") {
      const result = await this.openRoute({ roomId: requiredString(frame.roomId, "room id"),
        publicNodeKey: requiredString(frame.publicNodeKey, "member public node key"),
        proof: frame.proof, attributionClaims: frame.attributionClaims });
      sendFrame(socket, { protocol: NATIVE_PROTOCOL, type: "route-open-result", requestId: frame.requestId, ...result });
      return;
    }
    if (frame.type === "route-list") {
      sendFrame(socket, { protocol: NATIVE_PROTOCOL, type: "route-list-result", requestId: frame.requestId,
        routes: this.listRoutes() });
      return;
    }
    if (frame.type === "route-close") {
      const result = await this.closeRoute({ roomId: requiredString(frame.roomId, "room id"),
        publicNodeKey: requiredString(frame.publicNodeKey, "member public node key"),
        proof: frame.proof, attributionClaims: frame.attributionClaims });
      sendFrame(socket, { protocol: NATIVE_PROTOCOL, type: "route-close-result", requestId: frame.requestId, ...result });
      return;
    }
    if (frame.type === 'route-challenge') {
      const result = await this.createRouteChallenge({ action: requiredString(frame.action, 'route action'),
        roomId: requiredString(frame.roomId, 'room id'), publicNodeKey: requiredString(frame.publicNodeKey, 'member public node key') });
      sendFrame(socket, { protocol: NATIVE_PROTOCOL, type: 'route-challenge-result', requestId: frame.requestId, ...result });
      return;
    }
    if (frame.type === 'route-act-status') {
      const { journal } = this.#authorityContext();
      sendFrame(socket, { protocol: NATIVE_PROTOCOL, type: 'route-act-status-result', requestId: frame.requestId,
        status: journal.status(requiredString(frame.operationId, 'operation id')) });
      return;
    }
    if (frame.type === "spawn") {
      const request = parseSpawnRequest(frame.request);
      if (request.harness === "hermes") throw new AgoraError("spawn-unsupported: hermes has no interactive initial-prompt mechanism");
      const pane = await ensurePaneAuthority(this.root);
      if (pane.pid) this.panePid = pane.pid;
      const spawnId = mintSpawnId();
      await openPane(pane.sock, spawnId, this.root);
      sendFrame(socket, {
        protocol: NATIVE_PROTOCOL,
        type: "spawn-result",
        requestId: frame.requestId,
        spawnId,
      });
      return;
    }
    const roomId = requiredString(frame.roomId, "room id");
    if (member && roomId !== member.binding.roomId)
      throw codedRefusal("member-room-refused", "a member session may only reach the room its route binds");
    const store = await this.openRoom(roomId);
    if (frame.type === "status") {
      sendFrame(socket, { protocol: NATIVE_PROTOCOL, type: "status-result", requestId: frame.requestId, status: store.status() });
      return;
    }
    if (frame.type === "read" || frame.type === "subscribe") {
      const since = frame.since === undefined ? undefined : requiredString(frame.since, "cursor");
      const limit = frame.limit === undefined ? undefined : Number(frame.limit);
      if (frame.type === "read") {
        const messages = store.read({ ...(since ? { since } : {}), ...(limit !== undefined ? { limit } : {}) });
        // The page must be the END the STORE would select, or the limit this refusal names is a
        // limit for a different set of messages. `native-store.mjs` slices `-limit` when there is no
        // `since` (the newest N) and forward from the cursor when there is (the oldest N after it).
        // Measured live before this was fixed: with no cursor the host searched the head, named 765,
        // and the caller's `--limit 765` asked for the newest 765 -- different, larger messages, so
        // it refused again naming 761. It converges, so it is not a loop; it is worse than a loop,
        // because the caller did exactly what it was told and was told something false.
        /** @param {number} count */
        const envelope = (count) => {
          const page = count === messages.length ? messages
            : since ? messages.slice(0, count) : messages.slice(-count);
          const sequence = page.length ? parseNativeCursor(page.at(-1).cursor).sequence
            : since ? parseNativeCursor(since).sequence : store.status().committed;
          return { protocol: NATIVE_PROTOCOL, type: "read-result", requestId: frame.requestId,
            roomId, messages: page, checkpoint: store.checkpoint(sequence) };
        };
        const whole = envelope(messages.length);
        const bytes = nativeFramePayloadBytes(whole);
        if (bytes > NATIVE_FRAME_MAX) {
          // Refuse by the CONDITION, never by the frame's byte range. "must be 1-1048576 bytes" is
          // the encoder describing its own length prefix; it tells a caller nothing about what it
          // asked for, names no smaller request that would work, and reads like a corrupt stream
          // rather than an oversized answer. The refusal below is the same event named so the
          // caller can act: what it asked for, what that came to, the bound, and a limit that fits.
          //
          // Deliberately NOT a silent truncation. Returning the prefix that fits with a `truncated`
          // marker would fix `join` today at the cost of a partial read that every existing caller
          // reports as a whole one, since none of them read such a marker -- the exact silent
          // default this house has been bitten by. Paging is the right answer and it is a unit with
          // a client half; this is the floor under it, and it never lies about what it delivered.
          const fits = largestFittingCount(envelope, messages.length);
          if (!fits) {
            // The one message that cannot cross is the one the caller would have received first,
            // which is the same end the page is taken from.
            const first = since ? messages[0] : messages.at(-1);
            throw codedRefusal("read-batch-refused", `message ${first.cursor} alone encodes to `
              + `${nativeFramePayloadBytes(envelope(1))} bytes and one native protocol frame holds `
              + `${NATIVE_FRAME_MAX}; this protocol cannot deliver it (no cursor advanced)`);
          }
          throw codedRefusal("read-batch-refused", `${messages.length} messages encode to ${bytes} bytes and `
            + `one native protocol frame holds ${NATIVE_FRAME_MAX}; re-read with limit ${fits} or fewer `
            + `(no cursor advanced)`);
        }
        sendFrame(socket, whole);
        return;
      }

      if (!since) throw new AgoraError("native subscription needs an explicit cursor");
      const start = parseNativeCursor(since);
      // read() validates the epoch and that the cursor is not beyond the log.
      store.read({ since, limit: 1 });
      const committed = store.status().committed;
      const backlogCount = committed - start.sequence;
      if (backlogCount > 10_000)
        throw new AgoraError(`native subscription backlog has ${backlogCount} records; read forward before subscribing (no cursor advanced)`);
      const backlog = backlogCount ? store.read({ since, limit: backlogCount }) : [];
      // One event frame per message, so the batch bound above does not apply -- but a SINGLE
      // oversized message still cannot cross, and it would surface here as the encoder's byte
      // range with no cursor to identify it. Name it the same way the read path does.
      const replayFrames = backlog.map((message) => {
        const event = { protocol: NATIVE_PROTOCOL, type: "event", requestId: message.id, roomId, message };
        const size = nativeFramePayloadBytes(event);
        if (size > NATIVE_FRAME_MAX)
          throw codedRefusal("read-batch-refused", `message ${message.cursor} alone encodes to ${size} bytes `
            + `and one native protocol frame holds ${NATIVE_FRAME_MAX}; this protocol cannot deliver it `
            + `(no cursor advanced)`);
        return encodeNativeFrame(event);
      });
      const resultFrame = encodeNativeFrame({ protocol: NATIVE_PROTOCOL, type: "subscribe-result",
        requestId: frame.requestId, roomId, messages: [], checkpoint: store.checkpoint(committed) });
      const replayBytes = replayFrames.reduce((sum, encoded) => sum + encoded.length, resultFrame.length);
      if (socket.writableLength + replayBytes > MAX_PENDING_WRITE)
        throw new AgoraError(`native subscription backlog needs ${replayBytes} buffered bytes; read forward before subscribing (no cursor advanced)`);
      for (const encoded of replayFrames) socket.write(encoded);
      this.subscriptions.get(socket)?.set(roomId, committed);
      socket.write(resultFrame);
      return;
    }
    if (frame.type === "append") {
      const operation = frame.operation;
      if (!operation || typeof operation !== "object" || Array.isArray(operation)) throw new AgoraError("native append needs an operation object");
      // The store stamps author.id and derives the message id from this account id, so a member's
      // posts carry its own minted principal rather than the host's.
      const receipt = /** @type {any} */ (await store.append(/** @type {any} */ (operation),
        { accountId: member ? member.binding.accountId : this.accountId }));
      sendFrame(socket, { protocol: NATIVE_PROTOCOL, type: "append-ack", requestId: frame.requestId, roomId, ...receipt });
      if (receipt.kind !== "board") {
        const message = store.read({ since: `${store.manifest.epoch}:${parseNativeCursor(receipt.cursor).sequence - 1}`, limit: 1 })[0];
        if (message) this.#broadcast(roomId, message);
      }
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

  /**
   * Open a member route. The SERVICE process owns it: `startMemberRoute` fences its resources to
   * the owner's AbortSignal and requires the owner's serviceBootId, so a route started by a CLI's
   * own process would die with that process. `route open` is therefore a request to the running
   * service, the way `spawn` is, never a listener the verb starts for itself.
   * The host's own hop for the same requirement the remote client has: `runtime` is the resolver's
   * option surface, with the state root optional because THIS layer fills it in below. Typed rather
   * than narrowed — an in-process caller may still override the root, exactly as the remote room's
   * caller may, and deciding otherwise is a contract change that does not belong in a types head.
   * `routeOptions` stays `any` deliberately and is not widened here — it is a different surface
   * with its own owner, and quietly typing it in a head cut for the runtime would be scope drift
   * wearing a type annotation.
   * @param {{ roomId: string, publicNodeKey: string, proof?: unknown, attributionClaims?: unknown,
   *  runtime?: import("./tailcat-runtime.mjs").TailcatRuntimeOverrides, routeOptions?: any }} request
   */
  async openRoute(request) {
    const retained = { ...request };
    return await this.#admitRoute(retained, 'room-enroll', (binding, operationId) => this.#openApprovedRoute(retained, binding, operationId));
  }

  #authorityContext() {
    if (!this.authority || !this.authorityJournal || !this.localNodeKeyDigest)
      throw new AuthorityError('authority-absent');
    if (!this.running || this.draining) throw new AuthorityError('authority-service-draining');
    return { authority: this.authority, journal: this.authorityJournal, target: this.localNodeKeyDigest };
  }

  /** Issuance has no route effect; context is owned by this service.
   * @param {{action: string, roomId: string, publicNodeKey: string}} input */
  async createRouteChallenge(input) {
    const { authority, journal, target } = this.#authorityContext();
    if (!['room-enroll', 'room-revoke'].includes(input.action)) throw new AuthorityError('operator-action-refused');
    const publicNodeKey = validatePublicNodeKey(input.publicNodeKey);
    const store = await this.openRoom(input.roomId);
    this.#authorityContext();
    journal.assertAvailable(input.roomId);
    const key = routeKey(input.roomId, publicNodeKeyDigest(publicNodeKey));
    const existing = this.routes.get(key);
    if (input.action === 'room-enroll' && (existing || this.openingRoutes.has(key))) {
      const state = existing ? (existing.state === 'closing' ? 'closing' : 'live') : 'opening';
      const error = new AuthorityError('route-already-open');
      error.message = state === 'live'
        ? `route-already-open: ${input.roomId} already admits this key; close it before opening a new grant`
        : `route-already-open: ${input.roomId} already admits this key and that route is ${state}; wait for it to settle before opening a new grant`;
      throw error;
    }
    if (input.action === 'room-revoke' && (!existing || existing.state !== 'live'))
      throw new AuthorityError('route-not-open');
    const now = this.now().toISOString();
    for (const [id, pending] of this.routeChallenges)
      if (Date.parse(pending.challenge.act.expiresAt) <= Date.parse(now)) this.routeChallenges.delete(id);
    if (this.routeChallenges.size >= 1024) throw new AuthorityError('operator-challenge-capacity');
    const binding = input.action === 'room-revoke' && existing ? existing.binding : buildRouteBinding({
      hostAccountId: this.accountId, hostAuthority: this.accountId, roomId: input.roomId,
      roomEpoch: store.manifest.epoch, serviceBootId: this.bootEpoch, publicNodeKey });
    const request = validateAuthorityRequest({ action: input.action, binding, targetNodeKeyDigest: target,
      operationId: randomUUID().replaceAll('-', ''),
      revisions: { policy: authority.policy.revision, membership: journal.revision(input.roomId) } });
    const challenge = createAuthorityChallenge(authority, request, now);
    const retained = { request, challenge };
    this.routeChallenges.set(challenge.act.challengeId, structuredClone(retained));
    return retained;
  }

  /** Serialize the whole admission/effect per room, including different member keys.
   * @template T
   * @param {{roomId: string, publicNodeKey?: string, allowedKeyDigest?: string, proof?: unknown, attributionClaims?: unknown}} input
   * @param {'room-enroll'|'room-revoke'} action
   * @param {(binding: any, operationId: string) => Promise<T>} effect */
  #admitRoute(input, action, effect) {
    const { authority, journal, target } = this.#authorityContext();
    if (input.proof === undefined || input.proof === null) throw new AuthorityError('operator-proof-required');
    const submitted = validateAuthorityChallenge(/** @type {{challenge?: unknown}} */ (input.proof).challenge);
    const pending = this.routeChallenges.get(submitted.act.challengeId);
    if (journal.status(submitted.act.operationId).state !== 'unknown') throw new AuthorityError('operator-act-replayed');
    if (!pending) throw new AuthorityError('operator-challenge-absent');
    const digest = input.allowedKeyDigest ?? publicNodeKeyDigest(validatePublicNodeKey(input.publicNodeKey));
    if (pending.request.binding.roomId !== input.roomId || pending.request.binding.allowedKeyDigest !== digest
      || pending.request.action !== action) throw new AuthorityError('operator-context-refused');
    const roomId = input.roomId;
    const envelope = structuredClone(input.proof), claims = structuredClone(input.attributionClaims);
    const job = (this.admissions.get(roomId) ?? Promise.resolve()).catch(() => {}).then(async () => {
      this.#authorityContext();
      journal.assertAvailable(roomId);
      if (journal.status(submitted.act.operationId).state !== 'unknown') throw new AuthorityError('operator-act-replayed');
      const store = await this.openRoom(roomId);
      const original = pending.request;
      if (original.targetNodeKeyDigest !== target) throw new AuthorityError('operator-target-refused');
      // Authenticate the retained act before naming the live-route conflict. A second valid
      // same-key act has an actionable route conflict as well as a stale room revision.
      verifyAuthorityProof(envelope, authority, pending.challenge, original, this.now().toISOString());
      if (action === 'room-enroll' && this.routes.has(routeKey(roomId, digest)))
        throw new AuthorityError('route-already-open');
      const current = { ...original, targetNodeKeyDigest: target,
        binding: { ...original.binding, host: { ...original.binding.host, id: this.accountId },
          serviceBootId: this.bootEpoch, roomEpoch: store.manifest.epoch },
        revisions: { policy: authority.policy.revision, membership: journal.revision(roomId) } };
      verifyAuthorityProof(envelope, authority, pending.challenge, current, this.now().toISOString());
      if (action === 'room-revoke') {
        const live = this.routes.get(routeKey(roomId, digest));
        if (!live || live.binding.grantId !== original.binding.grantId
          || live.binding.routeGeneration !== original.binding.routeGeneration || live.state !== 'live')
          throw new AuthorityError('operator-context-refused');
      }
      await journal.begin(current, envelope, claims, this.now().toISOString());
      this.routeChallenges.delete(submitted.act.challengeId);
      try { return await effect(current.binding, current.operationId); }
      catch (error) {
        if (!journal.unavailable && !journal.recoveryRooms.has(roomId) && journal.status(current.operationId).state === 'intent')
          await journal.finish(current.operationId, 'failed', this.now().toISOString());
        throw error;
      }
    });
    this.admissions.set(roomId, job);
    void job.finally(() => { if (this.admissions.get(roomId) === job) this.admissions.delete(roomId); }).catch(() => {});
    return job;
  }

  /** @param {Parameters<NativeRoomService['openRoute']>[0]} request @param {any} binding @param {string} operationId */
  async #openApprovedRoute(request, binding, operationId) {
    const journal = /** @type {AuthorityJournal} */ (this.authorityJournal);
    if (!this.running) throw new AgoraError("native service is dark; start it explicitly before opening a route");
    const publicNodeKey = validatePublicNodeKey(request.publicNodeKey);
    const allowedKeyDigest = publicNodeKeyDigest(publicNodeKey);
    const roomId = requiredString(request.roomId, "room id");
    const key = routeKey(roomId, allowedKeyDigest);
    // One live route per key digest: a second grant for a live digest would leave two secrets and
    // two generations for one principal, and `route close` naming the digest would name both.
    //
    // The outer room queue protects admission revisions; this inner synchronous reservation
    // independently protects the effect registry. Keeping it across all effect awaits avoids
    // orphaning a listener if the admission scheduler is ever changed.
    return await withRouteReservation(this, roomId, key, async () => {
    const activation = { active: false };
    const secret = mintRouteSecret();
    const { proofRef, file: secretPath } = await writeRouteSecret(this.root, binding, secret);
    if (!this.routeOwner || this.routeOwner.signal.aborted) this.routeOwner = new AbortController();
    const owner = { serviceId: this.accountId, serviceBootId: this.bootEpoch, signal: this.routeOwner.signal };
    let resource;
    const file = path.join(this.nativeDirectory, 'routes', binding.grantId, 'descriptor.json');
    try {
    resource = startMemberRoute({ binding, allowedNodeKey: publicNodeKey }, {
      owner,
      // The service's state root is REQUIRED, not decorative: resolveTailcatBinary gives every
      // other option a default (platform, arch, vendorDir, override, overrideSha256) and reads
      // `stateRoot` bare into cacheDirectory, whose first line is path.resolve(root). An empty
      // runtime therefore throws a TypeError during Tailcat runtime startup, before any key is
      // used and before any child exists -- which is what a route open reports as a startup
      // refusal. The spread order lets a test override it and cannot drop it by accident.
      runtime: { stateRoot: this.root, ...(request.runtime ?? {}) },
      ...(request.routeOptions ?? this.routeOptions ?? {}),
      acceptChannel: (accepted, stream, signal) => this.#acceptMember({ binding: accepted, secret, activation }, stream, signal),
    });
      const published = /** @type {any} */ (await resource.ready);
      const descriptor = buildRouteDescriptor({ binding, endpoint: published.endpoint, proofRef,
        issuedAt: this.now().toISOString() });
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await writeAtomic(file, descriptor);
      const entry = { binding, secret, proofRef, descriptor, resource, descriptorPath: file,
        secretPath, state: /** @type {'live' | 'closing'} */ ("live"), openedAt: this.now().toISOString(), activation };
      await journal.finish(operationId, 'committed', this.now().toISOString());
      this.routes.set(key, entry);
      activation.active = true;
      return { descriptor, descriptorPath: file, secretRef: proofRef, secretPath };
    } catch (error) {
      // A failed descriptor write must not leave a live listener nobody has a record of.
      try {
        await resource?.stop();
        await removeRouteSecret(this.root, binding);
        await rm(file, { force: true });
      } catch {
        if (resource) this.failedAdmissions.set(operationId, resource);
        journal.recoveryRooms.add(roomId);
        throw new AuthorityError('operator-recovery-required');
      }
      throw error;
    }
    });
  }

  /** Live routes, read from the service's own registry rather than from files on disk. */
  listRoutes() {
    return [...this.routes.values()].map((route) => ({
      roomId: route.binding.roomId, accountId: route.binding.accountId,
      allowedKeyDigest: route.binding.allowedKeyDigest, grantId: route.binding.grantId,
      routeGeneration: route.binding.routeGeneration, endpoint: route.descriptor.endpoint,
      state: route.state ?? "live",
      openedAt: route.openedAt, descriptorPath: route.descriptorPath, secretPath: route.secretPath,
    }));
  }

  /**
   * Close is REVOCATION. Nothing runs on the remote, so its copy of the secret simply goes stale
   * and fails the proof by name; a reopen mints a new generation whose descriptor and secret
   * travel by the operator's hand.
   * @param {{ roomId: string, publicNodeKey?: string, allowedKeyDigest?: string, proof?: unknown, attributionClaims?: unknown }} request
   */
  async closeRoute(request) {
    const retained = { ...request };
    return await this.#admitRoute(retained, 'room-revoke', (_binding, operationId) => this.#closeApprovedRoute(retained, operationId));
  }

  /** @param {Parameters<NativeRoomService['closeRoute']>[0]} request @param {string} operationId */
  async #closeApprovedRoute(request, operationId) {
    const journal = /** @type {AuthorityJournal} */ (this.authorityJournal);
    const roomId = requiredString(request.roomId, "room id");
    const digest = request.allowedKeyDigest
      ?? publicNodeKeyDigest(validatePublicNodeKey(request.publicNodeKey));
    const key = routeKey(roomId, digest);
    const route = this.routes.get(key);
    if (!route) throw new AgoraError(`route-not-open: ${roomId} admits no route for that key`);
    // Marked rather than deleted: AGORA_CLEANUP_PENDING's own message says to retain the handle,
    // and dropping the entry first would leave a child still being torn down with nothing in the
    // registry describing it. The entry stays, reported as closing, until closed settles.
    await journal.finish(operationId, 'revoked', this.now().toISOString());
    route.activation.active = false;
    route.state = "closing";
    let cleanupPending;
    // stop() can reject with AGORA_CLEANUP_PENDING; reporting a clean teardown we did not observe
    // is the failure this branch exists to refuse.
    try { await route.resource.stop(); this.routes.delete(key); }
    catch (error) {
      cleanupPending = error;
      void Promise.resolve(route.resource.closed).catch(() => {}).finally(() => this.routes.delete(key));
    }
    await removeRouteSecret(this.root, route.binding);
    await rm(route.descriptorPath, { force: true });
    if (cleanupPending) throw cleanupPending;
    await journal.finish(operationId, 'closed', this.now().toISOString());
    return { roomId, grantId: route.binding.grantId, routeGeneration: route.binding.routeGeneration,
      accountId: route.binding.accountId, revoked: true };
  }

  /**
   * Admit one Tailcat-authenticated member stream.
   *
   * This is deliberately NOT `#accept`. That path sends a server-hello proved with the seat-local
   * service nonce on every socket it is given (see `#accept`), and the nonce must never leave this
   * machine. A member stream is proved under the route's own secret, with the member phases, over a
   * transcript widened by the binding, and it never observes the nonce at all.
   *
   * @param {{ binding: any, secret: string, activation: {active: boolean} }} route
   * @param {import("node:stream").Duplex} stream
   * @param {AbortSignal} signal
   * @returns {{ ready: Promise<unknown>, closed: Promise<unknown>, stop: () => Promise<unknown> }}
   */
  #acceptMember(route, stream, signal) {
    const decoder = new NativeFrameDecoder();
    let greeted = false;
    let chain = Promise.resolve();
    const requestId = randomUUID().replaceAll("-", "");
    const serverChallenge = randomUUID().replaceAll("-", "");
    const member = { binding: route.binding };
    this.subscriptions.set(/** @type {any} */ (stream), new Map());
    /** @type {(v?: unknown) => void} */ let resolveReady = () => {};
    /** @type {(e: unknown) => void} */ let rejectReady = () => {};
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    void ready.catch(() => {});
    const closed = new Promise((resolve) => {
      if (stream.destroyed) resolve(undefined); else stream.once("close", () => resolve(undefined));
    });

    const base = { bootEpoch: this.bootEpoch, requestId, serverChallenge,
      accountId: this.accountId, seatLabel: this.seatLabel };
    const serverTranscript = memberTranscript(route.binding, base);
    const fail = (/** @type {unknown} */ error, /** @type {string | undefined} */ id) => {
      const message = error instanceof Error ? error.message : "native member request failed";
      const carried = /** @type {any} */ (error)?.code;
      const code = typeof carried === "string" && /^[a-z][a-z0-9-]+$/.test(carried)
        ? carried : greeted ? "member-request-refused" : "member-hello-refused";
      sendFrame(/** @type {any} */ (stream), { protocol: NATIVE_PROTOCOL, type: "error",
        requestId: id ?? randomUUID().replaceAll("-", ""),
        reason: greeted ? "request-refused" : "member-hello-refused", code, message: message.slice(0, 500) });
    };
    if (!route.activation.active) {
      const error = new AuthorityError('member-route-not-active');
      fail(error, requestId); rejectReady(error); stream.end();
      return { ready, closed, stop: async () => { stream.destroy(); this.subscriptions.delete(stream); } };
    }
    if (!sendFrame(/** @type {any} */ (stream), { protocol: NATIVE_PROTOCOL, type: "member-server-hello",
      ...serverTranscript, proof: memberHandshakeProof(route.secret, MEMBER_PHASES.server, serverTranscript) })) {
      rejectReady(new AgoraError("member stream closed before the host could greet it"));
      return { ready, closed, stop: async () => { stream.destroy(); } };
    }

    stream.on("data", (bytes) => {
      let frames;
      try { frames = decoder.push(bytes); }
      catch (error) { fail(error, undefined); stream.destroy(); return; }
      for (const raw of frames) {
        chain = chain.then(async () => {
          const frame = validateNativeEnvelope(raw);
          if (!route.activation.active) throw new AuthorityError('member-route-not-active');
          if (!greeted) {
            // A member socket that speaks the LOCAL handshake is refused by name rather than
            // falling through to a path that would consult the nonce.
            if (frame.type === "client-hello")
              throw codedRefusal("member-phase-refused", "a member session speaks the member handshake, never the local one");
            if (frame.type !== "member-client-hello" || frame.requestId !== requestId
              || frame.bootEpoch !== this.bootEpoch || frame.serverChallenge !== serverChallenge)
              throw codedRefusal("member-hello-refused", "the client hello did not match this handshake");
            const clientChallenge = requiredString(frame.clientChallenge, "client challenge");
            validateNativeId(clientChallenge, "client challenge");
            const transcript = { ...serverTranscript, clientChallenge };
            if (!verifyMemberHandshakeProof(frame.proof, route.secret, MEMBER_PHASES.client, transcript))
              throw codedRefusal("member-proof-refused", "the client did not prove the transcript under this route's secret");
            // The account is bound by the route, never taken from the frame. A frame that names a
            // different principal is refused here rather than reaching the store.
            if (frame.accountId !== undefined && frame.accountId !== route.binding.accountId)
              throw codedRefusal("member-actor-mismatch", "this route admits one principal and the frame named another");
            greeted = true;
            sendFrame(/** @type {any} */ (stream), { protocol: NATIVE_PROTOCOL, type: "member-welcome",
              ...transcript, proof: memberHandshakeProof(route.secret, MEMBER_PHASES.welcome, transcript) });
            resolveReady(undefined);
            return;
          }
          if (frame.accountId !== undefined && frame.accountId !== route.binding.accountId)
            throw codedRefusal("member-actor-mismatch", "this route admits one principal and the frame named another");
          // A face choice is a foreign key on a member frame the way an account claim is. The host
          // reads no face off any frame (face selection and publication run in the poster's own
          // CLI against the poster's own state and token), so a member carrying one is refused
          // by name rather than silently ignored, and nothing is committed under it.
          // Checked at both positions a frame can carry it, the way the identity claim is: the local
          // transport puts it at the top level, and a hand-built frame could put it in the operation.
          const op = /** @type {any} */ (frame.operation);
          if (Object.hasOwn(frame, "face") || (op && typeof op === "object" && !Array.isArray(op) && Object.hasOwn(op, "face")))
            throw codedRefusal("member-face-refused", "the host reads no face off a member frame; a face is chosen and published by the poster's own CLI, never through a route");
          await this.#dispatch(/** @type {any} */ (stream), frame, member);
        }).catch((error) => {
          const id = raw && typeof raw === "object" && "requestId" in raw && typeof raw.requestId === "string"
            ? raw.requestId : undefined;
          fail(error, id);
          // Give the named refusal a tick to leave the wire. The route's own accept() destroys
          // this stream as soon as ready rejects, and a refusal the far side never receives is
          // indistinguishable from a hang.
          if (!greeted) setImmediate(() => { rejectReady(error); stream.end(); });
        });
      }
    });
    stream.on("close", () => { this.subscriptions.delete(/** @type {any} */ (stream)); });
    stream.on("error", () => {});
    if (signal.aborted) stream.destroy();
    return { ready, closed, stop: async () => { stream.destroy(); await closed; } };
  }

  async stop() {
    if (!this.server) return;
    this.draining = true;
    await Promise.allSettled([...this.admissions.values()]);
    this.running = false;
    this.routeChallenges.clear();
    for (const route of this.routes.values()) {
      route.activation.active = false;
      try { await route.resource.stop(); } catch { /* reported by closeRoute; stop() is best-effort */ }
    }
    for (const resource of this.failedAdmissions.values()) {
      try { await resource.stop(); } catch { /* durable intent retains the recovery obligation */ }
    }
    this.failedAdmissions.clear();
    this.routes.clear();
    this.routeOwner?.abort();
    this.routeOwner = undefined;
    if (this.panePid) {
      await reapPane(this.panePid);
      this.panePid = undefined;
    }
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear(); this.subscriptions.clear();
    await Promise.allSettled([...this.roomActivities]);
    for (const store of this.rooms.values()) await store.close();
    this.rooms.clear();
    await this.authorityJournal?.close();
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
      if (frame.type === "error") {
        const error = new AgoraError(`${frame.reason ?? "request-refused"}: ${frame.message ?? "native service refused the request"}`);
        const wireCode = typeof frame.code === "string" && /^[a-z][a-z0-9-]+$/.test(frame.code) ? frame.code : undefined;
        // A client may upgrade before its host. Pre-L8 frames have no `code`, but their leading
        // name carried real discrimination (including route-not-open versus request-refused).
        // Derive it only here at the frame boundary; callers and retry loops still see a code.
        const oldPrefix = wireCode === undefined && typeof frame.message === "string"
          ? /^([a-z][a-z-]+):/.exec(frame.message)?.[1] : undefined;
        const code = wireCode ?? oldPrefix ?? frame.reason;
        if (typeof code === "string") Object.assign(error, { code });
        pending.reject(error);
      }
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
