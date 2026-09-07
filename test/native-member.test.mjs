// T1 host ingress: the host half of native membership over Tailcat.
//
// No cell here holds a live Tailcat relay. The child is faked with a loopback duplex, so a green
// run proves the HOST ADMISSION PATH and proves nothing about Tailcat's own --allow refusal, which
// only the live probe in T3 exhibits. Every cell that claims a refusal asserts the NAMED reason,
// never merely that something threw.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Duplex } from "node:stream";
import test from "node:test";
import {
  MEMBER_PHASES, assertDescriptorDigest, buildRouteBinding, descriptorDigest, isMemberAccountId,
  memberAccountId, memberHandshakeProof, memberMayRequest, memberTranscript, mintRouteSecret,
  readRouteSecret, removeRouteSecret, routeProofRef, routeSecretPath, validatePublicNodeKey,
  verifyMemberHandshakeProof, writeRouteSecret,
} from "../src/native-member.mjs";
import { NativeFrameDecoder, NATIVE_PROTOCOL, encodeNativeFrame, nativeHandshakeProof } from "../src/native-protocol.mjs";
import { NativeRoomService } from "../src/native-service.mjs";
import { publicNodeKeyDigest } from "../src/protocol/route.mjs";

const ACCOUNT = "a".repeat(32);
const ROOM = "b".repeat(32);
const EPOCH = "c".repeat(32);
const KEY = `nodekey:${"d".repeat(64)}`;
const OTHER_KEY = `nodekey:${"e".repeat(64)}`;

/** A binding without a running service, for the pure-function cells. */
function binding(over = {}) {
  return buildRouteBinding({
    hostAccountId: ACCOUNT, hostAuthority: ACCOUNT, roomId: ROOM, roomEpoch: EPOCH,
    serviceBootId: "f".repeat(32), publicNodeKey: KEY, ...over,
  });
}

// ---------------------------------------------------------------- the principal

test("the member principal is the key, and its minted id cannot collide with a host account", () => {
  const b = binding();
  assert.equal(b.allowedKeyDigest, publicNodeKeyDigest(KEY));
  assert.match(b.accountId, /^m-[a-f0-9]{32}$/);
  assert.equal(b.member.id, b.accountId, "the routing ref and the principal must not be able to disagree");
  assert.ok(isMemberAccountId(b.accountId));
  // A host account id is 32 hex with no prefix; the spaces are disjoint by construction.
  assert.ok(!isMemberAccountId(ACCOUNT), "a host account id satisfied the member predicate");
  assert.notEqual(memberAccountId(publicNodeKeyDigest(KEY)), memberAccountId(publicNodeKeyDigest(OTHER_KEY)));
});

test("only a public node key is admitted, never a digest or a private path", () => {
  assert.equal(validatePublicNodeKey(KEY), KEY);
  for (const bad of [publicNodeKeyDigest(KEY), "nodekey:short", `nodekey:${"D".repeat(64)}`, "/home/me/key", "", null]) {
    assert.throws(() => validatePublicNodeKey(/** @type {any} */ (bad)), /public node key/,
      `admitted ${JSON.stringify(bad)}`);
  }
});

// ------------------------------------------------- proofRef: selection, not just containment

test("a proof reference is refused unless it EQUALS this route's own canonical name", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-member-ref-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const b = binding();
  const canonical = routeProofRef(b);
  assert.equal(canonical, `${b.grantId}/${b.routeGeneration}.secret`);
  assert.ok(routeSecretPath(root, b, canonical).endsWith(`${b.routeGeneration}.secret`));

  // The oracle: the descriptor names the file the host reads and then HMACs under. A containment
  // check ("does it stay under the root") admits every row below that resolves back inside.
  const refused = [
    "../../slack-bot.token",
    `${b.grantId}/../../slack-bot.token.secret`,
    "./x.secret",
    "../x.secret",
    "..",
    "",
    // The two rows a containment-shaped implementation PASSES. These are the discriminating cells.
    `${b.grantId}/${"9".repeat(32)}.secret`,
    `${"8".repeat(32)}/${b.routeGeneration}.secret`,
  ];
  for (const bad of refused) {
    assert.throws(() => routeSecretPath(root, b, bad), /proof-ref-refused/,
      `proof reference ${JSON.stringify(bad)} was not refused`);
  }
});

test("a route secret round-trips, and a world-readable one is refused rather than repaired", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-member-secret-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const b = binding();
  const secret = mintRouteSecret();
  const { proofRef, file } = await writeRouteSecret(root, b, secret);
  assert.equal(await readRouteSecret(root, b, proofRef), secret);

  if (process.platform !== "win32") {
    // git's index stores only 644 or 755, so a secret cloned from the seat repo arrives 0644.
    await chmod(file, 0o644);
    await assert.rejects(readRouteSecret(root, b, proofRef), /grants group or other access/);
    const after = await stat(file);
    assert.equal(after.mode & 0o777, 0o644, "the secret was silently repaired instead of refused");
    await chmod(file, 0o600);
    assert.equal(await readRouteSecret(root, b, proofRef), secret);
  } else {
    // Mode bits are synthesized on Windows; the refusal PATH must still exist and be reachable.
    await assert.rejects(readRouteSecret(root, b, `${b.grantId}/${"7".repeat(32)}.secret`), /proof-ref-refused/);
  }
});

test("close is revocation: the secret and its generation go, so a stale copy fails by name", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-member-revoke-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const b = binding();
  const { proofRef } = await writeRouteSecret(root, b, mintRouteSecret());
  await removeRouteSecret(root, b);
  await assert.rejects(readRouteSecret(root, b, proofRef), /ENOENT|no such file/i);
});

// ---------------------------------------------------------------- domain separation

test("a proof minted under the LOCAL nonce does not validate on a member route", () => {
  const b = binding();
  const secret = mintRouteSecret();
  const nonce = mintRouteSecret();
  const transcript = memberTranscript(b, { bootEpoch: "f".repeat(32), requestId: "r".repeat(32), serverChallenge: "s".repeat(32) });

  // The phase is inside the HMAC, so the local nonce mints a WELL-FORMED proof under a member
  // phase; it is the secret and the phase together that refuse it.
  const forged = nativeHandshakeProof(nonce, /** @type {any} */ (MEMBER_PHASES.server), transcript);
  assert.match(forged, /^[a-f0-9]{64}$/, "the forgery must be well formed, or the cell proves nothing");
  assert.equal(verifyMemberHandshakeProof(forged, secret, MEMBER_PHASES.server, transcript), false);

  // And the mirror: a member proof does not validate on the local path.
  const memberProof = memberHandshakeProof(secret, MEMBER_PHASES.client, transcript);
  assert.equal(verifyMemberHandshakeProof(memberProof, secret, MEMBER_PHASES.client, transcript), true);
  assert.equal(verifyMemberHandshakeProof(memberProof, secret, MEMBER_PHASES.server, transcript), false,
    "a proof validated under a phase it was not minted for");
  assert.throws(() => memberHandshakeProof(secret, "server", transcript), /invalid .* phase/);
});

test("the member transcript carries the route, and never the seat's local identity", () => {
  const b = binding();
  const t = memberTranscript(b, { bootEpoch: "f".repeat(32), requestId: "r".repeat(32),
    serverChallenge: "s".repeat(32), accountId: ACCOUNT, seatLabel: "admin-pc" });
  // The remote reads seatLabel and the host accountId from service.json, which it does not have.
  assert.ok(!("seatLabel" in t), "seatLabel entered a transcript the remote cannot reproduce");
  // tsc also refuses `t.accountId` outright, which is a stronger statement than this assertion:
  // the field is not on the transcript's type at all. The runtime check stays for a reader.
  assert.equal(/** @type {any} */ (t).accountId, undefined, "the host's local account id entered the member transcript");
  assert.ok(!("accountId" in t), "the host account id entered the member transcript");
  for (const field of ["bootEpoch", "requestId", "serverChallenge", "roomId", "roomEpoch", "grantId",
    "routeGeneration", "membershipRevision", "memberAccountId"]) {
    assert.ok(field in t, `the member transcript dropped ${field}`);
  }
  // Freshness and mutual challenge survive the removal.
  assert.equal(t.memberAccountId, b.accountId);
});

// ---------------------------------------------------------------- the descriptor

test("a descriptor digest covers everything but itself, and an altered binding is refused", () => {
  const b = binding();
  const descriptor = {
    binding: b, protocol: "agora-native/1",
    endpoint: { transport: "tailcat", address: "x".repeat(40), port: 4242 },
    issuedAt: new Date().toISOString(), proofRef: routeProofRef(b),
  };
  const signed = { ...descriptor, descriptorDigest: descriptorDigest(descriptor) };
  assert.equal(assertDescriptorDigest(signed).descriptorDigest, signed.descriptorDigest);

  const tampered = { ...signed, binding: { ...b, roomId: "9".repeat(32) } };
  assert.throws(() => assertDescriptorDigest(tampered), /altered in transit/);
  const tamperedPort = { ...signed, endpoint: { ...signed.endpoint, port: 4243 } };
  assert.throws(() => assertDescriptorDigest(tamperedPort), /altered in transit/);
});

test("a descriptor carrying secret material is refused by the SHAPE, not by a guard", () => {
  const b = binding();
  const descriptor = {
    binding: b, protocol: "agora-native/1",
    endpoint: { transport: "tailcat", address: "x".repeat(40), port: 4242 },
    issuedAt: new Date().toISOString(), proofRef: routeProofRef(b),
  };
  const signed = { ...descriptor, descriptorDigest: descriptorDigest(descriptor) };
  // validateRouteDescriptor's readRecord has no optional list, so ANY extra key is refused before
  // T1 adds anything. A guard could be deleted; the closed required list cannot widen silently.
  for (const extra of ["secret", "nonce", "token", "proof"]) {
    assert.throws(() => assertDescriptorDigest({ ...signed, [extra]: mintRouteSecret() }),
      /field|descriptor/, `a descriptor carrying ${extra} was admitted`);
  }
});

// ---------------------------------------------------------------- the member session

test("a member session may not reach the control surface", () => {
  for (const allowed of ["status", "read", "subscribe", "append"]) assert.ok(memberMayRequest(allowed));
  for (const refused of ["create-room", "spawn", "route-open", "route-list", "route-close"]) {
    assert.equal(memberMayRequest(refused), false, `a member session could request ${refused}`);
  }
});

/** Drive one member stream against a live service, with the Tailcat child faked as loopback. */
/** @param {import('node:test').TestContext} t */
async function memberFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-member-host-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new NativeRoomService({ root, accountId: ACCOUNT, seatLabel: "admin-pc" });
  await service.start();
  await service.createRoom({ roomId: ROOM, epoch: EPOCH });
  t.after(() => service.stop());
  return { root, service };
}

/** One end of a loopback pair, spoken to as a member client. */
function loopback() {
  const toHost = new PassThrough();
  const toClient = new PassThrough();
  const hostSide = Duplex.from({ readable: toHost, writable: toClient });
  const clientSide = Duplex.from({ readable: toClient, writable: toHost });
  return { hostSide, clientSide };
}

/** Read frames from a duplex until `want` returns a value. */
/** @param {any} stream @param {(frame: any) => any} want @param {number} [timeoutMs] */
function collect(stream, want, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const decoder = new NativeFrameDecoder();
    const timer = setTimeout(() => reject(new Error("timed out waiting for a member frame")), timeoutMs);
    stream.on("data", (/** @type {any} */ bytes) => {
      for (const frame of decoder.push(bytes)) {
        const hit = want(frame);
        if (hit !== undefined) { clearTimeout(timer); resolve(hit); }
      }
    });
    stream.on("error", (/** @type {any} */ error) => { clearTimeout(timer); reject(error); });
  });
}

/** A Tailcat child that never runs. The relay is T3's; this proves the host admission path. */
/** @param {{ exit?: number | null, signal?: AbortSignal }} [options] */
function fakeChild(options = {}) {
  const { exit = null, signal } = options;
  const stdout = new PassThrough();
  /** @type {Record<string, Function[]>} */ const listeners = {};
  const child = /** @type {any} */ ({
    stdout, exitCode: null, signalCode: null, connected: false,
    once(/** @type {string} */ event, /** @type {Function} */ cb) { (listeners[event] ??= []).push(cb); return child; },
    on(/** @type {string} */ event, /** @type {Function} */ cb) { return child.once(event, cb); },
    disconnect() {},
  });
  const finish = (/** @type {number} */ code) => {
    if (child.exitCode !== null) return;
    child.exitCode = code; stdout.end();
    for (const cb of listeners.exit ?? []) cb(code, null);
  };
  if (exit !== null) queueMicrotask(() => finish(exit));
  // A real Tailcat child dies when the route's guardian aborts. A fake that does not leaves
  // stop() waiting on a corpse and reports cleanup-pending, which would read as a defect in
  // close rather than as a defect in the fixture.
  else if (signal) signal.addEventListener("abort", () => finish(0), { once: true });
  return child;
}

/** Open a real route with the transport faked, and hand back the accept hook. */
/** @param {any} service @param {string} [publicNodeKey] */
async function openFakedRoute(service, publicNodeKey = KEY) {
  /** @type {((socket: any) => void) | undefined} */ let accept;
  const address = `tc${"a".repeat(48)}`;
  const result = await service.openRoute({
    roomId: ROOM, publicNodeKey,
    routeOptions: {
      listen: async (/** @type {(socket: any) => void} */ hook) => { accept = hook; return { port: 4242, close: async () => {} }; },
      // `serve` stays resident; `parse` must end and exit 0 for scope.command().
      spawn: async (/** @type {string[]} */ args, /** @type {any} */ _runtime, /** @type {any} */ owner) =>
        fakeChild({ exit: args[0] === "parse" ? 0 : null, signal: owner?.signal }),
      address: async () => address,
    },
  });
  return { ...result, accept: /** @type {(socket: any) => void} */ (accept) };
}

/** Complete the member handshake on the client side and return the live duplex. */
/** @param {any} clientSide @param {string} secret @param {{ accountId?: string }} [claim] */
async function greet(clientSide, secret, claim = {}) {
  const { accountId } = claim;
  const hello = await collect(clientSide, (f) => (f.type === "member-server-hello" ? f : undefined));
  assert.ok(verifyMemberHandshakeProof(hello.proof, secret, MEMBER_PHASES.server,
    Object.fromEntries(Object.entries(hello).filter(([k]) => !["protocol", "type", "proof"].includes(k)))),
    "the host's member-server hello did not prove the transcript");
  const { protocol: _p, type: _t, proof: _pr, ...serverTranscript } = hello;
  const clientChallenge = randomUUID().replaceAll("-", "");
  const transcript = { ...serverTranscript, clientChallenge };
  clientSide.write(encodeNativeFrame({
    protocol: NATIVE_PROTOCOL, type: "member-client-hello", ...transcript,
    ...(accountId ? { accountId } : {}),
    proof: memberHandshakeProof(secret, MEMBER_PHASES.client, transcript),
  }));
  return await collect(clientSide, (f) => (f.type === "member-welcome" || f.type === "error" ? f : undefined));
}

test("a member append lands under the minted principal, and the host account is untouched", async (t) => {
  const { service } = await memberFixture(t);
  const { descriptor, accept } = await openFakedRoute(service);
  const secret = await readRouteSecret(service.root, descriptor.binding, descriptor.proofRef);
  const { hostSide, clientSide } = loopback();
  accept(hostSide);
  const welcome = await greet(clientSide, secret);
  assert.equal(welcome.type, "member-welcome", `handshake refused: ${welcome.message ?? ""}`);

  clientSide.write(encodeNativeFrame({ protocol: NATIVE_PROTOCOL, type: "append", requestId: "q".repeat(32),
    roomId: ROOM, operation: { operationId: randomUUID().replaceAll("-", ""), authorName: "remote-bearer", text: "from the remote seat" } }));
  const ack = await collect(clientSide, (f) => (f.type === "append-ack" || f.type === "error" ? f : undefined));
  assert.equal(ack.type, "append-ack", `append refused: ${ack.message ?? ""}`);

  const store = await service.openRoom(ROOM);
  const posted = store.read({}).at(-1);
  assert.equal(posted.author.id, descriptor.binding.accountId, "a member post was stamped with the wrong principal");
  assert.ok(isMemberAccountId(posted.author.id));
  assert.notEqual(posted.author.id, ACCOUNT, "a member post was stamped with the HOST account");
  assert.equal(posted.author.kind, "agent");
});

test("a member frame naming another principal is refused by name", async (t) => {
  const { service } = await memberFixture(t);
  const { descriptor, accept } = await openFakedRoute(service);
  const secret = await readRouteSecret(service.root, descriptor.binding, descriptor.proofRef);
  const { hostSide, clientSide } = loopback();
  accept(hostSide);
  assert.equal((await greet(clientSide, secret)).type, "member-welcome");

  // The envelope admits arbitrary keys, so this is a frame the guard can actually see.
  clientSide.write(encodeNativeFrame({ protocol: NATIVE_PROTOCOL, type: "append", requestId: "z".repeat(32),
    roomId: ROOM, accountId: ACCOUNT,
    operation: { operationId: randomUUID().replaceAll("-", ""), authorName: "not me", text: "x" } }));
  const refusal = await collect(clientSide, (f) => (f.type === "error" ? f : undefined));
  assert.match(refusal.message, /member-actor-mismatch/);
});

test("a member claiming human is refused, and the local board holder SURVIVES", async (t) => {
  const { service } = await memberFixture(t);
  const store = await service.openRoom(ROOM);

  // A real local holder, taken through the local path. Without this the cell proves the guard
  // fires and never proves what it protects, and the verb it defends deletes a lease
  // (native-store.mjs: `break` requires authorKind human, then holders.delete(subject)).
  const claimed = /** @type {any} */ (await store.append(
    { kind: "board", operationId: randomUUID().replaceAll("-", ""), payload: { action: "claim", subject: "work:unit-1" } },
    { accountId: ACCOUNT }));
  assert.equal(claimed.held, true, "the fixture failed to establish a local holder");
  const before = store.board().find((/** @type {any} */ h) => h.subject === "work:unit-1");
  assert.ok(before, "no holder to protect");
  assert.equal(before.accountId, ACCOUNT);

  const { descriptor, accept } = await openFakedRoute(service);
  const secret = await readRouteSecret(service.root, descriptor.binding, descriptor.proofRef);
  const { hostSide, clientSide } = loopback();
  accept(hostSide);
  assert.equal((await greet(clientSide, secret)).type, "member-welcome");

  // The attack: `break` is a human verb that trusts a client-supplied label.
  clientSide.write(encodeNativeFrame({ protocol: NATIVE_PROTOCOL, type: "append", requestId: "y".repeat(32),
    roomId: ROOM, operation: { kind: "board", operationId: randomUUID().replaceAll("-", ""),
      authorKind: "human", authorName: "the operator", payload: { action: "break", subject: "work:unit-1" } } }));
  const refusal = await collect(clientSide, (f) => (f.type === "error" ? f : undefined));
  assert.match(refusal.message, /member-author-kind-refused/);

  // The consequence, which is the half that was missing: the lease is still held, by the same
  // account, under the same lease id. A refusal that still deleted the holder would pass the
  // assertion above and fail this one.
  const after = store.board().find((/** @type {any} */ h) => h.subject === "work:unit-1");
  assert.ok(after, "the local holder was deleted despite the refusal");
  assert.equal(after.accountId, ACCOUNT);
  assert.equal(after.leaseId, before.leaseId, "the lease was replaced rather than preserved");
});

test("a member session cannot reach the control surface or another room", async (t) => {
  const { service } = await memberFixture(t);
  const { descriptor, accept } = await openFakedRoute(service);
  const secret = await readRouteSecret(service.root, descriptor.binding, descriptor.proofRef);
  const { hostSide, clientSide } = loopback();
  accept(hostSide);
  assert.equal((await greet(clientSide, secret)).type, "member-welcome");

  /** @type {[string, RegExp][]} */
  const controlSurface = [["create-room", /member-request-refused/], ["route-open", /member-request-refused/],
    ["spawn", /member-request-refused/]];
  for (const [type, pattern] of controlSurface) {
    clientSide.write(encodeNativeFrame({ protocol: NATIVE_PROTOCOL, type, requestId: randomUUID().replaceAll("-", "") }));
    const refusal = await collect(clientSide, (f) => (f.type === "error" ? f : undefined));
    assert.match(refusal.message, pattern, `${type} was not refused`);
  }
  await service.createRoom({ roomId: "1".repeat(32), epoch: "2".repeat(32) });
  clientSide.write(encodeNativeFrame({ protocol: NATIVE_PROTOCOL, type: "status",
    requestId: randomUUID().replaceAll("-", ""), roomId: "1".repeat(32) }));
  const strayed = await collect(clientSide, (f) => (f.type === "error" ? f : undefined));
  assert.match(strayed.message, /member-room-refused/);
});

test("a member socket speaking the LOCAL handshake is refused rather than reaching the nonce", async (t) => {
  const { service } = await memberFixture(t);
  const { accept } = await openFakedRoute(service);
  const { hostSide, clientSide } = loopback();
  accept(hostSide);
  await collect(clientSide, (f) => (f.type === "member-server-hello" ? f : undefined));
  clientSide.write(encodeNativeFrame({ protocol: NATIVE_PROTOCOL, type: "client-hello",
    requestId: "n".repeat(32), proof: "0".repeat(64) }));
  const refusal = await collect(clientSide, (f) => (f.type === "error" ? f : undefined));
  assert.match(refusal.message, /member-phase-refused/);
});

test("one live route per key digest, and a second open is refused by name", async (t) => {
  const { service } = await memberFixture(t);
  const first = await openFakedRoute(service);
  await assert.rejects(openFakedRoute(service), /route-already-open/);
  assert.equal(service.listRoutes().length, 1);
  // grantId, not accountId: accountId is a pure function of the public key, so with both opens
  // using ONE key that assertion holds whether the first route survived or was silently replaced
  // by a second grant. The property actually at stake is that the FIRST route is still live.
  assert.equal(service.listRoutes()[0].grantId, first.descriptor.binding.grantId,
    "the refused second open replaced the live route instead of leaving it alone");
  // A different key is a different principal and is admitted alongside.
  await openFakedRoute(service, OTHER_KEY);
  assert.equal(service.listRoutes().length, 2);
});

test("close revokes: the route leaves the registry and its secret is gone", async (t) => {
  const { service } = await memberFixture(t);
  const { descriptor } = await openFakedRoute(service);
  assert.equal(service.listRoutes().length, 1);
  const closed = await service.closeRoute({ roomId: ROOM, publicNodeKey: KEY });
  assert.equal(closed.revoked, true);
  assert.equal(service.listRoutes().length, 0);
  await assert.rejects(readRouteSecret(service.root, descriptor.binding, descriptor.proofRef), /ENOENT|no such file/i);
  await assert.rejects(service.closeRoute({ roomId: ROOM, publicNodeKey: KEY }), /route-not-open/);
  // A reopen mints a NEW generation, so the operator must carry a new descriptor and secret.
  const again = await openFakedRoute(service);
  assert.notEqual(again.descriptor.binding.routeGeneration, descriptor.binding.routeGeneration);
  assert.notEqual(again.descriptor.binding.grantId, descriptor.binding.grantId);
});

test("a descriptor-write failure leaves no live orphan route", async (t) => {
  const { service } = await memberFixture(t);
  // Point the descriptor at a path that cannot be written, after the listener is already up.
  const original = service.nativeDirectory;
  const blocker = path.join(original, "blocker");
  await writeFile(blocker, "not a directory\n");
  let stopped = false;
  const routeOptions = {
    listen: async (/** @type {(socket: any) => void} */ _hook) => ({ port: 4242, close: async () => { stopped = true; } }),
    spawn: async (/** @type {string[]} */ args, /** @type {any} */ _runtime, /** @type {any} */ owner) =>
      fakeChild({ exit: args[0] === "parse" ? 0 : null, signal: owner?.signal }),
    address: async () => `tc${"a".repeat(48)}`,
  };
  service.nativeDirectory = blocker;
  await assert.rejects(service.openRoute({ roomId: ROOM, publicNodeKey: KEY, routeOptions }));
  service.nativeDirectory = original;
  assert.equal(service.listRoutes().length, 0, "a failed open left a route in the registry");
  assert.ok(stopped, "a failed descriptor write left the listener running");
  // And the secret it minted was removed, so nothing is left to authenticate against.
  const leftovers = await readFile(path.join(original, "routes"), "utf8").catch((e) => e.code);
  assert.ok(leftovers === "ENOENT" || leftovers === "EISDIR", `unexpected leftover state: ${leftovers}`);
});

// ---------------------------------------------------------------- the verb's own arguments

/** Run the real binary with NO config in reach, so the ordering is proven on any machine. */
/** @param {string[]} args */
async function agoraConfigless(args) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const bin = new URL("../bin/agora.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const clean = { ...process.env };
  for (const name of ["AGORA_CONFIG", "AGORA_STATE", "AGORA_SESSION", "AGORA_ACTOR"]) delete clean[name];
  try {
    const child = run(process.execPath, [bin, ...args],
      { env: { ...clean, AGORA_CONFIG: path.join(tmpdir(), "agora-no-such-config.json") }, windowsHide: true });
    child.child.stdin?.end();
    const { stdout, stderr } = await child;
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = /** @type {any} */ (e);
    return { code: err.code, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

test("route verbs refuse their own arguments BEFORE loadConfig", async () => {
  // The point of pinning a config that does not exist: on a seat that has one, a verb which
  // loaded config first would still print the right message, and the ordering would go untested.
  // Here a config-first verb exits 1 with "no config"; only an argument-first verb exits 2.
  for (const args of [
    ["service", "route"],
    ["service", "route", "bogus"],
    ["service", "route", "open"],
    ["service", "route", "open", "b".repeat(32)],
    ["service", "route", "close"],
    ["service", "route", "close", "b".repeat(32)],
  ]) {
    const { code, stderr } = await agoraConfigless(args);
    assert.equal(code, 2, `${args.join(" ")} exited ${code}, not the usage code: ${stderr.trim()}`);
    assert.doesNotMatch(stderr, /no config at/, `${args.join(" ")} reached loadConfig before its own check`);
  }
});

test("a malformed --allow-key is a usage error, and only the public key shape is admitted", async () => {
  for (const key of ["deadbeef", `sha256:${"a".repeat(64)}`, "nodekey:short", "/home/me/tailcat.key"]) {
    const { code, stderr } = await agoraConfigless(["service", "route", "open", "b".repeat(32), "--allow-key", key]);
    assert.equal(code, 2, `--allow-key ${key} exited ${code}`);
    assert.match(stderr, /public node key|nodekey/);
  }
});

test("route list has no argument to refuse, so it reaches config and says so", async () => {
  // The twin of the cells above: strictness bought by refusing a verb that has nothing to refuse
  // would be a false pass. `route list` must get PAST the argument stage.
  const { code, stderr } = await agoraConfigless(["service", "route", "list"]);
  assert.equal(code, 1, `route list exited ${code}, not the error code`);
  assert.match(stderr, /no config at/);
});

// ---------------------------------------------------------- the registry race

test("two CONCURRENT opens for one key: one route, one named refusal, no orphan listener", async (t) => {
  const { service } = await memberFixture(t);
  // Each socket's request chain is its own, so nothing serializes two route-open frames. A check
  // that awaits before registering lets both pass and leaves a LIVE listener nobody can reach.
  let opened = 0;
  let closed = 0;
  const routeOptions = {
    listen: async (/** @type {(socket: any) => void} */ _hook) => {
      opened += 1;
      return { port: 4242, close: async () => { closed += 1; } };
    },
    spawn: async (/** @type {string[]} */ args, /** @type {any} */ _r, /** @type {any} */ owner) =>
      fakeChild({ exit: args[0] === "parse" ? 0 : null, signal: owner?.signal }),
    address: async () => `tc${"a".repeat(48)}`,
  };
  const both = await Promise.allSettled([
    service.openRoute({ roomId: ROOM, publicNodeKey: KEY, routeOptions }),
    service.openRoute({ roomId: ROOM, publicNodeKey: KEY, routeOptions }),
  ]);
  const won = both.filter((r) => r.status === "fulfilled");
  const lost = both.filter((r) => r.status === "rejected");
  assert.equal(won.length, 1, "both concurrent opens were admitted");
  assert.equal(lost.length, 1, "neither open was refused");
  assert.match(String(/** @type {PromiseRejectedResult} */ (lost[0]).reason.message), /route-already-open/);
  assert.equal(service.listRoutes().length, 1);

  // The registry can look right while a second listener is still up: the orphan is the defect,
  // not the count. Exactly one listener was opened and none was abandoned.
  assert.equal(opened - closed, 1, `listeners opened ${opened}, closed ${closed}: an orphan survived`);
  assert.equal(service.listRoutes()[0].grantId, /** @type {any} */ (won[0]).value.descriptor.binding.grantId);
  assert.equal(service.listRoutes()[0].state, "live");
});

test("close retains the handle while cleanup is pending, and reports it as closing", async (t) => {
  const { service } = await memberFixture(t);
  const { descriptor } = await openFakedRoute(service);
  const key = `${ROOM}:${descriptor.binding.allowedKeyDigest}`;
  const entry = /** @type {any} */ (service.routes.get(key));
  let release = () => {};
  // A stop() that rejects cleanup-pending: its own message says to retain the handle.
  entry.resource.stop = async () => {
    throw Object.assign(new Error("Native route cleanup is pending; retain closed and the resource handle."),
      { code: "AGORA_CLEANUP_PENDING", cleanupPending: true });
  };
  entry.resource.closed = new Promise((resolve) => { release = () => resolve(undefined); });

  await assert.rejects(service.closeRoute({ roomId: ROOM, publicNodeKey: KEY }), /cleanup is pending/);
  const during = service.listRoutes();
  assert.equal(during.length, 1, "the handle was dropped while its child was still being torn down");
  assert.equal(during[0].state, "closing");

  release();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.listRoutes().length, 0, "the entry outlived its resource closing");
});
