// T2 remote client: the far half of native membership over Tailcat.
//
// The rig is the cut's: both halves in one process against two state roots, with the Tailcat child
// faked as a loopback duplex, so a green run proves the CLIENT half against T1's real host
// admission path and proves nothing about Tailcat's own `--allow` refusal or a live rendezvous —
// those are T3's, on two real machines. Every cell that claims a refusal asserts the NAMED reason.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
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
import { authorityFixtureService, approvedOpen, approvedClose } from './authority-fixture.mjs';
import { nativeRemoteTransport } from "../src/transports/native-remote.mjs";
import { ServiceDarkError } from "../src/wake/subscriber.mjs";
import { localTransferIdentity } from "../src/tailcat.mjs";
import { resolveTailcatBinary } from "../src/tailcat-runtime.mjs";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { AgoraError } from "../src/core.mjs";

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
 * @param {{ secret?: string, descriptor?: any, key?: string, deadTransport?: boolean, timeoutMs?: number, onSpawn?: (runtime: any) => void }} [over]
 */
async function rig(t, over = {}) {
  const hostRoot = await mkdtemp(path.join(tmpdir(), "agora-t2-host-"));
  const seatRoot = await mkdtemp(path.join(tmpdir(), "agora-t2-seat-"));
  t.after(() => rm(hostRoot, { recursive: true, force: true }));
  t.after(() => rm(seatRoot, { recursive: true, force: true }));
  const service = await authorityFixtureService({ root: hostRoot, accountId: HOST_ACCOUNT, seatLabel: "seat-a" },
    [{ roomId: ROOM, publicNodeKeys: [KEY, OTHER_KEY] }]);
  await service.start();
  await service.createRoom({ roomId: ROOM, epoch: EPOCH });
  t.after(() => service.stop());

  /** @type {((socket: any) => void) | undefined} */
  let accept;
  /** Latest accept hook, so a reopened route can be wired in a cell. @type {{ fn?: (socket:any)=>void }} */
  const hostAccept = {};
  const opened = await approvedOpen(service, {
    roomId: ROOM, publicNodeKey: KEY,
    routeOptions: {
      listen: async (/** @type {(socket: any) => void} */ hook) => { accept = hook; hostAccept.fn = hook; return { port: 4242, close: async () => {} }; },
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
    // A real route closes its listener when the scope aborts, so no socket arrives after a close.
    // This rig hands one to `accept` directly, and `accept` destroys a stream it will not take
    // before `ownStream` has attached an error handler — a fixture artifact, not a product path.
    hostSide.on("error", () => {});
    hostStreams.push(hostSide);
    const wire = () => /** @type {(socket: any) => void} */ (hostAccept.fn ?? accept)(hostSide);
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
      nodeKey: over.key ?? KEY, timeoutMs: over.timeoutMs ?? 4000,
      channelOptions: {
        spawn: async (/** @type {string[]} */ args, /** @type {any} */ runtime, /** @type {any} */ owner) => {
          spawned.push(args);
          over.onSpawn?.(runtime);
          if (args[0] === "parse") return fakeChild({ exit: 0, signal: owner?.signal });
          if (args[1] === "printpub") {
            const stdout = new PassThrough();
            const child = fakeChild({ exit: 0, stdout, signal: owner?.signal });
            stdout.end(`${over.key ?? KEY}\n`);
            return child;
          }
          // A transport child that ends because there is nothing to reach: the shape a dial takes
          // against a route that is no longer open.
          if (over.deadTransport) return fakeChild({ exit: 1, stdin: new PassThrough(), signal: owner?.signal });
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
  return { hostRoot, seatRoot, service, opened, secret, room, makeRoom, hostStreams, keyPath, gate, subscribes, spawned, hostAccept };
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
  // The REAL helper, on an empty root: the refusal has to be the helper's own, at the moment it
  // would otherwise mint, or the caller is doing check-then-use and the file can change between
  // the two observations.
  await assert.rejects(localTransferIdentity(root, { create: false }), /enrollment-absent/);
  await assert.rejects(stat(keyPath), /ENOENT/, "the no-create read minted an identity anyway");
  // And it creates NOTHING, the directory included. The helper made its private directory before
  // the refusal could fire, so a failed dial on an un-enrolled seat left an empty tailcat/ behind:
  // a side effect of a call whose whole point is to have none, and a directory a later reader would
  // take as evidence that enrolment had been attempted.
  assert.deepEqual(await readdir(root), [], "the no-create read left something behind in the state root");

  // And the caller passes it. One call, and the flag is what refuses.
  /** @type {any[]} */
  const calls = [];
  await assert.rejects(resolveSeatIdentity(root, { identity: /** @type {any} */ (async (/** @type {string} */ _r, /** @type {any} */ o) => { calls.push(o); throw new AgoraError("enrollment-absent: stub"); }) }),
    /enrollment-absent/);
  assert.equal(calls.length, 1, "the seat identity was observed more than once");
  assert.equal(calls[0]?.create, false, "the caller did not ask the helper to refuse rather than mint");
  await assert.rejects(stat(keyPath), /ENOENT/);
});

test("the no-create read runs the SAME ancestry check as the create path, and still creates nothing", async (t) => {
  // privateDirectory does two things: an ancestor walk refusing any symlinked or non-directory
  // ancestor, and the check on the directory itself. Replicating only the second made this read
  // weaker than the write it stands in for — the same state root refused on the create path and
  // accepted here, with the weaker answer on the path whose whole purpose is to touch nothing.
  const base = await mkdtemp(path.join(tmpdir(), "agora-t2-ancestry-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const real = path.join(base, "real");
  await mkdir(real, { recursive: true });
  let linked = true;
  try { await symlink(real, path.join(base, "link"), "junction"); }
  catch { linked = false; }
  if (linked) {
    await assert.rejects(localTransferIdentity(path.join(base, "link", "state"), { create: false }),
      /traverses a linked or non-directory path/);
    assert.deepEqual(await readdir(real), [], "the refused read created something behind the link");
  } else {
    t.diagnostic("this platform would not create a link, so the ancestry check is unmeasured here");
  }

  // The ordinary twin: an un-linked root is refused for ABSENCE, by its own name, not by ancestry.
  await assert.rejects(localTransferIdentity(path.join(base, "real", "state"), { create: false }), /enrollment-absent/);
});

test("a transport that ends before the greeting fails fast AND by name", async (t) => {
  // Measured rather than reasoned: a child that ends because there is nothing to reach fails the
  // dial in milliseconds, while a child that stays connected with nothing answering costs the whole
  // handshake timeout. The fast path was already there; what it could not do was say what happened,
  // because the route layer's cancellation message describes its own bookkeeping.
  const { room } = await rig(t, { deadTransport: true });
  const started = Date.now();
  await assert.rejects(room.client(), /member-channel-dark: the transport ended before the host greeted/);
  const elapsed = Date.now() - started;
  // The rig's handshake budget is 4000 ms; the point of the cell is that this does not wait for it.
  assert.ok(elapsed < 2000, `a dead transport took ${elapsed} ms to report, which is the timeout path`);
});

test("the runtime handed to the transport carries the state root the resolver needs", async (t) => {
  // Measured at the SPAWN BOUNDARY, because that is the only place this defect is visible: the
  // channel hands this object to spawnTailcat, which hands it to resolveTailcatBinary, which needs
  // a state root to find the capsule. A room that keeps the root as its own field and passes {}
  // downward reaches the resolver with nothing and dies inside the guardian with a textless status
  // — which is exactly what a live seat reported, and exactly what no faked child can see, since a
  // fake never reaches a resolver at all.
  const { room, seatRoot } = await rig(t);
  assert.equal(room.runtime.stateRoot, seatRoot, "the room's runtime carries no state root");

  /** @type {any[]} */
  const runtimes = [];
  const probe = await rig(t, { onSpawn: (/** @type {any} */ runtime) => runtimes.push(runtime) });
  await probe.room.client();
  assert.ok(runtimes.length > 0, "no spawn was observed");
  for (const runtime of runtimes)
    assert.equal(runtime?.stateRoot, probe.seatRoot,
      `a transport child was launched with ${JSON.stringify(runtime)}, which the binary resolver cannot use`);

  // Capture is not enough, and the reason is the one L1 paid for: a dead address does not fail the
  // launch, and the guardian's status reads the same for a bare root as for a real failure. So the
  // captured runtime is driven through the REAL resolver, which is what the channel would reach.
  const resolved = await resolveTailcatBinary(runtimes[0]);
  assert.ok(resolved.path.startsWith(probe.seatRoot),
    `the resolver placed the binary at ${resolved.path}, outside the remote's state root`);
  assert.match(resolved.sha256, /^[a-f0-9]{64}$/);
  assert.equal(createHash("sha256").update(await readFile(resolved.path)).digest("hex"), resolved.sha256,
    "the resolved binary does not match the digest the resolver verified it against");

  // The twin, and it is the defect itself: an empty runtime is REJECTED rather than resolving to
  // something, and it leaves nothing behind.
  // The cast is the finding in miniature: the resolver's own type DECLARES stateRoot required, and
  // the room reached it with {} only because the runtime travelled as `any` through the channel.
  await assert.rejects(resolveTailcatBinary(/** @type {any} */ ({})), /./, "an empty runtime resolved a binary anyway");

  // A caller's own runtime still wins on any key it sets, so the fold is not an override.
  const explicit = new RemoteRoom({ descriptor: probe.opened.descriptor, secret: probe.secret,
    stateRoot: probe.seatRoot, keyPath: probe.keyPath, nodeKey: KEY, runtime: { stateRoot: "/elsewhere" } });
  assert.equal(explicit.runtime.stateRoot, "/elsewhere");
  await explicit.close();
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
    requestId: "1".repeat(32), serverChallenge: "2".repeat(32), accountId: HOST_ACCOUNT, seatLabel: "seat-a", proof: "0".repeat(64) }));
  await assert.rejects(completeMemberHandshake({ stream, binding: b, secret, timeoutMs: 2000 }), /member-phase-refused/);
});

test("a host-answered admission refusal carries a code that survives rewording and channel close", async (t) => {
  const { hostAccept, opened, secret } = await rig(t);
  const toHost = new PassThrough();
  const toClient = new PassThrough();
  const hostSide = Duplex.from({ readable: toHost, writable: toClient });
  hostSide.on("error", () => {});
  const decoder = new NativeFrameDecoder();
  /** @type {any[]} */ const frames = [];
  toClient.on("data", (bytes) => frames.push(...decoder.push(bytes)));
  hostAccept.fn?.(hostSide);
  const deadline = Date.now() + 2000;
  while (frames.length < 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  const hello = frames.shift();
  assert.equal(hello?.type, "member-server-hello");
  toHost.write(encodeNativeFrame({ protocol: NATIVE_PROTOCOL, type: "member-client-hello",
    bootEpoch: hello.bootEpoch, requestId: hello.requestId, serverChallenge: hello.serverChallenge,
    clientChallenge: "3".repeat(32), proof: "0".repeat(64) }));
  while (frames.length < 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  const answered = frames.shift();
  assert.equal(answered?.type, "error");
  assert.equal(answered?.code, "member-proof-refused");

  // The message is deliberately unrelated to the code. The receiver's control property survives
  // this edit and the host ending the stream in the same admission turn.
  const clientInput = new PassThrough();
  const clientOutput = new PassThrough();
  const clientStream = Duplex.from({ readable: clientInput, writable: clientOutput });
  clientInput.write(encodeNativeFrame({ ...answered, message: "the host declined these credentials" }));
  clientInput.end();
  await assert.rejects(completeMemberHandshake({ stream: clientStream, binding: opened.descriptor.binding,
    secret, timeoutMs: 2000 }), error => /** @type {any} */(error).code === "member-proof-refused"
      && /declined these credentials/.test(String(error)));

  // A newer seat can meet an older host. Its uncoded frame keeps the old named prefix only at the
  // decoder, then becomes the same coded error every downstream classifier consumes.
  const oldInput = new PassThrough();
  const oldOutput = new PassThrough();
  const oldStream = Duplex.from({ readable: oldInput, writable: oldOutput });
  oldInput.write(encodeNativeFrame({ protocol: NATIVE_PROTOCOL, type: "error", reason: "member-hello-refused",
    requestId: "4".repeat(32), message: "member-room-refused: this older host declined the room" }));
  oldInput.end();
  await assert.rejects(completeMemberHandshake({ stream: oldStream, binding: opened.descriptor.binding,
    secret, timeoutMs: 2000 }), error => /** @type {any} */(error).code === "member-room-refused"
      && /older host declined/.test(String(error)));

  // The coded side is not restricted to member-* names: the host may answer with a terminal
  // route-level code, and rewording its message must not collapse it into member-hello-refused.
  const routeInput = new PassThrough();
  const routeOutput = new PassThrough();
  const routeStream = Duplex.from({ readable: routeInput, writable: routeOutput });
  routeInput.write(encodeNativeFrame({ protocol: NATIVE_PROTOCOL, type: "error", code: "route-not-open",
    reason: "request-refused", requestId: "5".repeat(32), message: "the host no longer has this route" }));
  routeInput.end();
  await assert.rejects(completeMemberHandshake({ stream: routeStream, binding: opened.descriptor.binding,
    secret, timeoutMs: 2000 }), error => /** @type {any} */(error).code === "route-not-open"
      && /no longer has this route/.test(String(error)));
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

/** A room whose channel is scripted, for the two cells about how a failure is CLASSIFIED. The
 * transport is not what is under test there; the classification is, so the socket is a real emitter
 * (the reattach is driven by its close event) and nothing else is.
 * @param {{ request?: (...a: any[]) => any, subscribe?: (...a: any[]) => any }} [script] */
function scriptedRoom(script = {}) {
  const socket = /** @type {any} */ (new EventEmitter());
  socket.destroyed = false;
  const client = {
    socket,
    request: script.request ?? (async () => ({ status: { epoch: EPOCH, committed: 0 } })),
    subscribe: script.subscribe ?? (async () => ({ messages: [] })),
  };
  return /** @type {any} */ ({
    binding: { roomId: ROOM, accountId: `m-${"d".repeat(32)}`, host: { id: HOST_ACCOUNT } },
    client: async () => client, close: async () => {}, drops: 0, dials: 1, socket, script,
  });
}

test("a malformed committed count is refused, not laundered into a full-room replay", async () => {
  // Number() lets 3.7 and -5 through, and Math.max(0, committed - window) turns either into the
  // valid cursor 0: a full replay of the room reported as if no history had been skipped. A count
  // that is not a non-negative safe integer is refused instead.
  for (const bad of [3.7, -5, "12", null, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
    const room = scriptedRoom({ request: async () => ({ status: { epoch: EPOCH, committed: bad } }) });
    await assert.rejects(openRemoteSubscription({ room }), /committed count/,
      `a committed count of ${JSON.stringify(bad)} was accepted`);
  }
  // And the ordinary value still works, or strictness bought by refusing the normal case is no win.
  const ok = scriptedRoom({ request: async () => ({ status: { epoch: EPOCH, committed: 4 } }) });
  const sub = await openRemoteSubscription({ room: ok });
  assert.equal(sub.neverOffered, null);
  sub.close();
});

test("a refusal the host ANSWERED reports itself once; only an unanswered dial is darkness", async () => {
  let subscribes = 0;
  const room = scriptedRoom({
    subscribe: async () => {
      subscribes += 1;
      if (subscribes === 1) return { messages: [] };
      // Answered on a LIVE socket: the host refused this cursor, and that is the cause a reader
      // needs. Retrying it maxReconnects times and then reporting "could not be re-dialled" would
      // replace a precise cause with a false one, which is worse than either alone.
      // Deliberately NOT one of the named refusals: a message that matches NAMED_REFUSAL would be
      // caught by that guard instead, and this cell would pass with the live-socket check deleted.
      // What defines an answered refusal is that a live socket carried it, not its wording.
      throw new AgoraError("the host declined this subscription for reasons of its own");
    },
  });
  const sub = await openRemoteSubscription({ room, since: nativeCursor(EPOCH, 0), backoffMs: 5, maxReconnects: 5 });
  assert.equal(subscribes, 1);

  room.socket.emit("close");                    // the drop the subscription reattaches on
  const deadline = Date.now() + 4000;
  while (subscribes < 2 && Date.now() < deadline) await sub.wait(20);

  // The three discriminating assertions. Without the classification the error would be the dark
  // one, the message would say could-not-be-re-dialled, and subscribes would be 6 rather than 2.
  await assert.rejects(sub.read(), /declined this subscription/);
  await assert.rejects(sub.read(), (e) => !/could not be re-dialled/.test(String(e && /** @type {any} */ (e).message)));
  assert.equal(subscribes, 2, `an answered refusal was retried: ${subscribes - 1} attempt(s)`);
  assert.equal(sub.dark(), undefined, "an answered refusal was reported as darkness");
  sub.close();
});

// --------------------------------------- the three silent numbers the freeze claimed and did not carry

test("whoami MEASURES the channel; it does not answer from the descriptor", async (t) => {
  const { room } = await rig(t);
  const actor = /** @type {any} */ ({ name: "Opus/t2", kind: "agent" });
  const live = nativeRemoteTransport(/** @type {any} */ ({ transport: "native-remote" }), { actor, remote: room });
  assert.deepEqual(await live.whoami(), { id: room.binding.accountId, name: "Opus/t2" });

  // The discriminating half. Everything whoami needs for its ANSWER is in the descriptor, so a
  // whoami that read it would resolve here and doctor's row would report a live identity for a
  // route that cannot be opened at all. It must reject instead.
  const dark = nativeRemoteTransport(/** @type {any} */ ({ transport: "native-remote" }), {
    actor,
    remote: /** @type {any} */ ({
      binding: room.binding,
      client: async () => { throw new AgoraError("member-channel-dark: the host is not answering"); },
      close: async () => {},
    }),
  });
  await assert.rejects(dark.whoami(), /member-channel-dark/,
    "whoami answered for a channel that cannot open");
});

test("a dark channel throws rather than returning an empty read that looks like a quiet room", async () => {
  let dials = 0;
  const room = scriptedRoom();
  const sub = await openRemoteSubscription({ room, since: nativeCursor(EPOCH, 0), backoffMs: 5, maxReconnects: 2 });
  // Every re-dial from here fails the way an unreachable host does: unnamed, so it is retried and
  // then reported as darkness.
  room.client = async () => { dials += 1; throw new AgoraError("member-channel-dark: the host is not answering"); };
  room.socket.emit("close");
  const deadline = Date.now() + 4000;
  while (dials < 2 && Date.now() < deadline) await sub.wait(20);

  // The whole point: [] reads as a quiet room and exits 0, and this room was not quiet, it was
  // unreachable. It must throw, and it must throw the dark error, so the watch ends with
  // service-dark and exit 1.
  await assert.rejects(sub.read(), (e) => e instanceof ServiceDarkError);
  await assert.rejects(sub.read(), /could not be re-dialled/);
  assert.match(String(sub.dark()), /could not be re-dialled/);
  sub.close();
});

test("a NAMED refusal on a re-dial is not retried: one attempt, and it reports itself", async () => {
  let dials = 0;
  const room = scriptedRoom();
  const sub = await openRemoteSubscription({ room, since: nativeCursor(EPOCH, 0), backoffMs: 5, maxReconnects: 5 });
  // Revocation looks like this from the far side: the secret is gone on the host, so the hello is
  // refused by name. It is a fact, not a flaky connection.
  room.client = async () => { dials += 1; throw Object.assign(new AgoraError("the host declined this route after its wording changed"), { code: "member-host-proof-refused" }); };
  room.socket.emit("close");
  const deadline = Date.now() + 4000;
  while (dials < 1 && Date.now() < deadline) await sub.wait(20);
  await sub.wait(120);

  assert.equal(dials, 1, `a named refusal was retried: ${dials} dial(s), each spawning a Tailcat child to be told the same thing`);
  await assert.rejects(sub.read(), /wording changed/);
  assert.equal(sub.dark(), undefined, "a named refusal was reported as darkness");
  sub.close();
});

test("a client held across a route close fails by name on the next verb, and the re-dial does too", async (t) => {
  const { room, service, opened, hostAccept } = await rig(t);
  const held = await room.client();
  assert.ok((await held.request("status", { roomId: ROOM })).status, "the route was not usable before the close");

  await approvedClose(service, { roomId: ROOM, publicNodeKey: KEY });

  // The held client must not answer a verb for a revoked route out of a socket that still looks
  // live. Measured, not assumed: the shared request machine refuses because the socket is gone.
  await assert.rejects(held.request("status", { roomId: ROOM }), /dark; request was not sent/);

  // The next dial: close tears down the LISTENER as well as the secret, so nothing on the host is
  // left to refuse the handshake and the remote learns of revocation as an unreachable route. That
  // is a named end (member-channel-dark), not a proof refusal, and the docs say so in those words
  // because a reader who knows the secret was rotated would expect the other one.
  await assert.rejects(room.client(), /member-channel-dark/);

  // Reopened: a new grant and a new generation, the remote still holding the old descriptor. The
  // binding comparison fires BEFORE the proof, so this is a binding mismatch and not a stale-secret
  // proof failure either. Pinned because the obvious expectation is wrong in both directions.
  await approvedOpen(service, {
    roomId: ROOM, publicNodeKey: KEY,
    routeOptions: {
      listen: async (/** @type {(socket:any)=>void} */ hook) => { hostAccept.fn = hook; return { port: 4243, close: async () => {} }; },
      spawn: async (/** @type {string[]} */ args, /** @type {any} */ _r, /** @type {any} */ owner) =>
        fakeChild({ exit: args[0] === "parse" ? 0 : null, signal: owner?.signal }),
      address: async () => ADDRESS,
    },
  });
  await assert.rejects(room.client(), /member-binding-mismatch/);
  // The revocation is real on disk, which is what makes the two rejections above mean revocation
  // rather than a flaky socket.
  const { readRouteSecret } = await import("../src/native-member.mjs");
  await assert.rejects(readRouteSecret(/** @type {any} */ (room).stateRoot, opened.descriptor.binding, opened.descriptor.proofRef), /./);
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

// --------------------------------------- transport lifetime: the verb that succeeded must end

test("close() releases the channel: the room is closed and the next verb refuses by name", async (t) => {
  const { room } = await rig(t);
  const actor = /** @type {any} */ ({ name: "Opus/t2", kind: "agent" });
  const transport = nativeRemoteTransport(/** @type {any} */ ({ transport: "native-remote" }), { actor, remote: room });
  assert.deepEqual(await transport.whoami(), { id: room.binding.accountId, name: "Opus/t2" });
  assert.equal(typeof transport.close, "function", "a transport that owns a child process has no close");
  await transport.close?.();
  await assert.rejects(transport.read(), /member-channel-dark/,
    "the channel was still usable after close, so nothing was released");
});

test("close() is idempotent, survives a never-dialled room, and never fails the verb that succeeded", async (t) => {
  const { room } = await rig(t);
  const actor = /** @type {any} */ ({ name: "Opus/t2", kind: "agent" });
  const never = nativeRemoteTransport(/** @type {any} */ ({ transport: "native-remote" }), { actor, remote: room });
  // Asserted rather than reached through `?.`: optional chaining makes an ABSENT close pass every
  // line below it, which is a cell that cannot see the defect it was written for.
  assert.equal(typeof never.close, "function");
  await never.close?.();
  await never.close?.();

  // The one that matters for the drain: it runs AFTER the exit code is settled and the answer is
  // printed, so a teardown that throws would turn a verb that worked into a verb that failed with
  // nowhere left to report it.
  const angry = nativeRemoteTransport(/** @type {any} */ ({ transport: "native-remote" }), {
    actor,
    remote: /** @type {any} */ ({ binding: room.binding, close: async () => { throw new Error("teardown exploded"); } }),
  });
  assert.equal(typeof angry.close, "function");
  await angry.close?.();
});

test("a transport that owns a handle lets the process EXIT once it is closed, and holds it open otherwise", async () => {
  // Asserts EXIT, not output: the defect this cell exists for printed every row correctly and then
  // sat until SIGKILL. A `setInterval` stands in for the Tailcat child's stdio pipes — any
  // referenced handle keeps Node's loop alive, and the transport's close is what releases it.
  const dir = await mkdtemp(path.join(tmpdir(), "agora-lifetime-"));
  const script = (/** @type {boolean} */ close) => `
    import { nativeRemoteTransport } from ${JSON.stringify(new URL("../src/transports/native-remote.mjs", import.meta.url).href)};
    const handle = setInterval(() => {}, 1000);
    const transport = nativeRemoteTransport({ transport: "native-remote" }, {
      actor: { name: "Opus/t2", kind: "agent" },
      remote: { binding: { roomId: "r" }, close: async () => clearInterval(handle) },
    });
    console.log("work done");
    ${close ? "await transport.close();" : ""}
  `;
  const closing = path.join(dir, "closing.mjs");
  const holding = path.join(dir, "holding.mjs");
  await writeFile(closing, script(true));
  await writeFile(holding, script(false));

  const run = promisify(execFile);
  const { stdout } = await run(process.execPath, [closing], { timeout: 10000 });
  assert.match(stdout, /work done/, "the arm did not reach the end of its work");

  await assert.rejects(
    run(process.execPath, [holding], { timeout: 3000 }),
    (/** @type {any} */ e) => e.killed === true,
    "the twin exited without its close, so this cell cannot see the defect it is here for",
  );
  await rm(dir, { recursive: true, force: true });
});

test("the handshake's dark refusal fires in a process holding NO other handle", async () => {
  // The rig condition IS the test: a `PassThrough` is not a referenced handle, so this child has
  // nothing keeping Node's loop alive except the handshake timer itself. That is the case an
  // unref'd timer loses — and it is invisible from the CLI, where the Tailcat child's stdio pipes
  // hold the loop and the bound therefore appears to work. Measured on the previous head: the
  // child exited in 1 ms with code 13 ("unsettled top-level await") and no message at all.
  // A bound that fires only while something else is alive is not a bound.
  const dir = await mkdtemp(path.join(tmpdir(), "agora-dark-"));
  const probe = path.join(dir, "probe.mjs");
  await writeFile(probe, `
    import { PassThrough } from "node:stream";
    import { completeMemberHandshake } from ${JSON.stringify(new URL("../src/native-remote.mjs", import.meta.url).href)};
    const started = Date.now();
    // A peer that is connected and silent: the shape that costs the whole budget, as opposed to a
    // dead transport, which fails the dial in milliseconds.
    try {
      await completeMemberHandshake({ stream: new PassThrough(), binding: { accountId: "m-x" },
        secret: "s", timeoutMs: 600 });
      console.log("RESOLVED");
    } catch (e) {
      console.log(JSON.stringify({ elapsed: Date.now() - started, message: String(e.message) }));
    }
  `);
  const run = promisify(execFile);
  const { stdout } = await run(process.execPath, [probe], { timeout: 15000 });
  const seen = JSON.parse(stdout.trim());
  assert.match(seen.message, /member-channel-dark/,
    "a silent peer produced no named refusal, so the channel went dark without saying so");
  assert.ok(seen.elapsed >= 550,
    `the refusal arrived after ${seen.elapsed} ms, which is short of the bound it claims to enforce`);
  await rm(dir, { recursive: true, force: true });
});

test("the runtime hop is CHECKED: an assembly without a state root does not compile", async (t) => {
  // This cell's real assertions are the three `@ts-expect-error` directives, and they are graded by
  // `npm run check`, not by the runner: tsc fails when a directive stops being needed. So if anyone
  // widens these hops back to `any`, this cell goes red for exactly the reason it exists — which is
  // the one shape a runtime assertion cannot express, because the defect it guards produced NO bad
  // value in this process. It killed a child on a live machine and returned a status with no text.
  const { room, seatRoot } = await rig(t);

  /** The exported option type is what makes the requirement sayable, so it is gated first: an
   * assembly missing the state root is refused where it is WRITTEN.
   * @type {import("../src/tailcat-runtime.mjs").TailcatRuntimeOptions} */
  // @ts-expect-error a runtime without a state root is not a runtime the resolver can use.
  const rootless = { vendorDir: "/tmp/vendor" };
  void rootless;

  // The field itself, which is the hop L2 fell through: this compiles only because `room.runtime`
  // IS the resolver's option type. Widen it back to `any` and this line still passes, which is why
  // the directives above and below carry the negative half.
  void (() => resolveTailcatBinary(room.runtime));

  // @ts-expect-error the constructor's overrides are the resolver's surface, so a key the resolver
  // does not have is refused at the hop instead of travelling as a silent no-op.
  // (the offending key rides the FIRST line: `@ts-expect-error` suppresses the next line only, so a
  // call wrapped across three lines reports from a line the directive never covered.)
  void (() => new RemoteRoom({ runtime: { notAResolverKey: 1 }, descriptor: room.descriptor,
    secret: "x", stateRoot: seatRoot, keyPath: room.keyPath, nodeKey: KEY }));

  // @ts-expect-error and the same hop on the resolver entry point callers actually use.
  void (() => openRemoteRoom({ descriptorPath: "/nowhere", stateRoot: seatRoot, runtime: { notAResolverKey: 1 } }));

  // The positive control, so the type is not merely refusing everything: the documented override
  // still compiles AND still wins at runtime, which is the contract an earlier draft of this head
  // broke by omitting `stateRoot` from the overrides type.
  const explicit = new RemoteRoom({ descriptor: room.descriptor, secret: "x", stateRoot: seatRoot,
    keyPath: room.keyPath, nodeKey: KEY, runtime: { stateRoot: "/elsewhere", vendorDir: "/tmp/vendor" } });
  assert.equal(explicit.runtime.stateRoot, "/elsewhere");
  assert.equal(explicit.runtime.vendorDir, "/tmp/vendor");
  await explicit.close();
});

test("the typed hop catches an OMITTED root and not an undefined one, which is pinned here on purpose", async () => {
  // A known edge, kept where the next reader will meet it. Under this tsconfig (strict, no
  // `exactOptionalPropertyTypes`) an optional property admits an explicit `undefined`, so the three
  // lines below type-check while the third one is false at runtime. Found by a reviewer against my
  // own unqualified claim that the annotation makes a rootless assembly a compile error.
  //
  // Deliberately DIRECTIVE-FREE: a `@ts-expect-error` here would assert the gap is closed and go
  // red the moment it is, which reads as a passing gate for the wrong reason. These annotations
  // instead become tsc errors if anyone enables `exactOptionalPropertyTypes` — so whoever closes
  // the gap is sent to this cell and to the typedef's paragraph, and updates both.
  /** @type {import("../src/tailcat-runtime.mjs").TailcatRuntimeOverrides} */
  const sneaky = { stateRoot: undefined, vendorDir: "/tmp/vendor" };
  /** @type {import("../src/tailcat-runtime.mjs").TailcatRuntimeOptions} */
  const folded = { stateRoot: "/seat", ...sneaky };

  assert.equal(folded.stateRoot, undefined,
    "the gap has closed: an explicit undefined no longer survives the fold, so update the typedef's paragraph and delete this cell");
  assert.equal(typeof folded.stateRoot, "undefined");
  // The sharper half: the key EXISTS, so a defensive `in` or `hasOwn` guard passes while the value
  // is missing. A runtime check against this hop has to test the value, never the key.
  assert.equal(Object.hasOwn(folded, "stateRoot"), true);

  // WHAT THE BACKSTOP ACTUALLY DOES, measured, because a reviewer asked that this cell not leave
  // "the resolver refuses cleanly" behind as a property we have. It does not. With the root
  // undefined it dies in `path.join` with a raw TypeError that names no state root, no Agora
  // concept and no remedy:
  await assert.rejects(resolveTailcatBinary({ stateRoot: folded.stateRoot }),
    (/** @type {any} */ e) => e instanceof TypeError && /paths\[0\].*must be of type string/.test(e.message),
    "the resolver's refusal for an undefined root has changed shape; re-read it before trusting the sentence above");

  // And the sharper half, which is why this probe deliberately drops `vendorDir`. An earlier draft
  // of this very cell passed `folded` whole, and the extra key made the resolver fail EARLIER, on
  // the vendor lock, with a confident AgoraError telling the operator to "Pull the complete Agora
  // checkout" — a clean-looking refusal for a cause that is not the defect. The cell went green for
  // a reason unrelated to the root it claims to be about, which is the same complementary-mutation
  // failure the reader used on my directives, arriving in my own assertion. Both shapes recorded so
  // neither reads as a guarantee:
  await assert.rejects(resolveTailcatBinary({ stateRoot: folded.stateRoot, vendorDir: "/tmp/vendor" }),
    (/** @type {any} */ e) => e instanceof AgoraError && /runtime lock is missing or invalid/.test(e.message),
    "the misleading-refusal path has changed; the comment above is now wrong");
});

// --------------------------------------- L7: a swallowed teardown must reach somebody

test("a swallowed close failure is RECORDED, the verb is unaffected, and absence means clean", async (t) => {
  const { room } = await rig(t);
  const actor = /** @type {any} */ ({ name: "Opus/t2", kind: "agent" });

  // The ordinary path first, because the value of the field is that it stays ABSENT: a counter
  // reading 0 cannot distinguish "nothing failed" from "something failed and said nothing", which
  // is the defect one layer up that this unit exists to not repeat.
  const clean = nativeRemoteTransport(/** @type {any} */ ({ transport: "native-remote" }), { actor, remote: room });
  await clean.whoami();
  await clean.close?.();
  assert.equal(clean.closeFailed, undefined, "a clean close reported a failure");

  // Driven to 1, which is the requirement a reviewer put on the record before this head existed.
  const angry = nativeRemoteTransport(/** @type {any} */ ({ transport: "native-remote" }), {
    actor,
    remote: /** @type {any} */ ({ binding: room.binding, close: async () => { throw new Error("teardown exploded"); } }),
  });
  await angry.close?.();
  assert.match(String(angry.closeFailed), /teardown exploded/,
    "a swallowed teardown failure reached nobody, which is the leak with no witness");

  // Still never throws: this runs after the answer is printed, and failing the verb it followed
  // would be worse than the leak it reports.
  await assert.doesNotReject(() => /** @type {any} */ (angry).close());
});

test("cleanup-pending is named as ITSELF, not counted as a failure", async (t) => {
  const { room } = await rig(t);
  const actor = /** @type {any} */ ({ name: "Opus/t2", kind: "agent" });
  const pending = Object.assign(new Error("Native route cleanup is pending; retain closed and the resource handle."),
    { code: "AGORA_CLEANUP_PENDING", cleanupPending: true });
  const t2 = nativeRemoteTransport(/** @type {any} */ ({ transport: "native-remote" }), {
    actor, remote: /** @type {any} */ ({ binding: room.binding, close: async () => { throw pending; } }),
  });
  await t2.close?.();
  // A documented state with its own 10 s budget. Reported, and reported as what it is: a surface
  // that calls the expected case a failure teaches operators to ignore the surface, which is how
  // the unexpected one gets missed.
  assert.match(String(t2.closeFailed), /cleanup is still pending/);
});

test("rewording a refusal does not make it retryable: the CODE decides, not the prose", async () => {
  // The defect this replaces: the terminal check ran a regex over the message, so the wording was
  // load-bearing. A reworded refusal became retryable, got re-dialled five times — five Tailcat
  // children told the same thing — and was then reported as darkness, replacing a precise cause
  // with a false one.
  for (const [label, error] of [
    // The message deliberately does NOT contain the code. An earlier draft of this cell used
    // "member-hello-refused: reworded detail", which a prose-keyed check matches just as well —
    // a case that cannot discriminate, caught by mutation rather than by reading it.
    ["a local refusal whose message no longer carries its name", Object.assign(new Error("the host greeted this seat with something unexpected"), { code: "member-hello-refused" })],
    ["a host-answered refusal whose prose does not carry its name", Object.assign(new AgoraError("the host declined this request"), { code: "member-request-refused" })],
  ]) {
    let dials = 0;
    const room = scriptedRoom();
    const sub = await openRemoteSubscription({ room, since: nativeCursor(EPOCH, 0), backoffMs: 5, maxReconnects: 5 });
    room.client = async () => { dials += 1; throw error; };
    room.socket.emit("close");
    const deadline = Date.now() + 3000;
    while (dials < 1 && Date.now() < deadline) await sub.wait(20);
    await sub.wait(120);
    assert.equal(dials, 1, `${label}: retried ${dials} time(s); a terminal answer must be re-dialled zero more times`);
    await assert.rejects(sub.read(), /something unexpected|declined this request/, `${label}: the precise cause was replaced`);
    sub.close();
  }
});

test("a FAILING close still lets the process exit, which is the risk this surface introduces", async () => {
  // Adding a report to a teardown path is exactly where an unsettled await gets introduced, and
  // the failure would look like L3's original defect returning: every row printed, nothing exits.
  // Asserts EXIT, not output, in a child whose only handle is the one the close releases.
  const dir = await mkdtemp(path.join(tmpdir(), "agora-l7-"));
  const probe = path.join(dir, "probe.mjs");
  await writeFile(probe, `
    import { nativeRemoteTransport } from ${JSON.stringify(new URL("../src/transports/native-remote.mjs", import.meta.url).href)};
    const handle = setInterval(() => {}, 1000);
    const transport = nativeRemoteTransport({ transport: "native-remote" }, {
      actor: { name: "Opus/t2", kind: "agent" },
      remote: { binding: { roomId: "r" }, close: async () => { clearInterval(handle); throw new Error("teardown exploded"); } },
    });
    await transport.close();
    console.log(JSON.stringify({ recorded: transport.closeFailed }));
  `);
  const { stdout } = await promisify(execFile)(process.execPath, [probe], { timeout: 10000 });
  assert.match(JSON.parse(stdout.trim()).recorded, /teardown exploded/,
    "the child exited but recorded nothing, so the surface is not carrying the failure");
  await rm(dir, { recursive: true, force: true });
});

// ------------------- L9a: a channel that stops carrying without closing its socket

test("a silent dead channel is NOTICED and reported by name, with no socket close to trigger it", async (t) => {
  // The reproduction the investigation asked for. Before the idle clock, the only liveness signal
  // was `socket.once("close")`, so this exact shape — a relayed channel that stops carrying while
  // the socket stays open — left the watch alive, the cursor frozen and nothing reported. The cell
  // asserts the socket never closes, so it cannot pass through the old path by accident.
  let carrying = true;
  let redials = 0;
  const room = scriptedRoom({
    request: async () => {
      if (!carrying) throw new AgoraError("member-channel-dark: the host is not answering");
      return { status: { epoch: EPOCH, committed: 0 } };
    },
  });
  let closes = 0;
  room.socket.on("close", () => { closes += 1; });

  const sub = await openRemoteSubscription({ room, since: nativeCursor(EPOCH, 0),
    idleMs: 120, backoffMs: 5, maxReconnects: 2 });
  // Closes even when an assertion throws: the idle clock is REF'd, so an unclosed subscription
  // holds the RUNNER open and a failing cell hangs instead of reporting. Measured while calibrating
  // this file's own mutant, which timed out at 280 s rather than going red in a second.
  t.after(() => sub.close());

  // The channel stops carrying. No close, no error event, no exit — exactly what was measured.
  carrying = false;
  room.client = async () => { redials += 1; throw new AgoraError("member-channel-dark: the host is not answering"); };

  const deadline = Date.now() + 5000;
  while (sub.dark() === undefined && Date.now() < deadline) await sub.wait(20);

  assert.equal(closes, 0, "the socket closed, so this cell did not exercise the silent path it exists for");
  assert.ok(redials > 0, "nothing re-dialled: the idle clock never noticed the channel had stopped carrying");
  assert.match(String(sub.dark()), /could not be re-dialled/,
    "the subscription stayed silent instead of reporting darkness by name");
  await assert.rejects(sub.read(), (e) => e instanceof ServiceDarkError);
});

test("the idle clock stays out of the way while the channel carries", async (t) => {
  // The other half, and the one that keeps the first from being satisfied by a probe that fires
  // constantly: a live channel must not be re-dialled, and a probe answered is not activity the
  // consumer sees.
  let redials = 0;
  let probesSeen = 0;
  // Counted at CONSTRUCTION: scriptedRoom binds `script.request` into the client when it is built,
  // so assigning room.script.request afterwards is inert — a counter that would have read zero
  // forever while looking like a measurement.
  const room = scriptedRoom({ request: async () => { probesSeen += 1; return { status: { epoch: EPOCH, committed: 0 } }; } });
  // idleMs 500 -> the clock ticks every 250 ms, so the window below contains SEVERAL probes that
  // actually fire. An earlier draft used idleMs 60 against a 1 s interval floor and observed ZERO
  // probes in 400 ms: it asserted nothing at all about the clock while reading as though it did.
  // A second reader caught that; it is the third cell-that-cannot-fail in this file and
  // the comment stays so the next reader sizes the window against the interval, not against taste.
  let probes = 0;
  const sub = await openRemoteSubscription({ room, since: nativeCursor(EPOCH, 0),
    idleMs: 500, backoffMs: 5, maxReconnects: 2 });
  // Closes even when an assertion throws: the idle clock is REF'd, so an unclosed subscription
  // holds the RUNNER open and a failing cell hangs instead of reporting. Measured while calibrating
  // this file's own mutant, which timed out at 280 s rather than going red in a second.
  t.after(() => sub.close());
  // Overridden AFTER the subscription is open: the first draft armed this before the initial dial
  // and the cell failed on its own fixture rather than on the code, which is the fixture-reaches-an-
  // earlier-guard shape this file already carries an instance of.
  room.client = async () => { redials += 1; throw new Error("a live channel must not be re-dialled"); };

  // Several idle windows with the channel answering normally.
  await sub.wait(1600);
  assert.ok(probesSeen >= 1, "no probe fired in the window, so this cell asserts nothing about the clock");
  assert.equal(redials, 0, `a healthy channel was re-dialled ${redials} time(s)`);
  assert.equal(sub.dark(), undefined, "a healthy channel was reported dark");
});

test("the idle clock is REF'd: a process holding nothing else still reports the dead channel", async () => {
  // Written because the in-process cells above cannot see this. Mutating the timer to `unref()`
  // leaves all of them green — a test process is full of referenced handles, so the timer always
  // fires under `node --test`. The only rig that discriminates is a child whose sole possible
  // handle is the clock itself, which is the same shape L7 needed for the handshake timer and the
  // reason knowledge/dev-gotchas/a-timeout-that-only-fires-while-another-handle-lives-is-not-a-bound
  // says an ordinary cell cannot gate it.
  const dir = await mkdtemp(path.join(tmpdir(), "agora-l9a-"));
  const probe = path.join(dir, "probe.mjs");
  await writeFile(probe, `
    import { EventEmitter } from "node:events";
    import { openRemoteSubscription } from ${JSON.stringify(new URL("../src/native-remote.mjs", import.meta.url).href)};
    const socket = new EventEmitter();          // NOT a real handle: nothing here holds the loop
    socket.destroyed = false;
    let carrying = true;
    const client = { socket,
      request: async () => { if (!carrying) throw Object.assign(new Error("member-channel-dark: gone"), { code: "member-channel-dark" }); return { status: { epoch: "${"e".repeat(32)}", committed: 0 } }; },
      subscribe: async () => ({ messages: [] }) };
    const room = { binding: { roomId: "${"b".repeat(32)}", accountId: "m-x", host: { id: "h" } },
      client: async () => client, close: async () => {} };
    const sub = await openRemoteSubscription({ room, since: "${"e".repeat(32)}:0",
      idleMs: 120, backoffMs: 5, maxReconnects: 1 });
    carrying = false;
    room.client = async () => { throw Object.assign(new Error("member-channel-dark: gone"), { code: "member-channel-dark" }); };
    // NO polling loop, deliberately: sub.wait() arms a setTimeout, which is itself a referenced
    // handle, and an earlier draft of this cell used one — so the child stayed alive on ITS OWN
    // timer and the unref mutant passed. The rig has to hold nothing. With the clock ref'd the
    // process lives until the probe fires, reattach fails, darkness is set and stopClock() releases
    // the loop, so it exits reporting the reason; with it unref'd there is nothing to hold the loop
    // at all and the process exits at once, reporting null.
    process.on("exit", () => console.log(JSON.stringify({ dark: sub.dark() ?? null })));
  `);
  const { stdout } = await promisify(execFile)(process.execPath, [probe], { timeout: 15000 });
  const seen = JSON.parse(stdout.trim());
  assert.match(String(seen.dark), /could not be re-dialled/,
    "the child exited or stayed silent instead of reporting the dead channel: the clock is not holding the loop");
  await rm(dir, { recursive: true, force: true });
});

test("an obsolete probe's late failure does not re-subscribe the healthy channel that replaced it", async (t) => {
  // Bruno/reader's HOLD on 484b62a, reproduced here with promises rather than timing so the
  // ordering is forced, not raced: the old probe is pending, its socket closes, the close path
  // attaches a healthy replacement, and only THEN does the old probe reject. Before the identity
  // fence, `reattaching` was already false again by that point, so the stale failure dialled and
  // subscribed a third time on a channel that was fine — actual 3/3 where 2/2 is owed.
  let calls = 0, subscriptions = 0;
  /** @type {(e: unknown) => void} */ let rejectProbe = () => {};
  const probeHeld = new Promise((_, reject) => { rejectProbe = reject; });

  const makeClient = (/** @type {boolean} */ holds) => {
    const socket = /** @type {any} */ (new EventEmitter());
    socket.destroyed = false;
    return {
      socket,
      // The FIRST client's status hangs until this cell rejects it; the replacement answers.
      request: async () => (holds ? probeHeld : { status: { epoch: EPOCH, committed: 0 } }),
      subscribe: async () => { subscriptions += 1; return { messages: [] }; },
    };
  };
  const first = makeClient(true);
  const second = makeClient(false);

  const room = /** @type {any} */ ({
    binding: { roomId: ROOM, accountId: `m-${"d".repeat(32)}`, host: { id: HOST_ACCOUNT } },
    client: async () => { calls += 1; return calls === 1 ? first : second; },
    close: async () => {},
  });

  const sub = await openRemoteSubscription({ room, since: nativeCursor(EPOCH, 0),
    idleMs: 60, backoffMs: 5, maxReconnects: 3 });
  // Closes even when an assertion throws: the idle clock is REF'd, so an unclosed subscription
  // holds the RUNNER open and a failing cell hangs instead of reporting. Measured while calibrating
  // this file's own mutant, which timed out at 280 s rather than going red in a second.
  t.after(() => sub.close());
  assert.equal(calls, 1);
  assert.equal(subscriptions, 1);

  // 1. let the clock fire so the probe is in flight on `first`, and hangs
  const started = Date.now();
  while (Date.now() - started < 400) await sub.wait(20);

  // 2. the old socket closes: the existing close path attaches the healthy replacement
  first.socket.emit("close");
  const dialled = Date.now();
  // Wait on the LAST step of the replacement, not the first. An earlier draft waited for `calls`
  // to reach 2 and then asserted `subscriptions` in the same breath — but the dial resolves before
  // the subscribe runs, so the cell read a half-finished reattach and failed on its own timing.
  // Waiting on the dial and asserting the subscribe is two different moments treated as one.
  while (subscriptions < 2 && Date.now() - dialled < 2000) await sub.wait(10);
  assert.equal(calls, 2, "the close path did not attach a replacement");
  assert.equal(subscriptions, 2, "the replacement did not subscribe");

  // 3. NOW the obsolete probe rejects, against a channel that is already healthy
  rejectProbe(new AgoraError("member-channel-dark: the host is not answering"));
  await sub.wait(300);

  assert.equal(calls, 2, `an obsolete probe re-dialled: ${calls} dial(s) where 2 are owed`);
  assert.equal(subscriptions, 2, `an obsolete probe re-subscribed the healthy channel: ${subscriptions} subscribes where 2 are owed`);
  assert.equal(sub.dark(), undefined, "a healthy channel was reported dark by a stale probe");
});

test("a probe failure invalidates the REAL cached client, so the reattach dials instead of re-subscribing a corpse", async (t) => {
  // A second reader's measured HOLD on the first repair, rebuilt on the real rig:
  // a real RemoteRoom and a real NativeServiceClient, no substituted `room.client`. The channel is
  // made silent WITHOUT closing — the host stream stops reading — which is the only case that
  // reaches the cache, since a close would clear it.
  //
  // Measured before the fix: dials 1, subscribes 2, same cached client, socket.destroyed false,
  // dark null, and `read()` throwing an uncoded request timeout. The "reconnect" re-subscribed the
  // connection that had just failed its probe.
  const { room, hostStreams } = await rig(t, { timeoutMs: 80 });
  const sub = await openRemoteSubscription({ room, since: nativeCursor(EPOCH, 0),
    idleMs: 50, backoffMs: 5, maxReconnects: 2 });
  t.after(() => sub.close());

  const before = room.dials;
  const first = await room.client();

  // Silent-open: the host holds the stream and answers nothing. No close, no destroy.
  hostStreams[0].pause();
  // Snapshotted HERE, not after the wait: the repair itself closes the failed client, so reading
  // `destroyed` at the end measures the fix rather than the precondition. An earlier draft asserted
  // it afterwards and failed on its own guard — the cell was right about what it needed and wrong
  // about when to look.
  const openWhenSilenced = first.socket.destroyed === false;

  const deadline = Date.now() + 6000;
  while (room.dials === before && sub.dark() === undefined && Date.now() < deadline) await sub.wait(20);

  assert.equal(openWhenSilenced, true,
    "the socket was already closed when the channel was silenced, so this cell did not exercise the cached-client path");
  // Either outcome satisfies the lift; what must NOT happen is silently re-subscribing the corpse.
  if (sub.dark() === undefined) {
    assert.ok(room.dials > before, `no real redial: dials stayed at ${room.dials}`);
    const second = await room.client();
    assert.notEqual(second, first, "the room handed back the same cached client after its probe failed");
  } else {
    assert.match(String(sub.dark()), /could not be re-dialled/, "darkness was reported without a name");
  }
});

test("a replacement completed DURING dropClient's teardown is not dialled over on the probe's return", async (t) => {
  // A second reader's third HOLD, and the same race as the first two at a third
  // await: `dropClient` closes the old socket, whose close handler can attach a healthy replacement
  // while `resource.stop()` is still pending. The probe resumes holding a `client` that is now two
  // generations old, and without re-reading the fence it dials over a channel that is fine.
  //
  // The ordering is forced, not raced: `stop()` hangs on a deferred promise, and the replacement is
  // completed by hand while it hangs.
  let calls = 0, subscriptions = 0;
  /** @type {() => void} */ let releaseStop = () => {};
  const stopHeld = new Promise((resolve) => { releaseStop = () => resolve(undefined); });

  const makeClient = (/** @type {boolean} */ silent) => {
    const socket = /** @type {any} */ (new EventEmitter());
    socket.destroyed = false;
    return { socket, closed: false,
      close() { this.closed = true; },
      request: async () => { if (silent) throw new AgoraError("member-channel-dark: silent"); return { status: { epoch: EPOCH, committed: 0 } }; },
      subscribe: async () => { subscriptions += 1; return { messages: [] }; } };
  };
  const first = makeClient(true);
  const second = makeClient(false);

  const room = /** @type {any} */ ({
    binding: { roomId: ROOM, accountId: `m-${"d".repeat(32)}`, host: { id: HOST_ACCOUNT } },
    client: async () => { calls += 1; return calls === 1 ? first : second; },
    close: async () => {},
    // Stands in for the real one: it closes the old client, then its teardown HANGS, and the
    // replacement lands in that window exactly as the close handler would do it.
    dropClient: async (/** @type {any} */ c) => {
      if (c !== first) return;
      first.socket.destroyed = true;
      first.socket.emit("close");     // the existing close path attaches the replacement
      await stopHeld;                 // ...while teardown is still pending
    },
  });

  const sub = await openRemoteSubscription({ room, since: nativeCursor(EPOCH, 0),
    idleMs: 50, backoffMs: 5, maxReconnects: 3 });
  t.after(() => sub.close());

  // Let the probe fail on `first` and enter dropClient; the close inside it completes the
  // replacement while stop hangs.
  const deadline = Date.now() + 4000;
  while (subscriptions < 2 && Date.now() < deadline) await sub.wait(10);
  assert.equal(subscriptions, 2, "the replacement did not land during teardown");

  releaseStop();                       // the probe now resumes, holding a stale client
  await sub.wait(400);

  assert.equal(calls, 2, `the probe dialled over a healthy replacement on resumption: ${calls} dials where 2 are owed`);
  assert.equal(subscriptions, 2, `the probe re-subscribed a healthy channel: ${subscriptions} subscribes where 2 are owed`);
  assert.equal(sub.dark(), undefined, "a healthy channel was reported dark after a late resumption");
});
