// @ts-nocheck
// Purge (docs/PURGE.md) is appended on the host seat's own connections only: a remote member's
// purge over its route is refused purge-refused-remote and nothing is appended. The member fixture
// is the hostile-client suite's (test/native-member-hostile.test.mjs): no live Tailcat relay.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Duplex, PassThrough } from "node:stream";
import test from "node:test";
import { NativeFrameDecoder, NATIVE_PROTOCOL, encodeNativeFrame } from "../src/native-protocol.mjs";
import { memberHandshakeProof, MEMBER_PHASES, readRouteSecret } from "../src/native-member.mjs";
import { authorityFixtureService, approvedOpen } from "./authority-fixture.mjs";

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
    const timeout = setTimeout(() => reject(new Error("timed out waiting for the service's answer")), 3000);
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

function fakeRouteOptions(state) {
  return {
    listen: async (hook) => {
      state.accept = hook;
      state.listenersOpened = (state.listenersOpened ?? 0) + 1;
      return { port: 4545, close: async () => { state.listenersClosed = (state.listenersClosed ?? 0) + 1; } };
    },
    spawn: async (args, _runtime, owner) => {
      const spawned = child(owner?.signal, args[0] === "parse" ? 0 : null);
      if (args[0] !== "parse")
        spawned.once("exit", () => { state.childrenExited = (state.childrenExited ?? 0) + 1; });
      return spawned;
    },
    address: async () => `tc${"a".repeat(48)}`,
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-purge-member-"));
  const service = await authorityFixtureService({ root, accountId: ACCOUNT, seatLabel: "host" },
    [{ roomId: ROOM, publicNodeKeys: [KEY] }]);
  await service.start();
  await service.createRoom({ roomId: ROOM, epoch: EPOCH });
  // stop first, then remove the root, in one hook: after-hooks run in registration order
  t.after(async () => { await service.stop(); await rm(root, { recursive: true, force: true }); });
  const route = {};
  const opened = await approvedOpen(service, { roomId: ROOM, publicNodeKey: KEY, routeOptions: fakeRouteOptions(route) });
  const secret = await readRouteSecret(root, opened.descriptor.binding, opened.descriptor.proofRef);
  return { root, service, opened, secret, route, accept: (stream) => route.accept(stream) };
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

test("a remote member's purge is refused purge-refused-remote and nothing is appended", async (t) => {
  const { accept, secret, service } = await fixture(t);
  const store = await service.openRoom(ROOM);
  const local = await store.append({ operationId: randomUUID().replaceAll("-", ""), authorName: "Ada", authorKind: "human", text: "the host's words" }, { accountId: ACCOUNT });
  const socket = pair(); accept(socket.host);
  assert.equal((await hello(socket.client, secret)).result.type, "member-welcome");
  socket.client.write(encodeNativeFrame({ protocol: NATIVE_PROTOCOL, type: "append", requestId: "m".repeat(32), roomId: ROOM,
    operation: { kind: "purge", operationId: "n".repeat(32), authorName: "remote", purge: { targets: [local.id], reason: "from afar" } } }));
  const refused = await readUntil(socket.client, (value) => value.type === "error");
  assert.match(refused.message, /purge-refused-remote/);
  assert.equal(store.records.length, 1, "nothing was appended");
  assert.equal(store.generation, 0);
  assert.equal(store.view().messages[0].text, "the host's words");
});
