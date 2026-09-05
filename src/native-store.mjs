// @ts-check
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { AgoraError } from "./core.mjs";
import { nativeCursor, nativeDigest, parseNativeCursor, validateNativeEpoch, validateNativeId } from "./native-protocol.mjs";

const LOG_VERSION = 1;
const MANIFEST_VERSION = 1;
const LOG_RECORD_MAX = 1024 * 1024;
const MESSAGE_TEXT_MAX = 256 * 1024;
const ATTACHMENT_MAX = 32;
const ROOM_RE = /^[a-f0-9]{32}$/;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** @param {Uint8Array} bytes */
const sha256 = (bytes) => createHash("sha256").update(bytes).digest();

/** @param {string} root @param {string} roomId */
function roomDirectory(root, roomId) {
  if (!ROOM_RE.test(roomId)) throw new AgoraError("native room id must be 32 lowercase hexadecimal characters");
  return path.join(path.resolve(root), "native", "rooms", roomId);
}

/** @param {string} file @param {string} text */
async function writeDurableAtomic(file, text) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(text, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
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
  if (!record.message || record.message.id !== record.operationId || record.message.room !== manifest.roomId ||
      record.message.cursor !== nativeCursor(manifest.epoch, expectedSequence)) throw new AgoraError("native room log message identity does not match its committed position");
  const { recordDigest, ...unsigned } = record;
  if (!/^sha256:[a-f0-9]{64}$/.test(recordDigest ?? "") || nativeDigest(unsigned) !== recordDigest)
    throw new AgoraError(`native room log record digest mismatch at sequence ${expectedSequence}; do not advance or truncate it`);
  return record;
}

/** @param {import('node:fs/promises').FileHandle} handle @param {any} manifest */
async function scan(handle, manifest) {
  const size = (await handle.stat()).size;
  let position = 0;
  let recoveredTailBytes = 0;
  /** @type {any[]} */
  const records = [];
  while (position < size) {
    const header = Buffer.alloc(4);
    if (size - position < 4) { recoveredTailBytes = size - position; break; }
    const headerRead = await readExact(handle, header, position);
    if (headerRead < 4) throw new AgoraError(`native room log became unreadable at offset ${position}; do not advance or truncate it`);
    const length = header.readUInt32BE(0);
    if (length < 1 || length > LOG_RECORD_MAX) throw new AgoraError(`native room log declares an invalid ${length}-byte record at offset ${position}`);
    const body = Buffer.alloc(length + 32);
    if (size - position - 4 < body.length) { recoveredTailBytes = size - position; break; }
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
  if (recoveredTailBytes) {
    // Acceptance is sent only after sync. A partial final frame therefore has no valid receipt and
    // is safe to remove; a complete frame with a bad checksum is refused above, never "repaired".
    await handle.truncate(position);
    await handle.sync();
  }
  return { records, end: position, recoveredTailBytes };
}

export class NativeRoomStore {
  /** @param {string} directory @param {any} manifest @param {import('node:fs/promises').FileHandle} handle @param {any[]} records @param {number} end @param {number} recoveredTailBytes @param {() => Date} now */
  constructor(directory, manifest, handle, records, end, recoveredTailBytes, now) {
    this.directory = directory;
    this.logPath = path.join(directory, "room.frames");
    this.manifest = manifest;
    this.handle = handle;
    this.records = records;
    this.end = end;
    this.recoveredTailBytes = recoveredTailBytes;
    this.now = now;
    this.queue = Promise.resolve();
    this.closed = false;
    this.operations = new Map(records.map((r) => [`${r.message.author.id}\0${r.operationId}`, r]));
  }

  /** @param {{ root: string, roomId?: string, epoch?: string, hostAccountId: string, now?: () => Date }} options */
  static async create(options) {
    const roomId = options.roomId ?? randomUUID().replaceAll("-", "");
    const epoch = options.epoch ?? randomUUID().replaceAll("-", "");
    validateNativeEpoch(epoch);
    validateNativeId(options.hostAccountId, "host account id");
    const directory = roomDirectory(options.root, roomId);
    await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code === "EEXIST") throw new AgoraError(`native room ${roomId} already exists`);
      throw e;
    }
    try {
      const manifest = { version: MANIFEST_VERSION, roomId, epoch, hostAccountId: options.hostAccountId, createdAt: (options.now ?? (() => new Date()))().toISOString() };
      await writeDurableAtomic(path.join(directory, "room.json"), JSON.stringify(manifest, null, 2) + "\n");
      const log = await open(path.join(directory, "room.frames"), "wx+", 0o600);
      await log.sync();
      await log.close();
      return NativeRoomStore.open({ root: options.root, roomId, now: options.now });
    } catch (e) {
      await rm(directory, { recursive: true, force: true });
      throw e;
    }
  }

  /** @param {{ root: string, roomId: string, now?: () => Date }} options */
  static async open(options) {
    const directory = roomDirectory(options.root, options.roomId);
    let manifest;
    try { manifest = JSON.parse(await readFile(path.join(directory, "room.json"), "utf8")); }
    catch { throw new AgoraError(`native room ${options.roomId} has no valid manifest`); }
    if (manifest?.version !== MANIFEST_VERSION || manifest.roomId !== options.roomId || !ROOM_RE.test(manifest.roomId ?? "") ||
        !/^[A-Za-z0-9_-]{16,128}$/.test(manifest.hostAccountId ?? "")) throw new AgoraError(`native room ${options.roomId} manifest is invalid`);
    validateNativeEpoch(manifest.epoch);
    const handle = await open(path.join(directory, "room.frames"), "r+");
    try {
      const scanned = await scan(handle, manifest);
      return new NativeRoomStore(directory, manifest, handle, scanned.records, scanned.end, scanned.recoveredTailBytes, options.now ?? (() => new Date()));
    } catch (e) { await handle.close(); throw e; }
  }

  /**
   * The authenticated account id comes from the route-bound handler, never from the request body.
   * @param {{ operationId: string, authorName: string, authorKind?: 'human'|'agent'|'unknown', text: string, thread?: string, attachments?: unknown[] }} input
   * @param {{ accountId: string }} authenticated
   */
  async append(input, authenticated) {
    const run = this.queue.then(() => this.#append(input, authenticated));
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * @param {{ operationId: string, authorName: string, authorKind?: 'human'|'agent'|'unknown', text: string, thread?: string, attachments?: unknown[] }} input
   * @param {{ accountId: string }} authenticated
   */
  async #append(input, authenticated) {
    if (this.closed) throw new AgoraError("native room store is closed");
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
    const sequence = this.records.length + 1;
    const message = { id: input.operationId, room: this.manifest.roomId,
      ...(input.thread ? { thread: input.thread } : {}),
      author: { id: authenticated.accountId, name: payload.authorName, kind: payload.authorKind },
      text: input.text, ts: this.now().toISOString(), cursor: nativeCursor(this.manifest.epoch, sequence),
      ...(attachments?.length ? { attachments } : {}) };
    const unsigned = { version: LOG_VERSION, roomId: this.manifest.roomId, epoch: this.manifest.epoch, sequence, operationId: input.operationId,
      payloadDigest, previousDigest: this.records.at(-1)?.recordDigest ?? null, message };
    const record = { ...unsigned, recordDigest: nativeDigest(unsigned) };
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
    this.end += frame.length;
    this.records.push(record);
    this.operations.set(key, record);
    return { id: message.id, cursor: message.cursor, duplicate: false };
  }

  /** @param {{ since?: string, limit?: number }} [options] */
  read(options = {}) {
    if (this.closed) throw new AgoraError("native room store is closed");
    const limit = options.limit ?? 1000;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new AgoraError("native room read limit must be 1-10000");
    if (!options.since) return this.records.slice(-limit).map((r) => structuredClone(r.message));
    const cursor = parseNativeCursor(options.since);
    if (cursor.epoch !== this.manifest.epoch) throw new AgoraError(`native room cursor belongs to epoch ${cursor.epoch}, not live epoch ${this.manifest.epoch}; recover explicitly without advancing`);
    if (cursor.sequence > this.records.length) throw new AgoraError(`native room cursor ${cursor.sequence} exceeds committed sequence ${this.records.length}; recover explicitly without advancing`);
    return this.records.slice(cursor.sequence, cursor.sequence + limit).map((r) => structuredClone(r.message));
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
      recoveredTailBytes: this.recoveredTailBytes };
  }

  async close() {
    if (this.closed) return;
    await this.queue;
    this.closed = true;
    await this.handle.close();
  }
}
