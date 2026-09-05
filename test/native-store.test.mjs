// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NativeRoomStore } from "../src/native-store.mjs";

const ROOM = "1".repeat(32);
const EPOCH = "2".repeat(32);
const HOST = "seat_host_0000001";
const PEER = "seat_peer_0000001";

/** @param {import('node:test').TestContext} t */
async function room(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-native-room-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let tick = 0;
  const store = await NativeRoomStore.create({ root, roomId: ROOM, epoch: EPOCH, hostAccountId: HOST,
    now: () => new Date(Date.UTC(2026, 8, 5, 4, 0, tick++)) });
  t.after(() => store.close());
  return { root, store };
}

test("native room host serializes concurrent appends and assigns monotonic opaque cursors", async (t) => {
  const { store } = await room(t);
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => store.append({
    operationId: `operation_${String(i).padStart(8, "0")}`,
    authorName: "Peer/agent", text: `message ${i}`,
  }, { accountId: PEER })));
  assert.deepEqual(results.map((result) => result.cursor), Array.from({ length: 20 }, (_, i) => `${EPOCH}:${i + 1}`));
  const messages = store.read({ since: `${EPOCH}:0` });
  assert.equal(messages.length, 20);
  assert.deepEqual(messages.map((message) => message.cursor), results.map((result) => result.cursor));
  assert.ok(messages.every((message) => message.author.id === PEER), "identity comes from the authenticated route");
});

test("native room retries return the original receipt and conflicting reuse is refused", async (t) => {
  const { store } = await room(t);
  const input = { operationId: "operation_retry_001", authorName: "Peer/agent", text: "hello" };
  const first = await store.append(input, { accountId: PEER });
  const retry = await store.append(input, { accountId: PEER });
  assert.deepEqual(first, { id: input.operationId, cursor: `${EPOCH}:1`, duplicate: false });
  assert.deepEqual(retry, { id: input.operationId, cursor: `${EPOCH}:1`, duplicate: true });
  await assert.rejects(store.append({ ...input, text: "different" }, { accountId: PEER }), /already committed with different bytes/);
  assert.equal(store.status().committed, 1);
});

test("native room acceptance survives restart and reads never cross epochs or future positions", async (t) => {
  const { root, store } = await room(t);
  await store.append({ operationId: "operation_restart_1", authorName: "Peer", text: "one" }, { accountId: PEER });
  await store.close();
  const reopened = await NativeRoomStore.open({ root, roomId: ROOM });
  t.after(() => reopened.close());
  assert.equal(reopened.read({ since: `${EPOCH}:0` })[0].text, "one");
  assert.equal((await reopened.append({ operationId: "operation_restart_1", authorName: "Peer", text: "one" }, { accountId: PEER })).duplicate, true);
  assert.throws(() => reopened.read({ since: `${"3".repeat(32)}:0` }), /belongs to epoch/);
  assert.throws(() => reopened.read({ since: `${EPOCH}:99` }), /exceeds committed sequence/);
});

test("reader-held checkpoints witness an exact prefix rather than trusting a self-consistent log", async (t) => {
  const { store } = await room(t);
  await store.append({ operationId: "operation_anchor_01", authorName: "Peer", text: "one" }, { accountId: PEER });
  const anchor = store.checkpoint();
  await store.append({ operationId: "operation_anchor_02", authorName: "Peer", text: "two" }, { accountId: PEER });
  assert.deepEqual(store.assertCheckpoint(anchor), anchor, "a retained prefix survives later appends");
  assert.throws(() => store.assertCheckpoint({ ...anchor, digest: `sha256:${"f".repeat(64)}` }), /digest does not match/);
  assert.throws(() => store.assertCheckpoint({ ...anchor, epoch: "3".repeat(32) }), /another epoch/);
  assert.throws(() => store.assertCheckpoint({ ...anchor, sequence: 99 }), /sequence is unavailable/);
});

test("a partial final frame is an unaccepted tail; restart removes it and reports the recovery", async (t) => {
  const { root, store } = await room(t);
  await store.append({ operationId: "operation_tail_0001", authorName: "Peer", text: "kept" }, { accountId: PEER });
  const logPath = store.logPath;
  await store.close();
  await appendFile(logPath, Buffer.from([0, 0, 0, 100, 123, 34, 120]));
  const reopened = await NativeRoomStore.open({ root, roomId: ROOM });
  t.after(() => reopened.close());
  assert.equal(reopened.status().recoveredTailBytes, 7);
  assert.deepEqual(reopened.read().map((message) => message.text), ["kept"]);
});

test("a complete corrupted record is refused and never truncated as crash recovery", async (t) => {
  const { root, store } = await room(t);
  await store.append({ operationId: "operation_corrupt_1", authorName: "Peer", text: "kept" }, { accountId: PEER });
  const logPath = store.logPath;
  await store.close();
  const bytes = await readFile(logPath);
  bytes[bytes.length - 1] ^= 0xff;
  const handle = await open(logPath, "r+");
  await handle.write(bytes, 0, bytes.length, 0); await handle.close();
  await assert.rejects(NativeRoomStore.open({ root, roomId: ROOM }), /checksum mismatch/);
  assert.equal((await readFile(logPath)).length, bytes.length, "corruption evidence remains intact");
});

test("native attachment records carry receiver-verifiable metadata, never sender paths", async (t) => {
  const { store } = await room(t);
  const attachment = { id: "attachment_000001", name: "screen.png", kind: "image", size: 3, digest: `sha256:${"a".repeat(64)}`, path: "C:\\secret\\screen.png" };
  await assert.rejects(store.append({ operationId: "operation_attach_1", authorName: "Peer", text: "see", attachments: [attachment] }, { accountId: PEER }), /never store sender-local/);
  const { path: _senderPath, ...safe } = attachment;
  await store.append({ operationId: "operation_attach_2", authorName: "Peer", text: "see", attachments: [safe] }, { accountId: PEER });
  assert.deepEqual(store.read()[0].attachments, [safe]);
});
