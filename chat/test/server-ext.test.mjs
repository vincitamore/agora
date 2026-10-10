// @ts-check
// The kit's extension routes against a real seat service: scan, upload, file and thumbnail,
// annotate, react, purge and search, and what an edit and a purge do to the kit's index.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AGORA_DIR, startSeat } from "./seat-service.mjs";
import { createChat } from "../server/index.mjs";

const BunRuntime = /** @type {any} */ (globalThis).Bun;
const SLOW = { timeout: 120_000 };

/** @type {import("../server/index.mjs").Person[]} */
const PEOPLE = [
  { id: "p-ada", name: "Ada Byron", ref: "ref-ada" },
  { id: "p-grace", name: "Grace Hopper", ref: "ref-grace" },
  { id: "p-lin", name: "Lin" },
];

/** A PNG whose IHDR says 64 x 48, then noise. */
function png() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(64, 0);
  ihdr.writeUInt32BE(48, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(13, 0);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), len, Buffer.from("IHDR"), ihdr, Buffer.alloc(4), randomBytes(512)]);
}
const SVG = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`);

/**
 * @param {import("node:test").TestContext} t
 * @param {{ deny?: Set<string>, scanUpload?: import("../server/index.mjs").ChatHooks["scanUpload"] }} [knobs]
 */
async function setup(t, knobs = {}) {
  const seat = await startSeat(t);
  const kitDir = await mkdtemp(path.join(tmpdir(), "agora-chat-ext-"));
  /** @type {string[]} */
  const logs = [];
  let scanThrows = false;
  /** @type {{ denyThread: string | null }} */
  const live = { denyThread: null };
  /** @type {import("../server/index.mjs").ChatOptions} */
  const options = {
    agoraDir: AGORA_DIR, agoraState: seat.state, agoraConfig: seat.config, room: seat.alias, clientName: "example-app",
    storeDir: kitDir,
    hooks: {
      identify: async () => null,
      authorize: (p, act, ctx) => !(knobs.deny?.has(`${p.id}:${act}`)) && !(act === "read" && live.denyThread && ctx.thread === live.denyThread && p.id !== "p-ada"),
      people: async () => PEOPLE,
      scanText: (text) => {
        if (scanThrows) throw new Error("the scanner broke");
        return /sk-live-/.test(text) ? { refuse: "secret-shaped" } : /10\.0\.0\.\d/.test(text) ? { warn: "looks like an address" } : {};
      },
      scanUpload: knobs.scanUpload ?? (async ({ name }) => (/\.exe$/.test(name) ? { ok: false, reason: "executable" } : { ok: true })),
      notifyText: () => ({ title: "", body: "" }),
      presence: async () => ({ state: "ready" }),
      residentName: "the resident",
    },
    push: null, log: (line) => logs.push(line),
    tuning: { keepAliveMs: 1000, presenceMs: 500, restartMs: 500, peopleMs: 0 },
  };
  let chat = await createChat(options);
  const server = BunRuntime.serve({
    port: 0, hostname: "127.0.0.1", maxRequestBodySize: 64 * 1024 * 1024,
    async fetch(/** @type {Request} */ req) {
      const who = PEOPLE.find((p) => p.id === req.headers.get("x-person")) ?? null;
      return (await chat.handle(req, who)) ?? new Response("the host's own", { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  const { connect } = await import(pathToFileURL(path.join(AGORA_DIR, "src", "client.mjs")).href);
  const agent = await connect({ state: seat.state, config: seat.config, clientName: "other-app" });
  /** @type {Array<{ close(): void }>} */
  const streams = [];
  t.after(async () => {
    for (const s of streams) s.close();
    agent.close();
    server.stop(true);
    await chat.close();
    await rm(kitDir, { recursive: true, force: true });
  });
  /** @param {string} id @param {string} p @param {unknown} [json] */
  const call = async (id, p, json) => {
    const res = await fetch(`${base}${p}`, json === undefined ? { headers: { "x-person": id } }
      : { method: "POST", headers: { "x-person": id, "content-type": "application/json" }, body: JSON.stringify(json) });
    const text = await res.text();
    /** @type {any} */
    let body = text;
    try { body = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body, headers: res.headers };
  };
  /** @param {string} id @param {Uint8Array} bytes @param {Record<string, string>} headers */
  const upload = async (id, bytes, headers) => {
    const res = await fetch(`${base}/chat/upload`, { method: "POST", headers: { "x-person": id, ...headers }, body: /** @type {any} */ (bytes) });
    return { status: res.status, body: /** @type {any} */ (await res.json()) };
  };
  /** Wait until the kit's index holds a message (the follow delivered it). @param {string} id */
  const indexed = async (id) => {
    const end = Date.now() + 20_000;
    while (Date.now() < end) {
      if ((await call("p-ada", "/chat/threads?limit=200")).body.data.threads.some((/** @type {any} */ s) => s.root.id === id || s.last?.id === id)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`the kit never indexed ${id}`);
  };
  return {
    seat, agent, call, upload, indexed, logs, base, kitDir,
    get chat() { return chat; },
    /** the kit stops (the host keeps serving: the kit answers 503 STOPPED meanwhile) */
    async down() { await chat.close(); },
    /** the kit starts again on the same store */
    async up() { chat = await createChat(options); },
    /** @param {boolean} v */
    set scanThrows(v) { scanThrows = v; },
    /** the host stops letting anyone but Ada read this thread @param {string} thread */
    denyThread(thread) { live.denyThread = thread; },
    /** @param {string} id @param {string} query */
    async stream(id, query) {
      const s = await openStream(`${base}/chat/stream?${query}`, { "x-person": id });
      streams.push(s);
      await s.until(() => s.of("state").some((e) => e.data.state === "live"), "the stream live");
      return s;
    },
  };
}

/** @param {string} url @param {Record<string, string>} headers */
async function openStream(url, headers) {
  const ac = new AbortController();
  const res = await fetch(url, { headers, signal: ac.signal });
  assert.equal(res.status, 200);
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
    /** @param {() => unknown} pred @param {string} what */
    async until(pred, what, ms = 20_000) {
      const end = Date.now() + ms;
      for (;;) {
        const got = pred();
        if (got) return got;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}; events: ${JSON.stringify(events.map((e) => [e.event, e.data?.text ?? e.data?.state ?? e.data?.act ?? e.data?.purged]))}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    },
    close: () => ac.abort(),
  };
}

test("scan answers what a post would, and changes nothing", SLOW, async (t) => {
  const k = await setup(t, { deny: new Set(["p-lin:post"]) });
  const before = (await k.agent.read(k.seat.alias)).through;
  assert.deepEqual((await k.call("p-ada", "/chat/scan", { text: "plain words" })).body, { ok: true, data: {} });
  const warned = await k.call("p-ada", "/chat/scan", { text: "try 10.0.0.7" });
  assert.equal(warned.status, 200);
  assert.equal(warned.body.data.warn, "looks like an address");
  const refused = await k.call("p-ada", "/chat/scan", { text: "my key is sk-live-abc" });
  assert.equal(refused.status, 422);
  assert.equal(refused.body.error.code, "TEXT_REFUSED");
  assert.equal(refused.body.error.reason, "secret-shaped");
  k.scanThrows = true;
  const broke = await k.call("p-ada", "/chat/scan", { text: "anything" });
  assert.equal(broke.status, 422);
  assert.equal(broke.body.error.reason, "scan-failed");
  k.scanThrows = false;
  assert.equal((await k.call("p-ada", "/chat/scan", { words: "x" })).status, 400);
  assert.equal((await k.call("p-lin", "/chat/scan", { text: "x" })).status, 403);
  assert.equal((await k.agent.read(k.seat.alias)).through, before, "a scan appends nothing");
  assert.equal((await k.call("p-ada", "/chat/scan")).status, 405, "GET is not answered");
});

test("upload, file and thumbnail: scans, caps, headers, and who may fetch", SLOW, async (t) => {
  const k = await setup(t);
  const bytes = png();
  const up = await k.upload("p-ada", bytes, { "x-file-name": encodeURIComponent("panel photo é.png"), "content-type": "image/png", "x-image-width": "64", "x-image-height": "48" });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  const att = up.body.data.attachment;
  assert.equal(att.kind, "image");
  assert.equal(att.digest, `sha256:${createHash("sha256").update(bytes).digest("hex")}`);
  assert.deepEqual([att.width, att.height], [64, 48]);
  assert.equal(up.body.data.thumb, undefined, "no thumbnail yet");

  // a thumbnail for it, by the uploader only
  const thumbBytes = png();
  assert.equal((await k.upload("p-grace", thumbBytes, { "x-thumb-for": att.digest })).status, 404, "not Grace's upload");
  assert.equal((await k.upload("p-ada", Buffer.from("not an image"), { "x-thumb-for": att.digest })).status, 422);
  const th = await k.upload("p-ada", thumbBytes, { "x-thumb-for": att.digest });
  assert.equal(th.status, 200, JSON.stringify(th.body));
  assert.equal(th.body.data.thumb, `/chat/thumb/${encodeURIComponent(att.digest)}`);
  const again = await k.upload("p-ada", bytes, { "x-file-name": "same.png", "content-type": "image/png" });
  assert.equal(again.body.data.thumb, th.body.data.thumb, "the same bytes again carry the thumbnail");

  // before it is posted: the uploader may fetch it, nobody else
  const fileUrl = `/chat/file/${att.id}?digest=${encodeURIComponent(att.digest)}`;
  assert.equal((await k.call("p-ada", fileUrl)).status, 200);
  assert.equal((await k.call("p-grace", fileUrl)).status, 404);
  assert.equal((await k.call("p-grace", th.body.data.thumb)).status, 404);

  // posted: anyone who may read the thread
  const post = await k.call("p-ada", "/chat/post", { text: "the panel", attachments: [att] });
  assert.equal(post.status, 200, JSON.stringify(post.body));
  await k.indexed(post.body.data.receipt.id);
  const res = await fetch(`${k.base}${fileUrl}`, { headers: { "x-person": "p-grace" } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("cache-control"), "private");
  assert.match(res.headers.get("content-disposition") ?? "", /^inline; .*filename\*=UTF-8''panel%20photo%20%C3%A9\.png/);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), new Uint8Array(bytes));
  const thumb = await fetch(`${k.base}${th.body.data.thumb}`, { headers: { "x-person": "p-grace" } });
  assert.equal(thumb.status, 200);
  assert.equal(thumb.headers.get("content-type"), "image/png");
  assert.deepEqual(new Uint8Array(await thumb.arrayBuffer()), new Uint8Array(thumbBytes));

  // an SVG is a download, never rendered
  const svg = await k.upload("p-ada", SVG, { "x-file-name": "drawing.svg", "content-type": "image/svg+xml" });
  assert.equal(svg.status, 200, JSON.stringify(svg.body));
  assert.equal(svg.body.data.attachment.kind, "file", "its bytes do not prove an image");
  const svgRes = await fetch(`${k.base}/chat/file/${svg.body.data.attachment.id}?digest=${encodeURIComponent(svg.body.data.attachment.digest)}`, { headers: { "x-person": "p-ada" } });
  assert.equal(svgRes.status, 200);
  assert.equal(svgRes.headers.get("content-type"), "application/octet-stream");
  assert.match(svgRes.headers.get("content-disposition") ?? "", /^attachment; filename="drawing.svg"/);
  assert.equal(svgRes.headers.get("x-content-type-options"), "nosniff");
  assert.match(svgRes.headers.get("content-security-policy") ?? "", /sandbox/);
  await svgRes.arrayBuffer();

  // refusals: a secret in a text file, the host's own scan, the size cap, the name
  const secret = await k.upload("p-ada", Buffer.from("db password\nsk-live-0123456789\n"), { "x-file-name": "notes.txt", "content-type": "text/plain" });
  assert.equal(secret.status, 422);
  assert.equal(secret.body.error.code, "UPLOAD_REFUSED");
  assert.equal(secret.body.error.reason, "secret-shaped");
  const exe = await k.upload("p-ada", Buffer.from([0x4d, 0x5a, 0x90, 0x00]), { "x-file-name": "tool.exe" });
  assert.equal(exe.status, 422);
  assert.equal(exe.body.error.reason, "executable");
  const big = await k.upload("p-ada", new Uint8Array(25 * 1024 * 1024 + 1), { "x-file-name": "big.bin" });
  assert.equal(big.status, 413);
  assert.equal(big.body.error.code, "TOO_LARGE");
  assert.equal((await k.upload("p-ada", bytes, {})).status, 400, "a name is required");
  assert.equal((await k.upload("p-ada", bytes, { "x-file-name": "../up.png" })).status, 400, "a name is not a path");
  assert.equal((await k.upload("p-ada", new Uint8Array(0), { "x-file-name": "empty.txt" })).status, 400);
  assert.equal((await k.call("p-ada", `/chat/file/${"a".repeat(64)}?digest=sha256:${"0".repeat(64)}`)).status, 404, "bytes that do not exist");
});

test("upload is authorized", SLOW, async (t) => {
  const k = await setup(t, { deny: new Set(["p-lin:upload"]) });
  assert.equal((await k.upload("p-lin", png(), { "x-file-name": "x.png" })).status, 403);
});

test("annotate: the author edits and withdraws, anyone may pin; an edit re-indexes trailers, mentions and words", SLOW, async (t) => {
  const k = await setup(t);
  const root = await k.call("p-ada", "/chat/post", { text: "the first plan @Grace Hopper", trailers: [["waiting", "p-grace"]] });
  assert.equal(root.status, 200, JSON.stringify(root.body));
  const id = root.body.data.receipt.id;
  await k.indexed(id);
  const s = await k.stream("p-grace", `thread=${id}`);
  /** @param {string} who @param {string} scope */
  const listed = async (who, scope = "all") => (await k.call(who, `/chat/threads?scope=${scope}`)).body.data.threads.find((/** @type {any} */ x) => x.root.id === id);
  assert.deepEqual((await listed("p-ada")).waiting, ["p-grace"]);
  assert.ok(await listed("p-grace", "mine"), "Grace is mentioned and waited on");
  assert.equal((await listed("p-lin", "mine")), undefined);

  // not Grace's to edit; a secret is refused; shapes
  assert.equal((await k.call("p-grace", "/chat/annotate", { act: "edit", target: id, text: "mine now" })).status, 403);
  const secret = await k.call("p-ada", "/chat/annotate", { act: "edit", target: id, text: "sk-live-xyz" });
  assert.equal(secret.status, 422);
  assert.equal(secret.body.error.reason, "secret-shaped");
  assert.equal((await k.call("p-ada", "/chat/annotate", { act: "shout", target: id })).status, 400);
  assert.equal((await k.call("p-ada", "/chat/annotate", { act: "edit", target: "f".repeat(64), text: "x" })).status, 404);

  // the edit: no mention of Grace, waiting on Lin now
  const edit = await k.call("p-ada", "/chat/annotate", { act: "edit", target: id, text: "the second plan, for Lin to check\n\nwaiting: p-lin", operationId: "edit-draft-1" });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  assert.equal(edit.body.data.receipt.operationId, "edit-draft-1");
  const resent = await k.call("p-ada", "/chat/annotate", { act: "edit", target: id, text: "the second plan, for Lin to check\n\nwaiting: p-lin", operationId: "edit-draft-1" });
  assert.equal(resent.body.data.receipt.id, edit.body.data.receipt.id, "a resend under the same draft id lands once");
  assert.equal(resent.body.data.receipt.duplicate, true);
  const ev = /** @type {any} */ (await s.until(() => s.of("annotation").find((e) => e.data.act === "edit"), "the edit on the stream")).data;
  assert.match(ev.message.text, /^the second plan/);
  const row = await listed("p-ada");
  assert.deepEqual(row.waiting, ["p-lin"], "waiting follows the edit");
  assert.equal(await listed("p-grace", "mine"), undefined, "Grace is no longer mentioned nor waited on");
  assert.ok(await listed("p-lin", "mine"), "Lin is waited on");
  const oldWords = await k.call("p-ada", "/chat/search?q=first");
  assert.equal(oldWords.body.data.hits.length, 0, "search forgot the old words");
  const newWords = await k.call("p-ada", "/chat/search?q=second plan");
  assert.deepEqual(newWords.body.data.hits.map((/** @type {any} */ h) => h.message.id), [id]);

  // pin by anyone; withdraw by the author
  const pin = await k.call("p-grace", "/chat/annotate", { act: "pin", target: id });
  assert.equal(pin.status, 200, JSON.stringify(pin.body));
  assert.equal((await k.call("p-grace", "/chat/annotate", { act: "withdraw", target: id })).status, 403);
  assert.equal((await k.call("p-ada", "/chat/annotate", { act: "withdraw", target: id })).status, 200);
  const thread = await k.call("p-ada", `/chat/thread/${id}`);
  const shown = thread.body.data.messages.find((/** @type {any} */ m) => m.id === id);
  assert.ok(shown.withdrawn && shown.pinned);
  assert.equal((await k.call("p-ada", "/chat/search?q=second")).body.data.hits.length, 0, "a withdrawn message is not found");
  const late = await k.call("p-grace", "/chat/react", { target: id, name: "seen", on: true });
  assert.equal(late.status, 409, "a withdrawn message takes no new reaction");
  assert.equal(late.body.error.code, "WITHDRAWN");
  assert.equal((await k.call("p-grace", "/chat/react", { target: id, name: "seen", on: false })).status, 200, "taking one back is still allowed");
});

test("react keeps names, never counts", SLOW, async (t) => {
  const k = await setup(t, { deny: new Set(["p-lin:react"]) });
  const root = await k.call("p-ada", "/chat/post", { text: "a reaction target" });
  const id = root.body.data.receipt.id;
  await k.indexed(id);
  assert.deepEqual((await k.call("p-ada", "/chat/react", { target: id, name: "agree", on: true })).body.data.names, ["p-ada"]);
  assert.deepEqual((await k.call("p-grace", "/chat/react", { target: id, name: "agree", on: true })).body.data.names, ["p-ada", "p-grace"]);
  assert.deepEqual((await k.call("p-ada", "/chat/react", { target: id, name: "agree", on: false })).body.data.names, ["p-grace"]);
  assert.equal((await k.call("p-ada", "/chat/react", { target: id, name: "two words", on: true })).status, 400);

  // folded into every message the kit serves: names, each with who, in the order first chosen
  assert.equal((await k.call("p-lin", "/chat/react", { target: id, name: "later", on: true })).status, 403);
  const add = await k.call("p-ada", "/chat/react", { target: id, name: "seen", on: true });
  const want = [{ name: "agree", people: ["p-grace"] }, { name: "seen", people: ["p-ada"] }];
  assert.deepEqual(add.body.data, { names: ["p-ada"], reactions: want });
  const inThread = async (/** @type {string} */ where) => (await k.call("p-grace", `/chat/thread/${where}`)).body.data.messages.find((/** @type {any} */ m) => m.id === id);
  assert.deepEqual((await inThread(id)).reactions, want, "the thread route");
  assert.deepEqual((await inThread("main")).reactions, want, "the room route");
  const row = (await k.call("p-grace", "/chat/threads")).body.data.threads.find((/** @type {any} */ x) => x.root.id === id);
  assert.deepEqual(row.root.reactions, want, "the thread list's root");
  assert.deepEqual(row.last.reactions, want, "and its last");
  assert.deepEqual((await k.call("p-grace", "/chat/search?q=reaction")).body.data.hits[0].message.reactions, want, "a search hit");
  const s = await k.stream("p-grace", `thread=${id}`);
  const shown = /** @type {any} */ (await s.until(() => s.of("message").find((e) => e.data.id === id), "the message on the stream")).data;
  assert.deepEqual(shown.reactions, want, "the stream's message event");
  await k.call("p-ada", "/chat/annotate", { act: "pin", target: id });
  const pinned = /** @type {any} */ (await s.until(() => s.of("annotation").find((e) => e.data.act === "pin"), "the pin on the stream")).data;
  assert.deepEqual(pinned.message.reactions, want, "the stream's annotation event carries its target's reactions");
  // removed: the field goes
  assert.deepEqual((await k.call("p-ada", "/chat/react", { target: id, name: "seen", on: false })).body.data.reactions, [{ name: "agree", people: ["p-grace"] }]);
  assert.deepEqual((await k.call("p-grace", "/chat/react", { target: id, name: "agree", on: false })).body.data, { names: [], reactions: [] });
  assert.equal((await inThread(id)).reactions, undefined, "no reactions, no field");
  assert.equal((await k.call("p-ada", "/chat/react", { target: id, name: "__proto__", on: true })).status, 200, "a name is data, never a key");
  assert.deepEqual((await inThread(id)).reactions, [{ name: "__proto__", people: ["p-ada"] }]);
  assert.equal((await k.call("p-ada", "/chat/react", { target: "e".repeat(64), name: "agree", on: true })).status, 404);
  assert.equal((await k.call("p-lin", "/chat/react", { target: id, name: "agree", on: true })).status, 403);
});

test("the client half reads the reactions the server serves, in the one shape it serves", SLOW, async (t) => {
  const { reactionsOf } = await import("../client/composer.js");
  const k = await setup(t);
  const id = (await k.call("p-ada", "/chat/post", { text: "one shape for reactions" })).body.data.receipt.id;
  await k.indexed(id);
  assert.equal(reactionsOf((await k.call("p-grace", `/chat/thread/${id}`)).body.data.messages[0]), null, "no field, nothing read");
  await k.call("p-grace", "/chat/react", { target: id, name: "seen", on: true });
  await k.call("p-ada", "/chat/react", { target: id, name: "done", on: true });
  const answer = (await k.call("p-ada", "/chat/react", { target: id, name: "seen", on: true })).body.data;
  const want = [["seen", ["p-grace", "p-ada"]], ["done", ["p-ada"]]];
  assert.deepEqual([...(reactionsOf({ reactions: answer.reactions }) ?? [])], want, "the react answer");
  const served = (await k.call("p-grace", `/chat/thread/${id}`)).body.data.messages.find((/** @type {any} */ m) => m.id === id);
  assert.deepEqual([...(reactionsOf(served) ?? [])], want, "the thread route");
  const listed = (await k.call("p-grace", "/chat/threads")).body.data.threads.find((/** @type {any} */ x) => x.root.id === id);
  assert.deepEqual([...(reactionsOf(listed.root) ?? [])], want, "the thread list");
  const s = await k.stream("p-grace", `thread=${id}`);
  const shown = /** @type {any} */ (await s.until(() => s.of("message").find((e) => e.data.id === id), "the message on the stream")).data;
  assert.deepEqual([...(reactionsOf(shown) ?? [])], want, "the stream's message event");
});

test("a reaction reaches every open stream on its thread at once, as the message's reactions now stand", SLOW, async (t) => {
  const k = await setup(t);
  const id = (await k.call("p-ada", "/chat/post", { text: "react to this live" })).body.data.receipt.id;
  const other = (await k.call("p-ada", "/chat/post", { text: "another thread" })).body.data.receipt.id;
  const reply = (await k.call("p-ada", "/chat/post", { text: "a reply in it", thread: id })).body.data.receipt.id;
  await k.indexed(reply);
  await k.indexed(other);
  const grace = await k.stream("p-grace", `thread=${id}`);
  const lin = await k.stream("p-lin", `thread=${id}`);
  const room = await k.stream("p-lin", "thread=main");
  const elsewhere = await k.stream("p-grace", `thread=${other}`);
  const reactionsOn = (/** @type {any} */ s, /** @type {string} */ target) => s.of("reaction").filter((/** @type {any} */ e) => e.data.target === target);

  await k.call("p-ada", "/chat/react", { target: reply, name: "seen", on: true });
  const want = [{ name: "seen", people: ["p-ada"] }];
  for (const [who, s] of /** @type {const} */ ([["grace", grace], ["lin", lin], ["main", room]])) {
    const got = /** @type {any} */ (await s.until(() => reactionsOn(s, reply)[0], `the reaction on ${who}'s stream`));
    assert.deepEqual(got.data, { target: reply, reactions: want }, who);
    assert.equal(got.id, undefined, "a reaction moves no resume point");
  }
  await k.call("p-grace", "/chat/react", { target: reply, name: "seen", on: true });
  await lin.until(() => reactionsOn(lin, reply).length === 2, "the second reaction");
  assert.deepEqual(reactionsOn(lin, reply)[1].data.reactions, [{ name: "seen", people: ["p-ada", "p-grace"] }]);
  await k.call("p-ada", "/chat/react", { target: reply, name: "seen", on: false });
  await k.call("p-grace", "/chat/react", { target: reply, name: "seen", on: false });
  await grace.until(() => reactionsOn(grace, reply).length === 4, "taken back");
  assert.deepEqual(reactionsOn(grace, reply)[3].data.reactions, [], "the last taken back is an empty list");
  // the root's own reactions reach its thread's streams too; another thread's stream hears none of it
  await k.call("p-lin", "/chat/react", { target: id, name: "done", on: true });
  await grace.until(() => reactionsOn(grace, id)[0], "the root's reaction");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(elsewhere.of("reaction").length, 0, "another thread's stream hears no reaction");
  // a stream opened afterwards reads them folded into the message
  const late = await k.stream("p-grace", `thread=${id}`);
  const root = /** @type {any} */ (await late.until(() => late.of("message").find((e) => e.data.id === id), "the root on a new stream")).data;
  assert.deepEqual(root.reactions, [{ name: "done", people: ["p-lin"] }]);
});

test("search: words and file names, context, coverage, and what a reader may see", SLOW, async (t) => {
  const k = await setup(t);
  const a = await k.call("p-ada", "/chat/post", { text: "the valve schedule for tuesday", trailers: [["context", "item=alpha; screen=detail"]] });
  const b = await k.call("p-ada", "/chat/post", { text: "the valve schedule for friday", trailers: [["context", "item=beta"]] });
  const up = await k.upload("p-ada", png(), { "x-file-name": "wiring-diagram.png", "content-type": "image/png" });
  const c = await k.call("p-ada", "/chat/post", { text: "see attached", attachments: [up.body.data.attachment] });
  for (const r of [a, b, c]) assert.equal(r.status, 200, JSON.stringify(r.body));
  await k.indexed(c.body.data.receipt.id);
  const ids = (/** @type {any} */ r) => r.body.data.hits.map((/** @type {any} */ h) => h.message.id).sort();

  const both = await k.call("p-ada", "/chat/search?q=valve%20sched");
  assert.deepEqual(ids(both), [a.body.data.receipt.id, b.body.data.receipt.id].sort(), "every word, each as a prefix");
  assert.match(both.body.data.hits[0].snippet, /valve schedule/);
  assert.equal(typeof both.body.data.coverage.through, "string");
  // coverage reads as a time: the newest record the index holds through that cursor
  const shownC = (await k.call("p-ada", "/chat/thread/main")).body.data.messages.find((/** @type {any} */ m) => m.id === c.body.data.receipt.id);
  assert.deepEqual(both.body.data.coverage, { through: shownC.cursor, at: shownC.ts });
  assert.deepEqual((await k.call("p-ada", "/chat/search?q=%22%29%28*")).body.data.coverage.at, shownC.ts, "an empty query says it too");
  assert.equal(both.body.data.hits[0].message.author.id, undefined, "the browser's shape");
  assert.deepEqual(ids(await k.call("p-ada", "/chat/search?q=valve&context=item%3Dalpha")), [a.body.data.receipt.id]);
  assert.deepEqual(ids(await k.call("p-ada", "/chat/search?q=wiring&scope=files")), [c.body.data.receipt.id]);
  assert.deepEqual(ids(await k.call("p-ada", "/chat/search?q=wiring")), [], "scope=messages reads the words, not the names");
  assert.deepEqual(ids(await k.call("p-ada", "/chat/search?q=%22%29%28*")), [], "punctuation alone matches nothing and breaks nothing");
  assert.equal((await k.call("p-ada", "/chat/search?q=")).status, 400);
  assert.equal((await k.call("p-ada", "/chat/search?q=x&scope=all")).status, 400);
  assert.equal((await k.call("p-ada", "/chat/search?q=x&limit=0")).status, 400);
});

test("search reads a message's words, never its trailer block: not in a snippet, not as a match", SLOW, async (t) => {
  const k = await setup(t);
  const a = await k.call("p-ada", "/chat/post", { text: "the spare pump sits beside the tank", trailers: [["context", "zone=north; bay=quarry"]] });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const id = a.body.data.receipt.id;
  await k.indexed(id);
  const tank = await k.call("p-ada", "/chat/search?q=tank");
  assert.deepEqual(tank.body.data.hits.map((/** @type {any} */ h) => h.message.id), [id]);
  const snippet = tank.body.data.hits[0].snippet;
  assert.match(snippet, /beside the tank/);
  assert.doesNotMatch(snippet, /context|zone|north|quarry/, `the snippet is the words alone: ${snippet}`);
  assert.match(tank.body.data.hits[0].message.text, /context: zone=north/, "the message itself still carries its trailers");
  for (const q of ["zone", "north", "quarry", "context"]) {
    assert.deepEqual((await k.call("p-ada", `/chat/search?q=${q}`)).body.data.hits, [], `a trailer's word is metadata, not content: ${q}`);
  }
  assert.deepEqual((await k.call("p-ada", "/chat/search?q=pump&context=zone%3Dnorth")).body.data.hits.map((/** @type {any} */ h) => h.message.id), [id], "the trailer still filters, as metadata");

  // an edit keeps its trailer block under the new words (the composer does that); search reads the words
  const edit = await k.call("p-ada", "/chat/annotate", { act: "edit", target: id, text: "the spare pump sits beside the cistern\n\ncontext: zone=north; bay=quarry" });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  const end = Date.now() + 20_000;
  /** @type {any} */
  let found = null;
  while (Date.now() < end && !(found = (await k.call("p-ada", "/chat/search?q=cistern")).body.data.hits[0])) await new Promise((r) => setTimeout(r, 50));
  assert.ok(found, "the edit reached the index");
  assert.doesNotMatch(found.snippet, /context|zone|north|quarry/, `the edited snippet is the words alone: ${found.snippet}`);
  assert.deepEqual((await k.call("p-ada", "/chat/search?q=quarry")).body.data.hits, [], "the edit's trailer is not content either");
});

test("the searchable text drops the trailer block and the signature line, and nothing else", async () => {
  const { searchableText } = await import("../server/store.mjs");
  assert.equal(searchableText("the spare pump\n\ncontext: zone=north\nwaiting: p-ada\n\n-- Resident/watch"), "the spare pump");
  assert.equal(searchableText("the spare pump\n\n-- Resident/watch"), "the spare pump");
  assert.equal(searchableText("a note: with a colon\nand a second line"), "a note: with a colon\nand a second line", "a body line that looks like a key is still the body");
  assert.equal(searchableText("time: 14:00\nplace: bay 2"), "time: 14:00\nplace: bay 2", "a paragraph of unknown keys alone is the body, as agora reads it");
  assert.equal(searchableText(undefined), "");
});

test("a store from before the words-only index is emptied for a rebuild; what is kept stays", SLOW, async (t) => {
  const { openKitStore } = await import("../server/store.mjs");
  const dir = await mkdtemp(path.join(tmpdir(), "agora-chat-migrate-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  /** One value, from a statement finalized at once (an open statement holds the file on Windows). @param {any} db @param {string} sql */
  const one = (db, sql) => { const st = db.prepare(sql); try { return Object.values(st.get() ?? {})[0]; } finally { st.finalize(); } };
  const epoch = "a".repeat(32);
  // a version-1 store as the earlier build left it: the trailer block in the searchable text
  const v1 = await openKitStore(dir);
  v1.db.run("pragma user_version = 1");
  v1.db.run("insert into meta (key, value) values ('index_epoch', ?), ('index_through', ?)", epoch, `${epoch}:4`);
  v1.db.run("insert into messages (id, seq, cursor, ts, thread, author_kind, author_name, json) values ('m1', 4, ?, '2026-10-09T14:00:00Z', null, 'human', 'Ada', '{}')", `${epoch}:4`);
  v1.db.run("insert into message_fts (id, thread, text, files) values ('m1', 'm1', 'the tank context: zone=north', '')");
  v1.db.run("insert into reactions (target, name, person, at) values ('m1', 'seen', 'p-ada', '2026-10-09T14:01:00Z')");
  v1.db.run("insert into positions (person, thread, cursor, epoch, seq, at) values ('p-ada', 'main', ?, ?, 4, '2026-10-09T14:01:00Z')", `${epoch}:4`, epoch);
  assert.equal(one(v1.db, "pragma user_version"), 1);
  v1.close();

  const v2 = await openKitStore(dir);
  try {
    assert.equal(one(v2.db, "pragma user_version"), 2);
    assert.equal(one(v2.db, "select count(*) from meta where key in ('index_epoch', 'index_through')"), 0, "the next open rebuilds the index from the room");
    assert.equal(one(v2.db, "select count(*) from message_fts"), 0);
    assert.equal(one(v2.db, "select count(*) from messages"), 0);
    assert.equal(one(v2.db, "select count(*) from reactions"), 1, "reactions are kept");
    assert.equal(one(v2.db, "select count(*) from positions"), 1, "read positions are kept");
  } finally { v2.close(); }
});

test("search leaves out threads the reader may not read", SLOW, async (t) => {
  const k = await setup(t);
  const a = await k.call("p-ada", "/chat/post", { text: "the hidden ledger" });
  const id = a.body.data.receipt.id;
  await k.indexed(id);
  assert.equal((await k.call("p-grace", "/chat/search?q=ledger")).body.data.hits.length, 1);
  k.denyThread(id);
  assert.equal((await k.call("p-grace", "/chat/search?q=ledger")).body.data.hits.length, 0, "the host no longer lets Grace read it");
  assert.equal((await k.call("p-ada", "/chat/search?q=ledger")).body.data.hits.length, 1);
  const up = await k.upload("p-ada", png(), { "x-file-name": "ledger.png", "content-type": "image/png" });
  const att = up.body.data.attachment;
  const reply = await k.call("p-ada", "/chat/post", { text: "the ledger photo", thread: id, attachments: [att] });
  await k.indexed(reply.body.data.receipt.id);
  assert.equal((await k.call("p-grace", `/chat/file/${att.id}?digest=${encodeURIComponent(att.digest)}`)).status, 404, "nor its files");
  assert.equal((await k.call("p-ada", `/chat/file/${att.id}?digest=${encodeURIComponent(att.digest)}`)).status, 200);
});

test("purge through the kit: authorized, the index forgets at once, the file and thumbnail go, streams hear it", SLOW, async (t) => {
  const k = await setup(t, { deny: new Set(["p-grace:purge"]) });
  const root = await k.call("p-ada", "/chat/post", { text: "the thread about the photo" });
  const rootId = root.body.data.receipt.id;
  const bytes = png();
  const up = await k.upload("p-ada", bytes, { "x-file-name": "photo.png", "content-type": "image/png" });
  const att = up.body.data.attachment;
  assert.equal((await k.upload("p-ada", png(), { "x-thumb-for": att.digest })).status, 200);
  const reply = await k.call("p-ada", "/chat/post", { text: "the photo with the serial number", thread: rootId, attachments: [att] });
  const replyId = reply.body.data.receipt.id;
  const other = await k.call("p-ada", "/chat/post", { text: "an unrelated serial question" });
  await k.indexed(other.body.data.receipt.id);
  const main = await k.stream("p-grace", "thread=main");
  const elsewhere = await k.stream("p-grace", `thread=${other.body.data.receipt.id}`);
  assert.equal((await k.call("p-ada", "/chat/search?q=serial")).body.data.hits.length, 2);

  assert.equal((await k.call("p-grace", "/chat/purge", { targets: [replyId], reason: "not mine to purge" })).status, 403);
  assert.equal((await k.call("p-ada", "/chat/purge", { targets: [replyId] })).status, 400, "a reason is required");
  assert.equal((await k.call("p-ada", "/chat/purge", { reason: "nothing named" })).status, 400);
  const purged = await k.call("p-ada", "/chat/purge", { targets: [replyId], reason: "the serial number is private", operationId: "purge-draft-1" });
  assert.equal(purged.status, 200, JSON.stringify(purged.body));
  assert.deepEqual(purged.body.data.purged, [replyId]);
  assert.deepEqual(purged.body.data.facesOutOfReach, []);

  // at once, before the follow says anything
  const hits = (await k.call("p-ada", "/chat/search?q=serial")).body.data.hits.map((/** @type {any} */ h) => h.message.id);
  assert.deepEqual(hits, [other.body.data.receipt.id], "the purged reply is gone from search");
  assert.equal((await k.call("p-ada", `/chat/file/${att.id}?digest=${encodeURIComponent(att.digest)}`)).status, 404, "its file is 404, the uploader included");
  assert.equal((await k.call("p-ada", `/chat/thumb/${encodeURIComponent(att.digest)}`)).status, 404, "its thumbnail is gone");
  const list = (await k.call("p-ada", "/chat/threads")).body.data.threads.find((/** @type {any} */ s) => s.root.id === rootId);
  assert.equal(list.last.id, replyId);
  assert.equal(list.last.text, "", "the thread list's last line shows no purged words");

  const ev = /** @type {any} */ (await main.until(() => main.of("purge").find((e) => e.data.purged.includes(replyId)), "the purge on main")).data;
  assert.equal(ev.reason, "the serial number is private");
  assert.equal(ev.by.name, "Ada Byron");
  assert.equal(ev.via, undefined);
  const mainPurge = main.of("purge").find((e) => e.data.purged.includes(replyId));
  assert.equal(mainPurge?.id, ev.cursor, "id: is the purge's cursor");
  // a later post proves the other thread's stream was past the purge without hearing it
  await k.call("p-ada", "/chat/post", { text: "later in the other thread", thread: other.body.data.receipt.id });
  await elsewhere.until(() => elsewhere.of("message").some((e) => e.data.text?.startsWith("later in the other")), "the later reply");
  assert.equal(elsewhere.of("purge").length, 0, "a thread's stream hears nothing of a purge that took none of it");

  // a resend under the same draft id answers the same purge
  const resent = await k.call("p-ada", "/chat/purge", { targets: [replyId], reason: "the serial number is private", operationId: "purge-draft-1" });
  assert.equal(resent.status, 200, JSON.stringify(resent.body));
  assert.equal(resent.body.data.receipt.id, purged.body.data.receipt.id);
  assert.equal(resent.body.data.receipt.duplicate, true);
});

test("a purge made by another app reaches the kit's index and its thread streams", SLOW, async (t) => {
  const k = await setup(t);
  const root = await k.call("p-ada", "/chat/post", { text: "a thread to clear" });
  const rootId = root.body.data.receipt.id;
  const reply = await k.call("p-grace", "/chat/post", { text: "a reply with a token-like word zebracode", thread: rootId });
  const replyId = reply.body.data.receipt.id;
  await k.indexed(replyId);
  const s = await k.stream("p-ada", `thread=${rootId}`);
  assert.equal((await k.call("p-ada", "/chat/search?q=zebracode")).body.data.hits.length, 1);
  const r = await k.agent.purge(k.seat.alias, { thread: rootId, reason: "cleared by the other app", author: { kind: "agent", name: "Resident/watch" } });
  assert.deepEqual([...r.purged].sort(), [rootId, replyId].sort());
  const ev = /** @type {any} */ (await s.until(() => s.of("purge")[0], "the purge on the thread's stream")).data;
  assert.deepEqual([...ev.purged].sort(), [rootId, replyId].sort());
  assert.equal(ev.thread, rootId);
  assert.equal((await k.call("p-ada", "/chat/search?q=zebracode")).body.data.hits.length, 0, "the index forgot it when the record arrived");
  assert.equal((await k.call("p-ada", "/chat/search?q=clear")).body.data.hits.length, 0);
});

test("a purge made while the kit was down reaches its index when it starts again", SLOW, async (t) => {
  const k = await setup(t);
  const up = await k.upload("p-ada", png(), { "x-file-name": "gauge.png", "content-type": "image/png" });
  const att = up.body.data.attachment;
  const post = await k.call("p-ada", "/chat/post", { text: "the gauge reading quixotic", attachments: [att] });
  const id = post.body.data.receipt.id;
  const keep = await k.call("p-ada", "/chat/post", { text: "an older quixotic note that stays" });
  await k.indexed(keep.body.data.receipt.id);
  const fileUrl = `/chat/file/${att.id}?digest=${encodeURIComponent(att.digest)}`;
  assert.equal((await k.call("p-grace", fileUrl)).status, 200);
  assert.equal((await k.call("p-ada", "/chat/search?q=quixotic")).body.data.hits.length, 2);

  await k.down();
  const r = await k.agent.purge(k.seat.alias, { targets: [id], reason: "removed while the kit was away", author: { kind: "agent", name: "Resident/watch" } });
  assert.deepEqual(r.purged, [id]);
  await k.agent.append(k.seat.alias, { text: "written while the kit was away", author: { kind: "agent", name: "Resident/watch" } });
  await k.up();
  /** @type {string[]} */
  const heard = [];
  k.chat.on("message", (m) => { heard.push(String(m.text)); });

  const end = Date.now() + 20_000;
  let hits = [];
  for (;;) {
    hits = (await k.call("p-ada", "/chat/search?q=quixotic")).body.data?.hits ?? [];
    if (hits.length === 1 || Date.now() > end) break;
    await new Promise((res) => setTimeout(res, 50));
  }
  assert.deepEqual(hits.map((/** @type {any} */ h) => h.message.id), [keep.body.data.receipt.id], "search no longer finds the purged words");
  assert.equal((await k.call("p-grace", fileUrl)).status, 404, "and its file is gone");
  const row = (await k.call("p-ada", "/chat/threads")).body.data.threads.find((/** @type {any} */ x) => x.root.id === id);
  assert.equal(row.root.text, "", "the thread list shows no purged words");
  // the replay re-delivers nothing as news: only a message written after the start is heard
  await k.agent.append(k.seat.alias, { text: "written after the start", author: { kind: "agent", name: "Resident/watch" } });
  const until = Date.now() + 20_000;
  while (!heard.includes("written after the start") && Date.now() < until) await new Promise((res) => setTimeout(res, 50));
  assert.deepEqual(heard.filter((x) => !x.startsWith("written after the start")), [], "nothing from before the start is emitted again");
  assert.ok(heard.some((x) => x.startsWith("written after the start")));
});
