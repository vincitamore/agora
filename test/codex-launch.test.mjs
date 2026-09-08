import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  const help = spawnSync(process.execPath, [bin, "--help"], { encoding: "utf8" });
  assert.match(help.stdout, /\[-- <codex args>]  start or reuse/);
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
  let uuidSequence = 0;
  const deps = {
    spawn: /** @type {any} */ (fakeSpawn),
    /** @param {{endpoint:string}} descriptor */
    probe: async (descriptor) => descriptor.endpoint === readyEndpoint,
    reservePort: async () => 4678,
    uuid: () => `00000000-0000-4000-8000-${String(++uuidSequence).padStart(12, "0")}`,
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

test("an unpublished or malformed lock remains unknown through the bound and starts nothing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agora-codex-unknown-lock-"));
  const paths = codexControlPaths(dir);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.lock, "");
  let spawns = 0;
  try {
    await assert.rejects(ensureCodexServer({ stateRoot: dir, timeoutMs: 10, deps: {
      probe: async () => false,
      spawn: /** @type {any} */ (() => { spawns += 1; throw new Error("must not spawn"); }),
      sleep: async () => { await new Promise((resolve) => setTimeout(resolve, 2)); },
    } }), /unknown ownership/);
    assert.equal(spawns, 0);
    assert.equal(await readFile(paths.lock, "utf8"), "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a contender paused before atomic owner publication cannot create a second server", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agora-codex-publish-race-"));
  const fakeCodex = path.join(dir, process.platform === "win32" ? "codex.exe" : "codex");
  await writeFile(fakeCodex, "fake", { mode: 0o700 });
  /** @type {()=>void} */
  let releaseFirst = () => {};
  const firstPaused = new Promise((resolve) => { releaseFirst = () => resolve(undefined); });
  /** @type {()=>void} */
  let firstReached = () => {};
  const reached = new Promise((resolve) => { firstReached = () => resolve(undefined); });
  let spawns = 0;
  /** @type {string | undefined} */
  let readyEndpoint;
  let uuidSequence = 0;
  /** @param {string} _command @param {string[]} _args @param {any} options */
  const fakeSpawn = (_command, _args, options) => {
    spawns += 1; readyEndpoint = options.env.AGORA_CODEX_SERVER;
    return { pid: 44444, unref() {} };
  };
  const common = {
    spawn: /** @type {any} */ (fakeSpawn),
    /** @param {{endpoint:string}} descriptor */
    probe: async descriptor => descriptor.endpoint === readyEndpoint,
    reservePort: async () => 4680,
    uuid: () => `20000000-0000-4000-8000-${String(++uuidSequence).padStart(12, "0")}`,
    token: () => "private-token",
    sleep: async () => { await new Promise((resolve) => setImmediate(resolve)); },
  };
  try {
    const first = ensureCodexServer({ stateRoot: dir, codexPath: fakeCodex, deps: {
      ...common, beforeLockPublish: async () => { firstReached(); await firstPaused; },
    } });
    await reached;
    const second = await ensureCodexServer({ stateRoot: dir, codexPath: fakeCodex, deps: common });
    releaseFirst();
    const firstResult = await first;
    assert.equal(spawns, 1);
    assert.equal(firstResult.pid, second.pid);
  } finally {
    releaseFirst();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
  }
});

test("concurrent reclaimers of one proven-dead owner still start only one replacement", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agora-codex-stale-lock-"));
  const paths = codexControlPaths(dir);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.lock, `${JSON.stringify({ pid: 919191, token: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", at: new Date().toISOString() })}\n`);
  const fakeCodex = path.join(dir, process.platform === "win32" ? "codex.exe" : "codex");
  await writeFile(fakeCodex, "fake", { mode: 0o700 });
  let spawns = 0;
  let uuidSequence = 0;
  /** @type {string | undefined} */
  let readyEndpoint;
  /** @param {string} _command @param {string[]} _args @param {any} options */
  const fakeSpawn = (_command, _args, options) => {
    spawns += 1; readyEndpoint = options.env.AGORA_CODEX_SERVER;
    return { pid: 45454, unref() {} };
  };
  const deps = {
    spawn: /** @type {any} */ (fakeSpawn),
    /** @param {{endpoint:string}} descriptor */
    probe: async descriptor => descriptor.endpoint === readyEndpoint,
    /** @param {number} pid */
    processAlive: pid => pid !== 919191,
    reservePort: async () => 4789,
    uuid: () => `10000000-0000-4000-8000-${String(++uuidSequence).padStart(12, "0")}`,
    token: () => "private-token",
    sleep: async () => { await new Promise((resolve) => setImmediate(resolve)); },
  };
  try {
    const results = await Promise.all([
      ensureCodexServer({ stateRoot: dir, codexPath: fakeCodex, deps }),
      ensureCodexServer({ stateRoot: dir, codexPath: fakeCodex, deps }),
    ]);
    assert.equal(spawns, 1);
    assert.equal(results[0].pid, results[1].pid);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
  }
});
