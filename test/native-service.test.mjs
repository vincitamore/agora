// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NativeRoomService, NativeServiceClient } from "../src/native-service.mjs";

const ROOM = "4".repeat(32);
const EPOCH = "5".repeat(32);
const ACCOUNT = "seat_account_0001";

/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-native-service-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new NativeRoomService({ root, accountId: ACCOUNT, seatLabel: "admin-pc" });
  const endpoint = await service.start();
  await service.createRoom({ roomId: ROOM, epoch: EPOCH });
  t.after(() => service.stop());
  return { root, service, endpoint };
}

test("one seat service fans a committed event to independent local subscribers", async (t) => {
  const { endpoint } = await fixture(t);
  const a = await NativeServiceClient.connect(/** @type {any} */ (endpoint));
  const b = await NativeServiceClient.connect(/** @type {any} */ (endpoint));
  t.after(() => { a.close(); b.close(); });
  /** @type {(message: any) => void} */ let resolveA;
  /** @type {(message: any) => void} */ let resolveB;
  const seenA = new Promise((resolve) => { resolveA = resolve; });
  const seenB = new Promise((resolve) => { resolveB = resolve; });
  await Promise.all([
    a.subscribe(ROOM, `${EPOCH}:0`, (message) => resolveA(message)),
    b.subscribe(ROOM, `${EPOCH}:0`, (message) => resolveB(message)),
  ]);
  const receipt = await a.request("append", { roomId: ROOM, operation: {
    operationId: "operation_service_01", authorName: "Sol/codex", text: "hello",
  } });
  assert.equal(receipt.cursor, `${EPOCH}:1`);
  const [messageA, messageB] = await Promise.all([seenA, seenB]);
  assert.equal(/** @type {any} */ (messageA).id, "operation_service_01");
  assert.deepEqual(messageA, messageB);
  assert.equal(/** @type {any} */ (messageA).author.id, ACCOUNT);
});

test("a later local session replays host-accepted messages from its own cursor", async (t) => {
  const { endpoint } = await fixture(t);
  const writer = await NativeServiceClient.connect(/** @type {any} */ (endpoint));
  t.after(() => writer.close());
  await writer.request("append", { roomId: ROOM, operation: {
    operationId: "operation_replay_001", authorName: "Sol/codex", text: "kept",
  } });
  const reader = await NativeServiceClient.connect(/** @type {any} */ (endpoint));
  t.after(() => reader.close());
  const result = await reader.request("read", { roomId: ROOM, since: `${EPOCH}:0` });
  assert.deepEqual(result.messages.map((/** @type {any} */ message) => message.text), ["kept"]);
  assert.equal(result.checkpoint.sequence, 1);
});

test("stable retries through the service reconcile an unknown receipt without a second append", async (t) => {
  const { endpoint } = await fixture(t);
  const client = await NativeServiceClient.connect(/** @type {any} */ (endpoint));
  t.after(() => client.close());
  const operation = { operationId: "operation_unknown_01", authorName: "Sol/codex", text: "once" };
  const first = await client.request("append", { roomId: ROOM, operation });
  const retry = await client.request("append", { roomId: ROOM, operation });
  assert.equal(first.cursor, retry.cursor);
  assert.equal(retry.duplicate, true);
  const read = await client.request("read", { roomId: ROOM, since: `${EPOCH}:0` });
  assert.equal(read.messages.length, 1);
});

test("concurrent first access opens one room store rather than two writers", async (t) => {
  const { service } = await fixture(t);
  await service.rooms.get(ROOM)?.close();
  service.rooms.delete(ROOM);
  const [a, b] = await Promise.all([service.openRoom(ROOM), service.openRoom(ROOM)]);
  assert.strictEqual(a, b);
});

test("the local nonce and single-service lock fail closed", async (t) => {
  const { root, service, endpoint } = await fixture(t);
  await assert.rejects(NativeServiceClient.connect({ .../** @type {any} */ (endpoint), nonce: "wrong_nonce_00001" }), /hello-refused/);
  const second = new NativeRoomService({ root, accountId: ACCOUNT, seatLabel: "admin-pc" });
  await assert.rejects(second.start(), /service lock already exists/);
  await service.stop();
  await assert.rejects(NativeServiceClient.connect(/** @type {any} */ (endpoint)), /ECONNREFUSED|closed|dark/);
});
