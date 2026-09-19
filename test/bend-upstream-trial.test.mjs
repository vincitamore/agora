// @ts-check
// The upstream trial (scripts/bend-upstream-trial.mjs) and the BEND_PIN_TRIAL override it sets:
// the gates compare the checkout against the trial commit, by name, instead of the pin (so a
// trial never proves against whatever happens to be checked out), the trial's usage is refused
// before any fetch, and a trial against a repository that is not Bend ends at the first gate with
// a parseable report and exit 1, never at the pin file or this tree. Rows that run Bend skip by
// name without bun.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const TRIAL = join(ROOT, "scripts", "bend-upstream-trial.mjs");
const shell = process.platform === "win32";
const hasBun = spawnSync("bun", ["--version"], { encoding: "utf8", shell }).status === 0;
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

/** a git repository with one commit that has a bend2/main.ts, so the gates pass the "is a checkout" test and reach the commit check */
async function fakeBend() {
  const dir = await mkdtemp(join(tmpdir(), "fake-bend-"));
  const git = (/** @type {string[]} */ a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", env: gitEnv });
  git(["init", "-q"]);
  await mkdir(join(dir, "bend2"), { recursive: true });
  await writeFile(join(dir, "bend2", "main.ts"), "console.log('not bend');\n");
  await writeFile(join(dir, "bend2", "bend.ts"), "export {};\n");
  await writeFile(join(dir, "bend2", "comp.ts"), "export {};\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "not bend"]);
  return { dir, head: git(["rev-parse", "HEAD"]).trim() };
}

test("the trial refuses a usage error before fetching anything", () => {
  const r = spawnSync(process.execPath, [TRIAL, "--ref"], { encoding: "utf8", windowsHide: true });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--ref needs a value/);
  const r2 = spawnSync(process.execPath, [TRIAL, "--bogus"], { encoding: "utf8", windowsHide: true });
  assert.equal(r2.status, 2);
  assert.match(r2.stderr, /unknown argument --bogus/);
});

test("BEND_PIN_TRIAL makes both gates compare against the trial commit by name, not the pin and not whatever is checked out", async (t) => {
  if (!hasBun) return t.skip("needs bun");
  const fake = await fakeBend();
  try {
    const other = "0123456789abcdef0123456789abcdef01234567";
    for (const gate of ["spec/build-kernel.ts", "spec/laws-check.ts"]) {
      const r = spawnSync("bun", [join(ROOT, gate)], { encoding: "utf8", shell, env: { ...process.env, BEND_CLONE: fake.dir, BEND_PIN_TRIAL: other } });
      assert.equal(r.status, 2, `${gate}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /the trial commit is 0123456789abcdef0123456789abcdef01234567 \(BEND_PIN_TRIAL\)/, gate);
      assert.ok(r.stderr.includes(fake.head), `${gate} names the checkout's commit`);
      assert.doesNotMatch(r.stderr, /TRIAL: proving/, `${gate} prints no trial banner for a refused checkout`);
    }
  } finally {
    await rm(fake.dir, { recursive: true, force: true });
  }
});

test("a trial against a repository that is not Bend ends at the proofs gate with a report and exit 1, and touches neither the pin nor this tree", async (t) => {
  if (!hasBun) return t.skip("needs bun");
  const fake = await fakeBend();
  const into = await mkdtemp(join(tmpdir(), "trial-into-"));
  const reportFile = join(into, "report.json");
  const pinBefore = await readFile(join(ROOT, "spec", "bend.pin.json"), "utf8");
  const status = execFileSync("git", ["status", "--porcelain", "--", "spec", "src"], { cwd: ROOT, encoding: "utf8" });
  try {
    const r = spawnSync(process.execPath, [TRIAL, "--upstream", fake.dir, "--ref", "HEAD", "--into", join(into, "head"), "--report", reportFile], { encoding: "utf8", windowsHide: true, timeout: 120_000 });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const line = r.stdout.trim().split(/\r?\n/).at(-1) ?? "";
    const report = JSON.parse(line);
    assert.equal(report.type, "bend-upstream-trial");
    assert.equal(report.head, fake.head);
    assert.equal(report.headSubject, "not bend");
    assert.equal(report.atPin, false);
    assert.equal(report.gates.proofs, "red");
    assert.equal(report.gates.laws, "not-run");
    assert.equal(report.verdict, "gate-failed:proofs");
    assert.deepEqual(JSON.parse(await readFile(reportFile, "utf8")), report, "--report writes the same line");
    assert.match(r.stderr, /pin {2}[0-9a-f]{40}/);
    assert.equal(await readFile(join(ROOT, "spec", "bend.pin.json"), "utf8"), pinBefore, "the pin is untouched");
    assert.equal(execFileSync("git", ["status", "--porcelain", "--", "spec", "src"], { cwd: ROOT, encoding: "utf8" }), status, "spec/ and src/ are as they were");
  } finally {
    await rm(fake.dir, { recursive: true, force: true });
    await rm(into, { recursive: true, force: true });
  }
});
