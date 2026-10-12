// @ts-check
// mountChat's opening order: a linked thread is read by its root at mount and drawn as soon as the
// person is known, never after the thread list; its stream still opens after that read, so a
// record the read holds is drawn once. A small document, a fetch whose answers the test releases
// one by one, and an EventSource the test feeds stand in for the browser.
import test from "node:test";
import assert from "node:assert/strict";

/** @typedef {any} N */
class Node_ {
  /** @param {number} type */
  constructor(type) {
    this.nodeType = type;
    /** @type {N[]} */
    this.childNodes = [];
    /** @type {N} */
    this.parentNode = null;
  }
  get firstChild() { return this.childNodes[0] ?? null; }
  /** @param {N} c */
  appendChild(c) {
    if (c.nodeType === 11) { for (const k of [...c.childNodes]) this.appendChild(k); return c; }
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this; this.childNodes.push(c); return c;
  }
  /** @param {N} n @param {N} ref */
  insertBefore(n, ref) {
    if (!ref) return this.appendChild(n);
    if (n.parentNode) n.parentNode.removeChild(n);
    this.childNodes.splice(this.childNodes.indexOf(ref), 0, n); n.parentNode = this; return n;
  }
  /** @param {N} c */
  removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; }
  /** @param {N} n @param {N} old */
  replaceChild(n, old) { const i = this.childNodes.indexOf(old); if (n.parentNode) n.parentNode.removeChild(n); this.childNodes[i] = n; n.parentNode = this; old.parentNode = null; return old; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  /** @returns {string} */
  get textContent() { return this.nodeType === 3 ? /** @type {any} */ (this).data : this.childNodes.map((c) => c.textContent).join(""); }
  set textContent(v) { if (this.nodeType === 3) /** @type {any} */ (this).data = v; else { this.childNodes = []; if (v) this.appendChild(new Text_(String(v))); } }
  /** @param {N} n @returns {boolean} */
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
}
class Text_ extends Node_ {
  /** @param {string} d */
  constructor(d) { super(3); this.data = d; }
}
class Frag_ extends Node_ { constructor() { super(11); } }
class El_ extends Node_ {
  /** @param {string} tag */
  constructor(tag) {
    super(1);
    this.tagName = tag.toUpperCase();
    /** @type {Map<string, string>} */ this.attrs = new Map();
    /** @type {Map<string, Function[]>} */ this.listeners = new Map();
    this.scrollTop = 0; this.scrollHeight = 0; this.clientHeight = 0;
    const self = this;
    this.classList = {
      /** @param {string[]} c */ add: (...c) => { const s = new Set(self.classes()); for (const x of c) s.add(x); self.setAttribute("class", [...s].join(" ")); },
      /** @param {string} c */ remove: (c) => self.setAttribute("class", self.classes().filter((x) => x !== c).join(" ")),
      /** @param {string} c */ contains: (c) => self.classes().includes(c),
    };
  }
  classes() { return (this.attrs.get("class") ?? "").split(/\s+/).filter(Boolean); }
  /** @param {string} k @param {string} v */ setAttribute(k, v) { this.attrs.set(k, String(v)); }
  /** @param {string} k */ getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  /** @param {string} k */ hasAttribute(k) { return this.attrs.has(k); }
  /** @param {string} k */ removeAttribute(k) { this.attrs.delete(k); }
  /** @param {string} t @param {Function} f */ addEventListener(t, f) { this.listeners.set(t, [...(this.listeners.get(t) ?? []), f]); }
  /** @param {string} sel */
  matches(sel) {
    if (sel.startsWith(".")) return this.classes().includes(sel.slice(1));
    const attr = sel.match(/^\[([a-z-]+)\]$/);
    if (attr) return this.attrs.has(attr[1]);
    return this.tagName === sel.toUpperCase();
  }
  /** @param {string} sel @returns {N} */
  closest(sel) { for (let x = /** @type {N} */ (this); x && x.nodeType === 1; x = x.parentNode) if (x.matches(sel)) return x; return null; }
  /** @param {string} sel @returns {N[]} */
  querySelectorAll(sel) {
    /** @type {N[]} */
    const out = [];
    const walk = (/** @type {N} */ n) => { for (const c of n.childNodes) if (c.nodeType === 1) { if (c.matches(sel)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  /** @param {string} sel */ querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
}
/** @type {any} */
const doc = {
  /** @param {string} t */ createElement: (t) => new El_(t),
  /** @param {string} d */ createTextNode: (d) => new Text_(d),
  createDocumentFragment: () => new Frag_(),
};

// ---- the network: each GET waits until the test answers it; each stream is fed by the test ----

/** @type {Array<{ path: string, answer: (body: unknown) => void }>} */
let asked = [];
const heldFetch = (/** @type {string} */ url) => new Promise((resolve) => {
  asked.push({ path: url, answer: (body) => resolve(/** @type {any} */ ({ status: 200, json: async () => ({ ok: true, data: body }) })) });
});
/** @param {string} path */
const request = (path) => asked.find((a) => a.path === path);

/** @type {FakeStream[]} */
let streams = [];
class FakeStream {
  /** @param {string} url */
  constructor(url) { this.url = url; this.readyState = 1; /** @type {Map<string, Function[]>} */ this.on = new Map(); streams.push(this); /** @type {any} */ this.onopen = null; /** @type {any} */ this.onerror = null; }
  /** @param {string} name @param {Function} fn */ addEventListener(name, fn) { this.on.set(name, [...(this.on.get(name) ?? []), fn]); }
  /** @param {string} name @param {unknown} data */ emit(name, data) { for (const fn of this.on.get(name) ?? []) fn({ data: JSON.stringify(data) }); }
  close() { this.readyState = 2; }
}
/**
 * The stand-ins go in for one test and come out after it: the test files share one process, and a
 * fetch that never answers would hang every file that runs after this one.
 * @param {import("node:test").TestContext} t
 */
function network(t) {
  const g = /** @type {any} */ (globalThis);
  const saved = { fetch: g.fetch, EventSource: g.EventSource, document: g.document };
  g.fetch = heldFetch; g.EventSource = FakeStream; g.document = doc;
  asked = []; streams = [];
  t.after(() => { g.fetch = saved.fetch; g.EventSource = saved.EventSource; g.document = saved.document; });
}

const { mountChat } = await import("../client/index.js");

const tick = () => new Promise((r) => setTimeout(r, 5));
const ROOT = "r".repeat(64);
/** @param {string} id @param {string} text @param {string} cursor */
const msg = (id, text, cursor) => ({ id, cursor, ts: new Date(2026, 9, 9, 11, 2).toISOString(), text, author: { name: "pat", kind: "human" }, ...(id === ROOT ? {} : { thread: ROOT }) });
const STATE = { room: "network", me: { id: "p-1", name: "pat" }, resident: null, capabilities: [], version: 1, link: { state: "live" } };

/** @param {N} el */
const rows = (el) => el.querySelectorAll(".chat-msg-text").map((/** @type {N} */ t) => t.textContent);

test("a linked thread is asked for at mount and drawn while the thread list has not answered", async (t) => {
  network(t);
  const el = doc.createElement("div");
  const chat = mountChat(el, { base: "/chat", thread: ROOT });
  t.after(() => chat.unmount());
  await tick();
  assert.ok(request(`/chat/thread/${ROOT}`), `the thread was not asked for at mount: ${asked.map((a) => a.path).join(", ")}`);
  assert.ok(request("/chat/state"), "the state was not asked for at mount");
  request(`/chat/thread/${ROOT}`)?.answer({ messages: [msg(ROOT, "the bench camera on ether5", "e:1"), msg("m2", "planned", "e:2")], annotations: [], through: "e:2" });
  await tick();
  assert.deepEqual(rows(el), [], "drawn before the person was known");
  request("/chat/state")?.answer(STATE);
  await tick();
  // the list is asked for, and never answers in this test
  assert.ok(request("/chat/threads?scope=all"), "the list was never asked for");
  assert.deepEqual(rows(el), ["the bench camera on ether5", "planned"]);
  assert.equal(el.querySelector(".chat-shell").getAttribute("data-view"), "thread");
  assert.equal(asked.filter((a) => a.path === `/chat/thread/${ROOT}`).length, 1, "the thread was read twice");
});

test("the linked thread's stream opens after its read, and a record the read holds is drawn once", async (t) => {
  network(t);
  const el = doc.createElement("div");
  const chat = mountChat(el, { base: "/chat", thread: ROOT });
  t.after(() => chat.unmount());
  await tick();
  assert.equal(streams.filter((s) => s.url.includes(`thread=${ROOT}`)).length, 0, "the thread stream opened before its read");
  request("/chat/state")?.answer(STATE);
  request(`/chat/thread/${ROOT}`)?.answer({ messages: [msg(ROOT, "root", "e:1"), msg("m2", "reply", "e:2")], annotations: [], through: "e:2" });
  await tick();
  const stream = streams.find((s) => s.url === `/chat/stream?thread=${ROOT}`);
  assert.ok(stream, "the thread stream never opened");
  // the stream's history repeats what the read held, then carries one new record
  stream.emit("message", msg(ROOT, "root", "e:1"));
  stream.emit("message", msg("m2", "reply", "e:2"));
  stream.emit("message", msg("m3", "later", "e:3"));
  await tick();
  assert.deepEqual(rows(el), ["root", "reply", "later"]);
});

test("a thread the person opens before the link resolves is not taken back by the link", async (t) => {
  network(t);
  const el = doc.createElement("div");
  const chat = mountChat(el, { base: "/chat", thread: ROOT });
  t.after(() => chat.unmount());
  await tick();
  const other = "o".repeat(64);
  void chat.open(other);
  await tick();
  request(`/chat/thread/${other}`)?.answer({ messages: [{ ...msg(other, "the other one", "e:5"), thread: undefined }], annotations: [], through: "e:5" });
  request(`/chat/thread/${ROOT}`)?.answer({ messages: [msg(ROOT, "linked", "e:1")], annotations: [], through: "e:1" });
  request("/chat/state")?.answer(STATE);
  await tick();
  assert.deepEqual(rows(el), ["the other one"]);
});

test("a thread whose root was purged is headed \"purged thread\", at its read and when a live purge takes the root", async (t) => {
  network(t);
  const el = doc.createElement("div");
  const chat = mountChat(el, { base: "/chat", thread: ROOT });
  t.after(() => chat.unmount());
  await tick();
  request("/chat/state")?.answer(STATE);
  request(`/chat/thread/${ROOT}`)?.answer({ messages: [{ ...msg(ROOT, "", "e:1"), purged: { at: new Date(2026, 9, 9, 12, 0).toISOString(), purge: "p".repeat(64) } }, msg("m2", "a reply that stayed", "e:2")], annotations: [], through: "e:2" });
  await tick();
  assert.equal(el.querySelector(".chat-thread-title").textContent, "purged thread");

  const other = "o".repeat(64);
  void chat.open(other);
  await tick();
  request(`/chat/thread/${other}`)?.answer({ messages: [{ ...msg(other, "The pump schedule", "e:5"), thread: undefined }], annotations: [], through: "e:5" });
  await tick();
  assert.equal(el.querySelector(".chat-thread-title").textContent, "The pump schedule");
  const stream = streams.find((s) => s.url === `/chat/stream?thread=${other}`);
  assert.ok(stream, "the thread stream never opened");
  stream.emit("purge", { id: "q".repeat(64), cursor: "e:6", ts: new Date().toISOString(), purged: [other], reason: "asked", by: { name: "pat" } });
  await tick();
  assert.equal(el.querySelector(".chat-thread-title").textContent, "purged thread");
});
