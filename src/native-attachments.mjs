// @ts-check
/**
 * Durable attachments in native rooms: the service half. The contract is docs/ATTACHMENTS.md.
 *
 * The seat service calls two functions here and nothing else: `handleAttachmentFrame` for every
 * `attachment-*` frame on a LOCAL connection (a member session never reaches it: `memberMayRequest`
 * refuses the type first), and `assertDurableAttachments` before every message append. An
 * attachment with no `lifetime` (metadata only, as a native record has always been able to carry)
 * passes exactly as before.
 *
 * Custody: `<room directory>/attachments/sha256-<hex>`, no extension, mode 0600, one file per
 * distinct content. An upload is written to a temp file beside it (`.upload-<uploadId>.tmp`),
 * hashed as it arrives, and installed at commit by fsync and rename, so a blob is either the whole
 * verified content or absent: a crash before the rename leaves only a temp file, which no lookup
 * here ever reads and the next begin in that room sweeps once it is older than the upload limit.
 *
 * An attachment's id derives from its room and its digest (`durableAttachmentId`), so nothing maps
 * ids to blobs: an id that does not derive names nothing.
 *
 * Beside each blob, `sha256-<hex>.type` is its custody record: `{ kind, mimetype }` as recorded at
 * the first install (the kind the bytes prove; the type `recordedMimetype` keeps). It is written
 * before the blob's rename and removed if that rename fails, so an installed blob always has one.
 * Reads and appends take the type from it, never from a client's claim.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { AgoraError } from "./core.mjs";
import { RENAME_RETRY, writeDurableAtomic } from "./native-store.mjs";
import { NATIVE_PROTOCOL } from "./native-protocol.mjs";
import { ATTACHMENT_SNIFF_BYTES, detectAttachmentType, durableAttachmentId, validateWireAttachment } from "./protocol/attachment.mjs";

/** The limits the custody enforces, in one place. */
export const ATTACHMENT_LIMITS = Object.freeze({
  /** one attachment */
  maxBytes: 25 * 1024 * 1024,
  /** attachments per message (the store's own ceiling of 32 stays as the outer bound) */
  perMessage: 10,
  /** a room's default quota; `room.json` may set `attachmentQuota` */
  roomQuotaBytes: 2 * 1024 * 1024 * 1024,
  /** an upload not committed within this is dropped */
  uploadTtlMs: 10 * 60 * 1000,
  /** uploads in flight on one connection */
  inFlightPerConnection: 4,
  /** the largest chunk a frame carries, and the largest read */
  chunkMax: 262144,
});

/** The request frames this module answers. */
export const ATTACHMENT_FRAME_TYPES = Object.freeze(["attachment-begin", "attachment-chunk", "attachment-commit", "attachment-read"]);

/** Every refusal code the custody can answer with. */
export const ATTACHMENT_REFUSALS = Object.freeze([
  "attachment-too-large", "attachment-quota", "attachment-digest-mismatch", "attachment-size-mismatch",
  "attachment-upload-unknown", "attachment-upload-expired", "attachment-unknown", "attachments-unsupported",
]);

/** @param {unknown} type @returns {boolean} */
export function isAttachmentFrame(type) {
  return typeof type === "string" && type.startsWith("attachment-");
}

/**
 * What the service hands over for one frame. `socket` is the local connection (per-connection
 * state, such as uploads in flight, is keyed on it and released on its close); `send` writes one
 * answer frame on it; `openRoom` opens the room store by id the way every other request does.
 * `limits`, `now` and `deps` are for the tests: the service passes none of them.
 * @typedef {{
 *   root: string,
 *   socket: import("node:stream").Duplex,
 *   send: (frame: Record<string, unknown>) => boolean,
 *   openRoom: (roomId: string) => Promise<CustodyRoom>,
 *   clientName?: string,
 *   limits?: Partial<Limits>,
 *   now?: () => number,
 *   deps?: CustodyDeps,
 * }} AttachmentContext
 */
/** What the custody reads of a room store: its physical directory and its manifest. @typedef {{ directory: string, manifest: any }} CustodyRoom */
/**
 * Injection points for the tests that plant a failure between the temp write and the rename.
 * @typedef {{ rename?: typeof rename, sleep?: (ms: number) => Promise<void> }} CustodyDeps
 */
/**
 * @typedef {{
 *   uploadId: string, roomId: string, directory: string, name: string, size: number, digest: string,
 *   declaredMimetype: string | undefined, received: number, hash: import("node:crypto").Hash,
 *   head: Buffer, temp: string, handle: import("node:fs/promises").FileHandle | undefined,
 *   startedAt: number, timer: NodeJS.Timeout | undefined, reserved: number,
 * }} Upload
 */

/** @param {string} code @param {string} detail */
function refusal(code, detail) {
  return Object.assign(new AgoraError(`${code}: ${detail}`), { code });
}

/** @type {WeakMap<object, { uploads: Map<string, Upload>, expired: Set<string> }>} */
const connections = new WeakMap();
/** Bytes promised to uploads in flight, per room directory, so two uploads cannot both fit one gap. @type {Map<string, number>} */
const reservations = new Map();
/** One custody step at a time per room directory: the quota check and the rename are one step, an
 * append that names durable bytes is checked and committed as one, and a purge's collection
 * re-reads the room's references and removes blobs as one. @type {Map<string, Promise<unknown>>} */
const roomLocks = new Map();
/**
 * Digests an upload installed or confirmed recently, per room directory, to when the hold lapses.
 * A purge's collection passes over a held digest: the uploader holds a reference it has not yet
 * appended, and those bytes must be there when it does. An append that names the digest ends the
 * hold (from then the room's own reference keeps the bytes); otherwise it lapses after
 * `CUSTODY_HOLD_MS`, and a later collection (the next purge, or the next open of the room) takes
 * bytes nothing references. @type {Map<string, Map<string, number>>}
 */
const holds = new Map();
/** How long an upload's hold on its digest lasts without an append that names it. */
export const CUSTODY_HOLD_MS = 60 * 60 * 1000;
/** Expired upload ids remembered per connection, so a late chunk says expired rather than unknown. */
const EXPIRED_MEMORY = 64;
const BLOB_RE = /^sha256-[a-f0-9]{64}$/;
const TEMP_RE = /^\.upload-[A-Za-z0-9_-]{16,128}\.tmp$/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const ROOM_RE = /^[a-f0-9]{32}$/;
const ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const MIME_RE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** @typedef {Record<keyof typeof ATTACHMENT_LIMITS, number>} Limits */
/** @param {Partial<Limits> | undefined} override @returns {Limits} */
const limitsOf = (override) => ({ ...ATTACHMENT_LIMITS, ...(override ?? {}) });

/** The custody directory of a room. @param {string} roomDirectory */
export function custodyDirectory(roomDirectory) {
  return path.join(roomDirectory, "attachments");
}

/** The installed blob for a digest. @param {string} roomDirectory @param {string} digest */
export function custodyPath(roomDirectory, digest) {
  if (!DIGEST_RE.test(digest)) throw refusal("attachment-unknown", "a digest is sha256:<64 hex>");
  return path.join(custodyDirectory(roomDirectory), `sha256-${digest.slice(7)}`);
}

/** The custody record beside a blob. @param {string} roomDirectory @param {string} digest */
export function custodyRecordPath(roomDirectory, digest) {
  return `${custodyPath(roomDirectory, digest)}.type`;
}

/**
 * The recorded kind and type of an installed blob. A record that is missing, malformed, or names a
 * kind the bytes contradict is not believed: the bytes' own word stands, and a file is then untyped.
 * @param {string} roomDirectory @param {string} digest @param {Uint8Array} head the blob's first bytes
 * @returns {Promise<{ kind: 'image' | 'file', mimetype: string }>}
 */
export async function custodyRecord(roomDirectory, digest, head) {
  const detected = detectAttachmentType(head);
  if (detected.kind === "image") return { kind: "image", mimetype: /** @type {string} */ (detected.mimetype) };
  try {
    const record = JSON.parse(await readFile(custodyRecordPath(roomDirectory, digest), "utf8"));
    if (record?.kind === "file" && typeof record.mimetype === "string" && MIME_RE.test(record.mimetype) && !/^image\//i.test(record.mimetype))
      return { kind: "file", mimetype: record.mimetype };
  } catch { /* no record, or not one: the bytes' word */ }
  return { kind: "file", mimetype: "application/octet-stream" };
}

/** @param {any} manifest @param {Limits} limits */
function roomQuota(manifest, limits) {
  const q = manifest?.attachmentQuota;
  return Number.isSafeInteger(q) && q >= 0 ? q : limits.roomQuotaBytes;
}

/** The bytes installed in a room's custody (temp files are not installed and do not count). @param {string} directory */
async function installedBytes(directory) {
  let names;
  try { names = await readdir(custodyDirectory(directory)); }
  catch (e) { if (/** @type {any} */ (e)?.code === "ENOENT") return 0; throw e; }
  let total = 0;
  for (const name of names) {
    if (!BLOB_RE.test(name)) continue;
    try { total += (await stat(path.join(custodyDirectory(directory), name))).size; }
    catch (e) { if (/** @type {any} */ (e)?.code !== "ENOENT") throw e; }
  }
  return total;
}

/** @param {string} file */
async function installedSize(file) {
  try {
    const s = await stat(file);
    return s.isFile() ? s.size : undefined;
  } catch (e) {
    if (/** @type {any} */ (e)?.code === "ENOENT") return undefined;
    throw e;
  }
}

/** Temp files a dead process left, older than the upload limit, are removed. @param {string} directory @param {number} olderThan */
async function sweepTemps(directory, olderThan) {
  let names;
  try { names = await readdir(custodyDirectory(directory)); }
  catch { return; }
  for (const name of names) {
    if (!TEMP_RE.test(name)) continue;
    const file = path.join(custodyDirectory(directory), name);
    try { if ((await stat(file)).mtimeMs < olderThan) await rm(file, { force: true }); }
    catch { /* another sweep or its owner removed it */ }
  }
}

/** @template T @param {string} directory @param {() => Promise<T>} fn @returns {Promise<T>} */
async function withRoomLock(directory, fn) {
  const before = roomLocks.get(directory) ?? Promise.resolve();
  const run = before.then(fn, fn);
  const settled = run.then(() => undefined, () => undefined);
  roomLocks.set(directory, settled);
  try { return await run; }
  finally { if (roomLocks.get(directory) === settled) roomLocks.delete(directory); }
}

/** @param {object} socket */
function connectionState(socket) {
  let state = connections.get(socket);
  if (!state) {
    state = { uploads: new Map(), expired: new Set() };
    connections.set(socket, state);
    const held = state;
    // a connection that closes takes its uploads with it: nothing was committed, nothing installs
    /** @type {any} */ (socket).once?.("close", () => { for (const u of [...held.uploads.values()]) void drop(held, u); });
  }
  return state;
}

/** @param {{ uploads: Map<string, Upload>, expired: Set<string> }} state @param {Upload} upload */
async function drop(state, upload) {
  if (!state.uploads.delete(upload.uploadId)) return;
  if (upload.timer) clearTimeout(upload.timer);
  release(upload);
  const handle = upload.handle;
  upload.handle = undefined;
  try { await handle?.close(); } catch { /* already closed */ }
  await rm(upload.temp, { force: true }).catch(() => {});
}

/** @param {Upload} upload */
function release(upload) {
  if (!upload.reserved) return;
  const left = (reservations.get(upload.directory) ?? 0) - upload.reserved;
  if (left > 0) reservations.set(upload.directory, left); else reservations.delete(upload.directory);
  upload.reserved = 0;
}

/** @param {{ uploads: Map<string, Upload>, expired: Set<string> }} state @param {Upload} upload */
async function expire(state, upload) {
  await drop(state, upload);
  state.expired.add(upload.uploadId);
  if (state.expired.size > EXPIRED_MEMORY) state.expired.delete(/** @type {string} */ (state.expired.values().next().value));
}

/**
 * The upload a frame names, or the refusal that says why there is none. A late frame for an upload
 * past its limit expires it here even if its timer has not run.
 * @param {{ uploads: Map<string, Upload>, expired: Set<string> }} state @param {unknown} uploadId
 * @param {number} now @param {Limits} limits
 */
async function uploadFor(state, uploadId, now, limits) {
  if (typeof uploadId !== "string" || !ID_RE.test(uploadId)) throw refusal("attachment-upload-unknown", "an upload id is 16-128 letters, digits, _ or -");
  const upload = state.uploads.get(uploadId);
  if (!upload) {
    if (state.expired.has(uploadId)) throw refusal("attachment-upload-expired", `upload ${uploadId} was not committed within ${limits.uploadTtlMs} ms and was dropped`);
    throw refusal("attachment-upload-unknown", `no upload ${uploadId} on this connection`);
  }
  if (now - upload.startedAt > limits.uploadTtlMs) {
    await expire(state, upload);
    throw refusal("attachment-upload-expired", `upload ${uploadId} was not committed within ${limits.uploadTtlMs} ms and was dropped`);
  }
  return upload;
}

/** @param {unknown} roomId */
function roomIdOf(roomId) {
  if (typeof roomId !== "string" || !ROOM_RE.test(roomId)) throw new AgoraError("native attachment frame needs a 32-hex room id");
  return roomId;
}

/**
 * The type the custody records: an image's is the one its bytes prove; a file keeps the declared
 * type unless that type claims an image the bytes do not prove, and is otherwise untyped.
 * @param {{ kind: 'image' | 'file', mimetype: string | null }} detected @param {string | undefined} declared
 */
function recordedMimetype(detected, declared) {
  if (detected.kind === "image") return /** @type {string} */ (detected.mimetype);
  if (declared !== undefined && !/^image\//i.test(declared)) return declared;
  return "application/octet-stream";
}

/**
 * Answer one `attachment-*` frame.
 * @param {AttachmentContext} context @param {Record<string, any>} frame
 * @returns {Promise<void>}
 */
export async function handleAttachmentFrame(context, frame) {
  const limits = limitsOf(context.limits);
  const now = context.now ?? Date.now;
  const state = connectionState(context.socket);
  const answer = (/** @type {string} */ type, /** @type {Record<string, unknown>} */ fields) =>
    context.send({ protocol: NATIVE_PROTOCOL, type, requestId: frame.requestId, ...fields });

  if (frame.type === "attachment-begin") {
    const roomId = roomIdOf(frame.roomId);
    const { name, size, digest } = frame;
    if (typeof name !== "string" || !name || Buffer.byteLength(name, "utf8") > 255 || /[\u0000-\u001f\u007f-\u009f]/u.test(name))
      throw new AgoraError("an attachment name is 1-255 bytes with no control characters");
    if (typeof digest !== "string" || !DIGEST_RE.test(digest)) throw new AgoraError("an attachment digest is sha256:<64 lowercase hex>");
    if (!Number.isSafeInteger(size) || size < 0) throw refusal("attachment-size-mismatch", "a declared size is a non-negative integer");
    if (size > limits.maxBytes) throw refusal("attachment-too-large", `${size} bytes is over the ${limits.maxBytes}-byte limit for one attachment`);
    const declaredMimetype = frame.mimetype === undefined ? undefined : frame.mimetype;
    if (declaredMimetype !== undefined && (typeof declaredMimetype !== "string" || !MIME_RE.test(declaredMimetype)))
      throw new AgoraError("a declared mimetype is type/subtype");
    if (state.uploads.size >= limits.inFlightPerConnection)
      throw refusal("attachment-quota", `${state.uploads.size} uploads are in flight on this connection and ${limits.inFlightPerConnection} is the limit; commit one first`);
    const store = await context.openRoom(roomId);
    const directory = store.directory;
    await sweepTemps(directory, now() - limits.uploadTtlMs);
    const uploadId = randomUUID().replaceAll("-", "");
    /** @type {Upload} */
    const upload = { uploadId, roomId, directory, name, size, digest, declaredMimetype, received: 0,
      hash: createHash("sha256"), head: Buffer.alloc(0), temp: path.join(custodyDirectory(directory), `.upload-${uploadId}.tmp`),
      handle: undefined, startedAt: now(), timer: undefined, reserved: 0 };
    await withRoomLock(directory, async () => {
      // identical bytes are one file: content already installed costs the quota nothing more
      if ((await installedSize(custodyPath(directory, digest))) === undefined) {
        const quota = roomQuota(store.manifest, limits);
        const used = await installedBytes(directory) + (reservations.get(directory) ?? 0);
        if (used + size > quota)
          throw refusal("attachment-quota", `the room holds ${used} attachment bytes (installed and in flight) of its ${quota}; ${size} more does not fit`);
        upload.reserved = size;
        reservations.set(directory, (reservations.get(directory) ?? 0) + size);
      }
    });
    try {
      await mkdir(custodyDirectory(directory), { recursive: true, mode: 0o700 });
      upload.handle = await open(upload.temp, "wx", 0o600);
    } catch (e) {
      release(upload);
      throw e;
    }
    state.uploads.set(uploadId, upload);
    upload.timer = setTimeout(() => { void expire(state, upload); }, limits.uploadTtlMs);
    upload.timer.unref?.();
    answer("attachment-ready", { uploadId, chunkMax: limits.chunkMax });
    return;
  }

  if (frame.type === "attachment-chunk") {
    const upload = await uploadFor(state, frame.uploadId, now(), limits);
    try {
      const data = frame.data;
      // bounded before anything sized by the request is allocated: the encoded length decides
      const encodedMax = Math.ceil(limits.chunkMax / 3) * 4;
      if (typeof data !== "string" || data.length === 0 || data.length % 4 !== 0 || data.length > encodedMax || !BASE64_RE.test(data))
        throw refusal("attachment-size-mismatch", `a chunk is 1-${limits.chunkMax} bytes as padded base64`);
      if (frame.offset !== upload.received)
        throw refusal("attachment-size-mismatch", `chunk offset ${JSON.stringify(frame.offset)} is not the ${upload.received} bytes received so far; chunks arrive in order`);
      const decodedLength = (data.length / 4) * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
      if (upload.received + decodedLength > upload.size)
        throw refusal("attachment-size-mismatch", `${upload.received + decodedLength} bytes is past the declared ${upload.size}`);
      const bytes = Buffer.from(data, "base64");
      if (bytes.length !== decodedLength) throw refusal("attachment-size-mismatch", "the chunk is not canonical base64");
      await /** @type {import("node:fs/promises").FileHandle} */ (upload.handle).write(bytes, 0, bytes.length, upload.received);
      upload.hash.update(bytes);
      if (upload.head.length < ATTACHMENT_SNIFF_BYTES)
        upload.head = Buffer.concat([upload.head, bytes.subarray(0, ATTACHMENT_SNIFF_BYTES - upload.head.length)]);
      upload.received += bytes.length;
    } catch (e) {
      await drop(state, upload);
      throw e;
    }
    answer("attachment-progress", { received: upload.received });
    return;
  }

  if (frame.type === "attachment-commit") {
    const upload = await uploadFor(state, frame.uploadId, now(), limits);
    // from here the upload is this commit's: its timer may not drop it mid-install; a refusal or a
    // failure drops it, and success installs it
    if (upload.timer) clearTimeout(upload.timer);
    upload.timer = undefined;
    let attachment;
    try {
      if (upload.received !== upload.size)
        throw refusal("attachment-size-mismatch", `received ${upload.received} bytes of the declared ${upload.size}; nothing was installed`);
      const got = `sha256:${upload.hash.digest("hex")}`;
      if (got !== upload.digest) throw refusal("attachment-digest-mismatch", `the bytes hash to ${got}, not the declared ${upload.digest}; nothing was installed`);
      const handle = /** @type {import("node:fs/promises").FileHandle} */ (upload.handle);
      await handle.sync();
      await handle.close();
      upload.handle = undefined;
      const target = custodyPath(upload.directory, upload.digest);
      const recordFile = custodyRecordPath(upload.directory, upload.digest);
      await withRoomLock(upload.directory, async () => {
        // the uploader is about to name these bytes in an append: no purge's collection takes them
        // from under it, whether this install puts them in custody or finds them already there
        hold(upload.directory, upload.digest, now() + CUSTODY_HOLD_MS);
        // identical bytes already in custody keep the record of their first install
        if ((await installedSize(target)) !== undefined) return;
        const detected = detectAttachmentType(upload.head);
        await writeDurableAtomic(recordFile, JSON.stringify({ kind: detected.kind, mimetype: recordedMimetype(detected, upload.declaredMimetype) }) + "\n");
        try {
          await renameRetrying(upload.temp, target, context.deps);
          await syncDirectory(custodyDirectory(upload.directory));
        } catch (e) {
          if ((await installedSize(target)) === undefined) await rm(recordFile, { force: true }).catch(() => {});
          throw e;
        }
      });
      const recorded = await custodyRecord(upload.directory, upload.digest, upload.head);
      attachment = validateWireAttachment({ id: durableAttachmentId(upload.roomId, upload.digest), digest: upload.digest,
        lifetime: "durable", name: upload.name, kind: recorded.kind, size: upload.size, mimetype: recorded.mimetype });
    } finally {
      await drop(state, upload);
    }
    answer("attachment-ack", { attachment });
    return;
  }

  if (frame.type === "attachment-read") {
    const roomId = roomIdOf(frame.roomId);
    const { id, digest, offset, length } = frame;
    if (typeof digest !== "string" || !DIGEST_RE.test(digest) || typeof id !== "string" || id !== durableAttachmentId(roomId, digest))
      throw refusal("attachment-unknown", "no attachment with that id and digest in this room");
    if (!Number.isSafeInteger(length) || length < 1) throw new AgoraError("a read length is a positive integer");
    if (length > limits.chunkMax) throw refusal("attachment-too-large", `a read is at most ${limits.chunkMax} bytes`);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new AgoraError("a read offset is a non-negative integer");
    const store = await context.openRoom(roomId);
    const file = custodyPath(store.directory, digest);
    let handle;
    try { handle = await open(file, "r"); }
    catch (e) {
      if (/** @type {any} */ (e)?.code === "ENOENT") throw refusal("attachment-unknown", "no attachment with that id and digest in this room");
      throw e;
    }
    try {
      const size = (await handle.stat()).size;
      if (offset > size) throw refusal("attachment-size-mismatch", `offset ${offset} is past the attachment's ${size} bytes`);
      const want = Math.min(length, size - offset);
      const buffer = Buffer.alloc(want);
      const { bytesRead } = want ? await handle.read(buffer, 0, want, offset) : { bytesRead: 0 };
      // every data frame carries the custody record's kind and type, so the first one answers both
      const headBuffer = Buffer.alloc(ATTACHMENT_SNIFF_BYTES);
      const { bytesRead: headRead } = await handle.read(headBuffer, 0, ATTACHMENT_SNIFF_BYTES, 0);
      const { kind, mimetype } = await custodyRecord(store.directory, digest, headBuffer.subarray(0, headRead));
      answer("attachment-data", { offset, data: buffer.subarray(0, bytesRead).toString("base64"), size, eof: offset + bytesRead >= size, kind, mimetype });
    } finally {
      await handle.close();
    }
    return;
  }

  throw new AgoraError(`native service does not support request type ${JSON.stringify(frame.type)}`);
}

/**
 * The rename may be refused on Windows while another process holds the target open; the same
 * bounded retry the store uses (`RENAME_RETRY`). Any other code is thrown at once.
 * @param {string} from @param {string} to @param {CustodyDeps | undefined} deps
 */
async function renameRetrying(from, to, deps) {
  const renameFile = deps?.rename ?? rename;
  const sleep = deps?.sleep ?? ((/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt++) {
    try { await renameFile(from, to); return; }
    catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error)?.code;
      if (attempt >= RENAME_RETRY.attempts || typeof code !== "string" || !RENAME_RETRY.codes.includes(code)) throw error;
      await sleep(RENAME_RETRY.baseDelayMs * attempt);
    }
  }
}

/** POSIX persists the directory entry after a rename; Windows has no directory fsync through Node. @param {string} directory */
async function syncDirectory(directory) {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try { await handle.sync(); }
  finally { await handle.close(); }
}

/** @param {string} directory @param {string} digest @param {number} until */
function hold(directory, digest, until) {
  let room = holds.get(directory);
  if (!room) holds.set(directory, room = new Map());
  room.set(digest, Math.max(until, room.get(digest) ?? 0));
}

/** @param {string} directory @param {string} digest @param {number} at */
function held(directory, digest, at) {
  const room = holds.get(directory);
  const until = room?.get(digest);
  if (until === undefined) return false;
  if (until > at) return true;
  room?.delete(digest);
  return false;
}

/**
 * Run `fn` under the room's custody lock: the service checks and commits an append that names
 * durable bytes inside it, so a purge's collection never reads the room's references between the
 * check and the commit. @template T @param {string} roomDirectory @param {() => Promise<T>} fn
 */
export function withCustodyLock(roomDirectory, fn) {
  return withRoomLock(roomDirectory, fn);
}

/**
 * An append that names these digests committed: the room's own reference keeps the bytes now, so
 * the uploads' holds end. Called under the custody lock. @param {string} roomDirectory @param {Iterable<string>} digests
 */
export function releaseHolds(roomDirectory, digests) {
  const room = holds.get(roomDirectory);
  if (!room) return;
  for (const d of digests) room.delete(d);
  if (!room.size) holds.delete(roomDirectory);
}

/**
 * Let go of what a purge released (docs/PURGE.md): for each digest no unpurged message references
 * (the store's `custodyCensus().released`), remove its blob and its `.type` custody record. Run
 * under the room's custody lock, so no upload's install interleaves with it. Idempotent: a digest
 * already gone is passed over, so the service runs it after every purge and again when it opens a
 * purged room, which finishes a collection a crash interrupted. A blob is removed before its record,
 * so a crash between the two leaves a record with no blob, which nothing reads and the next run removes.
 * `census` is called under the lock and names what no unpurged message references (the store's
 * `custodyCensus().released`); a digest an upload holds is passed over.
 * @param {string} roomDirectory @param {() => Iterable<string>} census
 * @param {{ now?: () => number, requested?: () => void }} [deps] `requested` runs before the lock is
 *   waited for (a test seam that lets a test interleave an install or an append deterministically)
 * @returns {Promise<{ blobsRemoved: number }>}
 */
export async function collectReleasedCustody(roomDirectory, census, deps = {}) {
  const now = deps.now ?? Date.now;
  deps.requested?.();
  return withRoomLock(roomDirectory, async () => {
    // what is released is read HERE, under the lock every install and every attachment-carrying
    // append takes: an append committed a moment ago is a reference, and a held upload is one too
    const digests = [...census()].filter((d) => typeof d === "string" && DIGEST_RE.test(d) && !held(roomDirectory, d, now()));
    let blobsRemoved = 0;
    for (const digest of digests) {
      const blob = custodyPath(roomDirectory, digest);
      if ((await installedSize(blob)) !== undefined) {
        await rm(blob, { force: true });
        blobsRemoved += 1;
      }
      await rm(custodyRecordPath(roomDirectory, digest), { force: true });
    }
    if (blobsRemoved) await syncDirectory(custodyDirectory(roomDirectory)).catch(() => {});
    return { blobsRemoved };
  });
}

/**
 * Before a message append: every `durable` attachment it names must be installed in this room's
 * custody, its size the bytes' and its kind and type the custody record's, or the append is refused and nothing is appended. A
 * message that carries a durable attachment carries at most `perMessage` attachments in all.
 * @param {AttachmentContext | { root: string, openRoom?: (roomId: string) => Promise<CustodyRoom>, limits?: Partial<Limits> }} context
 * @param {string} roomId @param {unknown} attachments
 * @returns {Promise<void>}
 */
export async function assertDurableAttachments(context, roomId, attachments) {
  if (!Array.isArray(attachments)) return;
  const durable = attachments.filter((a) => a && typeof a === "object" && /** @type {any} */ (a).lifetime === "durable");
  if (!durable.length) return;
  const limits = limitsOf(context.limits);
  if (attachments.length > limits.perMessage)
    throw refusal("attachment-quota", `a message carries at most ${limits.perMessage} attachments; this one names ${attachments.length}`);
  if (!context.openRoom) throw refusal("attachments-unsupported", "this caller holds no room custody");
  const store = await context.openRoom(roomIdOf(roomId));
  for (const raw of durable) {
    let a;
    try { a = validateWireAttachment(raw); }
    catch (e) { throw new AgoraError(`a durable attachment is not a valid reference (${e instanceof Error ? e.message : String(e)})`); }
    if (a.id !== durableAttachmentId(roomId, a.digest)) throw refusal("attachment-unknown", `attachment ${a.id} is not this room's id for ${a.digest}`);
    const file = custodyPath(store.directory, a.digest);
    const size = await installedSize(file);
    if (size === undefined) throw refusal("attachment-unknown", `attachment ${a.id} names bytes this room's custody does not hold; nothing was appended`);
    if (size !== a.size) throw refusal("attachment-unknown", `attachment ${a.id} says ${a.size} bytes and custody holds ${size}; nothing was appended`);
    const recorded = await custodyRecord(store.directory, a.digest, await readHead(file));
    if (recorded.kind !== a.kind || (a.mimetype !== undefined && a.mimetype !== recorded.mimetype) || (recorded.kind === "image" && a.mimetype === undefined))
      throw refusal("attachment-unknown", `attachment ${a.id} says ${a.kind}${a.mimetype ? ` ${a.mimetype}` : ""} and custody records ${recorded.kind} ${recorded.mimetype}; nothing was appended`);
  }
}

/** @param {string} file */
async function readHead(file) {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(ATTACHMENT_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, ATTACHMENT_SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

/**
 * The verified bytes of one durable attachment from a room's custody, for a reader on the host seat
 * (a face that uploads pictures, `read --files`): the digest is checked against the bytes read, so a
 * blob altered on disk is refused, never served.
 * @param {string} roomDirectory @param {string} roomId @param {{ id: string, digest: string }} attachment
 * @returns {Promise<{ path: string, bytes: Buffer, kind: 'image' | 'file', mimetype: string }>}
 */
export async function readDurableBlob(roomDirectory, roomId, attachment) {
  if (attachment.id !== durableAttachmentId(roomId, attachment.digest)) throw refusal("attachment-unknown", "no attachment with that id and digest in this room");
  const file = custodyPath(roomDirectory, attachment.digest);
  let bytes;
  try {
    const handle = await open(file, "r");
    try {
      const { size } = await handle.stat();
      if (size > ATTACHMENT_LIMITS.maxBytes) throw refusal("attachment-too-large", `custody holds ${size} bytes under ${attachment.digest}`);
      bytes = Buffer.alloc(size);
      if (size) await handle.read(bytes, 0, size, 0);
    } finally { await handle.close(); }
  } catch (e) {
    if (/** @type {any} */ (e)?.code === "ENOENT") throw refusal("attachment-unknown", "no attachment with that id and digest in this room");
    throw e;
  }
  const got = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (got !== attachment.digest) throw refusal("attachment-digest-mismatch", `custody's bytes hash to ${got}, not ${attachment.digest}`);
  return { path: file, bytes, ...(await custodyRecord(roomDirectory, attachment.digest, bytes.subarray(0, ATTACHMENT_SNIFF_BYTES))) };
}
