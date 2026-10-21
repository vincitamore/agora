// @ts-check
/**
 * The messenger: supervision of a room's clocks in code (docs/MESSENGER.md).
 *
 * One code path, `tick`: a pure fold over durable records (the room read with its titles and
 * pins, the board read, the seat's session records through the resolver) at an instant, returning
 * the acts that are due. The clocks run on evidence before time: a delivery starts at the session's
 * seen record, and a holder's own activity record (is it busy, producing, calling tools, or idle)
 * decides whether a notice is due at all; the time bounds are backstops (see `evidenceOf`).
 * The shell (`runTick`) gathers the records, asks `tick`, and when anything
 * is due takes the room's messenger lock, gathers again and posts what the fresh fold still says
 * is due. **Its own posts are its incident record**: every notice is one of a fixed set of one-line
 * forms (`NOTICE_TEMPLATES`), and `tick` skips an act whose form already stands in the room for
 * that incident, so a restart duplicates nothing and an interval missed while it was down is caught
 * by the next tick. The one other thing kept is where it started in the room (`messengerStart`):
 * an incident older than its first start, less a short look-back, is not raised, so a first start
 * on a room with history does not flood it.
 *
 * The notices carry ids, ages and names, never a message's text: a pointer, never a paraphrase.
 *
 * What it never does: answer, claim, decide, quote or paraphrase; write to a prompt line; start or
 * stop a session; ping an address that is not held on this seat; post a heartbeat. Routing has no
 * model: an unaddressed human request goes to the holder of its subject, else to the stood
 * orchestrator position, else it is named to the host human.
 */

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { AgoraError, EXIT, writeFileAtomic } from "./core.mjs";
import { claimAuthors, foldBoard, safeSubject } from "./board-read.mjs";
import { parseNativeCursor } from "./native-protocol.mjs";
import { listSessions, pidAlive, positionOf } from "./session.mjs";
import { matchesAddress, parseTrailers } from "./trailers.mjs";

/**
 * The notice set. Pinned by exact equality in test/messenger.test.mjs: a notice is a pointer,
 * never a paraphrase, so a form that grows a slot for the message's words is a red bar there.
 * N8 (a restore or position fault, in the Room subject) is composed by the resident tooling that
 * restores; the tick does not raise it.
 */
export const NOTICE_TEMPLATES = Object.freeze({
  N1: "Routed: unaddressed request {id}.",
  N2: "Not taken {age} since {since}: {id}.",
  N3: "{position} has not {verb} {id} after {age}; observe: {verdict}.",
  N4: "Lease on {subject} expired {age} ago without renew or release.",
  N5: "to: {addr} names no holder here ({kind}); nearest: {nearest}.",
  N6: "Open subject {id} unclaimed after {age}.",
  N7: "Reply posted at top level; its subject is {root}.",
  N8: "{position}: {verdict} by {attestor} {age}; path {path}; outcome {outcome}.",
  N9: "No role fits {id}; for {human}.",
  N10: "Queued {task} not started after {age}, with no task held: {id}.",
  N11: "Waiting on {person} for {task} after {age}: {id}.",
  N12: "On arming: {task} waits on {person} after {age}: {id}.",
  N13: "On arming: queued {queued}; active and yours {yours}; active, held by others {others}.",
  N14: "On arming: {position} holds {claims}.",
});

/**
 * Forms a notice was posted in before its current one, read and never composed. The room is never
 * rewritten, so a line posted in a replaced form still reads as that notice: its incident stays
 * recorded, and it is never read as an agent's line to clock. Pinned by exact equality in
 * test/messenger.test.mjs beside the set.
 */
export const PRIOR_FORMS = Object.freeze({
  N13: Object.freeze(["On arming: queued {queued}; active {active}."]),
});

/** @typedef {keyof typeof NOTICE_TEMPLATES} NoticeKind */

/**
 * The bounds, in milliseconds. The clocks run on evidence first (what a holder's session is doing:
 * `readActivity`) and on these times only where evidence is absent or has to be bounded.
 * G: how long a holder with no turn, tool call or output may sit idle on an unresolved delivery or
 * lapsed lease before N2 or N4. G2: the same idle time before the human line (N3). S: a busy holder
 * with no progress at all for this long is stalled, which reads as dark. D: a watch whose record has
 * not been refreshed for this long (at least three of its own intervals) is silent, which reads as
 * dark. R, R2, I: the time-only backstops for a holder whose session writes no activity record (an
 * older client): R, delivery to taken, then N2; R2, the human line (N3) on either clock; I, the
 * grace after a lease expires before N4. They are long backstops (hours), used only without an
 * activity record. Bo: an
 * open subject before N6. H: the horizon; an incident that started before it is not raised. L: the
 * look-back of a first start; an incident that started before the messenger's first start in the
 * room less L is not raised (`messengerStart`). T: the stream's interval tick.
 */
export const DEFAULT_BOUNDS = Object.freeze({ R: 7_200_000, R2: 14_400_000, I: 3_600_000, Bo: 14_400_000, H: 86_400_000, L: 600_000, T: 30_000, G: 600_000, G2: 1_800_000, S: 7_200_000, D: 300_000 });

/** @typedef {{ R: number, R2: number, I: number, Bo: number, H: number, L: number, T: number, G: number, G2: number, S: number, D: number }} Bounds */

/**
 * `R=2h,R2=4h,I=1h,Bo=4h,H=24h,L=10m,T=30s,G=10m,G2=30m,S=2h,D=5m` (any subset; the rest are the
 * defaults). Units ms, s, m, h.
 * @param {string | undefined} spec @returns {Bounds}
 */
export function parseBounds(spec) {
  /** @type {Bounds} */
  const b = { ...DEFAULT_BOUNDS };
  if (spec !== undefined && spec.trim()) {
    for (const part of spec.split(",")) {
      const m = /^\s*(R2|R|I|Bo|H|L|T|G2|G|S|D)\s*=\s*(\d+)(ms|s|m|h)\s*$/.exec(part);
      if (!m) throw new AgoraError(`--bounds takes NAME=<n><ms|s|m|h> joined by commas (names R, R2, I, Bo, H, L, T, G, G2, S, D), not ${JSON.stringify(part)}`, EXIT.usage);
      b[/** @type {keyof Bounds} */ (m[1])] = Number(m[2]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[/** @type {'ms' | 's' | 'm' | 'h'} */ (m[3])];
    }
  }
  if (!(b.R > 0 && b.R < b.R2)) throw new AgoraError(`--bounds needs 0 < R < R2 (R ${b.R} ms, R2 ${b.R2} ms)`, EXIT.usage);
  if (!(b.G > 0 && b.G < b.G2)) throw new AgoraError(`--bounds needs 0 < G < G2 (G ${b.G} ms, G2 ${b.G2} ms)`, EXIT.usage);
  if (!(b.S > 0 && b.D > 0)) throw new AgoraError("--bounds needs S and D above 0", EXIT.usage);
  if (!(b.L <= b.H)) throw new AgoraError(`--bounds needs L <= H (L ${b.L} ms, H ${b.H} ms): the look-back of a first start never reaches past the horizon`, EXIT.usage);
  if (!(b.T >= 1000)) throw new AgoraError("--bounds T is at least 1s", EXIT.usage);
  return b;
}

/** An age as a notice prints it: `42s`, `16m`, `1h05m`. @param {number} ms */
export function formatAge(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

const SLOT = /\{([a-z]+)\}/g;

/**
 * Compose one notice. Every slot is filled with one token (no whitespace), so `parseNotice` reads
 * it back exactly.
 * @param {NoticeKind} kind @param {Record<string, string>} fields
 */
export function formatNotice(kind, fields) {
  const template = NOTICE_TEMPLATES[kind];
  if (!template) throw new AgoraError(`no notice ${kind}`);
  return template.replace(SLOT, (_, name) => {
    const v = fields[name];
    if (typeof v !== "string" || !v || /\s/.test(v)) throw new AgoraError(`notice ${kind} slot ${name} needs one token, not ${JSON.stringify(v)}`);
    return v;
  });
}

/** The current forms first, then the replaced ones. @type {Array<[NoticeKind, RegExp, string[]]>} */
const PARSERS = /** @type {any} */ ([...Object.entries(NOTICE_TEMPLATES), ...Object.entries(PRIOR_FORMS).flatMap(([kind, forms]) => forms.map((f) => [kind, f]))].map(([kind, template]) => {
  /** @type {string[]} */
  const slots = [];
  const source = template.split(SLOT).map((/** @type {string} */ piece, /** @type {number} */ i) => {
    if (i % 2 === 1) { slots.push(piece); return "(\\S+?)"; }
    return piece.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }).join("");
  return [kind, new RegExp(`^${source}$`), slots];
}));

/**
 * Read a message back as a notice: its kind and slots, and its trailers. Null for anything else.
 * @param {string} text
 * @returns {{ kind: NoticeKind, fields: Record<string, string>, re: string | undefined, to: string[] } | null}
 */
export function parseNotice(text) {
  const { body, trailers, to } = parseTrailers(String(text ?? ""));
  const line = body.trim();
  if (line.includes("\n")) return null;
  for (const [kind, re, slots] of PARSERS) {
    const m = re.exec(line);
    if (!m) continue;
    /** @type {Record<string, string>} */
    const fields = {};
    slots.forEach((s, i) => { fields[s] = m[i + 1]; });
    return { kind, fields, re: trailers.find((t) => t.key === "re")?.value, to };
  }
  return null;
}

/**
 * The incident a notice stands for: one key per incident, so a second notice for it is a duplicate.
 * @param {NoticeKind} kind @param {Record<string, string>} f @param {{ re?: string, to: string[] }} t
 */
export function noticeKey(kind, f, t) {
  switch (kind) {
    case "N1": case "N9": return `route:${f.id}`;
    case "N2": return `N2:${f.id}:${t.to[0] ?? ""}`;
    // one human line per incident: the position text is not in the key, so a roster change between
    // ticks (a position forgotten, a holder renamed) cannot raise the same incident twice
    case "N3": return `N3:${f.verb}:${f.id}`;
    case "N4": return `N4:${f.subject}`;
    case "N5": return `N5:${t.re ?? ""}:${f.addr}`;
    case "N6": return `N6:${f.id}`;
    case "N7": return `N7:${t.re ?? ""}`;
    case "N8": return `N8:${f.position}:${f.path}:${f.outcome}`;
    case "N10": case "N11": case "N12": return `${kind}:${f.id}`;
    // the room's queue as one arming learns it: one standing line per arming, the arming's place in
    // the log decides whether the latest one already covers it
    case "N13": return "N13";
    // the claims a position holds as one arming learns them: one line per position per arming
    case "N14": return `N14:${f.position}`;
  }
  return `${kind}`;
}

/**
 * @typedef {{ kind: NoticeKind, key: string, text: string, trailers: Array<{ key: string, value: string }>, thread: string | undefined }} Act
 * @typedef {import('./board-read.mjs').Resolution} Resolution
 * @typedef {{
 *   session: string, turn: "busy" | "idle", since: number, lastToolAt: number | null, lastOutputAt: number | null,
 *   progressAt: number | null, progress: number, updatedAt: number, intervalMs: number | null,
 * }} Activity
 * @typedef {{
 *   now: number, messages: any[], titles: Map<string, string>, pinned: Set<string>, boardRecords: any[],
 *   accountId: string | null, resolve: (address: string) => Resolution, human: string, bounds: Bounds,
 *   seen?: Map<string, number>, activity?: Map<string, Activity>, records?: import('./board-read.mjs').SeatRecord[], since?: number, standing?: Set<string>,
 * }} TickInput
 * `seen` is `readSeen`'s map: when each of this seat's sessions admitted each line into its intake.
 * `activity` is `readActivity`'s: what each of this seat's sessions is doing now.
 * `records` are this seat's session records with their posted ledgers (the resolver's): who posted
 * a line from which position, and when a session that has ended was last seen alive.
 * `since` is the messenger's starting point in the room (`messengerStart`): nothing that began
 * before it is raised. `standing` are the positions this seat is bringing back: a run record or an
 * inherit marker stands for each (a restart or a succession under way).
 * @typedef {{ clock: 1 | 2 | 3, id: string, position: string, state: "working" }} Held
 * Clock 3 is the queue's: `id` is the head task's subject root.
 */

/** @param {string} cursor */
const seqOf = (cursor) => { try { return parseNativeCursor(cursor).sequence; } catch { return 0; } };

/**
 * What a position's sessions are doing, from their activity records (docs/MESSENGER.md § Evidence).
 * Per holder: `working` (a turn is running and it shows progress within S), `idle` (no turn; the
 * time it went quiet is the latest of its turn end, tool call and output), `dark` (its process is
 * gone, its watch has not refreshed the record for D or three of its intervals, or its turn has made
 * no progress for S), or `none` (no record: an older client, or a session with no watch of this
 * kind). A position is `working` if any holder is; else `idle` if any holder with a record is (a live
 * session that is not taking it); else `dark`; else `none`. `since` is when it went idle or dark
 * (`null` when unknown); `verdict` is the one token the N3 line prints for it.
 * @param {import('./board-read.mjs').ResolvedHolder[]} holders @param {Map<string, Activity> | undefined} activity @param {number} now @param {Bounds} bounds
 * @returns {{ state: "working" | "idle" | "dark" | "none", since: number | null, verdict: string }}
 */
export function evidenceOf(holders, activity, now, bounds) {
  /** @type {Array<{ state: "working" | "idle" | "dark" | "none", since: number | null, why: string }>} */
  const per = holders.map((h) => {
    const a = h.session === null ? undefined : activity?.get(h.session);
    if (!a) return h.process === "gone" ? { state: "dark", since: null, why: "gone" } : { state: "none", since: null, why: "none" };
    if (h.process === "gone") return { state: "dark", since: a.updatedAt, why: "gone" };
    const silent = Math.max(bounds.D, 3 * (a.intervalMs ?? 0));
    if (now - a.updatedAt > silent) return { state: "dark", since: a.updatedAt + silent, why: "silent" };
    const last = Math.max(a.since, a.lastToolAt ?? 0, a.lastOutputAt ?? 0, a.progressAt ?? 0);
    if (a.turn === "busy") return now - last > bounds.S ? { state: "dark", since: last + bounds.S, why: "stalled" } : { state: "working", since: a.since, why: "working" };
    return { state: "idle", since: last, why: "idle" };
  });
  const latest = (/** @type {typeof per} */ rows) => {
    const ts = rows.map((r) => r.since).filter((t) => t !== null);
    return ts.length === rows.length && ts.length ? Math.max(.../** @type {number[]} */ (ts)) : null;
  };
  const working = per.filter((p) => p.state === "working");
  if (working.length) return { state: "working", since: latest(working), verdict: "working" };
  const idle = per.filter((p) => p.state === "idle");
  if (idle.length) return { state: "idle", since: latest(idle), verdict: "idle" };
  const dark = per.filter((p) => p.state === "dark");
  if (dark.length) return { state: "dark", since: latest(dark), verdict: [...new Set(dark.map((p) => p.why))].join("+") };
  return { state: "none", since: null, verdict: "none" };
}

/**
 * A room read as the fold reads it: each line's trailers, addresses, subject root and whether it is
 * a notice, in log order.
 * @param {any[]} messages
 */
function readMessages(messages) {
  return messages.map((m) => {
    const text = String(m.text ?? "");
    const { trailers, to } = parseTrailers(text);
    return { raw: m, text, id: String(m.id), cursor: String(m.cursor), seq: seqOf(String(m.cursor)), ts: Date.parse(m.ts), thread: m.thread,
      root: m.thread ?? String(m.id), human: m.author?.kind === "human", accountId: m.author?.id, bearer: String(m.signedAs ?? m.author?.name ?? ""),
      trailers, to, notice: parseNotice(text) };
  }).sort((a, b) => a.seq - b.seq);
}

/** `waiting: <person>; needs: <thing>` (or `waiting: <person>`) as a body line of its own, or as the `waiting` trailer. */
const WAITING_LINE = /^waiting:[ \t]*([^\s;]+)[ \t]*(?:;.*)?$/im;
/** The same form after other words on a line (`Released: no bar. waiting: Ada; needs: …`): there it reads only with its `needs:`. */
const WAITING_INLINE = /(?:^|[\s.,;:(])waiting:[ \t]*([^\s;,]+)[ \t]*;[ \t]*needs:/i;

/**
 * The person a line says a task waits on: its `waiting` trailer, wherever it stands in the block;
 * else a body line `waiting: <person>; needs: <thing>`; else that form with its `needs:` anywhere in
 * a body line. Undefined for anything else (a waiting in prose records none).
 * @param {{ text: string, trailers: Array<{ key: string, value: string }> }} m
 */
function waitingOf(m) {
  const t = m.trailers.find((x) => x.key === "waiting");
  if (t) return WAITING_LINE.exec(`waiting: ${t.value}`)?.[1];
  const body = parseTrailers(m.text).body;
  return (WAITING_LINE.exec(body) ?? WAITING_INLINE.exec(body))?.[1];
}

/** `withdrawn: <who>; <why>` as a body line of its own (the `withdrawn` trailer reads the same). */
const WITHDRAWN_LINE = /^withdrawn:/im;

/**
 * Does a line say its request is taken back: a `withdrawn` trailer, or a body line that starts
 * `withdrawn:`. A withdrawal written in prose (`I no longer need it`) says nothing here.
 * @param {{ text: string, trailers: Array<{ key: string, value: string }> }} m
 */
function withdrawnOf(m) {
  return m.trailers.some((t) => t.key === "withdrawn") || WITHDRAWN_LINE.test(parseTrailers(m.text).body);
}

/**
 * @typedef {{
 *   subject: string, slug: string, root: string, order: number, pinned: boolean,
 *   state: "queued" | "active" | "waiting" | "done", since: number, sinceSeq: number,
 *   holder: string | null, claim: string | null, waiting: { person: string, id: string, ts: number, seq: number } | null,
 * }} Task
 * @typedef {{ tasks: Task[], free: { ts: number, seq: number } }} Queue
 * A task is a subject: the root (and its thread) a line in it marks `task: <slug>`, or the subject of
 * a line claiming or releasing a `task:<slug>` that names no task. Its identity is the root, never the
 * name: a name used again in a later subject is a new task. `order` is its root's place in the log;
 * `since` and `sinceSeq` are when it entered its state; `holder` and `claim` are the claim's bearer
 * and line while active; `waiting` is the waiting line while parked. `free` is since when no task
 * has been held (`-Infinity` and 0 when none ever was).
 */

/**
 * The room's task queue, a fold over trailers and stored nowhere (docs/MESSENGER.md § The queue),
 * over the lines at or after `from` (the earliest instant the messenger may raise anything: history
 * before it neither queues, holds nor closes a task). In log order: a `task:` mark queues its
 * subject; `claim: task:<slug>` makes it active, held by the claim's bearer; `release: task:<slug>`
 * closes it with a `verdict:` or a withdrawal (`withdrawn:`) on the same line, and of an active task
 * otherwise parks it with a waiting line or hands it back to the queue; a verdict the holder posts in
 * the task's subject closes it with no release; a human's withdrawal in a queued or parked task's
 * subject (or citing the waiting line) ends it; and any other human line in a parked task's subject
 * (or citing the waiting line) is the answer, which hands it back to the queue. A claim or release
 * names the task of that name in its own subject, else the newest open one of that name, else (a
 * release) the newest closed one; a claim of a name that is open nowhere starts a task in its own
 * subject. The messenger's own notices are not acts.
 * @param {ReturnType<typeof readMessages>} ms @param {Set<string>} pinned @param {number} [from] @returns {Queue}
 */
function foldQueue(ms, pinned, from = -Infinity) {
  /** subject root and name -> the task @type {Map<string, Task>} */
  const tasks = new Map();
  const keyOf = (/** @type {string} */ root, /** @type {string} */ slug) => `${root}\n${slug}`;
  const rootSeq = new Map(ms.map((m) => [m.id, m.seq]));
  const PREFIX = "work:task:";
  /** the task name a board subject carries, if it is a task's @param {string | undefined} s */
  const slugOf = (s) => (s !== undefined && s.startsWith(PREFIX) && s.length > PREFIX.length ? s.slice(PREFIX.length) : undefined);
  let free = { ts: -Infinity, seq: 0 };
  /** @param {Task} t @param {Task["state"]} state @param {typeof ms[number]} m */
  const move = (t, state, m) => { t.state = state; t.since = m.ts; t.sinceSeq = m.seq; t.holder = null; t.claim = null; t.waiting = null; };
  /** @param {string} slug @param {typeof ms[number]} m */
  const open = (slug, m) => {
    /** @type {Task} */
    const t = { subject: `${PREFIX}${slug}`, slug, root: m.root, order: rootSeq.get(m.root) ?? m.seq, pinned: pinned.has(m.root), state: "queued", since: m.ts, sinceSeq: m.seq, holder: null, claim: null, waiting: null };
    tasks.set(keyOf(m.root, slug), t);
    return t;
  };
  /** the task a claim or release of `task:<slug>` on this line names @param {string} slug @param {typeof ms[number]} m @param {boolean} claim */
  const named = (slug, m, claim) => {
    const here = tasks.get(keyOf(m.root, slug));
    if (here) return here;
    const same = [...tasks.values()].filter((t) => t.slug === slug);
    return same.filter((t) => t.state !== "done").pop() ?? (claim ? undefined : same.pop()) ?? open(slug, m);
  };
  for (const m of ms) {
    if (m.notice || m.ts < from) continue;
    for (const t of m.trailers) {
      const slug = t.key === "task" ? slugOf(safeSubject(`task:${t.value}`)) : undefined;
      if (slug !== undefined && !tasks.has(keyOf(m.root, slug))) open(slug, m);
    }
    const heldBefore = [...tasks.values()].some((t) => t.state === "active");
    const verdict = m.trailers.some((t) => t.key === "verdict");
    // a withdrawal ends the task as a verdict would: the request is gone, so nothing is queued again
    const withdrawn = withdrawnOf(m);
    const closes = verdict || withdrawn;
    /** @type {Set<Task>} */
    const released = new Set();
    for (const t of m.trailers) {
      if (t.key !== "claim" && t.key !== "release") continue;
      const slug = slugOf(safeSubject(t.value));
      if (slug === undefined) continue;
      const task = named(slug, m, t.key === "claim");
      if (t.key === "claim") { move(task, "active", m); task.holder = m.bearer; task.claim = m.id; continue; }
      released.add(task);
      // a release closes any task with a verdict or a withdrawal on the line; otherwise it acts only on
      // a held task (a stray release after a close, freeing the lease, does not reopen it)
      if (!closes && task.state !== "active") continue;
      const person = closes ? undefined : waitingOf(m);
      move(task, closes ? "done" : person ? "waiting" : "queued", m);
      if (person) task.waiting = { person, id: m.id, ts: m.ts, seq: m.seq };
    }
    for (const task of tasks.values()) {
      if (released.has(task)) continue;
      if (verdict && task.state === "active" && task.root === m.root && task.holder === m.bearer) move(task, "done", m);
      else if (m.human && (task.state === "waiting" || (withdrawn && task.state === "queued"))
        && (task.root === m.root || m.trailers.some((t) => t.key === "re" && t.value === task.waiting?.id))) move(task, withdrawn ? "done" : "queued", m);
    }
    if (heldBefore && ![...tasks.values()].some((t) => t.state === "active")) free = { ts: m.ts, seq: m.seq };
  }
  return { tasks: [...tasks.values()], free };
}

/**
 * The room's task queue from a read (`foldQueue`): every task with its state, and since when no
 * task has been held.
 * @param {any[]} messages @param {Set<string>} pinned the pinned roots (a pinned task is the head)
 * @param {number} [from] the fold's start: what the messenger may raise from (its starting point, within the horizon)
 */
export function queueOf(messages, pinned, from) {
  return foldQueue(readMessages(messages), pinned, from);
}

/**
 * The acts due at `now`. Pure.
 * @param {TickInput} input
 * @returns {{ acts: Act[], notices: number, held: Held[] }}
 */
export function tick(input) {
  const { now, bounds, human } = input;
  const ms = readMessages(input.messages);
  const byRef = new Map();
  for (const m of ms) { byRef.set(m.id, m); byRef.set(m.cursor, m); }
  /** key -> the highest sequence a notice for it stands at */
  const done = new Map();
  for (const m of ms) if (m.notice) {
    const key = noticeKey(m.notice.kind, m.notice.fields, m.notice);
    done.set(key, Math.max(done.get(key) ?? 0, m.seq));
  }
  const board = foldBoard(input.boardRecords, now);
  const authors = claimAuthors(board, input.messages);
  const horizon = Math.max(now - bounds.H, input.since ?? -Infinity);
  /** @type {Act[]} */
  const acts = [];
  /** @param {NoticeKind} kind @param {number} after @param {Record<string, string>} fields @param {Array<{ key: string, value: string }>} trailers @param {string | undefined} thread */
  const emit = (kind, after, fields, trailers, thread) => {
    const key = noticeKey(kind, fields, { re: trailers.find((t) => t.key === "re")?.value, to: trailers.filter((t) => t.key === "to").map((t) => t.value) });
    if ((done.get(key) ?? 0) > after || acts.some((a) => a.key === key)) return;
    acts.push({ kind, key, text: formatNotice(kind, fields), trailers, thread });
  };
  /** @param {typeof ms[number]} m @param {string} k */
  const trailer = (m, k) => m.trailers.find((t) => t.key === k)?.value;
  const resolved = new Map();
  /** @param {string} a @returns {Resolution} */
  const resolve = (a) => { if (!resolved.has(a)) resolved.set(a, input.resolve(a)); return resolved.get(a); };
  /** the host human, named by an address: a person whether or not they have spoken in the read, so
   * an agent session bearing their name is never taken for them @param {string} a */
  const isHost = (a) => a.trim().toLowerCase() === human.toLowerCase();
  /** @param {Resolution} r */
  const localOf = (r) => r.holders.filter((h) => h.process !== "foreign");
  const orchestrator = () => (["role", "position"].includes(resolve("orchestrator").kind) ? localOf(resolve("orchestrator")) : []);
  /** the subject a root is held under, attributed: msg:<root>, or task:<slug> from the root's trailer @param {string} root */
  const heldBy = (root) => {
    const rootMsg = byRef.get(root);
    const subjects = [safeSubject(`msg:${root}`), ...(rootMsg && trailer(rootMsg, "task") ? [safeSubject(`task:${trailer(rootMsg, "task")}`)] : [])];
    for (const s of subjects) {
      const state = board.subjects.find((x) => x.subject === s);
      if (state?.holder && authors.get(/** @type {string} */ (s))) return authors.get(/** @type {string} */ (s));
    }
    return undefined;
  };
  /** any claim of msg:<id> on the board, at or after the message @param {string} id */
  const claimedSubject = (id) => board.subjects.find((x) => x.subject === safeSubject(`msg:${id}`) && x.claimedAt !== null);
  /** line id -> the position of the session on this seat that posted it, from the posted ledgers */
  const postedFrom = new Map();
  for (const r of input.records ?? []) {
    const p = positionOf(r.record);
    if (p && r.posted) for (const id of r.posted) postedFrom.set(id, p);
  }
  /** is this post (or claim) the addressee's: a holder's bearer, or a bearer or position the address names
   * @param {string} addr @param {import('./board-read.mjs').ResolvedHolder[]} holders @param {{ bearer: string, id: string }} post */
  const byAddressee = (addr, holders, post) => holders.some((h) => h.bearer === post.bearer) || matchesAddress(addr, post.bearer, undefined, postedFrom.get(post.id) ?? null);
  /** has the addressee taken the message: a claim of msg:<id>, or a later post of its that cites it
   * (re:) or stands in the same subject (a reply in its thread, or, for a line that is itself a
   * reply, a later reply in that thread: native threads are one level deep)
   * @param {typeof ms[number]} m @param {string} addr @param {import('./board-read.mjs').ResolvedHolder[]} holders */
  const taken = (m, addr, holders) => {
    const claim = claimedSubject(m.id);
    if (claim) {
      const who = authors.get(claim.subject);
      if (who === undefined || byAddressee(addr, holders, who)) return true;
    }
    return ms.some((x) => x.seq > m.seq && !x.notice && byAddressee(addr, holders, x)
      && (trailer(x, "re") === m.id || trailer(x, "re") === m.cursor || x.root === m.root));
  };
  /** was the address held when the line was posted: a session that has since ended and held it was
   * seen alive at or after the post (its record's last write, its watch's last refresh), a holder of
   * it posted after the line (an answer, or any line it signed: a notice too), or its clock already
   * ran (an N2 for it stands)
   * @param {typeof ms[number]} m @param {string} addr */
  const heldWhenPosted = (m, addr) => {
    for (const r of input.records ?? []) {
      if (r.state !== "gone" || !r.record || !matchesAddress(addr, r.record.bearer, undefined, positionOf(r.record) ?? null)) continue;
      if ((Date.parse(r.record.lastSeen ?? "") || -Infinity) >= m.ts || (input.activity?.get(r.slug)?.updatedAt ?? -Infinity) >= m.ts) return true;
    }
    return ms.some((x) => x.seq > m.seq && !x.human && byAddressee(addr, [], x))
      || done.has(noticeKey("N2", { id: m.id }, { to: [addr] }));
  };
  /** does a retired name belong only to positions held again or coming back: every ended session it
   * names on this seat stood at a position a live session holds now (a model swap's successor) or
   * one this seat is bringing back (`standing`: its run record or inherit marker stands)
   * @param {string} addr */
  const succeeded = (addr) => {
    const recs = input.records ?? [];
    const ended = recs.filter((r) => r.state === "gone" && r.record && matchesAddress(addr, r.record.bearer, undefined, positionOf(r.record) ?? null));
    return ended.length > 0 && ended.every((r) => {
      const p = positionOf(r.record);
      return Boolean(p) && (input.standing?.has(/** @type {string} */ (p)) || recs.some((x) => x.state === "live" && positionOf(x.record) === p));
    });
  };
  /**
   * Where clock 1 starts for a delivery: the earliest instant (not after `now`, not before the post) at
   * which a holder's session admitted the line, when a seen record says so, else the post.
   * @param {string} deliveredId the line the holder is delivered: the message itself, or its route line
   * @param {import('./board-read.mjs').ResolvedHolder[]} holders @param {number} postedTs
   * @returns {{ ts: number, since: "seen" | "posted" }}
   */
  const startOf = (deliveredId, holders, postedTs) => {
    const at = holders.flatMap((h) => {
      const t = h.session === null ? undefined : input.seen?.get(seenKey(h.session, deliveredId));
      return t !== undefined && t <= now ? [t] : [];
    });
    return at.length ? { ts: Math.max(postedTs, Math.min(...at)), since: "seen" } : { ts: postedTs, since: "posted" };
  };
  /** the incidents an idle-or-dark clock would raise but a working holder holds back, in the order found */
  /** @type {Held[]} */
  const held = [];
  /**
   * clock 1 for one (message, address): the delivery's evidence first. A working holder draws no
   * notice (the line waits in its own harness); an idle or dark one draws N2 after G of idleness
   * that began no earlier than the delivery, N3 after G2; with no activity record the time-only
   * bounds R and R2 run from the delivery.
   * @param {typeof ms[number]} m @param {string} addr @param {import('./board-read.mjs').ResolvedHolder[]} holders @param {string} deliveredId @param {number} postedTs
   */
  const clock1 = (m, addr, holders, deliveredId, postedTs) => {
    if (taken(m, addr, holders)) return;
    const { ts: startTs, since } = startOf(deliveredId, holders, postedTs);
    const age = now - startTs;
    const ev = evidenceOf(holders, input.activity, now, bounds);
    const to = [{ key: "to", value: addr }, { key: "re", value: m.id }];
    const toHuman = [{ key: "to", value: human }, { key: "re", value: m.id }];
    const position = [...new Set(holders.map((h) => h.position ?? h.bearer))].join("+");
    if (ev.state === "working") {
      if (age >= bounds.G) held.push({ clock: 1, id: m.id, position, state: "working" });
      return;
    }
    const quiet = ev.state === "none" ? age : now - Math.max(startTs, ev.since ?? startTs);
    const [first, second] = ev.state === "none" ? [bounds.R, bounds.R2] : [bounds.G, bounds.G2];
    if (quiet >= first) emit("N2", m.seq, { age: formatAge(age), since, id: m.id }, to, m.root);
    if (quiet >= second) {
      const verdict = ev.state === "none" ? [...new Set(holders.map((h) => h.verdict))].join("+") : ev.verdict;
      emit("N3", m.seq, { position, verb: "taken", id: m.id, age: formatAge(age), verdict }, toHuman, m.root);
    }
  };
  /** the messenger itself, on this seat: a holder of the messenger role, the bearer its notices are
   * signed by, or the session whose ledger posted one. A line addressed to it is never clocked: it
   * cannot take a line, and its notices are answered with `re:`, which it reads as an answer */
  const ownNotices = new Set(ms.filter((m) => m.notice && !m.human).map((m) => m.id));
  const selfBearers = new Set(ms.filter((m) => ownNotices.has(m.id)).map((m) => m.bearer));
  const selfSessions = new Set((input.records ?? []).filter((r) => r.posted && [...r.posted].some((id) => ownNotices.has(id))).map((r) => r.slug));
  /** @param {import('./board-read.mjs').ResolvedHolder} h */
  const isSelf = (h) => h.role === "messenger" || selfBearers.has(h.bearer) || (h.session !== null && selfSessions.has(h.session));
  /** a line that owes its addressee no answer, and so starts no delivery clock (with `ack: none`
   * and an address to the messenger itself, the whole set: docs/MESSENGER.md § The clocks): an
   * answer to a notice (its `re:` cites one), or a release with no verdict and no claim (a record
   * act: the hold has ended, nothing is handed on) @param {typeof ms[number]} m */
  const owesNoAnswer = (m) => m.trailers.some((t) => t.key === "re" && byRef.get(t.value)?.notice)
    || (m.trailers.some((t) => t.key === "release") && !m.trailers.some((t) => t.key === "verdict" || t.key === "claim"));

  for (const m of ms) {
    if (m.notice || m.ts < horizon) continue;
    // clock 1 on addressed lines, and the unmatched-address pointer
    if (m.to.length && trailer(m, "ack") !== "none") {
      const noAnswer = owesNoAnswer(m);
      for (const addr of m.to) {
        const r = resolve(addr);
        if (isHost(addr) || r.kind === "everyone" || r.kind === "seat" || r.kind === "person") continue;
        if (r.kind === "none") {
          // a pointer for an address that named no one when the line was posted: never for a line its
          // addressee answered, nor after the fact for one posted while a holder lived; never
          // `retired` on a line that owes no answer, which nothing answers or clocks, so no evidence
          // could ever show its address was held when it was posted; and never `retired` for a name
          // whose position is held again or coming back (a swap's successor, a restart under way)
          if (r.why === "retired" && (noAnswer || succeeded(addr))) continue;
          if (!heldWhenPosted(m, addr)) emit("N5", m.seq, { addr, kind: r.why ?? "unknown", nearest: r.nearest ?? "none" }, [{ key: "re", value: m.id }], m.root);
          continue;
        }
        const local = localOf(r).filter((h) => !isSelf(h));
        if (local.length && !noAnswer) clock1(m, addr, local, m.id, m.ts);
      }
    }
    // routing, no model: an unaddressed human request outside the Room subject
    if (m.human && !m.to.length && !input.pinned.has(m.root)) {
      const route = ms.find((x) => x.notice && (x.notice.kind === "N1" || x.notice.kind === "N9") && x.notice.fields.id === m.id && x.seq > m.seq);
      if (!route) {
        const holder = heldBy(m.root);
        if (holder) emit("N1", m.seq, { id: m.id }, [{ key: "to", value: holder.bearer }, { key: "re", value: m.id }], m.root);
        else if (orchestrator().length) emit("N1", m.seq, { id: m.id }, [{ key: "to", value: "orchestrator" }, { key: "re", value: m.id }], m.root);
        else emit("N9", m.seq, { id: m.id, human }, [{ key: "to", value: human }, { key: "re", value: m.id }], m.root);
      } else if (route.notice?.kind === "N1" && route.to[0]) {
        const addr = route.to[0];
        const local = localOf(resolve(addr));
        if (local.length) clock1(m, addr, local, route.id, route.ts);
      }
    }
    // a reply posted at top level that left a subject: the line it cites is a reply, or its root is
    // titled or already has a thread. A top-level answer to a lone top-level line is the flat answer
    // form (a room with no threads answers so, and `carry` credits it), so it draws no pointer
    const re = trailer(m, "re");
    if (!m.thread && re) {
      const cited = byRef.get(re);
      const inSubject = cited && (cited.thread !== undefined || input.titles.has(cited.root) || ms.some((x) => x.thread === cited.root && x.seq < m.seq));
      if (cited && cited.root !== m.id && inSubject) emit("N7", m.seq, { root: cited.root }, [{ key: "re", value: m.id }], cited.root);
    }
    // an open subject: a titled human root addressed to nothing this seat holds
    if (m.human && !m.thread && input.titles.has(m.id) && !input.pinned.has(m.id) && m.to.length
      && !m.to.some((a) => !isHost(a) && ["role", "position"].includes(resolve(a).kind) && localOf(resolve(a)).length)) {
      const age = now - m.ts;
      const answered = ms.some((x) => x.seq > m.seq && !x.notice && !x.human && (x.thread === m.id || trailer(x, "re") === m.id));
      if (age >= bounds.Bo && !claimedSubject(m.id) && !answered) {
        const target = orchestrator().length ? "orchestrator" : human;
        emit("N6", m.seq, { id: m.id, age: formatAge(age) }, [{ key: "to", value: target }, { key: "re", value: m.id }], m.id);
      }
    }
  }

  // clock 2: a lease of this seat's that lapsed with no renew, release or verdict. Expiry alone never
  // pings a working holder (it is held, and reported as working); an idle or dark holder is pinged
  // once it has been quiet for G since the later of its going quiet and the expiry, and the human
  // line follows at G2. With no activity record the time-only bounds run from the expiry.
  for (const s of board.subjects) {
    const lease = s.lapsed;
    if (!lease || (input.accountId && lease.accountId !== input.accountId)) continue;
    const author = authors.get(s.subject);
    if (!author) continue;
    const from = seqOf(lease.cursor);
    const settled = ms.some((x) => x.seq > from && !x.notice && x.bearer === author.bearer
      && (x.trailers.some((t) => t.key === "release" && safeSubject(t.value) === s.subject) || (trailer(x, "verdict") !== undefined && x.root === author.root)));
    if (settled) continue;
    const expired = Date.parse(lease.expiresAt);
    if (expired < horizon) continue;
    const since = now - expired;
    const holders = localOf(resolve(author.bearer));
    const ev = evidenceOf(holders, input.activity, now, bounds);
    const position = holders.length ? [...new Set(holders.map((h) => h.position ?? h.bearer))].join("+") : author.bearer;
    if (ev.state === "working") {
      held.push({ clock: 2, id: s.subject, position, state: "working" });
      continue;
    }
    const quiet = ev.state === "none" ? since : now - Math.max(expired, ev.since ?? expired);
    const [first, second] = ev.state === "none" ? [bounds.I, bounds.R2] : [bounds.G, bounds.G2];
    if (quiet < first) continue;
    emit("N4", from, { subject: s.subject, age: formatAge(since) }, [{ key: "to", value: author.bearer }], author.root);
    if (quiet >= second) {
      const verdict = ev.state !== "none" ? ev.verdict : holders.length ? [...new Set(holders.map((h) => h.verdict))].join("+") : "absent";
      emit("N3", from, { position, verb: "renewed", id: s.subject, age: formatAge(since), verdict }, [{ key: "to", value: human }], author.root);
    }
  }

  // clock 3, the queue: with no task held, the head of the queue (pinned first, then oldest) waits on
  // the orchestrator from the later of its queueing and the last task's end. A working orchestrator
  // is held; an idle or dark one is told after G of quiet (N10) and the human after G2 (N3
  // `started`); with no activity record, R and R2 from that instant. With no orchestrator stood the
  // host human is told at R, once. The queue is folded from the horizon: history the messenger may
  // not raise neither holds the queue nor stands in it.
  const queue = foldQueue(ms, input.pinned, horizon);
  /** @param {Task} a @param {Task} b */
  const queueOrder = (a, b) => Number(b.pinned) - Number(a.pinned) || a.order - b.order;
  const head = queue.tasks.some((t) => t.state === "active") ? undefined : queue.tasks.filter((t) => t.state === "queued").sort(queueOrder)[0];
  if (head) {
    const startTs = Math.max(head.since, queue.free.ts);
    const after = Math.max(head.sinceSeq, queue.free.seq);
    const age = now - startTs;
    const fields = { task: `task:${head.slug}`, age: formatAge(age), id: head.root };
    const re = { key: "re", value: head.root };
    const holders = orchestrator();
    if (!holders.length) { if (age >= bounds.R) emit("N10", after, fields, [{ key: "to", value: human }, re], head.root); }
    else {
      const ev = evidenceOf(holders, input.activity, now, bounds);
      const position = [...new Set(holders.map((h) => h.position ?? h.bearer))].join("+");
      if (ev.state === "working") { if (age >= bounds.G) held.push({ clock: 3, id: head.root, position, state: "working" }); }
      else {
        const quiet = ev.state === "none" ? age : now - Math.max(startTs, ev.since ?? startTs);
        const [first, second] = ev.state === "none" ? [bounds.R, bounds.R2] : [bounds.G, bounds.G2];
        if (quiet >= first) emit("N10", after, fields, [{ key: "to", value: "orchestrator" }, re], head.root);
        if (quiet >= second) {
          const verdict = ev.state === "none" ? [...new Set(holders.map((h) => h.verdict))].join("+") : ev.verdict;
          emit("N3", after, { position, verb: "started", id: head.root, age: formatAge(age), verdict }, [{ key: "to", value: human }, re], head.root);
        }
      }
    }
  }

  // the waiting record: a parked task is named to the person it waits on once, R after the waiting
  // line (a person keeps no activity record); and to each orchestrator session that took the
  // position after the line was written (its record's start), once per session, so a successor
  // learns it from the room and not from memory
  /** @param {string | null} session */
  const armedAt = (session) => Date.parse((input.records ?? []).find((r) => r.slug === session)?.record?.startedAt ?? "");
  for (const t of queue.tasks) {
    const w = t.waiting;
    if (t.state !== "waiting" || !w) continue;
    const fields = { person: w.person, task: `task:${t.slug}`, age: formatAge(now - w.ts), id: w.id };
    const re = { key: "re", value: w.id };
    if (now - w.ts >= bounds.R) emit("N11", w.seq, fields, [{ key: "to", value: w.person }, re], t.root);
    const arm = Math.max(-Infinity, ...orchestrator().map((h) => armedAt(h.session)).filter((a) => a > w.ts && a <= now));
    if (arm >= horizon) {
      const armSeq = ms.reduce((s, x) => (x.ts <= arm ? Math.max(s, x.seq) : s), w.seq);
      emit("N12", armSeq, fields, [{ key: "to", value: "orchestrator" }, re], t.root);
    }
  }

  // the queue at arming: an orchestrator session whose record started after a task it would hold or
  // take entered that state (queued or active) is handed the whole queue once, by subject, in the
  // Room subject, so a successor or a swapped model learns what it owes from the room. An active task
  // is named as its own when the position holds it (the claim's bearer or posting session is the
  // position's, a predecessor's included), else as held by others
  const holders = orchestrator();
  const lastArming = Math.max(-Infinity, ...holders.map((h) => armedAt(h.session)).filter((a) => a <= now));
  const queued = queue.tasks.filter((t) => t.state === "queued").sort(queueOrder);
  const active = queue.tasks.filter((t) => t.state === "active");
  if (lastArming >= horizon && [...queued, ...active].some((t) => t.since < lastArming)) {
    /** @param {Task[]} ts */
    const list = (ts) => (ts.length ? ts.map((t) => `task:${t.slug}@${t.root}`).join(",") : "none");
    /** @param {Task} t */
    const yours = (t) => t.claim !== null && t.holder !== null && byAddressee("orchestrator", holders, { bearer: t.holder, id: t.claim });
    const armSeq = ms.reduce((s, x) => (x.ts <= lastArming ? Math.max(s, x.seq) : s), 0);
    emit("N13", armSeq, { queued: list(queued), yours: list(active.filter(yours)), others: list(active.filter((t) => !yours(t))) },
      [{ key: "to", value: "orchestrator" }], roomSubjectRoot(input.messages, input.titles, input.pinned) ?? undefined);
  }

  // the claims at arming: a session that took a position holding live claims of this seat's made
  // before it armed (a predecessor's, so its own reading of the room starts past them) is handed
  // them once, addressed to the position, in the Room subject: a restarted maker learns from the
  // room that the unit is its own. A claim is the position's by the session that posted it (the
  // posted ledgers, which inherit moves to a successor), else by a session of the claim's bearer
  // that stood at one position. An orchestrator's task claims are N13's to name.
  const recs = input.records ?? [];
  const orchPositions = new Set(holders.map((h) => h.position).filter(Boolean));
  /** @param {{ bearer: string, id: string }} who @returns {string | undefined} */
  const positionOfClaim = (who) => {
    const p = postedFrom.get(who.id);
    if (p) return p;
    const at = new Set(recs.filter((r) => r.record?.bearer === who.bearer).map((r) => positionOf(r.record)).filter(Boolean));
    return at.size === 1 ? /** @type {string} */ ([...at][0]) : undefined;
  };
  /** position -> its claims held now @type {Map<string, Array<{ subject: string, root: string, ts: number }>>} */
  const claimsAt = new Map();
  for (const s of board.subjects) {
    if (!s.holder || (input.accountId && s.holder.accountId !== input.accountId)) continue;
    const who = authors.get(s.subject);
    const p = who ? positionOfClaim(who) : undefined;
    if (!who || !p || (orchPositions.has(p) && s.subject.startsWith("work:task:"))) continue;
    claimsAt.set(p, [...(claimsAt.get(p) ?? []), { subject: s.subject, root: who.root, ts: byRef.get(who.id)?.ts ?? Infinity }]);
  }
  for (const [p, claims] of claimsAt) {
    const armed = Math.max(-Infinity, ...recs.filter((r) => r.state === "live" && positionOf(r.record) === p).map((r) => Date.parse(r.record?.startedAt ?? "")).filter((a) => a <= now));
    const owed = claims.filter((c) => c.ts < armed);
    if (armed < horizon || !owed.length) continue;
    const armSeq = ms.reduce((s, x) => (x.ts <= armed ? Math.max(s, x.seq) : s), 0);
    emit("N14", armSeq, { position: p, claims: owed.map((c) => `${c.subject}@${c.root}`).join(",") }, [{ key: "to", value: p }],
      roomSubjectRoot(input.messages, input.titles, input.pinned) ?? undefined);
  }
  return { acts, notices: done.size, held };
}

/**
 * The Room subject: the pinned, titled root that room business is posted under (the earliest pinned
 * root when none is titled). Null when the room pins none; the line then goes top level.
 * @param {any[]} messages @param {Map<string, string>} titles @param {Set<string>} pinned @returns {string | null}
 */
export function roomSubjectRoot(messages, titles, pinned) {
  const roots = messages.filter((m) => !m.thread && pinned.has(String(m.id)));
  const pick = roots.find((m) => titles.has(String(m.id))) ?? roots[0];
  return pick ? String(pick.id) : null;
}

// ---------------------------------------------------------------------------------------------
// The shell
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {{ messages: any[], annotations: any[], boardRecords: any[], resolve: (a: string) => Resolution, seen?: Map<string, number>, activity?: Map<string, Activity>, records?: import('./board-read.mjs').SeatRecord[], standing?: Set<string> }} Snapshot
 * @typedef {{
 *   gather: () => Promise<Snapshot>, post: (act: Act) => Promise<{ id: string, cursor: string }>,
 *   lock: <T>(fn: () => Promise<T>) => Promise<T | undefined>, now: () => number,
 *   accountId: string | null, human: string, bounds: Bounds, dryRun?: boolean, since?: number,
 * }} TickDeps
 * `since` is the starting point `messengerStart` gives for the room.
 */

/** Titles and pins folded from a read's annotations, in log order. @param {any[]} annotations */
export function annotationState(annotations) {
  const titles = new Map();
  const pinned = new Set();
  for (const a of annotations) {
    if (a?.act === "title" && typeof a.text === "string") titles.set(a.target, a.text);
    else if (a?.act === "pin") pinned.add(a.target);
    else if (a?.act === "unpin") pinned.delete(a.target);
  }
  return { titles, pinned };
}

/** @param {Snapshot} snap @param {TickDeps} deps @param {number} now */
function fold(snap, deps, now) {
  const { titles, pinned } = annotationState(snap.annotations);
  return tick({ now, messages: snap.messages, titles, pinned, boardRecords: snap.boardRecords, accountId: deps.accountId,
    resolve: snap.resolve, human: deps.human, bounds: deps.bounds, ...(snap.seen ? { seen: snap.seen } : {}), ...(snap.activity ? { activity: snap.activity } : {}),
    ...(snap.records ? { records: snap.records } : {}), ...(snap.standing ? { standing: snap.standing } : {}), ...(deps.since !== undefined ? { since: deps.since } : {}) });
}

// ---------------------------------------------------------------------------------------------
// The starting point
// ---------------------------------------------------------------------------------------------

/** Where a room's messenger keeps its starting point: beside the room's lock, one file per room. @param {string} stateRoot @param {string} roomId */
export function startPath(stateRoot, roomId) {
  return path.join(stateRoot, "messenger", `${roomId}.start.json`);
}

/**
 * The messenger's starting point in a room: the first start's instant less the look-back L
 * (`--bounds L=`, default 10 min; `L=0s` is the room head), recorded once and kept across restarts,
 * so a first start on a room with history raises only what began in the last L, and a restart
 * raises everything that came due while it was down. `record: false` (a dry run) reads a recorded
 * point and writes none. A torn record is a first start again: the conservative floor, never a flood.
 * The record: `{"v":1,"type":"messenger-start","since":"<iso>","startedAt":"<iso>","lookBackMs":<n>}`.
 * @param {string} file @param {{ now: number, lookBackMs: number, record: boolean }} o
 * @returns {Promise<{ since: number, startedAt: number, recorded: boolean, created: boolean }>}
 */
export async function messengerStart(file, o) {
  /** @returns {Promise<{ since: number, startedAt: number } | null | undefined>} undefined: no file; null: unreadable */
  const read = async () => {
    let text;
    try { text = await readFile(file, "utf8"); }
    catch (e) { if (/** @type {any} */ (e).code === "ENOENT") return undefined; throw e; }
    try {
      const j = JSON.parse(text);
      const since = Date.parse(j?.since);
      const startedAt = Date.parse(j?.startedAt);
      return j?.v === 1 && j?.type === "messenger-start" && Number.isFinite(since) && Number.isFinite(startedAt) ? { since, startedAt } : null;
    } catch { return null; }
  };
  const held = await read();
  if (held) return { ...held, recorded: true, created: false };
  const fresh = { since: o.now - o.lookBackMs, startedAt: o.now };
  if (!o.record) return { ...fresh, recorded: false, created: false };
  if (held === null) await rm(file, { force: true });
  await mkdir(path.dirname(file), { recursive: true });
  const text = JSON.stringify({ v: 1, type: "messenger-start", since: new Date(fresh.since).toISOString(), startedAt: new Date(fresh.startedAt).toISOString(), lookBackMs: o.lookBackMs }) + "\n";
  try {
    await writeFile(file, text, { flag: "wx" });
    return { ...fresh, recorded: true, created: true };
  } catch (e) {
    if (/** @type {any} */ (e).code !== "EEXIST") throw e;
    // another tick on the seat started first: its point stands
    const won = await read();
    return won ? { ...won, recorded: true, created: false } : { ...fresh, recorded: false, created: false };
  }
}

// ---------------------------------------------------------------------------------------------
// The seen records
// ---------------------------------------------------------------------------------------------

/**
 * Where a session keeps its delivery record: one line per message its watch admitted into its
 * intake, in the session's own state directory (`<state>/sessions/<key>/seen.jsonl`). The agora-room
 * plugins write it (plugins/claude/agora-room/hooks/lib.js SEEN_FILE, pinned equal in the tests);
 * the clock reads it from the seat that holds the session, so a member seat's record is read by the
 * member's own messenger and never by the host's, which runs no clock for an address held elsewhere.
 */
export const SEEN_FILE = "seen.jsonl";

/** The key a line is looked up by: the session that admitted it, and its message id. @param {string} session @param {string} id */
export const seenKey = (session, id) => `${session}\n${id}`;

/**
 * Read one session's seen lines for a room alias into `into`, keeping the earliest admission per
 * line. A line that is not a v1 seen record for this room, or has no readable instant, is skipped.
 * @param {string} text @param {string} session @param {string} room @param {Map<string, number>} into
 */
export function parseSeen(text, session, room, into) {
  for (const l of text.split("\n")) {
    const s = l.trim();
    if (!s.startsWith("{")) continue;
    let rec;
    try { rec = JSON.parse(s); } catch { continue; }
    if (rec?.v !== 1 || rec.type !== "seen" || rec.room !== room || typeof rec.id !== "string") continue;
    const at = Date.parse(rec.admittedAt);
    if (!Number.isFinite(at)) continue;
    const key = seenKey(session, rec.id);
    const prev = into.get(key);
    if (prev === undefined || at < prev) into.set(key, at);
  }
}

/**
 * Every seen record under a state root for one room alias: session and message id → the instant it
 * was admitted. A session with no file, or an unreadable one, contributes nothing, and its lines
 * read as unseen (the clock then runs from the post).
 * @param {string} stateRoot @param {string} room @returns {Promise<Map<string, number>>}
 */
export async function readSeen(stateRoot, room) {
  /** @type {Map<string, number>} */
  const out = new Map();
  for (const slug of await listSessions(stateRoot)) {
    let text;
    try { text = await readFile(path.join(stateRoot, "sessions", slug, SEEN_FILE), "utf8"); } catch { continue; }
    parseSeen(text, slug, room, out);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The activity records
// ---------------------------------------------------------------------------------------------

/**
 * Where a session keeps its activity record: what its own watch last saw the session doing, in the
 * session's own state directory (`<state>/sessions/<key>/activity.json`), rewritten whole by the
 * agora-room plugins (plugins/claude/agora-room/hooks/lib.js ACTIVITY_FILE, pinned equal in the
 * tests). `turn` is `busy` or `idle` since `since`; `lastToolAt` and `lastOutputAt` are the last tool
 * call and the last assistant output; `progress` counts transcript entries observed and `progressAt`
 * says when it last moved; `updatedAt` is the watch's own heartbeat, and `intervalMs` its poll
 * interval. It is the evidence the clocks run on: is the session still producing transcript, calling
 * tools, or sitting idle.
 */
export const ACTIVITY_FILE = "activity.json";

/**
 * One activity file's text as an `Activity`, or null when it is not a v1 record with readable instants.
 * @param {string} text @param {string} session @returns {Activity | null}
 */
export function parseActivity(text, session) {
  let rec;
  try { rec = JSON.parse(text); } catch { return null; }
  if (rec?.v !== 1 || rec.type !== "activity" || (rec.turn !== "busy" && rec.turn !== "idle")) return null;
  const at = (/** @type {unknown} */ v) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);
  const since = at(rec.since);
  const updatedAt = at(rec.updatedAt);
  if (since === null || updatedAt === null) return null;
  const interval = Number(rec.intervalMs);
  return {
    session, turn: rec.turn, since, lastToolAt: at(rec.lastToolAt), lastOutputAt: at(rec.lastOutputAt), progressAt: at(rec.progressAt),
    progress: Number.isInteger(rec.progress) && rec.progress >= 0 ? rec.progress : 0, updatedAt, intervalMs: Number.isFinite(interval) && interval > 0 ? interval : null,
  };
}

/**
 * Every activity record under a state root: session → what it was doing. A session with no file, or
 * an unreadable one, contributes nothing and reads as `none` (the time-only backstops run for it).
 * @param {string} stateRoot @returns {Promise<Map<string, Activity>>}
 */
export async function readActivity(stateRoot) {
  /** @type {Map<string, Activity>} */
  const out = new Map();
  for (const slug of await listSessions(stateRoot)) {
    let text;
    try { text = await readFile(path.join(stateRoot, "sessions", slug, ACTIVITY_FILE), "utf8"); } catch { continue; }
    const rec = parseActivity(text, slug);
    if (rec) out.set(slug, rec);
  }
  return out;
}

/**
 * The seat's evidence for a room, as the snapshot carries it: seen records and activity records.
 * @param {string} stateRoot @param {string} room
 */
export async function readEvidence(stateRoot, room) {
  return { seen: await readSeen(stateRoot, room), activity: await readActivity(stateRoot) };
}

/**
 * One tick: fold; when anything is due, under the room's lock fold again on a fresh read and post
 * what is still due. `dryRun` returns the acts and posts nothing.
 * @param {TickDeps} deps
 * @returns {Promise<{ due: Act[], posted: Array<Act & { id: string, cursor: string }>, locked: boolean, held: Held[] }>}
 */
export async function runTick(deps) {
  const first = fold(await deps.gather(), deps, deps.now());
  if (!first.acts.length || deps.dryRun) return { due: first.acts, posted: [], locked: false, held: first.held };
  /** @type {Array<Act & { id: string, cursor: string }>} */
  const posted = [];
  const ran = await deps.lock(async () => {
    const fresh = fold(await deps.gather(), deps, deps.now());
    for (const act of fresh.acts) posted.push({ ...act, ...(await deps.post(act)) });
    return true;
  });
  return { due: first.acts, posted, locked: ran === true, held: first.held };
}

/** A lock older than this is a crashed holder's, and is taken over. */
export const LOCK_STALE_MS = 60_000;

/**
 * The room's messenger lock: one tick posts at a time across every process on the seat (the stream
 * and the cycle's backstop tick). Exclusive create; a stale lock is taken over; a held one is
 * waited for up to `waitMs`, and the tick is skipped (undefined) past that.
 * @param {string} file @param {{ waitMs?: number }} [opts]
 * @returns {<T>(fn: () => Promise<T>) => Promise<T | undefined>}
 */
export function fileLock(file, opts = {}) {
  return async (fn) => {
    await mkdir(path.dirname(file), { recursive: true });
    const deadline = Date.now() + (opts.waitMs ?? 10_000);
    for (;;) {
      try { await writeFile(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: "wx" }); break; }
      catch (e) {
        if (/** @type {any} */ (e).code !== "EEXIST") throw e;
        let age = 0;
        /** @type {number | undefined} */ let holder;
        try { age = Date.now() - (await stat(file)).mtimeMs; } catch { continue; } // removed meanwhile: try again
        try { holder = Number(JSON.parse(await readFile(file, "utf8")).pid); } catch { holder = undefined; } // being written
        // a lock whose holder is gone (a stream killed mid-post) is taken over at once; past the
        // stale bound it is taken over whoever wrote it
        if (age > LOCK_STALE_MS || (Number.isInteger(holder) && holder !== process.pid && !pidAlive(/** @type {number} */ (holder)))) { await rm(file, { force: true }); continue; }
        if (Date.now() > deadline) return undefined;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    try { return await fn(); }
    finally { await rm(file, { force: true }); }
  };
}

/** Where a messenger's liveness is kept: beside its session, one file per room. @param {string} stateRoot @param {string} session @param {string} alias */
export function livenessPath(stateRoot, session, alias) {
  return path.join(stateRoot, "messenger", `${session}.${alias}.json`);
}

/**
 * The stream: a tick now, then on every room event and every T, until `until` or a stop. The
 * liveness file is rewritten after each tick (`harness: "agora"`, `updatedAt`, counters), in the
 * shape a supervisor reads the omp extension's.
 * @param {TickDeps & { wait: (ms: number) => Promise<void>, until: number | null, stopped: () => boolean,
 *   liveness: { file: string, base: Record<string, unknown> }, onTick?: (r: Awaited<ReturnType<typeof runTick>>) => void }} deps
 */
export async function runStream(deps) {
  const stats = { ticks: 0, posted: 0, errors: 0, lastError: /** @type {string | null} */ (null), lastTick: /** @type {string | null} */ (null) };
  const write = () => writeFileAtomic(deps.liveness.file, JSON.stringify({ ...deps.liveness.base, harness: "agora", pid: process.pid,
    intervalMs: deps.bounds.T, ready: stats.ticks > 0 && stats.lastError === null, ...stats, updatedAt: new Date().toISOString() }, null, 2) + "\n");
  await mkdir(path.dirname(deps.liveness.file), { recursive: true });
  while (!deps.stopped() && (deps.until === null || Date.now() < deps.until)) {
    try {
      const r = await runTick(deps);
      stats.posted += r.posted.length;
      stats.lastError = null;
      deps.onTick?.(r);
    } catch (e) {
      stats.errors++;
      stats.lastError = e instanceof Error ? e.message : String(e);
    }
    stats.ticks++;
    stats.lastTick = new Date().toISOString();
    await write();
    const left = deps.until === null ? deps.bounds.T : Math.min(deps.bounds.T, deps.until - Date.now());
    if (left > 0 && !deps.stopped()) await deps.wait(left);
  }
  return stats;
}
