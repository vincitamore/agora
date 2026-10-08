// @ts-check
// Native threads and the `via` stamp through the seat service: the welcome's capability offer, a
// local connection's declared client name stamped on its messages, thread-scoped read and subscribe,
// a member's refusals, and a client that sends nothing thread-scoped (and declares no name) to a
// service that did not offer it. Every refusal is asserted by its name and by what was not sent.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { NativeRoomService, NativeServiceClient } from "../src/native-service.mjs";
import { NATIVE_PROTOCOL, NativeFrameDecoder, encodeNativeFrame, nativeHandshakeProof } from "../src/native-protocol.mjs";
import { openNativeSubscription } from "../src/wake/subscriber.mjs";
import { nativeTransport } from "../src/transports/native.mjs";
import { receiveCapabilityOffer } from "../src/protocol/capabilities.mjs";

const ROOM = "6".repeat(32);
const EPOCH = "7".repeat(32);
const ACCOUNT = "seat_account_0006";
const op = () => randomUUID().replaceAll("-", "");

/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-native-threads-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new NativeRoomService({ root, accountId: ACCOUNT, seatLabel: "seat-t" });
  const endpoint = /** @type {any} */ (await service.start());
  await service.createRoom({ roomId: ROOM, epoch: EPOCH });
  t.after(() => service.stop());
  /** @param {string} [clientName] */
  const connect = async (clientName) => {
    const c = await NativeServiceClient.connect({ ...endpoint, ...(clientName ? { clientName } : {}) });
    t.after(() => c.close());
    return c;
  };
  return { root, service, endpoint, connect };
}

/** @param {NativeServiceClient} c @param {Record<string, unknown>} operation */
const append = (c, operation) => c.request("append", { roomId: ROOM, operation: { operationId: op(), authorName: "A", text: "t", ...operation } });
/** @param {Promise<unknown>} p @param {string} code */
const refusedAs = (p, code) => assert.rejects(p, (e) => { assert.equal(/** @type {any} */ (e).code, code, String(e)); return true; });

test("the welcome offers threads-v1 and client-name-v1, and echoes the client name the service took", async (t) => {
  const { connect } = await fixture(t);
  const plain = await connect();
  assert.deepEqual([...plain.capabilities].sort(), ["client-name-v1", "threads-v1"]);
  assert.equal(plain.clientName, undefined);
  const named = await connect("review-app");
  assert.equal(named.clientName, "review-app");
});

test("a named connection's messages are stamped via; an unnamed one's are not, and its authorRef is refused", async (t) => {
  const { connect, service } = await fixture(t);
  const app = await connect("review-app");
  const cli = await connect();
  const root = await append(app, { authorName: "Dana", authorKind: "human", authorRef: "u-17", text: "a question" });
  const store = await service.openRoom(ROOM);
  const stored = /** @type {any} */ (store.read().at(-1));
  assert.equal(stored.id, root.id);
  assert.equal(stored.via, "review-app");
  assert.deepEqual(stored.author, { id: ACCOUNT, name: "Dana", kind: "human", ref: "u-17" });
  await append(cli, { text: "an answer", thread: root.id });
  const answer = /** @type {any} */ (store.read().at(-1));
  assert.equal("via" in answer, false, "a connection that declared no name is stamped with none");
  await refusedAs(append(cli, { authorRef: "u-17" }), "author-ref-without-client");
  await refusedAs(append(app, { via: "another-app" }), "operation-via-refused");
  // the app may root a thread as system: via never changes what the kind means
  await append(app, { authorName: "review-app", authorKind: "system", text: "job 9 opened" });
  assert.deepEqual([/** @type {any} */ (store.read().at(-1)).author.kind, /** @type {any} */ (store.read().at(-1)).via], ["system", "review-app"]);
});

test("a malformed client name in the hello is refused by name, and the client refuses one before sending it", async (t) => {
  const { endpoint } = await fixture(t);
  await refusedAs(NativeServiceClient.connect({ ...endpoint, clientName: "Not A Client" }), "client-name-invalid");
  // a raw hello that skips the client's own check meets the service's
  const socket = net.createConnection({ path: endpoint.path });
  t.after(() => socket.destroy());
  const decoder = new NativeFrameDecoder();
  /** @type {any[]} */ const frames = [];
  socket.on("data", (bytes) => frames.push(...decoder.push(bytes)));
  socket.on("error", () => {});
  const next = async () => { while (!frames.length) await new Promise((r) => setTimeout(r, 5)); return frames.shift(); };
  const hello = await next();
  const transcript = { bootEpoch: hello.bootEpoch, requestId: hello.requestId, serverChallenge: hello.serverChallenge,
    accountId: hello.accountId, seatLabel: hello.seatLabel, clientChallenge: op() };
  socket.write(encodeNativeFrame({ protocol: NATIVE_PROTOCOL, type: "client-hello", ...transcript, clientName: "Not A Client",
    proof: nativeHandshakeProof(endpoint.nonce, "client", transcript) }));
  const answer = await next();
  assert.equal(answer.type, "error");
  assert.equal(answer.reason, "hello-refused");
  assert.match(answer.message, /^client-name-invalid: /);
});

test("a thread read is the root and its replies; a quiet stretch still advances the checkpoint; unknown and reply roots are refused", async (t) => {
  const { connect } = await fixture(t);
  const c = await connect();
  const a = await append(c, { text: "a" });               // 1
  await append(c, { text: "x" });                         // 2
  const a1 = await append(c, { text: "a1", thread: a.id }); // 3
  await append(c, { text: "y" });                         // 4
  const whole = await c.request("read", { roomId: ROOM, thread: a.id });
  assert.deepEqual(whole.messages.map((/** @type {any} */ m) => m.text), ["a", "a1"]);
  assert.equal(whole.checkpoint.sequence, 4, "a whole thread view accounts for everything committed");
  const after = await c.request("read", { roomId: ROOM, thread: a.id, since: `${EPOCH}:3` });
  assert.deepEqual(after.messages, []);
  assert.equal(after.checkpoint.sequence, 4, "the records after the last reply are outside the thread and covered");
  const room = await c.request("read", { roomId: ROOM, since: `${EPOCH}:0` });
  assert.deepEqual(room.messages.map((/** @type {any} */ m) => [m.text, m.thread ?? null]), [["a", null], ["x", null], ["a1", a.id], ["y", null]], "the room view carries every reply with its thread");
  await refusedAs(c.request("read", { roomId: ROOM, thread: "e".repeat(64) }), "thread-root-unknown");
  await refusedAs(c.request("read", { roomId: ROOM, thread: a1.id }), "thread-root-not-top-level");
  await refusedAs(append(c, { thread: a1.id }), "thread-root-not-top-level");
  await assert.rejects(c.request("read", { roomId: ROOM, thread: "x" }), /thread id must be/);
});

test("a thread subscription replays and then delivers its own thread only", async (t) => {
  const { connect } = await fixture(t);
  const writer = await connect();
  const a = await append(writer, { text: "a" });
  await append(writer, { text: "x" });
  await append(writer, { text: "a1", thread: a.id });
  const reader = await connect();
  /** @type {any[]} */ const seen = [];
  await reader.subscribe(ROOM, `${EPOCH}:0`, (m) => seen.push(m), a.id);
  await append(writer, { text: "y" });
  const b = await append(writer, { text: "b" });
  await append(writer, { text: "b1", thread: b.id });
  await append(writer, { text: "a2", thread: a.id });
  const deadline = Date.now() + 4000;
  while (seen.length < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(seen.map((m) => m.text), ["a", "a1", "a2"], "the root and its replies, each once, in order");
  await refusedAs(reader.subscribe(ROOM, `${EPOCH}:0`, () => {}, "d".repeat(64)), "thread-root-unknown");
});

test("a thread read past the frame cap names the record limit that returns exactly what fits, and it works", { timeout: 120000 }, async (t) => {
  const { connect } = await fixture(t);
  const c = await connect();
  const a = await append(c, { text: "root" });
  // heavy replies with filler between them: a count of replies would scan too few records
  for (let i = 0; i < 6; i++) {
    await append(c, { text: `filler ${i}` });
    await append(c, { text: `${i}:`.padEnd(240 * 1024, "r"), thread: a.id });
  }
  const refused = await c.request("read", { roomId: ROOM, thread: a.id, since: `${EPOCH}:0` }).then(() => undefined, (e) => e);
  assert.equal(refused?.code, "read-batch-refused", String(refused));
  const named = Number(/re-read with limit (\d+)/.exec(refused.message)?.[1]);
  const page = await c.request("read", { roomId: ROOM, thread: a.id, since: `${EPOCH}:0`, limit: named });
  assert.ok(page.messages.length >= 2, `the named limit ${named} returned ${page.messages.length}`);
  assert.equal(page.checkpoint.sequence, named, "the page accounts for the records it was told to scan");
  assert.equal(page.messages.at(-1).cursor, `${EPOCH}:${named}`, "and it ends on the last reply that fits");
  // and nothing more fits: reaching the next reply (past one filler) is refused again
  await refusedAs(c.request("read", { roomId: ROOM, thread: a.id, since: `${EPOCH}:0`, limit: named + 2 }), "read-batch-refused");
});

test("a received offer keeps the names this build knows, drops the rest, and refuses an unknown requirement", () => {
  const member = receiveCapabilityOffer({ advertised: ["threads-v1"], required: [] });
  assert.deepEqual(member.advertised, ["threads-v1"]);
  assert.deepEqual(receiveCapabilityOffer(undefined), { advertised: [], required: [] }, "a host that predates offers offers nothing");
  assert.deepEqual(receiveCapabilityOffer({ advertised: ["threads-v1", "future-v9"], required: [] }).advertised, ["threads-v1"], "an advertised name this build does not know is dropped");
  assert.throws(() => receiveCapabilityOffer({ advertised: ["future-v9"], required: ["future-v9"] }), /protocol/, "a required name this build does not know refuses");
  assert.throws(() => receiveCapabilityOffer({ advertised: [], required: ["threads-v1"] }), /protocol context at required/, "required is offered");
});

/**
 * A seat service from before offers: it completes the hello, ignores any field it does not know
 * (a client name, a thread) and sends no capability offer. Records every request it receives.
 * @param {import('node:test').TestContext} t
 */
async function oldService(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-old-service-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nonce = "old_service_nonce_000001";
  const bootEpoch = op();
  const endpoint = { path: process.platform === "win32" ? `\\\\.\\pipe\\agora-old-${op()}` : path.join(root, "s.sock"),
    nonce, bootEpoch, accountId: ACCOUNT, seatLabel: "old-seat" };
  /** @type {any[]} */ const received = [];
  /** @type {Set<net.Socket>} */ const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    const decoder = new NativeFrameDecoder();
    const st = { bootEpoch, requestId: op(), serverChallenge: op(), accountId: ACCOUNT, seatLabel: "old-seat" };
    socket.write(encodeNativeFrame({ protocol: NATIVE_PROTOCOL, type: "server-hello", ...st, proof: nativeHandshakeProof(nonce, "server", st) }));
    let greeted = false;
    socket.on("data", (bytes) => {
      for (const frame of decoder.push(bytes)) {
        const f = /** @type {any} */ (frame);
        if (!greeted) {
          greeted = true;
          const tr = { ...st, clientChallenge: f.clientChallenge };
          socket.write(encodeNativeFrame({ protocol: NATIVE_PROTOCOL, type: "welcome", ...tr, proof: nativeHandshakeProof(nonce, "welcome", tr) }));
          continue;
        }
        received.push(f);
        socket.write(encodeNativeFrame({ protocol: NATIVE_PROTOCOL, type: "error", requestId: f.requestId, reason: "request-refused", message: "the old service answered" }));
      }
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen({ path: endpoint.path }, () => resolve(undefined)); });
  // a client the test leaves connected would hold close() open: the old service hangs up on it
  t.after(() => new Promise((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve(undefined)); }));
  await mkdir(path.join(root, "native"), { recursive: true });
  await writeFile(path.join(root, "native", "service.json"), JSON.stringify(endpoint));
  return { root, endpoint, received };
}

test("nothing thread-scoped and no client name goes to a service that did not offer them", async (t) => {
  const { root, endpoint, received } = await oldService(t);
  await refusedAs(NativeServiceClient.connect({ ...endpoint, clientName: "review-app" }), "client-name-unsupported");
  const plain = await NativeServiceClient.connect(endpoint);
  plain.close();
  assert.equal(plain.capabilities.size, 0);
  const transport = nativeTransport({ transport: "native", roomId: ROOM }, { actor: { name: "seat", kind: "agent" }, stateRoot: root });
  await refusedAs(transport.read({ thread: "a".repeat(64) }), "thread-unsupported");
  await refusedAs(transport.post("x", { thread: "a".repeat(64) }), "thread-unsupported");
  await refusedAs(openNativeSubscription({ stateRoot: root, roomId: ROOM, since: `${EPOCH}:0`, thread: "a".repeat(64) }), "thread-unsupported");
  assert.deepEqual(received, [], "no request reached the old service: a thread request there would be answered for the whole room");
  // the room-wide verbs still go, so the refusal is about the thread and nothing else
  await assert.rejects(transport.read({}), /the old service answered/);
  assert.equal(received.length, 1);
  assert.equal("thread" in received[0], false);
});
