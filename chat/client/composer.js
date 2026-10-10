// @ts-check
/**
 * The composer: mentions with completion, attachments (camera, library, file, paste, drop), the
 * text scan's warning before send, drafts per thread, the outbox that resends under the same
 * operation id, "also send to the room", edit and withdraw on the reader's own messages, and
 * reactions as names.
 *
 * On a wide container the composer is one row under the thread (input, attach, the host's attach
 * actions, send) with a hint line under it. Below 720 px it is a reply bar (`+`, input, send); `+`
 * opens a bottom sheet, "Add to this thread", which carries the files, the three ways to add one
 * and the host's actions. The host's actions are a slot (`registerAttachAction`): the kit draws
 * the button and calls the host, and never sees what the host does with it.
 *
 * Sending: the text goes to `POST <base>/scan` first, so a warning reaches the person while they
 * can still change the words. A refusal is shown and nothing is sent; a warning is shown with
 * "send anyway". Then the post enters the outbox, which is kept in `localStorage`: a post that
 * could not be delivered (offline, the room dark, acceptance unknown) stays there and is resent
 * under the same operation id when the browser is back online, on a timer, or when the page
 * opens again, so the room holds it once. A refused post comes back to the person with the reason.
 *
 * Nothing here counts: reactions are lists of names.
 */

import { h } from "./markdown.js";
import { splitMessage, clock } from "./thread.js";
import { uploadFile, prepareFile, filesOf, sizeWords, UploadError } from "./upload.js";

/** @typedef {{ id: string, name: string, ref?: string }} Person */
/**
 * @typedef {{
 *   label: string,
 *   note?: string,
 *   run: (ctx: import("./index.js").ChatContext & { close(): void }) => void | Promise<void>,
 * }} AttachAction
 */
/**
 * @typedef {{
 *   base?: string,
 *   people?: () => Promise<Person[]>,
 *   context?: () => Array<[string, string]>,
 *   reactions?: string[],
 *   storage?: Storage | null,
 *   onPosted?: (receipt: any, thread: string | null) => void,
 *   fetch?: typeof fetch,
 *   messageOf?: (id: string) => any,
 * }} ComposerOptions
 */

/** The words a reaction may be, unless the host names its own: one word each (the kit takes letters, digits, `_` and `-`). */
export const DEFAULT_REACTIONS = ["seen", "thanks", "agreed", "done"];
const OUTBOX_RETRY_MS = [2000, 5000, 10000, 30000, 60000];
const TEXT_LINES_MAX = 8;

/**
 * @typedef {{ unmount(): void, focus(): void, setText(text: string): void, sheet(mode: "attach" | null): void, addFiles(files: File[]): void, edit(messageId: string): Promise<void>, actions(messageId: string): Promise<void>, reaction(event: { target: string, reactions: unknown }): void, purge(event: { id?: string, ts?: string, purged?: unknown, reason?: string }): void, annotation(event: { act?: string, target?: string, text?: string, ts?: string }): void }} ComposerHandle
 */

/** @type {ComposerOptions} */
let defaults = {};
/** The composer mounted in each slot: a thread opened in the same slot replaces it. @type {WeakMap<HTMLElement, ComposerHandle>} */
const mounted = new WeakMap();

/** The composer mounted in a slot, for a host that drives it (a prefilled draft, a file it made). @param {HTMLElement} el */
export function composerIn(el) {
  return /** @type {ComposerHandle | undefined} */ (mounted.get(el));
}
/** @type {Map<string, AttachAction>} */
const attachActions = new Map();

/**
 * The options every composer mounted after this call uses, where `mountComposer`'s own third
 * argument does not say otherwise. A host calls it once, beside `mountChat`.
 * @param {ComposerOptions} o
 */
export function configureComposer(o) {
  defaults = { ...defaults, ...o };
}

/**
 * A host action in the attach sheet and the composer row: a dashed button with a note on the
 * right ("hand over a password" · "never posted"). The kit draws it and calls `run`; what the
 * action does (a sheet of the host's own, a route of the host's own) never passes through the room.
 * @param {string} name @param {AttachAction} action
 */
export function registerAttachAction(name, action) {
  if (!action || typeof action.run !== "function" || typeof action.label !== "string") throw new TypeError("registerAttachAction takes { label, note?, run }");
  attachActions.set(name, action);
}

// ---------------------------------------------------------------------------------------------
// storage: drafts and the outbox

/** @param {ComposerOptions} o @returns {Storage | null} */
function storageOf(o) {
  if (o.storage !== undefined) return o.storage;
  try { return typeof localStorage !== "undefined" ? localStorage : null; } catch { return null; }
}

/** @param {Storage | null} s @param {string} key */
function readJson(s, key) {
  if (!s) return null;
  try { const raw = s.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
/** @param {Storage | null} s @param {string} key @param {unknown} value */
function writeJson(s, key, value) {
  if (!s) return;
  try { if (value === null) s.removeItem(key); else s.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked: the draft lives in the page */ }
}

/** The key a thread's draft is kept under. @param {string} base @param {string | null} thread */
export function draftKey(base, thread) {
  return `agora-chat:draft:${base}:${thread ?? "new"}`;
}

/** A new operation id: 8 to 128 letters, digits, `-` or `_`. */
export function newOperationId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return `d-${crypto.randomUUID()}`;
  return `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * @typedef {{
 *   operationId: string,
 *   thread: string | null,
 *   text: string,
 *   trailers?: Array<[string, string]>,
 *   attachments?: any[],
 *   alsoToRoom?: boolean,
 *   state: "sending" | "queued" | "unknown" | "refused",
 *   reason?: string,
 *   tries: number,
 *   at: string,
 * }} OutboxItem
 */
/**
 * The answer of one delivery attempt: the route's status and body, or `null` when the request never
 * reached it (offline, the connection dropped).
 * @typedef {(body: Record<string, unknown>) => Promise<{ status: number, body: any } | null>} OutboxSend
 */

/**
 * The outbox. Every post goes through it; a post leaves it when the room has answered for it
 * (200), or when it is refused and handed back. A post whose acceptance is unknown (202), or that
 * did not reach the room (offline, 503 dark, any 5xx), stays and is resent under the same operation
 * id, so the room's de-duplication by operation id holds it once. Only one attempt per operation id
 * is in flight at a time, in this page.
 *
 * @param {{
 *   send: OutboxSend,
 *   storage?: Storage | null,
 *   key?: string,
 *   now?: () => Date,
 *   schedule?: (fn: () => void, ms: number) => unknown,
 *   cancel?: (handle: any) => void,
 *   onChange?: (items: OutboxItem[]) => void,
 *   onSent?: (item: OutboxItem, data: any) => void,
 * }} o
 */
export function createOutbox(o) {
  const storage = o.storage ?? null;
  const key = o.key ?? "agora-chat:outbox";
  const now = o.now ?? (() => new Date());
  const schedule = o.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = o.cancel ?? ((t) => clearTimeout(t));
  /** @type {OutboxItem[]} */
  let items = [];
  const stored = readJson(storage, key);
  if (Array.isArray(stored)) {
    for (const it of stored) {
      if (!it || typeof it.operationId !== "string" || typeof it.text !== "string") continue;
      // a page that closed mid-send does not know whether the room took it: resend, same id
      items.push({ ...it, state: it.state === "sending" ? "unknown" : it.state });
    }
  }
  /** @type {Map<string, Promise<OutboxItem | null>>} */
  const inflight = new Map();
  /** @type {Set<(items: OutboxItem[]) => void>} */
  const listeners = new Set();
  if (o.onChange) listeners.add(o.onChange);
  /** @type {any} */
  let timer = null;

  const save = () => {
    writeJson(storage, key, items.length ? items : null);
    for (const fn of listeners) { try { fn(items.slice()); } catch { /* a listener's fault is its own */ } }
  };
  /** @param {string} id */
  const find = (id) => items.find((x) => x.operationId === id);
  /** @param {OutboxItem} it @param {Partial<OutboxItem>} patch */
  const update = (it, patch) => { Object.assign(it, patch); save(); };
  /** @param {string} id */
  const remove = (id) => { items = items.filter((x) => x.operationId !== id); save(); };

  const arm = () => {
    if (timer !== null) { cancel(timer); timer = null; }
    const waiting = items.filter((x) => x.state === "queued" || x.state === "unknown");
    if (!waiting.length) return;
    const tries = Math.min(...waiting.map((x) => x.tries));
    timer = schedule(() => { timer = null; void api.flush(); }, OUTBOX_RETRY_MS[Math.min(Math.max(tries - 1, 0), OUTBOX_RETRY_MS.length - 1)]);
  };

  /**
   * One attempt for one item. Resolves to the item as it stands after the attempt, or null when it
   * left the outbox because the room answered for it.
   * @param {OutboxItem} it
   * @returns {Promise<OutboxItem | null>}
   */
  const attempt = (it) => {
    const running = inflight.get(it.operationId);
    if (running) return running;
    const p = (async () => {
      update(it, { state: "sending", tries: it.tries + 1 });
      /** @type {{ status: number, body: any } | null} */
      let r = null;
      try {
        r = await o.send({
          text: it.text,
          operationId: it.operationId,
          ...(it.thread ? { thread: it.thread } : {}),
          ...(it.trailers?.length ? { trailers: it.trailers } : {}),
          ...(it.attachments?.length ? { attachments: it.attachments } : {}),
          ...(it.alsoToRoom && it.thread ? { alsoToRoom: true } : {}),
        });
      } catch { r = null; }
      if (!find(it.operationId)) return null; // discarded while it was in flight
      if (r && r.status === 200 && r.body?.ok) {
        remove(it.operationId);
        if (o.onSent) { try { o.onSent(it, r.body.data); } catch { /* the listener's own */ } }
        return null;
      }
      const err = r?.body?.error;
      const code = typeof err === "string" ? err : err?.code;
      if (!r) update(it, { state: "queued", reason: "offline" });
      else if (r.status === 202) update(it, { state: "unknown", reason: "the room did not confirm it" });
      else if (r.status === 503 || r.status >= 500 || r.status === 429) update(it, { state: "queued", reason: code === "ROOM_DARK" ? "the room is dark" : `the room answered ${code ?? r.status}` });
      else {
        const why = r.status === 422 ? (err?.reason ?? err?.message ?? "refused")
          : r.status === 409 ? (err?.refusal?.code ?? err?.refusal ?? err?.message ?? "the room refused it")
          : (err?.message ?? code ?? `refused (${r.status})`);
        update(it, { state: "refused", reason: String(typeof why === "string" ? why : JSON.stringify(why)) });
      }
      return it;
    })();
    inflight.set(it.operationId, p);
    p.finally(() => { inflight.delete(it.operationId); arm(); }).catch(() => {});
    return p;
  };

  const api = {
    /** @returns {OutboxItem[]} */
    items: () => items.slice(),
    /**
     * Put a post in the outbox and make the first attempt.
     * @param {{ text: string, thread: string | null, operationId?: string, trailers?: Array<[string, string]>, attachments?: any[], alsoToRoom?: boolean }} post
     */
    add(post) {
      const operationId = post.operationId ?? newOperationId();
      const existing = find(operationId);
      if (existing) return attempt(existing);
      /** @type {OutboxItem} */
      const it = { operationId, thread: post.thread ?? null, text: post.text, trailers: post.trailers, attachments: post.attachments, alsoToRoom: post.alsoToRoom, state: "sending", tries: 0, at: now().toISOString() };
      items.push(it);
      save();
      return attempt(it);
    },
    /** Resend every post that is waiting, oldest first, one at a time. */
    async flush() {
      for (const it of items.slice()) {
        if (it.state !== "queued" && it.state !== "unknown") continue;
        const after = await attempt(it);
        // still unreachable: the rest would only fail the same way, and keep their order
        if (after && after.state === "queued" && after.reason === "offline") break;
      }
    },
    /** Take a post out without sending it. @param {string} id */
    discard(id) { remove(id); },
    /** @param {(items: OutboxItem[]) => void} fn */
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    close() { if (timer !== null) cancel(timer); timer = null; listeners.clear(); },
  };
  arm();
  return api;
}

// ---------------------------------------------------------------------------------------------
// mentions

/**
 * The mention being typed at the caret: the `@` that starts it and the letters after it.
 * @param {string} text @param {number} caret
 * @returns {{ start: number, query: string } | null}
 */
export function mentionAt(text, caret) {
  const before = text.slice(0, caret);
  const m = before.match(/(^|[^A-Za-z0-9._-])@([^\s@]{0,32})$/);
  if (!m) return null;
  return { start: caret - m[2].length - 1, query: m[2] };
}

/**
 * The people a typed prefix matches: names first, then ids, each once.
 * @param {Person[]} people @param {string} query @param {number} [limit]
 */
export function matchPeople(people, query, limit = 6) {
  const q = query.toLowerCase();
  const starts = people.filter((p) => p.name.toLowerCase().startsWith(q) || p.id.toLowerCase().startsWith(q));
  const within = people.filter((p) => !starts.includes(p) && p.name.toLowerCase().includes(q));
  return [...starts, ...within].slice(0, limit);
}

/**
 * Put a completed mention in place of the one being typed.
 * @param {string} text @param {{ start: number, query: string }} at @param {Person} person
 * @returns {{ text: string, caret: number }}
 */
export function insertMention(text, at, person) {
  const end = at.start + 1 + at.query.length;
  const word = `@${person.name} `;
  const next = text.slice(0, at.start) + word + text.slice(end).replace(/^ /, "");
  return { text: next, caret: at.start + word.length };
}

// ---------------------------------------------------------------------------------------------
// the network

/**
 * @param {ComposerOptions} o @param {string} path @param {RequestInit} [init]
 * @returns {Promise<{ status: number, body: any } | null>} null when the request never reached the route
 */
async function call(o, path, init) {
  const base = String(o.base ?? "/chat").replace(/\/+$/, "");
  const doFetch = o.fetch ?? fetch;
  /** @type {Response} */
  let r;
  try {
    r = await doFetch(base + path, { credentials: "same-origin", ...init, headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}) } });
  } catch { return null; }
  /** @type {any} */
  let body = null;
  try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}

/**
 * Ask the host's text scan what a post of these words would meet.
 * @param {ComposerOptions} o @param {string} text
 * @returns {Promise<{ refuse?: string, warn?: string, unchecked?: boolean }>}
 */
export async function scanText(o, text) {
  const r = await call(o, "/scan", { method: "POST", body: JSON.stringify({ text }) });
  if (!r) return { unchecked: true };
  if (r.status === 422) return { refuse: String(r.body?.error?.reason ?? r.body?.error?.message ?? "refused") };
  if (r.status === 200 && r.body?.ok) return r.body.data?.warn ? { warn: String(r.body.data.warn) } : {};
  // a host whose kit predates the scan route: the post scans again and stays the authority
  return { unchecked: true };
}

/** Outboxes by base: one per kit, shared by every composer on the page. @type {Map<string, ReturnType<typeof createOutbox>>} */
const outboxes = new Map();
/** @param {ComposerOptions} o */
function outboxFor(o) {
  const base = String(o.base ?? "/chat").replace(/\/+$/, "");
  let box = outboxes.get(base);
  if (box) return box;
  box = createOutbox({
    storage: storageOf(o),
    key: `agora-chat:outbox:${base}`,
    send: (body) => call(o, "/post", { method: "POST", body: JSON.stringify(body) }),
    onSent: (it, data) => { for (const fn of sentListeners) fn(it, data); },
  });
  outboxes.set(base, box);
  if (typeof window !== "undefined") {
    const b = box;
    window.addEventListener("online", () => { void b.flush(); });
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void b.flush(); });
  }
  void box.flush();
  return box;
}
/** @type {Set<(it: OutboxItem, data: any) => void>} */
const sentListeners = new Set();

/** The state route, read once per base: who the reader is, what the resident is called. @type {Map<string, Promise<any>>} */
const states = new Map();
/** @param {ComposerOptions} o */
function stateOf(o) {
  const base = String(o.base ?? "/chat");
  let p = states.get(base);
  if (!p) {
    p = call(o, "/state").then((r) => (r && r.body?.ok ? r.body.data : null));
    states.set(base, p);
  }
  return p;
}

// ---------------------------------------------------------------------------------------------
// the composer

/**
 * Whether a message is the reader's own: a person's message whose `author.ref` is the reader's ref
 * (the kit names a person by `ref`, else by `id`). Edit and withdraw are the author's by ref on the
 * server, so a name that matches is not enough.
 * @param {any} m @param {Person | null} me
 */
export function isMine(m, me) {
  if (!m || !me || m.author?.kind !== "human") return false;
  const ref = m.author.ref;
  return typeof ref === "string" && ref === (me.ref ?? me.id);
}

/**
 * A served message's reactions, as the people by word. The kit serves one shape on every message
 * (CONTRACT.md, the message): `reactions: [{ name, people: [personId] }]`, each name once, in the
 * order first chosen, and no field when there are none. An array, never an object keyed by name: a
 * name is a person's word, so it is never used as a key.
 * @param {any} m
 * @returns {Map<string, string[]> | null}
 */
export function reactionsOf(m) {
  const r = m?.reactions;
  if (!Array.isArray(r)) return null;
  /** @type {Map<string, string[]>} */
  const out = new Map();
  for (const e of r) {
    if (!e || typeof e.name !== "string" || !Array.isArray(e.people)) continue;
    out.set(e.name, e.people.filter((/** @type {unknown} */ x) => typeof x === "string"));
  }
  return out;
}

/**
 * When a message was purged, from a served message (`purged: { at, purge }`, or `true` where the
 * index says so).
 * @param {any} m
 * @returns {{ at?: string, reason?: string } | null}
 */
export function purgedOf(m) {
  if (!m || !m.purged) return null;
  return typeof m.purged === "object" && typeof m.purged.at === "string" ? { at: m.purged.at } : {};
}

/** The trailer block a message carried, to keep under an edit. @param {string} text */
function trailerBlock(text) {
  const s = splitMessage(text);
  return s.trailers.length ? `\n\n${s.trailers.map((t) => `${t.key}: ${t.value}`).join("\n")}` : "";
}

/**
 * Mount the composer into a slot: the thread pane's `.chat-composer`, or a host's own sheet. `thread`
 * is the root it replies under, `null` for a new thread; `person` is the reader (edit and withdraw
 * are offered on their own messages); the whole context is what a host's attach action is handed.
 * A composer already in the slot is unmounted first.
 * @param {HTMLElement} el
 * @param {import("./index.js").ChatContext} ctx
 * @param {ComposerOptions} [options]
 * @returns {ComposerHandle}
 */
export function mountComposer(el, ctx, options = {}) {
  const previous = mounted.get(el);
  if (previous) previous.unmount();
  /** @type {ComposerOptions} */
  const o = { ...defaults, ...options };
  const base = String(o.base ?? "/chat").replace(/\/+$/, "");
  o.base = base;
  const thread = ctx.thread ?? null;
  const storage = storageOf(o);
  const box = outboxFor(o);
  const reactions = o.reactions ?? DEFAULT_REACTIONS;
  /** @type {Person | null} */
  let me = ctx.person ? { ...ctx.person } : null;
  /** @type {Person[]} */
  let people = [];
  let residentName = "the resident";
  /** @type {Map<string, any>} */
  const known = new Map();
  /** @type {Map<string, Map<string, string[]>>} reactions by message, by word: person ids */
  const reacted = new Map();
  /** @type {Set<string>} */
  const mineIds = new Set();
  /** @type {Map<string, { at?: string, reason?: string }>} the messages a purge took, by id */
  const purged = new Map();
  /** @type {Array<() => void>} */
  const undo = [];
  let gone = false;

  // ---- elements ----
  el.classList.add("chat-cmp");
  el.setAttribute("data-mode", thread ? "reply" : "new");
  const pane = /** @type {HTMLElement | null} */ (el.closest(".chat-thread-pane"));
  const ledger = /** @type {HTMLElement | null} */ (pane?.querySelector(".chat-ledger") ?? null);

  const input = /** @type {HTMLTextAreaElement} */ (h("textarea", {
    class: "chat-cmp-input", rows: "1", spellcheck: "true", autocomplete: "off", enterkeyhint: "send",
    "aria-label": thread ? "Add to this thread" : "Start a thread",
    placeholder: thread ? "› add to this thread · @ to mention" : "› start a thread · its first line is the title · @ to mention",
  }));
  const send = h("button", { type: "button", class: "chat-cmp-send" }, ["send"]);
  const plus = h("button", { type: "button", class: "chat-cmp-plus", "aria-label": "Attach or hand over", "aria-expanded": "false" }, ["+"]);
  const attachBtn = h("button", { type: "button", class: "chat-cmp-attach" }, ["attach"]);
  const rowActions = h("span", { class: "chat-cmp-row-actions" });
  const mentionList = h("ul", { class: "chat-cmp-mentions", role: "listbox", "aria-label": "People", hidden: true });
  const notice = h("div", { class: "chat-cmp-notice", role: "status", "aria-live": "polite", hidden: true });
  const outboxEl = h("ul", { class: "chat-cmp-outbox", "aria-label": "Not sent yet", hidden: true });
  const filesEl = h("ul", { class: "chat-cmp-files", "aria-label": "Files to send", hidden: true });
  const sheetHead = h("div", { class: "chat-cmp-sheet-head" }, [
    h("span", { class: "chat-cap" }, [thread ? "Add to this thread" : "Add to the new thread"]),
    h("button", { type: "button", class: "chat-cmp-close" }, ["close"]),
  ]);
  const pickCamera = /** @type {HTMLInputElement} */ (h("input", { type: "file", accept: "image/*", capture: "environment", hidden: true, tabindex: "-1" }));
  const pickLibrary = /** @type {HTMLInputElement} */ (h("input", { type: "file", accept: "image/*", multiple: true, hidden: true, tabindex: "-1" }));
  const pickFile = /** @type {HTMLInputElement} */ (h("input", { type: "file", multiple: true, hidden: true, tabindex: "-1" }));
  const optCamera = h("button", { type: "button", class: "chat-cmp-option" }, ["take a photo"]);
  const optLibrary = h("button", { type: "button", class: "chat-cmp-option" }, ["photo library"]);
  const optFile = h("button", { type: "button", class: "chat-cmp-option" }, ["a file: PDF, drawing, config"]);
  const sheetActions = h("div", { class: "chat-cmp-sheet-actions" });
  const sheetOptions = h("div", { class: "chat-cmp-options" }, [optCamera, optLibrary, optFile, sheetActions]);
  const alsoBox = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", class: "chat-cmp-also-box" }));
  const also = h("label", { class: "chat-cmp-also" }, [alsoBox, " also send to the room"]);
  const hint = h("span", { class: "chat-cmp-hint-words" });
  const foot = h("div", { class: "chat-cmp-foot" }, [hint, thread ? also : null]);
  const row = h("div", { class: "chat-cmp-row" }, [plus, h("div", { class: "chat-cmp-field" }, [input, mentionList]), attachBtn, rowActions, send]);
  const editing = h("div", { class: "chat-cmp-editing", hidden: true });
  const wrap = h("div", { class: "chat-cmp-wrap", "data-sheet": "closed" }, [
    sheetHead, notice, outboxEl, editing, filesEl, sheetOptions, row, foot, pickCamera, pickLibrary, pickFile,
  ]);
  while (el.firstChild) el.removeChild(el.firstChild);
  el.appendChild(wrap);

  // ---- state ----
  /** @type {Array<{ key: string, file: File, name: string, size: number, state: "reading" | "uploading" | "ready" | "refused", reason?: string, attachment?: any, preview?: string }>} */
  let files = [];
  /** @type {{ text: string, warn: string } | null} */
  let warned = null;
  /** @type {{ id: string, original: any, loading?: boolean } | null} */
  let editingMsg = null;
  let sending = false;

  // ---- drafts ----
  const dKey = draftKey(base, thread);
  const draft = readJson(storage, dKey);
  if (draft && typeof draft.text === "string") input.value = draft.text;
  if (draft && draft.alsoToRoom) alsoBox.checked = true;
  /** @type {any} */
  let draftTimer = null;
  const saveDraft = () => {
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      draftTimer = null;
      if (editingMsg) return;
      writeJson(storage, dKey, input.value.trim() ? { text: input.value, alsoToRoom: alsoBox.checked, at: new Date().toISOString() } : null);
    }, 250);
  };

  // ---- drawing ----
  const fit = () => {
    input.style.height = "auto";
    const line = parseFloat(getComputedStyle(input).lineHeight) || 20;
    const max = line * TEXT_LINES_MAX + 24;
    input.style.height = `${Math.min(input.scrollHeight + 2, max)}px`;
  };

  const drawHint = () => {
    const ctxValues = (o.context?.() ?? []).filter(([k]) => k === "context").flatMap(([, v]) => v.split(";").map((p) => p.split("=").slice(1).join("=").trim())).filter(Boolean);
    hint.textContent = (ctxValues.length ? `${residentName} sees ${ctxValues.join(", ")} with your message · ` : "") + "drop a file anywhere";
  };

  /** @param {"warn" | "refuse" | "info" | "error"} kind @param {Array<Node | string>} children */
  const showNotice = (kind, children) => {
    while (notice.firstChild) notice.removeChild(notice.firstChild);
    for (const c of children) notice.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    notice.setAttribute("data-kind", kind);
    notice.hidden = false;
  };
  const clearNotice = () => { notice.hidden = true; notice.removeAttribute("data-kind"); while (notice.firstChild) notice.removeChild(notice.firstChild); };

  const drawFiles = () => {
    while (filesEl.firstChild) filesEl.removeChild(filesEl.firstChild);
    filesEl.hidden = files.length === 0;
    for (const f of files) {
      const thumb = h("span", { class: "chat-cmp-file-thumb" });
      if (f.preview) thumb.appendChild(h("img", { src: f.preview, alt: "" }));
      const words = f.state === "reading" ? "reading" : f.state === "uploading" ? "uploading" : f.state === "ready" ? "ready" : `not sent: ${f.reason ?? "refused"}`;
      const remove = h("button", { type: "button", class: "chat-cmp-file-x", "aria-label": `Remove ${f.name}` }, ["×"]);
      remove.addEventListener("click", () => {
        if (f.preview) URL.revokeObjectURL(f.preview);
        files = files.filter((x) => x !== f);
        drawFiles();
      });
      filesEl.appendChild(h("li", { class: "chat-cmp-file", "data-state": f.state }, [
        thumb,
        h("span", { class: "chat-cmp-file-words" }, [
          h("span", { class: "chat-cmp-file-name" }, [`${f.name} · ${sizeWords(f.size)}`]),
          h("span", { class: "chat-cmp-file-state" }, [words]),
        ]),
        remove,
      ]));
    }
    drawSend();
  };

  const drawSend = () => {
    const pending = files.some((f) => f.state === "reading" || f.state === "uploading");
    const empty = !input.value.trim() && !files.some((f) => f.state === "ready");
    send.toggleAttribute("disabled", sending || pending || empty || !!editingMsg?.loading);
    send.textContent = editingMsg ? "save" : warned && warned.text === input.value ? "send anyway" : "send";
    send.setAttribute("data-warned", warned && warned.text === input.value ? "true" : "false");
    // the button's words change its width, and so the box's: measure the box again
    fit();
  };

  /** @param {OutboxItem[]} items */
  const drawOutbox = (items) => {
    while (outboxEl.firstChild) outboxEl.removeChild(outboxEl.firstChild);
    const mine = items.filter((x) => x.thread === thread);
    outboxEl.hidden = mine.length === 0;
    for (const it of mine) {
      const first = it.text.split("\n").find((l) => l.trim()) ?? "";
      const state = it.state === "refused" ? `not sent · ${it.reason ?? "refused"}`
        : it.state === "sending" ? "sending"
        : it.state === "unknown" ? "sending again · the room did not confirm it"
        : `not sent yet · ${it.reason === "offline" ? "offline" : it.reason ?? "waiting"} · goes when the room answers`;
      const acts = h("span", { class: "chat-cmp-ob-acts" });
      if (it.state === "refused") {
        const back = h("button", { type: "button", class: "chat-cmp-link" }, ["edit"]);
        back.addEventListener("click", () => {
          box.discard(it.operationId);
          input.value = it.text;
          if (it.alsoToRoom) alsoBox.checked = true;
          fit(); saveDraft(); drawSend(); input.focus();
        });
        acts.appendChild(back);
      } else if (it.state !== "sending") {
        const now = h("button", { type: "button", class: "chat-cmp-link" }, ["try now"]);
        now.addEventListener("click", () => { void box.flush(); });
        acts.appendChild(now);
      }
      const drop = h("button", { type: "button", class: "chat-cmp-link" }, ["discard"]);
      drop.addEventListener("click", () => { box.discard(it.operationId); });
      if (it.state !== "sending") acts.appendChild(drop);
      outboxEl.appendChild(h("li", { class: "chat-cmp-ob", "data-state": it.state }, [
        h("span", { class: "chat-cmp-ob-text" }, [first]),
        h("span", { class: "chat-cmp-ob-state" }, [state]),
        acts,
      ]));
    }
  };

  const drawActions = () => {
    for (const target of [rowActions, sheetActions]) {
      while (target.firstChild) target.removeChild(target.firstChild);
      for (const [name, a] of attachActions) {
        const b = h("button", { type: "button", class: "chat-cmp-host", "data-action": name }, [
          h("span", {}, [a.label]),
          a.note ? h("span", { class: "chat-cmp-host-note" }, [a.note]) : null,
        ]);
        b.addEventListener("click", () => {
          void Promise.resolve(a.run({ ...ctx, close: () => setSheet(null) })).catch((e) => showNotice("error", [`${a.label}: ${e instanceof Error ? e.message : String(e)}`]));
        });
        target.appendChild(b);
      }
    }
  };

  /** @param {"attach" | null} mode */
  const setSheet = (mode) => {
    wrap.setAttribute("data-sheet", mode ?? "closed");
    plus.setAttribute("aria-expanded", mode ? "true" : "false");
    if (pane) { if (mode) pane.setAttribute("data-chat-sheet", mode); else pane.removeAttribute("data-chat-sheet"); }
  };

  // ---- files ----
  /** @param {File[]} list */
  const addFiles = (list) => {
    for (const file of list) {
      const entry = { key: `${Date.now()}-${Math.random()}`, file, name: file.name || "pasted", size: file.size, state: /** @type {"reading"} */ ("reading") };
      files.push(entry);
      void (async () => {
        try {
          const prepared = await prepareFile(file);
          const e = /** @type {any} */ (entry);
          e.name = prepared.name;
          e.size = prepared.blob.size;
          if (prepared.thumb || prepared.reencoded) e.preview = URL.createObjectURL(prepared.thumb ?? prepared.blob);
          e.state = "uploading";
          drawFiles();
          const r = await uploadFile(file, { base, prepared, ...(o.fetch ? { fetch: o.fetch } : {}) });
          e.attachment = r.attachment;
          e.state = "ready";
        } catch (err) {
          const e = /** @type {any} */ (entry);
          e.state = "refused";
          e.reason = err instanceof UploadError ? (err.reason ?? err.message) : err instanceof Error ? err.message : String(err);
        }
        if (!gone) drawFiles();
      })();
    }
    drawFiles();
  };
  for (const [opt, pick] of /** @type {Array<[HTMLElement, HTMLInputElement]>} */ ([[optCamera, pickCamera], [optLibrary, pickLibrary], [optFile, pickFile]])) {
    opt.addEventListener("click", () => pick.click());
    pick.addEventListener("change", () => { addFiles(Array.from(pick.files ?? [])); pick.value = ""; });
  }
  attachBtn.addEventListener("click", () => pickFile.click());
  plus.addEventListener("click", () => setSheet(wrap.getAttribute("data-sheet") === "attach" ? null : "attach"));
  /** @type {HTMLElement} */ (sheetHead.querySelector(".chat-cmp-close")).addEventListener("click", () => { setSheet(null); closeActions(); });
  input.addEventListener("paste", (ev) => {
    const list = filesOf(ev);
    if (list.length) { ev.preventDefault(); addFiles(list); }
  });
  const dropZone = pane ?? el;
  /** @param {DragEvent} ev */
  const onDragOver = (ev) => { if (ev.dataTransfer && Array.from(ev.dataTransfer.types ?? []).includes("Files")) { ev.preventDefault(); dropZone.setAttribute("data-chat-drop", "true"); } };
  const onDragLeave = () => dropZone.removeAttribute("data-chat-drop");
  /** @param {DragEvent} ev */
  const onDrop = (ev) => { const list = filesOf(ev); dropZone.removeAttribute("data-chat-drop"); if (list.length) { ev.preventDefault(); addFiles(list); } };
  dropZone.addEventListener("dragover", onDragOver);
  dropZone.addEventListener("dragleave", onDragLeave);
  dropZone.addEventListener("drop", onDrop);
  undo.push(() => { dropZone.removeEventListener("dragover", onDragOver); dropZone.removeEventListener("dragleave", onDragLeave); dropZone.removeEventListener("drop", onDrop); });

  // ---- mentions ----
  let mentionIndex = 0;
  /** @type {Person[]} */
  let mentionHits = [];
  const closeMentions = () => { mentionList.hidden = true; mentionHits = []; input.removeAttribute("aria-activedescendant"); };
  const drawMentions = () => {
    const at = mentionAt(input.value, input.selectionStart ?? input.value.length);
    mentionHits = at ? matchPeople(people, at.query) : [];
    while (mentionList.firstChild) mentionList.removeChild(mentionList.firstChild);
    if (!at || !mentionHits.length) { closeMentions(); return; }
    mentionIndex = Math.min(mentionIndex, mentionHits.length - 1);
    mentionHits.forEach((p, i) => {
      const li = h("li", { role: "option", class: "chat-cmp-mention", id: `chat-mention-${i}`, "aria-selected": i === mentionIndex ? "true" : "false" }, [
        h("span", { class: "chat-cmp-mention-name" }, [`@${p.name}`]),
        p.id !== p.name ? h("span", { class: "chat-cmp-mention-id" }, [p.id]) : null,
      ]);
      li.addEventListener("mousedown", (ev) => { ev.preventDefault(); pickMention(p); });
      mentionList.appendChild(li);
    });
    input.setAttribute("aria-activedescendant", `chat-mention-${mentionIndex}`);
    mentionList.hidden = false;
  };
  /** @param {Person} p */
  const pickMention = (p) => {
    const at = mentionAt(input.value, input.selectionStart ?? input.value.length);
    if (!at) return;
    const next = insertMention(input.value, at, p);
    input.value = next.text;
    input.setSelectionRange(next.caret, next.caret);
    closeMentions();
    fit(); saveDraft(); drawSend();
  };

  input.addEventListener("input", () => {
    if (warned && warned.text !== input.value) { warned = null; clearNotice(); }
    mentionIndex = 0;
    fit(); drawMentions(); saveDraft(); drawSend();
  });
  input.addEventListener("keydown", (ev) => {
    if (!mentionList.hidden && mentionHits.length) {
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") { ev.preventDefault(); mentionIndex = (mentionIndex + (ev.key === "ArrowDown" ? 1 : -1) + mentionHits.length) % mentionHits.length; drawMentions(); return; }
      if (ev.key === "Enter" || ev.key === "Tab") { ev.preventDefault(); pickMention(mentionHits[mentionIndex]); return; }
      if (ev.key === "Escape") { ev.preventDefault(); closeMentions(); return; }
    }
    if (ev.key === "Escape" && editingMsg) { ev.preventDefault(); stopEdit(); return; }
    // Enter sends on a keyboard; Shift+Enter is a new line. A phone's return key is a new line.
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing && !(typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches)) {
      ev.preventDefault();
      void submit();
    }
  });
  input.addEventListener("blur", () => setTimeout(closeMentions, 120));
  alsoBox.addEventListener("change", saveDraft);

  // ---- sending ----
  const submit = async () => {
    if (sending) return;
    const text = input.value.replace(/\s+$/, "");
    const ready = files.filter((f) => f.state === "ready");
    if (files.some((f) => f.state === "reading" || f.state === "uploading")) return;
    if (!text.trim() && !ready.length) return;
    sending = true;
    drawSend();
    try {
      if (editingMsg) { if (!editingMsg.loading) await saveEdit(text); return; }
      const words = text.trim() ? text : ready.map((f) => f.name).join(", ");
      if (!(warned && warned.text === input.value)) {
        const scan = await scanText(o, words);
        if (scan.refuse) {
          warned = null;
          showNotice("refuse", [h("strong", {}, ["not sent"]), ` · ${scan.refuse}. Change the words; this cannot be sent as it is.`]);
          return;
        }
        if (scan.warn) {
          warned = { text: input.value, warn: scan.warn };
          const edit = h("button", { type: "button", class: "chat-cmp-link" }, ["change it"]);
          edit.addEventListener("click", () => input.focus());
          showNotice("warn", [h("strong", {}, ["check before sending"]), ` · ${scan.warn}`, h("span", { class: "chat-cmp-notice-acts" }, [edit])]);
          return;
        }
      }
      warned = null;
      clearNotice();
      const trailers = o.context?.() ?? [];
      const post = { text: words, thread, operationId: newOperationId(), ...(trailers.length ? { trailers } : {}), ...(ready.length ? { attachments: ready.map((f) => f.attachment) } : {}), ...(thread && alsoBox.checked ? { alsoToRoom: true } : {}) };
      // the words leave the composer once they are in the outbox: the outbox keeps them until the room answers
      for (const f of files) if (f.preview) URL.revokeObjectURL(f.preview);
      files = [];
      input.value = "";
      alsoBox.checked = false;
      writeJson(storage, dKey, null);
      fit(); drawFiles(); setSheet(null);
      await box.add(post);
    } finally {
      sending = false;
      if (!gone) drawSend();
    }
  };
  send.addEventListener("click", () => { void submit(); });
  /** @param {OutboxItem} it @param {any} data */
  const onSent = (it, data) => {
    if (data?.receipt?.id) mineIds.add(data.receipt.id);
    if (data?.warn && it.thread === thread) showNotice("info", [`sent · the scan noted: ${data.warn}`]);
    if (o.onPosted && it.thread === thread) { try { o.onPosted(data?.receipt, thread); } catch { /* the host's own */ } }
  };
  sentListeners.add(onSent);
  undo.push(() => { sentListeners.delete(onSent); });
  undo.push(box.subscribe(drawOutbox));

  // ---- edit, withdraw, reactions ----
  const loadThread = async () => {
    if (!thread) return;
    const r = await call(o, `/thread/${encodeURIComponent(thread)}`);
    for (const m of r?.body?.data?.messages ?? []) {
      if (!m || typeof m.id !== "string") continue;
      known.set(m.id, m);
      const rx = reactionsOf(m);
      if (rx) reacted.set(m.id, rx);
      const p = purgedOf(m);
      if (p && !purged.has(m.id)) purged.set(m.id, p);
    }
  };
  /** @param {string} id */
  const messageOf = async (id) => {
    if (!known.has(id)) await loadThread();
    return known.get(id) ?? null;
  };
  /** @param {HTMLElement} row */
  const rowIsMine = (row) => {
    const id = row.getAttribute("data-id") ?? "";
    if (mineIds.has(id)) return true;
    return isMine(heldMessage(id), me);
  };

  /**
   * The message as this page already holds it: the ledger's own copy (the host's `messageOf`, kept
   * current by the stream's annotations), else the composer's. Null when neither has it.
   * @param {string} id
   */
  const heldMessage = (id) => {
    let m = null;
    if (o.messageOf) { try { m = o.messageOf(id) ?? null; } catch { m = null; } }
    return m ?? known.get(id) ?? null;
  };
  /** @param {string} words @param {Array<Node | string>} [more] */
  const drawEditing = (words, more = []) => {
    while (editing.firstChild) editing.removeChild(editing.firstChild);
    const cancel = h("button", { type: "button", class: "chat-cmp-link" }, ["cancel"]);
    cancel.addEventListener("click", stopEdit);
    editing.appendChild(h("span", {}, [words, ...more]));
    editing.appendChild(cancel);
    editing.hidden = false;
  };
  /** The box takes no typing while it waits for words to be put in it. @param {boolean} on */
  const lockBox = (on) => {
    input.readOnly = on;
    if (on) input.setAttribute("aria-busy", "true"); else input.removeAttribute("aria-busy");
  };
  /** The draft as typed, kept now: the edit borrows the box and `stopEdit` gives the draft back. */
  const keepDraft = () => {
    if (draftTimer) { clearTimeout(draftTimer); draftTimer = null; }
    writeJson(storage, dKey, input.value.trim() ? { text: input.value, alsoToRoom: alsoBox.checked, at: new Date().toISOString() } : null);
  };
  /** @param {string} id @param {any} m */
  const beginEdit = (id, m) => {
    editingMsg = { id, original: m };
    input.value = splitMessage(m.text).body;
    lockBox(false);
    warned = null;
    clearNotice();
    drawEditing(`editing your message from ${clock(m.ts)}`);
    wrap.setAttribute("data-editing", "true");
    fit(); drawSend();
    input.focus();
  };

  /**
   * Edit one of the reader's messages. The box is filled from the words the page already holds, at
   * once, so there is no moment in which typing can be lost. Only when the page holds nothing does
   * it ask the room; the box is read-only until the words are in it, and if anything reached the box
   * in that window anyway, the box keeps it and the composer says what the room's words are.
   * @param {string} id
   */
  const startEdit = async (id) => {
    if (editingMsg && editingMsg.id === id) { input.focus(); return; }
    if (!editingMsg) keepDraft();
    const held = heldMessage(id);
    if (held) {
      if (held.withdrawn || held.purged) { showNotice("error", ["that message cannot be edited now"]); return; }
      beginEdit(id, held);
      return;
    }
    editingMsg = { id, original: null, loading: true };
    const before = input.value;
    lockBox(true);
    warned = null;
    clearNotice();
    drawEditing("loading your message");
    wrap.setAttribute("data-editing", "loading");
    drawSend();
    await loadThread();
    if (gone || !editingMsg || editingMsg.id !== id) return;
    const m = known.get(id) ?? null;
    if (!m || m.withdrawn || m.purged) { stopEdit(); showNotice("error", ["that message cannot be edited now"]); return; }
    if (input.value === before) { beginEdit(id, m); return; }
    // something reached the box while it waited: it is the person's, and it stays
    const typed = input.value;
    beginEdit(id, m);
    input.value = typed;
    fit(); drawSend();
    roomWordsDiffer(m);
  };
  /**
   * Say, in the composer, that the room's words for the message being edited are not what the box
   * holds, with a way to take them; the box is never changed without the person's hand.
   * @param {any} m
   */
  const roomWordsDiffer = (m) => {
    const words = splitMessage(m.text).body;
    const take = h("button", { type: "button", class: "chat-cmp-link" }, ["use the room's words"]);
    take.addEventListener("click", () => {
      if (!editingMsg || editingMsg.id !== m.id) return;
      input.value = words;
      clearNotice(); fit(); drawSend(); input.focus();
    });
    const first = words.split("\n").find((l) => l.trim()) ?? "";
    showNotice("info", [h("strong", {}, ["your words are kept"]), ` · the room has this message as “${first.length > 80 ? first.slice(0, 79) + "…" : first}”; saving replaces it with what is in the box`, h("span", { class: "chat-cmp-notice-acts" }, [take])]);
  };
  const stopEdit = () => {
    editingMsg = null;
    lockBox(false);
    editing.hidden = true;
    wrap.removeAttribute("data-editing");
    const d = readJson(storage, dKey);
    input.value = d && typeof d.text === "string" ? d.text : "";
    warned = null;
    clearNotice();
    fit(); drawSend();
  };
  /** @param {string} text */
  const saveEdit = async (text) => {
    const ed = editingMsg;
    if (!ed || !ed.original) return;
    if (!text.trim()) { showNotice("error", ["an edit keeps some words; to take a message back, withdraw it"]); return; }
    if (!(warned && warned.text === input.value)) {
      const scan = await scanText(o, text);
      if (scan.refuse) { showNotice("refuse", [h("strong", {}, ["not saved"]), ` · ${scan.refuse}. Change the words; this cannot be saved as it is.`]); return; }
      if (scan.warn) { warned = { text: input.value, warn: scan.warn }; showNotice("warn", [h("strong", {}, ["check before saving"]), ` · ${scan.warn}`]); return; }
    }
    const r = await call(o, "/annotate", { method: "POST", body: JSON.stringify({ act: "edit", target: ed.id, text: text + trailerBlock(ed.original.text) }) });
    if (!r) { showNotice("error", ["not saved · offline; the edit is still here"]); return; }
    if (!(r.status === 200 && r.body?.ok)) { showNotice("error", [`not saved · ${r.body?.error?.reason ?? r.body?.error?.refusal?.code ?? r.body?.error?.message ?? r.body?.error?.code ?? r.status}`]); return; }
    known.set(ed.id, { ...ed.original, text: text + trailerBlock(ed.original.text), edited: { at: new Date().toISOString() } });
    if (editingMsg === ed) stopEdit();
  };

  /** @param {string} id */
  const withdraw = async (id) => {
    const r = await call(o, "/annotate", { method: "POST", body: JSON.stringify({ act: "withdraw", target: id }) });
    if (!r) return "offline: nothing was withdrawn";
    if (!(r.status === 200 && r.body?.ok)) return String(r.body?.error?.refusal?.code ?? r.body?.error?.message ?? r.body?.error?.code ?? r.status);
    return null;
  };

  /** @param {string} id @param {string} word @param {boolean} on */
  const react = async (id, word, on) => {
    const r = await call(o, "/react", { method: "POST", body: JSON.stringify({ target: id, name: word, on }) });
    if (!r || !(r.status === 200 && r.body?.ok)) return false;
    // the answer carries the message's reactions as now folded: the same shape every message has
    reacted.set(id, reactionsOf({ reactions: r.body.data?.reactions ?? [] }) ?? new Map());
    if (ledger) decorate(ledger);
    return true;
  };

  /** @param {string} id */
  const nameOf = (id) => people.find((p) => p.id === id)?.name ?? (me && me.id === id ? me.name : id);

  const actionsEl = h("section", { class: "chat-cmp-actions", "aria-label": "This message", hidden: true });
  wrap.insertBefore(actionsEl, notice);
  const closeActions = () => {
    actionsEl.hidden = true;
    while (actionsEl.firstChild) actionsEl.removeChild(actionsEl.firstChild);
    if (wrap.getAttribute("data-sheet") === "actions") setSheetActions(false);
  };
  /** @param {boolean} on */
  const setSheetActions = (on) => {
    wrap.setAttribute("data-sheet", on ? "actions" : "closed");
    if (pane) { if (on) pane.setAttribute("data-chat-sheet", "actions"); else pane.removeAttribute("data-chat-sheet"); }
  };
  /** @param {string} id */
  const openActions = async (id) => {
    if (purged.has(id)) return;
    if (!heldMessage(id) && !mineIds.has(id)) await messageOf(id);
    if (gone) return;
    const row = /** @type {HTMLElement | null} */ (ledger?.querySelector(`[data-id="${id.replace(/[^A-Za-z0-9_-]/g, "")}"]`) ?? null);
    // a withdrawn message takes nothing more: no reaction, no edit, no second withdrawal
    if (row?.classList.contains("is-withdrawn") || heldMessage(id)?.withdrawn) { closeActions(); return; }
    while (actionsEl.firstChild) actionsEl.removeChild(actionsEl.firstChild);
    const who = row?.querySelector(".chat-msg-who")?.textContent ?? "";
    const at = row?.querySelector(".chat-msg-time")?.textContent ?? "";
    const close = h("button", { type: "button", class: "chat-cmp-close" }, ["close"]);
    close.addEventListener("click", closeActions);
    actionsEl.appendChild(h("div", { class: "chat-cmp-sheet-head" }, [h("span", { class: "chat-cap" }, [`This message · ${at} · ${who}`]), close]));
    const words = h("div", { class: "chat-cmp-reacts", role: "group", "aria-label": "React" });
    const byWord = reacted.get(id);
    for (const w of reactions) {
      const on = !!me && (byWord?.get(w) ?? []).includes(me.id);
      const b = h("button", { type: "button", class: "chat-cmp-react", "aria-pressed": on ? "true" : "false" }, [w]);
      b.addEventListener("click", async () => {
        b.setAttribute("disabled", "");
        const ok = await react(id, w, b.getAttribute("aria-pressed") !== "true");
        b.removeAttribute("disabled");
        if (ok) closeActions(); else b.setAttribute("data-failed", "true");
      });
      words.appendChild(b);
    }
    actionsEl.appendChild(words);
    if (row && rowIsMine(row)) {
      const edit = h("button", { type: "button", class: "chat-cmp-option" }, ["edit"]);
      edit.addEventListener("click", () => { closeActions(); void startEdit(id); });
      const wd = h("button", { type: "button", class: "chat-cmp-option" }, ["withdraw"]);
      const err = h("p", { class: "chat-cmp-actions-err", role: "alert", hidden: true });
      wd.addEventListener("click", async () => {
        if (wd.getAttribute("data-confirm") !== "true") {
          wd.setAttribute("data-confirm", "true");
          wd.textContent = "withdraw it · it stays in the record as withdrawn";
          return;
        }
        wd.setAttribute("disabled", "");
        const failed = await withdraw(id);
        wd.removeAttribute("disabled");
        if (failed) { err.textContent = `not withdrawn · ${failed}`; err.hidden = false; return; }
        closeActions();
      });
      actionsEl.appendChild(h("div", { class: "chat-cmp-options" }, [edit, wd, err]));
    }
    actionsEl.setAttribute("data-id", id);
    actionsEl.hidden = false;
    setSheet(null);
    setSheetActions(true);
  };

  /** Give each ledger row its "more" control and its reactions line; rows are redrawn, so this runs again. @param {HTMLElement} root */
  const decorate = (root) => {
    for (const row of /** @type {HTMLElement[]} */ (Array.from(root.querySelectorAll(".chat-msg")))) {
      const id = row.getAttribute("data-id");
      if (!id) continue;
      const body = row.querySelector(".chat-msg-body");
      if (!body) continue;
      const tookIt = purged.get(id);
      if (tookIt) {
        // the words, files and cards a purge took leave the page; the row keeps its place and says so
        if (!row.classList.contains("is-purged")) {
          row.classList.add("is-purged");
          while (body.firstChild) body.removeChild(body.firstChild);
          body.appendChild(h("p", { class: "chat-msg-purged" }, [`purged${tookIt.at ? ` ${clock(tookIt.at)}` : ""}${tookIt.reason ? ` · ${tookIt.reason}` : ""}`]));
          row.querySelector(".chat-msg-more")?.remove();
        }
        continue;
      }
      if (row.classList.contains("is-withdrawn")) {
        // a withdrawn message keeps its place and nothing else: no reactions line, no "more" control
        row.querySelector(".chat-msg-more")?.remove();
        body.querySelector(".chat-reacts")?.remove();
        if (actionsEl.getAttribute("data-id") === id && !actionsEl.hidden) closeActions();
        continue;
      }
      if (!row.querySelector(".chat-msg-more")) {
        const more = h("button", { type: "button", class: "chat-msg-more", "aria-label": "React, edit or withdraw", title: "react, edit or withdraw" }, ["···"]);
        more.addEventListener("click", (ev) => { ev.stopPropagation(); openActions(id); });
        row.appendChild(more);
      }
      const byWord = reacted.get(id);
      const old = body.querySelector(".chat-reacts");
      const parts = byWord ? [...byWord].filter(([, ids]) => ids.length).map(([w, ids]) => `${w} · ${ids.map(nameOf).join(", ")}`) : [];
      const line = parts.join("   ");
      if (old && old.textContent === line) continue;
      if (old) old.remove();
      if (line) body.appendChild(h("div", { class: "chat-reacts", "aria-label": "Reactions" }, [line]));
    }
  };
  if (ledger) {
    decorate(ledger);
    const mo = new MutationObserver(() => decorate(ledger));
    mo.observe(ledger, { childList: true });
    undo.push(() => mo.disconnect());
  }

  // the phone's reply bar has room for two words; the wide row says what the box takes
  const shell = /** @type {HTMLElement | null} */ (el.closest(".chat"));
  const drawPlaceholder = () => {
    const narrow = (shell?.clientWidth ?? 1000) < 720;
    input.placeholder = thread ? (narrow ? "› reply" : "› add to this thread · @ to mention")
      : (narrow ? "› start a thread" : "› start a thread · its first line is the title · @ to mention");
  };
  drawPlaceholder();
  if (shell && typeof ResizeObserver === "function") {
    const ro = new ResizeObserver(() => { drawPlaceholder(); fit(); });
    ro.observe(shell);
    undo.push(() => ro.disconnect());
  }

  // ---- purges: the thread's stream (index.js) hands each one over through the handle ----
  /** @param {{ id?: string, ts?: string, purged?: unknown, reason?: string }} p */
  const applyPurge = (p) => {
    if (gone || !p || !Array.isArray(p.purged)) return;
    for (const id of p.purged) {
      if (typeof id !== "string") continue;
      purged.set(id, { at: typeof p.ts === "string" ? p.ts : undefined, reason: typeof p.reason === "string" ? p.reason : undefined });
      const m = known.get(id);
      if (m) known.set(id, { ...m, text: "", purged: { at: p.ts, purge: p.id } });
      if (editingMsg && editingMsg.id === id) stopEdit();
    }
    if (!actionsEl.hidden && p.purged.includes(actionsEl.getAttribute("data-id"))) closeActions();
    if (ledger) decorate(ledger);
  };

  // ---- start ----
  drawActions();
  drawOutbox(box.items());
  drawHint();
  drawFiles();
  fit();
  void (async () => {
    const st = await stateOf(o);
    if (gone) return;
    if (st?.me) me = { ...st.me };
    if (st?.resident?.name) residentName = String(st.resident.name);
    drawHint();
    if (o.people) { try { people = await o.people(); } catch { people = []; } }
    await loadThread();
    if (gone) return;
    if (ledger) decorate(ledger);
  })();

  const handle = {
    unmount() {
      if (gone) return;
      gone = true;
      mounted.delete(el);
      for (const f of undo) f();
      if (draftTimer) clearTimeout(draftTimer);
      for (const f of files) if (f.preview) URL.revokeObjectURL(f.preview);
      if (pane) pane.removeAttribute("data-chat-sheet");
      wrap.remove();
      el.classList.remove("chat-cmp");
    },
    focus: () => input.focus(),
    /** @param {string} text */
    setText(text) { input.value = text; fit(); saveDraft(); drawSend(); },
    sheet: setSheet,
    addFiles,
    edit: startEdit,
    actions: openActions,
    /**
     * A stream's `reaction` event: the message's reactions as they now stand, from anyone.
     * @param {{ target: string, reactions: unknown }} event
     */
    reaction(event) {
      if (gone || !event || typeof event.target !== "string") return;
      reacted.set(event.target, reactionsOf({ reactions: event.reactions }) ?? new Map());
      if (ledger) decorate(ledger);
    },
    /** A stream's `purge` event: the rows it took lose their words and keep their place. */
    purge: applyPurge,
    /**
     * A stream's `annotation` event. When it changes the message being edited, the composer says so
     * and leaves the box as the person has it; a withdrawal ends the edit.
     * @param {{ act?: string, target?: string, text?: string, ts?: string }} a
     */
    annotation(a) {
      if (gone || !a || typeof a.target !== "string") return;
      const m = known.get(a.target);
      if (m && a.act === "withdraw") known.set(a.target, { ...m, withdrawn: m.withdrawn ?? { at: a.ts } });
      if (!editingMsg || editingMsg.id !== a.target || editingMsg.loading) return;
      if (a.act === "withdraw") { stopEdit(); showNotice("error", ["that message was withdrawn while you edited it; the edit was not saved"]); return; }
      if (a.act !== "edit" || typeof a.text !== "string" || !editingMsg.original) return;
      const next = { ...editingMsg.original, text: a.text, edited: { at: a.ts } };
      known.set(a.target, next);
      editingMsg = { id: a.target, original: next };
      if (splitMessage(a.text).body !== input.value.replace(/\s+$/, "")) roomWordsDiffer(next);
    },
  };
  mounted.set(el, handle);
  return handle;
}
