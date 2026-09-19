// @ts-check
// Pins for the seams the consumer mutation sweep found in src/carry.mjs (scripts/mutate-consumers.mjs):
// each test names the survivor it kills, a mutation that every importing test left green. The
// survivors it does not kill are equivalent mutants and are listed at the end, with why.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { writeCursor } from "../src/core.mjs";
import { carryState, carryWindow, foldRoom } from "../src/carry.mjs";
import { writeArmed } from "../src/session.mjs";
import { writeFollow } from "../src/follow.mjs";
import { tmp } from "./helpers.mjs";

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

/**
 * A transport that records every read it is asked for and answers from a map of thread -> replies.
 * @param {import('../src/core.mjs').Message[]} room @param {Record<string, import('../src/core.mjs').Message[]>} threads @param {{ threads?: boolean }} [o]
 */
function fakeTransport(room, threads, o = {}) {
  /** @type {Array<{ thread?: string, limit?: number, since?: string }>} */
  const reads = [];
  return {
    reads,
    transport: /** @type {any} */ ({
      kind: "fake", room: "r", threads: o.threads ?? true,
      /** @param {{ thread?: string, limit?: number, since?: string }} [opts] */
      async read(opts = {}) { reads.push(opts); return opts.thread ? (threads[opts.thread] ?? []) : room; },
    }),
  };
}

test("carryWindow: the default limit is 200 (survivor 124: 200 -> 201)", async () => {
  const { transport, reads } = fakeTransport([], {});
  await carryWindow(transport);
  assert.deepEqual(reads, [{ limit: 200 }]);
});

test("carryWindow: a transport without threads folds nothing even when folding is asked for (survivor 128: || -> &&)", async () => {
  const room = [msg("p1", "parent"), msg("r1", "reply", { thread: "p1" })];
  const { transport, reads } = fakeTransport(room, { p1: [msg("r2", "another reply", { thread: "p1" })] }, { threads: false });
  const w = await carryWindow(transport, { threads: true });
  assert.equal(reads.length, 1, "one room read and no thread read");
  assert.deepEqual(w.threads, []);
  assert.equal(w.messages.length, 2);
});

test("carryWindow: the cap bounds how many threads fold, and the threads with the newest activity fold first (survivors 131, 173, 185)", async () => {
  // three parents; t2 has the newest reply in the window, t1 the newest latest_reply, t3 is quiet
  const room = [
    msg("t1", "one", { cursor: "1", raw: { reply_count: 1, latest_reply: "9" } }), // its reply is outside the window; the parent says it exists
    msg("t2", "two", { cursor: "2" }),
    msg("t3", "three", { cursor: "3" }),
    msg("t2r", "reply", { thread: "t2", cursor: "8" }),
    msg("t3r", "reply", { thread: "t3", cursor: "4" }),
  ];
  const replies = { t1: [msg("t1x", "x", { thread: "t1", cursor: "9" })], t2: [msg("t2r", "reply", { thread: "t2", cursor: "8" })], t3: [msg("t3r", "reply", { thread: "t3", cursor: "4" })] };
  const all = await carryWindow(fakeTransport(room, replies).transport);
  assert.deepEqual(all.threads, ["t1", "t2", "t3"], "newest activity first: t1 by latest_reply 9, t2 by its reply 8, t3 by its reply 4");
  const capped = await carryWindow(fakeTransport(room, replies).transport, { cap: 2 });
  assert.equal(capped.threads.length, 2, "the cap is passed through to the bounding");
  // a Slack parent names its own id as its thread and is a root, not a reply in a thread
  const slackParent = [msg("s1", "parent", { thread: "s1", cursor: "1" }), msg("s1r", "reply", { thread: "s1", cursor: "2" })];
  const s = await carryWindow(fakeTransport(slackParent, { s1: [] }).transport);
  assert.deepEqual(s.threads, ["s1"]);
});

test("carryState: a room's own key is the room, a thread key is a thread, the threads sort by key, and only this room's live armed watches are carried (survivors 42, 60, 65, 67)", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const sdir = path.join(dir, "sessions", "s1");
    await mkdir(sdir, { recursive: true });
    await writeCursor(sdir, "down", "12");
    await writeCursor(sdir, "down#b", "3");
    await writeCursor(sdir, "down#a", "9");
    await writeCursor(sdir, "downstairs", "1"); // a different room whose key shares the prefix
    await writeFollow(sdir, "down", { threads: {}, aliases: {} });
    await writeArmed(sdir, "down", { room: "down", pid: process.pid, mode: "stream", interval: 15, startedAt: "2026-09-04T00:00:00.000Z" });
    await writeArmed(sdir, "downstairs", { room: "downstairs", pid: process.pid, mode: "stream", interval: 15, startedAt: "2026-09-04T00:00:00.000Z" });
    const state = await carryState(sdir, dir, "down");
    assert.equal(state.cursor, "12", "the room key itself is the room's cursor, never listed as a thread");
    assert.deepEqual(state.threads.map((t) => t.thread), ["a", "b"], "threads carried sorted by key, and the other room's key is not one of them");
    assert.deepEqual(state.armed.map((a) => a.key), ["down"], "an armed watch on another room is not this room's");
  } finally {
    await cleanup();
  }
});

test("carryState: an armed file that is not a record is skipped (survivor 67: !rec)", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const sdir = path.join(dir, "sessions", "s1");
    await mkdir(path.join(sdir, "armed"), { recursive: true });
    await writeCursor(sdir, "down", "1");
    await writeFollow(sdir, "down", { threads: {}, aliases: {} });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(sdir, "armed", "down.json"), "{\"room\":\"down\"}\n"); // no pid: not a record
    const state = await carryState(sdir, dir, "down");
    assert.deepEqual(state.armed, []);
  } finally {
    await cleanup();
  }
});

test("foldRoom: the horizon names the window's ends and this session's last own post (survivors 393, 394, 395)", () => {
  const msgs = [
    msg("m1", "first\n\n-- Peer/dev", { who: "peer" }),
    msg("m2", "mine\n\n-- Alice/watch"),
    msg("m3", "last\n\n-- Peer/dev", { who: "peer" }),
  ];
  const c = foldRoom(msgs, new Set(["m2"]), { bearer: "Alice/watch" });
  assert.equal(c.horizon.oldest, msgs[0].ts);
  assert.equal(c.horizon.newest, msgs[2].ts);
  assert.deepEqual(c.horizon.lastOwn, { id: "m2", cursor: "2", ts: msgs[1].ts });
  assert.equal(c.horizon.own, 1);
  const none = foldRoom(msgs, new Set(), { bearer: "Alice/watch" });
  assert.equal(none.horizon.lastOwn, null, "no own post in the window is null, not the first message");
  const first = foldRoom(msgs, new Set(["m1"]), { bearer: "Peer/dev" });
  assert.deepEqual(first.horizon.lastOwn, { id: "m1", cursor: "1", ts: msgs[0].ts }, "an own post at index 0 is a last own post, not none");
});

test("foldRoom: a trailer naming the same post twice retracts it once and answers it once (survivor 207: && -> ||)", () => {
  const msgs = [
    msg("m1", "settled\n\nverdict: pass\nexhibit: run 1\n\n-- Alice/watch"),
    msg("m2", "ask\n\nto: Alice/watch\n\n-- Peer/dev", { who: "peer" }),
    msg("m3", "taking it back, twice named\n\nwithdraws: m1, m1\nre: m2, m2\n\n-- Alice/watch"),
  ];
  const c = foldRoom(msgs, new Set(["m1", "m3"]), { bearer: "Alice/watch" });
  assert.deepEqual(c.superseded.map((v) => v.id), ["m1"], "one supersession for one post, however many times the trailer names it");
  assert.deepEqual(c.verdicts, []);
  assert.deepEqual(c.owed, [], "m2 is answered by name");
});

// Equivalent mutants from the same sweep, left green on purpose (16 of the 26 survivors):
//   carry.mjs:60 and :185 (a sort comparator's -1/1/0 magnitudes and its < vs <=) -- a comparator is
//     read by sign only, and the keys it compares are unique, so no order changes;
//   carry.mjs:175 (< and > inside an inline JSDoc type) -- comment text, no behaviour;
//   carry.mjs:207 (id && !includes -> ||) -- an empty or repeated id names no fact and retracts
//     nothing, so the fold is unchanged (the pin above shows the once-only outcome either way);
//   carry.mjs:294 (lastOwn = -1 -> -2) -- only compared with >= 0, and every index is >= 0;
//   carry.mjs:342 (fact id + 1 -> + 2) -- fact ids are only compared with each other, so a uniform
//     shift changes no standing;
//   carry.mjs:377 (> -> >=, -1 -> -2) -- an own post at index i is skipped before the comparison
//     by posted.has, so spokeIn can never equal i, and -2 < 0 as -1 is.
