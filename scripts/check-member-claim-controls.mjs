// Does the suite actually PIN the claim's contracts, or is it green for reasons of its own?
//
//   node scripts/check-member-claim-controls.mjs
//
// One mutant per contract, and a mutant is credited only when the run reddens a cell — with the
// cell READ FROM THE OUTPUT, never chosen in advance. Every run here is the WHOLE suite, the same
// argv `npm test` uses: a mutant run under a name or file filter can only report on the cell its
// author predicted, so a surviving mutant would mean the prediction was wrong rather than that the
// line is unpinned. The predicted cell is printed beside the observed ones, so a mismatch is
// information instead of a silent pass.
//
// Each mutant is a plausible implementation somebody would write, not a scrambling of characters:
//
//   create-not-exclusive       — `w` for `wx`: the create stops being a compare-and-swap, which is
//                                what read-then-unlink and rename-to-tombstone both amount to.
//   spawn-follows-the-create   — the post-create listing's verdict ignored: a create is a win.
//   release-empties-the-claim  — release unlinks instead of marking: the durable floor is gone.
//   prune-takes-its-own-floor  — `>` for `>=`: the holder prunes itself and its number is reissued.
//   loser-removes-the-winner   — the losing taker removes the higher generation, not its own.
//   child-guard-removed        — a replacement spawns beside the dead holder's live Tailcat child.
//   release-ignores-the-child  — a released state published while that child is still running.
//
// `create-not-exclusive` additionally runs the REAL-PROCESS contest probe, because the property it
// breaks — exactly one holder among concurrent takers of one stale record — is one an in-process
// suite cannot exhibit: the event loop walks every contender through the same await points and the
// race never appears.
//
// The checkout is mutated in place and restored, and the restore is proven against the OBJECT
// STORE rather than a captured copy: a capture taken a moment late restores a state that merely
// works, and no suite can tell that apart from the source you meant.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const rel = "src/native-member-claim.mjs";
const file = path.join(repo, rel);

const git = (/** @type {string[]} */ args) =>
  spawnSync("git", args, { cwd: repo, encoding: "utf8" }).stdout.trim();

const committed = git(["rev-parse", `HEAD:${rel}`]);
const onDisk = () => git(["hash-object", file]);
assert.ok(committed, `${rel} is not in HEAD. Commit the repair before calibrating it, or the `
  + "restore below puts back the PRE-FIX code and the calibration measures a different program.");
assert.equal(onDisk(), committed,
  `${rel} differs from HEAD; commit or stash it first, because the restore below restores to HEAD.`);

const original = await readFile(file, "utf8");

/** The whole suite, never a filter. Returns the cells that failed, read from the output. */
function runSuite() {
  const started = Date.now();
  const result = spawnSync(process.execPath, ["--test", "test/**/*.test.mjs"], {
    cwd: repo, encoding: "utf8", timeout: 20 * 60_000, maxBuffer: 128 * 1024 * 1024,
  });
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const failed = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1].trim());
  return { status: result.status, elapsedMs: Date.now() - started, failed, out };
}

/** Eight real processes against one stale generation. */
function runContest() {
  const result = spawnSync(process.execPath, ["scripts/probe-member-claim-contest.mjs"], {
    cwd: repo, encoding: "utf8", timeout: 5 * 60_000,
  });
  return { status: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** @type {{ name: string, from: string, to: string, predicts: RegExp, contest?: boolean }[]} */
const controls = [
  {
    name: "create-not-exclusive",
    from: 'const handle = await open(file, "wx", 0o600);',
    to: 'const handle = await open(file, "w", 0o600);',
    predicts: /O_EXCL admits one/,
    contest: true,
  },
  {
    name: "spawn-follows-the-create",
    from: "  if (after.floor > generation) {",
    to: "  if (false && after.floor > generation) {",
    predicts: /removes only its own file/,
  },
  {
    name: "release-empties-the-claim",
    from: '    const handle = await open(keyClaimFile(dir, generation, "released"), "wx", 0o600);',
    to: "    await rm(keyClaimFile(dir, generation), { force: true }); return true;\n"
      + '    const handle = await open(keyClaimFile(dir, generation, "released"), "wx", 0o600);',
    predicts: /never reissued/,
  },
  {
    name: "prune-takes-its-own-floor",
    from: "    if (Number(match[1]) >= generation) continue;",
    to: "    if (Number(match[1]) > generation) continue;",
    predicts: /floor survives the prune/,
  },
  {
    name: "loser-removes-the-winner",
    from: "  if (after.floor > generation) {\n    await rm(file, { force: true }).catch(() => {});",
    to: "  if (after.floor > generation) {\n    await rm(keyClaimFile(dir, after.floor), { force: true }).catch(() => {});",
    predicts: /removes only its own file|delayed cleanup/,
  },
  {
    name: "child-guard-removed",
    from: "      if (orphans.length)",
    to: "      if (false && orphans.length)",
    predicts: /Tailcat child still answers/,
  },
  {
    name: "release-ignores-the-child",
    from: "    if (liveClaimChildren(scan, generation, deps).length) return false;",
    to: "    if (false && liveClaimChildren(scan, generation, deps).length) return false;",
    predicts: /mark never lands early|still owns a live child/,
  },
];

const baseline = runSuite();
assert.equal(baseline.status, 0,
  `baseline is not green, so nothing below discriminates:\n${baseline.out.slice(-4000)}`);
console.log(JSON.stringify({ baseline: "green", elapsedMs: baseline.elapsedMs }));

const cleanContest = runContest();
assert.equal(cleanContest.status, 0, `the contest probe is not green at HEAD:\n${cleanContest.out}`);
console.log(JSON.stringify({ contest: "one holder every trial" }));

/** @type {any[]} */
const report = [];
try {
  for (const control of controls) {
    assert.equal(original.split(control.from).length, 2,
      `control anchor is not unique, or has moved: ${control.name}`);
    await writeFile(file, original.replace(control.from, control.to), { encoding: "utf8" });
    assert.notEqual(onDisk(), committed, `${control.name}: the mutant did not change the file`);

    const run = runSuite();
    assert.equal(run.status, 1, `${control.name}: the suite stayed GREEN; that line is unpinned`);
    assert.ok(run.failed.length,
      `${control.name}: the suite failed with no named cell — a load error, not a discriminated defect`);
    const row = {
      control: control.name,
      reddened: run.failed,
      predicted: String(control.predicts),
      matchedPrediction: run.failed.some((cell) => control.predicts.test(cell)),
      elapsedMs: run.elapsedMs,
    };
    if (control.contest) {
      const contested = runContest();
      assert.notEqual(contested.status, 0, `${control.name}: the contest probe stayed green`);
      assert.match(contested.out, /FAIL: \d+ concurrent holders admitted/, contested.out);
      Object.assign(row, { contest: /FAIL: .*/.exec(contested.out)?.[0] });
    }
    report.push(row);
    console.log(JSON.stringify(row));
    assert.ok(row.matchedPrediction,
      `${control.name}: the suite reddened, but not the cell written for this contract — `
      + `predicted ${control.predicts}, observed ${JSON.stringify(run.failed)}`);
  }
} finally {
  await writeFile(file, original, { encoding: "utf8" });
}

assert.equal(onDisk(), committed, "the restored file is not byte-identical to HEAD");
const restored = runSuite();
assert.equal(restored.status, 0, `restored suite is not green:\n${restored.out.slice(-4000)}`);
console.log(JSON.stringify({
  controls: report.length, restored: "green and byte-identical to HEAD", blob: committed,
}));
