// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { NativeFrameDecoder, NATIVE_PROTOCOL, canonicalJson, encodeNativeFrame, nativeCursor, nativeDigest,
  nativeHandshakeProof, parseNativeCursor, validateNativeEnvelope, verifyNativeHandshakeProof } from "../src/native-protocol.mjs";

test("native protocol frames survive arbitrary chunk boundaries and several frames per chunk", () => {
  const values = [
    { protocol: NATIVE_PROTOCOL, type: "hello", requestId: "request_00000001", text: "line one\nline two" },
    { protocol: NATIVE_PROTOCOL, type: "heartbeat", requestId: "request_00000002", n: 2 },
  ];
  const bytes = Buffer.concat(values.map((value) => encodeNativeFrame(value)));
  const decoder = new NativeFrameDecoder();
  const found = [];
  for (let i = 0; i < bytes.length; i += 3) found.push(...decoder.push(bytes.subarray(i, i + 3)));
  decoder.finish();
  assert.deepEqual(found, values);
  assert.equal(validateNativeEnvelope(found[0]).type, "hello");
});

test("native protocol streams a large coalesced batch without buffering it as one frame", () => {
  const values = Array.from({ length: 2000 }, (_, i) => ({ protocol: NATIVE_PROTOCOL, type: "event", requestId: `request_${String(i).padStart(8, "0")}` }));
  const bytes = Buffer.concat(values.map((value) => encodeNativeFrame(value)));
  const decoder = new NativeFrameDecoder({ maximum: 128 });
  assert.deepEqual(decoder.push(bytes), values);
  assert.equal(decoder.buffer.length, 0);
});

test("native protocol refuses oversized, invalid and truncated frames", () => {
  assert.throws(() => encodeNativeFrame({ body: "x".repeat(100) }, 20), /must be 1-20 bytes/);
  const oversized = Buffer.alloc(4); oversized.writeUInt32BE(999, 0);
  assert.throws(() => new NativeFrameDecoder({ maximum: 20 }).push(oversized), /invalid 999-byte frame/);
  const invalid = Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from("{")]);
  assert.throws(() => new NativeFrameDecoder().push(invalid), /not valid JSON/);
  const decoder = new NativeFrameDecoder(); decoder.push(Buffer.from([0, 0, 0, 8, 1]));
  assert.throws(() => decoder.finish(), /ended inside a frame/);
});

test("native protocol refuses malformed UTF-8 instead of replacing bytes", () => {
  const malformed = Buffer.from([0, 0, 0, 2, 0xc3, 0x28]);
  assert.throws(() => new NativeFrameDecoder().push(malformed), /not valid UTF-8/);
});

test("native cursors carry epoch and monotonic sequence without trusting wall clocks", () => {
  const epoch = "a".repeat(32);
  assert.equal(nativeCursor(epoch, 42), `${epoch}:42`);
  assert.deepEqual(parseNativeCursor(`${epoch}:42`), { epoch, sequence: 42 });
  assert.throws(() => parseNativeCursor(`${epoch}:01`), /bad native room cursor/);
  assert.throws(() => parseNativeCursor(`wrong:1`), /bad native room cursor/);
});

test("native payload digests are independent of object key insertion order", () => {
  assert.equal(canonicalJson({ b: 2, a: [3, { z: true, y: null }] }), '{"a":[3,{"y":null,"z":true}],"b":2}');
  assert.equal(nativeDigest({ a: 1, b: 2 }), nativeDigest({ b: 2, a: 1 }));
  assert.notEqual(nativeDigest({ a: 1, b: 2 }), nativeDigest({ a: 1, b: 3 }));
});

test("native handshake proofs bind phase, boot epoch and the fresh transcript", () => {
  const secret = "service_secret_0000000000000001";
  const transcript = { bootEpoch: "a".repeat(32), requestId: "b".repeat(32), serverChallenge: "c".repeat(32),
    accountId: "seat_account_0001", seatLabel: "admin-pc" };
  const proof = nativeHandshakeProof(secret, "server", transcript);
  assert.equal(verifyNativeHandshakeProof(proof, secret, "server", transcript), true);
  assert.equal(verifyNativeHandshakeProof(proof, secret, "client", transcript), false);
  assert.equal(verifyNativeHandshakeProof(proof, secret, "server", { ...transcript, bootEpoch: "d".repeat(32) }), false);
});
