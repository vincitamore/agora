// @ts-check
// The stranger's row of the Tailcat provenance: `scripts/vendor-tailcat.mjs verify` refuses, by name,
// a checkout that is not the pinned source before it asks for Go, refuses a wrong OS and a missing
// argument, and the recipe it would rebuild with is the one lock.json records. The rebuild itself
// needs Go 1.27.0 and the pinned checkout; it runs where Go is (vendor/tailcat/README.md).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts", "vendor-tailcat.mjs");
const run = (/** @type {string[]} */ args, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, ...env }, windowsHide: true });

test("verify refuses a missing or wrong OS argument before anything else", () => {
  const r = run(["verify"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Usage: verify <upstream-checkout> <windows\|linux\|darwin>/);
  const r2 = run(["verify", ".", "plan9"]);
  assert.notEqual(r2.status, 0);
  assert.match(r2.stderr, /Usage: verify/);
});

test("verify refuses a checkout whose HEAD is not the pinned revision, naming both, before asking for Go", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tailcat-verify-"));
  try {
    const source = JSON.parse(await readFile(join(ROOT, "vendor", "tailcat", "source.json"), "utf8"));
    const git = (/** @type {string[]} */ a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    git(["init", "-q"]);
    await writeFile(join(dir, "build-tags.txt"), "netgo\n");
    git(["add", "build-tags.txt"]);
    git(["commit", "-q", "-m", "not the pinned source"]);
    git(["tag", source.tag]);
    const head = git(["rev-parse", "HEAD"]).trim();
    const r = run(["verify", dir, "linux"], { AGORA_GO: "a-go-that-must-not-be-called" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Pinned tag\/revision mismatch/);
    assert.ok(r.stderr.includes(head) && r.stderr.includes(source.revision), "the refusal names the checkout's HEAD and the pinned revision");
    assert.doesNotMatch(r.stderr, /a-go-that-must-not-be-called/, "Go was never asked for");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("lock.json records the recipe verify rebuilds with, and it is the reproducible one", async () => {
  const lock = JSON.parse(await readFile(join(ROOT, "vendor", "tailcat", "lock.json"), "utf8"));
  const source = JSON.parse(await readFile(join(ROOT, "vendor", "tailcat", "source.json"), "utf8"));
  assert.deepEqual(lock.source, source, "lock and source agree, so verify compares against the pin it names");
  assert.deepEqual(lock.build.flags, ["-trimpath", "-buildvcs=false"]);
  assert.equal(lock.build.cgo, false);
  assert.equal(lock.build.go, `go${source.go}`);
  assert.ok(lock.build.ldflags.includes("-s") && lock.build.ldflags.includes("-w"));
  assert.ok(lock.build.ldflags.some((/** @type {string} */ f) => f === `-X main.version=${source.tag}`));
  assert.deepEqual(Object.keys(lock.targets).sort(), ["darwin-amd64", "darwin-arm64", "linux-amd64", "linux-arm64", "windows-amd64", "windows-arm64"]);
  for (const [target, entry] of Object.entries(lock.targets)) {
    assert.match(/** @type {any} */ (entry).sha256, /^[a-f0-9]{64}$/, target);
    assert.match(/** @type {any} */ (entry).capsuleSha256, /^[a-f0-9]{64}$/, target);
  }
});
