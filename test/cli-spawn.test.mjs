// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const run = promisify(execFile);
const BIN = new URL("../bin/agora.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const CLEARED = ["CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_PID", "GROK_SESSION_ID", "GROK_PID", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "HERMES_SESSION_ID", "AGORA_SESSION_PID", "AGORA_SESSION", "AGORA_ACTOR", "AGORA_CONFIG", "AGORA_STATE"];
const REQUEST = {
  operationId: "3f2b1c8e9a444f6a8f312b7d0c5e1a90",
  harness: "grok",
  model: "grok-4.6",
  role: "forge",
  unit: "p4-spawn-verb",
  room: "house",
  answersTo: "grace",
  cwd: ".",
  briefDigest: "sha256:6f1d9c2a4b8e70135ac9f3d21e6b8c47a05f9e3b2d18c4760af5e91b3c7d2a68",
};

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

test("schema lists spawn --file", async () => {
  const { code, stdout } = await agora(["schema", "--json"], {});
  assert.equal(code, 0);
  const schema = JSON.parse(stdout);
  assert.ok(schema.verbs.spawn);
  assert.equal(schema.verbs.spawn.options["--file <path>"] !== undefined, true);
});

test("spawn without --file is usage", async () => {
  const { code, stderr } = await agora(["spawn"], {});
  assert.equal(code, 2);
  assert.match(stderr, /spawn needs --file/);
});

test("spawn --file unknown key is request-field-unknown and mints nothing", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-spawn-unknown-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "req.json");
  await writeFile(file, JSON.stringify({ ...REQUEST, depth: 0 }));
  const { code, stderr } = await agora(["spawn", "--file", file], { AGORA_STATE: root, AGORA_SESSION: "sp" });
  assert.equal(code, 1);
  assert.match(stderr, /request-field-unknown/);
  assert.match(stderr, /depth/);
});

test("spawn --file hermes is spawn-unsupported", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-spawn-hermes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "req.json");
  await writeFile(file, JSON.stringify({ ...REQUEST, harness: "hermes" }));
  const { code, stderr } = await agora(["spawn", "--file", file], { AGORA_STATE: root, AGORA_SESSION: "sp" });
  assert.equal(code, 1);
  assert.match(stderr, /spawn-unsupported/);
});

test("spawn --file with a live service opens one pane and prints a 32-hex id", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-spawn-ok-"));
  const cfg = path.join(root, "agora.json");
  await writeFile(cfg, JSON.stringify({ actor: { name: "seat", kind: "agent" }, rooms: { scratch: { transport: "local", path: path.join(root, "room.ndjson") } } }));
  const env = { AGORA_STATE: root, AGORA_CONFIG: cfg, AGORA_SESSION: "sp" };
  t.after(async () => {
    await agora(["service", "stop"], env);
    await rm(root, { recursive: true, force: true });
  });
  const started = await agora(["service", "start", "--json"], env);
  assert.equal(started.code, 0, started.stderr);
  const file = path.join(root, "req.json");
  await writeFile(file, JSON.stringify(REQUEST));
  const spawned = await agora(["spawn", "--file", file, "--json"], env);
  assert.equal(spawned.code, 0, spawned.stderr);
  const line = JSON.parse(spawned.stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
  assert.match(String(line.spawnId), /^[a-f0-9]{32}$/);
});
