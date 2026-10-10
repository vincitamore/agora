// @ts-check
// The custody half of durable attachments (docs/ATTACHMENTS.md), driven frame by frame through
// `handleAttachmentFrame` with a recording connection and a room directory in a temp root. The
// round trip through a real seat service and agora/client is test/client-attachments.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ATTACHMENT_LIMITS, assertDurableAttachments, custodyPath, handleAttachmentFrame, readDurableBlob } from "../src/native-attachments.mjs";
import { RENAME_RETRY } from "../src/native-store.mjs";
import { detectAttachmentType, durableAttachmentId } from "../src/protocol/attachment.mjs";

const ROOM = "a".repeat(32);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("IHDR-and-the-rest-of-a-png")]);
const digestOf = (/** @type {Uint8Array} */ b) => `sha256:${createHash("sha256").update(b).digest("hex")}`;
let seq = 0;
const rid = () => `request_${String(++seq).padStart(12, "0")}`;

/**
 * A room directory and a connection to drive frames on. `manifest` is what the store would hold.
 * @param {import('node:test').TestContext} t
 * @param {{ manifest?: any, limits?: Partial<Record<keyof typeof ATTACHMENT_LIMITS, number>>, now?: () => number, deps?: any }} [o]
 */
async function rig(t, o = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-attach-"));
  /** @type {EventEmitter[]} */
  const sockets = [];
  // close every connection first, so open uploads release their temp files, then remove the root
  t.after(async () => {
    for (const s of sockets) s.emit("close");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await rm(root, { recursive: true, force: true });
  });
  const directory = path.join(root, "native", "rooms", ROOM);
  await mkdir(directory, { recursive: true });
  const manifest = o.manifest ?? {};
  const connection = () => {
    const socket = new EventEmitter();
    sockets.push(socket);
    /** @type {Array<Record<string, any>>} */
    const sent = [];
    const context = { root, socket: /** @type {any} */ (socket), send: (/** @type {any} */ f) => { sent.push(f); return true; },
      openRoom: async (/** @type {string} */ id) => { assert.equal(id, ROOM); return { directory, manifest }; },
      ...(o.limits ? { limits: o.limits } : {}), ...(o.now ? { now: o.now } : {}), ...(o.deps ? { deps: o.deps } : {}) };
    /** One frame in; its answer out, or the refusal it threw. @param {Record<string, any>} frame */
    const call = async (frame) => {
      const requestId = rid();
      const before = sent.length;
      await handleAttachmentFrame(context, { protocol: "agora-native/1", requestId, ...frame });
      assert.equal(sent.length, before + 1, "exactly one answer per frame");
      const answer = sent.at(-1);
      assert.equal(answer?.requestId, requestId);
      return /** @type {Record<string, any>} */ (answer);
    };
    /** @param {Record<string, any>} frame */
    const refusedWith = async (frame) => {
      try { await call(frame); } catch (e) { return /** @type {any} */ (e).code ?? /** @type {any} */ (e).message; }
      assert.fail(`expected ${frame.type} to be refused`);
    };
    /** begin, every chunk, commit. @param {Uint8Array} bytes @param {Record<string, any>} [begin] */
    const upload = async (bytes, begin = {}) => {
      const ready = await call({ type: "attachment-begin", roomId: ROOM, name: "file.bin", size: bytes.length, digest: digestOf(bytes), ...begin });
      for (let off = 0; off < bytes.length; off += ready.chunkMax)
        await call({ type: "attachment-chunk", uploadId: ready.uploadId, offset: off, data: Buffer.from(bytes.subarray(off, off + ready.chunkMax)).toString("base64") });
      return (await call({ type: "attachment-commit", uploadId: ready.uploadId })).attachment;
    };
    return { socket, sent, context, call, refusedWith, upload };
  };
  /** What custody holds: installed blobs and temp files. */
  const held = async () => {
    try { return (await readdir(path.join(directory, "attachments"))).sort(); }
    catch { return []; }
  };
  return { root, directory, manifest, connection, held };
}

test("kind is the bytes' word: a PNG named .vsdx is an image, a text file named .png is a file", async (t) => {
  const r = await rig(t);
  const c = r.connection();
  const image = await c.upload(PNG, { name: "drawing.vsdx", mimetype: "application/vnd.ms-visio.drawing" });
  assert.deepEqual(image, { id: durableAttachmentId(ROOM, digestOf(PNG)), digest: digestOf(PNG), lifetime: "durable",
    name: "drawing.vsdx", kind: "image", size: PNG.length, mimetype: "image/png" });
  const text = Buffer.from("not a picture at all\n");
  const file = await c.upload(text, { name: "photo.png", mimetype: "image/png" });
  assert.equal(file.kind, "file");
  assert.equal(file.mimetype, "application/octet-stream", "a declared image type the bytes do not prove is not recorded");
  const csv = await c.upload(Buffer.from("a,b\n1,2\n"), { name: "t.csv", mimetype: "text/csv" });
  assert.equal(csv.mimetype, "text/csv", "a file keeps its declared non-image type");
  assert.deepEqual(await r.held(), [digestOf(text), digestOf(PNG), digestOf(Buffer.from("a,b\n1,2\n"))].map((d) => `sha256-${d.slice(7)}`).sort(), "installed blobs only, no temp left");
  const blob = custodyPath(r.directory, digestOf(PNG));
  assert.deepEqual(await readFile(blob), PNG);
  if (process.platform !== "win32") assert.equal((await stat(blob)).mode & 0o777, 0o600);
  for (const [bytes, kind, mime] of /** @type {const} */ ([
    [[0xff, 0xd8, 0xff, 0xe0], "image", "image/jpeg"], [[...Buffer.from("GIF89a")], "image", "image/gif"], [[...Buffer.from("GIF87a")], "image", "image/gif"],
    [[...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP")], "image", "image/webp"], [[...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WAVE")], "file", null],
    [[0x89, 0x50, 0x4e, 0x47], "file", null], [[], "file", null]]))
    assert.deepEqual(detectAttachmentType(Uint8Array.from(bytes)), { kind, mimetype: mime });
});

test("identical bytes are one blob and cost the quota once", async (t) => {
  const r = await rig(t, { manifest: { attachmentQuota: PNG.length } });
  const c = r.connection();
  const a = await c.upload(PNG, { name: "one.png" });
  const b = await c.upload(PNG, { name: "two.png" });
  assert.equal(a.id, b.id);
  assert.equal(b.name, "two.png");
  assert.equal((await r.held()).length, 1);
});

test("a digest mismatch, a short upload, a chunk past the size and a quota breach are refused and leave nothing installed", async (t) => {
  const r = await rig(t, { manifest: { attachmentQuota: 64 } });
  const c = r.connection();
  const bytes = Buffer.from("twenty bytes exactly");

  let ready = await c.call({ type: "attachment-begin", roomId: ROOM, name: "x", size: bytes.length, digest: digestOf(Buffer.from("other")) });
  await c.call({ type: "attachment-chunk", uploadId: ready.uploadId, offset: 0, data: bytes.toString("base64") });
  assert.equal(await c.refusedWith({ type: "attachment-commit", uploadId: ready.uploadId }), "attachment-digest-mismatch");
  assert.equal(await c.refusedWith({ type: "attachment-commit", uploadId: ready.uploadId }), "attachment-upload-unknown", "a refused commit drops the upload");
  assert.deepEqual(await r.held(), []);

  ready = await c.call({ type: "attachment-begin", roomId: ROOM, name: "x", size: bytes.length, digest: digestOf(bytes) });
  await c.call({ type: "attachment-chunk", uploadId: ready.uploadId, offset: 0, data: bytes.subarray(0, 10).toString("base64") });
  assert.equal(await c.refusedWith({ type: "attachment-commit", uploadId: ready.uploadId }), "attachment-size-mismatch");
  assert.deepEqual(await r.held(), []);

  ready = await c.call({ type: "attachment-begin", roomId: ROOM, name: "x", size: 4, digest: digestOf(bytes) });
  assert.equal(await c.refusedWith({ type: "attachment-chunk", uploadId: ready.uploadId, offset: 0, data: bytes.toString("base64") }), "attachment-size-mismatch");
  assert.equal(await c.refusedWith({ type: "attachment-chunk", uploadId: ready.uploadId, offset: 0, data: "QUJD" }), "attachment-upload-unknown", "a refused chunk drops the upload");
  assert.deepEqual(await r.held(), []);

  ready = await c.call({ type: "attachment-begin", roomId: ROOM, name: "x", size: 8, digest: digestOf(bytes) });
  assert.equal(await c.refusedWith({ type: "attachment-chunk", uploadId: ready.uploadId, offset: 4, data: "QUJD" }), "attachment-size-mismatch", "chunks arrive in order");
  ready = await c.call({ type: "attachment-begin", roomId: ROOM, name: "x", size: 8, digest: digestOf(bytes) });
  assert.equal(await c.refusedWith({ type: "attachment-chunk", uploadId: ready.uploadId, offset: 0, data: "QU!D" }), "attachment-size-mismatch", "not base64");

  assert.equal(await c.refusedWith({ type: "attachment-begin", roomId: ROOM, name: "x", size: 65, digest: digestOf(bytes) }), "attachment-quota");
  assert.deepEqual(await r.held(), [], "a refused begin opens no temp file");
  // two uploads that each fit cannot both take the same gap
  await c.call({ type: "attachment-begin", roomId: ROOM, name: "x", size: 40, digest: digestOf(Buffer.alloc(40)) });
  assert.equal(await c.refusedWith({ type: "attachment-begin", roomId: ROOM, name: "y", size: 40, digest: digestOf(Buffer.alloc(41)) }), "attachment-quota");
});

test("frames are bounded before anything sized by the request is allocated", async (t) => {
  const r = await rig(t);
  const c = r.connection();
  assert.equal(await c.refusedWith({ type: "attachment-begin", roomId: ROOM, name: "big", size: ATTACHMENT_LIMITS.maxBytes + 1, digest: digestOf(PNG) }), "attachment-too-large");
  assert.deepEqual(await r.held(), []);
  const ready = await c.call({ type: "attachment-begin", roomId: ROOM, name: "x", size: ATTACHMENT_LIMITS.maxBytes, digest: digestOf(PNG) });
  assert.equal(ready.chunkMax, 262144);
  // one byte past the encoded bound of a chunk is refused on its length, not decoded
  const over = "A".repeat(Math.ceil(ATTACHMENT_LIMITS.chunkMax / 3) * 4 + 4);
  assert.equal(await c.refusedWith({ type: "attachment-chunk", uploadId: ready.uploadId, offset: 0, data: over }), "attachment-size-mismatch");
  assert.equal(await c.refusedWith({ type: "attachment-read", roomId: ROOM, id: durableAttachmentId(ROOM, digestOf(PNG)), digest: digestOf(PNG), offset: 0, length: ATTACHMENT_LIMITS.chunkMax + 1 }), "attachment-too-large");
  // and at most four uploads in flight on one connection (the refused chunk dropped the first)
  for (let i = 0; i < 4; i++) await c.call({ type: "attachment-begin", roomId: ROOM, name: "x", size: 1, digest: digestOf(Buffer.from([i])) });
  assert.equal(await c.refusedWith({ type: "attachment-begin", roomId: ROOM, name: "x", size: 1, digest: digestOf(Buffer.from([9])) }), "attachment-quota");
  assert.ok(r.connection(), "another connection has its own four");
});

test("an upload not committed in time is expired, and its temp file removed", async (t) => {
  let clock = 1_000_000;
  const r = await rig(t, { now: () => clock });
  const c = r.connection();
  const ready = await c.call({ type: "attachment-begin", roomId: ROOM, name: "x", size: PNG.length, digest: digestOf(PNG) });
  await c.call({ type: "attachment-chunk", uploadId: ready.uploadId, offset: 0, data: PNG.toString("base64") });
  clock += ATTACHMENT_LIMITS.uploadTtlMs + 1;
  assert.equal(await c.refusedWith({ type: "attachment-commit", uploadId: ready.uploadId }), "attachment-upload-expired");
  assert.equal(await c.refusedWith({ type: "attachment-commit", uploadId: ready.uploadId }), "attachment-upload-expired", "the id stays known as expired");
  assert.equal(await c.refusedWith({ type: "attachment-commit", uploadId: "never_issued_0000" }), "attachment-upload-unknown");
  assert.deepEqual(await r.held(), []);

  // the timer drops it too, with nothing arriving
  const timed = await rig(t, { limits: { uploadTtlMs: 30 } });
  const d = timed.connection();
  const late = await d.call({ type: "attachment-begin", roomId: ROOM, name: "x", size: PNG.length, digest: digestOf(PNG) });
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(await timed.held(), []);
  assert.equal(await d.refusedWith({ type: "attachment-commit", uploadId: late.uploadId }), "attachment-upload-expired");
});

test("a closed connection takes its uploads with it", async (t) => {
  const r = await rig(t);
  const c = r.connection();
  await c.call({ type: "attachment-begin", roomId: ROOM, name: "x", size: PNG.length, digest: digestOf(PNG) });
  assert.equal((await r.held()).length, 1, "the temp file");
  c.socket.emit("close");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(await r.held(), []);
});

test("a crash between the temp write and the rename installs nothing", async (t) => {
  const crash = await rig(t, { deps: { rename: async () => { throw Object.assign(new Error("the process died here"), { code: "EIO" }); } } });
  const c = crash.connection();
  await assert.rejects(c.upload(PNG), /the process died here/);
  assert.deepEqual(await crash.held(), [], "no blob, and the temp file is removed");
  await assert.rejects(assertDurableAttachments(c.context, ROOM, [{ id: durableAttachmentId(ROOM, digestOf(PNG)), digest: digestOf(PNG), lifetime: "durable", name: "x", kind: "image", size: PNG.length, mimetype: "image/png" }]),
    (e) => /** @type {any} */ (e).code === "attachment-unknown");

  // a process that died outright leaves a temp file: never installed, never read, swept once stale
  const dead = await rig(t);
  await mkdir(path.join(dead.directory, "attachments"), { recursive: true });
  const leftover = path.join(dead.directory, "attachments", ".upload-deadbeefdeadbeef.tmp");
  await writeFile(leftover, PNG);
  const d = dead.connection();
  await assert.rejects(assertDurableAttachments(d.context, ROOM, [{ id: durableAttachmentId(ROOM, digestOf(PNG)), digest: digestOf(PNG), lifetime: "durable", name: "x", kind: "image", size: PNG.length, mimetype: "image/png" }]),
    (e) => /** @type {any} */ (e).code === "attachment-unknown");
  const old = new Date(Date.now() - ATTACHMENT_LIMITS.uploadTtlMs - 60_000);
  await utimes(leftover, old, old);
  await d.call({ type: "attachment-begin", roomId: ROOM, name: "y", size: 1, digest: digestOf(Buffer.from("z")) });
  assert.ok(!(await dead.held()).includes(".upload-deadbeefdeadbeef.tmp"), "swept by the next begin");
});

test("the rename retries the Windows sharing refusals RENAME_RETRY names, and no other", async (t) => {
  /** @type {string[]} */
  const slept = [];
  let refusals = 2;
  const flaky = await rig(t, { deps: { sleep: async (/** @type {number} */ ms) => { slept.push(String(ms)); },
    rename: async (/** @type {string} */ from, /** @type {string} */ to) => {
      if (refusals-- > 0) throw Object.assign(new Error("held open"), { code: "EPERM" });
      const { rename } = await import("node:fs/promises");
      await rename(from, to);
    } } });
  const installed = await flaky.connection().upload(PNG);
  assert.equal(installed.kind, "image");
  assert.deepEqual(slept, [String(RENAME_RETRY.baseDelayMs), String(RENAME_RETRY.baseDelayMs * 2)]);
  assert.deepEqual(await flaky.held(), [`sha256-${digestOf(PNG).slice(7)}`]);

  let attempts = 0;
  const stuck = await rig(t, { deps: { sleep: async () => {}, rename: async () => { attempts++; throw Object.assign(new Error("still held"), { code: "EBUSY" }); } } });
  await assert.rejects(stuck.connection().upload(PNG), /still held/);
  assert.equal(attempts, RENAME_RETRY.attempts);
  assert.deepEqual(await stuck.held(), []);
});

test("an append naming a durable attachment is checked against custody", async (t) => {
  const r = await rig(t);
  const c = r.connection();
  const image = await c.upload(PNG, { name: "p.png" });
  const ok = (/** @type {unknown[]} */ list) => assertDurableAttachments(c.context, ROOM, list);
  const code = (/** @type {unknown[]} */ list) => ok(list).then(() => "accepted", (e) => e.code ?? e.message);
  assert.equal(await code([image]), "accepted");
  assert.equal(await code([{ ...image, lifetime: "durable" }]), "accepted", "the lifetime is the durable marker it is checked by");
  const absent = Buffer.from("never uploaded");
  assert.equal(await code([{ ...image, id: durableAttachmentId(ROOM, digestOf(absent)), digest: digestOf(absent), size: absent.length }]), "attachment-unknown");
  assert.equal(await code([{ ...image, id: durableAttachmentId("b".repeat(32), image.digest) }]), "attachment-unknown", "another room's id");
  assert.equal(await code([{ ...image, size: image.size + 1 }]), "attachment-unknown", "a size the bytes do not have");
  assert.equal(await code([{ ...image, kind: "file", mimetype: "text/plain" }]), "attachment-unknown", "a kind the bytes do not have");
  assert.equal(await code([{ ...image, mimetype: "image/gif" }]), "attachment-unknown", "an image type the bytes do not have");
  assert.equal(await code(Array.from({ length: 11 }, () => image)), "attachment-quota", "ten per message");
  assert.equal(await code(Array.from({ length: 10 }, () => image)), "accepted");
  // metadata only (no lifetime) passes exactly as before, up to the store's own ceiling
  const meta = { id: "metadata_only_0001", name: "m", kind: "file", size: 1, digest: digestOf(absent) };
  assert.equal(await code(Array.from({ length: 12 }, () => meta)), "accepted");
  assert.equal(await code(/** @type {any} */ ("not a list")), "accepted", "the store refuses a non-list itself");
});

test("a read returns the installed bytes in bounded chunks, and an id that does not derive names nothing", async (t) => {
  const r = await rig(t, { limits: { chunkMax: 8 } });
  const c = r.connection();
  const bytes = randomBytes(20);
  const a = await c.upload(bytes);
  /** @type {Buffer[]} */
  const parts = [];
  for (let offset = 0, eof = false; !eof;) {
    const d = await c.call({ type: "attachment-read", roomId: ROOM, id: a.id, digest: a.digest, offset, length: 8 });
    assert.equal(d.size, 20);
    assert.equal(d.offset, offset);
    const got = Buffer.from(d.data, "base64");
    assert.ok(got.length <= 8);
    parts.push(got); offset += got.length; eof = d.eof;
  }
  assert.deepEqual(Buffer.concat(parts), bytes);
  assert.equal(await c.refusedWith({ type: "attachment-read", roomId: ROOM, id: "x".repeat(64), digest: a.digest, offset: 0, length: 8 }), "attachment-unknown");
  const absent = digestOf(Buffer.from("absent"));
  assert.equal(await c.refusedWith({ type: "attachment-read", roomId: ROOM, id: durableAttachmentId(ROOM, absent), digest: absent, offset: 0, length: 8 }), "attachment-unknown");
  assert.equal(await c.refusedWith({ type: "attachment-read", roomId: ROOM, id: a.id, digest: a.digest, offset: 21, length: 8 }), "attachment-size-mismatch");
});

test("readDurableBlob serves verified bytes and refuses a blob altered on disk", async (t) => {
  const r = await rig(t);
  const a = await r.connection().upload(PNG, { name: "p.png" });
  const blob = await readDurableBlob(r.directory, ROOM, a);
  assert.deepEqual([blob.bytes.equals(PNG), blob.kind, blob.mimetype, blob.path], [true, "image", "image/png", custodyPath(r.directory, a.digest)]);
  await writeFile(custodyPath(r.directory, a.digest), Buffer.concat([PNG, Buffer.from("x")]));
  await assert.rejects(readDurableBlob(r.directory, ROOM, a), (e) => /** @type {any} */ (e).code === "attachment-digest-mismatch");
  await assert.rejects(readDurableBlob(r.directory, ROOM, { ...a, id: "y".repeat(64) }), (e) => /** @type {any} */ (e).code === "attachment-unknown");
});
