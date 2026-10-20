// @ts-check
// The messenger's tick: the pinned notice set, the two clocks, routing with no model, the pointer
// notices, and its own posts as the incident record (no duplicate after a restart). Every check
// here has a red leg beside it: the variation that must move it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ACTIVITY_FILE, DEFAULT_BOUNDS, NOTICE_TEMPLATES, SEEN_FILE, evidenceOf, fileLock, formatAge, formatNotice, noticeKey, parseBounds, parseNotice, parseSeen,
  readActivity, readEvidence, readSeen, runTick, seenKey, tick,
} from "../src/messenger.mjs";
import { ACTIVITY_FILE as PLUGIN_ACTIVITY_FILE, ActivityTracker, SEEN_FILE as PLUGIN_SEEN_FILE, SeenLog, seenRecord } from "../plugins/claude/agora-room/hooks/lib.js";
import { resolveAddress } from "../src/board-read.mjs";
import { withTrailers } from "../src/trailers.mjs";

// A notice is a pointer, never a paraphrase: it carries ids, ages and names and never the words of
// the message it points at. This pin is the whole set, by exact equality, so a form that grows a
// slot for a message's text (or a new form) is a red bar here and a reviewed change, not drift.
test("the notice set is exactly these nine forms", () => {
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
  });
  assert.ok(Object.isFrozen(NOTICE_TEMPLATES));
  assert.deepEqual({ ...DEFAULT_BOUNDS }, { R: 900_000, R2: 2_700_000, I: 120_000, Bo: 1_800_000, H: 14_400_000, T: 30_000, G: 600_000, G2: 1_800_000, S: 7_200_000, D: 300_000 });
});

test("every form reads back as itself; a slot is one token (red leg: a slot with a space is refused)", () => {
  const sample = { id: "a".repeat(64), age: "16m", since: "posted", position: "desk.coding", verb: "taken", verdict: "unknown", subject: "work:msg:x",
    addr: "builder", kind: "retired", nearest: "desk.coding", root: "b".repeat(64), attestor: "observe", path: "ensure", outcome: "ready", human: "Ada" };
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
/** an activity record as the reader gives it, quiet and fresh unless said otherwise @param {string} session @param {Partial<import("../src/messenger.mjs").Activity>} [o] @returns {import("../src/messenger.mjs").Activity} */
const ACT = (session, o = {}) => ({ session, turn: "idle", since: T0, lastToolAt: null, lastOutputAt: null, progressAt: null, progress: 0, updatedAt: T0, intervalMs: 2000, ...o });
/** @param {any[]} messages @param {{ now: number, board?: any[], records?: any[], titles?: Map<string, string>, pinned?: Set<string>, bounds?: any, seen?: Array<[string, string, number]>, activity?: import("../src/messenger.mjs").Activity[] }} o */
function runFull(messages, o) {
  const ctx = { seatName: "host", accountId: HOST, records: o.records ?? RECORDS, messages };
  return tick({ now: o.now, messages, titles: o.titles ?? new Map(), pinned: o.pinned ?? new Set(), boardRecords: o.board ?? [], accountId: HOST,
    resolve: (a) => resolveAddress(a, ctx), human: "Ada", bounds: o.bounds ?? { ...DEFAULT_BOUNDS },
    ...(o.seen ? { seen: new Map(o.seen.map(([slug, id, at]) => [seenKey(slug, id), at])) } : {}),
    ...(o.activity ? { activity: new Map(o.activity.map((a) => [a.session, a])) } : {}) });
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
/** a holder's record, written just now (a live watch) @param {string} session @param {number} now @param {Partial<import("../src/messenger.mjs").Activity>} o */
const fresh = (session, now, o) => ACT(session, { updatedAt: now - 30_000, ...o });

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

test("a dead session gets its pointer: the resolver reads an address held only by a gone session as retired (N5), and a lapsed lease of a gone holder falls back to the backstop with verdict absent", () => {
  const gone = [{ slug: "s-coding", state: /** @type {const} */ ("gone"), record: /** @type {any} */ ({ bearer: "coding/Opus", label: "desk.coding" }), posted: new Set() }, RECORDS[1]];
  const q = msg({ at: T0, kind: "human", name: "Ada", text: "look please", to: ["coding"] });
  assert.deepEqual(kinds(run([q], { now: T0 + MIN, records: gone, activity: [ACT("s-coding", { updatedAt: T0 })] })), ["N5"]);
  const take = msg({ at: T0, name: "coding/Opus", text: "taking", claim: "parser" });
  const board = [{ cursor: `${EPOCH}:${seq - 1}`, accountId: HOST, operationId: "op9", board: { action: "claim", subject: "work:parser" }, expiresAt: new Date(T0 + 60 * MIN).toISOString(), leaseMs: 3_600_000 }];
  assert.deepEqual(kinds(run([take], { now: T0 + 62 * MIN - 1, board, records: gone, activity: [ACT("s-coding", { updatedAt: T0 + 60 * MIN })] })), []);
  assert.deepEqual(kinds(run([take], { now: T0 + 62 * MIN, board, records: gone, activity: [ACT("s-coding", { updatedAt: T0 + 60 * MIN })] })), ["N4"]);
  const late = run([take], { now: T0 + 105 * MIN, board, records: gone });
  assert.equal(late[1].text, "coding/Opus has not renewed work:parser after 45m; observe: absent.");
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
  const hours = { ...DEFAULT_BOUNDS, R: 120 * MIN, R2: 240 * MIN, H: 24 * 60 * MIN };
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
    lock: fileLock(path.join(root, "room.lock")), now: () => T0 + 20 * MIN, accountId: HOST, human: "Ada", bounds: { ...DEFAULT_BOUNDS },
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
