// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { queueCodex } from "../src/codex.mjs";
import { readCursor } from "../src/core.mjs";
import { watch } from "../src/watch.mjs";
import { departureLine, departuresLine } from "../src/session.mjs";
import { tmp } from "./helpers.mjs";

const run = promisify(execFile);
const msgs = [1, 2, 3, 4].map((n) => ({
  id: String(n), cursor: String(n), room: "fixture", thread: n % 2 === 0 ? "T" : undefined,
  text: `body ${n}`, ts: `2026-09-04T00:00:0${n}.000Z`,
  author: /** @type {import('../src/core.mjs').Actor & { id: string }} */ ({ id: "peer", name: "peer", kind: "agent" }),
}));
const room = /** @type {import('../src/core.mjs').Transport} */ ({
  kind: "local", room: "fixture", threads: true,
  read: async ({ thread, since } = {}) => msgs.filter((m) => m.thread === thread && Number(m.cursor) > Number(since ?? 0)),
  post: async () => { throw new Error("read-only fixture"); },
  whoami: async () => ({ id: "reader", name: "reader" }),
});
const failed = () => Object.assign(new Error("private argv body and token must never reach retry logs"), { code: 1 });
const thread = "fixture-thread";
const base = { bin: process.execPath, thread, env: {}, sleep: async () => {} };
/** @param {string} state */
const follows = (state) => ({ ids: () => ["T"], key: () => "r#T", cursor: () => readCursor(state, "r#T"), interval: 1 });

for (const coalesceSeconds of [0, 20]) {
  test(`Codex retry recovers the failed suffix in the same watch (coalesce ${coalesceSeconds})`, async () => {
    const { dir, cleanup } = await tmp();
    /** @type {string[]} */
    const calls = [];
    /** @type {number[]} */
    const delays = [];
    let rejected = false;
    try {
      const result = await watch(room, {
        stateDir: dir, key: "r", mode: "once", threads: follows(dir), coalesceSeconds,
        onBatch: async (messages, batch) => queueCodex("r", messages, {
          ...base,
          sleep: async (ms) => { delays.push(ms); },
          run: /** @type {any} */ (async (/** @type {string} */ _bin, /** @type {string[]} */ args) => {
            const id = /cursor (\d+)/.exec(args[4])?.[1] ?? "";
            calls.push(id);
            if (id === "2" && !rejected) { rejected = true; throw failed(); }
          }),
          onRetry: () => {},
          onQueued: async ({ message }) => { await batch.checkpoint(message); },
        }),
      });
      assert.equal(result.delivered, 4);
      assert.deepEqual(calls, ["1", "2", "2", "3", "4"]);
      assert.deepEqual(delays, [1000]);
      assert.equal(await readCursor(dir, "r"), "3");
      assert.equal(await readCursor(dir, "r#T"), "4");
    } finally { await cleanup(); }
  });
}

test("Codex exhausted retries preserve the accepted room prefix and replay the thread/suffix after restart", async () => {
  const { dir, cleanup } = await tmp();
  /** @type {string[]} */
  const calls = [];
  /** @type {number[]} */
  const delays = [];
  try {
    await assert.rejects(() => watch(room, {
      stateDir: dir, key: "r", mode: "once", threads: follows(dir), coalesceSeconds: 20,
      onBatch: async (messages, batch) => queueCodex("r", messages, {
        ...base, sleep: async (ms) => { delays.push(ms); }, onRetry: () => {},
        run: /** @type {any} */ (async (/** @type {string} */ _bin, /** @type {string[]} */ args) => {
          const id = /cursor (\d+)/.exec(args[4])?.[1] ?? "";
          calls.push(id);
          if (id === "2") throw failed();
        }),
        onQueued: async ({ message }) => { await batch.checkpoint(message); },
      }),
    }), (error) => {
      assert.match(String(error), /r\/2.*after 3 attempt.*acceptance unknown.*cursor not acknowledged/);
      assert.doesNotMatch(String(error), /private argv|token/);
      return true;
    });
    assert.deepEqual(calls, ["1", "2", "2", "2"]);
    assert.deepEqual(delays, [1000, 2000]);
    assert.equal(await readCursor(dir, "r"), "1");
    assert.equal(await readCursor(dir, "r#T"), undefined);
    calls.length = 0;
    await watch(room, {
      stateDir: dir, key: "r", mode: "once", threads: follows(dir),
      onBatch: async (messages, batch) => queueCodex("r", messages, {
        ...base,
        run: /** @type {any} */ (async (/** @type {string} */ _bin, /** @type {string[]} */ args) => { calls.push(/cursor (\d+)/.exec(args[4])?.[1] ?? ""); }),
        onQueued: async ({ message }) => { await batch.checkpoint(message); },
      }),
    });
    assert.deepEqual(calls, ["2", "3", "4"]);
    assert.equal(await readCursor(dir, "r"), "3");
    assert.equal(await readCursor(dir, "r#T"), "4");
  } finally { await cleanup(); }
});

test("a failed acceptance checkpoint never retries an already accepted queue call", async () => {
  let calls = 0;
  await assert.rejects(() => queueCodex("r", msgs, {
    ...base, run: /** @type {any} */ (async () => { calls++; }),
    onQueued: () => { throw new Error("checkpoint disk failure"); },
  }), /checkpoint disk failure/);
  assert.equal(calls, 1);
});

for (const cancel of [false, true]) {
  test(`a ${cancel ? "cancelled" : "hung"} real subprocess is killed without acknowledgement`, { timeout: 15000 }, async () => {
    let acknowledged = 0;
    let started = 0;
    const controller = new AbortController();
    await assert.rejects(() => queueCodex("r", [msgs[0]], {
      ...base, timeoutMs: cancel ? 5000 : 100, attempts: 1, signal: controller.signal,
      run: /** @type {any} */ (async (/** @type {string} */ _bin, /** @type {string[]} */ _args, /** @type {import('node:child_process').ExecFileOptionsWithStringEncoding} */ options) => {
        started++;
        // Use Node, never a real Codex session or its database, for the hung-child fixture.
        const pending = run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options);
        if (cancel) controller.abort();
        return pending;
      }),
      onQueued: () => { acknowledged++; },
    }), cancel ? /cancelled/ : /terminated.*timeout 100ms/);
    assert.equal(started, 1);
    assert.equal(acknowledged, 0);
  });
}

test("cancellation during retry backoff stops without a second attempt", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(() => queueCodex("r", [msgs[0]], {
    bin: process.execPath, thread, env: {}, signal: controller.signal,
    run: /** @type {any} */ (async () => { calls++; throw failed(); }),
    onRetry: () => { controller.abort(); },
  }), /retry cancelled/);
  assert.equal(calls, 1);
});

test("a dead supervisor notice does not pronounce its bearer or conversation departed", () => {
  const rec = /** @type {import('../src/session.mjs').SessionRecord} */ ({
    bearer: "Codex/worker", lastSeen: "2026-09-04T00:00:00Z", pidSource: "AGORA_SESSION_PID",
  });
  const one = departureLine(rec, ["peer"]);
  assert.match(one, /recorded delivery\/session process is no longer running/);
  assert.match(one, /Conversation liveness is unknown/);
  assert.doesNotMatch(one, /Requests addressed to it will not be answered/);
  const mixed = departuresLine([rec, { ...rec, bearer: "Other", pidSource: "CLAUDE_PID" }], []);
  assert.match(mixed, /Supervisor-based records do not establish conversation departure/);
  assert.doesNotMatch(mixed, /will not be answered/);
});
