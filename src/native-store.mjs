// @ts-check
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { AgoraError } from "./core.mjs";
import { nativeCursor, nativeDigest, parseNativeCursor, validateNativeEpoch, validateNativeId } from "./native-protocol.mjs";
import { ProtocolValidationError } from "./protocol/common.mjs";
import { validateBoardPayload } from "./protocol/operation.mjs";

const LOG_VERSION = 1;
const MANIFEST_VERSION = 1;
const LOG_RECORD_MAX = 1024 * 1024;
const MESSAGE_TEXT_MAX = 256 * 1024;
const ATTACHMENT_MAX = 32;
const DEFAULT_RECORD_LIMIT = 100_000;
const DEFAULT_CLAIM_LEASE_MS = 3_600_000;
const CLAIM_LEASE_CAP_MS = 86_400_000;
const MISSING_EXPIRY = "1970-01-01T00:00:00.000Z";
const ROOM_RE = /^[a-f0-9]{32}$/;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** @param {Uint8Array} bytes */
const sha256 = (bytes) => createHash("sha256").update(bytes).digest();

/** @param {string} roomId @param {string} accountId @param {string} operationId */
function messageId(roomId, accountId, operationId) {
  return createHash("sha256").update(roomId).update("\0").update(accountId).update("\0").update(operationId).digest("hex");
}

/** @param {string} root @param {string} roomId */
function roomDirectory(root, roomId) {
  if (!ROOM_RE.test(roomId)) throw new AgoraError("native room id must be 32 lowercase hexadecimal characters");
  return path.join(path.resolve(root), "native", "rooms", roomId);
}

/** @param {string} file @param {string} text */
async function writeDurableAtomic(file, text) {
  const parent = path.dirname(file);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  let renamed = false;
  let durable = false;
  let primaryError;
  try {
    const handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(text, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temp, file);
    renamed = true;
    await syncDirectory(parent);
    durable = true;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try { await rm(temp, { force: true }); }
    catch (cleanupError) {
      // Once rename and directory sync succeeded, failure to remove the old
      // temp pathname cannot revoke the durable target. Before that point the
      // primary publication failure remains authoritative and cleanup must not
      // overwrite it with a less informative error.
      if (!primaryError && !(renamed && durable)) throw cleanupError;
    }
  }
}

/**
 * POSIX needs the directory entry persisted after an atomic rename. Windows
 * does not permit fsync on a directory handle through Node; its file flush +
 * rename path is the strongest portable runtime primitive available there.
 * @param {string} directory
 */
async function syncDirectory(directory) {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try { await handle.sync(); }
  finally { await handle.close(); }
}

/** @param {string} directory */
async function physicalRoom(directory) {
  const canonical = await realpath(directory);
  const info = await stat(canonical, { bigint: true });
  if (!info.isDirectory()) throw new AgoraError("native room path is not a directory");
  // dev+ino survives symlink, junction, case and bind-mount aliases. Some
  // Windows filesystems expose zeroes; realpath is the safe refusal-oriented
  // fallback there and is case-folded because the namespace is insensitive.
  const identity = info.dev !== 0n || info.ino !== 0n
    ? `fs:${info.dev}:${info.ino}`
    : `path:${process.platform === "win32" ? canonical.toLowerCase() : canonical}`;
  return { directory: canonical, identity };
}

const WRITER_LOCK = "writer.lock";
const WRITER_PROBE_MS = 200;

/** @param {{host:string,port:number}} endpoint @returns {Promise<"live"|"dead">} */
function probeWriter(endpoint) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: endpoint.host, port: endpoint.port });
    const timer = setTimeout(() => finish("live"), WRITER_PROBE_MS);
    timer.unref?.();
    const finish = (/** @type {"live"|"dead"} */ verdict) => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(verdict);
    };
    socket.once("connect", () => finish("live"));
    socket.once("error", (error) => finish(/** @type {NodeJS.ErrnoException} */ (error).code === "ECONNREFUSED" ? "dead" : "live"));
  });
}

async function listenEphemeralWriter() {
  const server = net.createServer((socket) => socket.destroy());
  server.listen({ host: "127.0.0.1", port: 0, exclusive: true });
  try { await Promise.race([once(server, "listening"), once(server, "error").then(([error]) => Promise.reject(error))]); }
  catch (error) { try { if (server.listening) server.close(); } catch {} throw error; }
  const address = server.address();
  if (!address || typeof address === "string") {
    try { if (server.listening) server.close(); } catch {}
    throw new AgoraError("native room writer bound no TCP port");
  }
  return { server, endpoint: { host: "127.0.0.1", port: address.port } };
}

/**
 * Exclusive create of writer.lock is the acquire. After EEXIST, only
 * ECONNREFUSED on the recorded port licenses unlink; timeout, any other
 * probe error, or a malformed lock refuse. The probe never takes the lock
 * on its own.
 * @param {string} directory @param {string} identity
 */
async function acquireWriter(directory, identity) {
  const lockPath = path.join(directory, WRITER_LOCK);
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const lock = await open(lockPath, "wx", 0o600);
      try {
        const { server, endpoint } = await listenEphemeralWriter();
        await lock.writeFile(`${JSON.stringify({ identity, pid: process.pid, host: endpoint.host, port: endpoint.port })}\n`, "utf8");
        await lock.sync();
        return { server, endpoint, identity, lock, lockPath };
      } catch (error) {
        await lock.close().catch(() => {});
        await rm(lockPath, { force: true }).catch(() => {});
        throw error;
      }
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST") throw error;
      let recorded = /** @type {{ host?: unknown, port?: unknown }} */ ({});
      try { recorded = JSON.parse(await readFile(lockPath, "utf8")); }
      catch { throw new AgoraError(`native room writer lock ${lockPath} is unusable`); }
      const host = typeof recorded.host === "string" ? recorded.host : "";
      const port = typeof recorded.port === "number" && Number.isInteger(recorded.port) ? recorded.port : 0;
      if (!host || !port) throw new AgoraError(`native room writer lock ${lockPath} is unusable`);
      if (await probeWriter({ host, port }) === "live")
        throw new AgoraError(`native room already has a live writer or its OS-owned endpoint ${host}:${port} is unavailable`);
      await rm(lockPath, { force: true });
    }
  }
  throw new AgoraError("native room writer lock could not be acquired");
}

/** @param {{ server: net.Server, endpoint: {host:string,port:number}, identity:string, lock?: import('node:fs/promises').FileHandle, lockPath?: string }} writer */
async function releaseWriter(writer) {
  if (writer.server.listening) await new Promise((resolve) => writer.server.close(() => resolve(undefined)));
  if (writer.lock) await writer.lock.close().catch(() => {});
  if (writer.lockPath) await rm(writer.lockPath, { force: true }).catch(() => {});
}

/** @param {unknown} value */
function storedFrame(value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (!payload.length || payload.length > LOG_RECORD_MAX) throw new AgoraError(`native room record exceeds ${LOG_RECORD_MAX} bytes`);
  const frame = Buffer.allocUnsafe(4 + payload.length + 32);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  sha256(payload).copy(frame, 4 + payload.length);
  return frame;
}

/** @param {import('node:fs/promises').FileHandle} handle @param {Buffer} bytes @param {number} position */
async function writeAll(handle, bytes, position) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, position + offset);
    if (!bytesWritten) throw new AgoraError("native room log write made no progress");
    offset += bytesWritten;
  }
}

/**
 * FileHandle.read may return fewer bytes than requested before EOF. Recovery
 * decisions therefore follow the file size, never one read call.
 * @param {import('node:fs/promises').FileHandle} handle
 * @param {Buffer} bytes
 * @param {number} position
 */
async function readExact(handle, bytes, position) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, position + offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  return offset;
}

/** @param {unknown} value */
function validateAttachment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AgoraError("native attachment metadata must be an object");
  const a = /** @type {Record<string, unknown>} */ (value);
  if (typeof a.id !== "string") throw new AgoraError("native attachment needs an id");
  validateNativeId(a.id, "attachment id");
  if (typeof a.name !== "string" || !a.name || a.name.length > 255) throw new AgoraError("native attachment needs a bounded name");
  if (a.kind !== "image" && a.kind !== "file") throw new AgoraError("native attachment kind must be image or file");
  if (typeof a.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(a.digest)) throw new AgoraError("native attachment needs a sha256 digest");
  if (!Number.isSafeInteger(a.size) || Number(a.size) < 0) throw new AgoraError("native attachment needs a non-negative byte size");
  if ("path" in a || "url" in a) throw new AgoraError("native room records never store sender-local attachment paths or transport URLs");
  return { id: a.id, name: a.name, kind: a.kind, size: a.size, digest: a.digest,
    ...(typeof a.mimetype === "string" ? { mimetype: a.mimetype.slice(0, 200) } : {}),
    ...(Number.isSafeInteger(a.width) && Number(a.width) > 0 ? { width: a.width } : {}),
    ...(Number.isSafeInteger(a.height) && Number(a.height) > 0 ? { height: a.height } : {}) };
}

/** @param {any} record @param {any} manifest @param {number} expectedSequence @param {string | null} expectedPreviousDigest */
function validateRecord(record, manifest, expectedSequence, expectedPreviousDigest) {
  if (!record || typeof record !== "object" || record.version !== LOG_VERSION || record.roomId !== manifest.roomId || record.epoch !== manifest.epoch)
    throw new AgoraError("native room log contains a record for another room or protocol version");
  if (record.sequence !== expectedSequence) throw new AgoraError(`native room log sequence gap: expected ${expectedSequence}, got ${record.sequence}`);
  validateNativeId(record.operationId, "operation id");
  if (!/^sha256:[a-f0-9]{64}$/.test(record.payloadDigest ?? "")) throw new AgoraError("native room log contains an invalid payload digest");
  if (record.previousDigest !== expectedPreviousDigest) throw new AgoraError(`native room log hash-chain mismatch at sequence ${expectedSequence}; do not advance or truncate it`);
  validateNativeId(record.accountId, "record account id");
  if (record.kind === "board") {
    if (record.message) throw new AgoraError("native room board record must not carry a chat message");
    try { validateBoardPayload(record.board); }
    catch (error) {
      if (error instanceof ProtocolValidationError) throw new AgoraError(`native room board record is invalid (${error.message})`);
      throw error;
    }
    if (record.boardId !== messageId(manifest.roomId, record.accountId, record.operationId) ||
        record.cursor !== nativeCursor(manifest.epoch, expectedSequence))
      throw new AgoraError("native room board identity does not match its committed position");
  } else if (!record.message || record.message.id !== messageId(manifest.roomId, record.accountId, record.operationId) ||
      record.message.author?.id !== record.accountId || record.message.room !== manifest.roomId ||
      record.message.cursor !== nativeCursor(manifest.epoch, expectedSequence)) throw new AgoraError("native room log message identity does not match its committed position");
  const { recordDigest, ...unsigned } = record;
  if (!/^sha256:[a-f0-9]{64}$/.test(recordDigest ?? "") || nativeDigest(unsigned) !== recordDigest)
    throw new AgoraError(`native room log record digest mismatch at sequence ${expectedSequence}; do not advance or truncate it`);
  return record;
}

/** @param {import('node:fs/promises').FileHandle} handle @param {any} manifest @param {any} boundary */
async function scan(handle, manifest, boundary) {
  const size = (await handle.stat()).size;
  if (!boundary || boundary.version !== 1 || boundary.roomId !== manifest.roomId || boundary.epoch !== manifest.epoch ||
      !Number.isSafeInteger(boundary.sequence) || boundary.sequence < 0 || boundary.sequence > manifest.recordLimit ||
      !Number.isSafeInteger(boundary.end) || boundary.end < 0 ||
      (boundary.sequence === 0 ? boundary.digest !== null : !/^sha256:[a-f0-9]{64}$/.test(boundary.digest ?? "")))
    throw new AgoraError("native room committed boundary is invalid; do not advance or truncate the log");
  if (size < boundary.end) throw new AgoraError(`native room log is truncated below its acknowledged ${boundary.end}-byte boundary; do not reuse its cursor`);
  let position = 0;
  /** @type {any[]} */
  const records = [];
  while (position < boundary.end) {
    const header = Buffer.alloc(4);
    if (boundary.end - position < 4) throw new AgoraError(`native room committed boundary ends inside a header at offset ${position}`);
    const headerRead = await readExact(handle, header, position);
    if (headerRead < 4) throw new AgoraError(`native room log became unreadable at offset ${position}; do not advance or truncate it`);
    const length = header.readUInt32BE(0);
    if (length < 1 || length > LOG_RECORD_MAX) throw new AgoraError(`native room log declares an invalid ${length}-byte record at offset ${position}`);
    const body = Buffer.alloc(length + 32);
    if (boundary.end - position - 4 < body.length) throw new AgoraError(`native room committed boundary ends inside a record at offset ${position}`);
    const bodyRead = await readExact(handle, body, position + 4);
    if (bodyRead < body.length) throw new AgoraError(`native room log became unreadable at offset ${position}; do not advance or truncate it`);
    const payload = body.subarray(0, length);
    if (!sha256(payload).equals(body.subarray(length))) throw new AgoraError(`native room log checksum mismatch at offset ${position}; do not advance or truncate it`);
    let parsed;
    try { parsed = JSON.parse(UTF8.decode(payload)); }
    catch { throw new AgoraError(`native room log contains invalid UTF-8 or JSON at offset ${position}; do not advance or truncate it`); }
    records.push(validateRecord(parsed, manifest, records.length + 1, records.at(-1)?.recordDigest ?? null));
    position += 4 + body.length;
  }
  if (records.length !== boundary.sequence || (records.at(-1)?.recordDigest ?? null) !== boundary.digest)
    throw new AgoraError("native room log does not match its acknowledged sequence/digest boundary; do not advance or truncate it");
  const recoveredTailBytes = size - boundary.end;
  if (recoveredTailBytes) {
    // Only bytes beyond the separately synced committed boundary are unacknowledged. A short log
    // is refused above: partial bytes alone never prove that an acknowledged frame was unaccepted.
    await handle.truncate(boundary.end);
    await handle.sync();
  }
  return { records, end: boundary.end, recoveredTailBytes };
}

export class NativeRoomStore {
  /** @param {string} directory @param {any} manifest @param {any} boundary @param {import('node:fs/promises').FileHandle} handle @param {{server: net.Server, endpoint: {host:string,port:number}, identity:string}} writer @param {any[]} records @param {number} end @param {number} recoveredTailBytes @param {() => Date} now */
  constructor(directory, manifest, boundary, handle, writer, records, end, recoveredTailBytes, now) {
    this.directory = directory;
    this.logPath = path.join(directory, "room.frames");
    this.boundaryPath = path.join(directory, "committed.json");
    this.manifest = manifest;
    this.boundary = boundary;
    this.handle = handle;
    this.writer = writer;
    this.records = records;
    this.end = end;
    this.recoveredTailBytes = recoveredTailBytes;
    this.now = now;
    this.queue = Promise.resolve();
    this.closed = false;
    this.resourcesClosed = false;
    this.operations = new Map(records.map((r) => [`${r.accountId}\0${r.operationId}`, r]));
    /** @type {Map<string, { accountId: string, cursor: string, leaseId: string, fence: string, expiresAt: string, leaseMs: number }>} */
    this.holders = new Map();
    for (const r of records) this.#applyBoard(r);
  }

  /** @param {{ root: string, roomId?: string, epoch?: string, hostAccountId: string, recordLimit?: number, now?: () => Date }} options */
  static async create(options) {
    const roomId = options.roomId ?? randomUUID().replaceAll("-", "");
    const epoch = options.epoch ?? randomUUID().replaceAll("-", "");
    validateNativeEpoch(epoch);
    validateNativeId(options.hostAccountId, "host account id");
    const recordLimit = options.recordLimit ?? DEFAULT_RECORD_LIMIT;
    if (!Number.isSafeInteger(recordLimit) || recordLimit < 1 || recordLimit > 10_000_000)
      throw new AgoraError("native room record limit must be 1-10000000");
    const requestedDirectory = roomDirectory(options.root, roomId);
    await mkdir(path.dirname(requestedDirectory), { recursive: true, mode: 0o700 });
    try { await mkdir(requestedDirectory, { mode: 0o700 }); }
    catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code === "EEXIST") throw new AgoraError(`native room ${roomId} already exists`);
      throw e;
    }
    let directory = requestedDirectory;
    let writer;
    let log;
    let boundaryPublicationStarted = false;
    try {
      await syncDirectory(path.dirname(requestedDirectory));
      const physical = await physicalRoom(requestedDirectory);
      directory = physical.directory;
      writer = await acquireWriter(physical.directory, physical.identity);
      const confirmed = await physicalRoom(requestedDirectory);
      if (confirmed.identity !== physical.identity)
        throw new AgoraError("native room identity changed while acquiring its writer; refusing without publishing it");
      const manifest = { version: MANIFEST_VERSION, roomId, epoch, hostAccountId: options.hostAccountId, recordLimit,
        claimLeaseMs: DEFAULT_CLAIM_LEASE_MS, claimLeaseCapMs: CLAIM_LEASE_CAP_MS,
        createdAt: (options.now ?? (() => new Date()))().toISOString() };
      await writeDurableAtomic(path.join(directory, "room.json"), JSON.stringify(manifest, null, 2) + "\n");
      log = await open(path.join(directory, "room.frames"), "wx+", 0o600);
      await log.sync();
      await syncDirectory(directory);
      const boundary = { version: 1, roomId, epoch, sequence: 0, end: 0, digest: null };
      boundaryPublicationStarted = true;
      await writeDurableAtomic(path.join(directory, "committed.json"), JSON.stringify(boundary, null, 2) + "\n");
      return new NativeRoomStore(directory, manifest, boundary, log, writer, [], 0, 0,
        options.now ?? (() => new Date()));
    } catch (e) {
      if (log) await log.close().catch(() => {});
      // Cleanup is safe only before the committed-boundary publication starts,
      // and it must happen while writer authority is still held. Once that
      // publication begins, preserve the room: rename may have succeeded before
      // an error reached us, so recursive deletion could erase accepted state or
      // a successor that opens after release.
      if (!boundaryPublicationStarted) await rm(directory, { recursive: true, force: true }).catch(() => {});
      if (writer) await releaseWriter(writer).catch(() => {});
      if (boundaryPublicationStarted) {
        const code = /** @type {NodeJS.ErrnoException} */ (e).code;
        throw new AgoraError(`native room ${roomId} publication failed with unknown acceptance; state preserved for inspection${code ? ` (${code})` : ""}`);
      }
      throw e;
    }
  }

  /** @param {{ root: string, roomId: string, now?: () => Date }} options */
  static async open(options) {
    const requestedDirectory = roomDirectory(options.root, options.roomId);
    let physical;
    try { physical = await physicalRoom(requestedDirectory); }
    catch { throw new AgoraError(`native room ${options.roomId} has no valid manifest`); }
    const writer = await acquireWriter(physical.directory, physical.identity);
    const directory = physical.directory;
    let manifest;
    let handle;
    try {
      const confirmed = await physicalRoom(requestedDirectory);
      if (confirmed.identity !== physical.identity)
        throw new AgoraError("native room identity changed while acquiring its writer; refusing before scan");
      try { manifest = JSON.parse(await readFile(path.join(directory, "room.json"), "utf8")); }
      catch { throw new AgoraError(`native room ${options.roomId} has no valid manifest`); }
      if (manifest?.version !== MANIFEST_VERSION || manifest.roomId !== options.roomId || !ROOM_RE.test(manifest.roomId ?? "") ||
          !/^[A-Za-z0-9_-]{16,128}$/.test(manifest.hostAccountId ?? "") || !Number.isSafeInteger(manifest.recordLimit) ||
          manifest.recordLimit < 1 || manifest.recordLimit > 10_000_000) throw new AgoraError(`native room ${options.roomId} manifest is invalid`);
      validateNativeEpoch(manifest.epoch);
      handle = await open(path.join(directory, "room.frames"), "r+");
      let boundary;
      try { boundary = JSON.parse(await readFile(path.join(directory, "committed.json"), "utf8")); }
      catch { throw new AgoraError(`native room ${options.roomId} has no valid committed boundary`); }
      const scanned = await scan(handle, manifest, boundary);
      return new NativeRoomStore(directory, manifest, boundary, handle, writer, scanned.records, scanned.end, scanned.recoveredTailBytes,
        options.now ?? (() => new Date()));
    } catch (e) {
      if (handle) await handle.close();
      await releaseWriter(writer);
      throw e;
    }
  }

  /**
   * The authenticated account id comes from the route-bound handler, never from the request body.
   * @param {any} input
   * @param {{ accountId: string }} authenticated
   */
  async append(input, authenticated) {
    const run = this.queue.then(() => this.#append(input, authenticated));
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * @param {any} input
   * @param {{ accountId: string }} authenticated
   */
  async #append(input, authenticated) {
    if (this.closed) throw new AgoraError("native room store is closed");
    if (/** @type {any} */ (input).kind === "board") return this.#appendBoard(/** @type {any} */ (input), authenticated);
    validateNativeId(input.operationId, "operation id");
    validateNativeId(authenticated.accountId, "account id");
    if (typeof input.authorName !== "string" || !input.authorName.trim() || input.authorName.length > 120) throw new AgoraError("native post needs a bounded author label");
    if (input.authorKind && !["human", "agent", "unknown"].includes(input.authorKind)) throw new AgoraError("native post author kind is invalid");
    if (typeof input.text !== "string" || Buffer.byteLength(input.text) > MESSAGE_TEXT_MAX) throw new AgoraError(`native post text exceeds ${MESSAGE_TEXT_MAX} bytes`);
    if (input.thread !== undefined) validateNativeId(input.thread, "thread id");
    if (input.attachments && (!Array.isArray(input.attachments) || input.attachments.length > ATTACHMENT_MAX)) throw new AgoraError(`native post carries more than ${ATTACHMENT_MAX} attachments`);
    const attachments = input.attachments?.map(validateAttachment);
    const payload = { accountId: authenticated.accountId, authorName: input.authorName.trim(), authorKind: input.authorKind ?? "agent", text: input.text,
      ...(input.thread ? { thread: input.thread } : {}), ...(attachments?.length ? { attachments } : {}) };
    const payloadDigest = nativeDigest(payload);
    const key = `${authenticated.accountId}\0${input.operationId}`;
    const existing = this.operations.get(key);
    if (existing) {
      if (existing.payloadDigest !== payloadDigest) throw new AgoraError(`native operation ${input.operationId} was already committed with different bytes`);
      return { id: existing.message.id, cursor: existing.message.cursor, duplicate: true };
    }
    if (this.records.length >= this.manifest.recordLimit)
      throw new AgoraError(`native room reached its ${this.manifest.recordLimit}-record resident limit; retain or archive explicitly before accepting more`);
    const sequence = this.records.length + 1;
    const id = messageId(this.manifest.roomId, authenticated.accountId, input.operationId);
    const message = { id, room: this.manifest.roomId,
      ...(input.thread ? { thread: input.thread } : {}),
      author: { id: authenticated.accountId, name: payload.authorName, kind: payload.authorKind },
      text: input.text, ts: this.now().toISOString(), cursor: nativeCursor(this.manifest.epoch, sequence),
      ...(attachments?.length ? { attachments } : {}) };
    const unsigned = { version: LOG_VERSION, roomId: this.manifest.roomId, epoch: this.manifest.epoch, sequence,
      accountId: authenticated.accountId, operationId: input.operationId,
      payloadDigest, previousDigest: this.records.at(-1)?.recordDigest ?? null, message };
    const record = { ...unsigned, recordDigest: nativeDigest(unsigned) };
    await this.#commit(record, key);
    return { id: message.id, cursor: message.cursor, duplicate: false };
  }

  /**
   * Board check-and-acquire is this turn of the append queue: the holder map is
   * consulted after every earlier append has committed. Two concurrent claims
   * of an unheld subject cannot both return acquired, including two operations
   * from the same account (every local client on a seat shares this.accountId).
   * A retried operation id is a duplicate; renew extends the lease; an expired
   * holder is no holder. Break is a human-kind event that names and drops the holder.
   * @param {{ kind: 'board', operationId: string, payload: unknown, authorKind?: string }} input
   * @param {{ accountId: string }} authenticated
   */
  async #appendBoard(input, authenticated) {
    validateNativeId(input.operationId, "operation id");
    validateNativeId(authenticated.accountId, "account id");
    let payload;
    try { payload = validateBoardPayload(input.payload); }
    catch (error) {
      if (error instanceof ProtocolValidationError) throw new AgoraError(`native board payload is invalid (${error.message})`);
      throw error;
    }
    const key = `${authenticated.accountId}\0${input.operationId}`;
    const existing = this.operations.get(key);
    if (existing) {
      if (existing.payloadDigest !== nativeDigest({ accountId: authenticated.accountId, board: payload }))
        throw new AgoraError(`native operation ${input.operationId} was already committed with different bytes`);
      return { id: existing.boardId, cursor: existing.cursor, duplicate: true, kind: "board" };
    }
    const stored = this.holders.get(payload.subject);
    const live = this.#liveHolder(payload.subject);
    if (payload.action === "claim") {
      if (live)
        throw new AgoraError(`native board subject ${payload.subject} is held at ${live.cursor} by ${live.accountId} until ${live.expiresAt}`);
    } else if (payload.action === "release" || payload.action === "renew") {
      if (!live || live.accountId !== authenticated.accountId || live.leaseId !== payload.leaseId)
        throw new AgoraError(`native board subject ${payload.subject} is not held by this account under that lease`);
    } else if (payload.action === "break") {
      if (input.authorKind !== "human")
        throw new AgoraError("native board break is a human verb");
      if (!stored)
        throw new AgoraError(`native board subject ${payload.subject} has no holder to break`);
    }
    if (this.records.length >= this.manifest.recordLimit)
      throw new AgoraError(`native room reached its ${this.manifest.recordLimit}-record resident limit; retain or archive explicitly before accepting more`);
    const sequence = this.records.length + 1;
    const cursor = nativeCursor(this.manifest.epoch, sequence);
    const boardId = messageId(this.manifest.roomId, authenticated.accountId, input.operationId);
    const payloadDigest = nativeDigest({ accountId: authenticated.accountId, board: payload });
    const leaseMs = payload.action === "claim" || payload.action === "renew" ? this.#leaseMs(payload, live) : undefined;
    const expiresAt = leaseMs !== undefined ? new Date(this.now().getTime() + leaseMs).toISOString() : undefined;
    const unsigned = { version: LOG_VERSION, roomId: this.manifest.roomId, epoch: this.manifest.epoch, sequence,
      accountId: authenticated.accountId, operationId: input.operationId, kind: "board",
      payloadDigest, previousDigest: this.records.at(-1)?.recordDigest ?? null,
      board: payload, boardId, cursor,
      ...(expiresAt ? { expiresAt, leaseMs } : {}),
      ...(payload.action === "break" && stored ? { broken: { accountId: stored.accountId, cursor: stored.cursor, expiresAt: stored.expiresAt } } : {}) };
    const record = { ...unsigned, recordDigest: nativeDigest(unsigned) };
    await this.#commit(record, key);
    this.#applyBoard(record);
    /** @param {{ accountId: string, cursor: string, expiresAt: string } | undefined} h */
    const holderView = (h) => h ? { accountId: h.accountId, cursor: h.cursor, expiresAt: h.expiresAt } : undefined;
    return { id: boardId, cursor, duplicate: false, kind: "board",
      ...(payload.action === "claim" ? { held: true, leaseId: input.operationId, fence: cursor, expiresAt } : {}),
      ...(payload.action === "renew" ? { held: true, leaseId: payload.leaseId, fence: cursor, expiresAt } : {}),
      ...(payload.action === "contest" ? { held: Boolean(live), holder: holderView(stored) } : {}),
      ...(payload.action === "break" ? { broken: true, holder: holderView(stored) } : {}) };
  }

  /** @param {string} subject */
  #liveHolder(subject) {
    const holder = this.holders.get(subject);
    if (!holder) return null;
    if (Date.parse(holder.expiresAt) <= this.now().getTime()) return null;
    return holder;
  }

  /**
   * @param {{ leaseMs?: number }} payload
   * @param {{ leaseMs: number } | null} live
   */
  #leaseMs(payload, live) {
    const cap = this.manifest.claimLeaseCapMs ?? CLAIM_LEASE_CAP_MS;
    const fallback = live?.leaseMs ?? this.manifest.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS;
    const leaseMs = payload.leaseMs ?? fallback;
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > cap)
      throw new AgoraError(`native board lease must be 1000-${cap} ms`);
    return leaseMs;
  }

  /** @param {any} record */
  #applyBoard(record) {
    if (record.kind !== "board" || !record.board) return;
    const { action, subject } = record.board;
    if (action === "claim")
      this.holders.set(subject, { accountId: record.accountId, cursor: record.cursor, leaseId: record.operationId,
        fence: record.cursor, expiresAt: record.expiresAt ?? MISSING_EXPIRY, leaseMs: record.leaseMs ?? DEFAULT_CLAIM_LEASE_MS });
    else if (action === "release" || action === "break") this.holders.delete(subject);
    else if (action === "renew" && this.holders.has(subject)) {
      const current = this.holders.get(subject);
      if (current) this.holders.set(subject, { ...current, cursor: record.cursor, fence: record.cursor,
        expiresAt: record.expiresAt ?? current.expiresAt, leaseMs: record.leaseMs ?? current.leaseMs });
    }
  }

  /** @param {any} record @param {string} key */
  async #commit(record, key) {
    const frame = storedFrame(record);
    const start = this.end;
    try {
      await writeAll(this.handle, frame, start);
      await this.handle.sync();
    } catch (e) {
      try { await this.handle.truncate(start); await this.handle.sync(); }
      catch { this.closed = true; }
      throw e;
    }
    const boundary = { version: 1, roomId: this.manifest.roomId, epoch: this.manifest.epoch, sequence: record.sequence,
      end: start + frame.length, digest: record.recordDigest };
    try {
      await writeDurableAtomic(this.boundaryPath, JSON.stringify(boundary, null, 2) + "\n");
    } catch (error) {
      // Once boundary publication begins, its acceptance is unknown: rename may
      // have succeeded before a directory sync failed. Never roll the log back
      // behind a boundary another process may observe. Reopen reconciles the
      // old or new boundary against the retained frame.
      this.closed = true;
      const code = /** @type {NodeJS.ErrnoException} */ (error)?.code;
      const suffix = typeof code === "string" ? ` (${code})` : "";
      const wrapped = new AgoraError(`native room committed-boundary publication failed; acceptance is unknown and the writer must reopen before retrying${suffix}`);
      if (error instanceof Error) wrapped.cause = error;
      throw wrapped;
    }
    this.boundary = boundary;
    this.end += frame.length;
    this.records.push(record);
    this.operations.set(key, record);
  }

  /** @param {{ since?: string, limit?: number }} [options] */
  read(options = {}) {
    if (this.closed) throw new AgoraError("native room store is closed");
    const limit = options.limit ?? 1000;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new AgoraError("native room read limit must be 1-10000");
    /** @param {any[]} records */
    const messages = (records) => records.filter((r) => r.message).map((r) => structuredClone(r.message));
    if (!options.since) return messages(this.records.slice(-limit));
    const cursor = parseNativeCursor(options.since);
    if (cursor.epoch !== this.manifest.epoch) throw new AgoraError(`native room cursor belongs to epoch ${cursor.epoch}, not live epoch ${this.manifest.epoch}; recover explicitly without advancing`);
    if (cursor.sequence > this.records.length) throw new AgoraError(`native room cursor ${cursor.sequence} exceeds committed sequence ${this.records.length}; recover explicitly without advancing`);
    return messages(this.records.slice(cursor.sequence, cursor.sequence + limit));
  }

  /** @returns {{ subject: string, accountId: string, cursor: string, leaseId: string, fence: string, expiresAt: string, leaseMs: number }[]} */
  board() {
    if (this.closed) throw new AgoraError("native room store is closed");
    return [...this.holders.entries()].map(([subject, h]) => ({ subject, ...h }));
  }

  /**
   * A checkpoint belongs outside the fetched replica. Comparing it on resume detects
   * truncation or replacement of a prefix that an internally valid hash chain cannot.
   * @param {number} [sequence]
   */
  checkpoint(sequence = this.records.length) {
    if (this.closed) throw new AgoraError("native room store is closed");
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > this.records.length)
      throw new AgoraError(`native room checkpoint sequence must be between 0 and ${this.records.length}`);
    return { roomId: this.manifest.roomId, epoch: this.manifest.epoch, sequence,
      digest: sequence === 0 ? null : this.records[sequence - 1].recordDigest };
  }

  /** @param {unknown} value */
  assertCheckpoint(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new AgoraError("native room checkpoint must be an object");
    const checkpoint = /** @type {Record<string, unknown>} */ (value);
    if (checkpoint.roomId !== this.manifest.roomId) throw new AgoraError("native room checkpoint belongs to another room");
    if (checkpoint.epoch !== this.manifest.epoch) throw new AgoraError("native room checkpoint belongs to another epoch");
    if (!Number.isSafeInteger(checkpoint.sequence) || Number(checkpoint.sequence) < 0 || Number(checkpoint.sequence) > this.records.length)
      throw new AgoraError("native room checkpoint sequence is unavailable; recover explicitly without advancing");
    const expected = Number(checkpoint.sequence) === 0 ? null : this.records[Number(checkpoint.sequence) - 1].recordDigest;
    if (checkpoint.digest !== expected) throw new AgoraError("native room checkpoint digest does not match the retained prefix; recover explicitly without advancing");
    return this.checkpoint(Number(checkpoint.sequence));
  }

  status() {
    return { roomId: this.manifest.roomId, epoch: this.manifest.epoch, hostAccountId: this.manifest.hostAccountId,
      committed: this.records.length, latestCursor: nativeCursor(this.manifest.epoch, this.records.length), latestDigest: this.records.at(-1)?.recordDigest ?? null,
      recordLimit: this.manifest.recordLimit, recoveredTailBytes: this.recoveredTailBytes };
  }

  async close() {
    if (this.resourcesClosed) return;
    await this.queue;
    this.closed = true;
    this.resourcesClosed = true;
    try { await this.handle.close(); }
    finally { await releaseWriter(this.writer); }
  }
}
