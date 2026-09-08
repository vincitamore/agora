// L12: the POSITIVE half of the contest — two local consumers on ONE resident client, and a
// message appended on the host delivered to both.
//
// The contest cell's half is negative (the losing start spawns nothing). This one is the claim the
// unit actually makes to its users: sessions stop dialing and lose nothing by it. Without this,
// "one client per machine" is proved to be exclusive and not proved to be useful.
//
// The rig is the T2 cut's: a REAL host service with a REAL member route, and the Tailcat child
// faked as a loopback duplex, so a green run proves the client half against the host's real member
// admission path and proves nothing about Tailcat's own rendezvous.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Duplex, PassThrough } from "node:stream";
import { authorityFixtureService, approvedOpen } from "./authority-fixture.mjs";
import { readRouteSecret, writeRouteSecret } from "../src/native-member.mjs";
import { MemberClientService } from "../src/native-member-client.mjs";
import { NativeServiceClient } from "../src/native-service.mjs";
import { readMemberDescriptor } from "../src/native-member-descriptor.mjs";
import { nativeCursor } from "../src/native-protocol.mjs";

const HOST_ACCOUNT = "b".repeat(32);
const ROOM = "c".repeat(32);
const EPOCH = "d".repeat(32);
const KEY = `nodekey:${"abcdef0123456789".repeat(4)}`;
const ADDRESS = `tc${"a".repeat(48)}`;

/**
 * The T2 cut's fake Tailcat child, copied rather than approximated: a simplified one whose
 * resident child ignores the owner's abort signal makes the host's route teardown fail, and the
 * failure surfaces as `operator-recovery-required` with the real cause swallowed by the cleanup
 * path. Measured here before it was copied.
 * @param {{ exit?: number | null, signal?: AbortSignal, stdout?: any, stdin?: any }} [options]
 */
function fakeChild(options = {}) {
  const { exit = null, signal } = options;
  const stdout = options.stdout ?? new PassThrough();
  const stdin = options.stdin;
  /** @type {Record<string, Function[]>} */ const listeners = {};
  const child = /** @type {any} */ ({
    stdout, stdin, exitCode: null, signalCode: null, connected: false,
    once(/** @type {string} */ e, /** @type {Function} */ cb) { (listeners[e] ??= []).push(cb); return child; },
    on(/** @type {string} */ e, /** @type {Function} */ cb) { return child.once(e, cb); },
    disconnect() {},
  });
  const finish = (/** @type {number} */ code) => {
    if (child.exitCode !== null) return;
    child.exitCode = code;
    if (!options.stdout) stdout.end();
    for (const cb of listeners.exit ?? []) cb(code, null);
  };
  if (exit !== null) queueMicrotask(() => finish(exit));
  else if (signal) signal.addEventListener("abort", () => finish(0), { once: true });
  return child;
}

/**
 * A host with a room and an open route to KEY, and a seat whose state carries the secret.
 * @param {import('node:test').TestContext} t
 */
async function rig(t) {
  const hostRoot = await mkdtemp(path.join(tmpdir(), "agora-l12-host-"));
  const seatRoot = await mkdtemp(path.join(tmpdir(), "agora-l12-seat-"));
  t.after(() => rm(hostRoot, { recursive: true, force: true }));
  t.after(() => rm(seatRoot, { recursive: true, force: true }));

  const service = await authorityFixtureService(
    { root: hostRoot, accountId: HOST_ACCOUNT, seatLabel: "admin-pc" },
    [{ roomId: ROOM, publicNodeKeys: [KEY] }]);
  await service.start();
  await service.createRoom({ roomId: ROOM, epoch: EPOCH });
  t.after(() => service.stop());

  /** @type {((socket: any) => void) | undefined} */
  let accept;
  const opened = await approvedOpen(service, {
    roomId: ROOM, publicNodeKey: KEY,
    routeOptions: {
      listen: async (/** @type {(socket: any) => void} */ hook) => { accept = hook; return { port: 4242, close: async () => {} }; },
      spawn: async (/** @type {string[]} */ args, /** @type {any} */ _r, /** @type {any} */ owner) =>
        fakeChild({ exit: args[0] === "parse" ? 0 : null, signal: owner?.signal }),
      address: async () => ADDRESS,
    },
  });

  const secret = await readRouteSecret(hostRoot, opened.descriptor.binding, opened.descriptor.proofRef);
  await writeRouteSecret(seatRoot, opened.descriptor.binding, secret);

  // The seat's enrolled identity, carrying BOTH halves so the digest is a file read.
  await mkdir(path.join(seatRoot, "tailcat"), { recursive: true, mode: 0o700 });
  const keyPath = path.join(seatRoot, "tailcat", "identity.private.json");
  await writeFile(keyPath, JSON.stringify({
    Private: `privkey:${"9".repeat(64)}`,
    Public: { ServerPublic: KEY, ServerDiscoPublic: `discokey:${"8".repeat(64)}` },
  }), { mode: 0o600 });

  const descriptorPath = path.join(seatRoot, "route-descriptor.json");
  await writeFile(descriptorPath, JSON.stringify(opened.descriptor), "utf8");

  /** Every Tailcat argv the resident client asked for. */
  /** @type {string[][]} */
  const spawned = [];
  /** Every member channel the resident opened, so a cell can BREAK one and watch it recover.
   *  @type {{ hostSide: any, toHost: any, toClient: any }[]} */
  const dials = [];
  const dial = () => {
    const toHost = new PassThrough();
    const toClient = new PassThrough();
    const hostSide = Duplex.from({ readable: toHost, writable: toClient });
    hostSide.on("error", () => {});
    dials.push({ hostSide, toHost, toClient });
    /** @type {(socket: any) => void} */ (accept)(hostSide);
    return { stdout: toClient, stdin: toHost };
  };
  const channelOptions = {
    spawn: async (/** @type {string[]} */ args, /** @type {any} */ _r, /** @type {any} */ owner) => {
      spawned.push(args);
      if (args[0] === "parse") return fakeChild({ exit: 0, signal: owner?.signal });
      if (args[1] === "printpub") {
        const stdout = new PassThrough();
        const child = fakeChild({ exit: 0, stdout, signal: owner?.signal });
        stdout.end(`${KEY}\n`);
        return child;
      }
      return fakeChild({ signal: owner?.signal, ...dial() });
    },
  };

  return { service, seatRoot, descriptorPath, keyPath, channelOptions, spawned, dials,
    identity: async () => ({ keyPath, nodeKey: KEY }), roomId: ROOM };
}

test("two local consumers on ONE resident client both receive a message appended on the host", async (t) => {
  const { service, seatRoot, descriptorPath, channelOptions, spawned, identity, roomId } = await rig(t);

  const client = new MemberClientService({
    stateRoot: seatRoot, alias: "house-remote", descriptorPath,
    keyDigest: `sha256:${"e".repeat(64)}`, seatLabel: "amore-dev-laptop",
    channelOptions, identity,
  });
  await client.start();
  t.after(() => client.stop());

  // ONE dial authority: exactly one transport child exists for the key, whatever the local side does.
  const dials = spawned.filter((args) => args[0] !== "parse" && args[1] !== "printpub");
  assert.equal(dials.length, 1, `the resident client opened ${dials.length} member channels`);

  const descriptor = await readMemberDescriptor(seatRoot, "house-remote");
  assert.equal(descriptor.roomId, roomId);

  // TWO local sessions, each connecting to the resident client exactly as they would connect to the
  // seat service. Neither knows it is not one.
  const since = nativeCursor(EPOCH, 0);
  /** @type {any[][]} */
  const received = [[], []];
  /** @type {any[]} */
  const locals = [];
  for (const [index] of [[0], [1]]) {
    const local = await NativeServiceClient.connect({ ...descriptor, timeoutMs: 5000 });
    locals.push(local);
    t.after(() => local.close());
    await local.subscribe(roomId, since, (message) => { received[index].push(message); });
  }

  // A message appended ON THE HOST, after both consumers are subscribed — and appended THROUGH the
  // host's own protocol, not straight into its store. A direct `store.append` commits the message
  // and never broadcasts (the service broadcasts from its append HANDLER), so a cell that appends
  // to the store proves persistence and silently proves nothing about delivery. Measured here.
  // `descriptor().path` is typed as nullable before the bind; the service is started, so it is set.
  const hostLocal = await NativeServiceClient.connect(
    /** @type {any} */ ({ ...service.descriptor(), timeoutMs: 5000 }));
  t.after(() => hostLocal.close());
  const ack = /** @type {any} */ (await hostLocal.request("append", { roomId, operation: {
    operationId: "l12deliver".padEnd(32, "0"), authorName: "host", authorKind: "agent",
    text: "one client, two consumers" } }));
  assert.ok(ack?.id ?? ack?.cursor, `the host did not accept the append: ${JSON.stringify(ack)}`);

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && (received[0].length === 0 || received[1].length === 0))
    await new Promise((r) => setTimeout(r, 25));

  assert.ok(received[0].length > 0, "the first local consumer received nothing");
  assert.ok(received[1].length > 0, "the second local consumer received nothing");
  const texts = received.map((batch) => batch.map((m) => String(m.text)));
  assert.ok(texts[0].some((t2) => t2.includes("one client, two consumers")), `first consumer saw ${JSON.stringify(texts[0])}`);
  assert.ok(texts[1].some((t2) => t2.includes("one client, two consumers")), `second consumer saw ${JSON.stringify(texts[1])}`);

  // A plain request THROUGH the proxy against a healthy upstream. This is the cell that was
  // missing: `subscribe`'s reply is built by hand, so it correlated correctly while every other
  // verb's did not — the upstream envelope's own requestId was spread over the local one and the
  // caller waited out its timeout against a perfectly healthy host. (Astra/verifier, 1788839927.)
  const statusResult = /** @type {any} */ (await locals[0].request("status", { roomId }));
  assert.ok(statusResult?.status, `status through the resident client returned ${JSON.stringify(statusResult)}`);
  const readResult = /** @type {any} */ (await locals[1].request("read", { roomId, since: nativeCursor(EPOCH, 0) }));
  assert.ok(Array.isArray(readResult?.messages), "read through the resident client returned no messages array");

  // And still ONE channel after both subscriptions: the fan-out is local, not a second dial.
  const after = spawned.filter((args) => args[0] !== "parse" && args[1] !== "printpub");
  assert.equal(after.length, 1, "a local subscribe opened a second member channel");

  // Stop the client HERE rather than leaving it to the after hooks. Those run in registration
  // order, so the HOST would stop first and this client would then spend its whole reconnect
  // budget dialling a host that is gone — thirty seconds of process-exit delay that reads as a
  // hang and tells nobody anything. `stop` is idempotent, so the hook below stays as the net.
  await client.stop();
});

test("the upstream is lost while two consumers stay subscribed: it re-dials and BOTH still receive", async (t) => {
  const { service, seatRoot, descriptorPath, channelOptions, spawned, dials, identity, roomId } = await rig(t);

  const client = new MemberClientService({
    stateRoot: seatRoot, alias: "house-remote", descriptorPath,
    keyDigest: `sha256:${"e".repeat(64)}`, seatLabel: "amore-dev-laptop",
    channelOptions, identity,
    // Small enough that the cell measures the mechanism rather than waiting out a production
    // default, and the idle clock is what NOTICES a channel that stopped carrying: a member route
    // is a relayed path under no obligation to emit a close, which is the whole reason that clock
    // exists. Setting it here means the cell passes whether or not the close event arrives.
    idleMs: 200, maxReconnects: 5, backoffMs: 20,
  });
  await client.start();

  const descriptor = await readMemberDescriptor(seatRoot, "house-remote");
  const since = nativeCursor(EPOCH, 0);
  /** @type {any[][]} */
  const received = [[], []];
  /** @type {any[]} */
  const locals = [];
  for (const [index] of [[0], [1]]) {
    const local = await NativeServiceClient.connect({ ...descriptor, timeoutMs: 5000 });
    locals.push(local);
    t.after(() => local.close());
    await local.subscribe(roomId, since, (message) => { received[index].push(message); });
  }

  const dialsBefore = spawned.filter((args) => args[0] !== "parse" && args[1] !== "printpub").length;
  assert.equal(dialsBefore, 1);

  // THE LOSS. The member channel dies under the resident while both local consumers stay exactly
  // where they are. The defect this replaces attached each consumer's listener to the client object
  // that existed at subscribe time, so after the re-dial the room was live, the host was appending,
  // and neither consumer ever heard anything again: dials 2, deliveries 0.
  dials[0].toClient.destroy();

  const redialled = Date.now() + 5000;
  while (Date.now() < redialled
    && spawned.filter((args) => args[0] !== "parse" && args[1] !== "printpub").length <= dialsBefore)
    await new Promise((r) => setTimeout(r, 20));
  const dialsAfter = spawned.filter((args) => args[0] !== "parse" && args[1] !== "printpub").length;
  assert.ok(dialsAfter > dialsBefore, "the resident never re-dialled after the channel was destroyed");

  // A message appended on the host AFTER the recovery, through the host's own protocol so the
  // service broadcasts it. Reaching both consumers is the property; the re-dial alone is not.
  const hostLocal = await NativeServiceClient.connect(
    /** @type {any} */ ({ ...service.descriptor(), timeoutMs: 5000 }));
  t.after(() => hostLocal.close());
  const ack = /** @type {any} */ (await hostLocal.request("append", { roomId, operation: {
    operationId: "l12redial".padEnd(32, "0"), authorName: "host", authorKind: "agent",
    text: "after the re-dial" } }));
  assert.ok(ack?.id ?? ack?.cursor, `the host did not accept the append: ${JSON.stringify(ack)}`);

  const deadline = Date.now() + 5000;
  const sawIt = (/** @type {any[]} */ batch) => batch.some((m) => String(m.text).includes("after the re-dial"));
  while (Date.now() < deadline && !(sawIt(received[0]) && sawIt(received[1])))
    await new Promise((r) => setTimeout(r, 25));

  assert.ok(sawIt(received[0]), `the first consumer never saw the post-redial message: ${JSON.stringify(received[0].map((m) => m.text))}`);
  assert.ok(sawIt(received[1]), `the second consumer never saw the post-redial message: ${JSON.stringify(received[1].map((m) => m.text))}`);

  // Cursors stay monotone per consumer, which is the half of the at-least-once contract a
  // duplicate does not excuse: a replay may repeat a message by id, never reorder the room.
  for (const batch of received) {
    const sequences = batch.map((m) => Number(String(m.cursor).split(":")[1]));
    const sorted = [...sequences].sort((a, b) => a - b);
    assert.deepEqual(sequences, sorted, `a consumer received cursors out of order: ${JSON.stringify(sequences)}`);
  }

  await client.stop();
});
