// A native post names its message id before the append leaves the seat, so the poster's own
// ledger can hold the id before the service pushes the message to any subscribed watch. Own-post
// detection is the ledger and nothing else; a ledger written after the receipt lost the race on
// a stream watch of the same session (measured: three own posts delivered back in one session).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { nativeMessageId } from "../src/native-protocol.mjs";
import { NativeRoomStore } from "../src/native-store.mjs";
import { nativeTransport } from "../src/transports/native.mjs";
import { appendPosted, readPosted } from "../src/session.mjs";

const ROOM = "3".repeat(32);
const EPOCH = "4".repeat(32);
const HOST = "seat_host_0000001";

test("the store's message id is the protocol's digest of room, account and operation id", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-native-ledger-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await NativeRoomStore.create({ root, roomId: ROOM, epoch: EPOCH, hostAccountId: HOST });
  t.after(() => store.close());
  const r = /** @type {any} */ (await store.append({ operationId: "operation_ledger_001", authorName: "A", authorKind: "agent", text: "hello" }, { accountId: HOST }));
  assert.equal(r.id, nativeMessageId(ROOM, HOST, "operation_ledger_001"));
});

test("beforeSend receives the id the receipt will carry, before the append reaches the service", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-native-ledger-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "native"), { recursive: true });
  await writeFile(path.join(root, "native", "service.json"), JSON.stringify({
    path: "never-dialed-the-connect-seam-is-injected", nonce: "n", bootEpoch: EPOCH, accountId: HOST, seatLabel: "probe",
  }));
  /** @type {any[]} */
  const sent = [];
  const connect = async () => ({
    socket: { unref() {}, once() {}, destroyed: false },
    request: async (/** @type {string} */ verb, /** @type {any} */ payload) => {
      sent.push({ verb, payload });
      return { id: nativeMessageId(ROOM, HOST, payload.operation.operationId), cursor: `${EPOCH}:1` };
    },
  });
  const transport = nativeTransport({ transport: "native", roomId: ROOM }, {
    actor: { name: "Fable/test", kind: "agent" },
    stateRoot: root,
    connect: /** @type {any} */ (connect),
  });
  const sdir = path.join(root, "sessions", "s1");
  let seenBefore;
  let sentAtBefore;
  const receipt = await transport.post("hello", {
    beforeSend: async (id) => { seenBefore = id; sentAtBefore = sent.length; await appendPosted(sdir, id); },
  });
  assert.equal(sentAtBefore, 0, "beforeSend runs before any request is sent");
  assert.equal(seenBefore, receipt.id);
  assert.equal(sent.length, 1);
  assert.ok((await readPosted(sdir)).has(receipt.id));
  assert.match(await readFile(path.join(sdir, "posted.jsonl"), "utf8"), new RegExp(receipt.id));
});
