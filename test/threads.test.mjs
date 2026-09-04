import assert from "node:assert/strict";
import test from "node:test";
import { mergeAscending, threadRoots, withThreads } from "../src/threads.mjs";

/** @param {Partial<import('../src/core.mjs').Message> & { id: string }} m @returns {import('../src/core.mjs').Message} */
const msg = (m) => ({
  room: "r",
  author: { id: "u", name: "u", kind: /** @type {const} */ ("agent") },
  text: "",
  ts: new Date(Number(m.id) * 1000).toISOString(),
  cursor: m.id,
  ...m,
});

test("threadRoots: Slack parents with replies after the cursor, replies naming their thread, nothing else", () => {
  const msgs = [
    msg({ id: "100", raw: { reply_count: 2, latest_reply: "150" } }), // moved after the cursor
    msg({ id: "110", raw: { reply_count: 1, latest_reply: "115" } }), // its reply is before the cursor
    msg({ id: "120", raw: {} }), // no thread
    msg({ id: "130", thread: "105" }), // a reply seen in the room (local transport, or a broadcast)
    msg({ id: "140", raw: { reply_count: 3 } }), // no latest_reply to check: kept, the thread read applies the cursor
  ];
  assert.deepEqual(threadRoots(msgs, "125"), ["100", "105", "140"]);
  assert.deepEqual(threadRoots(msgs), ["100", "110", "105", "140"], "with no cursor every thread that has replies is a root");
  assert.deepEqual(threadRoots([msg({ id: "1", thread: "1" })]), [], "a parent whose thread field names itself is not a reply");
});

test("mergeAscending: by time, then id, one copy per id", () => {
  const a = [msg({ id: "300" }), msg({ id: "100" })];
  const b = [msg({ id: "200" }), msg({ id: "100", text: "dup" })];
  const out = mergeAscending(a, b);
  assert.deepEqual(out.map((m) => m.id), ["100", "200", "300"]);
  assert.equal(out[0].text, "", "the first copy seen wins");
});

test("withThreads: reads each root after the cursor and folds the replies in by time", async () => {
  /** @type {import('../src/core.mjs').ReadOptions[]} */
  const calls = [];
  const transport = {
    /** @param {import('../src/core.mjs').ReadOptions} o */
    async read(o) {
      calls.push(o);
      if (o.thread === "100") return [msg({ id: "150", thread: "100", text: "claim in a thread" })];
      if (o.thread === "140") return [];
      throw new Error(`unexpected thread ${o.thread}`);
    },
  };
  const room = [msg({ id: "160", text: "a top-level line after the cursor" })];
  const horizon = [
    msg({ id: "100", raw: { reply_count: 1, latest_reply: "150" } }),
    msg({ id: "110", raw: { reply_count: 1, latest_reply: "115" } }),
    msg({ id: "140", raw: { reply_count: 1 } }),
    ...room,
  ];
  const r = await withThreads(transport, room, horizon, { since: "125" });
  assert.deepEqual(r.threads, ["100", "140"]);
  assert.deepEqual(calls, [{ thread: "100", since: "125" }, { thread: "140", since: "125" }]);
  assert.deepEqual(r.messages.map((m) => m.id), ["150", "160"], "the thread reply lands before the later top-level line");
  const capped = await withThreads({ async read() { return []; } }, [], horizon, { since: "125", cap: 1 });
  assert.deepEqual(capped.threads, ["140"], "the cap keeps the most recently rooted threads");
});
