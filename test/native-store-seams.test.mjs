// @ts-check
// Pins for the kernel-seam survivors the consumer mutation sweep found in src/native-store.mjs
// (scripts/mutate-consumers.mjs): the lines between the store and the proven kernels that no
// importing test constrained. Each test names the mutant it kills; the equivalent mutants from
// the same class are listed at the end with why.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NativeRoomStore } from "../src/native-store.mjs";

const ROOM = "5".repeat(32);
const EPOCH = "6".repeat(32);
const HOST = "seat_host_0000001";
const PEER = "seat_peer_0000001";
/** @param {number} n */
const OP = (n) => `operation_seam_${String(n).padStart(4, "0")}`;

/** @param {import('node:test').TestContext} t @param {{ now?: () => Date, recordLimit?: number }} [opts] */
async function room(t, opts = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-store-seams-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await NativeRoomStore.create({ root, roomId: ROOM, epoch: EPOCH, hostAccountId: HOST, now: opts.now, ...(opts.recordLimit ? { recordLimit: opts.recordLimit } : {}) });
  t.after(() => store.close());
  return { root, store };
}
/** @param {NativeRoomStore} store @param {number} n @param {string} [account] */
const claim = (store, n, account = HOST, extra = {}) => /** @type {Promise<any>} */ (store.append({ kind: "board", operationId: OP(n), payload: { action: "claim", subject: "work:seam", ...extra } }, { accountId: account }));
/** @param {NativeRoomStore} store @param {number} n @param {string} text */
const post = (store, n, text = `m${n}`) => store.append({ operationId: OP(n), authorName: "A", authorKind: "agent", text }, { accountId: HOST });

test("the record limit admits exactly that many records, for messages and board acts alike (survivor 527: >= -> >)", async (t) => {
  const { store } = await room(t, { recordLimit: 2 });
  await post(store, 1);
  await claim(store, 2);
  await assert.rejects(post(store, 3), /reached its 2-record resident limit/);
  await assert.rejects(claim(store, 4, PEER, { subject: "work:other" }), /reached its 2-record resident limit/);
  assert.equal(store.status().committed, 2);
});

test("a stale fence is refused naming both the live fence and the one given (survivor 508: fenceNamed)", async (t) => {
  const { store } = await room(t);
  const first = await claim(store, 1);
  await store.append({ kind: "board", operationId: OP(2), payload: { action: "renew", subject: "work:seam", leaseId: first.leaseId, fence: first.fence } }, { accountId: HOST });
  const live = store.board()[0].fence;
  await assert.rejects(
    store.append({ kind: "board", operationId: OP(3), payload: { action: "release", subject: "work:seam", leaseId: first.leaseId, fence: first.fence } }, { accountId: HOST }),
    new RegExp(`fence is ${live}, not ${first.fence}`),
  );
});

test("a renew's receipt says held, and a human break's record carries the holder it dropped (survivors 549, 540)", async (t) => {
  const { store } = await room(t);
  const first = await claim(store, 1);
  const renewed = /** @type {any} */ (await store.append({ kind: "board", operationId: OP(2), payload: { action: "renew", subject: "work:seam", leaseId: first.leaseId, fence: first.fence } }, { accountId: HOST }));
  assert.equal(renewed.held, true);
  assert.equal(renewed.leaseId, first.leaseId);
  assert.equal(/** @type {any} */ (store.records.at(-1)).broken, undefined, "a renew over a held subject is not a break: no dropped holder on its record");
  const broken = /** @type {any} */ (await store.append({ kind: "board", operationId: OP(3), payload: { action: "break", subject: "work:seam" }, authorKind: "human", authorName: "Alex" }, { accountId: PEER }));
  assert.equal(broken.broken, true);
  assert.equal(broken.holder?.accountId, HOST);
  const record = /** @type {any} */ (store.records.at(-1));
  assert.equal(record.board.action, "break");
  assert.equal(record.broken?.accountId, HOST, "the record names the holder it dropped, so the log can be read without the receipt");
  assert.equal(record.actor?.kind, "human");
  assert.deepEqual(store.board(), []);
});

test("a lease is admitted from 1000 ms to the store's cap and refused past it (survivor 571: the cap; the floor is the payload validator's)", async (t) => {
  const { store } = await room(t);
  await assert.rejects(claim(store, 1, HOST, { leaseMs: 999 }), /payload is invalid \(protocol range at leaseMs\)/);
  const ok = await claim(store, 2, HOST, { leaseMs: 1000 });
  assert.equal(ok.held, true);
  await store.append({ kind: "board", operationId: OP(3), payload: { action: "release", subject: "work:seam", leaseId: ok.leaseId, fence: ok.fence } }, { accountId: HOST });
  await assert.rejects(claim(store, 4, HOST, { leaseMs: 86_400_001 }), /lease must be 1000-86400000 ms/);
  const capped = await claim(store, 5, HOST, { leaseMs: 86_400_000 });
  assert.equal(capped.held, true);
});

test("a read's limit is bounded 1..10000 (survivor 629)", async (t) => {
  const { store } = await room(t);
  await post(store, 1);
  assert.throws(() => store.read({ limit: 0 }), /read limit must be 1-10000/);
  assert.throws(() => store.read({ limit: 10_001 }), /read limit must be 1-10000/);
  assert.equal(store.read({ limit: 10_000 }).length, 1);
  assert.equal(store.read({ limit: 1 }).length, 1);
});

test("a checkpoint is bounded 0..committed, and one past the committed sequence is refused (survivors 664, 676)", async (t) => {
  const { store } = await room(t);
  await post(store, 1);
  await post(store, 2);
  assert.throws(() => store.checkpoint(-1), /between 0 and 2/);
  assert.throws(() => store.checkpoint(3), /between 0 and 2/);
  assert.equal(store.checkpoint(2).sequence, 2);
  assert.equal(store.checkpoint(0).digest, null);
  assert.throws(() => store.assertCheckpoint({ roomId: ROOM, epoch: EPOCH, sequence: 3, digest: null }), /unavailable/);
  assert.throws(() => store.assertCheckpoint({ roomId: ROOM, epoch: EPOCH, sequence: -1, digest: null }), /unavailable/);
  assert.equal(store.assertCheckpoint(store.checkpoint(2)).sequence, 2);
});

test("the digest chain links each record to the one before it, so a reopened room is the same room (survivor 537: at(-1) -> at(-2))", async (t) => {
  const { root, store } = await room(t);
  await post(store, 1);
  await claim(store, 2);
  await post(store, 3);
  const records = /** @type {any[]} */ (store.records);
  assert.equal(records[0].previousDigest, null);
  assert.equal(records[1].previousDigest, records[0].recordDigest);
  assert.equal(records[2].previousDigest, records[1].recordDigest);
  await store.close();
  const reopened = await NativeRoomStore.open({ root, roomId: ROOM });
  t.after(() => reopened.close());
  assert.equal(reopened.status().committed, 3);
  assert.equal(reopened.board()[0].accountId, HOST);
});

// Not pinned, on purpose: native-store.mjs:628 (the read default of 1000 rows) -- observable only
// through a room of more than a thousand records, and a thousand fsync'd appends on the house
// Windows runner trips the committed-boundary publication EPERM under load (an open alpha
// investigation); the pin waits on that defect, and the bound above holds the limit's shape.
// Equivalent mutants in the kernel-seam class, left green on purpose:
//   native-store.mjs:503 (interned id + 1 -> + 2) -- interned ids are compared by equality only;
//   native-store.mjs:505 (Math.max(0, ...) -> Math.max(1, ...) on a stored expiry) -- an expiry
//     that fails to parse is 0 or 1 ms after the epoch, expired either way at any live clock;
//   native-store.mjs:514 (the kernel's cursor input + 1 -> + 2) -- the store applies its own
//     computed cursor and expiry to the holder (#applyBoard reads the record, not the verdict's
//     holder), so the kernel's Applied{holder} is consulted for its class only; a design note,
//     not a defect: the fuzz model agrees with the store on every seed;
//   native-store.mjs:571 (the 1000 ms floor) -- the payload validator refuses below 1000 first
//     (protocol range), so the store's floor is unreachable through the API; its cap is not,
//     and is pinned above;
//   native-store.mjs:578 (record.kind !== "board" || !record.board -> &&) -- a board record
//     always carries board, so the two conditions never disagree.
