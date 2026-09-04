// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { codexPrompt, codexThread, queueCodex } from "../src/codex.mjs";

const message = /** @type {import('../src/core.mjs').Message} */ ({
  id: "m1",
  cursor: "1788475881.165359",
  ts: "2026-09-03T22:51:21Z",
  author: { id: "U1", name: "Alex", kind: "human" },
  text: "please inspect this\n\n-- to: Codex-Sol/general",
});

test("Codex task identity prefers CODEX_THREAD_ID and falls back to CODEX_SESSION_ID", () => {
  assert.equal(codexThread({ CODEX_THREAD_ID: "thread", CODEX_SESSION_ID: "session" }), "thread");
  assert.equal(codexThread({ CODEX_SESSION_ID: "session" }), "session");
  assert.equal(codexThread({}), undefined);
});

test("Codex prompt preserves the original delivery with a compact origin envelope", () => {
  const prompt = codexPrompt("slopcannon", message);
  assert.match(prompt, /^\[Agora delivery; room slopcannon; cursor 1788475881\.165359; from Alex\]/);
  assert.match(prompt, /Codex no-op policy:[^\n]+<!-- agora:no-maintenance -->/);
  assert.ok(prompt.endsWith(message.text));
});

test("Codex queue sends each delivery in order to the current Desktop task", async () => {
  /** @type {Array<{ file: string, args: string[] }>} */
  const calls = [];
  const second = { ...message, id: "m2", cursor: "2", text: "next", signedAs: "Fable/review" };
  await queueCodex("slopcannon", [message, second], {
    env: { CODEX_THREAD_ID: "task-123" },
    run: /** @type {any} */ (async (/** @type {string} */ file, /** @type {string[]} */ args) => {
      calls.push({ file, args });
      return { stdout: "", stderr: "" };
    }),
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args.slice(0, 4), ["queue", "--thread", "task-123", "--message"]);
  assert.equal(calls[0].file, "codex");
  assert.match(calls[1].args[4], /from Fable\/review/);
});

test("Codex queue serializes a burst instead of starting later deliveries concurrently", async () => {
  /** @type {() => void} */
  let releaseFirst = () => {};
  /** @type {Promise<void>} */
  const firstHeld = new Promise((resolve) => { releaseFirst = () => resolve(); });
  /** @type {string[]} */
  const started = [];
  const second = { ...message, id: "m2", cursor: "2", text: "next" };
  const queued = queueCodex("slopcannon", [message, second], {
    env: { CODEX_THREAD_ID: "task-123" },
    run: /** @type {any} */ (async (/** @type {string} */ _file, /** @type {string[]} */ args) => {
      started.push(args[4]);
      if (started.length === 1) await firstHeld;
      return { stdout: "", stderr: "" };
    }),
  });
  assert.equal(started.length, 1, "the second delivery waits for the first queue call");
  releaseFirst();
  await queued;
  assert.equal(started.length, 2);
  assert.match(started[0], /cursor 1788475881\.165359/);
  assert.match(started[1], /cursor 2/);
});

test("Codex queue fails before consuming a delivery when no Desktop task id exists", async () => {
  await assert.rejects(() => queueCodex("slopcannon", [message], { env: {} }), /CODEX_THREAD_ID or CODEX_SESSION_ID/);
});
