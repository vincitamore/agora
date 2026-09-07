// @ts-nocheck
// T3 hostile-client regression cells. These attack T1's frozen public boundary;
// no live Tailcat relay is started here.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Duplex, PassThrough } from "node:stream";
import test from "node:test";
import { NativeFrameDecoder, NATIVE_FRAME_MAX, NATIVE_PROTOCOL, encodeNativeFrame, nativeHandshakeProof } from "../src/native-protocol.mjs";
import { buildRouteBinding, memberHandshakeProof, MEMBER_PHASES, mintRouteSecret, readRouteSecret, removeRouteSecret, routeProofRef, routeSecretPath, verifyMemberHandshakeProof, writeRouteSecret } from "../src/native-member.mjs";
import { NativeRoomService } from "../src/native-service.mjs";

const ACCOUNT = "a".repeat(32);
const ROOM = "b".repeat(32);
const EPOCH = "c".repeat(32);
const KEY = `nodekey:${"d".repeat(64)}`;

function pair() {
  const inbound = new PassThrough();
  const outbound = new PassThrough();
  const host = Duplex.from({ readable: inbound, writable: outbound });
  const client = Duplex.from({ readable: outbound, writable: inbound });
  // Hostile cells intentionally make the service destroy its end. That teardown is
  // expected evidence, not an unhandled-error failure of the test transport.
  host.on("error", () => {});
  client.on("error", () => {});
  return { host, client };
}

function readUntil(stream, predicate) {
  return new Promise((resolve, reject) => {
    const decoder = new NativeFrameDecoder();
    const timeout = setTimeout(() => reject(new Error("timed out waiting for hostile probe response")), 3000);
    stream.on("data", (bytes) => {
      for (const frame of decoder.push(bytes)) {
        if (predicate(frame)) { clearTimeout(timeout); resolve(frame); }
      }
    });
    stream.on("error", reject);
  });
}

function child(signal, exit = null) {
  const stdout = new PassThrough();
  const listeners = {};
  const value = { stdout, exitCode: null, signalCode: null, connected: false,
    once(name, fn) { (listeners[name] ??= []).push(fn); return value; },
    on(name, fn) { return value.once(name, fn); }, disconnect() {} };
  const finish = (code) => { if (value.exitCode !== null) return; value.exitCode = code; stdout.end(); for (const fn of listeners.exit ?? []) fn(code, null); };
  if (exit !== null) queueMicrotask(() => finish(exit));
  else signal?.addEventListener("abort", () => finish(0), { once: true });
  return value;
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-t3-hostile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new NativeRoomService({ root, accountId: ACCOUNT, seatLabel: "host" });
  await service.start();
  await service.createRoom({ roomId: ROOM, epoch: EPOCH });
  t.after(() => service.stop());
  /** @type {(stream: Duplex) => void} */ let accept;
  const opened = await service.openRoute({ roomId: ROOM, publicNodeKey: KEY, routeOptions: {
    listen: async (hook) => { accept = hook; return { port: 4545, close: async () => {} }; },
    spawn: async (args, _runtime, owner) => child(owner?.signal, args[0] === "parse" ? 0 : null),
    address: async () => `tc${"a".repeat(48)}`,
  } });
  const secret = await readRouteSecret(root, opened.descriptor.binding, opened.descriptor.proofRef);
  return { root, service, opened, secret, accept: (stream) => accept(stream) };
}

async function hello(client, secret) {
  const server = await readUntil(client, (frame) => frame.type === "member-server-hello");
  const { protocol: _protocol, type: _type, proof: _proof, ...base } = server;
  const clientChallenge = randomUUID().replaceAll("-", "");
  const transcript = { ...base, clientChallenge };
  client.write(encodeNativeFrame({ protocol: NATIVE_PROTOCOL, type: "member-client-hello", ...transcript,
    proof: memberHandshakeProof(secret, MEMBER_PHASES.client, transcript) }));
  const result = await readUntil(client, (frame) => frame.type === "member-welcome" || frame.type === "error");
  return { server, transcript, result };
}

test("T3 replay: a member proof replay fails on the changed server challenge, while a fresh second hello succeeds", async (t) => {
  const { accept, secret, opened } = await fixture(t);
  const first = pair(); accept(first.host);
  const captured = await hello(first.client, secret);
  assert.equal(captured.result.type, "member-welcome");

  const second = pair(); accept(second.host);
  const current = await readUntil(second.client, (frame) => frame.type === "member-server-hello");
  assert.equal(current.grantId, captured.server.grantId, "the replay discriminator changed route generation");
  assert.notEqual(current.serverChallenge, captured.server.serverChallenge, "second connection did not mint a fresh server challenge");
  // Keep the current route fields and request id, changing only the captured server challenge/proof pair.
  second.client.write(encodeNativeFrame({ protocol: NATIVE_PROTOCOL, type: "member-client-hello",
    ...captured.transcript, requestId: current.requestId, bootEpoch: current.bootEpoch }));
  const refused = await readUntil(second.client, (frame) => frame.type === "error");
  assert.match(refused.message, /member-hello-refused/, "replay was not rejected at the server-challenge check");

  const honest = pair(); accept(honest.host);
  assert.equal((await hello(honest.client, secret)).result.type, "member-welcome", "fresh second connection was rejected");
  assert.equal(opened.descriptor.binding.routeGeneration, current.routeGeneration);
});

test("T3 incomplete and oversized frame bytes cannot yield an append payload", () => {
  const frame = encodeNativeFrame({ protocol: NATIVE_PROTOCOL, type: "append", requestId: "r".repeat(32), roomId: ROOM,
    operation: { operationId: randomUUID().replaceAll("-", ""), authorName: "remote", text: "must not commit" } });
  const truncated = new NativeFrameDecoder();
  assert.deepEqual(truncated.push(frame.subarray(0, frame.length - 1)), []);
  assert.throws(() => truncated.finish(), /ended inside a frame/);

  const prefix = Buffer.alloc(4); prefix.writeUInt32BE(NATIVE_FRAME_MAX + 1);
  assert.throws(() => new NativeFrameDecoder().push(prefix), /invalid .*frame/);
});

test("T3 route secrets reject selection, world-readable mode, and stale generations", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-t3-secret-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binding = buildRouteBinding({ hostAccountId: ACCOUNT, hostAuthority: ACCOUNT, roomId: ROOM, roomEpoch: EPOCH,
    serviceBootId: "f".repeat(32), publicNodeKey: KEY });
  const secret = mintRouteSecret();
  const { file, proofRef } = await writeRouteSecret(root, binding, secret);
  for (const ref of ["../../slack-bot.token", "..", `${binding.grantId}/${"9".repeat(32)}.secret`, `${"8".repeat(32)}/${binding.routeGeneration}.secret`])
    assert.throws(() => routeSecretPath(root, binding, ref), /proof-ref-refused/);
  assert.equal(await readRouteSecret(root, binding, proofRef), secret);
  if (process.platform !== "win32") {
    await chmod(file, 0o644);
    await assert.rejects(readRouteSecret(root, binding, proofRef), /grants group or other access/);
    await chmod(file, 0o600);
  }
  await removeRouteSecret(root, binding);
  await assert.rejects(readRouteSecret(root, binding, routeProofRef(binding)), /ENOENT|no such file/i);
});

test("T3 local nonce and member identity claims cannot cross the member boundary", async (t) => {
  const { accept, secret, opened } = await fixture(t);
  const base = { bootEpoch: "f".repeat(32), requestId: "r".repeat(32), serverChallenge: "s".repeat(32) };
  const memberTranscript = { ...base, roomId: ROOM, roomEpoch: EPOCH, grantId: opened.descriptor.binding.grantId,
    routeGeneration: opened.descriptor.binding.routeGeneration, membershipRevision: 1, memberAccountId: opened.descriptor.binding.accountId };
  const localProof = nativeHandshakeProof(mintRouteSecret(), MEMBER_PHASES.client, memberTranscript);
  assert.equal(verifyMemberHandshakeProof(localProof, secret, MEMBER_PHASES.client, memberTranscript), false);

  const socket = pair(); accept(socket.host);
  assert.equal((await hello(socket.client, secret)).result.type, "member-welcome");
  socket.client.write(encodeNativeFrame({ protocol: NATIVE_PROTOCOL, type: "append", requestId: "m".repeat(32), roomId: ROOM,
    accountId: ACCOUNT, operation: { operationId: "n".repeat(32), authorName: "forged", text: "x" } }));
  assert.match((await readUntil(socket.client, (value) => value.type === "error")).message, /member-actor-mismatch/);

  const board = pair(); accept(board.host);
  assert.equal((await hello(board.client, secret)).result.type, "member-welcome");
  board.client.write(encodeNativeFrame({ protocol: NATIVE_PROTOCOL, type: "append", requestId: "p".repeat(32), roomId: ROOM,
    operation: { kind: "board", operationId: "q".repeat(32), authorKind: "human", authorName: "forged", payload: { action: "break", subject: "t3" } } }));
  assert.match((await readUntil(board.client, (value) => value.type === "error")).message, /member-author-kind-refused/);
});

test("T3 one live route per key rejects a second grant before transport startup", async (t) => {
  const { service } = await fixture(t);
  await assert.rejects(service.openRoute({ roomId: ROOM, publicNodeKey: KEY }), /route-already-open/);
  assert.equal(service.listRoutes().length, 1);
});

test("T3 service-owned route: service stop reaps the route after the route-opening caller is gone", async (t) => {
  const { service } = await fixture(t);
  assert.equal(service.listRoutes().length, 1, "route was not held by the resident service");
  await service.stop();
  assert.equal(service.listRoutes().length, 0, "service stop left a member route registered");
});

test("T3 mixed writers serialize two member and one local append without a partial record", async (t) => {
  const { accept, secret, service, opened } = await fixture(t);
  const a = pair(), b = pair(); accept(a.host); accept(b.host);
  assert.equal((await hello(a.client, secret)).result.type, "member-welcome");
  assert.equal((await hello(b.client, secret)).result.type, "member-welcome");
  const append = (client, id, text) => {
    client.write(encodeNativeFrame({ protocol: NATIVE_PROTOCOL, type: "append", requestId: id, roomId: ROOM,
      operation: { operationId: id, authorName: "remote", text } }));
    return readUntil(client, (value) => value.type === "append-ack" || value.type === "error");
  };
  const store = await service.openRoom(ROOM);
  const [left, right, local] = await Promise.all([
    append(a.client, "1".repeat(32), "remote one"), append(b.client, "2".repeat(32), "remote two"),
    store.append({ operationId: "3".repeat(32), authorName: "host", text: "local" }, { accountId: ACCOUNT }),
  ]);
  assert.equal(left.type, "append-ack"); assert.equal(right.type, "append-ack"); assert.ok(local.cursor);
  const records = store.read({});
  assert.equal(records.length, 3);
  assert.deepEqual(records.map((record) => record.cursor.split(":")[1]), ["1", "2", "3"]);
  assert.equal(records.filter((record) => record.author.id === opened.descriptor.binding.accountId).length, 2);
});
