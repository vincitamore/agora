// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { NativeRoomService, NativeServiceClient, nativeServiceEndpoint } from "../src/native-service.mjs";
import { NativeFrameDecoder, NATIVE_PROTOCOL, encodeNativeFrame, nativeHandshakeProof } from "../src/native-protocol.mjs";

const ROOM = "4".repeat(32);
const EPOCH = "5".repeat(32);
const ACCOUNT = "seat_account_0001";

/** @param {net.Server} server @param {string} endpoint */
function listen(server, endpoint) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ path: endpoint }, () => { server.off("error", reject); resolve(undefined); });
  });
}

/** @param {net.Server} server */
function close(server) {
  return new Promise((resolve) => server.close(() => resolve(undefined)));
}

/** @param {net.Socket} socket */
async function readFrame(socket) {
  const decoder = new NativeFrameDecoder();
  for (;;) {
    const [bytes] = await once(socket, "data");
    const frames = decoder.push(/** @type {Buffer} */ (bytes));
    if (frames.length) return /** @type {Record<string, any>} */ (frames[0]);
  }
}

/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-native-service-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new NativeRoomService({ root, accountId: ACCOUNT, seatLabel: "admin-pc" });
  const endpoint = await service.start();
  await service.createRoom({ roomId: ROOM, epoch: EPOCH });
  t.after(() => service.stop());
  return { root, service, endpoint };
}

test("one seat service fans a committed event to independent local subscribers", async (t) => {
  const { endpoint } = await fixture(t);
  const a = await NativeServiceClient.connect(/** @type {any} */ (endpoint));
  const b = await NativeServiceClient.connect(/** @type {any} */ (endpoint));
  t.after(() => { a.close(); b.close(); });
  /** @type {(message: any) => void} */ let resolveA;
  /** @type {(message: any) => void} */ let resolveB;
  const seenA = new Promise((resolve) => { resolveA = resolve; });
  const seenB = new Promise((resolve) => { resolveB = resolve; });
  await Promise.all([
    a.subscribe(ROOM, `${EPOCH}:0`, (message) => resolveA(message)),
    b.subscribe(ROOM, `${EPOCH}:0`, (message) => resolveB(message)),
  ]);
  const receipt = await a.request("append", { roomId: ROOM, operation: {
    operationId: "operation_service_01", authorName: "Sol/codex", text: "hello",
  } });
  assert.equal(receipt.cursor, `${EPOCH}:1`);
  const [messageA, messageB] = await Promise.all([seenA, seenB]);
  assert.match(/** @type {any} */ (messageA).id, /^[a-f0-9]{64}$/);
  assert.notEqual(/** @type {any} */ (messageA).id, "operation_service_01", "the host, not the caller, mints globally distinct message ids");
  assert.deepEqual(messageA, messageB);
  assert.equal(/** @type {any} */ (messageA).author.id, ACCOUNT);
});

test("a later local session replays host-accepted messages from its own cursor", async (t) => {
  const { endpoint } = await fixture(t);
  const writer = await NativeServiceClient.connect(/** @type {any} */ (endpoint));
  t.after(() => writer.close());
  await writer.request("append", { roomId: ROOM, operation: {
    operationId: "operation_replay_001", authorName: "Sol/codex", text: "kept",
  } });
  const reader = await NativeServiceClient.connect(/** @type {any} */ (endpoint));
  t.after(() => reader.close());
  const result = await reader.request("read", { roomId: ROOM, since: `${EPOCH}:0` });
  assert.deepEqual(result.messages.map((/** @type {any} */ message) => message.text), ["kept"]);
  assert.equal(result.checkpoint.sequence, 1);
});

test("stable retries through the service reconcile an unknown receipt without a second append", async (t) => {
  const { endpoint } = await fixture(t);
  const client = await NativeServiceClient.connect(/** @type {any} */ (endpoint));
  t.after(() => client.close());
  const operation = { operationId: "operation_unknown_01", authorName: "Sol/codex", text: "once" };
  const first = await client.request("append", { roomId: ROOM, operation });
  const retry = await client.request("append", { roomId: ROOM, operation });
  assert.equal(first.cursor, retry.cursor);
  assert.equal(retry.duplicate, true);
  const read = await client.request("read", { roomId: ROOM, since: `${EPOCH}:0` });
  assert.equal(read.messages.length, 1);
});

test("concurrent first access opens one room store rather than two writers", async (t) => {
  const { service } = await fixture(t);
  await service.rooms.get(ROOM)?.close();
  service.rooms.delete(ROOM);
  const [a, b] = await Promise.all([service.openRoom(ROOM), service.openRoom(ROOM)]);
  assert.strictEqual(a, b);
});

test("the server-auth-first handshake and endpoint bind fail closed", async (t) => {
  const { root, service, endpoint } = await fixture(t);
  await assert.rejects(NativeServiceClient.connect({ .../** @type {any} */ (endpoint), nonce: "wrong_nonce_00001" }), /server proof was invalid/);
  const second = new NativeRoomService({ root, accountId: ACCOUNT, seatLabel: "admin-pc" });
  await assert.rejects(second.start(), /endpoint .* already active or occupied/);
  await service.stop();
  await assert.rejects(NativeServiceClient.connect(/** @type {any} */ (endpoint)), /ECONNREFUSED|ENOENT|closed|dark/);
});

test("concurrent seat-service starters produce exactly one live owner", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-native-concurrent-start-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = new NativeRoomService({ root, accountId: ACCOUNT, seatLabel: "first" });
  const second = new NativeRoomService({ root, accountId: ACCOUNT, seatLabel: "second" });
  const results = await Promise.allSettled([first.start(), second.start()]);
  const winners = results.filter((result) => result.status === "fulfilled");
  const losers = results.filter((result) => result.status === "rejected");
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  const winner = results[0].status === "fulfilled" ? first : second;
  const endpoint = /** @type {PromiseFulfilledResult<any>} */ (winners[0]).value;
  t.after(() => winner.stop());
  const client = await NativeServiceClient.connect(endpoint);
  client.close();
});

test("an endpoint squatter receives no client bytes before proving the service", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-native-squatter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const endpointPath = await nativeServiceEndpoint(root, ACCOUNT);
  const fake = net.createServer();
  let received = 0;
  fake.on("connection", (socket) => {
    socket.on("data", (bytes) => { received += bytes.length; });
    socket.write(encodeNativeFrame({ protocol: NATIVE_PROTOCOL, type: "server-hello", requestId: "f".repeat(32),
      bootEpoch: "b".repeat(32), serverChallenge: "c".repeat(32), accountId: ACCOUNT, seatLabel: "admin-pc",
      proof: "0".repeat(64) }));
  });
  await listen(fake, endpointPath);
  t.after(() => close(fake));
  await assert.rejects(NativeServiceClient.connect({ path: endpointPath, nonce: "n".repeat(32), bootEpoch: "b".repeat(32),
    accountId: ACCOUNT, seatLabel: "admin-pc", timeoutMs: 1_000 }), /server proof was invalid/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(received, 0, "no reusable credential, label, body or request crosses before server authentication");
});

test("filesystem aliases resolve to one physical seat endpoint", async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), "agora-native-endpoint-alias-"));
  const root = path.join(parent, "root");
  const alias = path.join(parent, "alias");
  t.after(() => rm(parent, { recursive: true, force: true }));
  await nativeServiceEndpoint(root, ACCOUNT);
  await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
  assert.equal(await nativeServiceEndpoint(root, ACCOUNT), await nativeServiceEndpoint(alias, ACCOUNT));
});

test("a recorded dead-service transcript cannot authenticate a fresh client challenge", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-native-replay-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new NativeRoomService({ root, accountId: ACCOUNT, seatLabel: "admin-pc", nonce: "n".repeat(32) });
  const endpoint = await service.start();
  const raw = net.createConnection({ path: /** @type {string} */ (endpoint.path) });
  await once(raw, "connect");
  const hello = await readFrame(raw);
  const oldClientChallenge = "d".repeat(32);
  const serverTranscript = { bootEpoch: hello.bootEpoch, requestId: hello.requestId, serverChallenge: hello.serverChallenge,
    accountId: hello.accountId, seatLabel: hello.seatLabel };
  const oldTranscript = { ...serverTranscript, clientChallenge: oldClientChallenge };
  raw.write(encodeNativeFrame({ protocol: NATIVE_PROTOCOL, type: "client-hello", ...oldTranscript,
    proof: nativeHandshakeProof(endpoint.nonce, "client", oldTranscript) }));
  const oldWelcome = await readFrame(raw);
  raw.destroy();
  await service.stop();

  const replay = net.createServer((socket) => {
    socket.write(encodeNativeFrame(hello));
    socket.once("data", () => socket.write(encodeNativeFrame(oldWelcome)));
  });
  await listen(replay, /** @type {string} */ (endpoint.path));
  t.after(() => close(replay));
  await assert.rejects(NativeServiceClient.connect(/** @type {any} */ (endpoint)), /fresh transcript/);
});

test("abrupt service death leaves no manual lock recovery step", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-native-abrupt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const moduleUrl = new URL("../src/native-service.mjs", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "--eval",
    `import { NativeRoomService } from ${JSON.stringify(moduleUrl)}; const s = new NativeRoomService({ root: process.env.AGORA_TEST_ROOT, accountId: ${JSON.stringify(ACCOUNT)}, seatLabel: "child" }); process.stdout.write(JSON.stringify(await s.start()) + "\\n"); setInterval(() => {}, 1000);`],
  { env: { ...process.env, AGORA_TEST_ROOT: root }, stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const [line] = await once(child.stdout, "data");
  const deadEndpoint = JSON.parse(String(line));
  assert.equal(typeof deadEndpoint.path, "string");
  child.kill("SIGKILL");
  await once(child, "exit");

  const restarted = new NativeRoomService({ root, accountId: ACCOUNT, seatLabel: "replacement" });
  const endpoint = await restarted.start();
  t.after(() => restarted.stop());
  const client = await NativeServiceClient.connect(/** @type {any} */ (endpoint));
  client.close();
  assert.notEqual(endpoint.bootEpoch, deadEndpoint.bootEpoch);
});
