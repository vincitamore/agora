// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { AgoraError, writeCursor } from "../src/core.mjs";
import { carryState, carryWindow, foldRoom, renderCarry } from "../src/carry.mjs";
import { appendPosted, inheritSession, readPosted } from "../src/session.mjs";
import { writeFollow } from "../src/follow.mjs";
import { slackTransport } from "../src/transports/slack.mjs";
import { fakeFetch, tmp } from "./helpers.mjs";

const run = promisify(execFile);
const BIN = new URL("../bin/agora.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/** @param {string[]} args @param {Record<string, string>} env */
async function agora(args, env) {
  try {
    // the harness running the suite injects its own session id and pid, and the tool reads both:
    // a test asserting what a verb printed must not depend on which harness ran it
    const clean = { ...process.env };
    for (const name of ["CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_PID", "GROK_SESSION_ID", "GROK_PID", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "HERMES_SESSION_ID", "AGORA_SESSION_PID", "AGORA_SESSION", "AGORA_ACTOR", "AGORA_CONFIG", "AGORA_STATE"]) delete clean[name];
    const child = run(process.execPath, [BIN, ...args], { env: { ...clean, ...env }, windowsHide: true });
    child.child.stdin?.end();
    const { stdout, stderr } = await child;
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = /** @type {any} */ (e);
    return { code: err.code, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

/** Every typed line of a `--json` run, parsed. @param {string} out */
const typed = (out) => out.trim().split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));

/** @param {string} id @param {string} text @param {{ ts?: string, who?: string, kind?: string, thread?: string, cursor?: string, raw?: Record<string, unknown> }} [o] */
function msg(id, text, o = {}) {
  return /** @type {import('../src/core.mjs').Message} */ ({
    id,
    room: "r",
    ...(o.thread ? { thread: o.thread } : {}),
    author: { id: o.who ?? "seat", name: o.who ?? "seat", kind: /** @type {any} */ (o.kind ?? "agent") },
    text,
    signedAs: /^--\s(.+)$/m.exec(text)?.[1],
    ts: o.ts ?? `2026-09-04T00:00:${String(Number(id.replace(/\D/g, "")) || 0).padStart(2, "0")}.000Z`,
    cursor: o.cursor ?? (id.replace(/\D/g, "") || id),
    ...(o.raw ? { raw: o.raw } : {}),
  });
}

const OWN_CLAIM = msg("m1", "taking it\n\nclaim: worker/src/fetch.ts::retryFetch\nto: Codex\n\n-- Grace/watch");
const OWN_SECOND = msg("m2", "and this\n\nclaim: docs/x.md\n\n-- Grace/watch");
const OWN_RELEASE = msg("m3", "handing back\n\nrelease: docs/x.md\n\n-- Grace/watch");
const OWN_VERDICT = msg("m4", "settled\n\nverdict: pass\nexhibit: run 4412 line 88\nexhibit: sha256 abc\n\n-- Grace/watch");
const THEIRS = msg("m5", "can you rerun it?\n\nto: Grace\n\n-- Peer/dev", { who: "peer", kind: "human" });

test("carry: only this session's own posts are folded, and the ledger is the whole filter", () => {
  const all = [OWN_CLAIM, OWN_SECOND, THEIRS];
  const mine = foldRoom(all, new Set(["m1", "m2"]), { bearer: "Grace/watch" });
  assert.deepEqual(mine.claims.map((c) => c.subject), ["worker/src/fetch.ts::retryFetch", "docs/x.md"]);
  // the same window read by a session that posted none of it carries no claims of its own
  const other = foldRoom(all, new Set(), { bearer: "Opus/design" });
  assert.deepEqual(other.claims, []);
  assert.deepEqual(other.obligations, []);
  assert.equal(other.horizon.own, 0);
});

test("carry: a released claim leaves the open list and the release is carried beside it", () => {
  const c = foldRoom([OWN_CLAIM, OWN_SECOND, OWN_RELEASE], new Set(["m1", "m2", "m3"]), { bearer: "Grace/watch" });
  assert.deepEqual(c.claims.map((x) => x.subject), ["worker/src/fetch.ts::retryFetch"]);
  assert.deepEqual(c.claims.map((x) => [x.id, x.cursor]), [["m1", "1"]]);
  // the retraction is not merely subtracted: a successor that saw only the survivors could not
  // tell a withdrawn subject from one that was never claimed, and would re-claim it
  assert.deepEqual(c.releases.map((x) => x.subject), ["docs/x.md"]);
});

test("carry: the earliest claim on a subject is the one carried", () => {
  const again = msg("m9", "still mine\n\nclaim: worker/src/fetch.ts::retryFetch\n\n-- Grace/watch");
  const c = foldRoom([OWN_CLAIM, again], new Set(["m1", "m9"]), { bearer: "Grace/watch" });
  assert.equal(c.claims.length, 1);
  assert.equal(c.claims[0].id, "m1");
});

test("carry: a verdict carries its exhibits, and an obligation is an own post with a to:", () => {
  const c = foldRoom([OWN_CLAIM, OWN_VERDICT], new Set(["m1", "m4"]), { bearer: "Grace/watch" });
  assert.deepEqual(c.verdicts.map((v) => [v.verdict, v.exhibits, v.id]), [["pass", ["run 4412 line 88", "sha256 abc"], "m4"]]);
  assert.deepEqual(c.obligations.map((o) => [o.to, o.id, o.cursor]), [[["Codex"], "m1", "1"]]);
});

test("carry: at top level a delivery stays owed under a later own post, and an address for someone else is never owed", () => {
  const before = msg("m0", "earlier ask\n\nto: Grace/watch\n\n-- Peer/dev", { who: "peer", kind: "human" });
  const elsewhere = msg("m6", "for the other one\n\nto: Opus/design\n\n-- Peer/dev", { who: "peer", kind: "human" });
  const c = foldRoom([before, OWN_CLAIM, THEIRS, elsewhere], new Set(["m1"]), { bearer: "Grace/watch" });
  // m0 is older than this session's own top-level post, and that post named nothing: at top level
  // a later line of our own is not a receipt, so m0 is still owed. m6 names someone else.
  assert.deepEqual(c.owed.map((o) => o.id), ["m0", "m5"]);
  assert.deepEqual(c.owed.map((o) => [o.from, o.to]), [["Peer/dev", ["Grace/watch"]], ["Peer/dev", ["Grace"]]]);
  assert.deepEqual(c.horizon.lastOwn, { id: "m1", cursor: "1", ts: OWN_CLAIM.ts });
});

test("carry: a receipt naming A leaves B owed, and a later unrelated top-level post leaves both owed", () => {
  // the measured defect: two addressed requests at top level and one `re:` receipt for the first
  // cleared BOTH, because the room lane was cut at this session's own newest post the way a thread
  // is. At top level a post answers nothing it does not name.
  const a = msg("m20", "Request A\n\nto: Grace\n\n-- Peer/dev", { who: "peer", kind: "human" });
  const b = msg("m21", "Request B\n\nto: Grace\n\n-- Peer/dev", { who: "peer", kind: "human" });
  const receipt = msg("m22", "on A\n\nre: m20\n\n-- Grace/watch");
  const c = foldRoom([a, b, receipt], new Set(["m22"]), { bearer: "Grace/watch" });
  assert.deepEqual(c.owed.map((o) => o.id), ["m21"], "the re: clears A alone; B is still unanswered");

  const later = msg("m23", "something else entirely\n\n-- Grace/watch");
  const both = foldRoom([a, b, later], new Set(["m23"]), { bearer: "Grace/watch" });
  assert.deepEqual(both.owed.map((o) => o.id), ["m20", "m21"], "a later top-level post of our own is a receipt for neither");
});

test("carry: with nothing of this session's own in the window, every addressed message is owed", () => {
  const c = foldRoom([THEIRS], new Set(), { bearer: "Grace/watch" });
  assert.deepEqual(c.owed.map((o) => o.id), ["m5"]);
  assert.equal(c.horizon.lastOwn, null);
});

test("carry: an address naming the seat, the model or everyone reaches this bearer", () => {
  const seat = msg("m7", "anyone\n\nto: *\n\n-- Peer/dev", { who: "peer", kind: "human" });
  const named = msg("m8", "the seat\n\nto: agora-bot\n\n-- Peer/dev", { who: "peer", kind: "human" });
  const c = foldRoom([seat, named], new Set(), { bearer: "Grace/watch", seat: { id: "U01", name: "agora-bot" } });
  assert.deepEqual(c.owed.map((o) => o.id), ["m7", "m8"]);
});

test("carry: the window folds the room's live threads, so a release posted as a thread reply closes its claim", async () => {
  // the measured defect: on Slack a room read never contains replies, so a claim taken at the top
  // level and handed back in the thread under it read as still open ninety minutes later
  const parent = msg("p1", "taking it\n\nclaim: human:1788534332\n\n-- Grace/watch", { cursor: "1", raw: { reply_count: 1, latest_reply: "3" } });
  const reply = msg("r3", "handing it back\n\nrelease: human:1788534332\n\n-- Grace/watch", { thread: "p1", cursor: "3" });
  /** @type {import('../src/core.mjs').ReadOptions[]} */
  const reads = [];
  const transport = {
    threads: true,
    /** @param {import('../src/core.mjs').ReadOptions} [o] */
    async read(o = {}) {
      reads.push(o);
      if (o.thread) return o.thread === "p1" ? [reply] : [];
      return [parent]; // channel history: parents only, exactly as Slack answers
    },
  };

  const w = await carryWindow(transport, { limit: 200 });
  assert.deepEqual(w.threads, ["p1"]);
  assert.deepEqual(reads, [{ limit: 200 }, { thread: "p1", since: undefined }]);
  const c = foldRoom(w.messages, new Set(["p1", "r3"]), { bearer: "Grace/watch" });
  assert.deepEqual(c.claims, [], "the release is in the window, so the claim is not open");
  assert.deepEqual(c.releases.map((x) => [x.subject, x.id]), [["human:1788534332", "r3"]]);

  // and the room read alone is the defect, which is what --no-threads buys back
  const plain = await carryWindow(transport, { limit: 200, threads: false });
  assert.deepEqual(plain.threads, []);
  const blind = foldRoom(plain.messages, new Set(["p1", "r3"]), { bearer: "Grace/watch" });
  assert.deepEqual(blind.claims.map((x) => x.subject), ["human:1788534332"]);
  assert.deepEqual(blind.releases, []);
});

test("carry: a thread the transport cannot read is named in threadsUnread and the rest still fold", async () => {
  // the measured defect: on a busy room one `conversations.replies` in the fold was rate limited,
  // and carry exited 1 with an empty envelope -- a successor asking what this seat held got
  // nothing at all, on exactly the room busy enough to need the answer, while a watch on the same
  // call in the same process degraded and kept going
  const p1 = msg("p1", "one\n\nclaim: a\n\n-- Grace/watch", { cursor: "10", raw: { reply_count: 1, latest_reply: "11" } });
  const p2 = msg("p2", "two\n\nclaim: b\n\n-- Grace/watch", { cursor: "20", raw: { reply_count: 1, latest_reply: "31" } });
  const p3 = msg("p3", "three\n\nclaim: c\n\n-- Grace/watch", { cursor: "30", raw: { reply_count: 1, latest_reply: "41" } });
  const r1 = msg("r1", "handing a back\n\nrelease: a\n\n-- Grace/watch", { thread: "p1", cursor: "11" });
  const r3 = msg("r3", "handing c back\n\nrelease: c\n\n-- Grace/watch", { thread: "p3", cursor: "41" });
  /** @type {string[]} */
  const order = [];
  const transport = {
    threads: true,
    /** @param {import('../src/core.mjs').ReadOptions} [o] */
    async read(o = {}) {
      if (!o.thread) return [p1, p2, p3];
      order.push(o.thread);
      // the transport has already retried behind its own jittered wait and given up: this is what
      // the fold is handed, and it must not put a second loop on top of it
      if (o.thread === "p2") throw new AgoraError("slack conversations.replies: rate limited");
      return o.thread === "p1" ? [r1] : [r3];
    },
  };

  const w = await carryWindow(transport, { limit: 200 });
  assert.deepEqual(w.threads, ["p3", "p1"], "two of the three folded");
  assert.deepEqual(w.threadsUnread, [{ id: "p2", reason: "slack conversations.replies: rate limited" }]);
  assert.deepEqual(order, ["p3", "p2", "p1"], "newest activity first, so a fold cut short is cut at the least costly place");
  assert.deepEqual(w.messages.map((m) => m.id), ["p1", "r1", "p2", "p3", "r3"]);

  // the envelope is computed from what was folded: the two readable releases close their claims,
  // and the one behind the unread thread is still reported open -- which is exactly what the
  // named hole tells a successor to distrust
  const c = foldRoom(w.messages, new Set(["p1", "p2", "p3", "r1", "r3"]), { bearer: "Grace/watch" });
  assert.deepEqual(c.claims.map((x) => x.subject), ["b"]);
  assert.deepEqual(c.releases.map((x) => x.subject), ["a", "c"]);
  const text = renderCarry({ ...c, threadsUnread: w.threadsUnread, cursorKey: "down", cursor: null, threads: [] });
  assert.match(text, /unread {6}p2: slack conversations\.replies: rate limited/);
});

test("carry: a malformed thread id and a thread that is gone are recorded, never thrown", async () => {
  const parent = msg("p1", "one\n\n-- Grace/watch", { cursor: "10", raw: { reply_count: 1, latest_reply: "11" } });
  const mangled = msg("m5", "a reply whose thread lost its last digits\n\n-- Grace/watch", { thread: "178845964", cursor: "9" });
  const gone = msg("p9", "two\n\n-- Grace/watch", { cursor: "20", raw: { reply_count: 1, latest_reply: "21" } });
  const transport = {
    threads: true,
    /** @param {string} id */
    validateThread: (id) => (/^p\d$/.test(id) ? undefined : "not a thread id here (an unquoted timestamp loses its last digits under pwsh)"),
    /** @param {import('../src/core.mjs').ReadOptions} [o] */
    async read(o = {}) {
      if (!o.thread) return [parent, mangled, gone];
      if (o.thread === "p9") throw new AgoraError("slack conversations.replies: thread_not_found");
      return [];
    },
  };
  const w = await carryWindow(transport, { limit: 200 });
  assert.deepEqual(w.threads, ["p1"]);
  assert.deepEqual(w.threadsUnread, [
    { id: "p9", reason: "slack conversations.replies: thread_not_found" },
    { id: "178845964", reason: "not a thread id here (an unquoted timestamp loses its last digits under pwsh)" },
  ], "a thread that is gone and one this read cannot reach are the same fact: named, not fatal");
});

test("carry: through the slack transport, a thread whose ts lost its digits is named unread with the reason and never read", async () => {
  const good = "1700000000.000100";
  const bad = "1788589282.65997";
  const { fetch, calls } = fakeFetch([
    ["users.info", () => ({ body: { ok: true, user: { id: "U2", real_name: "peer" } } })],
    ["conversations.history", () => ({
      body: {
        ok: true,
        has_more: false,
        messages: [
          // a broadcast reply (the one kind of reply a room read keeps) whose thread_ts is mangled:
          // the fold roots a thread on it, and that root must be named unread, not read
          { ts: "1700000000.000300", user: "U2", subtype: "thread_broadcast", text: "a reply whose thread lost its last digits", thread_ts: bad },
          { ts: good, user: "U2", text: "parent", thread_ts: good, reply_count: 1, latest_reply: "1700000000.000200" },
        ],
      },
    })],
    ["conversations.replies", () => ({
      body: {
        ok: true,
        has_more: false,
        messages: [
          { ts: good, user: "U2", text: "parent", thread_ts: good, reply_count: 1 },
          { ts: "1700000000.000200", user: "U2", text: "the reply in the good thread", thread_ts: good },
        ],
      },
    })],
  ]);
  const t = slackTransport({ transport: "slack", channel: "C1" }, { token: "x", fetch });
  const w = await carryWindow(t, { limit: 200 });
  assert.deepEqual(w.threads, [good], "the readable thread is folded");
  assert.equal(w.threadsUnread.length, 1);
  assert.equal(w.threadsUnread[0].id, bad);
  assert.match(w.threadsUnread[0].reason, /5 digits after the dot, not 6/);
  assert.match(w.threadsUnread[0].reason, /unquoted ts loses its trailing digits under PowerShell/);
  assert.ok(w.messages.some((m) => m.text === "the reply in the good thread"));
  const asked = calls.filter((c) => String(c.url).includes("conversations.replies")).map((c) => new URL(String(c.url)).searchParams.get("ts"));
  assert.deepEqual(asked, [good], "the malformed id never reached the API");
  const text = renderCarry({ ...foldRoom(w.messages, new Set(), { bearer: "Grace/watch" }), threadsUnread: w.threadsUnread, cursorKey: "down", cursor: null, threads: w.threads });
  assert.match(text, /unread {6}1788589282\.65997: a Slack thread id is the parent message's ts/);
});

test("carry: --no-threads carries the field empty, and the room read is the one failure that is fatal", async () => {
  const parent = msg("p1", "one\n\n-- Grace/watch", { cursor: "10", raw: { reply_count: 1, latest_reply: "11" } });
  const transport = {
    threads: true,
    /** @param {import('../src/core.mjs').ReadOptions} [o] */
    async read(o = {}) {
      if (o.thread) throw new AgoraError("slack conversations.replies: rate limited");
      return [parent];
    },
  };
  const plain = await carryWindow(transport, { limit: 200, threads: false });
  assert.deepEqual(plain.threadsUnread, [], "the field is in the envelope whether or not a thread was missed");

  const roomFails = { threads: true, async read() { throw new AgoraError("slack conversations.history: rate limited"); } };
  await assert.rejects(() => carryWindow(roomFails, { limit: 200 }), /conversations\.history: rate limited/);
});

test("carry: a claim taken again after a release re-opens the subject, and the earliest after the release holds", () => {
  const take = msg("c1", "taking it\n\nclaim: docs/x.md\n\n-- Grace/watch");
  const give = msg("c2", "handing it back\n\nrelease: docs/x.md\n\n-- Grace/watch");
  const again = msg("c3", "taking it up again\n\nclaim: docs/x.md\n\n-- Grace/watch");
  const later = msg("c4", "still mine\n\nclaim: docs/x.md\n\n-- Grace/watch");
  const c = foldRoom([take, give, again, later], new Set(["c1", "c2", "c3", "c4"]), { bearer: "Grace/watch" });
  assert.deepEqual(c.claims.map((x) => [x.subject, x.id]), [["docs/x.md", "c3"]], "the earliest claim after the release, not the first one ever posted");
  assert.deepEqual(c.releases.map((x) => x.id), ["c2"], "the retraction is still carried beside it");
});

test("carry: a verdict answering an earlier own verdict supersedes it, and the withdrawn one is carried", () => {
  const first = msg("v1", "it passes\n\nverdict: pass\nexhibit: run 4412 line 88\n\n-- Grace/watch");
  const withdrawn = msg("v2", "that was the wrong branch\n\nre: v1\nverdict: withdrawn\nexhibit: run 4419 line 12\n\n-- Grace/watch");
  const c = foldRoom([first, withdrawn], new Set(["v1", "v2"]), { bearer: "Grace/watch" });
  assert.deepEqual(c.verdicts.map((v) => [v.verdict, v.id]), [["withdrawn", "v2"]], "the withdrawn verdict is no longer what this session says");
  assert.deepEqual(c.superseded.map((v) => [v.id, v.cursor, v.verdict, v.supersededBy]), [["v1", "1", "pass", "v2"]]);
  const text = renderCarry({ ...c, cursorKey: "down", cursor: null });
  assert.match(text, /superseded {2}pass {3}v1 cursor 1, withdrawn by v2/);
  assert.ok(!text.includes("it passes"), "a withdrawal names the verdict, never the words");

  // a `re:` that names something other than one of this session's own verdicts changes nothing
  const unrelated = msg("v3", "and the other one\n\nre: foreign-9\nverdict: pass\nexhibit: run 4420\n\n-- Grace/watch");
  const b = foldRoom([first, unrelated], new Set(["v1", "v3"]), { bearer: "Grace/watch" });
  assert.deepEqual(b.verdicts.map((v) => v.id), ["v1", "v3"]);
  assert.deepEqual(b.superseded, []);
});

test("carry: a withdraws: supersedes an earlier own verdict and releases an earlier own claim", () => {
  // the measured defect: across twenty-two verdicts over one day and four bearers, not one carried
  // a `re:` naming the verdict it withdrew, so supersession never fired on real data at all
  const first = msg("v1", "it passes\n\nverdict: pass\nexhibit: run 4412 line 88\n\n-- Grace/watch");
  const back = msg("v2", "wrong branch, taking that back\n\nwithdraws: v1\n\n-- Grace/watch");
  const c = foldRoom([first, back], new Set(["v1", "v2"]), { bearer: "Grace/watch" });
  assert.deepEqual(c.verdicts, [], "a withdrawal needs no verdict of its own to take one back");
  assert.deepEqual(c.superseded.map((v) => [v.id, v.cursor, v.verdict, v.supersededBy]), [["v1", "1", "pass", "v2"]]);
  const text = renderCarry({ ...c, cursorKey: "down", cursor: null });
  assert.match(text, /superseded {2}pass {3}v1 cursor 1, withdrawn by v2/);

  // by cursor as well as by id: an agent that read the cursor off `post` need not translate it
  const byCursor = foldRoom([first, msg("v3", "taking it back\n\nwithdraws: 1\n\n-- Grace/watch")], new Set(["v1", "v3"]), { bearer: "Grace/watch" });
  assert.deepEqual(byCursor.superseded.map((v) => [v.id, v.supersededBy]), [["v1", "v3"]]);

  // a withdrawal naming an earlier own CLAIM hands its subject back, as a release: does
  const dropped = msg("m20", "not mine after all\n\nwithdraws: m1\n\n-- Grace/watch");
  const claims = foldRoom([OWN_CLAIM, OWN_SECOND, dropped], new Set(["m1", "m2", "m20"]), { bearer: "Grace/watch" });
  assert.deepEqual(claims.claims.map((x) => x.subject), ["docs/x.md"]);
  assert.deepEqual(claims.releases.map((x) => [x.subject, x.id]), [["worker/src/fetch.ts::retryFetch", "m20"]], "carried, never merely subtracted");

  // and one that names nothing of this session's own changes nothing
  const foreign = foldRoom([first, OWN_CLAIM, msg("v4", "x\n\nwithdraws: foreign-9\n\n-- Grace/watch")], new Set(["v1", "m1", "v4"]), { bearer: "Grace/watch" });
  assert.deepEqual(foreign.verdicts.map((v) => v.id), ["v1"]);
  assert.deepEqual(foreign.superseded, []);
  assert.deepEqual(foreign.releases, []);
  assert.deepEqual(foreign.claims.map((x) => x.subject), ["worker/src/fetch.ts::retryFetch"]);
});

test("carry: an incoming withdraws: is rendered and never folded", () => {
  // the ledger is the whole filter here as everywhere: a counterpart cannot withdraw a verdict of
  // ours by naming it, and this side's fold does not read their block at all
  const mine = msg("v1", "it passes\n\nverdict: pass\nexhibit: run 4412 line 88\n\n-- Grace/watch");
  const theirs = msg("x9", "that one is wrong\n\nwithdraws: v1\n\n-- Peer/dev", { who: "peer", kind: "human" });
  const c = foldRoom([mine, theirs], new Set(["v1"]), { bearer: "Grace/watch" });
  assert.deepEqual(c.verdicts.map((v) => v.id), ["v1"]);
  assert.deepEqual(c.superseded, []);
});

test("carry: a delivery addressed here is owed until this session answers it by name", () => {
  const ask = msg("m10", "can you rerun it?\n\nto: Grace\n\n-- Peer/dev", { who: "peer", kind: "human" });
  const open = foldRoom([OWN_CLAIM, ask], new Set(["m1"]), { bearer: "Grace/watch" });
  assert.deepEqual(open.owed.map((o) => o.id), ["m10"], "a delivery awaiting a reply, not this session's own to:");
  assert.deepEqual(open.obligations.map((o) => o.id), ["m1"], "what this session addressed to someone else is the other list");

  // the receipt is posted in a thread, so only the `re:` can be what answers it
  const receipt = msg("m11", "on it\n\nre: m10\n\n-- Grace/watch", { thread: "t9" });
  const answered = foldRoom([OWN_CLAIM, ask, receipt], new Set(["m1", "m11"]), { bearer: "Grace/watch" });
  assert.deepEqual(answered.owed, []);

  const other = msg("m11", "on something else\n\nre: m99\n\n-- Grace/watch", { thread: "t9" });
  const still = foldRoom([OWN_CLAIM, ask, other], new Set(["m1", "m11"]), { bearer: "Grace/watch" });
  assert.deepEqual(still.owed.map((o) => o.id), ["m10"], "a re: naming another message answers nothing here");
});

test("carry: a post in the room or in another thread is no receipt for a delivery in this one", () => {
  const inThread = msg("m12", "and this one?\n\nto: Grace\n\n-- Peer/dev", { who: "peer", kind: "human", thread: "t1" });
  const elsewhere = msg("m13", "noted\n\n-- Grace/watch", { thread: "t2" });
  const top = msg("m14", "back to the room\n\n-- Grace/watch");
  const c = foldRoom([inThread, elsewhere, top], new Set(["m13", "m14"]), { bearer: "Grace/watch" });
  assert.deepEqual(c.owed.map((o) => [o.id, o.thread]), [["m12", "t1"]]);
  const here = foldRoom([inThread, msg("m15", "on it\n\n-- Grace/watch", { thread: "t1" })], new Set(["m15"]), { bearer: "Grace/watch" });
  assert.deepEqual(here.owed, [], "speaking in the same thread after it is the receipt");
});

test("carry: nothing rendered carries a message body", () => {
  const c = foldRoom([OWN_CLAIM, OWN_VERDICT, THEIRS], new Set(["m1", "m4"]), { bearer: "Grace/watch" });
  const text = renderCarry({
    room: { alias: "down", transport: "local", room: "/tmp/down.ndjson" },
    bearer: { name: "Grace/watch", source: "session" },
    session: { slug: "s1", source: "AGORA_SESSION", registered: true },
    seat: { name: "agora-bot", id: "U01" },
    cursor: "4",
    cursorKey: "down",
    threads: [],
    follow: { threads: {} },
    armed: [],
    ...c,
  });
  for (const body of ["taking it", "settled", "can you rerun it?"]) assert.ok(!text.includes(body), `${body} is a message body and must not be rendered`);
  assert.match(text, /claim {7}worker\/src\/fetch\.ts::retryFetch {3}m1 cursor 1/);
  assert.match(text, /owed {8}from Peer\/dev to Grace {3}m5 cursor 5/);
  assert.match(text, /exhibit: run 4412 line 88 \| sha256 abc/);
});

test("carry: state is read, never seeded, so the verb writes nothing", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const sdir = path.join(dir, "sessions", "s1");
    await mkdir(sdir, { recursive: true });
    await writeCursor(dir, "down", "77"); // the single-session layout at the state root
    const before = (await readdir(sdir)).sort();
    const state = await carryState(sdir, dir, "down");
    assert.equal(state.cursor, null);
    assert.equal(state.seedFrom, "77", "what the next watch would seed from is said, not performed");
    assert.deepEqual((await readdir(sdir)).sort(), before, "carry stores nothing");
  } finally {
    await cleanup();
  }
});

test("carry: a thread with a position that has left the follow set is carried, marked as left", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const sdir = path.join(dir, "sessions", "s1");
    await mkdir(sdir, { recursive: true });
    await writeCursor(sdir, "down", "12");
    await writeCursor(sdir, "down#t1", "3");
    await writeCursor(sdir, "down#t2", "9");
    await writeFollow(sdir, "down", { threads: { t1: "2026-09-04T00:00:00.000Z" }, aliases: { t1b: "t1" } });
    const state = await carryState(sdir, dir, "down");
    assert.equal(state.cursor, "12");
    assert.equal(state.seedFrom, undefined);
    assert.deepEqual(state.threads.map((t) => [t.thread, t.cursor, t.followed]), [["t1", "3", true], ["t2", "9", false]]);
    assert.deepEqual(state.follow.aliases, { t1b: "t1" });
  } finally {
    await cleanup();
  }
});

test("cli: carry derives the keep-list from the session directory and one bounded read", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const cfgPath = path.join(dir, "agora.json");
    await writeFile(cfgPath, JSON.stringify({
      actor: { name: "Grace/watch", kind: "agent" },
      rooms: { down: { transport: "local", path: path.join(dir, "down.ndjson"), note: "shared lane" } },
    }));
    const env = { AGORA_CONFIG: cfgPath, AGORA_STATE: path.join(dir, "state"), AGORA_SESSION: "s1" };
    await agora(["session", "--as", "Grace/watch"], env);
    await agora(["post", "down", "--claim", "worker/src/fetch.ts::retryFetch", "--to", "Codex", "taking the retry path"], env);
    await agora(["post", "down", "--verdict", "pass", "--exhibit", "run 4412 line 88", "settled"], env);
    // a message this session did not post, addressed to it, after its last post. The window is one
    // ascending list merged by time, as every transport's own read is, so the stamp is later than
    // the posts above it rather than a fixed one that could fall before them.
    await writeFile(path.join(dir, "down.ndjson"), await readFile(path.join(dir, "down.ndjson"), "utf8")
      + JSON.stringify({ id: "foreign-1", author: { id: "peer", name: "peer", kind: "human" }, text: "can you rerun it?\n\nto: Grace\n\n-- Peer/dev", ts: new Date(Date.now() + 60_000).toISOString() }) + "\n");

    const r = await agora(["carry", "down", "--json"], env);
    assert.equal(r.code, 0);
    const c = JSON.parse(r.stdout.trim());
    assert.equal(c.type, "carry");
    assert.deepEqual(c.room.alias, "down");
    assert.equal(c.room.note, "shared lane");
    assert.deepEqual(c.bearer, { name: "Grace/watch", source: "session" });
    assert.deepEqual(c.session, { slug: "s1", source: "AGORA_SESSION", registered: true });
    assert.deepEqual(c.claims.map((/** @type {any} */ x) => x.subject), ["worker/src/fetch.ts::retryFetch"]);
    assert.deepEqual(c.verdicts.map((/** @type {any} */ x) => [x.verdict, x.exhibits]), [["pass", ["run 4412 line 88"]]]);
    assert.deepEqual(c.obligations.map((/** @type {any} */ x) => x.to), [["Codex"]]);
    assert.deepEqual(c.superseded, [], "the field is in the envelope whether or not anything was withdrawn");
    assert.deepEqual(c.owed.map((/** @type {any} */ x) => [x.id, x.from]), [["foreign-1", "Peer/dev"]]);
    assert.equal(c.horizon.messages, 3);
    for (const body of ["taking the retry path", "can you rerun it?"]) assert.ok(!r.stdout.includes(body), "no message text crosses into the carry");

    // the cursor is not moved and nothing is written by the call
    const sdir = path.join(dir, "state", "sessions", "s1");
    const before = (await readdir(sdir)).sort();
    const human = await agora(["carry", "down"], env);
    assert.equal(human.code, 0);
    assert.match(human.stdout, /^carry down \(local /);
    assert.match(human.stdout, /Nothing here is stored/);
    assert.deepEqual((await readdir(sdir)).sort(), before);
  } finally {
    await cleanup();
  }
});

test("cli: carry --limit and --no-threads are bounded reads that move no cursor", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const cfgPath = path.join(dir, "agora.json");
    await writeFile(cfgPath, JSON.stringify({
      actor: { name: "Grace/watch", kind: "agent" },
      rooms: { down: { transport: "local", path: path.join(dir, "down.ndjson") } },
    }));
    const env = { AGORA_CONFIG: cfgPath, AGORA_STATE: path.join(dir, "state"), AGORA_SESSION: "s1" };
    await agora(["session", "--as", "Grace/watch"], env);
    for (const n of [1, 2, 3]) await agora(["post", "down", `line ${n}`], env);
    const r = await agora(["carry", "down", "--json", "--limit", "2", "--no-threads"], env);
    assert.equal(r.code, 0);
    const c = JSON.parse(r.stdout.trim());
    assert.equal(c.horizon.messages, 2, "the window is the newest --limit messages");
    const cur = await agora(["cursor", "down", "--json"], env);
    assert.equal(JSON.parse(cur.stdout.trim()).cursor, null, "carry never touches the saved position");
  } finally {
    await cleanup();
  }
});

/**
 * A Slack API stand-in: a channel of three parents, each with one reply, where the thread named
 * by `limited` answers `conversations.replies` with 429 forever. The transport's own jittered
 * retry runs against it and gives up on its own, which is the state `carry` is handed.
 * @param {{ limited?: string, roomStatus?: number }} [o]
 */
async function slackStub(o = {}) {
  const parents = [
    { ts: "1788459640.000100", user: "U1", text: "taking a\n\nclaim: a\n\n-- Grace/watch", reply_count: 1, latest_reply: "1788459640.000110" },
    { ts: "1788459640.000200", user: "U1", text: "taking b\n\nclaim: b\n\n-- Grace/watch", reply_count: 1, latest_reply: "1788459640.000210" },
    { ts: "1788459640.000300", user: "U1", text: "taking c\n\nclaim: c\n\n-- Grace/watch", reply_count: 1, latest_reply: "1788459640.000310" },
  ];
  /** @type {Record<string, any[]>} */
  const replies = {
    "1788459640.000100": [{ ts: "1788459640.000110", user: "U1", thread_ts: "1788459640.000100", text: "handing a back\n\nrelease: a\n\n-- Grace/watch" }],
    "1788459640.000200": [{ ts: "1788459640.000210", user: "U1", thread_ts: "1788459640.000200", text: "handing b back\n\nrelease: b\n\n-- Grace/watch" }],
    "1788459640.000300": [{ ts: "1788459640.000310", user: "U1", thread_ts: "1788459640.000300", text: "handing c back\n\nrelease: c\n\n-- Grace/watch" }],
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    /** @param {any} body */
    const send = (body) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname === "/auth.test") return send({ ok: true, user_id: "U9", user: "agora-bot" });
    if (url.pathname === "/users.info") return send({ ok: true, user: { real_name: "Grace" } });
    if (url.pathname === "/conversations.history") {
      if (o.roomStatus) return res.writeHead(o.roomStatus).end("no");
      return send({ ok: true, messages: parents });
    }
    if (url.pathname === "/conversations.replies") {
      const ts = String(url.searchParams.get("ts"));
      // no retry-after body: the header is what the transport waits on, and it floors at a second
      if (ts === o.limited) return res.writeHead(429, { "retry-after": "0" }).end("{}");
      return send({ ok: true, messages: [parents.find((p) => p.ts === ts), ...(replies[ts] ?? [])] });
    }
    return res.writeHead(404).end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    api: `http://127.0.0.1:${addr.port}`,
    ids: ["1788459640.000100", "1788459640.000110", "1788459640.000200", "1788459640.000300", "1788459640.000310"],
    close: () => new Promise((r) => server.close(() => r(undefined))),
  };
}

test("cli: carry survives a rate-limited thread read, names it, and still emits the envelope", async () => {
  // the measured defect: on a busy room one rate-limited `conversations.replies` in the fold took
  // the whole envelope down -- exit 1, zero bytes -- and a successor asking what this seat held
  // got nothing, while a watch on the same call in the same process degraded and kept going
  const { dir, cleanup } = await tmp();
  const slack = await slackStub({ limited: "1788459640.000200" });
  try {
    const cfgPath = path.join(dir, "agora.json");
    await writeFile(cfgPath, JSON.stringify({
      actor: { name: "Grace/watch", kind: "agent" },
      rooms: { busy: { transport: "slack", channel: "C0123ABC", api: slack.api, tokenEnv: "AGORA_TEST_SLACK" } },
    }));
    const env = { AGORA_CONFIG: cfgPath, AGORA_STATE: path.join(dir, "state"), AGORA_SESSION: "s1", AGORA_TEST_SLACK: "xoxb-stub" };
    await agora(["session", "--as", "Grace/watch"], env);
    // the ledger is the filter on the fold, and these are this session's own posts
    const sdir = path.join(dir, "state", "sessions", "s1");
    for (const id of slack.ids) await appendPosted(sdir, id);

    const r = await agora(["carry", "busy", "--json"], env);
    assert.equal(r.code, 0, "one unreadable thread is not a failed handover");
    const c = JSON.parse(r.stdout.trim());
    assert.equal(c.type, "carry");
    assert.deepEqual(c.threadsUnread, [{ id: "1788459640.000200", reason: "slack conversations.replies: rate limited" }]);
    assert.match(r.stderr, /agora: folded 2 of 3 live threads into the room; 1 not read: 1788459640\.000200 \(slack conversations\.replies: rate limited\)/);
    // the two threads that were readable folded, so the releases in them closed their claims; the
    // subject behind the unread thread is still reported open, which the named hole is the warning about
    assert.deepEqual(c.claims.map((/** @type {any} */ x) => x.subject), ["b"]);
    assert.deepEqual(c.releases.map((/** @type {any} */ x) => x.subject), ["a", "c"]);
    assert.equal(c.horizon.messages, 5);

    const human = await agora(["carry", "busy"], env);
    assert.equal(human.code, 0);
    assert.match(human.stdout, /unread {6}1788459640\.000200: slack conversations\.replies: rate limited/);
  } finally {
    await slack.close();
    await cleanup();
  }
});

test("cli: a room read that fails is still exit 1, because there is no envelope without it", async () => {
  const { dir, cleanup } = await tmp();
  const slack = await slackStub({ roomStatus: 500 });
  try {
    const cfgPath = path.join(dir, "agora.json");
    await writeFile(cfgPath, JSON.stringify({
      actor: { name: "Grace/watch", kind: "agent" },
      rooms: { busy: { transport: "slack", channel: "C0123ABC", api: slack.api, tokenEnv: "AGORA_TEST_SLACK" } },
    }));
    const env = { AGORA_CONFIG: cfgPath, AGORA_STATE: path.join(dir, "state"), AGORA_SESSION: "s1", AGORA_TEST_SLACK: "xoxb-stub" };
    await agora(["session", "--as", "Grace/watch"], env);
    const r = await agora(["carry", "busy", "--json"], env);
    assert.equal(r.code, 1);
    assert.equal(r.stdout.trim(), "", "a partial envelope would be a lie about the window it was computed from");
    assert.match(r.stderr, /conversations\.history: HTTP 500/);
  } finally {
    await slack.close();
    await cleanup();
  }
});

test("inherit: cursors, follow set and ledger are copied, the ledger appended, the source untouched", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const src = path.join(dir, "sessions", "old");
    const dst = path.join(dir, "sessions", "new");
    await mkdir(src, { recursive: true });
    await writeCursor(src, "down", "41");
    await writeCursor(src, "down#t1", "3");
    await writeFollow(src, "down", { threads: { t1: "2026-09-04T00:00:00.000Z" }, aliases: { t1b: "t1" } });
    await appendPosted(src, "old-1");
    await appendPosted(src, "old-2");
    await mkdir(dst, { recursive: true });
    await appendPosted(dst, "new-1");

    const plan = await inheritSession(dir, "old", { slug: "new", source: "AGORA_SESSION", explicit: true });
    assert.deepEqual(plan.cursors, ["down", "down#t1"]);
    assert.deepEqual(plan.follow, ["down"]);
    assert.equal(plan.ledger.lines, 2);
    assert.deepEqual(plan.conflicts, []);

    assert.equal(JSON.parse(await readFile(path.join(dst, "down.cursor"), "utf8")).cursor, "41");
    assert.equal(JSON.parse(await readFile(path.join(dst, "down#t1.cursor"), "utf8")).cursor, "3");
    assert.deepEqual(JSON.parse(await readFile(path.join(dst, "follow", "down.json"), "utf8")).aliases, { t1b: "t1" });
    // appended, never replaced: this session's own ids are its own protection against a self-echo
    assert.deepEqual([...(await readPosted(dst))].sort(), ["new-1", "old-1", "old-2"]);
    assert.deepEqual([...(await readPosted(src))].sort(), ["old-1", "old-2"], "the source is read only");
    assert.ok(!existsSync(path.join(dst, "session.json")), "the record says who a session is and is never inherited");
  } finally {
    await cleanup();
  }
});

test("inherit: a room this session already holds is refused, and --force takes it", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const src = path.join(dir, "sessions", "old");
    const dst = path.join(dir, "sessions", "new");
    await mkdir(src, { recursive: true });
    await writeCursor(src, "down", "41");
    await writeCursor(dst, "down", "7");
    const session = { slug: "new", source: "AGORA_SESSION", explicit: true };
    await assert.rejects(() => inheritSession(dir, "old", session), (/** @type {any} */ e) => {
      assert.equal(e.exitCode, 2);
      assert.match(e.message, /already holds a position in down/);
      return true;
    });
    assert.equal(JSON.parse(await readFile(path.join(dst, "down.cursor"), "utf8")).cursor, "7", "a refusal changes nothing");
    const plan = await inheritSession(dir, "old", session, { force: true });
    assert.deepEqual(plan.conflicts, ["down"]);
    assert.equal(plan.forced, true);
    assert.equal(JSON.parse(await readFile(path.join(dst, "down.cursor"), "utf8")).cursor, "41");
  } finally {
    await cleanup();
  }
});

test("inherit: this session, an unknown key and a key that is not a session name are usage errors", async () => {
  const { dir, cleanup } = await tmp();
  try {
    await mkdir(path.join(dir, "sessions", "old"), { recursive: true });
    const session = { slug: "new", source: "AGORA_SESSION", explicit: true };
    for (const [key, why] of [["new", /is this session/], ["nope", /no session nope has state/], ["..", /is not one/], ["a/b", /is not one/]])
      await assert.rejects(() => inheritSession(dir, String(key), session), (/** @type {any} */ e) => {
        assert.equal(e.exitCode, 2, `${key} is a usage error`);
        assert.match(e.message, /** @type {RegExp} */ (why));
        return true;
      });
  } finally {
    await cleanup();
  }
});

test("cli: session --inherit --dry-run says what it would copy and copies nothing", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const cfgPath = path.join(dir, "agora.json");
    await writeFile(cfgPath, JSON.stringify({
      actor: { name: "Grace/watch", kind: "agent" },
      rooms: { down: { transport: "local", path: path.join(dir, "down.ndjson") } },
    }));
    const state = path.join(dir, "state");
    const one = { AGORA_CONFIG: cfgPath, AGORA_STATE: state, AGORA_SESSION: "s1" };
    const two = { AGORA_CONFIG: cfgPath, AGORA_STATE: state, AGORA_SESSION: "s2" };
    await agora(["session", "--as", "Grace/watch"], one);
    await agora(["post", "down", "the predecessor's line"], one);
    await agora(["cursor", "down", "--now"], one);

    const dry = await agora(["session", "--inherit", "s1", "--dry-run"], two);
    assert.equal(dry.code, 0);
    assert.match(dry.stdout, /^would inherit from s1: 1 cursor \(down\)/);
    assert.ok(!existsSync(path.join(state, "sessions", "s2", "down.cursor")), "a dry run copies nothing");

    const did = await agora(["session", "--inherit", "s1", "--json"], two);
    assert.equal(did.code, 0);
    const plan = JSON.parse(did.stdout.trim());
    assert.equal(plan.type, "inherit");
    assert.deepEqual(plan.cursors, ["down"]);
    assert.equal(plan.ledger.lines, 1);
    assert.match(did.stderr, /record was not copied; run `agora session --as/);

    // the whole point: the successor resumes at the predecessor's position and its predecessor's
    // own post is not delivered back to it as a foreign message
    const w = await agora(["watch", "down", "--once", "--json"], two);
    assert.equal(w.code, 0, "nothing new: the position was inherited, so the room is not replayed");
    const lines = typed(w.stdout);
    const result = lines.find((/** @type {any} */ l) => l.type === "watch-result");
    assert.equal(result.delivered, 0);

    // and with the position reset, the predecessor's post is skipped by the inherited ledger
    await agora(["cursor", "down", "--reset"], two);
    const again = await agora(["watch", "down", "--once", "--json"], two);
    assert.equal(again.code, 0, "the inherited ledger makes the predecessor's post this session's own");
    const r2 = typed(again.stdout).find((/** @type {any} */ l) => l.type === "watch-result");
    assert.equal(r2.skipped, 1);
    assert.equal(r2.delivered, 0);
  } finally {
    await cleanup();
  }
});

test("cli: session --inherit refuses a held room with exit 2 and names --force", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const cfgPath = path.join(dir, "agora.json");
    await writeFile(cfgPath, JSON.stringify({
      actor: { name: "Grace/watch", kind: "agent" },
      rooms: { down: { transport: "local", path: path.join(dir, "down.ndjson") } },
    }));
    const state = path.join(dir, "state");
    const one = { AGORA_CONFIG: cfgPath, AGORA_STATE: state, AGORA_SESSION: "s1" };
    const two = { AGORA_CONFIG: cfgPath, AGORA_STATE: state, AGORA_SESSION: "s2" };
    await agora(["post", "down", "one"], one);
    await agora(["cursor", "down", "--now"], one);
    await agora(["post", "down", "two"], two);
    await agora(["cursor", "down", "--now"], two);
    const held = JSON.parse((await agora(["cursor", "down", "--json"], two)).stdout.trim()).cursor;

    const refused = await agora(["session", "--inherit", "s1"], two);
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /already holds a position in down.*--force/s);
    assert.equal(JSON.parse((await agora(["cursor", "down", "--json"], two)).stdout.trim()).cursor, held);

    const forced = await agora(["session", "--inherit", "s1", "--force"], two);
    assert.equal(forced.code, 0);
    assert.match(forced.stdout, /--force took s1's position in down/);
  } finally {
    await cleanup();
  }
});
