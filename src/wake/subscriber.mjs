// @ts-check
import { readFile } from "node:fs/promises";
import path from "node:path";
import { AgoraError, parseSignature } from "../core.mjs";
import { NativeServiceClient } from "../native-service.mjs";
import { nativeCursor, parseNativeCursor } from "../native-protocol.mjs";
import { pidAlive } from "../session.mjs";
import { WATCH_STOP } from "../watch.mjs";

/**
 * The native subscriber: the wake adapter a session runs against the seat service.
 *
 * The service fans out bytes and never wakes anything. Everything that makes a wake THIS
 * session's stays in this process: the cursor it subscribes from and advances, the ledger that
 * says which posts are its own, the wake predicate it chose, and the lines it prints. None of that
 * is sent to the service; a `subscribe` carries a room and a cursor, nothing else, so a
 * counterpart's trailer can never steer what the service pushes here.
 *
 * The subscription is consumed through the same `watch()` loop the poller runs, as a transport
 * read: `read` drains what the service has pushed since the cursor, and the loop's sleep becomes a
 * wait that ends early when something arrives. So own-post suppression, the wake filter,
 * coalescing, the cursor-after-delivery rule and the result line are reused, not copied, and the
 * state layout is untouched: the same cursor file, the same ledger, the same armed record.
 *
 * A closed socket is an event, never silence. `read` throws a `ServiceDarkError` once the buffered
 * deliveries are drained; the loop ends the way a guard ends it, with the reason on the result and
 * exit 1, because exit 0 reads as a quiet room and this room was not quiet, it was unreachable.
 */

/** The machine-readable reason a watch ends with when its seat service is unreachable. */
export const SERVICE_DARK = "service-dark";

export class ServiceDarkError extends AgoraError {
  /** @param {string} message */
  constructor(message) {
    super(message, 1);
    this.name = "ServiceDarkError";
    /** What a watch puts on its result line; the exit code stays 1. */
    this.reason = SERVICE_DARK;
    this[WATCH_STOP] = SERVICE_DARK;
  }
}

const ROOM_ID_RE = /^[a-f0-9]{32}$/;

/** @param {unknown} value @param {string} label */
export function validateNativeRoomId(value, label = "native room id") {
  if (typeof value !== "string" || !ROOM_ID_RE.test(value)) throw new AgoraError(`${label} must be 32 lowercase hexadecimal characters`);
  return value;
}

/** Where the seat service publishes its advisory descriptor. @param {string} stateRoot */
export function serviceDescriptorPath(stateRoot) {
  return path.join(stateRoot, "native", "service.json");
}

/**
 * @typedef {object} ServiceDescriptor
 * @property {string} path
 * @property {string} nonce the seat-private service secret; never printed, never sent
 * @property {string} bootEpoch
 * @property {string} accountId
 * @property {string} seatLabel
 * @property {number} [pid]
 * @property {string} [startedAt]
 */

/**
 * The descriptor, or a `ServiceDarkError` naming why there is none. A descriptor is advisory: the
 * bind is the live authority, so a stale file is discovered by the connection, not here.
 * @param {string} stateRoot
 * @returns {Promise<ServiceDescriptor>}
 */
export async function readServiceDescriptor(stateRoot) {
  const file = serviceDescriptorPath(stateRoot);
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (e) {
    const code = /** @type {NodeJS.ErrnoException} */ (e).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw new ServiceDarkError(`no seat service descriptor at ${file}; the native service is not running on this seat`);
    throw new ServiceDarkError(`seat service descriptor ${file} cannot be read (${code ?? String(e)})`);
  }
  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ServiceDarkError(`seat service descriptor ${file} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.path !== "string" || typeof parsed.nonce !== "string")
    throw new ServiceDarkError(`seat service descriptor ${file} does not describe an endpoint`);
  return parsed;
}

/**
 * What `doctor` may say about the service without connecting: the descriptor's public fields and
 * whether the pid it names still answers. Never the nonce.
 * @param {string} stateRoot
 * @returns {Promise<{ descriptor: string, present: boolean, pid?: number, pidAlive?: boolean, bootEpoch?: string, accountId?: string, seatLabel?: string, startedAt?: string, endpoint?: string, error?: string }>}
 */
export async function serviceDescriptorStatus(stateRoot) {
  const descriptor = serviceDescriptorPath(stateRoot);
  try {
    const d = await readServiceDescriptor(stateRoot);
    return {
      descriptor, present: true,
      ...(typeof d.pid === "number" ? { pid: d.pid, pidAlive: pidAlive(d.pid) } : {}),
      bootEpoch: d.bootEpoch, accountId: d.accountId, seatLabel: d.seatLabel,
      ...(d.startedAt ? { startedAt: d.startedAt } : {}), endpoint: d.path,
    };
  } catch (e) {
    return { descriptor, present: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Connect to the seat service through the descriptor. The hello is the client's (server-auth-first,
 * transcript-bound); every way it can fail is the service being dark to this session.
 * @param {string} stateRoot
 * @param {{ connect?: typeof NativeServiceClient.connect, timeoutMs?: number }} [deps]
 */
export async function connectSeatService(stateRoot, deps = {}) {
  const descriptor = await readServiceDescriptor(stateRoot);
  const connect = deps.connect ?? NativeServiceClient.connect;
  try {
    return { client: await connect({ ...descriptor, ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}) }), descriptor };
  } catch (e) {
    throw new ServiceDarkError(`seat service at ${descriptor.path} is dark: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * A message as the service committed it, in the shape every transport reports. The service already
 * stamped `author.id` from the arriving route; this side adds only what it can read off the text.
 * @param {any} message
 * @returns {import('../core.mjs').Message}
 */
export function nativeMessage(message) {
  const text = String(message.text ?? "");
  return {
    id: String(message.id),
    room: String(message.room),
    ...(message.thread ? { thread: String(message.thread) } : {}),
    author: message.author ?? { id: "unknown", name: "unknown", kind: "unknown" },
    text,
    signedAs: parseSignature(text),
    ts: String(message.ts),
    cursor: String(message.cursor),
    ...(Array.isArray(message.attachments) && message.attachments.length ? { attachments: message.attachments } : {}),
  };
}

/** @param {import('../core.mjs').Message} m */
const sequenceOf = (m) => parseNativeCursor(m.cursor).sequence;

/**
 * What a session with no saved position subscribes from: the newest window, as a read with no
 * cursor returns on every transport (a local room gives the newest 1000 lines). The service
 * requires the cursor to be explicit and replays everything after it, so "from the start" on a
 * long room would replay the whole log; the window keeps a first arm bounded, and `cursor --set
 * <epoch>:0` is the way to ask for the start on purpose.
 */
export const SUBSCRIBE_WINDOW = 1000;

/**
 * @typedef {object} NativeSubscription
 * @property {string} roomId
 * @property {{ id: string, seatLabel: string }} seat the service account this seat posts as
 * @property {(opts?: import('../core.mjs').ReadOptions) => Promise<import('../core.mjs').ReadResult>} read
 *   what the service pushed since the cursor, ascending; empty when nothing has; throws
 *   `ServiceDarkError` once the service is gone and the buffer is drained
 * @property {(ms: number) => Promise<void>} wait resolves when something arrives, when the service
 *   goes dark, or after `ms`, whichever is first: the watch loop's sleep
 * @property {() => string | undefined} dark why the service is dark, once it is
 * @property {{ from: string, to: string, count: number } | null} neverOffered when the session had no
   saved position and the room was longer than the window: the committed sequence positions this
   subscription started after, so they were never offered to this session. Stated as positions,
   never as cursor movement (a cursor advances past filtered and own messages too, so it is no
   evidence of delivery); `cursor --set <epoch>:0` is how the session asks to be offered them
 * @property {() => void} close
 */

/**
 * Subscribe to a room from this session's cursor. The replay the service answers with and the
 * events it pushes afterwards form one ordered stream; the subscription keeps the stream in order
 * and hands out each sequence once. The service holds only the last sequence written to this
 * socket; the cursor is this session's and is advanced by the caller after delivery.
 * @param {{ stateRoot: string, roomId: string, since?: string, connect?: typeof NativeServiceClient.connect, timeoutMs?: number, window?: number }} opts
 * @returns {Promise<NativeSubscription>}
 */
export async function openNativeSubscription(opts) {
  const roomId = validateNativeRoomId(opts.roomId);
  const { client, descriptor } = await connectSeatService(opts.stateRoot, { connect: opts.connect, timeoutMs: opts.timeoutMs });
  /** @type {import('../core.mjs').Message[]} */
  let queue = [];
  /** @type {string | undefined} */
  let darkReason;
  /** @type {Set<() => void>} */
  const waiters = new Set();
  const wake = () => {
    for (const w of waiters) w();
    waiters.clear();
  };
  /**
   * Dark is a fact about the channel, never about the words in an error: the socket is closed or
   * errored, or the service never answered. A request the service answered with a refusal (an
   * unknown room, a foreign epoch, a backlog it will not replay) arrived on a live socket and is
   * this session's to recover, so it propagates as the ordinary error it is.
   * @param {unknown} e
   */
  const classify = (e) => {
    const dark = darkReason !== undefined || client.socket.destroyed || !client.socket.writable;
    client.close();
    if (!dark) return e;
    return new ServiceDarkError(`seat service at ${descriptor.path} is dark: ${e instanceof Error ? e.message : String(e)}`);
  };
  const markDark = (/** @type {string} */ why) => {
    if (darkReason === undefined) darkReason = why;
    wake();
  };
  client.socket.on("close", () => markDark(`seat service at ${descriptor.path} closed the connection`));
  client.socket.on("error", (e) => markDark(`seat service at ${descriptor.path} failed: ${e instanceof Error ? e.message : String(e)}`));
  let since = opts.since;
  /** @type {{ from: string, to: string, count: number } | null} */
  let neverOffered = null;
  if (!since) {
    // the service refuses a subscription with no cursor (it replays the backlog after one), so a
    // session with no saved position asks where the room is and starts at the newest window
    const window = opts.window && opts.window > 0 ? opts.window : SUBSCRIBE_WINDOW;
    let status;
    try { status = (await client.request("status", { roomId })).status; }
    catch (e) { throw classify(e); }
    const epoch = String(status.epoch);
    const committed = Number(status.committed);
    const start = Math.max(0, committed - window);
    since = nativeCursor(epoch, start);
    // what a first arm was never offered is said, never silent: the positions are named on the
    // subscription and the caller prints them with the way to ask for them
    if (start > 0) neverOffered = { from: nativeCursor(epoch, 1), to: nativeCursor(epoch, start), count: start };
  }
  /** Highest sequence handed out by `read`; nothing at or below it is handed out again. */
  let drained = parseNativeCursor(since).sequence;
  const push = (/** @type {any[]} */ messages) => {
    let added = false;
    for (const raw of messages) {
      let m;
      try { m = nativeMessage(raw); sequenceOf(m); }
      catch { continue; }
      if (queue.some((q) => q.id === m.id)) continue;
      queue.push(m);
      added = true;
    }
    if (added) {
      queue.sort((a, b) => sequenceOf(a) - sequenceOf(b));
      wake();
    }
  };
  let result;
  try {
    result = await client.subscribe(roomId, since, (message) => push([message]));
  } catch (e) { throw classify(e); }
  push(Array.isArray(result?.messages) ? result.messages : []);
  return {
    roomId,
    seat: { id: descriptor.accountId, seatLabel: descriptor.seatLabel },
    neverOffered,
    async read(readOpts = {}) {
      const floor = readOpts.since ? Math.max(drained, parseNativeCursor(readOpts.since).sequence) : drained;
      const limit = readOpts.limit && readOpts.limit > 0 ? readOpts.limit : Infinity;
      /** @type {import('../core.mjs').Message[]} */
      const out = [];
      /** @type {import('../core.mjs').Message[]} */
      const keep = [];
      for (const m of queue) {
        const s = sequenceOf(m);
        if (s <= floor) continue;
        if (out.length < limit) out.push(m); else keep.push(m);
      }
      queue = keep;
      if (out.length) drained = sequenceOf(out[out.length - 1]);
      else if (darkReason !== undefined) throw new ServiceDarkError(darkReason);
      return /** @type {import('../core.mjs').ReadResult} */ (out);
    },
    wait(ms) {
      if (queue.length || darkReason !== undefined) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(() => { waiters.delete(done); resolve(); }, Math.max(0, ms));
        const done = () => { clearTimeout(timer); resolve(); };
        waiters.add(done);
      });
    },
    dark: () => darkReason,
    close() {
      client.close();
    },
  };
}
