// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { codexPrompt, codexThread, queueCodex } from "../src/codex.mjs";

const message = /** @type {import('../src/core.mjs').Message} */ ({
  id: "m1",
  cursor: "1788475881.165359",
  ts: "2026-09-03T22:51:21Z",
  author: { id: "U1", name: "Alex", kind: "human" },
  text: "please inspect this\n\n-- to: Codex/general",
});

test("Codex task identity prefers CODEX_THREAD_ID and falls back to CODEX_SESSION_ID", () => {
  assert.equal(codexThread({ CODEX_THREAD_ID: "thread", CODEX_SESSION_ID: "session" }), "thread");
  assert.equal(codexThread({ CODEX_SESSION_ID: "session" }), "session");
  assert.equal(codexThread({}), undefined);
});

test("Codex prompt preserves the original delivery with a compact origin envelope", () => {
  const prompt = codexPrompt("example-room", message);
  assert.match(prompt, /^\[Agora delivery; room example-room; cursor 1788475881\.165359; from Alex\]/);
  assert.ok(prompt.endsWith(message.text));
});

test("Codex queue sends each delivery in order to the current Desktop task", async () => {
  /** @type {Array<{ file: string, args: string[] }>} */
  const calls = [];
  const second = { ...message, id: "m2", cursor: "2", text: "next", signedAs: "Grace/review" };
  await queueCodex("example-room", [message, second], {
    env: { CODEX_THREAD_ID: "task-123" },
    run: /** @type {any} */ (async (/** @type {string} */ file, /** @type {string[]} */ args) => {
      calls.push({ file, args });
      return { stdout: "", stderr: "" };
    }),
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args.slice(0, 4), ["queue", "--thread", "task-123", "--message"]);
  assert.equal(calls[0].file, "codex");
  assert.match(calls[1].args[4], /from Grace\/review/);
});

test("Codex queue fails before consuming a delivery when no Desktop task id exists", async () => {
  await assert.rejects(() => queueCodex("example-room", [message], { env: {} }), /CODEX_THREAD_ID or CODEX_SESSION_ID/);
});
