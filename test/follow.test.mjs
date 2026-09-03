// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { followThreads, readFollow, threadsOf } from "../src/follow.mjs";
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
