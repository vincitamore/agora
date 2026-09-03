// @ts-check
import { parseSignature } from "./core.mjs";

/**
 * A message is a body, a blank line, an optional trailer block, a blank line, and an optional
 * signature. The block addresses the message and says what it claims, in one grammar the emitter
 * and the parser share.
 *
 * Recognition is deliberately stricter than a commit-message parser's, because two humans type in
 * this room and a line of prose that happens to hold a colon must not become a claim: strip the
 * signature, take the last paragraph, and accept it only if EVERY line is `key: value` and at least
 * one key is one we know. There are no partial parses.
 *
 * Unknown keys are parsed, carried and rendered, and never acted on. That is the whole versioning
 * story: growth is additive, and narrowing a key's meaning is the only breaking change.
 * @typedef {{ key: string, value: string }} Trailer
 */

/** The keys this tool knows. Order is the order the emitter writes them in. */
export const KNOWN_KEYS = Object.freeze(["to", "re", "claim", "release", "verdict", "exhibit", "because"]);

const TRAILER_RE = /^([A-Za-z][A-Za-z0-9-]{0,23})[ \t]*:[ \t](.{1,200})$/;
/** A platform mention resolves to the bot user, so it addresses the seat and cannot name a bearer. */
const MENTION_RE = /^<@([A-Z0-9]+)(?:\|[^>]*)?>$/;

/** @param {string} text */
function stripSignature(text) {
  if (parseSignature(text) === undefined) return text;
  const lines = text.replace(/\s+$/, "").split(/\r?\n/);
  lines.pop();
  return lines.join("\n").replace(/\s+$/, "");
}

/**
 * Split a message into its body and its trailers. `body` is everything before the block, without
 * its trailing blank lines; when there is no block, the body is the whole text as given.
 * @param {string} text
 * @returns {{ body: string, trailers: Trailer[], to: string[] }}
 */
export function parseTrailers(text) {
  const none = { body: text, trailers: /** @type {Trailer[]} */ ([]), to: /** @type {string[]} */ ([]) };
  const withoutSignature = stripSignature(text);
  const lines = withoutSignature.replace(/\s+$/, "").split(/\r?\n/);

  let start = lines.length;
  while (start > 0 && lines[start - 1].trim()) start--;
  const paragraph = lines.slice(start);
  if (!paragraph.length) return none;

  /** @type {Trailer[]} */
  const trailers = [];
  for (const line of paragraph) {
    const m = line.match(TRAILER_RE);
    if (!m) return none;
    trailers.push({ key: m[1].toLowerCase(), value: m[2].trim() });
  }
  if (!trailers.some((t) => KNOWN_KEYS.includes(t.key))) return none;

  /** @type {string[]} */
  const to = [];
  for (const t of trailers) {
    if (t.key !== "to") continue;
    for (const one of t.value.split(",")) {
      const v = one.trim();
      if (v && !to.includes(v)) to.push(v);
    }
  }
  const body = lines.slice(0, start).join("\n").replace(/\s+$/, "");
  return { body, trailers, to };
}

/**
 * The block, one `key: value` per line: the known keys in their fixed order, then anything else in
 * the order it was given. Emitter and parser round-trip by construction.
 * @param {Trailer[]} entries
 */
export function formatTrailers(entries) {
  /** @type {Trailer[]} */
  const ordered = [];
  for (const key of KNOWN_KEYS) for (const t of entries) if (t.key === key) ordered.push(t);
  for (const t of entries) if (!KNOWN_KEYS.includes(t.key)) ordered.push(t);
  return ordered.map((t) => `${t.key}: ${t.value}`).join("\n");
}

/**
 * Does this address name me? Bearers match by segment prefix, so `Grace` reaches `Grace/watch` and
 * `Grace/watch` reaches only itself; `Gra` reaches nothing. `*` is everyone. A platform mention
 * token matches when its id is the seat's: the platform's own mechanism resolves to the bot user,
 * so it addresses the whole seat and cannot pick out one bearer, which is why bearer addressing is
 * textual at all.
 * @param {string} address @param {string} bearer @param {{ id?: string, name?: string }} [seat]
 */
export function matchesAddress(address, bearer, seat) {
  const a = address.trim();
  if (!a) return false;
  if (a === "*") return true;
  const mention = a.match(MENTION_RE);
  if (mention) return Boolean(seat?.id) && mention[1] === seat?.id;
  const lower = a.toLowerCase();
  if (seat?.name && lower === seat.name.toLowerCase()) return true;
  const want = lower.split("/").filter(Boolean);
  const have = bearer.toLowerCase().split("/").filter(Boolean);
  if (!want.length || want.length > have.length) return false;
  return want.every((seg, i) => seg === have[i]);
}
