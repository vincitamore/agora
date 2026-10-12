// @ts-check
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { AgoraError, redact } from "./core.mjs";
import { FaceRunner, facePolicyPath } from "./faces.mjs";
import { readDurableBlob } from "./native-attachments.mjs";

/**
 * The seat service's side of the faces: one `FaceRunner` per native room, bound to the room's
 * store, and the four places the service hands it work. `src/faces.mjs` owns what a face is and
 * how a copy is published, reconciled and mirrored; this module owns only when that runs and with
 * what the store can answer.
 *
 * - after an append commits: the message's faces, whose rows ride the ack (`afterAppend`);
 * - after an edit or withdraw annotation commits: the mirror to the copies (`afterAnnotation`);
 * - after a purge commits, before its ack: the deletions, and the copies out of reach (`afterPurge`);
 * - at start, and on a slow tick: the sweep of stale `pending` and `unknown` faces (`start`).
 *
 * Native success never waits on a face: a face's call runs after the receipt, a failure is a face
 * row, and nothing here throws into the append path. The one bounded wait is a purge's, whose
 * receipt lists what it could not delete. Credentials stay inside the transport code the service
 * is handed (`createTransport`), read from the shared config the service reads and never writes.
 */

/** How long a purge's receipt waits for its deletions before listing the rest as out of reach. */
export const PURGE_FACE_DEADLINE_MS = 4_000;
/** The sweep's tick: a stale `pending` or `unknown` face is reconciled within about this long. */
export const FACE_TICK_MS = 60_000;
/** How long a stopping service lets face work finish; what is left is swept at the next start. */
export const FACE_DRAIN_MS = 5_000;

/** @typedef {import("./native-store.mjs").NativeRoomStore} NativeRoomStore */
/** @typedef {import("./faces.mjs").Face} Face */

/**
 * The message as it stands now: the latest edit's text, and `withdrawn` / `purged` when it is.
 * A read of the store's own indexes; nothing is cached.
 * @param {NativeRoomStore} store @param {string} id
 */
export function standingMessage(store, id) {
  const index = store.messageIndex.get(id);
  if (index === undefined) return undefined;
  const [message] = store.view({ since: `${store.manifest.epoch}:${index}`, limit: 1 }).messages;
  if (!message || message.id !== id) return undefined;
  const withdrawn = store.withdrawn.has(id);
  const purged = store.purged.has(id);
  let text = message.text;
  if (!withdrawn && !purged) {
    for (const i of store.annotationIndex.get(id) ?? []) {
      const a = store.records[i]?.annotation;
      if (a?.act === "edit" && typeof a.text === "string") text = a.text;
    }
  }
  return { ...message, text, ...(withdrawn ? { withdrawn: true } : {}), ...(purged ? { purged: true } : {}) };
}

/**
 * The kind of a named member, read off the room's own messages (the last message under that name
 * decides), for the `addressed` selector's `to:` test. @param {NativeRoomStore} store @param {string} name
 */
export function memberKindIn(store, name) {
  for (let i = store.records.length - 1; i >= 0; i--) {
    const author = store.records[i]?.message?.author;
    if (author && (author.name === name || author.id === name)) return author.kind;
  }
  return undefined;
}

/**
 * The poster's face choice off an append frame: absent (the room's policy), `"none"` (`--no-face`),
 * or the transports `--face` named. Anything else is refused before the commit.
 * @param {unknown} value @returns {'auto' | 'none' | string[]}
 */
export function faceChoiceOf(value) {
  if (value === undefined) return "auto";
  if (value === "none") return "none";
  if (Array.isArray(value) && value.length <= 8 && value.every((v) => typeof v === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(v))) return [...new Set(value)];
  throw Object.assign(new AgoraError("face-invalid: face is \"none\" or a list of up to 8 transport names"), { code: "face-invalid" });
}

export class NativeFaceWiring {
  /**
   * @param {{ root: string, attestor: { serviceId: string, serviceBootId: string },
   *   transportFor: (face: Face) => Promise<any>, now?: () => Date, warn?: (line: string) => void,
   *   settleMs?: number, tickMs?: number, purgeDeadlineMs?: number, drainMs?: number,
   *   onTick?: (tick: { root: string, roomId: string, store: NativeRoomStore, runner: FaceRunner, faces: Face[] }) => Promise<unknown>,
   *   onStop?: () => Promise<unknown> | unknown }} options
   * `transportFor` builds the face's transport from the shared config room the face borrows a token
   * from (see `configFaceTransports`); a test hands one built on an injected fetch. `onTick` is the
   * inbound side's seam: run once per faced room on each tick, after that room's sweep, with the
   * room's own runner (so the inbound poll and the sweep share one runner and never reconcile one
   * face twice) and its enabled faces. A failure in it is a warning. `onStop` releases what the
   * tick holds (the inbound side's client), after the drain.
   */
  constructor(options) {
    this.root = options.root;
    this.attestor = options.attestor;
    this.transportFor = options.transportFor;
    this.now = options.now ?? (() => new Date());
    this.warn = options.warn ?? ((line) => { process.stderr.write(`${redact(line)}\n`); });
    this.settleMs = options.settleMs;
    this.tickMs = options.tickMs ?? FACE_TICK_MS;
    this.purgeDeadlineMs = options.purgeDeadlineMs ?? PURGE_FACE_DEADLINE_MS;
    this.drainMs = options.drainMs ?? FACE_DRAIN_MS;
    this.onTick = options.onTick;
    this.onStop = options.onStop;
    /** @type {Map<string, FaceRunner>} */
    this.runners = new Map();
    /** The store each runner reads through; replaced when the service reopens a room. @type {Map<string, NativeRoomStore>} */
    this.stores = new Map();
    /** Face work in flight (publications, mirrors, sweeps), awaited by `stop`. @type {Set<Promise<unknown>>} */
    this.work = new Set();
    /** The same work, by the room it writes for, so a room's deletion can wait for its own. @type {Map<string, Set<Promise<unknown>>>} */
    this.roomWork = new Map();
    /** @type {NodeJS.Timeout | undefined} */
    this.timer = undefined;
    this.stopped = false;
  }

  /** @param {string} roomId @param {NativeRoomStore} store */
  runner(roomId, store) {
    this.stores.set(roomId, store);
    const existing = this.runners.get(roomId);
    if (existing) return existing;
    const live = () => {
      const s = this.stores.get(roomId);
      if (!s || s.closed) throw new AgoraError(`native room ${roomId} is not open on this service`);
      return s;
    };
    const runner = new FaceRunner({
      stateRoot: this.root, roomId, attestor: this.attestor, now: this.now, warn: this.warn,
      ...(this.settleMs !== undefined ? { settleMs: this.settleMs } : {}),
      transportFor: (face) => this.transportFor(face),
      memberKind: (name) => memberKindIn(live(), name),
      lookupMessage: (id) => standingMessage(live(), id),
      lookupCursor: (cursor) => {
        const s = live();
        const [epoch, seq] = String(cursor).split(":");
        const n = Number(seq);
        if (epoch !== s.manifest.epoch || !Number.isSafeInteger(n) || n < 1 || n > s.records.length) return undefined;
        const [m] = s.view({ since: `${epoch}:${n - 1}`, limit: 1 }).messages;
        return m && m.cursor === cursor ? m : undefined;
      },
      readBlob: async (attachment) => (await readDurableBlob(live().directory, roomId, attachment)).bytes,
    });
    this.runners.set(roomId, runner);
    return runner;
  }

  /** @param {Promise<unknown>} promise @param {string} [roomId] the room the work writes for */
  #track(promise, roomId) {
    const tracked = promise.catch((e) => { this.warn(`agora: face work failed: ${e instanceof Error ? e.message : String(e)}`); });
    this.work.add(tracked);
    const set = roomId ? this.roomWork.get(roomId) ?? new Set() : undefined;
    if (roomId && set) { set.add(tracked); this.roomWork.set(roomId, set); }
    void tracked.finally(() => {
      this.work.delete(tracked);
      if (roomId && set) { set.delete(tracked); if (!set.size && this.roomWork.get(roomId) === set) this.roomWork.delete(roomId); }
    });
    return tracked;
  }

  /**
   * A room is being deleted: stop facing it and wait, within `drainMs`, for the face work already
   * running for it (publications, mirrors, its sweep and inbound tick), so no late face line lands
   * in a directory about to be removed. Returns false when that work did not finish in time; the
   * runner is then kept, and the caller refuses the deletion.
   * @param {string} roomId @returns {Promise<boolean>}
   */
  async forget(roomId) {
    const runner = this.runners.get(roomId);
    const pending = [...(this.roomWork.get(roomId) ?? []), ...(runner ? [...runner.inflight.values()] : []), ...(runner?.sweeping ? [runner.sweeping] : [])];
    if (pending.length) {
      /** @type {NodeJS.Timeout | undefined} */
      let timer;
      const drained = await Promise.race([Promise.allSettled(pending).then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), this.drainMs); })]);
      clearTimeout(timer);
      if (!drained) return false;
    }
    this.runners.delete(roomId);
    this.stores.delete(roomId);
    return true;
  }

  /**
   * After a message committed: its face rows for the ack (before any transport call), the calls
   * left running. A failure here is a warning and no rows; it never fails the append.
   * @param {string} roomId @param {NativeRoomStore} store @param {any} message @param {'auto' | 'none' | string[]} choice
   * @returns {Promise<import("./faces.mjs").FaceStatus[] | undefined>}
   */
  async afterAppend(roomId, store, message, choice) {
    if (this.stopped) return undefined;
    try {
      const runner = this.runner(roomId, store);
      const { faces, settled } = await runner.face(message, { face: choice });
      this.#track(settled, roomId);
      return faces;
    } catch (e) {
      this.warn(`agora: faces for ${message?.cursor ?? "a message"} not run: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  }

  /**
   * After an edit or withdraw committed: the mirror to every copy, in the background. Pin and
   * unpin carry nothing to a face.
   * @param {string} roomId @param {NativeRoomStore} store @param {any} annotation
   */
  afterAnnotation(roomId, store, annotation) {
    if (this.stopped || (annotation?.act !== "edit" && annotation?.act !== "withdraw")) return;
    const runner = this.runner(roomId, store);
    this.#track(runner.mirror({ act: annotation.act, id: String(annotation.id), cursor: annotation.cursor, target: String(annotation.target) }), roomId);
  }

  /**
   * After a purge committed, before its ack: the deletions, bounded by `purgeDeadlineMs`, and the
   * copies the purge could not delete. A room with no face record is answered without a read.
   * @param {string} roomId @param {NativeRoomStore} store @param {{ id: string, cursor?: string, purged: string[] }} purge
   * @returns {Promise<Record<string, string>[]>}
   */
  async afterPurge(roomId, store, purge) {
    if (this.stopped || !purge.purged.length) return [];
    try {
      const runner = this.runner(roomId, store);
      const { facesOutOfReach, work } = await runner.purge(purge, { deadlineMs: this.purgeDeadlineMs });
      this.#track(work, roomId);
      return facesOutOfReach;
    } catch (e) {
      this.warn(`agora: the purge's face deletions not run: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }

  /**
   * The restart sweep: every room with a face policy is opened and swept (a `pending` face whose
   * writer died becomes `unknown` and is reconciled; a stale mirror is carried again), then the
   * tick keeps sweeping the rooms this service has faced. Runs in the background; a room that will
   * not open is a warning.
   * @param {{ openRoom: (roomId: string) => Promise<NativeRoomStore> }} service
   */
  start(service) {
    this.#track((async () => {
      for (const roomId of await facedRooms(this.root)) {
        if (this.stopped) return;
        try { this.runner(roomId, await service.openRoom(roomId)); }
        catch (e) { this.warn(`agora: faced room ${roomId} not swept: ${e instanceof Error ? e.message : String(e)}`); }
      }
      await this.#sweepAll();
    })());
    this.timer = setInterval(() => { void this.#track(this.#sweepAll()); }, this.tickMs);
    this.timer.unref?.();
  }

  async #sweepAll() {
    for (const [roomId, runner] of this.runners) {
      if (this.stopped) return;
      const store = this.stores.get(roomId);
      if (!store || store.closed || this.runners.get(roomId) !== runner) continue;
      await this.#track((async () => {
        try { await runner.sweep(); }
        catch (e) { this.warn(`agora: face sweep of ${roomId} failed: ${e instanceof Error ? e.message : String(e)}`); }
        if (!this.onTick || this.stopped) return;
        try {
          const faces = (await runner.policy()).faces.filter((f) => f.enabled);
          if (faces.length) await this.onTick({ root: this.root, roomId, store, runner, faces });
        } catch (e) { this.warn(`agora: face tick of ${roomId} failed: ${e instanceof Error ? e.message : String(e)}`); }
      })(), roomId);
    }
  }

  /** Stop the tick and let face work finish within `drainMs`; what is left is swept at the next start. */
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.work.size) {
      /** @type {NodeJS.Timeout | undefined} */
      let timer;
      await Promise.race([Promise.allSettled([...this.work]), new Promise((resolve) => { timer = setTimeout(resolve, this.drainMs); })]);
      clearTimeout(timer);
    }
    try { await this.onStop?.(); }
    catch (e) { this.warn(`agora: face tick release failed: ${e instanceof Error ? e.message : String(e)}`); }
  }
}

/** The rooms under this state root that carry a face policy. @param {string} root */
export async function facedRooms(root) {
  /** @type {string[]} */
  let names = [];
  try { names = await readdir(path.join(root, "native", "rooms")); }
  catch (e) { if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ENOENT") throw e; }
  /** @type {string[]} */
  const out = [];
  for (const name of names) {
    if (!/^[a-f0-9]{32}$/.test(name)) continue;
    try { if ((await stat(facePolicyPath(root, name))).isFile()) out.push(name); }
    catch { /* no policy: no faces to sweep */ }
  }
  return out.sort();
}

/** What a transport answers when the token it holds is no longer good: the call was refused, never performed. */
export const TOKEN_REFUSED = Object.freeze(new Set(["invalid_auth", "token_revoked"]));

/** Was this call refused for the token it carried? A Slack answer names it; GitHub answers 401. @param {unknown} e */
function tokenRefused(e) {
  const x = /** @type {any} */ (e);
  if (!x || typeof x !== "object" || !x.answered) return false;
  return (typeof x.error === "string" && TOKEN_REFUSED.has(x.error)) || x.status === 401;
}

/**
 * The production `transportFor`: the face borrows the token of the shared config room it names
 * (`face.alias`), read from the config the service reads, and aims it at the face's own target.
 * The config is read, never written.
 *
 * A rotated token needs no service restart. The transport handed back holds the token it was built
 * with; when a call is refused for that token (Slack `invalid_auth` or `token_revoked`, GitHub
 * 401), the config row is read again, the token re-resolved from its `tokenFile` or `tokenEnv`, the
 * transport rebuilt, and the call made once more. A token refusal means the call was not performed,
 * so the second attempt cannot double a post. Refused again, the call fails by name
 * (`token-refused`), and the next call re-reads once more: a fixed token file is picked up without
 * a restart, a still-bad one costs one extra refused call each time.
 * @param {{ loadConfig: () => Promise<any>, createTransport: (alias: string, room: any, cfg: any, deps?: any) => Promise<any>, fetch?: typeof fetch }} deps
 * @returns {(face: Face) => Promise<any>}
 */
export function configFaceTransports({ loadConfig, createTransport, fetch: f }) {
  /** @param {Face} face */
  const build = async (face) => {
    const cfg = await loadConfig();
    const room = cfg?.rooms?.[face.alias];
    if (!room || room.transport !== face.transport)
      throw new AgoraError(`the ${face.transport} face borrows room "${face.alias}", which the config does not name as a ${face.transport} room`);
    const aimed = face.transport === "slack" && face.target.channel ? { ...room, channel: face.target.channel } : room;
    return createTransport(face.alias, aimed, cfg, f ? { fetch: f } : {});
  };
  return async (face) => refreshingTransport(await build(face), () => build(face), face);
}

/**
 * A transport whose methods re-resolve the token once on a token refusal (see
 * `configFaceTransports`). Properties pass through to the current transport; methods are called on
 * it, so a rebuilt transport takes over for every later call.
 * @param {any} first @param {() => Promise<any>} rebuild @param {Face} face
 */
export function refreshingTransport(first, rebuild, face) {
  let current = first;
  return new Proxy(/** @type {any} */ ({}), {
    has: (_t, key) => key in current,
    ownKeys: () => Reflect.ownKeys(current),
    getOwnPropertyDescriptor: (_t, key) => {
      const d = Reflect.getOwnPropertyDescriptor(current, key);
      return d ? { ...d, configurable: true } : undefined;
    },
    get(_t, key) {
      const value = current[key];
      if (typeof value !== "function") return value;
      return async (/** @type {unknown[]} */ ...args) => {
        try { return await current[key](...args); }
        catch (e) {
          if (!tokenRefused(e)) throw e;
          const why = /** @type {any} */ (e).error ?? `http-${/** @type {any} */ (e).status}`;
          current = await rebuild();
          try { return await current[key](...args); }
          catch (again) {
            if (!tokenRefused(again)) throw again;
            throw Object.assign(new AgoraError(`token-refused: the ${face.transport} token of room "${face.alias}" was refused (${why}), and again after re-reading its tokenFile or tokenEnv; replace the token and the next call picks it up`),
              { code: "token-refused", answered: true, sent: true, error: "token-refused" });
          }
        }
      };
    },
  });
}
