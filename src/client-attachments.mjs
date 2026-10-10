// @ts-check
/**
 * Durable attachments, the client half of `agora/client`. The contract is docs/ATTACHMENTS.md.
 *
 * `client.upload(room, request)` and `client.attachment(room, ref)` are methods on the client and
 * delegate here with a seam: the client's own room resolution, its live connection, the capability
 * set the service offered, and its outcome constructors, so a failure here is classified exactly as
 * an append's is. This module keeps no state of its own and imports nothing from the client.
 *
 * This build carries no upload or read path: both refuse `attachments-unsupported` before anything
 * is sent.
 */

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

/**
 * Upload one file into the room's custody; resolves with the reference an append carries.
 * @param {AttachmentSeam} seam @param {unknown} room @param {UploadRequest} request
 * @returns {Promise<WireAttachment>}
 */
export async function uploadAttachment(seam, room, request) {
  seam.roomId(room);
  void request;
  throw seam.refused("attachments-unsupported", "this client build carries no attachment upload; nothing was sent");
}

/**
 * Read one installed attachment's bytes, verified against its digest. Local connections only.
 * @param {AttachmentSeam} seam @param {unknown} room @param {AttachmentRef} ref
 * @returns {Promise<AttachmentBytes>}
 */
export async function readAttachment(seam, room, ref) {
  seam.roomId(room);
  void ref;
  throw seam.refused("attachments-unsupported", "this client build carries no attachment read; nothing was sent");
}
