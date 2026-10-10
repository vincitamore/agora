// @ts-check
/**
 * Durable attachments in native rooms: the service half. The contract is docs/ATTACHMENTS.md.
 *
 * The seat service calls two functions here and nothing else: `handleAttachmentFrame` for every
 * `attachment-*` frame on a LOCAL connection (a member session never reaches it: `memberMayRequest`
 * refuses the type first), and `assertDurableAttachments` before every message append. This build
 * serves no attachment custody: every frame, and every append naming a `durable` attachment, is
 * refused `attachments-unsupported`. An attachment with no `lifetime` (metadata only, as a native
 * record has always been able to carry) passes exactly as before.
 */

import { AgoraError } from "./core.mjs";

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
 * @typedef {{
 *   root: string,
 *   socket: import("node:stream").Duplex,
 *   send: (frame: Record<string, unknown>) => boolean,
 *   openRoom: (roomId: string) => Promise<import("./native-store.mjs").NativeRoomStore>,
 *   clientName?: string,
 * }} AttachmentContext
 */

/** @param {string} code @param {string} detail */
function refusal(code, detail) {
  return Object.assign(new AgoraError(`${code}: ${detail}`), { code });
}

/**
 * Answer one `attachment-*` frame.
 * @param {AttachmentContext} context @param {Record<string, any>} frame
 * @returns {Promise<void>}
 */
export async function handleAttachmentFrame(context, frame) {
  void context;
  throw refusal("attachments-unsupported", `this seat service does not serve ${String(frame?.type)} (no attachments-v1)`);
}

/**
 * Before a message append: every `durable` attachment it names must be installed in this room's
 * custody, or the append is refused and nothing is appended.
 * @param {AttachmentContext | { root: string }} context @param {string} roomId @param {unknown} attachments
 * @returns {Promise<void>}
 */
export async function assertDurableAttachments(context, roomId, attachments) {
  void context; void roomId;
  if (!Array.isArray(attachments)) return;
  for (const a of attachments)
    if (a && typeof a === "object" && /** @type {any} */ (a).lifetime === "durable")
      throw refusal("attachments-unsupported", "this seat service holds no attachment custody; a durable attachment cannot be appended");
}
