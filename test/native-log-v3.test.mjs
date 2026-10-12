// @ts-check
// Log version 3 (docs/PURGE.md, docs/NATIVE-ROOMS.md): a message's attachment list is committed by
// its digest inside the record digest and rides outside it, so a purge takes the entries (file name,
// size, kind) off the disk with the text. A version 2 room keeps working and purges as before, and
// `NativeRoomStore.upgrade` rewrites one as version 3, offline, verified, installed by one rename,
// with every sequence, cursor and earlier checkpoint standing; a kill before that rename leaves the
// version 2 room.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { NativeRoomStore, UPGRADE_BACKUP, attachmentsDigest } from "../src/native-store.mjs";

const ROOM = "e".repeat(32), EPOCH = "f".repeat(32), ACCOUNT = "seat_account_0001";
const LOCAL = { accountId: ACCOUNT };
const op = () => randomUUID().replaceAll("-", "");
const STORE_URL = new URL("../src/native-store.mjs", import.meta.url).href;
/** A file name that occurs nowhere else in a room's bytes. */
const NAME = "quarterly-forecast-zq7.pdf", KEPT = "kept-notes-zq7.txt";
/** @param {string} c @param {string} name */
const attachment = (c, name) => ({ id: `att_${c.repeat(20)}`, name, kind: "file", size: 10, digest: `sha256:${c.repeat(64)}` });

/** @param {import('node:test').TestContext} t */
async function tempRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-v3-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const clock = () => { let tick = Date.parse("2026-10-01T00:00:00.000Z"); return () => new Date(tick += 1000); };
/** @param {string} root */
const roomDir = (root) => path.join(root, "native", "rooms", ROOM);

/** @param {NativeRoomStore} store @param {string} text @param {Record<string, unknown>} [extra] */
const post = (store, text, extra = {}) => /** @type {Promise<any>} */ (store.append({ operationId: op(), authorName: "Ada", authorKind: "human", text, ...extra }, LOCAL));
/** @param {NativeRoomStore} store @param {string[]} targets */
const purge = (store, targets) =>
  /** @type {Promise<any>} */ (store.append(/** @type {any} */ ({ kind: "purge", operationId: op(), authorName: "Ada", authorKind: "human", purge: { targets, reason: "asked to remove it" } }), LOCAL));
/** @param {Promise<unknown>} p @param {string} code */
const refusedAs = (p, code) => assert.rejects(p, (e) => { assert.equal(/** @type {any} */ (e).code, code, String(e)); return true; });

/**
 * Every file under a room directory whose bytes contain `needle`: the grep the ruling asks for.
 * @param {string} dir @param {string} needle @returns {Promise<string[]>}
 */
async function grep(dir, needle) {
  /** @type {string[]} */
  const hits = [];
  for (const entry of await readdir(dir, { recursive: true })) {
    const file = path.join(dir, entry);
    if (!(await stat(file)).isFile()) continue;
    if ((await readFile(file)).includes(Buffer.from(needle, "utf8"))) hits.push(entry.replaceAll("\\", "/"));
  }
  return hits.sort();
}

/** A version 2 room with three messages (one carrying NAME), an edit and a board claim. @param {string} root @param {() => Date} now */
async function v2Room(root, now) {
  const store = await NativeRoomStore.create({ root, roomId: ROOM, epoch: EPOCH, hostAccountId: ACCOUNT, logVersion: 2, now });
  const plain = await post(store, "a plain message");
  const carrying = await post(store, "the forecast", { attachments: [attachment("a", NAME)] });
  const kept = await post(store, "notes that stay", { attachments: [attachment("b", KEPT)], thread: plain.id });
  await store.append(/** @type {any} */ ({ kind: "annotation", operationId: op(), authorName: "Ada", authorKind: "human", annotation: { act: "edit", target: plain.id, text: "a plain message, edited" } }), LOCAL);
  await store.append({ kind: "board", operationId: op(), payload: { action: "claim", subject: "work:x" } }, LOCAL);
  return { store, plain, carrying, kept };
}

test("a version 3 room: the record digest covers the attachment list's digest, the list rides outside it, and a reader never sees the digest", async (t) => {
  const root = await tempRoot(t);
  const now = clock();
  const store = await NativeRoomStore.create({ root, roomId: ROOM, epoch: EPOCH, hostAccountId: ACCOUNT, logVersion: 3, now });
  t.after(() => store.close());
  assert.deepEqual([store.logVersion, store.status().logVersion, store.status().generation], [3, 3, 0]);
  assert.equal(JSON.parse(await readFile(path.join(roomDir(root), "room.json"), "utf8")).logVersion, 3);
  assert.equal(JSON.parse(await readFile(path.join(roomDir(root), "committed.json"), "utf8")).logVersion, 3, "the boundary names the version it installs");
  const plain = await post(store, "no attachments");
  const carrying = await post(store, "with one", { attachments: [attachment("a", NAME)] });
  const record = store.records[1];
  assert.equal(record.version, 3);
  assert.equal(record.message.attachmentsDigest, attachmentsDigest([attachment("a", NAME)]));
  assert.equal("attachmentsDigest" in store.records[0].message, false, "a message without attachments carries no digest of them");
  assert.equal("v2Digest" in record, false, "a record written at version 3 carries no version 2 digest");
  const read = store.read();
  assert.deepEqual(read.map((m) => m.id), [plain.id, carrying.id]);
  assert.deepEqual(read[1].attachments, [attachment("a", NAME)]);
  assert.equal("attachmentsDigest" in read[1], false, "a reader never sees the record's own commitment");
  // a resend is the original receipt
  const resent = await store.append({ operationId: record.operationId, authorName: "Ada", authorKind: "human", text: "with one", attachments: [attachment("a", NAME)] }, LOCAL);
  assert.deepEqual(resent, { id: carrying.id, cursor: carrying.cursor, duplicate: true });
  await store.close();
  const again = await NativeRoomStore.open({ root, roomId: ROOM, now });
  t.after(() => again.close());
  assert.equal(again.logVersion, 3);
  assert.deepEqual(again.read(), read, "a reopen verifies and serves the same");
});

test("a purge of a version 3 message takes its attachment entry off the disk; custody still learns what it released", async (t) => {
  const root = await tempRoot(t);
  const now = clock();
  const store = await NativeRoomStore.create({ root, roomId: ROOM, epoch: EPOCH, hostAccountId: ACCOUNT, logVersion: 3, now });
  t.after(() => store.close());
  const carrying = await post(store, "the forecast", { attachments: [attachment("a", NAME)] });
  const kept = await post(store, "notes that stay", { attachments: [attachment("b", KEPT)] });
  const checkpoint = store.checkpoint();
  assert.deepEqual(await grep(roomDir(root), NAME), ["room.frames"], "before the purge the log names the file");
  const receipt = await purge(store, [carrying.id]);
  assert.deepEqual(receipt.purged, [carrying.id]);
  assert.deepEqual(await grep(roomDir(root), NAME), [], "after the purge no file under the room names it");
  assert.deepEqual(await grep(roomDir(root), KEPT), ["room.frames.1"], "an unpurged message keeps its entry");
  const stored = store.records[0].message;
  assert.equal("attachments" in stored || "text" in stored, false);
  assert.ok(stored.attachmentsDigest, "the digest stays, inside the record digest");
  assert.deepEqual(store.records[2].purge.released, [`sha256:${"a".repeat(64)}`], "the purge record names the custody it released");
  assert.deepEqual([...store.custodyCensus().released], [`sha256:${"a".repeat(64)}`]);
  assert.equal("released" in store.view().purges[0], false, "a reader never sees the custody digests");
  assert.deepEqual(store.assertCheckpoint(checkpoint), checkpoint, "every digest stands");
  await store.close();
  const again = await NativeRoomStore.open({ root, roomId: ROOM, now });
  t.after(() => again.close());
  assert.deepEqual(again.read().map((m) => [m.id, m.text, "attachments" in m]), [[carrying.id, undefined, false], [kept.id, "notes that stay", true]]);
  assert.deepEqual([...again.custodyCensus().released], [`sha256:${"a".repeat(64)}`], "and still after a reopen");
});

test("a version 2 room still opens and purges as before: served without the attachments, the entries kept on disk", async (t) => {
  const root = await tempRoot(t);
  const now = clock();
  const { store, carrying } = await v2Room(root, now);
  t.after(() => store.close());
  await purge(store, [carrying.id]);
  assert.equal(store.logVersion, 2);
  assert.equal("attachments" in store.read().find((m) => m.id === carrying.id), false);
  assert.deepEqual(await grep(roomDir(root), NAME), ["room.frames.1"], "a version 2 record digest covers the entry, so the log keeps it");
  assert.deepEqual([...store.custodyCensus().released], [`sha256:${"a".repeat(64)}`]);
  await store.close();
  const again = await NativeRoomStore.open({ root, roomId: ROOM, now });
  t.after(() => again.close());
  assert.equal(again.logVersion, 2);
});

test("upgrade rewrites a version 2 room as version 3 record by record: sequences, cursors, ids and payloads stay, earlier checkpoints stay valid", async (t) => {
  const root = await tempRoot(t);
  const now = clock();
  const { store, carrying, plain } = await v2Room(root, now);
  const before = store.records.map((r) => structuredClone(r));
  const served = store.view();
  const checkpoints = [0, 1, 3, store.records.length].map((n) => store.checkpoint(n));
  // a room with a live writer is refused, and nothing changes
  await refusedAs(NativeRoomStore.upgrade({ root, roomId: ROOM }), "room-in-use");
  await store.close();
  const v2bytes = await readFile(path.join(roomDir(root), "room.frames"));

  const receipt = await NativeRoomStore.upgrade({ root, roomId: ROOM, now });
  assert.deepEqual([receipt.from, receipt.to, receipt.records, receipt.generation, receipt.epoch, receipt.attachmentEntriesDropped], [2, 3, before.length, 1, EPOCH, 0]);
  assert.equal(receipt.v2Digest, before.at(-1).recordDigest);
  // the backup is the version 2 room exactly
  assert.deepEqual(await readFile(path.join(roomDir(root), UPGRADE_BACKUP, "room.frames")), v2bytes);
  assert.deepEqual((await readdir(roomDir(root))).filter((n) => n.startsWith("room.frames")), ["room.frames.1"]);
  assert.equal(JSON.parse(await readFile(path.join(roomDir(root), "room.json"), "utf8")).logVersion, 3);

  const v3 = await NativeRoomStore.open({ root, roomId: ROOM, now });
  t.after(() => v3.close());
  assert.equal(v3.logVersion, 3);
  assert.equal(v3.records.length, before.length);
  for (let i = 0; i < before.length; i++) {
    const [was, is] = [before[i], v3.records[i]];
    assert.deepEqual([is.version, is.sequence, is.operationId, is.payloadDigest, is.v2Digest], [3, was.sequence, was.operationId, was.payloadDigest, was.recordDigest], `record ${i + 1}`);
    assert.equal(is.message?.cursor ?? is.annotation?.cursor ?? is.cursor, was.message?.cursor ?? was.annotation?.cursor ?? was.cursor);
    assert.notEqual(is.recordDigest, was.recordDigest, "the digest is recomputed under version 3 rules");
  }
  assert.ok(v3.records[1].message.attachmentsDigest);
  assert.deepEqual(v3.view(), served, "a reader is served exactly what it was");
  for (const c of checkpoints) assert.deepEqual(v3.assertCheckpoint(c), v3.checkpoint(c.sequence), `a checkpoint at ${c.sequence} from before the upgrade re-anchors`);
  assert.throws(() => v3.assertCheckpoint({ ...checkpoints[2], digest: `sha256:${"1".repeat(64)}` }), /digest does not match/);
  // a resend of an operation committed before the upgrade is still its original receipt
  const resent = await v3.append({ operationId: before[0].operationId, authorName: "Ada", authorKind: "human", text: "a plain message" }, LOCAL);
  assert.deepEqual(resent, { id: plain.id, cursor: plain.cursor, duplicate: true });

  // after the upgrade (and the backup's prune) a purge leaves no file in the room naming the attachment
  await refusedAs(NativeRoomStore.upgrade({ root, roomId: ROOM }), "room-in-use");
  await v3.close();
  await refusedAs(NativeRoomStore.upgrade({ root, roomId: ROOM }), "upgrade-not-needed");
  assert.deepEqual(await grep(roomDir(root), NAME), ["room.frames.1", `${UPGRADE_BACKUP}/room.frames`], "the backup names it until it is pruned");
  const pruned = await NativeRoomStore.pruneUpgradeBackup({ root, roomId: ROOM });
  assert.deepEqual([pruned.roomId, pruned.removed, pruned.logVersion, path.basename(pruned.backup)], [ROOM, true, 3, UPGRADE_BACKUP]);
  await assert.rejects(stat(path.join(roomDir(root), UPGRADE_BACKUP)), /ENOENT/);
  assert.equal((await NativeRoomStore.pruneUpgradeBackup({ root, roomId: ROOM })).removed, false);
  const after = await NativeRoomStore.open({ root, roomId: ROOM, now });
  t.after(() => after.close());
  await purge(after, [carrying.id]);
  assert.deepEqual(await grep(roomDir(root), NAME), [], "the upgraded room's purge takes the name off the disk");
  assert.deepEqual(await grep(roomDir(root), KEPT), ["room.frames.2"]);
});

test("upgrade of a room whose purge ran at version 2 takes those entries off the disk too, and names their custody on the purge", async (t) => {
  const root = await tempRoot(t);
  const now = clock();
  const { store, carrying } = await v2Room(root, now);
  const taken = await purge(store, [carrying.id]);
  await store.close();
  const receipt = await NativeRoomStore.upgrade({ root, roomId: ROOM, now });
  assert.equal(receipt.attachmentEntriesDropped, 1);
  await NativeRoomStore.pruneUpgradeBackup({ root, roomId: ROOM });
  assert.deepEqual(await grep(roomDir(root), NAME), []);
  const v3 = await NativeRoomStore.open({ root, roomId: ROOM, now });
  t.after(() => v3.close());
  assert.deepEqual(v3.records.find((r) => r.purge?.id === taken.id).purge.released, [`sha256:${"a".repeat(64)}`]);
  assert.deepEqual([...v3.custodyCensus().released], [`sha256:${"a".repeat(64)}`]);
});

test("upgrade refuses a version 1 room and a room in use by name", async (t) => {
  const root = await tempRoot(t);
  const v1 = await NativeRoomStore.create({ root, roomId: ROOM, epoch: EPOCH, hostAccountId: ACCOUNT });
  await post(v1, "one");
  await v1.close();
  await refusedAs(NativeRoomStore.upgrade({ root, roomId: ROOM }), "upgrade-unsupported-log-version");
  assert.equal(JSON.parse(await readFile(path.join(roomDir(root), "room.json"), "utf8")).logVersion, undefined, "nothing was changed");
});

/**
 * Run an upgrade in a child process that kills itself (SIGKILL: no handler, no cleanup) at a stage.
 * @param {string} root @param {string} stage @param {number} [frames]
 */
function killedUpgrade(root, stage, frames = 0) {
  const script = `import { NativeRoomStore } from ${JSON.stringify(STORE_URL)};
await NativeRoomStore.upgrade({ root: ${JSON.stringify(root)}, roomId: ${JSON.stringify(ROOM)}, hooks: { upgradeStage: (s, n) => {
  if (s === ${JSON.stringify(stage)} && (${frames} === 0 || n === ${frames})) process.kill(process.pid, "SIGKILL");
} } });
console.log("not killed");`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", windowsHide: true, timeout: 60_000 });
  assert.equal(r.stdout.includes("not killed"), false, `the child reached the end: ${r.stdout}${r.stderr}`);
  assert.equal(r.status === 0, false, "the child was killed");
}

test("an upgrade killed mid-write, or after the generation is written, leaves the room openable at version 2; a rerun installs it", async (t) => {
  const root = await tempRoot(t);
  const now = clock();
  const { store } = await v2Room(root, now);
  const before = store.records.map((r) => r.recordDigest);
  const served = store.view();
  await store.close();
  for (const [stage, frames] of /** @type {Array<[string, number]>} */ ([["frame-written", 2], ["generation-written", 0]])) {
    killedUpgrade(root, stage, frames);
    const names = await readdir(roomDir(root));
    assert.ok(names.includes("room.frames.1"), `${stage}: the half-done generation is on disk`);
    const reopened = await NativeRoomStore.open({ root, roomId: ROOM, now });
    assert.equal(reopened.logVersion, 2, `${stage}: the room opens at version 2`);
    assert.deepEqual(reopened.records.map((r) => r.recordDigest), before);
    assert.deepEqual(reopened.view(), served);
    await reopened.close();
    assert.deepEqual((await readdir(roomDir(root))).filter((n) => n.startsWith("room.frames")), ["room.frames"], `${stage}: the open removed what no boundary names`);
  }
  const receipt = await NativeRoomStore.upgrade({ root, roomId: ROOM, now });
  assert.equal(receipt.to, 3);
  const v3 = await NativeRoomStore.open({ root, roomId: ROOM, now });
  t.after(() => v3.close());
  assert.deepEqual(v3.view(), served);
});

test("an upgrade killed after the boundary installs it opens at version 3 and the open finishes the manifest", async (t) => {
  const root = await tempRoot(t);
  const now = clock();
  const { store } = await v2Room(root, now);
  const served = store.view();
  await store.close();
  killedUpgrade(root, "boundary-installed");
  assert.equal(JSON.parse(await readFile(path.join(roomDir(root), "room.json"), "utf8")).logVersion, 2, "the manifest rewrite never ran");
  const v3 = await NativeRoomStore.open({ root, roomId: ROOM, now });
  t.after(() => v3.close());
  assert.equal(v3.logVersion, 3);
  assert.deepEqual(v3.view(), served);
  assert.equal(JSON.parse(await readFile(path.join(roomDir(root), "room.json"), "utf8")).logVersion, 3, "the open finished it");
  assert.deepEqual((await readdir(roomDir(root))).filter((n) => n.startsWith("room.frames")), ["room.frames.1"]);
});

test("a corrupt version 3 record is refused by name", async (t) => {
  const root = await tempRoot(t);
  const now = clock();
  const store = await NativeRoomStore.create({ root, roomId: ROOM, epoch: EPOCH, hostAccountId: ACCOUNT, logVersion: 3, now });
  await post(store, "with one", { attachments: [attachment("a", NAME)] });
  await store.close();
  // rename the attachment in the log and re-seal the frame: the frame's checksum passes, so the
  // attachments digest is what refuses
  const file = path.join(roomDir(root), "room.frames");
  const bytes = await readFile(file);
  const length = bytes.readUInt32BE(0);
  const record = JSON.parse(bytes.subarray(4, 4 + length).toString("utf8"));
  record.message.attachments[0].name = "renamed-zq7.pdf";
  const payload = Buffer.from(JSON.stringify(record), "utf8");
  const header = Buffer.alloc(4); header.writeUInt32BE(payload.length, 0);
  const { createHash } = await import("node:crypto");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(file, Buffer.concat([header, payload, createHash("sha256").update(payload).digest()]));
  const boundaryPath = path.join(roomDir(root), "committed.json");
  const boundary = JSON.parse(await readFile(boundaryPath, "utf8"));
  await writeFile(boundaryPath, JSON.stringify({ ...boundary, end: 4 + payload.length + 32 }, null, 2) + "\n");
  const opened = NativeRoomStore.open({ root, roomId: ROOM, now }).then((s) => { s.close(); return s; });
  await assert.rejects(opened, /message at sequence 1 carries attachments that do not match their attachments digest/);
});
