// @ts-check
// The messenger's tick: the pinned notice set, the two clocks, routing with no model, the pointer
// notices, and its own posts as the incident record (no duplicate after a restart). Every check
// here has a red leg beside it: the variation that must move it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as messenger from "../src/messenger.mjs";
import {
  ACTIVITY_FILE, DEFAULT_BOUNDS, NOTICE_TEMPLATES, SEEN_FILE, evidenceOf, fileLock, formatAge, formatNotice, noticeKey, parseBounds, parseNotice, parseSeen,
  queueOf, readActivity, readEvidence, readSeen, runTick, seenKey, tick,
} from "../src/messenger.mjs";
import { ACTIVITY_FILE as PLUGIN_ACTIVITY_FILE, ActivityTracker, SEEN_FILE as PLUGIN_SEEN_FILE, SeenLog, seenRecord } from "../plugins/claude/agora-room/hooks/lib.js";
import { resolveAddress } from "../src/board-read.mjs";
import { withTrailers } from "../src/trailers.mjs";

// A notice is a pointer, never a paraphrase: it carries ids, ages and names and never the words of
// the message it points at. This pin is the whole set, by exact equality, so a form that grows a
// slot for a message's text (or a new form) is a red bar here and a reviewed change, not drift.
test("the notice set is exactly these thirteen forms", () => {
  assert.deepEqual({ ...NOTICE_TEMPLATES }, {
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
    N13: "On arming: queued {queued}; active {active}.",
  });
  assert.ok(Object.isFrozen(NOTICE_TEMPLATES));
  assert.deepEqual({ ...DEFAULT_BOUNDS }, { R: 7_200_000, R2: 14_400_000, I: 3_600_000, Bo: 14_400_000, H: 86_400_000, L: 600_000, T: 30_000, G: 600_000, G2: 1_800_000, S: 7_200_000, D: 300_000 });
});

test("every form reads back as itself; a slot is one token (red leg: a slot with a space is refused)", () => {
  const sample = { id: "a".repeat(64), age: "16m", since: "posted", position: "desk.coding", verb: "taken", verdict: "unknown", subject: "work:msg:x",
    addr: "builder", kind: "retired", nearest: "desk.coding", root: "b".repeat(64), attestor: "observe", path: "ensure", outcome: "ready", human: "Ada",
    task: "task:parser-fix", person: "Ada", queued: `task:slugify@${"d".repeat(64)},task:chunk@${"e".repeat(64)}`, active: "none" };
  for (const kind of /** @type {(keyof typeof NOTICE_TEMPLATES)[]} */ (Object.keys(NOTICE_TEMPLATES))) {
    const text = withTrailers(formatNotice(kind, sample), [{ key: "re", value: "c".repeat(64) }]) + "\n\n-- messenger/Code";
    const back = parseNotice(text);
    assert.equal(back?.kind, kind, text);
    assert.equal(back?.re, "c".repeat(64));
    for (const slot of [...NOTICE_TEMPLATES[kind].matchAll(/\{([a-z]+)\}/g)].map((m) => m[1])) assert.equal(back?.fields[slot], /** @type {any} */ (sample)[slot]);
  }
  assert.throws(() => formatNotice("N5", { ...sample, addr: "two words" }), /one token/);
  assert.equal(parseNotice("Not taken soon: abc. And some more words"), null, "a paraphrase is not a notice");
});

test("ages and bounds", () => {
  assert.deepEqual([0, 999, 42_000, 60_000, 16 * 60_000, 3_900_000].map(formatAge), ["0s", "0s", "42s", "1m", "16m", "1h05m"]);
  assert.deepEqual(parseBounds("R=90s,R2=270s,I=12s,Bo=3m,H=1h,T=5s"), { ...DEFAULT_BOUNDS, R: 90_000, R2: 270_000, I: 12_000, Bo: 180_000, H: 3_600_000, T: 5_000 });
  assert.deepEqual(parseBounds("G=1m,G2=3m,S=90m,D=2m"), { ...DEFAULT_BOUNDS, G: 60_000, G2: 180_000, S: 5_400_000, D: 120_000 });
  assert.deepEqual(parseBounds(undefined), { ...DEFAULT_BOUNDS });
  assert.throws(() => parseBounds("R=10m,R2=5m"), /0 < R < R2/);
  assert.throws(() => parseBounds("G=40m"), /0 < G < G2/);
  assert.throws(() => parseBounds("S=0s"), /S and D above 0/);
  assert.throws(() => parseBounds("X=1m"), /--bounds takes/);
});

// ---- a synthetic room ----
const EPOCH = "e".repeat(32);
const T0 = Date.parse("2026-01-01T10:00:00.000Z");
const MIN = 60_000;
const HOST = "acct-host";
let seq = 0;
/** @param {{ id?: string, at: number, kind?: string, name: string, text: string, to?: string[], re?: string, thread?: string, claim?: string, release?: string, account?: string, extra?: Array<{ key: string, value: string }> }} p */
function msg(p) {
  seq++;
  const trailers = [...(p.to ?? []).map((v) => ({ key: "to", value: v })), ...(p.re ? [{ key: "re", value: p.re }] : []),
    ...(p.claim ? [{ key: "claim", value: p.claim }] : []), ...(p.release ? [{ key: "release", value: p.release }] : []), ...(p.extra ?? [])];
  const body = withTrailers(p.text, trailers);
  const human = (p.kind ?? "agent") === "human";
  return { id: p.id ?? `m${String(seq).padStart(4, "0")}`, cursor: `${EPOCH}:${seq}`, ts: new Date(p.at).toISOString(), ...(p.thread ? { thread: p.thread } : {}),
    author: { id: p.account ?? HOST, name: p.name, kind: p.kind ?? "agent" }, text: human ? body : `${body}\n\n-- ${p.name}`, ...(human ? {} : { signedAs: p.name }) };
}
/** a notice the messenger posted, as the room holds it @param {number} at @param {keyof typeof NOTICE_TEMPLATES} kind @param {Record<string, string>} f @param {Array<{ key: string, value: string }>} trailers @param {string} [thread] */
function notice(at, kind, f, trailers, thread) {
  seq++;
  return { id: `n${String(seq).padStart(4, "0")}`, cursor: `${EPOCH}:${seq}`, ts: new Date(at).toISOString(), ...(thread ? { thread } : {}),
    author: { id: HOST, name: "messenger/Code", kind: "agent" }, signedAs: "messenger/Code", text: `${withTrailers(formatNotice(kind, f), trailers)}\n\n-- messenger/Code` };
}
const live = /** @type {const} */ ("live");
const RECORDS = [
  { slug: "s-coding", state: live, record: /** @type {any} */ ({ bearer: "coding/Opus", label: "desk.coding" }), posted: new Set() },
  { slug: "s-orch", state: live, record: /** @type {any} */ ({ bearer: "orchestrator/Opus", label: "desk.orchestrator" }), posted: new Set() },
];
/** the tight time-only backstops the clock cases below are written against; the defaults are hours (pinned above) */
const SHORT = { ...DEFAULT_BOUNDS, R: 15 * 60_000, R2: 45 * 60_000, I: 2 * 60_000, Bo: 30 * 60_000, H: 4 * 60 * 60_000 };
/** an activity record as the reader gives it, quiet and fresh unless said otherwise @param {string} session @param {Partial<import("../src/messenger.mjs").Activity>} [o] @returns {import("../src/messenger.mjs").Activity} */
const ACT = (session, o = {}) => ({ session, turn: "idle", since: T0, lastToolAt: null, lastOutputAt: null, progressAt: null, progress: 0, updatedAt: T0, intervalMs: 2000, ...o });
/** a holder's record, written just now (a live watch) @param {string} session @param {number} now @param {Partial<import("../src/messenger.mjs").Activity>} o */
const fresh = (session, now, o) => ACT(session, { updatedAt: now - 30_000, ...o });
/** @param {any[]} messages @param {{ now: number, board?: any[], records?: any[], titles?: Map<string, string>, pinned?: Set<string>, bounds?: any, seen?: Array<[string, string, number]>, activity?: import("../src/messenger.mjs").Activity[], since?: number }} o */
function runFull(messages, o) {
  const records = o.records ?? RECORDS;
  const ctx = { seatName: "host", accountId: HOST, records, messages };
  return tick({ now: o.now, messages, titles: o.titles ?? new Map(), pinned: o.pinned ?? new Set(), boardRecords: o.board ?? [], accountId: HOST,
    resolve: (a) => resolveAddress(a, ctx), human: "Ada", bounds: o.bounds ?? { ...SHORT }, records,
    ...(o.seen ? { seen: new Map(o.seen.map(([slug, id, at]) => [seenKey(slug, id), at])) } : {}),
    ...(o.activity ? { activity: new Map(o.activity.map((a) => [a.session, a])) } : {}),
    ...(o.since !== undefined ? { since: o.since } : {}) });
}
const run = (/** @type {any[]} */ messages, /** @type {Parameters<typeof runFull>[1]} */ o) => runFull(messages, o).acts;
const kinds = (/** @type {any[]} */ acts) => acts.map((a) => a.kind);

test("clock 1: nothing before R, one N2 at R, one N3 at R2; each once (red leg: with no notice in the room, a later tick asks again)", () => {
  const q = msg({ at: T0, kind: "human", name: "Ada", text: "Parser fails on the fixture", to: ["coding"] });
  assert.deepEqual(kinds(run([q], { now: T0 + 15 * MIN - 1 })), []);
  const atR = run([q], { now: T0 + 15 * MIN });
  assert.deepEqual(kinds(atR), ["N2"]);
  assert.equal(atR[0].text, `Not taken 15m since posted: ${q.id}.`);
  assert.deepEqual(atR[0].trailers, [{ key: "to", value: "coding" }, { key: "re", value: q.id }]);
  assert.equal(atR[0].thread, q.id, "posted in the subject's thread");
  const n2 = notice(T0 + 15 * MIN, "N2", { age: "15m", since: "posted", id: q.id }, atR[0].trailers, q.id);
  assert.deepEqual(kinds(run([q, n2], { now: T0 + 16 * MIN })), [], "its own post is the record: no second N2");
  assert.deepEqual(kinds(run([q], { now: T0 + 16 * MIN })), ["N2"], "red leg: without the notice the incident is still open");
  const atR2 = run([q, n2], { now: T0 + 45 * MIN });
  assert.deepEqual(kinds(atR2), ["N3"]);
  assert.equal(atR2[0].text, `desk.coding has not taken ${q.id} after 45m; observe: unknown.`);
  assert.deepEqual(atR2[0].trailers, [{ key: "to", value: "Ada" }, { key: "re", value: q.id }]);
  // down past R2: both are due, each once
  assert.deepEqual(kinds(run([q], { now: T0 + 50 * MIN })), ["N2", "N3"]);
});

test("clock 1 runs from the seen record when a session has one, else from the post (red legs: no record; a record for another session; a record from the future)", () => {
  const q = msg({ at: T0, kind: "human", name: "Ada", text: "Parser fails on the fixture", to: ["coding"] });
  const seenAt = T0 + 10 * MIN;
  const seen = /** @type {Array<[string, string, number]>} */ ([["s-coding", q.id, seenAt]]);
  // the post is 24 minutes old, the delivery 14: R has not run
  assert.deepEqual(kinds(run([q], { now: T0 + 24 * MIN, seen })), []);
  assert.deepEqual(kinds(run([q], { now: T0 + 24 * MIN })), ["N2"], "red leg: with no record the same instant is past R from the post");
  const atR = run([q], { now: seenAt + 15 * MIN, seen });
  assert.deepEqual(kinds(atR), ["N2"]);
  assert.equal(atR[0].text, `Not taken 15m since seen: ${q.id}.`);
  assert.deepEqual(parseNotice(atR[0].text)?.fields, { age: "15m", since: "seen", id: q.id }, "the pinned form reads its own seen line back");
  const n2 = notice(seenAt + 15 * MIN, "N2", { age: "15m", since: "seen", id: q.id }, atR[0].trailers, q.id);
  assert.deepEqual(kinds(run([q, n2], { now: seenAt + 20 * MIN, seen })), [], "its own post is still the record");
  // R2 from the seen instant too
  assert.deepEqual(kinds(run([q, n2], { now: seenAt + 44 * MIN, seen })), []);
  const atR2 = run([q, n2], { now: seenAt + 45 * MIN, seen });
  assert.deepEqual(kinds(atR2), ["N3"]);
  assert.equal(atR2[0].text, `desk.coding has not taken ${q.id} after 45m; observe: unknown.`);
  // another session's record, and one that has not happened yet at the folded instant, do not start it
  assert.deepEqual(kinds(run([q], { now: T0 + 24 * MIN, seen: [["s-orch", q.id, seenAt]] })), ["N2"]);
  assert.deepEqual(kinds(run([q], { now: T0 + 24 * MIN, seen: [["s-coding", q.id, T0 + 30 * MIN]] })), ["N2"], "a replay before the delivery reads it as unseen");
  // an instant before the post (a skewed clock) cannot start the clock before the post
  assert.deepEqual(kinds(run([q], { now: T0 + 15 * MIN, seen: [["s-coding", q.id, T0 - 20 * MIN]] })), ["N2"]);
  // taken stops it whichever way it started
  const reply = msg({ at: T0 + 12 * MIN, name: "coding/Opus", text: "on it", thread: q.id });
  assert.deepEqual(kinds(run([q, reply], { now: seenAt + 50 * MIN, seen })), []);
});

test("a routed request's clock runs from the route line's seen record, not the request's (red leg: the request's own id)", () => {
  const q = msg({ at: T0, kind: "human", name: "Ada", text: "can someone run the suite?" });
  const route = notice(T0 + 1, "N1", { id: q.id }, [{ key: "to", value: "orchestrator" }, { key: "re", value: q.id }], q.id);
  const seenAt = T0 + 20 * MIN;
  assert.deepEqual(kinds(run([q, route], { now: T0 + 30 * MIN, seen: [["s-orch", route.id, seenAt]] })), [], "10 minutes since the route line reached it");
  const due = run([q, route], { now: seenAt + 15 * MIN, seen: [["s-orch", route.id, seenAt]] });
  assert.deepEqual(kinds(due), ["N2"]);
  assert.equal(due[0].text, `Not taken 15m since seen: ${q.id}.`);
  assert.deepEqual(kinds(run([q, route], { now: T0 + 30 * MIN, seen: [["s-orch", q.id, seenAt]] })), ["N2"], "red leg: a record keyed by the request is not the route line's");
});

test("the seen record: the plugins' writer and the messenger's reader agree on the file and the line (red legs: another room, another version, a torn line)", async (t) => {
  assert.equal(SEEN_FILE, PLUGIN_SEEN_FILE, "one file name, written by the plugins and read here");
  const dir = await mkdtemp(path.join(tmpdir(), "agora-seen-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const at = "2026-01-01T10:10:00.000Z";
  const log = new SeenLog(null);
  log.add(seenRecord({ session: "s-coding", position: "desk.coding", room: "lab", id: "m1", cursor: "c1", readAt: at, admittedAt: at }));
  log.add(seenRecord({ session: "s-coding", position: "desk.coding", room: "other", id: "m2", cursor: "c2", readAt: at, admittedAt: at }));
  const later = "2026-01-01T10:30:00.000Z";
  log.add(seenRecord({ session: "s-coding", position: "desk.coding", room: "lab", id: "m1", cursor: "c1", readAt: later, admittedAt: later }));
  await mkdir(path.join(dir, "sessions", "s-coding"), { recursive: true });
  await writeFile(path.join(dir, "sessions", "s-coding", SEEN_FILE), `${log.text()}{"v":1,"type":"seen","room":"lab","id":"torn\n{"v":2,"type":"seen","room":"lab","id":"m3","admittedAt":"${at}"}\n`);
  await mkdir(path.join(dir, "sessions", "s-none"), { recursive: true });
  const got = await readSeen(dir, "lab");
  assert.deepEqual([...got.entries()], [[seenKey("s-coding", "m1"), Date.parse(at)]], "the earliest admission of m1; not the other room's m2; not v2's m3; not the torn line");
  assert.equal((await readSeen(path.join(dir, "missing"), "lab")).size, 0, "no state root, no records");
  const into = new Map();
  parseSeen(log.text(), "s-other", "other", into);
  assert.deepEqual([...into.keys()], [seenKey("s-other", "m2")]);
});

test("clock 1 stops at a claim of msg:<id> by the addressee or its reply citing the message (red leg: a reply by someone else does not stop it)", () => {
  const q = msg({ at: T0, kind: "human", name: "Ada", text: "look please", to: ["coding"] });
  const reply = msg({ at: T0 + MIN, name: "coding/Opus", text: "on it", re: q.id });
  assert.deepEqual(kinds(run([q, reply], { now: T0 + 50 * MIN })), ["N7"], "taken; the top-level re: reply draws only its pointer");
  const threaded = msg({ at: T0 + MIN, name: "coding/Opus", text: "on it", thread: q.id });
  assert.deepEqual(kinds(run([q, threaded], { now: T0 + 50 * MIN })), []);
  // a claim posted top level, citing nothing: the board claim alone stops the clock
  const claimMsg = msg({ at: T0 + MIN, name: "coding/Opus", text: "taking", claim: `msg:${q.id}` });
  const board = [{ cursor: `${EPOCH}:${seq - 1}`, accountId: HOST, operationId: "op1", board: { action: "claim", subject: `work:msg:${q.id}` }, expiresAt: new Date(T0 + 61 * MIN).toISOString(), leaseMs: 3_600_000 }];
  assert.deepEqual(kinds(run([q, claimMsg], { now: T0 + 50 * MIN, board })), []);
  assert.deepEqual(kinds(run([q, claimMsg], { now: T0 + 50 * MIN })), ["N2", "N3"], "red leg: the trailer without the board claim is not a claim");
  const other = msg({ at: T0 + MIN, name: "review/Argon", text: "not me", thread: q.id });
  assert.deepEqual(kinds(run([q, other], { now: T0 + 50 * MIN })), ["N2", "N3"]);
});

test("clock 1 stops at the addressee's later post in the same subject when the line is itself a reply there (red legs: its post in another subject; a post there by someone else; its post before the line)", () => {
  const root = msg({ at: T0, kind: "human", name: "Ada", text: "the release", to: ["*"] });
  const before = msg({ at: T0 + 30_000, name: "coding/Opus", text: "looking at the release", thread: root.id });
  const ask = msg({ at: T0 + MIN, name: "orchestrator/Opus", text: "please cut the build", to: ["coding"], thread: root.id });
  const later = msg({ at: T0 + 2 * MIN, name: "coding/Opus", text: "built", thread: root.id });
  const elsewhere = msg({ at: T0 + 2 * MIN, name: "coding/Opus", text: "built", thread: "m-another-subject" });
  const byOther = msg({ at: T0 + 2 * MIN, name: "review/Argon", text: "built", thread: root.id });
  const now = T0 + 50 * MIN;
  assert.deepEqual(kinds(run([root, ask, later], { now })), [], "the addressee posted in the line's subject after it: taken");
  assert.deepEqual(kinds(run([root, ask, elsewhere], { now })), ["N2", "N3"], "red leg: its post is in another subject");
  assert.deepEqual(kinds(run([root, ask, byOther], { now })), ["N2", "N3"], "red leg: someone else posted there");
  assert.deepEqual(kinds(run([root, before, ask], { now })), ["N2", "N3"], "red leg: its post came before the line");
  // a line to a position, taken by the position's holder posting in the subject
  const toPosition = msg({ at: T0 + 3 * MIN, name: "orchestrator/Opus", text: "and tag it", to: ["desk.coding"], thread: root.id });
  const tagged = msg({ at: T0 + 4 * MIN, name: "coding/Opus", text: "tagged", thread: root.id });
  assert.deepEqual(kinds(run([root, toPosition, tagged], { now })), []);
  assert.deepEqual(kinds(run([root, toPosition], { now })), ["N2", "N3"], "red leg: no post after it");
});

test("a foreign addressee, a person, everyone and ack: none draw no clock; an unmatched address draws one N5 (red leg: a live holder of the name)", () => {
  const foreignPost = msg({ at: T0 - MIN, name: "lin-coder/Kimi", text: "hello", account: "acct-peer" });
  const toForeign = msg({ at: T0, name: "coding/Opus", text: "for you", to: ["lin-coder"] });
  const toPerson = msg({ at: T0, kind: "human", name: "Ada", text: "hi" });
  const toAda = msg({ at: T0, name: "coding/Opus", text: "for Ada", to: ["Ada"] });
  const toAll = msg({ at: T0, name: "coding/Opus", text: "all", to: ["*"] });
  const fyi = msg({ at: T0, name: "orchestrator/Opus", text: "fyi", to: ["coding"], extra: [{ key: "ack", value: "none" }] });
  const acts = run([foreignPost, toForeign, toPerson, toAda, toAll, fyi], { now: T0 + 50 * MIN, pinned: new Set([toPerson.id]) });
  assert.deepEqual(kinds(acts), []);
  const typo = msg({ at: T0, name: "orchestrator/Opus", text: "please", to: ["cod"] });
  const n5 = run([typo], { now: T0 + 1 });
  assert.deepEqual(kinds(n5), ["N5"]);
  assert.equal(n5[0].text, "to: cod names no holder here (half-name); nearest: desk.coding.");
  assert.deepEqual(n5[0].trailers, [{ key: "re", value: typo.id }]);
  assert.deepEqual(kinds(run([typo], { now: T0 + 1, records: [...RECORDS, { slug: "s-cod", state: live, record: { bearer: "cod/Haiku", label: "desk.cod" }, posted: new Set() }] })), [], "red leg: a holder named cod");
});

test("N5 names the one live holder a typo is one letter from, and says ambiguous for two (red leg: two letters off names none)", () => {
  const typo = msg({ at: T0, name: "orchestrator/Opus", text: "please", to: ["desk.codng"] });
  assert.deepEqual(run([typo], { now: T0 + 1 }).map((a) => a.text), ["to: desk.codng names no holder here (unknown); nearest: desk.coding."]);
  const far = msg({ at: T0, name: "orchestrator/Opus", text: "please", to: ["desk.cdng"] });
  assert.deepEqual(run([far], { now: T0 + 1 }).map((a) => a.text), ["to: desk.cdng names no holder here (unknown); nearest: none."]);
  const twin = { slug: "s-codes", state: live, record: /** @type {any} */ ({ bearer: "codes/Opus", label: "desk.codes" }), posted: new Set() };
  const both = msg({ at: T0, name: "orchestrator/Opus", text: "please", to: ["desk.codex"] });
  const coder = { slug: "s-coder", state: live, record: /** @type {any} */ ({ bearer: "coder/Opus", label: "desk.coder" }), posted: new Set() };
  assert.deepEqual(run([both], { now: T0 + 1, records: [...RECORDS, twin, coder] }).map((a) => a.text), ["to: desk.codex names no holder here (unknown); nearest: ambiguous."]);
});

test("routing with no model: holder of the subject, else the orchestrator, else N9 to the host human (red leg: no orchestrator stood)", () => {
  const q = msg({ at: T0, kind: "human", name: "Ada", text: "can someone run the suite?" });
  const r = run([q], { now: T0 + 1 });
  assert.deepEqual(kinds(r), ["N1"]);
  assert.equal(r[0].text, `Routed: unaddressed request ${q.id}.`);
  assert.deepEqual(r[0].trailers, [{ key: "to", value: "orchestrator" }, { key: "re", value: q.id }]);
  const n9 = run([q], { now: T0 + 1, records: [RECORDS[0]] });
  assert.deepEqual(kinds(n9), ["N9"]);
  assert.equal(n9[0].text, `No role fits ${q.id}; for Ada.`);
  // a reply in a held subject goes to its holder
  const root = msg({ at: T0, kind: "human", name: "Ada", text: "task", to: ["coding"] });
  const take = msg({ at: T0 + MIN, name: "coding/Opus", text: "taking", claim: `msg:${root.id}`, thread: root.id });
  const board = [{ cursor: `${EPOCH}:${seq - 1}`, accountId: HOST, operationId: "op2", board: { action: "claim", subject: `work:msg:${root.id}` }, expiresAt: new Date(T0 + 100 * MIN).toISOString(), leaseMs: 3_600_000 }];
  const follow = msg({ at: T0 + 2 * MIN, kind: "human", name: "Ada", text: "also the docs", thread: root.id });
  const held = run([root, take, follow], { now: T0 + 2 * MIN + 1, board });
  assert.deepEqual(held.map((a) => [a.kind, a.trailers[0].value]), [["N1", "coding/Opus"]]);
  // the routed line starts clock 1 for the orchestrator, once
  const routed = notice(T0 + 1, "N1", { id: q.id }, r[0].trailers, q.id);
  assert.deepEqual(kinds(run([q, routed], { now: T0 + 15 * MIN + 1 })), ["N2"]);
  const answer = msg({ at: T0 + 2 * MIN, name: "orchestrator/Opus", text: "queued", thread: q.id });
  assert.deepEqual(kinds(run([q, routed, answer], { now: T0 + 50 * MIN })), []);
  // the Room subject is room business: never routed
  assert.deepEqual(kinds(run([q], { now: T0 + 1, pinned: new Set([q.id]) })), []);
});

test("N7 for a top-level reply naming its subject; N6 for an open titled subject at Bo (red legs: a reply in the thread; a claim)", () => {
  const root = msg({ at: T0, kind: "human", name: "Ada", text: "question", to: ["*"] });
  const top = msg({ at: T0 + MIN, name: "coding/Opus", text: "answer", re: root.id });
  const n7 = run([root, top], { now: T0 + MIN + 1, titles: new Map([[root.id, "Q"]]) });
  assert.deepEqual(n7.map((a) => [a.kind, a.text, a.thread]), [["N7", `Reply posted at top level; its subject is ${root.id}.`, root.id]]);
  const n6 = run([root], { now: T0 + 30 * MIN, titles: new Map([[root.id, "Q"]]) });
  assert.deepEqual(n6.map((a) => [a.kind, a.text, a.trailers[0].value]), [["N6", `Open subject ${root.id} unclaimed after 30m.`, "orchestrator"]]);
  assert.deepEqual(kinds(run([root], { now: T0 + 30 * MIN - 1, titles: new Map([[root.id, "Q"]]) })), []);
  assert.deepEqual(kinds(run([root], { now: T0 + 30 * MIN })), [], "untitled: no subject to name");
  const inThread = msg({ at: T0 + MIN, name: "review/Argon", text: "looking", thread: root.id });
  assert.deepEqual(kinds(run([root, inThread], { now: T0 + 30 * MIN, titles: new Map([[root.id, "Q"]]) })), []);
  const board = [{ cursor: `${EPOCH}:${seq}`, accountId: HOST, operationId: "op3", board: { action: "claim", subject: `work:msg:${root.id}` }, expiresAt: new Date(T0 + 100 * MIN).toISOString(), leaseMs: 3_600_000 }];
  assert.deepEqual(kinds(run([root], { now: T0 + 30 * MIN, titles: new Map([[root.id, "Q"]]), board })), []);
});

// ---- the queue: tasks folded from trailers, the queued-stall clock, the waiting record ----
/** @param {number} at @param {string} root @param {string} slug @param {string} [text] the orchestrator's intake reply, marking the subject `task: <slug>` */
const intake = (at, root, slug, text = `queued ${slug}, position 1`) => msg({ at, name: "orchestrator/Opus", text, thread: root, to: ["Ada"], re: root, extra: [{ key: "task", value: slug }] });
/** @param {number} at @param {string} root @param {string} slug */
const takeTask = (at, root, slug) => msg({ at, name: "orchestrator/Opus", text: `taking ${slug}`, thread: root, to: ["Ada"], claim: `task:${slug}` });
/** @param {number} at @param {string} root @param {string} slug */
const closeTask = (at, root, slug) => msg({ at, name: "orchestrator/Opus", text: `closing ${slug}`, thread: root, to: ["Ada"], release: `task:${slug}`,
  extra: [{ key: "verdict", value: "pass" }, { key: "exhibit", value: "review 1" }] });
/** @param {number} at @param {string} root @param {string} slug @param {string} [text] */
const parkTask = (at, root, slug, text = "waiting: Ada; needs: the operation that is slow") => msg({ at, name: "orchestrator/Opus", text, thread: root, to: ["Ada"], release: `task:${slug}` });
/** @param {number} at @param {string} text a human request addressed to the orchestrator, so its own clock stops at the intake reply */
const ask = (at, text) => msg({ at, kind: "human", name: "Ada", text, to: ["orchestrator"] });

test("the queue is a fold over trailers: a task: mark queues, a claim makes it active, a release with a verdict closes it, a release with a waiting line parks it until the person answers (red leg: a reply with no task: mark is no task)", () => {
  const a = ask(T0, "fix the parser"), b = ask(T0 + MIN, "make it faster"), c = ask(T0 + 2 * MIN, "add slugify");
  const head = [a, b, c, intake(T0 + 3 * MIN, a.id, "parser-fix"), takeTask(T0 + 4 * MIN, a.id, "parser-fix"),
    msg({ at: T0 + 5 * MIN, name: "orchestrator/Opus", text: "queued slugify, position 1", thread: c.id, re: c.id, to: ["Ada"] }),
    takeTask(T0 + 6 * MIN, b.id, "faster")];
  const park = parkTask(T0 + 7 * MIN, b.id, "faster");
  const q1 = queueOf([...head, park], new Set());
  assert.deepEqual(q1.tasks.map((t) => [t.slug, t.root, t.state, t.holder]), [["parser-fix", a.id, "active", "orchestrator/Opus"], ["faster", b.id, "waiting", null]], "red leg: slugify's reply carries no task: mark, so it is no task");
  assert.deepEqual(q1.tasks[1].waiting, { person: "Ada", id: park.id, ts: T0 + 7 * MIN, seq: Number(park.cursor.split(":")[1]) });
  const close = closeTask(T0 + 8 * MIN, a.id, "parser-fix");
  const answer = msg({ at: T0 + 9 * MIN, kind: "human", name: "Ada", text: "the import, under 2s", thread: b.id });
  const q2 = queueOf([...head, park, close, answer], new Set());
  assert.deepEqual(q2.tasks.map((t) => [t.slug, t.state, t.since]), [["parser-fix", "done", T0 + 8 * MIN], ["faster", "queued", T0 + 9 * MIN]], "the answer puts it back in the queue");
  assert.equal(q2.free.ts, T0 + 8 * MIN, "no task held since the close");
  const prose = parkTask(T0 + 7 * MIN, b.id, "faster", "I will wait for Ada to say which operation is slow.");
  assert.equal(queueOf([...head, prose], new Set()).tasks[1].state, "queued", "red leg: a waiting in prose is no waiting line; the release hands it back to the queue");
  // a verdict by the holder in the task's subject closes it even with no release trailer
  const verdictOnly = msg({ at: T0 + 8 * MIN, name: "orchestrator/Opus", text: "closing", thread: a.id, extra: [{ key: "verdict", value: "pass" }, { key: "exhibit", value: "review 1" }] });
  assert.equal(queueOf([...head, park, verdictOnly], new Set()).tasks[0].state, "done");
  const reviewVerdict = msg({ at: T0 + 8 * MIN, name: "review/Argon", text: "pass", thread: a.id, extra: [{ key: "verdict", value: "pass" }, { key: "exhibit", value: "node --test exit 0" }] });
  assert.equal(queueOf([...head, park, reviewVerdict], new Set()).tasks[0].state, "active", "red leg: another bearer's verdict in the subject does not close the holder's task");
  // a release after the close (the lease left held by a close with no release trailer) does not reopen it
  const strayRelease = msg({ at: T0 + 9 * MIN, name: "orchestrator/Opus", text: "releasing the lease", thread: a.id, release: "task:parser-fix" });
  assert.equal(queueOf([...head, park, verdictOnly, strayRelease], new Set()).tasks[0].state, "done", "a closed task stays closed");
  assert.equal(queueOf([...head, park, strayRelease], new Set()).tasks[0].state, "queued", "red leg: the same release of a held task hands it back");
});

test("the queue reads a task from a trailer block holding only `task: <slug>` (no to:, no re:)", () => {
  const a = ask(T0, "fix the parser");
  const bare = msg({ at: T0 + MIN, name: "orchestrator/Opus", text: "queued parser-fix, position 1", thread: a.id, extra: [{ key: "task", value: "parser-fix" }] });
  assert.deepEqual(queueOf([a, bare], new Set()).tasks.map((t) => [t.slug, t.root, t.state]), [["parser-fix", a.id, "queued"]]);
});

test("the queue clock: no task held and the orchestrator idle, one N10 for the queue head after G and the human line (N3 started) after G2 (red legs: a task held; the orchestrator working; no task: mark)", () => {
  const a = ask(T0, "fix the parser"), b = ask(T0 + MIN, "add slugify");
  const ms = [a, b, intake(T0 + 2 * MIN, a.id, "parser-fix"), takeTask(T0 + 3 * MIN, a.id, "parser-fix"), intake(T0 + 4 * MIN, b.id, "slugify"), closeTask(T0 + 10 * MIN, a.id, "parser-fix")];
  const idle = (/** @type {number} */ now) => [fresh("s-orch", now, { since: T0 + 10 * MIN })];
  assert.deepEqual(kinds(run(ms, { now: T0 + 20 * MIN - 1, activity: idle(T0 + 20 * MIN - 1) })), [], "quiet for less than G since the close");
  const atG = run(ms, { now: T0 + 20 * MIN, activity: idle(T0 + 20 * MIN) });
  assert.deepEqual(atG.map((x) => [x.kind, x.text, x.thread]), [["N10", `Queued task:slugify not started after 10m, with no task held: ${b.id}.`, b.id]]);
  assert.deepEqual(atG[0].trailers, [{ key: "to", value: "orchestrator" }, { key: "re", value: b.id }]);
  const n10 = notice(T0 + 20 * MIN, "N10", { task: "task:slugify", age: "10m", id: b.id }, atG[0].trailers, b.id);
  assert.deepEqual(kinds(run([...ms, n10], { now: T0 + 30 * MIN, activity: idle(T0 + 30 * MIN) })), [], "its own post is the record: once");
  const atG2 = run([...ms, n10], { now: T0 + 40 * MIN, activity: idle(T0 + 40 * MIN) });
  assert.deepEqual(atG2.map((x) => [x.kind, x.text, x.trailers]), [["N3", `desk.orchestrator has not started ${b.id} after 30m; observe: idle.`, [{ key: "to", value: "Ada" }, { key: "re", value: b.id }]]]);
  // red leg: the task is still held
  assert.deepEqual(kinds(run(ms.slice(0, -1), { now: T0 + 60 * MIN, activity: [fresh("s-orch", T0 + 60 * MIN, { since: T0 + 10 * MIN })] })), [], "a task held: the queue waits behind it");
  // red leg: the orchestrator is working
  const busy = runFull(ms, { now: T0 + 60 * MIN, activity: [fresh("s-orch", T0 + 60 * MIN, { turn: "busy", since: T0 + 50 * MIN, progressAt: T0 + 59 * MIN })] });
  assert.deepEqual([busy.acts, busy.held], [[], [{ clock: 3, id: b.id, position: "desk.orchestrator", state: "working" }]], "working: held, never pinged");
  // red leg: no task: mark on the intake reply
  const unmarked = [...ms.slice(0, 4), msg({ at: T0 + 4 * MIN, name: "orchestrator/Opus", text: "queued slugify, position 1", thread: b.id, re: b.id, to: ["Ada"] }), ms[5]];
  assert.deepEqual(kinds(run(unmarked, { now: T0 + 60 * MIN, activity: idle(T0 + 60 * MIN) })), [], "no mark, no task: nothing is queued");
  // the head only: pinned first, then oldest
  const c = ask(T0 + 5 * MIN, "add chunk");
  const three = [...ms, c, intake(T0 + 6 * MIN, c.id, "chunk")];
  assert.deepEqual(run(three, { now: T0 + 20 * MIN, activity: idle(T0 + 20 * MIN) }).map((x) => [x.kind, x.trailers[1].value]), [["N10", b.id]]);
  assert.deepEqual(run(three, { now: T0 + 20 * MIN, activity: idle(T0 + 20 * MIN), pinned: new Set([c.id]) }).map((x) => [x.kind, x.trailers[1].value]), [["N10", c.id]], "a pinned task is the head");
  // a queued task from before the starting point is not raised, and does not hide a newer one (pinned
  // here, so it would be the head)
  const old = ask(T0 - 3 * MIN, "old request");
  const withOld = [old, intake(T0 - 3 * MIN, old.id, "old"), ...ms];
  const pinOld = new Set([old.id]);
  assert.deepEqual(run(withOld, { now: T0 + 20 * MIN, activity: idle(T0 + 20 * MIN), since: T0 - MIN, pinned: pinOld }).map((x) => [x.kind, x.trailers[1].value]), [["N10", b.id]], "the head is the first task the messenger may raise");
  assert.deepEqual(run(withOld, { now: T0 + 20 * MIN, activity: idle(T0 + 20 * MIN), pinned: pinOld }).map((x) => [x.kind, x.trailers[1].value]), [["N10", old.id]], "red leg: with no starting point the old task is the head");
  // no activity record: the time-only backstops from the later of the queueing and the close
  assert.deepEqual(kinds(run(ms, { now: T0 + 25 * MIN - 1 })), []);
  assert.deepEqual(kinds(run(ms, { now: T0 + 25 * MIN })), ["N10"]);
  assert.deepEqual(kinds(run(ms, { now: T0 + 55 * MIN })), ["N10", "N3"]);
  // no orchestrator stood: the host human is told at R, once, with no second line
  const alone = run(ms, { now: T0 + 60 * MIN, records: [RECORDS[0]] });
  assert.deepEqual(alone.map((x) => [x.kind, x.trailers[0].value]), [["N10", "Ada"]]);
});

test("the waiting record: one N11 to the person after R, the task queued again once the person answers, one N12 to each orchestrator session that armed after the line (red legs: the line as prose; a session armed before it)", () => {
  const b = ask(T0, "make it faster");
  const taken = [b, intake(T0 + MIN, b.id, "faster"), takeTask(T0 + MIN, b.id, "faster")];
  const park = parkTask(T0 + 2 * MIN, b.id, "faster");
  const ms = [...taken, park];
  assert.deepEqual(kinds(run(ms, { now: T0 + 17 * MIN - 1 })), []);
  const atR = run(ms, { now: T0 + 17 * MIN });
  assert.deepEqual(atR.map((x) => [x.kind, x.text, x.thread, x.trailers]), [["N11", `Waiting on Ada for task:faster after 15m: ${park.id}.`, b.id, [{ key: "to", value: "Ada" }, { key: "re", value: park.id }]]]);
  const n11 = notice(T0 + 17 * MIN, "N11", { person: "Ada", task: "task:faster", age: "15m", id: park.id }, atR[0].trailers, b.id);
  assert.deepEqual(kinds(run([...ms, n11], { now: T0 + 90 * MIN })), [], "once");
  const prose = [...ms.slice(0, 3), parkTask(T0 + 2 * MIN, b.id, "faster", "I will wait for Ada to say which operation is slow.")];
  assert.ok(!kinds(run(prose, { now: T0 + 17 * MIN })).includes("N11"), "red leg: a waiting in prose records nothing to surface");
  // the person answered: no N11, and the task is the queue's again
  const answer = msg({ at: T0 + 5 * MIN, kind: "human", name: "Ada", text: "the import, under 2s", thread: b.id, to: ["orchestrator"] });
  const after = kinds(run([...ms, answer], { now: T0 + 30 * MIN }));
  assert.ok(!after.includes("N11") && after.includes("N10"), after.join(","));
  // arming: a session that took the position after the line is told once; the one that wrote it is not
  const armed = (/** @type {string} */ slug, /** @type {number} */ at) => ({ slug, state: live, record: /** @type {any} */ ({ bearer: "orchestrator/Sonnet", label: "desk.orchestrator", startedAt: new Date(at).toISOString() }), posted: new Set() });
  const writer = [RECORDS[0], armed("s-orch", T0 - 60 * MIN)];
  assert.deepEqual(kinds(run(ms, { now: T0 + 10 * MIN, records: writer })), [], "red leg: the session that wrote the line armed before it");
  const successor = [RECORDS[0], armed("s-orch2", T0 + 8 * MIN)];
  const onArm = run(ms, { now: T0 + 10 * MIN, records: successor });
  assert.deepEqual(onArm.map((x) => [x.kind, x.text, x.trailers]), [["N12", `On arming: task:faster waits on Ada after 8m: ${park.id}.`, [{ key: "to", value: "orchestrator" }, { key: "re", value: park.id }]]]);
  const n12 = notice(T0 + 10 * MIN, "N12", { task: "task:faster", person: "Ada", age: "8m", id: park.id }, onArm[0].trailers, b.id);
  assert.deepEqual(kinds(run([...ms, n12], { now: T0 + 12 * MIN, records: successor })), [], "once per arming");
  assert.deepEqual(kinds(run([...ms, n12], { now: T0 + 14 * MIN, records: [RECORDS[0], armed("s-orch3", T0 + 13 * MIN)] })), ["N12"], "the next arming is told again");
});

test("a task is its subject, not its name: a name reused in a later subject is a new task, and N10 names the queued one (red legs: the old subject's close leaves the new task queued; a claim by name outside any subject takes the open one)", () => {
  const a = ask(T0, "add slugify"), b = ask(T0 + 10 * MIN, "add slugify for titles too"), c = ask(T0 + 11 * MIN, "make the reports smaller");
  const ms = [a, intake(T0 + MIN, a.id, "slugify"), takeTask(T0 + 2 * MIN, a.id, "slugify"), closeTask(T0 + 5 * MIN, a.id, "slugify"),
    b, c, intake(T0 + 12 * MIN, b.id, "slugify"), intake(T0 + 13 * MIN, c.id, "reports")];
  assert.deepEqual(queueOf(ms, new Set()).tasks.map((t) => [t.slug, t.root, t.state]), [["slugify", a.id, "done"], ["slugify", b.id, "queued"], ["reports", c.id, "queued"]]);
  const idle = (/** @type {number} */ now) => [fresh("s-orch", now, { since: T0 + 13 * MIN })];
  assert.deepEqual(run(ms, { now: T0 + 30 * MIN, activity: idle(T0 + 30 * MIN) }).map((x) => [x.kind, x.text]),
    [["N10", `Queued task:slugify not started after 18m, with no task held: ${b.id}.`]], "the head is the older queued subject, whatever its name was used for before");
  // a second close in the old subject (a stray release with a verdict) is the old task's, never the new one's
  const stray = closeTask(T0 + 14 * MIN, a.id, "slugify");
  assert.deepEqual(queueOf([...ms, stray], new Set()).tasks.map((t) => [t.root, t.state]), [[a.id, "done"], [b.id, "queued"], [c.id, "queued"]]);
  // a claim by name posted outside any subject takes the open task of that name
  const topClaim = msg({ at: T0 + 15 * MIN, name: "orchestrator/Opus", text: "taking slugify", claim: "task:slugify" });
  assert.deepEqual(queueOf([...ms, topClaim], new Set()).tasks.map((t) => [t.root, t.state]), [[a.id, "done"], [b.id, "active"], [c.id, "queued"]]);
});

test("the queue fold reads from the starting point: a task taken before it and never closed does not hold the queue (red leg: with no starting point it does)", () => {
  const old = ask(T0 - 30 * MIN, "fix the median");
  const fresh2 = ask(T0, "fix the median again");
  const ms = [old, intake(T0 - 29 * MIN, old.id, "median-fix"), takeTask(T0 - 28 * MIN, old.id, "median-fix"), fresh2, intake(T0 + MIN, fresh2.id, "median-fix")];
  const idle = [fresh("s-orch", T0 + 20 * MIN, { since: T0 + MIN })];
  assert.deepEqual(run(ms, { now: T0 + 20 * MIN, activity: idle, since: T0 - MIN }).map((x) => [x.kind, x.trailers[1].value]), [["N10", fresh2.id]]);
  assert.deepEqual(queueOf(ms, new Set(), T0 - MIN).tasks.map((t) => [t.root, t.state]), [[fresh2.id, "queued"]]);
  assert.deepEqual(kinds(run(ms, { now: T0 + 20 * MIN, activity: idle })), [], "red leg: no starting point, so the old task is held and the queue waits behind it");
});

test("a waiting record is read from the waiting trailer anywhere in the block, or from `waiting: <person>; needs: <thing>` anywhere in the release line (red legs: a waiting in prose; the inline form with no needs)", () => {
  const b = ask(T0, "make the reports smaller");
  const taken = [b, intake(T0 + MIN, b.id, "reports"), takeTask(T0 + MIN, b.id, "reports")];
  const parked = (/** @type {any} */ park) => { const t = queueOf([...taken, park], new Set()).tasks[0]; return [t.state, t.waiting?.person ?? null]; };
  const inline = parkTask(T0 + 2 * MIN, b.id, "reports", "Released: no bar. waiting: Ada; needs: which report, and what counts as smaller.");
  assert.deepEqual(parked(inline), ["waiting", "Ada"], "mid-line, after other words");
  assert.deepEqual(parked(parkTask(T0 + 2 * MIN, b.id, "reports")), ["waiting", "Ada"], "the line-start form still reads");
  const trailer = msg({ at: T0 + 2 * MIN, name: "orchestrator/Opus", text: "Released: no bar.", thread: b.id, to: ["Ada"], release: "task:reports",
    extra: [{ key: "task", value: "reports" }, { key: "waiting", value: "Ada; needs: which report" }] });
  assert.deepEqual(parked(trailer), ["waiting", "Ada"], "the trailer, last in its block");
  assert.deepEqual(parked(parkTask(T0 + 2 * MIN, b.id, "reports", "Released: I am waiting on Ada to say which report.")), ["queued", null], "red leg: prose");
  assert.deepEqual(parked(parkTask(T0 + 2 * MIN, b.id, "reports", "Released: no bar, waiting: Ada said nothing yet.")), ["queued", null], "red leg: inline with no needs");
  assert.deepEqual(run([...taken, inline], { now: T0 + 17 * MIN }).map((x) => [x.kind, x.trailers]), [["N11", [{ key: "to", value: "Ada" }, { key: "re", value: inline.id }]]]);
});

test("on arming, an orchestrator session that took the position after tasks were queued or taken gets one N13 listing them by subject, in the Room subject (red legs: a session armed before them; nothing queued or held)", () => {
  const roomRoot = msg({ at: T0 - 60 * MIN, kind: "human", name: "Ada", text: "Room" });
  const a = ask(T0, "fix the parser"), b = ask(T0 + MIN, "add slugify"), c = ask(T0 + 2 * MIN, "add chunk");
  const ms = [roomRoot, a, b, c, intake(T0 + 3 * MIN, a.id, "parser-fix"), takeTask(T0 + 4 * MIN, a.id, "parser-fix"), intake(T0 + 5 * MIN, b.id, "slugify"), intake(T0 + 6 * MIN, c.id, "chunk")];
  const armed = (/** @type {string} */ slug, /** @type {number} */ at) => ({ slug, state: live, record: /** @type {any} */ ({ bearer: "orchestrator/Sonnet", label: "desk.orchestrator", startedAt: new Date(at).toISOString() }), posted: new Set() });
  const pins = { pinned: new Set([roomRoot.id]), titles: new Map([[roomRoot.id, "Room"]]) };
  const successor = [RECORDS[0], armed("s-orch2", T0 + 8 * MIN)];
  const onArm = run(ms, { now: T0 + 9 * MIN, records: successor, ...pins });
  const text = `On arming: queued task:slugify@${b.id},task:chunk@${c.id}; active task:parser-fix@${a.id}.`;
  assert.deepEqual(onArm.map((x) => [x.kind, x.text, x.trailers, x.thread]), [["N13", text, [{ key: "to", value: "orchestrator" }], roomRoot.id]]);
  assert.deepEqual(run(ms, { now: T0 + 9 * MIN, records: successor }).filter((x) => x.kind === "N13").map((x) => x.thread), [undefined], "no Room subject: top level");
  const n13 = notice(T0 + 9 * MIN, "N13", { queued: `task:slugify@${b.id},task:chunk@${c.id}`, active: `task:parser-fix@${a.id}` }, onArm[0].trailers, roomRoot.id);
  assert.deepEqual(kinds(run([...ms, n13], { now: T0 + 12 * MIN, records: successor, ...pins })), [], "once per arming");
  assert.deepEqual(kinds(run([...ms, n13], { now: T0 + 14 * MIN, records: [RECORDS[0], armed("s-orch3", T0 + 13 * MIN)], ...pins })), ["N13"], "the next arming is told again");
  assert.deepEqual(kinds(run(ms, { now: T0 + 9 * MIN, records: [RECORDS[0], armed("s-orch", T0 - MIN)], ...pins })), [], "red leg: the session armed before every task, and saw them live");
  assert.deepEqual(kinds(run(ms.slice(0, 4), { now: T0 + 9 * MIN, records: successor, ...pins })), [], "red leg: nothing queued or held, nothing to hand over");
});

test("no clock 1 for a line that owes no answer: ack: none, an address naming the messenger itself, an answer to a notice, a release with no verdict and no claim (red legs: each as a request to coding)", () => {
  const now = T0 + 20 * MIN; // past R with no activity record: a request is clocked
  const request = msg({ at: T0, name: "orchestrator/Opus", text: "please run the suite", to: ["coding"] });
  assert.deepEqual(kinds(run([request], { now })), ["N2"], "red leg: a request to coding");
  // (a) ack: none
  assert.deepEqual(kinds(run([msg({ at: T0, name: "orchestrator/Opus", text: "fyi", to: ["coding"], extra: [{ key: "ack", value: "none" }] })], { now })), []);
  // (b) the messenger itself: its role, or the bearer its notices are signed by
  const withMessenger = [...RECORDS, { slug: "s-msgr", state: live, record: /** @type {any} */ ({ bearer: "messenger/Code", label: "desk.messenger" }), posted: new Set() }];
  const toSelf = msg({ at: T0, name: "orchestrator/Opus", text: "answered your notice", to: ["messenger"] });
  assert.deepEqual(kinds(run([toSelf], { now, records: withMessenger })), []);
  const sentry = [...RECORDS, { slug: "s-sentry", state: live, record: /** @type {any} */ ({ bearer: "sentry/Code" }), posted: new Set() }];
  const own = notice(T0 - MIN, "N5", { addr: "nobody", kind: "unknown", nearest: "none" }, [{ key: "re", value: "z".repeat(64) }]);
  const signed = { ...own, author: { ...own.author, name: "sentry/Code" }, signedAs: "sentry/Code", text: own.text.replace("-- messenger/Code", "-- sentry/Code") };
  const toSentry = msg({ at: T0, name: "orchestrator/Opus", text: "answered", to: ["sentry"] });
  assert.deepEqual(kinds(run([signed, toSentry], { now, records: sentry })), [], "the bearer that signs the notices is the messenger");
  assert.deepEqual(kinds(run([toSentry], { now, records: sentry })), ["N2"], "red leg: with no notice signed by it, sentry is any holder");
  // (c) an answer to a notice
  const n10 = notice(T0 - MIN, "N10", { task: "task:x", age: "10m", id: "r".repeat(64) }, [{ key: "to", value: "orchestrator" }, { key: "re", value: "r".repeat(64) }]);
  const plain = msg({ at: T0 - MIN, name: "review/Argon", text: "a line" });
  assert.deepEqual(kinds(run([n10, msg({ at: T0, name: "orchestrator/Opus", text: "not started because", thread: n10.id, to: ["coding"], re: n10.id })], { now })), []);
  assert.deepEqual(kinds(run([plain, msg({ at: T0, name: "orchestrator/Opus", text: "please look", thread: plain.id, to: ["coding"], re: plain.id })], { now })), ["N2"], "red leg: re: a line that is no notice");
  // (d) a release with no verdict and no claim: a record act
  const released = (/** @type {Array<{ key: string, value: string }>} */ extra, to = ["coding"]) => msg({ at: T0, name: "orchestrator/Opus", text: "Released work:x/impl", to, release: "work:x/impl", extra });
  assert.deepEqual(kinds(run([released([])], { now })), []);
  assert.deepEqual(kinds(run([released([{ key: "verdict", value: "pass" }])], { now })), ["N2"], "red leg: a release with a verdict is a result to act on");
  assert.deepEqual(kinds(run([released([{ key: "claim", value: "work:x/review" }])], { now })), ["N2"], "red leg: a release beside a claim hands work on");
  assert.deepEqual(kinds(run([released([], ["codng"])], { now })), ["N5"], "no clock, but an address that names no one still draws its pointer");
});

test("clock 2: a lapsed lease of this seat's gives N4 after I and N3 at R2; a release or verdict settles it; a foreign lease never (red leg: no release)", () => {
  const take = msg({ at: T0, name: "coding/Opus", text: "taking", claim: "parser" });
  const claimRec = (/** @type {string} */ account) => [{ cursor: `${EPOCH}:${seq - 1}`, accountId: account, operationId: "op4", board: { action: "claim", subject: "work:parser" }, expiresAt: new Date(T0 + 60 * MIN).toISOString(), leaseMs: 3_600_000 }];
  const board = claimRec(HOST);
  assert.deepEqual(kinds(run([take], { now: T0 + 60 * MIN + 2 * MIN - 1, board })), []);
  const n4 = run([take], { now: T0 + 62 * MIN, board });
  assert.deepEqual(n4.map((a) => [a.kind, a.text, a.trailers]), [["N4", "Lease on work:parser expired 2m ago without renew or release.", [{ key: "to", value: "coding/Opus" }]]]);
  assert.deepEqual(kinds(run([take], { now: T0 + 105 * MIN, board })), ["N4", "N3"]);
  assert.equal(run([take], { now: T0 + 105 * MIN, board })[1].text, "desk.coding has not renewed work:parser after 45m; observe: unknown.");
  const released = msg({ at: T0 + 30 * MIN, name: "coding/Opus", text: "done", release: "parser" });
  assert.deepEqual(kinds(run([take, released], { now: T0 + 105 * MIN, board })), []);
  const verdict = msg({ at: T0 + 30 * MIN, name: "coding/Opus", text: "done", thread: take.id, extra: [{ key: "verdict", value: "pass" }, { key: "exhibit", value: "npm test exit 0" }] });
  assert.deepEqual(kinds(run([take, verdict], { now: T0 + 105 * MIN, board })), [], "a verdict in the claim's thread settles it");
  assert.deepEqual(kinds(run([take], { now: T0 + 105 * MIN, board: claimRec("acct-peer") })), [], "another seat's lease is never this messenger's");
});


// ---- the clocks on evidence ----

test("clock 1 on evidence: a busy addressee draws no notice however old the delivery; an idle one draws N2 after G and N3 after G2 (red legs: the same delivery with no record; idle)", () => {
  const q = msg({ at: T0, kind: "human", name: "Ada", text: "Parser fails on the fixture", to: ["coding"] });
  const now = T0 + 60 * MIN;
  const busy = fresh("s-coding", now, { turn: "busy", since: T0 + MIN, lastToolAt: now - MIN, progressAt: now - MIN });
  const working = runFull([q], { now, activity: [busy] });
  assert.deepEqual(working.acts, [], "an hour after the post, but the addressee is mid-turn: the line waits in its own harness");
  assert.deepEqual(working.held, [{ clock: 1, id: q.id, position: "desk.coding", state: "working" }], "held, and said so");
  assert.deepEqual(kinds(run([q], { now })), ["N2", "N3"], "red leg: with no record the same hour is past R and R2");
  // it went idle ten minutes ago and still has not taken it
  const idle10 = run([q], { now, activity: [fresh("s-coding", now, { since: now - 10 * MIN })] });
  assert.deepEqual(idle10.map((a) => [a.kind, a.text]), [["N2", `Not taken 1h00m since posted: ${q.id}.`]]);
  assert.deepEqual(kinds(run([q], { now, activity: [fresh("s-coding", now, { since: now - 10 * MIN + 1 })] })), [], "red leg: idle for less than G");
  // idle for long: the human line too, naming what the session was doing
  const idle55 = run([q], { now, activity: [fresh("s-coding", now, { since: T0 + 5 * MIN })] });
  assert.deepEqual(idle55.map((a) => [a.kind, a.text]), [
    ["N2", `Not taken 1h00m since posted: ${q.id}.`],
    ["N3", `desk.coding has not taken ${q.id} after 1h00m; observe: idle.`],
  ]);
  assert.deepEqual(idle55[1].trailers, [{ key: "to", value: "Ada" }, { key: "re", value: q.id }]);
  // an output or a tool call after the idle began moves the idle start: it was working a moment ago
  assert.deepEqual(kinds(run([q], { now, activity: [fresh("s-coding", now, { since: T0 + 5 * MIN, lastOutputAt: now - 2 * MIN })] })), [], "red leg: quiet for 2 minutes, not 55");
});

test("clock 1 on evidence: idleness counts from the later of the delivery and the going quiet (red leg: no seen record, so the post)", () => {
  const q = msg({ at: T0, kind: "human", name: "Ada", text: "look please", to: ["coding"] });
  const seenAt = T0 + 5 * MIN;
  const seen = /** @type {Array<[string, string, number]>} */ ([["s-coding", q.id, seenAt]]);
  const idleLong = (/** @type {number} */ now) => [fresh("s-coding", now, { since: T0 - 60 * MIN })];
  assert.deepEqual(kinds(run([q], { now: seenAt + 10 * MIN - 1, seen, activity: idleLong(seenAt + 10 * MIN - 1) })), [], "it had been idle for an hour, but the line reached it 10 minutes ago less a moment");
  const due = run([q], { now: seenAt + 10 * MIN, seen, activity: idleLong(seenAt + 10 * MIN) });
  assert.deepEqual(due.map((a) => a.text), [`Not taken 10m since seen: ${q.id}.`]);
  const unseen = run([q], { now: T0 + 10 * MIN, activity: idleLong(T0 + 10 * MIN) });
  assert.deepEqual(unseen.map((a) => a.text), [`Not taken 10m since posted: ${q.id}.`], "red leg: with no seen record the post starts it");
  // it was busy when the line came and went idle later: the idle clock starts then
  const wentIdle = (/** @type {number} */ now) => [fresh("s-coding", now, { since: T0 + 40 * MIN, lastOutputAt: T0 + 40 * MIN })];
  assert.deepEqual(kinds(run([q], { now: T0 + 50 * MIN - 1, activity: wentIdle(T0 + 50 * MIN - 1) })), []);
  assert.deepEqual(kinds(run([q], { now: T0 + 50 * MIN, activity: wentIdle(T0 + 50 * MIN) })), ["N2"]);
});

test("a dark holder is pinged like an idle one: a silent watch, a turn with no progress for S (red leg: the same record, fresh and progressing)", () => {
  const q = msg({ at: T0, kind: "human", name: "Ada", text: "look please", to: ["coding"] });
  // the watch stopped refreshing its record at T0+10m (D is 5m): dark since T0+15m
  const silent = [ACT("s-coding", { turn: "busy", since: T0 + MIN, progressAt: T0 + 10 * MIN, updatedAt: T0 + 10 * MIN })];
  assert.deepEqual(kinds(run([q], { now: T0 + 25 * MIN - 1, activity: silent })), []);
  assert.deepEqual(run([q], { now: T0 + 25 * MIN, activity: silent }).map((a) => a.kind), ["N2"]);
  const n3 = run([q], { now: T0 + 45 * MIN, activity: silent });
  assert.deepEqual(n3.map((a) => a.kind), ["N2", "N3"]);
  assert.equal(n3[1].text, `desk.coding has not taken ${q.id} after 45m; observe: silent.`);
  assert.deepEqual(run([q], { now: T0 + 45 * MIN, activity: [fresh("s-coding", T0 + 45 * MIN, { turn: "busy", since: T0 + MIN, progressAt: T0 + 44 * MIN })] }), [], "red leg: refreshed and progressing is working");
  // busy, refreshed, but nothing at all for S: stalled
  const last = T0 + 2 * MIN;
  const stalled = (/** @type {number} */ now) => [fresh("s-coding", now, { turn: "busy", since: T0 + MIN, lastToolAt: last, progressAt: last })];
  const atS = last + 120 * MIN;
  assert.deepEqual(kinds(run([q], { now: atS, bounds: { ...DEFAULT_BOUNDS, H: 24 * 60 * MIN }, activity: stalled(atS) })), [], "exactly S with no progress is still working");
  const past = atS + 10 * MIN;
  const st = run([q], { now: past, bounds: { ...DEFAULT_BOUNDS, H: 24 * 60 * MIN }, activity: stalled(past) });
  assert.deepEqual(st.map((a) => a.kind), ["N2"], "stalled for G: dark, so pinged");
  assert.deepEqual(kinds(run([q], { now: past, bounds: { ...DEFAULT_BOUNDS, H: 24 * 60 * MIN }, activity: [fresh("s-coding", past, { turn: "busy", since: T0 + MIN, lastToolAt: past - MIN, progressAt: past - MIN })] })), [], "red leg: a tool call a minute ago");
});

test("a dead session gets its pointer: the resolver reads an address held only by a gone session as retired (N5) for a line posted after it went, and a lapsed lease of a gone holder falls back to the backstop with verdict absent", () => {
  const gone = [{ slug: "s-coding", state: /** @type {const} */ ("gone"), record: /** @type {any} */ ({ bearer: "coding/Opus", label: "desk.coding" }), posted: new Set() }, RECORDS[1]];
  const q = msg({ at: T0, kind: "human", name: "Ada", text: "look please", to: ["coding"] });
  assert.deepEqual(kinds(run([q], { now: T0 + MIN, records: gone, activity: [ACT("s-coding", { updatedAt: T0 - MIN })] })), ["N5"]);
  const take = msg({ at: T0, name: "coding/Opus", text: "taking", claim: "parser" });
  const board = [{ cursor: `${EPOCH}:${seq - 1}`, accountId: HOST, operationId: "op9", board: { action: "claim", subject: "work:parser" }, expiresAt: new Date(T0 + 60 * MIN).toISOString(), leaseMs: 3_600_000 }];
  assert.deepEqual(kinds(run([take], { now: T0 + 62 * MIN - 1, board, records: gone, activity: [ACT("s-coding", { updatedAt: T0 + 60 * MIN })] })), []);
  assert.deepEqual(kinds(run([take], { now: T0 + 62 * MIN, board, records: gone, activity: [ACT("s-coding", { updatedAt: T0 + 60 * MIN })] })), ["N4"]);
  const late = run([take], { now: T0 + 105 * MIN, board, records: gone });
  assert.equal(late[1].text, "coding/Opus has not renewed work:parser after 45m; observe: absent.");
});

test("N5 is never posted for a line its addressee answered, nor after the fact for a line posted while its holder lived (red legs: the holder was gone before the line; no answer; no clock notice)", () => {
  const goneRec = (/** @type {Record<string, unknown>} */ rec, /** @type {string[]} */ posted = []) =>
    [{ slug: "s-dummy", state: /** @type {const} */ ("gone"), record: /** @type {any} */ ({ bearer: "dummy/Probe", label: "desk.dummy", ...rec }), posted: new Set(posted) }, ...RECORDS];
  const ask = msg({ at: T0, kind: "human", name: "Ada", text: "please", to: ["desk.dummy"] });
  const answer = msg({ at: T0 + MIN, name: "dummy/Probe", text: "done", thread: ask.id });
  const now = T0 + 30 * MIN;
  // answered in its thread by the position's session, which has since ended
  assert.deepEqual(kinds(run([ask, answer], { now, records: goneRec({ lastSeen: new Date(T0 - 5 * MIN).toISOString() }, [answer.id]) })), [], "answered: no pointer");
  assert.deepEqual(kinds(run([ask], { now, records: goneRec({ lastSeen: new Date(T0 - 5 * MIN).toISOString() }) })), ["N5"], "red leg: no answer, and the holder was gone before the line");
  // unanswered, but its holder was alive when it was posted: no pointer after the fact
  assert.deepEqual(kinds(run([ask], { now, records: goneRec({ lastSeen: new Date(T0 + 2 * MIN).toISOString() }) })), [], "seen alive after the line by its record");
  assert.deepEqual(kinds(run([ask], { now, records: goneRec({ lastSeen: new Date(T0 - 5 * MIN).toISOString() }), activity: [ACT("s-dummy", { updatedAt: T0 + 2 * MIN })] })), [], "seen alive after the line by its activity record");
  // its clock ran while it lived: the N2 standing for the line is the evidence
  const n2 = notice(T0 + 15 * MIN, "N2", { age: "15m", since: "posted", id: ask.id }, [{ key: "to", value: "desk.dummy" }, { key: "re", value: ask.id }], ask.id);
  assert.deepEqual(kinds(run([ask, n2], { now, records: goneRec({ lastSeen: new Date(T0 - 5 * MIN).toISOString() }) })), [], "an N2 for it stands");
  // a typo addresses no one, then or now: its pointer is due at once
  const typo = msg({ at: T0, name: "orchestrator/Opus", text: "please", to: ["desk.dumy"] });
  assert.deepEqual(kinds(run([typo], { now: T0 + 1, records: goneRec({ lastSeen: new Date(T0 + 2 * MIN).toISOString() }) })), ["N5"]);
  // its session's record was forgotten, so only the room remembers the name: a post signed by it
  // after the line, in any subject, says the name was held when the line was posted
  const signedBefore = msg({ at: T0 - 2 * MIN, name: "relay/Haiku", text: "relay up" });
  const toRelay = msg({ at: T0, name: "orchestrator/Opus", text: "relay this", to: ["relay"] });
  const signedAfter = msg({ at: T0 + MIN, name: "relay/Haiku", text: "relayed", thread: "m-another-subject" });
  assert.deepEqual(kinds(run([signedBefore, toRelay, signedAfter], { now })), [], "the name posted after the line");
  assert.deepEqual(kinds(run([signedBefore, toRelay], { now })), ["N5"], "red leg: the name's last post came before the line (retired)");
  // a line to the messenger, which only ever posts notices: a notice it signed after the line counts
  const signedEarlier = notice(T0 - MIN, "N1", { id: "m-earlier" }, [{ key: "to", value: "orchestrator" }, { key: "re", value: "m-earlier" }], "m-earlier");
  const toMessenger = msg({ at: T0, kind: "human", name: "Ada", text: "are you there?", to: ["messenger"] });
  const itsNotice = notice(T0 + MIN, "N1", { id: "m-other" }, [{ key: "to", value: "orchestrator" }, { key: "re", value: "m-other" }], "m-other");
  assert.deepEqual(kinds(run([signedEarlier, toMessenger, itsNotice], { now })), [], "a notice it signed after the line");
  assert.deepEqual(kinds(run([signedEarlier, toMessenger], { now })), ["N5"], "red leg: its last notice came before the line");
});

test("clock 2 on evidence: expiry never pings a working holder (it is held); an idle or dark holder is pinged after G and the human told after G2 (red legs: no record; idle for less than G)", () => {
  const take = msg({ at: T0, name: "coding/Opus", text: "taking", claim: "parser" });
  const board = [{ cursor: `${EPOCH}:${seq - 1}`, accountId: HOST, operationId: "op8", board: { action: "claim", subject: "work:parser" }, expiresAt: new Date(T0 + 60 * MIN).toISOString(), leaseMs: 3_600_000 }];
  const expiry = T0 + 60 * MIN;
  const now = T0 + 105 * MIN;
  const working = runFull([take], { now, board, activity: [fresh("s-coding", now, { turn: "busy", since: T0 + 50 * MIN, lastToolAt: now - MIN, progressAt: now - MIN })] });
  assert.deepEqual(working.acts, [], "45 minutes past expiry and still calling tools");
  assert.deepEqual(working.held, [{ clock: 2, id: "work:parser", position: "desk.coding", state: "working" }]);
  assert.deepEqual(kinds(run([take], { now, board })), ["N4", "N3"], "red leg: with no record, expiry alone raises it");
  // idle since before the expiry: the grace runs from the expiry
  const idle = (/** @type {number} */ at, since = T0 + 30 * MIN) => [fresh("s-coding", at, { since })];
  assert.deepEqual(kinds(run([take], { now: expiry + 10 * MIN - 1, board, activity: idle(expiry + 10 * MIN - 1) })), [], "red leg: idle, but for less than G since the expiry");
  const n4 = run([take], { now: expiry + 10 * MIN, board, activity: idle(expiry + 10 * MIN) });
  assert.deepEqual(n4.map((a) => [a.kind, a.text]), [["N4", "Lease on work:parser expired 10m ago without renew or release."]]);
  const both = run([take], { now: expiry + 30 * MIN, board, activity: idle(expiry + 30 * MIN) });
  assert.deepEqual(both.map((a) => a.kind), ["N4", "N3"]);
  assert.equal(both[1].text, "desk.coding has not renewed work:parser after 30m; observe: idle.");
  // worked past the expiry and went idle at T0+80m: the grace runs from then
  assert.deepEqual(kinds(run([take], { now: T0 + 90 * MIN - 1, board, activity: idle(T0 + 90 * MIN - 1, T0 + 80 * MIN) })), []);
  assert.deepEqual(kinds(run([take], { now: T0 + 90 * MIN, board, activity: idle(T0 + 90 * MIN, T0 + 80 * MIN) })), ["N4"]);
  // a silent watch is dark: pinged, and the human line names why
  const silent = [ACT("s-coding", { turn: "busy", since: T0 + MIN, updatedAt: T0 + 10 * MIN })];
  assert.deepEqual(kinds(run([take], { now: expiry + 10 * MIN, board, activity: silent })), ["N4"]);
  assert.equal(run([take], { now: expiry + 30 * MIN, board, activity: silent })[1].text, "desk.coding has not renewed work:parser after 30m; observe: silent.");
});

test("evidenceOf: any working holder makes the position working; a holder with no record is ignored beside one with a record; none when no one has one", () => {
  const h = (/** @type {string} */ session, process = /** @type {"live" | "gone"} */ ("live")) => ({ seat: "host", position: "desk.coding", role: "coding", model: "Opus", bearer: "coding/Opus", session, process, verdict: /** @type {const} */ ("unknown") });
  const now = T0 + 60 * MIN;
  const act = new Map([
    ["a", fresh("a", now, { turn: "busy", since: now - 5 * MIN, progressAt: now - MIN })],
    ["b", fresh("b", now, { since: now - 20 * MIN })],
    ["c", fresh("c", now, { since: now - 40 * MIN })],
  ]);
  const b = { ...DEFAULT_BOUNDS };
  assert.deepEqual(evidenceOf([h("a"), h("b")], act, now, b), { state: "working", since: now - 5 * MIN, verdict: "working" });
  assert.deepEqual(evidenceOf([h("b"), h("c")], act, now, b), { state: "idle", since: now - 20 * MIN, verdict: "idle" }, "idle since the later of the two: the last to go quiet");
  assert.deepEqual(evidenceOf([h("b"), h("x")], act, now, b), { state: "idle", since: now - 20 * MIN, verdict: "idle" }, "x has no record");
  assert.deepEqual(evidenceOf([h("x")], act, now, b), { state: "none", since: null, verdict: "none" });
  assert.deepEqual(evidenceOf([], act, now, b), { state: "none", since: null, verdict: "none" });
  assert.deepEqual(evidenceOf([h("x", "gone")], act, now, b), { state: "dark", since: null, verdict: "gone" }, "a gone process is dark even with no record");
  // the silent bound is at least three of the watch's own intervals: a slow poller is not dark
  const slow = new Map([["s", ACT("s", { turn: "idle", since: now - 20 * MIN, updatedAt: now - 8 * MIN, intervalMs: 600_000 })]]);
  assert.equal(evidenceOf([h("s")], slow, now, b).state, "idle");
  assert.equal(evidenceOf([h("s")], new Map([["s", ACT("s", { turn: "idle", since: now - 20 * MIN, updatedAt: now - 8 * MIN, intervalMs: 2000 })]]), now, b).state, "dark", "red leg: the same age at a 2s interval");
});

test("no activity record falls back to the time bounds, which are configurable for older clients (red leg: a record for another session does not count)", () => {
  const q = msg({ at: T0, kind: "human", name: "Ada", text: "look please", to: ["coding"] });
  const other = [fresh("s-orch", T0 + 15 * MIN, { turn: "busy", since: T0 })];
  assert.deepEqual(kinds(run([q], { now: T0 + 15 * MIN, activity: other })), ["N2"], "R from the delivery, as before");
  const hours = { ...DEFAULT_BOUNDS };
  assert.deepEqual(kinds(run([q], { now: T0 + 15 * MIN, bounds: hours })), [], "red leg: the default backstop is not the short one");
  assert.deepEqual(kinds(run([q], { now: T0 + 120 * MIN - 1, bounds: hours })), []);
  assert.deepEqual(kinds(run([q], { now: T0 + 120 * MIN, bounds: hours })), ["N2"]);
  assert.deepEqual(kinds(run([q], { now: T0 + 240 * MIN, bounds: hours })), ["N2", "N3"]);
});

test("the activity record: the plugins' tracker writes it, the messenger reads it (red legs: another version, a bad turn, a torn file, no file)", async (t) => {
  assert.equal(ACTIVITY_FILE, PLUGIN_ACTIVITY_FILE, "one file name, written by the plugins and read here");
  const dir = await mkdtemp(path.join(tmpdir(), "agora-activity-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let clock = T0;
  const tr = new ActivityTracker({ now: () => clock });
  assert.equal(tr.turnEnd(), false, "a fresh watch is idle already");
  clock += MIN; assert.equal(tr.turnStart(), true); assert.equal(tr.turnStart(), false, "no change, no immediate write");
  clock += MIN; tr.tool();
  clock += MIN; tr.output(false);
  clock += MIN; tr.output(true);
  clock += MIN; tr.entry();
  const rec = tr.take({ session: "s-coding", position: "desk.coding", intervalMs: 2000 });
  assert.equal(tr.due(), false);
  clock += 29_000; assert.equal(tr.due(), false);
  clock += 1_000; assert.equal(tr.due(), true, "the heartbeat: a quiet watch still refreshes its record");
  await mkdir(path.join(dir, "sessions", "s-coding"), { recursive: true });
  await writeFile(path.join(dir, "sessions", "s-coding", ACTIVITY_FILE), JSON.stringify(rec));
  for (const [slug, text] of [["s-v2", JSON.stringify({ ...rec, v: 2 })], ["s-bad", JSON.stringify({ ...rec, turn: "running" })], ["s-torn", `${JSON.stringify(rec).slice(0, 40)}`], ["s-nodate", JSON.stringify({ ...rec, updatedAt: "soon" })]]) {
    await mkdir(path.join(dir, "sessions", slug), { recursive: true });
    await writeFile(path.join(dir, "sessions", slug, ACTIVITY_FILE), text);
  }
  await mkdir(path.join(dir, "sessions", "s-none"), { recursive: true });
  const got = await readActivity(dir);
  assert.deepEqual([...got.keys()], ["s-coding"], "only the v1 record with readable instants");
  assert.deepEqual(got.get("s-coding"), {
    session: "s-coding", turn: "busy", since: T0 + MIN, lastToolAt: T0 + 2 * MIN, lastOutputAt: T0 + 4 * MIN, progressAt: T0 + 5 * MIN,
    progress: 3, updatedAt: T0 + 5 * MIN, intervalMs: 2000,
  }, "the tool call, the finished message and the entry each count one; a streamed chunk moves the time only");
  assert.equal((await readActivity(path.join(dir, "missing"))).size, 0);
  // a reload continues the counters and the last-seen times, not the turn
  const again = new ActivityTracker({ now: () => clock, prior: JSON.stringify(rec) });
  assert.equal(again.progress, 3);
  assert.equal(again.turn, "idle");
  assert.equal(again.lastToolAt, T0 + 2 * MIN);
  const ev = await readEvidence(dir, "lab");
  assert.deepEqual([ev.seen.size, ev.activity.size], [0, 1]);
});

test("the horizon: an incident that started before H is not raised (red leg: inside H it is)", () => {
  const q = msg({ at: T0, kind: "human", name: "Ada", text: "old", to: ["coding"] });
  assert.deepEqual(kinds(run([q], { now: T0 + 4 * 60 * MIN + 1 })), []);
  assert.deepEqual(kinds(run([q], { now: T0 + 4 * 60 * MIN - 1 })), ["N2", "N3"]);
});

test("the starting point: an incident that began before the messenger's first start in the room is not raised (red legs: no starting point; a line after it)", () => {
  const old = msg({ at: T0, kind: "human", name: "Ada", text: "old", to: ["coding"] });
  const typo = msg({ at: T0, name: "orchestrator/Opus", text: "old", to: ["nobody"] });
  const fresh2 = msg({ at: T0 + 20 * MIN, kind: "human", name: "Ada", text: "new", to: ["coding"] });
  const now = T0 + 70 * MIN;
  assert.deepEqual(kinds(run([old, typo], { now, since: T0 + 10 * MIN })), [], "before the start: nothing, though H still covers it");
  assert.deepEqual(kinds(run([old, typo], { now })), ["N2", "N3", "N5"], "red leg: with no starting point H alone bounds it");
  assert.deepEqual(kinds(run([old, fresh2], { now, since: T0 + 10 * MIN })), ["N2", "N3"], "a line after the start is raised");
  // a lease that expired before the start is not raised either
  const take = msg({ at: T0, name: "coding/Opus", text: "taking", claim: "parser" });
  const board = [{ cursor: `${EPOCH}:${seq - 1}`, accountId: HOST, operationId: "op-start", board: { action: "claim", subject: "work:parser" }, expiresAt: new Date(T0 + 5 * MIN).toISOString(), leaseMs: 300_000 }];
  assert.deepEqual(kinds(run([take], { now, board, since: T0 + 10 * MIN })), []);
  assert.deepEqual(kinds(run([take], { now, board })), ["N4", "N3"], "red leg: no starting point");
});

test("the starting point is recorded once per room, from the first start less the look-back L, and kept across restarts; a dry run records nothing (red legs: a second start; a torn file)", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-messenger-start-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(DEFAULT_BOUNDS.L, 10 * MIN, "the default look-back is small: ten minutes");
  const file = messenger.startPath(root, "r".repeat(32));
  assert.equal(file, path.join(root, "messenger", `${"r".repeat(32)}.start.json`));
  const dry = await messenger.messengerStart(file, { now: T0, lookBackMs: 10 * MIN, record: false });
  assert.deepEqual(dry, { since: T0 - 10 * MIN, startedAt: T0, recorded: false, created: false });
  await assert.rejects(stat(file), /ENOENT/, "a dry run writes nothing");
  const first = await messenger.messengerStart(file, { now: T0, lookBackMs: 10 * MIN, record: true });
  assert.deepEqual(first, { since: T0 - 10 * MIN, startedAt: T0, recorded: true, created: true });
  const onDisk = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(onDisk, { v: 1, type: "messenger-start", since: new Date(T0 - 10 * MIN).toISOString(), startedAt: new Date(T0).toISOString(), lookBackMs: 10 * MIN });
  const again = await messenger.messengerStart(file, { now: T0 + 5 * 60 * MIN, lookBackMs: 60 * MIN, record: true });
  assert.deepEqual(again, { since: T0 - 10 * MIN, startedAt: T0, recorded: true, created: false }, "red leg: a restart hours later keeps the first start");
  const dryAfter = await messenger.messengerStart(file, { now: T0 + 5 * 60 * MIN, lookBackMs: 10 * MIN, record: false });
  assert.deepEqual(dryAfter, { since: T0 - 10 * MIN, startedAt: T0, recorded: true, created: false }, "a dry run reads the recorded start");
  await writeFile(file, "{ torn");
  const torn = await messenger.messengerStart(file, { now: T0 + 6 * 60 * MIN, lookBackMs: 10 * MIN, record: true });
  assert.deepEqual(torn, { since: T0 + 6 * 60 * MIN - 10 * MIN, startedAt: T0 + 6 * 60 * MIN, recorded: true, created: true }, "a torn record is a first start again: the conservative floor, never a flood");
  assert.throws(() => parseBounds("L=25h"), /L <= H/);
  assert.equal(parseBounds("L=0s").L, 0, "L=0 starts at the room head");
});

test("no notice carries the words of the message it points at (red leg: the planted words are in the room)", () => {
  const secret = "zebra-quartz-ledger";
  const ms = [msg({ at: T0, kind: "human", name: "Ada", text: `please ${secret}`, to: ["coding"] }), msg({ at: T0, kind: "human", name: "Ada", text: `${secret} again` }),
    msg({ at: T0, name: "orchestrator/Opus", text: `${secret}`, to: ["nobody"] })];
  const acts = run(ms, { now: T0 + 50 * MIN });
  assert.ok(acts.length >= 4, `exercised ${acts.length} notices`);
  for (const a of acts) assert.ok(!a.text.includes(secret) && !a.trailers.some((t) => t.value.includes(secret)), a.text);
  assert.ok(ms.some((m) => m.text.includes(secret)), "red leg: the words are present to be quoted");
});

test("noticeKey: one incident, one key; N1 and N9 share the route", () => {
  assert.equal(noticeKey("N1", { id: "x" }, { to: [] }), noticeKey("N9", { id: "x", human: "Ada" }, { to: [] }));
  assert.notEqual(noticeKey("N2", { id: "x" }, { to: ["a"] }), noticeKey("N2", { id: "x" }, { to: ["b"] }));
  // red leg: a roster change between ticks renames the position in the text; the incident is the same
  assert.equal(noticeKey("N3", { verb: "taken", id: "x", position: "desk.coding" }, { to: [] }), noticeKey("N3", { verb: "taken", id: "x", position: "coding/Opus" }, { to: [] }));
});

test("runTick posts only what the fresh fold under the lock still finds due (red leg: an answer landing between the reads)", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-messenger-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const q = msg({ at: T0, kind: "human", name: "Ada", text: "x", to: ["coding"] });
  const answer = msg({ at: T0 + MIN, name: "coding/Opus", text: "on it", thread: q.id });
  let reads = 0;
  /** @type {any[]} */ const posted = [];
  const deps = (/** @type {boolean} */ answerLands) => ({
    gather: async () => {
      reads++;
      const messages = answerLands && reads > 1 ? [q, answer] : [q];
      const ctx = { seatName: "host", accountId: HOST, records: RECORDS, messages };
      return { messages, annotations: [], boardRecords: [], resolve: (/** @type {string} */ a) => resolveAddress(a, ctx) };
    },
    post: async (/** @type {any} */ act) => { posted.push(act); return { id: `p${posted.length}`, cursor: `${EPOCH}:${900 + posted.length}` }; },
    lock: fileLock(path.join(root, "room.lock")), now: () => T0 + 20 * MIN, accountId: HOST, human: "Ada", bounds: { ...SHORT },
  });
  const a = await runTick(deps(false));
  assert.deepEqual([a.due.length, a.posted.map((p) => p.kind), a.locked], [1, ["N2"], true]);
  reads = 0; posted.length = 0;
  const b = await runTick(deps(true));
  assert.deepEqual([b.due.length, b.posted.length], [1, 0], "due at the first read, answered by the fresh one: nothing posted");
  const dry = await runTick({ ...deps(false), dryRun: true });
  assert.deepEqual([dry.due.length, dry.posted.length], [1, 0]);
});

test("the room's messenger lock is exclusive across holders and taken over when stale", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-messenger-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = fileLock(path.join(root, "room.lock"), { waitMs: 200 });
  /** @type {string[]} */ const order = [];
  let release = () => {};
  const first = lock(() => new Promise((r) => { order.push("first in"); release = () => { order.push("first out"); r(undefined); }; }));
  await new Promise((r) => setTimeout(r, 30));
  const second = await lock(async () => { order.push("second in"); return true; });
  assert.equal(second, undefined, "a held lock past the wait skips the tick");
  release();
  await first;
  assert.equal(await lock(async () => true), true);
  assert.deepEqual(order, ["first in", "first out"]);
});
