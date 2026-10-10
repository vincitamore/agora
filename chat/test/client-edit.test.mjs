// @ts-check
// The composer mounted on a real ledger (renderThread) in a small document: an edit never loses
// what the person typed, and a withdrawn message keeps its place and nothing else (no reactions
// line, no "more" control, no actions sheet). The room behind it is a fetch stand-in whose thread
// read can be held open, which is the window the race lived in.
import test from "node:test";
import assert from "node:assert/strict";

// ---- a small document: the surface the composer and the ledger use ----
/** @typedef {any} N */
/** @type {Array<{ target: N, fn: Function }>} */
const observers = [];
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
  changed() { for (const o of observers) if (o.target === this) queueMicrotask(() => o.fn([])); }
  /** @param {N} c */
  appendChild(c) {
    if (c.nodeType === 11) { for (const k of [...c.childNodes]) this.appendChild(k); return c; }
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this; this.childNodes.push(c); this.changed(); return c;
  }
  /** @param {N} n @param {N} ref */
  insertBefore(n, ref) {
    if (n.parentNode) n.parentNode.removeChild(n);
    const i = this.childNodes.indexOf(ref);
    if (i < 0) this.childNodes.push(n); else this.childNodes.splice(i, 0, n);
    n.parentNode = this; this.changed(); return n;
  }
  /** @param {N} c */
  removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; this.changed(); return c; }
  /** @param {N} n @param {N} old */
  replaceChild(n, old) { const i = this.childNodes.indexOf(old); if (n.parentNode) n.parentNode.removeChild(n); this.childNodes[i] = n; n.parentNode = this; old.parentNode = null; this.changed(); return old; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  /** @returns {string} */
  get textContent() { return this.nodeType === 3 ? /** @type {any} */ (this).data : this.childNodes.map((c) => c.textContent).join(""); }
  set textContent(v) { if (this.nodeType === 3) /** @type {any} */ (this).data = v; else { this.childNodes = []; if (v) this.appendChild(new Text_(String(v))); } }
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
    /** @type {Map<string, string>} */
    this.attrs = new Map();
    /** @type {Map<string, Function[]>} */
    this.listeners = new Map();
    this.value = "";
    this.readOnly = false;
    this.checked = false;
    this.placeholder = "";
    this.style = {};
    this.scrollHeight = 20;
    this.clientWidth = 1000;
    this.selectionStart = 0;
    /** @type {any[] | null} */
    this.files = null;
    const self = this;
    this.classList = {
      /** @param {string[]} c */ add: (...c) => { const s = new Set(self.classes()); for (const x of c) s.add(x); self.setAttribute("class", [...s].join(" ")); },
      /** @param {string} c */ remove: (c) => self.setAttribute("class", self.classes().filter((x) => x !== c).join(" ")),
      /** @param {string} c */ contains: (c) => self.classes().includes(c),
      /** @param {string} c */ toggle: (c) => { if (self.classes().includes(c)) { self.classList.remove(c); return false; } self.classList.add(c); return true; },
    };
  }
  classes() { return (this.attrs.get("class") ?? "").split(/\s+/).filter(Boolean); }
  get hidden() { return this.attrs.has("hidden"); }
  set hidden(v) { if (v) this.attrs.set("hidden", ""); else this.attrs.delete("hidden"); }
  /** @param {string} k @param {string} v */ setAttribute(k, v) { this.attrs.set(k, String(v)); }
  /** @param {string} k */ getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  /** @param {string} k */ hasAttribute(k) { return this.attrs.has(k); }
  /** @param {string} k */ removeAttribute(k) { this.attrs.delete(k); }
  /** @param {string} k @param {boolean} [on] */ toggleAttribute(k, on) { const v = on ?? !this.attrs.has(k); if (v) this.attrs.set(k, ""); else this.attrs.delete(k); return v; }
  /** @param {string} t @param {Function} f */ addEventListener(t, f) { this.listeners.set(t, [...(this.listeners.get(t) ?? []), f]); }
  /** @param {string} t @param {Function} f */ removeEventListener(t, f) { this.listeners.set(t, (this.listeners.get(t) ?? []).filter((x) => x !== f)); }
  /** @param {string} t @param {Record<string, any>} [extra] */
  fire(t, extra = {}) {
    const ev = { type: t, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...extra };
    for (const f of this.listeners.get(t) ?? []) f(ev);
    return ev;
  }
  click() { if (!this.attrs.has("disabled")) this.fire("click"); }
  focus() {}
  /** @param {number} a @param {number} b */ setSelectionRange(a, b) { this.selectionStart = b; }
  /** @param {string} sel */
  matches(sel) {
    if (sel.startsWith(".")) return this.classes().includes(sel.slice(1));
    const attr = sel.match(/^\[([a-z-]+)(?:="([^"]*)")?\]$/);
    if (attr) return attr[2] === undefined ? this.attrs.has(attr[1]) : this.attrs.get(attr[1]) === attr[2];
    return this.tagName === sel.toUpperCase();
  }
  /** @param {string} sel @returns {N} */
  closest(sel) { for (let x = /** @type {N} */ (this); x && x.nodeType === 1; x = x.parentNode) if (x.matches(sel)) return x; return null; }
  /** @param {string} sel @returns {N[]} */
  querySelectorAll(sel) {
    /** @type {N[]} */
    const out = [];
    const walk = (/** @type {N} */ n) => { for (const c of n.childNodes) { if (c.nodeType === 1) { if (c.matches(sel)) out.push(c); walk(c); } } };
    walk(this);
    return out;
  }
  /** @param {string} sel */ querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
}
const g = /** @type {any} */ (globalThis);
g.document = {
  /** @param {string} t */ createElement: (t) => new El_(t),
  /** @param {string} d */ createTextNode: (d) => new Text_(d),
  createDocumentFragment: () => new Frag_(),
};
g.getComputedStyle = () => ({ lineHeight: "20px" });
g.MutationObserver = class {
  /** @param {Function} fn */
  constructor(fn) { this.fn = fn; }
  /** @param {N} target */
  observe(target) { observers.push({ target, fn: this.fn }); }
  disconnect() { for (let i = observers.length - 1; i >= 0; i--) if (observers[i].fn === this.fn) observers.splice(i, 1); }
};
const doc = g.document;

const { mountComposer } = await import("../client/composer.js");
const { renderThread } = await import("../client/thread.js");

// ---- the room: a fetch stand-in; a thread read can be held until the test lets it go ----

const ME = { id: "p-mei", name: "mei" };
const NOW = new Date(2026, 9, 9, 14, 16);
let bases = 0;

/**
 * @param {any[]} served the messages the thread route answers with
 */
function room(served) {
  /** @type {Array<{ path: string, body: any }>} */
  const requests = [];
  /** @type {Array<() => void>} */
  const held = [];
  const r = {
    requests,
    holdThread: false,
    /** let every held thread read answer */
    release() { while (held.length) /** @type {() => void} */ (held.shift())(); },
    /** @param {string} url @param {any} [init] */
    async fetch(url, init) {
      const path = url.replace(/^\/[^/]+/, "");
      const body = init?.body ? JSON.parse(init.body) : null;
      requests.push({ path, body });
      /** @param {any} data */
      const ok = (data) => /** @type {any} */ ({ status: 200, json: async () => ({ ok: true, data }) });
      if (path === "/state") return ok({ me: ME, resident: { name: "the resident" } });
      if (path.startsWith("/thread/")) {
        if (r.holdThread) await new Promise((res) => held.push(() => res(undefined)));
        return ok({ messages: served });
      }
      if (path === "/scan") return ok({});
      if (path === "/annotate") return ok({ receipt: { id: "a-1" } });
      if (path === "/react") return ok({ names: [], reactions: [] });
      return /** @type {any} */ ({ status: 404, json: async () => ({ ok: false }) });
    },
  };
  return r;
}

/** @param {Partial<any> & { id: string, text: string }} m @returns {any} */
const msg = (m) => ({ ts: new Date(2026, 9, 9, 14, 0).toISOString(), author: { id: "seat", name: "mei", kind: "human", ref: "p-mei" }, thread: "root", ...m });

/**
 * A thread pane: the ledger the host renders, and the composer's slot under it.
 * @param {any[]} shown what the ledger shows @param {ReturnType<typeof room>} rm @param {{ held?: boolean }} [opts]
 */
function pane(shown, rm, opts = {}) {
  const p = doc.createElement("section");
  p.classList.add("chat-thread-pane");
  const ledger = doc.createElement("div");
  const slot = doc.createElement("div");
  p.appendChild(ledger);
  p.appendChild(slot);
  const ctx = /** @type {any} */ ({ person: ME, thread: "root", theme: "light", now: () => NOW, post: async () => ({}) });
  const view = renderThread(ledger, shown, ctx, { me: ME });
  const handle = mountComposer(slot, ctx, {
    base: `/k${++bases}`, storage: null, fetch: /** @type {any} */ (rm.fetch),
    ...(opts.held === false ? {} : { messageOf: (/** @type {string} */ id) => view.messages().find((m) => m.id === id) ?? null }),
  });
  const q = (/** @type {string} */ sel) => slot.querySelector(sel);
  return { p, ledger, slot, view, handle, q, input: q(".chat-cmp-input"), wrap: q(".chat-cmp-wrap"), send: q(".chat-cmp-send") };
}

/** Type as a person does: a read-only box takes nothing. @param {N} input @param {string} text */
const type = (input, text) => { if (input.readOnly) return false; input.value = text; input.fire("input"); return true; };
const tick = () => new Promise((r) => setTimeout(r, 5));
/** The edit the room was asked to save. @param {ReturnType<typeof room>} rm */
const saved = (rm) => rm.requests.filter((x) => x.path === "/annotate" && x.body?.act === "edit").map((x) => x.body);

const ROOT = msg({ id: "root", text: "The north vent sticks.", thread: undefined });

test("an edit of a message posted after the composer mounted fills the box at once; what is typed is what is saved", async () => {
  const served = [ROOT];
  const rm = room(served);
  const s = pane([ROOT], rm);
  await tick();
  // posted after the composer mounted: the room and the ledger have it, the composer's own copy does not
  const late = msg({ id: "late", text: "the new vent motor, for the record\n\ncontext: zone=north" });
  served.push(late);
  s.view.add(late);
  rm.holdThread = true;
  const editing = s.handle.edit("late");
  // the same turn: no fetch stood between the click and the box
  assert.equal(s.wrap.getAttribute("data-editing"), "true");
  assert.equal(s.input.readOnly, false);
  assert.equal(s.input.value, "the new vent motor, for the record", "the box holds the words the ledger shows, without the trailers");
  // typed at machine speed, inside what used to be the load window
  assert.ok(type(s.input, "the new vent motor, installed, for the record"));
  rm.release();
  await editing;
  await tick();
  assert.equal(s.input.value, "the new vent motor, installed, for the record", "nothing came back to overwrite it");
  s.send.click();
  await tick(); await tick();
  assert.deepEqual(saved(rm).map((b) => b.text), ["the new vent motor, installed, for the record\n\ncontext: zone=north"], "the typed words are saved, the trailer block kept under them");
  assert.equal(s.wrap.getAttribute("data-editing"), null, "the edit closed once saved");
});

test("an edit that has to ask the room keeps the box read-only until the words are in it", async () => {
  const late = msg({ id: "late", text: "the spare pump sits on shelf 3" });
  const served = [ROOT];
  const rm = room(served);
  const s = pane([ROOT], rm, { held: false });
  await tick();
  // posted after the composer mounted, and this host lends the composer no ledger copy
  served.push(late);
  rm.holdThread = true;
  const editing = s.handle.edit("late");
  assert.equal(s.wrap.getAttribute("data-editing"), "loading");
  assert.equal(s.input.readOnly, true, "the box takes no typing while it waits");
  assert.equal(type(s.input, "typed into the wait"), false);
  assert.ok(s.send.hasAttribute("disabled"), "nothing can be saved while it waits");
  rm.release();
  await editing;
  assert.equal(s.wrap.getAttribute("data-editing"), "true");
  assert.equal(s.input.readOnly, false);
  assert.equal(s.input.value, "the spare pump sits on shelf 3");
  assert.ok(type(s.input, "the spare pump sits on shelf 4"));
  s.send.click();
  await tick(); await tick();
  assert.deepEqual(saved(rm).map((b) => b.text), ["the spare pump sits on shelf 4"]);
});

test("words that reach the box while it waits are kept, and the composer says what the room's words are", async () => {
  const late = msg({ id: "late", text: "the spare pump sits on shelf 3" });
  const served = [ROOT];
  const rm = room(served);
  const s = pane([ROOT], rm, { held: false });
  await tick();
  // posted after the composer mounted, and this host lends the composer no ledger copy
  served.push(late);
  rm.holdThread = true;
  const editing = s.handle.edit("late");
  // not a key press (the box is read-only): a paste, an input method, a host's setText
  s.input.value = "shelf 4, beside the hose reels";
  rm.release();
  await editing;
  assert.equal(s.input.value, "shelf 4, beside the hose reels", "the room's words did not replace it");
  const notice = s.q(".chat-cmp-notice");
  assert.equal(notice.hidden, false);
  assert.match(notice.textContent, /your words are kept/);
  assert.match(notice.textContent, /the spare pump sits on shelf 3/, "the room's words are named");
  s.send.click();
  await tick(); await tick();
  assert.deepEqual(saved(rm).map((b) => b.text), ["shelf 4, beside the hose reels"]);
});

test("an edit made elsewhere while the box is open is named, never written over the box", async () => {
  const mine = msg({ id: "m1", text: "first words" });
  const rm = room([ROOT, mine]);
  const s = pane([ROOT, mine], rm);
  await tick();
  await s.handle.edit("m1");
  assert.ok(type(s.input, "my second words"));
  const a = { act: "edit", target: "m1", text: "words from the other tab", ts: NOW.toISOString() };
  s.view.annotate(/** @type {any} */ (a));
  s.handle.annotation(a);
  assert.equal(s.input.value, "my second words");
  assert.match(s.q(".chat-cmp-notice").textContent, /words from the other tab/);
});

test("a withdrawn message shows no reactions line and offers no reaction, edit or withdrawal", async () => {
  const mine = msg({ id: "m1", text: "the new vent motor", reactions: [{ name: "seen", people: ["p-ravi"] }] });
  const rm = room([ROOT, mine]);
  const s = pane([ROOT, mine], rm);
  await tick(); await tick();
  const row = () => s.ledger.querySelector('[data-id="m1"]');
  assert.equal(row().querySelector(".chat-reacts")?.textContent, "seen · p-ravi", "before: the reactions line is drawn");
  assert.ok(row().querySelector(".chat-msg-more"), "before: the more control is there");

  // the withdrawal arrives as the stream's annotation: the ledger redraws the row
  const w = { act: "withdraw", target: "m1", ts: NOW.toISOString() };
  s.view.annotate(/** @type {any} */ (w));
  s.handle.annotation(w);
  await tick();
  assert.ok(row().classList.contains("is-withdrawn"));
  assert.equal(row().querySelector(".chat-reacts"), null, "no reactions line on a withdrawn message");
  assert.equal(row().querySelector(".chat-msg-more"), null, "no more control on a withdrawn message");

  // a reaction event for it, from a page that has not caught up, draws nothing either
  s.handle.reaction({ target: "m1", reactions: [{ name: "seen", people: ["p-ravi", "p-dana"] }] });
  assert.equal(row().querySelector(".chat-reacts"), null);
  // and asking for its actions opens no sheet
  await s.handle.actions("m1");
  const sheet = s.slot.querySelector(".chat-cmp-actions");
  assert.equal(sheet.hidden, true, "the actions sheet stays shut");
  assert.equal(sheet.querySelector(".chat-cmp-react"), null, "no react control");
});

test("a withdrawal while the actions sheet is open closes it", async () => {
  const mine = msg({ id: "m1", text: "a line" });
  const rm = room([ROOT, mine]);
  const s = pane([ROOT, mine], rm);
  await tick(); await tick();
  await s.handle.actions("m1");
  const sheet = s.slot.querySelector(".chat-cmp-actions");
  assert.equal(sheet.hidden, false);
  assert.ok(sheet.querySelector(".chat-cmp-react"));
  const w = { act: "withdraw", target: "m1", ts: NOW.toISOString() };
  s.view.annotate(/** @type {any} */ (w));
  await tick();
  assert.equal(sheet.hidden, true);
});
