// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const run = promisify(execFile);
const BIN = new URL("../bin/agora.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
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

test("schema lists service start|stop|status", async () => {
  const { code, stdout } = await agora(["schema", "--json"], {});
  assert.equal(code, 0);
  const schema = JSON.parse(stdout);
  assert.ok(schema.verbs.service);
  assert.deepEqual(schema.verbs.service.args, ["start|stop|status|room create"]);
});

test("service start, status, stop, and a second start after stop", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-service-"));
  t.after(async () => {
    await agora(["service", "stop"], { AGORA_STATE: root, AGORA_CONFIG: path.join(root, "agora.json") });
    await rm(root, { recursive: true, force: true });
  });
  const cfg = path.join(root, "agora.json");
  await writeFile(cfg, JSON.stringify({ actor: { name: "seat", kind: "agent" }, rooms: { scratch: { transport: "local", path: path.join(root, "room.ndjson") } } }));
  const env = { AGORA_STATE: root, AGORA_CONFIG: cfg, AGORA_SESSION: "svc" };
  const started = await agora(["service", "start", "--json"], env);
  assert.equal(started.code, 0, started.stderr);
  const startLine = JSON.parse(started.stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
  assert.equal(startLine.present, true);
  assert.equal(startLine.pidAlive, true);
  const status = await agora(["service", "status", "--json"], env);
  assert.equal(status.code, 0);
  const st = JSON.parse(status.stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
  assert.equal(st.present, true);
  assert.equal(st.pidAlive, true);
  const again = await agora(["service", "start", "--json"], env);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /already running/);
  const stopped = await agora(["service", "stop", "--json"], env);
  assert.equal(stopped.code, 0, stopped.stderr);
  const after = await agora(["service", "status", "--json"], env);
  const gone = JSON.parse(after.stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
  assert.equal(gone.present, false);
});

test("service room create mints a 32-hex id, EEXIST is exit 1, and agora.json is untouched", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-service-room-"));
  t.after(async () => {
    await agora(["service", "stop"], { AGORA_STATE: root, AGORA_CONFIG: path.join(root, "agora.json") });
    await rm(root, { recursive: true, force: true });
  });
  const cfg = path.join(root, "agora.json");
  const cfgBody = JSON.stringify({ actor: { name: "seat", kind: "agent" }, rooms: { scratch: { transport: "local", path: path.join(root, "room.ndjson") } } });
  await writeFile(cfg, cfgBody);
  const env = { AGORA_STATE: root, AGORA_CONFIG: cfg, AGORA_SESSION: "svc" };
  const started = await agora(["service", "start", "--json"], env);
  assert.equal(started.code, 0, started.stderr);
  const created = await agora(["service", "room", "create"], env);
  assert.equal(created.code, 0, created.stderr);
  const id = created.stdout.trim().split(/\r?\n/).at(-1) ?? "";
  assert.match(id, /^[a-f0-9]{32}$/);
  const again = await agora(["service", "room", "create", "--room-id", id], env);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /already exists|already open/i);
  assert.equal(await readFile(cfg, "utf8"), cfgBody);
});

test("service stop does not kill a pid it has not verified is the service", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-service-stale-"));
  const cfg = path.join(root, "agora.json");
  await writeFile(cfg, JSON.stringify({ actor: { name: "seat", kind: "agent" }, rooms: { scratch: { transport: "local", path: path.join(root, "room.ndjson") } } }));
  await mkdir(path.join(root, "native"), { recursive: true });
  const innocent = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1e9)"], { stdio: "ignore", windowsHide: true });
  t.after(async () => {
    try { innocent.kill("SIGKILL"); } catch { /* gone */ }
    await agora(["service", "stop"], { AGORA_STATE: root, AGORA_CONFIG: cfg });
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(path.join(root, "native", "service.json"), JSON.stringify({
    protocol: 1,
    path: path.join(root, "native", "no-such-endpoint"),
    nonce: "n".repeat(32),
    pid: innocent.pid,
    bootEpoch: "b".repeat(32),
    accountId: "a".repeat(32),
    seatLabel: "stale",
    startedAt: new Date().toISOString(),
  }));
  const env = { AGORA_STATE: root, AGORA_CONFIG: cfg, AGORA_SESSION: "svc" };
  const stopped = await agora(["service", "stop", "--json"], env);
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.equal(innocent.exitCode, null, "stop killed a pid it never handshook");
  assert.notEqual(innocent.killed, true);
  try {
    process.kill(/** @type {number} */ (innocent.pid), 0);
  } catch (e) {
    assert.fail(`innocent pid ${innocent.pid} is gone: ${e instanceof Error ? e.message : e}`);
  }
});
