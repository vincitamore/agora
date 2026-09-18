// C0 for the kernels' laws: every law in spec/LAWS.bend, spec/BOARD-LAWS.bend and
// spec/SETTLEMENT-LAWS.bend ships a known-red mutation of its model under
// spec/laws-red/<kernel>/<law>/, and spec/laws-check.ts proves the real files green, greps the
// closure, checks the import chain and law/def parity, and reddens the gate on every fixture at
// that law. Runs where bun and a Bend checkout exist; skips by name elsewhere.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const SPEC = resolve(ROOT, "spec");
const LAWS = { cursor: "LAWS.bend", board: "BOARD-LAWS.bend", settlement: "SETTLEMENT-LAWS.bend" };

test("every law in every kernel has a red fixture directory", () => {
  for (const [kernel, file] of Object.entries(LAWS)) {
    const names = [...readFileSync(resolve(SPEC, file), "utf8").matchAll(/^law ([A-Za-z0-9_.]+):/gm)].map((m) => m[1]);
    assert.ok(names.length > 0, `${file} states laws`);
    const dir = resolve(SPEC, "laws-red", kernel);
    const have = existsSync(dir) ? readdirSync(dir) : [];
    assert.deepEqual(names.filter((n) => !have.includes(n)), [], `${file}: laws without a red fixture`);
    assert.deepEqual(have.filter((d) => !names.includes(d)), [], `laws-red/${kernel}: fixtures naming no law`);
  }
});

test("the laws gate is green: real proofs check, and every red fixture reddens at its law", (t) => {
  const clone = process.env.BEND_CLONE ?? resolve(ROOT, "..", "bend-src");
  const bun = spawnSync("bun", ["--version"], { encoding: "utf8" });
  if (bun.error || !existsSync(resolve(clone, "bend2", "main.ts"))) {
    t.skip("needs bun and a Bend checkout (BEND_CLONE); the laws gate runs where they exist");
    return;
  }
  const r = spawnSync("bun", [resolve(SPEC, "laws-check.ts")], { encoding: "utf8", env: { ...process.env, BEND_CLONE: clone } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /\n0 red of \d+ items/);
});
