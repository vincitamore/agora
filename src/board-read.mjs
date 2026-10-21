// @ts-check
/**
 * The board, read (boards-v1), and the address resolver.
 *
 * A native room's board is a sequence of admitted acts in its log: claim, renew, release, contest,
 * break. Every record a host serves was judged by the store's kernel before it committed, so the
 * holder of a subject at any instant is a FOLD over those records in log order, never a second
 * judgement: a claim sets the holder, a renew moves its fence and expiry, a release or a break
 * drops it, a contest names the holder it found and changes nothing, and an expired lease is no
 * holder (it stays stored, "lapsed", until a claim replaces it, exactly as the store keeps it).
 * test/board-read.test.mjs runs seeded random acts through the real store and requires this fold
 * to equal `store.board()` and every contest receipt at every step.
 *
 * The board names accounts, not sessions: every session on a seat shares the seat's account. Who
 * claimed is read off the room: `post --claim <s>` commits the board claim, then the message that
 * carries `claim: <s>`, signed by its bearer. `claimAuthors` joins the two.
 *
 * `resolveAddress` answers what a `to:` names on this seat, from the session records (positions
 * and bearers), the room's own authors (humans, and agents of other accounts), and the posted
 * ledgers (a renamed session still owns the ids it posted under its old name). It never reads a
 * verdict it cannot attest: a live process is `unknown`, a gone one is `absent`.
 */

import { AgoraError, EXIT } from "./core.mjs";
import { asBoardSubject } from "./board-subject.mjs";
import { parseNativeCursor } from "./native-protocol.mjs";
import { matchesAddress, parseTrailers } from "./trailers.mjs";
import { positionOf } from "./session.mjs";

/**
 * @typedef {{ accountId: string, cursor: string, leaseId: string, fence: string, expiresAt: string, leaseMs: number }} Holder
 * @typedef {{ cursor: string, accountId: string, because: string | null, held: boolean, holder: { accountId: string, cursor: string, expiresAt: string } | null }} Contest
 * @typedef {{ cursor: string, accountId: string, actor: any, dropped: { accountId: string, cursor: string, expiresAt: string } | null }} Break
 * @typedef {{ subject: string, holder: Holder | null, lapsed: Holder | null, claimedAt: string | null, contests: Contest[], breaks: Break[], last: string }} SubjectState
 * @typedef {{ through: string | null, subjects: SubjectState[] }} BoardFold
 */

/** The record's sequence. @param {string} cursor */
const seqOf = (cursor) => parseNativeCursor(cursor).sequence;

/** The default a store applies when a claim record carries no lease length. */
const DEFAULT_LEASE_MS = 3_600_000;
const MISSING_EXPIRY = "1970-01-01T00:00:00.000Z";

/**
 * Fold the board records (log order) at an instant. `now` decides only which stored holder is
 * live; the records decide everything else.
 * @param {any[]} records @param {number} now epoch milliseconds
 * @returns {BoardFold}
 */
export function foldBoard(records, now) {
  /** @typedef {{ stored: Holder | null, claimedAt: string | null, contests: Contest[], breaks: Break[], last: string }} Folding */
  /** @type {Map<string, Folding>} */
  const subjects = new Map();
  /** @type {string | null} */
  let through = null;
  const live = (/** @type {Holder | null} */ h) => h !== null && Date.parse(h.expiresAt) > now;
  for (const r of records) {
    const board = r?.board;
    if (!board || typeof board.subject !== "string" || typeof r.cursor !== "string") continue;
    through = r.cursor;
    /** @type {Folding} */
    const s = subjects.get(board.subject) ?? { stored: null, claimedAt: null, contests: [], breaks: [], last: r.cursor };
    subjects.set(board.subject, s);
    s.last = r.cursor;
    if (board.action === "claim") {
      s.stored = { accountId: r.accountId, cursor: r.cursor, leaseId: r.operationId, fence: r.cursor,
        expiresAt: r.expiresAt ?? MISSING_EXPIRY, leaseMs: r.leaseMs ?? DEFAULT_LEASE_MS };
      s.claimedAt = r.cursor;
    } else if (board.action === "renew") {
      if (s.stored) s.stored = { ...s.stored, cursor: r.cursor, fence: r.cursor, expiresAt: r.expiresAt ?? s.stored.expiresAt, leaseMs: r.leaseMs ?? s.stored.leaseMs };
    } else if (board.action === "release") {
      s.stored = null;
    } else if (board.action === "break") {
      s.breaks.push({ cursor: r.cursor, accountId: r.accountId, actor: r.actor ?? null, dropped: r.broken ?? null });
      s.stored = null;
    } else if (board.action === "contest") {
      // the receipt's `held` is the liveness at the contest's own instant, which the log does not
      // carry; the fold gives the stored holder it named and the caller judges `held` at its `now`
      const h = s.stored;
      s.contests.push({ cursor: r.cursor, accountId: r.accountId, because: typeof board.because === "string" ? board.because : null,
        held: live(h), holder: h ? { accountId: h.accountId, cursor: h.cursor, expiresAt: h.expiresAt } : null });
    }
  }
  return {
    through,
    subjects: [...subjects.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([subject, s]) => ({
      subject, holder: live(s.stored) ? s.stored : null, lapsed: s.stored && !live(s.stored) ? s.stored : null,
      claimedAt: s.claimedAt, contests: s.contests, breaks: s.breaks, last: s.last,
    })),
  };
}

/** The live holders as `store.board()` lists them. @param {BoardFold} fold */
export function liveHolders(fold) {
  return fold.subjects.filter((s) => s.holder).map((s) => ({ subject: s.subject, .../** @type {Holder} */ (s.holder) }));
}

/**
 * Who claimed: for each subject's claim (live or lapsed), the first message after it, from the
 * same account, that carries a `claim:` trailer naming the subject. That message's bearer and
 * thread are the claim's.
 * @param {BoardFold} fold @param {any[]} messages the room read, ascending
 * @returns {Map<string, { bearer: string, id: string, cursor: string, root: string }>} by subject
 */
export function claimAuthors(fold, messages) {
  const out = new Map();
  for (const s of fold.subjects) {
    const h = s.holder ?? s.lapsed;
    if (!h) continue;
    const from = seqOf(s.claimedAt ?? h.cursor);
    for (const m of messages) {
      if (seqOf(m.cursor) <= from || m.author?.id !== h.accountId) continue;
      const claims = parseTrailers(String(m.text ?? "")).trailers.filter((t) => t.key === "claim");
      if (!claims.some((t) => safeSubject(t.value) === s.subject)) continue;
      out.set(s.subject, { bearer: m.signedAs ?? m.author?.name ?? "unknown", id: m.id, cursor: m.cursor, root: m.thread ?? m.id });
      break;
    }
  }
  return out;
}

/** The board subject a trailer value names, or undefined when it names none. @param {string} value */
export function safeSubject(value) {
  try { return asBoardSubject(value); } catch { return undefined; }
}

/**
 * Read a room's board through its transport: native and native-remote rooms only.
 * @param {any} transport
 */
export async function readBoard(transport) {
  if (typeof transport?.boardRead !== "function")
    throw new AgoraError(`board belongs to a native room; this is a ${transport?.kind ?? "unknown"} room, which has no board`, EXIT.usage);
  return /** @type {Promise<{ records: any[], holders: any[], checkpoint: any }>} */ (transport.boardRead());
}

// ---------------------------------------------------------------------------------------------
// Resolve
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {{ slug: string, record: import('./session.mjs').SessionRecord | undefined, state: 'live' | 'gone' | 'unknown' | 'unregistered', posted?: Set<string> }} SeatRecord
 * @typedef {{ seat: string, position: string | null, role: string, model: string | null, bearer: string, session: string | null, process: 'live' | 'gone' | 'unknown' | 'foreign', verdict: 'unknown' | 'absent' }} ResolvedHolder
 * @typedef {{ type: 'resolve', address: string, kind: 'person' | 'seat' | 'role' | 'position' | 'everyone' | 'none', holders: ResolvedHolder[], context: 'local' | 'room-only', why?: 'retired' | 'half-name' | 'unknown', nearest?: string | null }} Resolution
 * @typedef {{ seatName: string, accountId: string | null, records: SeatRecord[] | null, messages: any[] }} ResolveContext
 */

/** A position's role: its last segment. @param {string} position */
const roleOfPosition = (position) => position.split(".").pop() ?? position;

/** @param {SeatRecord} r @param {string} seatName @returns {ResolvedHolder} */
function localHolder(r, seatName) {
  const rec = /** @type {import('./session.mjs').SessionRecord} */ (r.record);
  const position = positionOf(rec) ?? null;
  const segs = rec.bearer.split("/");
  return {
    seat: seatName, position, role: position ? roleOfPosition(position) : segs[0], model: segs.length > 1 ? segs[segs.length - 1] : null,
    bearer: rec.bearer, session: r.slug, process: r.state === "live" ? "live" : r.state === "gone" ? "gone" : "unknown",
    verdict: r.state === "gone" ? "absent" : "unknown",
  };
}

/**
 * Does an address name this holder? The shared matcher (`matchesAddress`): a position matches
 * exactly, or by its role (last segment) when the address is one segment; a bearer matches by
 * segment prefix (`coding` reaches `coding/Opus`), never half a segment.
 * @param {string} address @param {{ position: string | null, bearer: string }} h
 */
function names(address, h) {
  return matchesAddress(address, h.bearer, undefined, h.position);
}

/**
 * What an address names. Seat context: the session records under this state root (`records`
 * null means none could be read, and the answer is `room-only`).
 * @param {string} address @param {ResolveContext} ctx
 * @returns {Resolution}
 */
export function resolveAddress(address, ctx) {
  const a = address.trim();
  const lower = a.toLowerCase();
  const context = ctx.records ? "local" : "room-only";
  const records = (ctx.records ?? []).filter((r) => r.record && typeof r.record.bearer === "string");
  const present = records.filter((r) => r.state !== "gone").map((r) => localHolder(r, ctx.seatName));
  const base = { type: /** @type {const} */ ("resolve"), address: a, context: /** @type {'local' | 'room-only'} */ (context) };
  if (a === "*") return { ...base, kind: "everyone", holders: present };
  if (ctx.seatName && lower === ctx.seatName.toLowerCase()) return { ...base, kind: "seat", holders: present };
  const humans = new Set(ctx.messages.filter((m) => m.author?.kind === "human").map((m) => String(m.author.name).toLowerCase()));
  if (humans.has(lower)) return { ...base, kind: "person", holders: [] };
  const kindOf = /** @returns {'role' | 'position'} */ () => (a.includes(".") || a.includes("/") ? "position" : "role");
  const matched = present.filter((h) => names(a, h));
  if (matched.length) return { ...base, kind: kindOf(), holders: matched };
  // a bearer that posted here from another account: a holder on another seat, never pinged
  const foreign = new Map();
  for (const m of ctx.messages) {
    if (m.author?.kind === "human" || !m.author?.id || m.author.id === ctx.accountId) continue;
    const bearer = m.signedAs ?? m.author.name;
    if (typeof bearer === "string" && matchesAddress(a, bearer)) foreign.set(bearer, m.author.id);
  }
  if (foreign.size) return { ...base, kind: kindOf(), holders: [...foreign].map(([bearer, seat]) => {
    const segs = bearer.split("/");
    return { seat, position: null, role: segs[0], model: segs.length > 1 ? segs[segs.length - 1] : null, bearer, session: null, process: /** @type {const} */ ("foreign"), verdict: /** @type {const} */ ("unknown") };
  }) };
  // none here: say why, and the nearest live holder when one can be shown
  const gone = records.filter((r) => r.state === "gone").map((r) => localHolder(r, ctx.seatName)).filter((h) => names(a, h));
  const signedHere = ctx.messages.filter((m) => m.author?.kind !== "human" && (!ctx.accountId || m.author?.id === ctx.accountId)
    && typeof (m.signedAs ?? m.author?.name) === "string" && matchesAddress(a, m.signedAs ?? m.author.name));
  if (gone.length || signedHere.length) {
    // the session that posted under the old name, if one is live: its name now is the nearest
    const ids = new Set(signedHere.map((m) => m.id));
    const owner = records.find((r) => r.state !== "gone" && r.posted && [...ids].some((id) => r.posted?.has(id)));
    const successor = gone.map((g) => g.position).filter(Boolean).map((p) => present.find((h) => h.position === p)).find(Boolean);
    const near = owner ? localHolder(owner, ctx.seatName) : successor;
    return { ...base, kind: "none", holders: [], why: "retired", nearest: near ? near.position ?? near.bearer : null };
  }
  const half = present.find((h) => [...(h.position ? h.position.split(".") : []), ...h.bearer.toLowerCase().split("/")]
    .some((seg) => seg.length > lower.length && seg.startsWith(lower)));
  if (half) return { ...base, kind: "none", holders: [], why: "half-name", nearest: half.position ?? half.bearer };
  return { ...base, kind: "none", holders: [], why: "unknown", nearest: oneEditFrom(lower, present) };
}

/**
 * The live holder an unknown address is one letter off (one letter dropped, added or changed) in its
 * position, its role, its bearer or the bearer's first segment: that holder's name; `ambiguous` when
 * two holders are, so a typo is never answered with a guess; null when none is, or the address is
 * under three letters (every short name is one letter from another).
 * @param {string} lower the address, lower case @param {ResolvedHolder[]} present
 * @returns {string | null}
 */
function oneEditFrom(lower, present) {
  if (lower.length < 3) return null;
  const near = new Set();
  for (const h of present) {
    const bearer = h.bearer.toLowerCase();
    const names = [h.position, h.position ? roleOfPosition(h.position) : null, bearer, bearer.split("/")[0]];
    if (names.some((n) => n && n.length >= 3 && oneEdit(lower, n))) near.add(h.position ?? h.bearer);
  }
  return near.size === 1 ? [...near][0] : near.size > 1 ? "ambiguous" : null;
}

/** Are two different strings exactly one insertion, deletion or substitution apart? @param {string} a @param {string} b */
export function oneEdit(a, b) {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0;
  while (i < s.length && s[i] === l[i]) i++;
  return s.length === l.length ? s.slice(i + 1) === l.slice(i + 1) : s.slice(i) === l.slice(i + 1);
}
