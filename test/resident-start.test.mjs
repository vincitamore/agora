// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RESERVED_ENV, defaultBearer, firstPrompt, hostAlive, ompOverlay, parseTaskXml, planResident, readRun, residentState, restartResident,
  runFilePath, runTimer, startResident, stopResident, substituteVars, timerSpec, validateManifest, which,
} from "../src/resident-start.mjs";
import { writeRecord } from "../src/session.mjs";
import { modelLabel } from "../plugins/omp/agora-room/index.mjs";

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

/** A manifest with two positions, a shared default block, vars and a model alias. */
function manifestDoc() {
  return {
    version: 1,
    models: { small: "vendor/claude-haiku-9:medium" },
    vars: { HOME_DIR: { path: "." }, TEAM: "desk" },
    defaults: {
      harness: "omp", model: "small", rooms: ["lab"], profile: "PROFILE.md", host: "tern",
      append: ["extra.md"], skills: { dir: "skills", names: ["beta", "alpha"] },
      workdir: { files: { "NOTES.md": ["HOME.md", { text: "team {{TEAM}} at {{HOME_DIR}}" }], ".marker": [{ text: "{{HOME_DIR}}" }] } },
      env: { SEAT_MARKER: "desk" }, preamble: "off",
    },
    residents: {
      "desk.messenger": { role: "messenger", wake: "all" },
      "desk.coding": { role: "coding", wake: "mine", harness: "claude", model: "claude-sonnet-9", host: "none" },
    },
  };
}

/** A seat in a temp root: config, state, manifest folder, fake executables on a PATH of their own.
 * @param {import("node:test").TestContext} t */
async function seat(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-rstart-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const state = path.join(root, "state");
  const home = path.join(root, "home");
  const mdir = path.join(root, "team");
  const bin = path.join(root, "bin");
  await mkdir(path.join(mdir, "skills", "alpha"), { recursive: true });
  await mkdir(path.join(mdir, "skills", "beta"), { recursive: true });
  await mkdir(bin, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(path.join(mdir, "skills", "alpha", "SKILL.md"), "alpha\n");
  await writeFile(path.join(mdir, "skills", "beta", "SKILL.md"), "beta\n");
  await writeFile(path.join(mdir, "PROFILE.md"), "# Ada\n\nThe profile.\n");
  await writeFile(path.join(mdir, "extra.md"), "Extra layer.\r\n");
  await writeFile(path.join(mdir, "HOME.md"), "Home of {{TEAM}}.\n");
  const manifestFile = path.join(mdir, "residents.json");
  await writeFile(manifestFile, JSON.stringify(manifestDoc(), null, 2));
  for (const n of ["omp", "claude", "tern", "tmux"]) for (const ext of ["", ".exe", ".com"]) await writeFile(path.join(bin, n + ext), "");
  const config = path.join(root, "config.json");
  const cfg = { actor: { name: "Grace", kind: "agent" }, rooms: { lab: { transport: "local", path: path.join(root, "lab.ndjson") }, other: { transport: "local", path: path.join(root, "other.ndjson") } } };
  await writeFile(config, JSON.stringify(cfg));
  const env = { PATH: bin, PATHEXT: ".COM;.EXE" };
  return { root, state, home, mdir, bin, manifestFile, config, cfg: { ...cfg, path: config }, env };
}

/** @param {Awaited<ReturnType<typeof seat>>} s @param {Record<string, unknown>} [extra] */
function ctxOf(s, extra = {}) {
  return { cfg: s.cfg, stateRoot: s.state, checkout: CHECKOUT, entry: BIN, node: "node-bin", env: s.env, platform: process.platform, home: s.home, ...extra };
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

/** `tern ls --json` with one session whose block is live or exited. @param {number} id @param {boolean} live */
const ternLs = (id, live) => JSON.stringify({ sessions: [{ id, name: "x", tabs: [{ id: id + 1, blocks: [{ id: id + 2, live, exited: live ? null : 0 }] }] }], detached: [] });

// ---------------------------------------------------------------------------------------------

test("manifest: defaults merge, paths resolve against the manifest, aliases and vars are kept", async (t) => {
  const s = await seat(t);
  const m = validateManifest(manifestDoc(), s.manifestFile);
  assert.deepEqual(Object.keys(m.residents), ["desk.messenger", "desk.coding"]);
  const msg = m.residents["desk.messenger"];
  assert.equal(msg.harness, "omp");
  assert.equal(msg.wake, "all");
  assert.equal(msg.profile, path.join(s.mdir, "PROFILE.md"));
  assert.deepEqual(msg.append, [path.join(s.mdir, "extra.md")]);
  assert.deepEqual(msg.skills, { dir: path.join(s.mdir, "skills"), names: ["alpha", "beta"] }, "skill names sorted and deduplicated");
  assert.deepEqual(msg.workdir.files.map((f) => f.path), ["NOTES.md", ".marker"]);
  assert.deepEqual(msg.workdir.files[0].parts[0], { file: path.join(s.mdir, "HOME.md") });
  assert.equal(m.residents["desk.coding"].harness, "claude", "a row overrides its defaults");
  assert.equal(m.models.small, "vendor/claude-haiku-9:medium");
  assert.equal(m.vars.HOME_DIR, s.mdir.replace(/\\/g, "/"));
  assert.equal(substituteVars("{{TEAM}} {{NOPE}}", m.vars), "desk {{NOPE}}", "only declared vars are replaced");
});

test("manifest: every refusal names the file and the field", async (t) => {
  const s = await seat(t);
  /** @param {(d: any) => void} mutate @param {RegExp} re */
  const refuses = (mutate, re) => {
    const d = manifestDoc();
    mutate(d);
    assert.throws(() => validateManifest(d, s.manifestFile), (e) => {
      const msg = /** @type {Error} */ (e).message;
      assert.ok(msg.startsWith(s.manifestFile), `names the file: ${msg}`);
      assert.match(msg, re);
      return true;
    });
  };
  refuses((d) => { d.extra = 1; }, /extra: unknown key/);
  refuses((d) => { d.version = 2; }, /version: must be 1/);
  refuses((d) => { d.residents = {}; }, /residents: must name at least one resident/);
  refuses((d) => { d.residents["Desk Coding"] = { role: "coding" }; }, /residents\.Desk Coding: a resident key is its position/);
  refuses((d) => { d.residents["desk.coding"].colour = "red"; }, /residents\.desk\.coding\.colour: unknown field/);
  refuses((d) => { delete d.defaults.host; }, /residents\.desk\.messenger\.host: is required/);
  refuses((d) => { d.residents["desk.coding"].harness = "codex"; }, /desk\.coding\.harness: must be one of omp, claude/);
  refuses((d) => { d.residents["desk.coding"].host = "screen"; }, /desk\.coding\.host: must be one of tern, tmux, none/);
  refuses((d) => { d.residents["desk.coding"].wake = "some"; }, /desk\.coding\.wake: must be one of all, addressed, mine/);
  refuses((d) => { d.residents["desk.coding"].rooms = []; }, /desk\.coding\.rooms: must name at least one room/);
  refuses((d) => { d.residents["desk.coding"].role = "Coding Lead"; }, /desk\.coding\.role: a role is one segment/);
  refuses((d) => { d.residents["desk.coding"].env = { AGORA_LABEL: "x" }; }, /env\.AGORA_LABEL: is set by agora resident start itself/);
  refuses((d) => { d.residents["desk.coding"].env = { SLACK_TOKEN: "x" }; }, /env\.SLACK_TOKEN: looks like a credential/);
  refuses((d) => { d.residents["desk.coding"].workdir = { files: { "../escape.md": [{ text: "x" }] } }; }, /workdir\.files\.\.\.\/escape\.md: must be a path inside the working folder/);
  refuses((d) => { d.residents["desk.coding"].workdir = { files: { "a.md": [{ texts: "x" }] } }; }, /a part is a path/);
  refuses((d) => { d.residents["desk.coding"].skills = { dir: "skills", names: ["../up"] }; }, /skills\.names: must be a list of skill folder names/);
  refuses((d) => { d.vars = { lower: "x" }; }, /vars\.lower: a var name is upper-case/);
  refuses((d) => { d.residents["desk.coding"].bearer = "has space"; }, /bearer: a bearer is letters/);
  assert.ok(RESERVED_ENV.includes("AGORA_ROOM_CMD"));
});

test("plan: omp under tern carries the extension overlay, the role env and a host command that re-enters start --run", async (t) => {
  const s = await seat(t);
  const m = validateManifest(manifestDoc(), s.manifestFile);
  const p = planResident(m, "desk.messenger", ctxOf(s, { env: { ...s.env, TERN_WINDOW_KEY: "w1" } }));
  assert.equal(p.model, "vendor/claude-haiku-9:medium", "the alias resolves");
  assert.equal(p.bearer, "messenger/Haiku");
  assert.equal(p.bearer, `messenger/${modelLabel(p.model)}`, "the bearer is named as the omp extension names it");
  assert.equal(p.workdir, path.join(s.state, "residents", "desk.messenger", "work"));
  assert.deepEqual(p.files, [{ path: path.join(p.workdir, "NOTES.md"), parts: m.residents["desk.messenger"].workdir.files[0].parts }, { path: path.join(p.workdir, ".marker"), parts: m.residents["desk.messenger"].workdir.files[1].parts }]);
  const ompExe = which("omp", { env: s.env });
  assert.ok(ompExe);
  assert.deepEqual(p.argv, [ompExe, "--append-system-prompt", path.join(p.dir, "prompt.md"), "--config", path.join(p.dir, "omp-config.yml"), "--approval-mode", "yolo", "--model", p.model, "--skills", "alpha,beta", p.firstPrompt]);
  assert.equal(p.firstPrompt, firstPrompt({ slug: "desk.messenger", role: "messenger", bearer: "messenger/Haiku", rooms: ["lab"], wake: "all", harness: "omp" }));
  assert.match(p.firstPrompt, /arm none\. Run the arming sequence in your profile now/);
  assert.deepEqual(p.env, {
    SEAT_MARKER: "desk", AGORA_CONFIG: s.config, AGORA_STATE: s.state, AGORA_LABEL: "desk.messenger", AGORA_ROOM: "lab", AGORA_ROOM_WAKE: "all",
    AGORA_ROOM_CMD: JSON.stringify(["node-bin", BIN]), AGORA_ROOM_PREAMBLE: "off", AGORA_ROLE: "messenger",
  });
  assert.equal(p.overlayText, ompOverlay(path.join(CHECKOUT, "plugins", "omp", "agora-room").replace(/\\/g, "/"), path.join(s.mdir, "skills").replace(/\\/g, "/")));
  assert.match(String(p.overlayText), /^extensions:\n {2}- ".*plugins\/omp\/agora-room"\nskills:\n {2}customDirectories:\n {4}- ".*skills"\n$/);
  assert.equal(p.skills?.mode, "overlay");
  assert.equal(p.trust, null);
  const tern = which("tern", { env: s.env });
  assert.deepEqual(p.hostArgv, [tern, "new", "session", "desk.messenger", "--json", "--window", "w1", "--cwd", p.workdir, "--", "node-bin", BIN, "resident", "start", "desk.messenger", "--run", runFilePath(s.state, "desk.messenger"), "--config", s.config]);
});

test("plan: claude under none signs through AGORA_ACTOR, loads the plugin dir, copies skills and trusts the folder", async (t) => {
  const s = await seat(t);
  const m = validateManifest(manifestDoc(), s.manifestFile);
  const p = planResident(m, "desk.coding", ctxOf(s));
  assert.equal(p.host, "none");
  assert.equal(p.hostArgv, null);
  assert.equal(p.bearer, "coding/Sonnet");
  assert.equal(p.env.AGORA_ACTOR, "coding/Sonnet");
  assert.equal(p.env.AGORA_ROLE, undefined);
  assert.equal(p.overlay, null);
  assert.equal(p.skills?.mode, "copy");
  assert.equal(p.trust, p.workdir);
  assert.deepEqual(p.argv.slice(1, -1), ["--system-prompt", ".", "--append-system-prompt-file", path.join(p.dir, "prompt.md"), "--plugin-dir", path.join(CHECKOUT, "plugins", "claude", "agora-room"), "--dangerously-skip-permissions", "--model", "claude-sonnet-9"]);
  assert.match(p.firstPrompt, /agora-room plugin owns your watch/);
});

test("plan: overrides, tmux, an explicit bearer, and the named refusals", async (t) => {
  const s = await seat(t);
  const doc = manifestDoc();
  doc.residents["desk.messenger"] = /** @type {any} */ ({ role: "messenger", wake: "all", bearer: "Ada/desk", host: "tmux", thinking: "low", args: ["--no-rules"] });
  const m = validateManifest(doc, s.manifestFile);
  const p = planResident(m, "desk.messenger", ctxOf(s, { room: "other", model: "vendor/gpt-7-sol" }));
  assert.deepEqual(p.rooms, ["other"], "--room replaces the rooms");
  assert.equal(p.name, "desk.messenger (other)");
  assert.equal(p.model, "vendor/gpt-7-sol");
  assert.equal(p.bearer, "Ada/desk");
  assert.equal(p.env.AGORA_ACTOR, "Ada/desk", "an explicit bearer signs through AGORA_ACTOR even on omp");
  assert.equal(p.env.AGORA_ROLE, undefined);
  assert.deepEqual(p.argv.slice(-6), ["--thinking", "low", "--skills", "alpha,beta", "--no-rules", p.firstPrompt], "thinking, skills, then the row's args, then the first prompt last");
  const tmux = which("tmux", { env: s.env });
  assert.deepEqual(p.hostArgv?.slice(0, 9), [tmux, "-L", "agora-resident-desk.messenger", "new-session", "-d", "-s", "desk.messenger", "-c", p.workdir]);
  assert.equal(defaultBearer("review", "vendor/gpt-7-sol"), "review/Sol");

  assert.throws(() => planResident(m, "desk.nobody", ctxOf(s)), /no resident "desk\.nobody"/);
  assert.throws(() => planResident(m, "desk.messenger", ctxOf(s, { room: "elsewhere" })), /room "elsewhere" is not in the agora config \(have: lab, other\)/);
  assert.throws(() => planResident(m, "desk.messenger", ctxOf(s, { host: "screen" })), /--host takes tern, tmux, none/);
  assert.throws(() => planResident(m, "desk.messenger", ctxOf(s, { env: { PATH: path.join(s.root, "empty") } })), /omp is not on PATH/);
  const shim = path.win32.join("C:\\tools", "omp.cmd");
  const onlyShim = (/** @type {string} */ f) => f.toLowerCase() === shim.toLowerCase();
  assert.throws(() => planResident(m, "desk.messenger", ctxOf(s, { platform: "win32", env: { PATH: "C:\\tools", PATHEXT: ".CMD" }, exists: onlyShim })), /is a batch shim/);
});

test("start: renders, builds the folder, records the tern handle; a second start finds it running and starts nothing", async (t) => {
  const s = await seat(t);
  const m = validateManifest(manifestDoc(), s.manifestFile);
  const p = planResident(m, "desk.messenger", ctxOf(s));
  let alive = true;
  const r = fakeRunner((argv) => {
    if (argv[1] === "new") return { code: 0, stdout: JSON.stringify({ session: 41, tab: 42, block: 43 }) };
    if (argv[1] === "ls") return { code: 0, stdout: ternLs(41, alive) };
    return { code: 0 };
  });
  const first = await startResident(p, s.state, { checkout: CHECKOUT, run: r.fn, home: s.home });
  assert.equal(first.row.action, "started");
  assert.deepEqual(first.row.handle, { session: 41, tab: 42, block: 43 });
  assert.equal(first.exec, undefined);
  assert.deepEqual(r.calls.map((c) => c[1]), ["new"], "one host call, the start");

  const prompt = await readFile(p.prompt.file, "utf8");
  assert.ok(prompt.startsWith("# Ada\n\nThe profile.\n"), "the profile first");
  assert.match(prompt, /## Room mechanics/, "the room-mechanics block appended");
  assert.ok(prompt.endsWith("\n\nExtra layer.\n"), "the appended file last, LF endings");
  assert.equal(await readFile(path.join(p.workdir, "NOTES.md"), "utf8"), `Home of desk.\n\nteam desk at ${s.mdir.replace(/\\/g, "/")}\n`);
  assert.equal(await readFile(path.join(p.workdir, ".marker"), "utf8"), `${s.mdir.replace(/\\/g, "/")}\n`);
  assert.equal(await readFile(String(p.overlay), "utf8"), p.overlayText);
  assert.equal(existsSync(path.join(p.workdir, ".claude")), false, "omp copies no skills: the overlay names their folder");
  const rec = await readRun(s.state, "desk.messenger");
  assert.equal(rec?.host, "tern");
  assert.deepEqual(rec?.handle, { session: 41, tab: 42, block: 43 });
  assert.deepEqual(rec?.exec, { argv: p.argv, env: p.env, cwd: p.workdir });

  const second = await startResident(p, s.state, { checkout: CHECKOUT, run: r.fn, home: s.home });
  assert.equal(second.row.action, "running");
  assert.match(String(second.row.reason), /the tern handle of the last start is running/);
  assert.equal(r.calls.filter((c) => c[1] === "new").length, 1, "idempotent: no second session");

  // the session ended: the next start clears the leftover and starts again
  alive = false;
  const third = await startResident(p, s.state, { checkout: CHECKOUT, run: r.fn, home: s.home });
  assert.equal(third.row.action, "started");
  assert.deepEqual(r.calls.filter((c) => c[1] === "kill").map((c) => c.slice(1, 4)), [["kill", "session", "41"]], "the empty host session was removed");
});

test("start: a live session record that holds the position is a running resident, whatever started it", async (t) => {
  const s = await seat(t);
  const m = validateManifest(manifestDoc(), s.manifestFile);
  const dir = path.join(s.state, "sessions", "omp-abc");
  await mkdir(dir, { recursive: true });
  await writeRecord(dir, /** @type {any} */ ({ slug: "omp-abc", source: "OMP_SESSION_ID" }), { bearer: "messenger/Haiku", label: "desk.messenger", pid: process.pid, pidSource: "OMP_PID" });
  const st = await residentState(s.state, "desk.messenger");
  assert.equal(st.running, true);
  assert.deepEqual(st.sessions, ["omp-abc"]);
  const r = fakeRunner(() => ({ code: 0, stdout: "{}" }));
  const res = await startResident(planResident(m, "desk.messenger", ctxOf(s)), s.state, { checkout: CHECKOUT, run: r.fn });
  assert.equal(res.row.action, "running");
  assert.match(String(res.row.reason), /live session omp-abc holds the position/);
  assert.equal(r.calls.length, 0, "the host was never asked");
  assert.equal(existsSync(runFilePath(s.state, "desk.messenger")), false);
});

test("start: claude on host none copies skills, trusts the folder in a temp home, and hands back the foreground exec", async (t) => {
  const s = await seat(t);
  const m = validateManifest(manifestDoc(), s.manifestFile);
  const p = planResident(m, "desk.coding", ctxOf(s));
  await writeFile(path.join(s.home, ".claude.json"), JSON.stringify({ keep: true }));
  const res = await startResident(p, s.state, { checkout: CHECKOUT, home: s.home });
  assert.equal(res.row.action, "started");
  assert.equal(typeof res.exec, "function", "the caller runs the harness in its own terminal");
  assert.equal(await readFile(path.join(p.workdir, ".claude", "skills", "alpha", "SKILL.md"), "utf8"), "alpha\n");
  assert.equal(await readFile(path.join(p.workdir, ".claude", "skills", "beta", "SKILL.md"), "utf8"), "beta\n");
  const trusted = JSON.parse(await readFile(path.join(s.home, ".claude.json"), "utf8"));
  assert.equal(trusted.keep, true, "the rest of the file is kept");
  assert.equal(trusted.projects[p.workdir.replace(/\\/g, "/")].hasTrustDialogAccepted, true);
  const rec = await readRun(s.state, "desk.coding");
  assert.equal(rec?.host, "none");
  assert.equal(rec?.handle, null, "no pid until the harness is spawned");
  const st = await residentState(s.state, "desk.coding");
  assert.equal(st.running, true, "a fresh handle-less record holds the position for the lock's bound");
});

test("stop: by the recorded handle, waiting until it is gone; nothing recorded is nothing to stop", async (t) => {
  const s = await seat(t);
  const m = validateManifest(manifestDoc(), s.manifestFile);
  const p = planResident(m, "desk.messenger", ctxOf(s));
  let alive = true;
  const r = fakeRunner((argv) => {
    if (argv[1] === "new") return { code: 0, stdout: JSON.stringify({ session: 7, tab: 8, block: 9 }) };
    if (argv[1] === "ls") return { code: 0, stdout: ternLs(7, alive) };
    if (argv[1] === "kill") { alive = false; return { code: 0, stdout: JSON.stringify({ session: 7 }) }; }
    return { code: 1 };
  });
  await startResident(p, s.state, { checkout: CHECKOUT, run: r.fn });
  const run = await readRun(s.state, "desk.messenger");
  assert.equal(await hostAlive(/** @type {any} */ (run), { run: r.fn }), "live");
  const stopped = await stopResident(s.state, "desk.messenger", { run: r.fn, sleep: async () => {} });
  assert.equal(stopped.action, "stopped");
  assert.deepEqual(r.calls.filter((c) => c[1] === "kill").map((c) => c.slice(1, 5)), [["kill", "session", "7", "--json"]]);
  assert.equal(existsSync(runFilePath(s.state, "desk.messenger")), false, "the run record is removed");
  assert.equal((await stopResident(s.state, "desk.messenger", { run: r.fn })).action, "none");
});

test("restart: the cycle's built-in restart stops by the handle and starts again", async (t) => {
  const s = await seat(t);
  const m = validateManifest(manifestDoc(), s.manifestFile);
  let session = 100;
  /** @type {Set<number>} */
  const live = new Set();
  const r = fakeRunner((argv) => {
    if (argv[1] === "new") { session += 1; live.add(session); return { code: 0, stdout: JSON.stringify({ session, tab: 0, block: 0 }) }; }
    if (argv[1] === "ls") return { code: 0, stdout: JSON.stringify({ sessions: [...live].map((id) => ({ id, tabs: [{ blocks: [{ live: true, exited: null }] }] })) }) };
    if (argv[1] === "kill") { live.delete(Number(argv[3])); return { code: 0 }; }
    return { code: 1 };
  });
  const ctx = ctxOf(s);
  await startResident(planResident(m, "desk.messenger", ctx), s.state, { checkout: CHECKOUT, run: r.fn });
  const res = await restartResident(m, "desk.messenger", ctx, { checkout: CHECKOUT, run: r.fn, sleep: async () => {} });
  assert.deepEqual(res, { code: 0, err: "" });
  assert.deepEqual([...live], [102], "the old session is gone and one new one runs");
  const none = await restartResident(m, "desk.coding", ctx, { checkout: CHECKOUT, run: r.fn });
  assert.equal(none.code, 1);
  assert.match(none.err, /host none; give it a restart command/);
});

test("timer: one spec per OS, and check reads without writing", async (t) => {
  const s = await seat(t);
  const base = { home: s.home, node: "/opt/node/bin/node", entry: "/opt/agora/bin/agora.mjs", config: "/home/grace/.agora/config.json", stateRoot: s.state, uid: 501 };

  const win = timerSpec({ ...base, platform: "win32", node: "C:\\Program Files\\nodejs\\node.exe", entry: "C:\\agora\\bin\\agora.mjs", config: "C:\\agora\\config.json" });
  assert.equal(win.kind, "schtasks");
  assert.deepEqual(win.install, [["schtasks", "/Create", "/TN", "agora-resident-cycle", "/XML", win.files[0].path, "/F"]]);
  assert.deepEqual(win.check, [["schtasks", "/Query", "/TN", "agora-resident-cycle", "/XML", "ONE"]]);
  assert.deepEqual(win.remove, [["schtasks", "/Delete", "/TN", "agora-resident-cycle", "/F"]]);
  assert.equal(win.files[0].temporary, true);
  assert.equal(win.expect?.arguments, `--headless "C:\\Program Files\\nodejs\\node.exe" C:\\agora\\bin\\agora.mjs resident cycle --all --config C:\\agora\\config.json`);
  assert.deepEqual(parseTaskXml(win.files[0].content), { command: "conhost.exe", arguments: win.expect?.arguments, interval: "PT15M" });
  assert.match(win.files[0].content, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(win.files[0].content, /<LogonType>InteractiveToken<\/LogonType>/, "runs in the user's session, where Tern is");

  const linux = timerSpec({ ...base, platform: "linux", seconds: 600 });
  assert.equal(linux.kind, "systemd");
  assert.deepEqual(linux.files.map((f) => path.basename(f.path)), ["agora-resident-cycle.service", "agora-resident-cycle.timer"]);
  assert.equal(path.dirname(linux.files[0].path), path.join(s.home, ".config", "systemd", "user"));
  assert.match(linux.files[0].content, /^ExecStart=\/bin\/sh -lc "exec '\/opt\/node\/bin\/node' '\/opt\/agora\/bin\/agora\.mjs' 'resident' 'cycle' '--all' '--config' '\/home\/grace\/\.agora\/config\.json'"$/m);
  assert.match(linux.files[1].content, /^OnUnitActiveSec=10min$/m);
  assert.deepEqual(linux.install, [["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", "--now", "agora-resident-cycle.timer"]]);
  assert.deepEqual(linux.remove, [["systemctl", "--user", "disable", "--now", "agora-resident-cycle.timer"], ["systemctl", "--user", "daemon-reload"]]);

  const mac = timerSpec({ ...base, platform: "darwin", manifest: "/home/grace/team/residents.json" });
  assert.equal(mac.kind, "launchd");
  assert.equal(mac.files[0].path, path.join(s.home, "Library", "LaunchAgents", "agora.resident-cycle.plist"));
  assert.match(mac.files[0].content, /<key>StartInterval<\/key><integer>900<\/integer>/);
  assert.match(mac.files[0].content, /'--manifest' '\/home\/grace\/team\/residents\.json'/);
  assert.deepEqual(mac.install, [["launchctl", "bootout", "gui/501/agora.resident-cycle"], ["launchctl", "bootstrap", "gui/501", mac.files[0].path]]);

  assert.throws(() => timerSpec({ ...base, platform: "linux", seconds: 90 }), /whole minutes/);
  assert.throws(() => timerSpec({ ...base, platform: "linux", config: "/home/it's/config.json" }), /cannot carry/);

  // check: a registered task with the same command is ok; another command differs; absent is missing
  /** @type {string[]} */
  const writes = [];
  const deps = (/** @type {(argv: string[]) => { code: number, stdout?: string }} */ answer) => ({
    run: fakeRunner(answer).fn,
    writeFile: async (/** @type {string} */ f) => { writes.push(f); },
    rm: async (/** @type {string} */ f) => { writes.push(`rm ${f}`); },
    mkdir: async () => {},
    readFile: async () => { throw new Error("absent"); },
  });
  const utf16 = (/** @type {string} */ text) => text.split("").join("\u0000");
  assert.equal((await runTimer("check", win, deps(() => ({ code: 0, stdout: utf16(win.files[0].content) })))).state, "ok");
  const differs = await runTimer("check", win, deps(() => ({ code: 0, stdout: win.files[0].content.replace("PT15M", "PT5M") })));
  assert.equal(differs.state, "differs");
  assert.match(differs.problems.join(" "), /its interval is PT5M, not PT15M/);
  assert.equal((await runTimer("check", win, deps(() => ({ code: 1 })))).state, "missing");
  assert.equal((await runTimer("check", linux, deps(() => ({ code: 0 })))).state, "missing");
  assert.deepEqual(writes, [], "check writes nothing");

  const installed = await runTimer("install", win, deps(() => ({ code: 0 })));
  assert.equal(installed.state, "installed");
  assert.deepEqual(writes, [win.files[0].path, `rm ${win.files[0].path}`], "the XML is written, used, and removed");
  writes.length = 0;
  const contents = new Map(linux.files.map((f) => [f.path, f.content]));
  const linuxOk = await runTimer("check", linux, { ...deps(() => ({ code: 0, stdout: "enabled" })), readFile: async (f) => String(contents.get(f)) });
  assert.equal(linuxOk.state, "ok");
  assert.deepEqual(linuxOk.ran.map((x) => x.argv.slice(2, 3)), [["is-enabled"], ["is-active"]]);
});

test("cli: --plan prints per harness and host without writing; cycle --all takes the manifest's residents", async (t) => {
  const s = await seat(t);
  const env = { ...s.env, AGORA_CONFIG: s.config, AGORA_STATE: s.state };
  let r = await agora(["resident", "start", "--all", "--plan", "--json", "--manifest", s.manifestFile, "--host", "tern"], env);
  assert.equal(r.code, 0, r.stderr);
  const rows = r.stdout.trim().split("\n").map((/** @type {string} */ l) => JSON.parse(l));
  assert.deepEqual(rows.map((/** @type {any} */ x) => [x.resident, x.harness, x.host, x.state]), [["desk.messenger", "omp", "tern", "would-start"], ["desk.coding", "claude", "tern", "would-start"]]);
  assert.equal(rows[0].hostArgv[1], "new");
  assert.equal(rows[0].files.length, 2);
  assert.equal(existsSync(path.join(s.state, "residents")), false, "--plan writes nothing");

  r = await agora(["resident", "start", "desk.coding", "--plan", "--manifest", s.manifestFile], env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^desk\.coding: would-start\n {2}claude claude-sonnet-9 as coding\/Sonnet, position desk\.coding, rooms lab \(wake mine\), host none/);
  assert.match(r.stdout, /trusts {3}.* in ~\/\.claude\.json/);

  r = await agora(["resident", "start", "--all", "--manifest", s.manifestFile], env);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /host none runs one resident in this terminal/);
  r = await agora(["resident", "start", "desk.messenger", "--plan", "--manifest", path.join(s.root, "missing.json")], env);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no resident manifest at/);
  r = await agora(["resident", "start", "desk.messenger", "--plan", "--room", "nowhere", "--manifest", s.manifestFile], env);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /room "nowhere" is not in the agora config/);
  r = await agora(["resident", "launch"], env);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /takes prompt, start, stop, timer, cycle or inherit/);

  r = await agora(["resident", "cycle", "--all", "--dry-run", "--json", "--manifest", s.manifestFile], env);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n").map((/** @type {string} */ l) => JSON.parse(l)).map((/** @type {any} */ x) => [x.resident, x.action]), [["desk.messenger", "none"], ["desk.coding", "none"]]);
  r = await agora(["resident", "stop", "desk.messenger", "--json"], env);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).action, "none");
});

test("cli: start --run runs the recorded harness with its environment and folder, needing no manifest", async (t) => {
  const s = await seat(t);
  const work = path.join(s.root, "work");
  await mkdir(work);
  const out = path.join(s.root, "ran.txt");
  const file = runFilePath(s.state, "desk.alpha");
  await mkdir(path.dirname(file), { recursive: true });
  const script = "require('fs').writeFileSync(process.argv[1], process.env.AGORA_LABEL + ' ' + require('path').basename(process.cwd()))";
  const rec = { type: "resident-run", id: "r1", resident: "desk.alpha", host: "tern", startedAt: new Date().toISOString(), hostInfo: {}, handle: null, exec: { argv: [process.execPath, "-e", script, out], env: { AGORA_LABEL: "desk.alpha" }, cwd: work } };
  await writeFile(file, JSON.stringify(rec));
  const env = { ...s.env, AGORA_STATE: s.state };
  let r = await agora(["resident", "start", "desk.alpha", "--run", file, "--config", s.config], env);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(await readFile(out, "utf8"), "desk.alpha work");
  assert.equal(JSON.parse(await readFile(`${file}.pid`, "utf8")).id, "r1", "the wrapper recorded the harness pid beside the run record");
  r = await agora(["resident", "start", "desk.other", "--run", file, "--config", s.config], env);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /records resident desk\.alpha, not desk\.other/);
});
