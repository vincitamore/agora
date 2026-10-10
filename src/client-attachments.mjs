// @ts-check
/**
 * Durable attachments, the client half of `agora/client`. The contract is docs/ATTACHMENTS.md.
 *
 * `client.upload(room, request)` and `client.attachment(room, ref)` are methods on the client and
 * delegate here with a seam: the client's own room resolution, its live connection, the capability
 * set the service offered, and its outcome constructors, so a failure here is classified exactly as
 * an append's is. This module keeps no state of its own and imports nothing from the client.
 *
 * An upload and a read each hold ONE connection for their whole length: an upload lives on the
 * connection that began it, so a connection that drops mid-way is `dark` and the caller uploads
 * again from the start (nothing was installed). Nothing here retries by itself.
 */

import { createHash } from "node:crypto";
import { ATTACHMENT_SNIFF_BYTES, detectAttachmentType, durableAttachmentId, validateWireAttachment } from "./protocol/attachment.mjs";

/** @typedef {import("./protocol/attachment.mjs").WireAttachment} WireAttachment */
/**
 * @typedef {{
 *   bytes: Uint8Array,
 *   name: string,
 *   mimetype?: string,
 *   width?: number,
 *   height?: number,
 * }} UploadRequest
 */
/** @typedef {{ id: string, digest: string }} AttachmentRef */
/** @typedef {{ stream: ReadableStream<Uint8Array>, size: number, kind: 'image' | 'file', mimetype: string }} AttachmentBytes */
/**
 * What the client hands over. `roomId` resolves an alias or `{ roomId }`; `live` is the request
 * connection (made or remade on demand); `capabilities` is what the service offered on its latest
 * hello; `refused` and `dark` build the client's own outcome errors; `classify` turns a failure
 * after a frame left into one of them.
 * @typedef {{
 *   roomId: (room: unknown) => string,
 *   live: () => Promise<{ client: import("./native-service.mjs").NativeServiceClient, accountId: string }>,
 *   capabilities: () => ReadonlySet<string>,
 *   refused: (code: string, message: string, extra?: { operationId?: string, cause?: unknown }) => Error,
 *   dark: (code: string, message: string, extra?: { operationId?: string, cause?: unknown }) => Error,
 *   classify: (error: unknown, at: { append?: boolean, operationId?: string, where: string }) => Error,
 * }} AttachmentSeam
 */

/** The capability a service offers when it holds attachment custody. */
export const ATTACHMENTS_CAPABILITY = "attachments-v1";

/** The one-attachment limit the service enforces, refused here before anything is sent. */
const MAX_BYTES = 25 * 1024 * 1024;
/** The largest chunk this client sends or asks for, whatever a service offers. */
const CHUNK_MAX = 262144;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const WHERE = "this seat's service";

/** @param {unknown} e */
const said = (e) => (e instanceof Error ? e.message : String(e));

/**
 * The live connection, refused by name when its service holds no custody: an older service would
 * answer every frame with an unsupported type, after the bytes had left.
 * @param {AttachmentSeam} seam
 */
async function custodyConnection(seam) {
  const conn = await seam.live();
  if (!conn.client.capabilities?.has(ATTACHMENTS_CAPABILITY))
    throw seam.refused("attachments-unsupported", `${WHERE} offers no ${ATTACHMENTS_CAPABILITY}; nothing was sent`);
  return conn;
}

/**
 * Upload one file into the room's custody; resolves with the reference an append carries.
 * @param {AttachmentSeam} seam @param {unknown} room @param {UploadRequest} request
 * @returns {Promise<WireAttachment>}
 */
export async function uploadAttachment(seam, room, request) {
  const roomId = seam.roomId(room);
  if (typeof request !== "object" || request === null) throw seam.refused("upload-invalid", "upload takes { bytes, name, mimetype?, width?, height? }");
  const { bytes, name, mimetype, width, height } = request;
  if (!(bytes instanceof Uint8Array)) throw seam.refused("upload-invalid", "bytes is a Uint8Array");
  if (bytes.byteLength > MAX_BYTES) throw seam.refused("attachment-too-large", `${bytes.byteLength} bytes is over the ${MAX_BYTES}-byte limit for one attachment; nothing was sent`);
  if (typeof name !== "string" || !name || Buffer.byteLength(name, "utf8") > 255 || /[\u0000-\u001f\u007f-\u009f]/u.test(name))
    throw seam.refused("upload-invalid", "a name is 1-255 bytes with no control characters");
  if (mimetype !== undefined && (typeof mimetype !== "string" || !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/.test(mimetype)))
    throw seam.refused("upload-invalid", "a mimetype is type/subtype");
  for (const [field, v] of /** @type {const} */ ([["width", width], ["height", height]]))
    if (v !== undefined && (!Number.isSafeInteger(v) || /** @type {number} */ (v) < 1 || /** @type {number} */ (v) > 2147483647))
      throw seam.refused("upload-invalid", `${field} is a positive integer`);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const { client } = await custodyConnection(seam);
  /** @param {string} type @param {Record<string, unknown>} fields */
  const ask = async (type, fields) => {
    try { return /** @type {Record<string, any>} */ (await client.request(type, fields)); }
    catch (e) { throw seam.classify(e, { where: WHERE }); }
  };
  const ready = await ask("attachment-begin", { roomId, name, size: bytes.byteLength, digest, ...(mimetype !== undefined ? { mimetype } : {}) });
  const uploadId = ready?.uploadId;
  if (typeof uploadId !== "string" || !ID_RE.test(uploadId)) throw seam.refused("upload-mismatch", "the service's ready names no upload id");
  const step = Number.isSafeInteger(ready.chunkMax) && ready.chunkMax > 0 ? Math.min(ready.chunkMax, CHUNK_MAX) : CHUNK_MAX;
  for (let offset = 0; offset < bytes.byteLength; offset += step) {
    const chunk = bytes.subarray(offset, Math.min(offset + step, bytes.byteLength));
    const progress = await ask("attachment-chunk", { uploadId, offset, data: Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString("base64") });
    if (progress?.received !== offset + chunk.byteLength)
      throw seam.refused("upload-mismatch", `the service received ${JSON.stringify(progress?.received)} bytes where ${offset + chunk.byteLength} were sent`);
  }
  const ack = await ask("attachment-commit", { uploadId });
  /** @type {WireAttachment} */
  let attachment;
  try { attachment = validateWireAttachment(ack?.attachment); }
  catch (e) { throw seam.refused("upload-mismatch", `the service's acknowledgement is not an attachment reference (${said(e)})`, { cause: e }); }
  if (attachment.lifetime !== "durable" || attachment.digest !== digest || attachment.size !== bytes.byteLength || attachment.id !== durableAttachmentId(roomId, digest))
    throw seam.refused("upload-mismatch", "the service acknowledged an attachment that is not the one sent");
  // dimensions are the caller's word about an image; a file carries none
  if (attachment.kind === "image") {
    if (width !== undefined) attachment.width = width;
    if (height !== undefined) attachment.height = height;
  }
  return attachment;
}

/**
 * Read one installed attachment's bytes, verified against its digest. Local connections only. The
 * first chunk is read before this resolves (so `size` and the kind its bytes prove are known); the
 * stream withholds its last chunk until every byte has hashed to the digest, and errors with
 * `attachment-digest-mismatch` instead of delivering it when they do not.
 * @param {AttachmentSeam} seam @param {unknown} room @param {AttachmentRef} ref
 * @returns {Promise<AttachmentBytes>}
 */
export async function readAttachment(seam, room, ref) {
  const roomId = seam.roomId(room);
  const id = ref?.id, digest = ref?.digest;
  if (typeof id !== "string" || !ID_RE.test(id) || typeof digest !== "string" || !DIGEST_RE.test(digest))
    throw seam.refused("attachment-invalid", "an attachment reference is { id, digest } as upload returned it");
  const { client } = await custodyConnection(seam);
  /** @param {number} offset */
  const fetchChunk = async (offset) => {
    /** @type {Record<string, any>} */
    let data;
    try { data = await client.request("attachment-read", { roomId, id, digest, offset, length: CHUNK_MAX }); }
    catch (e) { throw seam.classify(e, { where: WHERE }); }
    if (data?.offset !== offset || typeof data.data !== "string" || !Number.isSafeInteger(data.size) || typeof data.eof !== "boolean")
      throw seam.refused("attachment-mismatch", `the service's data frame does not answer the read at ${offset}`);
    const bytes = new Uint8Array(Buffer.from(data.data, "base64"));
    if (bytes.byteLength > CHUNK_MAX || offset + bytes.byteLength > data.size || data.eof !== (offset + bytes.byteLength === data.size)
      || (!data.eof && bytes.byteLength === 0))
      throw seam.refused("attachment-mismatch", `the service's data frame at ${offset} is inconsistent with its own size`);
    return { bytes, size: /** @type {number} */ (data.size), eof: /** @type {boolean} */ (data.eof) };
  };
  const first = await fetchChunk(0);
  const size = first.size;
  if (size > MAX_BYTES) throw seam.refused("attachment-mismatch", `the service reports ${size} bytes, over the one-attachment limit`);
  const detected = detectAttachmentType(first.bytes.subarray(0, ATTACHMENT_SNIFF_BYTES));
  const hash = createHash("sha256");
  /** @param {Uint8Array} bytes */
  const verified = (bytes) => {
    hash.update(bytes);
    const got = `sha256:${hash.digest("hex")}`;
    if (got !== digest) throw seam.refused("attachment-digest-mismatch", `the bytes read hash to ${got}, not ${digest}`);
  };
  let next = first;
  let offset = 0;
  // the first chunk is checked here when it is the whole file, so a mismatch rejects the call itself
  if (first.eof) verified(first.bytes);
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const chunk = next;
        offset += chunk.bytes.byteLength;
        if (chunk.eof) {
          if (chunk !== first) verified(chunk.bytes);
          if (chunk.bytes.byteLength) controller.enqueue(chunk.bytes);
          controller.close();
          return;
        }
        hash.update(chunk.bytes);
        controller.enqueue(chunk.bytes);
        next = await fetchChunk(offset);
        if (next.size !== size) throw seam.refused("attachment-mismatch", "the attachment's size changed during the read");
      } catch (e) {
        controller.error(e);
      }
    },
  });
  return { stream, size, kind: detected.kind, mimetype: detected.mimetype ?? "application/octet-stream" };
}
