// L12: the contest. Two concurrent `member start`s race for one enrolled key.
//
// The assertion that matters is a NEGATIVE one about the loser: it spawns nothing and dials
// nothing. Counting only successfully opened host channels would miss exactly the process this
// unit exists to prevent — a competitor whose child started and whose handshake then failed is
// still a second peer on the shared key, because the host indexes clients by node PUBLIC key and
// the entry is re-pointed before anything is proved.
//
// So the count is taken at the real spawn seam, `options.spawn ?? spawnTailcat` in
// src/tailcat-routes.mjs, threaded down through the member client's channel options. A cell that
// counted at a seam of its own invention would prove its own wiring rather than this one.
//
// WHAT THIS FILE DOES NOT COVER, stated rather than implied: two local consumers subscribed to one
// resident client and a host-appended message delivered to both. That half needs the loopback host
// rig and is not written yet; nothing here should be read as evidence for it.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PassThrough } from "node:stream";
import {
  buildRouteBinding, buildRouteDescriptor, mintRouteSecret, routeProofRef, writeRouteSecret,
} from "../src/native-member.mjs";
import { runMemberClient } from "../src/native-member-supervisor.mjs";
import { readKeyClaim } from "../src/native-member-claim.mjs";
import { memberDescriptorPath } from "../src/native-member-descriptor.mjs";
import { existsSync } from "node:fs";

const HOST_ACCOUNT = "b".repeat(32);
const ROOM = "c".repeat(32);
const EPOCH = "d".repeat(32);
const KEY = `nodekey:${"abcdef0123456789".repeat(4)}`;
const ADDRESS = `tc${"a".repeat(48)}`;

/**
 * A state root carrying an enrolled identity, a route descriptor and its secret.
 * @param {import('node:test').TestContext} t
 */
async function seat(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-contest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, "state");
  await mkdir(path.join(stateRoot, "tailcat"), { recursive: true, mode: 0o700 });
  const keyPath = path.join(stateRoot, "tailcat", "identity.private.json");
  await writeFile(keyPath, JSON.stringify({
    Private: `privkey:${"9".repeat(64)}`,
    Public: { ServerPublic: KEY, ServerDiscoPublic: `discokey:${"8".repeat(64)}` },
  }), "utf8");

  const binding = buildRouteBinding({
    hostAccountId: HOST_ACCOUNT, hostAuthority: HOST_ACCOUNT, roomId: ROOM, roomEpoch: EPOCH,
    serviceBootId: "f".repeat(32), publicNodeKey: KEY,
  });
  const secret = mintRouteSecret();
  const proofRef = routeProofRef(binding);
  await writeRouteSecret(stateRoot, binding, secret);
  const descriptor = buildRouteDescriptor({ binding,
    endpoint: { transport: "tailcat", address: ADDRESS, port: 4242 },
    proofRef, issuedAt: new Date().toISOString() });
  const descriptorPath = path.join(root, "descriptor.json");
  await writeFile(descriptorPath, JSON.stringify(descriptor), "utf8");

  return { root, stateRoot, keyPath, descriptorPath, identity: async () => ({ keyPath, nodeKey: KEY }) };
}

/**
 * A fake Tailcat child.
 *
 * The injected `spawn` must return the CHILD ITSELF, not a `{child, exited}` pair: the channel
 * derives `exited` from the child's own `exit` event and reads `child.stdout` directly, so a fake
 * returning a wrapper fails as "Tailcat command output unavailable" before any dial. Measured here.
 *
 * Output is written on `setImmediate`, after the consumer has attached to the stream — a fake that
 * writes and ends synchronously delivers to nobody. And a dial child EXITS on a timer that is NOT
 * unref'd: an unref'd timer lets the loop drain while the channel is still waiting, and every cell
 * in the file is then cancelled by the parent rather than failing on its own assertion.
 * @param {string} [text] @param {number} [exitAfterMs]
 */
function fakeChild(text, exitAfterMs = 600) {
  const stdout = new PassThrough();
  /** @type {Record<string, Function[]>} */
  const listeners = {};
  const child = /** @type {any} */ ({
    stdout, stdin: new PassThrough(), exitCode: null, signalCode: null, connected: false,
    once(/** @type {string} */ e, /** @type {Function} */ cb) { (listeners[e] ??= []).push(cb); return child; },
    on(/** @type {string} */ e, /** @type {Function} */ cb) { return child.once(e, cb); },
    disconnect() {}, kill() { finish(0); },
  });
  const finish = (/** @type {number} */ code) => {
    if (child.exitCode !== null) return;
    child.exitCode = code;
    for (const cb of (listeners.exit ?? []).slice()) cb(code, null);
  };
  if (text !== undefined) setImmediate(() => { stdout.write(text); stdout.end(); finish(0); });
  else setTimeout(() => { stdout.end(); finish(1); }, exitAfterMs);
  return child;
}

/** Is this the DIAL, rather than one of the one-shot commands the channel runs before it? */
const isDial = (/** @type {string[]} */ args) => !args.includes("parse") && !args.includes("printpub");

test("two concurrent member starts: one dials, the LOSER spawns zero and dials zero", async (t) => {
  const { stateRoot, descriptorPath, identity } = await seat(t);

  /** Every Tailcat child either start would create, in order. Counted at the product's own seam. */
  /** @type {string[][]} */
  const spawns = [];
  let dials = 0;
  /** Opened when the test decides the race is settled, so the winner cannot finish early and
   *  hand the key back before the loser has even tried. Determinism, not timing. */
  let releaseWinner = () => {};
  const winnerHeld = new Promise((resolve) => { releaseWinner = () => resolve(undefined); });
  let firstDial = () => {};
  const firstDialSeen = new Promise((resolve) => { firstDial = () => resolve(undefined); });

  /** @param {string[]} args */
  const spawn = async (args) => {
    spawns.push(args);
    // `parse` and `printpub` are one-shot commands the channel runs BEFORE the dial. The barrier
    // must not open on those: the winner keeps spawning after them, and a count taken then moves
    // for the winner's own pre-dial commands and is read as the loser's. (Measured: the first
    // version of this cell failed with "the losing start spawned 1" when what it had actually seen
    // was the winner's `printpub`.) Open the barrier only once the winner is parked in the dial,
    // so every later spawn is unambiguously the loser's.
    if (!isDial(args)) return fakeChild(args.includes("parse") ? "ok\n" : `${KEY}\n`);
    dials += 1;
    // Hold ONLY the first dial. If a later dial appears it can only be the loser's, and it must be
    // allowed to proceed so the count assertion below is what fails. Parking every dial instead
    // deadlocks under the very mutant this cell exists to catch, and the runner then reports a
    // timeout — a red, but one indistinguishable from an unrelated hang. Measured: the
    // claim-after-spawn mutant timed out here until this branch was made first-only.
    if (dials === 1) { firstDial(); await winnerHeld; }
    return fakeChild(undefined);            // never handshakes, then exits so teardown finishes
  };

  const start = (/** @type {string} */ label) => runMemberClient({
    stateRoot, alias: "house-remote", descriptorPath, seatLabel: label,
    identity, channelOptions: { spawn, firstDialAttempts: 1, firstDialTimeoutMs: 300 },
  });

  const winner = start("first").catch((error) => ({ failed: error }));
  await firstDialSeen;                      // the winner is inside the channel, holding the claim

  // The loser starts while the key is demonstrably held.
  const loserSpawnsBefore = spawns.length;
  const loser = await start("second").catch((error) => ({ failed: error }));
  const loserSpawnsAfter = spawns.length;

  // THE PROPERTY: the losing start created no Tailcat child at all — not a dial, not a `parse`,
  // not a `printpub`. Anything it spawned under the shared key would be a second peer.
  assert.equal(loserSpawnsAfter, loserSpawnsBefore,
    `the losing start spawned ${loserSpawnsAfter - loserSpawnsBefore} Tailcat child(ren) under the shared key`);
  assert.equal(/** @type {any} */ (loser).failed?.code, "member-key-claim-held");
  assert.match(/** @type {any} */ (loser).failed?.message, /resident/);

  // And it published no readiness descriptor: a loser advertises nothing.
  assert.equal(existsSync(memberDescriptorPath(stateRoot, "house-remote")), false);

  releaseWinner();
  await winner;

  // The winner spawned; it is the one dial authority.
  assert.ok(spawns.length >= 1, "the winning start never reached the spawn seam at all");

  // The winner's own dial fails against a child that never handshakes; that it releases the key
  // afterwards is the third cell's subject, not this one's.
});

test("the loser's refusal is what the supervisor reports, not a timeout", async (t) => {
  const { stateRoot, descriptorPath, identity } = await seat(t);
  /** @type {string[][]} */
  const spawns = [];
  /** @param {string[]} args */
  const spawn = async (args) => {
    spawns.push(args);
    if (!isDial(args)) return fakeChild(args.includes("parse") ? "ok\n" : `${KEY}\n`);
    return fakeChild(undefined);
  };
  const { takeKeyClaim } = await import("../src/native-member-claim.mjs");
  const { routeKeyDigest } = await import("../src/native-member-supervisor.mjs");
  const { keyDigest } = await routeKeyDigest(descriptorPath);
  const held = await takeKeyClaim({ stateRoot, keyDigest, kind: "resident", label: "the one already running" });
  t.after(() => held.release());

  const error = await runMemberClient({
    stateRoot, alias: "house-remote", descriptorPath, identity,
    channelOptions: { spawn, firstDialAttempts: 1, firstDialTimeoutMs: 300 },
  }).catch((e) => e);

  assert.equal(error.code, "member-key-claim-held");
  // Actionable: the operator learns who holds it and what kind of holder it is.
  assert.match(error.message, /resident pid \d+/);
  assert.match(error.message, /the one already running/);
  assert.deepEqual(spawns, [], "a start refused at the claim reached the spawn seam anyway");
});

test("a start whose dial fails releases the key, so the next start is not fenced out", async (t) => {
  const { stateRoot, descriptorPath, identity } = await seat(t);
  /** @type {string[][]} */
  const spawns = [];
  /** @param {string[]} args */
  const spawn = async (args) => {
    spawns.push(args);
    if (!isDial(args)) return fakeChild(args.includes("parse") ? "ok\n" : `${KEY}\n`);
    return fakeChild(undefined);
  };
  const opts = {
    stateRoot, alias: "house-remote", descriptorPath, identity,
    channelOptions: { spawn, firstDialAttempts: 1, firstDialTimeoutMs: 300 },
  };
  const first = await runMemberClient(opts).catch((e) => e);
  assert.ok(first instanceof Error, "the fake child completed a handshake it cannot complete");

  const { routeKeyDigest } = await import("../src/native-member-supervisor.mjs");
  const { keyDigest } = await routeKeyDigest(descriptorPath);
  const claim = await readKeyClaim(stateRoot, keyDigest);
  assert.equal(claim.held, false, "a failed dial left the key claimed forever");

  // And the next start gets as far as the spawn seam, which is the observable proof it was not
  // fenced out by its predecessor's corpse.
  const before = spawns.length;
  await runMemberClient(opts).catch(() => {});
  assert.ok(spawns.length > before, "the second start never reached the spawn seam");
});

test("the resident records the Tailcat children it spawns, and clears the record when they are gone", async (t) => {
  const { stateRoot, descriptorPath, identity } = await seat(t);
  const { routeKeyDigest } = await import("../src/native-member-supervisor.mjs");
  const { keyClaimDir, canonicalStateRoot, scanClaimDir } = await import("../src/native-member-claim.mjs");
  const { keyDigest } = await routeKeyDigest(descriptorPath);
  const dir = keyClaimDir(await canonicalStateRoot(stateRoot), keyDigest);

  // A pid that is certainly not running: the record must be WRITTEN from the spawn seam whatever
  // the pid is (nothing probes at write time), and read back as dead by the next taker. Using a
  // live pid here would fence this test's own state root and prove less.
  const DEAD = 999_999_999;
  /** @type {Record<string, unknown>} the record as it stood at each observation */
  const seen = {};
  /** @param {string[]} args */
  const spawn = async (args) => {
    const child = fakeChild(isDial(args) ? undefined : (args.includes("parse") ? "ok\n" : `${KEY}\n`));
    child.pid = DEAD;
    if (isDial(args)) {
      // Observed after the dial child exists: this is the window in which a crashed resident would
      // leave its child behind, and the whole point of the record.
      queueMicrotask(async () => { seen.duringDial = (await scanClaimDir(dir)).children.get(1)?.pids; });
    }
    return child;
  };

  // This start fails its handshake (the fake never completes one), which runs the failure path:
  // teardown, then release. Both halves are what the record is for.
  const failed = await runMemberClient({
    stateRoot, alias: "house-remote", descriptorPath, identity,
    channelOptions: { spawn, firstDialAttempts: 1, firstDialTimeoutMs: 300 },
  }).catch((error) => error);
  assert.ok(failed instanceof Error, "the fake child completed a handshake it cannot complete");

  // THE WIRE: the spawn seam wrote the child beside the claim. Deleting the wrapper leaves both
  // ends of this correct and this assertion red, which is the seam nothing else covers.
  assert.deepEqual(seen.duringDial, [DEAD], "no Tailcat child was recorded beside the claim");

  // And teardown cleared it, so the key is genuinely free rather than free-looking.
  const after = await scanClaimDir(dir);
  assert.equal(after.children.get(1), undefined, "the child record outlived the child it named");
  const claim = await readKeyClaim(stateRoot, keyDigest);
  assert.equal(claim.held, false);
});
