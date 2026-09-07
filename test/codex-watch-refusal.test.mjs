// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { codexBridgeRefusal } from "../src/codex.mjs";

const bin = fileURLToPath(new URL("../bin/agora.mjs", import.meta.url));
const MISSING_CONFIG = path.join(tmpdir(), `agora-no-config-${process.pid}-codex-refusal.json`);

/**
 * The CLI with a scrubbed environment: no Codex variable leaks in from the seat that runs the
 * suite, and no config is reachable, so the cell reads the verb and not the machine.
 * @param {string[]} args @param {Record<string, string>} env
 */
function run(args, env) {
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (/^CODEX_|^AGORA_CODEX/.test(k)) delete base[k];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], {
      env: { ...base, AGORA_CONFIG: MISSING_CONFIG, AGORA_SESSION: "cli-test", AGORA_ACTOR: "Test/cli", ...env },
      windowsHide: true,
    });
    child.stdin.end();
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("codexBridgeRefusal names the fault and every fix, and stands down for each escape", () => {
  const text = codexBridgeRefusal({}, { CODEX_THREAD_ID: "thread-1" });
  assert.ok(text, "a Codex session with no bridge is refused");
  assert.match(text, /CODEX_THREAD_ID is set/);
  assert.match(text, /--codex-queue/);
  assert.match(text, /start-codex-watch\.sh/);
  assert.match(text, /--codex-server/);
  assert.match(text, /--codex-token-file/);
  assert.match(text, /--print-only/);
  assert.match(text, /delivers to nobody/);
  assert.match(String(codexBridgeRefusal({}, { CODEX_SESSION_ID: "sess-1" })), /CODEX_SESSION_ID is set/);
  // Blank variables are not a Codex session.
  assert.equal(codexBridgeRefusal({}, { CODEX_THREAD_ID: "  " }), undefined);
  assert.equal(codexBridgeRefusal({}, {}), undefined);
  for (const escape of [{ "codex-queue": true }, { "codex-server": "ws://127.0.0.1:4500" }, { "codex-token-file": "/t" }, { "print-only": true }]) {
    assert.equal(codexBridgeRefusal(escape, { CODEX_THREAD_ID: "thread-1" }), undefined, JSON.stringify(escape));
  }
});

test("watch under CODEX_THREAD_ID with no bridge is exit 2 before loadConfig, naming both forms and the escape", async () => {
  const r = await run(["watch", "agora", "--stream", "--follow", "--json"], { CODEX_THREAD_ID: "thread-1" });
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /CODEX_THREAD_ID is set/);
  assert.match(r.stderr, /--codex-queue/);
  assert.match(r.stderr, /--codex-server/);
  assert.match(r.stderr, /--print-only/);
  assert.doesNotMatch(r.stderr, /no config/);
  assert.equal(r.stdout, "");
});

test("watch under CODEX_SESSION_ID alone (older builds) is refused the same way", async () => {
  const r = await run(["watch", "agora", "--once"], { CODEX_SESSION_ID: "sess-1" });
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /CODEX_SESSION_ID is set/);
  assert.doesNotMatch(r.stderr, /no config/);
});

test("the twins: each escape, and no Codex session at all, reaches config (exit 1 on the missing config, never the refusal)", async () => {
  /** @type {{ name: string, args: string[], env: Record<string, string> }[]} */
  const cases = [
    { name: "--codex-queue", args: ["watch", "agora", "--codex-queue"], env: { CODEX_THREAD_ID: "thread-1" } },
    { name: "--codex-server", args: ["watch", "agora", "--codex-server", "ws://127.0.0.1:4500", "--codex-token-file", "/absolute/token"], env: { CODEX_THREAD_ID: "thread-1" } },
    { name: "--print-only", args: ["watch", "agora", "--print-only"], env: { CODEX_THREAD_ID: "thread-1" } },
    { name: "no Codex session", args: ["watch", "agora", "--once"], env: {} },
  ];
  for (const c of cases) {
    const r = await run(c.args, c.env);
    assert.equal(r.code, 1, `${c.name}: ${r.stderr}`);
    assert.match(r.stderr, /no config/, c.name);
    assert.doesNotMatch(r.stderr, /delivers to nobody/, c.name);
  }
});

test("the refusal is the watch verb's alone: read and post under a Codex session reach config", async () => {
  for (const args of [["read", "agora"], ["post", "agora", "hello"]]) {
    const r = await run(args, { CODEX_THREAD_ID: "thread-1" });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /no config/);
    assert.doesNotMatch(r.stderr, /delivers to nobody/);
  }
});
