// @ts-check
// Log version 2 (docs/ANNOTATIONS.md): the record digest commits to a message's text by its digest
// and leaves the text outside, a version 1 room is written and read exactly as before, and the
// committed boundary's generation names the log file a room opens.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NativeRoomStore, generationFile, textDigest } from "../src/native-store.mjs";
import { nativeDigest } from "../src/native-protocol.mjs";

const ROOM = "a".repeat(32), EPOCH = "b".repeat(32), ACCOUNT = "seat_account_0001";
const sha = (/** @type {string | Uint8Array} */ b) => createHash("sha256").update(b).digest("hex");

/** @param {import('node:test').TestContext} t */
async function tempRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-v2-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** A clock that moves one second per read, so every byte a room writes is reproducible. */
function clock() {
  let tick = Date.parse("2026-01-01T00:00:00.000Z");
  return () => new Date(tick += 1000);
}

/** @param {string} root */
const roomDir = (root) => path.join(root, "native", "rooms", ROOM);

/**
 * Read a room's framed log, let `edit` change the parsed records, and write it back with every frame
 * re-sealed (length and checksum) and the boundary's `end` moved to match, so the store's own checks
 * are what decide: the frame checksum passes, and the record-level check is what refuses.
 * @param {string} root @param {(records: any[]) => void} edit @param {string} [file]
 */
async function rewriteLog(root, edit, file = "room.frames") {
  const bytes = await readFile(path.join(roomDir(root), file));
  /** @type {any[]} */
  const records = [];
  for (let at = 0; at < bytes.length;) {
    const length = bytes.readUInt32BE(at);
    records.push(JSON.parse(bytes.subarray(at + 4, at + 4 + length).toString("utf8")));
    at += 4 + length + 32;
  }
  edit(records);
  const frames = records.map((r) => {
    const payload = Buffer.from(JSON.stringify(r), "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length, 0);
    return Buffer.concat([header, payload, createHash("sha256").update(payload).digest()]);
  });
  const out = Buffer.concat(frames);
  await writeFile(path.join(roomDir(root), file), out);
  const boundaryPath = path.join(roomDir(root), "committed.json");
  const boundary = JSON.parse(await readFile(boundaryPath, "utf8"));
  await writeFile(boundaryPath, JSON.stringify({ ...boundary, end: out.length }, null, 2) + "\n");
}

test("a version 1 room is written and read byte for byte as the build before log version 2 wrote and read it", async (t) => {
  const root = await tempRoot(t);
  const now = clock();
  const store = await NativeRoomStore.create({ root, roomId: ROOM, epoch: EPOCH, hostAccountId: ACCOUNT, now });
  assert.equal(store.logVersion, 1, "a caller that names no version gets version 1");
  const root1 = await store.append({ operationId: "op_v1_bytes_0001", authorName: "Ada", authorKind: "human", text: "hello\n-- Ada" }, { accountId: ACCOUNT });
  await store.append({ operationId: "op_v1_bytes_0002", authorName: "Bea", authorKind: "agent", text: "a reply", thread: root1.id,
    attachments: [{ id: "attachment_00000001", name: "a.png", kind: "image", size: 3, digest: `sha256:${"c".repeat(64)}`, mimetype: "image/png", width: 1, height: 1 }] },
    { accountId: ACCOUNT, via: "example-app" });
  await store.append({ kind: "board", operationId: "op_v1_bytes_0003", payload: { action: "claim", subject: "work:unit-a" } }, { accountId: ACCOUNT });
  await store.append({ operationId: "op_v1_bytes_0004", authorName: "Cy", authorKind: "human", authorRef: "person.1", text: "third" }, { accountId: ACCOUNT, via: "example-app" });
  await store.close();
  const reopened = await NativeRoomStore.open({ root, roomId: ROOM, now });
  t.after(() => reopened.close());
  const dir = roomDir(root);
  /** @param {any} v */
  const reads = (v) => sha(JSON.stringify({ messages: v.messages, through: v.through }));
  // measured by running this same sequence on the build before log version 2 (agora 03dcae5)
  assert.deepEqual({
    roomJson: sha((await readFile(path.join(dir, "room.json"), "utf8")).replace(/"createdAt": "[^"]*"/, "")),
    committed: sha(await readFile(path.join(dir, "committed.json"))),
    frames: sha(await readFile(path.join(dir, "room.frames"))),
    view: reads(reopened.view()),
    since: reads(reopened.view({ since: `${EPOCH}:1` })),
    thread: reads(reopened.view({ thread: root1.id })),
  }, {
    roomJson: "acafddfa7186b8a6b8574825976e190eec4369961ff4e1da47a992c29b51bfa3",
    committed: "29cdd229e5f03cffa1e2ba170d1f94651f40b0f419e5972f0b1462c3342de290",
    frames: "384701623098c0527e0b1ecf21baa0715338643f654738827c1c01646aad3ea1",
    view: "42c21f9cfbd88dd3dc69bdbb8de350228415abca3611ba51ada747544d729780",
    since: "f449e8791197bbff058749cadaa84db4517d25b021c73e68f7e09f9789a3e7e4",
    thread: "991070c97d5783fab7343658ea0f77bc0033ab1c100404ab9783ae5ccd0517bd",
  });
  assert.deepEqual(reopened.view().annotations, [], "a version 1 room carries no annotations");
  assert.equal(reopened.status().logVersion, 1);
});

test("a version 2 room: the record digest covers the text's digest, not the text, and a reader never sees the digest", async (t) => {
  const root = await tempRoot(t);
  const store = await NativeRoomStore.create({ root, roomId: ROOM, epoch: EPOCH, hostAccountId: ACCOUNT, logVersion: 2, now: clock() });
  t.after(() => store.close());
  const manifest = JSON.parse(await readFile(path.join(roomDir(root), "room.json"), "utf8"));
  assert.equal(manifest.logVersion, 2);
  assert.equal(JSON.parse(await readFile(path.join(roomDir(root), "committed.json"), "utf8")).generation, 0);
  const text = "the words, café ✓";
  const receipt = await store.append({ operationId: "op_v2_digest_0001", authorName: "Ada", authorKind: "human", text }, { accountId: ACCOUNT });
  const record = store.records[0];
  assert.equal(record.version, 2);
  assert.equal(record.message.textDigest, `sha256:${sha(Buffer.from(text, "utf8"))}`);
  assert.equal(record.message.textDigest, textDigest(text));
  const { recordDigest, ...unsigned } = record;
  const { text: _text, ...withoutText } = unsigned.message;
  assert.equal(recordDigest, nativeDigest({ ...unsigned, message: withoutText }), "the digest is over the record with message.text removed");
  assert.notEqual(recordDigest, nativeDigest(unsigned), "the text itself is outside the digest");
  assert.equal(record.payloadDigest, nativeDigest({ accountId: ACCOUNT, authorName: "Ada", authorKind: "human", textDigest: textDigest(text) }),
    "the payload digest names the text by its digest too");
  const [read] = store.read();
  assert.equal(read.text, text);
  assert.equal("textDigest" in read, false);
  assert.equal(read.id, receipt.id);
  // an identical resend is the original receipt; different text under the same id is refused
  assert.deepEqual(await store.append({ operationId: "op_v2_digest_0001", authorName: "Ada", authorKind: "human", text }, { accountId: ACCOUNT }),
    { id: receipt.id, cursor: receipt.cursor, duplicate: true });
  await assert.rejects(store.append({ operationId: "op_v2_digest_0001", authorName: "Ada", authorKind: "human", text: "other" }, { accountId: ACCOUNT }),
    /already committed with different bytes/);
  // board records in a version 2 room are version 2 as well, and the room reopens
  await store.append({ kind: "board", operationId: "op_v2_digest_0002", payload: { action: "claim", subject: "work:unit-a" } }, { accountId: ACCOUNT });
  assert.equal(store.records[1].version, 2);
  assert.equal(store.status().logVersion, 2);
});

test("a version 2 room refuses to open on a tampered text, a missing text, or a missing text digest", async (t) => {
  /** @param {(records: any[]) => void} edit @param {RegExp} refusal */
  const refusesAfter = async (edit, refusal) => {
    const root = await tempRoot(t);
    const store = await NativeRoomStore.create({ root, roomId: ROOM, epoch: EPOCH, hostAccountId: ACCOUNT, logVersion: 2, now: clock() });
    await store.append({ operationId: "op_v2_tamper_0001", authorName: "Ada", authorKind: "human", text: "original" }, { accountId: ACCOUNT });
    await store.append({ operationId: "op_v2_tamper_0002", authorName: "Ada", authorKind: "human", text: "second" }, { accountId: ACCOUNT });
    await store.close();
    // untouched, it opens
    const fine = await NativeRoomStore.open({ root, roomId: ROOM });
    await fine.close();
    await rewriteLog(root, edit);
    await assert.rejects(async () => { const s = await NativeRoomStore.open({ root, roomId: ROOM }); await s.close(); }, refusal);
  };
  // the same length, so only the text check can see it: the frame checksum is re-sealed and the
  // record digest never covered the text
  await refusesAfter((r) => { r[0].message.text = "0riginal"; }, /sequence 1 carries a text that does not match its text digest/);
  await refusesAfter((r) => { delete r[1].message.text; }, /sequence 2 has no text and no purge names it/);
  await refusesAfter((r) => { r[0].message.text = 7; }, /does not match its text digest/);
  await refusesAfter((r) => { delete r[0].message.textDigest; }, /carries no text digest/);
  await refusesAfter((r) => { r[0].kind = "mystery"; }, /unknown kind/);
  await refusesAfter((r) => { r[1].version = 1; }, /another room or protocol version/);
});

test("the boundary's generation names the log file: absent is room.frames, N is room.frames.N; a version 1 room stays at 0", async (t) => {
  assert.equal(generationFile(0), "room.frames");
  assert.equal(generationFile(3), "room.frames.3");
  const root = await tempRoot(t);
  const store = await NativeRoomStore.create({ root, roomId: ROOM, epoch: EPOCH, hostAccountId: ACCOUNT, logVersion: 2, now: clock() });
  await store.append({ operationId: "op_v2_generation_1", authorName: "Ada", authorKind: "human", text: "kept" }, { accountId: ACCOUNT });
  await store.close();
  const dir = roomDir(root);
  const boundaryPath = path.join(dir, "committed.json");
  const boundary = JSON.parse(await readFile(boundaryPath, "utf8"));
  // generation 1 is a copy of 0 here: what is read is the file the boundary names
  await copyFile(path.join(dir, "room.frames"), path.join(dir, "room.frames.1"));
  await writeFile(boundaryPath, JSON.stringify({ ...boundary, generation: 1 }, null, 2) + "\n");
  await writeFile(path.join(dir, "room.frames"), "");
  const opened = await NativeRoomStore.open({ root, roomId: ROOM, now: clock() });
  assert.equal(opened.generation, 1);
  assert.equal(opened.read()[0].text, "kept");
  // a commit on generation 1 goes to room.frames.1 and its boundary still names generation 1
  await opened.append({ operationId: "op_v2_generation_2", authorName: "Ada", authorKind: "human", text: "next" }, { accountId: ACCOUNT });
  await opened.close();
  assert.equal(JSON.parse(await readFile(boundaryPath, "utf8")).generation, 1);
  assert.equal((await readFile(path.join(dir, "room.frames"))).length, 0, "generation 0 was not written");
  const again = await NativeRoomStore.open({ root, roomId: ROOM });
  assert.deepEqual(again.read().map((m) => m.text), ["kept", "next"]);
  await again.close();

  for (const generation of [-1, 1.5, "1"]) {
    await writeFile(boundaryPath, JSON.stringify({ ...boundary, generation }, null, 2) + "\n");
    await assert.rejects(NativeRoomStore.open({ root, roomId: ROOM }), /invalid generation/);
  }

  // a version 1 room never names a generation above 0
  const v1root = await tempRoot(t);
  const v1 = await NativeRoomStore.create({ root: v1root, roomId: ROOM, epoch: EPOCH, hostAccountId: ACCOUNT, now: clock() });
  await v1.close();
  const v1boundary = path.join(roomDir(v1root), "committed.json");
  assert.equal("generation" in JSON.parse(await readFile(v1boundary, "utf8")), false, "a version 1 boundary carries no generation");
  await copyFile(path.join(roomDir(v1root), "room.frames"), path.join(roomDir(v1root), "room.frames.1"));
  await writeFile(v1boundary, JSON.stringify({ ...JSON.parse(await readFile(v1boundary, "utf8")), generation: 1 }, null, 2) + "\n");
  await assert.rejects(NativeRoomStore.open({ root: v1root, roomId: ROOM }), /generation above 0 in a version 1 room/);
});

test("a manifest's log version is 1, 2 or absent; create refuses any other", async (t) => {
  const root = await tempRoot(t);
  await assert.rejects(NativeRoomStore.create({ root, roomId: ROOM, epoch: EPOCH, hostAccountId: ACCOUNT, logVersion: /** @type {any} */ (3) }), /log version must be 1 or 2/);
  const store = await NativeRoomStore.create({ root, roomId: ROOM, epoch: EPOCH, hostAccountId: ACCOUNT, logVersion: 2 });
  await store.close();
  const manifestPath = path.join(roomDir(root), "room.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, logVersion: 3 }, null, 2) + "\n");
  await assert.rejects(NativeRoomStore.open({ root, roomId: ROOM }), /manifest is invalid/);
});

test("a durable attachment reads back with its lifetime; metadata without one reads back without one", async (t) => {
  const root = await tempRoot(t);
  const store = await NativeRoomStore.create({ root, roomId: ROOM, epoch: EPOCH, hostAccountId: ACCOUNT, logVersion: 2, now: clock() });
  t.after(() => store.close());
  const base = { name: "a.png", kind: "image", size: 3, digest: `sha256:${"c".repeat(64)}` };
  await store.append({ operationId: "op_v2_lifetime_01", authorName: "Ada", authorKind: "human", text: "two files",
    attachments: [{ id: "attachment_00000001", lifetime: "durable", ...base }, { id: "attachment_00000002", ...base }] }, { accountId: ACCOUNT });
  const [m] = store.read();
  assert.equal(m.attachments[0].lifetime, "durable");
  assert.equal("lifetime" in m.attachments[1], false);
  await assert.rejects(store.append({ operationId: "op_v2_lifetime_02", authorName: "Ada", authorKind: "human", text: "bad",
    attachments: [{ id: "attachment_00000003", lifetime: "forever", ...base }] }, { accountId: ACCOUNT }), /lifetime must be offer or durable/);
});
