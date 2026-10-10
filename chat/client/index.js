// @ts-check
/**
 * The chat kit's client half: `mountChat`, `registerCard`, `registerBlock`. ES modules, no build
 * step, phone-first at 360 px. The contract is CONTRACT.md.
 *
 * The modules beside this one each own one part: `list` (the thread list), `thread` (one thread as
 * a ledger), `cards` and `blocks` (the registries), `markdown` (the rendered subset and the element
 * builder), `composer`, `upload` and `search`.
 *
 * `mountChat` lays out two panes, the thread list and the open thread. In a container narrower than
 * 720 px only one pane shows at a time (the layout is a container query, so it follows the element
 * the host mounts into, not the window). It reads `GET <base>/state`, `GET <base>/threads` and
 * `GET <base>/thread/:root`, keeps two server-sent event streams (`thread=main` for the list,
 * `thread=<root>` for the open thread, whose `reaction` and `purge` events it hands to the
 * composer), mounts the composer with the host's `base`, `people` and `context`, reconnects either with backoff when it closes, and says on
 * the state line whether the room is live, reconnecting, dark or refused.
 */

import { h } from "./markdown.js";
import { renderThreadList, rootId } from "./list.js";
import { renderThread, bodyOf, contextOf, clock, dayLabel } from "./thread.js";
import { mountComposer, composerIn } from "./composer.js";

export { registerCard } from "./cards.js";
export { registerBlock } from "./blocks.js";

/**
 * What a card or block renderer is handed.
 * @typedef {{
 *   person: { id: string, name: string } | null,
 *   thread: string | null,
 *   post: (text: string, trailers?: Array<[string, string]>) => Promise<unknown>,
 *   theme: string,
 *   now: () => Date,
 * }} ChatContext
 */
/**
 * `thread` opens that thread at mount; `now` is the clock the ledger reads (a fixed one renders the
 * same page twice); both are optional and change nothing else.
 * @typedef {{
 *   base: string,
 *   context?: () => Array<[string, string]>,
 *   onOpenThread?: (root: string) => void,
 *   people?: () => Promise<Array<{ id: string, name: string }>>,
 *   thread?: string,
 *   now?: () => Date,
 * }} MountOptions
 */

/** How long a closed stream waits before it is opened again, attempt by attempt; the last repeats. */
const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];

/**
 * @param {string} base @param {string} path @param {RequestInit} [init]
 * @returns {Promise<{ status: number, body: any }>}
 */
async function call(base, path, init) {
  const r = await fetch(base + path, { credentials: "same-origin", ...init, headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}), ...(init?.headers ?? {}) } });
  /** @type {any} */
  let body = null;
  try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}

/** @param {{ status: number, body: any }} r */
function dataOf(r) {
  if (r.body && r.body.ok) return r.body.data;
  const e = r.body?.error;
  const code = typeof e === "string" ? e : e?.code ?? `HTTP ${r.status}`;
  throw new Error(code);
}

/**
 * One server-sent event stream that comes back after it closes.
 * @param {string} url
 * @param {Record<string, (data: any) => void>} on
 * @param {(state: "connecting" | "open" | "reconnecting") => void} status
 */
function openStream(url, on, status) {
  /** @type {EventSource | null} */
  let es = null;
  let attempt = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  let closed = false;
  const connect = () => {
    if (closed) return;
    status(attempt ? "reconnecting" : "connecting");
    es = new EventSource(url, { withCredentials: true });
    es.onopen = () => { attempt = 0; status("open"); };
    es.onerror = () => {
      if (closed || !es) return;
      if (es.readyState === 2) {
        es.close();
        const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
        attempt++;
        status("reconnecting");
        timer = setTimeout(connect, wait);
      } else status("reconnecting");
    };
    for (const [name, fn] of Object.entries(on)) {
      es.addEventListener(name, (ev) => {
        const raw = /** @type {MessageEvent} */ (ev).data;
        /** @type {any} */
        let data = raw;
        try { data = JSON.parse(raw); } catch { data = raw; }
        fn(data);
      });
    }
  };
  connect();
  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      if (es) es.close();
    },
  };
}

/** @param {HTMLElement} el */
function themeOf(el) {
  const marked = el.closest?.("[data-theme]");
  const t = marked?.getAttribute("data-theme");
  if (t) return t;
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * Mount the chat into an element.
 * @param {HTMLElement} el @param {MountOptions} options
 * @returns {{ unmount(): void, open(root: string): Promise<void>, back(): void, refresh(): Promise<void> }}
 */
export function mountChat(el, options) {
  const base = String(options?.base ?? "/chat").replace(/\/+$/, "");
  const now = options.now ?? (() => new Date());
  /** @type {{ id: string, name: string } | null} */
  let me = null;
  /** @type {Map<string, string>} */
  const names = new Map();
  const nameOf = (/** @type {string} */ id) => names.get(id) ?? (me && me.id === id ? me.name : id);

  /** @type {"all" | "mine" | "waiting"} */
  let filter = "all";
  /** @type {import("./list.js").ThreadSummary[]} */
  let threads = [];
  /** @type {string | null} */
  let active = null;
  /** @type {ReturnType<typeof renderThread> | null} */
  let view = null;
  /** @type {{ close(): void } | null} */
  let threadStream = null;
  let roomState = "connecting";
  /** @type {string | null} */
  let roomDetail = null;
  /** @type {any} */
  let presence = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let listTimer = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let positionTimer = null;
  let gone = false;

  /** @param {string | null} thread @returns {ChatContext} */
  const ctxFor = (thread) => ({
    person: me,
    thread,
    theme: themeOf(el),
    now,
    post: async (text, trailers) => {
      const operationId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `op-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const payload = JSON.stringify({ text, thread: thread ?? undefined, operationId, trailers: [...(options.context?.() ?? []), ...(trailers ?? [])] });
      for (let tries = 0; ; tries++) {
        const r = await call(base, "/post", { method: "POST", body: payload });
        // acceptance unknown: the same operation id is resent, never a new one
        if (r.status === 202 && tries < 3) { await new Promise((res) => setTimeout(res, 1000 * (tries + 1))); continue; }
        return dataOf(r);
      }
    },
  });

  el.classList.add("chat");
  const filters = /** @type {const} */ ([["all", "all"], ["mine", "i'm in"], ["waiting", "waiting on me"]]);
  const filterBar = h("div", { class: "chat-filters", role: "group", "aria-label": "Show" });
  const listEl = h("nav", { class: "chat-threads", "aria-label": "Threads" });
  const stateLine = h("p", { class: "chat-state", role: "status", "aria-live": "polite" });
  const listPane = h("section", { class: "chat-list-pane", "aria-label": "Threads" }, [
    h("div", { class: "chat-list-head" }, [filterBar]),
    h("div", { class: "chat-list-scroll" }, [listEl]),
    stateLine,
  ]);

  const back = h("button", { type: "button", class: "chat-back", "aria-label": "Back to the threads" }, ["‹"]);
  const cap = h("span", { class: "chat-cap" });
  const title = h("h1", { class: "chat-thread-title" });
  const meta = h("span", { class: "chat-thread-meta" });
  const presenceLine = h("span", { class: "chat-presence" });
  const head = h("header", { class: "chat-thread-head" }, [
    back,
    h("div", { class: "chat-thread-heading" }, [cap, title, meta]),
    h("div", { class: "chat-thread-side" }, [presenceLine]),
  ]);
  const ledger = h("div", { class: "chat-ledger" });
  const scroller = h("div", { class: "chat-scroll" }, [ledger]);
  const composer = h("div", { class: "chat-composer" });
  const emptyThread = h("p", { class: "chat-empty chat-empty--thread" }, ["open a thread from the list"]);
  const threadPane = h("section", { class: "chat-thread-pane", "aria-label": "Thread" }, [head, scroller, composer, emptyThread]);
  const shell = h("div", { class: "chat-shell", "data-view": "list", "data-open": "false" }, [listPane, threadPane]);
  el.appendChild(shell);

  const drawFilters = () => {
    while (filterBar.firstChild) filterBar.removeChild(filterBar.firstChild);
    for (const [key, label] of filters) {
      const b = h("button", { type: "button", class: "chat-filter", "aria-pressed": filter === key ? "true" : "false" }, [label]);
      b.addEventListener("click", () => { if (filter !== key) { filter = key; drawFilters(); void loadList(); } });
      filterBar.appendChild(b);
    }
  };

  const drawState = () => {
    const words = {
      connecting: "connecting",
      live: "live",
      reconnecting: "reconnecting",
      dark: "dark · the room is not answering",
      refused: "refused",
    };
    const key = /** @type {keyof typeof words} */ (roomState in words ? roomState : "connecting");
    stateLine.textContent = words[key] + (roomDetail ? ` · ${roomDetail}` : "");
    stateLine.setAttribute("data-state", key);
  };

  const drawPresence = () => {
    if (!presence || typeof presence.state !== "string") { presenceLine.textContent = ""; return; }
    const since = presence.lastSeen ? ` since ${clock(presence.lastSeen)}` : "";
    presenceLine.textContent = `resident · ${presence.state}${since}`;
    presenceLine.setAttribute("data-state", presence.state);
  };

  /** @param {any} s */
  const onState = (s) => {
    const value = typeof s === "string" ? s : s?.state;
    if (value === "live" || value === "dark" || value === "refused") {
      roomState = value;
      roomDetail = typeof s === "object" && s ? (s.reason ?? s.code ?? null) : null;
      drawState();
    }
  };

  const drawList = () => {
    const shown = filter === "waiting" ? threads.filter((t) => me && (t.waiting ?? []).includes(me.id)) : threads;
    renderThreadList(listEl, shown, ctxFor(null), { me, active, name: nameOf, onOpen: (root) => { void open(root); } });
  };

  const loadList = async () => {
    try {
      const data = dataOf(await call(base, `/threads?scope=${filter === "mine" ? "mine" : "all"}`));
      threads = Array.isArray(data?.threads) ? data.threads : [];
      drawList();
    } catch (e) {
      roomDetail = `the list could not be read: ${e instanceof Error ? e.message : String(e)}`;
      drawState();
    }
  };
  const queueList = () => {
    if (listTimer) clearTimeout(listTimer);
    listTimer = setTimeout(() => { listTimer = null; void loadList(); }, 300);
  };

  // the ledger stays at its newest line while the reader is there: cards and fonts that arrive
  // after the first paint grow it, and a reader who scrolled up is left where they are
  let stuck = true;
  scroller.addEventListener("scroll", () => { stuck = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80; }, { passive: true });
  const toBottom = () => { if (stuck) scroller.scrollTop = scroller.scrollHeight; };
  /** @type {ResizeObserver | null} */
  const grown = typeof ResizeObserver === "function" ? new ResizeObserver(() => toBottom()) : null;
  if (grown) grown.observe(ledger);

  const markRead = () => {
    if (!active || !view) return;
    const last = view.last();
    if (!last?.cursor) return;
    const thread = active;
    const cursor = last.cursor;
    if (positionTimer) clearTimeout(positionTimer);
    positionTimer = setTimeout(() => {
      positionTimer = null;
      void call(base, "/position", { method: "POST", body: JSON.stringify({ thread, cursor }) }).catch(() => {});
      const t = threads.find((x) => rootId(x) === thread);
      if (t && t.unread) { t.unread = false; drawList(); }
    }, 500);
  };

  /** @param {import("./thread.js").ChatMessage[]} messages @param {string} root */
  const drawHead = (messages, root) => {
    const rootMsg = messages.find((m) => m.id === root) ?? messages[0];
    const summary = threads.find((t) => rootId(t) === root);
    const fromList = summary && typeof summary.root !== "string" ? summary.root : undefined;
    const r = rootMsg ?? fromList;
    const line = r ? (bodyOf(r).split("\n").find((l) => l.trim()) ?? "").replace(/[*_`]+/g, "").trim() : "";
    title.textContent = line || root;
    cap.textContent = r ? `thread · opened ${dayLabel(r.ts, now())} ${clock(r.ts)} by ${r.author?.name ?? ""}` : "thread";
    const people = [...new Set(messages.filter((m) => m.author?.kind === "human").map((m) => m.author.name))];
    const ctxValues = r ? contextOf(r).map(([, v]) => v) : [];
    meta.textContent = [...ctxValues, people.join(", ")].filter(Boolean).join(" · ");
  };

  /** @param {string} root */
  const open = async (root) => {
    if (gone) return;
    // a host whose onOpenThread routes back into open() lands here a second time: show, do not reload
    if (root === active && threadStream) { shell.setAttribute("data-view", "thread"); return; }
    active = root;
    shell.setAttribute("data-view", "thread");
    shell.setAttribute("data-open", "true");
    drawList();
    if (threadStream) { threadStream.close(); threadStream = null; }
    while (composer.firstChild) composer.removeChild(composer.firstChild);
    title.textContent = "";
    cap.textContent = "thread";
    meta.textContent = "";
    view = renderThread(ledger, [], ctxFor(root), { base, me, name: nameOf });
    if (options.onOpenThread) options.onOpenThread(root);
    try {
      const data = dataOf(await call(base, `/thread/${encodeURIComponent(root)}`));
      if (active !== root) return;
      const messages = Array.isArray(data?.messages) ? data.messages : [];
      view = renderThread(ledger, messages, ctxFor(root), { base, me, name: nameOf });
      drawHead(messages, root);
      stuck = true;
      toBottom();
      markRead();
    } catch (e) {
      ledger.appendChild(h("p", { class: "chat-empty", role: "alert" }, [`this thread could not be read: ${e instanceof Error ? e.message : String(e)}`]));
    }
    // the composer takes the host's options from mountChat, so a host calls nothing else to post
    try {
      mountComposer(composer, ctxFor(root), {
        base,
        ...(options.people ? { people: options.people } : {}),
        ...(options.context ? { context: options.context } : {}),
      });
    } catch { /* the composer is mounted where it is built */ }
    threadStream = openStream(`${base}/stream?thread=${encodeURIComponent(root)}`, {
      message: (m) => {
        if (active !== root || !view || !m || typeof m !== "object") return;
        if (view.add(m)) {
          drawHead(view.messages(), root);
          toBottom();
          markRead();
        }
      },
      annotation: (a) => { if (active === root && view && a && typeof a === "object") view.annotate(a); },
      // someone reacted: the composer draws the reactions line under each row
      reaction: (r) => { if (active === root && r && typeof r === "object") composerIn(composer)?.reaction(r); },
      // a purge, whoever made it: the composer strikes the rows it took, which it draws on
      purge: (p) => { if (active === root && p && typeof p === "object") composerIn(composer)?.purge(p); },
      state: onState,
      presence: (p) => { presence = p; drawPresence(); },
    }, (s) => { if (s === "reconnecting") { roomState = "reconnecting"; drawState(); } });
  };

  const backToList = () => {
    shell.setAttribute("data-view", "list");
  };
  back.addEventListener("click", backToList);

  const mainStream = openStream(`${base}/stream?thread=main`, {
    message: () => queueList(),
    annotation: () => queueList(),
    purge: () => queueList(),
    state: onState,
    presence: (p) => { presence = p; drawPresence(); },
  }, (s) => {
    if (s === "reconnecting") { roomState = "reconnecting"; drawState(); }
    if (s === "open" && roomState === "reconnecting") { roomState = "live"; roomDetail = null; drawState(); queueList(); }
  });

  drawFilters();
  drawState();
  (async () => {
    try {
      const state = dataOf(await call(base, "/state"));
      me = state?.me ?? null;
      if (state?.resident) { presence = state.resident; drawPresence(); }
    } catch (e) {
      roomDetail = `the room could not be read: ${e instanceof Error ? e.message : String(e)}`;
      drawState();
    }
    if (options.people) {
      try { for (const p of await options.people()) names.set(p.id, p.name); } catch { /* names fall back to ids */ }
    }
    await loadList();
    if (options.thread) await open(options.thread);
  })();

  return {
    unmount() {
      gone = true;
      mainStream.close();
      if (threadStream) threadStream.close();
      if (listTimer) clearTimeout(listTimer);
      if (positionTimer) clearTimeout(positionTimer);
      if (grown) grown.disconnect();
      shell.remove();
      el.classList.remove("chat");
    },
    open,
    back: backToList,
    refresh: loadList,
  };
}
