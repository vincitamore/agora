// @ts-check
// Durable attachments (docs/ATTACHMENTS.md) and annotations (docs/ANNOTATIONS.md) together, through
// agora/client against a real seat service: a message in a version 2 room that names custody bytes
// keeps them across an edit, and an edit carries no attachments of its own.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { foldAnnotations } from "../src/client.mjs";
import { NativeServiceClient } from "../src/native-service.mjs";
import { readServiceDescriptor } from "../src/wake/subscriber.mjs";
import { ROOM, seat } from "./client-fixtures.mjs";

const digestOf = (/** @type {Uint8Array} */ b) => `sha256:${createHash("sha256").update(b).digest("hex")}`;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DANA = { kind: /** @type {const} */ ("human"), name: "Dana", ref: "person.1" };

/** @param {ReadableStream<Uint8Array>} stream */
async function drain(stream) {
  /** @type {Uint8Array[]} */
  const parts = [];
  for await (const part of /** @type {any} */ (stream)) parts.push(part);
  return Buffer.concat(parts);
}

test("a version 2 room's message with durable attachments: upload, append, read with annotations, edit, and the bytes read back", { timeout: 60_000 }, async (t) => {
  const s = await seat(t);
  const manifest = JSON.parse(await readFile(path.join(s.root, "native", "rooms", ROOM, "room.json"), "utf8"));
  assert.equal(manifest.logVersion, 2, "the seat service makes version 2 rooms");
  const app = await s.open({ clientName: "example-app" });
  assert.ok(app.capabilities.has("attachments-v1") && app.capabilities.has("annotations-v1"));

  const picture = Buffer.concat([PNG_SIGNATURE, randomBytes(600 * 1024)]);
  const report = Buffer.from("%PDF-1.7\n" + "x".repeat(4096));
  const image = await app.upload("house", { bytes: picture, name: "site.png", width: 640, height: 480 });
  const file = await app.upload("house", { bytes: report, name: "report.pdf", mimetype: "application/pdf" });
  const posted = await app.append("house", { text: "the survey", author: DANA, attachments: [image, file] });

  const before = await app.read("house");
  assert.deepEqual(before.annotations, []);
  assert.equal(before.messages.length, 1);
  assert.deepEqual(before.messages[0].attachments, [image, file], "the message carries both references as uploaded");

  const edit = await app.annotate("house", { act: "edit", target: posted.id, text: "the survey, corrected", author: DANA });
  const after = await app.read("house");
  assert.deepEqual(after.messages, before.messages, "an edit never changes the committed message");
  assert.equal(after.annotations?.length, 1);
  const [annotation] = /** @type {any[]} */ (after.annotations);
  assert.deepEqual([annotation.id, annotation.act, annotation.target, annotation.text], [edit.id, "edit", posted.id, "the survey, corrected"]);
  assert.equal("attachments" in annotation, false, "an annotation carries no attachments");

  const [folded] = foldAnnotations(after.messages, after.annotations ?? []);
  assert.equal(folded.text, "the survey, corrected");
  assert.deepEqual(folded.attachments, [image, file], "the folded message keeps the attachments it was committed with");

  for (const [ref, bytes, kind, mimetype] of /** @type {const} */ ([[image, picture, "image", "image/png"], [file, report, "file", "application/pdf"]])) {
    const got = await app.attachment("house", { id: ref.id, digest: ref.digest });
    assert.deepEqual([got.size, got.kind, got.mimetype], [bytes.length, kind, mimetype]);
    const back = await drain(got.stream);
    assert.equal(digestOf(back), ref.digest, `${ref.name} reads back byte for byte after the edit`);
  }
});

test("an edit that names attachments inside its annotation is refused annotation-invalid and nothing is appended", { timeout: 30_000 }, async (t) => {
  const s = await seat(t);
  const app = await s.open();
  const first = await app.upload("house", { bytes: Buffer.concat([PNG_SIGNATURE, randomBytes(64)]), name: "a.png" });
  const second = await app.upload("house", { bytes: Buffer.concat([PNG_SIGNATURE, randomBytes(64)]), name: "b.png" });
  const posted = await app.append("house", { text: "one picture", author: { kind: "agent", name: "Grace/watch" }, attachments: [first] });
  const c = await NativeServiceClient.connect(/** @type {any} */ (await readServiceDescriptor(s.root)));
  t.after(() => c.close());
  // the raw frame: agora/client's annotate builds the annotation itself and has no way to say this
  await assert.rejects(c.request("append", { roomId: ROOM, operation: { kind: "annotation", operationId: "op_edit_with_attachment", authorName: "Grace/watch", authorKind: "agent",
    annotation: { act: "edit", target: posted.id, text: "two pictures", attachments: [second] } } }),
  (e) => { assert.equal(/** @type {any} */ (e).code, "annotation-invalid", String(e)); return true; });
  const read = await app.read("house");
  assert.deepEqual(read.annotations, []);
  assert.deepEqual(read.messages[0].attachments, [first]);
});
