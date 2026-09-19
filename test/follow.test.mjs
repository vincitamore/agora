// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { aliasThreads, dropFollow, followableMessages, followThreads, readFollow, rootOf, rootsOf, threadsOf } from "../src/follow.mjs";
import { tmp } from "./helpers.mjs";

/** @param {string} id @param {string} [thread] @returns {import('../src/core.mjs').Message} */
const msg = (id, thread) => ({
  id,
  room: "r",
  thread,
  author: { id: "u", name: "u", kind: "agent" },
  text: id,
  ts: "2026-09-03T00:00:00.000Z",
  cursor: id,
});

test("a thread joins the set when this session posts into it, and when a delivered message carries it", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const posted = await followThreads(dir, "down", ["T1"]);
    assert.deepEqual(posted.threads, ["T1"]);
    assert.deepEqual(posted.added, ["T1"]);

    // the other door: the threads a delivered batch came from
    const ids = threadsOf([msg("a", "T2"), msg("b"), msg("c", "T2"), msg("d", "T3")]);
    assert.deepEqual(ids, ["T2", "T3"], "each thread once, in the order it arrived; the room message carries none");
    const delivered = await followThreads(dir, "down", ids);
    assert.deepEqual(delivered.threads.sort(), ["T1", "T2", "T3"]);
    assert.deepEqual(Object.keys((await readFollow(dir, "down")).threads).sort(), ["T1", "T2", "T3"], "the set is on disk, not in a process");
    assert.equal(path.basename(path.dirname(path.join(dir, "follow", "down.json"))), "follow");

    const again = await followThreads(dir, "down", []);
    assert.deepEqual(again.added, [], "reading the set forward adds nothing");
    assert.equal(again.threads.length, 3);
  } finally {
    await cleanup();
  }
});

test("a thread with no activity for the idle window leaves the set; activity keeps it", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const t0 = new Date("2026-09-03T09:00:00.000Z");
    await followThreads(dir, "down", ["old", "kept"], { now: t0 });
    const later = new Date(t0.getTime() + 90 * 60_000);
    const r = await followThreads(dir, "down", ["kept"], { idleMinutes: 60, now: later });
    assert.deepEqual(r.expired, ["old"]);
    assert.deepEqual(r.threads, ["kept"]);
    // a thread that is being polled but is silent still ages out: reading is not activity
    const muchLater = new Date(later.getTime() + 90 * 60_000);
    const r2 = await followThreads(dir, "down", [], { idleMinutes: 60, now: muchLater });
    assert.deepEqual(r2.expired, ["kept"]);
    assert.deepEqual(r2.threads, []);
  } finally {
    await cleanup();
  }
});

test("the set is capped, and the thread with the oldest activity is the one evicted", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const t0 = new Date("2026-09-03T09:00:00.000Z");
    for (let i = 0; i < 3; i++) await followThreads(dir, "down", [`T${i}`], { cap: 3, now: new Date(t0.getTime() + i * 1000) });
    // T0 is the oldest, but talking in it again makes it the newest
    await followThreads(dir, "down", ["T0"], { cap: 3, now: new Date(t0.getTime() + 4000) });
    const r = await followThreads(dir, "down", ["T3"], { cap: 3, now: new Date(t0.getTime() + 5000) });
    assert.deepEqual(r.evicted, ["T1"], "the least recently active leaves, and the caller says so");
    assert.deepEqual(r.threads, ["T2", "T0", "T3"], "oldest activity first");

    const two = await followThreads(dir, "down", ["T4", "T5"], { cap: 3, now: new Date(t0.getTime() + 6000) });
    assert.deepEqual(two.evicted, ["T2", "T0"], "a cap breached by two evicts two");
    assert.deepEqual(two.threads, ["T3", "T4", "T5"]);
  } finally {
    await cleanup();
  }
});

test("dropFollow removes one thread so a 404 follow does not rejoin on the next poll", async () => {
  const { dir, cleanup } = await tmp();
  try {
    await followThreads(dir, "down", ["keep", "1788459640.1197"]);
    assert.equal(await dropFollow(dir, "down", "1788459640.1197"), true);
    assert.deepEqual(Object.keys((await readFollow(dir, "down")).threads), ["keep"]);
    assert.equal(await dropFollow(dir, "down", "missing"), false);
  } finally {
    await cleanup();
  }
});

test("rootsOf names the thread a reply is in and the thread a top-level message would root", () => {
  /** @param {string} id @param {string} [thread] */
  const msg = (id, thread) => /** @type {import("../src/core.mjs").Message} */ ({ id, room: "r", author: { id: "x", name: "x", kind: "agent" }, text: "", ts: "", cursor: id, ...(thread ? { thread } : {}) });
  assert.deepEqual(rootsOf([msg("a", "T2"), msg("b"), msg("c", "T2"), msg("d", "T3")]), ["T2", "b", "T3"]);
  assert.deepEqual(rootsOf([]), []);
});

test("follow admission keeps human deliveries and agent traffic addressed to this bearer, model, seat or everyone", () => {
  /** @param {string} id @param {"human" | "agent" | "system"} kind @param {string} [to] */
  const delivery = (id, kind, to) => /** @type {import("../src/core.mjs").Message} */ ({
    id,
    room: "r",
    author: { id: `u-${id}`, name: id, kind },
    text: to ? `${id}\n\nto: ${to}` : id,
    ts: "",
    cursor: id,
  });
  const msgs = [
    delivery("human-elsewhere", "human", "Other/model"),
    delivery("unaddressed-agent", "agent"),
    delivery("other-agent", "agent", "Other/model"),
    delivery("model", "agent", "Sol"),
    delivery("bearer", "agent", "Cal/codex"),
    delivery("seat-name", "agent", "socius_amore"),
    delivery("seat-mention", "agent", "<@USEAT>"),
    delivery("everyone", "system", "*"),
    delivery("unaddressed-system", "system"),
  ];
  assert.deepEqual(
    followableMessages(msgs, "Cal/codex", { id: "USEAT", name: "socius_amore" }).map((m) => m.id),
    ["human-elsewhere", "model", "bearer", "seat-name", "seat-mention", "everyone"],
  );
});

test("admission gates new roots without letting an active followed conversation age out", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const t0 = new Date("2026-09-03T09:00:00.000Z");
    await followThreads(dir, "down", ["existing"], { now: t0 });
    const active = new Date(t0.getTime() + 50 * 60_000);
    const r = await followThreads(dir, "down", ["existing", "broadcast"], { admit: [], idleMinutes: 60, now: active });
    assert.deepEqual(r.threads, ["existing"], "an unaddressed broadcast spends no new follow slot");
    assert.deepEqual(r.added, []);

    const later = new Date(t0.getTime() + 100 * 60_000);
    const kept = await followThreads(dir, "down", [], { idleMinutes: 60, now: later });
    assert.deepEqual(kept.threads, ["existing"], "activity refreshed the existing conversation despite admission being closed");

    const admitted = await followThreads(dir, "down", ["addressed"], { admit: ["addressed"], now: later });
    assert.deepEqual(admitted.added, ["addressed"]);
  } finally {
    await cleanup();
  }
});

test("the cap keeps the threads the answers arrive in: this session's own roots and what a human just replied in", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const t0 = new Date("2026-09-03T09:00:00.000Z");
    const at = (/** @type {number} */ n) => new Date(t0.getTime() + n * 1000);
    // MINE is the oldest by activity and would go first; it is the thread under this session's own
    // request, which is exactly where the operator answers
    await followThreads(dir, "down", ["MINE"], { cap: 2, now: at(0) });
    await followThreads(dir, "down", ["chatter"], { cap: 2, now: at(1) });
    const r = await followThreads(dir, "down", ["newest"], { cap: 2, now: at(2), protect: ["MINE"] });
    assert.deepEqual(r.evicted, ["chatter"], "a busy room's chatter is always more recent than the request still being answered");
    assert.deepEqual(r.protectedEvicted, []);
    assert.deepEqual(r.threads, ["MINE", "newest"]);

    // the cap still binds when everything left is protected; it just says which one it took
    const all = await followThreads(dir, "down", ["third"], { cap: 2, now: at(3), protect: ["MINE", "newest", "third"] });
    assert.deepEqual(all.evicted, ["MINE"]);
    assert.deepEqual(all.protectedEvicted, ["MINE"], "so the caller can say so out loud");
    assert.deepEqual(all.threads, ["newest", "third"]);
  } finally {
    await cleanup();
  }
});

test("the ids of one post the transport had to split are one followed conversation", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const t0 = new Date("2026-09-03T09:00:00.000Z");
    await followThreads(dir, "down", ["p1"], { cap: 2, now: t0 });
    // sender-side only: these are the ids this session's own post produced, from the post result,
    // never anything read off a delivered message
    await aliasThreads(dir, "down", "p1", ["p2", "p3"]);
    const set = await readFollow(dir, "down");
    assert.deepEqual(set.aliases, { p2: "p1", p3: "p1" });
    assert.equal(rootOf(set, "p2"), "p1");
    assert.equal(rootOf(set, "other"), "other");

    const r = await followThreads(dir, "down", [], { cap: 2, now: new Date(t0.getTime() + 1000) });
    assert.deepEqual(r.threads, ["p1", "p2", "p3"], "a reply under any chunk is read");
    assert.deepEqual(Object.keys((await readFollow(dir, "down")).threads), ["p1"], "and the chunks spend no slot of their own");

    // activity on a chunk is activity on the post
    await followThreads(dir, "down", ["later"], { cap: 2, now: new Date(t0.getTime() + 2000) });
    const moved = await followThreads(dir, "down", ["p3"], { cap: 2, now: new Date(t0.getTime() + 3000) });
    assert.deepEqual(moved.threads.slice(0, 2), ["later", "p1"], "the root moved off the eviction end, not a fourth entry");

    const out = await followThreads(dir, "down", ["fresh"], { cap: 1, now: new Date(t0.getTime() + 4000) });
    assert.deepEqual(out.evicted, ["later", "p1"]);
    assert.deepEqual(out.threads, ["fresh"], "the chunks leave with their root");
    assert.equal((await readFollow(dir, "down")).aliases, undefined);
  } finally {
    await cleanup();
  }
});
