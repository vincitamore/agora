// @ts-check
// The kit's service worker, run in a stand-in worker scope: a push shows its notification and is
// acknowledged as shown; a click focuses an open window and tells it the thread, or opens the
// thread's URL, and is acknowledged as clicked.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const SW = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "push", "sw.js");

/** @param {{ windows?: any[] }} [opts] */
async function worker(opts = {}) {
  /** @type {Record<string, Function>} */
  const handlers = {};
  /** @type {any[]} */
  const shown = [];
  /** @type {any[]} */
  const posts = [];
  /** @type {string[]} */
  const opened = [];
  const self = {
    location: { origin: "https://app.example" },
    addEventListener: (/** @type {string} */ name, /** @type {Function} */ fn) => { handlers[name] = fn; },
    registration: { showNotification: async (/** @type {string} */ title, /** @type {any} */ options) => { shown.push({ title, options }); } },
    clients: {
      matchAll: async () => opts.windows ?? [],
      openWindow: async (/** @type {string} */ url) => { opened.push(url); },
    },
  };
  const fetch = async (/** @type {string} */ url, /** @type {any} */ init) => { posts.push({ url, headers: init.headers, body: JSON.parse(init.body), credentials: init.credentials }); return new Response("{}"); };
  vm.runInNewContext(await readFile(SW, "utf8"), { self, fetch, URL, Promise, JSON });
  /** @param {string} name @param {any} event */
  const fire = async (name, event) => {
    /** @type {Promise<unknown>[]} */
    const waits = [];
    handlers[name]({ ...event, waitUntil: (/** @type {Promise<unknown>} */ p) => waits.push(p) });
    await Promise.all(waits);
  };
  return { self: /** @type {any} */ (self), fire, shown, posts, opened };
}

test("a push is shown with the payload's text and tagged by thread, and acknowledged as shown", async () => {
  const w = await worker();
  w.self.agoraChatPush.configure({ base: "/app/chat/", headers: { "X-Example-App": "1" } });
  const payload = { v: 1, pushId: "a".repeat(32), kind: "message", title: "Alice wrote", body: "can you check this?", thread: "r1", url: "/?thread=r1" };
  await w.fire("push", { data: { json: () => payload } });
  assert.equal(w.shown.length, 1);
  assert.equal(w.shown[0].title, "Alice wrote");
  assert.equal(w.shown[0].options.body, "can you check this?");
  assert.equal(w.shown[0].options.tag, "thread-r1");
  assert.deepEqual(w.shown[0].options.data, { pushId: payload.pushId, thread: "r1", url: "/?thread=r1" });
  assert.deepEqual(w.posts, [{ url: "/app/chat/push/ack", headers: { "content-type": "application/json", "X-Example-App": "1" }, body: { pushId: payload.pushId, event: "shown" }, credentials: "same-origin" }]);
  // an unreadable payload still shows something, and acknowledges nothing it cannot name
  await w.fire("push", { data: { json: () => { throw new Error("not json"); } } });
  assert.equal(w.shown[1].title, "New message");
  assert.equal(w.posts.length, 1);
});

test("a click focuses an open window and names the thread; with none open it opens the thread", async () => {
  /** @type {any[]} */
  const messages = [];
  let focused = 0;
  const win = { url: "https://app.example/room", focus: async () => { focused++; }, postMessage: (/** @type {any} */ m) => messages.push(m) };
  const other = { url: "https://elsewhere.example/", focus: async () => { throw new Error("wrong window"); }, postMessage: () => {} };
  const w = await worker({ windows: [other, win] });
  let closed = false;
  const notification = { data: { pushId: "b".repeat(32), thread: "r2", url: "/?thread=r2" }, close: () => { closed = true; } };
  await w.fire("notificationclick", { notification });
  assert.ok(closed);
  assert.equal(focused, 1);
  assert.deepEqual(messages, [{ type: "agora-chat-open-thread", thread: "r2", url: "https://app.example/?thread=r2" }]);
  assert.deepEqual(w.posts.map((p) => p.body), [{ pushId: "b".repeat(32), event: "clicked" }]);

  const none = await worker({ windows: [] });
  await none.fire("notificationclick", { notification: { data: { pushId: "c".repeat(32), thread: null, url: "/" }, close() {} } });
  assert.deepEqual(none.opened, ["https://app.example/"]);
});

test("a click whose url resolves to another origin opens the app's root instead", async () => {
  const w = await worker({ windows: [] });
  await w.fire("notificationclick", { notification: { data: { pushId: "d".repeat(32), thread: "r3", url: "https://elsewhere.example/?thread=r3" }, close() {} } });
  assert.deepEqual(w.opened, ["https://app.example/"]);
  const v = await worker({ windows: [] });
  await v.fire("notificationclick", { notification: { data: { pushId: "e".repeat(32), thread: "r4", url: "//elsewhere.example/r4" }, close() {} } });
  assert.deepEqual(v.opened, ["https://app.example/"]);
});
