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
  DEFAULT_IDLE_SECONDS, DEFAULT_MIN_CONTEXT, configuredResidents, cycleVerdict, inheritMarkerPath, measureClaudeTranscript,
  readInheritMarker, renderResidentPrompt, restartCommand, transcriptFor, writeInheritMarker,
} from "../src/resident.mjs";
import { writeRecord } from "../src/session.mjs";

const run = promisify(execFile);
const BIN = fileURLToPath(new URL("../bin/agora.mjs", import.meta.url));
const CLEARED = ["CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_PID", "GROK_SESSION_ID", "GROK_PID", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "HERMES_SESSION_ID", "AGORA_SESSION_PID", "AGORA_SESSION", "AGORA_ACTOR", "AGORA_CONFIG", "AGORA_STATE"];

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

/** A Claude Code transcript: hook noise, then assistant turns with usage. @param {Array<[string, number, number, number]>} turns [ts, input, cacheRead, cacheWrite] */
function transcript(turns) {
  const lines = [JSON.stringify({ type: "user", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "You are the r1 resident." } })];
  for (const [ts, input, cr, cw] of turns) {
    lines.push(JSON.stringify({ type: "assistant", timestamp: ts, message: { role: "assistant", usage: { input_tokens: input, cache_read_input_tokens: cr, cache_creation_input_tokens: cw, output_tokens: 5 } } }));
    lines.push(JSON.stringify({ type: "progress", timestamp: ts, data: { hook: "stop" } })); // appended without inference
  }
  return lines.join("\n") + "\n";
}

/** A seat: state root, a fake home with one transcript, one live session record signing as the resident.
 * @param {import("node:test").TestContext} t @param {{ bearer: string, turns: Array<[string, number, number, number]>, source?: string }} a */
async function seat(t, a) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-resident-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const state = path.join(root, "state");
  const home = path.join(root, "home");
  const uuid = "0b7b6b0c-1111-4222-8333-444455556666";
  const slug = `claude-code-${uuid}`;
  const proj = path.join(home, ".claude", "projects", "-home-user-src-tree");
  await mkdir(proj, { recursive: true });
  await writeFile(path.join(proj, `${uuid}.jsonl`), transcript(a.turns));
  const dir = path.join(state, "sessions", slug);
  await mkdir(dir, { recursive: true });
  await writeRecord(dir, /** @type {any} */ ({ slug, source: a.source ?? "CLAUDE_CODE_SESSION_ID" }), { bearer: a.bearer, pid: process.pid, pidSource: "CLAUDE_PID" });
  return { root, state, home, uuid, slug };
}

test("renderResidentPrompt appends the block once and leaves a profile that already carries it alone", () => {
  const block = "## Room mechanics (shared)\n\nbody\n";
  const out = renderResidentPrompt("# P\n\ncharter", block);
  assert.equal(out, "# P\n\ncharter\n\n## Room mechanics (shared)\n\nbody\n");
  assert.equal(renderResidentPrompt(out, block), out);
});

test("measureClaudeTranscript takes the newest assistant usage, never the trailing hook lines", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-resident-m-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const f = path.join(root, "t.jsonl");
  await writeFile(f, transcript([["2026-01-01T01:00:00.000Z", 2, 100, 10], ["2026-01-01T02:00:00.000Z", 3, 200_000, 500]]) + "not json\n");
  const m = await measureClaudeTranscript(f);
  assert.deepEqual(m, { lastInference: "2026-01-01T02:00:00.000Z", context: 200_503, uncached: 3, cacheRead: 200_000, cacheWrite: 500 });
  await writeFile(f, "{}\n");
  assert.equal(await measureClaudeTranscript(f), null);
});

test("transcriptFor finds the harness transcript by session uuid and refuses other harnesses by name", async (t) => {
  const s = await seat(t, { bearer: "Model/r1", turns: [["2026-01-01T01:00:00.000Z", 2, 100, 10]] });
  const found = transcriptFor({ slug: s.slug, source: "CLAUDE_CODE_SESSION_ID" }, { home: s.home });
  assert.equal(found.status, "found");
  assert.ok(/** @type {any} */ (found).file.endsWith(`${s.uuid}.jsonl`));
  const other = transcriptFor({ slug: "codex-abc", source: "CODEX_SESSION_ID" }, { home: s.home });
  assert.equal(other.status, "unsupported");
  assert.match(/** @type {any} */ (other).reason, /Claude Code transcripts only/);
  const missing = transcriptFor({ slug: "claude-code-nope", source: "CLAUDE_CODE_SESSION_ID" }, { home: s.home });
  assert.equal(missing.status, "unsupported");
});

test("cycleVerdict: cold AND large cycles; warm, small, unsupported and absent each say why", async () => {
  const now = new Date("2026-01-02T00:00:00.000Z");
  const rec = (/** @type {string} */ bearer, /** @type {string} */ startedAt = "2026-01-01T00:00:00.000Z") => ({ slug: `claude-code-${bearer.replace("/", "-")}`, state: "live", record: { bearer, startedAt, source: "CLAUDE_CODE_SESSION_ID" } });
  const measured = (/** @type {number} */ ctx, /** @type {string} */ ts) => async () => ({ status: /** @type {const} */ ("measured"), lastInference: ts, context: ctx, file: "t" });
  const base = { slug: "r1", now, idleSeconds: DEFAULT_IDLE_SECONDS, minContext: DEFAULT_MIN_CONTEXT };
  let v = await cycleVerdict({ ...base, sessions: [rec("Model/r1")], measure: measured(300_000, "2026-01-01T12:00:00.000Z") });
  assert.equal(v.action, "cycle");
  assert.equal(/** @type {any} */ (v).idleSeconds, 43_200);
  v = await cycleVerdict({ ...base, sessions: [rec("Model/r1")], measure: measured(300_000, "2026-01-01T23:30:00.000Z") });
  assert.equal(v.action, "none"); assert.match(String(v.reason), /warm or working/);
  v = await cycleVerdict({ ...base, sessions: [rec("Model/r1")], measure: measured(100_000, "2026-01-01T12:00:00.000Z") });
  assert.equal(v.action, "none"); assert.match(String(v.reason), /small/);
  v = await cycleVerdict({ ...base, sessions: [rec("Model/r1")], measure: async () => ({ status: /** @type {const} */ ("unsupported"), reason: "no transcript" }) });
  assert.equal(v.action, "none"); assert.equal(v.reason, "no transcript");
  v = await cycleVerdict({ ...base, sessions: [{ ...rec("Model/r1"), state: "gone" }, rec("Model/r2")], measure: measured(300_000, "2026-01-01T12:00:00.000Z") });
  assert.equal(v.action, "none"); assert.match(String(v.reason), /no live session/);
  // two live sessions for one resident: the newest is the one measured
  const seen = /** @type {string[]} */ ([]);
  v = await cycleVerdict({ ...base, sessions: [rec("Model/r1", "2026-01-01T00:00:00.000Z"), rec("Model/r1", "2026-01-01T06:00:00.000Z")], measure: async (r) => { seen.push(r.startedAt); return { status: "measured", lastInference: "2026-01-01T12:00:00.000Z", context: 300_000, file: "t" }; } });
  assert.deepEqual(seen, ["2026-01-01T06:00:00.000Z"]);
  await assert.rejects(cycleVerdict({ ...base, slug: "Bad Slug", sessions: [], measure: measured(1, "x") }), /resident slug/);
});

test("the inherit marker round-trips and a foreign file is refused", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-resident-k-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const w = await writeInheritMarker(root, "r1", { from: "claude-code-x", context: 5, lastInference: "2026-01-01T00:00:00.000Z" });
  assert.equal(w.file, inheritMarkerPath(root, "r1"));
  const r = await readInheritMarker(root, "r1");
  assert.equal(r?.from, "claude-code-x"); assert.equal(r?.context, 5); assert.equal(r?.by, "cycle");
  assert.equal(await readInheritMarker(root, "r2"), null);
  await writeFile(inheritMarkerPath(root, "r1"), "{\"type\":\"other\"}\n");
  await assert.rejects(readInheritMarker(root, "r1"), /not a resident inherit marker/);
});

test("configuredResidents reads the table and nothing else; restartCommand substitutes the slug", () => {
  assert.deepEqual(configuredResidents({}), {});
  assert.deepEqual(configuredResidents({ residents: { a: { restart: "x {slug}" }, b: {}, c: true } }), { a: { restart: "x {slug}" }, b: { restart: undefined }, c: {} });
  assert.throws(() => configuredResidents({ residents: { "Bad Slug": {} } }), /resident slug/);
  assert.equal(restartCommand("systemctl --user restart resident-{slug}.service", "r1"), "systemctl --user restart resident-r1.service");
});

test("CLI: prompt appends the shipped block; cycle measures the seat, writes the marker and runs the restart; inherit consumes it", async (t) => {
  const s = await seat(t, { bearer: "Model/r1", turns: [["2026-01-01T01:00:00.000Z", 2, 100, 10], ["2026-01-01T02:00:00.000Z", 3, 200_000, 500]] });
  const profile = path.join(s.root, "PROFILE.md");
  await writeFile(profile, "# Resident profile: r1\n\ncharter\n");
  const cfgPath = path.join(s.root, "agora.json");
  const stamp = path.join(s.root, "restarted.txt");
  const stampScript = path.join(s.root, "stamp.mjs");
  await writeFile(stampScript, `import { writeFileSync } from "node:fs"; writeFileSync(process.argv[2], process.argv[3]);
`);
  await writeFile(cfgPath, JSON.stringify({ actor: { name: "Model", kind: "agent" }, rooms: { r: { transport: "local", path: path.join(s.root, "room.ndjson") } }, residents: { r1: { restart: `"${process.execPath}" "${stampScript}" "${stamp}" {slug}` } } }));
  const env = { AGORA_STATE: s.state, AGORA_CONFIG: cfgPath, HOME: s.home, USERPROFILE: s.home };

  const p = await agora(["resident", "prompt", profile], env);
  assert.equal(p.code, 0, p.stderr);
  assert.ok(p.stdout.startsWith("# Resident profile: r1\n"));
  assert.match(p.stdout, /\n## Room mechanics \(shared by every resident; appended by the launcher\)\n/);
  assert.match(p.stdout, /agora resident inherit <slug>/);

  // the transcript's last inference is in 2026-01; now is later, so it is cold; 200,503 > 150,000
  const dry = await agora(["resident", "cycle", "r1", "--dry-run", "--json"], env);
  assert.equal(dry.code, 0, dry.stderr);
  const drow = JSON.parse(dry.stdout.trim().split("\n").pop() ?? "{}");
  assert.equal(drow.action, "would-cycle");
  assert.equal(drow.context, 200_503);
  assert.equal(drow.session, s.slug);
  assert.equal(existsSync(inheritMarkerPath(s.state, "r1")), false);
  assert.equal(existsSync(stamp), false);

  const small = await agora(["resident", "cycle", "r1", "--min-context", "300000", "--json"], env);
  assert.equal(small.code, 0);
  assert.match(JSON.parse(small.stdout.trim()).reason, /small/);
  assert.equal(existsSync(inheritMarkerPath(s.state, "r1")), false);

  const bad = await agora(["resident", "cycle", "r1", "--idle", "soon"], env);
  assert.equal(bad.code, 2);

  const real = await agora(["resident", "cycle", "--all", "--json"], env);
  assert.equal(real.code, 0, real.stderr);
  const row = JSON.parse(real.stdout.trim());
  assert.equal(row.action, "cycle");
  assert.equal(row.restartExit, 0);
  assert.equal(await readFile(stamp, "utf8"), "r1");
  const marker = await readInheritMarker(s.state, "r1");
  assert.equal(marker?.from, s.slug);
  assert.equal(marker?.context, 200_503);

  // the successor: a different session, holding no position yet
  const cursors = path.join(s.state, "sessions", s.slug);
  await writeFile(path.join(cursors, "room-a.cursor"), "7\n");
  await writeFile(path.join(cursors, "posted.jsonl"), JSON.stringify({ id: "m1", pid: 1 }) + "\n");
  const succ = { ...env, AGORA_SESSION: "claude-code-9999" };
  const inh = await agora(["resident", "inherit", "r1", "--json"], succ);
  assert.equal(inh.code, 0, inh.stderr);
  const irow = JSON.parse(inh.stdout.trim());
  assert.equal(irow.inherited, true);
  assert.equal(irow.from, s.slug);
  assert.deepEqual(irow.cursors, ["room-a"]);
  assert.equal(await readFile(path.join(s.state, "sessions", "claude-code-9999", "room-a.cursor"), "utf8"), "7\n");
  assert.equal(existsSync(inheritMarkerPath(s.state, "r1")), false, "the marker is consumed");
  assert.match(inh.stderr, /session --as <Model>\/r1/);

  const again = await agora(["resident", "inherit", "r1", "--json"], succ);
  assert.equal(again.code, 0);
  assert.equal(JSON.parse(again.stdout.trim()).reason, "no marker");
});

test("CLI: a marker naming a pruned predecessor is removed with a warning; the cycled session itself may not inherit", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-resident-p-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const state = path.join(root, "state");
  const cfgPath = path.join(root, "agora.json");
  await writeFile(cfgPath, JSON.stringify({ actor: { name: "Model", kind: "agent" }, rooms: { r: { transport: "local", path: path.join(root, "room.ndjson") } } }));
  const env = { AGORA_STATE: state, AGORA_CONFIG: cfgPath, AGORA_SESSION: "claude-code-succ" };
  await writeInheritMarker(state, "r1", { from: "claude-code-gone" });
  const gone = await agora(["resident", "inherit", "r1", "--json"], env);
  assert.equal(gone.code, 0, gone.stderr);
  assert.equal(JSON.parse(gone.stdout.trim()).reason, "predecessor-gone");
  assert.match(gone.stderr, /pruned/);
  assert.equal(existsSync(inheritMarkerPath(state, "r1")), false);
  await writeInheritMarker(state, "r1", { from: "claude-code-succ" });
  const self = await agora(["resident", "inherit", "r1"], env);
  assert.equal(self.code, 2);
  assert.match(self.stderr, /names this session/);
  assert.equal(existsSync(inheritMarkerPath(state, "r1")), false);
  const usage = await agora(["resident", "dance"], env);
  assert.equal(usage.code, 2);
});
