#!/usr/bin/env bun
// @ts-check
/**
 * A dev host for push, on localhost (a secure context, so a browser will subscribe): one signed-in
 * person ("alice"), the kit's push routes mounted as a host mounts them, a host service worker that
 * imports the kit's worker, and a page to subscribe, send a test push, and watch each push's answer
 * and acknowledgement arrive. With a real browser this sends real pushes through its push service.
 *
 *   bun chat/push/dev/serve.mjs --store <dir> --vapid <file> [--port 0] [--subject mailto:...]
 *
 * Prints one JSON line `{ "url": ... }` when listening. Stop it with Ctrl-C.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPush, createPushService } from "../server.mjs";
import { openPushStore } from "../store.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUSH = path.resolve(HERE, "..");

/** @param {string[]} argv */
function args(argv) {
  /** @type {Record<string, string>} */
  const a = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--") || argv[i + 1] === undefined) throw new Error(`usage: serve.mjs --store <dir> --vapid <file> [--port <n>] [--subject <mailto:>]`);
    a[argv[i].slice(2)] = argv[i + 1];
  }
  if (!a.store || !a.vapid) throw new Error("--store and --vapid are required");
  return a;
}

const a = args(process.argv.slice(2));
const person = { id: "alice", name: "Alice", ref: "alice" };
const store = await openPushStore({ storeDir: path.resolve(a.store) });
const push = await createPush({ vapidFile: path.resolve(a.vapid), subject: a.subject ?? "mailto:dev@example.org" });
const service = createPushService({
  store, push,
  hooks: { people: async () => [person], notifyText: ({ message }) => ({ title: String(message.author?.name ?? ""), body: String(message.text ?? "") }) },
  threadUrl: (root) => (root ? `/?thread=${encodeURIComponent(root)}` : "/"),
});

/** @type {Record<string, [string, string]>} */
const files = {
  "/": [path.join(HERE, "index.html"), "text/html; charset=utf-8"],
  "/sw.js": [path.join(HERE, "sw.js"), "text/javascript; charset=utf-8"],
  "/chat/push/sw.js": [path.join(PUSH, "sw.js"), "text/javascript; charset=utf-8"],
  "/chat/push/client.js": [path.join(PUSH, "client.js"), "text/javascript; charset=utf-8"],
};

const bun = /** @type {any} */ (globalThis).Bun;
const server = bun.serve({
  hostname: "localhost",
  port: Number(a.port ?? 0),
  /** @param {Request} req */
  async fetch(req) {
    const url = new URL(req.url);
    const file = files[url.pathname];
    if (file && req.method === "GET") {
      return new Response(await readFile(file[0]), { headers: { "content-type": file[1], "cache-control": "no-store", "service-worker-allowed": "/" } });
    }
    if (url.pathname === "/dev/records") {
      return Response.json({ ok: true, data: store.recentSent(person.id, 10) }, { headers: { "cache-control": "no-store" } });
    }
    const r = await service.handle(req, person);
    return r ?? new Response("not found", { status: 404 });
  },
});

process.stdout.write(`${JSON.stringify({ url: `http://localhost:${server.port}/`, publicKey: push.publicKey })}\n`);
const stop = () => {
  server.stop(true);
  store.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
