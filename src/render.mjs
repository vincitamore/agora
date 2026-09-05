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
  const who = m.signedAs && m.signedAs !== m.author.name ? `${m.author.name} as ${m.signedAs}` : m.author.name;
  const where = m.thread ? `  thread ${m.thread}` : "";
  return `[${m.ts}] ${who} (${m.author.kind})${where}  cursor ${m.cursor}`;
}

/** The attachment block under a body, or an empty string. @param {ReturnType<typeof decorate>} m */
export function attachmentLines(m) {
  return m.attachments?.length
    ? `\n  attachments\n${m.attachments.map((a) => `    ${a.kind} ${a.name}${a.mimetype ? ` (${a.mimetype}` : ""}${a.size !== undefined ? `${a.mimetype ? ", " : " ("}${a.size} bytes` : ""}${a.mimetype || a.size !== undefined ? ")" : ""}${a.path ? `\n      local ${a.path}` : ""}${a.url ? `\n      source ${a.url}` : ""}${a.error ? `\n      ${a.error}` : ""}`).join("\n")}`
    : "";
}

/** @param {ReturnType<typeof decorate>} m */
export function human(m) {
  return `${headerLine(m)}\n${trailerLine(m)}${indent(m.text)}${attachmentLines(m)}`;
}
