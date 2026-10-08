// @ts-check
// Native threads and the `via` stamp in the room store: a reply names a root the room holds and
// that is itself top-level (refused by name otherwise); a thread view is the root and its replies,
// a view over what the read already selected; `via` is the client name the connection declared,
// handed in beside the account, and `author.ref` exists only beside it. Each refusal is asserted by
// its code and by what it did NOT commit.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NativeRoomStore } from "../src/native-store.mjs";

const ROOM = "3".repeat(32);
const EPOCH = "4".repeat(32);
const HOST = "seat_host_0000001";
const PEER = "seat_peer_0000001";
let n = 0;
const OP = () => `operation_thread_${String(++n).padStart(4, "0")}`;

/** @param {import('node:test').TestContext} t */
async function room(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-store-threads-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await NativeRoomStore.create({ root, roomId: ROOM, epoch: EPOCH, hostAccountId: HOST });
  t.after(() => store.close());
  return { root, store };
}
/** @param {NativeRoomStore} store @param {Record<string, unknown>} [fields] @param {{ accountId?: string, via?: string }} [auth] */
const post = (store, fields = {}, auth = {}) => /** @type {Promise<{ id: string, cursor: string, duplicate: boolean }>} */ (
  store.append({ operationId: OP(), authorName: "A", authorKind: "agent", text: "t", ...fields }, { accountId: HOST, ...auth }));
/** @param {Promise<unknown>} p @param {string} code */
const refusedAs = (p, code) => assert.rejects(p, (e) => { assert.equal(/** @type {any} */ (e).code, code, String(e)); assert.match(String(/** @type {any} */ (e).message), new RegExp(`^${code}: `)); return true; });

test("a reply names a top-level root the room holds; an unknown root or a reply's id is refused by name and commits nothing", async (t) => {
  const { store } = await room(t);
  const root = await post(store, { text: "root" });
  const replyOp = { operationId: OP(), authorName: "A", authorKind: "agent", text: "reply", thread: root.id };
  const reply = await store.append(replyOp, { accountId: HOST });
  assert.equal(store.read().at(-1)?.thread, root.id);
  await refusedAs(post(store, { thread: "f".repeat(64) }), "thread-root-unknown");
  await refusedAs(post(store, { thread: reply.id }), "thread-root-not-top-level");
  // a board record's id is derived like a message's, and it is not a message
  const claim = /** @type {any} */ (await store.append({ kind: "board", operationId: OP(), payload: { action: "claim", subject: "work:t" } }, { accountId: HOST }));
  await refusedAs(post(store, { thread: claim.id }), "thread-root-unknown");
  assert.equal(store.status().committed, 3, "three records: the root, the reply and the claim; no refused reply committed");
  // a retry of a committed reply is its original receipt, root check or not
  assert.equal((await store.append(replyOp, { accountId: HOST })).duplicate, true);
});

test("the room view carries every reply; a thread view is the root and its replies only, ascending", async (t) => {
  const { store } = await room(t);
  const a = await post(store, { text: "a" });
  const b = await post(store, { text: "b" });
  await post(store, { text: "a1", thread: a.id });
  await post(store, { text: "b1", thread: b.id });
  await store.append({ kind: "board", operationId: OP(), payload: { action: "claim", subject: "work:v" } }, { accountId: HOST });
  await post(store, { text: "a2", thread: a.id }, { accountId: PEER });
  assert.deepEqual(store.read().map((m) => m.text), ["a", "b", "a1", "b1", "a2"], "the room view is the one sequence, replies included");
  assert.deepEqual(store.read({ thread: a.id }).map((m) => m.text), ["a", "a1", "a2"]);
  assert.deepEqual(store.read({ thread: b.id }).map((m) => m.text), ["b", "b1"]);
  assert.deepEqual(store.read({ thread: a.id, limit: 2 }).map((m) => m.text), ["a1", "a2"], "with no cursor a thread view is its own newest messages");
  assert.deepEqual(store.view({ thread: a.id }).through, 6, "a whole thread view accounts for everything committed");
  const c = await post(store, { text: "c" });
  assert.deepEqual(store.read({ thread: c.id }).map((m) => m.text), ["c"], "a root with no replies is its own thread");
  assert.throws(() => store.read({ thread: "e".repeat(64) }), (e) => /** @type {any} */ (e).code === "thread-root-unknown");
  const a1 = /** @type {any} */ (store.read({ thread: a.id })[1]);
  assert.throws(() => store.read({ thread: a1.id }), (e) => /** @type {any} */ (e).code === "thread-root-not-top-level");
});

test("after a cursor the read plan selects the records and the thread view keeps its own; `through` is where the scan ended", async (t) => {
  const { store } = await room(t);
  const a = await post(store, { text: "a" });              // 1
  await post(store, { text: "x" });                         // 2
  await post(store, { text: "a1", thread: a.id });          // 3
  await post(store, { text: "y" });                         // 4
  await post(store, { text: "z" });                         // 5
  await post(store, { text: "a2", thread: a.id });          // 6
  const since = (/** @type {number} */ s) => `${EPOCH}:${s}`;
  const v = store.view({ thread: a.id, since: since(0), limit: 4 });
  assert.deepEqual(v.messages.map((m) => m.text), ["a", "a1"], "the limit bounds the records scanned (1..4), not the replies returned");
  assert.equal(v.through, 4, "the scan accounts for record 4, past the last reply it found");
  const quiet = store.view({ thread: a.id, since: since(3), limit: 2 });
  assert.deepEqual(quiet.messages, [], "nothing of the thread in records 4..5");
  assert.equal(quiet.through, 5, "and the view still advances over them");
  const rest = store.view({ thread: a.id, since: since(5) });
  assert.deepEqual(rest.messages.map((m) => m.text), ["a2"]);
  assert.equal(rest.through, 6);
  assert.equal(store.view({ since: since(6) }).through, 6, "a read at the end accounts for the end");
  assert.throws(() => store.view({ thread: a.id, since: `${"9".repeat(32)}:0` }), /belongs to epoch/, "the plan's refusals stand for a thread view");
  assert.throws(() => store.view({ thread: a.id, since: since(7) }), /exceeds committed sequence/);
});

test("a reopened room rebuilds its message and thread indexes from the log", async (t) => {
  const { root, store } = await room(t);
  const a = await post(store, { text: "a" });
  const a1 = await post(store, { text: "a1", thread: a.id });
  await post(store, { text: "x" });
  await store.close();
  const reopened = await NativeRoomStore.open({ root, roomId: ROOM });
  t.after(() => reopened.close());
  assert.deepEqual(reopened.read({ thread: a.id }).map((m) => m.text), ["a", "a1"]);
  await refusedAs(reopened.append({ operationId: OP(), authorName: "A", text: "r", thread: a1.id }, { accountId: HOST }), "thread-root-not-top-level");
  const a2 = await reopened.append({ operationId: OP(), authorName: "A", text: "a2", thread: a.id }, { accountId: HOST });
  assert.deepEqual(reopened.read({ thread: a.id }).map((m) => m.id), [a.id, a1.id, a2.id], "an append after the reopen joins the rebuilt index at its own position");
});

test("via is the connection's declared client name, stamped beside the account; author.ref stands only beside it", async (t) => {
  const { store } = await room(t);
  const stamped = await post(store, { authorKind: "human", authorName: "Dana", authorRef: "u.42@example" }, { via: "review-app" });
  const m = /** @type {any} */ (store.read().at(-1));
  assert.equal(m.id, stamped.id);
  assert.equal(m.via, "review-app");
  assert.deepEqual(m.author, { id: HOST, name: "Dana", kind: "human", ref: "u.42@example" }, "the account is still the author's id; the ref is attribution beside it");
  // a connection that declared no name stamps nothing, and a plain post carries neither field
  await post(store, { text: "plain" });
  const plain = /** @type {any} */ (store.read().at(-1));
  assert.equal("via" in plain, false);
  assert.equal("ref" in plain.author, false);
  // a client name stamps every author kind, the app's own root posted as system included
  for (const kind of ["agent", "human", "unknown", "system"]) await post(store, { authorKind: kind }, { via: "review-app" });
  assert.deepEqual(store.read().slice(-4).map((x) => [x.author.kind, /** @type {any} */ (x).via]), [["agent", "review-app"], ["human", "review-app"], ["unknown", "review-app"], ["system", "review-app"]]);
  await assert.rejects(post(store, { authorKind: "operator" }), /author kind is invalid/);
});

test("via and authorRef are refused by name when malformed, misplaced or unscoped, and nothing commits", async (t) => {
  const { store } = await room(t);
  await refusedAs(post(store, { authorRef: "u1" }), "author-ref-without-client");
  await refusedAs(post(store, { via: "review-app" }), "operation-via-refused");
  await refusedAs(post(store, { via: "review-app" }, { via: "review-app" }), "operation-via-refused");
  for (const bad of ["p", "1pq", "pq_workbench", "Pq-workbench", "pq workbench", `p${"q".repeat(40)}`]) await refusedAs(post(store, {}, { via: bad }), "client-name-invalid");
  await refusedAs(post(store, {}, { via: /** @type {any} */ (7) }), "client-name-invalid");
  for (const bad of ["", "has space", "a/b", "x".repeat(65), "é"]) await refusedAs(post(store, { authorRef: bad }, { via: "review-app" }), "author-ref-invalid");
  await refusedAs(post(store, { authorRef: /** @type {any} */ (42) }, { via: "review-app" }), "author-ref-invalid");
  assert.equal(store.status().committed, 0);
  await post(store, {}, { via: "pq" });
  await post(store, {}, { via: `p${"q".repeat(39)}` });
  await post(store, { authorRef: "x".repeat(64) }, { via: "review-app" });
  await post(store, { authorRef: "A.z_0@9+-" }, { via: "review-app" });
  assert.equal(store.status().committed, 4);
});

test("an operation id retried from another client name, or with another authorRef, is different bytes", async (t) => {
  const { store } = await room(t);
  const op = { operationId: "operation_retry_via_01", authorName: "Dana", authorKind: "human", text: "once", authorRef: "u1" };
  const first = await store.append(op, { accountId: HOST, via: "review-app" });
  assert.equal((await store.append(op, { accountId: HOST, via: "review-app" })).duplicate, true);
  await assert.rejects(store.append(op, { accountId: HOST, via: "other-app" }), /already committed with different bytes/);
  await assert.rejects(store.append({ ...op, authorRef: "u2" }, { accountId: HOST, via: "review-app" }), /already committed with different bytes/);
  assert.equal(store.status().committed, 1);
  assert.equal(first.duplicate, false);
});

test("a board act on a named connection is a board record: no via, no message", async (t) => {
  const { store } = await room(t);
  await store.append({ kind: "board", operationId: OP(), payload: { action: "claim", subject: "work:b" } }, { accountId: HOST, via: "review-app" });
  const record = /** @type {any} */ (store.records.at(-1));
  assert.equal(record.kind, "board");
  assert.equal("via" in record, false);
  assert.equal(record.message, undefined);
});
