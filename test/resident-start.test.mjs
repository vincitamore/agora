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
  RESERVED_ENV, cycleMessenger, defaultBearer, firstPrompt, hostAlive, ompOverlay, parseTaskXml, planResident, readRun, residentState, restartResident,
  runFilePath, runTimer, startResident, stopResident, substituteVars, timerSpec, validateManifest, which,
} from "../src/resident-start.mjs";
import { DEFAULT_BOUNDS, runStream } from "../src/messenger.mjs";
import { writeRecord } from "../src/session.mjs";
import { readInheritMarker } from "../src/resident.mjs";
// the names this wave adds, read through the namespace so a build without them fails only their cells
import * as residentStart from "../src/resident-start.mjs";
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

test("manifest: a row's context ceiling is { ceiling: <tokens> }, inherited from defaults, absent by default, read by no messenger row; anything else is refused by its field (red leg: no context field)", async (t) => {
  const s = await seat(t);
  const plain = validateManifest(manifestDoc(), s.manifestFile);
  assert.equal(plain.residents["desk.coding"].context, null, "no field: the cycle's own bounds only");
  const d = manifestDoc();
  /** @type {any} */ (d.residents["desk.coding"]).context = { ceiling: 150_000 };
  const m = validateManifest(d, s.manifestFile);
  assert.deepEqual(m.residents["desk.coding"].context, { ceiling: 150_000 });
  const viaDefaults = manifestDoc();
  /** @type {any} */ (viaDefaults.defaults).context = { ceiling: 200_000 };
  /** @type {any} */ (viaDefaults.residents["desk.messenger"]).harness = "agora";
  const md = validateManifest(viaDefaults, s.manifestFile);
  assert.deepEqual(md.residents["desk.coding"].context, { ceiling: 200_000 });
  assert.equal(md.residents["desk.messenger"].context, null, "a messenger is code: it has no context to bound");
  /** @param {unknown} context @param {RegExp} re */
  const refuses = (context, re) => {
    const bad = manifestDoc();
    /** @type {any} */ (bad.residents["desk.coding"]).context = context;
    assert.throws(() => validateManifest(bad, s.manifestFile), re);
  };
  refuses(150_000, /desk\.coding\.context: must be an object \{ ceiling: <tokens> \}/);
  refuses({ ceiling: 0 }, /desk\.coding\.context\.ceiling: must be a whole number of tokens, at least 1/);
  refuses({ ceiling: "150K" }, /desk\.coding\.context\.ceiling: must be a whole number of tokens/);
  refuses({ ceiling: 150_000, floor: 1 }, /desk\.coding\.context\.floor: unknown field \(have: ceiling\)/);
  refuses({}, /desk\.coding\.context\.ceiling: is required/);
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
    AGORA_ROOM_CMD: JSON.stringify(["node-bin", BIN]), AGORA_MODEL: "vendor/claude-haiku-9:medium", AGORA_ROOM_PREAMBLE: "off", AGORA_ROLE: "messenger",
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
  assert.match(String(p.firstPrompt), /agora-room plugin owns your watch/);
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

  const prompt = await readFile(String(p.prompt?.file), "utf8");
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

test("start: a Tern session under the position's name that runs no harness (restored as a bare shell after Tern's restart or a reboot) is killed by its id and the start goes on; one running this run file's wrapper is the host; one running another resident's wrapper is refused, never killed (red legs inline)", async (t) => {
  const s = await seat(t);
  const m = validateManifest(manifestDoc(), s.manifestFile);
  const p = planResident(m, "desk.messenger", ctxOf(s));
  /** @param {string} name @param {number} id @param {{ program?: string, args?: string[], command?: string | null }} b */
  const session = (name, id, b) => ({ id, name, tabs: [{ id: id + 1, blocks: [{ id: id + 2, program: b.program ?? "powershell.exe", args: b.args ?? ["-NoLogo"], command: b.command ?? null, live: true, exited: null }] }] });
  /** @param {any[]} sessions */
  const tern = (sessions) => {
    const live = new Map(sessions.map((x) => [String(x.id), x]));
    let next = 900;
    return fakeRunner((argv) => {
      if (argv[1] === "new") {
        if ([...live.values()].some((x) => x.name === argv[3])) return { code: 1, stderr: `tern new: a session is already called ${argv[3]}` };
        next += 10;
        live.set(String(next), session(argv[3], next, { command: argv.slice(argv.indexOf("--") + 1).join(" ") }));
        return { code: 0, stdout: JSON.stringify({ session: next, tab: next + 1, block: next + 2 }) };
      }
      if (argv[1] === "ls") return { code: 0, stdout: JSON.stringify({ sessions: [...live.values()], detached: [] }) };
      if (argv[1] === "kill") { live.delete(argv[3]); return { code: 0, stdout: JSON.stringify({ session: Number(argv[3]) }) }; }
      return { code: 1 };
    });
  };

  // the restored leftover: a bare shell under the name, beside an unrelated session
  const r = tern([session("desk.messenger", 500, {}), session("Default", 4, {})]);
  const res = await startResident(p, s.state, { checkout: CHECKOUT, run: r.fn, home: s.home });
  assert.equal(res.row.action, "started");
  assert.deepEqual(res.row.cleared, ["500"], "the start says which stale session it closed");
  assert.deepEqual(r.calls.map((c) => c[1]), ["new", "ls", "kill", "new"], "a clash only: the happy path asks Tern nothing more");
  assert.deepEqual(r.calls.filter((c) => c[1] === "kill").map((c) => c.slice(1, 4)), [["kill", "session", "500"]], "by its id; the unrelated session is untouched");
  assert.deepEqual((await readRun(s.state, "desk.messenger"))?.handle, { session: 910, tab: 911, block: 912 });

  // red leg: a session of that name running this position's wrapper on this run file is the host itself
  const s2 = await seat(t);
  const p2 = planResident(validateManifest(manifestDoc(), s2.manifestFile), "desk.messenger", ctxOf(s2));
  const ours = tern([session("desk.messenger", 600, { command: `& 'node-bin' ${BIN} resident start desk.messenger --run ${p2.runFile}` })]);
  const held = await startResident(p2, s2.state, { checkout: CHECKOUT, run: ours.fn, home: s2.home });
  assert.equal(held.row.action, "running");
  assert.match(String(held.row.reason), /tern session 600 called desk\.messenger runs this position's host/);
  assert.equal(ours.calls.filter((c) => c[1] === "kill").length, 0, "never killed");
  assert.equal(existsSync(p2.runFile), false, "the refused start leaves no run record of its own");

  // red leg: a session of that name running another state root's resident is refused by name, never killed
  const s3 = await seat(t);
  const p3 = planResident(validateManifest(manifestDoc(), s3.manifestFile), "desk.messenger", ctxOf(s3));
  const other = tern([session("desk.messenger", 700, { command: `& 'node-bin' ${BIN} resident start desk.messenger --run C:\\elsewhere\\state\\residents\\desk.messenger\\run.json` })]);
  await assert.rejects(startResident(p3, s3.state, { checkout: CHECKOUT, run: other.fn, home: s3.home }),
    /tern session 700 called desk\.messenger runs another resident's host/);
  assert.equal(other.calls.filter((c) => c[1] === "kill").length, 0, "another resident is never killed");
});

test("state: a position not held says since when it is absent (the newest of its run's start, its sessions' record writes and watch heartbeats, a messenger's liveness file) and why: reboot when the machine booted since, else host (red legs inline)", async (t) => {
  const s = await seat(t);
  const dead = () => { throw Object.assign(new Error("no such process"), { code: "ESRCH" }); };
  const runOf = (/** @type {string} */ slug, /** @type {number} */ startedAt) => ({ type: "resident-run", id: `r-${slug}`, resident: slug, host: "none", startedAt: new Date(startedAt).toISOString(), hostInfo: {}, handle: { pid: 999_999 }, exec: { argv: [], env: {}, cwd: "." } });
  const now = Date.now();
  // a model position: its run started two hours ago; its session's record was last written just now
  await mkdir(path.dirname(runFilePath(s.state, "desk.coding")), { recursive: true });
  await writeFile(runFilePath(s.state, "desk.coding"), JSON.stringify(runOf("desk.coding", now - 2 * 3_600_000)));
  const sdir = path.join(s.state, "sessions", "omp-old");
  await mkdir(sdir, { recursive: true });
  await writeRecord(sdir, /** @type {any} */ ({ slug: "omp-old", source: "OMP_SESSION_ID" }), { bearer: "coding/Sonnet", label: "desk.coding", pid: 999_999, pidSource: "OMP_PID" });
  const lastSeen = Date.parse(JSON.parse(await readFile(path.join(sdir, "session.json"), "utf8")).lastSeen);
  await writeFile(path.join(sdir, "activity.json"), JSON.stringify({ v: 1, type: "activity", turn: "idle", since: new Date(now - 3_600_000).toISOString(), updatedAt: new Date(lastSeen + 4_000).toISOString() }));
  const host = await residentState(s.state, "desk.coding", { kill: dead, boot: Math.floor((lastSeen - 60_000) / 1000) });
  assert.equal(host.running, false);
  assert.deepEqual(host.absent, { since: lastSeen + 4_000, cause: "host" }, "the watch's heartbeat is the latest sign of life; the machine booted before it");
  const rebooted = await residentState(s.state, "desk.coding", { kill: dead, boot: Math.floor((lastSeen + 60_000) / 1000) });
  assert.deepEqual(rebooted.absent, { since: lastSeen + 4_000, cause: "reboot" }, "booted after the last sign of life");
  // red leg: with no session of its own, only the run's start is known
  const bare = runOf("desk.review", now - 3_600_000);
  await mkdir(path.dirname(runFilePath(s.state, "desk.review")), { recursive: true });
  await writeFile(runFilePath(s.state, "desk.review"), JSON.stringify(bare));
  assert.deepEqual((await residentState(s.state, "desk.review", { kill: dead, boot: 1 })).absent, { since: now - 3_600_000, cause: "host" });
  // a messenger stream's liveness file counts for its own position, never another's
  await mkdir(path.join(s.state, "messenger"), { recursive: true });
  await writeFile(path.join(s.state, "messenger", "desk.review.lab.json"), JSON.stringify({ harness: "agora", session: "desk.review", updatedAt: new Date(now - 60_000).toISOString() }));
  await writeFile(path.join(s.state, "messenger", "desk.review-2.lab.json"), JSON.stringify({ harness: "agora", session: "desk.review-2", updatedAt: new Date(now).toISOString() }));
  assert.deepEqual((await residentState(s.state, "desk.review", { kill: dead, boot: 1 })).absent, { since: now - 60_000, cause: "host" });
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

test("plan: a numbered slot of a role signs as the slot, so it never shares the base row's bearer (red leg: the base row keeps its role)", async (t) => {
  const s = await seat(t);
  const doc = manifestDoc();
  /** @type {any} */ (doc.residents)["desk.coding-2"] = { role: "coding", wake: "mine" };
  /** @type {any} */ (doc.residents)["desk.review"] = { role: "review", wake: "mine" };
  const m = validateManifest(doc, s.manifestFile);
  const slot = planResident(m, "desk.coding-2", ctxOf(s));
  const label = modelLabel("vendor/claude-haiku-9:medium");
  assert.equal(slot.bearer, `coding-2/${label}`);
  assert.equal(slot.env.AGORA_ROLE, "coding-2", "the extension registers <AGORA_ROLE>/<Model>");
  assert.equal(slot.role, "coding", "the role is unchanged: the card, the lineage and the grant read it");
  assert.match(String(slot.firstPrompt), new RegExp(`role coding, bearer coding-2/${label}, position desk\\.coding-2`));
  // red leg: a row that is not a slot signs as its role
  const base = planResident(m, "desk.review", ctxOf(s));
  assert.deepEqual([base.bearer, base.env.AGORA_ROLE], [`review/${label}`, "review"]);
  const name = residentStart.bearerName;
  assert.deepEqual([name("desk.coding-2", "coding"), name("desk.coding", "coding"), name("desk.coding-x", "coding"), name("desk.review-2", "coding"), name("coding-3", "coding")],
    ["coding-2", "coding", "coding", "coding", "coding-3"]);
});

test("start: a start at a position whose last session is gone writes the inherit marker naming it, so a relaunch or a model swap is a succession; a messenger row writes none (red leg: no session held the position)", async (t) => {
  const s = await seat(t);
  const doc = withMessenger();
  /** @type {any} */ (doc.residents)["desk.orchestrator"] = { role: "orchestrator", wake: "mine" };
  const m = validateManifest(doc, s.manifestFile);
  const dead = (/** @type {number} */ pid) => { if (pid === 999_011 || pid === 999_012) throw Object.assign(new Error("gone"), { code: "ESRCH" }); };
  let session = 60;
  const r = fakeRunner((argv) => (argv[1] === "new" ? { code: 0, stdout: JSON.stringify({ session: ++session }) } : { code: 0, stdout: ternLs(session, false) }));
  // red leg first: nothing ever held the position, so the first start writes no marker
  const first = await startResident(planResident(m, "desk.orchestrator", ctxOf(s)), s.state, { checkout: CHECKOUT, run: r.fn, kill: dead });
  assert.deepEqual([first.row.action, first.row.inherit], ["started", undefined]);
  assert.equal(await readInheritMarker(s.state, "desk.orchestrator"), null);
  // that session ran (its record at the position) and is gone; the relaunch picks another model
  const old = path.join(s.state, "sessions", "omp-first");
  await mkdir(old, { recursive: true });
  await writeRecord(old, /** @type {any} */ ({ slug: "omp-first", source: "AGORA_SESSION" }), { bearer: "orchestrator/Haiku", label: "desk.orchestrator", pid: 999_011, pidSource: "OMP_PID" });
  const swap = await startResident(planResident(m, "desk.orchestrator", ctxOf(s, { model: "vendor/claude-sonnet-9:high" })), s.state, { checkout: CHECKOUT, run: r.fn, kill: dead });
  assert.equal(swap.row.action, "started");
  assert.equal(swap.row.bearer, "orchestrator/Sonnet");
  assert.deepEqual([/** @type {any} */ (swap.row.inherit)?.from, /** @type {any} */ (swap.row.inherit)?.by], ["omp-first", "start"]);
  assert.equal((await readInheritMarker(s.state, "desk.orchestrator"))?.from, "omp-first", "the new session's extension consumes it before its first read");
  // a messenger row keeps its own session key across starts: nothing to inherit
  const mdir = path.join(s.state, "sessions", "lab.messenger");
  await mkdir(mdir, { recursive: true });
  await writeRecord(mdir, /** @type {any} */ ({ slug: "lab.messenger", source: "AGORA_SESSION" }), { bearer: "messenger/Code", label: "lab.messenger", pid: 999_012, pidSource: "agora-messenger" });
  const msg = await startResident(planResident(m, "lab.messenger", ctxOf(s)), s.state, { checkout: CHECKOUT, run: r.fn, kill: dead });
  assert.deepEqual([msg.row.action, msg.row.inherit], ["started", undefined]);
  assert.equal(await readInheritMarker(s.state, "lab.messenger"), null);
});

test("timer: one spec per OS, and check reads without writing", async (t) => {
  const s = await seat(t);
  const base = { home: s.home, node: "/opt/node/bin/node", entry: "/opt/agora/bin/agora.mjs", config: "/home/grace/.agora/config.json", stateRoot: s.state, uid: 501 };

  const win = timerSpec({ ...base, platform: "win32", node: "C:\\Program Files\\nodejs\\node.exe", entry: "C:\\agora\\bin\\agora.mjs", config: "C:\\agora\\config.json" });
  assert.equal(win.kind, "schtasks");
  const wrapper = path.join(s.state, "residents", "cycle.cmd");
  const log = path.join(s.state, "residents", "cycle.log");
  const exitFile = path.join(s.state, "residents", "cycle.exit");
  assert.deepEqual(win.files.map((f) => [f.path === wrapper ? "wrapper" : "xml", f.temporary]), [["xml", true], ["wrapper", false]], "the XML is used once; the wrapper is the task's program and stays");
  assert.deepEqual(win.install, [["schtasks", "/Delete", "/TN", "agora-resident-cycle", "/F"], ["schtasks", "/Create", "/TN", "agora-resident-cycle", "/XML", win.files[0].path, "/F"]], "deleted first, so a new entry carries no old entry's last run");
  assert.deepEqual(win.check, [["schtasks", "/Query", "/TN", "agora-resident-cycle", "/XML", "ONE"], ["schtasks", "/Query", "/TN", "agora-resident-cycle", "/V", "/FO", "CSV", "/NH"]]);
  assert.deepEqual(win.remove, [["schtasks", "/Delete", "/TN", "agora-resident-cycle", "/F"]]);
  // Task Scheduler cannot start node under `conhost --headless` (0x80070005); it can start cmd.exe
  // there, on a wrapper agora writes, quoted once so a path with spaces holds (conhost mangles /s "")
  assert.equal(win.expect?.arguments, `--headless cmd.exe /d /c "${wrapper}"`);
  assert.deepEqual(parseTaskXml(win.files[0].content), { command: "conhost.exe", arguments: win.expect?.arguments, interval: "PT15M", logon: "PT2M" });
  assert.match(win.files[0].content, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(win.files[0].content, /<LogonType>InteractiveToken<\/LogonType>/, "runs in the user's session, where Tern is");
  assert.equal(win.files[1].content, [
    "@echo off",
    "chcp 65001 >nul",
    `"C:\\Program Files\\nodejs\\node.exe" C:\\agora\\bin\\agora.mjs resident cycle --all --config C:\\agora\\config.json >>"${log}" 2>&1`,
    `>"${exitFile}" echo %ERRORLEVEL%`,
    "",
  ].join("\r\n"), "the cycle's own output is its log, as launchd's is; its exit code is recorded, since conhost passes none on");
  // a path with spaces is quoted; % is doubled, since cmd expands it even inside quotes; a quote cannot be carried
  const odd = timerSpec({ ...base, platform: "win32", node: "C:\\node.exe", entry: "C:\\agora\\bin\\agora.mjs", config: "C:\\Users\\Grace Hopper\\100%\\config.json" });
  assert.match(odd.files[1].content, /--config "C:\\Users\\Grace Hopper\\100%%\\config\.json" >>/);
  assert.throws(() => timerSpec({ ...base, platform: "win32", node: "C:\\node.exe", entry: "C:\\agora\\bin\\agora.mjs", config: "C:\\a\"b\\config.json" }), /cannot carry/);
  // the wrapper's own path rides cmd /c inside one pair of quotes, where cmd still reads & ( ) and friends
  assert.throws(() => timerSpec({ ...base, platform: "win32", node: "C:\\node.exe", entry: "C:\\agora\\bin\\agora.mjs", stateRoot: "C:\\Users\\Ada (lab)\\state" }), /wrapper .* cannot carry a quote or any of & < > \( \) @ \^ \| %/);

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

  // check: a registered task with the same command and wrapper, whose last run started and ran the
  // cycle to exit 0, is ok; another command or wrapper differs; a run the scheduler refused, one that
  // never reached the cycle, or a cycle that exited non-zero is failing; absent is missing
  /** @type {string[]} */
  const writes = [];
  const files = new Map(win.files.map((f) => [f.path, f.content]));
  files.set(exitFile, "0 \r\n");
  const deps = (/** @type {(argv: string[]) => { code: number, stdout?: string }} */ answer) => ({
    run: fakeRunner(answer).fn,
    writeFile: async (/** @type {string} */ f) => { writes.push(f); },
    rm: async (/** @type {string} */ f) => { writes.push(`rm ${f}`); },
    mkdir: async () => {},
    readFile: async (/** @type {string} */ f) => { if (!files.has(f)) throw new Error("absent"); return String(files.get(f)); },
  });
  const utf16 = (/** @type {string} */ text) => text.split("").join("\u0000");
  const csv = (/** @type {string} */ last) => `"HOST","\\agora-resident-cycle","1/1/2026 0:15:00 AM","Ready","Interactive only","1/1/2026 0:00:01 AM","${last}","grace","conhost.exe --headless cmd.exe","N/A"\r\n`;
  const sched = (/** @type {string} */ xmlText, /** @type {string} */ last) => (/** @type {string[]} */ argv) => argv.includes("/XML") ? { code: 0, stdout: xmlText } : { code: 0, stdout: csv(last) };
  const ok = await runTimer("check", win, deps(sched(utf16(win.files[0].content), "0")));
  assert.deepEqual([ok.state, ok.lastResult, ok.cycleExit], ["ok", 0, 0]);
  assert.equal((await runTimer("check", win, deps(sched(win.files[0].content, "267011")))).state, "ok", "registered and not yet run has not failed");
  assert.equal((await runTimer("check", win, deps(sched(win.files[0].content, "267009")))).state, "ok", "running now has not failed");
  // the trial's case: registered as written, and every run refused before agora started
  const failing = await runTimer("check", win, deps(sched(win.files[0].content, "-2147024891")));
  assert.deepEqual([failing.state, failing.lastResult], ["failing", -2147024891]);
  assert.match(failing.problems.join(" "), /ended with 0x80070005 \(-2147024891\): the scheduler could not start it/);
  // conhost ends 0 whatever its child did: the wrapper's record tells a cycle that failed or never ran
  files.set(exitFile, "1\r\n");
  const exited = await runTimer("check", win, deps(sched(win.files[0].content, "0")));
  assert.deepEqual([exited.state, exited.cycleExit], ["failing", 1]);
  assert.match(exited.problems.join(" "), new RegExp(`ran the cycle, which exited 1; its own lines are in ${log.replace(/\\/g, "\\\\")}`));
  files.delete(exitFile);
  const never = await runTimer("check", win, deps(sched(win.files[0].content, "0")));
  assert.equal(never.state, "failing");
  assert.match(never.problems.join(" "), /did not run the cycle: .*cycle\.exit is absent/);
  files.set(exitFile, "0\r\n");
  const differs = await runTimer("check", win, deps(sched(win.files[0].content.replace("PT15M", "PT5M"), "0")));
  assert.equal(differs.state, "differs");
  assert.match(differs.problems.join(" "), /its interval is PT5M, not PT15M/);
  files.set(wrapper, "@echo off\r\nnode other.mjs\r\n");
  const stale = await runTimer("check", win, deps(sched(win.files[0].content, "0")));
  assert.equal(stale.state, "differs");
  assert.match(stale.problems.join(" "), /cycle\.cmd differs from what install writes/);
  files.delete(wrapper);
  assert.equal((await runTimer("check", win, deps(sched(win.files[0].content, "0")))).state, "differs", "a task whose wrapper is gone cannot run");
  files.set(wrapper, win.files[1].content);
  assert.equal((await runTimer("check", win, deps(() => ({ code: 1 })))).state, "missing");
  assert.equal((await runTimer("check", linux, { ...deps(() => ({ code: 0 })), readFile: async () => { throw new Error("absent"); } })).state, "missing");
  assert.deepEqual(writes, [], "check writes nothing");

  const installed = await runTimer("install", win, deps(sched(win.files[0].content, "0")));
  assert.equal(installed.state, "installed");
  assert.equal(installed.check?.state, "ok", "install's own output carries the check after its first run");
  assert.deepEqual(installed.ran.slice(0, 3).map((x) => x.argv[1]), ["/Delete", "/Create", "/Run"], "the entry is created, then run once by the scheduler");
  assert.deepEqual(writes, [win.files[0].path, wrapper, `rm ${exitFile}`, `rm ${win.files[0].path}`], "the XML is written, used, and removed; the wrapper stays; an older exit record cannot vouch for the new entry");
  writes.length = 0;
  const first = await runTimer("install", win, deps((argv) => argv[1] === "/Delete" ? { code: 1 } : sched(win.files[0].content, "0")(argv)));
  assert.equal(first.state, "installed", "a first install has nothing to delete");
  assert.equal((await runTimer("install", win, deps((argv) => argv[1] === "/Create" ? { code: 1 } : { code: 0 }))).state, "failed");
  // the first run is waited for: not yet run and running read as pending until a result lands
  /** @type {string[]} */
  const results = ["267011", "267009", "0"];
  const slept = /** @type {number[]} */ ([]);
  const waiting = await runTimer("install", win, { ...deps((argv) => argv.includes("/XML") ? { code: 0, stdout: win.files[0].content } : argv.includes("/V") ? { code: 0, stdout: csv(results.length > 1 ? /** @type {string} */ (results.shift()) : results[0]) } : { code: 0 }), sleep: async (ms) => { slept.push(ms); } });
  assert.equal(waiting.state, "installed");
  assert.equal(slept.length, 2, "it asked twice more before the run ended");
  // a run still going at the deadline is said so, not failed
  const long = await runTimer("install", win, { ...deps(sched(win.files[0].content, "267009")), sleep: async () => {}, settleMs: 1000 });
  assert.deepEqual([long.state, long.firstRun], ["installed", "running"]);
  // the trial's case: the scheduler takes the run and the cycle never runs, or exits 2; install says so and is not ok
  const refused = await runTimer("install", win, deps(sched(win.files[0].content, "-2147024891")));
  assert.deepEqual([refused.state, refused.check?.state], ["failing", "failing"]);
  assert.match(String(refused.check?.problems.join(" ")), /0x80070005/);
  files.set(exitFile, "2\r\n");
  const exits2 = await runTimer("install", win, deps(sched(win.files[0].content, "0")));
  assert.deepEqual([exits2.state, exits2.check?.cycleExit], ["failing", 2]);
  files.set(exitFile, "0\r\n");
  // the scheduler refusing the run itself
  const noRun = await runTimer("install", win, deps((argv) => argv[1] === "/Run" ? { code: 1, stderr: "ERROR: nope" } : sched(win.files[0].content, "0")(argv)));
  assert.equal(noRun.state, "failing");
  assert.match(noRun.problems.join(" "), /schtasks \/Run \/TN agora-resident-cycle: exit 1 ERROR: nope/);
  // systemd: the oneshot service is started and waited for; a non-zero start is the failure
  const lcontents = new Map(linux.files.map((f) => [f.path, f.content]));
  const ldeps = (/** @type {(argv: string[]) => { code: number, stdout?: string, stderr?: string }} */ answer) => ({ ...deps(answer), readFile: async (/** @type {string} */ f) => String(lcontents.get(f)), sleep: async () => {} });
  const lok = await runTimer("install", linux, ldeps(() => ({ code: 0, stdout: "enabled" })));
  assert.deepEqual([lok.state, lok.check?.state], ["installed", "ok"]);
  assert.deepEqual(lok.ran.map((x) => x.argv.slice(2, 5).join(" ")), ["daemon-reload", "enable --now agora-resident-cycle.timer", "start agora-resident-cycle.service"], "start carries no --no-block");
  assert.deepEqual(lok.check?.ran.map((x) => x.argv[2]), ["is-enabled", "is-active"]);
  const lfail = await runTimer("install", linux, ldeps((argv) => argv[2] === "start" ? { code: 1, stderr: "Job failed" } : { code: 0, stdout: "enabled" }));
  assert.equal(lfail.state, "failing");
  assert.match(lfail.problems.join(" "), /systemctl --user start agora-resident-cycle\.service: exit 1 Job failed; its lines are in journalctl --user -u agora-resident-cycle\.service/);
  // launchd: kickstart, then print until the job has exited; a non-zero exit is the failure
  const mcontents = new Map(mac.files.map((f) => [f.path, f.content]));
  const mdeps = (/** @type {string} */ printed) => ({ ...deps((argv) => argv[1] === "print" ? { code: 0, stdout: printed } : { code: 0 }), readFile: async (/** @type {string} */ f) => String(mcontents.get(f)), sleep: async () => {} });
  const mok = await runTimer("install", mac, mdeps("state = not running\n\tlast exit code = 0\n"));
  assert.deepEqual([mok.state, mok.firstRun], ["installed", "ended"]);
  const mbad = await runTimer("install", mac, mdeps("state = not running\n\tlast exit code = 2\n"));
  assert.equal(mbad.state, "failing");
  assert.match(mbad.problems.join(" "), /its run exited 2; its own lines are in .*cycle\.log/);
  const mnever = await runTimer("install", mac, { ...mdeps("state = not running\n\tlast exit code = (never exited)\n"), settleMs: 1000 });
  assert.deepEqual([mnever.state, mnever.firstRun], ["installed", "running"]);
  writes.length = 0;
  await runTimer("remove", win, deps(() => ({ code: 0 })));
  assert.deepEqual(writes, [`rm ${wrapper}`, `rm ${path.join(s.state, "residents", "service-start.cmd")}`, `rm ${exitFile}`], "remove takes the wrappers and the cycle's record with the task");
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

// ---- harness agora: the messenger as a manifest row ----

/** @param {Record<string, unknown>} [row] */
const withMessenger = (row = {}) => {
  const d = manifestDoc();
  /** @type {any} */ (d.residents)["lab.messenger"] = { role: "messenger", harness: "agora", wake: "all", rooms: ["lab"], args: ["--human-name", "Ada", "--bounds", "R=90s,R2=270s"], ...row };
  return d;
};

test("manifest: a messenger row (harness agora) needs no model and no profile, reads none from defaults, and watches one room (red leg: two rooms)", async (t) => {
  const s = await seat(t);
  const m = validateManifest(withMessenger(), s.manifestFile);
  const row = m.residents["lab.messenger"];
  assert.deepEqual([row.harness, row.model, row.profile, row.append, row.skills, row.thinking], ["agora", "code", "", [], null, null], "the defaults' model, profile, append and skills are not the messenger's");
  const bare = manifestDoc();
  bare.defaults = /** @type {any} */ ({ host: "none" });
  bare.residents = /** @type {any} */ ({ "lab.messenger": { role: "messenger", harness: "agora", rooms: ["lab"] } });
  assert.equal(validateManifest(bare, s.manifestFile).residents["lab.messenger"].model, "code");
  assert.throws(() => validateManifest(withMessenger({ rooms: ["lab", "other"] }), s.manifestFile), /lab\.messenger\.rooms: a messenger row \(harness agora\) watches one room/);
  const noModel = manifestDoc();
  delete /** @type {any} */ (noModel.defaults).model;
  assert.throws(() => validateManifest(noModel, s.manifestFile), /desk\.messenger\.model: is required/, "a model harness still needs its model");
});

test("plan: a messenger row runs `agora messenger <room> --stream` as its own session, with no prompt, and names its liveness file", async (t) => {
  const s = await seat(t);
  const m = validateManifest(withMessenger(), s.manifestFile);
  const p = planResident(m, "lab.messenger", ctxOf(s, { host: "none", env: { PATH: path.join(s.root, "empty") } }));
  assert.deepEqual(p.argv, ["node-bin", BIN, "messenger", "lab", "--stream", "--config", s.config, "--human-name", "Ada", "--bounds", "R=90s,R2=270s"], "no harness binary is looked up");
  assert.equal(p.bearer, "messenger/Code");
  assert.deepEqual(Object.keys(p.env).sort(), ["AGORA_ACTOR", "AGORA_CONFIG", "AGORA_LABEL", "AGORA_SESSION", "AGORA_STATE", "SEAT_MARKER"]);
  assert.deepEqual([p.env.AGORA_SESSION, p.env.AGORA_LABEL, p.env.AGORA_ACTOR], ["lab.messenger", "lab.messenger", "messenger/Code"]);
  assert.deepEqual([p.prompt, p.firstPrompt, p.overlay, p.trust, p.skills], [null, null, null, null, null]);
  assert.equal(p.liveness, path.join(s.state, "messenger", "lab.messenger.lab.json"));
  assert.equal(planResident(m, "desk.coding", ctxOf(s)).liveness, null, "a model harness has no messenger liveness");
  // the start renders nothing and records the host handle like any row
  const pt = planResident(m, "lab.messenger", ctxOf(s));
  const r = fakeRunner((argv) => (argv[1] === "new" ? { code: 0, stdout: JSON.stringify({ session: 7, tab: 8, block: 9 }) } : { code: 0 }));
  const started = await startResident(pt, s.state, { checkout: CHECKOUT, run: r.fn, home: s.home });
  assert.equal(started.row.action, "started");
  assert.equal(existsSync(path.join(p.dir, "prompt.md")), false, "no prompt is written for a messenger");
  assert.deepEqual((await readRun(s.state, "lab.messenger"))?.exec.argv, pt.argv);
});

test("cycle: a messenger row's backstop is one --once tick as its session; a failed tick is named (red leg: the tick exits non-zero)", async (t) => {
  const s = await seat(t);
  const m = validateManifest(withMessenger(), s.manifestFile);
  /** @type {Array<{ argv: string[], env?: Record<string, string> }>} */
  const calls = [];
  const tickLine = JSON.stringify({ type: "messenger-tick", due: [{ kind: "N2" }, { kind: "N5" }], posted: [{ kind: "N2" }, { kind: "N5" }] });
  /** @param {number} code */
  const runner = (code) => /** @type {any} */ (async (/** @type {string[]} */ argv, /** @type {any} */ opts) => { calls.push({ argv, env: opts?.env }); return { code, stdout: code === 0 ? `${tickLine}\n` : "", stderr: code === 0 ? "" : "seat service dark" }; });
  const ok = /** @type {any} */ (await cycleMessenger(m, "lab.messenger", ctxOf(s), { run: runner(0) }));
  assert.deepEqual([ok.action, ok.stream, ok.posted, ok.due], ["tick", "gone", 2, 2]);
  assert.deepEqual(calls[0].argv, ["node-bin", BIN, "messenger", "lab", "--once", "--json", "--config", s.config, "--human-name", "Ada", "--bounds", "R=90s,R2=270s"]);
  assert.deepEqual([calls[0].env?.AGORA_SESSION, calls[0].env?.AGORA_ACTOR, calls[0].env?.AGORA_LABEL], ["lab.messenger", "messenger/Code", "lab.messenger"]);
  // the stream holding the position: the tick still runs (its own posts are the record)
  const pid = process.pid;
  await writeRecord(path.join(s.state, "sessions", "lab.messenger"), /** @type {any} */ ({ slug: "lab.messenger", source: "AGORA_SESSION" }), { bearer: "messenger/Code", label: "lab.messenger", pid, pidSource: "agora-messenger" });
  assert.equal((await cycleMessenger(m, "lab.messenger", ctxOf(s), { run: runner(0) })).stream, "live");
  const failed = await cycleMessenger(m, "lab.messenger", ctxOf(s), { run: runner(1) });
  assert.equal(failed.action, "failed");
  assert.match(String(failed.reason), /backstop tick exited 1: seat service dark/);
});

test("stream: the liveness file is rewritten after every tick in the extension's shape (red leg: a failing tick is not ready)", async (t) => {
  const s = await seat(t);
  const file = path.join(s.state, "messenger", "lab.messenger.lab.json");
  let ticks = 0;
  const deps = (/** @type {boolean} */ failing) => ({
    gather: async () => { ticks++; if (failing) throw new Error("seat service dark"); return { messages: [], annotations: [], boardRecords: [], resolve: () => /** @type {any} */ ({ kind: "none", holders: [] }) }; },
    post: async () => ({ id: "x", cursor: "c" }), lock: async (/** @type {any} */ fn) => fn(), now: () => Date.now(), accountId: null, human: "Ada",
    bounds: { ...DEFAULT_BOUNDS, R: 1000, R2: 2000, I: 1000, Bo: 1000, H: 3_600_000, T: 1000 },
    wait: async () => {}, until: null, stopped: () => ticks >= 3, liveness: { file, base: { session: "lab.messenger", bearer: "messenger/Code", position: "lab.messenger", room: "lab" } },
  });
  const stats = await runStream(deps(false));
  assert.equal(stats.ticks, 3);
  const live = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual([live.harness, live.session, live.position, live.room, live.ready, live.ticks, live.errors, live.intervalMs, live.pid], ["agora", "lab.messenger", "lab.messenger", "lab", true, 3, 0, 1000, process.pid]);
  assert.ok(Date.parse(live.updatedAt) > 0 && Date.parse(live.lastTick) > 0);
  ticks = 0;
  await runStream(deps(true));
  const dark = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual([dark.ready, dark.errors, dark.lastError], [false, 3, "seat service dark"]);
});

// ---- lineage, the stop's departure, the timer kick ----

/** A room with coding and a review that must be another family; `review` overrides the review row. @param {Record<string, unknown>} [review] */
const lineageDoc = (review = {}) => {
  const d = manifestDoc();
  d.models = /** @type {any} */ ({ ...d.models, sonnet: "anthropic/claude-sonnet-5-5:high", opus: "google-antigravity/claude-opus-5-5:high", argon: "google-antigravity/gemini-4-argon:high" });
  d.residents = /** @type {any} */ ({
    "lab.coding": { role: "coding", wake: "mine", model: "sonnet" },
    "lab.review": { role: "review", wake: "mine", model: "argon", lineage: "different-from-coding", ...review },
  });
  return d;
};
/** A pid that answers no signal: a gone session. */
const deadKill = (/** @type {number} */ pid) => { if (pid >= 999_000) throw Object.assign(new Error("gone"), { code: "ESRCH" }); };

test("manifest: a row's lineage is any or different-from-<role>, by name; rows that break their own rule are refused (red leg: review on coding's family through another provider)", async (t) => {
  const s = await seat(t);
  const m = validateManifest(lineageDoc(), s.manifestFile);
  assert.deepEqual([m.residents["lab.review"].lineage, m.residents["lab.coding"].lineage], ["different-from-coding", "any"]);
  assert.throws(() => validateManifest(lineageDoc({ lineage: "different from coding" }), s.manifestFile), /residents\.lab\.review\.lineage: lineage must be "any" or "different-from-<role>"/);
  assert.throws(() => validateManifest(lineageDoc({ model: "opus" }), s.manifestFile),
    /residents\.lab\.review\.lineage: lab\.review runs google-antigravity\/claude-opus-5-5:high, family claude, the family of lab\.coding \(anthropic\/claude-sonnet-5-5:high\); the manifest says lab\.review differs from coding/);
});

test("plan: the launcher gives the harness its model id (AGORA_MODEL), which the manifest may not set, and names the positions its lineage binds", async (t) => {
  const s = await seat(t);
  const m = validateManifest(lineageDoc(), s.manifestFile);
  const p = planResident(m, "lab.review", ctxOf(s, { model: "opus" }));
  assert.equal(p.env.AGORA_MODEL, "google-antigravity/claude-opus-5-5:high");
  assert.ok(RESERVED_ENV.includes("AGORA_MODEL"));
  assert.deepEqual(/** @type {any} */ (p).lineage, { family: "claude", against: [{ position: "lab.coding", rule: "lab.review differs from coding", rowModel: "anthropic/claude-sonnet-5-5:high" }] });
  const bad = lineageDoc();
  /** @type {any} */ (bad.residents)["lab.review"].env = { AGORA_MODEL: "x" };
  assert.throws(() => validateManifest(bad, s.manifestFile), /lab\.review\.env\.AGORA_MODEL: is set by agora resident start itself/);
});

test("start: a relaunch onto the family a live counterpart runs is refused by name before anything is written; another family starts, and its run record keeps the model (red leg: the counterpart is gone)", async (t) => {
  const s = await seat(t);
  const m = validateManifest(lineageDoc(), s.manifestFile);
  let session = 300;
  const r = fakeRunner((argv) => (argv[1] === "new" ? { code: 0, stdout: JSON.stringify({ session: ++session }) } : { code: 0, stdout: ternLs(session, true) }));
  const coding = path.join(s.state, "sessions", "omp-coding");
  await mkdir(coding, { recursive: true });
  await writeRecord(coding, /** @type {any} */ ({ slug: "omp-coding", source: "OMP_SESSION_ID" }), { bearer: "coding/Sonnet", label: "lab.coding", pid: process.pid, pidSource: "OMP_PID", model: "anthropic/claude-sonnet-5-5:high" });
  const deps = { checkout: CHECKOUT, run: r.fn, home: s.home, kill: deadKill };
  const refused = await startResident(planResident(m, "lab.review", ctxOf(s, { model: "opus" })), s.state, deps);
  assert.equal(refused.row.action, "refused");
  assert.match(String(refused.row.reason), /^lineage: lab\.review on google-antigravity\/claude-opus-5-5:high is family claude, the family lab\.coding runs \(anthropic\/claude-sonnet-5-5:high, from its session omp-coding\); the manifest says lab\.review differs from coding$/);
  assert.deepEqual(r.calls, [], "the host was never asked");
  assert.equal(existsSync(runFilePath(s.state, "lab.review")), false, "no run record");
  const ok = await startResident(planResident(m, "lab.review", ctxOf(s)), s.state, deps);
  assert.equal(ok.row.action, "started");
  assert.equal(/** @type {any} */ (await readRun(s.state, "lab.review"))?.model, "google-antigravity/gemini-4-argon:high");
  // the other way: a coding relaunch onto the family review runs, read from review's run record
  await writeRecord(coding, /** @type {any} */ ({ slug: "omp-coding", source: "OMP_SESSION_ID" }), { bearer: "coding/Sonnet", pid: 999_101, pidSource: "OMP_PID" });
  const back = await startResident(planResident(m, "lab.coding", ctxOf(s, { model: "argon" })), s.state, deps);
  assert.equal(back.row.action, "refused");
  assert.match(String(back.row.reason), /the family lab\.review runs \(google-antigravity\/gemini-4-argon:high, from its run record\)/);
  // red leg: nothing in force at the counterpart, nothing to clash with
  const s2 = await seat(t);
  const m2 = validateManifest(lineageDoc(), s2.manifestFile);
  const free = await startResident(planResident(m2, "lab.review", ctxOf(s2, { model: "opus" })), s2.state, { ...deps, home: s2.home });
  assert.equal(free.row.action, "started", "a counterpart that is not running binds nothing");
});

test("restart: the cycle's relaunch checks lineage before it stops anything (red leg: an allowed family stops and starts)", async (t) => {
  const s = await seat(t);
  const m = validateManifest(lineageDoc(), s.manifestFile);
  let session = 400;
  /** @type {Set<number>} */
  const live = new Set();
  const r = fakeRunner((argv) => {
    if (argv[1] === "new") { session += 1; live.add(session); return { code: 0, stdout: JSON.stringify({ session }) }; }
    if (argv[1] === "ls") return { code: 0, stdout: JSON.stringify({ sessions: [...live].map((id) => ({ id, tabs: [{ blocks: [{ live: true, exited: null }] }] })) }) };
    if (argv[1] === "kill") { live.delete(Number(argv[3])); return { code: 0 }; }
    return { code: 1 };
  });
  const deps = { checkout: CHECKOUT, run: r.fn, sleep: async () => {}, kill: deadKill };
  await startResident(planResident(m, "lab.coding", ctxOf(s)), s.state, deps);
  await startResident(planResident(m, "lab.review", ctxOf(s)), s.state, deps);
  const res = await restartResident(m, "lab.review", ctxOf(s, { model: "opus" }), deps);
  assert.equal(res.code, 1);
  assert.match(res.err, /^lineage: lab\.review on google-antigravity\/claude-opus-5-5:high is family claude, the family lab\.coding runs \(anthropic\/claude-sonnet-5-5:high, from its run record\)/);
  assert.equal(r.calls.filter((c) => c[1] === "kill").length, 0, "nothing was stopped");
  const ok = await restartResident(m, "lab.review", ctxOf(s), deps);
  assert.deepEqual(ok, { code: 0, err: "" });
  assert.equal(r.calls.filter((c) => c[1] === "kill").length, 1);
});

test("stop: a stopped position's sessions are marked as handled in every room they held, so no sibling posts a departure line for a stop (red leg: a session that was not stopped is still announced)", async (t) => {
  const s = await seat(t);
  const m = validateManifest(lineageDoc(), s.manifestFile);
  let alive = true;
  const r = fakeRunner((argv) => {
    if (argv[1] === "new") return { code: 0, stdout: JSON.stringify({ session: 7 }) };
    if (argv[1] === "ls") return { code: 0, stdout: ternLs(7, alive) };
    if (argv[1] === "kill") { alive = false; return { code: 0 }; }
    return { code: 1 };
  });
  await startResident(planResident(m, "lab.coding", ctxOf(s)), s.state, { checkout: CHECKOUT, run: r.fn });
  const ago = new Date(Date.now() - 10 * 60_000);
  const mk = async (/** @type {string} */ slug, /** @type {string} */ label) => {
    const dir = path.join(s.state, "sessions", slug);
    await mkdir(dir, { recursive: true });
    await writeRecord(dir, /** @type {any} */ ({ slug, source: "OMP_SESSION_ID" }), { bearer: `${label.split(".")[1]}/Sonnet`, label, pid: 999_201, pidSource: "OMP_PID", now: ago });
    await writeFile(path.join(dir, "lab.cursor"), "1");
    await writeFile(path.join(dir, "lab#t1.cursor"), "1");
  };
  await mk("omp-coding", "lab.coding");
  await mk("omp-other", "lab.other");
  const stopped = await stopResident(s.state, "lab.coding", { run: r.fn, sleep: async () => {}, kill: deadKill });
  assert.equal(stopped.action, "stopped");
  const { departures } = await import("../src/session.mjs");
  const gone = await departures(s.state, { selfSlug: "me", roomKey: "lab", kill: deadKill });
  assert.deepEqual(gone.map((g) => g.slug), ["omp-other"], "the stopped position is not a departure; another gone session still is");
  const marker = JSON.parse(await readFile(path.join(s.state, "sessions", "omp-coding", "departed", "lab.json"), "utf8"));
  assert.deepEqual([marker.reason, marker.by], ["stopped", "resident stop lab.coding"]);
});

test("timer run: asks the OS scheduler to run the installed entry now, outside any session; an entry that is not installed is named, never run in-process", async (t) => {
  const s = await seat(t);
  const base = { home: s.home, node: "/opt/node/bin/node", entry: "/opt/agora/bin/agora.mjs", stateRoot: s.state, uid: 501 };
  const win = timerSpec({ ...base, platform: "win32", node: "C:\\node.exe", entry: "C:\\agora\\bin\\agora.mjs" });
  const linux = timerSpec({ ...base, platform: "linux" });
  const mac = timerSpec({ ...base, platform: "darwin" });
  assert.deepEqual(/** @type {any} */ (win).run, [["schtasks", "/Run", "/TN", "agora-resident-cycle"]]);
  assert.deepEqual(/** @type {any} */ (linux).run, [["systemctl", "--user", "start", "--no-block", "agora-resident-cycle.service"]]);
  assert.deepEqual(/** @type {any} */ (mac).run, [["launchctl", "kickstart", "gui/501/agora.resident-cycle"]]);
  const ok = fakeRunner(() => ({ code: 0 }));
  const kicked = await runTimer(/** @type {any} */ ("run"), win, { run: ok.fn });
  assert.equal(kicked.state, "kicked");
  assert.deepEqual(ok.calls, [["schtasks", "/Run", "/TN", "agora-resident-cycle"]]);
  const missing = await runTimer(/** @type {any} */ ("run"), win, { run: fakeRunner(() => ({ code: 1, stderr: "ERROR: The system cannot find the file specified." })).fn });
  assert.equal(missing.state, "missing");
  assert.match(missing.problems.join(" "), /no cycle timer is installed \(schtasks \/Run \/TN agora-resident-cycle: exit 1 ERROR: The system cannot find the file specified\.\); install it with agora resident timer install/);
});

test("timer: the seat service starts at logon by agora's own startup entry when a row needs a room this seat hosts, as its last recorded start asked; install refuses by name when no start is recorded; remove takes only agora's entry (red legs inline)", async (t) => {
  const s = await seat(t);
  const RUN = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
  const APPROVED = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";
  const recordFile = path.join(s.state, "native", "service-start.json");
  const up = { file: recordFile, record: { version: 1, intent: "up", at: "2026-01-02T03:04:05.000Z", authorityId: `a-${"b".repeat(64)}`, config: "C:\\agora\\config.json" } };
  const base = { home: s.home, platform: "win32", node: "C:\\node.exe", entry: "C:\\agora\\bin\\agora.mjs", config: "C:\\agora\\config.json", stateRoot: s.state };
  const spec = /** @type {any} */ (timerSpec(/** @type {any} */ ({ ...base, service: ["lab.coding"], serviceStart: up })));
  const wrapper = path.join(s.state, "residents", "service-start.cmd");
  const log = path.join(s.state, "residents", "service-start.log");
  // the entry names no authority: the logon start reads the record, so a later start with another authority is followed
  assert.equal(spec.serviceLogin?.name, "agora-seat-service");
  assert.equal(spec.serviceLogin?.data, `conhost.exe --headless cmd.exe /d /c "${wrapper}"`);
  assert.equal(spec.serviceLogin?.file.content, [
    "@echo off",
    "chcp 65001 >nul",
    `set "AGORA_STATE=${s.state}"`,
    `C:\\node.exe C:\\agora\\bin\\agora.mjs service start --logon --config C:\\agora\\config.json >>"${log}" 2>&1`,
    "",
  ].join("\r\n"));
  assert.equal(/** @type {any} */ (timerSpec(/** @type {any} */ ({ ...base, serviceStart: up }))).serviceLogin.data, null, "no row needs the service: install writes no entry");
  assert.equal(/** @type {any} */ (timerSpec(/** @type {any} */ ({ ...base, platform: "linux", node: "/opt/node", entry: "/opt/agora.mjs", config: "/home/grace/config.json", service: ["lab.coding"] }))).serviceLogin, null);
  // another name gives entries of their own, never the default ones
  assert.deepEqual(residentStart.timerNames?.("w-test"), { task: "w-test", label: "w-test", tern: "w-test-tern-daemon", service: "w-test-seat-service" });
  assert.deepEqual(residentStart.timerNames?.(undefined), { task: "agora-resident-cycle", label: "agora.resident-cycle", tern: "agora-tern-daemon", service: "agora-seat-service" });
  assert.throws(() => residentStart.timerNames?.("bad name"), /must be 1-64 letters/);
  const named = /** @type {any} */ (timerSpec(/** @type {any} */ ({ ...base, name: "w-test", service: ["lab.coding"], serviceStart: up, tern: "C:\\tern.exe" })));
  assert.deepEqual([named.name, named.login.name, named.serviceLogin.name, named.install[1][3]], ["w-test", "w-test-tern-daemon", "w-test-seat-service", "w-test"]);

  // the OS, stubbed: the Run key's values, the Startup apps records, the wrapper on disk
  /** @type {Map<string, string>} */
  const run = new Map();
  /** @type {Map<string, string>} */
  const approved = new Map();
  /** @type {Map<string, string>} */
  const files = new Map();
  const taskXml = spec.files[0].content;
  files.set(spec.files[1].path, spec.files[1].content);
  files.set(path.join(s.state, "residents", "cycle.exit"), "0\r\n");
  /** @type {string[]} */
  const writes = [];
  const os = fakeRunner((argv) => {
    // the scheduler's run of the cycle leaves its exit record, as the wrapper does
    if (argv[0] === "schtasks" && argv[1] === "/Run") { files.set(path.join(s.state, "residents", "cycle.exit"), "0\r\n"); return { code: 0 }; }
    if (argv[0] === "schtasks") return argv.includes("/XML") ? { code: 0, stdout: taskXml } : argv.includes("/V") ? { code: 0, stdout: `"HOST","\\agora-resident-cycle","x","Ready","x","1/1/2026","0","grace"\r\n` } : { code: 0 };
    if (argv[1] === "query" && argv[2] === RUN) return { code: 0, stdout: `\r\n${RUN.replace("HKCU", "HKEY_CURRENT_USER")}\r\n${[...run].map(([n, d]) => `    ${n}    REG_SZ    ${d}`).join("\r\n")}\r\n` };
    if (argv[1] === "query" && argv[2] === APPROVED) return approved.has(argv[4]) ? { code: 0, stdout: `    ${argv[4]}    REG_BINARY    ${approved.get(argv[4])}\r\n` } : { code: 1 };
    if (argv[1] === "add") { run.set(argv[4], argv[8]); return { code: 0 }; }
    if (argv[1] === "delete") { (argv[2] === RUN ? run : approved).delete(argv[4]); return { code: 0 }; }
    return { code: 1 };
  });
  const deps = (/** @type {any} */ sp = spec) => ({
    run: os.fn, sleep: async () => {},
    writeFile: async (/** @type {string} */ f, /** @type {any} */ d) => { writes.push(f); files.set(f, String(d)); },
    rm: async (/** @type {string} */ f) => { writes.push(`rm ${f}`); files.delete(f); },
    mkdir: async () => {},
    readFile: async (/** @type {string} */ f) => { if (!files.has(f)) throw new Error("absent"); return String(files.get(f)); },
  });
  run.set("Other", "C:\\other.exe");
  run.set("w-test-seat-service", "kept");

  // check, nothing installed: a row needs the service and nothing starts it
  let c = /** @type {any} */ (await runTimer("check", spec, deps()));
  assert.equal(c.state, "differs");
  assert.equal(c.service?.state, "missing");
  assert.match(c.problems.join(" "), /the seat service does not start at logon, and lab\.coding needs it \(a room this seat hosts\); timer install adds it/);
  assert.equal(writes.length, 0, "check writes nothing");

  // install with no recorded start: refused by name, before anything is written or registered
  os.calls.length = 0;
  const unrecorded = /** @type {any} */ (timerSpec(/** @type {any} */ ({ ...base, service: ["lab.coding"], serviceStart: { file: recordFile, record: null } })));
  const refused = /** @type {any} */ (await runTimer("install", unrecorded, deps(unrecorded)));
  assert.equal(refused.state, "refused");
  assert.match(refused.problems.join(" "), /^service-start-unrecorded: lab\.coding needs the seat service at logon, and no service start is recorded on this seat \(.*service-start\.json is absent\), so its authority cannot be known; start the service once with agora service start/);
  assert.deepEqual([writes.length, os.calls.length], [0, 0], "nothing written, nothing registered");

  // install with a recorded start: the wrapper, then agora's entry; the check after the first run lists it
  const installed = /** @type {any} */ (await runTimer("install", spec, deps()));
  assert.equal(installed.state, "installed", JSON.stringify(installed.check?.problems));
  assert.equal(files.get(wrapper), spec.serviceLogin.file.content);
  assert.equal(run.get("agora-seat-service"), spec.serviceLogin.data);
  assert.deepEqual(installed.check.service, { name: "agora-seat-service", needs: ["lab.coding"], intent: "up", authorityId: up.record.authorityId, at: up.record.at, state: "agora", data: spec.serviceLogin.data, problems: [] });

  // a deliberate stop is followed, not undone: the entry stays and says the logon start leaves the service dark
  const down = /** @type {any} */ (timerSpec(/** @type {any} */ ({ ...base, service: ["lab.coding"], serviceStart: { file: recordFile, record: { version: 1, intent: "down", at: "2026-01-03T00:00:00.000Z", authorityId: null } } })));
  c = /** @type {any} */ (await runTimer("check", down, deps(down)));
  assert.deepEqual([c.state, c.service.state, c.service.intent, c.service.authorityId], ["ok", "agora", "down", null]);
  // the entry there with no record: it would start nothing
  c = /** @type {any} */ (await runTimer("check", unrecorded, deps(unrecorded)));
  assert.deepEqual([c.state, c.service.state], ["differs", "unrecorded"]);
  // turned off in Startup apps, another program, a missing wrapper
  approved.set("agora-seat-service", "03000000");
  assert.equal((/** @type {any} */ (await runTimer("check", spec, deps()))).service.state, "disabled");
  approved.delete("agora-seat-service");
  run.set("agora-seat-service", "C:\\elsewhere.exe");
  assert.equal((/** @type {any} */ (await runTimer("check", spec, deps()))).service.state, "differs");
  run.set("agora-seat-service", spec.serviceLogin.data);
  files.delete(wrapper);
  c = /** @type {any} */ (await runTimer("check", spec, deps()));
  assert.equal(c.service.state, "differs");
  assert.match(c.problems.join(" "), /service-start\.cmd is missing; timer install writes it/);
  files.set(wrapper, spec.serviceLogin.file.content);

  // remove: agora's entries and their Startup apps records, and the wrapper; nothing else in the Run key
  writes.length = 0;
  await runTimer("remove", spec, deps());
  assert.deepEqual([...run.keys()].sort(), ["Other", "w-test-seat-service"]);
  assert.ok(writes.includes(`rm ${wrapper}`));
  c = /** @type {any} */ (await runTimer("check", spec, deps()));
  assert.equal(c.service.state, "missing");
});
