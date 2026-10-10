// @ts-check
/**
 * One thread as a ledger: time and author column, serif for agent prose, sans for people, mono
 * for code and evidence; posts past 600 characters collapsed behind "show all".
 *
 * A message arrives folded (`foldAnnotations` in agora's client): `text` is the whole posted text,
 * its trailer block and signature line included, and `edited`, `withdrawn` and `pinned` are set
 * when an annotation said so. The ledger shows the body, renders the trailers it knows (`card`,
 * `waiting`, `context`) and acts on none of them.
 *
 * This module also carries the reading of a message (`splitMessage`, `bodyOf`, `trailerValues`,
 * `contextOf`) and the clock words (`clock`, `dayLabel`) the list shares.
 */

import { h, renderMarkdown } from "./markdown.js";
import { mountCard, parseCardRef } from "./cards.js";

/** Posts longer than this are collapsed behind "show all". */
export const COLLAPSE_AT = 600;

// The reading of a trailer block and a signature line is agora's (src/trailers.mjs, src/core.mjs);
// the client half is served on its own, so the rule is restated here and kept to the same shape.
const KNOWN_KEYS = ["to", "re", "withdraws", "claim", "release", "verdict", "exhibit", "because", "ack", "card", "waiting", "context"];
const TRAILER_RE = /^([A-Za-z][A-Za-z0-9-]{0,23})[ \t]*:[ \t](.{1,400})$/;
const SIGNATURE_RE = /^(?:--|—|–)\s?(.{1,80}?)\s*$/;

/**
 * @typedef {{
 *   id: string, cursor?: string, ts: string, text: string, thread?: string, via?: string,
 *   author: { id?: string, name: string, kind: "human" | "agent" | "system", ref?: string },
 *   trailers?: Array<{ key: string, value: string }>, to?: string[], signedAs?: string,
 *   attachments?: Array<{ id: string, digest: string, name: string, kind: "image" | "file", size: number, mimetype?: string, width?: number, height?: number }>,
 *   edited?: { at: string, text: string }, withdrawn?: { at: string }, pinned?: boolean,
 * }} ChatMessage
 */
/**
 * @typedef {{ id: string, cursor?: string, ts: string, act: "edit" | "withdraw" | "pin" | "unpin", target: string, text?: string, author?: ChatMessage["author"], via?: string }} ChatAnnotation
 */

/**
 * Split posted text into its body, its trailers and its signature, by agora's rules: a last line
 * `-- name` is the signature; a last paragraph made only of `key: value` lines, one of them a key
 * agora knows, is the trailer block.
 * @param {string} text
 * @returns {{ body: string, trailers: Array<{ key: string, value: string }>, signedAs?: string }}
 */
export function splitMessage(text) {
  let lines = String(text ?? "").replace(/\s+$/, "").split(/\r?\n/);
  /** @type {string | undefined} */
  let signedAs;
  if (lines.length >= 2) {
    const m = lines[lines.length - 1].match(SIGNATURE_RE);
    if (m) { signedAs = m[1]; lines = lines.slice(0, -1); while (lines.length && !lines[lines.length - 1].trim()) lines.pop(); }
  }
  let start = lines.length;
  while (start > 0 && lines[start - 1].trim()) start--;
  const paragraph = lines.slice(start);
  /** @type {Array<{ key: string, value: string }>} */
  const trailers = [];
  let block = paragraph.length > 0;
  for (const line of paragraph) {
    const m = line.match(TRAILER_RE);
    if (!m) { block = false; break; }
    trailers.push({ key: m[1].toLowerCase(), value: m[2].trim() });
  }
  if (block && trailers.some((t) => KNOWN_KEYS.includes(t.key)) && start > 0) {
    return { body: lines.slice(0, start).join("\n").replace(/\s+$/, ""), trailers, ...(signedAs !== undefined ? { signedAs } : {}) };
  }
  return { body: lines.join("\n"), trailers: [], ...(signedAs !== undefined ? { signedAs } : {}) };
}

/** The body a reader sees: the text without its trailer block and signature. @param {ChatMessage} m */
export function bodyOf(m) {
  return splitMessage(m.text).body;
}

/** Every value of one trailer key, in order. @param {ChatMessage} m @param {string} key */
export function trailerValues(m, key) {
  const list = m.trailers ?? splitMessage(m.text).trailers;
  return list.filter((t) => t.key === key).map((t) => t.value);
}

/** The `context` trailers as `[key, value]` pairs: `context: k=v; k2=v2`. @param {ChatMessage} m */
export function contextOf(m) {
  /** @type {Array<[string, string]>} */
  const out = [];
  for (const v of trailerValues(m, "context")) {
    for (const part of v.split(";")) {
      const at = part.indexOf("=");
      if (at < 1) continue;
      const k = part.slice(0, at).trim();
      const val = part.slice(at + 1).trim();
      if (k && val) out.push([k, val]);
    }
  }
  return out;
}

/** The person ids a message's `waiting` trailers name. @param {ChatMessage} m */
export function waitingOf(m) {
  return trailerValues(m, "waiting").flatMap((v) => v.split(",")).map((s) => s.trim()).filter(Boolean);
}

/** @param {number} n */
const two = (n) => String(n).padStart(2, "0");
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** `14:16`, local time. @param {string | Date} at */
export function clock(at) {
  const d = at instanceof Date ? at : new Date(at);
  return Number.isNaN(d.getTime()) ? "" : `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** `today`, else `wed 08 oct`, or `wed 08 oct 2025` in another year. @param {string | Date} at @param {Date} now */
export function dayLabel(at, now) {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const key = (/** @type {Date} */ x) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  if (key(d) === key(now)) return "today";
  const base = `${DAYS[d.getDay()]} ${two(d.getDate())} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === now.getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

/** `14:16` today, `oct 8` before. @param {string | Date} at @param {Date} now */
export function shortWhen(at, now) {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const label = dayLabel(d, now);
  if (label === "today") return clock(d);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** @param {number} n */
function bytes(n) {
  if (!(n >= 0)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * @typedef {{
 *   base?: string,
 *   me?: { id: string, name: string } | null,
 *   name?: (personId: string) => string,
 * }} ThreadOptions
 */

/**
 * Render a thread into `el` and keep it current: `add` a message that arrived, `annotate` with an
 * annotation event. Messages are kept once each by id, in cursor order as they come.
 * @param {HTMLElement} el
 * @param {ChatMessage[]} messages
 * @param {import("./index.js").ChatContext} ctx
 * @param {ThreadOptions} [opts]
 * @returns {{ add(m: ChatMessage): boolean, annotate(a: ChatAnnotation): void, messages(): ChatMessage[], last(): ChatMessage | undefined }}
 */
export function renderThread(el, messages, ctx, opts = {}) {
  el.classList.add("chat-ledger");
  el.setAttribute("role", "log");
  while (el.firstChild) el.removeChild(el.firstChild);
  /** @type {ChatMessage[]} */
  const list = [];
  /** @type {Map<string, HTMLElement>} */
  const rows = new Map();
  let lastDay = "";
  const now = () => ctx.now();

  /** @param {ChatMessage} m */
  const append = (m) => {
    const day = dayLabel(m.ts, now());
    if (day && day !== lastDay) {
      el.appendChild(h("div", { class: "chat-day", role: "separator" }, [day]));
      lastDay = day;
    }
    const row = messageRow(m, ctx, opts);
    rows.set(m.id, row);
    el.appendChild(row);
  };

  for (const m of messages) {
    if (!m || typeof m.id !== "string" || rows.has(m.id)) continue;
    list.push(m);
    append(m);
  }

  return {
    add(m) {
      if (!m || typeof m.id !== "string" || rows.has(m.id)) return false;
      list.push(m);
      append(m);
      return true;
    },
    annotate(a) {
      const at = list.findIndex((m) => m.id === a.target);
      if (at < 0) return;
      const m = { ...list[at] };
      if (a.act === "withdraw") m.withdrawn ??= { at: a.ts };
      else if (a.act === "pin" || a.act === "unpin") m.pinned = a.act === "pin";
      else if (a.act === "edit" && !m.withdrawn && typeof a.text === "string") {
        const split = splitMessage(a.text);
        m.text = a.text;
        m.edited = { at: a.ts, text: a.text };
        m.trailers = split.trailers;
        if (split.signedAs !== undefined) m.signedAs = split.signedAs; else delete m.signedAs;
      }
      list[at] = m;
      const old = rows.get(m.id);
      const row = messageRow(m, ctx, opts);
      rows.set(m.id, row);
      if (old && old.parentNode) old.parentNode.replaceChild(row, old);
    },
    messages: () => list.slice(),
    last: () => list[list.length - 1],
  };
}

/**
 * One ledger row.
 * @param {ChatMessage} m @param {import("./index.js").ChatContext} ctx @param {ThreadOptions} opts
 * @returns {HTMLElement}
 */
export function messageRow(m, ctx, opts = {}) {
  const kind = m.author?.kind === "agent" || m.author?.kind === "system" ? m.author.kind : "human";
  const who = m.author?.name ?? "";
  const meId = opts.me?.id ?? ctx.person?.id ?? null;
  const waiting = waitingOf(m);
  const forMe = meId !== null && waiting.includes(meId);
  const nameOf = opts.name ?? ((/** @type {string} */ id) => id);

  const body = h("div", { class: "chat-msg-body" });
  const row = h("article", {
    class: `chat-msg chat-msg--${kind}` + (m.withdrawn ? " is-withdrawn" : "") + (m.pinned ? " is-pinned" : "") + (forMe ? " is-for-you" : ""),
    "data-id": m.id, "data-cursor": m.cursor ?? null,
  }, [
    h("time", { class: "chat-msg-time", datetime: m.ts, title: m.ts }, [clock(m.ts)]),
    h("span", { class: "chat-msg-who", title: m.via ? `${who} · via ${m.via}` : who }, [who]),
    body,
  ]);

  if (m.withdrawn) {
    body.appendChild(h("p", { class: "chat-msg-withdrawn" }, [`withdrawn ${clock(m.withdrawn.at)}`]));
    return row;
  }

  const text = bodyOf(m);
  if (text.trim()) {
    const prose = h("div", { class: "chat-msg-text " + (kind === "agent" ? "chat-prose" : kind === "system" ? "chat-mono" : "chat-sans") });
    prose.appendChild(renderMarkdown(text, ctx));
    body.appendChild(prose);
    if (text.length > COLLAPSE_AT) {
      prose.classList.add("is-collapsed");
      const toggle = h("button", { type: "button", class: "chat-show-all", "aria-expanded": "false" }, ["show all"]);
      toggle.addEventListener("click", () => {
        const open = prose.classList.toggle("is-collapsed") === false;
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
        toggle.textContent = open ? "show less" : "show all";
      });
      body.appendChild(toggle);
    }
  }

  for (const v of trailerValues(m, "card")) {
    const ref = parseCardRef(v);
    if (!ref) continue;
    const card = mountCard(ref, ctx, { you: forMe });
    if (card) body.appendChild(card);
  }

  if (m.attachments?.length) body.appendChild(attachmentsBlock(m, opts.base ?? ""));

  /** @type {Array<Node | string>} */
  const marks = [];
  if (forMe) marks.push(h("span", { class: "chat-mark chat-mark--you" }, ["waiting on you"]));
  const others = waiting.filter((id) => id !== meId);
  if (others.length) marks.push(h("span", { class: "chat-mark" }, [`waiting on ${others.map(nameOf).join(", ")}`]));
  if (m.edited) marks.push(h("span", { class: "chat-mark" }, [`edited ${clock(m.edited.at)}`]));
  if (m.pinned) marks.push(h("span", { class: "chat-mark" }, ["pinned"]));
  if (marks.length) body.appendChild(h("div", { class: "chat-msg-marks" }, marks));
  return row;
}

/**
 * The files a message carries: images as thumbnails, other files as a name and a size, each a
 * link to the kit's file route. Nothing here is fetched as anything but an image or a download.
 * @param {ChatMessage} m @param {string} base
 */
function attachmentsBlock(m, base) {
  const wrap = h("div", { class: "chat-files" });
  for (const a of m.attachments ?? []) {
    const href = `${base}/file/${encodeURIComponent(a.id)}?digest=${encodeURIComponent(a.digest)}`;
    if (a.kind === "image") {
      const img = h("img", { src: `${base}/thumb/${encodeURIComponent(a.digest)}`, alt: a.name, loading: "lazy", decoding: "async" });
      img.addEventListener("error", () => { img.remove(); });
      wrap.appendChild(h("a", { class: "chat-file chat-file--image", href, target: "_blank", rel: "noopener" }, [
        h("span", { class: "chat-thumb" }, [img]),
        h("span", { class: "chat-file-name" }, [a.name]),
      ]));
    } else {
      wrap.appendChild(h("a", { class: "chat-file", href, download: a.name }, [
        h("span", { class: "chat-file-name" }, [a.name]),
        h("span", { class: "chat-file-size" }, [bytes(a.size)]),
      ]));
    }
  }
  return wrap;
}
