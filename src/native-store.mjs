// @ts-check
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { AgoraError } from "./core.mjs";
import Kernel from "./native-cursor.kernel.mjs";
import BoardKernel from "./native-board.kernel.mjs";
import { nat as kernelNat } from "./kernel-nat.mjs";
import { nativeCursor, nativeDigest, nativeMessageId, parseNativeCursor, validateNativeEpoch, validateNativeId } from "./native-protocol.mjs";
import { AUTHOR_REF_PATTERN, CLIENT_NAME_PATTERN, ProtocolValidationError } from "./protocol/common.mjs";
import { validateBoardPayload } from "./protocol/operation.mjs";

/**
 * Log version 1 commits to a message's text inside its record digest. Log version 2
 * (docs/ANNOTATIONS.md) commits to the text by `message.textDigest` and keeps `message.text`
 * outside the digest, so a later purge can remove the text without breaking the chain; it is also
 * the only version that carries `annotation` records. A room's version is `room.json`'s
 * `logVersion` (absent is 1) and every record in its log carries that version.
 */
const LOG_VERSION = 1;
const LOG_VERSION_2 = 2;
const MANIFEST_VERSION = 1;
export const ANNOTATION_ACTS = Object.freeze(["edit", "withdraw", "pin", "unpin"]);
const TEXT_DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
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
const messageId = nativeMessageId;

/** The digest a version 2 record carries for a text: sha256 over its UTF-8 bytes. @param {string} text */
export const textDigest = (text) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

/**
 * The part of a record its `recordDigest` covers. Version 1: everything but the digest itself.
 * Version 2: also without `message.text` and `annotation.text`, which their `textDigest` commits to.
 * @param {any} unsigned the record without `recordDigest`
 */
function signedPart(unsigned) {
  if (unsigned.version !== LOG_VERSION_2) return unsigned;
  if (unsigned.message && "text" in unsigned.message) {
    const { text: _text, ...message } = unsigned.message;
    return { ...unsigned, message };
  }
  if (unsigned.annotation && "text" in unsigned.annotation) {
    const { text: _text, ...annotation } = unsigned.annotation;
    return { ...unsigned, annotation };
  }
  return unsigned;
}

/** @param {any} unsigned */
const recordDigestOf = (unsigned) => nativeDigest(signedPart(unsigned));

/** The log file of a generation: 0 is `room.frames`, N is `room.frames.<N>`. @param {number} generation */
export const generationFile = (generation) => generation === 0 ? "room.frames" : `room.frames.${generation}`;

/**
 * A stored message or annotation as a reader receives it: without its `textDigest`, which is the
 * record's own commitment rather than a field of the conversation. @param {any} stored
 */
function withoutTextDigest(stored) {
  const { textDigest: _digest, ...rest } = structuredClone(stored);
  return rest;
}

/** A refusal whose name is a property, so the service carries it on the wire as `code` and a caller
 * decides on the name, never on the prose. @param {string} code @param {string} detail */
function refusal(code, detail) {
  return Object.assign(new AgoraError(`${code}: ${detail}`), { code });
}

/** @param {string} root @param {string} roomId */
function roomDirectory(root, roomId) {
  if (!ROOM_RE.test(roomId)) throw new AgoraError("native room id must be 32 lowercase hexadecimal characters");
  return path.join(path.resolve(root), "native", "rooms", roomId);
}

/**
 * The rename may be refused on Windows while another process holds the target open without
 * share-delete (an indexer, an antivirus scan, a reader mid-open): EPERM, EBUSY or EACCES with the
 * temp file intact and the target untouched, so trying again is safe and usually lands within
 * milliseconds. Measured on a Windows CI runner: the committed-boundary publication of a
 * thousand fsync'd appends hit it after 31 seconds and the whole append refused with acceptance
 * unknown. Every other code (ENOENT, EXDEV, ENOSPC) is thrown at once, because there the rename
 * did not fail for a reason a moment cures. The same shape as core.mjs's `writeFileAtomic`.
 */
export const RENAME_RETRY = Object.freeze({ attempts: 8, codes: Object.freeze(["EPERM", "EBUSY", "EACCES"]), baseDelayMs: 10 });

/**
 * @param {string} file @param {string} text
 * @param {{ rename?: typeof rename, sleep?: (ms: number) => Promise<void>, attempts?: number }} [deps]
 *   injection for the tests that plant a refusal on the rename; the product passes nothing
 */
export async function writeDurableAtomic(file, text, deps = {}) {
  const renameFile = deps.rename ?? rename;
  const sleep = deps.sleep ?? ((/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const attempts = deps.attempts ?? RENAME_RETRY.attempts;
  if (!Number.isInteger(attempts) || attempts < 1) throw new AgoraError("native durable write needs at least one rename attempt");
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
    for (let attempt = 1; ; attempt++) {
      try { await renameFile(temp, file); break; }
      catch (error) {
        const code = /** @type {NodeJS.ErrnoException} */ (error)?.code;
        if (attempt >= attempts || typeof code !== "string" || !RENAME_RETRY.codes.includes(code)) throw error;
        await sleep(RENAME_RETRY.baseDelayMs * attempt);
      }
    }
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
  // a reference's lifetime is part of it: a durable attachment reads back as durable, so a reader
  // knows the room's custody holds its bytes (docs/ATTACHMENTS.md); metadata-only names none
  if (a.lifetime !== undefined && a.lifetime !== "offer" && a.lifetime !== "durable")
    throw new AgoraError("native attachment lifetime must be offer or durable");
  return { id: a.id, name: a.name, kind: a.kind, size: a.size, digest: a.digest,
    ...(a.lifetime !== undefined ? { lifetime: a.lifetime } : {}),
    ...(typeof a.mimetype === "string" ? { mimetype: a.mimetype.slice(0, 200) } : {}),
    ...(Number.isSafeInteger(a.width) && Number(a.width) > 0 ? { width: a.width } : {}),
    ...(Number.isSafeInteger(a.height) && Number(a.height) > 0 ? { height: a.height } : {}) };
}

/** A manifest's log version: absent is 1 (a room made before the field existed). @param {any} manifest @returns {1 | 2} */
function manifestLogVersion(manifest) {
  return manifest?.logVersion === LOG_VERSION_2 ? LOG_VERSION_2 : LOG_VERSION;
}

/**
 * An annotation record read back: its identity is its committed position, it names a message the
 * log already held, and only an edit carries a text, which must hash to its text digest.
 * @param {any} record @param {any} manifest @param {number} sequence @param {Map<string, any>} messages
 */
function validateAnnotationRecord(record, manifest, sequence, messages) {
  const at = `native room log annotation at sequence ${sequence}`;
  if (record.message || record.board) throw new AgoraError(`${at} carries a message or a board act; do not advance or truncate it`);
  const a = record.annotation;
  if (!a || typeof a !== "object" || Array.isArray(a) || a.id !== messageId(manifest.roomId, record.accountId, record.operationId) ||
      a.author?.id !== record.accountId || a.cursor !== nativeCursor(manifest.epoch, sequence) || typeof a.ts !== "string")
    throw new AgoraError(`${at} does not match its committed position; do not advance or truncate it`);
  if (!ANNOTATION_ACTS.includes(a.act) || typeof a.target !== "string" || !messages.has(a.target))
    throw new AgoraError(`${at} names no act or no earlier message; do not advance or truncate it`);
  if (a.via !== undefined && (typeof a.via !== "string" || !CLIENT_NAME_PATTERN.test(a.via)))
    throw new AgoraError(`${at} carries an invalid via; do not advance or truncate it`);
  if (a.author.ref !== undefined && (typeof a.author.ref !== "string" || !AUTHOR_REF_PATTERN.test(a.author.ref) || a.via === undefined))
    throw new AgoraError(`${at} carries an invalid author ref; do not advance or truncate it`);
  if (a.act === "edit") {
    if (!TEXT_DIGEST_RE.test(a.textDigest ?? "")) throw new AgoraError(`${at} is an edit without a text digest; do not advance or truncate it`);
    if (!("text" in a)) throw new AgoraError(`${at} has no text and no purge names it; do not advance or truncate it`);
    if (typeof a.text !== "string" || textDigest(a.text) !== a.textDigest)
      throw new AgoraError(`${at} carries a text that does not match its text digest; do not advance or truncate it`);
  } else if ("text" in a || "textDigest" in a) {
    throw new AgoraError(`${at} carries a text on a ${a.act}; do not advance or truncate it`);
  }
}

/**
 * The generation the committed boundary names: absent is 0. A purge is the only writer of a
 * generation above 0, and a version 1 room refuses purge, so a version 1 room is always at 0.
 * @param {any} boundary @param {any} manifest
 */
function boundaryGeneration(boundary, manifest) {
  const generation = boundary?.generation ?? 0;
  if (!Number.isSafeInteger(generation) || generation < 0)
    throw new AgoraError("native room committed boundary names an invalid generation; do not advance or truncate the log");
  if (generation > 0 && manifestLogVersion(manifest) !== LOG_VERSION_2)
    throw new AgoraError("native room committed boundary names a generation above 0 in a version 1 room; do not advance or truncate the log");
  return generation;
}

/**
 * @param {any} record @param {any} manifest @param {number} expectedSequence @param {string | null} expectedPreviousDigest
 * @param {Map<string, any>} [messages] the messages scanned so far, by id: an annotation's target must be one of them
 */
function validateRecord(record, manifest, expectedSequence, expectedPreviousDigest, messages = new Map()) {
  const logVersion = manifestLogVersion(manifest);
  if (!record || typeof record !== "object" || record.version !== logVersion || record.roomId !== manifest.roomId || record.epoch !== manifest.epoch)
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
  } else if (logVersion === LOG_VERSION_2 && record.kind === "annotation") {
    validateAnnotationRecord(record, manifest, expectedSequence, messages);
  } else {
    // version 1 reads exactly as before; version 2 knows its kinds
    if (logVersion === LOG_VERSION_2 && record.kind !== undefined)
      throw new AgoraError(`native room log record at sequence ${expectedSequence} has an unknown kind; do not advance or truncate it`);
    if (!record.message || record.message.id !== messageId(manifest.roomId, record.accountId, record.operationId) ||
        record.message.author?.id !== record.accountId || record.message.room !== manifest.roomId ||
        record.message.cursor !== nativeCursor(manifest.epoch, expectedSequence)) throw new AgoraError("native room log message identity does not match its committed position");
    // `via` and `author.ref` are optional; present, each has the shape the append admitted, and a
    // ref never stands without the via that scoped it
    const { via, author } = record.message;
    if (via !== undefined && (typeof via !== "string" || !CLIENT_NAME_PATTERN.test(via)))
      throw new AgoraError(`native room log message at sequence ${expectedSequence} carries an invalid via; do not advance or truncate it`);
    if (author.ref !== undefined && (typeof author.ref !== "string" || !AUTHOR_REF_PATTERN.test(author.ref)))
      throw new AgoraError(`native room log message at sequence ${expectedSequence} carries an invalid author ref; do not advance or truncate it`);
    if (author.ref !== undefined && via === undefined)
      throw new AgoraError(`native room log message at sequence ${expectedSequence} carries an author ref without a via; do not advance or truncate it`);
    if (logVersion === LOG_VERSION_2) {
      const m = record.message;
      if (!TEXT_DIGEST_RE.test(m.textDigest ?? ""))
        throw new AgoraError(`native room log message at sequence ${expectedSequence} carries no text digest; do not advance or truncate it`);
      // the text is outside the record digest, so the digest of the text is what holds it
      if (!("text" in m))
        throw new AgoraError(`native room log message at sequence ${expectedSequence} has no text and no purge names it; do not advance or truncate it`);
      if (typeof m.text !== "string" || textDigest(m.text) !== m.textDigest)
        throw new AgoraError(`native room log message at sequence ${expectedSequence} carries a text that does not match its text digest; do not advance or truncate it`);
    }
  }
  const { recordDigest, ...unsigned } = record;
  if (!/^sha256:[a-f0-9]{64}$/.test(recordDigest ?? "") || recordDigestOf(unsigned) !== recordDigest)
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
  /** @type {Map<string, any>} the messages scanned so far, for the annotations that name them */
  const messages = new Map();
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
    const record = validateRecord(parsed, manifest, records.length + 1, records.at(-1)?.recordDigest ?? null, messages);
    records.push(record);
    if (record.message) messages.set(record.message.id, record.message);
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

/**
 * The records a native room's log holds (docs/ANNOTATIONS.md, docs/PURGE.md). Every record carries
 * `{ version, roomId, epoch, sequence, accountId, operationId, payloadDigest, previousDigest,
 * recordDigest }`; `version` is the room's log version and `recordDigest` chains them.
 *
 * - message: `{ message: { id, room, thread?, author: { id, name, kind, ref? }, via?, text, ts,
 *   cursor, attachments? } }`. Version 2 adds `message.textDigest` (sha256 of the UTF-8 text) inside
 *   the digested part and keeps `message.text` outside it: `recordDigest` is computed over the record
 *   with `message.text` removed, and `payloadDigest` names `textDigest` where version 1 names `text`.
 *   On scan a present text must hash to its `textDigest`.
 * - board: `{ kind: "board", board, boardId, cursor, expiresAt?, leaseMs?, broken?, actor? }`.
 * - annotation (version 2 only): `{ kind: "annotation", annotation: { id, act, target,
 *   author: { id, name, kind, ref? }, via?, textDigest?, text?, ts, cursor } }`; `act` is edit,
 *   withdraw, pin or unpin, `target` a message the log already holds, and only an edit carries a
 *   text, held as a message's is (`annotation.text` outside the digest).
 *
 * Readers receive messages and annotations without `textDigest`. The committed boundary
 * (`committed.json`) is `{ version: 1, roomId, epoch, sequence, end, digest, generation? }`; an
 * absent generation is 0, the file `room.frames`, and generation N is `room.frames.<N>`.
 */
export class NativeRoomStore {
  /** @param {string} directory @param {any} manifest @param {any} boundary @param {import('node:fs/promises').FileHandle} handle @param {{server: net.Server, endpoint: {host:string,port:number}, identity:string}} writer @param {any[]} records @param {number} end @param {number} recoveredTailBytes @param {() => Date} now */
  constructor(directory, manifest, boundary, handle, writer, records, end, recoveredTailBytes, now) {
    this.directory = directory;
    /** `room.json`'s `logVersion`, absent read as 1. @type {1 | 2} */
    this.logVersion = manifestLogVersion(manifest);
    /** The log generation the committed boundary names (absent is 0). Read side only here: a purge
     * (docs/PURGE.md) is the one writer of a generation above 0. */
    this.generation = boundaryGeneration(boundary, manifest);
    this.logPath = path.join(directory, generationFile(this.generation));
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
    /** Every chat message's id to its record's index: how a thread root is verified without a scan.
     * Derived from the log alone and rebuilt on every open, like the operation index above.
     * @type {Map<string, number>} */
    this.messageIndex = new Map();
    /** A thread root's id to the indices of the records that reply in it, ascending; rebuilt on open.
     * @type {Map<string, number[]>} */
    this.threadIndex = new Map();
    /** The messages a withdraw annotation has named: no annotation is admitted on one again.
     * Derived from the log alone and rebuilt on every open. @type {Set<string>} */
    this.withdrawn = new Set();
    /** A message's id to the indices of the annotation records that name it, ascending; rebuilt on open.
     * @type {Map<string, number[]>} */
    this.annotationIndex = new Map();
    records.forEach((r, i) => { this.#applyBoard(r); this.#index(r, i); });
  }

  /**
   * `logVersion` 2 makes a room whose records commit to text by digest and which carries
   * annotations (docs/ANNOTATIONS.md); the default stays 1, the format every room had before, so a
   * caller that names nothing writes exactly what it always wrote. The seat service makes version 2.
   * @param {{ root: string, roomId?: string, epoch?: string, hostAccountId: string, recordLimit?: number, logVersion?: 1 | 2, now?: () => Date }} options
   */
  static async create(options) {
    const logVersion = options.logVersion ?? LOG_VERSION;
    if (logVersion !== LOG_VERSION && logVersion !== LOG_VERSION_2) throw new AgoraError("native room log version must be 1 or 2");
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
        createdAt: (options.now ?? (() => new Date()))().toISOString(),
        // a version 1 room's manifest stays the bytes it always was: absent reads as 1
        ...(logVersion === LOG_VERSION_2 ? { logVersion } : {}) };
      await writeDurableAtomic(path.join(directory, "room.json"), JSON.stringify(manifest, null, 2) + "\n");
      log = await open(path.join(directory, "room.frames"), "wx+", 0o600);
      await log.sync();
      await syncDirectory(directory);
      const boundary = { version: 1, roomId, epoch, sequence: 0, end: 0, digest: null,
        ...(logVersion === LOG_VERSION_2 ? { generation: 0 } : {}) };
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
          manifest.recordLimit < 1 || manifest.recordLimit > 10_000_000 ||
          (manifest.logVersion !== undefined && manifest.logVersion !== LOG_VERSION && manifest.logVersion !== LOG_VERSION_2))
        throw new AgoraError(`native room ${options.roomId} manifest is invalid`);
      validateNativeEpoch(manifest.epoch);
      // the boundary names the generation, so it is read before the log it points at is opened
      let boundary;
      try { boundary = JSON.parse(await readFile(path.join(directory, "committed.json"), "utf8")); }
      catch { throw new AgoraError(`native room ${options.roomId} has no valid committed boundary`); }
      const generation = boundaryGeneration(boundary, manifest);
      handle = await open(path.join(directory, generationFile(generation)), "r+");
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
   * The authenticated account id comes from the route-bound handler, never from the request body;
   * `via`, when present, is the client name the local connection declared in its hello, handed in
   * by the service beside the account (cooperative attribution, not authentication).
   * @param {any} input
   * @param {{ accountId: string, via?: string }} authenticated
   */
  async append(input, authenticated) {
    const run = this.queue.then(() => this.#append(input, authenticated));
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * @param {any} input
   * @param {{ accountId: string, via?: string }} authenticated
   */
  async #append(input, authenticated) {
    if (this.closed) throw new AgoraError("native room store is closed");
    if (/** @type {any} */ (input).kind === "board") return this.#appendBoard(/** @type {any} */ (input), authenticated);
    if (/** @type {any} */ (input).kind === "annotation") return this.#appendAnnotation(/** @type {any} */ (input), authenticated);
    if (input.kind !== undefined && input.kind !== "message") throw refusal("append-kind-invalid", "an append is a message, a board act or an annotation");
    validateNativeId(input.operationId, "operation id");
    validateNativeId(authenticated.accountId, "account id");
    // `via` is the client name the CONNECTION declared, handed in beside the account by the service;
    // an operation never names its own. `authorRef` is that client's id for the person it posted for,
    // so it exists only on a connection that declared a name. Both are attribution, never identity.
    const via = authenticated.via;
    if (via !== undefined && (typeof via !== "string" || !CLIENT_NAME_PATTERN.test(via)))
      throw refusal("client-name-invalid", "a client name is a lowercase letter then 1-39 lowercase letters, digits or hyphens");
    if (input.via !== undefined)
      throw refusal("operation-via-refused", "via is stamped from the connection's declared client name, never taken from an operation");
    if (input.authorRef !== undefined && via === undefined)
      throw refusal("author-ref-without-client", "an authorRef is an app client's own id for the person, and this connection declared no client name");
    if (input.authorRef !== undefined && (typeof input.authorRef !== "string" || !AUTHOR_REF_PATTERN.test(input.authorRef)))
      throw refusal("author-ref-invalid", "an authorRef is 1-64 letters, digits or . _ @ + -");
    if (typeof input.authorName !== "string" || !input.authorName.trim() || input.authorName.length > 120) throw new AgoraError("native post needs a bounded author label");
    if (input.authorKind && !["human", "agent", "unknown", "system"].includes(input.authorKind)) throw new AgoraError("native post author kind is invalid");
    if (typeof input.text !== "string" || Buffer.byteLength(input.text) > MESSAGE_TEXT_MAX) throw new AgoraError(`native post text exceeds ${MESSAGE_TEXT_MAX} bytes`);
    if (input.thread !== undefined) validateNativeId(input.thread, "thread id");
    if (input.attachments && (!Array.isArray(input.attachments) || input.attachments.length > ATTACHMENT_MAX)) throw new AgoraError(`native post carries more than ${ATTACHMENT_MAX} attachments`);
    const attachments = input.attachments?.map(validateAttachment);
    const v2 = this.logVersion === LOG_VERSION_2;
    // version 2 commits to the text by its digest everywhere a digest covers it, the payload's
    // included, so removing the text later leaves every digest standing
    const digestOfText = v2 ? textDigest(input.text) : undefined;
    const payload = { accountId: authenticated.accountId, authorName: input.authorName.trim(), authorKind: input.authorKind ?? "agent",
      ...(v2 ? { textDigest: digestOfText } : { text: input.text }),
      ...(input.thread ? { thread: input.thread } : {}), ...(attachments?.length ? { attachments } : {}),
      ...(via !== undefined ? { via } : {}), ...(input.authorRef !== undefined ? { authorRef: input.authorRef } : {}) };
    const payloadDigest = nativeDigest(payload);
    const key = `${authenticated.accountId}\0${input.operationId}`;
    const existing = this.operations.get(key);
    if (existing) {
      if (existing.payloadDigest !== payloadDigest || !existing.message) throw new AgoraError(`native operation ${input.operationId} was already committed with different bytes`);
      return { id: existing.message.id, cursor: existing.message.cursor, duplicate: true };
    }
    // a reply names a root the room holds and that is itself top-level: one level, as on Slack
    if (input.thread !== undefined) this.threadRoot(input.thread);
    if (this.records.length >= this.manifest.recordLimit)
      throw new AgoraError(`native room reached its ${this.manifest.recordLimit}-record resident limit; retain or archive explicitly before accepting more`);
    const sequence = this.records.length + 1;
    const id = messageId(this.manifest.roomId, authenticated.accountId, input.operationId);
    const message = { id, room: this.manifest.roomId,
      ...(input.thread ? { thread: input.thread } : {}),
      author: { id: authenticated.accountId, name: payload.authorName, kind: payload.authorKind,
        ...(input.authorRef !== undefined ? { ref: input.authorRef } : {}) },
      ...(via !== undefined ? { via } : {}),
      ...(v2 ? { textDigest: digestOfText } : {}),
      text: input.text, ts: this.now().toISOString(), cursor: nativeCursor(this.manifest.epoch, sequence),
      ...(attachments?.length ? { attachments } : {}) };
    const unsigned = { version: this.logVersion, roomId: this.manifest.roomId, epoch: this.manifest.epoch, sequence,
      accountId: authenticated.accountId, operationId: input.operationId,
      payloadDigest, previousDigest: this.records.at(-1)?.recordDigest ?? null, message };
    const record = { ...unsigned, recordDigest: recordDigestOf(unsigned) };
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
   * @param {{ kind: 'board', operationId: string, payload: unknown, authorKind?: string, authorName?: string, session?: string }} input
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
    // Admission is decided by the kernel generated from spec/board.bend, whose laws the checker
    // proves (spec/BOARD-LAWS.bend): one live holder per subject, an expired lease is no holder,
    // release and renew need the holder's account, lease id and live fence, break is a human verb
    // that names what it drops. Ids are interned to Nats for this one judgement (only equality is
    // compared) and instants are epoch milliseconds; the lease length the record will carry is
    // still computed below by #leaseMs, which owns the cap and fallback policy.
    /** @type {Map<string, bigint>} */
    const interned = new Map();
    /** @type {Map<bigint, string>} the way back from a verdict's Nats to the store's ids */
    const ids = new Map();
    /** @param {string} id */
    const nat = (id) => { if (!interned.has(id)) { interned.set(id, BigInt(interned.size + 1)); ids.set(/** @type {bigint} */ (interned.get(id)), id); } return /** @type {bigint} */ (interned.get(id)); };
    const holder = stored
      ? { $: "Held", account: nat(stored.accountId), lease: nat(stored.leaseId), fence: nat(stored.fence), expires: kernelNat(Math.max(0, Date.parse(stored.expiresAt) || 0), "the stored expiry") }
      : { $: "NoHolder" };
    const me = nat(authenticated.accountId);
    const fenceNamed = payload.action === "renew" || payload.action === "release" ? payload.fence : "";
    // the lease the record will carry is the one the kernel judges with: #leaseMs owns the cap and
    // fallback policy and refuses before the kernel sees a value; the kernel's Held{expires} is then
    // the expiry the store keeps, not a placeholder the store recomputes beside it
    const leaseMs = payload.action === "claim" || payload.action === "renew" ? this.#leaseMs(payload, live) : undefined;
    const act = payload.action === "claim" ? { $: "Claim", account: me, op: nat(input.operationId), lease_ms: kernelNat(/** @type {number} */ (leaseMs), "the lease") }
      : payload.action === "renew" ? { $: "Renew", account: me, lease: nat(payload.leaseId), fence: nat(payload.fence), lease_ms: kernelNat(/** @type {number} */ (leaseMs), "the lease") }
      : payload.action === "release" ? { $: "Release", account: me, lease: nat(payload.leaseId), fence: nat(payload.fence) }
      : payload.action === "break" ? { $: "Break", human: input.authorKind === "human" }
      : { $: "Contest" };
    // every number the kernel receives is checked against the interpreter's Nat ceiling first
    // (src/kernel-nat.mjs): the kernel aborts past it with a bare string, the store refuses by name
    const now = kernelNat(this.now().getTime(), "the clock");
    if (leaseMs !== undefined) kernelNat(now + BigInt(leaseMs), "the expiry the kernel would compute");
    const verdict = BoardKernel.judge(act, holder, kernelNat(this.records.length + 1, "the cursor"), now);
    if (verdict.$ === "Held_by_another" && live)
      throw new AgoraError(`native board subject ${payload.subject} is held at ${live.cursor} by ${live.accountId} until ${live.expiresAt}`);
    if (verdict.$ === "Not_the_holder")
      throw new AgoraError(`native board subject ${payload.subject} is not held by this account under that lease`);
    if (verdict.$ === "Fence_mismatch" && live)
      throw new AgoraError(`native board subject ${payload.subject} fence is ${live.fence}, not ${fenceNamed}`);
    if (verdict.$ === "Not_human")
      throw new AgoraError("native board break is a human verb");
    if (verdict.$ === "Nothing_to_break")
      throw new AgoraError(`native board subject ${payload.subject} has no holder to break`);
    if (verdict.$ !== "Applied")
      throw new AgoraError(`native board verdict ${verdict.$} on ${payload.subject} names no holder to report`);
    if (this.records.length >= this.manifest.recordLimit)
      throw new AgoraError(`native room reached its ${this.manifest.recordLimit}-record resident limit; retain or archive explicitly before accepting more`);
    const sequence = this.records.length + 1;
    const cursor = nativeCursor(this.manifest.epoch, sequence);
    const boardId = messageId(this.manifest.roomId, authenticated.accountId, input.operationId);
    const payloadDigest = nativeDigest({ accountId: authenticated.accountId, board: payload });
    // What the store keeps is what the kernel decided. Applied{Held{account, lease, fence, expires}}
    // comes back as ids through the interning map; its fence must be this record's own cursor and
    // its account and lease must be the ones the record names, or the store's wiring and the
    // kernel's reading have parted and nothing downstream may trust either. The expiry the record
    // carries is the kernel's, so #applyBoard on reopen re-derives from the record exactly the
    // holder the kernel named. A contest applies the stored holder unchanged and carries no lease.
    const kernelHolder = verdict.holder.$ === "Held"
      ? { accountId: ids.get(verdict.holder.account), leaseId: ids.get(verdict.holder.lease), fence: Number(verdict.holder.fence), expiresAt: new Date(Number(verdict.holder.expires)).toISOString() }
      : null;
    const askedLeaseId = payload.action === "renew" ? payload.leaseId : input.operationId;
    if (kernelHolder && (payload.action === "claim" || payload.action === "renew")) {
      if (kernelHolder.fence !== sequence || kernelHolder.accountId !== authenticated.accountId || kernelHolder.leaseId !== askedLeaseId)
        throw new AgoraError(`native board kernel named a holder the store did not ask for on ${payload.subject}: refusing before commit`);
    }
    const expiresAt = kernelHolder && (payload.action === "claim" || payload.action === "renew") ? kernelHolder.expiresAt : undefined;
    const unsigned = { version: this.logVersion, roomId: this.manifest.roomId, epoch: this.manifest.epoch, sequence,
      accountId: authenticated.accountId, operationId: input.operationId, kind: "board",
      payloadDigest, previousDigest: this.records.at(-1)?.recordDigest ?? null,
      board: payload, boardId, cursor,
      ...(expiresAt ? { expiresAt, leaseMs } : {}),
      ...(payload.action === "break" && stored ? { broken: { accountId: stored.accountId, cursor: stored.cursor, expiresAt: stored.expiresAt },
        actor: { name: input.authorName ?? "", kind: input.authorKind ?? "unknown", session: input.session ?? "default" } } : {}) };
    const record = { ...unsigned, recordDigest: recordDigestOf(unsigned) };
    await this.#commit(record, key);
    this.#applyBoard(record);
    /** @param {{ accountId: string, cursor: string, expiresAt: string } | undefined} h */
    const holderView = (h) => h ? { accountId: h.accountId, cursor: h.cursor, expiresAt: h.expiresAt } : undefined;
    return { id: boardId, cursor, duplicate: false, kind: "board",
      ...(payload.action === "claim" ? { held: true, leaseId: input.operationId, fence: cursor, expiresAt } : {}),
      ...(payload.action === "renew" ? { held: true, leaseId: payload.leaseId, fence: cursor, expiresAt } : {}),
      ...(payload.action === "contest" ? { held: Boolean(live), holder: holderView(stored) } : {}),
      ...(payload.action === "break" ? { broken: true, holder: holderView(stored),
        actor: { name: input.authorName ?? "", kind: input.authorKind ?? "unknown", session: input.session ?? "default" } } : {}) };
  }

  /**
   * An annotation (docs/ANNOTATIONS.md): an edit, withdraw, pin or unpin of a message the room
   * holds, appended as its own record after it; the message's record never changes. Version 2 rooms
   * only, so a version 1 log keeps exactly the record kinds an older build reads. An edit's text is
   * held like a message's: by its digest inside the record digest, the text itself outside it.
   * Edit and withdraw are the author's own: the target's account must be the append's, and where the
   * target carries an `author.ref` (an app's id for the person) the append must carry the same ref
   * from the same client. A target with no ref is answered for by an append with no ref, so a person
   * an app names never edits a message the seat's own agents posted. Who may pin is the host's call,
   * made before it appends.
   * @param {{ kind: 'annotation', operationId: string, annotation: unknown, authorKind?: string, authorName?: string, authorRef?: string, via?: unknown }} input
   * @param {{ accountId: string, via?: string }} authenticated
   */
  async #appendAnnotation(input, authenticated) {
    if (this.logVersion !== LOG_VERSION_2)
      throw refusal("annotation-unsupported-log-version", `native room ${this.manifest.roomId} is a version 1 room; annotations need a version 2 room`);
    validateNativeId(input.operationId, "operation id");
    validateNativeId(authenticated.accountId, "account id");
    const via = authenticated.via;
    if (via !== undefined && (typeof via !== "string" || !CLIENT_NAME_PATTERN.test(via)))
      throw refusal("client-name-invalid", "a client name is a lowercase letter then 1-39 lowercase letters, digits or hyphens");
    if (input.via !== undefined)
      throw refusal("operation-via-refused", "via is stamped from the connection's declared client name, never taken from an operation");
    if (input.authorRef !== undefined && via === undefined)
      throw refusal("author-ref-without-client", "an authorRef is an app client's own id for the person, and this connection declared no client name");
    if (input.authorRef !== undefined && (typeof input.authorRef !== "string" || !AUTHOR_REF_PATTERN.test(input.authorRef)))
      throw refusal("author-ref-invalid", "an authorRef is 1-64 letters, digits or . _ @ + -");
    if (typeof input.authorName !== "string" || !input.authorName.trim() || input.authorName.length > 120) throw new AgoraError("native annotation needs a bounded author label");
    if (input.authorKind && !["human", "agent", "unknown", "system"].includes(input.authorKind)) throw new AgoraError("native annotation author kind is invalid");
    const raw = input.annotation;
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw refusal("annotation-invalid", "an annotation is { act, target, text? }");
    const a = /** @type {Record<string, unknown>} */ (raw);
    const unknown = Object.keys(a).filter((k) => !["act", "target", "text"].includes(k));
    if (unknown.length) throw refusal("annotation-invalid", `an annotation carries only act, target and text, not ${unknown.join(", ")}`);
    if (typeof a.act !== "string" || !ANNOTATION_ACTS.includes(a.act))
      throw refusal("annotation-invalid", "an annotation's act is edit, withdraw, pin or unpin");
    if (typeof a.target !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(a.target))
      throw refusal("annotation-invalid", "an annotation's target is a message id");
    if (a.act === "edit") {
      if (typeof a.text !== "string" || Buffer.byteLength(a.text) > MESSAGE_TEXT_MAX)
        throw refusal("annotation-invalid", `an edit carries a text of at most ${MESSAGE_TEXT_MAX} bytes`);
    } else if (a.text !== undefined) {
      throw refusal("annotation-invalid", `a ${a.act} carries no text`);
    }
    const act = /** @type {'edit' | 'withdraw' | 'pin' | 'unpin'} */ (a.act);
    const target = a.target;
    const digestOfText = act === "edit" ? textDigest(/** @type {string} */ (a.text)) : undefined;
    const authorName = input.authorName.trim();
    const authorKind = input.authorKind ?? "agent";
    const payload = { accountId: authenticated.accountId, authorName, authorKind, act, target,
      ...(digestOfText ? { textDigest: digestOfText } : {}),
      ...(via !== undefined ? { via } : {}), ...(input.authorRef !== undefined ? { authorRef: input.authorRef } : {}) };
    const payloadDigest = nativeDigest({ annotation: payload });
    const key = `${authenticated.accountId}\0${input.operationId}`;
    const existing = this.operations.get(key);
    if (existing) {
      if (existing.payloadDigest !== payloadDigest || !existing.annotation)
        throw new AgoraError(`native operation ${input.operationId} was already committed with different bytes`);
      return { id: existing.annotation.id, cursor: existing.annotation.cursor, duplicate: true, kind: "annotation" };
    }
    const at = this.messageIndex.get(target);
    if (at === undefined)
      throw refusal("annotation-target-unknown", `native room ${this.manifest.roomId} holds no message ${target}`);
    if (this.withdrawn.has(target))
      throw refusal("annotation-target-withdrawn", `message ${target} is withdrawn; nothing more is annotated on it`);
    const message = this.records[at].message;
    if (act === "edit" || act === "withdraw") {
      const sameRef = message.author.ref === input.authorRef && (message.author.ref === undefined || message.via === via);
      if (message.author.id !== authenticated.accountId || !sameRef)
        throw refusal("annotation-not-author", `only the author of message ${target} may ${act} it`);
    }
    if (this.records.length >= this.manifest.recordLimit)
      throw new AgoraError(`native room reached its ${this.manifest.recordLimit}-record resident limit; retain or archive explicitly before accepting more`);
    const sequence = this.records.length + 1;
    const annotation = { id: messageId(this.manifest.roomId, authenticated.accountId, input.operationId), act, target,
      author: { id: authenticated.accountId, name: authorName, kind: authorKind,
        ...(input.authorRef !== undefined ? { ref: input.authorRef } : {}) },
      ...(via !== undefined ? { via } : {}),
      ...(digestOfText ? { textDigest: digestOfText, text: /** @type {string} */ (a.text) } : {}),
      ts: this.now().toISOString(), cursor: nativeCursor(this.manifest.epoch, sequence) };
    const unsigned = { version: this.logVersion, roomId: this.manifest.roomId, epoch: this.manifest.epoch, sequence,
      accountId: authenticated.accountId, operationId: input.operationId, kind: "annotation",
      payloadDigest, previousDigest: this.records.at(-1)?.recordDigest ?? null, annotation };
    const record = { ...unsigned, recordDigest: recordDigestOf(unsigned) };
    await this.#commit(record, key);
    return { id: annotation.id, cursor: annotation.cursor, duplicate: false, kind: "annotation" };
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
      end: start + frame.length, digest: record.recordDigest,
      // the generation is kept as the boundary carried it; a version 1 boundary never names one
      ...(this.boundary.generation !== undefined ? { generation: this.generation } : {}) };
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
    this.#index(record, this.records.length - 1);
  }

  /** @param {{ since?: string, limit?: number, thread?: string }} [options] */
  read(options = {}) {
    return this.view(options).messages;
  }

  /**
   * A read and the committed sequence it accounts for (`through`).
   *
   * The room view is the one ordered sequence, replies included. A `thread` narrows it to that
   * thread's root and its replies, ascending, and is a VIEW over what the read already selected,
   * never a second plan: with `since`, the proven kernel selects the records after the cursor
   * (`limit` bounds the records scanned, not the messages returned) and the view keeps the thread's;
   * `through` is the end of that scan, so a thread reader's position advances over the records
   * outside its thread and stays a room position. Without `since`, a thread view is its own newest
   * `limit` messages, found through the thread index rather than a scan, and accounts for
   * everything committed. A root the room does not hold, or one that is itself a reply, is refused
   * by name before anything is read.
   * @param {{ since?: string, limit?: number, thread?: string }} [options]
   */
  view(options = {}) {
    if (this.closed) throw new AgoraError("native room store is closed");
    const limit = options.limit ?? 1000;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new AgoraError("native room read limit must be 1-10000");
    const thread = options.thread;
    if (thread !== undefined) this.threadRoot(thread);
    /** @param {any} m */
    const inView = (m) => thread === undefined || m.id === thread || m.thread === thread;
    /** @param {any[]} records */
    const messages = (records) => records.filter((r) => r.message && inView(r.message)).map((r) => withoutTextDigest(r.message));
    /** An annotation is in a thread view when the message it names is. @param {any} a */
    const annotationInView = (a) => thread === undefined || inView(this.records[/** @type {number} */ (this.messageIndex.get(a.target))].message);
    /** @param {any[]} records */
    const annotations = (records) => records.filter((r) => r.kind === "annotation" && annotationInView(r.annotation)).map((r) => withoutTextDigest(r.annotation));
    if (!options.since) {
      if (thread === undefined) {
        const window = this.records.slice(-limit);
        return { messages: messages(window), annotations: annotations(window), through: this.records.length };
      }
      const at = /** @type {number} */ (this.messageIndex.get(thread));
      const indices = [at, ...(this.threadIndex.get(thread) ?? [])].sort((a, b) => a - b).slice(-limit);
      // the annotations on the window's messages, from the oldest message in it on
      const from = indices[0] ?? 0;
      const named = indices.flatMap((i) => this.annotationIndex.get(this.records[i].message.id) ?? []).filter((i) => i >= from).sort((a, b) => a - b);
      return { messages: indices.map((i) => withoutTextDigest(this.records[i].message)),
        annotations: named.map((i) => withoutTextDigest(this.records[i].annotation)), through: this.records.length };
    }
    const cursor = parseNativeCursor(options.since);
    // The plan (which sequences a read delivers, or a refusal that advances nothing) is decided by
    // the kernel generated from spec/cursor.bend, whose laws the checker proves: a foreign epoch and
    // a future sequence are refused, and a delivery is exactly the rows after the cursor, capped by
    // the limit and by the committed sequence (spec/LAWS.bend).
    const plan = Kernel.plan(cursor.epoch === this.manifest.epoch, kernelNat(this.records.length, "the committed sequence"), kernelNat(cursor.sequence, "the cursor sequence"), kernelNat(limit, "the read limit"));
    if (plan.$ === "RefusedEpoch") throw new AgoraError(`native room cursor belongs to epoch ${cursor.epoch}, not live epoch ${this.manifest.epoch}; recover explicitly without advancing`);
    if (plan.$ === "RefusedFuture") throw new AgoraError(`native room cursor ${cursor.sequence} exceeds committed sequence ${this.records.length}; recover explicitly without advancing`);
    const selected = this.records.slice(Number(plan.from) - 1, Number(plan.to));
    return { messages: messages(selected), annotations: annotations(selected), through: Number(plan.to) };
  }

  /**
   * The root of a thread, or a refusal by name: the room holds no message with that id
   * (`thread-root-unknown`), or that message is itself a reply (`thread-root-not-top-level`; a
   * thread is one level). Answered from the message index, never a scan.
   * @param {string} id
   */
  threadRoot(id) {
    const at = this.messageIndex.get(id);
    if (at === undefined)
      throw refusal("thread-root-unknown", `native room ${this.manifest.roomId} holds no message ${id}; a thread is named by its root message's id`);
    const root = this.records[at].message;
    if (root.thread !== undefined)
      throw refusal("thread-root-not-top-level", `message ${id} is a reply in thread ${root.thread}; a thread is one level, so reply to its root ${root.thread}`);
    return structuredClone(root);
  }

  /** @param {any} record @param {number} index */
  #index(record, index) {
    if (record.kind === "annotation") {
      const { act, target } = record.annotation;
      if (act === "withdraw") this.withdrawn.add(target);
      const named = this.annotationIndex.get(target);
      if (named) named.push(index);
      else this.annotationIndex.set(target, [index]);
      return;
    }
    if (!record.message) return;
    this.messageIndex.set(record.message.id, index);
    const thread = record.message.thread;
    if (thread === undefined) return;
    const replies = this.threadIndex.get(thread);
    if (replies) replies.push(index);
    else this.threadIndex.set(thread, [index]);
  }

  /**
   * The live holders: a lease that has expired is no holder to any verb (an expired subject is
   * claimed, a stale renew is refused as not-the-holder), so it is not listed as held either.
   * The stored record stays in the map until a claim replaces it, which is what `#liveHolder`
   * reads through; measured by the model-based fuzz (scripts/fuzz-native-store.mjs) before the
   * filter, board() listed leases no verb honoured.
   * @returns {{ subject: string, accountId: string, cursor: string, leaseId: string, fence: string, expiresAt: string, leaseMs: number }[]}
   */
  board() {
    if (this.closed) throw new AgoraError("native room store is closed");
    return [...this.holders.entries()].filter(([subject]) => this.#liveHolder(subject)).map(([subject, h]) => ({ subject, ...h }));
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
      recordLimit: this.manifest.recordLimit, recoveredTailBytes: this.recoveredTailBytes, logVersion: this.logVersion };
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
