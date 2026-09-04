// @ts-check
import { cursorKey, readCursorFile, redact } from "./core.mjs";
import { readFollow } from "./follow.mjs";
import { armedAlive, readArmed, sessionScope } from "./session.mjs";
import { after, boundedRoots, mergeAscending } from "./threads.mjs";
import { matchesAddress, parseTrailers } from "./trailers.mjs";

/**
 * What a session hands to whoever holds the seat after it -- across a compaction, or to a
 * successor session that inherits its state.
 *
 * Everything here is DERIVED AT CALL TIME and nothing is stored: the session directory's own
 * files (positions, follow set, armed registrations) and one bounded read of the room, its live
 * threads folded in, read against this session's posted ledger. There is no carry file, no "what
 * I owe" record and no settled state; a second call a minute later re-derives the same answer
 * from the same sources, and a call that is never made costs nothing. That is the whole reason
 * the keep-list is a verb rather than a file: a maintained handover record is state the tool
 * would have to keep true, and what only vigilance keeps true is already drifting.
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
 * The window `carry` folds: one bounded read of the room with no cursor, with the replies its live
 * threads gained folded in by time, exactly as `read --threads` does and bounded the same way.
 *
 * The fold is not optional here, the way it is on `read`. On a transport whose room read never
 * returns replies, a `release:` posted as a thread reply is simply absent from a plain room read,
 * and the envelope then reports as open a claim this session let go of ninety minutes ago -- a
 * successor that believes it and re-claims a subject nobody holds. `read` may be cheap and partial
 * because a reader can always run it again; a handover has one shot. `--no-threads` is there for
 * the room read alone, and it is the caller saying it will accept that.
 *
 * Nothing here writes. The room read takes no cursor and the thread reads take none either, so
 * neither this session's position nor the shared one moves.
 *
 * **One thread that cannot be read is not a failed handover.** The threads are read one at a
 * time and a read that throws is recorded in `threadsUnread` rather than thrown on: a busy room
 * rate-limits one `conversations.replies` out of eighteen, and a carry that propagated that
 * exited non-zero with an empty envelope -- a successor asking what it holds got nothing at all,
 * on exactly the room busy enough to need the answer, while a watch on the same call in the same
 * process degraded and kept going. `--no-threads` was the only way through and it silently drops
 * the fold, which is the defect the fold exists to prevent. So the room read is the one failure
 * that is fatal here; every thread is either folded or named as missing, and the envelope always
 * comes. The reason is carried verbatim so the reader can tell a thread that was rate-limited
 * (read it again in a minute) from one that is gone (`thread_not_found`) without guessing.
 *
 * No retry is added on top of the transport's own. Slack already retries a 429 four times behind
 * a jittered wait, and a second loop out here would multiply that into a herd against the limit
 * that produced it.
 * @param {{ threads: boolean, read: (o: import('./core.mjs').ReadOptions) => Promise<Message[]>, validateThread?: (id: string) => string | undefined }} transport
 * @param {{ limit?: number, thread?: string, threads?: boolean, cap?: number }} [opts]
 * @returns {Promise<{ messages: Message[], threads: string[], threadsUnread: Array<{ id: string, reason: string }> }>}
 */
export async function carryWindow(transport, opts = {}) {
  const limit = opts.limit ?? 200;
  const messages = await transport.read({ ...(opts.thread ? { thread: opts.thread } : {}), limit });
  // a read already narrowed to one thread cannot fold itself in, and a transport with no threads
  // has nothing to fold: in both cases the room read is the whole window
  if (opts.threads === false || opts.thread || !transport.threads) return { messages, threads: [], threadsUnread: [] };
  // bounded exactly as `read --threads` bounds it, then ordered by what moved last: when the cap
  // or the rate limit cuts the fold short, the threads a handover most needs are the ones already in
  const roots = byLastActivity(boundedRoots(messages, messages, opts.cap === undefined ? {} : { cap: opts.cap }), messages);
  /** @type {Message[][]} */
  const replies = [];
  /** @type {string[]} */
  const threads = [];
  /** @type {Array<{ id: string, reason: string }>} */
  const threadsUnread = [];
  for (const id of roots) {
    // a mangled id (an unquoted Slack ts loses its last digits under pwsh) is a thread this read
    // cannot reach, which is the same fact as a read that failed -- named, never thrown
    const bad = transport.validateThread?.(id);
    if (bad) {
      threadsUnread.push({ id, reason: redact(bad) });
      continue;
    }
    try {
      replies.push(await transport.read({ thread: id, since: undefined }));
      threads.push(id);
    } catch (err) {
      threadsUnread.push({ id, reason: redact(err instanceof Error ? err.message : String(err)) });
    }
  }
  return { messages: mergeAscending(messages, ...replies), threads, threadsUnread };
}

/**
 * The same roots, newest activity first.
 *
 * A thread's activity is the newest cursor the window has for it: its parent's `latest_reply`
 * where the transport reports one, and any reply of its own already in the window. Reading in
 * that order is what makes a short fold the useful half rather than an arbitrary one -- the
 * release posted twenty minutes ago is folded before the thread that has been quiet since
 * Tuesday, so an envelope cut short by a rate limit is still cut at the least costly place.
 * @param {string[]} roots
 * @param {Message[]} msgs
 * @returns {string[]}
 */
function byLastActivity(roots, msgs) {
  /** @type {Map<string, string>} */
  const at = new Map();
  const want = new Set(roots);
  for (const m of msgs) {
    const root = m.thread && m.thread !== m.id ? m.thread : m.id;
    if (!want.has(root)) continue;
    const raw = /** @type {Record<string, unknown>} */ (m.raw ?? {});
    for (const v of [m.cursor, raw.latest_reply]) {
      if (v === undefined || v === null) continue;
      const prev = at.get(root);
      if (prev === undefined || after(String(v), prev)) at.set(root, String(v));
    }
  }
  /** @param {string} id */
  const key = (id) => at.get(id) ?? "";
  // stable: two threads the window cannot tell apart keep the order the bounding gave them
  return [...roots].sort((a, b) => (after(key(a), key(b)) ? -1 : after(key(b), key(a)) ? 1 : 0));
}

/**
 * The conversation a message sits in: the thread it is a reply in, or the room itself. A Slack
 * parent names its own id as its thread, which is the root of a thread rather than a reply in one,
 * so it belongs to the room. The empty string is the room because no transport has a thread by
 * that name.
 */
const ROOM_LANE = "";

/** @param {Message} m */
function lane(m) {
  return m.thread && m.thread !== m.id ? m.thread : ROOM_LANE;
}

/** A trailer value naming messages: one id, or several separated by commas. @param {string} v */
function namedIds(v) {
  /** @type {string[]} */
  const out = [];
  for (const one of v.split(",")) {
    const id = one.trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * The commitments this session made in the window, which of them still stand, and what it has not
 * answered.
 *
 * **Reading the trailers on THIS SESSION'S OWN POSTS is not "parse-and-act on an incoming
 * trailer".** The standing prohibition is against a counterpart's trailer steering this side's
 * process -- routing, waking, filtering or suppressing on a block someone else wrote. Every block
 * folded here into `claims`, `releases`, `verdicts`, `superseded` and `obligations` was written by
 * the reader asking for it: the ledger is the filter, so a message is in that set if and only if
 * this session posted it, and the `re:` that supersedes a verdict or clears a delivery is this
 * session's own on this session's own post, as is the `withdraws:` that takes one back. Nothing
 * is routed, woken, filtered or suppressed either way. `owed` does read an incoming `to:`, and
 * it renders it: the addresses are printed as they were written, this verb runs only because the
 * reader ran it, and no delivery, cursor or wake changes because of what it found -- the same
 * line `read` has always drawn under an incoming block.
 * @param {Message[]} msgs the window, ascending
 * @param {Set<string>} posted this session's ledger
 * @param {{ bearer: string, seat?: { id?: string, name?: string } }} who
 */
export function foldRoom(msgs, posted, who) {
  /** @type {Array<Ref & { subject: string }>} */
  const releases = [];
  /** @type {Array<Ref & { verdict: string, exhibits: string[] }>} */
  const verdicts = [];
  /** @type {Array<Ref & { verdict: string, exhibits: string[], supersededBy: string }>} */
  const superseded = [];
  /** @type {Array<Ref & { to: string[] }>} */
  const obligations = [];

  /**
   * A subject is open from the claim that took it until the release that handed it back, and a
   * claim after a release takes it again: a subject released at noon and re-claimed at one is
   * held, and the claim that holds it is the earliest one after the last release rather than the
   * first one ever posted. The map is that state -- set on a claim only when the subject is not
   * already open, deleted on a release -- so its insertion order is the order the standing claims
   * were taken.
   * @type {Map<string, Ref & { subject: string }>}
   */
  const openClaims = new Map();
  /**
   * What each of this session's own posts claimed, under its id and under its cursor, so a later
   * `withdraws:` naming that post by either can hand the same subjects back. Only posts already
   * read are in it, which is what makes a withdrawal name an EARLIER post of this session's own.
   * @type {Map<string, string[]>}
   */
  const claimedBy = new Map();
  /** ids this session named in a `re:` on a post of its own @type {Set<string>} */
  const answered = new Set();
  /** lane -> index of this session's newest own post in it @type {Map<string, number>} */
  const spokeIn = new Map();

  let lastOwn = -1;
  for (const [i, m] of msgs.entries()) {
    if (!posted.has(m.id)) continue;
    lastOwn = i;
    spokeIn.set(lane(m), i);
    const { trailers, to } = parseTrailers(m.text);
    if (!trailers.length) continue;
    /** @type {Ref} */
    const ref = { id: m.id, cursor: m.cursor, ts: m.ts, ...(m.thread ? { thread: m.thread } : {}) };
    const exhibits = trailers.filter((t) => t.key === "exhibit").map((t) => t.value);
    /** the messages this post answers, by id */
    const answers = trailers.filter((t) => t.key === "re").flatMap((t) => namedIds(t.value));
    for (const id of answers) answered.add(id);
    /** the messages this post takes back, by id or cursor */
    const withdrawn = trailers.filter((t) => t.key === "withdraws").flatMap((t) => namedIds(t.value));
    // A `withdraws:` is the first-class retraction, and it is resolved before this message's own
    // trailers because it is about the earlier ones: whatever the named post committed stops being
    // committed, whether or not this post commits anything in its place. Measured on a live room:
    // across twenty-two verdicts over one day and four bearers, not one carried a `re:` naming the
    // verdict it withdrew, so supersession never fired at all and a withdrawn verdict sat beside
    // the one that withdrew it. A link that depends on remembering a second flag while being wrong
    // about something is a link nobody makes, so the retraction is a flag of its own.
    for (const id of withdrawn) {
      const at = verdicts.findIndex((v) => v.id === id || v.cursor === id);
      if (at >= 0) superseded.push({ ...verdicts.splice(at, 1)[0], supersededBy: m.id });
      // withdrawing the post that took a subject hands the subject back, exactly as a `release:`
      // does, and is carried in the same list so a successor sees the retraction rather than a gap
      for (const subject of claimedBy.get(id) ?? []) {
        releases.push({ subject, ...ref });
        openClaims.delete(subject);
      }
    }
    /** @type {string[]} */
    const claimedHere = [];
    for (const t of trailers) {
      if (t.key === "claim") {
        claimedHere.push(t.value);
        if (!openClaims.has(t.value)) openClaims.set(t.value, { subject: t.value, ...ref });
      } else if (t.key === "release") {
        releases.push({ subject: t.value, ...ref });
        openClaims.delete(t.value);
      } else if (t.key === "verdict") {
        // A retraction is also a verdict answering an earlier verdict of this session's own: what
        // it names stops being what this session says and becomes what it said. It is moved, never
        // dropped -- a successor that saw only the survivor could not tell a verdict that was
        // withdrawn from one that was never posted, and would go looking for its exhibit again.
        // `withdraws:` above is the same move said outright; this one stays for the block that
        // says it by answering.
        for (const id of answers) {
          const at = verdicts.findIndex((v) => v.id === id || v.cursor === id);
          if (at >= 0) superseded.push({ ...verdicts.splice(at, 1)[0], supersededBy: m.id });
        }
        verdicts.push({ verdict: t.value, exhibits, ...ref });
      }
    }
    // under both names a later `withdraws:` may use: an agent that read the cursor off `post`
    // should not have to translate it into an id before it can take the claim back
    if (claimedHere.length) for (const name of [m.id, m.cursor]) claimedBy.set(name, claimedHere);
    if (to.length) obligations.push({ to, ...ref });
  }

  /**
   * Deliveries owing a receipt: a message this session did not post, addressed to this bearer,
   * that this session has not spoken after in the same conversation and has not answered by name.
   *
   * The lane matters on a transport with threads. A room read is not one conversation there, and a
   * top-level post is no receipt for a question asked in a thread four hours earlier: each thread
   * is cut at this session's own newest post in that thread, the room at its own newest top-level
   * post. A `re:` naming the message is the explicit form of the same receipt and reaches across
   * lanes, since an answer by name is an answer wherever it was posted.
   *
   * This is what arrived and is unanswered, never what this session addressed to someone else --
   * that is `obligations`, and computing this from those `to:` lines is how a seat owing a receipt
   * from four minutes ago reported nothing owed at all.
   * @type {Array<Ref & { from: string, to: string[] }>}
   */
  const owed = [];
  for (const [i, m] of msgs.entries()) {
    if (posted.has(m.id) || answered.has(m.id)) continue;
    if ((spokeIn.get(lane(m)) ?? -1) > i) continue;
    const { to } = parseTrailers(m.text);
    if (!to.some((a) => matchesAddress(a, who.bearer, who.seat))) continue;
    owed.push({ from: m.signedAs ?? m.author.name, to, id: m.id, cursor: m.cursor, ts: m.ts, ...(m.thread ? { thread: m.thread } : {}) });
  }

  return {
    claims: [...openClaims.values()],
    releases,
    verdicts,
    superseded,
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
  // named, never silently absent: a thread missing from the fold is a hole in the window every
  // list below is computed from, and a successor has to know which hole before it trusts them
  for (const u of c.threadsUnread ?? []) row("unread", `${u.id}: ${u.reason}`);
  for (const [id, root] of Object.entries(c.follow?.aliases ?? {})) row("alias", `${id} is another name for ${root}`);
  for (const a of c.armed ?? []) row("armed", `${a.key}  ${a.mode ?? "watch"}  pid ${a.pid}  ${a.alive ? "live" : "gone"}${a.since ? `  since ${a.since}` : ""}`);
  for (const x of c.claims ?? []) row("claim", `${x.subject}   ${x.id} cursor ${x.cursor}`);
  for (const x of c.releases ?? []) row("release", `${x.subject}   ${x.id} cursor ${x.cursor}`);
  for (const x of c.verdicts ?? []) row("verdict", `${x.verdict}${x.exhibits.length ? `   exhibit: ${x.exhibits.join(" | ")}` : ""}   ${x.id} cursor ${x.cursor}`);
  for (const x of c.superseded ?? []) row("superseded", `${x.verdict}   ${x.id} cursor ${x.cursor}, withdrawn by ${x.supersededBy}`);
  for (const x of c.obligations ?? []) row("to", `${x.to.join(", ")}   ${x.id} cursor ${x.cursor}`);
  for (const x of c.owed ?? []) row("owed", `from ${x.from} to ${x.to.join(", ")}   ${x.id} cursor ${x.cursor}`);
  const h = c.horizon ?? {};
  out.push("");
  out.push(`read ${h.messages ?? 0} message${h.messages === 1 ? "" : "s"} back to ${h.oldest ?? "nothing"}; ${h.own ?? 0} of this session's own. Nothing here is stored: this is derived at the call and re-derived at the next one.`);
  return out.join("\n");
}
