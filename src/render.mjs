// @ts-check
import { decodeTransfer } from "./tailcat.mjs";
import { formatTrailers, parseTrailers } from "./trailers.mjs";

/**
 * How a message is shown to a person: the one derived line above a verbatim body. The CLI's
 * `read` and `watch` print through these, and the human TUI renders through the same functions,
 * so the two surfaces cannot drift apart on what a trailer block says or where the signature sits.
 */

/** @param {string} s */
export const indent = (s) => s.split(/\r?\n/).map((l) => `    ${l}`).join("\n");

/**
 * A message with its trailer block read off it. The text is never rewritten: the block stays in
 * the body it was posted in, and this only says what is in there.
 * @param {import('./core.mjs').Message} m
 */
export function decorate(m) {
  const { trailers, to } = parseTrailers(m.text);
  return {
    ...m,
    ...(decodeTransfer(m.text)?.kind === "offer" ? { offer: decodeTransfer(m.text).offer } : {}),
    ...(to.length ? { to } : {}),
    ...(trailers.length ? { trailers } : {}),
  };
}

/**
 * A message as `read --json` prints it, without the line's `type` and `alias`: decorated, and
 * without the transport's raw payload. The CLI's JSON lines and `agora/client` both build their
 * message objects here, so the two cannot drift apart on a field.
 * @param {import('./core.mjs').Message} m
 */
export function wireMessage(m) {
  const { raw: _raw, ...rest } = decorate(m);
  return rest;
}

/** The one derived line above a body: what the trailers say, in the emitter's order. @param {ReturnType<typeof decorate>} m */
export function trailerLine(m) {
  if (!m.trailers?.length) return "";
  /** @type {string[]} */
  const parts = [];
  if (m.to?.length) parts.push(`to ${m.to.join(", ")}`);
  for (const t of formatTrailers(m.trailers).split("\n")) {
    const at = t.indexOf(": ");
    const key = t.slice(0, at);
    if (key === "to") continue;
    parts.push(`${key} ${t.slice(at + 2)}`);
  }
  return parts.length ? `  → ${parts.join(" · ")}\n` : "";
}

/** The header the CLI prints above a message: who, as whom, where, at which cursor. @param {ReturnType<typeof decorate>} m */
export function headerLine(m) {
  const named = m.signedAs && m.signedAs !== m.author.name ? `${m.author.name} as ${m.signedAs}` : m.author.name;
  // the app client a native message was submitted through: what its connection declared, shown as
  // attribution beside the name and never in place of it
  const who = m.via ? `${named} · via ${m.via}` : named;
  const where = m.thread ? `  thread ${m.thread}` : "";
  return `[${m.ts}] ${who} (${m.author.kind})${where}  cursor ${m.cursor}`;
}

/** The attachment block under a body, or an empty string. @param {ReturnType<typeof decorate>} m */
export function attachmentLines(m) {
  return m.attachments?.length
    ? `\n  attachments\n${m.attachments.map((a) => `    ${a.kind} ${a.name}${a.mimetype ? ` (${a.mimetype}` : ""}${a.size !== undefined ? `${a.mimetype ? ", " : " ("}${a.size} bytes` : ""}${a.mimetype || a.size !== undefined ? ")" : ""}${a.path ? `\n      local ${a.path}` : ""}${a.url ? `\n      source ${a.url}` : ""}${a.error ? `\n      ${a.error}` : ""}`).join("\n")}`
    : "";
}

/**
 * An annotation (docs/ANNOTATIONS.md): an edit, withdraw, pin or unpin of a message, as `read
 * --json` prints it (with `type: "annotation"` and `alias` beside it) and as `agora/client`
 * delivers it. Built field by field, so nothing the record carries beyond the contract leaks out.
 * @param {any} a
 * @returns {{ id: string, cursor: string, ts: string, act: 'edit' | 'withdraw' | 'pin' | 'unpin', target: string, text?: string, author: { id: string, name: string, kind: string, ref?: string }, via?: string }}
 */
export function wireAnnotation(a) {
  const author = a?.author ?? {};
  return {
    id: String(a.id), cursor: String(a.cursor), ts: String(a.ts), act: a.act, target: String(a.target),
    ...(typeof a.text === "string" ? { text: a.text } : {}),
    author: { id: String(author.id), name: String(author.name), kind: String(author.kind),
      ...(typeof author.ref === "string" ? { ref: author.ref } : {}) },
    ...(typeof a.via === "string" && a.via ? { via: a.via } : {}),
    ...(a?.purged && typeof a.purged.at === "string" ? { purged: { at: a.purged.at, purge: String(a.purged.purge) } } : {}),
  };
}

/** How the CLI shows an annotation to a person: who did what to which message, and an edit's text. @param {ReturnType<typeof wireAnnotation>} a */
export function humanAnnotation(a) {
  const who = a.via ? `${a.author.name} · via ${a.via}` : a.author.name;
  const head = `[${a.ts}] ${who} (${a.author.kind}) ${a.act} ${a.target}  cursor ${a.cursor}`;
  return a.text !== undefined ? `${head}\n${indent(a.text)}` : head;
}

/** @param {ReturnType<typeof decorate>} m */
export function human(m) {
  if (m.purged) return `${headerLine(m)}
${trailerLine(m)}    (purged at ${m.purged.at} by ${m.purged.purge})${attachmentLines(m)}`;
  return `${headerLine(m)}\n${trailerLine(m)}${indent(m.text)}${attachmentLines(m)}`;
}
