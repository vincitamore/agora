// @ts-check
/**
 * The chat kit's server half: `createChat` and the route table. The contract is CONTRACT.md.
 *
 * The host mounts the kit inside its own `Bun.serve` fetch, after its own cross-site checks and
 * session: `const r = await chat.handle(req, person); if (r) return r;`. A path outside `/chat/`
 * answers `null` so the host falls through to its own routes. A person the host did not pass is
 * asked of the host's `identify`; nobody is 401.
 *
 * The modules beside this one each own one part: `room` (the room through agora/client, and its one
 * follow), `stream` (SSE fan-out), `post` (posting and its outcomes), `store` (kit.sqlite: the index,
 * positions, reactions, thumbs), `uploads` (upload, file and thumbnail), `annotate` (annotate,
 * react, purge), `search` (the search route). The last three are called with the kit (`ChatKit`) as
 * their third argument; a part not built answers 501 `NOT_IMPLEMENTED`. Push (`../push/`) owns
 * `/chat/push/*` and `/chat/prefs`, keeps its own tables in kit.sqlite, and is told of each new
 * message with its mentions and the thread's participants.
 *
 * The index. The room's one follow is heard first by the index, which records every message and
 * annotation in kit.sqlite (with its mentions, read against the host's `people`) before anything is
 * fanned out or emitted. At start the index reads, page by page, whatever the room committed since
 * it last ran, then the follow starts where it ends; a room of another epoch than the index's
 * rebuilds the index. `chat.on("message")` and `chat.on("annotation")` hear only what arrives
 * after the kit started, never what the catch-up finds from before, so a host that pushes on them
 * does not push old news.
 */

import * as pushServer from "../push/server.mjs";
import { handleAnnotate, handlePurge, handleReact } from "./annotate.mjs";
import { createPosting, fail, json, MESSAGE_ID, personRef } from "./post.mjs";
import { asFault, openRoom } from "./room.mjs";
import { handleScan } from "./scan.mjs";
import { forgetPurge, handleSearch, reindexEdit } from "./search.mjs";
import { openKitStore, parseCursor, parseMentions } from "./store.mjs";
import { createStreams, toBrowser } from "./stream.mjs";
import { handleFile, handleThumb, handleUpload } from "./uploads.mjs";

/**
 * A person as the host knows them. `ref` is stamped on the person's messages as `author.ref`.
 * @typedef {{ id: string, name: string, ref?: string }} Person
 */
/** @typedef {'read' | 'post' | 'upload' | 'edit' | 'withdraw' | 'pin' | 'purge' | 'react'} ChatAct */
/** @typedef {{ state: 'ready' | 'busy' | 'away' | 'dark', lastSeen?: string, running?: string }} Presence */
/**
 * The host's side of the seam. Every hook is the host's knowledge; the kit never learns what it means.
 * @typedef {{
 *   identify: (req: Request) => Promise<Person | null>,
 *   authorize: (person: Person, act: ChatAct, ctx: Record<string, unknown>) => boolean,
 *   people: () => Promise<Person[]>,
 *   scanText: (text: string) => { refuse?: string, warn?: string },
 *   scanUpload: (file: { name: string, mimetype: string, bytes: Uint8Array }) => Promise<{ ok: true } | { ok: false, reason: string }>,
 *   notifyText: (event: { message: Record<string, any>, threadRoot?: Record<string, any> }) => { title: string, body: string },
 *   presence: () => Promise<Presence>,
 *   residentName: string,
 * }} ChatHooks
 */
/**
 * @typedef {{
 *   agoraDir: string,
 *   agoraState?: string,
 *   agoraConfig?: string,
 *   room: string,
 *   clientName: string,
 *   storeDir: string,
 *   hooks: ChatHooks,
 *   push: { vapidFile: string, subject: string, threadUrl?: string, allowEndpoint?: (url: URL) => boolean } | null,
 *   log?: (line: string) => void,
 *   tuning?: { keepAliveMs?: number, presenceMs?: number, restartMs?: number, peopleMs?: number },
 * }} ChatOptions
 */
/** @typedef {'message' | 'annotation'} ChatEvent */
/**
 * What a `message` or `annotation` listener hears beside the record: the thread's root id, the
 * people the message mentions, and the people a `waiting:` trailer on it names (ids, from the
 * host's `people`). For an annotation, `thread` is its target's thread when the index knows it.
 * @typedef {{ thread: string, mentions: string[], waiting: string[] }} ChatEventMeta
 */
/**
 * @typedef {{
 *   handle: (req: Request, person: Person | null) => Promise<Response | null>,
 *   on: (event: ChatEvent, listener: (value: Record<string, any>, meta: ChatEventMeta) => void) => () => void,
 *   close: () => Promise<void>,
 *   version: string,
 * }} Chat
 */
/**
 * What the kit hands the parts built beside it (uploads, annotate, search, push) as their third
 * argument: the room, the store, the hooks, and the kit's own helpers. The parts never hold the
 * client or the database on their own.
 * @typedef {{
 *   options: ChatOptions,
 *   hooks: ChatHooks,
 *   room: import("./room.mjs").Room,
 *   store: import("./store.mjs").KitStore,
 *   log: (line: string) => void,
 *   people: () => Person[],
 *   personRef: (person: { id: string, ref?: string }) => string | undefined,
 *   json: (status: number, body: Record<string, unknown>) => Response,
 *   fail: (status: number, code: string, message: string, extra?: Record<string, unknown>) => Response,
 *   toBrowser: <M extends Record<string, any>>(m: M) => Omit<M, 'room'>,
 *   on: Chat['on'],
 * }} ChatKit
 */
/** @typedef {(req: Request, person: Person, kit: ChatKit) => Promise<Response | null>} PartHandler */

/** The kit's own version, which a host checks against the major it was written for. */
export const CHAT_VERSION = "1.0.0";

/** The path every kit route lives under. */
export const CHAT_BASE = "/chat/";

/**
 * Every route the kit answers, as `METHOD path`; `:name` is one path segment.
 * @type {ReadonlyArray<string>}
 */
export const CHAT_ROUTES = Object.freeze([
  "GET /chat/state",
  "GET /chat/threads",
  "GET /chat/thread/:root",
  "GET /chat/stream",
  "POST /chat/post",
  "POST /chat/scan",
  "POST /chat/upload",
  "GET /chat/file/:id",
  "GET /chat/thumb/:digest",
  "POST /chat/annotate",
  "POST /chat/react",
  "POST /chat/purge",
  "POST /chat/position",
  "GET /chat/search",
  "GET /chat/push/key",
  "POST /chat/push/subscribe",
  "DELETE /chat/push/subscribe",
  "POST /chat/push/test",
  "POST /chat/push/ack",
  "GET /chat/prefs",
  "PUT /chat/prefs",
]);

/** How many threads a list answers when it is not told, and at most. */
const THREADS_LIMIT = 50;
const THREADS_MAX = 200;
/** How many messages a thread opens with. */
const THREAD_LIMIT = 200;
/** How long the host's people list is kept before it is asked again. */
const PEOPLE_MS = 60_000;

/**
 * A JSON answer in the kit's envelope.
 * @param {number} status @param {{ ok: boolean, data?: unknown, error?: { code: string, message?: string } }} body
 */
export function chatJson(status, body) {
  return json(status, body);
}

/** @param {unknown} e */
const said = (e) => (e instanceof Error ? e.message : String(e));

/**
 * A read that failed, as HTTP.
 * @param {import("./room.mjs").Fault} f
 */
function readFault(f) {
  if (f.outcome !== "refused") return fail(503, "ROOM_DARK", "The room is unreachable right now.");
  if (f.code === "thread-root-unknown" || f.code === "thread-root-not-top-level") return fail(404, "NOT_FOUND", "There is no such thread.", { refusal: f.code });
  return fail(409, "ROOM_REFUSED", `The room refused the read (${f.code}).`, { refusal: f.code });
}

/**
 * A thread named in a route: `main` (the whole room) or a root message id.
 * @param {string | null} value
 * @returns {string | null | undefined} null for main, the id, or undefined when it is neither
 */
function threadParam(value) {
  if (value === "main") return null;
  if (typeof value === "string" && MESSAGE_ID.test(value)) return value;
  return undefined;
}

/**
 * Create the kit for one room.
 * @param {ChatOptions} options
 * @returns {Promise<Chat>}
 */
export async function createChat(options) {
  if (!options || typeof options !== "object") throw new TypeError("createChat takes { agoraDir, room, clientName, storeDir, hooks, push }");
  for (const key of /** @type {const} */ (["agoraDir", "room", "clientName", "storeDir"])) {
    if (typeof options[key] !== "string" || !options[key]) throw new TypeError(`createChat needs ${key}`);
  }
  const hooks = options.hooks;
  for (const key of /** @type {const} */ (["identify", "authorize", "people", "scanText", "scanUpload", "notifyText", "presence"])) {
    if (typeof hooks?.[key] !== "function") throw new TypeError(`createChat needs the hook ${key}`);
  }
  // a bad notification URL is the host's configuration error: refused before anything is opened
  const threadUrlFrom = /** @type {any} */ (pushServer).threadUrlFrom;
  if (options.push?.threadUrl !== undefined && typeof threadUrlFrom === "function") threadUrlFrom(options.push.threadUrl);
  const log = options.log ?? ((line) => console.error(line));
  const tuning = options.tuning ?? {};

  const store = await openKitStore(options.storeDir);

  /** @type {Map<ChatEvent, Set<(value: Record<string, any>, meta: ChatEventMeta) => void>>} */
  const listeners = new Map([["message", new Set()], ["annotation", new Set()]]);
  /** @param {ChatEvent} event @param {Record<string, any>} value @param {ChatEventMeta} meta */
  function emit(event, value, meta) {
    for (const l of [...(listeners.get(event) ?? [])]) {
      try { l(value, meta); } catch (e) { log(`chat: a ${event} listener threw: ${said(e)}`); }
    }
  }
  /** @type {Chat['on']} */
  function on(event, listener) {
    const set = listeners.get(event);
    if (!set) throw new TypeError(`no such event: ${event}`);
    set.add(listener);
    return () => { set.delete(listener); };
  }

  // the host's people, kept a while; mentions and waiting are read against them
  /** @type {Person[]} */
  let people = [];
  let peopleAt = 0;
  /** @type {Promise<void> | null} */
  let peopleLoading = null;
  function refreshPeople() {
    if (!peopleLoading) {
      peopleLoading = hooks.people().then(
        (list) => { if (Array.isArray(list)) people = list.filter((p) => p && typeof p.id === "string"); peopleAt = Date.now(); },
        (e) => { log(`chat: the host's people threw: ${said(e)}`); peopleAt = Date.now(); },
      ).finally(() => { peopleLoading = null; });
    }
    return peopleLoading;
  }
  function currentPeople() {
    if (Date.now() - peopleAt > (tuning.peopleMs ?? PEOPLE_MS)) void refreshPeople();
    return people;
  }
  /** The person a message's `author.ref` names, by the host's people. @param {string | undefined} ref */
  function personOfRef(ref) {
    if (!ref) return undefined;
    return currentPeople().find((p) => personRef(p) === ref)?.id;
  }
  /** The people a `waiting:` value names: a person's id, or their ref. @param {string} value */
  function personOfWaiting(value) {
    const v = value.trim();
    const list = currentPeople();
    return list.find((p) => p.id === v)?.id ?? list.find((p) => personRef(p) === v)?.id ?? v;
  }

  /**
   * Push, when the kit carries it: `push/store.mjs` opened on the kit's own database, a sender when
   * the host gave `push` options, and the service that owns `/chat/push/*` and `/chat/prefs`.
   * A kit built without push answers those routes 501.
   */
  async function openPush() {
    const api = /** @type {any} */ (pushServer);
    if (typeof api.createPushService !== "function") return null;
    // named through a variable: a kit built without push has no push/store.mjs to type-check against
    const storeModule = new URL("../push/store.mjs", import.meta.url).href;
    /** @type {any} */
    let pushStoreApi;
    try { pushStoreApi = await import(storeModule); }
    catch (e) { log(`chat: push has no store: ${said(e)}`); return null; }
    const opened = await pushStoreApi.openPushStore({ db: store.db });
    let sender = null;
    if (options.push) {
      try { sender = await api.createPush(options.push); }
      catch (e) { log(`chat: push did not start (the routes answer without it): ${said(e)}`); }
    }
    const service = api.createPushService({ store: opened, push: sender, hooks: { people: hooks.people, notifyText: hooks.notifyText }, base: "/chat",
      ...(options.push?.threadUrl !== undefined ? { threadUrl: options.push.threadUrl } : {}) });
    return { service, store: opened };
  }

  /**
   * A new message to push's policy: the thread's root (for a reply), who it mentions, and who has
   * posted in its thread. Never awaited by the index; a failure is logged.
   * @param {Record<string, any>} message the browser's shape @param {string} thread @param {string[]} mentions
   */
  function notifyPush(message, thread, mentions) {
    if (!pushService) return;
    const root = thread !== message.id ? store.message(thread) : null;
    const threadRoot = root ? toBrowser(room.fold([/** @type {any} */ (root.message)], /** @type {any} */ (root.annotations))[0]) : undefined;
    const participants = [...new Set(store.threadAuthorRefs(thread).map(personOfRef).filter((id) => typeof id === "string"))];
    pushService.notify({ message, ...(threadRoot ? { threadRoot } : {}), mentions, participants })
      .catch((e) => log(`chat: push notify failed: ${said(e)}`));
  }

  /** Whether the follow has delivered past the catch-up: only then are records news. */
  let caughtUp = false;

  /**
   * Where the follow starts: the index checked against the room's epoch (rebuilt when they
   * differ), then everything the room committed since the index last ran, read page by page.
   * @param {import("./room.mjs").AgoraClient} c @param {string} alias
   */
  async function startFrom(c, alias) {
    caughtUp = false;
    await refreshPeople();
    const head = await c.read(alias, { limit: 1 });
    const at = parseCursor(head.through);
    if (!at) throw new Error(`the room answered no native cursor (${head.through})`);
    const epoch = at.epoch;
    // what the room committed after this read is news, even when the catch-up is what reads it
    /** @param {string} cursor */
    const isNews = (cursor) => (parseCursor(cursor)?.seq ?? 0) > at.seq;
    const state = store.indexState();
    let reset = false;
    if (state.epoch !== epoch) {
      if (state.epoch) log(`chat: the room is of another epoch than the index; the index is rebuilt`);
      store.resetIndex(epoch);
      reset = state.epoch !== null;
    }
    let since = store.indexState().through ?? `${epoch}:0`;
    for (;;) {
      const page = await c.read(alias, { since, limit: 500 });
      for (const m of page.messages) index.message(m, isNews(m.cursor));
      for (const a of page.annotations ?? []) index.annotation(a, isNews(a.cursor));
      store.setThrough(page.through);
      const done = page.through === since || (page.committedThrough !== undefined && page.through === page.committedThrough);
      since = page.through;
      if (done) break;
    }
    caughtUp = true;
    return { since, reset };
  }

  const index = {
    /** @param {import("./room.mjs").RoomMessage} m @param {boolean} news */
    message(m, news) {
      const mentions = parseMentions(m.text, currentPeople());
      let fresh = false;
      try {
        fresh = store.putMessage(/** @type {any} */ (m), mentions);
        store.setThrough(m.cursor);
      } catch (e) {
        log(`chat: a message was not indexed (${m.cursor}): ${said(e)}`);
      }
      if (!news || !fresh) return;
      const waiting = (m.trailers ?? []).filter((t) => t.key === "waiting").map((t) => personOfWaiting(t.value));
      const thread = typeof m.thread === "string" ? m.thread : m.id;
      const shaped = toBrowser(m);
      emit("message", shaped, { thread, mentions, waiting });
      notifyPush(shaped, thread, mentions);
    },
    /** @param {import("./room.mjs").RoomAnnotation} a @param {boolean} news */
    annotation(a, news) {
      let fresh = false;
      try {
        fresh = store.putAnnotation(/** @type {any} */ (a));
        store.setThrough(a.cursor);
      } catch (e) {
        log(`chat: an annotation was not indexed (${a.cursor}): ${said(e)}`);
      }
      if (fresh) reindexEdit(store, room.fold, a, currentPeople());
      if (!news || !fresh) return;
      emit("annotation", toBrowser(a), { thread: store.threadOf(a.target) ?? a.target, mentions: [], waiting: [] });
    },
  };

  const room = await openRoom({
    agoraDir: options.agoraDir, room: options.room, clientName: options.clientName, log, startFrom,
    ...(options.agoraState ? { agoraState: options.agoraState } : {}),
    ...(options.agoraConfig ? { agoraConfig: options.agoraConfig } : {}),
    ...(tuning.restartMs !== undefined ? { restartMs: tuning.restartMs } : {}),
  });
  // the index hears every record first
  room.listen({
    message: (m) => index.message(m, caughtUp),
    annotation: (a) => index.annotation(a, caughtUp),
    purge: (p) => forgetPurge(store, p.purged, log),
  });
  const streams = createStreams({
    room, store, hooks, log,
    ...(tuning.keepAliveMs !== undefined ? { keepAliveMs: tuning.keepAliveMs } : {}),
    ...(tuning.presenceMs !== undefined ? { presenceMs: tuning.presenceMs } : {}),
  });
  const posting = createPosting({ room, hooks, log });

  /** @type {ChatKit} */
  const kit = {
    options, hooks, room, store, log, on,
    people: currentPeople,
    personRef, json, fail, toBrowser,
  };

  // push is its own part (push/): its routes, its own tables in kit.sqlite, and a notify for each new message
  /** @type {{ handle: (req: Request, person: Person | null) => Promise<Response | null>, notify: (event: Record<string, any>) => Promise<unknown> } | null} */
  let pushService = null;
  /** @type {{ close(): void } | null} */
  let pushStore = null;
  const push = await openPush();
  if (push) ({ service: pushService, store: pushStore } = push);

  /** @type {Record<string, PartHandler>} */
  const parts = {
    upload: handleUpload, file: handleFile, thumb: handleThumb,
    annotate: handleAnnotate, react: handleReact, purge: handlePurge, search: handleSearch, scan: handleScan,
  };
  /** @param {PartHandler} handler @param {Request} req @param {Person} person */
  async function part(handler, req, person) {
    try {
      return (await handler(req, person, kit)) ?? fail(404, "NOT_FOUND", "No such route.");
    } catch (e) {
      if (/^not-implemented\b/.test(said(e))) return fail(501, "NOT_IMPLEMENTED", "This part of the kit is not built yet.");
      log(`chat: ${new URL(req.url).pathname} failed: ${said(e)}`);
      return fail(500, "INTERNAL", "The kit could not answer.");
    }
  }

  // ---- the routes this module answers ----

  /** @param {Person} person */
  async function state(person) {
    /** @type {Record<string, unknown>} */
    let presence;
    try { presence = { ...(await hooks.presence()) }; }
    catch (e) {
      log(`chat: the host's presence threw: ${said(e)}`);
      presence = { state: "dark", reason: "presence-unavailable" };
    }
    const status = room.status();
    const follow = room.followState();
    return json(200, { ok: true, data: {
      room: options.room,
      me: { id: person.id, name: person.name, ...(person.ref ? { ref: person.ref } : {}) },
      resident: { name: hooks.residentName, ...presence },
      capabilities: room.capabilities(),
      version: CHAT_VERSION,
      link: status.state === "off" ? { state: "refused", reason: status.code ?? "room-off" } : { state: follow.state === "starting" ? "dark" : follow.state, ...(follow.code ? { reason: follow.code } : {}) },
    } });
  }

  /** The newest message of a thread, folded, for the line under its title. @param {string} id */
  function lastMessage(id) {
    const got = store.message(id);
    return got ? toBrowser(room.fold([/** @type {any} */ (got.message)], /** @type {any} */ (got.annotations))[0]) : null;
  }

  /** @param {URL} url @param {Person} person */
  function threads(url, person) {
    const scope = url.searchParams.get("scope") ?? "all";
    if (scope !== "all" && scope !== "mine") return fail(400, "BAD_REQUEST", "scope is all or mine.");
    /** @type {Array<[string, string]>} */
    const context = [];
    for (const c of url.searchParams.getAll("context")) {
      const at = c.indexOf("=");
      if (at <= 0 || at === c.length - 1) return fail(400, "BAD_REQUEST", "context is <key>=<value>.");
      context.push([c.slice(0, at).trim(), c.slice(at + 1).trim()]);
    }
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw === null ? THREADS_LIMIT : Number(limitRaw);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > THREADS_MAX) return fail(400, "BAD_REQUEST", `limit is 1 to ${THREADS_MAX}.`);
    const indexed = store.indexState();
    let beforeSeq = null;
    const before = url.searchParams.get("before");
    if (before !== null) {
      const at = parseCursor(before);
      if (!at) return fail(400, "BAD_REQUEST", "before is a thread's lastCursor.");
      if (at.epoch !== indexed.epoch) return json(200, { ok: true, data: { threads: [], through: indexed.through } });
      beforeSeq = at.seq;
    }
    const myRef = personRef(person) ?? "";
    const rows = store.threadRows({ me: { id: person.id, ref: myRef }, scope, context, beforeSeq, limit });
    const list = rows.map((r) => {
      /** @type {Map<string, true>} */
      const waiting = new Map();
      /** @type {Map<string, { type: string, id: string }>} */
      const cards = new Map();
      for (const line of r.lines) {
        const by = personOfRef(line.author.ref);
        if (by) waiting.delete(by);
        for (const w of line.waiting) waiting.set(personOfWaiting(w), true);
        for (const c of line.cards) cards.set(`${c.type} ${c.id}`, c);
      }
      const last = r.lines.at(-1) ?? { cursor: r.root.cursor, ts: r.root.ts, seq: 0, author: r.root.author };
      let unread = false;
      if (!(myRef && last.author.ref === myRef)) {
        const pos = store.position(person.id, r.root.id);
        const at = parseCursor(last.cursor);
        unread = !pos || !at || pos.epoch !== at.epoch || at.seq > pos.seq;
      }
      return {
        root: toBrowser(room.fold([/** @type {any} */ (r.root)], /** @type {any} */ (r.rootAnnotations))[0]),
        lastAt: last.ts,
        lastBy: { name: last.author.name, kind: last.author.kind, ...(last.author.ref ? { ref: last.author.ref } : {}) },
        lastCursor: last.cursor,
        last: lastMessage(r.lines.at(-1)?.id ?? r.root.id),
        unread,
        waiting: [...waiting.keys()],
        cards: [...cards.values()],
      };
    });
    return json(200, { ok: true, data: { threads: list, through: indexed.through } });
  }

  /** @param {string | null} root @param {URL} url */
  async function thread(root, url) {
    const since = url.searchParams.get("since") ?? undefined;
    if (since !== undefined && !parseCursor(since)) return fail(400, "BAD_REQUEST", "since is a cursor.");
    try {
      const got = await room.read({ limit: THREAD_LIMIT, ...(root ? { thread: root } : {}), ...(since ? { since } : {}) });
      const shown = new Set(got.messages.map((m) => m.id));
      const messages = room.fold(got.messages, got.annotations ?? []).map(toBrowser);
      // an annotation on a message this page does not carry (an edit after `since`) is given on its own
      const annotations = (got.annotations ?? []).filter((a) => !shown.has(a.target)).map(toBrowser);
      return json(200, { ok: true, data: { messages, annotations, through: got.through } });
    } catch (e) {
      return readFault(asFault(e));
    }
  }

  /** @param {Request} req */
  async function body(req) {
    try {
      const value = await req.json();
      return value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : null;
    } catch { return null; }
  }

  /** @param {Request} req @param {Person} person */
  async function position(req, person) {
    const b = await body(req);
    if (!b) return fail(400, "BAD_REQUEST", "The body is a JSON object.");
    const where = threadParam(typeof b.thread === "string" ? b.thread : null);
    if (where === undefined) return fail(400, "BAD_REQUEST", "thread is main or a root message's id.");
    if (!store.setPosition(person.id, where ?? "main", b.cursor)) return fail(400, "BAD_REQUEST", "cursor is a room cursor.");
    return json(200, { ok: true, data: {} });
  }

  let closed = false;
  return {
    version: CHAT_VERSION,
    on,
    async handle(req, given) {
      const url = new URL(req.url);
      if (!url.pathname.startsWith(CHAT_BASE)) return null;
      if (closed) return fail(503, "STOPPED", "The kit is closing.");
      const person = given ?? (await hooks.identify(req));
      if (!person || typeof person.id !== "string") return fail(401, "UNAUTHENTICATED", "Sign in first.");
      const segments = url.pathname.slice(CHAT_BASE.length).split("/");
      const [head, arg, extra] = segments;
      const method = req.method;
      /** @param {Record<string, unknown>} ctx */
      const may = (/** @type {ChatAct} */ act, ctx = {}) => hooks.authorize(person, act, ctx);
      const forbidden = () => fail(403, "FORBIDDEN", "You cannot do that here.");

      if (head === "state" && !arg && method === "GET") return may("read") ? state(person) : forbidden();
      if (head === "threads" && !arg && method === "GET") return may("read") ? threads(url, person) : forbidden();
      if (head === "thread" && arg && !extra && method === "GET") {
        const root = threadParam(decodeURIComponent(arg));
        if (root === undefined) return fail(400, "BAD_REQUEST", "The thread is main or a root message's id.");
        return may("read", { thread: root }) ? thread(root, url) : forbidden();
      }
      if (head === "stream" && !arg && method === "GET") {
        const where = threadParam(url.searchParams.get("thread") ?? "main");
        if (where === undefined) return fail(400, "BAD_REQUEST", "thread is main or a root message's id.");
        if (!may("read", { thread: where })) return forbidden();
        const since = req.headers.get("last-event-id") ?? url.searchParams.get("since") ?? undefined;
        return streams.open(req, { thread: where, ...(since ? { since } : {}) });
      }
      if (head === "post" && !arg && method === "POST") return posting.handle(req, person);
      if (head === "position" && !arg && method === "POST") return position(req, person);
      if (head === "scan" && !arg && method === "POST") return part(parts.scan, req, person);
      if (head === "upload" && !arg && method === "POST") return part(parts.upload, req, person);
      if (head === "file" && arg && !extra && method === "GET") return part(parts.file, req, person);
      if (head === "thumb" && arg && !extra && method === "GET") return part(parts.thumb, req, person);
      if (head === "annotate" && !arg && method === "POST") return part(parts.annotate, req, person);
      if (head === "react" && !arg && method === "POST") return part(parts.react, req, person);
      if (head === "purge" && !arg && method === "POST") return part(parts.purge, req, person);
      if (head === "search" && !arg && method === "GET") return part(parts.search, req, person);
      if (head === "push" || head === "prefs") {
        if (!pushService) return fail(501, "NOT_IMPLEMENTED", "Push is not built in this kit.");
        try {
          return (await pushService.handle(req, person)) ?? fail(404, "NOT_FOUND", "No such route.");
        } catch (e) {
          log(`chat: ${url.pathname} failed: ${said(e)}`);
          return fail(500, "INTERNAL", "The kit could not answer.");
        }
      }
      if (CHAT_ROUTES.some((r) => r.split(" ")[1].split("/")[2] === head)) return fail(405, "METHOD_NOT_ALLOWED", `${method} is not answered on ${url.pathname}.`);
      return fail(404, "NOT_FOUND", "No such route.");
    },
    async close() {
      if (closed) return;
      closed = true;
      streams.close();
      try { pushStore?.close(); } catch (e) { log(`chat: push did not close cleanly: ${said(e)}`); }
      room.close();
      store.close();
    },
  };
}
