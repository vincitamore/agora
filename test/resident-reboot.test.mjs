// @ts-check
// Reboot recovery: the cycle's supervisor restarts standing residents (bounded, staggered, never
// into a dark seat service), the timer runs at logon as well as on its interval, Tern is brought up
// before residents are started into it and is registered to start at logon on Windows, and the
// row's context ceiling reaches the harness so its watch can hold it between cycle runs.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseTaskXml, planResident, readRun, residentState, runFilePath, runTimer, startResident, timerSpec, validateManifest } from "../src/resident-start.mjs";
import * as residentStart from "../src/resident-start.mjs";
import { ensure, readLedger } from "../src/resident-grant.mjs";
import * as grants from "../src/resident-grant.mjs";
import { readSucceedRequest } from "../src/resident.mjs";
import { parseNotice } from "../src/messenger.mjs";
import { bootEpoch } from "../src/session.mjs";
import * as lib from "../plugins/claude/agora-room/hooks/lib.js";

const run = promisify(execFile);
const BIN = fileURLToPath(new URL("../bin/agora.mjs", import.meta.url));
const CHECKOUT = fileURLToPath(new URL("../", import.meta.url));
const CLEARED = ["CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "OMP_SESSION_ID", "OMP_PID", "AGORA_SESSION", "AGORA_ACTOR", "AGORA_LABEL", "AGORA_CONFIG", "AGORA_STATE", "TERN_WINDOW_KEY"];

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

/** The room seed's rows: a messenger naming its host human, three standing model rows, one on-demand row. */
function seedDoc() {
  return {
    version: 1,
    models: { opus: "vendor/claude-opus-9:high", argon: "other/gemini-9:high" },
    defaults: { harness: "omp", host: "tern", model: "opus", rooms: ["lab"], wake: "mine", preamble: "off", profile: "PROFILE.md" },
    residents: {
      "lab.messenger": { role: "messenger", harness: "agora", wake: "all", rooms: ["lab"], args: ["--human-name", "Ada"] },
      "lab.orchestrator": { role: "orchestrator" },
      "lab.coding": { role: "coding", max: 3 },
      "lab.review": { role: "review", model: "argon", context: { ceiling: 150_000 } },
      "lab.helper": { role: "helper", tenure: "on-demand" },
    },
  };
}

/** @param {import("node:test").TestContext} t */
async function seat(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-reboot-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const state = path.join(root, "state");
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(root, "PROFILE.md"), "# A resident\n");
  for (const n of ["omp", "tern"]) for (const ext of ["", ".exe", ".com"]) await writeFile(path.join(bin, n + ext), "");
  const manifestFile = path.join(root, "residents.json");
  await writeFile(manifestFile, JSON.stringify(seedDoc(), null, 2));
  const config = path.join(root, "config.json");
  const cfg = { actor: { name: "Grace", kind: "agent" }, state, rooms: { lab: { transport: "local", path: path.join(root, "lab.ndjson") } } };
  await writeFile(config, JSON.stringify(cfg));
  const env = { PATH: bin, PATHEXT: ".COM;.EXE" };
  const ctx = { cfg: { ...cfg, path: config }, stateRoot: state, checkout: CHECKOUT, entry: BIN, node: "node-bin", env, platform: process.platform };
  return { root, state, bin, manifestFile, config, env, ctx, manifest: validateManifest(seedDoc(), manifestFile) };
}

/** A runner that answers by the command's words and records every call.
 * @param {(argv: string[]) => { code: number, stdout?: string, stderr?: string }} answer */
function fakeRunner(answer) {
  /** @type {string[][]} */
  const calls = [];
  /** @type {import("../src/resident-start.mjs").Runner} */
  const fn = async (argv) => { calls.push(argv); const r = answer(argv); return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }; };
  return { fn, calls };
}

const ternLs = (/** @type {number} */ id, /** @type {boolean} */ live) => JSON.stringify({ sessions: [{ id, tabs: [{ blocks: [{ live, exited: live ? null : 0 }] }] }], detached: [] });

// ---------------------------------------------------------------------------------------------
// The run record: what the supervisor reads as "this position stands"
// ---------------------------------------------------------------------------------------------

test("start: a restart the host refuses keeps the last run record, so the next pass still knows the position stood; a first start that fails leaves none (red leg)", async (t) => {
  const s = await seat(t);
  const plan = planResident(s.manifest, "lab.orchestrator", s.ctx);
  let refuse = false;
  let alive = true;
  const r = fakeRunner((argv) => {
    if (argv[1] === "new") return refuse ? { code: 1, stderr: "tern new: the session daemon refused" } : { code: 0, stdout: JSON.stringify({ session: 5 }) };
    if (argv[1] === "ls") return { code: 0, stdout: ternLs(5, alive) };
    return { code: 0, stdout: "{}" };
  });
  // red leg: nothing stood here, and the host refuses: no record
  refuse = true;
  await assert.rejects(startResident(plan, s.state, { checkout: CHECKOUT, run: r.fn }), /the tern host refused the start/);
  assert.equal(await readRun(s.state, "lab.orchestrator"), null);
  refuse = false;
  const first = await startResident(plan, s.state, { checkout: CHECKOUT, run: r.fn });
  assert.equal(first.row.action, "started");
  const stood = await readRun(s.state, "lab.orchestrator");
  // the session died, and the host refuses the restart
  alive = false;
  refuse = true;
  await assert.rejects(startResident(plan, s.state, { checkout: CHECKOUT, run: r.fn }), /the tern host refused the start/);
  const kept = await readRun(s.state, "lab.orchestrator");
  assert.equal(kept?.id, stood?.id, "the record of the start that stood is kept");
  assert.equal((await residentState(s.state, "lab.orchestrator", { run: r.fn })).running, false, "and it reads as one that stood and died");
});

test("hostAlive: a harness pid recorded before this boot is gone whatever now answers on it; a tmux or none handle started before this boot is gone (red legs: this boot's pid and handle are asked)", async () => {
  const boot = bootEpoch();
  const before = new Date((boot - 3600) * 1000).toISOString();
  const after = new Date((boot + 60) * 1000).toISOString();
  const r = fakeRunner((argv) => argv[1] === "ls" ? { code: 0, stdout: ternLs(5, true) } : { code: 0 });
  /** @type {any} */
  const tern = { type: "resident-run", id: "x", resident: "lab.orchestrator", host: "tern", startedAt: before, hostInfo: { tern: "tern" }, handle: { session: 5 }, pid: process.pid, pidBoot: boot - 3600 };
  assert.equal(await residentStart.hostAlive(tern, { run: r.fn, boot }), "gone", "a pid from the last boot names nothing now");
  assert.equal(await residentStart.hostAlive({ ...tern, pidBoot: boot }, { run: r.fn, boot }), "live", "red leg: this boot's pid answers, then the host is asked");
  const tmux = { ...tern, host: "tmux", pid: undefined, pidBoot: undefined, hostInfo: { tmux: "tmux", server: "s", session: "x" } };
  const calls = r.calls.length;
  assert.equal(await residentStart.hostAlive(tmux, { run: r.fn, boot }), "gone", "a tmux server does not outlive a reboot");
  assert.equal(r.calls.length, calls, "and the host was not asked");
  assert.equal(await residentStart.hostAlive({ ...tmux, startedAt: after }, { run: r.fn, boot }), "live", "red leg: started this boot, the host is asked");
});

test("execRun's pid record carries this boot, and readRun reads it back as pidBoot", async (t) => {
  const s = await seat(t);
  const file = runFilePath(s.state, "lab.orchestrator");
  await mkdir(path.dirname(file), { recursive: true });
  const rec = { type: "resident-run", id: "r1", resident: "lab.orchestrator", host: "tern", startedAt: new Date().toISOString(), hostInfo: {}, handle: { session: 1 },
    exec: { argv: [process.execPath, "-e", "process.exit(0)"], env: {}, cwd: s.root } };
  await writeFile(file, JSON.stringify(rec));
  assert.equal(await residentStart.execRun(file, "lab.orchestrator"), 0);
  const back = /** @type {any} */ (await readRun(s.state, "lab.orchestrator"));
  assert.equal(typeof back.pid, "number");
  assert.ok(Math.abs(back.pidBoot - bootEpoch()) <= 2, `pidBoot ${back.pidBoot}`);
});

// ---------------------------------------------------------------------------------------------
// The supervisor: standing rows restarted, bounded, staggered, never into a dark service
// ---------------------------------------------------------------------------------------------

/**
 * Fake seat acts for ensure. `runs` maps a position to its run record (a start writes one, a stop
 * removes it); `running` holds what runs; the service and the Tern host answer as set.
 * @param {number} now
 */
function fakeDeps(now) {
  const running = new Set();
  /** @type {Map<string, { startedAt: string, host?: string }>} */
  const runs = new Map();
  /** @type {Array<{ room: string, text: string, raw: string }>} */
  const posts = [];
  /** @type {string[]} */
  const acts = [];
  /** @type {number[]} */
  const slept = [];
  const world = { service: true, ternUp: true, ternStarts: true, ternCalls: 0, now };
  /** @type {import("../src/resident-grant.mjs").EnsureDeps} */
  const deps = {
    start: async (p) => {
      acts.push(`start ${p}`);
      running.add(p);
      runs.set(p, { startedAt: new Date(world.now).toISOString() });
      return { action: "started" };
    },
    stop: async (p) => { acts.push(`stop ${p}`); running.delete(p); runs.delete(p); return { action: "stopped" }; },
    state: async (p) => {
      const run = runs.get(p) ?? null;
      // a tern row whose host does not answer cannot be read either way
      if (run && !running.has(p) && !world.ternUp) return { running: true, run, reason: "the tern handle of the last start cannot be checked", host: "unknown" };
      return { running: running.has(p), run, reason: running.has(p) ? "live" : null, host: run ? (running.has(p) ? "live" : "gone") : null };
    },
    marker: async () => false,
    turn: async () => ({ status: "none" }),
    post: async (room, text) => { posts.push({ room, text: text.split("\n")[0], raw: text }); return { id: `m${posts.length}` }; },
    now: () => world.now,
    service: async () => (world.service ? { up: true, reason: null } : { up: false, reason: "seat service at \\\\.\\pipe\\agora-x is dark: connect ENOENT" }),
    host: async (kind) => {
      if (kind !== "tern") return { up: true, started: false, reason: null };
      world.ternCalls += 1;
      if (world.ternUp) return { up: true, started: false, reason: null };
      if (!world.ternStarts) return { up: false, started: false, reason: "Tern did not answer within 20s of its own daemon --login" };
      world.ternUp = true;
      return { up: true, started: true, reason: null };
    },
    sleep: async (ms) => { slept.push(ms); },
  };
  return { deps, running, runs, posts, acts, slept, world };
}

test("ensure after a reboot: every standing row with a run record and nothing running is started once, staggered, with one N8 line each; an on-demand row and a row stopped by hand are left; the next pass starts nothing (red legs inline)", async (t) => {
  const s = await seat(t);
  const f = fakeDeps(Date.parse("2026-01-01T00:00:00.000Z"));
  const stood = ["lab.messenger", "lab.orchestrator", "lab.coding", "lab.review"];
  for (const p of [...stood, "lab.helper"]) f.runs.set(p, { startedAt: "2025-12-31T23:00:00.000Z" });
  let rows = await ensure(s.manifest, s.state, f.deps);
  assert.deepEqual(rows.map((x) => [x.position, x.action]), stood.map((p) => [p, "restarted"]), "the messenger and every standing model row");
  assert.deepEqual(f.acts, stood.map((p) => `start ${p}`), "red leg: the on-demand row is a grant's to start, never the supervisor's");
  assert.deepEqual(f.slept, [10_000, 10_000, 10_000], "a stagger between starts, none before the first");
  assert.deepEqual(f.posts.map((x) => x.text), stood.map((p) => `${p}: absent by host 0s; path restart; outcome started.`));
  assert.deepEqual((await readLedger(s.state)).filter((e) => e.ev === "start").map((e) => [e.position, e.path, e.outcome]), stood.map((p) => [p, "restart", "started"]));
  rows = await ensure(s.manifest, s.state, f.deps);
  assert.deepEqual(rows, [], "running again: nothing to do");
  // a row the operator stopped has no run record, and stays stopped
  f.running.delete("lab.coding");
  f.runs.delete("lab.coding");
  assert.deepEqual(await ensure(s.manifest, s.state, f.deps), []);
  // --dry-run starts nothing and says what it would
  f.running.delete("lab.review");
  rows = await ensure(s.manifest, s.state, f.deps, { dryRun: true });
  assert.deepEqual(rows.map((x) => [x.position, x.action]), [["lab.review", "would-restart"]]);
  assert.equal(f.acts.length, stood.length);
});

test("ensure with the seat service dark: nothing is started, the darkness is reported once per episode, and the rows start when it is back (red leg: the service up starts them)", async (t) => {
  const s = await seat(t);
  const f = fakeDeps(Date.parse("2026-01-01T00:00:00.000Z"));
  const stood = ["lab.messenger", "lab.orchestrator", "lab.coding", "lab.review"];
  for (const p of stood) f.runs.set(p, { startedAt: "2025-12-31T23:00:00.000Z" });
  f.world.service = false;
  let rows = await ensure(s.manifest, s.state, f.deps);
  assert.deepEqual(rows.map((x) => x.action), ["dark"]);
  assert.deepEqual(rows[0].positions, stood);
  assert.match(String(rows[0].reason), /the seat service is dark .*: nothing started/);
  assert.deepEqual([f.acts, f.posts], [[], []], "no start is attempted and nothing can be posted");
  rows = await ensure(s.manifest, s.state, f.deps);
  assert.deepEqual(rows, [], "said once, not every pass");
  assert.equal((await readLedger(s.state)).filter((e) => e.ev === "dark").length, 1);
  assert.equal((await readLedger(s.state)).filter((e) => e.ev === "start").length, 0, "a dark service is not a failed start: it spends no restart");
  f.world.service = true;
  rows = await ensure(s.manifest, s.state, f.deps);
  assert.deepEqual(rows.map((x) => x.action), stood.map(() => "restarted"));
  assert.deepEqual((await readLedger(s.state)).map((e) => e.ev).filter((e) => e === "dark" || e === "light"), ["dark", "light"]);
  // a new episode is reported again
  for (const p of stood) f.running.delete(p);
  f.world.service = false;
  rows = await ensure(s.manifest, s.state, f.deps);
  assert.deepEqual(rows.map((x) => x.action), ["dark"]);
});

test("ensure past the restart limit: a position started 3 times in the hour is held, its host human is told once by an N8 line to them, and starts stop until a start by hand (red leg: a raised limit starts it again)", async (t) => {
  const s = await seat(t);
  const t0 = Date.parse("2026-01-01T00:00:00.000Z");
  const f = fakeDeps(t0);
  f.runs.set("lab.orchestrator", { startedAt: "2025-12-31T23:00:00.000Z" });
  const pass = async (/** @type {Record<string, any>} */ opts = {}) => {
    f.running.delete("lab.orchestrator"); // it dies after every start
    f.world.now += 60_000;
    return (await ensure(s.manifest, s.state, f.deps, opts)).filter((x) => x.position === "lab.orchestrator");
  };
  for (let i = 0; i < 3; i++) assert.deepEqual((await pass()).map((x) => x.action), ["restarted"]);
  // red leg: under a higher limit the fourth death is started too (and nothing is recorded by a dry run)
  assert.deepEqual((await pass({ dryRun: true, restartLimit: { starts: 10 } })).map((x) => x.action), ["would-restart"]);
  const held = await pass();
  assert.deepEqual(held.map((x) => x.action), ["held"]);
  assert.match(String(held[0].reason), /restart limit: 3 starts in 1h/);
  const told = f.posts.at(-1);
  assert.equal(told?.text, "lab.orchestrator: absent by host 4m; path restart; outcome held.");
  assert.match(String(told?.raw), /\nto: Ada\n/, "addressed to the room's host human, the messenger row's --human-name");
  assert.match(String(told?.raw), /ack: none$/);
  assert.equal(parseNotice(String(told?.raw))?.fields.outcome, "held");
  const posts = f.posts.length;
  assert.deepEqual((await pass()).map((x) => x.action), ["held"]);
  assert.equal(f.posts.length, posts, "told once");
  assert.equal(f.acts.filter((a) => a === "start lab.orchestrator").length, 3, "starts stopped");
  // a start by hand (a run record newer than the hold) clears it
  f.runs.set("lab.orchestrator", { startedAt: new Date(f.world.now + 1000).toISOString() });
  f.world.now += 2000;
  assert.deepEqual((await pass()).map((x) => x.action), ["restarted"]);
});

test("ensure on host tern: a Tern that does not answer is brought up once per pass before residents start into it; one that cannot be started is a failed start with one N8 line (red leg: Tern up is asked nothing more)", async (t) => {
  const s = await seat(t);
  const f = fakeDeps(Date.parse("2026-01-01T00:00:00.000Z"));
  for (const p of ["lab.orchestrator", "lab.coding"]) f.runs.set(p, { startedAt: "2025-12-31T23:00:00.000Z" });
  f.world.ternUp = false;
  let rows = await ensure(s.manifest, s.state, f.deps);
  assert.deepEqual(rows.map((x) => [x.position, x.action]), [["lab.orchestrator", "restarted"], ["lab.coding", "restarted"]]);
  assert.equal(rows[0].host, "tern started");
  assert.equal(f.world.ternCalls, 1, "once per pass");
  // Tern cannot be started: the start fails by name and spends one of the limit
  for (const p of ["lab.orchestrator", "lab.coding"]) f.running.delete(p);
  f.world.ternUp = false;
  f.world.ternStarts = false;
  rows = await ensure(s.manifest, s.state, f.deps);
  assert.deepEqual(rows.map((x) => [x.position, x.action]), [["lab.orchestrator", "failed"], ["lab.coding", "failed"]]);
  assert.match(String(rows[0].reason), /Tern did not answer/);
  assert.equal(f.posts.at(-1)?.text, "lab.coding: absent by host 0s; path restart; outcome failed.");
  assert.deepEqual((await readLedger(s.state)).filter((e) => e.outcome === "failed").map((e) => e.position), ["lab.orchestrator", "lab.coding"]);
});

test("hostHuman: the messenger row's --human-name for the room, else null", async (t) => {
  const s = await seat(t);
  assert.equal(grants.hostHuman(s.manifest, "lab"), "Ada");
  assert.equal(grants.hostHuman(s.manifest, "other"), null);
});

// ---------------------------------------------------------------------------------------------
// Tern: brought up by the cycle, started at logon on Windows
// ---------------------------------------------------------------------------------------------

test("ensureTern: a Tern that answers is left; one that does not is started by its own daemon --login and waited for; a dry run starts nothing; no Tern is said", async (t) => {
  const s = await seat(t);
  let up = true;
  const r = fakeRunner((argv) => argv[1] === "ls" ? (up ? { code: 0, stdout: "{}" } : { code: 1, stderr: "no Tern is running" }) : { code: 1 });
  /** @type {string[][]} */
  const launched = [];
  const deps = { env: s.env, platform: process.platform, run: r.fn, launch: (/** @type {string[]} */ argv) => { launched.push(argv); up = true; }, sleep: async () => {}, waitMs: 2000 };
  assert.deepEqual(await residentStart.ensureTern(deps), { up: true, started: false, reason: null });
  assert.deepEqual(launched, []);
  up = false;
  const started = await residentStart.ensureTern(deps);
  assert.deepEqual([started.up, started.started], [true, true]);
  assert.deepEqual(launched, [[path.join(s.bin, process.platform === "win32" ? "tern.exe" : "tern"), "daemon", "--login"]], "on Windows the windowed program beside the CLI, which opens no console");
  up = false;
  launched.length = 0;
  const dry = await residentStart.ensureTern({ ...deps, dryRun: true });
  assert.equal(dry.up, false);
  assert.match(String(dry.reason), /dry run/);
  assert.deepEqual(launched, []);
  const deaf = await residentStart.ensureTern({ ...deps, launch: () => {} });
  assert.equal(deaf.up, false);
  assert.match(String(deaf.reason), /did not answer within 2s/);
  const none = await residentStart.ensureTern({ ...deps, env: { PATH: path.join(s.root, "nowhere") } });
  assert.deepEqual([none.up, none.started], [false, false]);
  assert.match(String(none.reason), /tern is not installed/);
});

test("timer: a logon trigger beside the interval on every OS; check reports both, and a registered task without the logon trigger differs (red leg)", async (t) => {
  const s = await seat(t);
  const base = { home: path.join(s.root, "home"), node: "C:\\node.exe", entry: "C:\\agora\\bin\\agora.mjs", config: "C:\\agora\\config.json", stateRoot: s.state, uid: 501 };
  const win = timerSpec({ ...base, platform: "win32", user: "HOST\\grace" });
  assert.deepEqual(win.triggers, ["every PT15M", "at logon after PT2M"]);
  assert.match(win.files[0].content, /<LogonTrigger><Enabled>true<\/Enabled><UserId>HOST\\grace<\/UserId><Delay>PT2M<\/Delay><\/LogonTrigger>/);
  assert.equal(parseTaskXml(win.files[0].content).logon, "PT2M");
  const files = new Map(win.files.map((f) => [f.path, f.content]));
  files.set(win.exitFile ?? "", "0\r\n");
  const csv = `"HOST","\\agora-resident-cycle","1/1/2026 0:15:00 AM","Ready","Interactive only","1/1/2026 0:00:01 AM","0","grace","conhost.exe","N/A"\r\n`;
  const deps = (/** @type {string} */ xmlText) => ({
    run: fakeRunner((argv) => argv[0] === "reg" ? { code: 1 } : argv.includes("/XML") ? { code: 0, stdout: xmlText } : { code: 0, stdout: csv }).fn,
    readFile: async (/** @type {string} */ f) => { if (!files.has(f)) throw new Error("absent"); return String(files.get(f)); },
    writeFile: async () => {}, rm: async () => {}, mkdir: async () => {},
  });
  const ok = await runTimer("check", win, deps(win.files[0].content));
  assert.deepEqual([ok.state, ok.triggers], ["ok", ["every PT15M", "at logon after PT2M"]]);
  const old = win.files[0].content.replace(/<LogonTrigger>.*?<\/LogonTrigger>/, "");
  const differs = await runTimer("check", win, deps(old));
  assert.equal(differs.state, "differs");
  assert.match(differs.problems.join(" "), /it has no logon trigger; timer install adds one/);

  const linux = timerSpec({ ...base, platform: "linux", node: "/n", entry: "/a", config: "/c" });
  assert.match(linux.files[1].content, /^OnStartupSec=2min$/m, "the user's timers start with the user's session");
  assert.doesNotMatch(linux.files[1].content, /OnBootSec/);
  assert.deepEqual(linux.triggers, ["every 15min", "at login after 2min"]);
  const mac = timerSpec({ ...base, platform: "darwin", node: "/n", entry: "/a", config: "/c" });
  assert.match(mac.files[0].content, /<key>RunAtLoad<\/key><true\/>/);
  assert.deepEqual(mac.triggers, ["every 900s", "at login"]);
});

test("timer: on Windows, Tern starts at logon: install adds agora's Run entry unless Tern's own Start at login is on; check reports it; remove deletes agora's alone (red legs: no Tern row needs nothing; Tern's own entry is never touched)", async (t) => {
  const s = await seat(t);
  const base = { platform: "win32", home: path.join(s.root, "home"), node: "C:\\node.exe", entry: "C:\\agora\\bin\\agora.mjs", config: "C:\\agora\\config.json", stateRoot: s.state, user: "HOST\\grace" };
  const spec = timerSpec({ ...base, tern: "C:\\T\\tern.exe" });
  const RUN = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
  const APPROVED = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";
  assert.deepEqual(spec.login, { name: "agora-tern-daemon", key: RUN, approved: APPROVED, data: '"C:\\T\\tern.exe" daemon --login' });
  const files = new Map(spec.files.map((f) => [f.path, f.content]));
  files.set(spec.exitFile ?? "", "0\r\n");
  const csv = `"HOST","\\agora-resident-cycle","1/1/2026 0:15:00 AM","Ready","Interactive only","1/1/2026 0:00:01 AM","0","grace","conhost.exe","N/A"\r\n`;
  /** @type {Map<string, string>} the Run key's values */
  const values = new Map([["OneDrive", '"C:\\OneDrive.exe" /background']]);
  /** @type {string | null} */
  let approved = null;
  const answer = (/** @type {string[]} */ argv) => {
    if (argv[0] === "reg") {
      if (argv[1] === "query" && argv[2] === RUN) return { code: 0, stdout: `\r\n${RUN.replace("HKCU", "HKEY_CURRENT_USER")}\r\n${[...values].map(([k, v]) => `    ${k}    REG_SZ    ${v}`).join("\r\n")}\r\n\r\n` };
      if (argv[1] === "query" && argv[2] === APPROVED) return approved ? { code: 0, stdout: `\r\n${APPROVED}\r\n    agora-tern-daemon    REG_BINARY    ${approved}\r\n` } : { code: 1, stderr: "ERROR: The system was unable to find the specified registry key or value." };
      if (argv[1] === "add") { values.set(argv[argv.indexOf("/v") + 1], argv[argv.indexOf("/d") + 1]); return { code: 0 }; }
      if (argv[1] === "delete") { const had = values.delete(argv[argv.indexOf("/v") + 1]); return { code: had || argv[2] === APPROVED ? 0 : 1 }; }
      return { code: 1 };
    }
    if (argv.includes("/XML")) return { code: 0, stdout: spec.files[0].content };
    return { code: 0, stdout: csv };
  };
  const r = fakeRunner(answer);
  const deps = { run: r.fn, readFile: async (/** @type {string} */ f) => { if (!files.has(f)) throw new Error("absent"); return String(files.get(f)); }, writeFile: async () => {}, rm: async () => {}, mkdir: async () => {}, sleep: async () => {} };

  const before = await runTimer("check", spec, deps);
  assert.equal(before.state, "differs", "the task is right but Tern would not start at logon");
  assert.deepEqual([before.login?.state, before.login?.name], ["missing", "agora-tern-daemon"]);
  assert.match(before.problems.join(" "), /Tern does not start at logon; timer install adds it/);

  const installed = await runTimer("install", spec, deps);
  assert.equal(installed.state, "installed");
  assert.deepEqual(r.calls.filter((c) => c[0] === "reg" && c[1] === "add"), [["reg", "add", RUN, "/v", "agora-tern-daemon", "/t", "REG_SZ", "/d", '"C:\\T\\tern.exe" daemon --login', "/f"]]);
  assert.equal(installed.check?.login?.state, "agora");
  assert.equal(installed.check?.state, "ok");

  approved = "030000000000000000000000";
  const off = await runTimer("check", spec, deps);
  assert.deepEqual([off.state, off.login?.state], ["differs", "disabled"]);
  assert.match(off.problems.join(" "), /turned off in Task Manager's Startup apps/);
  approved = "020000000000000000000000";
  assert.equal((await runTimer("check", spec, deps)).login?.state, "agora", "turned back on");
  approved = null;

  // Tern's own Start at login: preferred, and never added beside nor removed
  r.calls.length = 0;
  values.delete("agora-tern-daemon");
  values.set("Tern", '"C:\\T\\tern.exe" daemon --login');
  const own = await runTimer("check", spec, deps);
  assert.deepEqual([own.state, own.login?.state, own.login?.name], ["ok", "tern", "Tern"]);
  await runTimer("install", spec, deps);
  assert.deepEqual(r.calls.filter((c) => c[0] === "reg" && c[1] === "add"), [], "Tern's own setting is preferred: nothing added beside it");
  await runTimer("remove", spec, deps);
  assert.deepEqual(r.calls.filter((c) => c[0] === "reg" && c[1] === "delete").map((c) => c[c.indexOf("/v") + 1]), ["agora-tern-daemon", "agora-tern-daemon"], "only agora's own value, and its Startup apps record");
  assert.equal(values.has("Tern"), true);

  // red leg: a manifest with no Tern row needs no entry, and says so
  values.delete("Tern");
  const plain = timerSpec({ ...base, tern: null });
  assert.equal(plain.login?.data, null);
  const none = await runTimer("check", plain, { ...deps, readFile: async (/** @type {string} */ f) => (f === plain.files[1].path ? plain.files[1].content : String(files.get(f))) });
  assert.deepEqual([none.state, none.login?.state], ["ok", "not needed"]);
});

// ---------------------------------------------------------------------------------------------
// The live context ceiling
// ---------------------------------------------------------------------------------------------

test("plan: a row's context ceiling reaches the harness as AGORA_CONTEXT_CEILING, which a manifest may not set itself; a row with none carries none (red leg)", async (t) => {
  const s = await seat(t);
  assert.equal(planResident(s.manifest, "lab.review", s.ctx).env.AGORA_CONTEXT_CEILING, "150000");
  assert.equal(planResident(s.manifest, "lab.orchestrator", s.ctx).env.AGORA_CONTEXT_CEILING, undefined);
  assert.ok(residentStart.RESERVED_ENV.includes("AGORA_CONTEXT_CEILING"));
});

test("lib: a usage's context is what the next request re-reads (input, cache read, cache write), in either harness's keys; a ceiling is due once at or past it with no request pending", () => {
  assert.deepEqual(lib.contextOfUsage({ input: 10, cacheRead: 100_000, cacheWrite: 50, output: 7 }), 100_060);
  assert.equal(lib.contextOfUsage({ input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 4 }), 6);
  assert.equal(lib.contextOfUsage({ input: 0, output: 0 }), null, "an empty usage measures nothing");
  assert.equal(lib.contextOfUsage(null), null);
  assert.equal(lib.contextCeiling("150000"), 150_000);
  assert.equal(lib.contextCeiling(""), null);
  assert.equal(lib.contextCeiling("150K"), null);
  assert.equal(lib.ceilingDue({ ceiling: 150_000, context: 150_000, pending: false }), true);
  assert.equal(lib.ceilingDue({ ceiling: 150_000, context: 149_999, pending: false }), false, "red leg: under it");
  assert.equal(lib.ceilingDue({ ceiling: 150_000, context: 200_000, pending: true }), false, "a pending request carries it");
  assert.equal(lib.ceilingDue({ ceiling: null, context: 900_000, pending: false }), false);
  assert.equal(lib.ceilingDue({ ceiling: 150_000, context: null, pending: false }), false);
});

test("cli: resident succeed --ceiling writes a ceiling's request (any claim defers it) once; a second ask while it is pending leaves it (red leg: a plain succeed carries no ceiling)", async (t) => {
  const s = await seat(t);
  const env = { AGORA_CONFIG: s.config, AGORA_STATE: s.state, AGORA_SESSION: "omp-r1" };
  let r = await agora(["resident", "succeed", "lab.review", "--ceiling", "150000", "--json"], env);
  assert.equal(r.code, 0, r.stderr);
  const first = await readSucceedRequest(s.state, "lab.review");
  assert.deepEqual([first?.ceiling, first?.by], [150_000, "omp-r1"]);
  r = await agora(["resident", "succeed", "lab.review", "--ceiling", "150000", "--json"], env);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout.trim()).already, true);
  assert.equal((await readSucceedRequest(s.state, "lab.review"))?.at, first?.at, "the pending request is left as it was");
  r = await agora(["resident", "succeed", "lab.review", "--ceiling", "0"], env);
  assert.equal(r.code, 2);
  r = await agora(["resident", "succeed", "lab.coding", "--json"], env);
  assert.equal(r.code, 0, r.stderr);
  assert.equal((await readSucceedRequest(s.state, "lab.coding"))?.ceiling, undefined);
});

test("residentState after a reboot: a dead standing row reads as not running with its run record kept", async (t) => {
  const s = await seat(t);
  const file = runFilePath(s.state, "lab.orchestrator");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ type: "resident-run", id: "r0", resident: "lab.orchestrator", host: "tmux", startedAt: "2020-01-01T00:00:00.000Z", hostInfo: { tmux: "tmux", server: "s", session: "x" }, handle: { server: "s", session: "x" }, exec: { argv: [], env: {}, cwd: s.root } }));
  const st = await residentState(s.state, "lab.orchestrator", { run: fakeRunner(() => ({ code: 0 })).fn });
  assert.deepEqual([st.running, st.host, Boolean(st.run)], [false, "gone", true]);
  assert.equal(JSON.parse(await readFile(file, "utf8")).id, "r0");
});
