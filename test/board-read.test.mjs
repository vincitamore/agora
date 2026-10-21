// @ts-check
// The board read (boards-v1): the fold over the served board records equals the store's own kernel
// verdicts (live holders and their expiry, and every contest receipt) under seeded random acts;
// the claim's author is read off the room; the service serves the view read-only and a service
// without boards-v1 is refused by name; and the address resolver's kinds and refusals.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NativeRoomStore } from "../src/native-store.mjs";
import { NativeRoomService } from "../src/native-service.mjs";
import { nativeTransport } from "../src/transports/native.mjs";
import { claimAuthors, foldBoard, liveHolders, readBoard, resolveAddress } from "../src/board-read.mjs";

const EPOCH = "e".repeat(32);
const ACCOUNTS = ["seat_host_0000001", "seat_peer_0000001", "seat_peer_0000002"];
const SUBJECTS = ["work:a", "work:b", "human:q"];
/** The fuzz seeds this gate runs; each is a replayable sequence. */
const SEEDS = [1, 2, 3, 7, 11, 42, 97, 1234, 9001, 65537];
const STEPS = 160;

/** xorshift32, seeded */
function rng(/** @type {number} */ seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 0x1_0000_0000; };
}

/** @param {any[]} xs */
const sortBySubject = (xs) => [...xs].sort((a, b) => a.subject.localeCompare(b.subject));

for (const seed of SEEDS) {
  test(`board fold equals the store's kernel verdicts: seed ${seed}`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "agora-board-read-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const store = await NativeRoomStore.create({ root, roomId: seed.toString(16).padStart(32, "0"), epoch: EPOCH, hostAccountId: ACCOUNTS[0], now: () => new Date(now) });
    t.after(() => store.close());
    const rand = rng(seed);
    const pick = (/** @type {any[]} */ xs) => xs[Math.floor(rand() * xs.length)];
    let contests = 0, applied = 0;
    for (let step = 0; step < STEPS; step++) {
      const r = rand();
      if (r < 0.2) { now += pick([1, 999, 1000, 1001, 5000, 3_600_000, 3_600_001]); }
      else if (r < 0.3) await store.append({ operationId: `m${step}`.padEnd(16, "0"), authorName: "a", authorKind: "agent", text: `m${step}` }, { accountId: pick(ACCOUNTS) });
      else {
        const account = pick(ACCOUNTS), subject = pick(SUBJECTS);
        const action = pick(["claim", "claim", "renew", "release", "contest", "break"]);
        const held = store.board().find((h) => h.subject === subject);
        const stale = rand() < 0.25;
        const leaseId = held && !stale ? held.leaseId : "operation_none_000000";
        const fence = held && !stale ? held.fence : `${EPOCH}:1`;
        const leaseMs = rand() < 0.5 ? pick([1000, 1001, 5000, 3_600_000]) : undefined;
        const payload = action === "claim" ? { action, subject, ...(leaseMs ? { leaseMs } : {}) }
          : action === "renew" ? { action, subject, leaseId, fence, ...(leaseMs ? { leaseMs } : {}) }
          : action === "release" ? { action, subject, leaseId, fence }
          : action === "contest" ? { action, subject, because: "probe" } : { action, subject };
        let receipt;
        try {
          receipt = /** @type {any} */ (await store.append({ kind: "board", operationId: `b${step}`.padEnd(16, "0"), payload, authorKind: rand() < 0.5 ? "human" : "agent", authorName: account }, { accountId: account }));
          applied++;
        } catch { receipt = undefined; }
        if (receipt && action === "contest") {
          contests++;
          const fold = foldBoard(store.boardRecords(), now);
          const last = fold.subjects.find((s) => s.subject === subject)?.contests.at(-1);
          assert.ok(last, `seed ${seed} step ${step}: the fold lost the contest`);
          assert.equal(last.cursor, receipt.cursor);
          assert.deepEqual(last.holder ?? undefined, receipt.holder, `seed ${seed} step ${step}: contest holder`);
          assert.equal(last.held, receipt.held, `seed ${seed} step ${step}: contest held`);
        }
      }
      // after every step, at this instant: the live holders and their expiry, field for field
      const fold = foldBoard(store.boardRecords(), now);
      assert.deepEqual(sortBySubject(liveHolders(fold)), sortBySubject(store.board()), `seed ${seed} step ${step}: live holders`);
    }
    assert.ok(applied > 20, `seed ${seed} applied only ${applied} board acts: the run did not exercise the board`);
    t.diagnostic(`seed ${seed}: ${applied} board acts, ${contests} contests`);
  });
}

test("a lapsed lease is no holder and stays visible as lapsed until a claim replaces it (red leg: one ms before expiry it is the holder)", async () => {
  const records = [{ cursor: `${EPOCH}:1`, accountId: "acct", operationId: "op1", board: { action: "claim", subject: "work:x" }, expiresAt: "2026-01-01T00:00:10.000Z", leaseMs: 10_000 }];
  const before = foldBoard(records, Date.parse("2026-01-01T00:00:09.999Z")).subjects[0];
  assert.equal(before.holder?.accountId, "acct");
  assert.equal(before.lapsed, null);
  const after = foldBoard(records, Date.parse("2026-01-01T00:00:10.000Z")).subjects[0];
  assert.equal(after.holder, null);
  assert.equal(after.lapsed?.leaseId, "op1");
});

test("claimAuthors names the bearer of the message that carried the claim, from the same account only", () => {
  const records = [{ cursor: `${EPOCH}:2`, accountId: "acct", operationId: "op", board: { action: "claim", subject: "work:msg:abc" }, expiresAt: "2099-01-01T00:00:00.000Z", leaseMs: 3_600_000 }];
  const fold = foldBoard(records, Date.parse("2026-01-01T00:00:00.000Z"));
  const messages = [
    { id: "m1", cursor: `${EPOCH}:1`, author: { id: "acct", name: "x", kind: "agent" }, text: "earlier\n\nclaim: msg:abc", signedAs: "coding/Early" },
    { id: "m3", cursor: `${EPOCH}:3`, author: { id: "other", name: "y", kind: "agent" }, text: "taking\n\nclaim: msg:abc", signedAs: "coding/Other" },
    { id: "m4", cursor: `${EPOCH}:4`, thread: "root1", author: { id: "acct", name: "z", kind: "agent" }, text: "taking\n\nclaim: msg:abc", signedAs: "coding/Opus" },
  ];
  assert.deepEqual(claimAuthors(fold, messages).get("work:msg:abc"), { bearer: "coding/Opus", id: "m4", cursor: `${EPOCH}:4`, root: "root1" });
  // red leg: the message from the claiming account removed, nothing is attributed
  assert.equal(claimAuthors(fold, messages.filter((m) => m.id !== "m4")).get("work:msg:abc"), undefined);
});

test("the service serves the board view read-only; the transport reads it; a service without boards-v1 is refused by name", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-board-svc-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ROOM = "8".repeat(32);
  const service = new NativeRoomService({ root, accountId: "seat_account_0008", seatLabel: "seat-b" });
  await service.start();
  t.after(() => service.stop());
  await service.createRoom({ roomId: ROOM, epoch: "9".repeat(32) });
  const transport = /** @type {any} */ (nativeTransport({ transport: "native", roomId: ROOM }, { actor: { name: "coding/Opus", kind: "agent" }, stateRoot: root }));
  t.after(() => transport.close?.());
  await transport.board({ action: "claim", subject: "work:unit-1" });
  await transport.board({ action: "contest", subject: "work:unit-1", because: "mine too" });
  const store = await service.openRoom(ROOM);
  const committed = store.status().committed;
  const view = await readBoard(transport);
  assert.deepEqual(view.records.map((r) => r.board.action), ["claim", "contest"]);
  assert.deepEqual(view.holders.map((h) => h.subject), ["work:unit-1"]);
  assert.equal(view.checkpoint.sequence, committed);
  assert.equal(store.status().committed, committed, "reading the board wrote nothing");
  assert.deepEqual(liveHolders(foldBoard(view.records, Date.now())), view.holders);

  // a service that does not offer boards-v1: refused before any frame is sent
  const old = await mkdtemp(path.join(tmpdir(), "agora-board-old-"));
  t.after(() => rm(old, { recursive: true, force: true }));
  await mkdir(path.join(old, "native"), { recursive: true });
  await writeFile(path.join(old, "native", "service.json"), JSON.stringify({ path: "unused", nonce: "n", bootEpoch: "b", accountId: "a", seatLabel: "s", pid: 1 }));
  /** @type {string[]} */ const sent = [];
  const fake = /** @type {any} */ (async () => ({ socket: { unref() {}, once() {}, destroyed: false }, capabilities: new Set(["threads-v1"]), request: async (/** @type {string} */ type) => { sent.push(type); return {}; } }));
  const oldTransport = nativeTransport({ transport: "native", roomId: ROOM }, { actor: { name: "x", kind: "agent" }, stateRoot: old, connect: fake });
  await assert.rejects(readBoard(oldTransport), (e) => { assert.equal(/** @type {any} */ (e).code, "boards-unsupported"); return true; });
  assert.deepEqual(sent, [], "nothing was sent to a service that did not offer boards-v1");
  // and a room with no board at all
  await assert.rejects(readBoard({ kind: "local", read: async () => [] }), /board belongs to a native room/);
});

test("resolve: position, role, seat, everyone, person, foreign holder, retired, half name, unknown", () => {
  const live = /** @type {const} */ ("live");
  const records = [
    { slug: "s-coding", state: live, record: /** @type {any} */ ({ bearer: "coding/Opus", label: "desk.coding" }), posted: new Set(["old1"]) },
    { slug: "s-review", state: live, record: /** @type {any} */ ({ bearer: "review/Argon", label: "desk.review" }), posted: new Set() },
    { slug: "s-gone", state: /** @type {const} */ ("gone"), record: /** @type {any} */ ({ bearer: "triage/Haiku", label: "desk.triage" }), posted: new Set() },
  ];
  const messages = [
    { id: "h1", author: { id: "acct", name: "Ada", kind: "human" }, text: "hi" },
    { id: "old1", author: { id: "acct", name: "builder/Opus", kind: "agent" }, signedAs: "builder/Opus", text: "x" },
    { id: "f1", author: { id: "peer", name: "lin-coder/Kimi", kind: "agent" }, signedAs: "lin-coder/Kimi", text: "y" },
  ];
  const ctx = { seatName: "host", accountId: "acct", records, messages };
  const r = (/** @type {string} */ a) => resolveAddress(a, ctx);
  assert.deepEqual([r("desk.coding").kind, r("desk.coding").holders.map((h) => h.session)], ["position", ["s-coding"]]);
  assert.deepEqual([r("coding").kind, r("coding").holders.map((h) => h.bearer)], ["role", ["coding/Opus"]]);
  assert.equal(r("coding").holders[0].verdict, "unknown", "a live process is never read as ready");
  assert.deepEqual([r("host").kind, r("host").holders.length], ["seat", 2]);
  assert.deepEqual([r("*").kind, r("*").holders.length], ["everyone", 2]);
  assert.deepEqual([r("Ada").kind, r("Ada").holders], ["person", []], "a person is never resolved to agents");
  assert.deepEqual([r("lin-coder").kind, r("lin-coder").holders.map((h) => h.process)], ["role", ["foreign"]]);
  assert.deepEqual([r("builder").kind, r("builder").why, r("builder").nearest], ["none", "retired", "desk.coding"], "the renamed session's name now is the nearest");
  assert.deepEqual([r("triage").kind, r("triage").why], ["none", "retired"]);
  assert.deepEqual([r("cod").kind, r("cod").why, r("cod").nearest], ["none", "half-name", "desk.coding"], "half a segment is never a match");
  assert.deepEqual([r("nobody").kind, r("nobody").why, r("nobody").nearest], ["none", "unknown", null]);
  // one letter off a live holder's name: the nearest is that holder, never a guess between two
  assert.deepEqual([r("desk.codng").kind, r("desk.codng").why, r("desk.codng").nearest], ["none", "unknown", "desk.coding"], "a dropped letter");
  assert.deepEqual([r("revew").why, r("revew").nearest], ["unknown", "desk.review"], "a dropped letter in a role");
  assert.deepEqual(r("desk.revieq").nearest, "desk.review", "a substituted letter");
  assert.deepEqual(r("desk.codingg").nearest, "desk.coding", "an added letter");
  assert.deepEqual(r("desk.triag").nearest, null, "red leg: a gone holder is no neighbour (its retired name is the retired branch's)");
  assert.deepEqual(r("desk.cdng").nearest, null, "red leg: two letters off is no neighbour");
  const twin = (/** @type {string} */ role) => ({ slug: `s-${role}`, state: live, record: /** @type {any} */ ({ bearer: `${role}/Opus`, label: `desk.${role}` }), posted: new Set() });
  const twins = { ...ctx, records: [...records, twin("coder"), twin("codes")] };
  assert.equal(resolveAddress("desk.coder", twins).kind, "position");
  assert.deepEqual([resolveAddress("desk.codex", twins).why, resolveAddress("desk.codex", twins).nearest], ["unknown", "ambiguous"], "two holders one letter off: ambiguous, never a guess");
  assert.equal(resolveAddress("coding", { ...ctx, records: null }).context, "room-only");
});
