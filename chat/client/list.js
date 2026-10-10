// @ts-check
/**
 * The thread list: activity order, the unread dot, the waiting marker, card chips, root chips
 * from `context`, and "threads I'm in".
 *
 * A thread arrives as the kit's server lists it: `{ root, lastAt, lastBy, unread, waiting, cards }`.
 * `root` is the thread's root message (its first line is the title) or, from a server that sends
 * only the id, a string; `last`, when the server sends it, is the newest message, and its first line
 * is the line under the title. Unread is a boolean and waiting a list of person ids: no counts.
 */

import { h } from "./markdown.js";
import { bodyOf, contextOf, shortWhen } from "./thread.js";

/** How many of a thread's cards the list names. */
export const CARD_CHIPS = 3;

/**
 * @typedef {{
 *   root: import("./thread.js").ChatMessage | string,
 *   last?: import("./thread.js").ChatMessage,
 *   lastAt?: string, lastBy?: string,
 *   unread?: boolean, waiting?: string[],
 *   cards?: Array<{ type: string, id: string }>,
 * }} ThreadSummary
 */
/**
 * @typedef {{
 *   me?: { id: string, name: string } | null,
 *   active?: string | null,
 *   name?: (personId: string) => string,
 *   onOpen?: (root: string) => void,
 * }} ListOptions
 */

/** The root id of a summary. @param {ThreadSummary} t */
export function rootId(t) {
  return typeof t.root === "string" ? t.root : t.root?.id ?? "";
}

/** The first line of a message's body, plain. @param {import("./thread.js").ChatMessage | undefined} m */
export function firstLine(m) {
  if (!m) return "";
  if (m.withdrawn) return "withdrawn";
  const line = bodyOf(m).split("\n").find((l) => l.trim()) ?? "";
  // the list shows a line, not markup: strip the emphasis and code marks a reader would not type
  return line.replace(/[*_`]+/g, "").replace(/^#+\s*/, "").trim();
}

/**
 * Render the list into `el`, newest activity first.
 * @param {HTMLElement} el
 * @param {ThreadSummary[]} threads
 * @param {import("./index.js").ChatContext} ctx
 * @param {ListOptions} [opts]
 */
export function renderThreadList(el, threads, ctx, opts = {}) {
  el.classList.add("chat-threads");
  while (el.firstChild) el.removeChild(el.firstChild);
  const meId = opts.me?.id ?? ctx.person?.id ?? null;
  const nameOf = opts.name ?? ((/** @type {string} */ id) => id);
  const sorted = [...threads].filter((t) => rootId(t)).sort((a, b) => String(b.lastAt ?? "").localeCompare(String(a.lastAt ?? "")));
  if (!sorted.length) {
    el.appendChild(h("p", { class: "chat-empty" }, ["no threads here yet"]));
    return;
  }
  for (const t of sorted) {
    const root = rootId(t);
    const rootMsg = typeof t.root === "string" ? undefined : t.root;
    const title = firstLine(rootMsg) || root;
    const waiting = t.waiting ?? [];
    const forMe = meId !== null && waiting.includes(meId);
    const others = waiting.filter((id) => id !== meId);
    const lastLine = t.last ? firstLine(t.last) : "";
    const lastBy = t.last?.author?.name ?? t.lastBy ?? "";

    /** @type {Array<Node | string>} */
    const state = [];
    if (forMe) state.push(h("span", { class: "chat-ti-you" }, ["waiting on you"]));
    else if (others.length) state.push(h("span", null, [`waiting on ${others.map(nameOf).join(", ")}`]));
    // the newest cards, by id; the thread itself has them all
    for (const c of (t.cards ?? []).slice(-CARD_CHIPS)) state.push(h("span", { class: "chat-chip", title: `${c.type} ${c.id}` }, [c.id]));
    for (const [k, v] of rootMsg ? contextOf(rootMsg) : []) state.push(h("span", { class: "chat-chip chat-chip--context", title: `${k}=${v}` }, [v]));

    const item = h("button", {
      type: "button",
      class: "chat-ti" + (forMe ? " is-you" : "") + (opts.active === root ? " is-active" : "") + (t.unread ? " is-unread" : ""),
      "data-root": root,
      "aria-current": opts.active === root ? "true" : null,
    }, [
      h("span", { class: "chat-ti-top" }, [
        t.unread ? h("span", { class: "chat-unread", role: "img", "aria-label": "unread" }) : null,
        h("span", { class: "chat-ti-title" }, [title]),
        t.lastAt ? h("time", { class: "chat-ti-when", datetime: t.lastAt }, [shortWhen(t.lastAt, ctx.now())]) : null,
      ]),
      lastLine ? h("span", { class: "chat-ti-last" }, [lastBy ? `${lastBy}: ${lastLine}` : lastLine]) : null,
      state.length ? h("span", { class: "chat-ti-state" }, state) : null,
    ]);
    item.addEventListener("click", () => { if (opts.onOpen) opts.onOpen(root); });
    el.appendChild(item);
  }
}
