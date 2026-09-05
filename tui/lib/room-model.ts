/**
 * The pure model behind ROOM and SEARCH: threads folded under their root, messages turned into
 * the display lines the fixed-slot list paints, and an in-memory search over what is loaded.
 * The header and the derived trailer line come from `src/render.mjs`, the same functions the
 * CLI prints through, so a message reads the same in both surfaces. Bodies are verbatim, passed
 * through `redact()` at render time only; the record itself is never rewritten.
 */

import { decorate, headerLine, trailerLine, attachmentLines } from "../../src/render.mjs";
import { redact } from "../../src/core.mjs";
import { wrapLines } from "./format";
import type { Message } from "./room-client";

export interface Entry {
  root: Message;
  replies: Message[];
  /** A reply whose root is not in the loaded window shows at the top level, marked. */
  orphan: boolean;
}

/** Group replies under the root they name. Roots keep the order they were read in (ascending). */
export function foldThreads(msgs: Message[]): Entry[] {
  const isReply = (m: Message) => typeof m.thread === "string" && m.thread !== m.id;
  const byRoot = new Map<string, Entry>();
  const ordered: Array<{ at: number; entry: Entry }> = [];
  msgs.forEach((m, at) => {
    if (isReply(m)) return;
    const entry: Entry = { root: m, replies: [], orphan: false };
    byRoot.set(m.id, entry);
    ordered.push({ at, entry });
  });
  msgs.forEach((m, at) => {
    if (!isReply(m)) return;
    const parent = byRoot.get(m.thread as string);
    if (parent) parent.replies.push(m);
    else ordered.push({ at, entry: { root: m, replies: [], orphan: true } });
  });
  ordered.sort((a, b) => a.at - b.at);
  return ordered.map((o) => o.entry);
}

export type LineTone = "header" | "derived" | "body" | "fold" | "attachment" | "blank" | "note";

export interface Line {
  text: string;
  tone: LineTone;
  /** Index into the entries array this line belongs to. */
  entry: number;
  /** The author kind the header carries, for coloring. */
  kind?: string;
  /** True on the lines of a reply (indented one step under its root). */
  reply?: boolean;
}

export interface BuildOptions {
  width: number;
  unfolded: Set<string>;
}

function messageLines(m: Message, width: number, reply: boolean, entry: number): Line[] {
  const d = decorate(m as never);
  const pad = reply ? "  " : "";
  const out: Line[] = [];
  out.push({ text: pad + redact(headerLine(d)), tone: "header", entry, kind: m.author.kind, reply });
  const derived = trailerLine(d).replace(/\n$/, "");
  if (derived) out.push({ text: pad + redact(derived), tone: "derived", entry, reply });
  const bodyWidth = Math.max(8, width - pad.length - 4);
  for (const l of wrapLines(redact(m.text), bodyWidth)) out.push({ text: `${pad}    ${l}`, tone: "body", entry, reply });
  const att = attachmentLines(d).replace(/^\n/, "");
  if (att) for (const l of att.split("\n")) out.push({ text: pad + redact(l), tone: "attachment", entry, reply });
  return out;
}

/** Every line the list can show, newest entry last. */
export function buildLines(entries: Entry[], opts: BuildOptions): Line[] {
  const out: Line[] = [];
  entries.forEach((e, i) => {
    if (e.orphan) out.push({ text: `  reply to ${e.root.thread} (root not in the loaded window)`, tone: "note", entry: i });
    out.push(...messageLines(e.root, opts.width, false, i));
    if (e.replies.length) {
      const open = opts.unfolded.has(e.root.id);
      const n = e.replies.length;
      out.push({ text: `  ${open ? "▾" : "▸"} ${n} ${n === 1 ? "reply" : "replies"}`, tone: "fold", entry: i });
      if (open) for (const r of e.replies) out.push(...messageLines(r, opts.width, true, i));
    }
    out.push({ text: "", tone: "blank", entry: i });
  });
  return out;
}

export interface SearchOptions {
  author?: string;
  kind?: string;
}

/** Substring match over text and author name, case-insensitive, in read order. Rows only. */
export function searchMessages(msgs: Message[], query: string, opts: SearchOptions = {}): Message[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return msgs.filter((m) => {
    if (opts.author && m.author.name.toLowerCase() !== opts.author.toLowerCase()) return false;
    if (opts.kind && m.author.kind !== opts.kind) return false;
    return m.text.toLowerCase().includes(q) || m.author.name.toLowerCase().includes(q);
  });
}
