// @ts-check
// A purge's custody collection never takes bytes an append or an upload is about to reference
// (docs/PURGE.md): the collection reads the room's references under the custody lock that every
// install and every attachment-carrying append takes, and passes over a digest an upload holds.
// Each interleaving is forced through the service's test seams, so the order is the test's, not
// the scheduler's.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { connect } from "../src/client.mjs";
import { NativeRoomService } from "../src/native-service.mjs";

const ROOM = "4".repeat(32), EPOCH = "5".repeat(32), ACCOUNT = "seat_account_0004";
const GRACE = { kind: /** @type {const} */ ("agent"), name: "Grace/watch" };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(1024)]);
/** @param {string} file */
const exists = (file) => access(file).then(() => true, () => false);
const digestOf = (/** @type {Uint8Array} */ b) => `sha256:${createHash("sha256").update(b).digest("hex")}`;

/** @param {ReadableStream<Uint8Array>} stream */
async function drain(stream) {
  /** @type {Uint8Array[]} */
  const parts = [];
  for await (const part of /** @type {any} */ (stream)) parts.push(part);
  return Buffer.concat(parts);
}

/** A seat with its service in hand, for the seams. @param {import('node:test').TestContext} t */
async function seat(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-purge-custody-"));
  const service = new NativeRoomService({ root, accountId: ACCOUNT, seatLabel: "seat-c" });
  await service.start();
  await service.createRoom({ roomId: ROOM, epoch: EPOCH });
  const config = path.join(root, "agora.json");
  await writeFile(config, JSON.stringify({ actor: { name: "Grace/watch", kind: "agent" }, rooms: { house: { transport: "native", roomId: ROOM } } }));
  const app = await connect({ state: root, config });
  // a second connection: the service answers one connection's frames in order, so a purge that must
  // run while an append is paused mid-dispatch arrives on another
  const other = await connect({ state: root, config });
  t.after(async () => { app.close(); other.close(); await service.stop(); await rm(root, { recursive: true, force: true }); });
  const blob = path.join(root, "native", "rooms", ROOM, "attachments", `sha256-${digestOf(PNG).slice(7)}`);
  return { root, service, app, other, blob };
}

test("an append whose custody check passed commits before a purge's collection reads the references: the blob survives", { timeout: 60_000 }, async (t) => {
  const { service, app, other, blob } = await seat(t);
  const ref = await app.upload("house", { bytes: PNG, name: "panel.png" });
  const first = await app.append("house", { text: "the panel", author: GRACE, attachments: [ref] });
  /** @type {Promise<any> | undefined} */
  let purging;
  /** @type {() => void} */
  let requested = () => {};
  const collectionAsked = new Promise((resolve) => { requested = () => resolve(undefined); });
  service.testHooks = {
    // the second append has passed its custody check; before it commits, the purge of the first
    // message runs to the point where its collection asks for the custody lock
    afterCustodyCheck: async () => {
      service.testHooks = { collectionRequested: requested };
      purging = other.purge("house", { targets: [first.id], reason: "remove the first", author: GRACE });
      await collectionAsked;
    },
  };
  const second = await app.append("house", { text: "the same panel again", author: GRACE, attachments: [ref] });
  const receipt = await /** @type {Promise<any>} */ (purging);
  assert.deepEqual([receipt.purged, receipt.blobsRemoved], [[first.id], 0], "the collection saw the second append's reference");
  assert.equal(await exists(blob), true);
  assert.equal(await exists(`${blob}.type`), true);
  const got = await app.attachment("house", { id: ref.id, digest: ref.digest });
  assert.equal(digestOf(await drain(got.stream)), ref.digest);
  const read = await app.read("house");
  assert.deepEqual(read.messages.map((m) => [m.id, m.text]), [[first.id, ""], [second.id, "the same panel again"]]);
});

test("bytes re-uploaded before a purge are held until the append that names them: the collection passes over them", { timeout: 60_000 }, async (t) => {
  const { app, blob } = await seat(t);
  const ref = await app.upload("house", { bytes: PNG, name: "panel.png" });
  const first = await app.append("house", { text: "the panel", author: GRACE, attachments: [ref] });
  // the same bytes uploaded again: custody already holds them, and the upload holds the digest
  const again = await app.upload("house", { bytes: PNG, name: "panel-again.png" });
  assert.equal(again.digest, ref.digest);
  const receipt = await app.purge("house", { targets: [first.id], reason: "remove the first", author: GRACE });
  assert.equal(receipt.blobsRemoved, 0, "a held digest is not collected");
  assert.equal(await exists(blob), true);
  await app.append("house", { text: "posted after the purge", author: GRACE, attachments: [again] });
  const got = await app.attachment("house", { id: again.id, digest: again.digest });
  assert.equal(digestOf(await drain(got.stream)), again.digest);
  // with the hold ended by that append and its message purged too, the next purge collects the bytes
  const read = await app.read("house");
  const second = /** @type {any} */ (read.messages.at(-1));
  const last = await app.purge("house", { targets: [second.id], reason: "remove it all", author: GRACE });
  assert.equal(last.blobsRemoved, 1);
  assert.equal(await exists(blob), false);
});

test("an upload that commits while a purge's collection is waiting for the lock installs after it: the bytes are there for its append", { timeout: 60_000 }, async (t) => {
  const { service, app, other, blob } = await seat(t);
  const ref = await app.upload("house", { bytes: PNG, name: "panel.png" });
  const first = await app.append("house", { text: "the panel", author: GRACE, attachments: [ref] });
  /** @type {Promise<any> | undefined} */
  let uploading;
  service.testHooks = {
    // the collection has asked for the lock: an upload of the same bytes starts now, behind it
    collectionRequested: () => { service.testHooks = undefined; uploading = other.upload("house", { bytes: PNG, name: "panel-again.png" }); },
  };
  const receipt = await app.purge("house", { targets: [first.id], reason: "remove the first", author: GRACE });
  assert.equal(receipt.blobsRemoved, 1, "nothing referenced the bytes when the collection read the room");
  const again = await /** @type {Promise<any>} */ (uploading);
  assert.equal(await exists(blob), true, "the upload installed the bytes again after the collection");
  await app.append("house", { text: "posted after the purge", author: GRACE, attachments: [again] });
  const got = await app.attachment("house", { id: again.id, digest: again.digest });
  assert.equal(digestOf(await drain(got.stream)), again.digest);
});
