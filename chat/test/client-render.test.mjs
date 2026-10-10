// The client half's reading: the markdown subset and its refusals, the ledger, the list, cards
// and blocks. The modules build DOM with createElement and text nodes only, so a small document
// stands in for the browser's here; what it renders is checked by walking the tree it built.
import test from "node:test";
import assert from "node:assert/strict";

// ---- a small document: just the surface the client modules use ----
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
    /** @type {Map<string, string>} */
    this.attrs = new Map();
    /** @type {Map<string, Function[]>} */
    this.listeners = new Map();
    const self = this;
    this.classList = {
      /** @param {string[]} c */ add: (...c) => { const s = new Set(self.classes()); for (const x of c) s.add(x); self.setAttribute("class", [...s].join(" ")); },
      /** @param {string} c */ remove: (c) => self.setAttribute("class", self.classes().filter((x) => x !== c).join(" ")),
      /** @param {string} c */ contains: (c) => self.classes().includes(c),
      /** @param {string} c */ toggle: (c) => { if (self.classes().includes(c)) { self.classList.remove(c); return false; } self.classList.add(c); return true; },
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
    const walk = (/** @type {N} */ n) => { for (const c of n.childNodes) { if (c.nodeType === 1) { if (c.matches(sel)) out.push(c); walk(c); } } }; walk(this); return out; }
  /** @param {string} sel */ querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  click() {
    const ev = { target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    for (let x = /** @type {N} */ (this); x; x = x.parentNode) for (const f of x.listeners?.get("click") ?? []) f(ev);
  }
}
/** @type {any} */ (globalThis).document = {
  /** @param {string} t */ createElement: (t) => new El_(t),
  /** @param {string} d */ createTextNode: (d) => new Text_(d),
  createDocumentFragment: () => new Frag_(),
};
const doc = /** @type {any} */ (globalThis).document;

const { parseMarkdown, parseInline, renderMarkdown, safeHref } = await import("../client/markdown.js");
const { registerBlock } = await import("../client/blocks.js");
const { registerCard } = await import("../client/cards.js");
const { renderThread, splitMessage, COLLAPSE_AT, dayLabel } = await import("../client/thread.js");
const { renderThreadList } = await import("../client/list.js");

const NOW = new Date(2026, 9, 9, 14, 16);
/** @type {any} */
const ctx = { person: { id: "p-1", name: "one" }, thread: null, theme: "light", now: () => NOW, post: async () => ({}) };
/** @param {N} root @param {string} tag */
const all = (root, tag) => root.querySelectorAll(tag);
/** @param {string} text */
const render = (text) => { const box = doc.createElement("div"); box.appendChild(renderMarkdown(text, ctx)); return box; };
const tick = () => new Promise((r) => setTimeout(r, 5));

// ---- the markdown subset refuses what it must ----

test("a javascript: link is never a link, in any spelling", () => {
  for (const href of ["javascript:alert(1)", "JavaScript:alert(1)", "  javascript:alert(1)", "java\tscript:alert(1)", "javascript&#58;alert(1)",
    "data:text/html,<b>x</b>", "vbscript:x", "http://example.com/", "//example.com/x", "/\\example.com", "file:///etc/passwd"]) {
    assert.equal(safeHref(href), null, href);
    const box = render(`see [this](${href}) now`);
    assert.equal(all(box, "a").length, 0, href);
  }
  assert.equal(all(render("[x](javascript:alert(1))"), "a").length, 0);
  assert.match(render("[x](javascript:alert(1))").textContent, /javascript:alert\(1\)/, "a refused link stays visible as its text");
});

test("https links and same-origin paths are links; nothing else is", () => {
  const box = render("[docs](https://example.com/a?b=1) and [home](/inbox) and https://example.org/x.");
  const links = all(box, "a");
  assert.deepEqual(links.map((/** @type {N} */ a) => a.getAttribute("href")), ["https://example.com/a?b=1", "/inbox", "https://example.org/x"]);
  for (const a of links) assert.match(a.getAttribute("rel"), /noopener/);
});

test("raw HTML is text, never markup", () => {
  const src = '<script>alert(1)</script> <img src=x onerror="alert(2)"> <a href="javascript:x">y</a> <b>bold</b>';
  const box = render(src);
  for (const tag of ["script", "img", "a", "b", "iframe"]) assert.equal(all(box, tag).length, 0, tag);
  assert.equal(box.textContent, src);
});

test("an image is never made from text", () => {
  const box = render("look ![chart](https://example.com/c.png) here, and ![x](/thumb.png)");
  assert.equal(all(box, "img").length, 0);
  assert.equal(all(box, "a").length, 0, "the image syntax is not turned into a link either");
  assert.match(box.textContent, /!\[chart\]\(https:\/\/example\.com\/c\.png\)/);
});

test("the subset: paragraphs, lists, emphasis, code and fences", () => {
  const blocks = parseMarkdown("one *two* **three** `four`\nline\n\n- a\n- b\n  more\n\n3. c\n4. d\n\n```\n<raw> & stuff\n```");
  assert.deepEqual(blocks.map((b) => b.type), ["p", "ul", "ol", "fence"]);
  const box = render("one *two* **three** `four`\nline\n\n- a\n- b\n\n3. c\n\n```\n<raw> & stuff\n```");
  assert.equal(all(box, "em").length, 1);
  assert.equal(all(box, "strong").length, 1);
  assert.equal(all(box, "code").length, 2);
  assert.equal(all(box, "br").length, 1);
  assert.equal(all(box, "ol")[0].getAttribute("start"), "3");
  assert.equal(all(box, "pre")[0].textContent, "<raw> & stuff");
  assert.deepEqual(parseInline("snake_case_name stays"), [{ type: "text", text: "snake_case_name stays" }]);
  assert.deepEqual(parseInline("\\*not em\\*"), [{ type: "text", text: "*not em*" }]);
});

test("a registered block renders its fence; an unregistered or failing one is a code block", () => {
  registerBlock("tally-free", (source) => { const e = doc.createElement("section"); e.setAttribute("class", "mine"); e.textContent = source.toUpperCase(); return e; });
  registerBlock("broken", () => { throw new Error("nope"); });
  const box = render("```tally-free\nabc\n```\n\n```other\n<b>x</b>\n```\n\n```broken\nkeep\n```");
  assert.equal(all(box, ".mine")[0].textContent, "ABC");
  const pres = all(box, "pre");
  assert.deepEqual(pres.map((/** @type {N} */ p) => p.textContent), ["<b>x</b>", "keep"]);
  assert.equal(all(box, "b").length, 0);
});

// ---- a message's reading ----

test("splitMessage takes the signature and the trailer block off the body", () => {
  const s = splitMessage("Planned it.\n\ncard: plan P-1\nwaiting: p-1\n\n-- resident");
  assert.equal(s.body, "Planned it.");
  assert.equal(s.signedAs, "resident");
  assert.deepEqual(s.trailers, [{ key: "card", value: "plan P-1" }, { key: "waiting", value: "p-1" }]);
  assert.deepEqual(splitMessage("note: not a trailer block\nbecause this line is prose").trailers, []);
  assert.equal(splitMessage("Just text").body, "Just text");
});

test("day labels: today, then the date", () => {
  assert.equal(dayLabel(new Date(2026, 9, 9, 8, 0), NOW), "today");
  assert.equal(dayLabel(new Date(2026, 9, 8, 15, 36), NOW), "thu 08 oct");
  assert.equal(dayLabel(new Date(2025, 0, 2, 1, 0), NOW), "thu 02 jan 2025");
});

// ---- the ledger ----

/** @param {Partial<any>} o */
const msg = (o) => ({ id: o.id ?? "m1", cursor: o.cursor ?? "e:1", ts: o.ts ?? new Date(2026, 9, 9, 11, 2).toISOString(), text: o.text ?? "hi",
  author: o.author ?? { id: "acct", name: "resident", kind: "agent" }, ...o });

test("the ledger: serif for agents, sans for people, day rows, inert device text", () => {
  const el = doc.createElement("div");
  renderThread(el, [
    msg({ id: "a", ts: new Date(2026, 9, 8, 15, 36).toISOString(), author: { name: "pat", kind: "human" }, text: "port says <b>DOWN</b> & `x`" }),
    msg({ id: "b", text: "Holding." }),
  ], ctx);
  const days = all(el, ".chat-day").map((/** @type {N} */ d) => d.textContent);
  assert.deepEqual(days, ["thu 08 oct", "today"]);
  const texts = all(el, ".chat-msg-text");
  assert.ok(texts[0].classList.contains("chat-sans"));
  assert.ok(texts[1].classList.contains("chat-prose"));
  assert.equal(all(el, "b").length, 0);
  assert.match(texts[0].textContent, /<b>DOWN<\/b>/);
  assert.deepEqual(all(el, ".chat-msg-time").map((/** @type {N} */ t) => t.textContent), ["15:36", "11:02"]);
});

test("a post past 600 characters is collapsed behind show all; one at 600 is not", () => {
  const el = doc.createElement("div");
  renderThread(el, [msg({ id: "long", text: "x".repeat(COLLAPSE_AT + 1) }), msg({ id: "edge", text: "y".repeat(COLLAPSE_AT) })], ctx);
  const [long, edge] = all(el, ".chat-msg-text");
  assert.ok(long.classList.contains("is-collapsed"));
  assert.ok(!edge.classList.contains("is-collapsed"));
  const buttons = all(el, ".chat-show-all");
  assert.equal(buttons.length, 1);
  buttons[0].click();
  assert.ok(!long.classList.contains("is-collapsed"));
  assert.equal(buttons[0].textContent, "show less");
});

test("the trailer block and signature are not shown; withdrawn shows no text; add keeps a message once", () => {
  const el = doc.createElement("div");
  const view = renderThread(el, [msg({ id: "a", text: "Body here.\n\ncontext: item=7\n\n-- resident", trailers: [{ key: "context", value: "item=7" }] })], ctx);
  assert.equal(all(el, ".chat-msg-text")[0].textContent, "Body here.");
  assert.equal(view.add(msg({ id: "a" })), false);
  assert.equal(view.add(msg({ id: "b", cursor: "e:2", text: "secret words" })), true);
  view.annotate({ id: "x", ts: new Date(2026, 9, 9, 11, 5).toISOString(), act: "withdraw", target: "b" });
  assert.doesNotMatch(el.textContent, /secret words/);
  assert.match(el.textContent, /withdrawn 11:05/);
  view.annotate({ id: "y", ts: new Date(2026, 9, 9, 11, 6).toISOString(), act: "edit", target: "a", text: "New body." });
  assert.equal(all(el, ".chat-msg-text")[0].textContent, "New body.");
  assert.match(el.textContent, /edited 11:06/);
  assert.equal(all(el, ".chat-msg").length, 2);
});

test("a card renders from the host's load; waiting on the reader gives the you edge; an action runs; unregistered shows text only", async () => {
  /** @type {string[]} */
  const acted = [];
  registerCard("thing", {
    load: async (id) => ({ id, title: `Thing ${id}` }),
    render: (/** @type {any} */ d) => { const s = doc.createElement("section"); s.setAttribute("class", "chat-card"); const b = doc.createElement("button"); b.setAttribute("data-chat-action", "go"); b.textContent = d.title; s.appendChild(b); return s; },
    actions: { go: async (/** @type {any} */ d) => { acted.push(d.id); } },
  });
  const el = doc.createElement("div");
  renderThread(el, [
    msg({ id: "c1", text: "See below.\n\ncard: thing T-1\nwaiting: p-1", trailers: [{ key: "card", value: "thing T-1" }, { key: "waiting", value: "p-1" }] }),
    msg({ id: "c2", text: "Fallback text.\n\ncard: unknown-kind U-1", trailers: [{ key: "card", value: "unknown-kind U-1" }] }),
  ], ctx);
  await tick();
  const frames = all(el, ".chat-card-frame");
  assert.equal(frames.length, 1, "only the registered type is framed");
  assert.ok(frames[0].classList.contains("is-you"));
  assert.match(frames[0].textContent, /Thing T-1/);
  assert.match(el.textContent, /Fallback text\./);
  assert.match(el.textContent, /waiting on you/);
  all(frames[0], "button")[0].click();
  await tick();
  assert.deepEqual(acted, ["T-1"]);
});

test("a card whose load fails says so in its place", async () => {
  registerCard("gone", { load: async () => { throw new Error("no record"); }, render: () => doc.createElement("div") });
  const el = doc.createElement("div");
  renderThread(el, [msg({ id: "g", text: "x\n\ncard: gone G-1", trailers: [{ key: "card", value: "gone G-1" }] })], ctx);
  await tick();
  assert.match(all(el, ".chat-card-failed")[0].textContent, /gone G-1 could not be read: no record/);
});

// ---- the list ----

test("the list: activity order, unread dot, waiting marker, card chips, context chips", () => {
  const el = doc.createElement("nav");
  /** @type {string[]} */
  const opened = [];
  const root = (/** @type {string} */ id, /** @type {string} */ text) => msg({ id, text, author: { name: "pat", kind: "human" } });
  renderThreadList(el, [
    { root: root("old", "Older thread"), lastAt: new Date(2026, 9, 1, 9, 0).toISOString(), unread: true, waiting: ["p-2"], cards: [] },
    { root: root("new", "Newer thread\n\ncontext: item=alpha; screen=detail"), last: msg({ id: "l", text: "**Planned** below." }), lastAt: new Date(2026, 9, 9, 14, 14).toISOString(),
      unread: false, waiting: ["p-1"], cards: [{ type: "plan", id: "P-1" }] },
    { root: "bare-id", lastAt: new Date(2026, 9, 5, 9, 0).toISOString() },
  ], ctx, { name: (id) => (id === "p-2" ? "two" : id), onOpen: (r) => opened.push(r), active: "new" });
  const items = all(el, ".chat-ti");
  assert.deepEqual(items.map((/** @type {N} */ i) => i.getAttribute("data-root")), ["new", "bare-id", "old"]);
  assert.ok(items[0].classList.contains("is-you"));
  assert.ok(items[0].classList.contains("is-active"));
  assert.match(items[0].textContent, /waiting on you/);
  assert.match(items[0].textContent, /resident: Planned below\./);
  assert.deepEqual(all(items[0], ".chat-chip").map((/** @type {N} */ c) => c.textContent), ["P-1", "alpha", "detail"]);
  assert.equal(all(items[2], ".chat-unread").length, 1);
  assert.equal(all(items[0], ".chat-unread").length, 0);
  assert.match(items[2].textContent, /waiting on two/);
  assert.match(items[1].textContent, /bare-id/);
  items[2].click();
  assert.deepEqual(opened, ["old"]);
});
