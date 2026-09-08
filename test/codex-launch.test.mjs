import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CODEX_REMOTE_TOKEN_ENV,
  codexAppServerArgs,
  codexAttachedArgs,
  codexAttachedEnvironment,
  codexControlPaths,
  ensureCodexServer,
} from "../src/codex-launch.mjs";

test("schema exposes the attached Codex launcher", () => {
  const bin = path.resolve(import.meta.dirname, "..", "bin", "agora.mjs");
  const result = spawnSync(process.execPath, [bin, "schema", "--json"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const schema = JSON.parse(result.stdout);
  assert.deepEqual(schema.verbs.codex.args, ["status | [resume <thread>] | [-- <codex args>]"]);
  assert.match(schema.verbs.codex.does, /authenticated loopback/);
});

test("launch argv keeps the capability out of commands", () => {
  const tokenFile = path.resolve("token-file");
  assert.deepEqual(codexAppServerArgs("ws://127.0.0.1:4567", tokenFile), [
    "app-server", "--listen", "ws://127.0.0.1:4567", "--ws-auth", "capability-token", "--ws-token-file", tokenFile,
  ]);
  assert.deepEqual(codexAttachedArgs("ws://127.0.0.1:4567", ["resume", "thread-123456"]), [
    "--remote", "ws://127.0.0.1:4567", "--remote-auth-token-env", CODEX_REMOTE_TOKEN_ENV, "resume", "thread-123456",
  ]);
  const childEnv = codexAttachedEnvironment({ KEEP: "yes" }, "ws://127.0.0.1:4567", tokenFile, "private-token");
  assert.equal(childEnv.KEEP, "yes");
  assert.equal(childEnv.AGORA_CODEX_SERVER, "ws://127.0.0.1:4567/");
  assert.equal(childEnv.AGORA_CODEX_TOKEN_FILE, tokenFile);
  assert.equal(childEnv[CODEX_REMOTE_TOKEN_ENV], "private-token");
});

test("server start publishes only references and later reuses its authenticated descriptor", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agora-codex-launch-"));
  const fakeCodex = path.join(dir, process.platform === "win32" ? "codex.exe" : "codex");
  await writeFile(fakeCodex, "fake", { mode: 0o700 });
  /** @type {Array<{command:string,args:string[],options:any}>} */
  const calls = [];
  const live = new Set();
  /** @param {string} command @param {string[]} args @param {any} options */
  const fakeSpawn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = /** @type {any} */ (new EventEmitter());
    child.pid = 42424;
    child.unref = () => {};
    live.add(options.env.AGORA_CODEX_SERVER);
    return /** @type {any} */ (child);
  };
  /** @param {{endpoint:string}} descriptor */
  const probe = async (descriptor) => live.has(descriptor.endpoint);
  try {
    const first = await ensureCodexServer({
      stateRoot: dir,
      codexPath: fakeCodex,
      deps: {
        spawn: /** @type {any} */ (fakeSpawn),
        probe,
        reservePort: async () => 4567,
        uuid: () => "generation-one",
        token: () => "private-token",
        sleep: async () => {},
      },
    });
    assert.equal(first.reused, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.env.AGORA_CODEX_SERVER, "ws://127.0.0.1:4567/");
    assert.equal(calls[0].options.env.AGORA_CODEX_TOKEN_FILE, first.tokenFile);
    assert.equal(calls[0].options.env[CODEX_REMOTE_TOKEN_ENV], undefined);
    assert.equal(JSON.stringify(JSON.parse(await readFile(codexControlPaths(dir).descriptor, "utf8"))).includes("private-token"), false);
    assert.equal(await readFile(first.tokenFile, "utf8"), "private-token");

    const second = await ensureCodexServer({ stateRoot: dir, codexPath: fakeCodex, deps: { spawn: /** @type {any} */ (fakeSpawn), probe } });
    assert.equal(second.reused, true);
    assert.equal(calls.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("simultaneous terminals converge on one managed app server", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agora-codex-concurrent-"));
  const fakeCodex = path.join(dir, process.platform === "win32" ? "codex.exe" : "codex");
  await writeFile(fakeCodex, "fake", { mode: 0o700 });
  let spawns = 0;
  /** @type {string | undefined} */
  let readyEndpoint;
  /** @param {string} _command @param {string[]} _args @param {any} options */
  const fakeSpawn = (_command, _args, options) => {
    spawns += 1;
    readyEndpoint = options.env.AGORA_CODEX_SERVER;
    const child = /** @type {any} */ (new EventEmitter());
    child.pid = 43434;
    child.unref = () => {};
    return child;
  };
  const deps = {
    spawn: /** @type {any} */ (fakeSpawn),
    /** @param {{endpoint:string}} descriptor */
    probe: async (descriptor) => descriptor.endpoint === readyEndpoint,
    reservePort: async () => 4678,
    uuid: () => "single-generation",
    token: () => "private-token",
    sleep: async () => { await new Promise((resolve) => setImmediate(resolve)); },
  };
  try {
    const [left, right] = await Promise.all([
      ensureCodexServer({ stateRoot: dir, codexPath: fakeCodex, deps }),
      ensureCodexServer({ stateRoot: dir, codexPath: fakeCodex, deps }),
    ]);
    assert.equal(spawns, 1);
    assert.equal(left.pid, right.pid);
    assert.equal(left.endpoint, right.endpoint);
    assert.deepEqual([left.reused, right.reused].sort(), [false, true]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
