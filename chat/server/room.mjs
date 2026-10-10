// @ts-check
/**
 * The room through `agora/client`: connect with the host's client name, read history, follow the
 * room live, and append. Holds no state on disk.
 *
 * The client module is imported by path from the host's agora checkout (`<agoraDir>/src/client.mjs`)
 * once at start, so the kit runs against the agora the seat runs, never a copy of its own. A
 * definite no at start (a config the client refuses, an alias that is not a native room, a service
 * that will not stamp the client name) turns the room off with its reason; a dark service is not a
 * no, and is reached again on use.
 *
 * One follow serves the whole room: the kit's index is always its first listener, and every open
 * stream is fanned out from it (a stream on one thread keeps that thread's records). The follow
 * starts where the index ends, so whatever the room committed while the kit was away is indexed
 * before anything is fanned out.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The part of agora's client the kit uses (its contract is docs/CLIENT.md in the agora checkout).
// It is imported by path at run time, so it is typed here and checked on arrival.

/** @typedef {'refused' | 'dark' | 'unknown-acceptance'} Outcome */
/** @typedef {'live' | 'dark' | 'refused'} FollowState */
/**
 * @typedef {{ id: string, room?: string, cursor: string, ts: string, text: string, thread?: string, via?: string,
 *   author: { id?: string, name: string, kind: string, ref?: string },
 *   to?: string[], trailers?: Array<{ key: string, value: string }>, signedAs?: string,
 *   attachments?: Array<Record<string, any>>, [key: string]: unknown }} RoomMessage
 * @typedef {{ id: string, cursor: string, ts: string, act: string, target: string, text?: string,
 *   author: { id?: string, name: string, kind: string, ref?: string }, via?: string }} RoomAnnotation
 * @typedef {{ id: string, cursor: string, ts: string, purged: string[], thread?: string, reason: string, by: { name: string, ref?: string }, via?: string }} RoomPurge
 * @typedef {{ id: string, cursor: string, duplicate: boolean, operationId: string }} Receipt
 * @typedef {{ kind: 'human' | 'agent' | 'system', name: string, ref?: string }} Author
 * @typedef {{ text: string, author: Author, thread?: string, trailers?: Array<[string, string]>, operationId: string, attachments?: Array<Record<string, any>> }} AppendRequest
 * @typedef {{ messages: RoomMessage[], annotations?: RoomAnnotation[], through: string, committedThrough?: string, gap?: unknown }} ReadResult
 * @typedef {{ readonly cursor: string | undefined, close(): void }} AgoraFollow
 * @typedef {{
 *   capabilities: Set<string>,
 *   rooms(): Array<{ alias: string, roomId: string }>,
 *   read(room: string, options: { since?: string, limit?: number, thread?: string }): Promise<ReadResult>,
 *   append(room: string, request: AppendRequest): Promise<Receipt>,
 *   annotate(room: string, request: Record<string, any>): Promise<Receipt>,
 *   purge(room: string, request: Record<string, any>): Promise<Receipt & { purged: string[], blobsRemoved: number, facesOutOfReach: unknown[] }>,
 *   upload(room: string, request: Record<string, any>): Promise<Record<string, any>>,
 *   attachment(room: string, ref: { id: string, digest: string }): Promise<Record<string, any>>,
 *   follow(room: string, options: { since?: string, thread?: string },
 *     handlers: { message(m: RoomMessage): void, annotation?(a: RoomAnnotation): void, purge?(p: RoomPurge): void, state?(s: FollowState, error?: unknown): void },
 *     tuning?: { backoffMs?: readonly number[] }): AgoraFollow,
 *   close(): void,
 * }} AgoraClient
 * @typedef {{
 *   connect(options: { state?: string, config?: string, clientName?: string }): Promise<AgoraClient>,
 *   foldAnnotations(messages: readonly RoomMessage[], annotations: readonly RoomAnnotation[]): Array<RoomMessage & { edited?: { at: string, text: string }, withdrawn?: { at: string }, pinned?: boolean }>,
 *   FOLLOW_BACKOFF_MS?: readonly number[],
 * }} AgoraModule
 */

/**
 * A failure as the client names it: `refused` (a definite no, nothing appended), `dark` (no
 * service, nothing sent), `unknown-acceptance` (an append was on the wire when the answer was lost).
 * @typedef {{ outcome: Outcome, code: string, message: string, operationId?: string }} Fault
 */

/** A failure the kit raises itself, shaped like the client's own. */
export class RoomFault extends Error {
  /** @param {Outcome} outcome @param {string} code @param {string} message */
  constructor(outcome, code, message) {
    super(message);
    this.outcome = outcome;
    this.code = code;
  }
}

/** @param {unknown} e @returns {Fault | null} */
export function faultOf(e) {
  if (!e || typeof e !== "object") return null;
  const { outcome, code, message, operationId } = /** @type {Record<string, unknown>} */ (e);
  if (outcome !== "refused" && outcome !== "dark" && outcome !== "unknown-acceptance") return null;
  if (typeof code !== "string") return null;
  /** @type {Fault} */
  const fault = { outcome, code, message: typeof message === "string" ? message : code };
  if (typeof operationId === "string") fault.operationId = operationId;
  return fault;
}

/** Any failure as a fault: one that is not the client's is a refusal, so nothing loops on it. @param {unknown} e @returns {Fault} */
export function asFault(e) {
  return faultOf(e) ?? { outcome: "refused", code: "client-error", message: e instanceof Error ? e.message : String(e) };
}

/** Used when the client publishes no follow ladder of its own. */
const BACKOFF_MS = Object.freeze([500, 1000, 2000, 5000, 15000]);
/** How long the start waits on the first connect before it says the room is still being reached. */
const START_WAIT_MS = 5000;

/**
 * @typedef {{
 *   message?(m: RoomMessage): void,
 *   annotation?(a: RoomAnnotation): void,
 *   purge?(p: RoomPurge): void,
 *   state?(s: FollowState, code?: string): void,
 *   reset?(): void,
 * }} RoomListener
 */

/**
 * @typedef {{
 *   agoraDir: string, agoraState?: string, agoraConfig?: string, room: string, clientName: string,
 *   log?: (line: string) => void,
 *   startFrom?: (client: AgoraClient, room: string) => Promise<{ since?: string, reset?: boolean }>,
 *   restartMs?: number,
 * }} RoomOptions
 */

/** @typedef {Awaited<ReturnType<typeof openRoom>>} Room */

/**
 * Open the room: import the client, try one connect, and start the room's one follow. Never
 * rejects for a dark service; rejects only when the client module cannot be had at all.
 * @param {RoomOptions} options
 */
export async function openRoom(options) {
  const log = options.log ?? ((line) => console.error(line));
  const alias = options.room;
  const entry = path.join(options.agoraDir, "src", "client.mjs");
  if (!existsSync(entry)) throw new Error(`no agora client at ${entry}`);
  const agora = /** @type {AgoraModule} */ (await import(pathToFileURL(entry).href));
  if (typeof agora.connect !== "function" || typeof agora.foldAnnotations !== "function") throw new Error(`${entry} is not an agora client this kit can use (connect and foldAnnotations)`);
  const backoff = Array.isArray(agora.FOLLOW_BACKOFF_MS) && agora.FOLLOW_BACKOFF_MS.length ? agora.FOLLOW_BACKOFF_MS : BACKOFF_MS;
  const restartMs = options.restartMs ?? backoff[backoff.length - 1] ?? 15000;
  /** @param {number} attempt */
  const step = (attempt) => backoff[Math.min(attempt, backoff.length - 1)] ?? 15000;

  /** @type {AgoraClient | null} */
  let client = null;
  /** @type {Promise<AgoraClient> | null} */
  let dialing = null;
  let closed = false;

  /** The client, connected once and kept: it dials the service again by itself after a restart. */
  function link() {
    if (closed) return Promise.reject(new RoomFault("dark", "client-closed", "the kit is closing"));
    if (client) return Promise.resolve(client);
    if (!dialing) {
      /** @type {{ state?: string, config?: string, clientName: string }} */
      const connectOptions = { clientName: options.clientName };
      if (options.agoraState) connectOptions.state = options.agoraState;
      if (options.agoraConfig) connectOptions.config = options.agoraConfig;
      const attempt = agora.connect(connectOptions).then((c) => {
        if (closed) {
          c.close();
          throw new RoomFault("dark", "client-closed", "the kit is closing");
        }
        client = c;
        return c;
      });
      dialing = attempt;
      const settle = () => { if (dialing === attempt) dialing = null; };
      attempt.then(settle, settle);
    }
    return dialing;
  }

  function dropClient() {
    client?.close();
    client = null;
  }

  /** @type {{ state: 'on' } | { state: 'off', reason: string, code?: string }} */
  let status = { state: "on" };
  const started = (async () => {
    const first = link().then(
      (c) => {
        if (c.rooms().some((r) => r.alias === alias)) return /** @type {const} */ ({ state: "on" });
        return { state: /** @type {const} */ ("off"), reason: `the agora config names no native room "${alias}"`, code: "room-unknown" };
      },
      (e) => {
        const f = asFault(e);
        if (f.outcome === "refused") return { state: /** @type {const} */ ("off"), reason: `the seat service refused the kit (${f.code})`, code: f.code };
        log(`chat: the seat service is dark (${f.code}); it is reached again on use`);
        return /** @type {const} */ ({ state: "on" });
      },
    );
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const wait = new Promise((resolve) => { timer = setTimeout(() => resolve(null), START_WAIT_MS); });
    const verdict = await Promise.race([first, wait]);
    clearTimeout(timer);
    if (verdict && verdict.state === "off") {
      status = verdict;
      log(`chat: the room is off: ${verdict.reason}`);
      dropClient();
    }
    return status;
  })();

  // ---- requests ----

  /** @param {{ since?: string, limit?: number, thread?: string }} [opts] */
  async function read(opts = {}) {
    return (await link()).read(alias, opts);
  }

  /**
   * An append, and on unknown acceptance one more under the same operation id: the host returns
   * the original receipt if it had committed, and appends once if it had not. A second loss is
   * still unknown, and the operation id goes back to the caller for its own resend.
   * @param {AppendRequest} request
   * @returns {Promise<Receipt>}
   */
  async function append(request) {
    try {
      return await (await link()).append(alias, request);
    } catch (e) {
      const f = faultOf(e);
      if (f?.outcome !== "unknown-acceptance") throw e;
      try {
        return await (await link()).append(alias, request);
      } catch (again) {
        if (faultOf(again)?.outcome === "refused") throw again;
        throw Object.assign(new RoomFault("unknown-acceptance", f.code, f.message), { operationId: request.operationId });
      }
    }
  }

  /** @type {Map<string, Promise<void>>} */
  const locks = new Map();
  /**
   * One holder at a time per key, across awaits.
   * @template T @param {string} key @param {() => Promise<T>} fn @returns {Promise<T>}
   */
  function serial(key, fn) {
    const prev = locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(() => undefined, () => undefined);
    locks.set(key, tail);
    void tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
    return run;
  }

  // ---- the room's one follow, fanned out ----

  /** @type {Set<RoomListener>} */
  const listeners = new Set();
  const hub = {
    /** @type {'starting' | FollowState} */
    state: "starting",
    /** @type {string | undefined} */
    code: undefined,
    everLive: false,
    attempt: 0,
    /** @type {AgoraFollow | null} */
    follow: null,
    /** @type {ReturnType<typeof setTimeout> | null} */
    timer: null,
    generation: 0,
  };

  /** @param {(l: RoomListener) => void} fn */
  function each(fn) {
    for (const l of [...listeners]) {
      try { fn(l); } catch (e) { log(`chat: a room listener threw: ${e instanceof Error ? e.message : String(e)}`); }
    }
  }

  /** @param {FollowState} s @param {unknown} [error] */
  function setState(s, error) {
    const code = error === undefined ? undefined : asFault(error).code;
    const changed = hub.state !== s || hub.code !== code;
    hub.state = s;
    hub.code = code;
    if (s === "live") {
      hub.everLive = true;
      hub.attempt = 0;
    }
    if (changed) {
      log(`chat: the room is ${s}${code ? ` (${code})` : ""}`);
      each((l) => l.state?.(s, code));
    }
  }

  /** @param {number} ms */
  function schedule(ms) {
    if (closed || hub.timer) return;
    hub.timer = setTimeout(() => { hub.timer = null; void startFollow(); }, ms);
  }

  async function startFollow() {
    if (closed) return;
    const generation = ++hub.generation;
    /** @type {AgoraClient} */
    let c;
    try {
      c = await link();
    } catch (e) {
      if (closed || generation !== hub.generation) return;
      const f = asFault(e);
      setState(f.outcome === "refused" ? "refused" : "dark", e);
      schedule(f.outcome === "refused" ? restartMs : step(hub.attempt++));
      return;
    }
    /** @type {{ since?: string, reset?: boolean }} */
    let from = {};
    try {
      if (options.startFrom) from = await options.startFrom(c, alias);
    } catch (e) {
      if (closed || generation !== hub.generation) return;
      const f = asFault(e);
      log(`chat: the index could not catch up (${f.outcome}, ${f.code}): ${f.message}`);
      setState(f.outcome === "refused" ? "refused" : "dark", e);
      schedule(f.outcome === "refused" ? restartMs : step(hub.attempt++));
      return;
    }
    if (closed || generation !== hub.generation) return;
    if (from.reset && hub.everLive) each((l) => l.reset?.());
    try {
      hub.follow = c.follow(alias, from.since ? { since: from.since } : {}, {
        message: (m) => each((l) => l.message?.(m)),
        annotation: (a) => each((l) => l.annotation?.(a)),
        // asked only of a service that keeps purges: agora/client refuses a purge handler elsewhere
        ...(c.capabilities.has("purge-v1") ? { purge: (/** @type {RoomPurge} */ p) => each((l) => l.purge?.(p)) } : {}),
        state: (s, e) => {
          if (generation !== hub.generation) return;
          setState(s, e);
          if (s === "refused") {
            // the follow has stopped for good; a new one starts from where the index ends
            hub.follow = null;
            schedule(restartMs);
          }
        },
      });
    } catch (e) {
      setState("refused", e);
      schedule(restartMs);
    }
  }

  void started.then((s) => { if (s.state === "on") void startFollow(); else setState("refused", new RoomFault("refused", s.code ?? "room-off", s.reason)); });

  return {
    alias,
    /** Settled once the first connect has answered (or after a short wait). Never rejects. */
    ready: () => started,
    status: () => status,
    /** The room's follow: `starting` until it first answers, then `live`, `dark` or `refused`. */
    followState: () => ({ state: hub.state, ...(hub.code ? { code: hub.code } : {}), everLive: hub.everLive }),
    /** The service's capabilities, as the last hello offered them. */
    capabilities: () => (client ? [...client.capabilities].sort() : []),
    link,
    read,
    append,
    serial,
    /** @param {Record<string, any>} request */
    annotate: async (request) => (await link()).annotate(alias, request),
    /** @param {Record<string, any>} request */
    upload: async (request) => (await link()).upload(alias, request),
    /** @param {Record<string, any>} request */
    purge: async (request) => (await link()).purge(alias, request),
    /** @param {{ id: string, digest: string }} ref */
    attachment: async (ref) => (await link()).attachment(alias, ref),
    fold: agora.foldAnnotations,
    /**
     * Listen to the room's one follow. The first listener added hears every record first.
     * @param {RoomListener} l @returns {() => void} the unlisten
     */
    listen(l) {
      listeners.add(l);
      return () => { listeners.delete(l); };
    },
    close() {
      if (closed) return;
      closed = true;
      hub.generation++;
      if (hub.timer) clearTimeout(hub.timer);
      hub.timer = null;
      try { hub.follow?.close(); } catch { /* already closed */ }
      hub.follow = null;
      listeners.clear();
      dropClient();
    },
  };
}
