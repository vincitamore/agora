// @ts-check
// `agora tui` hands the terminal to the Bun package in tui/. What it must do before spawning
// anything: name a missing entry, a missing install and a missing Bun, each by its own code, and
// pass the room, the flags and this invocation's --config through unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { launchTui, TUI_PACKAGE } from "../src/tui-launch.mjs";

/**
 * a tui package directory: the entry, and node_modules unless `bare`
 * @param {{ bare?: boolean }} [options]
 */
async function pkg({ bare = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-tui-"));
  await writeFile(path.join(root, "index.tsx"), "// a stand-in for the human surface\n");
  if (!bare) await mkdir(path.join(root, "node_modules"));
  return root;
}

/**
 * a spawn that records its call and exits with `code`
 * @param {number} [code]
 */
function recorder(code = 0) {
  /** @type {{ bin: string, args: string[], options: any }[]} */
  const calls = [];
  /** @type {any} */
  const spawn = (/** @type {string} */ bin, /** @type {string[]} */ args, /** @type {any} */ options) => {
    calls.push({ bin, args, options });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", code, null));
    return child;
  };
  return { spawn, calls };
}

test("the shipped package is the default root, and it is the one in this repository", () => {
  assert.ok(TUI_PACKAGE.replaceAll("\\", "/").endsWith("/tui/"), TUI_PACKAGE);
});

test("a missing entry, a missing install and a missing bun are each refused by name, before any spawn", async () => {
  const { spawn, calls } = recorder();
  const empty = await mkdtemp(path.join(tmpdir(), "agora-tui-"));
  await assert.rejects(launchTui({ root: empty, spawn, resolveBun: () => "/bun" }), /tui-entry-absent/);
  const bare = await pkg({ bare: true });
  await assert.rejects(launchTui({ root: bare, spawn, resolveBun: () => "/bun" }), /tui-not-installed/);
  const ready = await pkg();
  await assert.rejects(launchTui({ root: ready, spawn, resolveBun: () => null }), /tui-bun-absent/);
  assert.equal(calls.length, 0, "nothing is spawned until the three are in place");
});

test("the room, the flags and the config are handed to bun with the entry first", async () => {
  const root = await pkg();
  const { spawn, calls } = recorder();
  const code = await launchTui({ root, args: ["example-room", "--name", "operator"], config: "/etc/agora.json", spawn, resolveBun: () => "/bun" });
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, "/bun");
  assert.deepEqual(calls[0].args, [path.join(root, "index.tsx"), "example-room", "--name", "operator", "--config", "/etc/agora.json"]);
  assert.equal(calls[0].options.stdio, "inherit", "the child owns this terminal");
  assert.equal(calls[0].options.cwd, undefined, "and this working directory, so a relative config means what it means elsewhere");
});

test("a --config of its own is not overridden, and the child's exit code is the verb's", async () => {
  const root = await pkg();
  const { spawn, calls } = recorder(3);
  const code = await launchTui({ root, args: ["--config", "./mine.json"], config: "/etc/agora.json", spawn, resolveBun: () => "/bun" });
  assert.equal(code, 3);
  assert.deepEqual(calls[0].args.slice(1), ["--config", "./mine.json"]);
});

test("a spawn that cannot start is an error with the binary in it, and a signal is a failure", async () => {
  const root = await pkg();
  /** @type {any} */
  const failing = () => { const c = new EventEmitter(); queueMicrotask(() => c.emit("error", new Error("ENOENT"))); return c; };
  await assert.rejects(launchTui({ root, spawn: failing, resolveBun: () => "/bun" }), /tui-spawn-failed: \/bun: ENOENT/);
  /** @type {any} */
  const killed = () => { const c = new EventEmitter(); queueMicrotask(() => c.emit("exit", null, "SIGKILL")); return c; };
  assert.equal(await launchTui({ root, spawn: killed, resolveBun: () => "/bun" }), 1);
});
