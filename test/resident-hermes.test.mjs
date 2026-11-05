// @ts-check
// harness "hermes" in the resident launcher (src/resident-start.mjs) and the cycle guard's measure of a
// hermes session from the agora-room plugin's turn record (src/resident.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HERMES_INTERFACE, HERMES_PROMPT_MAX, HERMES_SOURCE, RESERVED_ENV, firstPrompt, hermesChecks, hermesDenied, hermesHome, hermesProfileOf, hermesSessionKey,
  inheritedEnv, planResident, readRun, readSimpleYaml, startResident, validateManifest, which,
} from "../src/resident-start.mjs";
import { SESSION_RE, writeRecord } from "../src/session.mjs";
import * as resident from "../src/resident.mjs";

const BIN = fileURLToPath(new URL("../bin/agora.mjs", import.meta.url));
const CHECKOUT = fileURLToPath(new URL("../", import.meta.url));
const AT = new Date("2026-11-05T12:00:00.000Z");

/** A profile config.yaml as Hermes writes it (CRLF, block lists, a nested mapping). @param {{ enabled?: string[], model?: string, extra?: string }} [o] */
function profileYaml(o = {}) {
  const enabled = o.enabled ?? ["agent-importers", "agora-room"];
  return [
    "model:", "  default: " + (o.model ?? "deepseek/deepseek-v4.1-flash-1017"), "  provider: nous", "  base_url: ''",
    "toolsets:", "  - hermes-cli", "compression:", "  enabled: true", "  threshold: 0.5   # a comment",
    "plugins:", "  enabled:", ...enabled.map((e) => `    - ${e}`), "  disabled: []", "  entries:", "    agora-room:", "      allow_gateway_injection: true",
    o.extra ?? "",
  ].join("\r\n");
}

/** A seat: config with one room, a manifest with one hermes row, a fake hermes on a PATH of its own, a Hermes root with profile ab-ds41.
 * @param {import("node:test").TestContext} t @param {{ row?: Record<string, unknown>, yaml?: string, profile?: string }} [o] */
async function seat(t, o = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-rhermes-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const state = path.join(root, "state");
  const home = path.join(root, "home");
  const mdir = path.join(root, "team");
  const bin = path.join(root, "bin");
  const local = path.join(root, "local");
  for (const d of [mdir, bin, home, path.join(local, "hermes", "profiles", "ab-ds41")]) await mkdir(d, { recursive: true });
  await writeFile(path.join(local, "hermes", "profiles", "ab-ds41", "config.yaml"), o.yaml ?? profileYaml());
  await writeFile(path.join(mdir, "PROFILE.md"), o.profile ?? "# Watch\n\nA lean shadow profile.\n");
  for (const ext of ["", ".exe", ".com"]) for (const n of ["hermes", "tern"]) await writeFile(path.join(bin, n + ext), "");
  const manifestFile = path.join(mdir, "residents.json");
  const doc = {
    version: 1,
    residents: {
      "shadow.ds41": { role: "netwatch", harness: "hermes", model: "deepseek/deepseek-v4.1-flash-1017", rooms: ["lab"], profile: "PROFILE.md", host: "none",
        command: ["hermes", "-p", "ab-ds41"], bearer: "netwatch/Flash41", deny: ["write", "browser_exec"], ...(o.row ?? {}) },
    },
  };
  await writeFile(manifestFile, JSON.stringify(doc, null, 2));
  const config = path.join(root, "config.json");
  const cfg = { actor: { name: "Grace", kind: "agent" }, rooms: { lab: { transport: "local", path: path.join(root, "lab.ndjson") } } };
  await writeFile(config, JSON.stringify(cfg));
  const env = { PATH: bin, PATHEXT: ".COM;.EXE", LOCALAPPDATA: local, HOME: home, USERPROFILE: home };
  const m = validateManifest(doc, manifestFile);
  const ctx = { cfg: { ...cfg, path: config }, stateRoot: state, checkout: CHECKOUT, entry: BIN, node: "node-bin", env, platform: "win32", home, now: () => AT };
  return { root, state, home, mdir, local, manifestFile, m, ctx, env };
}

test("plan: hermes runs `hermes -p <profile> chat --cli` with the first prompt in a file, a pinned agora key, the deny list mapped to Hermes tools, and the plugin as a per-run project plugin", async (t) => {
  const s = await seat(t, { row: { thinking: "high", skills: { dir: ".", names: ["network-cli"] }, args: ["--max-turns", "40"] } });
  const p = planResident(s.m, "shadow.ds41", s.ctx);
  const exe = which("hermes", { env: s.env, platform: "win32" });
  assert.ok(exe);
  assert.deepEqual(p.argv, [exe, "-p", "ab-ds41", "chat", HERMES_INTERFACE, "--yolo", "--source", HERMES_SOURCE, "--query-file", path.join(p.dir, "first-prompt.txt"), "--reasoning", "high", "--skills", "network-cli", "--max-turns", "40"]);
  assert.equal(HERMES_INTERFACE, "--cli", "the classic REPL: the one that reads HERMES_EPHEMERAL_SYSTEM_PROMPT and the query file");
  assert.ok(!p.argv.includes(String(p.firstPrompt)), "the first prompt is not an argument: Hermes reads it from the file");
  assert.ok(!p.argv.includes("-m") && !p.argv.includes("--model"), "no -m: the profile is the model's one source");
  assert.equal(p.env.AGORA_SESSION, hermesSessionKey("shadow.ds41", AT));
  assert.match(p.env.AGORA_SESSION, /^hermes-shadow\.ds41-[0-9a-z]+$/);
  assert.ok(SESSION_RE.test(p.env.AGORA_SESSION));
  assert.equal(p.env.AGORA_ACTOR, "netwatch/Flash41", "an explicit bearer signs through AGORA_ACTOR");
  assert.equal(p.env.AGORA_DENY, "write_file,browser_exec", "write maps to Hermes's write_file; any other name passes as written");
  assert.equal(p.env.HERMES_ENABLE_PROJECT_PLUGINS, "1");
  assert.equal(p.env.AGORA_MODEL, "deepseek/deepseek-v4.1-flash-1017");
  assert.equal(p.env.HERMES_EPHEMERAL_SYSTEM_PROMPT, undefined, "the rendered prompt joins the environment at prepare, not in the plan");
  assert.deepEqual(p.hermes, {
    profile: "ab-ds41", home: path.win32.join(s.local, "hermes", "profiles", "ab-ds41"), config: path.join(path.win32.join(s.local, "hermes", "profiles", "ab-ds41"), "config.yaml"), interface: "--cli",
    plugin: { from: path.join(CHECKOUT, "plugins", "hermes", "agora-room"), to: path.join(p.workdir, ".hermes", "plugins", "agora-room") },
    firstPromptFile: path.join(p.dir, "first-prompt.txt"), promptMax: HERMES_PROMPT_MAX,
  });
  assert.equal(p.skills?.mode, "preload");
  assert.match(String(p.firstPrompt), /agora-room plugin owns your watch: arm none\. Its tools room_post and room_read are reached through tool_search, tool_describe and tool_call\./);
  assert.equal(p.firstPrompt, firstPrompt({ slug: "shadow.ds41", role: "netwatch", bearer: "netwatch/Flash41", rooms: ["lab"], wake: "addressed", harness: "hermes" }));
  // the role registers itself when no bearer is named, as on omp
  const role = planResident(validateManifest({ version: 1, residents: { "shadow.ds41": { ...s.m.raw.residents["shadow.ds41"], bearer: undefined } } }, s.manifestFile), "shadow.ds41", s.ctx);
  assert.equal(role.env.AGORA_ROLE, "netwatch");
  assert.equal(role.env.AGORA_ACTOR, undefined);
  assert.equal(role.bearer, "netwatch/Deepseek");
});

test("plan: a hermes row must name its profile; the manifest may not set what the launcher sets for Hermes (red legs)", async (t) => {
  const s = await seat(t, { row: { command: ["hermes"] } });
  assert.throws(() => planResident(s.m, "shadow.ds41", s.ctx), /a hermes row names its profile in "command"/);
  for (const name of ["AGORA_DENY", "HERMES_EPHEMERAL_SYSTEM_PROMPT", "HERMES_ENABLE_PROJECT_PLUGINS", "AGORA_SESSION"]) assert.ok(RESERVED_ENV.includes(name), name);
  assert.throws(() => validateManifest({ version: 1, residents: { x: { role: "r", harness: "hermes", model: "m", rooms: ["lab"], profile: "P.md", host: "none", env: { HERMES_EPHEMERAL_SYSTEM_PROMPT: "x" } } } }, s.manifestFile), /is set by agora resident start itself/);
  assert.equal(hermesProfileOf(["hermes", "--profile=ab-opus", "chat"]), "ab-opus");
  assert.equal(hermesProfileOf(["hermes", "--profile", "ab-opus"]), "ab-opus");
  assert.equal(hermesProfileOf(["hermes", "chat"]), null);
  assert.deepEqual(hermesDenied(["bash", "eval", "edit", "terminal", "mcp_x_y"]), ["terminal", "process", "execute_code", "patch", "mcp_x_y"]);
  assert.equal(hermesHome("default", { env: { LOCALAPPDATA: "C:\\L" }, platform: "win32" }), "C:\\L\\hermes");
  assert.equal(hermesHome("ab-opus", { env: { HOME: "/home/u" }, platform: "linux" }), "/home/u/.hermes/profiles/ab-opus");
});

test("checks: the profile's config is read, never written: plugin enablement, the pinned model, the prompt's size on Windows, and named warnings (red legs inline)", async (t) => {
  const yaml = readSimpleYaml(profileYaml({ extra: "hooks:\r\n  pre_verify:\r\n    - command: python C:/x/gate.py\r\n      timeout: 15\r\n" }));
  assert.equal(yaml.model.default, "deepseek/deepseek-v4.1-flash-1017");
  assert.deepEqual(yaml.plugins.enabled, ["agent-importers", "agora-room"]);
  assert.deepEqual(yaml.plugins.disabled, []);
  assert.equal(yaml.plugins.entries["agora-room"].allow_gateway_injection, true);
  assert.equal(yaml.compression.threshold, "0.5");
  assert.deepEqual(Object.keys(yaml.hooks), ["pre_verify"]);

  const ok = await seat(t);
  const plan = planResident(ok.m, "shadow.ds41", ok.ctx);
  const before = await readFile(path.join(ok.local, "hermes", "profiles", "ab-ds41", "config.yaml"), "utf8");
  const good = await hermesChecks(plan, { checkout: CHECKOUT });
  assert.deepEqual(good.refusals, []);
  assert.equal(good.profileModel, "deepseek/deepseek-v4.1-flash-1017");
  assert.ok(good.promptChars && good.promptChars > 100 && good.promptChars < HERMES_PROMPT_MAX);
  assert.ok(good.warnings.some((w) => /compression\.threshold_tokens/.test(w)));
  assert.equal(await readFile(path.join(ok.local, "hermes", "profiles", "ab-ds41", "config.yaml"), "utf8"), before, "the config is not written");

  const off = await seat(t, { yaml: profileYaml({ enabled: ["lampstand"], extra: "hooks:\r\n  pre_verify:\r\n    - command: x\r\n" }) });
  const c = await hermesChecks(planResident(off.m, "shadow.ds41", off.ctx), { checkout: CHECKOUT });
  assert.match(c.refusals.join("\n"), /does not enable the agora-room plugin, so nothing would wake the resident: hermes -p ab-ds41 plugins enable agora-room/);
  assert.match(c.warnings.join("\n"), /enables lampstand/);
  assert.match(c.warnings.join("\n"), /declares shell hooks \(pre_verify\)/);

  const other = await seat(t, { yaml: profileYaml({ model: "claude-opus-5-5" }) });
  const m2 = await hermesChecks(planResident(other.m, "shadow.ds41", other.ctx), { checkout: CHECKOUT });
  assert.match(m2.refusals.join("\n"), /pins model claude-opus-5-5, and the row names deepseek\/deepseek-v4\.1-flash-1017/);

  const missing = await seat(t);
  await rm(path.join(missing.local, "hermes", "profiles", "ab-ds41"), { recursive: true });
  assert.match((await hermesChecks(planResident(missing.m, "shadow.ds41", missing.ctx), { checkout: CHECKOUT })).refusals.join("\n"), /has no config at .*config\.yaml \(hermes profile create ab-ds41\)/);

  const big = await seat(t, { profile: `# Big\n\n${"x".repeat(HERMES_PROMPT_MAX)}\n` });
  const bp = planResident(big.m, "shadow.ds41", big.ctx);
  const bc = await hermesChecks(bp, { checkout: CHECKOUT });
  assert.match(bc.refusals.join("\n"), /the rendered prompt is \d+ characters; HERMES_EPHEMERAL_SYSTEM_PROMPT carries it on Windows, where an environment value holds at most 32,767/);
  // off Windows the environment holds it, so no bound applies
  const posix = planResident(big.m, "shadow.ds41", { ...big.ctx, platform: "linux", env: { ...big.env, HOME: big.home } });
  assert.equal(posix.hermes?.promptMax, null);
});

test("start: a hermes start renders the prompt into HERMES_EPHEMERAL_SYSTEM_PROMPT, writes the first-prompt file, copies the plugin, records the harness and clears the caller's AGORA_/HERMES_ names; a refused check writes nothing (red leg)", async (t) => {
  const s = await seat(t);
  const p = planResident(s.m, "shadow.ds41", s.ctx);
  const started = await startResident(p, s.state, { checkout: CHECKOUT, home: s.home });
  assert.equal(started.row.action, "started", String(started.row.reason));
  assert.ok(Array.isArray(started.row.warnings));
  const rec = await readRun(s.state, "shadow.ds41");
  assert.equal(rec?.harness, "hermes");
  const prompt = await readFile(path.join(p.dir, "prompt.md"), "utf8");
  assert.equal(rec?.exec.env.HERMES_EPHEMERAL_SYSTEM_PROMPT, prompt, "the rendered prompt, whole");
  assert.match(prompt, /## Room mechanics/);
  assert.deepEqual(rec?.exec.clear, ["AGORA_", "HERMES_"]);
  assert.equal(await readFile(path.join(p.dir, "first-prompt.txt"), "utf8"), `${p.firstPrompt}\n`);
  for (const f of ["plugin.yaml", "__init__.py", "room.py"]) assert.ok(existsSync(path.join(p.workdir, ".hermes", "plugins", "agora-room", f)), f);
  assert.equal(existsSync(path.join(p.workdir, ".hermes", "plugins", "agora-room", "__pycache__")), false);
  // the harness's environment: the caller's agora key and Hermes home are not inherited
  process.env.AGORA_TEST_CALLER_KEY = "caller";
  process.env.HERMES_TEST_CALLER_HOME = "x";
  try {
    const env = inheritedEnv(/** @type {any} */ (rec?.exec));
    assert.equal(env.AGORA_TEST_CALLER_KEY, undefined);
    assert.equal(env.HERMES_TEST_CALLER_HOME, undefined);
    assert.equal(env.AGORA_SESSION, p.env.AGORA_SESSION);
    assert.equal(env.HERMES_ENABLE_PROJECT_PLUGINS, "1");
    assert.ok(env.PATH !== undefined || env.Path !== undefined, "everything else is inherited");
  } finally { delete process.env.AGORA_TEST_CALLER_KEY; delete process.env.HERMES_TEST_CALLER_HOME; }

  const off = await seat(t, { yaml: profileYaml({ enabled: [] }) });
  const op = planResident(off.m, "shadow.ds41", off.ctx);
  const refused = await startResident(op, off.state, { checkout: CHECKOUT, home: off.home });
  assert.equal(refused.row.action, "refused");
  assert.match(String(refused.row.reason), /does not enable the agora-room plugin/);
  assert.equal(existsSync(op.runFile), false, "nothing written");
  assert.equal(existsSync(path.join(op.dir, "prompt.md")), false);
});

/** A live hermes session record at `shadow.ds41`, its run record, and optionally its turn record.
 * @param {import("node:test").TestContext} t @param {Record<string, unknown> | null} turn */
async function hermesSeat(t, turn) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-rhermes-c-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const state = path.join(root, "state");
  const slug = "hermes-shadow.ds41-abc";
  const dir = path.join(state, "sessions", slug);
  await mkdir(dir, { recursive: true });
  await writeRecord(dir, /** @type {any} */ ({ slug, source: "AGORA_SESSION" }), { bearer: "netwatch/Flash41", label: "shadow.ds41", pid: process.pid, pidSource: "AGORA_SESSION_PID" });
  await mkdir(path.join(state, "residents", "shadow.ds41"), { recursive: true });
  await writeFile(path.join(state, "residents", "shadow.ds41", "run.json"), JSON.stringify({ type: "resident-run", id: "r1", resident: "shadow.ds41", harness: "hermes", host: "none", startedAt: new Date().toISOString(), hostInfo: {}, handle: null, exec: { argv: ["hermes"], env: {}, cwd: root } }));
  if (turn) await writeFile(path.join(dir, "turn.json"), JSON.stringify({ v: 1, type: "turn", harness: "hermes", session: slug, ...turn }));
  // the plugin's watch heartbeat: a quiet resident with it is listening, not deaf
  const now = new Date().toISOString();
  await writeFile(path.join(dir, "activity.json"), JSON.stringify({ v: 1, type: "activity", session: slug, position: "shadow.ds41", turn: "idle", since: now, lastToolAt: null, lastOutputAt: null, progress: 1, progressAt: now, intervalMs: 2000, updatedAt: now }));
  return { state, slug, dir };
}

test("cycle: a hermes position is measured from its plugin's turn record, chosen by its harness; size, warmth and the succeed turn all read it (red legs: no record, unknown context)", async (t) => {
  const ago = (/** @type {number} */ s) => new Date(Date.now() - s * 1000).toISOString();
  const cold = await hermesSeat(t, { lastInference: ago(5000), context: 210_000, uncached: 1000, cacheRead: 209_000, cacheWrite: null, turn: "idle", turnEnded: true, at: ago(4990) });
  let v = /** @type {any} */ (await resident.planCycle(cold.state, "shadow.ds41", { harness: "hermes" }));
  assert.equal(v.session, cold.slug);
  assert.equal(v.context, 210_000);
  assert.equal(v.transcript, path.join(cold.dir, "turn.json"));
  assert.equal(v.action, "cycle", v.reason);
  assert.match(v.reason, /^cold \d+s and context 210000/);
  // with no harness given, the run record's harness chooses the measure
  v = /** @type {any} */ (await resident.planCycle(cold.state, "shadow.ds41", {}));
  assert.equal(v.context, 210_000, "the run record names the harness");

  const warm = await hermesSeat(t, { lastInference: ago(60), context: 210_000, turn: "busy", turnEnded: false, at: ago(30) });
  v = await resident.planCycle(warm.state, "shadow.ds41", { harness: "hermes" });
  assert.match(String(v.reason), /^warm or working/);
  // a succeed request waits for the running turn the record shows, then is honoured once it has ended
  await resident.writeSucceedRequest(warm.state, "shadow.ds41", { by: "resident", now: new Date(Date.now() + 1000) });
  v = await resident.planCycle(warm.state, "shadow.ds41", { harness: "hermes" });
  assert.match(String(v.reason), /waits for the running turn to end/);
  await writeFile(path.join(warm.dir, "turn.json"), JSON.stringify({ v: 1, type: "turn", lastInference: ago(20), context: 210_000, turn: "idle", turnEnded: true, at: ago(5) }));
  v = await resident.planCycle(warm.state, "shadow.ds41", { harness: "hermes" });
  assert.equal(v.action, "cycle", v.reason);
  assert.match(String(v.reason), /^succeed: requested /);

  const none = await hermesSeat(t, null);
  v = await resident.planCycle(none.state, "shadow.ds41", { harness: "hermes" });
  assert.equal(v.action, "none");
  assert.match(String(v.reason), /has written no turn record .*is the agora-room plugin loaded/);
  const unknown = await hermesSeat(t, { lastInference: null, context: null, turn: "idle", turnEnded: true, at: ago(5) });
  v = await resident.planCycle(unknown.state, "shadow.ds41", { harness: "hermes" });
  assert.match(String(v.reason), /records no inference with usage yet/);
  // the same session read as a transcript harness is unsupported by name, never guessed
  v = await resident.planCycle(cold.state, "shadow.ds41", { harness: "omp" });
  assert.match(String(v.reason), /reads Claude Code or OMP transcripts only/);
});

test("checks: a profile config the reader cannot parse is said, not passed", async (t) => {
  const s = await seat(t, { yaml: "- just\n- a list\n" });
  const c = await hermesChecks(planResident(s.m, "shadow.ds41", s.ctx), { checkout: CHECKOUT });
  assert.match(c.warnings.join("\n"), /could not be read as YAML/);
  assert.deepEqual(c.refusals, []);
});
