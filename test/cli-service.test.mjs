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
  assert.deepEqual(schema.verbs.service.args, ["start|stop|status"]);
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
