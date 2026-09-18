// The native read plan is decided by a kernel generated from spec/cursor.bend, whose laws
// (spec/LAWS.bend) the Bend 2 checker proves before the file is emitted. These tests pin the
// kernel's JavaScript face (BigInt in, tagged objects out) and, where a Bend checkout and bun
// are present, that the committed file is a fresh regeneration of the proven source.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";
import K from "../src/native-cursor.kernel.mjs";

const ROOT = resolve(import.meta.dirname, "..");

test("a foreign epoch is refused and advances nothing", () => {
  const p = K.plan(false, 10n, 3n, 4n);
  assert.equal(p.$, "RefusedEpoch");
  assert.equal(K.next(3n, p), 3n);
  assert.equal(K.delivered(p), 0n);
});

test("a future sequence is refused and advances nothing", () => {
  const p = K.plan(true, 10n, 11n, 4n);
  assert.equal(p.$, "RefusedFuture");
  assert.equal(K.next(11n, p), 11n);
});

test("a read is the rows after the cursor, capped by limit and by committed", () => {
  const p = K.plan(true, 10n, 3n, 4n);
  assert.deepEqual(p, { $: "Slice", from: 4n, to: 7n });
  assert.equal(K.next(3n, p), 7n);
  assert.equal(K.delivered(p), 4n);
  const tail = K.plan(true, 10n, 8n, 4n);
  assert.deepEqual(tail, { $: "Slice", from: 9n, to: 10n });
  assert.equal(K.next(8n, tail), 10n);
});

test("a cursor at the committed sequence delivers nothing and stays put", () => {
  const p = K.plan(true, 10n, 10n, 4n);
  assert.equal(p.$, "Slice");
  assert.equal(K.delivered(p), 0n);
  assert.equal(K.next(10n, p), 10n);
});

test("consecutive reads are contiguous and disjoint", () => {
  let cursor = 0n;
  const seen = [];
  for (let i = 0; i < 6; i++) {
    const p = K.plan(true, 10n, cursor, 3n);
    if (p.$ !== "Slice") break;
    for (let s = p.from; s <= p.to; s++) seen.push(s);
    cursor = K.next(cursor, p);
  }
  assert.deepEqual(seen, [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n]);
  assert.equal(cursor, 10n);
});

test("the committed kernel is a fresh regeneration of the proven source", (t) => {
  const clone = process.env.BEND_CLONE ?? resolve(ROOT, "..", "bend-src");
  const bun = spawnSync("bun", ["--version"], { encoding: "utf8" });
  if (bun.error || !existsSync(resolve(clone, "bend2", "main.ts"))) {
    t.skip("needs bun and a Bend checkout (BEND_CLONE); the regeneration gate runs where they exist");
    return;
  }
  const r = spawnSync("bun", [resolve(ROOT, "spec", "build-kernel.ts"), "--check"], { encoding: "utf8", env: { ...process.env, BEND_CLONE: clone } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
