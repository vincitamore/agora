// @ts-check
// Pins for the input-validation survivors of the consumer mutation sweep in src/native-store.mjs
// (class b of scripts/mutate-consumers.mjs's report): the `||`-joined refusal chains on a post's
// fields and on attachment metadata, and the record-limit option, where swapping a connective or
// moving a bound by one admits the malformed input and no importing test fed one. Each test feeds
// the exact input the mutant would admit, at the boundary, from both sides.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NativeRoomStore } from "../src/native-store.mjs";

const ROOM = "7".repeat(32);
const EPOCH = "8".repeat(32);
const HOST = "seat_host_0000001";
let n = 0;
const OP = () => `operation_input_${String(++n).padStart(4, "0")}`;

/** @param {import('node:test').TestContext} t */
async function room(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-store-inputs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await NativeRoomStore.create({ root, roomId: ROOM, epoch: EPOCH, hostAccountId: HOST });
  t.after(() => store.close());
  return store;
}
/** @param {NativeRoomStore} store @param {Record<string, unknown>} fields */
const post = (store, fields) => store.append({ operationId: OP(), authorName: "A", authorKind: "agent", text: "t", ...fields }, { accountId: HOST });
const DIGEST = `sha256:${"a".repeat(64)}`;
/** @param {Record<string, unknown>} [over] */
const attachment = (over = {}) => ({ id: "attachment_0000000001", name: "a.png", kind: "image", size: 1, digest: DIGEST, ...over });

test("a post's author label is a non-blank string of at most 120 characters (survivor 434)", async (t) => {
  const store = await room(t);
  await assert.rejects(post(store, { authorName: 7 }), /bounded author label/);
  await assert.rejects(post(store, { authorName: "   " }), /bounded author label/);
  await assert.rejects(post(store, { authorName: "x".repeat(121) }), /bounded author label/);
  await post(store, { authorName: "x".repeat(120) });
  assert.equal(store.status().committed, 1);
});

test("a post's text is a string of at most 256 KiB (survivor 436)", async (t) => {
  const store = await room(t);
  await assert.rejects(post(store, { text: 42 }), /text exceeds/);
  await assert.rejects(post(store, { text: "y".repeat(256 * 1024 + 1) }), /text exceeds/);
  await post(store, { text: "y".repeat(256 * 1024) });
  assert.equal(store.status().committed, 1);
});

test("attachments are an array of at most 32 (survivor 438)", async (t) => {
  const store = await room(t);
  await assert.rejects(post(store, { attachments: "not-a-list" }), /more than 32 attachments/);
  await assert.rejects(post(store, { attachments: Array.from({ length: 33 }, (_, i) => attachment({ id: `attachment_${String(i).padStart(10, "0")}` })) }), /more than 32 attachments/);
  await post(store, { attachments: Array.from({ length: 32 }, (_, i) => attachment({ id: `attachment_${String(i).padStart(10, "0")}` })) });
  assert.equal(store.read()[0].attachments?.length, 32);
});

test("attachment metadata is refused field by field, at each boundary (survivors 214-226)", async (t) => {
  const store = await room(t);
  const refused = async (/** @type {unknown} */ a, /** @type {RegExp} */ re) => assert.rejects(post(store, { attachments: [a] }), re);
  await refused(null, /must be an object/);
  await refused("x", /must be an object/);
  await refused([attachment()], /must be an object/);
  await refused(attachment({ id: 5 }), /needs an id/);
  await refused(attachment({ name: "" }), /bounded name/);
  await refused(attachment({ name: 9 }), /bounded name/);
  await refused(attachment({ name: "n".repeat(256) }), /bounded name/);
  await refused(attachment({ kind: "video" }), /kind must be image or file/);
  await refused(attachment({ digest: "sha256:short" }), /sha256 digest/);
  await refused(attachment({ digest: 1 }), /sha256 digest/);
  await refused(attachment({ size: -1 }), /non-negative byte size/);
  await refused(attachment({ size: 1.5 }), /non-negative byte size/);
  await refused(attachment({ size: "1" }), /non-negative byte size/);
  // the accepted shape at every boundary, and the optional fields kept only when well-formed
  await post(store, { attachments: [attachment({ name: "n".repeat(255), kind: "file", size: 0, mimetype: "m".repeat(300), width: 0, height: -3 })] });
  const stored = /** @type {any} */ (store.read()[0].attachments?.[0]);
  assert.equal(stored.name.length, 255);
  assert.equal(stored.size, 0);
  assert.equal(stored.mimetype.length, 200, "a mimetype is cut at 200");
  assert.equal(stored.width, undefined, "a non-positive width is dropped, not stored");
  assert.equal(stored.height, undefined);
  await post(store, { attachments: [attachment({ width: 1, height: 2, mimetype: 7 })] });
  const dims = /** @type {any} */ (store.read()[1].attachments?.[0]);
  assert.deepEqual([dims.width, dims.height, dims.mimetype], [1, 2, undefined]);
});

test("the record limit option is bounded 1..10,000,000 (survivor 330)", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-store-inputs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const make = (/** @type {number} */ recordLimit, /** @type {string} */ id) => NativeRoomStore.create({ root, roomId: id, epoch: EPOCH, hostAccountId: HOST, recordLimit });
  await assert.rejects(make(0, "1".repeat(32)), /record limit must be 1-10000000/);
  await assert.rejects(make(10_000_001, "2".repeat(32)), /record limit must be 1-10000000/);
  await assert.rejects(make(1.5, "3".repeat(32)), /record limit must be 1-10000000/);
  const one = await make(1, "4".repeat(32));
  t.after(() => one.close());
  const max = await make(10_000_000, "5".repeat(32));
  t.after(() => max.close());
  assert.equal(one.status().recordLimit, 1);
  assert.equal(max.status().recordLimit, 10_000_000);
});

test("a stored frame is bounded by the record maximum (survivor 177)", async (t) => {
  const store = await room(t);
  // the text bound (256 KiB) is below the frame bound (1 MiB), so a frame can only cross it
  // through attachments: thirty-two names of 255 characters and the text together stay under it
  await post(store, { text: "z".repeat(256 * 1024), attachments: Array.from({ length: 32 }, (_, i) => attachment({ id: `attachment_${String(i).padStart(10, "0")}`, name: "n".repeat(255) })) });
  assert.equal(store.status().committed, 1);
});
