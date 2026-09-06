// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NativeRoomStore } from "../src/native-store.mjs";

const ROOM = "1".repeat(32);
const EPOCH = "2".repeat(32);
const HOST = "seat_host_0000001";
const PEER = "seat_peer_0000001";
/** @param {number} n */
const OP = (n) => `operation_board_${String(n).padStart(3, "0")}`;

/** @param {import('node:test').TestContext} t */
async function room(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-native-board-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await NativeRoomStore.create({ root, roomId: ROOM, epoch: EPOCH, hostAccountId: HOST });
  t.after(() => store.close());
  return { root, store };
}

test("a claim is acquired inside the serialized append turn; a second account is refused with the holder", async (t) => {
  const { store } = await room(t);
  const first = /** @type {any} */ (await store.append({ kind: "board", operationId: OP(1), payload: { action: "claim", subject: "work:board" } }, { accountId: HOST }));
  assert.equal(first.held, true);
  assert.equal(first.duplicate, false);
  await assert.rejects(
    store.append({ kind: "board", operationId: OP(2), payload: { action: "claim", subject: "work:board" } }, { accountId: PEER }),
    /is held at/,
  );
  assert.equal(store.board()[0].accountId, HOST);
  assert.equal(store.read().length, 0, "board events are not chat messages");
});

test("two concurrent claims of an unheld subject: one acquired, one refused", async (t) => {
  const { store } = await room(t);
  const results = await Promise.allSettled([
    store.append({ kind: "board", operationId: OP(1), payload: { action: "claim", subject: "work:race" } }, { accountId: HOST }),
    store.append({ kind: "board", operationId: OP(2), payload: { action: "claim", subject: "work:race" } }, { accountId: PEER }),
  ]);
  const won = results.filter((r) => r.status === "fulfilled");
  const lost = results.filter((r) => r.status === "rejected");
  assert.equal(won.length, 1);
  assert.equal(lost.length, 1);
  assert.match(String(/** @type {PromiseRejectedResult} */ (lost[0]).reason.message), /is held at/);
  assert.equal(store.board().length, 1);
});

test("contest does not take the subject; release by the holder frees it", async (t) => {
  const { store } = await room(t);
  const claim = /** @type {any} */ (await store.append({ kind: "board", operationId: OP(1), payload: { action: "claim", subject: "work:contest" } }, { accountId: HOST }));
  const contest = /** @type {any} */ (await store.append({ kind: "board", operationId: OP(2), payload: { action: "contest", subject: "work:contest", because: "Evidence differs." } }, { accountId: PEER }));
  assert.equal(contest.held, true);
  assert.equal(contest.holder?.accountId, HOST);
  assert.equal(store.board()[0].accountId, HOST);
  await store.append({ kind: "board", operationId: OP(3), payload: { action: "release", subject: "work:contest", leaseId: claim.leaseId, fence: claim.fence } }, { accountId: HOST });
  assert.equal(store.board().length, 0);
  const taken = /** @type {any} */ (await store.append({ kind: "board", operationId: OP(4), payload: { action: "claim", subject: "work:contest" } }, { accountId: PEER }));
  assert.equal(taken.held, true);
});

test("reopen restores the holder; a chat append still reads without board rows", async (t) => {
  const { root, store } = await room(t);
  await store.append({ kind: "board", operationId: OP(1), payload: { action: "claim", subject: "work:persist" } }, { accountId: HOST });
  await store.append({ operationId: OP(2), authorName: "Host", text: "chat" }, { accountId: HOST });
  assert.equal(store.read().length, 1);
  assert.equal(store.read()[0].text, "chat");
  await store.close();
  const reopened = await NativeRoomStore.open({ root, roomId: ROOM });
  t.after(() => reopened.close());
  assert.equal(reopened.board()[0].accountId, HOST);
  assert.equal(reopened.read().length, 1);
});
