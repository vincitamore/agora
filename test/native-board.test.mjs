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

/** @param {import('node:test').TestContext} t @param {{ now?: () => Date }} [opts] */
async function room(t, opts = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-native-board-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await NativeRoomStore.create({ root, roomId: ROOM, epoch: EPOCH, hostAccountId: HOST, now: opts.now });
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

test("two concurrent claims from the same account: one acquired, one refused", async (t) => {
  const { store } = await room(t);
  const results = await Promise.allSettled([
    store.append({ kind: "board", operationId: OP(1), payload: { action: "claim", subject: "work:same-seat" } }, { accountId: HOST }),
    store.append({ kind: "board", operationId: OP(2), payload: { action: "claim", subject: "work:same-seat" } }, { accountId: HOST }),
  ]);
  const won = results.filter((r) => r.status === "fulfilled");
  const lost = results.filter((r) => r.status === "rejected");
  assert.equal(won.length, 1, "same-account concurrent claims must not both acquire");
  assert.equal(lost.length, 1);
  const acquired = /** @type {any} */ (/** @type {PromiseFulfilledResult<any>} */ (won[0]).value);
  assert.equal(acquired.held, true);
  assert.equal(acquired.duplicate, false);
  assert.match(String(/** @type {PromiseRejectedResult} */ (lost[0]).reason.message), /is held at/);
  assert.equal(store.board().length, 1);
  assert.equal(store.board()[0].leaseId, acquired.leaseId);
});

test("a new claim from the holding account does not reacquire; renew is the refresh", async (t) => {
  const { store } = await room(t);
  const first = /** @type {any} */ (await store.append({ kind: "board", operationId: OP(1), payload: { action: "claim", subject: "work:renew" } }, { accountId: HOST }));
  await assert.rejects(
    store.append({ kind: "board", operationId: OP(2), payload: { action: "claim", subject: "work:renew" } }, { accountId: HOST }),
    /is held at/,
  );
  assert.equal(store.board()[0].leaseId, first.leaseId);
  const retry = /** @type {any} */ (await store.append({ kind: "board", operationId: OP(1), payload: { action: "claim", subject: "work:renew" } }, { accountId: HOST }));
  assert.equal(retry.duplicate, true);
  assert.equal(retry.cursor, first.cursor);
  await store.append({ kind: "board", operationId: OP(3), payload: { action: "renew", subject: "work:renew", leaseId: first.leaseId, fence: first.fence } }, { accountId: HOST });
  assert.equal(store.board()[0].leaseId, first.leaseId);
  assert.notEqual(store.board()[0].cursor, first.cursor);
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

test("an expired lease is acquired by a second claimant; a renewed one is not", async (t) => {
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  const { store } = await room(t, { now: () => new Date(now) });
  const first = /** @type {any} */ (await store.append({ kind: "board", operationId: OP(1), payload: { action: "claim", subject: "work:ttl", leaseMs: 1000 } }, { accountId: HOST }));
  assert.equal(first.held, true);
  now += 1001;
  const taken = /** @type {any} */ (await store.append({ kind: "board", operationId: OP(2), payload: { action: "claim", subject: "work:ttl" } }, { accountId: PEER }));
  assert.equal(taken.held, true);
  assert.equal(store.board()[0].accountId, PEER);
  const kept = /** @type {any} */ (await store.append({ kind: "board", operationId: OP(3), payload: { action: "claim", subject: "work:renew-ttl", leaseMs: 1000 } }, { accountId: HOST }));
  now += 500;
  await store.append({ kind: "board", operationId: OP(4), payload: { action: "renew", subject: "work:renew-ttl", leaseId: kept.leaseId, fence: kept.fence } }, { accountId: HOST });
  now += 600;
  await assert.rejects(
    store.append({ kind: "board", operationId: OP(5), payload: { action: "claim", subject: "work:renew-ttl" } }, { accountId: PEER }),
    /is held at/,
  );
  assert.equal(store.board().find((h) => h.subject === "work:renew-ttl")?.accountId, HOST);
});

test("a stale fence after renew is refused with the current fence named", async (t) => {
  const { store } = await room(t);
  const claim = /** @type {any} */ (await store.append({ kind: "board", operationId: OP(1), payload: { action: "claim", subject: "work:fence" } }, { accountId: HOST }));
  const renewed = /** @type {any} */ (await store.append({ kind: "board", operationId: OP(2), payload: { action: "renew", subject: "work:fence", leaseId: claim.leaseId, fence: claim.fence } }, { accountId: HOST }));
  assert.notEqual(renewed.fence, claim.fence);
  await assert.rejects(
    store.append({ kind: "board", operationId: OP(3), payload: { action: "release", subject: "work:fence", leaseId: claim.leaseId, fence: claim.fence } }, { accountId: HOST }),
    new RegExp(`fence is ${renewed.fence}`),
  );
  await store.append({ kind: "board", operationId: OP(4), payload: { action: "release", subject: "work:fence", leaseId: claim.leaseId, fence: renewed.fence } }, { accountId: HOST });
  assert.equal(store.board().length, 0);
});

test("break by an agent is refused; a human-kind break frees the subject", async (t) => {
  const { store } = await room(t);
  await store.append({ kind: "board", operationId: OP(1), payload: { action: "claim", subject: "work:break" } }, { accountId: HOST });
  await assert.rejects(
    store.append({ kind: "board", operationId: OP(2), payload: { action: "break", subject: "work:break" }, authorKind: "agent" }, { accountId: PEER }),
    /break is a human verb/,
  );
  await assert.rejects(
    store.append({ kind: "board", operationId: OP(3), payload: { action: "break", subject: "work:break" } }, { accountId: PEER }),
    /break is a human verb/,
  );
  assert.equal(store.board()[0].accountId, HOST);
  const broken = /** @type {any} */ (await store.append({ kind: "board", operationId: OP(4), payload: { action: "break", subject: "work:break" }, authorKind: "human", authorName: "Alex", session: "grok-test-session" }, { accountId: PEER }));
  assert.equal(broken.broken, true);
  assert.equal(broken.holder?.accountId, HOST);
  assert.deepEqual(broken.actor, { name: "Alex", kind: "human", session: "grok-test-session" });
  assert.equal(store.board().length, 0);
  const taken = /** @type {any} */ (await store.append({ kind: "board", operationId: OP(5), payload: { action: "claim", subject: "work:break" } }, { accountId: PEER }));
  assert.equal(taken.held, true);
});

test("contest reports the holder's expiry beside its cursor", async (t) => {
  const { store } = await room(t);
  const claim = /** @type {any} */ (await store.append({ kind: "board", operationId: OP(1), payload: { action: "claim", subject: "work:expiry-view" } }, { accountId: HOST }));
  const contest = /** @type {any} */ (await store.append({ kind: "board", operationId: OP(2), payload: { action: "contest", subject: "work:expiry-view", because: "Evidence differs." } }, { accountId: PEER }));
  assert.equal(contest.held, true);
  assert.equal(contest.holder?.accountId, HOST);
  assert.equal(contest.holder?.expiresAt, claim.expiresAt);
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
