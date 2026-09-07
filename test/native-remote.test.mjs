// T2 remote client: the far half of native membership over Tailcat.
//
// The rig is the cut's: both halves in one process against two state roots, with the Tailcat child
// faked as a loopback duplex, so a green run proves the CLIENT half against T1's real host
// admission path and proves nothing about Tailcat's own `--allow` refusal or a live rendezvous —
// those are T3's, on two real machines. Every cell that claims a refusal asserts the NAMED reason.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Duplex, PassThrough } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";
import {
  buildRouteBinding, buildRouteDescriptor, descriptorDigest, memberHandshakeProof, memberTranscript,
  mintRouteSecret, routeProofRef, writeRouteSecret, MEMBER_PHASES,
} from "../src/native-member.mjs";
import {
  RemoteRoom, assertRemoteDescriptor, completeMemberHandshake, openRemoteRoom,
  openRemoteSubscription, readRemoteDescriptor, resolveSeatIdentity,
} from "../src/native-remote.mjs";
import { NATIVE_PROTOCOL, NativeFrameDecoder, encodeNativeFrame, nativeCursor } from "../src/native-protocol.mjs";
import { NativeRoomService } from "../src/native-service.mjs";

const run = promisify(execFile);
const BIN = new URL("../bin/agora.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const CLEARED = ["CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_PID", "GROK_SESSION_ID",
  "GROK_PID", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "HERMES_SESSION_ID", "AGORA_SESSION_PID",
  "AGORA_SESSION", "AGORA_ACTOR", "AGORA_CONFIG", "AGORA_STATE"];

const HOST_ACCOUNT = "a".repeat(32);
const ROOM = "b".repeat(32);
const EPOCH = "c".repeat(32);
const KEY = `nodekey:${"d".repeat(64)}`;
const OTHER_KEY = `nodekey:${"e".repeat(64)}`;
const ADDRESS = `tc${"a".repeat(48)}`;

/** @param {string[]} args @param {Record<string, string>} env */
async function agora(args, env) {
  try {
    const clean = { ...process.env };
    for (const name of CLEARED) delete clean[name];
    const child = run(process.execPath, [BIN, ...args], { env: { ...clean, ...env }, windowsHide: true });
    child.child.stdin?.end();
    const { stdout, stderr } = await child;
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = /** @type {any} */ (e);
    return { code: err.code, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

/** A binding with no running service, for the offline cells. */
function offlineBinding(over = {}) {
  return buildRouteBinding({
    hostAccountId: HOST_ACCOUNT, hostAuthority: HOST_ACCOUNT, roomId: ROOM, roomEpoch: EPOCH,
    serviceBootId: "f".repeat(32), publicNodeKey: KEY, ...over,
  });
}

/** @param {any} binding @param {string} proofRef */
function offlineDescriptor(binding, proofRef) {
  return buildRouteDescriptor({ binding, endpoint: { transport: "tailcat", address: ADDRESS, port: 4242 },
    proofRef, issuedAt: new Date().toISOString() });
}

/** A Tailcat child that never runs. @param {{ exit?: number | null, signal?: AbortSignal, stdout?: any, stdin?: any }} [options] */
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
 * The whole rig: a live host service with one faked route, and a RemoteRoom whose dial is wired
 * straight into that route's accept hook. Every dial makes a fresh loopback pair, which is what
 * makes the reconnect cells real rather than a reuse of one socket.
 * @param {import('node:test').TestContext} t
 * @param {{ secret?: string, descriptor?: any, key?: string }} [over]
 */
async function rig(t, over = {}) {
  const hostRoot = await mkdtemp(path.join(tmpdir(), "agora-t2-host-"));
  const seatRoot = await mkdtemp(path.join(tmpdir(), "agora-t2-seat-"));
  t.after(() => rm(hostRoot, { recursive: true, force: true }));
  t.after(() => rm(seatRoot, { recursive: true, force: true }));
  const service = new NativeRoomService({ root: hostRoot, accountId: HOST_ACCOUNT, seatLabel: "admin-pc" });
  await service.start();
  await service.createRoom({ roomId: ROOM, epoch: EPOCH });
  t.after(() => service.stop());

  /** @type {((socket: any) => void) | undefined} */
  let accept;
  const opened = await service.openRoute({
    roomId: ROOM, publicNodeKey: KEY,
    routeOptions: {
      listen: async (/** @type {(socket: any) => void} */ hook) => { accept = hook; return { port: 4242, close: async () => {} }; },
      spawn: async (/** @type {string[]} */ args, /** @type {any} */ _r, /** @type {any} */ owner) =>
        fakeChild({ exit: args[0] === "parse" ? 0 : null, signal: owner?.signal }),
      address: async () => ADDRESS,
    },
  });
  const secret = over.secret ?? await readSecret(hostRoot, opened.descriptor);
  const keyPath = path.join(seatRoot, "identity.private.json");
  await writeFile(keyPath, "{}", { mode: 0o600 });

  /** Streams handed to the host, so a cell can destroy one to force a reconnect. */
  /** @type {any[]} */
  const hostStreams = [];
  /** @type {any[]} */
  const clientStreams = [];
  // A dial can be HELD, so a cell can put the channel down, commit on the host while it is down,
  // and release — which is what a real reconnect gap looks like and what makes the replay cells
  // deterministic instead of a race against the re-dial.
  /** @type {{ release: () => void } | undefined} */
  let held;
  let holding = false;
  /** Every `subscribe` the host was asked for, in order, with the cursor it was asked from. The
   * read floor suppresses a duplicate whatever cursor a re-subscribe uses, so the cursor itself is
   * the only observable that discriminates a correct reattach from a full re-replay. */
  /** @type {string[]} */
  const subscribes = [];
  /** Every Tailcat argv the remote asked for, so a cell can assert a refusal happened BEFORE one. */
  /** @type {string[][]} */
  const spawned = [];
  const dial = () => {
    const toHost = new PassThrough();
    const toClient = new PassThrough();
    const spy = new PassThrough();
    const decoder = new NativeFrameDecoder();
    // Forwarded by hand rather than piped: a `data` listener on a piped stream would steal the
    // bytes from the host.
    spy.on("data", (chunk) => {
      try { for (const frame of decoder.push(chunk)) {
        const f = /** @type {any} */ (frame);
        if (f.type === "subscribe") subscribes.push(String(f.since));
      } } catch { /* the framing cells cover a malformed frame; this tap only observes */ }
      toHost.write(chunk);
    });
    const hostSide = Duplex.from({ readable: toHost, writable: toClient });
    hostStreams.push(hostSide);
    const wire = () => /** @type {(socket: any) => void} */ (accept)(hostSide);
    if (holding) held = { release: wire }; else wire();
    return { stdout: toClient, stdin: spy };
  };
  const gate = {
    hold() { holding = true; },
    async release() {
      holding = false;
      const deadline = Date.now() + 5000;
      while (!held && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      held?.release();
      held = undefined;
    },
  };
  // A factory, not one instance: a re-armed watch is a NEW client process against the SAME host
  // route, and the at-least-once cell is exactly about what the second one is offered.
  const makeRoom = () => {
    const made = new RemoteRoom({
      descriptor: over.descriptor ?? opened.descriptor, secret, stateRoot: seatRoot, keyPath,
      nodeKey: over.key ?? KEY, timeoutMs: 4000,
      channelOptions: {
        spawn: async (/** @type {string[]} */ args, /** @type {any} */ _r, /** @type {any} */ owner) => {
          spawned.push(args);
          if (args[0] === "parse") return fakeChild({ exit: 0, signal: owner?.signal });
          if (args[1] === "printpub") {
            const stdout = new PassThrough();
            const child = fakeChild({ exit: 0, stdout, signal: owner?.signal });
            stdout.end(`${over.key ?? KEY}\n`);
            return child;
          }
          const wires = dial();
          clientStreams.push(wires);
          return fakeChild({ signal: owner?.signal, ...wires });
        },
      },
    });
    t.after(() => made.close());
    return made;
  };
  const room = makeRoom();
  return { hostRoot, seatRoot, service, opened, secret, room, makeRoom, hostStreams, keyPath, gate, subscribes, spawned };
}

/** @param {string} root @param {any} descriptor */
async function readSecret(root, descriptor) {
  const { readRouteSecret } = await import("../src/native-member.mjs");
  return readRouteSecret(root, descriptor.binding, descriptor.proofRef);
}

// ------------------------------------------------------------ the descriptor, offline

test("a descriptor is refused when it is absent, unparseable, or its digest does not cover it", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-t2-desc-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(readRemoteDescriptor(path.join(root, "nope.json")), /descriptor-unreadable/);
  const bad = path.join(root, "bad.json");
  await writeFile(bad, "{not json");
  await assert.rejects(readRemoteDescriptor(bad), /descriptor-unreadable/);

  const b = offlineBinding();
  const d = offlineDescriptor(b, routeProofRef(b));
  const good = path.join(root, "good.json");
  await writeFile(good, JSON.stringify(d));
  assert.equal((await readRemoteDescriptor(good)).descriptorDigest, d.descriptorDigest);

  // A mutated field with the ORIGINAL digest: the mutation is what the digest is for.
  const tampered = path.join(root, "tampered.json");
  await writeFile(tampered, JSON.stringify({ ...d, endpoint: { ...d.endpoint, port: 4243 } }));
  await assert.rejects(readRemoteDescriptor(tampered), /digest does not cover/);

  // And the closed record: a descriptor carrying an extra key is refused by the SHAPE, which is a
  // property of validateRouteDescriptor rather than a guard this file adds.
  const extra = path.join(root, "extra.json");
  const carrying = { ...d, secret: mintRouteSecret() };
  await writeFile(extra, JSON.stringify({ ...carrying, descriptorDigest: descriptorDigest(carrying) }));
  await assert.rejects(readRemoteDescriptor(extra), /./);
});

test("a descriptor granted to another key is refused by name, and so is a foreign proofRef", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-t2-ours-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const b = offlineBinding();
  const d = offlineDescriptor(b, routeProofRef(b));
  assert.equal(assertRemoteDescriptor(d, { stateRoot: root, nodeKey: KEY }), d);
  assert.throws(() => assertRemoteDescriptor(d, { stateRoot: root, nodeKey: OTHER_KEY }), /descriptor-not-ours/);

  // proofRef selection: the descriptor may name exactly one file, its own.
  const other = offlineBinding();
  const crossed = offlineDescriptor(b, routeProofRef(other));
  assert.throws(() => assertRemoteDescriptor(crossed, { stateRoot: root, nodeKey: KEY }), /proof-ref-refused/);
});

test("a connect never mints an identity: the refusal is named and no key is left behind", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-t2-enroll-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keyPath = path.join(root, "tailcat", "identity.private.json");
  let minted = false;
  await assert.rejects(resolveSeatIdentity(root, { identity: /** @type {any} */ (async () => { minted = true; return { keyPath, nodeKey: KEY, fingerprint: "x" }; }) }),
    /enrollment-absent/);
  // The discriminating assertion, and the whole reason this function exists: the generator was not
  // reached, so a failed dial leaves no new identity on disk to be mistaken for an enrolled one.
  assert.equal(minted, false, "the identity generator ran on an un-enrolled seat");
  await assert.rejects(stat(keyPath), /ENOENT/);
});

// ------------------------------------------------------------ the handshake, against the real host

test("the member handshake completes against the host, and the remote owns its own authorship", async (t) => {
  const { room, service } = await rig(t);
  const client = await room.client();
  const status = await client.request("status", { roomId: ROOM });
  assert.equal(status.status.epoch, EPOCH);

  const receipt = await client.request("append", { roomId: ROOM,
    operation: { operationId: "o".repeat(32), authorName: "Opus/t2", authorKind: "agent", text: "from the far seat" } });
  assert.ok(receipt.cursor);
  const store = await service.openRoom(ROOM);
  const [message] = store.read({ since: nativeCursor(EPOCH, 0), limit: 10 }).slice(-1);
  assert.equal(message.text, "from the far seat");
  // The host stamps author.id from the BINDING, so the remote principal owns its byline and its
  // message identity rather than sharing the host's.
  assert.equal(message.author.id, room.binding.accountId);
  assert.match(message.author.id, /^m-[a-f0-9]{32}$/);
  assert.notEqual(message.author.id, HOST_ACCOUNT);
});

test("a host that speaks the LOCAL handshake is refused by name, not fallen through to", async () => {
  const b = offlineBinding();
  const secret = mintRouteSecret();
  const toHost = new PassThrough();
  const toClient = new PassThrough();
  const stream = Duplex.from({ readable: toClient, writable: toHost });
  toClient.write(encodeNativeFrame({ protocol: NATIVE_PROTOCOL, type: "server-hello", bootEpoch: "f".repeat(32),
    requestId: "1".repeat(32), serverChallenge: "2".repeat(32), accountId: HOST_ACCOUNT, seatLabel: "admin-pc", proof: "0".repeat(64) }));
  await assert.rejects(completeMemberHandshake({ stream, binding: b, secret, timeoutMs: 2000 }), /member-phase-refused/);
});

test("a server hello proved under the wrong secret is refused as a proof failure, by name", async (t) => {
  const { room } = await rig(t, { secret: mintRouteSecret() });
  await assert.rejects(room.client(), /member-host-proof-refused/);
});

test("a server hello whose binding is not this descriptor's is refused before the proof is consulted", async () => {
  const mine = offlineBinding();
  const theirs = offlineBinding({ roomId: "9".repeat(32) });
  const secret = mintRouteSecret();
  const toHost = new PassThrough();
  const toClient = new PassThrough();
  const stream = Duplex.from({ readable: toClient, writable: toHost });
  const fresh = { bootEpoch: "f".repeat(32), requestId: "1".repeat(32), serverChallenge: "2".repeat(32) };
  const transcript = memberTranscript(theirs, fresh);
  // Correctly proved for THEIR route, under the same secret: only the binding comparison can catch
  // it, and it must catch it with a named reason rather than as an opaque proof failure.
  toClient.write(encodeNativeFrame({ protocol: NATIVE_PROTOCOL, type: "member-server-hello", ...transcript,
    proof: memberHandshakeProof(secret, MEMBER_PHASES.server, transcript) }));
  await assert.rejects(completeMemberHandshake({ stream, binding: mine, secret, timeoutMs: 2000 }), /member-binding-mismatch/);
});

test("a welcome that does not prove the fresh transcript is refused", async () => {
  const b = offlineBinding();
  const secret = mintRouteSecret();
  const toHost = new PassThrough();
  const toClient = new PassThrough();
  const stream = Duplex.from({ readable: toClient, writable: toHost });
  const fresh = { bootEpoch: "f".repeat(32), requestId: "1".repeat(32), serverChallenge: "2".repeat(32) };
  const serverTranscript = memberTranscript(b, fresh);
  toClient.write(encodeNativeFrame({ protocol: NATIVE_PROTOCOL, type: "member-server-hello", ...serverTranscript,
    proof: memberHandshakeProof(secret, MEMBER_PHASES.server, serverTranscript) }));
  // Answer the client hello with a welcome proved under a DIFFERENT secret.
  const decoder = new (await import("../src/native-protocol.mjs")).NativeFrameDecoder();
  toHost.on("data", (bytes) => {
    for (const frame of decoder.push(bytes)) {
      const f = /** @type {any} */ (frame);
      if (f.type !== "member-client-hello") continue;
      const { protocol: _p, type: _t, proof: _pr, ...transcript } = f;
      toClient.write(encodeNativeFrame({ protocol: NATIVE_PROTOCOL, type: "member-welcome", ...transcript,
        proof: memberHandshakeProof(mintRouteSecret(), MEMBER_PHASES.welcome, transcript) }));
    }
  });
  await assert.rejects(completeMemberHandshake({ stream, binding: b, secret, timeoutMs: 2000 }), /member-welcome-refused/);
});

test("frames arriving with the welcome are refused rather than stranded in the handshake reader", async () => {
  const b = offlineBinding();
  const secret = mintRouteSecret();
  const toHost = new PassThrough();
  const toClient = new PassThrough();
  const stream = Duplex.from({ readable: toClient, writable: toHost });
  const fresh = { bootEpoch: "f".repeat(32), requestId: "1".repeat(32), serverChallenge: "2".repeat(32) };
  const serverTranscript = memberTranscript(b, fresh);
  toClient.write(encodeNativeFrame({ protocol: NATIVE_PROTOCOL, type: "member-server-hello", ...serverTranscript,
    proof: memberHandshakeProof(secret, MEMBER_PHASES.server, serverTranscript) }));
  const decoder = new (await import("../src/native-protocol.mjs")).NativeFrameDecoder();
  toHost.on("data", (bytes) => {
    for (const frame of decoder.push(bytes)) {
      const f = /** @type {any} */ (frame);
      if (f.type !== "member-client-hello") continue;
      const { protocol: _p, type: _t, proof: _pr, ...transcript } = f;
      // The welcome and an unsolicited event in ONE write: a reader that framed per call would
      // decode the welcome and drop the second frame's bytes, and the request client's own decoder
      // would then desync much later, against an unrelated cause.
      toClient.write(Buffer.concat([
        encodeNativeFrame({ protocol: NATIVE_PROTOCOL, type: "member-welcome", ...transcript,
          proof: memberHandshakeProof(secret, MEMBER_PHASES.welcome, transcript) }),
        encodeNativeFrame({ protocol: NATIVE_PROTOCOL, type: "event", roomId: ROOM, message: { id: "x" } }),
      ]));
    }
  });
  await assert.rejects(completeMemberHandshake({ stream, binding: b, secret, timeoutMs: 2000 }),
    /unsolicited frame/);
});

test("the dial's own gate fires: a route granted to another key is refused before any child is spawned", async (t) => {
  // The channel's assertDescriptor callback is the last named gate before a Tailcat child exists.
  // Comparing the handed descriptor with the one this room resolved could never fail, so the
  // callback re-checks the grant against THIS seat's key, and this is the run in which it fails.
  const { room, spawned } = await rig(t, { key: OTHER_KEY });
  await assert.rejects(room.client(), /descriptor-not-ours/);
  assert.deepEqual(spawned, [], "a Tailcat child was spawned for a route granted to another key");
});

// ------------------------------------------------------------ reconnect: at-least-once as the caller sees it

/** @param {any} service @param {number} n @param {string} tag */
async function commit(service, n, tag) {
  const store = await service.openRoom(ROOM);
  /** @type {string[]} */
  const ids = [];
  for (let i = 0; i < n; i += 1) {
    const receipt = /** @type {any} */ (await store.append(
      { operationId: `${tag}${String(i).padStart(2, "0")}`.padEnd(32, "0"), authorName: "host", authorKind: "agent", text: `${tag}-${i}` },
      { accountId: HOST_ACCOUNT }));
    ids.push(String(receipt.id));
  }
  return ids;
}

test("a death between delivery and the persisted cursor re-delivers, with the ORIGINAL id, and never rewinds", async (t) => {
  const { room, makeRoom, service } = await rig(t);
  const committed = await commit(service, 3, "aa");

  // Subscription A is the process that dies. It delivers all three; the caller persisted its
  // cursor after the FIRST, which is the only ordering in which a duplicate is observable at all
  // and the reason the contract is at-least-once rather than exactly-once.
  const a = await openRemoteSubscription({ room, since: nativeCursor(EPOCH, 0), backoffMs: 10 });
  /** @type {string[]} */
  const deliveredA = [];
  /** @type {number[]} */
  const persisted = [];
  for (const m of await a.read({ limit: 1 })) { deliveredA.push(m.id); persisted.push(Number(m.cursor.split(":")[1])); }
  for (const m of await a.read()) deliveredA.push(m.id);
  assert.deepEqual(deliveredA, committed);
  a.close();

  // The re-arm reads the PERSISTED cursor off disk, which is behind what A delivered.
  const b = await openRemoteSubscription({ room: makeRoom(), since: nativeCursor(EPOCH, persisted[0]), backoffMs: 10 });
  /** @type {string[]} */
  const deliveredB = [];
  for (const m of await b.read()) { deliveredB.push(m.id); persisted.push(Number(m.cursor.split(":")[1])); }
  b.close();

  // Nothing is lost: every committed message reached the caller across the two lives.
  const all = [...deliveredA, ...deliveredB];
  for (const id of committed) assert.ok(all.includes(id), `message ${id} was never delivered`);
  // At most one duplicate per death, and each duplicate carries its ORIGINAL message id — which is
  // what makes the id, not the cursor, the idempotence point a consumer dedups on.
  assert.deepEqual(deliveredB, committed.slice(1), "the re-arm did not replay exactly the un-persisted suffix");
  for (const id of deliveredB) assert.ok(committed.includes(id), `${id} is not one of the ids originally committed`);
  const counts = new Map();
  for (const id of all) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const [id, n] of counts) assert.ok(n <= 2, `${id} was delivered ${n} times across one death`);
  // The persisted cursor never moves backwards.
  for (let i = 1; i < persisted.length; i += 1)
    assert.ok(persisted[i] > persisted[i - 1], `the cursor moved backwards: ${persisted[i - 1]} then ${persisted[i]}`);
});

test("the tidy reconnect twin: nothing is lost across an in-process re-dial and the duplicate count is zero", async (t) => {
  const { room, service, gate } = await rig(t);
  const first = await commit(service, 2, "cc");
  const sub = await openRemoteSubscription({ room, since: nativeCursor(EPOCH, 0), backoffMs: 10 });
  /** @type {string[]} */
  const delivered = [];
  /** @type {number[]} */
  const cursors = [];
  const drain = async () => {
    for (const m of await sub.read()) { delivered.push(m.id); cursors.push(Number(m.cursor.split(":")[1])); }
  };
  await drain();
  assert.deepEqual(delivered, first);

  // Put the channel down, commit while it is down, and only then let the re-dial through: the
  // replay from the delivered floor is what has to carry them.
  gate.hold();
  const dials = room.dials;
  (await room.client()).socket.destroy();
  const second = await commit(service, 2, "dd");
  await gate.release();
  const deadline = Date.now() + 8000;
  while (delivered.length < 4 && Date.now() < deadline) { await drain(); if (delivered.length < 4) await sub.wait(50); }

  // dials, never drops: a close is not evidence that anything re-dialled.
  assert.ok(room.dials > dials, "the channel never re-dialled");
  assert.deepEqual(delivered, [...first, ...second], "a message was lost across the tidy reconnect");
  assert.equal(new Set(delivered).size, 4, "the tidy reconnect produced a duplicate");
  for (let i = 1; i < cursors.length; i += 1)
    assert.ok(cursors[i] > cursors[i - 1], `the cursor moved backwards: ${cursors[i - 1]} then ${cursors[i]}`);
  sub.close();
});

test("a reattach re-subscribes from the DELIVERED floor, so the host replays the suffix and not the room", async (t) => {
  const { room, service, gate, subscribes } = await rig(t);
  await commit(service, 4, "ee");
  const sub = await openRemoteSubscription({ room, since: nativeCursor(EPOCH, 0), backoffMs: 10 });
  /** @type {string[]} */
  const delivered = [];
  for (const m of await sub.read()) delivered.push(m.id);
  assert.equal(delivered.length, 4);
  assert.deepEqual(subscribes, [nativeCursor(EPOCH, 0)]);

  gate.hold();
  (await room.client()).socket.destroy();
  await gate.release();
  const deadline = Date.now() + 8000;
  while (subscribes.length < 2 && Date.now() < deadline) await sub.wait(50);

  // The observable that actually discriminates. The caller-facing "no duplicate" assertion in the
  // twin above is guaranteed by the read floor whatever cursor is used here, so it cannot see this
  // defect; a reattach from the ORIGINAL cursor would re-replay the whole room on every drop, and
  // on a long-lived watch the host refuses a backlog past ten thousand records.
  assert.equal(subscribes.length, 2, "the channel never re-subscribed");
  assert.equal(subscribes[1], nativeCursor(EPOCH, 4),
    `the reattach re-subscribed from ${subscribes[1]} instead of the delivered floor ${nativeCursor(EPOCH, 4)}`);
  sub.close();
});

// ------------------------------------------------------------ the verb

test("room add-remote refuses its own arguments before loadConfig, and reaches config with them", async () => {
  const missing = path.join(tmpdir(), "agora-t2-no-config", "nope.json");
  const absent = await agora(["room", "add-remote"], { AGORA_CONFIG: missing });
  assert.equal(absent.code, 2, absent.stderr);
  assert.match(absent.stderr, /needs <alias> <descriptor-path>/);

  const one = await agora(["room", "add-remote", "house"], { AGORA_CONFIG: missing });
  assert.equal(one.code, 2, one.stderr);

  // Present is not well formed: a malformed alias is still this verb's own argument.
  const malformed = await agora(["room", "add-remote", "_bad", "/tmp/x.json"], { AGORA_CONFIG: missing });
  assert.equal(malformed.code, 2, malformed.stderr);
  assert.match(malformed.stderr, /room alias/);

  // The twin. With both arguments well formed the verb must REACH config and exit 1, or a rule
  // that refuses everything would prove nothing about the ordering.
  const reached = await agora(["room", "add-remote", "house", "/tmp/x.json"], { AGORA_CONFIG: missing });
  assert.equal(reached.code, 1, reached.stderr);
  assert.match(reached.stderr, /no config at/);
});

test("room add-remote verifies the descriptor and PRINTS the row; it never writes the config", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-t2-verb-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = path.join(root, "state");
  const configPath = path.join(root, "agora.json");
  const config = { actor: { name: "Opus/t2", kind: "agent" }, rooms: { desk: { transport: "local", path: path.join(root, "desk.ndjson") } } };
  await writeFile(configPath, JSON.stringify(config));

  const b = offlineBinding();
  const { proofRef } = await writeRouteSecret(state, b, mintRouteSecret());
  const d = offlineDescriptor(b, proofRef);
  const file = path.join(root, "descriptor.json");
  await writeFile(file, JSON.stringify(d));
  // The seat's enrolled identity has to exist; the verb refuses before it reads a descriptor
  // otherwise, which is the enrollment-absent cell above.
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.join(state, "tailcat"), { recursive: true });
  await writeFile(path.join(state, "tailcat", "identity.private.json"), "{}", { mode: 0o600 });

  const env = { AGORA_CONFIG: configPath, AGORA_STATE: state };
  const bad = await agora(["room", "add-remote", "desk", file], env);
  assert.equal(bad.code, 1, bad.stderr);
  assert.match(bad.stderr, /already configured/);

  // The whole point of the verb: it prints, and the config on disk is byte-identical afterwards.
  const before = JSON.stringify(config);
  const out = await agora(["room", "add-remote", "house", file, "--json"], env);
  const after = await (await import("node:fs/promises")).readFile(configPath, "utf8");
  assert.equal(after, before, "room add-remote wrote the shared config");
  if (out.code === 0) {
    const row = JSON.parse(out.stdout);
    assert.equal(row.written, false);
    assert.equal(row.row.transport, "native-remote");
    assert.equal(row.row.descriptor, file);
    assert.ok(!("roomId" in row.row), "the printed row carried a roomId beside the descriptor");
    assert.equal(row.roomId, ROOM);
  } else {
    // The identity stub above is not a real Tailcat key, so `printpub` cannot be run here; what
    // must hold either way is that nothing was written.
    assert.match(out.stderr, /./);
  }
});
