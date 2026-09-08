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
import { NativeFrameDecoder, NATIVE_FRAME_MAX, NATIVE_PROTOCOL, encodeNativeFrame, nativeFramePayloadBytes, nativeHandshakeProof } from "../src/native-protocol.mjs";
import { NativeRoomService, withRouteReservation } from "../src/native-service.mjs";
import { closeServiceRoute, listServiceRoutes, openServiceRoute, challengeServiceRoute } from "../src/service-cli.mjs";
import { publicNodeKeyDigest } from "../src/protocol/route.mjs";
import { authorityFixtureService, fixtureProof, approvedOpen, approvedClose } from './authority-fixture.mjs';

const ACCOUNT = "a".repeat(32);
const ROOM = "b".repeat(32);
const EPOCH = "c".repeat(32);
const KEY = `nodekey:${"d".repeat(64)}`;
const OTHER_KEY = `nodekey:${"e".repeat(64)}`;
/** @param {string} root @param {Record<string, unknown>} [routeOptions] */
async function enrolledService(root, routeOptions) {
  return authorityFixtureService({ root, accountId: ACCOUNT, seatLabel: 'admin-pc', routeOptions },
    [{ roomId: ROOM, publicNodeKeys: [KEY, OTHER_KEY] }]);
}
/** Keep the entire wire cell on the real client, challenge AND effect.
 * @param {NativeRoomService} service @param {'room-enroll'|'room-revoke'} action */
async function approvedWire(service, action) {
  const p = await challengeServiceRoute(service.root, action, ROOM, KEY);
  const call = action === 'room-enroll' ? openServiceRoute : closeServiceRoute;
  return call(service.root, ROOM, KEY, fixtureProof(service, p.challenge));
}

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
  const service = await enrolledService(root);
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
  const result = await approvedOpen(service, {
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

/** Fill the room until one read-result frame cannot hold it. Returns how many messages landed.
 *
 * Messages GROW: the newest are the largest. That is not decoration, it is the whole point. A
 * uniform filler cannot tell a head from a tail, so a cell built on one credits a limit computed
 * over the wrong end of the batch and stays green -- which is exactly what happened. The defect
 * (the host measured the oldest N while `--limit N` returns the newest N) was invisible to a
 * fixture of identical messages and surfaced on the first real room, whose messages differ in size.
 * Growing sizes also put the heavy end where the store's default read takes its slice, so the
 * over-estimate is in the direction that strands a caller.
 * @param {any} service
 */
async function fillPastTheFrameCap(service, { descending = false } = {}) {
  const store = await service.openRoom(ROOM);
  /** @type {number[]} */ const sizes = [];
  let bytes = 0;
  while (bytes <= NATIVE_FRAME_MAX) {
    const size = 4 * 1024 + sizes.length * 3 * 1024;
    sizes.push(size);
    bytes += size;
  }
  // Both orders are exercised by the cells below. Growing puts the heavy end where the store's
  // default read slices, so a head-measuring host OVER-estimates and strands the caller; shrinking
  // puts it at the other end, where the same defect UNDER-estimates and merely wastes a round.
  // Only running both shows the fix selects the right end rather than being accidentally right.
  if (descending) sizes.reverse();
  for (const size of sizes) {
    await store.append({ operationId: randomUUID().replaceAll("-", ""), authorName: "filler", text: "x".repeat(size) },
      { accountId: ACCOUNT });
  }
  return sizes.length;
}

/** A greeted member session on a real route with the transport faked. */
/** @param {any} t */
async function memberSession(t) {
  const { service } = await memberFixture(t);
  const { descriptor, accept } = await openFakedRoute(service);
  const secret = await readRouteSecret(service.root, descriptor.binding, descriptor.proofRef);
  const { hostSide, clientSide } = loopback();
  accept(hostSide);
  const welcome = await greet(clientSide, secret);
  assert.equal(welcome.type, "member-welcome", `handshake refused: ${welcome.message ?? ""}`);
  /** @param {any} operation */
  const request = (operation) => {
    clientSide.write(encodeNativeFrame({ protocol: NATIVE_PROTOCOL, requestId: randomUUID().replaceAll("-", ""),
      roomId: ROOM, ...operation }));
    return collect(clientSide, (f) => (f.type === "read-result" || f.type === "error" ? f : undefined));
  };
  return { service, request };
}

test("a read past the frame cap is refused by its CONDITION, and the limit it names actually works", async (t) => {
  const { service, request } = await memberSession(t);
  const total = await fillPastTheFrameCap(service);

  const refused = await request({ type: "read" });
  assert.equal(refused.type, "error", "a read larger than one frame was delivered");
  assert.equal(refused.code, "read-batch-refused", "the host flattened the actionable refusal code");
  assert.match(refused.message, /read-batch-refused/,
    "the refusal did not name the condition");
  // The regression this cell exists for. The defect was not the cap; it was that the caller was
  // handed the ENCODER'S byte range ("native protocol frame must be 1-1048576 bytes"), which names
  // the length prefix and says nothing about the batch, the room, or a request that would work.
  assert.doesNotMatch(refused.message, /native protocol frame must be 1-/,
    "the refusal still leaks the encoder's byte range instead of naming the batch");
  assert.match(refused.message, new RegExp(`${total} messages`), "the refusal did not say how many it tried");
  assert.match(refused.message, /no cursor advanced/, "the refusal did not say the cursor is intact");

  // Exhibited by its CONSEQUENCE, not only by its refusal: the remedy the message names has to be
  // one the caller can actually run. A refusal that names an unusable limit is a worse defect than
  // the byte range it replaced, because it looks actionable.
  const named = Number(refused.message.match(/re-read with limit (\d+)/)?.[1]);
  assert.ok(Number.isInteger(named) && named > 0, `the refusal named no usable limit: ${refused.message}`);
  const ok = await request({ type: "read", limit: named });
  assert.equal(ok.type, "read-result", `the limit the refusal named was itself refused: ${ok.message ?? ""}`);
  assert.equal(ok.messages.length, named);

  // And it is the BOUNDARY, not a comfortable value below it: one more message does not fit.
  const over = await request({ type: "read", limit: named + 1 });
  assert.equal(over.type, "error", `limit ${named + 1} fit, so the refusal understated what the frame holds`);
  assert.equal(over.code, "read-batch-refused", "the boundary refusal lost its code on the member wire");
  assert.match(over.message, /read-batch-refused/);
});

test("the limit the refusal names is a limit for the messages the CALLER will get, not the ones the host measured", async (t) => {
  const { service, request } = await memberSession(t);
  await fillPastTheFrameCap(service);

  // With no cursor the store returns the NEWEST n (native-store.mjs slices `-limit`), so a fitting
  // count computed over the head of the batch names a limit for different, and here smaller,
  // messages. Measured live on 2026-09-07 before the fix: join was told 765, `--limit 765` refused
  // and said 761. It converges, so no test that only asserts "a refusal happens" can see it; the
  // assertion has to be that the named limit WORKS.
  const refused = await request({ type: "read" });
  assert.equal(refused.type, "error");
  const named = Number(refused.message.match(/re-read with limit (\d+)/)?.[1]);
  assert.ok(Number.isInteger(named) && named > 0, `no usable limit named: ${refused.message}`);

  const ok = await request({ type: "read", limit: named });
  assert.equal(ok.type, "read-result",
    `the limit the refusal named refused in turn (${ok.message ?? ""}) — it was computed over a different end of the batch`);
  assert.equal(ok.messages.length, named);

  // And it is the boundary from the caller's end too, so the host is not merely being conservative.
  const over = await request({ type: "read", limit: named + 1 });
  assert.equal(over.type, "error", `limit ${named + 1} fit, so the named limit understates what a caller can ask for`);
});

test("the named limit works with the heavy end LAST and with it FIRST, so the fix is not accidentally right", async (t) => {
  const { service, request } = await memberSession(t);
  // The reverse of the live shape. Newest are the SMALLEST here, so a head-measuring host
  // under-estimates instead of over-estimating: it would name a limit that works and is needlessly
  // small, which no "does the named limit succeed" assertion can catch on its own. Running both
  // directions is what distinguishes selecting the right end from happening to be conservative.
  await fillPastTheFrameCap(service, { descending: true });

  const refused = await request({ type: "read" });
  assert.equal(refused.type, "error");
  const named = Number(refused.message.match(/re-read with limit (\d+)/)?.[1]);
  assert.ok(Number.isInteger(named) && named > 0, `no usable limit named: ${refused.message}`);

  const ok = await request({ type: "read", limit: named });
  assert.equal(ok.type, "read-result", `the named limit refused in turn: ${ok.message ?? ""}`);
  assert.equal(ok.messages.length, named);

  const over = await request({ type: "read", limit: named + 1 });
  assert.equal(over.type, "error",
    `limit ${named + 1} fit, so with the heavy end first the host named a needlessly small limit`);
});

test("a read WITH a cursor names a limit for the forward slice, which is the other end entirely", async (t) => {
  const { service, request } = await memberSession(t);
  await fillPastTheFrameCap(service);
  const store = await service.openRoom(ROOM);
  // native-store.mjs slices FORWARD from a cursor (:617), so here the head is the right end and the
  // fix must not "correct" it to a suffix. The twin exists because a fix aimed at one branch is
  // exactly how the other branch breaks silently.
  const since = `${store.manifest.epoch}:0`;

  const refused = await request({ type: "read", since });
  assert.equal(refused.type, "error", "a full forward read fit, so this cell measures nothing");
  const named = Number(refused.message.match(/re-read with limit (\d+)/)?.[1]);
  assert.ok(Number.isInteger(named) && named > 0, `no usable limit named: ${refused.message}`);

  const ok = await request({ type: "read", since, limit: named });
  assert.equal(ok.type, "read-result", `the named limit refused on the forward slice: ${ok.message ?? ""}`);
  assert.equal(ok.messages.length, named);
  assert.equal(ok.messages[0].cursor, `${store.manifest.epoch}:1`,
    "the forward slice did not start at the cursor, so this cell is not reading the branch it names");

  const over = await request({ type: "read", since, limit: named + 1 });
  assert.equal(over.type, "error", `limit ${named + 1} fit on the forward slice, so the named limit understates it`);
});

test("the batch a verb DISPLAYS is the batch it should ask for: twenty fits where the room does not", async (t) => {
  const { service, request } = await memberSession(t);
  await fillPastTheFrameCap(service);

  // L6's whole content, at the layer this suite can reach. `join` asked for the entire room and then
  // printed `slice(-limit)` with limit defaulting to 20 — so on a busy room it built a result too
  // large for one frame and was refused, while wanting twenty messages. `cursor --now` did the same
  // for a single cursor. The fix is not a retry: it is asking for what will be used.
  const unlimited = await request({ type: "read" });
  assert.equal(unlimited.type, "error", "the room is not large enough for this cell to mean anything");
  assert.match(unlimited.message, /read-batch-refused/);

  // join's default, and cursor --now's one, both succeed on the same room in the same breath.
  const twenty = await request({ type: "read", limit: 20 });
  assert.equal(twenty.type, "read-result", `join's default batch was refused: ${twenty.message ?? ""}`);
  assert.equal(twenty.messages.length, 20);

  const one = await request({ type: "read", limit: 1 });
  assert.equal(one.type, "read-result", `cursor --now's read was refused: ${one.message ?? ""}`);
  assert.equal(one.messages.length, 1);

  // And the position is unchanged by bounding the read, which is what makes this safe rather than
  // merely smaller: the store slices the NEWEST n when there is no cursor, so the last element of a
  // limited read is the same message the unlimited one would have ended on.
  assert.equal(one.messages[0].cursor, twenty.messages.at(-1).cursor,
    "a bounded read ended on a different message than the newest, so it would move the cursor");
});

test("a member read leaves the cursor where it was when the batch is refused", async (t) => {
  const { service, request } = await memberSession(t);
  await fillPastTheFrameCap(service);
  const store = await service.openRoom(ROOM);
  const before = store.status().committed;

  assert.equal((await request({ type: "read" })).type, "error");

  assert.equal(store.status().committed, before, "a refused read moved the room's committed position");
  const small = await request({ type: "read", limit: 1 });
  assert.equal(small.type, "read-result", `the room was left unreadable by a refusal: ${small.message ?? ""}`);
  assert.equal(small.messages.length, 1, "the first message after a refusal was not the first message");
});

test("the LARGEST post the store accepts still fits one read frame, which is what keeps the batch bound narrowable", async (t) => {
  const { service, request } = await memberSession(t);
  const store = await service.openRoom(ROOM);
  // The store refuses post text past 256 KiB (native-store.mjs MESSAGE_TEXT_MAX), so through the
  // public append path a single message cannot outgrow a 1 MiB frame. That is not a coincidence to
  // rely on quietly -- it is the invariant that makes "re-read with a smaller limit" terminate.
  // Pin it here so raising either bound past the other fails a test instead of stranding a room.
  const text = "z".repeat(256 * 1024);
  await store.append({ operationId: randomUUID().replaceAll("-", ""), authorName: "filler", text },
    { accountId: ACCOUNT });

  const one = await request({ type: "read", limit: 1 });
  assert.equal(one.type, "read-result", `the largest acceptable post could not be read back: ${one.message ?? ""}`);
  assert.equal(one.messages.length, 1);
  assert.equal(one.messages[0].text.length, text.length);

  // The undeliverable-row branch in the read path is therefore unreachable through append TODAY,
  // and it is kept rather than deleted because the store's own record bound (LOG_RECORD_MAX) is
  // 1 MiB -- EQUAL to the frame bound, with the read envelope's fields added on top of it. A record
  // written at that bound by any future operation kind cannot cross a frame, and the caller would
  // meet it as an unnarrowable batch. Named here so the next reader of native-store.mjs sees it.
  assert.ok(nativeFramePayloadBytes(one) <= NATIVE_FRAME_MAX);
  assert.ok(256 * 1024 < NATIVE_FRAME_MAX,
    "the post cap reached the frame cap; a single message can now strand a room's read");
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
  const closed = await approvedClose(service, { roomId: ROOM, publicNodeKey: KEY });
  assert.equal(closed.revoked, true);
  assert.equal(service.listRoutes().length, 0);
  await assert.rejects(readRouteSecret(service.root, descriptor.binding, descriptor.proofRef), /ENOENT|no such file/i);
  await assert.rejects(approvedClose(service, { roomId: ROOM, publicNodeKey: KEY }), /route-not-open/);
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
  await assert.rejects(approvedOpen(service, { roomId: ROOM, publicNodeKey: KEY, routeOptions }));
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

test("reservation component: two CONCURRENT effects for one key, one grant, one named refusal, no orphan listener", async () => {
  // Drive the inner component directly: public signed admissions have an additional room queue.
  // These effect callbacks model listener acquisition, not a network or authority boundary.
  const registry = { routes: new Map(), openingRoutes: new Set() };
  const key = `${ROOM}:${publicNodeKeyDigest(KEY)}`;
  let opened = 0;
  let closed = 0;
  const effect = async () => {
    opened += 1;
    await new Promise(resolve => setImmediate(resolve));
    const grant = { grantId: randomUUID(), state: 'live', close: () => { closed += 1; } };
    registry.routes.set(key, grant);
    return grant;
  };
  const both = await Promise.allSettled([
    withRouteReservation(registry, ROOM, key, effect),
    withRouteReservation(registry, ROOM, key, effect),
  ]);
  const won = both.filter((r) => r.status === "fulfilled");
  const lost = both.filter((r) => r.status === "rejected");
  assert.equal(won.length, 1, "both concurrent opens were admitted");
  assert.equal(lost.length, 1, "neither open was refused");
  // The loser arrived while the winner was a reservation, not yet a registry entry: the refusal
  // names that state, because `route close` at that instant would say route-not-open.
  assert.match(String(/** @type {PromiseRejectedResult} */ (lost[0]).reason.message), /route-already-open: .*that route is opening; wait for it to settle/);
  assert.equal(registry.routes.size, 1);

  // The registry can look right while a second listener is still up: the orphan is the defect,
  // not the count. Exactly one listener was opened and none was abandoned.
  assert.equal(opened - closed, 1, `listeners opened ${opened}, closed ${closed}: an orphan survived`);
  assert.equal(registry.routes.get(key).grantId, /** @type {any} */ (won[0]).value.grantId);
  assert.equal(registry.routes.get(key).state, "live");
  assert.equal(registry.openingRoutes.size, 0);
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

  await assert.rejects(approvedClose(service, { roomId: ROOM, publicNodeKey: KEY }), /cleanup is pending/);
  const during = service.listRoutes();
  assert.equal(during.length, 1, "the handle was dropped while its child was still being torn down");
  assert.equal(during[0].state, "closing");

  release();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.listRoutes().length, 0, "the entry outlived its resource closing");
});

// ------------------------------------------- the runtime a real Tailcat child is resolved with

test("openRoute hands Tailcat a runtime the REAL resolver accepts", async (t) => {
  // The gap this closes: every other route cell injects `spawn`, so the real binary resolver is
  // never reached and the suite cannot see the arguments a real child would be resolved WITH.
  // Faking the child is still right here (CI holds no relay) — so the fake captures the runtime,
  // and the real resolver is then driven with it. No Tailcat process is started.
  const { service } = await memberFixture(t);

  // Item 8's half of this cell, graded by `npm run check` rather than by the runner: the request's
  // `runtime` is the resolver's own option surface, so a key the resolver does not have is refused
  // where the request is WRITTEN. Widen this hop back to `any` and the directive goes unused and
  // tsc fails — which is the only way to gate a defect that produced no bad value in this process.
  // @ts-expect-error a key the binary resolver has no use for is not a runtime option.
  void (() => service.openRoute({ runtime: { notAResolverKey: 1 }, roomId: ROOM, publicNodeKey: KEY }));

  /** @type {any} */ let handed;
  await approvedOpen(service, {
    roomId: ROOM, publicNodeKey: KEY,
    routeOptions: {
      listen: async (/** @type {(socket: any) => void} */ _hook) => ({ port: 4242, close: async () => {} }),
      spawn: async (/** @type {string[]} */ args, /** @type {any} */ runtime, /** @type {any} */ owner) => {
        handed ??= runtime;
        return fakeChild({ exit: args[0] === "parse" ? 0 : null, signal: owner?.signal });
      },
      address: async () => `tc${"a".repeat(48)}`,
    },
  });

  assert.ok(handed, "openRoute never reached the spawn boundary");
  assert.equal(typeof handed.stateRoot, "string", "the runtime carried no stateRoot");
  assert.equal(handed.stateRoot, service.root, "the runtime's stateRoot is not this service's root");

  const { resolveTailcatBinary } = await import("../src/tailcat-runtime.mjs");
  const { existsSync, readFileSync } = await import("node:fs");
  const { createHash } = await import("node:crypto");

  // The discriminator is ON DISK, not in an error string. resolveTailcatBinary runs inside the
  // guardian child, whose catch reports a status with no text, so the service reports the same
  // "runtime verification or startup failed" for a bare stateRoot and for a real launch failure
  // alike -- an assertion on the message cannot tell the fix from the defect.
  const resolved = await resolveTailcatBinary(handed);
  assert.ok(existsSync(resolved.path), "the resolver reported a path that is not on disk");
  assert.ok(resolved.path.startsWith(service.root),
    "the binary cached outside the service's own state root");
  assert.equal(path.basename(path.dirname(resolved.path)), resolved.sha256,
    "the cache directory is not named for the locked digest");
  assert.equal(createHash("sha256").update(readFileSync(resolved.path)).digest("hex"), resolved.sha256,
    "the extracted bytes do not match the lock");

  // The twin, and it is what makes the assertion above mean something: the pre-fix runtime puts
  // NOTHING under the root. Same real resolver, same machine, one field different.
  const bare = path.join(service.root, "bin", "tailcat");
  await assert.rejects(resolveTailcatBinary(/** @type {any} */ ({})),
    "an empty runtime resolved, so this cell cannot detect the defect it was written for");
  assert.ok(existsSync(bare), "the fixture never extracted anything, so the twin proves nothing");
});

// ------------------------------------------------- follow-ups: state in refusals, face, revocation

/** The faked transport as a service-wide default, so the wire path can open a route. */
function fakeRouteOptions(counters = { opened: 0, closed: 0 }) {
  return {
    counters,
    options: {
      listen: async (/** @type {(socket: any) => void} */ _hook) => {
        counters.opened += 1;
        return { port: 4242, close: async () => { counters.closed += 1; } };
      },
      spawn: async (/** @type {string[]} */ args, /** @type {any} */ _r, /** @type {any} */ owner) =>
        fakeChild({ exit: args[0] === "parse" ? 0 : null, signal: owner?.signal }),
      address: async () => `tc${"a".repeat(48)}`,
    },
  };
}

test("route-already-open names the state: a live route says close it, a closing route says wait", async (t) => {
  const { service } = await memberFixture(t);
  const { descriptor } = await openFakedRoute(service);
  await assert.rejects(openFakedRoute(service), /route-already-open: .*close it before opening a new grant/);
  const key = `${ROOM}:${descriptor.binding.allowedKeyDigest}`;
  const entry = /** @type {any} */ (service.routes.get(key));
  let release = () => {};
  entry.resource.stop = async () => {
    throw Object.assign(new Error("Native route cleanup is pending; retain closed and the resource handle."),
      { code: "AGORA_CLEANUP_PENDING", cleanupPending: true });
  };
  entry.resource.closed = new Promise((resolve) => { release = () => resolve(undefined); });
  await assert.rejects(approvedClose(service, { roomId: ROOM, publicNodeKey: KEY }), /cleanup is pending/);
  assert.equal(service.listRoutes()[0].state, "closing");
  // The key is held while the resource settles: the refusal says so, and says what to do.
  await assert.rejects(openFakedRoute(service), /route-already-open: .*that route is closing; wait for it to settle/);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.listRoutes().length, 0);
  // Settled: the same open now mints a new grant.
  const again = await openFakedRoute(service);
  assert.notEqual(again.descriptor.binding.grantId, descriptor.binding.grantId);
});

test("a member frame carrying a face, at either position, is refused by name and commits nothing; the same append without one lands", async (t) => {
  const { service } = await memberFixture(t);
  const { descriptor, accept } = await openFakedRoute(service);
  const secret = await readRouteSecret(service.root, descriptor.binding, descriptor.proofRef);
  const { hostSide, clientSide } = loopback();
  accept(hostSide);
  assert.equal((await greet(clientSide, secret)).type, "member-welcome");
  const store = await service.openRoom(ROOM);
  const before = store.read({}).length;
  const op = () => ({ operationId: randomUUID().replaceAll("-", ""), authorName: "remote-bearer", text: "with a face" });
  // Top level: where the local transport puts it.
  clientSide.write(encodeNativeFrame({ protocol: NATIVE_PROTOCOL, type: "append", requestId: "f".repeat(32),
    roomId: ROOM, face: ["slack"], operation: op() }));
  let refusal = await collect(clientSide, (f) => (f.type === "error" || f.type === "append-ack" ? f : undefined));
  assert.equal(refusal.type, "error", "a top-level face was committed");
  assert.match(refusal.message, /member-face-refused/);
  // Inside the operation: where a hand-built frame could put it.
  clientSide.write(encodeNativeFrame({ protocol: NATIVE_PROTOCOL, type: "append", requestId: "e".repeat(32),
    roomId: ROOM, operation: { ...op(), face: "none" } }));
  refusal = await collect(clientSide, (f) => (f.type === "error" || f.type === "append-ack" ? f : undefined));
  assert.equal(refusal.type, "error", "an operation-level face was committed");
  assert.match(refusal.message, /member-face-refused/);
  assert.equal(store.read({}).length, before, "a refused frame still committed a message");
  // Twin: the same append with no face lands under the member principal.
  clientSide.write(encodeNativeFrame({ protocol: NATIVE_PROTOCOL, type: "append", requestId: "d".repeat(32),
    roomId: ROOM, operation: op() }));
  const ack = await collect(clientSide, (f) => (f.type === "error" || f.type === "append-ack" ? f : undefined));
  assert.equal(ack.type, "append-ack", `the faceless twin was refused: ${ack.message ?? ""}`);
  assert.equal(store.read({}).length, before + 1);
  assert.equal(store.read({}).at(-1).author.id, descriptor.binding.accountId);
});

test("revocation from the host's side: close stops the listener so no hello is ever sent, and a reopen's hello names a new grant and generation", async (t) => {
  const { service } = await memberFixture(t);
  const counters = { opened: 0, closed: 0 };
  /** @type {((socket: any) => void) | undefined} */ let accept;
  const routeOptions = {
    ...fakeRouteOptions(counters).options,
    listen: async (/** @type {(socket: any) => void} */ hook) => { accept = hook; counters.opened += 1; return { port: 4242, close: async () => { counters.closed += 1; } }; },
  };
  const first = await approvedOpen(service, { roomId: ROOM, publicNodeKey: KEY, routeOptions });
  const secret = await readRouteSecret(service.root, first.descriptor.binding, first.descriptor.proofRef);
  // A live route greets a dial with a server hello that names its grant.
  {
    const { hostSide, clientSide } = loopback();
    /** @type {any} */ (accept)(hostSide);
    const hello = await collect(clientSide, (f) => (f.type === "member-server-hello" ? f : undefined));
    assert.equal(hello.grantId, first.descriptor.binding.grantId);
    assert.equal(hello.routeGeneration, first.descriptor.binding.routeGeneration);
  }
  await approvedClose(service, { roomId: ROOM, publicNodeKey: KEY });
  assert.equal(counters.closed, 1, "close did not stop the listener");
  // Nothing greets a dial on the closed route: the listener is gone, so the remote sees an
  // unreachable route, not a refusal by name. With the transport faked, "gone" is the stopped
  // listener; a stream handed to the old hook after stop gets no server hello.
  {
    const { hostSide, clientSide } = loopback();
    let greeted = false;
    clientSide.on("data", () => { greeted = true; });
    // A stopped route destroys the handed-off stream with an abort (tailcat-routes: accept on a
    // stopped route); that is the "listener gone" of the real transport, and no server hello is
    // ever written. Both ends listen, because an unhandled abort would read as a test crash
    // rather than as the property under test.
    const destroyed = new Promise((resolve) => {
      hostSide.once("error", (/** @type {any} */ error) => resolve(`error:${error.code ?? error.name}`));
      hostSide.once("close", () => resolve("close"));
    });
    clientSide.on("error", () => {});
    let handoff = "accepted";
    await Promise.resolve().then(() => /** @type {any} */ (accept)(hostSide)).catch((error) => { handoff = `refused: ${error.message}`; });
    const end = await Promise.race([destroyed, new Promise((resolve) => setTimeout(() => resolve("silent"), 500))]);
    assert.equal(greeted, false, `a closed route still sent a server hello (hand-off ${handoff}, stream ${end})`);
    assert.match(String(end), /error:ABORT_ERR|close/, `the stopped route kept the stream open (${end})`);
  }
  // A reopen mints a new grant and generation, and its hello names them: a remote still holding
  // the old descriptor disagrees on the binding before any proof is exchanged.
  const second = await approvedOpen(service, { roomId: ROOM, publicNodeKey: KEY, routeOptions });
  assert.notEqual(second.descriptor.binding.grantId, first.descriptor.binding.grantId);
  assert.notEqual(second.descriptor.binding.routeGeneration, first.descriptor.binding.routeGeneration);
  {
    const { hostSide, clientSide } = loopback();
    /** @type {any} */ (accept)(hostSide);
    const hello = await collect(clientSide, (f) => (f.type === "member-server-hello" ? f : undefined));
    assert.equal(hello.grantId, second.descriptor.binding.grantId);
    assert.notEqual(hello.grantId, first.descriptor.binding.grantId);
    assert.notEqual(hello.routeGeneration, first.descriptor.binding.routeGeneration);
    // The backstop, on neither path: were the old secret ever to reach this route's proof, it fails by name.
    const { protocol: _p, type: _t, proof: _pr, ...serverTranscript } = hello;
    const clientChallenge = randomUUID().replaceAll("-", "");
    const transcript = { ...serverTranscript, clientChallenge };
    clientSide.write(encodeNativeFrame({ protocol: NATIVE_PROTOCOL, type: "member-client-hello", ...transcript,
      proof: memberHandshakeProof(secret, MEMBER_PHASES.client, transcript) }));
    const refusal = await collect(clientSide, (f) => (f.type === "error" || f.type === "member-welcome" ? f : undefined));
    assert.equal(refusal.type, "error");
    assert.match(refusal.message, /member-proof-refused/);
  }
});

test("route open, list, a second open, and close reach the service through a real client, not the object", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-member-wire-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { counters, options } = fakeRouteOptions();
  const service = await enrolledService(root, options);
  await service.start();
  await service.createRoom({ roomId: ROOM, epoch: EPOCH });
  t.after(() => service.stop());
  assert.deepEqual(await listServiceRoutes(root), [], "list through the wire on an empty registry");
  const opened = await approvedWire(service, 'room-enroll');
  assert.equal(opened.descriptor.binding.roomId, ROOM);
  assert.equal(counters.opened, 1);
  const listed = await listServiceRoutes(root);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].grantId, opened.descriptor.binding.grantId);
  assert.equal(listed[0].state, "live");
  await assert.rejects(approvedWire(service, 'room-enroll'), /route-already-open: .*close it before opening a new grant/);
  const closed = await approvedWire(service, 'room-revoke');
  assert.equal(closed.revoked, true);
  assert.equal(counters.closed, 1);
  assert.deepEqual(await listServiceRoutes(root), []);
  await assert.rejects(approvedWire(service, 'room-revoke'), /route-not-open/);
});
