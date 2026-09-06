// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { codexServerURL, codexServerBatches, deliverCodexServer } from "../src/codex-server.mjs";

const thread = "fixture-thread-1234";
/** @param {number} id @param {string} [text] */
const message = (id, text = `original ${id}\nunchanged`) => /** @type {import('../src/core.mjs').Message} */ ({
  id: `message-${id}`, cursor: `epoch:${id}`, text, ts: "2026-01-01T00:00:00Z", author: { id: "sender", name: "Sender", kind: "human" },
});
/** @param {import('node:test').TestContext} t @param {(request:any)=>any} respond */
async function fixture(t, respond) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agora-codex-server-"));
  const tokenFile = path.join(dir, "capability");
  await writeFile(tokenFile, "fixture-secret\n");
  t.after(() => rm(dir, { recursive: true, force: true }));
  /** @type {any[]} */ const requests = [];
  let closed = false;
  class Socket extends EventTarget {
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
    /** @param {string} raw */
    send(raw) {
      const request = JSON.parse(raw); requests.push(request);
      if (request.id === undefined) return;
      const response = respond(request);
      if (response === undefined) return; // Intentionally missing acknowledgment.
      queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id: request.id, ...response }) })));
    }
    close() { closed = true; this.dispatchEvent(new Event("close")); }
  }
  return {
    options: { endpoint: "ws://127.0.0.1:9999", tokenFile, thread, timeoutMs: 50,
      socket: /** @type {import('../src/codex-server.mjs').SocketFactory} */ ((url, options) => {
        assert.equal(url, "ws://127.0.0.1:9999/");
        assert.deepEqual(options.headers, { Authorization: "Bearer fixture-secret" });
        return /** @type {any} */ (new Socket());
      }) }, requests, isClosed: () => closed,
  };
}
/** @param {any} request @param {string} [status] */
function responds(request, status = "idle") {
  if (request.method === "initialize") return { result: {} };
  if (request.method === "thread/read") return { result: { thread: { id: thread, status: { type: status } } } };
  return { result: { turn: { id: "native-turn" } } };
}

test("native endpoint is authenticated literal loopback, never a URL carrying a secret", () => {
  for (const url of ["ws://example.com", "ws://localhost", "ws://127.0.0.1?token=x", "ws://user:secret@127.0.0.1", "http://127.0.0.1", "ws://127.0.0.1/path"])
    assert.throws(() => codexServerURL(url), /loopback/);
  assert.equal(codexServerURL("ws://[::1]:1234"), "ws://[::1]:1234/");
});

for (const status of ["idle", "active"]) test(`one bounded native submission for ${status}, unchanged settings and ordered checkpoints`, async (t) => {
  const f = await fixture(t, (request) => responds(request, status));
  /** @type {string[]} */ const checkpoints = [];
  await deliverCodexServer("room", [message(1), message(2)], { ...f.options, onAccepted: async (m) => { checkpoints.push(m.id); } });
  assert.deepEqual(f.requests.map(r => r.method), ["initialize", "initialized", "thread/read", "turn/start"]);
  const params = f.requests.at(-1).params;
  assert.deepEqual(Object.keys(params).sort(), ["clientUserMessageId", "input", "threadId"]);
  assert.equal(params.threadId, thread);
  for (const m of [message(1), message(2)]) { assert.ok(params.input[0].text.includes(m.text)); assert.ok(params.input[0].text.includes(m.id)); assert.ok(params.input[0].text.includes(m.cursor)); }
  assert.deepEqual(checkpoints, ["message-1", "message-2"]);
  assert.ok(f.isClosed());
});

test("unloaded target is refused without cold resume, queue fallback or turn creation", async (t) => {
  const f = await fixture(t, request => responds(request, "notLoaded"));
  await assert.rejects(deliverCodexServer("room", [message(1)], f.options), /attach the retained TUI/);
  assert.ok(!f.requests.some(r => r.method === "turn/start")); assert.ok(f.isClosed());
});

test("acknowledgment timeout sends once, checkpoints nothing and exposes no token or text", async (t) => {
  const f = await fixture(t, request => request.method === "turn/start" ? undefined : responds(request));
  let checkpoints = 0;
  await assert.rejects(deliverCodexServer("room", [message(1, "private body")], { ...f.options, onAccepted: async () => { checkpoints++; } }), error => {
    assert.match(String(error), /do not blindly replay/); assert.doesNotMatch(String(error), /fixture-secret|private body/); return true;
  });
  assert.equal(checkpoints, 0); assert.equal(f.requests.filter(r => r.method === "turn/start").length, 1); assert.ok(f.isClosed());
});

test("native rejection keeps raw response private and does not advance cursors", async (t) => {
  const f = await fixture(t, request => request.method === "turn/start" ? { error: { code: -32600, message: "private provider body" } } : responds(request));
  await assert.rejects(deliverCodexServer("room", [message(1)], { ...f.options, onAccepted: async () => assert.fail("checkpoint before acceptance") }), error => {
    assert.match(String(error), /RPC -32600/); assert.doesNotMatch(String(error), /private provider body/); return true;
  });
});

test("batch limits preserve all originals and reject oversized input before any connection", async () => {
  const input = Array.from({ length: 70 }, (_, i) => message(i));
  const batches = codexServerBatches("room", input);
  assert.deepEqual(batches.map(b => b.messages.length), [32, 32, 6]);
  assert.deepEqual(batches.flatMap(b => b.messages), input);
  await assert.rejects(deliverCodexServer("room", [message(1), message(2, "x".repeat(65536))], {
    endpoint: "ws://127.0.0.1:1", tokenFile: path.resolve("absent"), thread,
    socket: () => { throw new Error("must not connect"); },
  }), /exceeds 64 KiB/);
});

test("accepted prefix checkpoints before later native refusal", async (t) => {
  let submissions = 0;
  const f = await fixture(t, request => {
    if (request.method === "turn/start" && ++submissions === 2) return { error: { code: -32600 } };
    return responds(request);
  });
  /** @type {string[]} */ const accepted = [];
  const input = Array.from({ length: 33 }, (_, i) => message(i));
  await assert.rejects(deliverCodexServer("room", input, { ...f.options, onAccepted: async m => { accepted.push(m.id); } }));
  assert.deepEqual(accepted, input.slice(0,32).map(m => m.id));
});
