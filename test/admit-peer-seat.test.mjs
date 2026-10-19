// @ts-check
// The peer admission helper against an in-process seat service and a fake Tailcat, in a temp
// root. A service restart drops every route, so each cell below counts starts and stops and reads
// the live route registry (grant id, route generation) rather than trusting the helper's output.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { admit } from "../scripts/admit-peer-seat.mjs";
import { NativeRoomService } from "../src/native-service.mjs";
import { closeServiceRoute, challengeServiceRoute, listServiceRoutes, signSeatRouteAct } from "../src/service-cli.mjs";
import { serviceDescriptorStatus } from "../src/wake/subscriber.mjs";
import { publicNodeKeyDigest } from "../src/protocol/route.mjs";

const ROOM = "b".repeat(32);
const HOST_NODE = `nodekey:${"1".repeat(64)}`;
const SIGNER_NODE = `nodekey:${"2".repeat(64)}`;
const ADA = `nodekey:${"a".repeat(64)}`;
const LIN = `nodekey:${"c".repeat(64)}`;
const ADDRESS = `tc${"a".repeat(48)}`;

/** A Tailcat child that never runs. @param {{ exit?: number | null, signal?: AbortSignal }} [options] */
function fakeChild(options = {}) {
  const { exit = null, signal } = options;
  const stdout = new PassThrough();
  /** @type {Record<string, Function[]>} */ const listeners = {};
  const child = /** @type {any} */ ({
    stdout, stdin: undefined, exitCode: null, signalCode: null, connected: false,
    once(/** @type {string} */ e, /** @type {Function} */ cb) { (listeners[e] ??= []).push(cb); return child; },
    on(/** @type {string} */ e, /** @type {Function} */ cb) { return child.once(e, cb); },
    disconnect() {},
  });
  const finish = (/** @type {number} */ code) => {
    if (child.exitCode !== null) return;
    child.exitCode = code;
    stdout.end();
    for (const cb of listeners.exit ?? []) cb(code, null);
  };
  if (exit !== null) queueMicrotask(() => finish(exit));
  else if (signal) signal.addEventListener("abort", () => finish(0), { once: true });
  return child;
}

const routeOptions = () => ({
  listen: async () => ({ port: 4242, close: async () => {} }),
  spawn: async (/** @type {string[]} */ args, /** @type {any} */ _runtime, /** @type {any} */ owner) =>
    fakeChild({ exit: args[0] === "parse" ? 0 : null, signal: owner?.signal }),
  address: async () => ADDRESS,
});

/**
 * A seat in a temp root: a config naming one native room, and the helper's three outside reaches
 * (start, stop, identity) replaced by an in-process service with a counter on each.
 * @param {import("node:test").TestContext} t
 */
async function seat(t) {
  const home = await mkdtemp(path.join(tmpdir(), "agora-admit-"));
  const state = path.join(home, "state");
  await mkdir(state, { recursive: true, mode: 0o700 });
  const config = path.join(home, "agora.json");
  await writeFile(config, JSON.stringify({ actor: { name: "Grace", kind: "agent" }, state, rooms: { partner: { transport: "native", roomId: ROOM } } }));
  const priorState = process.env.AGORA_STATE;
  process.env.AGORA_STATE = state;

  /** @type {NativeRoomService | undefined} */
  let service;
  const counts = { starts: 0, stops: 0 };
  const deps = {
    identity: async (/** @type {string} */ root) => ({
      nodeKey: path.resolve(root) === path.resolve(state) ? HOST_NODE : SIGNER_NODE,
    }),
    startService: async (/** @type {any} */ o) => {
      if (service) throw new Error("native service already running");
      service = new NativeRoomService({
        root: o.root, accountId: o.accountId, seatLabel: o.seatLabel, authorityId: o.authorityId || undefined,
        routeOptions: routeOptions(), readLocalIdentity: async () => ({ nodeKey: HOST_NODE }),
      });
      await service.start();
      counts.starts++;
      return serviceDescriptorStatus(o.root);
    },
    stopService: async () => {
      await service?.stop();
      service = undefined;
      counts.stops++;
      return serviceDescriptorStatus(state);
    },
  };
  t.after(async () => {
    await service?.stop();
    if (priorState === undefined) delete process.env.AGORA_STATE; else process.env.AGORA_STATE = priorState;
    await rm(home, { recursive: true, force: true, maxRetries: 3 });
  });

  const signerRoot = path.join(home, "operator-signer");
  return {
    home, state, signerRoot, counts, kits: path.join(home, "kits"),
    running: () => service !== undefined,
    /** Service-side death: no stop through the helper, no graceful bookkeeping. */
    async killService() { await service?.stop(); service = undefined; },
    /** @param {string[]} argv */
    run: (argv) => admit(["--config", config, ...argv], deps),
    /** Live routes as the service's own registry reports them, keyed by the admitted key's digest tail. */
    async routes() {
      const list = await listServiceRoutes(state);
      return Object.fromEntries(list.map((/** @type {any} */ r) => [r.allowedKeyDigest, { grantId: r.grantId, routeGeneration: r.routeGeneration }]));
    },
    /** Close one live route through the same signed act the helper uses. @param {string} key */
    async closeRoute(key) {
      const challenge = await challengeServiceRoute(state, "room-revoke", ROOM, key);
      const proof = await signSeatRouteAct(signerRoot, challenge, deps.identity);
      await closeServiceRoute(state, ROOM, key, proof);
    },
    authorityFile: () => readFile(path.join(signerRoot, "native", "authority-key.json"), "utf8"),
    roster: async () => JSON.parse(await readFile(path.join(state, "native", "admitted-peers.json"), "utf8")).entries.map((/** @type {any} */ e) => e.publicNodeKey),
  };
}

/** The kit folders under `dir`, each read as the remote would: descriptor binding and secret name.
 * @param {string} dir */
async function kitsIn(dir) {
  const out = [];
  for (const name of (await readdir(dir).catch(() => [])).sort()) {
    const files = await readdir(path.join(dir, name));
    const descriptor = JSON.parse(await readFile(path.join(dir, name, "descriptor.json"), "utf8"));
    out.push({ name, files: files.sort(), grantId: descriptor.binding.grantId, routeGeneration: descriptor.binding.routeGeneration });
  }
  return out;
}

/** Whether a kit still names a route the service holds.
 * @param {{ grantId: string, routeGeneration: string }} kit @param {Record<string, { grantId: string, routeGeneration: string }>} routes */
const kitIsLive = (kit, routes) => Object.values(routes).some((r) => r.grantId === kit.grantId && r.routeGeneration === kit.routeGeneration);

const admitTwo = (/** @type {Awaited<ReturnType<typeof seat>>} */ s) =>
  s.run(["--room", "partner", "--allow-key", ADA, "--allow-key", LIN, "--out-dir", s.kits]);

test("a first key after a bootstrap-only service needs --restart; with it the service restarts once and the peer gets its kit in its own folder", { timeout: 60_000 }, async (t) => {
  const s = await seat(t);
  const boot = await s.run(["--room", "partner", "--bootstrap"]);
  assert.equal(boot.service.started, true);
  await assert.rejects(s.run(["--room", "partner", "--allow-key", ADA, "--out-dir", s.kits]), /restart required, nothing changed/);
  assert.deepEqual(s.counts, { starts: 1, stops: 0 });
  assert.deepEqual(await kitsIn(s.kits), []);

  const first = await s.run(["--room", "partner", "--allow-key", ADA, "--out-dir", s.kits, "--restart"]);
  assert.deepEqual(s.counts, { starts: 2, stops: 1 });
  assert.deepEqual(first.staleRemotes, [], "nobody was admitted before, so nobody holds a stale kit");
  const kits = await kitsIn(s.kits);
  assert.equal(kits.length, 1);
  assert.ok(kitIsLive(/** @type {any} */ (kits[0]), await s.routes()));
});

test("a running service is never stopped as a side effect: a re-run with nothing new restarts nothing and changes nothing", { timeout: 60_000 }, async (t) => {
  const s = await seat(t);
  await admitTwo(s);
  assert.deepEqual(s.counts, { starts: 1, stops: 0 });
  const routesBefore = await s.routes();
  const authorityBefore = await s.authorityFile();
  const kitsBefore = await kitsIn(s.kits);

  for (const argv of [["--room", "partner", "--bootstrap"], ["--reopen"], []]) {
    const again = await s.run(argv);
    assert.deepEqual(s.counts, { starts: 1, stops: 0 }, `argv ${JSON.stringify(argv)} stopped or started the service`);
    assert.deepEqual(await s.routes(), routesBefore, `argv ${JSON.stringify(argv)} re-minted a route`);
    assert.equal(again.changed, false, `argv ${JSON.stringify(argv)} reported a change`);
    assert.equal(again.service.started, false);
    assert.equal(again.service.restarted, false);
    assert.deepEqual(again.staleRemotes, []);
  }
  assert.deepEqual(s.counts, { starts: 1, stops: 0 }, "the service was stopped or started again");
  assert.deepEqual(await s.routes(), routesBefore, "a route was re-minted");
  assert.equal(await s.authorityFile(), authorityBefore, "the authority was rewritten (its revision moved)");
  assert.deepEqual(await kitsIn(s.kits), kitsBefore);
  assert.ok(Object.values(routesBefore).length === 2);
});

test("a second admission on a running service refuses, by name, before changing anything: the first peer's route and kit stay valid", { timeout: 60_000 }, async (t) => {
  const s = await seat(t);
  await s.run(["--room", "partner", "--allow-key", ADA, "--out-dir", s.kits]);
  const routesBefore = await s.routes();
  const [kitBefore] = await kitsIn(s.kits);
  assert.ok(kitBefore && kitIsLive(kitBefore, routesBefore));
  const authorityBefore = await s.authorityFile();
  const countsBefore = { ...s.counts };

  await assert.rejects(s.run(["--room", "partner", "--allow-key", LIN, "--out-dir", s.kits]),
    /restart required, nothing changed.*--restart/s);

  assert.deepEqual(s.counts, countsBefore, "the refused run stopped or started the service");
  assert.equal(s.running(), true);
  assert.deepEqual(await s.routes(), routesBefore, "the first peer's route moved");
  assert.deepEqual(await kitsIn(s.kits), [kitBefore], "a kit was written or changed");
  assert.equal(await s.authorityFile(), authorityBefore);
  assert.deepEqual(await s.roster(), [ADA], "the refused admission was recorded in the roster");
});

test("--restart refuses without --out-dir, and changes nothing", { timeout: 60_000 }, async (t) => {
  const s = await seat(t);
  await s.run(["--room", "partner", "--allow-key", ADA, "--out-dir", s.kits]);
  const routesBefore = await s.routes();
  const countsBefore = { ...s.counts };
  await assert.rejects(s.run(["--room", "partner", "--allow-key", LIN, "--restart"]), /--restart requires --out-dir/);
  assert.deepEqual(s.counts, countsBefore);
  assert.deepEqual(await s.routes(), routesBefore);
  assert.deepEqual(await s.roster(), [ADA]);
});

test("--restart reissues a kit for EVERY admitted key, one folder each, and names every remote that must install it", { timeout: 60_000 }, async (t) => {
  const s = await seat(t);
  await s.run(["--room", "partner", "--allow-key", ADA, "--out-dir", s.kits]);
  const [adaOld] = await kitsIn(s.kits);
  assert.ok(adaOld);

  const second = await s.run(["--room", "partner", "--allow-key", LIN, "--out-dir", s.kits, "--restart"]);
  assert.deepEqual(s.counts, { starts: 2, stops: 1 });
  assert.equal(second.service.restarted, true);

  const routes = await s.routes();
  assert.equal(Object.keys(routes).length, 2);
  const kits = await kitsIn(s.kits);
  assert.equal(kits.length, 2, "one kit folder per admitted key");
  assert.equal(new Set(kits.map((k) => k.name)).size, 2);
  for (const kit of kits) {
    assert.deepEqual(kit.files.filter((f) => f.endsWith(".secret")).length, 1);
    assert.ok(kit.files.includes("descriptor.json") && kit.files.includes("install-peer-route.mjs"));
    assert.ok(kitIsLive(kit, routes), `kit ${kit.name} names a route the service does not hold`);
  }
  // the first peer's old kit named the pre-restart generation, which no longer exists
  assert.equal(Object.values(routes).some((r) => r.grantId === adaOld.grantId), false);
  // the notice names the previously admitted remote, and only it: the new peer has no stale kit
  assert.deepEqual(second.staleRemotes.map((r) => r.publicNodeKey), [ADA]);
  assert.ok(second.staleRemotes[0]?.kitDir?.startsWith(s.kits));
});

test("a stopped service is started and every admitted route re-opened with a kit for each, naming the remotes that must reinstall", { timeout: 60_000 }, async (t) => {
  const s = await seat(t);
  await admitTwo(s);
  const before = await kitsIn(s.kits);
  await s.killService();

  const out = await s.run(["--out-dir", s.kits]);
  assert.equal(out.service.started, true);
  assert.equal(out.service.restarted, false);
  const routes = await s.routes();
  const after = await kitsIn(s.kits);
  assert.equal(after.length, 2);
  for (const kit of after) assert.ok(kitIsLive(kit, routes));
  assert.equal(before.some((k) => kitIsLive(k, routes)), false, "old kits were expected to be stale after the service died");
  assert.deepEqual(out.staleRemotes.map((r) => r.publicNodeKey).sort(), [ADA, LIN].sort());
});

test("one closed route is the only one re-opened: the other peer's grant, generation and kit stay valid and the service stays up", { timeout: 60_000 }, async (t) => {
  const s = await seat(t);
  await admitTwo(s);
  const routesBefore = await s.routes();
  const kitsBefore = await kitsIn(s.kits);
  const adaDigest = publicNodeKeyDigest(ADA);
  const linDigest = publicNodeKeyDigest(LIN);
  assert.ok(routesBefore[adaDigest] && routesBefore[linDigest]);

  await s.closeRoute(ADA);
  const secondKits = path.join(s.home, "kits-2");
  const out = await s.run(["--out-dir", secondKits]);

  assert.deepEqual(s.counts, { starts: 1, stops: 0 }, "re-opening one route touched the service");
  const routesAfter = await s.routes();
  assert.deepEqual(routesAfter[linDigest], routesBefore[linDigest], "the other peer's route was re-minted");
  assert.notEqual(routesAfter[adaDigest]?.grantId, routesBefore[adaDigest]?.grantId);
  const reissued = await kitsIn(secondKits);
  assert.equal(reissued.length, 1, "a kit was written for a route that did not change");
  assert.ok(reissued[0] && kitIsLive(reissued[0], routesAfter));
  const linKit = kitsBefore.find((k) => k.grantId === routesBefore[linDigest]?.grantId);
  assert.ok(linKit && kitIsLive(linKit, routesAfter), "the other peer's installed kit stopped working");
  assert.deepEqual(out.staleRemotes.map((r) => r.publicNodeKey), [ADA]);
});
