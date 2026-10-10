// @ts-check
// Purge (docs/PURGE.md), the store half: a purge record names the messages whose text leaves the
// room, the log is rewritten as its next generation without those texts (or the texts of their
// edits), every record keeps its digest, sequence and cursor, and an interrupted rewrite recovers on
// reopen whichever side of the boundary's rename the crash fell.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NativeRoomStore } from "../src/native-store.mjs";

const ROOM = "e".repeat(32), EPOCH = "f".repeat(32), ACCOUNT = "seat_account_0001";
const op = () => randomUUID().replaceAll("-", "");
const LOCAL = { accountId: ACCOUNT };
const DIGEST_A = `sha256:${"a".repeat(64)}`, DIGEST_B = `sha256:${"b".repeat(64)}`;
/** @param {string} digest @param {string} name */
const attachment = (digest, name) => ({ id: `att_${digest.slice(7, 27)}`, name, kind: "file", size: 10, digest, lifetime: "durable" });

/** @param {import('node:test').TestContext} t @param {1 | 2} [logVersion] */
async function room(t, logVersion = 2) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-purge-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let tick = Date.parse("2026-03-01T00:00:00.000Z");
  const now = () => new Date(tick += 1000);
  const store = await NativeRoomStore.create({ root, roomId: ROOM, epoch: EPOCH, hostAccountId: ACCOUNT, logVersion, now });
  /** @type {NativeRoomStore[]} */
  const open = [store];
  t.after(async () => { for (const s of open) await s.close().catch(() => {}); });
  const dir = path.join(root, "native", "rooms", ROOM);
  return { root, dir, store, now, reopen: async (/** @type {any} */ hooks = undefined) => {
    const s = await NativeRoomStore.open({ root, roomId: ROOM, now, ...(hooks ? { hooks } : {}) });
    open.push(s);
    return s;
  } };
}

/** @param {NativeRoomStore} store @param {string} text @param {Record<string, unknown>} [extra] */
const post = (store, text, extra = {}) => /** @type {Promise<any>} */ (store.append({ operationId: op(), authorName: "Ada", authorKind: "human", text, ...extra }, LOCAL));
/** @param {NativeRoomStore} store @param {Record<string, unknown>} purge @param {Record<string, unknown>} [extra] */
const purge = (store, purge, extra = {}) =>
  /** @type {Promise<any>} */ (store.append(/** @type {any} */ ({ kind: "purge", operationId: op(), authorName: "Ada", authorKind: "human", purge, ...extra }), LOCAL));
/** @param {NativeRoomStore} store @param {Record<string, unknown>} annotation */
const annotate = (store, annotation) =>
  /** @type {Promise<any>} */ (store.append(/** @type {any} */ ({ kind: "annotation", operationId: op(), authorName: "Ada", authorKind: "human", annotation }), LOCAL));
/** @param {Promise<unknown>} p @param {string} code */
const refusedAs = (p, code) => assert.rejects(p, (e) => { assert.equal(/** @type {any} */ (e).code, code, String(e)); return true; });

/** The files of a room directory that are log generations. @param {string} dir */
const generations = async (dir) => (await readdir(dir)).filter((n) => /^room\.frames(\.\d+)?$/.test(n)).sort();

test("a purge takes its targets' text and their edits' text; every record keeps its digest, sequence and cursor; a reader's checkpoint stays valid", async (t) => {
  const { dir, store, reopen } = await room(t);
  const secret = await post(store, "the secret words");
  const kept = await post(store, "words that stay");
  await annotate(store, { act: "edit", target: secret.id, text: "the secret, edited" });
  await annotate(store, { act: "pin", target: kept.id });
  const checkpoint = store.checkpoint();
  const digests = store.records.map((r) => r.recordDigest);
  const receipt = await purge(store, { targets: [secret.id], reason: "asked to remove it" });
  assert.deepEqual([receipt.kind, receipt.duplicate, receipt.cursor, receipt.purged], ["purge", false, `${EPOCH}:5`, [secret.id]]);
  assert.equal(store.generation, 1);
  assert.equal(store.status().generation, 1);
  assert.deepEqual(await generations(dir), ["room.frames.1"], "generation 0 is removed once the boundary names 1");
  assert.equal(JSON.parse(await readFile(path.join(dir, "committed.json"), "utf8")).generation, 1);
  const bytes = (await readFile(path.join(dir, "room.frames.1"))).toString("utf8");
  assert.equal(bytes.includes("the secret"), false, "neither the text nor its edit survives in the log");
  assert.equal(bytes.includes("words that stay"), true);

  assert.deepEqual(store.records.slice(0, 4).map((r) => r.recordDigest), digests, "every record keeps its digest");
  const record = store.records[4];
  assert.deepEqual(record.purge.purged, [secret.id]);
  const marker = { at: record.purge.ts, purge: receipt.id };
  assert.equal("text" in store.records[0].message, false);
  assert.deepEqual(store.records[0].message.purged, marker);
  assert.equal("text" in store.records[2].annotation, false);
  assert.deepEqual(store.records[2].annotation.purged, marker);
  assert.equal(store.records[3].annotation.act, "pin", "a pin carries no text and is untouched");

  // the reader's checkpoint from before the purge is valid, and so is a read after it
  assert.deepEqual(store.assertCheckpoint(checkpoint), checkpoint);
  const view = store.view();
  assert.deepEqual(view.messages.map((m) => [m.id, m.text, m.purged]), [[secret.id, undefined, marker], [kept.id, "words that stay", undefined]]);
  assert.equal(view.annotations[0].text, undefined);
  assert.deepEqual(view.annotations[0].purged, marker);
  assert.deepEqual(store.view({ since: checkpoint.sequence ? `${EPOCH}:${checkpoint.sequence}` : undefined }).messages, []);

  // nothing more is annotated on a purged message; a resend is the original receipt
  await refusedAs(annotate(store, { act: "edit", target: secret.id, text: "back again" }), "annotation-target-purged");
  const resent = await store.append(/** @type {any} */ ({ kind: "purge", operationId: store.records[4].operationId, authorName: "Ada", authorKind: "human",
    purge: { targets: [secret.id], reason: "asked to remove it" } }), LOCAL);
  assert.deepEqual(resent, { id: receipt.id, cursor: receipt.cursor, duplicate: true, kind: "purge", purged: [secret.id] });
  // a later purge does not take again what an earlier one took
  const second = await purge(store, { targets: [secret.id, kept.id], reason: "all of it" });
  assert.deepEqual(second.purged, [kept.id]);
  assert.equal(store.generation, 2);
  await store.close();

  const again = await reopen();
  assert.deepEqual(again.assertCheckpoint(checkpoint), checkpoint, "a reopen keeps the checkpoint valid");
  assert.deepEqual(again.records.slice(0, 4).map((r) => r.recordDigest), digests);
  assert.deepEqual(again.view().messages.map((m) => m.text), [undefined, undefined]);
  assert.equal(again.generation, 2);
  assert.deepEqual(await generations(dir), ["room.frames.2"]);
});

test("a thread purge takes the root and every reply; custody is released only for what no unpurged message references", async (t) => {
  const { store } = await room(t);
  const root = await post(store, "the root");
  const r1 = await post(store, "reply one", { thread: root.id, attachments: [attachment(DIGEST_A, "a.txt")] });
  const r2 = await post(store, "reply two", { thread: root.id, attachments: [attachment(DIGEST_B, "b.txt")] });
  const other = await post(store, "elsewhere, the same bytes", { attachments: [attachment(DIGEST_B, "b.txt")] });
  const receipt = await purge(store, { targets: [], thread: root.id, reason: "the thread goes" });
  assert.deepEqual(receipt.purged, [root.id, r1.id, r2.id]);
  assert.deepEqual(store.view().messages.map((m) => [m.id, m.text]), [[root.id, undefined], [r1.id, undefined], [r2.id, undefined], [other.id, "elsewhere, the same bytes"]]);
  assert.deepEqual(store.view().messages[1].attachments, [attachment(DIGEST_A, "a.txt")], "a purged record keeps its attachment metadata");
  const census = store.custodyCensus();
  assert.deepEqual([...census.released], [DIGEST_A], "B is still referenced by an unpurged message");
  assert.ok(census.referenced.has(DIGEST_B));
  // a reply after the purge is a new message with its text
  const late = await post(store, "a later reply", { thread: root.id });
  assert.equal(store.view().messages.find((m) => m.id === late.id)?.text, "a later reply");
});

test("a purge is refused by name: a version 1 room, an unknown target, a reply as a thread, no target, an unknown key, no reason", async (t) => {
  const v1 = await room(t, 1);
  const m1 = await post(v1.store, "kept forever");
  await refusedAs(purge(v1.store, { targets: [m1.id], reason: "r" }), "purge-unsupported-log-version");
  const { store } = await room(t);
  const root = await post(store, "root");
  const reply = await post(store, "reply", { thread: root.id });
  await refusedAs(purge(store, { targets: ["x".repeat(64)], reason: "r" }), "purge-target-unknown");
  await refusedAs(purge(store, { thread: reply.id, reason: "r" }), "thread-root-not-top-level");
  await refusedAs(purge(store, { thread: "y".repeat(64), reason: "r" }), "thread-root-unknown");
  await refusedAs(purge(store, { targets: [], reason: "r" }), "purge-invalid");
  await refusedAs(purge(store, { targets: [root.id, root.id], reason: "r" }), "purge-invalid");
  await refusedAs(purge(store, { targets: [root.id], reason: "r", everything: true }), "purge-invalid");
  await refusedAs(purge(store, { targets: [root.id], reason: "  " }), "purge-invalid");
  assert.equal(store.records.length, 2, "nothing was appended");
  assert.equal(store.generation, 0);
});

test("only a message carries attachments: a board act, an annotation or a purge that names some is refused attachment-invalid", async (t) => {
  const { store } = await room(t);
  const m = await post(store, "a message");
  const attachments = [attachment(DIGEST_A, "a.txt")];
  await refusedAs(store.append(/** @type {any} */ ({ kind: "annotation", operationId: op(), authorName: "Ada", authorKind: "human",
    annotation: { act: "pin", target: m.id }, attachments }), LOCAL), "attachment-invalid");
  await refusedAs(store.append(/** @type {any} */ ({ kind: "board", operationId: op(), payload: { action: "claim", subject: "work:a" }, attachments }), LOCAL), "attachment-invalid");
  await refusedAs(purge(store, { targets: [m.id], reason: "r" }, { attachments }), "attachment-invalid");
  assert.equal(store.records.length, 1);
});

test("a crash after the next generation is written and before the boundary names it reopens on the old generation and finishes the purge", async (t) => {
  const { dir, store, reopen } = await room(t);
  const secret = await post(store, "the secret words");
  await post(store, "words that stay");
  const digests = store.records.map((r) => r.recordDigest);
  store.hooks = { purgeStage: (stage) => { if (stage === "generation-written") throw new Error("simulated crash"); } };
  await assert.rejects(purge(store, { targets: [secret.id], reason: "crash test" }), /simulated crash/);
  await store.close();
  assert.deepEqual(await generations(dir), ["room.frames", "room.frames.1"], "the half-done next generation is on disk");
  assert.equal(JSON.parse(await readFile(path.join(dir, "committed.json"), "utf8")).generation, 0, "the boundary still names generation 0");
  // spoil the half-done generation: a reopen that read it would refuse the room
  await writeFile(path.join(dir, "room.frames.1"), "not a log");

  /** @type {string[]} */
  const stages = [];
  const again = await reopen({ purgeStage: (/** @type {string} */ stage) => { stages.push(stage); } });
  assert.deepEqual(stages, ["generation-written", "boundary-installed"], "the open finished the purge from generation 0");
  assert.equal(again.generation, 1);
  assert.deepEqual(again.records.slice(0, 2).map((r) => r.recordDigest), digests);
  assert.equal(again.records[2].kind, "purge", "the purge record committed before the crash stands");
  assert.deepEqual(again.view().messages.map((m) => m.text), [undefined, "words that stay"]);
  assert.deepEqual(await generations(dir), ["room.frames.1"]);
  assert.equal((await readFile(path.join(dir, "room.frames.1"), "utf8")).includes("the secret"), false);
});

test("a crash after the boundary names the next generation removes the old one on open", async (t) => {
  const { dir, store, reopen } = await room(t);
  const secret = await post(store, "the secret words");
  store.hooks = { purgeStage: (stage) => { if (stage === "boundary-installed") throw new Error("simulated crash"); } };
  await assert.rejects(purge(store, { targets: [secret.id], reason: "crash test" }), /simulated crash/);
  await store.close();
  assert.deepEqual(await generations(dir), ["room.frames", "room.frames.1"], "the old generation outlived the crash");
  assert.equal((await readFile(path.join(dir, "room.frames"), "utf8")).includes("the secret"), true);
  /** @type {string[]} */
  const stages = [];
  const again = await reopen({ purgeStage: (/** @type {string} */ stage) => { stages.push(stage); } });
  assert.deepEqual(stages, [], "nothing left to rewrite");
  assert.equal(again.generation, 1);
  assert.deepEqual(await generations(dir), ["room.frames.1"], "the old generation, and the text in it, is gone");
  assert.equal(again.view().messages[0].text, undefined);
});

/**
 * Rewrite a room's log, re-sealing every frame, so the record-level checks are what decide.
 * @param {string} dir @param {string} file @param {(records: any[]) => void} edit
 */
async function rewriteLog(dir, file, edit) {
  const bytes = await readFile(path.join(dir, file));
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
  await writeFile(path.join(dir, file), out);
  const boundaryPath = path.join(dir, "committed.json");
  await writeFile(boundaryPath, JSON.stringify({ ...JSON.parse(await readFile(boundaryPath, "utf8")), end: out.length }, null, 2) + "\n");
}

test("on scan a record without its text must be named by a later purge; a purge's list must be what its targets name", async (t) => {
  // a text removed with no purge behind it
  const a = await room(t);
  await post(a.store, "first");
  await post(a.store, "second");
  await a.store.close();
  await rewriteLog(a.dir, "room.frames", (records) => { delete records[0].message.text; });
  await assert.rejects(a.reopen(), /sequence 1 has no text and no purge names it/);
  await rewriteLog(a.dir, "room.frames", (records) => { records[0].message.purged = { at: "2026-03-01T00:00:09.000Z", purge: "z".repeat(64) }; });
  await assert.rejects(a.reopen(), /sequence 1 has no text and no purge names it/);

  // a purged room whose purge record lists a message its targets do not name
  const b = await room(t);
  const m1 = await post(b.store, "first");
  await post(b.store, "second");
  await purge(b.store, { targets: [m1.id], reason: "r" });
  await b.store.close();
  await rewriteLog(b.dir, "room.frames.1", (records) => { records[2].purge.purged.push(records[1].message.id); });
  await assert.rejects(b.reopen(), /lists messages its targets and thread do not name/);

  // a text alongside a purge marker
  const c = await room(t);
  await post(c.store, "first");
  await c.store.close();
  await rewriteLog(c.dir, "room.frames", (records) => { records[0].message.purged = { at: "x", purge: "z".repeat(64) }; });
  await assert.rejects(c.reopen(), /carries a text and a purge marker/);
});

test("withdraw removes no bytes: the text stays in the log until a purge takes it", async (t) => {
  const { dir, store } = await room(t);
  const m = await post(store, "withdrawn but kept");
  await annotate(store, { act: "withdraw", target: m.id });
  assert.equal(store.generation, 0);
  assert.equal((await readFile(path.join(dir, "room.frames"), "utf8")).includes("withdrawn but kept"), true);
  // a withdrawn message can still be purged
  const receipt = await purge(store, { targets: [m.id], reason: "now remove it" });
  assert.deepEqual(receipt.purged, [m.id]);
  assert.equal((await readFile(path.join(dir, "room.frames.1"), "utf8")).includes("withdrawn but kept"), false);
});

// kills: view's thread narrowing of a purge (`thread !== undefined` flipped in `purges`, src/native-store.mjs
// view): a purge that took messages inside and outside a thread reads, in that thread's view, as the
// thread's messages only, and a purge that took none of them is absent from it
test("a thread view narrows a purge to the thread's messages and drops one that took none of them", async (t) => {
  const { store } = await room(t);
  const root = await post(store, "the root");
  const reply = await post(store, "a reply", { thread: root.id });
  const outside = await post(store, "outside the thread");
  const elsewhere = await post(store, "also outside");
  const since = `${EPOCH}:${store.records.length}`;
  const away = await purge(store, { targets: [elsewhere.id], reason: "not this thread" });
  const mixed = await purge(store, { targets: [outside.id, reply.id], reason: "one of each" });
  assert.deepEqual(mixed.purged, [reply.id, outside.id]);
  const whole = store.view();
  assert.deepEqual(whole.purges.map((p) => [p.id, p.purged]), [[away.id, [elsewhere.id]], [mixed.id, [reply.id, outside.id]]], "the room view keeps every purge whole");
  for (const view of [store.view({ thread: root.id }), store.view({ thread: root.id, since })]) {
    assert.deepEqual(view.purges.map((p) => [p.id, p.purged]), [[mixed.id, [reply.id]]], "the thread view names only the thread's message");
  }
});
