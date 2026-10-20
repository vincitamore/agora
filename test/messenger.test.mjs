// @ts-check
// The messenger's tick: the pinned notice set, the two clocks, routing with no model, the pointer
// notices, and its own posts as the incident record (no duplicate after a restart). Every check
// here has a red leg beside it: the variation that must move it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_BOUNDS, NOTICE_TEMPLATES, fileLock, formatAge, formatNotice, noticeKey, parseBounds, parseNotice, runTick, tick } from "../src/messenger.mjs";
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
  assert.deepEqual({ ...DEFAULT_BOUNDS }, { R: 900_000, R2: 2_700_000, I: 120_000, Bo: 1_800_000, H: 14_400_000, T: 30_000 });
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
  assert.deepEqual(parseBounds("R=90s,R2=270s,I=12s,Bo=3m,H=1h,T=5s"), { R: 90_000, R2: 270_000, I: 12_000, Bo: 180_000, H: 3_600_000, T: 5_000 });
  assert.deepEqual(parseBounds(undefined), { ...DEFAULT_BOUNDS });
  assert.throws(() => parseBounds("R=10m,R2=5m"), /0 < R < R2/);
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
/** @param {any[]} messages @param {{ now: number, board?: any[], records?: any[], titles?: Map<string, string>, pinned?: Set<string>, bounds?: any }} o */
function run(messages, o) {
  const ctx = { seatName: "host", accountId: HOST, records: o.records ?? RECORDS, messages };
  return tick({ now: o.now, messages, titles: o.titles ?? new Map(), pinned: o.pinned ?? new Set(), boardRecords: o.board ?? [], accountId: HOST,
    resolve: (a) => resolveAddress(a, ctx), human: "Ada", bounds: o.bounds ?? { ...DEFAULT_BOUNDS } }).acts;
}
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
