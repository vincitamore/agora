// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { codexPrompt, codexSpawnWarning, codexThread, queueCodex, resolveCodexBinary } from "../src/codex.mjs";

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

test("Codex warns only when the current thread differs from the stable seat session", () => {
  assert.equal(codexSpawnWarning({ CODEX_THREAD_ID: "root", CODEX_SESSION_ID: "root" }), undefined);
  assert.equal(codexSpawnWarning({ CODEX_THREAD_ID: "child", CODEX_SESSION_ID: "root" })?.includes("spawned Codex thread"), true);
});

test("Codex prompt preserves the original delivery with a compact origin envelope", () => {
  const prompt = codexPrompt("example-room", message);
  assert.match(prompt, /^\[Agora delivery; room example-room; cursor 1788475881\.165359; from Alex\]/);
  assert.match(prompt, /Codex no-op policy:[^\n]+<!-- agora:no-maintenance -->/);
  assert.ok(prompt.endsWith(message.text));
});

test("Codex binary honors the explicit environment override", async () => {
  const expected = path.resolve("fixture", "codex.exe");
  assert.equal(await resolveCodexBinary({
    env: { AGORA_CODEX_BIN: expected },
    exists: (file) => file === expected,
  }), expected);
});

test("Codex binary resolves the native executable reported by doctor behind an npm shim", async () => {
  const root = path.resolve("fixture", "nodejs");
  const node = path.join(root, "node.exe");
  const cli = path.join(root, "node_modules", "@openai", "codex", "bin", "codex.js");
  const native = path.resolve("fixture", "vendor", "codex.exe");
  assert.equal(await resolveCodexBinary({
    platform: "win32",
    env: { PATH: root },
    exists: (file) => [node, cli, native].includes(file),
    run: /** @type {any} */ (async (/** @type {string} */ file, /** @type {string[]} */ args) => {
      if (file === "where.exe") throw new Error("not found");
      assert.equal(file, node);
      assert.deepEqual(args, [cli, "doctor", "--json"]);
      return { stdout: JSON.stringify({ checks: { "runtime.provenance": { details: { "current executable": native } } } }), stderr: "" };
    }),
  }), native);
});

test("Codex queue sends each delivery in order to the current task", async () => {
  /** @type {Array<{ file: string, args: string[] }>} */
  const calls = [];
  const second = { ...message, id: "m2", cursor: "2", text: "next", signedAs: "Grace/review" };
  await queueCodex("example-room", [message, second], {
    env: { CODEX_THREAD_ID: "task-123" },
    bin: process.execPath,
    run: /** @type {any} */ (async (/** @type {string} */ file, /** @type {string[]} */ args) => {
      calls.push({ file, args });
      return { stdout: "", stderr: "" };
    }),
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args.slice(0, 4), ["queue", "--thread", "task-123", "--message"]);
  assert.equal(calls[0].file, process.execPath);
  assert.match(calls[1].args[4], /from Grace\/review/);
});

test("Codex queue serializes a burst instead of starting later deliveries concurrently", async () => {
  /** @type {() => void} */
  let releaseFirst = () => {};
  /** @type {Promise<void>} */
  const firstHeld = new Promise((resolve) => { releaseFirst = () => resolve(); });
  /** @type {string[]} */
  const started = [];
  const second = { ...message, id: "m2", cursor: "2", text: "next" };
  const queued = queueCodex("example-room", [message, second], {
    env: { CODEX_THREAD_ID: "task-123" },
    bin: process.execPath,
    run: /** @type {any} */ (async (/** @type {string} */ _file, /** @type {string[]} */ args) => {
      started.push(args[4]);
      if (started.length === 1) await firstHeld;
      return { stdout: "", stderr: "" };
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started.length, 1, "the second delivery waits for the first queue call");
  releaseFirst();
  await queued;
  assert.equal(started.length, 2);
  assert.match(started[0], /cursor 1788475881\.165359/);
  assert.match(started[1], /cursor 2/);
});

test("Codex queue fails before consuming a delivery when no task id exists", async () => {
  await assert.rejects(() => queueCodex("example-room", [message], { env: {} }), /CODEX_THREAD_ID.*CODEX_SESSION_ID/);
});

test("Codex queue keeps peer-authored shell metacharacters in one argv value", async () => {
  const text = 'literal & | " %VAR% stays data';
  /** @type {any[]} */
  const calls = [];
  await queueCodex("example-room", [{ ...message, text }], {
    env: { CODEX_SESSION_ID: "task-123" },
    bin: process.execPath,
    run: /** @type {any} */ (async (/** @type {string} */ file, /** @type {string[]} */ args, /** @type {Record<string, unknown>} */ options) => {
      calls.push({ file, args, options });
      return { stdout: "", stderr: "" };
    }),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[4].endsWith(text), true);
  assert.equal(calls[0].options.shell, undefined);
});
