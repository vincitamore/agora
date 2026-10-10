// @ts-check
/**
 * The markdown subset: paragraphs, lists, emphasis, code, fenced blocks, and links only to
 * `https:` and the same origin. Never an image from text, never raw HTML, never a `javascript:`
 * link.
 *
 * Text is parsed into a small tree (`parseMarkdown`) and the tree is built into DOM nodes with
 * `createElement` and text nodes only (`renderMarkdown`): nothing is ever assigned as HTML, so
 * markup in a message, from a person or copied from a device, stays the characters it was. What
 * the subset does not carry (headings, quotes, tables, images, HTML) is shown as the text it was
 * written as.
 *
 * This module also carries `h`, the one element builder every client module uses.
 */

import { blockRenderer } from "./blocks.js";

/**
 * @typedef {{ type: "text", text: string }
 *   | { type: "br" }
 *   | { type: "code", text: string }
 *   | { type: "em" | "strong", children: Inline[] }
 *   | { type: "link", href: string, children: Inline[] }} Inline
 */
/**
 * @typedef {{ type: "p", children: Inline[] }
 *   | { type: "ul", items: Inline[][] }
 *   | { type: "ol", start: number, items: Inline[][] }
 *   | { type: "fence", lang: string, text: string }} Block
 */

/**
 * Build an element. Attribute values are set with `setAttribute`; children are nodes or strings,
 * and a string always becomes a text node.
 * @param {string} tag
 * @param {Record<string, string | number | boolean | null | undefined> | null} [attrs]
 * @param {Array<Node | string | null | undefined | false>} [children]
 * @returns {HTMLElement}
 */
export function h(tag, attrs, children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  if (children) {
    for (const c of children) {
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
  }
  return el;
}

/**
 * The href a link may carry, or null. Only `https:` URLs and paths on the same origin pass:
 * `javascript:`, `data:`, `http:`, protocol-relative `//host`, and anything with a control
 * character or a space are refused, and the link is shown as its text.
 * @param {string} raw
 * @returns {string | null}
 */
export function safeHref(raw) {
  if (typeof raw !== "string") return null;
  const url = raw.trim();
  if (!url || url.length > 2000) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f-\u009f\\]/u.test(url)) return null;
  if (url.startsWith("/")) return url.startsWith("//") ? null : url;
  if (url.startsWith("#")) return url;
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol === "https:") return parsed.href;
  const origin = typeof location !== "undefined" && location && typeof location.origin === "string" ? location.origin : null;
  if (origin && origin !== "null" && parsed.origin === origin && (parsed.protocol === "http:" || parsed.protocol === "https:")) return parsed.href;
  return null;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})\s*([A-Za-z][A-Za-z0-9-]{0,31})?\s*$/;
const UL_ITEM = /^ {0,3}[-*+][ \t]+(.*)$/;
const OL_ITEM = /^ {0,3}(\d{1,9})[.)][ \t]+(.*)$/;

/**
 * Parse text into the subset's blocks.
 * @param {string} text
 * @returns {Block[]}
 */
export function parseMarkdown(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  /** @type {Block[]} */
  const out = [];
  /** @type {string[]} */
  let para = [];
  const flush = () => {
    if (para.length) out.push({ type: "p", children: parseInline(para.join("\n")) });
    para = [];
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(FENCE_OPEN);
    if (fence) {
      flush();
      const marker = fence[1];
      const close = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`);
      /** @type {string[]} */
      const body = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // the closing fence, or past the end
      out.push({ type: "fence", lang: (fence[2] ?? "").toLowerCase(), text: body.join("\n") });
      continue;
    }
    const ul = line.match(UL_ITEM);
    const ol = ul ? null : line.match(OL_ITEM);
    if (ul || ol) {
      flush();
      const ordered = !!ol;
      /** @type {string[][]} */
      const items = [];
      const start = ol ? Number(ol[1]) : 1;
      while (i < lines.length) {
        const m = ordered ? lines[i].match(OL_ITEM) : lines[i].match(UL_ITEM);
        if (m) { items.push([ordered ? m[2] : m[1]]); i++; continue; }
        // a continuation line belongs to the item above it when it is indented
        if (items.length && /^\s{2,}\S/.test(lines[i])) { items[items.length - 1].push(lines[i].trim()); i++; continue; }
        break;
      }
      const parsed = items.map((it) => parseInline(it.join("\n")));
      out.push(ordered ? { type: "ol", start, items: parsed } : { type: "ul", items: parsed });
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    para.push(line);
    i++;
  }
  flush();
  return out;
}

const IMAGE = /^!\[[^\]\n]{0,500}\]\([^)\n]{0,2000}\)/;
const LINK = /^\[([^\]\n]{1,500})\]\(([^)\s]{1,2000})\)/;
const AUTOLINK = /^https:\/\/[^\s<>()"'`]+/;
const ESCAPABLE = "\\`*_[]()!#+-.{}<>|~";

/**
 * Parse one run of text into inline nodes.
 * @param {string} src
 * @param {boolean} [inLink] links do not nest
 * @returns {Inline[]}
 */
export function parseInline(src, inLink = false) {
  /** @type {Inline[]} */
  const out = [];
  let buf = "";
  const text = () => { if (buf) { out.push({ type: "text", text: buf }); buf = ""; } };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const rest = src.slice(i);
    if (c === "\\" && i + 1 < src.length && ESCAPABLE.includes(src[i + 1])) { buf += src[i + 1]; i += 2; continue; }
    if (c === "\n") { text(); out.push({ type: "br" }); i++; continue; }
    if (c === "`") {
      const run = rest.match(/^`+/)?.[0] ?? "`";
      const close = src.indexOf(run, i + run.length);
      if (close > -1) {
        text();
        out.push({ type: "code", text: src.slice(i + run.length, close).replace(/^ (.+) $/s, "$1") });
        i = close + run.length;
        continue;
      }
      buf += run; i += run.length; continue;
    }
    if (c === "!" && src[i + 1] === "[") {
      const img = rest.match(IMAGE);
      // never an image from text: the syntax is shown as written
      if (img) { buf += img[0]; i += img[0].length; continue; }
    }
    if (c === "[" && !inLink) {
      const m = rest.match(LINK);
      if (m) {
        const href = safeHref(m[2]);
        if (href) { text(); out.push({ type: "link", href, children: parseInline(m[1], true) }); }
        else buf += m[0];
        i += m[0].length;
        continue;
      }
    }
    if (c === "h" && !inLink && (i === 0 || !/[A-Za-z0-9]/.test(src[i - 1]))) {
      const m = rest.match(AUTOLINK);
      if (m) {
        let url = m[0];
        while (/[.,;:!?]$/.test(url)) url = url.slice(0, -1);
        const href = safeHref(url);
        if (href) { text(); out.push({ type: "link", href, children: [{ type: "text", text: url }] }); i += url.length; continue; }
      }
    }
    // a run of `_` inside a word is literal, the whole run: `A__B` never opens on its second `_`
    if (c === "_" && i > 0 && /[A-Za-z0-9]/.test(src[i - 1])) {
      const run = rest.match(/^_+/)?.[0] ?? "_";
      buf += run; i += run.length; continue;
    }
    if ((c === "*" || c === "_") && src[i + 1] === c) {
      const marker = c + c;
      // `__` closes only at a word boundary, as it opens (above): `__a__b c__` is one strong run
      let close = src.indexOf(marker, i + 2);
      if (c === "_") while (close > -1 && /[A-Za-z0-9_]/.test(src[close + 2] ?? "")) close = src.indexOf(marker, close + 1);
      if (close > i + 2 && !/\s/.test(src[i + 2]) && !/\s/.test(src[close - 1])) {
        text();
        out.push({ type: "strong", children: parseInline(src.slice(i + 2, close), inLink) });
        i = close + 2;
        continue;
      }
    }
    if (c === "*" || c === "_") {
      if (i + 1 < src.length && !/\s/.test(src[i + 1])) {
        let close = i + 1;
        while ((close = src.indexOf(c, close)) > -1) {
          const after = src[close + 1];
          if (src[close + 1] === c) { close += 2; continue; }
          if (!/\s/.test(src[close - 1]) && !(c === "_" && after !== undefined && /[A-Za-z0-9]/.test(after))) break;
          close++;
        }
        if (close > i + 1 && !src.slice(i + 1, close).includes("\n\n")) {
          text();
          out.push({ type: "em", children: parseInline(src.slice(i + 1, close), inLink) });
          i = close + 1;
          continue;
        }
      }
    }
    buf += c;
    i++;
  }
  text();
  return out;
}

/**
 * One line of the markdown subset as plain text: what a reader sees, without the marks. Emphasis
 * keeps its words and drops its markers; a literal `_` or `*` the parser leaves as text (inside a
 * name such as `SITE_CT_PHONE610`) stays; code keeps its text; a link is its text.
 * @param {string} src
 */
export function plainInline(src) {
  /** @param {Inline[]} nodes @returns {string} */
  const flat = (nodes) => nodes.map((n) => (n.type === "text" || n.type === "code" ? n.text : n.type === "br" ? " " : flat(n.children))).join("");
  return flat(parseInline(src));
}

/** @param {Inline[]} nodes @param {Node} into */
function buildInline(nodes, into) {
  for (const n of nodes) {
    if (n.type === "text") into.appendChild(document.createTextNode(n.text));
    else if (n.type === "br") into.appendChild(document.createElement("br"));
    else if (n.type === "code") into.appendChild(h("code", { class: "chat-code-inline" }, [n.text]));
    else if (n.type === "em" || n.type === "strong") { const el = h(n.type); buildInline(n.children, el); into.appendChild(el); }
    else if (n.type === "link") {
      const external = /^https:/i.test(n.href) && !(typeof location !== "undefined" && location && n.href.startsWith(location.origin + "/"));
      const a = h("a", { href: n.href, rel: "noopener noreferrer nofollow", target: external ? "_blank" : null });
      buildInline(n.children, a);
      into.appendChild(a);
    }
  }
}

/**
 * A fenced block with no renderer: a code block, its text inert.
 * @param {string} text @param {string} lang
 */
export function codeBlock(text, lang) {
  return h("pre", { class: "chat-code", "data-lang": lang || null }, [h("code", null, [text])]);
}

/**
 * Render text in the subset. A fenced block whose language is registered (`registerBlock`) is
 * handed to its renderer; a renderer that throws, or returns something that is not a node, falls
 * back to the code block.
 * @param {string} text @param {import("./index.js").ChatContext} ctx @returns {DocumentFragment}
 */
export function renderMarkdown(text, ctx) {
  const frag = document.createDocumentFragment();
  for (const b of parseMarkdown(text)) {
    if (b.type === "p") { const p = h("p"); buildInline(b.children, p); frag.appendChild(p); continue; }
    if (b.type === "ul" || b.type === "ol") {
      const list = h(b.type, b.type === "ol" && b.start !== 1 ? { start: b.start } : null);
      for (const item of b.items) { const li = h("li"); buildInline(item, li); list.appendChild(li); }
      frag.appendChild(list);
      continue;
    }
    const render = b.lang ? blockRenderer(b.lang) : undefined;
    /** @type {Node | null} */
    let node = null;
    if (render) {
      try {
        const r = render(b.text, ctx);
        if (r && typeof r === "object" && "nodeType" in r) node = h("div", { class: "chat-block", "data-lang": b.lang }, [r]);
      } catch { node = null; }
    }
    frag.appendChild(node ?? codeBlock(b.text, b.lang));
  }
  return frag;
}
