// @ts-check
// Annotations (docs/ANNOTATIONS.md): the store admits edit, withdraw, pin and unpin as records of
// their own and refuses each case by name; the seat service hands them to a reader or subscriber
// that asks for them and carries every other one past them, as it carries them past board records.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NativeRoomStore, textDigest } from "../src/native-store.mjs";
import { NativeRoomService, NativeServiceClient } from "../src/native-service.mjs";
import { nativeDigest } from "../src/native-protocol.mjs";

const ROOM = "c".repeat(32), EPOCH = "d".repeat(32), ACCOUNT = "seat_account_0001", OTHER = "seat_account_0002";
const op = () => randomUUID().replaceAll("-", "");
const LOCAL = { accountId: ACCOUNT };
const APP = { accountId: ACCOUNT, via: "example-app" };

/** @param {import('node:test').TestContext} t @param {1 | 2} [logVersion] */
async function room(t, logVersion = 2) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-annotations-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let tick = Date.parse("2026-02-01T00:00:00.000Z");
  const now = () => new Date(tick += 1000);
  const store = await NativeRoomStore.create({ root, roomId: ROOM, epoch: EPOCH, hostAccountId: ACCOUNT, logVersion, now });
  t.after(() => store.close());
  return { root, store, now };
}

/** @param {NativeRoomStore} store @param {string} text @param {{ accountId: string, via?: string }} [who] @param {Record<string, unknown>} [extra] */
const post = (store, text, who = LOCAL, extra = {}) => store.append({ operationId: op(), authorName: "Ada", authorKind: "human", text, ...extra }, who);
/** @param {NativeRoomStore} store @param {Record<string, unknown>} annotation @param {{ accountId: string, via?: string }} [who] @param {Record<string, unknown>} [extra] */
const annotate = (store, annotation, who = LOCAL, extra = {}) =>
  /** @type {Promise<any>} */ (store.append(/** @type {any} */ ({ kind: "annotation", operationId: op(), authorName: "Ada", authorKind: "human", annotation, ...extra }), who));
/** @param {Promise<unknown>} p @param {string} code */
const refusedAs = (p, code) => assert.rejects(p, (e) => { assert.equal(/** @type {any} */ (e).code, code, String(e)); return true; });

test("edit, withdraw, pin and unpin are records of their own; the message's record never changes; a reopen rebuilds them", async (t) => {
  const { root, store, now } = await room(t);
  const m = await post(store, "first words");
  const messageRecord = structuredClone(store.records[0]);
  const edit = await annotate(store, { act: "edit", target: m.id, text: "better words" });
  const pin = await annotate(store, { act: "pin", target: m.id });
  const unpin = await annotate(store, { act: "unpin", target: m.id });
  const withdraw = await annotate(store, { act: "withdraw", target: m.id });
  assert.deepEqual([edit.kind, edit.duplicate, edit.cursor], ["annotation", false, `${EPOCH}:2`]);
  assert.deepEqual(store.records[0], messageRecord, "the message's record is untouched");
  const editRecord = store.records[1];
  assert.equal(editRecord.kind, "annotation");
  assert.equal(editRecord.version, 2);
  assert.equal(editRecord.annotation.textDigest, textDigest("better words"));
  const { recordDigest, ...unsigned } = editRecord;
  const { text: _text, ...withoutText } = unsigned.annotation;
  assert.equal(recordDigest, nativeDigest({ ...unsigned, annotation: withoutText }), "an edit's text is outside the digest, as a message's is");

  const view = store.view();
  assert.deepEqual(view.messages.map((x) => x.text), ["first words"], "a message read is the message as posted");
  assert.deepEqual(view.annotations.map((a) => [a.act, a.target, a.text]), [["edit", m.id, "better words"], ["pin", m.id, undefined], ["unpin", m.id, undefined], ["withdraw", m.id, undefined]]);
  assert.deepEqual(view.annotations.map((a) => a.id), [edit.id, pin.id, unpin.id, withdraw.id]);
  assert.deepEqual(view.annotations[0], { id: edit.id, act: "edit", target: m.id, author: { id: ACCOUNT, name: "Ada", kind: "human" },
    text: "better words", ts: view.annotations[0].ts, cursor: `${EPOCH}:2` }, "no text digest reaches a reader");
  assert.equal(view.through, 5);
  // after a cursor: the annotations past it
  assert.deepEqual(store.view({ since: `${EPOCH}:3` }).annotations.map((a) => a.act), ["unpin", "withdraw"]);
  assert.deepEqual(store.read({ since: `${EPOCH}:1` }), [], "read() is still messages only");

  await store.close();
  const reopened = await NativeRoomStore.open({ root, roomId: ROOM, now });
  t.after(() => reopened.close());
  assert.deepEqual(reopened.view().annotations, view.annotations);
  await refusedAs(annotate(reopened, { act: "pin", target: m.id }), "annotation-target-withdrawn");
});

test("edit and withdraw belong to the author: another account, another person, or another client is refused; pin is anyone's", async (t) => {
  const { store } = await room(t);
  const mine = await post(store, "the seat's own");
  const person = await post(store, "a person's", APP, { authorRef: "person.1" });
  for (const act of ["edit", "withdraw"]) {
    const body = (/** @type {string} */ target) => ({ act, target, ...(act === "edit" ? { text: "changed" } : {}) });
    await refusedAs(annotate(store, body(mine.id), { accountId: OTHER }), "annotation-not-author");
    await refusedAs(annotate(store, body(person.id), APP, { authorRef: "person.2" }), "annotation-not-author");
    await refusedAs(annotate(store, body(person.id), LOCAL), "annotation-not-author");
    await refusedAs(annotate(store, body(person.id), { accountId: ACCOUNT, via: "other-app" }, { authorRef: "person.1" }), "annotation-not-author");
    await refusedAs(annotate(store, body(mine.id), APP, { authorRef: "person.1" }), "annotation-not-author");
  }
  assert.equal(store.records.length, 2, "nothing was appended");
  await annotate(store, { act: "edit", target: person.id, text: "fixed" }, APP, { authorRef: "person.1" });
  await annotate(store, { act: "edit", target: mine.id, text: "fixed too" });
  await annotate(store, { act: "pin", target: person.id }, { accountId: OTHER });
  await annotate(store, { act: "unpin", target: mine.id }, APP, { authorRef: "person.9" });
  assert.equal(store.records.length, 6);
});

test("an annotation is refused by name: unknown target, withdrawn target, invalid shape, a version 1 room", async (t) => {
  const { store } = await room(t);
  const m = await post(store, "words");
  const pin = await annotate(store, { act: "pin", target: m.id });
  await refusedAs(annotate(store, { act: "pin", target: "f".repeat(64) }), "annotation-target-unknown");
  await refusedAs(annotate(store, { act: "pin", target: pin.id }), "annotation-target-unknown");
  await refusedAs(annotate(store, { act: "star", target: m.id }), "annotation-invalid");
  await refusedAs(annotate(store, { act: "edit", target: m.id }), "annotation-invalid");
  await refusedAs(annotate(store, { act: "edit", target: m.id, text: "x".repeat(256 * 1024 + 1) }), "annotation-invalid");
  await refusedAs(annotate(store, { act: "pin", target: m.id, text: "why" }), "annotation-invalid");
  await refusedAs(annotate(store, { act: "pin", target: m.id, thread: m.id }), "annotation-invalid");
  await refusedAs(annotate(store, { act: "pin", target: "short" }), "annotation-invalid");
  await refusedAs(annotate(store, /** @type {any} */ ("pin")), "annotation-invalid");
  await refusedAs(annotate(store, { act: "pin", target: m.id }, LOCAL, { via: "forged" }), "operation-via-refused");
  await refusedAs(annotate(store, { act: "pin", target: m.id }, LOCAL, { authorRef: "person.1" }), "author-ref-without-client");
  await annotate(store, { act: "withdraw", target: m.id });
  for (const act of ["edit", "withdraw", "pin", "unpin"])
    await refusedAs(annotate(store, { act, target: m.id, ...(act === "edit" ? { text: "late" } : {}) }), "annotation-target-withdrawn");
  await refusedAs(store.append(/** @type {any} */ ({ kind: "mystery", operationId: op(), authorName: "A", text: "t" }), LOCAL), "append-kind-invalid");

  const v1 = await room(t, 1);
  const old = await post(v1.store, "a version 1 message");
  await refusedAs(annotate(v1.store, { act: "pin", target: old.id }), "annotation-unsupported-log-version");
  assert.equal(v1.store.records.length, 1);
});

test("a resent annotation is its original receipt; the same operation id with other bytes is refused", async (t) => {
  const { store } = await room(t);
  const m = await post(store, "words");
  const operationId = op();
  const body = { kind: "annotation", operationId, authorName: "Ada", authorKind: "human", annotation: { act: "edit", target: m.id, text: "v2" } };
  const first = /** @type {any} */ (await store.append(/** @type {any} */ (body), LOCAL));
  assert.deepEqual(await store.append(/** @type {any} */ (structuredClone(body)), LOCAL), { id: first.id, cursor: first.cursor, duplicate: true, kind: "annotation" });
  await assert.rejects(store.append(/** @type {any} */ ({ ...body, annotation: { act: "edit", target: m.id, text: "v3" } }), LOCAL), /already committed with different bytes/);
  // a message under an annotation's operation id is other bytes too
  await assert.rejects(store.append({ operationId, authorName: "Ada", authorKind: "human", text: "v2" }, LOCAL), /already committed with different bytes/);
  assert.equal(store.records.length, 2);
});

test("a thread view carries the annotations on that thread's messages and no others", async (t) => {
  const { store } = await room(t);
  const root1 = await post(store, "root one");
  const reply = await post(store, "a reply", LOCAL, { thread: root1.id });
  const root2 = await post(store, "root two");
  await annotate(store, { act: "edit", target: reply.id, text: "a better reply" });
  await annotate(store, { act: "pin", target: root2.id });
  await annotate(store, { act: "pin", target: root1.id });
  const newest = store.view({ thread: root1.id });
  assert.deepEqual(newest.annotations.map((a) => [a.act, a.target]), [["edit", reply.id], ["pin", root1.id]]);
  const after = store.view({ thread: root1.id, since: `${EPOCH}:2` });
  assert.deepEqual(after.messages, []);
  assert.deepEqual(after.annotations.map((a) => a.target), [reply.id, root1.id]);
  assert.equal(after.through, 6);
  assert.deepEqual(store.view({ thread: root2.id }).annotations.map((a) => a.target), [root2.id]);
});

test("an edit whose text was changed on disk refuses the room; one that names no earlier message does too", async (t) => {
  /** @param {(records: any[]) => void} edit @param {RegExp} refusal */
  const refusesAfter = async (edit, refusal) => {
    const { root, store } = await room(t);
    const m = await post(store, "words");
    await annotate(store, { act: "edit", target: m.id, text: "abc" });
    await annotate(store, { act: "pin", target: m.id });
    await store.close();
    const dir = path.join(root, "native", "rooms", ROOM);
    const bytes = await readFile(path.join(dir, "room.frames"));
    /** @type {any[]} */
    const records = [];
    for (let at = 0; at < bytes.length;) {
      const length = bytes.readUInt32BE(at);
      records.push(JSON.parse(bytes.subarray(at + 4, at + 4 + length).toString("utf8")));
      at += 4 + length + 32;
    }
    edit(records);
    const out = Buffer.concat(records.map((r) => {
      const payload = Buffer.from(JSON.stringify(r), "utf8");
      const header = Buffer.alloc(4);
      header.writeUInt32BE(payload.length, 0);
      return Buffer.concat([header, payload, createHash("sha256").update(payload).digest()]);
    }));
    await writeFile(path.join(dir, "room.frames"), out);
    const boundaryPath = path.join(dir, "committed.json");
    await writeFile(boundaryPath, JSON.stringify({ ...JSON.parse(await readFile(boundaryPath, "utf8")), end: out.length }, null, 2) + "\n");
    await assert.rejects(async () => { const s = await NativeRoomStore.open({ root, roomId: ROOM }); await s.close(); }, refusal);
  };
  await refusesAfter((r) => { r[1].annotation.text = "abd"; }, /annotation at sequence 2 carries a text that does not match its text digest/);
  await refusesAfter((r) => { delete r[1].annotation.text; }, /annotation at sequence 2 has no text and no purge names it/);
  await refusesAfter((r) => { r[2].annotation.text = "x"; }, /carries a text on a pin/);
  // an annotation moved ahead of its message names no earlier message (the chain is re-sealed by
  // hand below only as far as the frames go, so the record check is what refuses)
  await refusesAfter((r) => { r[2].annotation.target = r[1].annotation.id; }, /names no act or no earlier message/);
});

/** @param {import('node:test').TestContext} t */
async function service(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-annotations-svc-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const svc = new NativeRoomService({ root, accountId: ACCOUNT, seatLabel: "seat-n" });
  const endpoint = /** @type {any} */ (await svc.start());
  t.after(() => svc.stop());
  await svc.createRoom({ roomId: ROOM, epoch: EPOCH });
  /** @param {string} [clientName] */
  const connect = async (clientName) => {
    const c = await NativeServiceClient.connect({ ...endpoint, ...(clientName ? { clientName } : {}) });
    t.after(() => c.close());
    return c;
  };
  return { root, svc, connect };
}

/** @param {NativeServiceClient} c @param {string} text @param {Record<string, unknown>} [extra] */
const say = (c, text, extra = {}) => /** @type {Promise<any>} */ (c.request("append", { roomId: ROOM, operation: { operationId: op(), authorName: "Ada", authorKind: "human", text, ...extra } }));
/** @param {NativeServiceClient} c @param {Record<string, unknown>} annotation */
const mark = (c, annotation) => /** @type {Promise<any>} */ (c.request("append", { roomId: ROOM, operation: { kind: "annotation", operationId: op(), authorName: "Ada", authorKind: "human", annotation } }));
/** @param {() => boolean} predicate */
const until = async (predicate) => { for (let i = 0; i < 200 && !predicate(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(predicate()); };

test("the service makes version 2 rooms; a reader that asks for annotations gets them, one that does not is carried past them", async (t) => {
  const { svc, connect } = await service(t);
  assert.equal((await svc.openRoom(ROOM)).logVersion, 2);
  const c = await connect();
  const m1 = await say(c, "one");
  const edit = await mark(c, { act: "edit", target: m1.id, text: "one, edited" });
  assert.equal(edit.kind, "annotation");
  await mark(c, { act: "pin", target: m1.id });

  const plain = /** @type {any} */ (await c.request("read", { roomId: ROOM, since: `${EPOCH}:0` }));
  assert.equal("annotations" in plain, false, "a reader that did not ask gets the frame it always got");
  assert.deepEqual(plain.messages.map((/** @type {any} */ m) => m.text), ["one"]);
  assert.equal(plain.checkpoint.sequence, 1, "as past a board record: accounted through the last message");

  const asked = /** @type {any} */ (await c.request("read", { roomId: ROOM, since: `${EPOCH}:0`, annotations: true }));
  assert.deepEqual(asked.messages.map((/** @type {any} */ m) => m.text), ["one"]);
  assert.deepEqual(asked.annotations.map((/** @type {any} */ a) => [a.act, a.text]), [["edit", "one, edited"], ["pin", undefined]]);
  assert.equal(asked.checkpoint.sequence, 3);
  assert.equal("textDigest" in asked.messages[0], false);
  assert.equal("textDigest" in asked.annotations[0], false);
  const newest = /** @type {any} */ (await c.request("read", { roomId: ROOM, limit: 2, annotations: true }));
  assert.deepEqual([newest.messages.length, newest.annotations.length], [0, 2], "a newest window is cut over messages and annotations together");
  await assert.rejects(c.request("read", { roomId: ROOM, annotations: "yes" }), (e) => /** @type {any} */ (e).code === "annotations-invalid");

  // subscriptions: one without annotations sees only messages, one with them sees both, in order
  /** @type {string[]} */
  const quiet = [];
  /** @type {string[]} */
  const both = [];
  const s1 = await connect();
  await s1.subscribe(ROOM, `${EPOCH}:0`, (m) => quiet.push(`m:${m.text}`));
  const s2 = await connect();
  await s2.subscribe(ROOM, `${EPOCH}:0`, (m) => both.push(`m:${m.text}`), undefined, (a) => both.push(`a:${a.act}`));
  assert.deepEqual(quiet, ["m:one"], "the replay carries a quiet subscriber past the annotations");
  assert.deepEqual(both, ["m:one", "a:edit", "a:pin"]);
  const m2 = await say(c, "two");
  await mark(c, { act: "withdraw", target: m2.id });
  await say(c, "three");
  await until(() => quiet.length === 3 && both.length === 6);
  assert.deepEqual(quiet, ["m:one", "m:two", "m:three"]);
  assert.deepEqual(both, ["m:one", "a:edit", "a:pin", "m:two", "a:withdraw", "m:three"]);
});

test("a thread subscription that asks for annotations gets only its thread's", async (t) => {
  const { connect } = await service(t);
  const c = await connect();
  const root1 = await say(c, "root");
  const other = await say(c, "elsewhere");
  /** @type {string[]} */
  const seen = [];
  const sub = await connect();
  await sub.subscribe(ROOM, `${EPOCH}:2`, (m) => seen.push(`m:${m.text}`), root1.id, (a) => seen.push(`a:${a.act}:${a.target === root1.id ? "root" : "other"}`));
  await mark(c, { act: "pin", target: other.id });
  await mark(c, { act: "pin", target: root1.id });
  await say(c, "in thread", { thread: root1.id });
  await until(() => seen.length === 2);
  assert.deepEqual(seen, ["a:pin:root", "m:in thread"]);
});
