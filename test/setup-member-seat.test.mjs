// @ts-check
// The member-seat setup script in temp roots. The seat's and the human's keys are minted by the
// real CLI; the kits come from the real host admission (scripts/admit-peer-seat.mjs) against an
// in-process seat service with a fake Tailcat; the descriptors are verified by the real
// `room add-remote`. What needs a live host (doctor, read, post, attachment get) is answered by a
// stand-in, and omp and Tern are stand-in programs that keep their state in the temp root.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { admit } from "../scripts/admit-peer-seat.mjs";
import { agoraEnv, execNoShell, setup, formatReport, STEPS } from "../scripts/setup-member-seat.mjs";
import { NativeRoomService } from "../src/native-service.mjs";
import { serviceDescriptorStatus } from "../src/wake/subscriber.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "bin", "agora.mjs");
const ROOM = "b".repeat(32);
const HOST_NODE = `nodekey:${"1".repeat(64)}`;
const SIGNER_NODE = `nodekey:${"2".repeat(64)}`;
const OTHER_KEY = `nodekey:${"e".repeat(64)}`;
const ADDRESS = `tc${"a".repeat(48)}`;
const CHARTER = "# Room charter\n\nC1. Address by audience.\n";
const CHARTER_HEX = createHash("sha256").update(CHARTER).digest("hex");
const HEAD = (await execNoShell(["git", "-C", ROOT, "rev-parse", "HEAD"])).stdout.trim();

test("the step list is the guide's, in the guide's order", () => {
  // docs/MEMBER-SEAT.md numbers these steps; a step added here without its section there is a
  // guide that no longer describes what the script does.
  assert.deepEqual(STEPS.map((s) => s.id), ["node", "checkout", "seat-key", "route", "config", "doctor", "human-key",
    "human-route", "omp", "tern", "charter", "first-run", "extension-turn"]);
});

// ---------------------------------------------------------------- stand-ins

const FAKE_OMP = `import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const [store, ...args] = process.argv.slice(2);
appendFileSync(store + ".log", JSON.stringify(args) + "\\n");
const data = existsSync(store) ? JSON.parse(readFileSync(store, "utf8")) : {};
if (args[0] === "--version") { console.log("omp/0.0.0-stand-in"); process.exit(0); }
if (args[0] === "config" && args[1] === "get") { console.log(JSON.stringify({ key: args[2], value: data[args[2]] ?? [], type: "array" })); process.exit(0); }
if (args[0] === "config" && args[1] === "set") { data[args[2]] = JSON.parse(args[3]); writeFileSync(store, JSON.stringify(data)); console.log(JSON.stringify({ key: args[2], value: data[args[2]] })); process.exit(0); }
console.error("stand-in omp: unknown " + args.join(" ")); process.exit(2);
`;

const FAKE_TERN = `import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
const [dir, ...args] = process.argv.slice(2);
appendFileSync(dir + ".log", JSON.stringify(args) + "\\n");
const link = path.join(dir, "agora.path");
const verb = args.slice(0, 2).join(" ");
if (verb === "plugin dir") { console.log(JSON.stringify({ dir })); process.exit(0); }
if (verb === "plugin link") { mkdirSync(dir, { recursive: true }); writeFileSync(link, args[2]); process.exit(0); }
if (verb === "plugin unlink") { rmSync(link, { force: true }); process.exit(0); }
if (verb === "plugin list") { console.log(JSON.stringify({ plugins: existsSync(link) ? [{ id: "agora", status: "ready" }] : [], problems: [] })); process.exit(0); }
console.error("stand-in tern: unknown " + args.join(" ")); process.exit(2);
`;

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

/**
 * The host's side: admit the member's keys with the real helper against an in-process service in
 * its own temp root and return the kit folders it exported.
 * @param {string} under @param {{ seatKey?: string, humanKey?: string, humanName?: string }} keys
 */
async function hostKits(under, keys) {
  const home = await mkdtemp(path.join(under, "host-"));
  const state = path.join(home, "state");
  await mkdir(state, { recursive: true, mode: 0o700 });
  const config = path.join(home, "agora.json");
  await writeFile(config, JSON.stringify({ actor: { name: "Lin", kind: "agent" }, state, rooms: { partner: { transport: "native", roomId: ROOM } } }));
  /** @type {NativeRoomService | undefined} */
  let service;
  const deps = {
    identity: async (/** @type {string} */ root) => ({ nodeKey: path.resolve(root) === path.resolve(state) ? HOST_NODE : SIGNER_NODE }),
    startService: async (/** @type {any} */ o) => {
      service = new NativeRoomService({
        root: o.root, accountId: o.accountId, seatLabel: o.seatLabel, authorityId: o.authorityId || undefined,
        routeOptions: {
          listen: async () => ({ port: 4242, close: async () => {} }),
          spawn: async (/** @type {string[]} */ args, /** @type {any} */ _r, /** @type {any} */ owner) => fakeChild({ exit: (args[0] === "parse" || args[0] === "genkey") ? 0 : null, signal: owner?.signal }),
          address: async () => ADDRESS,
        },
        readLocalIdentity: async () => ({ nodeKey: HOST_NODE }),
      });
      await service.start();
      return serviceDescriptorStatus(o.root);
    },
    stopService: async () => { await service?.stop(); service = undefined; return serviceDescriptorStatus(state); },
  };
  const prior = process.env.AGORA_STATE;
  process.env.AGORA_STATE = state;
  const kits = path.join(home, "kits");
  try {
    await admit(["--config", config, "--room", "partner",
      ...(keys.seatKey ? ["--allow-key", keys.seatKey] : []),
      ...(keys.humanKey ? ["--human-key", keys.humanKey, "--human-name", keys.humanName ?? "Grace"] : []),
      "--out-dir", kits], deps);
  } finally {
    await service?.stop();
    if (prior === undefined) delete process.env.AGORA_STATE; else process.env.AGORA_STATE = prior;
  }
  /** @type {{ seat?: string, human?: string }} */
  const out = {};
  for (const name of await readdir(kits)) {
    const d = JSON.parse(await readFile(path.join(kits, name, "descriptor.json"), "utf8"));
    if (d.binding.author) out.human = path.join(kits, name); else out.seat = path.join(kits, name);
  }
  return out;
}

/**
 * A member seat in a temp home, with omp and Tern stand-ins and the host-only verbs answered here.
 * @param {import("node:test").TestContext} t
 */
async function memberSeat(t) {
  const home = await mkdtemp(path.join(tmpdir(), "agora-member-seat-test-"));
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 3 }));
  const fakes = path.join(home, "fakes");
  await mkdir(fakes, { recursive: true });
  await writeFile(path.join(fakes, "omp.mjs"), FAKE_OMP);
  await writeFile(path.join(fakes, "tern.mjs"), FAKE_TERN);
  const ompStore = path.join(home, "omp-settings.json");
  const pluginDir = path.join(home, "tern-plugins");
  const ternData = path.join(home, "tern-data", "agora");
  /** @type {NodeJS.ProcessEnv} */
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(AGORA_|TERN_)/.test(k)) env[k] = v;

  const calls = { doctor: 0, read: 0, post: 0, attachment: 0 };
  /** @type {string[]} */
  const posts = [];
  const real = (/** @type {string[]} */ args, /** @type {{ state: string, config?: string }} */ o) =>
    execNoShell([process.execPath, ENTRY, ...args], { env: agoraEnv(env, o), timeoutMs: 60_000 });
  /** @param {string[]} args @param {{ state: string, config?: string }} o */
  const agora = async (args, o) => {
    const ok = (/** @type {unknown[]} */ rows) => ({ code: 0, stdout: rows.map((r) => JSON.stringify(r)).join("\n") + "\n", stderr: "" });
    switch (args[0]) {
      case "doctor":
        calls.doctor++;
        return ok([{ type: "tailcat", status: "verified" }, { type: "room", alias: "partner", transport: "native-remote", identity: { id: `m-${"f".repeat(32)}`, name: "member" } }]);
      case "read":
        calls.read++;
        return ok([
          { type: "message", alias: "partner", id: "m1".padEnd(64, "1"), cursor: "1:1", author: { name: "Lin" }, text: "Room charter",
            attachments: [{ id: "a".repeat(24), name: "CHARTER.md", digest: `sha256:${CHARTER_HEX}`, kind: "file", size: CHARTER.length, lifetime: "durable" }] },
          { type: "message", alias: "partner", id: "m2".padEnd(64, "2"), cursor: "1:2", author: { name: "Lin" }, text: "hello" },
          { type: "annotation", alias: "partner", act: "pin", target: "m1".padEnd(64, "1") },
        ]);
      case "attachment": {
        calls.attachment++;
        const out = args[args.indexOf("--out") + 1];
        await writeFile(/** @type {string} */ (out), CHARTER, { flag: "wx" });
        return ok([{ type: "attachment", alias: "partner", id: args[3], path: out }]);
      }
      case "post":
        calls.post++;
        posts.push(args.slice(args.indexOf("--") + 1).join(" "));
        return ok([{ id: `p${calls.post}`.padEnd(64, "0"), cursor: `1:${10 + calls.post}`, alias: "partner" }]);
      default:
        return real(args, o);
    }
  };
  let tick = 0;
  const deps = { home, env, agora, now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)) };
  const omp = JSON.stringify([process.execPath, path.join(fakes, "omp.mjs"), ompStore]);
  const tern = JSON.stringify([process.execPath, path.join(fakes, "tern.mjs"), pluginDir]);
  const paths = {
    config: path.join(home, ".agora", "config.json"),
    state: path.join(home, ".agora", "state"),
    humanConfig: path.join(home, ".agora", "human", "config.json"),
    humanState: path.join(home, ".agora", "human", "state"),
    ternJson: path.join(ternData, "agora.json"),
    linkFile: path.join(pluginDir, "agora.path"),
  };
  return {
    home, env, calls, posts, ompStore, pluginDir, ternData, paths,
    /** @param {string[]} argv */
    run: (argv) => setup(["--room", "partner", "--omp", omp, "--tern", tern, "--tern-data", ternData, ...argv], deps),
    /** @param {string} state */
    async key(state) {
      const r = await real(["enroll", "--local", "--json"], { state });
      return String(JSON.parse(r.stdout.trim().split(/\r?\n/).pop() ?? "{}").nodeKey);
    },
    ompCalls: async () => (await readFile(ompStore + ".log", "utf8").catch(() => "")).split("\n").filter(Boolean).map((l) => JSON.parse(l)),
    ternCalls: async () => (await readFile(pluginDir + ".log", "utf8").catch(() => "")).split("\n").filter(Boolean).map((l) => JSON.parse(l)),
  };
}

/** @param {Awaited<ReturnType<typeof setup>>} report */
const states = (report) => Object.fromEntries(report.steps.map((s) => [s.id, s.state]));
/** @param {Awaited<ReturnType<typeof setup>>} report @param {string} id */
const step = (report, id) => /** @type {NonNullable<(typeof report.steps)[number]>} */ (report.steps.find((s) => s.id === id));

/** Every file under `dir` with its bytes, for an exact before/after comparison. @param {string} dir */
async function snapshot(dir) {
  /** @type {Record<string, string>} */
  const out = {};
  const walk = async (/** @type {string} */ d) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out[path.relative(dir, p)] = (await readFile(p)).toString("base64");
    }
  };
  await walk(dir);
  return out;
}

// ---------------------------------------------------------------- cells

test("--check on a fresh seat changes nothing and names what a plain run would do", { timeout: 120_000 }, async (t) => {
  const s = await memberSeat(t);
  const report = await s.run(["--pin", HEAD, "--check"]);
  assert.deepEqual(states(report), {
    node: "ok", checkout: "ok", "seat-key": "todo", route: "blocked", config: "blocked", doctor: "blocked",
    "human-key": "todo", "human-route": "blocked", omp: "todo", tern: "todo", charter: "blocked",
    "first-run": "blocked", "extension-turn": "blocked",
  });
  assert.equal(report.ok, false);
  assert.equal(report.changed, false);
  assert.equal(existsSync(path.join(s.home, ".agora")), false, "a check created the agora folder");
  assert.equal(existsSync(s.ompStore), false, "a check wrote omp's settings");
  assert.equal(existsSync(s.paths.linkFile), false);
  assert.equal(existsSync(s.paths.ternJson), false);
  assert.deepEqual((await s.ompCalls()).map((a) => a.slice(0, 2).join(" ")), ["--version", "config get", "config get"]);
  assert.deepEqual((await s.ternCalls()).map((a) => a.join(" ")), ["plugin dir --json"]);
  assert.ok(step(report, "omp").changes.some((l) => l.includes("+ extensions:") && l.includes(path.join(ROOT, "plugins", "omp", "agora-room").replace(/\\/g, "\\\\"))));
  assert.match(formatReport(report), /todo\s+seat-key/);
});

test("the pin: absent, unknown, or not HEAD fails by name with the command that fixes it", { timeout: 120_000 }, async (t) => {
  const s = await memberSeat(t);
  const none = step(await s.run(["--check"]), "checkout");
  assert.equal(none.state, "fail");
  assert.match(none.detail, /no pin named; pass --pin <tag>/);
  const unknown = step(await s.run(["--check", "--pin", "f".repeat(40)]), "checkout");
  assert.equal(unknown.state, "fail");
  assert.match(unknown.detail, /is not in this checkout: git -C ".*" fetch --tags origin, then git -C ".*" checkout f{40}/);
  const parent = (await execNoShell(["git", "-C", ROOT, "rev-parse", "HEAD^"])).stdout.trim();
  if (/^[a-f0-9]{40}$/.test(parent)) { // a shallow clone has no parent to name
    const behind = step(await s.run(["--check", "--pin", parent]), "checkout");
    assert.equal(behind.state, "fail");
    assert.match(behind.detail, new RegExp(`not the pin ${parent} \\(${parent.slice(0, 12)}\\): git -C ".*" checkout ${parent}`));
  }
  await assert.rejects(setup(["--check"]), (/** @type {any} */ e) => e.exitCode === 2 && /--room <alias> is required/.test(e.message));
});

test("a plain run without kits mints both keys apart, configures omp and Tern, and waits for the kits", { timeout: 120_000 }, async (t) => {
  const s = await memberSeat(t);
  const report = await s.run(["--pin", HEAD, "--human-name", "Grace"]);
  assert.deepEqual(states(report), {
    node: "ok", checkout: "ok", "seat-key": "ok", route: "wait", config: "blocked", doctor: "blocked",
    "human-key": "ok", "human-route": "wait", omp: "ok", tern: "wait", charter: "blocked",
    "first-run": "blocked", "extension-turn": "blocked",
  });
  const seatKey = await s.key(s.paths.state);
  const humanKey = await s.key(s.paths.humanState);
  assert.notEqual(seatKey, humanKey);
  assert.match(step(report, "route").detail, new RegExp(`issues it for this seat's key, ${seatKey}`));
  const human = step(report, "human-key");
  assert.equal(human.changed, true);
  assert.ok(human.notes.some((l) => l.trim() === humanKey), "the human's public key is printed to send back");
  assert.ok(human.notes.some((l) => /the name it posts under: Grace/.test(l)));
  assert.deepEqual(JSON.parse(await readFile(s.ompStore, "utf8")), {
    extensions: [path.join(ROOT, "plugins", "omp", "agora-room")],
    "skills.customDirectories": [path.join(ROOT, "skills")],
  });
  assert.equal((await readFile(s.paths.linkFile, "utf8")).trim(), path.join(ROOT, "plugins", "tern", "agora"));
  assert.deepEqual(JSON.parse(await readFile(s.paths.ternJson, "utf8")), { rooms: ["partner"], room: "partner" }, "no post command before the human's route");
  assert.match(step(report, "tern").detail, /post command waits for the human's route/);
  assert.equal(existsSync(s.paths.config), false, "the config is written only with a route to name");
});

test("with both kits: one plain run writes the config through agora config and every step is ok but the first turn; a second run changes nothing at all", { timeout: 180_000 }, async (t) => {
  const s = await memberSeat(t);
  const kits = await hostKits(s.home, { seatKey: await s.key(s.paths.state), humanKey: await s.key(s.paths.humanState), humanName: "Grace" });
  const argv = ["--pin", HEAD, "--kit", /** @type {string} */ (kits.seat), "--human-kit", /** @type {string} */ (kits.human), "--human-name", "Grace"];

  const first = await s.run(argv);
  assert.deepEqual(states(first), {
    node: "ok", checkout: "ok", "seat-key": "ok", route: "ok", config: "ok", doctor: "ok",
    "human-key": "ok", "human-route": "ok", omp: "ok", tern: "ok", charter: "ok", "first-run": "ok", "extension-turn": "wait",
  }, formatReport(first));
  assert.equal(first.ok, true, "a wait is not a failure");
  assert.deepEqual(first.steps.filter((x) => x.changed).map((x) => x.id), ["route", "config", "human-route", "omp", "tern", "charter", "first-run"]);
  const cfgStep = step(first, "config");
  assert.ok(cfgStep.changes.some((l) => /^\s*--- \/dev\/null$/.test(l)), cfgStep.changes.join("\n"));
  assert.ok(cfgStep.changes.some((l) => /wrote .*config\.json with agora config/.test(l)), cfgStep.changes.join("\n"));

  const cfg = JSON.parse(await readFile(s.paths.config, "utf8"));
  assert.deepEqual(cfg.actor, { name: "agent", kind: "agent" });
  assert.equal(cfg.rooms.partner.transport, "native-remote");
  assert.ok(existsSync(cfg.rooms.partner.descriptor));
  const humanCfg = JSON.parse(await readFile(s.paths.humanConfig, "utf8"));
  assert.deepEqual(humanCfg.actor, { name: "Grace", kind: "human" });
  assert.equal(humanCfg.state, s.paths.humanState);
  assert.ok(String(humanCfg.rooms.partner.descriptor).startsWith(s.paths.humanState));
  assert.deepEqual(JSON.parse(await readFile(s.paths.ternJson, "utf8")).post,
    { command: ["node", ENTRY, "--config", s.paths.humanConfig], env: { AGORA_STATE: s.paths.humanState } });
  const charterFile = path.join(s.home, ".agora", "member-seat", "charter", "partner", `${CHARTER_HEX.slice(0, 16)}-CHARTER.md`);
  assert.equal(await readFile(charterFile, "utf8"), CHARTER);
  assert.match(step(first, "charter").detail, new RegExp(`sha256:${CHARTER_HEX}`));
  assert.equal(s.posts.length, 1);
  assert.match(step(first, "extension-turn").detail, /no omp session watches partner yet/);

  // the extension's liveness file, as a session that delivered a turn writes it
  await mkdir(path.join(s.home, ".agora", "omp-room"), { recursive: true });
  await writeFile(path.join(s.home, ".agora", "omp-room", "omp-s1.json"), JSON.stringify({ plugin: "agora-room", harness: "omp", session: "omp-s1", bearer: "coding/Haiku", rooms: [{ room: "partner", ready: true }], delivered: 1, updatedAt: "2026-01-01T00:00:00.000Z" }));
  const checked = await s.run([...argv, "--check"]);
  assert.equal(step(checked, "extension-turn").state, "ok");
  assert.equal(checked.ok, true);

  const before = await snapshot(s.home);
  const ternBefore = (await s.ternCalls()).length;
  const second = await s.run(argv);
  assert.equal(second.changed, false, formatReport(second));
  assert.deepEqual(second.steps.filter((x) => x.state !== "ok").map((x) => x.id), []);
  const after = await snapshot(s.home);
  const moved = Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k]
    && !k.endsWith(".log") && !k.includes(`${path.sep}sessions${path.sep}`) && !k.includes(`${path.sep}tailcat${path.sep}`));
  assert.deepEqual(moved, [], "a second run changed files");
  assert.equal(s.posts.length, 1, "the first-run post was made again");
  assert.deepEqual((await s.ternCalls()).slice(ternBefore).map((a) => a.slice(0, 2).join(" ")), ["plugin dir", "plugin list"]);
  assert.equal((await s.ompCalls()).filter((a) => a[1] === "set").length, 2, "omp settings were written again");
});

test("an existing config is merged through agora config: --check shows the diff and writes nothing; a plain run adds the row, keeps every other byte and a backup", { timeout: 180_000 }, async (t) => {
  const s = await memberSeat(t);
  const kits = await hostKits(s.home, { seatKey: await s.key(s.paths.state) });
  const mine = { actor: { name: "Ada", kind: "agent" }, sign: false, rooms: { notes: { transport: "local", path: path.join(s.home, "notes.jsonl") } } };
  const original = JSON.stringify(mine, null, 4);
  await writeFile(s.paths.config, original);
  const report = await s.run(["--pin", HEAD, "--kit", /** @type {string} */ (kits.seat), "--check"]);
  assert.equal(step(report, "config").state, "blocked", "the route is installed by a plain run first");

  const applied = await s.run(["--pin", HEAD, "--kit", /** @type {string} */ (kits.seat)]);
  const cfgStep = step(applied, "config");
  assert.equal(cfgStep.state, "ok", formatReport(applied));
  assert.equal(cfgStep.changed, true);
  assert.ok(cfgStep.changes.some((l) => /^\s*\+\s+"partner": \{/.test(l)), cfgStep.changes.join("\n"));
  const written = await readFile(s.paths.config, "utf8");
  const cfg = JSON.parse(written);
  assert.deepEqual({ ...cfg, rooms: { notes: cfg.rooms.notes } }, mine);
  assert.equal(cfg.rooms.partner.transport, "native-remote");
  const notesEnd = original.indexOf("}", original.indexOf('"notes"')) + 1;
  assert.ok(written.startsWith(original.slice(0, notesEnd)) && written.endsWith(original.slice(notesEnd)), `the untouched entries kept their bytes:\n${written}`);
  const backups = (await readdir(path.dirname(s.paths.config))).filter((f) => f.startsWith("config.json.bak-"));
  assert.equal(backups.length, 1);
  assert.equal(await readFile(path.join(path.dirname(s.paths.config), /** @type {string} */ (backups[0])), "utf8"), original);

  // the row gone again: --check previews the same write with --dry-run and leaves the file as it is
  await writeFile(s.paths.config, original);
  const preview = step(await s.run(["--pin", HEAD, "--kit", /** @type {string} */ (kits.seat), "--check"]), "config");
  assert.equal(preview.state, "todo");
  assert.match(preview.detail, /has no room partner yet; a plain run writes it with agora config room add/);
  assert.ok(preview.changes.some((l) => /^\s*\+\s+"partner": \{/.test(l)), preview.changes.join("\n"));
  assert.equal(await readFile(s.paths.config, "utf8"), original, "--check wrote the config");
  assert.equal((await readdir(path.dirname(s.paths.config))).filter((f) => f.startsWith("config.json.bak-")).length, 1, "--check made a backup");
});

test("a room of another transport under the alias fails by name and the config is not touched", { timeout: 180_000 }, async (t) => {
  const s = await memberSeat(t);
  const kits = await hostKits(s.home, { seatKey: await s.key(s.paths.state) });
  const original = JSON.stringify({ actor: { name: "Ada", kind: "agent" }, rooms: { partner: { transport: "local", path: "x.jsonl" } } });
  await writeFile(s.paths.config, original);
  const report = await s.run(["--pin", HEAD, "--kit", /** @type {string} */ (kits.seat)]);
  assert.equal(step(report, "config").state, "fail");
  assert.match(step(report, "config").detail, /already has a local room named partner; choose another alias/);
  assert.equal(await readFile(s.paths.config, "utf8"), original);
  assert.equal(report.ok, false);
});

test("a kit for another key, the human's kit as the seat's, and a human kit under another name are refused before anything is installed", { timeout: 180_000 }, async (t) => {
  const s = await memberSeat(t);
  const humanKey = await s.key(s.paths.humanState);
  await s.key(s.paths.state);
  const foreign = await hostKits(s.home, { seatKey: OTHER_KEY, humanKey, humanName: "Grace" });

  const r1 = await s.run(["--pin", HEAD, "--kit", /** @type {string} */ (foreign.seat), "--human-kit", /** @type {string} */ (foreign.human), "--human-name", "Ada"]);
  assert.equal(step(r1, "route").state, "fail");
  assert.match(step(r1, "route").detail, /issued for another key .* Send the host this seat's public key, nodekey:[a-f0-9]{64}.*never copy another machine's private key/s);
  assert.equal(existsSync(path.join(s.paths.state, "native", "remote")), false, "a foreign kit was installed");
  assert.equal(step(r1, "human-route").state, "fail");
  assert.match(step(r1, "human-route").detail, /grants "Grace", not "Ada"/);
  assert.equal(existsSync(path.join(s.paths.humanState, "native", "remote")), false);

  const r2 = await s.run(["--pin", HEAD, "--kit", /** @type {string} */ (foreign.human)]);
  assert.match(step(r2, "route").detail, /is the human's kit .*pass it as --human-kit/);
  const r3 = await s.run(["--pin", HEAD, "--kit", path.join(s.home, "kit.zip")]);
  assert.match(step(r3, "route").detail, /no kit folder at|unzip the kit/);
});

test("omp: another checkout's copy is replaced and the user's other entries kept; a plugin-linked copy fails by name", { timeout: 120_000 }, async (t) => {
  const s = await memberSeat(t);
  const stale = path.join(s.home, "old-agora", "plugins", "omp", "agora-room");
  const other = path.join(s.home, "my-extension");
  await writeFile(s.ompStore, JSON.stringify({ extensions: [stale, other], "skills.customDirectories": [path.join(s.home, "my-skills")] }));
  const report = await s.run(["--pin", HEAD]);
  const omp = step(report, "omp");
  assert.equal(omp.state, "ok");
  assert.ok(omp.changes.some((l) => l.includes("- extensions:") && l.includes("old-agora")), omp.changes.join("\n"));
  assert.deepEqual(JSON.parse(await readFile(s.ompStore, "utf8")), {
    extensions: [other, path.join(ROOT, "plugins", "omp", "agora-room")],
    "skills.customDirectories": [path.join(s.home, "my-skills"), path.join(ROOT, "skills")],
  });

  await mkdir(path.join(s.home, ".omp", "plugins", "node_modules", "agora-room"), { recursive: true });
  const twice = step(await s.run(["--pin", HEAD, "--check"]), "omp");
  assert.equal(twice.state, "fail");
  assert.match(twice.detail, /would load twice.*omp plugin uninstall agora-room/);
});

test("Tern: an installed copy fails by name; a link to another checkout is relinked, with the diff", { timeout: 120_000 }, async (t) => {
  const s = await memberSeat(t);
  await mkdir(path.join(s.pluginDir, "agora"), { recursive: true });
  const copy = step(await s.run(["--pin", HEAD]), "tern");
  assert.equal(copy.state, "fail");
  assert.match(copy.detail, /installed copy .* tern plugin remove agora/);
  assert.equal(existsSync(s.paths.linkFile), false);

  await rm(path.join(s.pluginDir, "agora"), { recursive: true });
  const elsewhere = path.join(s.home, "old-agora", "plugins", "tern", "agora");
  await writeFile(s.paths.linkFile, elsewhere);
  await mkdir(s.ternData, { recursive: true });
  await writeFile(s.paths.ternJson, JSON.stringify({ rooms: ["home"], room: "home", intervalMs: 9000 }));
  const relinked = step(await s.run(["--pin", HEAD]), "tern");
  assert.equal(relinked.state, "wait", relinked.detail);
  assert.ok(relinked.changes.some((l) => l.includes("- agora.path:") && l.includes("old-agora")));
  assert.equal((await readFile(s.paths.linkFile, "utf8")).trim(), path.join(ROOT, "plugins", "tern", "agora"));
  assert.deepEqual(JSON.parse(await readFile(s.paths.ternJson, "utf8")), { rooms: ["home", "partner"], room: "home", intervalMs: 9000 });
  assert.deepEqual((await s.ternCalls()).map((a) => a.slice(0, 2).join(" ")).filter((v) => v !== "plugin dir"), ["plugin unlink", "plugin link", "plugin list"]);
});
