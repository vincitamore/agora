// @ts-check
// The holder the store keeps is the holder the board kernel named. Before this, the act handed to
// the kernel carried a placeholder lease and the store rebuilt the holder from its own arithmetic,
// so Applied{holder} was consulted for its class and discarded (laws 3 and 7 were proved about a
// value the product never kept). Now the real lease goes to the kernel, the record's expiry is the
// kernel's, the kernel's fence must be the record's own cursor, and a reopen re-derives from the
// record exactly what the kernel decided.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeRoomStore } from "../src/native-store.mjs";

const HOST = "a0e7ad17c2dee02fc4cee4fcd6a04a9a";
const PEER = "b1b1c2c2d3d3e4e4f5f5a6a6b7b7c8c8";
const ROOM = "c0c0a5e5c0c0a5e5c0c0a5e5c0c0a5e5";
/** @param {number} n */
const OP = (n) => `operation_holder_${String(n).padStart(6, "0")}`;

/** @param {import("node:test").TestContext} t @param {number} [start] */
async function room(t, start = Date.UTC(2026, 8, 18, 12, 0, 0)) {
  const root = await mkdtemp(join(tmpdir(), "agora-verdict-holder-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let clock = start;
  const now = () => new Date(clock);
  const store = await NativeRoomStore.create({ root, roomId: ROOM, hostAccountId: HOST, now });
  t.after(() => store.close());
  return { root, store, now, tick: (/** @type {number} */ ms) => { clock += ms; } };
}

test("a claim's stored expiry is the kernel's: now plus the lease the store asked for, not a placeholder", async (/** @type {import("node:test").TestContext} */ t) => {
  const { store, now } = await room(t);
  const claimed = await store.append({ kind: "board", operationId: OP(1), payload: { action: "claim", subject: "work:a", leaseMs: 5_000 } }, { accountId: HOST });
  const [h] = store.board();
  assert.equal(h.subject, "work:a");
  assert.equal(h.expiresAt, new Date(now().getTime() + 5_000).toISOString(), "expiry is now + the asked lease");
  assert.equal(h.leaseMs, 5_000);
  assert.equal(h.fence, claimed.cursor, "the kernel fenced the claim at this record's cursor");
  assert.equal(h.leaseId, OP(1), "the lease id is the claim's operation");
  assert.equal(h.accountId, HOST);
});

test("a renew's stored expiry extends from now by the asked lease, and re-fences at the renew's cursor", async (/** @type {import("node:test").TestContext} */ t) => {
  const { store, now, tick } = await room(t);
  await store.append({ kind: "board", operationId: OP(1), payload: { action: "claim", subject: "work:a", leaseMs: 5_000 } }, { accountId: HOST });
  const [before] = store.board();
  tick(2_000);
  const renewed = await store.append({ kind: "board", operationId: OP(2), payload: { action: "renew", subject: "work:a", leaseId: OP(1), fence: before.fence, leaseMs: 9_000 } }, { accountId: HOST });
  const [after] = store.board();
  assert.equal(after.expiresAt, new Date(now().getTime() + 9_000).toISOString(), "the kernel's Nat.add(now, lease_ms) with the real lease");
  assert.equal(after.fence, renewed.cursor);
  assert.equal(after.leaseId, OP(1), "renew keeps the lease id");
});

test("a reopen re-derives from the record exactly the holder the kernel named", async (/** @type {import("node:test").TestContext} */ t) => {
  const { root, store, now } = await room(t);
  await store.append({ kind: "board", operationId: OP(1), payload: { action: "claim", subject: "work:a", leaseMs: 60_000 } }, { accountId: HOST });
  const [live] = store.board();
  await store.close();
  const reopened = await NativeRoomStore.open({ root, roomId: ROOM, now });
  t.after(() => reopened.close());
  assert.deepEqual(reopened.board(), [live], "the same holder, from the record alone");
});

test("release, a human break and a contest keep the kernel's reading: no holder, no holder, the stored holder", async (/** @type {import("node:test").TestContext} */ t) => {
  const { store } = await room(t);
  await store.append({ kind: "board", operationId: OP(1), payload: { action: "claim", subject: "work:a" } }, { accountId: HOST });
  const [h] = store.board();
  await store.append({ kind: "board", operationId: OP(2), payload: { action: "contest", subject: "work:a", because: "mine" } }, { accountId: PEER });
  assert.deepEqual(store.board(), [h], "a contest takes nothing");
  await store.append({ kind: "board", operationId: OP(3), payload: { action: "release", subject: "work:a", leaseId: h.leaseId, fence: h.fence } }, { accountId: HOST });
  assert.deepEqual(store.board(), [], "released");
  await store.append({ kind: "board", operationId: OP(4), payload: { action: "claim", subject: "work:b" } }, { accountId: PEER });
  await store.append({ kind: "board", operationId: OP(5), payload: { action: "break", subject: "work:b" }, authorKind: "human", authorName: "operator" }, { accountId: HOST });
  assert.deepEqual(store.board(), [], "broken by a human");
});

test("a lease the policy refuses never reaches the kernel", async (/** @type {import("node:test").TestContext} */ t) => {
  const { store } = await room(t);
  await assert.rejects(
    store.append({ kind: "board", operationId: OP(1), payload: { action: "claim", subject: "work:a", leaseMs: 999 } }, { accountId: HOST }),
    /native board lease must be 1000-|payload is invalid/,
  );
  assert.deepEqual(store.board(), []);
});
