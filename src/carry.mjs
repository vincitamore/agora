// @ts-check
import { cursorKey, readCursorFile } from "./core.mjs";
import { readFollow } from "./follow.mjs";
import { armedAlive, readArmed, sessionScope } from "./session.mjs";
import { matchesAddress, parseTrailers } from "./trailers.mjs";

/**
 * What a session hands to whoever holds the seat after it -- across a compaction, or to a
 * successor session that inherits its state.
 *
 * Everything here is DERIVED AT CALL TIME and nothing is stored: the session directory's own
 * files (positions, follow set, armed registrations) and one bounded read of the room folded
 * against this session's posted ledger. There is no carry file, no "what I owe" record and no
 * settled state; a second call a minute later re-derives the same answer from the same sources,
 * and a call that is never made costs nothing. That is the whole reason the keep-list is a verb
 * rather than a file: a maintained handover record is state the tool would have to keep true,
 * and what only vigilance keeps true is already drifting.
 *
 * Message text is never summarised, quoted or paraphrased. A commitment is named by its trailer
 * value and located by its message id and cursor; a successor that wants the words runs `read`.
 */

/** @typedef {import('./core.mjs').Message} Message */

/**
 * The positions, follow set and armed watches this session holds in one room, off the files that
 * already exist.
 *
 * `readCursorFile`, never `readCursorSeeded`: the seeded read WRITES the shared position forward
 * into the session directory, and carry writes nothing. When this session has no position of its
 * own the shared file is reported as `seedFrom` instead, which is what the next watch would pick
 * up, said out loud rather than performed.
 * @param {string} dir the session directory
 * @param {string} stateRoot
 * @param {string} alias
 */
export async function carryState(dir, stateRoot, alias) {
  const key = cursorKey(alias);
  const scope = await sessionScope(dir);
  const mine = (/** @type {string} */ k) => k === key || k.startsWith(`${key}#`);

  const own = await readCursorFile(dir, key);
  const seed = own.exists ? { exists: false, cursor: undefined } : await readCursorFile(stateRoot, key);
  const follow = await readFollow(dir, key);

  /** @type {Array<{ thread: string, key: string, cursor: string | null, lastActivity: string | null, followed: boolean }>} */
  const threads = [];
  for (const [id, at] of Object.entries(follow.threads)) {
    const tk = cursorKey(alias, id);
    threads.push({ thread: id, key: tk, cursor: (await readCursorFile(dir, tk)).cursor ?? null, lastActivity: at, followed: true });
  }
  // a thread this session still has a position for but no longer follows is where a successor
  // resumes if it re-enters that thread, so it is carried too, marked as left
  for (const k of scope.rooms) {
    if (!mine(k) || k === key || threads.some((t) => t.key === k)) continue;
    threads.push({ thread: k.slice(key.length + 1), key: k, cursor: (await readCursorFile(dir, k)).cursor ?? null, lastActivity: null, followed: false });
  }
  threads.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  /** @type {Array<{ key: string, thread: string | null, mode: string | null, pid: number, since: string | null, startedAt: string | null, alive: boolean }>} */
  const armed = [];
  for (const a of scope.armed) {
    if (!mine(a.key)) continue;
    const rec = await readArmed(dir, a.key);
    if (!rec) continue;
    armed.push({
      key: a.key,
      thread: rec.thread ?? null,
      mode: rec.mode ?? null,
      pid: rec.pid,
      since: rec.since ?? null,
      startedAt: rec.startedAt ?? null,
      alive: armedAlive(rec),
    });
  }

  return {
    cursor: own.cursor ?? null,
    cursorKey: key,
    seedFrom: seed.exists ? seed.cursor ?? null : undefined,
    threads,
    follow: { threads: follow.threads, ...(follow.aliases ? { aliases: follow.aliases } : {}) },
    armed,
  };
}

/** @typedef {{ id: string, cursor: string, ts: string, thread?: string }} Ref */

/**
 * The commitments this session made in the window, and what it has not answered.
 *
 * **Reading the trailers on THIS SESSION'S OWN POSTS is not "parse-and-act on an incoming
 * trailer".** The standing prohibition is against a counterpart's trailer steering this side's
 * process -- routing, waking, filtering or suppressing on a block someone else wrote. Every block
 * folded here into `claims`, `releases`, `verdicts` and `obligations` was written by the reader
 * asking for it: the ledger is the filter, so a message is in that set if and only if this session
 * posted it. Nothing is routed, woken, filtered or suppressed either way. `owed` does read an
 * incoming `to:`, and it renders it: the addresses are printed as they were written, this verb
 * runs only because the reader ran it, and no delivery, cursor or wake changes because of what it
 * found -- the same line `read` has always drawn under an incoming block.
 * @param {Message[]} msgs the window, ascending
 * @param {Set<string>} posted this session's ledger
 * @param {{ bearer: string, seat?: { id?: string, name?: string } }} who
 */
export function foldRoom(msgs, posted, who) {
  /** @type {Array<Ref & { subject: string }>} */
  const claims = [];
  /** @type {Array<Ref & { subject: string }>} */
  const releases = [];
  /** @type {Array<Ref & { verdict: string, exhibits: string[] }>} */
  const verdicts = [];
  /** @type {Array<Ref & { to: string[] }>} */
  const obligations = [];

  let lastOwn = -1;
  for (const [i, m] of msgs.entries()) {
    if (!posted.has(m.id)) continue;
    lastOwn = i;
    const { trailers, to } = parseTrailers(m.text);
    if (!trailers.length) continue;
    /** @type {Ref} */
    const ref = { id: m.id, cursor: m.cursor, ts: m.ts, ...(m.thread ? { thread: m.thread } : {}) };
    const exhibits = trailers.filter((t) => t.key === "exhibit").map((t) => t.value);
    for (const t of trailers) {
      if (t.key === "claim") claims.push({ subject: t.value, ...ref });
      else if (t.key === "release") releases.push({ subject: t.value, ...ref });
      else if (t.key === "verdict") verdicts.push({ verdict: t.value, exhibits, ...ref });
    }
    if (to.length) obligations.push({ to, ...ref });
  }

  // A retraction is carried beside the open claims and never merely subtracted from them: a
  // successor that sees only the survivors cannot tell a subject that was withdrawn from one that
  // was never claimed, and re-claiming a withdrawn subject is the failure this list prevents.
  const released = new Set(releases.map((r) => r.subject));
  /** @type {Array<Ref & { subject: string }>} */
  const open = [];
  for (const c of claims) {
    // the earliest claim on a subject is the one that holds, and the window is ascending
    if (released.has(c.subject) || open.some((o) => o.subject === c.subject)) continue;
    open.push(c);
  }

  /**
   * Deliveries owing a receipt: a message addressed to this bearer that arrived after the last
   * thing this session posted here. With nothing of this session's own in the window, every
   * addressed message in it is owed -- an empty answer would be a claim about a horizon this read
   * cannot see.
   * @type {Array<Ref & { from: string, to: string[] }>}
   */
  const owed = [];
  for (const m of msgs.slice(lastOwn + 1)) {
    if (posted.has(m.id)) continue;
    const { to } = parseTrailers(m.text);
    if (!to.some((a) => matchesAddress(a, who.bearer, who.seat))) continue;
    owed.push({ from: m.signedAs ?? m.author.name, to, id: m.id, cursor: m.cursor, ts: m.ts, ...(m.thread ? { thread: m.thread } : {}) });
  }

  return {
    claims: open,
    releases,
    verdicts,
    obligations,
    owed,
    horizon: {
      messages: msgs.length,
      own: msgs.filter((m) => posted.has(m.id)).length,
      oldest: msgs[0]?.ts ?? null,
      newest: msgs.at(-1)?.ts ?? null,
      lastOwn: lastOwn >= 0 ? { id: msgs[lastOwn].id, cursor: msgs[lastOwn].cursor, ts: msgs[lastOwn].ts } : null,
    },
  };
}

/** @typedef {ReturnType<typeof foldRoom> & Awaited<ReturnType<typeof carryState>> & Record<string, any>} Carry */

/**
 * The readable rendering: the same fields, one per line, in the order a successor needs them --
 * who it is, where it is reading from, what it holds, what it owes. No message text appears here
 * either; an id and a cursor are what `read` takes.
 * @param {Record<string, any>} c
 */
export function renderCarry(c) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} label @param {string} value */
  const row = (label, value) => out.push(`${label.padEnd(12)}${value}`);
  const seat = c.seat ?? {};
  out.push(`carry ${c.room?.alias} (${c.room?.transport} ${c.room?.room}) as ${c.bearer?.name} · session ${c.session?.slug}`);
  row("bearer", `${c.bearer?.name} (from ${c.bearer?.source})`);
  row("session", `${c.session?.slug} (from ${c.session?.source})${c.session?.registered ? "" : "  (unregistered)"}`);
  row("seat", seat.name ? `${seat.name}${seat.id ? ` (${seat.id})` : ""}` : "not asked (the transport could not say)");
  if (c.room?.note) row("lane", String(c.room.note));
  row("cursor", `${c.cursorKey}: ${c.cursor ?? "(none: a watch would read from the start)"}${c.seedFrom !== undefined ? `  would seed from the shared cursor ${c.seedFrom ?? "(from the start)"}` : ""}`);
  for (const t of c.threads ?? [])
    row("thread", `${t.thread}: ${t.cursor ?? "(none)"}${t.followed ? "" : "  (left the follow set)"}${t.lastActivity ? `  last activity ${t.lastActivity}` : ""}`);
  for (const [id, root] of Object.entries(c.follow?.aliases ?? {})) row("alias", `${id} is another name for ${root}`);
  for (const a of c.armed ?? []) row("armed", `${a.key}  ${a.mode ?? "watch"}  pid ${a.pid}  ${a.alive ? "live" : "gone"}${a.since ? `  since ${a.since}` : ""}`);
  for (const x of c.claims ?? []) row("claim", `${x.subject}   ${x.id} cursor ${x.cursor}`);
  for (const x of c.releases ?? []) row("release", `${x.subject}   ${x.id} cursor ${x.cursor}`);
  for (const x of c.verdicts ?? []) row("verdict", `${x.verdict}${x.exhibits.length ? `   exhibit: ${x.exhibits.join(" | ")}` : ""}   ${x.id} cursor ${x.cursor}`);
  for (const x of c.obligations ?? []) row("to", `${x.to.join(", ")}   ${x.id} cursor ${x.cursor}`);
  for (const x of c.owed ?? []) row("owed", `from ${x.from} to ${x.to.join(", ")}   ${x.id} cursor ${x.cursor}`);
  const h = c.horizon ?? {};
  out.push("");
  out.push(`read ${h.messages ?? 0} message${h.messages === 1 ? "" : "s"} back to ${h.oldest ?? "nothing"}; ${h.own ?? 0} of this session's own. Nothing here is stored: this is derived at the call and re-derived at the next one.`);
  return out.join("\n");
}
