// @ts-check
/**
 * `agora/client`: an app's client of the native rooms on this seat's service.
 *
 * An app (a web app whose signed-in people talk with an agent in a room, for one) imports this
 * instead of spawning the CLI per message. It speaks to the seat service the way the CLI does: the
 * descriptor under the state root names the endpoint, the service proves itself first, and every
 * request rides the same frames. What it adds is what an app needs in process: a subscription that
 * pushes, a receipt checked against the operation it answers, the app's client name stamped by the
 * service as `via`, and three ways a request can fail that never collapse into one another.
 *
 * Primitives, connection-scoped: `connect`, `read`, `subscribe`, `append`. The client keeps no
 * session state: it writes no file, keeps no cursor on disk, never retries an append on its own
 * (the caller resends under the same operation id) and never acts on an incoming trailer (a message
 * carries its trailers parsed, for rendering). `follow` is the one default, composed only from
 * `subscribe`. Contract: docs/CLIENT.md.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { AgoraError, configPath, expandHome, loadConfig, parseSignature, stateDir } from "./core.mjs";
import { NativeServiceClient } from "./native-service.mjs";
import { NATIVE_FRAME_MAX, NATIVE_PROTOCOL, nativeCursor, nativeFramePayloadBytes, parseNativeCursor } from "./native-protocol.mjs";
import { AUTHOR_REF_PATTERN, CLIENT_NAME_PATTERN } from "./protocol/common.mjs";
import { validateWireAttachment } from "./protocol/attachment.mjs";
import { ATTACHMENTS_CAPABILITY, readAttachment, uploadAttachment } from "./client-attachments.mjs";
import { validateNativeCheckpoint, validateNativeReadCoverage } from "./protocol/read.mjs";
import { assertReceiptContext, validateNativeCommitReceipt } from "./protocol/receipt.mjs";
import { decorate, wireAnnotation, wireMessage } from "./render.mjs";
import { trailerKeyOk, trailerValueOk, withTrailers } from "./trailers.mjs";
import { fittingReadLimit, validateNativeThread } from "./transports/native.mjs";
import { nativeMessage, readServiceDescriptor } from "./wake/subscriber.mjs";

export * from "./client-attachments.mjs";

/**
 * `refused`: a definite no. The service answered no on a live socket, or this client refused before
 * anything was sent; nothing was appended. `dark`: no socket, or it closed before the request was
 * sent; nothing reached the service. `unknown-acceptance`: the socket died, or no answer came, with
 * an append on the wire; resend under the same operation id to learn which.
 * @typedef {'refused' | 'dark' | 'unknown-acceptance'} ClientOutcome
 */

/** A room: an alias from the config, or a native room id. @typedef {string | { roomId: string }} RoomRef */
/** @typedef {{ alias: string, roomId: string, transport: 'native' }} RoomInfo */
/** When a purge took a record's text, and which purge record did (docs/PURGE.md). @typedef {{ at: string, purge: string }} PurgedMarker */
/**
 * A message, shaped exactly as `read --json` prints one. A message a purge took carries `purged`
 * and an empty text (docs/PURGE.md).
 * @typedef {ReturnType<typeof wireMessage> & { purged?: PurgedMarker }} ClientMessage
 */
/**
 * `through` is the position the read accounts for: a room cursor, past the last message when the
 * records after it are not messages (or, on a thread read, not in the thread). `committedThrough`
 * is what the host had committed, when it says. `gap` is present only when a newest-window read
 * returned fewer messages than were asked for because the rest would not fit one frame.
 * `annotations` are the annotation records in the same span, in log order, present when the
 * service offers annotations-v1 (and then always a list); a service without it has none to give.
 * @typedef {{ messages: ClientMessage[], annotations?: ClientAnnotation[], through: string, committedThrough?: string, gap?: ClientReadGap }} ClientReadResult
 */
/** @typedef {{ reason: 'frame-limit', requested: number, returned: number }} ClientReadGap */
/**
 * An annotation, shaped exactly as `read --json` prints one (docs/ANNOTATIONS.md). An edit whose
 * message a purge took carries `purged` and no text.
 * @typedef {ReturnType<typeof wireAnnotation> & { purged?: PurgedMarker }} ClientAnnotation
 */
/** @typedef {'edit' | 'withdraw' | 'pin' | 'unpin'} AnnotationAct */
/** @typedef {{ act: AnnotationAct, target: string, text?: string, author: ClientAuthor, operationId?: string }} AnnotateRequest */
/** @typedef {{ id: string, cursor: string, duplicate: boolean, operationId: string }} AnnotateReceipt */
/**
 * A purge (docs/PURGE.md): the messages named by `targets`, and with `thread` that root and every
 * reply, lose their text. `reason` is recorded on the purge record; `author` is who asked (`by`).
 * @typedef {{ targets?: string[], thread?: string, reason: string, author: ClientAuthor, operationId?: string }} PurgeRequest
 */
/**
 * `purged` lists the messages this purge took, in log order (an earlier purge's are not listed again);
 * `blobsRemoved` counts the attachment blobs custody let go of; `facesOutOfReach` the copies a face
 * already published, which a purge cannot reach.
 * @typedef {{ id: string, cursor: string, duplicate: boolean, operationId: string, purged: string[], blobsRemoved: number,
 *   facesOutOfReach: Array<{ transport: string, channel: string, ts: string }> }} PurgeReceipt
 */
/**
 * `message` sees each message once, in order. `annotation`, when given, sees each annotation once,
 * in the same order (it needs annotations-v1); without it, annotation records are passed over and
 * the cursor still advances across them. `dark` and `refused` see the end of an established
 * subscription, at most one of them, once; a subscription that cannot be established rejects
 * `subscribe` instead and calls neither.
 * `purge`, when given, sees each purge once, in the same order (it needs purge-v1): the messages a
 * purge took, so a reader strikes text it already shows (`foldPurges`); without it, purge records
 * are passed over and the cursor still advances across them.
 * @typedef {{ message: (m: ClientMessage) => void, annotation?: (a: ClientAnnotation) => void, purge?: (p: ClientPurge) => void, dark?: (error: ClientError) => void, refused?: (error: ClientError) => void }} SubscribeHandlers
 */
/**
 * A purge as a subscriber receives it (docs/PURGE.md): `purged` lists the messages it took, in log
 * order (on a thread subscription, only that thread's).
 * @typedef {{ id: string, cursor: string, ts: string, purged: string[], thread?: string, reason: string, by: { name: string, ref?: string }, via?: string }} ClientPurge
 */
/** `cursor` is the last position delivered or covered. @typedef {{ readonly cursor: string, close(): void }} ClientSubscription */
/** `ref` is the app's own id for the person, stamped as `author.ref`; only on a client that declared a name. @typedef {{ kind: 'human' | 'agent' | 'system', name: string, ref?: string }} ClientAuthor */
/**
 * `attachments` are references `upload` returned (docs/ATTACHMENTS.md), each checked by
 * `validateWireAttachment` before anything is sent.
 * @typedef {{ text: string, author: ClientAuthor, thread?: string, trailers?: Array<[string, string]>, operationId?: string, attachments?: import("./protocol/attachment.mjs").WireAttachment[] }} AppendRequest
 */
/** @typedef {{ id: string, cursor: string, duplicate: boolean, operationId: string }} AppendReceipt */
/** @typedef {'live' | 'dark' | 'refused'} FollowState */
/** @typedef {{ message: (m: ClientMessage) => void, annotation?: (a: ClientAnnotation) => void, purge?: (p: ClientPurge) => void, state?: (state: FollowState, error?: ClientError) => void }} FollowHandlers */
/** @typedef {{ readonly cursor: string | undefined, close(): void }} Follow */
/** @typedef {{ state?: string, config?: string, clientName?: string }} ConnectOptions */
/** @typedef {AgoraClient} Client */

/** The capability a service offers when it carries annotations (docs/ANNOTATIONS.md). */
export const ANNOTATIONS_CAPABILITY = "annotations-v1";
/** The capability a service offers when it keeps purges and sends them to subscribers (docs/PURGE.md). */
export const PURGE_CAPABILITY = "purge-v1";

/**
 * Mark the messages purges took (docs/PURGE.md): each named message comes back with an empty text,
 * `purged: { at, purge }`, and nothing read off its old text (trailers, `to`, signature, offer). A
 * reader that already shows a message strikes it with this when a purge event arrives. Pure: it
 * returns new messages in the same order, ignores ids not among them, and keeps a marker a message
 * already carries.
 * @template {ClientMessage} M
 * @param {readonly M[]} messages @param {readonly ClientPurge[]} purges
 * @returns {Array<M & { purged?: PurgedMarker }>}
 */
export function foldPurges(messages, purges) {
  /** @type {Map<string, PurgedMarker>} */
  const taken = new Map();
  const ordered = [...purges].sort((x, y) => parseNativeCursor(x.cursor).sequence - parseNativeCursor(y.cursor).sequence);
  for (const p of ordered) for (const id of p.purged) if (!taken.has(id)) taken.set(id, { at: p.ts, purge: p.id });
  return messages.map((m) => {
    const marker = m.purged ?? taken.get(m.id);
    if (!marker) return /** @type {any} */ ({ ...m });
    const { to: _to, trailers: _trailers, offer: _offer, signedAs: _signedAs, ...rest } = /** @type {any} */ (m);
    return /** @type {any} */ ({ ...rest, text: "", purged: { ...marker } });
  });
}
const ANNOTATION_ACTS = new Set(["edit", "withdraw", "pin", "unpin"]);

/**
 * Fold annotations onto messages (docs/ANNOTATIONS.md): a later edit replaces an earlier one, a
 * withdrawal wins over any edit, earlier or later, and the last of pin and unpin decides `pinned`.
 * An edited message's text is the latest edit's, with its trailers and signature read off the new
 * text. A pure function of its arguments: it returns new messages, keeps their order, ignores an
 * annotation whose target is not among them, and keeps no folded state anywhere.
 * @template {ClientMessage} M
 * @param {readonly M[]} messages @param {readonly ClientAnnotation[]} annotations
 * @returns {Array<M & { edited?: { at: string, text: string }, withdrawn?: { at: string }, pinned?: boolean }>}
 */
export function foldAnnotations(messages, annotations) {
  /** @type {Map<string, { edited?: { at: string, text: string }, withdrawn?: { at: string }, pinned?: boolean }>} */
  const folded = new Map();
  const ids = new Set(messages.map((m) => m.id));
  const ordered = [...annotations].filter((a) => ids.has(a.target))
    .sort((x, y) => parseNativeCursor(x.cursor).sequence - parseNativeCursor(y.cursor).sequence);
  for (const a of ordered) {
    const state = folded.get(a.target) ?? {};
    folded.set(a.target, state);
    if (a.act === "withdraw") { state.withdrawn ??= { at: a.ts }; continue; }
    if (a.act === "pin" || a.act === "unpin") { state.pinned = a.act === "pin"; continue; }
    // an edit after the withdrawal changes nothing: withdrawn wins
    if (a.act === "edit" && !state.withdrawn && typeof a.text === "string") state.edited = { at: a.ts, text: a.text };
  }
  return messages.map((m) => {
    const state = folded.get(m.id);
    if (!state) return /** @type {any} */ ({ ...m });
    let base = /** @type {any} */ ({ ...m });
    if (state.edited) {
      // what was read off the old text goes with it, and is read again off the new one
      const { to: _to, trailers: _trailers, offer: _offer, signedAs: _signedAs, ...rest } = base;
      const text = state.edited.text;
      const signedAs = parseSignature(text);
      base = decorate(/** @type {any} */ ({ ...rest, text, ...(signedAs !== undefined ? { signedAs } : {}) }));
    }
    return { ...base, ...(state.edited ? { edited: state.edited } : {}), ...(state.withdrawn ? { withdrawn: state.withdrawn } : {}),
      ...(state.pinned !== undefined ? { pinned: state.pinned } : {}) };
  });
}

/** What `follow` waits after a dark socket, attempt by attempt; the last step repeats. */
export const FOLLOW_BACKOFF_MS = Object.freeze([500, 1000, 2000, 5000, 15000]);

/** The body ceiling the native store enforces, refused here before anything is sent. */
const TEXT_MAX_BYTES = 256 * 1024;
const ROOM_ID_RE = /^[a-f0-9]{32}$/;
const OPERATION_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const AUTHOR_KINDS = new Set(["human", "agent", "system"]);

export class ClientError extends Error {
  /**
   * @param {ClientOutcome} outcome @param {string} code a bounded identifier, never free text
   * @param {string} message @param {{ operationId?: string, cause?: unknown }} [extra] `cause` is the
   *   service's or the transport's own error; a refusal this client makes by itself has none
   */
  constructor(outcome, code, message, extra = {}) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause });
    this.name = "ClientError";
    /** @type {ClientOutcome} */
    this.outcome = outcome;
    this.code = code;
    /** The operation id an append was, or would have been, sent under. @type {string | undefined} */
    this.operationId = extra.operationId;
  }
}

/** @param {string} code @param {string} message @param {{ operationId?: string, cause?: unknown }} [extra] */
const refused = (code, message, extra) => new ClientError("refused", code, message, extra);
/** @param {string} code @param {string} message @param {{ operationId?: string, cause?: unknown }} [extra] */
const dark = (code, message, extra) => new ClientError("dark", code, message, extra);
/** @param {unknown} e */
const said = (e) => (e instanceof Error ? e.message : String(e));
/**
 * The service's refusal carries its code on an AgoraError. A socket's own failure carries a code
 * too (`ENOENT`, `ECONNRESET`), and that one is darkness, never an answer.
 * @param {unknown} e
 */
const answered = (e) => e instanceof AgoraError && typeof /** @type {any} */ (e).code === "string";

/**
 * The service's answer to a request, or the one of the three outcomes that names why there is none.
 * A request that never left carries `sent: false`; one that was written and answered nothing is
 * dark for a read and unknown acceptance for an append.
 * @param {unknown} e @param {{ append?: boolean, operationId?: string, where: string }} at
 */
function classify(e, at) {
  if (e instanceof ClientError) return e;
  const extra = { operationId: at.operationId, cause: e };
  const code = /** @type {any} */ (e)?.code;
  // a service that is stopping answers that it is dark: nothing was served, so it is darkness said
  // aloud, and a follow waits it out instead of stopping on it
  if (answered(e) && code === "service-dark")
    return dark(code, at.append ? `room-dark: ${said(e)}; nothing was posted and no cursor was issued` : said(e), extra);
  if (answered(e)) return refused(code, said(e), extra);
  if (/** @type {any} */ (e)?.sent === false)
    return dark("service-dark", at.append ? `room-dark: ${at.where} is dark (${said(e)}); nothing was posted and no cursor was issued` : `${at.where} is dark: ${said(e)}`, extra);
  if (at.append) return new ClientError("unknown-acceptance", "acceptance-unknown", `${said(e)}; operation ${at.operationId} may have been committed: resend it under the same operation id`, extra);
  return dark("service-dark", `${at.where} went dark during the request: ${said(e)}`, extra);
}

/**
 * Open a client on this seat's service. The hello runs here, so a missing service is `dark` and a
 * declared `clientName` the service will not stamp is `refused` (`client-name-unsupported`) before
 * the caller holds anything.
 * @param {ConnectOptions} [options]
 * @returns {Promise<Client>}
 */
export async function connect(options = {}) {
  return AgoraClient.open(options);
}

class AgoraClient {
  /** @type {string} */ #stateRoot;
  /** @type {Map<string, { transport: string, roomId?: string }>} */ #aliases;
  /** @type {Promise<{ client: NativeServiceClient, accountId: string }> | undefined} */ #requesting;
  /** @type {Set<{ close(): void }>} */ #open = new Set();
  /** The epoch each room answered with, so an append's receipt is checked against it. @type {Map<string, string>} */ #epochs = new Map();
  /** The seat-private service secret, held only to refuse a text that carries it. @type {string | undefined} */ #secret;
  #closed = false;
  /** @type {ReadonlySet<string>} */ #capabilities = new Set();
  /** @type {{ accountId: string, label: string }} */ #seat = { accountId: "", label: "" };

  /** @param {{ stateRoot: string, aliases: Map<string, { transport: string, roomId?: string }>, clientName?: string }} init */
  constructor(init) {
    this.#stateRoot = init.stateRoot;
    this.#aliases = init.aliases;
    /** The client name this connection declared, stamped by the service as `via`. @type {string | undefined} */
    this.clientName = init.clientName;
  }

  /** @param {ConnectOptions} options @returns {Promise<AgoraClient>} */
  static async open(options) {
    const { clientName } = options;
    if (clientName !== undefined && (typeof clientName !== "string" || !CLIENT_NAME_PATTERN.test(clientName)))
      throw refused("client-name-invalid", "a client name is a lowercase letter then 1-39 lowercase letters, digits or hyphens");
    // A config is read when it is named, or when the state root has to be found through it; a
    // caller that names the state root and no config reads none and names rooms by id.
    /** @type {import('./core.mjs').Config | undefined} */
    let cfg;
    const file = options.config ?? (options.state === undefined ? configPath(undefined) : undefined);
    if (file !== undefined && (options.config !== undefined || existsSync(file))) {
      try { cfg = await loadConfig(file); }
      catch (e) { throw refused("config-invalid", said(e), { cause: e }); }
    }
    /** @type {Map<string, { transport: string, roomId?: string }>} */
    const aliases = new Map();
    for (const [alias, row] of Object.entries(cfg?.rooms ?? {}))
      aliases.set(alias, { transport: row.transport, ...(typeof row.roomId === "string" ? { roomId: row.roomId } : {}) });
    const stateRoot = options.state !== undefined
      ? path.resolve(expandHome(options.state))
      : stateDir(cfg ?? /** @type {import('./core.mjs').Config} */ ({ actor: { name: "", kind: "unknown" }, rooms: {} }));
    const client = new AgoraClient({ stateRoot, aliases, ...(clientName !== undefined ? { clientName } : {}) });
    await client.#request();
    return client;
  }

  /** What the service offered on the latest hello of the request connection. */
  get capabilities() { return this.#capabilities; }

  /** The seat service's public identity: its account and label, as its descriptor publishes them. */
  get seat() { return this.#seat; }

  /** The configured native rooms this client serves. @returns {RoomInfo[]} */
  rooms() {
    /** @type {RoomInfo[]} */
    const out = [];
    for (const [alias, row] of this.#aliases)
      if (row.transport === "native" && ROOM_ID_RE.test(row.roomId ?? "")) out.push({ alias, roomId: /** @type {string} */ (row.roomId), transport: "native" });
    return out;
  }

  /**
   * One connection to the service: the descriptor read afresh, the hello run, the offer kept.
   * @param {string | undefined} clientName
   */
  async #dial(clientName) {
    if (this.#closed) throw dark("client-closed", "this client was closed; nothing was sent");
    let descriptor;
    try { descriptor = await readServiceDescriptor(this.#stateRoot); }
    catch (e) { throw dark("service-dark", said(e), { cause: e }); }
    let client;
    try {
      client = await NativeServiceClient.connect({ ...descriptor, ...(clientName !== undefined ? { clientName } : {}) });
    } catch (e) {
      // a hello the service answered (a client name it will not take, a refused hello) is its no;
      // anything else is nobody proven at the endpoint
      if (answered(e)) throw refused(/** @type {any} */ (e).code, said(e), { cause: e });
      throw dark("service-dark", `seat service at ${descriptor.path} is dark: ${said(e)}`, { cause: e });
    }
    if (this.#closed) { client.close(); throw dark("client-closed", "this client was closed; nothing was sent"); }
    this.#secret = descriptor.nonce;
    this.#seat = { accountId: descriptor.accountId, label: descriptor.seatLabel };
    return { client, accountId: descriptor.accountId, path: descriptor.path };
  }

  /**
   * The request connection: made on first use, and made again by `#live` once it stops being
   * writable. It declares the client name, and it does not hold the process open (a pending request
   * holds it through its own timer).
   */
  #request() {
    if (this.#closed) return Promise.reject(dark("client-closed", "this client was closed; nothing was sent"));
    if (!this.#requesting) {
      const attempt = this.#dial(this.clientName).then(({ client, accountId }) => {
        client.socket.unref();
        this.#capabilities = new Set(client.capabilities);
        return { client, accountId };
      });
      attempt.catch(() => { if (this.#requesting === attempt) this.#requesting = undefined; });
      this.#requesting = attempt;
    }
    return this.#requesting;
  }

  /** The request connection, alive: one that is no longer writable is dropped and dialled again. */
  async #live() {
    const first = this.#request();
    const conn = await first;
    if (conn.client.socket.writable) return conn;
    if (this.#requesting === first) this.#requesting = undefined;
    return this.#request();
  }

  /** @param {RoomRef} room @returns {string} */
  #roomId(room) {
    if (typeof room === "string") {
      const row = this.#aliases.get(room);
      if (!row) throw refused("room-unknown", `no room named ${JSON.stringify(room)} in the config`);
      if (row.transport === "native-remote")
        throw refused("room-transport-unsupported", `${room} is a native-remote room: its member channel admits only agent authors and stamps no client name, so agora/client does not serve it`);
      if (row.transport !== "native")
        throw refused("room-transport-unsupported", `${room} is a ${row.transport} room; agora/client serves native rooms on this seat's service`);
      if (!ROOM_ID_RE.test(row.roomId ?? "")) throw refused("room-id-invalid", `${room} names no 32-hex roomId`);
      return /** @type {string} */ (row.roomId);
    }
    if (typeof room?.roomId === "string" && ROOM_ID_RE.test(room.roomId)) return room.roomId;
    throw refused("room-id-invalid", "a room is a configured alias or { roomId } with 32 lowercase hexadecimal characters");
  }

  /** @param {string | undefined} cursor @param {string} what */
  static #cursor(cursor, what) {
    if (cursor === undefined) return undefined;
    try { return parseNativeCursor(String(cursor)); }
    catch { throw refused("cursor-invalid", `${what} is a native cursor, <epoch>:<sequence>`); }
  }

  /** @param {string | undefined} thread */
  static #thread(thread) {
    if (thread === undefined) return;
    const why = typeof thread === "string" ? validateNativeThread(thread) : "a thread id is a string";
    if (why) throw refused("thread-invalid", why);
  }

  /** @param {NativeServiceClient} c @param {string} where */
  static #threads(c, where) {
    if (c.capabilities.has("threads-v1")) return;
    throw refused("thread-unsupported", `${where} does not offer threads-v1 (it predates native threads), so it would answer for the whole room; nothing was sent`);
  }

  /** @param {any} raw @param {string} roomId @param {string} epoch @param {string} code */
  static #message(raw, roomId, epoch, code) {
    if (!raw || typeof raw.id !== "string" || raw.room !== roomId)
      throw refused(code, `the service delivered a message that is not one of room ${roomId}'s`);
    /** @type {ClientMessage} */
    const m = { ...wireMessage(nativeMessage(raw)), ...(AgoraClient.#purgedMarker(raw.purged) ? { purged: { at: raw.purged.at, purge: raw.purged.purge } } : {}) };
    let at;
    try { at = parseNativeCursor(m.cursor); }
    catch { throw refused(code, `the service delivered a message without a native cursor`); }
    if (at.epoch !== epoch) throw refused(code, `the service delivered a message of epoch ${at.epoch}, not ${epoch}`);
    return { m, sequence: at.sequence };
  }

  /** A purge marker as the service sends one: `{ at, purge }`. @param {any} value */
  static #purgedMarker(value) {
    return Boolean(value) && typeof value === "object" && typeof value.at === "string" && typeof value.purge === "string";
  }

  /** @param {any} raw @param {string} epoch @param {string} code */
  static #annotation(raw, epoch, code) {
    if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !ANNOTATION_ACTS.has(raw.act) || typeof raw.target !== "string" ||
        !raw.author || typeof raw.author.id !== "string" || typeof raw.author.name !== "string" || typeof raw.author.kind !== "string" ||
        (raw.text !== undefined && typeof raw.text !== "string") ||
        // an edit carries its text, unless a purge took it and says so
        (raw.act === "edit" ? typeof raw.text !== "string" && !AgoraClient.#purgedMarker(raw.purged) : typeof raw.text === "string"))
      throw refused(code, "the service delivered an annotation that is not one");
    /** @type {ClientAnnotation} */
    const a = { ...wireAnnotation(raw), ...(AgoraClient.#purgedMarker(raw.purged) ? { purged: { at: raw.purged.at, purge: raw.purged.purge } } : {}) };
    let at;
    try { at = parseNativeCursor(a.cursor); }
    catch { throw refused(code, "the service delivered an annotation without a native cursor"); }
    if (at.epoch !== epoch) throw refused(code, `the service delivered an annotation of epoch ${at.epoch}, not ${epoch}`);
    return { a, sequence: at.sequence };
  }

  /** @param {any} raw @param {string} epoch @param {string} code */
  static #purgeEvent(raw, epoch, code) {
    const ok = raw && typeof raw === "object" && typeof raw.id === "string" && typeof raw.ts === "string" && typeof raw.reason === "string" &&
      Array.isArray(raw.purged) && raw.purged.every((/** @type {unknown} */ id) => typeof id === "string") &&
      raw.by && typeof raw.by.name === "string" && (raw.thread === undefined || typeof raw.thread === "string");
    if (!ok) throw refused(code, "the service delivered a purge that is not one");
    let at;
    try { at = parseNativeCursor(String(raw.cursor)); }
    catch { throw refused(code, "the service delivered a purge without a native cursor"); }
    if (at.epoch !== epoch) throw refused(code, `the service delivered a purge of epoch ${at.epoch}, not ${epoch}`);
    /** @type {ClientPurge} */
    const p = { id: raw.id, cursor: String(raw.cursor), ts: raw.ts, purged: [...raw.purged], ...(raw.thread !== undefined ? { thread: raw.thread } : {}),
      reason: raw.reason, by: { name: raw.by.name, ...(typeof raw.by.ref === "string" ? { ref: raw.by.ref } : {}) },
      ...(typeof raw.via === "string" ? { via: raw.via } : {}) };
    return { p, sequence: at.sequence };
  }

  /** @param {NativeServiceClient} c @param {string} where @param {string} what */
  static #annotations(c, where, what) {
    if (c.capabilities.has(ANNOTATIONS_CAPABILITY)) return;
    throw refused("annotations-unsupported", `${where} does not offer ${ANNOTATIONS_CAPABILITY}, so it would ${what}; nothing was sent`);
  }

  /**
   * Read the room, ascending. Without `since`, the newest `limit` messages (the service's default
   * window when no limit is given); after `since`, at most `limit` records past it. A `thread` keeps
   * that thread's root and replies. A page too large for one frame is read again once at the limit
   * the host names, and a newest-window read shortened that way carries `gap`.
   * @param {RoomRef} room @param {{ since?: string, limit?: number, thread?: string }} [options]
   * @returns {Promise<ClientReadResult>}
   */
  async read(room, options = {}) {
    const roomId = this.#roomId(room);
    const { since, limit, thread } = options;
    const after = AgoraClient.#cursor(since, "since");
    if (limit !== undefined && !(Number.isSafeInteger(limit) && limit >= 1 && limit <= 10_000)) throw refused("limit-invalid", "limit is a whole number from 1 to 10000");
    AgoraClient.#thread(thread);
    const { client: c } = await this.#live();
    if (thread !== undefined) AgoraClient.#threads(c, "this seat's service");
    const where = "this seat's service";
    // a service that offers annotations is asked for them; one that does not has none to give
    const withAnnotations = c.capabilities.has(ANNOTATIONS_CAPABILITY);
    /** @param {number | undefined} n */
    const ask = (n) => c.request("read", { roomId, ...(thread !== undefined ? { thread } : {}), ...(since ? { since } : {}), ...(n !== undefined ? { limit: n } : {}),
      ...(withAnnotations ? { annotations: true } : {}) });
    /** @type {any} */
    let answer;
    /** the count asked for when the host named a smaller page that fits one frame */
    let requested = 0;
    try { answer = await ask(limit); }
    catch (e) {
      const fit = fittingReadLimit(e);
      if (!fit) throw classify(e, { where });
      requested = limit ?? fit.selected;
      try { answer = await ask(Math.min(fit.fits, requested)); }
      catch (again) { throw classify(again, { where }); }
    }
    let checkpoint;
    try { checkpoint = validateNativeCheckpoint(answer?.checkpoint); }
    catch (e) { throw refused("read-result-invalid", `read result carried no valid checkpoint (${said(e)})`, { cause: e }); }
    if (checkpoint.roomId !== roomId) throw refused("read-result-invalid", "read result answered for another room");
    let through = nativeCursor(checkpoint.epoch, checkpoint.sequence);
    /** @type {string | undefined} */
    let committedThrough;
    if (answer.coverage !== undefined) {
      let coverage;
      try { coverage = validateNativeReadCoverage(answer.coverage); }
      catch (e) { throw refused("read-result-invalid", `read result carried an invalid coverage block (${said(e)})`, { cause: e }); }
      if (coverage.room.roomId !== roomId || coverage.room.epoch !== checkpoint.epoch) throw refused("read-result-invalid", "read coverage names another room or epoch");
      if (coverage.toInclusive !== through) throw refused("read-result-invalid", "read coverage and checkpoint disagree on the position read to");
      committedThrough = coverage.committedThrough;
    }
    /** @type {ClientMessage[]} */
    const messages = [];
    let previous = after?.sequence ?? 0;
    for (const raw of Array.isArray(answer.messages) ? answer.messages : []) {
      const { m, sequence } = AgoraClient.#message(raw, roomId, checkpoint.epoch, "read-result-invalid");
      if (sequence <= previous || sequence > checkpoint.sequence)
        throw refused("read-result-invalid", "read result messages are out of order, at or before the cursor, or past the position read to");
      previous = sequence;
      messages.push(m);
    }
    /** @type {ClientAnnotation[]} */
    const annotations = [];
    if (withAnnotations) {
      const seen = new Set(messages.map((m) => parseNativeCursor(m.cursor).sequence));
      let before = after?.sequence ?? 0;
      for (const raw of Array.isArray(answer.annotations) ? answer.annotations : []) {
        const { a, sequence } = AgoraClient.#annotation(raw, checkpoint.epoch, "read-result-invalid");
        if (sequence <= before || sequence > checkpoint.sequence || seen.has(sequence))
          throw refused("read-result-invalid", "read result annotations are out of order, at or before the cursor, past the position read to, or at a message's position");
        before = sequence;
        annotations.push(a);
      }
    }
    this.#epochs.set(roomId, checkpoint.epoch);
    // a page cut to fit after a cursor skips nothing (it ends earlier); a newest window loses its oldest
    const gap = requested && !since ? { gap: { reason: /** @type {const} */ ("frame-limit"), requested, returned: messages.length } } : {};
    return { messages, ...(withAnnotations ? { annotations } : {}), through, ...(committedThrough ? { committedThrough } : {}), ...gap };
  }

  /**
   * Subscribe to the room after `since` (without it, after the room's committed end when the
   * subscription is made). Each subscription is its own connection. The replay after `since` is
   * delivered before `subscribe` resolves; a subscription that cannot be established rejects and
   * delivers nothing.
   * @param {RoomRef} room @param {{ since?: string, thread?: string }} options @param {SubscribeHandlers} handlers
   * @returns {Promise<ClientSubscription>}
   */
  async subscribe(room, options, handlers) {
    const roomId = this.#roomId(room);
    const { since, thread } = options ?? {};
    AgoraClient.#cursor(since, "since");
    AgoraClient.#thread(thread);
    if (typeof handlers?.message !== "function") throw refused("handlers-invalid", "subscribe needs handlers with a message function");
    if (handlers.annotation !== undefined && typeof handlers.annotation !== "function") throw refused("handlers-invalid", "an annotation handler is a function");
    if (handlers.purge !== undefined && typeof handlers.purge !== "function") throw refused("handlers-invalid", "a purge handler is a function");
    const wantsAnnotations = typeof handlers.annotation === "function";
    const wantsPurges = typeof handlers.purge === "function";
    const { client: c, path: endpoint } = await this.#dial(undefined);
    const where = `the seat service at ${endpoint}`;
    let from = since;
    try {
      if (thread !== undefined) AgoraClient.#threads(c, where);
      if (wantsAnnotations) AgoraClient.#annotations(c, where, "never deliver an annotation");
      if (wantsPurges && !c.capabilities.has(PURGE_CAPABILITY))
        throw refused("purge-unsupported", `${where} does not offer ${PURGE_CAPABILITY}, so it would never deliver a purge; nothing was sent`);
      if (from === undefined) {
        const status = /** @type {any} */ (await c.request("status", { roomId }))?.status;
        try { from = nativeCursor(status?.epoch, status?.committed); }
        catch { throw refused("status-invalid", `${where} reported no committed position for ${roomId}`); }
      }
    } catch (e) {
      c.close();
      throw classify(e, { where });
    }
    const start = parseNativeCursor(from);
    const epoch = start.epoch;
    /** the last position delivered or covered */
    let position = start.sequence;
    /** @type {'opening' | 'open' | 'ended'} */
    let state = "opening";
    /** @type {any[]} */
    const pending = [];
    const handle = {
      get cursor() { return nativeCursor(epoch, position); },
      close() { finish(undefined); },
    };
    /** @param {{ kind: 'dark' | 'refused', error: ClientError } | undefined} ending */
    const finish = (ending) => {
      if (state === "ended") return;
      const was = state;
      state = "ended";
      this.#open.delete(handle);
      c.close();
      if (ending && was === "open") handlers[ending.kind]?.(ending.error);
    };
    /** @param {{ message?: any, annotation?: any, purge?: any }} event */
    const deliver = (event) => {
      if (event.purge !== undefined) {
        let read;
        try { read = AgoraClient.#purgeEvent(event.purge, epoch, "event-invalid"); }
        catch (e) { return finish({ kind: "refused", error: /** @type {ClientError} */ (e) }); }
        if (read.sequence <= position) return;
        try { handlers.purge?.(read.p); }
        catch (e) { return finish({ kind: "refused", error: refused("handler-threw", `the purge handler threw at ${read.p.cursor}: ${said(e)}; the subscription ended before it`, { cause: e }) }); }
        position = read.sequence;
        return;
      }
      if (event.annotation !== undefined) {
        let read;
        try { read = AgoraClient.#annotation(event.annotation, epoch, "event-invalid"); }
        catch (e) { return finish({ kind: "refused", error: /** @type {ClientError} */ (e) }); }
        if (read.sequence <= position) return;
        try { handlers.annotation?.(read.a); }
        catch (e) { return finish({ kind: "refused", error: refused("handler-threw", `the annotation handler threw at ${read.a.cursor}: ${said(e)}; the subscription ended before it`, { cause: e }) }); }
        position = read.sequence;
        return;
      }
      let read;
      try { read = AgoraClient.#message(event.message, roomId, epoch, "event-invalid"); }
      catch (e) { return finish({ kind: "refused", error: /** @type {ClientError} */ (e) }); }
      if (read.sequence <= position) return;
      try { handlers.message(read.m); }
      catch (e) { return finish({ kind: "refused", error: refused("handler-threw", `the message handler threw at ${read.m.cursor}: ${said(e)}; the subscription ended before it`, { cause: e }) }); }
      position = read.sequence;
    };
    /** @param {{ message?: any, annotation?: any, purge?: any }} event */
    const accept = (event) => {
      if (state === "opening") pending.push(event);
      else if (state === "open") deliver(event);
    };
    /** @param {any} raw */
    const listener = (raw) => accept({ message: raw });
    /** @param {any} raw */
    const annotationListener = (raw) => accept({ annotation: raw });
    /** @param {any} raw */
    const purgeListener = (raw) => accept({ purge: raw });
    this.#open.add(handle);
    c.socket.once("close", () => finish({ kind: "dark", error: dark("service-dark", `${where} closed the connection`) }));
    try {
      const result = /** @type {any} */ (await c.subscribe(roomId, from, listener, thread, wantsAnnotations ? annotationListener : undefined, wantsPurges ? purgeListener : undefined));
      let checkpoint;
      try { checkpoint = validateNativeCheckpoint(result?.checkpoint); }
      catch (e) { throw refused("subscribe-result-invalid", `the subscription carried no valid checkpoint (${said(e)})`, { cause: e }); }
      if (checkpoint.roomId !== roomId || checkpoint.epoch !== epoch || checkpoint.sequence < position)
        throw refused("subscribe-result-invalid", "the subscription's checkpoint names another room, another epoch, or a position before the cursor");
      // the socket may have closed while the answer was on its way: `finish` ran from its close
      if (/** @type {string} */ (state) === "ended") throw dark("service-dark", `${where} closed the connection`);
      state = "open";
      this.#epochs.set(roomId, epoch);
      // the replay, and anything pushed behind it, in the order it arrived
      for (const raw of pending.splice(0)) if (state === "open") deliver(raw);
      // what the service passed over to its committed end is covered, unless a handler ended it first
      if (state === "open") position = Math.max(position, checkpoint.sequence);
      return handle;
    } catch (e) {
      finish(undefined);
      throw classify(e, { where });
    }
  }

  /**
   * Append one message. The service stamps the author's id from the seat account and `via` from
   * this connection's client name; the app names the person (`author.name`, and `author.ref` when it
   * declared a client name). No signature line is added. `trailers` become a block after the body,
   * the way the CLI writes one. The client never resends: on `unknown-acceptance` the caller resends
   * under the returned `operationId`, and the host returns the original receipt if it had committed.
   * @param {RoomRef} room @param {AppendRequest} request @returns {Promise<AppendReceipt>}
   */
  async append(room, request) {
    const operationId = request?.operationId ?? randomUUID().replaceAll("-", "");
    try {
      return await this.#append(room, request, operationId);
    } catch (e) {
      // every failure after the frame left is classified where it is sent; anything else stopped
      // this side before the service saw a byte, so it is a definite no
      const error = e instanceof ClientError ? e : refused("append-invalid", said(e), { cause: e });
      error.operationId ??= operationId;
      throw error;
    }
  }

  /** @param {RoomRef} room @param {AppendRequest} request @param {string} operationId @returns {Promise<AppendReceipt>} */
  async #append(room, request, operationId) {
    const roomId = this.#roomId(room);
    if (typeof request !== "object" || request === null) throw refused("append-invalid", "append takes { text, author, thread?, trailers?, operationId?, attachments? }");
    if (typeof operationId !== "string" || !OPERATION_ID_RE.test(operationId)) throw refused("operation-id-invalid", "an operation id is 16-128 letters, digits, _ or -");
    if (typeof request.text !== "string") throw refused("text-invalid", "text is a string");
    const author = request.author;
    if (typeof author?.name !== "string" || !AUTHOR_KINDS.has(author.kind) || !author.name.trim() || author.name.length > 120)
      throw refused("author-invalid", "author is { kind: human | agent | system, name: 1-120 characters, ref? }");
    if (author.ref !== undefined) {
      if (this.clientName === undefined)
        throw refused("author-ref-without-client", "an author ref is an app client's own id for the person, and this client declared no client name");
      if (typeof author.ref !== "string" || !AUTHOR_REF_PATTERN.test(author.ref)) throw refused("author-ref-invalid", "an author ref is 1-64 letters, digits or . _ @ + -");
    }
    AgoraClient.#thread(request.thread);
    if (request.trailers !== undefined && !Array.isArray(request.trailers)) throw refused("trailer-invalid", "trailers is a list of [key, value] pairs");
    /** @type {import('./trailers.mjs').Trailer[]} */
    const entries = [];
    for (const pair of request.trailers ?? []) {
      const [key, value] = Array.isArray(pair) ? pair : [];
      const v = typeof value === "string" ? value.trim() : "";
      if (!trailerKeyOk(key) || !trailerValueOk(v))
        throw refused("trailer-invalid", "a trailer is [key, value]: a lower-case key of up to 24 characters and a one-line value of 1-400 characters");
      entries.push({ key, value: v });
    }
    const text = withTrailers(request.text, entries);
    if (Buffer.byteLength(text, "utf8") > TEXT_MAX_BYTES) throw refused("text-too-long", `the text is over ${TEXT_MAX_BYTES} bytes`);
    /** @type {import("./protocol/attachment.mjs").WireAttachment[] | undefined} */
    let attachments;
    if (request.attachments !== undefined) {
      if (!Array.isArray(request.attachments)) throw refused("attachment-invalid", "attachments is a list of the references upload returned");
      try { attachments = request.attachments.map((a) => validateWireAttachment(a)); }
      catch (e) { throw refused("attachment-invalid", `an attachment is not a valid reference (${said(e)})`, { cause: e }); }
    }
    let conn;
    try { conn = await this.#live(); }
    catch (e) {
      const error = /** @type {ClientError} */ (e);
      if (error.outcome === "dark") throw dark(error.code, `room-dark: ${error.message}; nothing was posted and no cursor was issued`, { cause: error, operationId });
      throw error;
    }
    const { client: c, accountId } = conn;
    if (request.thread !== undefined) AgoraClient.#threads(c, "this seat's service");
    // a durable reference goes only to a service that holds custody; an older one would store it
    // as bare metadata with no bytes behind it
    if (attachments?.some((a) => a.lifetime === "durable") && !c.capabilities?.has(ATTACHMENTS_CAPABILITY))
      throw refused("attachments-unsupported", "this seat's service offers no attachments-v1; nothing was posted");
    // the seat-private secret never enters a room, whoever typed it
    if (this.#secret !== undefined && text.includes(this.#secret))
      throw refused("service-secret-in-text", "the text carries the seat service secret; nothing was posted");
    const operation = { operationId, authorName: author.name, authorKind: author.kind, text,
      ...(request.thread !== undefined ? { thread: request.thread } : {}),
      ...(author.ref !== undefined ? { authorRef: author.ref } : {}),
      ...(attachments?.length ? { attachments } : {}) };
    // the frame the request client will write, measured as the encoder measures it, so an append
    // that cannot cross is refused here rather than thrown from inside the send
    if (nativeFramePayloadBytes({ roomId, operation, protocol: NATIVE_PROTOCOL, type: "append", requestId: "0".repeat(32) }) > NATIVE_FRAME_MAX)
      throw refused("text-too-long", "the append would not fit one native frame");
    /** @type {any} */
    let ack;
    try { ack = await c.request("append", { roomId, operation }); }
    catch (e) { throw classify(e, { append: true, operationId, where: "this seat's service" }); }
    const receipt = { roomId, accountId, operationId, id: ack?.id, cursor: ack?.cursor };
    try {
      const epoch = this.#epochs.get(roomId);
      if (epoch) assertReceiptContext(receipt, { roomId, accountId, operationId, epoch });
      else validateNativeCommitReceipt(receipt);
    } catch (e) {
      throw refused("receipt-mismatch", `the receipt does not answer this operation (${said(e)})`, { cause: e });
    }
    return { id: String(ack.id), cursor: String(ack.cursor), duplicate: ack.duplicate === true, operationId };
  }

  /**
   * Annotate one message (docs/ANNOTATIONS.md): edit or withdraw a message this author posted, or
   * pin or unpin one. The annotation is its own record; the message is never rewritten. Refused
   * `annotations-unsupported` before anything is sent when the service does not offer
   * annotations-v1. Outcomes and resending are exactly an append's: on `unknown-acceptance` resend
   * under the returned `operationId`.
   * @param {RoomRef} room @param {AnnotateRequest} request @returns {Promise<AnnotateReceipt>}
   */
  async annotate(room, request) {
    const operationId = request?.operationId ?? randomUUID().replaceAll("-", "");
    try {
      return await this.#annotate(room, request, operationId);
    } catch (e) {
      const error = e instanceof ClientError ? e : refused("annotation-invalid", said(e), { cause: e });
      error.operationId ??= operationId;
      throw error;
    }
  }

  /** @param {RoomRef} room @param {AnnotateRequest} request @param {string} operationId @returns {Promise<AnnotateReceipt>} */
  async #annotate(room, request, operationId) {
    const roomId = this.#roomId(room);
    if (typeof request !== "object" || request === null) throw refused("annotation-invalid", "annotate takes { act, target, text?, author, operationId? }");
    if (typeof operationId !== "string" || !OPERATION_ID_RE.test(operationId)) throw refused("operation-id-invalid", "an operation id is 16-128 letters, digits, _ or -");
    const { act, target, text } = request;
    if (typeof act !== "string" || !ANNOTATION_ACTS.has(act)) throw refused("annotation-invalid", "act is edit, withdraw, pin or unpin");
    if (typeof target !== "string" || !OPERATION_ID_RE.test(target)) throw refused("annotation-invalid", "target is a message id");
    if (act === "edit") {
      if (typeof text !== "string") throw refused("annotation-invalid", "an edit carries its new text");
      if (Buffer.byteLength(text, "utf8") > TEXT_MAX_BYTES) throw refused("text-too-long", `the text is over ${TEXT_MAX_BYTES} bytes`);
    } else if (text !== undefined) throw refused("annotation-invalid", `a ${act} carries no text`);
    const author = request.author;
    if (typeof author?.name !== "string" || !AUTHOR_KINDS.has(author.kind) || !author.name.trim() || author.name.length > 120)
      throw refused("author-invalid", "author is { kind: human | agent | system, name: 1-120 characters, ref? }");
    if (author.ref !== undefined) {
      if (this.clientName === undefined)
        throw refused("author-ref-without-client", "an author ref is an app client's own id for the person, and this client declared no client name");
      if (typeof author.ref !== "string" || !AUTHOR_REF_PATTERN.test(author.ref)) throw refused("author-ref-invalid", "an author ref is 1-64 letters, digits or . _ @ + -");
    }
    let conn;
    try { conn = await this.#live(); }
    catch (e) {
      const error = /** @type {ClientError} */ (e);
      if (error.outcome === "dark") throw dark(error.code, `room-dark: ${error.message}; nothing was annotated and no cursor was issued`, { cause: error, operationId });
      throw error;
    }
    const { client: c, accountId } = conn;
    AgoraClient.#annotations(c, "this seat's service", "not keep an annotation");
    if (this.#secret !== undefined && typeof text === "string" && text.includes(this.#secret))
      throw refused("service-secret-in-text", "the text carries the seat service secret; nothing was annotated");
    const operation = { kind: "annotation", operationId, authorName: author.name, authorKind: author.kind,
      annotation: { act, target, ...(act === "edit" ? { text } : {}) },
      ...(author.ref !== undefined ? { authorRef: author.ref } : {}) };
    if (nativeFramePayloadBytes({ roomId, operation, protocol: NATIVE_PROTOCOL, type: "append", requestId: "0".repeat(32) }) > NATIVE_FRAME_MAX)
      throw refused("text-too-long", "the annotation would not fit one native frame");
    /** @type {any} */
    let ack;
    try { ack = await c.request("append", { roomId, operation }); }
    catch (e) { throw classify(e, { append: true, operationId, where: "this seat's service" }); }
    const receipt = { roomId, accountId, operationId, id: ack?.id, cursor: ack?.cursor };
    try {
      const epoch = this.#epochs.get(roomId);
      if (epoch) assertReceiptContext(receipt, { roomId, accountId, operationId, epoch });
      else validateNativeCommitReceipt(receipt);
    } catch (e) {
      throw refused("receipt-mismatch", `the receipt does not answer this operation (${said(e)})`, { cause: e });
    }
    return { id: String(ack.id), cursor: String(ack.cursor), duplicate: ack.duplicate === true, operationId };
  }

  /**
   * Purge (docs/PURGE.md): the named messages, and with `thread` that root and every reply, lose
   * their text, and custody lets go of the attachment bytes no remaining message references. Every
   * record keeps its place, so a reader's cursor stays valid. A version 1 room refuses
   * `purge-unsupported-log-version`. Outcomes and resending are exactly an append's: on
   * `unknown-acceptance` resend under the returned `operationId`, which finishes a purge whose
   * rewrite was interrupted and answers with the original receipt.
   * @param {RoomRef} room @param {PurgeRequest} request @returns {Promise<PurgeReceipt>}
   */
  async purge(room, request) {
    const operationId = request?.operationId ?? randomUUID().replaceAll("-", "");
    try {
      return await this.#purge(room, request, operationId);
    } catch (e) {
      const error = e instanceof ClientError ? e : refused("purge-invalid", said(e), { cause: e });
      error.operationId ??= operationId;
      throw error;
    }
  }

  /** @param {RoomRef} room @param {PurgeRequest} request @param {string} operationId @returns {Promise<PurgeReceipt>} */
  async #purge(room, request, operationId) {
    const roomId = this.#roomId(room);
    if (typeof request !== "object" || request === null) throw refused("purge-invalid", "purge takes { targets?, thread?, reason, author, operationId? }");
    if (typeof operationId !== "string" || !OPERATION_ID_RE.test(operationId)) throw refused("operation-id-invalid", "an operation id is 16-128 letters, digits, _ or -");
    const targets = request.targets ?? [];
    if (!Array.isArray(targets) || targets.length > 1000 || !targets.every((t) => typeof t === "string" && OPERATION_ID_RE.test(t)))
      throw refused("purge-invalid", "targets is a list of up to 1000 message ids");
    if (new Set(targets).size !== targets.length) throw refused("purge-invalid", "a purge names each target once");
    if (request.thread !== undefined) AgoraClient.#thread(request.thread);
    if (!targets.length && request.thread === undefined) throw refused("purge-invalid", "a purge names at least one message or a thread");
    if (typeof request.reason !== "string" || !request.reason.trim() || request.reason.length > 1000)
      throw refused("purge-invalid", "a purge carries a reason of 1-1000 characters");
    const author = request.author;
    if (typeof author?.name !== "string" || !AUTHOR_KINDS.has(author.kind) || !author.name.trim() || author.name.length > 120)
      throw refused("author-invalid", "author is { kind: human | agent | system, name: 1-120 characters, ref? }");
    if (author.ref !== undefined) {
      if (this.clientName === undefined)
        throw refused("author-ref-without-client", "an author ref is an app client's own id for the person, and this client declared no client name");
      if (typeof author.ref !== "string" || !AUTHOR_REF_PATTERN.test(author.ref)) throw refused("author-ref-invalid", "an author ref is 1-64 letters, digits or . _ @ + -");
    }
    if (this.#secret !== undefined && request.reason.includes(this.#secret))
      throw refused("service-secret-in-text", "the reason carries the seat service secret; nothing was purged");
    let conn;
    try { conn = await this.#live(); }
    catch (e) {
      const error = /** @type {ClientError} */ (e);
      if (error.outcome === "dark") throw dark(error.code, `room-dark: ${error.message}; nothing was purged and no cursor was issued`, { cause: error, operationId });
      throw error;
    }
    const { client: c, accountId } = conn;
    if (request.thread !== undefined) AgoraClient.#threads(c, "this seat's service");
    if (!c.capabilities.has(PURGE_CAPABILITY))
      throw refused("purge-unsupported", `this seat's service does not offer ${PURGE_CAPABILITY}, so it keeps no purge; nothing was purged`);
    const operation = { kind: "purge", operationId, authorName: author.name, authorKind: author.kind,
      purge: { targets, ...(request.thread !== undefined ? { thread: request.thread } : {}), reason: request.reason },
      ...(author.ref !== undefined ? { authorRef: author.ref } : {}) };
    if (nativeFramePayloadBytes({ roomId, operation, protocol: NATIVE_PROTOCOL, type: "append", requestId: "0".repeat(32) }) > NATIVE_FRAME_MAX)
      throw refused("purge-invalid", "the purge would not fit one native frame");
    /** @type {any} */
    let ack;
    try { ack = await c.request("append", { roomId, operation }); }
    catch (e) { throw classify(e, { append: true, operationId, where: "this seat's service" }); }
    const receipt = { roomId, accountId, operationId, id: ack?.id, cursor: ack?.cursor };
    try {
      const epoch = this.#epochs.get(roomId);
      if (epoch) assertReceiptContext(receipt, { roomId, accountId, operationId, epoch });
      else validateNativeCommitReceipt(receipt);
    } catch (e) {
      throw refused("receipt-mismatch", `the receipt does not answer this operation (${said(e)})`, { cause: e });
    }
    if (ack.kind !== "purge" || !Array.isArray(ack.purged) || !ack.purged.every((/** @type {unknown} */ id) => typeof id === "string"))
      throw refused("receipt-mismatch", "the service did not answer with a purge receipt (an older service keeps no purge)");
    return { id: String(ack.id), cursor: String(ack.cursor), duplicate: ack.duplicate === true, operationId,
      purged: [...ack.purged], blobsRemoved: Number.isSafeInteger(ack.blobsRemoved) ? ack.blobsRemoved : 0,
      facesOutOfReach: Array.isArray(ack.facesOutOfReach) ? ack.facesOutOfReach : [] };
  }

  /**
   * The seam `upload` and `attachment` hand to their module: this client's room resolution, live
   * connection, offered capabilities and outcome constructors.
   * @returns {import("./client-attachments.mjs").AttachmentSeam}
   */
  #attachmentSeam() {
    return {
      roomId: (room) => this.#roomId(/** @type {RoomRef} */ (room)),
      live: () => this.#live(),
      capabilities: () => this.#capabilities,
      refused, dark, classify,
    };
  }

  /**
   * Upload one file into a room's custody (docs/ATTACHMENTS.md); the reference it resolves with
   * goes into `append`'s `attachments`.
   * @param {RoomRef} room @param {import("./client-attachments.mjs").UploadRequest} request
   * @returns {Promise<import("./protocol/attachment.mjs").WireAttachment>}
   */
  upload(room, request) {
    return uploadAttachment(this.#attachmentSeam(), room, request);
  }

  /**
   * Read one installed attachment's bytes, verified against its digest. Local connections only.
   * @param {RoomRef} room @param {import("./client-attachments.mjs").AttachmentRef} ref
   * @returns {Promise<import("./client-attachments.mjs").AttachmentBytes>}
   */
  attachment(room, ref) {
    return readAttachment(this.#attachmentSeam(), room, ref);
  }

  /**
   * The default on top: a subscription that comes back. After a dark socket it subscribes again
   * from its own cursor, waiting `backoffMs` step by step (the last step repeats, and a live
   * subscription starts the ladder over). It never hands a message over twice: it resubscribes
   * after the last position delivered or covered, and within a room's epoch a position names one
   * message. After a refusal it stops and reports. `cursor` is that last position, for the caller
   * to persist if it wants.
   * @param {RoomRef} room @param {{ since?: string, thread?: string }} options @param {FollowHandlers} handlers
   * @param {{ backoffMs?: readonly number[] }} [tuning]
   * @returns {Follow}
   */
  follow(room, options, handlers, tuning = {}) {
    this.#roomId(room);
    const { since, thread } = options ?? {};
    AgoraClient.#cursor(since, "since");
    AgoraClient.#thread(thread);
    if (typeof handlers?.message !== "function") throw refused("handlers-invalid", "follow needs handlers with a message function");
    if (handlers.annotation !== undefined && typeof handlers.annotation !== "function") throw refused("handlers-invalid", "an annotation handler is a function");
    if (handlers.purge !== undefined && typeof handlers.purge !== "function") throw refused("handlers-invalid", "a purge handler is a function");
    const onAnnotation = handlers.annotation;
    const onPurge = handlers.purge;
    const ladder = tuning.backoffMs ?? FOLLOW_BACKOFF_MS;
    if (!Array.isArray(ladder) || !ladder.length || !ladder.every((ms) => Number.isFinite(ms) && ms >= 0))
      throw refused("backoff-invalid", "backoffMs is a non-empty list of non-negative milliseconds");
    /** @type {string | undefined} */
    let cursor = since;
    /** @type {ClientSubscription | undefined} */
    let sub;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    let stopped = false;
    let attempt = 0;
    /** @param {FollowState} s @param {ClientError} [error] */
    const report = (s, error) => { if (!stopped) handlers.state?.(s, error); };
    const open = this.#open;
    const handle = {
      get cursor() { return sub ? sub.cursor : cursor; },
      close() {
        if (stopped) return;
        stopped = true;
        clearTimeout(timer);
        sub?.close();
        open.delete(handle);
      },
    };
    /** @param {ClientError} error */
    const ended = (error) => {
      if (stopped) return;
      if (sub) cursor = sub.cursor;
      sub = undefined;
      if (error.outcome === "refused") { report("refused", error); handle.close(); return; }
      report("dark", error);
      timer = setTimeout(start, ladder[Math.min(attempt, ladder.length - 1)]);
      attempt += 1;
    };
    const start = async () => {
      try {
        const s = await this.subscribe(room, { ...(cursor !== undefined ? { since: cursor } : {}), ...(thread !== undefined ? { thread } : {}) }, {
          message: (m) => {
            if (stopped) return;
            handlers.message(m);
            cursor = m.cursor;
          },
          // an annotation moves the cursor like a message, so a resubscription after a dark
          // period starts past it and never hands it over twice
          ...(onAnnotation ? { annotation: (/** @type {ClientAnnotation} */ a) => {
            if (stopped) return;
            onAnnotation(a);
            cursor = a.cursor;
          } } : {}),
          // a purge moves the cursor too, so it is handed over once across a dark period
          ...(onPurge ? { purge: (/** @type {ClientPurge} */ p) => {
            if (stopped) return;
            onPurge(p);
            cursor = p.cursor;
          } } : {}),
          dark: ended,
          refused: ended,
        });
        if (stopped) { s.close(); return; }
        sub = s;
        attempt = 0;
        report("live");
      } catch (e) {
        ended(/** @type {ClientError} */ (e));
      }
    };
    open.add(handle);
    void start();
    return handle;
  }

  /** Close every connection, subscription and follow this client holds. A client exit stops nothing on the service. */
  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const open of [...this.#open]) open.close();
    void this.#requesting?.then(({ client }) => client.close(), () => undefined);
    this.#requesting = undefined;
  }
}
