// @ts-check
/**
 * Message fixtures for replay scenarios (S00), the converter from `agora read --json` lines, and
 * the pure analyses a replay counts with.
 *
 * A fixture is JSON lines, in room order. A message line:
 *
 *   {"id":"q1","author":"Ada","kind":"human","text":"...","to":["coding"],"thread":"room","re":"a1","title":"..."}
 *
 * `id` is a label local to the fixture; `thread` names the label of the thread's root and `re` the
 * label of the message answered. `kind` is `human` or `agent`. An agent line may carry `session`
 * (default: its author), so one session can post under several bearers (a rename). `title` titles
 * the line's own message, as its author would. A register line:
 *
 *   {"event":"register","session":"s-build","author":"Opus/build"}
 *
 * puts a session in the room (or renames it) without a post. A session is present from its first
 * line on.
 */

import { readFile } from "node:fs/promises";
import { matchesAddress } from "../../../src/trailers.mjs";

/**
 * @typedef {{ event?: undefined, id?: string, author: string, kind: 'human' | 'agent', text: string, session?: string, to?: string[], thread?: string, re?: string, title?: string }} MessageLine
 * @typedef {{ event: 'register', session: string, author: string }} RegisterLine
 * @typedef {MessageLine | RegisterLine} FixtureLine
 */

/** @param {unknown} v @param {string} where */
function str(v, where) {
  if (typeof v !== "string" || !v.trim()) throw new Error(`${where}: expected a non-empty string`);
  return v;
}

/**
 * Read a fixture in the scenario format.
 * @param {string} file @returns {Promise<FixtureLine[]>}
 */
export async function loadFixture(file) {
  const raw = await readFile(file, "utf8");
  /** @type {FixtureLine[]} */
  const out = [];
  let n = 0;
  for (const line of raw.split(/\r?\n/)) {
    n++;
    if (!line.trim()) continue;
    const o = JSON.parse(line);
    const where = `${file}:${n}`;
    if (o.event === "register") {
      out.push({ event: "register", session: str(o.session, `${where} session`), author: str(o.author, `${where} author`) });
      continue;
    }
    if (o.kind !== "human" && o.kind !== "agent") throw new Error(`${where}: kind must be human or agent`);
    const to = o.to === undefined ? undefined : Array.isArray(o.to) ? o.to.map(String) : [String(o.to)];
    out.push({ author: str(o.author, `${where} author`), kind: o.kind, text: str(o.text, `${where} text`),
      ...(o.id !== undefined ? { id: String(o.id) } : {}), ...(o.session !== undefined ? { session: String(o.session) } : {}),
      ...(to?.length ? { to } : {}), ...(o.thread !== undefined ? { thread: String(o.thread) } : {}),
      ...(o.re !== undefined ? { re: String(o.re) } : {}), ...(o.title !== undefined ? { title: String(o.title) } : {}) });
  }
  return out;
}

/**
 * Convert an `agora read --json` export into a fixture, in memory. Message text keeps only the body
 * (signature and trailer block removed); `to` and `re` are carried as fields; `thread` and `re`
 * become labels when the export holds the message they name. Title annotations title their root;
 * other annotations and trailers are counted, not replayed. Every agent author is registered at
 * the start (the export does not say who was present before speaking, or which bearers one session
 * held), so a rename reads as two sessions.
 * @param {string} file
 */
export async function fromReadJson(file) {
  const raw = await readFile(file, "utf8");
  /** @type {any[]} */
  const messages = [];
  /** @type {any[]} */
  const annotations = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    const o = JSON.parse(line);
    if (o.type === "message") messages.push(o);
    else if (o.type === "annotation") annotations.push(o);
  }
  /** @type {Map<string, string>} */
  const label = new Map(messages.map((m, i) => [String(m.id), `m${i + 1}`]));
  /** @type {Map<string, string>} */
  const byCursor = new Map(messages.map((m, i) => [String(m.cursor), `m${i + 1}`]));
  /** @type {Map<string, string>} */
  const titles = new Map();
  const notes = { messages: messages.length, annotations: annotations.length, titles: 0, otherAnnotations: 0, otherTrailers: 0, danglingRe: 0, danglingThread: 0 };
  for (const a of annotations) {
    if (a.act === "title" && typeof a.text === "string" && label.has(String(a.target))) { titles.set(String(a.target), a.text); notes.titles++; }
    else notes.otherAnnotations++;
  }
  /** @type {FixtureLine[]} */
  const lines = [];
  const agents = new Set();
  for (const m of messages) if (m.author?.kind !== "human") agents.add(bearerOf(m));
  for (const a of agents) lines.push({ event: "register", session: a, author: a });
  for (const m of messages) {
    const trailers = Array.isArray(m.trailers) ? m.trailers : [];
    const reId = trailers.find((/** @type {any} */ t) => t.key === "re")?.value;
    notes.otherTrailers += trailers.filter((/** @type {any} */ t) => t.key !== "re" && t.key !== "to").length;
    // `re` names a message by id or by cursor (`post --re` takes either)
    const re = reId === undefined ? undefined : label.get(String(reId)) ?? byCursor.get(String(reId));
    if (reId !== undefined && re === undefined) notes.danglingRe++;
    const thread = m.thread === undefined ? undefined : label.get(String(m.thread));
    if (m.thread !== undefined && thread === undefined) notes.danglingThread++;
    const human = m.author?.kind === "human";
    const body = bodyText(String(m.text ?? ""), m.signedAs) || "(empty)";
    lines.push({ id: /** @type {string} */ (label.get(String(m.id))), author: human ? String(m.author.name) : bearerOf(m), kind: human ? "human" : "agent", text: body,
      ...(Array.isArray(m.to) && m.to.length ? { to: m.to.map(String) } : {}), ...(thread ? { thread } : {}), ...(re ? { re } : {}),
      ...(titles.has(String(m.id)) ? { title: /** @type {string} */ (titles.get(String(m.id))) } : {}) });
  }
  return { lines, notes };
}

/** A bearer the CLI accepts, from an export's signer. @param {any} m */
function bearerOf(m) {
  return toBearer(String(m.signedAs ?? m.author?.name ?? "unknown"));
}

/** @param {string} name */
export function toBearer(name) {
  const segs = name.split("/").map((s) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 32)).filter(Boolean);
  return (segs.length ? segs : ["unknown"]).join("/").slice(0, 64);
}

/** @param {string} text @param {string | undefined} signedAs */
function bodyText(text, signedAs) {
  let t = text;
  if (signedAs && t.endsWith(`\n\n-- ${signedAs}`)) t = t.slice(0, -(`\n\n-- ${signedAs}`).length);
  const paras = t.replace(/\s+$/, "").split(/\n\s*\n/);
  const last = paras[paras.length - 1] ?? "";
  if (paras.length > 1 && last.split(/\r?\n/).every((l) => /^[A-Za-z][A-Za-z0-9-]{0,23}[ \t]*:[ \t].+$/.test(l))) paras.pop();
  return paras.join("\n\n");
}

/**
 * The room's people and sessions over time, from the script: which bearer each session holds at
 * each message, who is present, and every bearer ever held.
 * @param {FixtureLine[]} lines
 */
export function timeline(lines) {
  /** @type {Map<string, string>} */
  const holding = new Map();
  /** @type {Set<string>} */
  const humans = new Set();
  /** @type {Set<string>} */
  const everHeld = new Set();
  /** @type {Array<{ line: MessageLine, session: string | null, holding: Map<string, string>, held: Set<string> }>} */
  const messages = [];
  for (const l of lines) {
    if (l.event === "register") { holding.set(l.session, l.author); everHeld.add(l.author); continue; }
    if (l.kind === "human") humans.add(l.author);
    let session = null;
    if (l.kind === "agent") {
      session = l.session ?? l.author;
      holding.set(session, l.author);
      everHeld.add(l.author);
    }
    messages.push({ line: l, session, holding: new Map(holding), held: new Set(everHeld) });
  }
  for (const l of lines) if (l.event !== "register" && l.kind === "human") humans.add(l.author);
  const bearers = new Set();
  for (const l of lines) if (l.event === "register" || l.kind === "agent") bearers.add(l.author);
  return { messages, humans, bearers: [...bearers] };
}

/**
 * Classify one address at one moment: matched (a present bearer, a person, or `*`), or unmatched as
 * `retired` (a bearer someone held earlier and nobody holds now), `halfName` (a strict prefix of a
 * present bearer's segment or of a person's name) or `unknown`. Matching is the tool's own
 * `matchesAddress`, called as the CLI calls it on a native room (the seat name is the reader's
 * bearer).
 * @param {string} address @param {Iterable<string>} present @param {Set<string>} held @param {Set<string>} humans
 * @returns {'matched' | 'retired' | 'halfName' | 'unknown'}
 */
export function classifyAddress(address, present, held, humans) {
  const a = address.trim();
  const now = [...present];
  if (a === "*" || now.some((b) => matchesAddress(a, b, { name: b }))) return "matched";
  const lower = a.toLowerCase();
  if ([...humans].some((h) => h.toLowerCase() === lower)) return "matched";
  if ([...held].some((b) => !now.includes(b) && matchesAddress(a, b, { name: b }))) return "retired";
  const segments = [...now.flatMap((b) => b.toLowerCase().split("/")), ...[...humans].map((h) => h.toLowerCase())];
  if (segments.some((s) => s.length > lower.length && s.startsWith(lower))) return "halfName";
  return "unknown";
}

/**
 * Human messages answered by two or more agents: an answer is an agent message after it that cites
 * it with `re`, or that lands in its thread before the next human message there.
 * @param {Array<{ id: string, kind: string, author: string, thread?: string, re?: string }>} msgs in room order
 */
export function answeredTwice(msgs) {
  let count = 0;
  /** @type {string[]} */
  const ids = [];
  msgs.forEach((h, i) => {
    if (h.kind !== "human") return;
    const root = h.thread ?? h.id;
    const answerers = new Set();
    for (let j = i + 1; j < msgs.length; j++) {
      const m = msgs[j];
      if (m.kind === "human" && (m.thread ?? m.id) === root) break;
      if (m.kind === "human") continue;
      if (m.re === h.id || m.thread === root) answerers.add(m.author);
    }
    if (answerers.size >= 2) { count++; ids.push(h.id); }
  });
  return { count, ids };
}

/**
 * The red-leg variations of a replay, each a pure function of the fixture.
 */
export const variations = {
  /** Thread every top-level reply that cites a message: post it in the cited message's thread. @param {FixtureLine[]} lines */
  threadReReplies(lines) {
    /** @type {Map<string, MessageLine>} */
    const byId = new Map();
    for (const l of lines) if (l.event !== "register" && l.id) byId.set(l.id, l);
    return lines.map((l) => {
      if (l.event === "register" || !l.re || l.thread) return l;
      const cited = byId.get(l.re);
      return cited ? { ...l, thread: cited.thread ?? l.re } : l;
    });
  },
  /** Title every top-level message. @param {FixtureLine[]} lines */
  titleRoots(lines) {
    let n = 0;
    return lines.map((l) => (l.event === "register" || l.thread || l.title ? l : { ...l, title: `Thread ${++n}` }));
  },
  /** Drop every address that matches nobody at the moment it is posted. @param {FixtureLine[]} lines */
  dropUnmatched(lines) {
    const t = timeline(lines);
    let k = 0;
    return lines.map((l) => {
      if (l.event === "register") return l;
      const at = t.messages[k++];
      if (!l.to) return l;
      const to = l.to.filter((a) => classifyAddress(a, at.holding.values(), at.held, t.humans) === "matched");
      const { to: _to, ...rest } = l;
      return to.length ? { ...rest, to } : rest;
    });
  },
  /** Keep only the first agent's answers to each human message; later answerers' lines are dropped. @param {FixtureLine[]} lines */
  firstAnswerOnly(lines) {
    /** @type {Array<{ id: string, kind: string, author: string, thread?: string, re?: string }>} */
    const msgs = [];
    /** @type {Map<number, number>} */
    const index = new Map();
    lines.forEach((l, i) => {
      if (l.event === "register") return;
      index.set(msgs.length, i);
      msgs.push({ id: l.id ?? `#${i}`, kind: l.kind, author: l.author, ...(l.thread ? { thread: l.thread } : {}), ...(l.re ? { re: l.re } : {}) });
    });
    const drop = new Set();
    msgs.forEach((h, i) => {
      if (h.kind !== "human") return;
      const root = h.thread ?? h.id;
      let first = null;
      for (let j = i + 1; j < msgs.length; j++) {
        const m = msgs[j];
        if (m.kind === "human" && (m.thread ?? m.id) === root) break;
        if (m.kind === "human") continue;
        if (m.re === h.id || m.thread === root) {
          if (first === null) first = m.author;
          else if (m.author !== first) drop.add(index.get(j));
        }
      }
    });
    return lines.filter((_, i) => !drop.has(i));
  },
  /** One more message from the first person, to everyone, at the end. @param {FixtureLine[]} lines */
  oneMore(lines) {
    const human = lines.find((l) => l.event !== "register" && l.kind === "human");
    return [...lines, { author: human && human.event !== "register" ? human.author : "Ada", kind: /** @type {const} */ ("human"), text: "One more line, for everyone.", to: ["*"] }];
  },
};
