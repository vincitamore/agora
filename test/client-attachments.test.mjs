// @ts-check
// Durable attachments through agora/client against a real seat service in a temporary state root
// (upload, append, read back, read the bytes), and against a stub service for the answers the real
// one cannot be made to give on command. The custody itself is test/native-attachments.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { connect } from "../src/client.mjs";
import { NativeServiceClient } from "../src/native-service.mjs";
import { custodyPath } from "../src/native-attachments.mjs";
import { durableAttachmentId } from "../src/protocol/attachment.mjs";
import { ADA, ROOM, failure, seat, stub } from "./client-fixtures.mjs";

const digestOf = (/** @type {Uint8Array} */ b) => `sha256:${createHash("sha256").update(b).digest("hex")}`;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The seat service offers `attachments-v1` once the capability joins the vocabulary and the local
 * offer (an integrator's patch beside this unit). Until then the frames are served but not offered,
 * so the client is told the offer here; once the service offers it this adds nothing.
 * @param {import('node:test').TestContext} t
 */
function offerCustody(t) {
  const original = NativeServiceClient.connect;
  NativeServiceClient.connect = async (endpoint) => {
    const c = await original.call(NativeServiceClient, endpoint);
    c.capabilities.add("attachments-v1");
    return c;
  };
  t.after(() => { NativeServiceClient.connect = original; });
}

/** @param {ReadableStream<Uint8Array>} stream */
async function drain(stream) {
  /** @type {Uint8Array[]} */
  const parts = [];
  for await (const part of /** @type {any} */ (stream)) parts.push(part);
  return Buffer.concat(parts);
}

test("a 25 MiB image round trip: upload, append, read back, and the bytes verified against the digest", { timeout: 120_000 }, async (t) => {
  offerCustody(t);
  const s = await seat(t);
  const app = await s.open({ clientName: "example-app" });
  const bytes = Buffer.concat([PNG_SIGNATURE, randomBytes(25 * 1024 * 1024 - PNG_SIGNATURE.length)]);
  const a = await app.upload("house", { bytes, name: "plan.vsdx", mimetype: "application/octet-stream", width: 1200, height: 800 });
  assert.deepEqual(a, { id: durableAttachmentId(ROOM, digestOf(bytes)), digest: digestOf(bytes), lifetime: "durable",
    name: "plan.vsdx", kind: "image", size: bytes.length, mimetype: "image/png", width: 1200, height: 800 });

  const receipt = await app.append("house", { text: "the drawing", author: ADA, attachments: [a] });
  const { messages } = await app.read("house");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, receipt.id);
  const [carried] = /** @type {any[]} */ (messages[0].attachments);
  for (const key of /** @type {const} */ (["id", "digest", "name", "kind", "size", "mimetype", "width", "height"]))
    assert.equal(carried[key], a[key], `the message carries the reference's ${key}`);
  assert.equal(carried.path, undefined, "a record never carries a path");

  const got = await app.attachment("house", { id: a.id, digest: a.digest });
  assert.deepEqual([got.size, got.kind, got.mimetype], [bytes.length, "image", "image/png"]);
  const back = await drain(got.stream);
  assert.equal(back.length, bytes.length);
  assert.equal(digestOf(back), a.digest);
});

test("an append naming bytes custody does not hold is refused and nothing is appended", { timeout: 30_000 }, async (t) => {
  offerCustody(t);
  const s = await seat(t);
  const app = await s.open();
  const absent = Buffer.from("never uploaded");
  const ref = { id: durableAttachmentId(ROOM, digestOf(absent)), digest: digestOf(absent), lifetime: /** @type {const} */ ("durable"),
    name: "x.txt", kind: /** @type {const} */ ("file"), size: absent.length };
  const e = await failure(app.append("house", { text: "with a ghost", author: ADA, attachments: [ref] }));
  assert.deepEqual([e.outcome, e.code], ["refused", "attachment-unknown"]);
  const eleven = await app.upload("house", { bytes: Buffer.from("a file"), name: "f.txt" });
  const many = await failure(app.append("house", { text: "too many", author: ADA, attachments: Array.from({ length: 11 }, () => eleven) }));
  assert.deepEqual([many.outcome, many.code], ["refused", "attachment-quota"]);
  assert.deepEqual((await app.read("house")).messages, []);
  const unknown = await failure(app.attachment("house", { id: ref.id, digest: ref.digest }));
  assert.deepEqual([unknown.outcome, unknown.code], ["refused", "attachment-unknown"]);
});

test("bytes altered in custody are never delivered as the attachment", { timeout: 60_000 }, async (t) => {
  offerCustody(t);
  const s = await seat(t);
  const app = await s.open();
  const room = path.join(s.root, "native", "rooms", ROOM);

  const small = Buffer.from("a short file");
  const a = await app.upload("house", { bytes: small, name: "s.txt" });
  await writeFile(custodyPath(room, a.digest), Buffer.from("a short fill"));
  const e = await failure(app.attachment("house", a));
  assert.deepEqual([e.outcome, e.code], ["refused", "attachment-digest-mismatch"], "one chunk: the call itself refuses");

  const large = randomBytes(600 * 1024);
  const b = await app.upload("house", { bytes: large, name: "l.bin" });
  const altered = Buffer.from(large); altered[altered.length - 1] ^= 1;
  await writeFile(custodyPath(room, b.digest), altered);
  const got = await app.attachment("house", b);
  /** @type {number} */
  let delivered = 0;
  await assert.rejects((async () => { for await (const part of /** @type {any} */ (got.stream)) delivered += part.length; })(),
    (err) => /** @type {any} */ (err).code === "attachment-digest-mismatch");
  assert.ok(delivered < large.length, "the last chunk is withheld");
});

test("a service that offers no custody is sent nothing; one that drops mid-upload is dark", { timeout: 30_000 }, async (t) => {
  const quiet = await stub(t, { offer: { advertised: ["threads-v1"], required: [] } });
  const app = await connect({ state: quiet.root, config: quiet.config });
  t.after(() => app.close());
  const e = await failure(app.upload("house", { bytes: Buffer.from("x"), name: "x" }));
  assert.deepEqual([e.outcome, e.code], ["refused", "attachments-unsupported"]);
  const r = await failure(app.attachment("house", { id: "z".repeat(64), digest: digestOf(Buffer.from("x")) }));
  assert.deepEqual([r.outcome, r.code], ["refused", "attachments-unsupported"]);
  assert.deepEqual(quiet.frames.filter((f) => String(f.type).startsWith("attachment-")), []);

  offerCustody(t);
  const dropping = await stub(t, { offer: { advertised: ["threads-v1"], required: [] },
    answer: (f) => (f.type === "attachment-begin" ? { type: "attachment-ready", uploadId: "upload_0000000001", chunkMax: 262144 } : f.type === "attachment-chunk" ? "drop" : undefined) });
  const other = await connect({ state: dropping.root, config: dropping.config });
  t.after(() => other.close());
  const d = await failure(other.upload("house", { bytes: Buffer.from("x"), name: "x" }));
  assert.equal(d.outcome, "dark");

  const tooBig = await failure(other.upload("house", { bytes: new Uint8Array(25 * 1024 * 1024 + 1), name: "x" }));
  assert.deepEqual([tooBig.outcome, tooBig.code], ["refused", "attachment-too-large"]);
});
