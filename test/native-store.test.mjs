// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { appendFile, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, symlink, truncate } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { NativeRoomStore } from "../src/native-store.mjs";

const ROOM = "1".repeat(32);
const EPOCH = "2".repeat(32);
const HOST = "seat_host_0000001";
const PEER = "seat_peer_0000001";

/** @param {import('node:test').TestContext} t */
async function room(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-native-room-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let tick = 0;
  const store = await NativeRoomStore.create({ root, roomId: ROOM, epoch: EPOCH, hostAccountId: HOST,
    now: () => new Date(Date.UTC(2026, 8, 5, 4, 0, tick++)) });
  t.after(() => store.close());
  return { root, store };
}

test("native room host serializes concurrent appends and assigns monotonic opaque cursors", async (t) => {
  const { store } = await room(t);
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => store.append({
    operationId: `operation_${String(i).padStart(8, "0")}`,
    authorName: "Peer/agent", text: `message ${i}`,
  }, { accountId: PEER })));
  assert.deepEqual(results.map((result) => result.cursor), Array.from({ length: 20 }, (_, i) => `${EPOCH}:${i + 1}`));
  const messages = store.read({ since: `${EPOCH}:0` });
  assert.equal(messages.length, 20);
  assert.deepEqual(messages.map((message) => message.cursor), results.map((result) => result.cursor));
  assert.ok(messages.every((message) => message.author.id === PEER), "identity comes from the authenticated route");
});

test("native room retries return the original receipt and conflicting reuse is refused", async (t) => {
  const { store } = await room(t);
  const input = { operationId: "operation_retry_001", authorName: "Peer/agent", text: "hello" };
  const first = await store.append(input, { accountId: PEER });
  const retry = await store.append(input, { accountId: PEER });
  assert.match(first.id, /^[a-f0-9]{64}$/);
  assert.deepEqual(first, { id: retry.id, cursor: `${EPOCH}:1`, duplicate: false });
  assert.deepEqual(retry, { id: first.id, cursor: `${EPOCH}:1`, duplicate: true });
  await assert.rejects(store.append({ ...input, text: "different" }, { accountId: PEER }), /already committed with different bytes/);
  assert.equal(store.status().committed, 1);
});

test("native room acceptance survives restart and reads never cross epochs or future positions", async (t) => {
  const { root, store } = await room(t);
  await store.append({ operationId: "operation_restart_1", authorName: "Peer", text: "one" }, { accountId: PEER });
  await store.close();
  const reopened = await NativeRoomStore.open({ root, roomId: ROOM });
  t.after(() => reopened.close());
  assert.equal(reopened.read({ since: `${EPOCH}:0` })[0].text, "one");
  assert.equal((await reopened.append({ operationId: "operation_restart_1", authorName: "Peer", text: "one" }, { accountId: PEER })).duplicate, true);
  assert.throws(() => reopened.read({ since: `${"3".repeat(32)}:0` }), /belongs to epoch/);
  assert.throws(() => reopened.read({ since: `${EPOCH}:99` }), /exceeds committed sequence/);
});

test("reader-held checkpoints witness an exact prefix rather than trusting a self-consistent log", async (t) => {
  const { store } = await room(t);
  await store.append({ operationId: "operation_anchor_01", authorName: "Peer", text: "one" }, { accountId: PEER });
  const anchor = store.checkpoint();
  await store.append({ operationId: "operation_anchor_02", authorName: "Peer", text: "two" }, { accountId: PEER });
  assert.deepEqual(store.assertCheckpoint(anchor), anchor, "a retained prefix survives later appends");
  assert.throws(() => store.assertCheckpoint({ ...anchor, digest: `sha256:${"f".repeat(64)}` }), /digest does not match/);
  assert.throws(() => store.assertCheckpoint({ ...anchor, epoch: "3".repeat(32) }), /another epoch/);
  assert.throws(() => store.assertCheckpoint({ ...anchor, sequence: 99 }), /sequence is unavailable/);
});

test("different authenticated authors cannot collide in Message.id", async (t) => {
  const { store } = await room(t);
  const input = { operationId: "operation_shared_01", authorName: "Agent", text: "same caller id" };
  const own = await store.append(input, { accountId: HOST });
  const foreign = await store.append(input, { accountId: PEER });
  assert.notEqual(own.id, foreign.id);
  assert.deepEqual(store.read().map((message) => message.id), [own.id, foreign.id]);
});

test("truncating an acknowledged frame is damage, never an unaccepted tail whose cursor may be reused", async (t) => {
  const { root, store } = await room(t);
  await store.append({ operationId: "operation_keep_001", authorName: "Peer", text: "retained" }, { accountId: PEER });
  await store.append({ operationId: "operation_lost_001", authorName: "Peer", text: "acknowledged" }, { accountId: PEER });
  const file = store.logPath;
  await store.close();
  await truncate(file, (await stat(file)).size - 1);
  await assert.rejects(NativeRoomStore.open({ root, roomId: ROOM }), /truncated below its acknowledged/);
});

test("one room has one OS-owned writer even when opened through separate store objects", async (t) => {
  const { root } = await room(t);
  await assert.rejects(NativeRoomStore.open({ root, roomId: ROOM }), /already has a live writer|writer endpoint is busy/);
});

test("filesystem aliases cannot mint a second writer authority for one physical room", async (t) => {
  const { root, store } = await room(t);
  const alias = `${root}-alias`;
  t.after(() => rm(alias, { force: true }));
  await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
  assert.equal(await realpath(alias), await realpath(root));
  await assert.rejects(NativeRoomStore.open({ root: alias, roomId: ROOM }), /already has a live writer|OS-owned endpoint/);
  assert.equal(store.status().committed, 0);
});

test("abrupt writer process death releases OS-owned room authority without stale reclaim", async (t) => {
  const { root, store } = await room(t);
  await store.close();
  const moduleUrl = new URL("../src/native-store.mjs", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e",
    "const {NativeRoomStore}=await import(process.argv[1]);await NativeRoomStore.open({root:process.argv[2],roomId:process.argv[3]});console.log('READY');setInterval(()=>{},1000)",
    moduleUrl, root, ROOM], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("child writer did not become ready")), 5000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("READY")) { clearTimeout(timer); resolve(undefined); }
    });
    child.once("exit", (code) => { if (!output.includes("READY")) { clearTimeout(timer); reject(new Error(`child writer exited ${code}`)); } });
  });
  await assert.rejects(NativeRoomStore.open({ root, roomId: ROOM }), /already has a live writer|OS-owned endpoint/);
  child.kill("SIGKILL");
  await once(child, "exit");
  const reopened = await NativeRoomStore.open({ root, roomId: ROOM });
  await reopened.close();
});

test("boundary publication failure preserves the synced frame for explicit reconciliation", async (t) => {
  const { root, store } = await room(t);
  const savedBoundary = `${store.boundaryPath}.saved`;
  await rename(store.boundaryPath, savedBoundary);
  await mkdir(store.boundaryPath);
  const before = (await stat(store.logPath)).size;
  await assert.rejects(store.append({ operationId: "operation_boundary_fail", authorName: "Peer", text: "unknown" }, { accountId: PEER }), /acceptance is unknown/);
  assert.ok((await stat(store.logPath)).size > before, "a possibly committed frame is not rolled back");
  await store.close();
  await rm(store.boundaryPath, { recursive: true, force: true });
  await rename(savedBoundary, store.boundaryPath);
  const tailBytes = (await stat(store.logPath)).size - before;
  const reopened = await NativeRoomStore.open({ root, roomId: ROOM });
  t.after(() => reopened.close());
  assert.equal(reopened.status().recoveredTailBytes, tailBytes);
  assert.equal(reopened.status().committed, 0);
});

test("post-publication temp cleanup failure does not revoke a durable room creation", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-native-create-cleanup-"));
  const originalRm = fs.rm;
  let injected = false;
  /** @type {NativeRoomStore | undefined} */
  let store;
  t.after(async () => {
    fs.rm = originalRm;
    syncBuiltinESMExports();
    if (store) await store.close();
    await originalRm(root, { recursive: true, force: true });
  });
  fs.rm = async (target, options) => {
    if (!injected && String(target).includes("committed.json.tmp-")) {
      injected = true;
      throw Object.assign(new Error("injected post-publication cleanup failure"), { code: "EIO" });
    }
    return originalRm(target, options);
  };
  syncBuiltinESMExports();
  store = await NativeRoomStore.create({ root, roomId: ROOM, epoch: EPOCH, hostAccountId: HOST });
  assert.equal(injected, true);
  assert.equal(store.status().committed, 0);
});

test("ambiguous creation publication preserves the room instead of deleting after release", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-native-create-unknown-"));
  const originalRename = fs.rename;
  let injected = false;
  /** @type {NativeRoomStore | undefined} */
  let reopened;
  t.after(async () => {
    fs.rename = originalRename;
    syncBuiltinESMExports();
    if (reopened) await reopened.close();
    await rm(root, { recursive: true, force: true });
  });
  fs.rename = async (source, target) => {
    await originalRename(source, target);
    if (!injected && String(target).endsWith("committed.json")) {
      injected = true;
      throw Object.assign(new Error("injected lost publication response"), { code: "EIO" });
    }
  };
  syncBuiltinESMExports();
  await assert.rejects(
    NativeRoomStore.create({ root, roomId: ROOM, epoch: EPOCH, hostAccountId: HOST }),
    /publication failed with unknown acceptance; state preserved/,
  );
  fs.rename = originalRename;
  syncBuiltinESMExports();
  assert.equal(injected, true);
  reopened = await NativeRoomStore.open({ root, roomId: ROOM });
  assert.equal(reopened.status().committed, 0);
});

test("the persisted resident-record ceiling refuses before memory grows without bound", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-native-limit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await NativeRoomStore.create({ root, roomId: ROOM, epoch: EPOCH, hostAccountId: HOST, recordLimit: 2 });
  t.after(() => store.close());
  await store.append({ operationId: "operation_limit_001", authorName: "Peer", text: "one" }, { accountId: PEER });
  await store.append({ operationId: "operation_limit_002", authorName: "Peer", text: "two" }, { accountId: PEER });
  await assert.rejects(store.append({ operationId: "operation_limit_003", authorName: "Peer", text: "three" }, { accountId: PEER }), /2-record resident limit/);
  assert.equal(store.status().recordLimit, 2);
});

test("a partial final frame is an unaccepted tail; restart removes it and reports the recovery", async (t) => {
  const { root, store } = await room(t);
  await store.append({ operationId: "operation_tail_0001", authorName: "Peer", text: "kept" }, { accountId: PEER });
  const logPath = store.logPath;
  await store.close();
  await appendFile(logPath, Buffer.from([0, 0, 0, 100, 123, 34, 120]));
  const reopened = await NativeRoomStore.open({ root, roomId: ROOM });
  t.after(() => reopened.close());
  assert.equal(reopened.status().recoveredTailBytes, 7);
  assert.deepEqual(reopened.read().map((message) => message.text), ["kept"]);
});

test("a complete corrupted record is refused and never truncated as crash recovery", async (t) => {
  const { root, store } = await room(t);
  await store.append({ operationId: "operation_corrupt_1", authorName: "Peer", text: "kept" }, { accountId: PEER });
  const logPath = store.logPath;
  await store.close();
  const bytes = await readFile(logPath);
  bytes[bytes.length - 1] ^= 0xff;
  const handle = await open(logPath, "r+");
  await handle.write(bytes, 0, bytes.length, 0); await handle.close();
  await assert.rejects(NativeRoomStore.open({ root, roomId: ROOM }), /checksum mismatch/);
  assert.equal((await readFile(logPath)).length, bytes.length, "corruption evidence remains intact");
});

test("native attachment records carry receiver-verifiable metadata, never sender paths", async (t) => {
  const { store } = await room(t);
  const attachment = { id: "attachment_000001", name: "screen.png", kind: "image", size: 3, digest: `sha256:${"a".repeat(64)}`, path: "C:\\secret\\screen.png" };
  await assert.rejects(store.append({ operationId: "operation_attach_1", authorName: "Peer", text: "see", attachments: [attachment] }, { accountId: PEER }), /never store sender-local/);
  const { path: _senderPath, ...safe } = attachment;
  await store.append({ operationId: "operation_attach_2", authorName: "Peer", text: "see", attachments: [safe] }, { accountId: PEER });
  assert.deepEqual(store.read()[0].attachments, [safe]);
});
