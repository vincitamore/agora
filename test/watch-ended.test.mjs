// @ts-check
// A watch that ends for a TRANSPORT reason delivers one final addressed line into its own
// session before it exits, on the stdout path and through a Codex bridge. A watch that ends
// normally emits none. The exit code is the transport's and unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const bin = fileURLToPath(new URL("../bin/agora.mjs", import.meta.url));

/** @param {string[]} args @param {Record<string, string>} env */
function agora(args, env) {
  return new Promise((resolve) => {
    const base = { ...process.env };
    for (const k of Object.keys(base)) if (/^CODEX_|^AGORA_CODEX|^CLAUDE_/.test(k)) delete base[k];
    const child = spawn(process.execPath, [bin, ...args], { env: { ...base, ...env }, windowsHide: true });
    child.stdin.end();
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** @param {string} out */
const typed = (out) => out.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));

/** A config with a native room whose seat service does not exist, and a local room beside it. */
async function seat() {
  const dir = await mkdtemp(path.join(tmpdir(), "agora-ended-"));
  const root = path.join(dir, "state");
  await mkdir(root, { recursive: true });
  const cfgPath = path.join(dir, "agora.json");
  await writeFile(cfgPath, JSON.stringify({
    actor: { name: "Grace/e2c", kind: "agent" },
    rooms: {
      nat: { transport: "native", roomId: "b".repeat(32) },
      down: { transport: "local", path: path.join(dir, "down.ndjson") },
    },
  }));
  await writeFile(path.join(dir, "down.ndjson"), "");
  return { dir, root, cfgPath, env: { AGORA_CONFIG: cfgPath, AGORA_STATE: root, AGORA_SESSION: "w" } };
}

test("a watch ending service-dark emits one watch-ended line, addressed to its own bearer, before the result line; exit stays 1", async () => {
  const { env } = await seat();
  const r = await agora(["watch", "nat", "--once", "--json"], env);
  assert.equal(r.code, 1, r.stderr);
  const lines = typed(r.stdout);
  const ended = lines.find((l) => l.type === "watch-ended");
  assert.ok(ended, `no watch-ended line in ${r.stdout}`);
  assert.equal(ended.alias, "nat");
  assert.equal(ended.reason, "service-dark");
  assert.deepEqual(ended.to, ["Grace/e2c"]);
  assert.equal(ended.bearer, "Grace/e2c");
  assert.match(ended.re_arm, /^agora watch nat --once --json/);
  assert.ok(lines.indexOf(ended) < lines.findIndex((l) => l.type === "watch-result"), "the ended line precedes the result line");
  const result = lines.at(-1);
  assert.equal(result.type, "watch-result");
  assert.equal(result.reason, "service-dark");
  assert.equal(result.exit, 1);
  // Never a fabricated message: the only message-typed lines are real deliveries, and there were none.
  assert.equal(lines.filter((l) => l.type === "message").length, 0);
});

test("without --json the ended line goes to stderr with the re-arm command, and stdout stays empty", async () => {
  const { env } = await seat();
  const r = await agora(["watch", "nat", "--once"], env);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /watch on nat ended: service-dark; re-arm with: agora watch nat --once/);
  assert.equal(r.stdout, "");
});

test("the twin: a watch that ends normally emits no watch-ended line", async () => {
  const { env } = await seat();
  const r = await agora(["watch", "down", "--once", "--json"], env);
  assert.equal(r.code, 0, r.stderr);
  const lines = typed(r.stdout);
  assert.equal(lines.some((l) => l.type === "watch-ended"), false);
  assert.equal(lines.at(-1).type, "watch-result");
  assert.equal(lines.at(-1).exit, 0);
});

test("under --codex-queue the ended notice is queued as exactly one turn through the bridge, attempted once", {
  skip: process.platform === "win32" ? "the fake Codex binary is a POSIX executable script" : false,
}, async () => {
  const { dir, env } = await seat();
  // A fake codex that records every argv line it is called with; `queue` succeeds.
  const record = path.join(dir, "codex-calls.log");
  const fake = path.join(dir, "codex");
  await writeFile(fake, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(record)}\nexit 0\n`);
  await chmod(fake, 0o755);
  // A rollout and a held-looking lock so the liveness gate passes and the transport reason is the
  // dark native service, not the Codex task.
  const codexHome = path.join(dir, "codex-home");
  const thread = "ended-thread-000001";
  const sessions = path.join(codexHome, "sessions", "2026", "09", "07");
  await mkdir(sessions, { recursive: true });
  await writeFile(path.join(sessions, `rollout-2026-09-07T00-00-00-${thread}.jsonl`), "");
  const r = await agora(["watch", "nat", "--once", "--json", "--codex-queue", "--codex-bin", fake, "--codex-thread", thread],
    { ...env, CODEX_HOME: codexHome });
  assert.equal(r.code, 1, r.stderr);
  const lines = typed(r.stdout);
  const ended = lines.find((l) => l.type === "watch-ended");
  assert.ok(ended, `no watch-ended line in ${r.stdout}`);
  assert.equal(ended.reason, "service-dark");
  let calls = "";
  try { calls = await readFile(record, "utf8"); } catch { calls = ""; }
  // The fake records one argv line per call; the queued message spans lines, so count calls by
  // the `queue --thread` head and read the notice from the whole record.
  const queued = calls.split("\n").filter((l) => l.startsWith("queue --thread"));
  assert.equal(queued.length, 1, `queued turns: ${JSON.stringify(queued)}`);
  assert.match(queued[0], new RegExp(`^queue --thread ${thread} --message `));
  assert.match(calls, /WATCH ENDED on nat: service-dark/);
  assert.match(calls, /Re-arm with: agora watch nat --once --json --codex-queue/);
  assert.match(calls, /from agora-watch\]/, "the notice is delivered as the watch's own, never as a room author");
  assert.match(r.stderr, /watch-ended notice delivered to the Codex task/);
  const result = lines.at(-1);
  assert.equal(result.type, "watch-result");
  assert.equal(result.exit, 1);
});

test("a final delivery that fails is logged once and does not change the exit code", {
  skip: process.platform === "win32" ? "the fake Codex binary is a POSIX executable script" : false,
}, async () => {
  const { dir, env } = await seat();
  const record = path.join(dir, "codex-calls.log");
  const fake = path.join(dir, "codex");
  await writeFile(fake, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(record)}\nexit 3\n`);
  await chmod(fake, 0o755);
  const codexHome = path.join(dir, "codex-home");
  const thread = "ended-thread-000002";
  const sessions = path.join(codexHome, "sessions", "2026", "09", "07");
  await mkdir(sessions, { recursive: true });
  await writeFile(path.join(sessions, `rollout-2026-09-07T00-00-00-${thread}.jsonl`), "");
  const r = await agora(["watch", "nat", "--once", "--json", "--codex-queue", "--codex-bin", fake, "--codex-thread", thread],
    { ...env, CODEX_HOME: codexHome });
  assert.equal(r.code, 1);
  let calls = "";
  try { calls = await readFile(record, "utf8"); } catch { calls = ""; }
  const queued = calls.split("\n").filter((l) => l.startsWith("queue --thread"));
  assert.equal(queued.length, 1, `a failed final notice was retried or never attempted: ${JSON.stringify(queued)}`);
  assert.match(r.stderr, /watch-ended notice was not delivered/);
  assert.doesNotMatch(r.stderr, /notice delivered to the Codex task/);
  const result = typed(r.stdout).at(-1);
  assert.equal(result.type, "watch-result");
  assert.equal(result.exit, 1);
});
