// @ts-check
// The kit and the room's own record verbs together, against a real seat service: a thread in the
// kit whose reply carries a PNG posted from the CLI, that reply edited and then purged from the CLI,
// what the kit's stream and routes show of each, and a mention in the thread pushed to a loopback
// push service under the host's thread URL template.
//
// A purge made outside the kit reaches it: a purge event on the stream, the index's text forgotten
// at once, and the file route answering 404 for the purged reply's PNG.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startSeat } from "./seat-service.mjs";
import { createChat } from "../server/index.mjs";
import { startFakePushService } from "../push/fake-service.mjs";

const BunRuntime = /** @type {any} */ (globalThis).Bun;

/** @type {import("../server/index.mjs").Person[]} */
const PEOPLE = [
  { id: "p-ada", name: "Ada Byron", ref: "ref-ada" },
  { id: "p-grace", name: "Grace Hopper", ref: "ref-grace" },
];

/** A PNG whose IHDR says 640 x 480, then noise. @returns {Buffer} */
function png() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(640, 0);
  ihdr.writeUInt32BE(480, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(13, 0);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), len, Buffer.from("IHDR"), ihdr, Buffer.alloc(4), randomBytes(1024)]);
}

/** @param {string} url @param {Record<string, string>} headers */
async function openStream(url, headers) {
  const ac = new AbortController();
  const res = await fetch(url, { headers, signal: ac.signal });
  assert.equal(res.status, 200, `the stream opened: ${res.status}`);
  /** @type {{ event: string, id?: string, data: any }[]} */
  const events = [];
  const reader = /** @type {ReadableStream<Uint8Array>} */ (res.body).getReader();
  const decoder = new TextDecoder();
  void (async () => {
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let at;
        while ((at = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, at);
          buf = buf.slice(at + 2);
          /** @type {any} */
          const ev = {};
          for (const line of block.split("\n")) {
            if (line.startsWith("event: ")) ev.event = line.slice(7);
            else if (line.startsWith("data: ")) ev.data = JSON.parse(line.slice(6));
            else if (line.startsWith("id: ")) ev.id = line.slice(4);
          }
          if (ev.event) events.push(ev);
        }
      }
    } catch { /* aborted */ }
  })();
  return {
    events,
    /** @param {string} event */
    of: (event) => events.filter((e) => e.event === event),
    /** @param {() => unknown} pred @param {string} what @param {number} [ms] */
    async until(pred, what, ms = 20_000) {
      const end = Date.now() + ms;
      for (;;) {
        const got = pred();
        if (got) return got;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}; events: ${JSON.stringify(events.map((e) => [e.event, e.data?.text ?? e.data?.state ?? e.data?.act]))}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    },
    close: () => ac.abort(),
  };
}

/** @param {string} stdout */
const lines = (stdout) => stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));

test("a kit thread, a PNG reply from the CLI, its edit and purge, and a pushed mention", { timeout: 120_000 }, async (t) => {
  const seat = await startSeat(t);
  const fake = await startFakePushService();
  const dir = await mkdtemp(path.join(tmpdir(), "agora-chat-records-"));
  const chat = await createChat({
    agoraDir: seat.agoraDir, agoraState: seat.state, agoraConfig: seat.config, room: seat.alias, clientName: "example-app",
    storeDir: path.join(dir, "kit"),
    hooks: {
      identify: async () => null,
      authorize: () => true,
      people: async () => PEOPLE,
      scanText: () => ({}),
      scanUpload: async () => ({ ok: true }),
      notifyText: ({ message }) => ({ title: `${message.author?.name ?? "someone"} wrote`, body: String(message.text ?? "") }),
      presence: async () => ({ state: "ready" }),
      residentName: "the resident",
    },
    push: { vapidFile: path.join(dir, "vapid.json"), subject: "mailto:ops@example.org", threadUrl: "/app/?thread={root}", allowEndpoint: fake.allows },
    log: () => {},
    tuning: { keepAliveMs: 1000, presenceMs: 500, restartMs: 500, peopleMs: 0 },
  });
  const server = BunRuntime.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(/** @type {Request} */ req) {
      const who = PEOPLE.find((p) => p.id === req.headers.get("x-person")) ?? null;
      return (await chat.handle(req, who)) ?? new Response("the host's own", { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  /** @type {{ close(): void }[]} */
  const streams = [];
  t.after(async () => {
    for (const s of streams) s.close();
    server.stop(true);
    await chat.close();
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  });
  /** @param {string} who @param {string} p @param {unknown} [body] */
  const call = async (who, p, body) => {
    const res = await fetch(`${base}${p}`, body === undefined ? { headers: { "x-person": who } }
      : { method: "POST", headers: { "x-person": who, "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await res.text();
    /** @type {any} */
    let parsed = text;
    try { parsed = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body: parsed };
  };

  // Grace subscribes to push through the kit's own routes
  const sub = await fake.subscribe();
  assert.equal((await call("p-grace", "/chat/push/subscribe", sub)).status, 200);

  // Ada opens a thread in the kit
  const root = await call("p-ada", "/chat/post", { text: "the panel layout for the north room" });
  assert.equal(root.status, 200, JSON.stringify(root.body));
  const rootId = root.body.data.receipt.id;
  const stream = await openStream(`${base}/chat/stream?thread=${rootId}`, { "x-person": "p-ada" });
  streams.push(stream);
  await stream.until(() => stream.of("state").some((e) => e.data.state === "live"), "the thread stream live");

  // an agent replies in that thread from the CLI, with a PNG
  const file = path.join(dir, "panel.png");
  await writeFile(file, png());
  await seat.agora(["post", seat.alias, "the photo of the panel", "--thread", rootId, "--attach", file]);
  const reply = /** @type {any} */ (await stream.until(() => stream.of("message").find((e) => e.data.text?.startsWith("the photo of the panel")), "the PNG reply on the kit's stream")).data;
  assert.equal(reply.thread, rootId);
  assert.equal(reply.attachments?.length, 1, "the reply carries its attachment through the kit");
  const [att] = reply.attachments;
  assert.equal(att.mimetype ?? att.type ?? "image/png", "image/png");
  assert.deepEqual([att.width, att.height], [640, 480], "post --attach measured the image and the kit passed it on");
  const thread = await call("p-ada", `/chat/thread/${rootId}`);
  assert.equal(thread.status, 200);
  assert.equal(thread.body.data.messages.find((/** @type {any} */ m) => m.id === reply.id)?.attachments?.[0]?.digest, att.digest, "the thread route shows the same attachment");
  const fileRes = await fetch(`${base}/chat/file/${att.id}?digest=${encodeURIComponent(att.digest)}`, { headers: { "x-person": "p-ada" } });
  assert.equal(fileRes.status, 200, "the kit's file route streams the reply's PNG from custody");
  assert.equal(fileRes.headers.get("content-type"), "image/png");
  assert.equal(fileRes.headers.get("x-content-type-options"), "nosniff");
  assert.equal(fileRes.headers.get("cache-control"), "private");
  assert.deepEqual(new Uint8Array(await fileRes.arrayBuffer()), new Uint8Array(await readFile(file)), "the bytes are the file's");

  // the agent edits the reply from the CLI: the kit's stream carries the annotation with the folded message
  const edited = lines((await seat.agora(["edit", seat.alias, reply.id, "--text", "the photo of the panel, cropped", "--json"])).stdout)[0];
  assert.equal(edited.act, "edit");
  const annotation = /** @type {any} */ (await stream.until(() => stream.of("annotation").find((e) => e.data.target === reply.id), "the edit on the kit's stream")).data;
  assert.equal(annotation.act, "edit");
  assert.equal(annotation.message?.id, reply.id, "the annotation carries its target");
  assert.match(annotation.message?.text ?? "", /^the photo of the panel, cropped/, "folded with the edit");
  assert.ok(annotation.message?.edited, "marked edited");

  // the agent purges the reply from the CLI
  const purged = lines((await seat.agora(["room", "purge", seat.alias, "--message", reply.id, "--reason", "asked to remove the photo", "--json"])).stdout)[0];
  assert.deepEqual(purged.purged, [reply.id]);
  assert.equal(purged.blobsRemoved, 1, "the PNG only that reply referenced is collected");

  // the stream stays live across the purge record: a later message still arrives
  await seat.agora(["post", seat.alias, "after the purge", "--thread", rootId]);
  await stream.until(() => stream.of("message").some((e) => e.data.text?.startsWith("after the purge")), "a message after the purge");
  assert.equal(stream.of("state").filter((e) => e.data.state !== "live").length, 0, "the stream never went dark or refused over the purge");
  const purgeEvent = /** @type {any} */ (await stream.until(() => stream.of("purge").find((e) => e.data.purged?.includes(reply.id)), "the purge on the kit's stream")).data;
  assert.deepEqual(purgeEvent.purged, [reply.id], "the thread's stream hears the purge of its reply");
  assert.equal(purgeEvent.reason, "asked to remove the photo");
  assert.ok(purgeEvent.by?.name, "the purge names who asked");
  assert.equal((await call("p-ada", `/chat/file/${att.id}?digest=${encodeURIComponent(att.digest)}`)).status, 404, "the purged reply's file is gone");

  // a read through the kit after the purge: the room's read path shows the reply without its text
  const afterRead = await call("p-ada", `/chat/thread/${rootId}`);
  const shown = afterRead.body.data.messages.find((/** @type {any} */ m) => m.id === reply.id);
  assert.equal(shown?.text, "", "the thread route reads the room, so the purged text is gone there");
  assert.ok(shown?.purged, "and the reply says it was purged");
  // the kit's own index is another matter
  const list = await call("p-ada", "/chat/threads");
  const summary = list.body.data.threads.find((/** @type {any} */ s) => s.root?.id === rootId);
  assert.ok(summary, "the thread is listed");
  // the kit's own index: what search and the list read
  const { Database } = await import("bun:sqlite");
  const kitDb = new Database(path.join(dir, "kit", "kit.sqlite"), { readonly: true });
  try {
    const fts = /** @type {any} */ (kitDb.query("select text from message_fts where id = ?").get(reply.id));
    assert.equal(fts, null, "the kit's search index forgot the purged reply's text when the purge arrived");
  } finally { kitDb.close(); }

  // a mention in the thread is pushed to Grace under the host's thread URL
  const before = fake.arrivals.length;
  const mention = await call("p-ada", "/chat/post", { text: "@Grace Hopper can you confirm the layout?", thread: rootId });
  assert.equal(mention.status, 200, JSON.stringify(mention.body));
  const arrival = /** @type {any} */ (await stream.until(() => fake.arrivals.length > before && fake.arrivals.at(-1), "the push for the mention"));
  assert.equal(arrival.payload?.kind, "message");
  assert.equal(arrival.payload?.thread, rootId);
  assert.equal(arrival.payload?.url, `/app/?thread=${rootId}`, "the notification opens the host's thread URL");
  assert.equal(arrival.payload?.title, "Ada Byron wrote");
  assert.equal(arrival.headers.urgency, "high");
});
