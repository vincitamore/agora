// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NativeRoomService, NativeServiceClient } from "../src/native-service.mjs";
import { SERVICE_DARK, ServiceDarkError, openNativeSubscription, serviceDescriptorPath, serviceDescriptorStatus } from "../src/wake/subscriber.mjs";
import { nativeTransport } from "../src/transports/native.mjs";
import { isWatchStop, watch, watchStopReason } from "../src/watch.mjs";
import { readCursor } from "../src/core.mjs";
import { matchesAddress, parseTrailers } from "../src/trailers.mjs";

const ROOM = "6".repeat(32);
const EPOCH = "7".repeat(32);
const ACCOUNT = "seat_account_0002";
const ME = { name: "Fable/watch", kind: /** @type {const} */ ("agent") };
const PEER = { name: "Sol/codex", kind: /** @type {const} */ ("agent") };

/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-subscriber-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new NativeRoomService({ root, accountId: ACCOUNT, seatLabel: "admin-pc" });
  await service.start();
  await service.createRoom({ roomId: ROOM, epoch: EPOCH });
  t.after(() => service.stop());
  const room = { transport: "native", roomId: ROOM };
  const mine = nativeTransport(room, { actor: ME, stateRoot: root });
  const peer = nativeTransport(room, { actor: PEER, stateRoot: root });
  return { root, service, mine, peer, session: (/** @type {string} */ slug) => path.join(root, "sessions", slug) };
}

/** The reader's own `--wake mine`: what names this bearer, its seat, or everyone. */
const wakeMine = (/** @type {import('../src/core.mjs').Message} */ m) =>
  parseTrailers(m.text).to.some((a) => matchesAddress(a, ME.name, { id: ACCOUNT, name: ME.name }));

/** @param {import('../src/wake/subscriber.mjs').NativeSubscription} subscription @param {import('../src/core.mjs').Transport} transport */
const through = (subscription, transport) => ({ ...transport, read: (/** @type {any} */ o) => subscription.read(o) });

test("a subscriber delivers from its cursor, skips its own post by the ledger, filters by the reader's wake rule, and writes the cursor once per delivered batch", async (t) => {
  const { root, mine, peer, session } = await fixture(t);
  const state = session("a");
  const posted = new Set();
  posted.add((await mine.post("mine, on watch")).id);
  await peer.post("for someone else\n\nto: Opus/review");
  await peer.post("for you\n\nto: Fable/watch");
  const subscription = await openNativeSubscription({ stateRoot: root, roomId: ROOM, since: `${EPOCH}:0` });
  t.after(() => subscription.close());
  /** @type {string[][]} */
  const batches = [];
  /** @type {Array<string | undefined>} */
  const cursorAtDelivery = [];
  const onBatch = async (/** @type {import('../src/core.mjs').Message[]} */ msgs) => {
    batches.push(msgs.map((m) => m.text.split("\n")[0]));
    cursorAtDelivery.push(await readCursor(state, "nat"));
  };
  let r = await watch(through(subscription, mine), {
    stateDir: state, key: "nat", cursor: `${EPOCH}:0`, interval: 0.05,
    sleep: (ms) => subscription.wait(ms), own: () => posted, wake: wakeMine, onBatch,
  });
  assert.equal(r.fired, true);
  assert.equal(r.delivered, 1);
  assert.equal(r.skipped, 1, "this session's own post is skipped by the ledger, not by the author");
  assert.equal(r.filtered, 1, "a message addressed to someone else does not wake --wake mine");
  assert.deepEqual(batches, [["for you"]]);
  assert.equal(await readCursor(state, "nat"), `${EPOCH}:3`, "the cursor advanced past own and filtered messages too");
  assert.equal(cursorAtDelivery[0], undefined, "the cursor is written after delivery, not before");

  // two more, held into one coalesced window: one delivery, one cursor write after it
  await peer.post("a\n\nto: Fable/watch");
  await peer.post("b\n\nto: Fable/watch");
  r = await watch(through(subscription, mine), {
    stateDir: state, key: "nat", interval: 0.05, coalesceSeconds: 0.3,
    sleep: (ms) => subscription.wait(ms), own: () => posted, wake: wakeMine, onBatch,
  });
  assert.equal(r.fired, true);
  assert.equal(r.delivered, 2);
  assert.deepEqual(batches, [["for you"], ["a", "b"]]);
  assert.equal(cursorAtDelivery[1], `${EPOCH}:3`, "the cursor stayed on disk until the batch was handed over");
  assert.equal(await readCursor(state, "nat"), `${EPOCH}:5`);
});

test("replay and pushed events are one ordered stream, and two subscribers on one seat each receive every sequence once", async (t) => {
  const { root, peer } = await fixture(t);
  const before = 60;
  const after = 60;
  for (let i = 1; i <= before; i++) await peer.post(`m${i}`);
  const a = await openNativeSubscription({ stateRoot: root, roomId: ROOM, since: `${EPOCH}:0` });
  const b = await openNativeSubscription({ stateRoot: root, roomId: ROOM, since: `${EPOCH}:0` });
  t.after(() => { a.close(); b.close(); });
  const posting = (async () => { for (let i = before + 1; i <= before + after; i++) await peer.post(`m${i}`); })();
  /** @param {import('../src/wake/subscriber.mjs').NativeSubscription} s */
  const drain = async (s) => {
    /** @type {import('../src/core.mjs').Message[]} */
    const out = [];
    while (out.length < before + after) {
      const got = await s.read({ since: out.length ? out[out.length - 1].cursor : `${EPOCH}:0` });
      out.push(...got);
      if (out.length < before + after) await s.wait(2000);
    }
    return out;
  };
  const [seenA, seenB] = await Promise.all([drain(a), drain(b)]);
  await posting;
  const expected = Array.from({ length: before + after }, (_, i) => `m${i + 1}`);
  assert.deepEqual(seenA.map((m) => m.text), expected, "subscriber A: in order, each once");
  assert.deepEqual(seenB.map((m) => m.text), expected, "subscriber B: in order, each once, nothing stolen by A");
  assert.deepEqual(seenA.map((m) => m.cursor), expected.map((_, i) => `${EPOCH}:${i + 1}`));
});

test("two sessions on one seat never consume each other's cursor", async (t) => {
  const { root, mine, peer, session } = await fixture(t);
  await peer.post("one");
  await peer.post("two");
  const a = await openNativeSubscription({ stateRoot: root, roomId: ROOM, since: `${EPOCH}:0` });
  const b = await openNativeSubscription({ stateRoot: root, roomId: ROOM, since: `${EPOCH}:0` });
  t.after(() => { a.close(); b.close(); });
  /** @type {string[]} */
  const seenA = [];
  /** @type {string[]} */
  const seenB = [];
  const ra = await watch(through(a, mine), { stateDir: session("a"), key: "nat", cursor: `${EPOCH}:0`, interval: 0.05, coalesceSeconds: 0.3,
    sleep: (ms) => a.wait(ms), onBatch: (m) => { seenA.push(...m.map((x) => x.text)); } });
  assert.equal(ra.delivered, 2);
  assert.equal(await readCursor(session("a"), "nat"), `${EPOCH}:2`);
  assert.equal(await readCursor(session("b"), "nat"), undefined, "A's delivery moved nothing of B's");
  const rb = await watch(through(b, mine), { stateDir: session("b"), key: "nat", cursor: `${EPOCH}:0`, interval: 0.05, coalesceSeconds: 0.3,
    sleep: (ms) => b.wait(ms), onBatch: (m) => { seenB.push(...m.map((x) => x.text)); } });
  assert.equal(rb.delivered, 2);
  assert.deepEqual(seenA, ["one", "two"]);
  assert.deepEqual(seenB, ["one", "two"]);
  assert.equal(await readCursor(session("b"), "nat"), `${EPOCH}:2`);
  assert.equal(await readCursor(session("a"), "nat"), `${EPOCH}:2`);
});

test("the service dying mid-stream ends the watch with service-dark, delivers what it had, and moves no cursor", async (t) => {
  const { root, service, mine, peer, session } = await fixture(t);
  const state = session("a");
  const subscription = await openNativeSubscription({ stateRoot: root, roomId: ROOM, since: `${EPOCH}:0` });
  t.after(() => subscription.close());
  let deliveries = 0;
  const started = watch(through(subscription, mine), {
    stateDir: state, key: "nat", cursor: `${EPOCH}:0`, mode: "stream", interval: 0.05,
    sleep: (ms) => subscription.wait(ms),
    onBatch: async () => {
      deliveries += 1;
      if (deliveries === 1) await service.stop(); // the socket closes under the subscriber
    },
  });
  await peer.post("last words");
  const r = await started;
  assert.equal(r.reason, SERVICE_DARK);
  assert.equal(r.fired, true, "what arrived before the death was delivered");
  assert.equal(r.delivered, 1);
  assert.equal(await readCursor(state, "nat"), `${EPOCH}:1`, "the cursor is where the last delivery left it, and no further");
  assert.equal(typeof subscription.dark(), "string");
  await assert.rejects(subscription.read({ since: `${EPOCH}:1` }), (e) => e instanceof ServiceDarkError && watchStopReason(e) === SERVICE_DARK && e.exitCode === 1);
});

test("no descriptor, a hello the service refuses, and a stopped service are each service-dark, never a quiet room", async (t) => {
  const { root, service } = await fixture(t);
  const empty = await mkdtemp(path.join(tmpdir(), "agora-subscriber-empty-"));
  t.after(() => rm(empty, { recursive: true, force: true }));
  await assert.rejects(openNativeSubscription({ stateRoot: empty, roomId: ROOM }), (e) => e instanceof ServiceDarkError && /no seat service descriptor/.test(e.message));
  const forged = await mkdtemp(path.join(tmpdir(), "agora-subscriber-forged-"));
  t.after(() => rm(forged, { recursive: true, force: true }));
  const descriptor = JSON.parse(await readFile(serviceDescriptorPath(root), "utf8"));
  await mkdir(path.dirname(serviceDescriptorPath(forged)), { recursive: true });
  await writeFile(serviceDescriptorPath(forged), JSON.stringify({ ...descriptor, nonce: "wrong_nonce_00001" }));
  await assert.rejects(openNativeSubscription({ stateRoot: forged, roomId: ROOM }), (e) => e instanceof ServiceDarkError && /server proof was invalid/.test(e.message));
  const status = await serviceDescriptorStatus(root);
  assert.equal(status.present, true);
  assert.equal(status.accountId, ACCOUNT);
  assert.ok(!JSON.stringify(status).includes(descriptor.nonce), "doctor's view of the service never carries the secret");
  await service.stop();
  await assert.rejects(openNativeSubscription({ stateRoot: root, roomId: ROOM }), (e) => e instanceof ServiceDarkError);
  const gone = await serviceDescriptorStatus(root);
  assert.equal(gone.present, false, "a stopped service takes its descriptor with it");
});

test("a refused cursor is this session's to recover, not the service being dark", async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(openNativeSubscription({ stateRoot: root, roomId: ROOM, since: `${"8".repeat(32)}:0` }),
    (e) => !(e instanceof ServiceDarkError) && /epoch/.test(String(e)));
});

test("a session with no saved position subscribes from the newest window: the service requires an explicit cursor and replays after it", async (t) => {
  const { root, peer } = await fixture(t);
  for (let i = 1; i <= 3; i++) await peer.post(`m${i}`);
  const subscription = await openNativeSubscription({ stateRoot: root, roomId: ROOM });
  t.after(() => subscription.close());
  await subscription.wait(2000);
  const replayed = await subscription.read();
  assert.deepEqual(replayed.map((m) => m.text), ["m1", "m2", "m3"], "a short room is the whole room, as a local read with no cursor");
  await peer.post("m4");
  await subscription.wait(2000);
  assert.deepEqual((await subscription.read({ since: replayed.at(-1)?.cursor })).map((m) => m.text), ["m4"]);
});

test("a room the service does not host is refused, never reported as the service being dark, with or without a saved cursor", async (t) => {
  const { root } = await fixture(t);
  const unknown = "e".repeat(32);
  await assert.rejects(openNativeSubscription({ stateRoot: root, roomId: unknown }),
    (e) => !(e instanceof ServiceDarkError) && e instanceof Error && /request-refused/.test(e.message) && !isWatchStop(e), "no saved cursor: the status request is refused on a live socket");
  await assert.rejects(openNativeSubscription({ stateRoot: root, roomId: unknown, since: `${EPOCH}:0` }),
    (e) => !(e instanceof ServiceDarkError) && e instanceof Error && /request-refused/.test(e.message), "a saved cursor: the subscribe is refused the same way");
  const dark = new ServiceDarkError("x");
  assert.equal(watchStopReason(dark), SERVICE_DARK, "dark carries the declared stop protocol");
  assert.equal(watchStopReason(new Error("watchReason: service-dark")), undefined, "a spelling is not the protocol");
});

test("a first arm on a room longer than the window names the committed positions it was never offered, as positions and not as cursor movement", async (t) => {
  const { root, peer } = await fixture(t);
  for (let i = 1; i <= 5; i++) await peer.post(`m${i}`);
  const subscription = await openNativeSubscription({ stateRoot: root, roomId: ROOM, window: 3 });
  t.after(() => subscription.close());
  assert.deepEqual(subscription.neverOffered, { from: `${EPOCH}:1`, to: `${EPOCH}:2`, count: 2 });
  await subscription.wait(2000);
  assert.deepEqual((await subscription.read()).map((m) => m.text), ["m3", "m4", "m5"]);
  const whole = await openNativeSubscription({ stateRoot: root, roomId: ROOM, window: 10 });
  t.after(() => whole.close());
  assert.equal(whole.neverOffered, null, "a room inside the window offers everything");
  const explicit = await openNativeSubscription({ stateRoot: root, roomId: ROOM, since: `${EPOCH}:0`, window: 3 });
  t.after(() => explicit.close());
  assert.equal(explicit.neverOffered, null, "a saved or set cursor is the session's own position, not a window");
});

/**
 * The property the head is named for, exercised rather than read: a CONNECTED subscriber whose
 * channel has gone dark in each of the three ways `classify` recognises reports the next failure
 * as the service being dark, carrying the declared stop protocol, never as the underlying error.
 * `connect` is injected so the condition is set on the real client after its hello and before the
 * first request. Replacing the discriminator with `false` turns every case here red.
 */
test("a connected subscriber whose channel went dark reports the next failure as service-dark under each dark condition, never as the underlying error", async (t) => {
  const { root } = await fixture(t);
  const unknown = "e".repeat(32);
  /** @param {(client: import('../src/native-service.mjs').NativeServiceClient) => void} arm */
  const connectThen = (arm) => /** @type {typeof NativeServiceClient.connect} */ (async (endpoint) => {
    const client = await NativeServiceClient.connect(endpoint);
    arm(client);
    return client;
  });
  /** @param {unknown} e @param {string} condition @param {RegExp} cause the underlying failure the dark verdict wraps: pins the case to the post-connection line, not to a failed connect */
  const isDark = (e, condition, cause) => {
    assert.ok(e instanceof ServiceDarkError, `${condition}: expected ServiceDarkError, got ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
    assert.match(e.message, cause, `${condition}: wraps the underlying failure, not a connect failure`);
    assert.equal(watchStopReason(e), SERVICE_DARK, `${condition}: the stop protocol is carried`);
    assert.equal(e.exitCode, 1, `${condition}: exit 1, never a new code`);
    return true;
  };

  // 1. darkReason already set by the subscriber's own error listener on a still-open socket: the
  //    link fails after the hello, before the service answers the first request
  await assert.rejects(
    openNativeSubscription({ stateRoot: root, roomId: ROOM, connect: connectThen((client) => {
      setImmediate(() => client.socket.emit("error", new Error("simulated link failure after hello")));
    }) }),
    (e) => isDark(e, "darkReason set by a listener (status)", /simulated link failure after hello/));

  // 2. socket.destroyed before the first request is written: the request is refused locally and
  //    the close event has not yet run any listener, so only the socket's state says dark
  await assert.rejects(
    openNativeSubscription({ stateRoot: root, roomId: ROOM, connect: connectThen((client) => client.socket.destroy()) }),
    (e) => isDark(e, "socket.destroyed (status)", /request was not sent/));
  await assert.rejects(
    openNativeSubscription({ stateRoot: root, roomId: ROOM, since: `${EPOCH}:0`, connect: connectThen((client) => client.socket.destroy()) }),
    (e) => isDark(e, "socket.destroyed (subscribe)", /request was not sent/));

  // 3. the socket is no longer writable while not reported destroyed: the write side is gone
  await assert.rejects(
    openNativeSubscription({ stateRoot: root, roomId: unknown, since: `${EPOCH}:0`, connect: connectThen((client) => {
      Object.defineProperty(client.socket, "writable", { value: false, configurable: true });
      Object.defineProperty(client.socket, "destroyed", { value: false, configurable: true });
    }) }),
    (e) => isDark(e, "!socket.writable (subscribe)", /request was not sent/));

  // the control: the same refusal on a healthy channel is not dark (the discriminator, not the
  // error, decides)
  await assert.rejects(openNativeSubscription({ stateRoot: root, roomId: unknown, since: `${EPOCH}:0` }),
    (e) => !(e instanceof ServiceDarkError) && !isWatchStop(e));
});
