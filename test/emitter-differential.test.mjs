// @ts-check
// The emitter differential (scripts/probe-emitter-differential.mjs) as a gate: the interpreter the
// laws are proved about and the emitted JS the product runs must agree on random inputs for every
// kernel, and the comparator must be shown to catch a planted disagreement. Skips by name where
// bun or a checkout at the pin is absent; CI runs the checkout step first, so it never skips there.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const clone = process.env.BEND_CLONE ?? resolve(ROOT, "..", "bend-src");
const shell = process.platform === "win32";
const bun = spawnSync("bun", ["--version"], { encoding: "utf8", shell });
const available = bun.status === 0 && existsSync(join(clone, "bend2", "main.ts"));

/**
 * @param {string[]} extra
 * @returns {{ status: number | null, obs: Array<Record<string, any>>, err: string }}
 */
function probe(extra) {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", "probe-emitter-differential.mjs"), "--cases", "120", "--seed", "11", ...extra], { encoding: "utf8", env: { ...process.env, BEND_CLONE: clone } });
  const obs = r.stdout.split(/\r?\n/).filter((/** @type {string} */ l) => l.trim().startsWith("{")).map((/** @type {string} */ l) => JSON.parse(l));
  return { status: r.status, obs, err: r.stderr };
}

test("interpreter and emitted JS agree on random inputs for every kernel", (/** @type {import("node:test").TestContext} */ t) => {
  if (!available) return t.skip("bun or a Bend checkout is absent");
  const { status, obs, err } = probe([]);
  assert.equal(status, 0, err);
  assert.deepEqual(obs.map((o) => String(o.kernel)).sort(), ["board", "cursor", "settlement"]);
  for (const o of obs) { assert.equal(o.cases, 120, JSON.stringify(o)); assert.equal(o.mismatches, 0, JSON.stringify(o)); assert.equal(o.pass, true); }
});

test("the comparator reports a planted disagreement (self-test)", (/** @type {import("node:test").TestContext} */ t) => {
  if (!available) return t.skip("bun or a Bend checkout is absent");
  const { status, obs } = probe(["--self-test", "--kernel", "board"]);
  assert.equal(status, 0);
  assert.equal(obs.length, 1);
  assert.equal(obs[0].selfTest, true);
  assert.equal(obs[0].mismatches, obs[0].planted);
  assert.ok(obs[0].planted >= 1);
  assert.equal(obs[0].pass, true);
});
