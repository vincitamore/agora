// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { localTransport } from "../src/transports/local.mjs";
import { watch } from "../src/watch.mjs";
import { readCursor } from "../src/core.mjs";
import { actor, tmp } from "./helpers.mjs";

test("watch once: nothing, then something, then nothing again; cursor persists", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const t = localTransport({ transport: "local", path: path.join(dir, "r.ndjson") }, { actor });
    const state = path.join(dir, "state");
    /** @type {string[][]} */
    const batches = [];
    const onBatch = (/** @type {import('../src/core.mjs').Message[]} */ m) => { batches.push(m.map((x) => x.text)); };

    let r = await watch(t, { stateDir: state, key: "r", mode: "once", onBatch });
    assert.equal(r.fired, false);
    await t.post("one");
    await t.post("two");
    r = await watch(t, { stateDir: state, key: "r", mode: "once", onBatch });
    assert.equal(r.fired, true);
    assert.deepEqual(batches, [["one", "two"]]);
    assert.equal(await readCursor(state, "r"), "2");
    r = await watch(t, { stateDir: state, key: "r", mode: "once", onBatch });
    assert.equal(r.fired, false);
    assert.equal(batches.length, 1, "nothing re-delivered");
  } finally {
    await cleanup();
  }
});

test("watch until-new polls, sleeps, fires on arrival", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const t = localTransport({ transport: "local", path: path.join(dir, "r.ndjson") }, { actor });
    /** @type {number[]} */
    const slept = [];
    let posted = false;
    const r = await watch(t, {
      stateDir: path.join(dir, "s"), key: "r", interval: 7,
      onBatch: () => {},
      sleep: async (ms) => { slept.push(ms); if (!posted) { posted = true; await t.post("arrived"); } },
    });
    assert.equal(r.fired, true);
    assert.equal(r.polls, 2);
    assert.deepEqual(slept, [7000]);
  } finally {
    await cleanup();
  }
});

test("watch gives up after --for, and stream keeps delivering", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const t = localTransport({ transport: "local", path: path.join(dir, "r.ndjson") }, { actor });
    let clock = 0;
    const r = await watch(t, {
      stateDir: path.join(dir, "s"), key: "r", interval: 5, forSeconds: 12,
      onBatch: () => {}, now: () => clock, sleep: async (ms) => { clock += ms; },
    });
    assert.equal(r.fired, false);
    assert.equal(r.polls, 3);

    clock = 0;
    let n = 0;
    /** @type {string[]} */
    const seen = [];
    const s = await watch(t, {
      stateDir: path.join(dir, "s2"), key: "r", mode: "stream", interval: 5, forSeconds: 12,
      onBatch: (m) => { seen.push(...m.map((x) => x.text)); }, now: () => clock,
      sleep: async (ms) => { clock += ms; await t.post(`m${++n}`); },
    });
    assert.equal(s.fired, true);
    assert.deepEqual(seen, ["m1", "m2"]);
  } finally {
    await cleanup();
  }
});
