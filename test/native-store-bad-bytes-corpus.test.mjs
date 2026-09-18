// @ts-check
// The committed corpus under test/fixtures/native-store-bad/ must be exactly what
// scripts/make-bad-bytes-corpus.mjs writes: a hand-edited case, or a case whose bytes drifted
// from the store's own writer, reds here rather than being trusted as an exhibit.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("the bad-bytes corpus is a fresh build of its generator", () => {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", "make-bad-bytes-corpus.mjs"), "--check"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /^ok /m);
});
