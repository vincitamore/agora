// @ts-check
// Purge (docs/PURGE.md) through the seat service and agora/client: custody lets go of the blobs and
// custody records no unpurged message references and keeps the rest, a reader's cursor from before
// the purge reads and subscribes on, a version 1 room refuses, only a message carries attachments
// (no silent drop), and a collection a crash interrupted is finished when the room is opened again.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { NativeRoomStore } from "../src/native-store.mjs";
import { NativeServiceClient } from "../src/native-service.mjs";
import { readServiceDescriptor } from "../src/wake/subscriber.mjs";
import { ACCOUNT, ROOM, seat } from "./client-fixtures.mjs";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GRACE = { kind: /** @type {const} */ ("agent"), name: "Grace/watch" };
const op = () => randomUUID().replaceAll("-", "");
/** @param {string} root @param {string} digest */
const blobPath = (root, digest) => path.join(root, "native", "rooms", ROOM, "attachments", `sha256-${digest.slice(7)}`);
/** @param {string} file */
const exists = (file) => access(file).then(() => true, () => false);
/** @param {Promise<unknown>} p @param {string} code */
const refusedAs = (p, code) => assert.rejects(p, (e) => { assert.equal(/** @type {any} */ (e).code, code, String(e)); return true; });

test("a thread purge removes the replies' text and the blobs and custody records only they referenced; shared bytes survive", { timeout: 60_000 }, async (t) => {
  const s = await seat(t);
  const app = await s.open();
  const onlyRoot = await app.upload("house", { bytes: Buffer.concat([PNG_SIGNATURE, randomBytes(512)]), name: "root.png" });
  const onlyReply = await app.upload("house", { bytes: Buffer.from("plain bytes only the reply names\n"), name: "notes.txt", mimetype: "text/plain" });
  const shared = await app.upload("house", { bytes: Buffer.concat([PNG_SIGNATURE, randomBytes(256)]), name: "shared.png" });
  const root = await app.append("house", { text: "the root, private", author: GRACE, attachments: [onlyRoot, shared] });
  const reply = await app.append("house", { text: "a reply, private", author: GRACE, thread: root.id, attachments: [onlyReply] });
  const kept = await app.append("house", { text: "elsewhere", author: GRACE, attachments: [shared] });
  const before = await app.read("house");
  const through = before.through;

  const receipt = await app.purge("house", { thread: root.id, reason: "the thread is removed", author: GRACE });
  assert.deepEqual([receipt.purged, receipt.blobsRemoved, receipt.facesOutOfReach, receipt.duplicate], [[root.id, reply.id], 2, [], false]);
  for (const ref of [onlyRoot, onlyReply]) {
    assert.equal(await exists(blobPath(s.root, ref.digest)), false, `${ref.name}'s blob is removed`);
    assert.equal(await exists(`${blobPath(s.root, ref.digest)}.type`), false, `${ref.name}'s custody record is removed`);
  }
  assert.equal(await exists(blobPath(s.root, shared.digest)), true, "bytes an unpurged message references survive");
  assert.equal(await exists(`${blobPath(s.root, shared.digest)}.type`), true);
  const back = await app.attachment("house", { id: shared.id, digest: shared.digest });
  assert.equal(back.size, shared.size);
  await refusedAs(app.attachment("house", { id: onlyRoot.id, digest: onlyRoot.digest }), "attachment-unknown");

  // the read: purged messages keep their place and metadata, with no text and the purge's marker
  const after = await app.read("house");
  const marker = { at: /** @type {string} */ (after.messages[0].purged?.at), purge: receipt.id };
  assert.deepEqual(after.messages.map((m) => [m.id, m.text, m.purged]), [[root.id, "", marker], [reply.id, "", marker], [kept.id, "elsewhere", undefined]]);
  assert.deepEqual(after.messages[0].attachments, [onlyRoot, shared], "attachment metadata is kept");
  // a reader holding the cursor from before the purge reads on without refusal, and subscribes on
  const onward = await app.read("house", { since: through });
  assert.deepEqual(onward.messages, []);
  /** @type {string[]} */
  const seen = [];
  const sub = await app.subscribe("house", { since: through }, { message: (m) => seen.push(m.text) });
  await app.append("house", { text: "after the purge", author: GRACE });
  for (let i = 0; i < 50 && !seen.length; i++) await new Promise((r) => setTimeout(r, 20));
  sub.close();
  assert.deepEqual(seen, ["after the purge"]);

  // a resend is the original receipt
  const again = await app.purge("house", { thread: root.id, reason: "the thread is removed", author: GRACE, operationId: receipt.operationId });
  assert.deepEqual([again.id, again.duplicate, again.purged, again.blobsRemoved], [receipt.id, true, [root.id, reply.id], 0]);
});

test("a collection a crash interrupted is finished when the service opens the room again", { timeout: 60_000 }, async (t) => {
  const s = await seat(t);
  const app = await s.open();
  const bytes = Buffer.from("bytes the purge releases\n");
  const ref = await app.upload("house", { bytes, name: "gone.txt", mimetype: "text/plain" });
  const m = await app.append("house", { text: "carries it", author: GRACE, attachments: [ref] });
  await app.purge("house", { targets: [m.id], reason: "remove", author: GRACE });
  app.close();
  await s.stop();
  // put the blob back, as if the crash came between the purge's boundary and custody's collection
  await writeFile(blobPath(s.root, ref.digest), bytes);
  await writeFile(`${blobPath(s.root, ref.digest)}.type`, JSON.stringify({ kind: "file", mimetype: "text/plain" }));
  await s.start();
  const again = await s.open();
  await again.read("house");
  assert.equal(await exists(blobPath(s.root, ref.digest)), false);
  assert.equal(await exists(`${blobPath(s.root, ref.digest)}.type`), false);
});

test("only a message carries attachments: an annotation or a board act naming a valid custody reference is refused attachment-invalid, not stored without it", { timeout: 60_000 }, async (t) => {
  const s = await seat(t);
  const app = await s.open();
  const ref = await app.upload("house", { bytes: Buffer.concat([PNG_SIGNATURE, randomBytes(64)]), name: "a.png" });
  const posted = await app.append("house", { text: "one picture", author: GRACE, attachments: [ref] });
  const c = await NativeServiceClient.connect(/** @type {any} */ (await readServiceDescriptor(s.root)));
  t.after(() => c.close());
  await refusedAs(c.request("append", { roomId: ROOM, operation: { kind: "annotation", operationId: op(), authorName: "Grace/watch", authorKind: "agent",
    annotation: { act: "pin", target: posted.id }, attachments: [ref] } }), "attachment-invalid");
  await refusedAs(c.request("append", { roomId: ROOM, operation: { kind: "board", operationId: op(), authorName: "Grace/watch", authorKind: "agent",
    payload: { action: "claim", subject: "work:pictures" }, attachments: [ref] } }), "attachment-invalid");
  await refusedAs(c.request("append", { roomId: ROOM, operation: { kind: "purge", operationId: op(), authorName: "Grace/watch", authorKind: "agent",
    purge: { targets: [posted.id], reason: "r" }, attachments: [ref] } }), "attachment-invalid");
  const read = await app.read("house");
  assert.deepEqual(read.annotations, [], "no annotation was appended");
  assert.equal(read.messages.length, 1);
  assert.equal(read.through.endsWith(":1"), true, "nothing was appended after the message");
});

test("a version 1 room refuses purge through the service", { timeout: 60_000 }, async (t) => {
  const s = await seat(t);
  const v1 = "9".repeat(32);
  const store = await NativeRoomStore.create({ root: s.root, roomId: v1, hostAccountId: ACCOUNT });
  const m = await store.append({ operationId: op(), authorName: "Ada", authorKind: "human", text: "kept" }, { accountId: ACCOUNT });
  await store.close();
  const app = await s.open();
  const dir = path.join(s.root, "native", "rooms", v1);
  const before = createHash("sha256").update(await readFile(path.join(dir, "room.frames"))).digest("hex");
  await refusedAs(app.purge({ roomId: v1 }, { targets: [m.id], reason: "r", author: GRACE }), "purge-unsupported-log-version");
  assert.equal("generation" in JSON.parse(await readFile(path.join(dir, "committed.json"), "utf8")), false);
  assert.equal(createHash("sha256").update(await readFile(path.join(dir, "room.frames"))).digest("hex"), before, "the log is byte for byte what it was");
  assert.equal((await app.read({ roomId: v1 })).messages[0].text, "kept");
});
