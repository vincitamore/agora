// @ts-check
/**
 * The messenger: supervision of a room's clocks in code (docs/MESSENGER.md).
 *
 * One code path, `tick`: a pure fold over durable records (the room read with its titles and
 * pins, the board read, the seat's session records through the resolver) at an instant, returning
 * the acts that are due. The shell (`runTick`) gathers the records, asks `tick`, and when anything
 * is due takes the room's messenger lock, gathers again and posts what the fresh fold still says
 * is due. Nothing else is kept: **its own posts are its incident record**. Every notice is one of
 * a fixed set of one-line forms (`NOTICE_TEMPLATES`), and `tick` skips an act whose form already
 * stands in the room for that incident, so a restart duplicates nothing and an interval missed
 * while it was down is caught by the next tick.
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
import { pidAlive } from "./session.mjs";
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
});

/** @typedef {keyof typeof NOTICE_TEMPLATES} NoticeKind */

/**
 * The bounds, in milliseconds. R: delivery to taken, then N2. R2: the human line (N3) on either
 * clock. I: the grace after a lease expires before N4. Bo: an open subject before N6. H: the
 * horizon; an incident that started before it is not raised. T: the stream's interval tick.
 */
export const DEFAULT_BOUNDS = Object.freeze({ R: 900_000, R2: 2_700_000, I: 120_000, Bo: 1_800_000, H: 14_400_000, T: 30_000 });

/** @typedef {{ R: number, R2: number, I: number, Bo: number, H: number, T: number }} Bounds */

/**
 * `R=15m,R2=45m,I=2m,Bo=30m,H=4h,T=30s` (any subset; the rest are the defaults). Units ms, s, m, h.
 * @param {string | undefined} spec @returns {Bounds}
 */
export function parseBounds(spec) {
  /** @type {Bounds} */
  const b = { ...DEFAULT_BOUNDS };
  if (spec !== undefined && spec.trim()) {
    for (const part of spec.split(",")) {
      const m = /^\s*(R2|R|I|Bo|H|T)\s*=\s*(\d+)(ms|s|m|h)\s*$/.exec(part);
      if (!m) throw new AgoraError(`--bounds takes NAME=<n><ms|s|m|h> joined by commas (names R, R2, I, Bo, H, T), not ${JSON.stringify(part)}`, EXIT.usage);
      b[/** @type {keyof Bounds} */ (m[1])] = Number(m[2]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[/** @type {'ms' | 's' | 'm' | 'h'} */ (m[3])];
    }
  }
  if (!(b.R > 0 && b.R < b.R2)) throw new AgoraError(`--bounds needs 0 < R < R2 (R ${b.R} ms, R2 ${b.R2} ms)`, EXIT.usage);
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

/** @type {Array<[NoticeKind, RegExp, string[]]>} */
const PARSERS = /** @type {any} */ (Object.entries(NOTICE_TEMPLATES).map(([kind, template]) => {
  /** @type {string[]} */
  const slots = [];
  const source = template.split(SLOT).map((piece, i) => {
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
  }
  return `${kind}`;
}

/**
 * @typedef {{ kind: NoticeKind, key: string, text: string, trailers: Array<{ key: string, value: string }>, thread: string | undefined }} Act
 * @typedef {import('./board-read.mjs').Resolution} Resolution
 * @typedef {{
 *   now: number, messages: any[], titles: Map<string, string>, pinned: Set<string>, boardRecords: any[],
 *   accountId: string | null, resolve: (address: string) => Resolution, human: string, bounds: Bounds,
 * }} TickInput
 */

/** @param {string} cursor */
const seqOf = (cursor) => { try { return parseNativeCursor(cursor).sequence; } catch { return 0; } };

/**
 * The acts due at `now`. Pure.
 * @param {TickInput} input
 * @returns {{ acts: Act[], notices: number }}
 */
export function tick(input) {
  const { now, bounds, human } = input;
  const ms = input.messages.map((m) => {
    const { trailers, to } = parseTrailers(String(m.text ?? ""));
    return { raw: m, id: String(m.id), cursor: String(m.cursor), seq: seqOf(String(m.cursor)), ts: Date.parse(m.ts), thread: m.thread,
      root: m.thread ?? String(m.id), human: m.author?.kind === "human", accountId: m.author?.id, bearer: String(m.signedAs ?? m.author?.name ?? ""),
      trailers, to, notice: parseNotice(String(m.text ?? "")) };
  }).sort((a, b) => a.seq - b.seq);
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
  const horizon = now - bounds.H;
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
  /** has the addressee taken the message: a claim of msg:<id>, or its post that cites it (re:, or a reply in its thread)
   * @param {typeof ms[number]} m @param {string} addr @param {import('./board-read.mjs').ResolvedHolder[]} holders */
  const taken = (m, addr, holders) => {
    const named = (/** @type {string} */ bearer) => holders.some((h) => h.bearer === bearer) || matchesAddress(addr, bearer);
    const claim = claimedSubject(m.id);
    if (claim) {
      const who = authors.get(claim.subject)?.bearer;
      if (who === undefined || named(who)) return true;
    }
    return ms.some((x) => x.seq > m.seq && !x.notice && named(x.bearer) && (trailer(x, "re") === m.id || trailer(x, "re") === m.cursor || x.thread === m.id));
  };
  /** clock 1 for one (message, address) @param {typeof ms[number]} m @param {string} addr @param {import('./board-read.mjs').ResolvedHolder[]} holders @param {number} startTs */
  const clock1 = (m, addr, holders, startTs) => {
    if (taken(m, addr, holders)) return;
    const age = now - startTs;
    if (age >= bounds.R) emit("N2", m.seq, { age: formatAge(age), since: "posted", id: m.id }, [{ key: "to", value: addr }, { key: "re", value: m.id }], m.root);
    if (age >= bounds.R2) {
      const position = [...new Set(holders.map((h) => h.position ?? h.bearer))].join("+");
      const verdict = [...new Set(holders.map((h) => h.verdict))].join("+");
      emit("N3", m.seq, { position, verb: "taken", id: m.id, age: formatAge(age), verdict }, [{ key: "to", value: human }, { key: "re", value: m.id }], m.root);
    }
  };

  for (const m of ms) {
    if (m.notice || m.ts < horizon) continue;
    // clock 1 on addressed lines, and the unmatched-address pointer
    if (m.to.length && trailer(m, "ack") !== "none") {
      for (const addr of m.to) {
        const r = resolve(addr);
        if (r.kind === "everyone" || r.kind === "seat" || r.kind === "person") continue;
        if (r.kind === "none") {
          emit("N5", m.seq, { addr, kind: r.why ?? "unknown", nearest: r.nearest ?? "none" }, [{ key: "re", value: m.id }], m.root);
          continue;
        }
        const local = localOf(r);
        if (local.length) clock1(m, addr, local, m.ts);
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
        if (local.length) clock1(m, addr, local, route.ts);
      }
    }
    // a reply posted at top level
    const re = trailer(m, "re");
    if (!m.thread && re) {
      const cited = byRef.get(re);
      if (cited && cited.root !== m.id) emit("N7", m.seq, { root: cited.root }, [{ key: "re", value: m.id }], cited.root);
    }
    // an open subject: a titled human root addressed to nothing this seat holds
    if (m.human && !m.thread && input.titles.has(m.id) && !input.pinned.has(m.id) && m.to.length
      && !m.to.some((a) => ["role", "position"].includes(resolve(a).kind) && localOf(resolve(a)).length)) {
      const age = now - m.ts;
      const answered = ms.some((x) => x.seq > m.seq && !x.notice && !x.human && (x.thread === m.id || trailer(x, "re") === m.id));
      if (age >= bounds.Bo && !claimedSubject(m.id) && !answered) {
        const target = orchestrator().length ? "orchestrator" : human;
        emit("N6", m.seq, { id: m.id, age: formatAge(age) }, [{ key: "to", value: target }, { key: "re", value: m.id }], m.id);
      }
    }
  }

  // clock 2: a lease of this seat's that lapsed with no renew, release or verdict
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
    if (since < bounds.I) continue;
    emit("N4", from, { subject: s.subject, age: formatAge(since) }, [{ key: "to", value: author.bearer }], author.root);
    if (since >= bounds.R2) {
      const holders = localOf(resolve(author.bearer));
      const position = holders.length ? [...new Set(holders.map((h) => h.position ?? h.bearer))].join("+") : author.bearer;
      const verdict = holders.length ? [...new Set(holders.map((h) => h.verdict))].join("+") : "absent";
      emit("N3", from, { position, verb: "renewed", id: s.subject, age: formatAge(since), verdict }, [{ key: "to", value: human }], author.root);
    }
  }
  return { acts, notices: done.size };
}

// ---------------------------------------------------------------------------------------------
// The shell
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {{ messages: any[], annotations: any[], boardRecords: any[], resolve: (a: string) => Resolution }} Snapshot
 * @typedef {{
 *   gather: () => Promise<Snapshot>, post: (act: Act) => Promise<{ id: string, cursor: string }>,
 *   lock: <T>(fn: () => Promise<T>) => Promise<T | undefined>, now: () => number,
 *   accountId: string | null, human: string, bounds: Bounds, dryRun?: boolean,
 * }} TickDeps
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
    resolve: snap.resolve, human: deps.human, bounds: deps.bounds });
}

/**
 * One tick: fold; when anything is due, under the room's lock fold again on a fresh read and post
 * what is still due. `dryRun` returns the acts and posts nothing.
 * @param {TickDeps} deps
 * @returns {Promise<{ due: Act[], posted: Array<Act & { id: string, cursor: string }>, locked: boolean }>}
 */
export async function runTick(deps) {
  const first = fold(await deps.gather(), deps, deps.now());
  if (!first.acts.length || deps.dryRun) return { due: first.acts, posted: [], locked: false };
  /** @type {Array<Act & { id: string, cursor: string }>} */
  const posted = [];
  const ran = await deps.lock(async () => {
    const fresh = fold(await deps.gather(), deps, deps.now());
    for (const act of fresh.acts) posted.push({ ...act, ...(await deps.post(act)) });
    return true;
  });
  return { due: first.acts, posted, locked: ran === true };
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
