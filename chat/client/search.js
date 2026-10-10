// @ts-check
/**
 * The search sheet over messages and files: one box, two scopes, the hits in the ledger's
 * columns (when, who, the words), and how far the record was searched.
 *
 * `GET <base>/search?q=&scope=messages|files&context=` answers `{ hits: [{ message, snippet }],
 * coverage: { through } }`. A snippet is shown as text: the words the person typed are marked by
 * the client, never by markup in the answer. Opening a hit hands its thread's root (and the
 * message id) to the host's `onOpen`, which usually calls the mounted chat's `open`.
 *
 * Nothing here counts: the status line says how far the record was searched, not how many hits.
 */

import { h } from "./markdown.js";
import { bodyOf, clock, shortWhen } from "./thread.js";
import { adoptStyles } from "./composer.js";

/**
 * @typedef {{
 *   base?: string,
 *   onOpen?: (root: string, messageId: string) => void,
 *   onClose?: () => void,
 *   context?: () => string | null,
 *   now?: () => Date,
 *   query?: string,
 *   scope?: "messages" | "files",
 *   fetch?: typeof fetch,
 * }} SearchOptions
 */

/**
 * The words of a query, for marking: each term once, longest first.
 * @param {string} q
 */
export function queryTerms(q) {
  const terms = String(q ?? "").toLowerCase().split(/\s+/).map((t) => t.replace(/^["'(]+|["'),.;:!?]+$/g, "")).filter((t) => t.length >= 2);
  return [...new Set(terms)].sort((a, b) => b.length - a.length);
}

/**
 * Split text into plain and marked runs where a query term occurs (case-insensitive).
 * @param {string} text @param {string[]} terms
 * @returns {Array<{ text: string, mark: boolean }>}
 */
export function markRuns(text, terms) {
  const s = String(text ?? "");
  if (!terms.length || !s) return [{ text: s, mark: false }];
  const lower = s.toLowerCase();
  /** @type {Array<{ text: string, mark: boolean }>} */
  const out = [];
  let i = 0;
  let plain = "";
  while (i < s.length) {
    const t = terms.find((term) => lower.startsWith(term, i));
    if (t) {
      if (plain) { out.push({ text: plain, mark: false }); plain = ""; }
      out.push({ text: s.slice(i, i + t.length), mark: true });
      i += t.length;
    } else { plain += s[i]; i++; }
  }
  if (plain) out.push({ text: plain, mark: false });
  return out;
}

/** The thread a hit opens: a reply's root, or the message itself when it is a root. @param {any} m */
export function rootOf(m) {
  return typeof m?.thread === "string" && m.thread ? m.thread : String(m?.id ?? "");
}

/**
 * Mount the search sheet into an element.
 * @param {HTMLElement} el @param {SearchOptions} options
 * @returns {{ unmount(): void, focus(): void, search(q: string, scope?: "messages" | "files"): Promise<void> }}
 */
export function mountSearch(el, options = {}) {
  adoptStyles();
  const base = String(options.base ?? "/chat").replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  /** @type {"messages" | "files"} */
  let scope = options.scope ?? "messages";
  let seq = 0;
  /** @type {any} */
  let timer = null;

  const input = /** @type {HTMLInputElement} */ (h("input", { type: "search", class: "chat-search-input", name: "q", autocomplete: "off", enterkeyhint: "search", "aria-label": "Search the room", placeholder: "words, a name, a file" }));
  const go = h("button", { type: "submit", class: "chat-search-go" }, ["search"]);
  const form = h("form", { class: "chat-search-form", role: "search" }, [input, go]);
  const scopes = h("div", { class: "chat-search-scopes", role: "group", "aria-label": "Search in" });
  const status = h("p", { class: "chat-search-status", role: "status", "aria-live": "polite" });
  const hits = h("ul", { class: "chat-search-hits", "aria-label": "Found" });
  const close = h("button", { type: "button", class: "chat-search-close" }, ["close"]);
  const head = h("div", { class: "chat-search-head" }, [h("span", { class: "chat-cap" }, ["Search · messages and files"]), options.onClose ? close : null]);
  const root = h("section", { class: "chat-search", "aria-label": "Search" }, [head, form, scopes, status, hits]);
  while (el.firstChild) el.removeChild(el.firstChild);
  el.appendChild(root);
  if (options.onClose) close.addEventListener("click", () => options.onClose?.());

  const drawScopes = () => {
    while (scopes.firstChild) scopes.removeChild(scopes.firstChild);
    for (const [key, label] of /** @type {const} */ ([["messages", "messages"], ["files", "files"]])) {
      const b = h("button", { type: "button", class: "chat-search-scope", "aria-pressed": scope === key ? "true" : "false" }, [label]);
      b.addEventListener("click", () => { if (scope !== key) { scope = key; drawScopes(); void run(input.value); } });
      scopes.appendChild(b);
    }
  };

  /** @param {string} words @param {"note" | "error"} [kind] */
  const say = (words, kind = "note") => { status.textContent = words; status.setAttribute("data-kind", kind); };

  /** @param {any} hit @param {string[]} terms */
  const hitRow = (hit, terms) => {
    const m = hit?.message ?? {};
    const when = h("span", { class: "chat-search-when" }, [m.ts ? `${shortWhen(m.ts, now())}${shortWhen(m.ts, now()) === clock(m.ts) ? "" : ` ${clock(m.ts)}`}` : ""]);
    const who = h("span", { class: "chat-search-who" }, [m.author?.name ?? ""]);
    const snippetText = typeof hit?.snippet === "string" && hit.snippet ? hit.snippet : bodyOf(m).split("\n").find((/** @type {string} */ l) => l.trim()) ?? "";
    /** @type {Array<Node | null>} */
    const parts = [when, who];
    if (scope === "files") {
      for (const a of m.attachments ?? []) {
        parts.push(h("span", { class: "chat-search-file" }, [a.name ?? "file", h("span", {}, [a.size >= 0 ? ` · ${a.size < 1024 * 1024 ? `${Math.max(1, Math.round(a.size / 1024))} KB` : `${(a.size / 1048576).toFixed(1)} MB`}` : ""])]));
      }
    }
    const snippet = h("span", { class: "chat-search-snippet" });
    for (const run of markRuns(snippetText, terms)) snippet.appendChild(run.mark ? h("mark", {}, [run.text]) : document.createTextNode(run.text));
    parts.push(snippet);
    const b = h("button", { type: "button" }, parts);
    b.addEventListener("click", () => { if (options.onOpen) options.onOpen(rootOf(m), String(m.id ?? "")); });
    return h("li", { class: "chat-search-hit", "data-id": m.id ?? null }, [b]);
  };

  /** @param {string} q */
  const run = async (q) => {
    const words = q.trim();
    const mine = ++seq;
    while (hits.firstChild) hits.removeChild(hits.firstChild);
    if (!words) { say(""); return; }
    say("searching");
    const params = new URLSearchParams({ q: words, scope });
    const c = options.context?.();
    if (c) params.set("context", c);
    /** @type {any} */
    let body = null;
    let status_ = 0;
    try {
      const r = await doFetch(`${base}/search?${params}`, { credentials: "same-origin", headers: { accept: "application/json" } });
      status_ = r.status;
      body = await r.json().catch(() => null);
    } catch {
      if (mine === seq) say("not searched · the room is not reachable from here", "error");
      return;
    }
    if (mine !== seq) return;
    if (!body?.ok) { say(`not searched · ${body?.error?.message ?? body?.error?.code ?? status_}`, "error"); return; }
    const list = Array.isArray(body.data?.hits) ? body.data.hits : [];
    const terms = queryTerms(words);
    for (const hit of list) hits.appendChild(hitRow(hit, terms));
    const through = body.data?.coverage?.through;
    const reach = through ? `the record searched through ${through}` : "the record searched";
    say(list.length ? reach : `nothing found · ${reach}`);
  };

  form.addEventListener("submit", (ev) => { ev.preventDefault(); if (timer) clearTimeout(timer); void run(input.value); });
  input.addEventListener("input", () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void run(input.value); }, 300);
  });
  input.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && options.onClose) { ev.preventDefault(); options.onClose(); } });

  drawScopes();
  if (options.query) { input.value = options.query; void run(options.query); }

  return {
    unmount() { if (timer) clearTimeout(timer); seq++; root.remove(); },
    focus: () => input.focus(),
    search: async (q, s) => { if (s) { scope = s; drawScopes(); } input.value = q; await run(q); },
  };
}
