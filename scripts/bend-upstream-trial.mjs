#!/usr/bin/env node
// Try the kernels against upstream Bend's head and say whether the pin can advance.
//
//   node scripts/bend-upstream-trial.mjs [--ref <ref>] [--upstream <git url>] [--into <dir>]
//                                        [--report <file>] [--keep]
//
// Fetches <ref> (default HEAD) of the upstream named by spec/bend.pin.json (or --upstream) into
// <dir>, copies this repository's committed tree (a detached worktree of HEAD) into a scratch directory,
// and there, with BEND_CLONE at the fetched commit and BEND_PIN_TRIAL naming it, runs the gates in
// order: the three PROOFs with regeneration (spec/build-kernel.ts), C0 for laws
// (spec/laws-check.ts), the emitter differential (test/emitter-differential.test.mjs), and the
// kernel and consumer suites (test/native-*.test.mjs, test/carry*.test.mjs,
// test/export-record.test.mjs). The first red gate ends the run with its output. The last line on
// stdout is one JSON report: the pin, the head, which committed kernels the head's emitter would
// change, each gate's state, and the verdict `pin-can-advance` or `gate-failed:<gate>`. Exit 0
// only on `pin-can-advance`.
//
// This file never edits spec/bend.pin.json, never writes under this repository, and never runs
// anything outside the scratch copy: advancing the pin is a reviewed pull request that re-clones,
// regenerates and re-proves (the pin's own note), and this is the report that says whether it
// would go green. --keep leaves the scratch copy for reading; --report also writes the JSON there.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PIN = JSON.parse(readFileSync(join(ROOT, "spec", "bend.pin.json"), "utf8"));
const KERNELS = ["cursor", "board", "settlement"].map((k) => `src/native-${k}.kernel.mjs`);
const shell = process.platform === "win32";

/** @param {string} cmd @param {string[]} args @param {{cwd?: string, env?: Record<string, string | undefined>}} [o] */
function run(cmd, args, o = {}) {
  const r = spawnSync(cmd, args, { cwd: o.cwd, encoding: "utf8", env: { ...process.env, ...o.env }, windowsHide: true, shell: shell && cmd !== "git" && cmd !== process.execPath, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, out: r.stdout ?? "", err: r.stderr ?? "", spawnError: r.error };
}

/** @param {string} msg */
function usage(msg) {
  console.error(`${msg}\nUsage: node scripts/bend-upstream-trial.mjs [--ref <ref>] [--upstream <git url>] [--into <dir>] [--report <file>] [--keep]`);
  process.exit(2);
}

/** @param {string[]} argv */
function parse(argv) {
  const o = { ref: "HEAD", upstream: PIN.upstream, into: "", report: "", keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined || v.startsWith("--")) usage(`${a} needs a value`); return v; };
    if (a === "--ref") o.ref = val();
    else if (a === "--upstream") o.upstream = val();
    else if (a === "--into") o.into = val();
    else if (a === "--report") o.report = val();
    else if (a === "--keep") o.keep = true;
    else usage(`unknown argument ${a}`);
  }
  if (!o.into) o.into = process.env.RUNNER_TEMP ? join(process.env.RUNNER_TEMP, "bend-head") : join(tmpdir(), "bend-head");
  return o;
}

/** @param {string} dir @param {string} url @param {string} ref */
function fetchHead(dir, url, ref) {
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, ".git"))) { const i = run("git", ["init", "-q"], { cwd: dir }); if (i.status !== 0) throw new Error(`git init failed in ${dir}: ${i.err}`); }
  const f = run("git", ["fetch", "-q", "--depth", "1", url, ref], { cwd: dir });
  if (f.status !== 0) throw new Error(`could not fetch ${ref} from ${url}: ${f.err.trim().split("\n").at(-1)}`);
  const co = run("git", ["checkout", "-q", "--detach", "FETCH_HEAD"], { cwd: dir });
  if (co.status !== 0) throw new Error(`checkout failed: ${co.err}`);
  const sha = run("git", ["rev-parse", "HEAD"], { cwd: dir }).out.trim();
  const subject = run("git", ["log", "-1", "--format=%s"], { cwd: dir }).out.trim();
  return { sha, subject };
}

/** the committed tree of this repository as a detached scratch worktree (uncommitted edits are not part of a trial); removed by scratchDrop */
function scratchCopy() {
  const dir = join(mkdtempSync(join(tmpdir(), "agora-bend-trial-")), "tree");
  run("git", ["-C", ROOT, "worktree", "prune"]);
  const a = run("git", ["-C", ROOT, "worktree", "add", "-q", "--detach", dir, "HEAD"]);
  if (a.status !== 0) throw new Error(`git worktree add failed: ${a.err}`);
  return dir;
}

/** @param {string} dir */
function scratchDrop(dir) {
  run("git", ["-C", ROOT, "worktree", "remove", "--force", dir]);
  rmSync(dirname(dir), { recursive: true, force: true });
}

/** @param {string} file */
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** @param {string} s @param {number} n */
const tail = (s, n = 60) => s.trim().split(/\r?\n/).slice(-n).join("\n");

function main(argv) {
  const o = parse(argv);
  const head = fetchHead(resolve(o.into), o.upstream, o.ref);
  const pinShort = PIN.sha.slice(0, 7);
  console.error(`pin  ${PIN.sha} (${PIN.version})`);
  console.error(`head ${head.sha} (${head.subject})`);
  const report = { type: "bend-upstream-trial", pin: PIN.sha, pinVersion: PIN.version, head: head.sha, headSubject: head.subject, atPin: head.sha === PIN.sha, kernelsChanged: /** @type {string[]} */ ([]), gates: /** @type {Record<string, string>} */ ({ proofs: "not-run", laws: "not-run", differential: "not-run", suites: "not-run" }), verdict: "", scratch: "" };

  const copy = scratchCopy();
  report.scratch = o.keep ? copy : "";
  const env = { BEND_CLONE: resolve(o.into), BEND_PIN_TRIAL: head.sha };
  const before = Object.fromEntries(KERNELS.map((k) => [k, sha256(join(copy, k))]));
  let failed = "";
  /** @param {string} name @param {() => {status: number | null, out: string, err: string, spawnError?: Error}} f */
  const gate = (name, f) => {
    if (failed) return;
    console.error(`== ${name}`);
    const r = f();
    const ok = r.status === 0 && !r.spawnError;
    report.gates[name] = ok ? "green" : "red";
    if (!ok) {
      failed = name;
      console.error(`${name} failed (exit ${r.status ?? r.spawnError?.message})`);
      console.log(tail(r.out + "\n" + r.err, 80));
    }
  };
  gate("proofs", () => run("bun", [join(copy, "spec", "build-kernel.ts")], { cwd: copy, env }));
  for (const k of KERNELS) if (existsSync(join(copy, k)) && sha256(join(copy, k)) !== before[k]) report.kernelsChanged.push(k);
  gate("laws", () => run("bun", [join(copy, "spec", "laws-check.ts")], { cwd: copy, env }));
  gate("differential", () => run(process.execPath, ["--test", "test/emitter-differential.test.mjs"], { cwd: copy, env }));
  gate("suites", () => {
    const files = readdirSync(join(copy, "test")).filter((f) => /^(native-.*|carry.*|export-record)\.test\.mjs$/.test(f)).map((f) => `test/${f}`);
    return run(process.execPath, ["--test", ...files], { cwd: copy, env });
  });
  report.verdict = failed ? `gate-failed:${failed}` : "pin-can-advance";
  if (o.keep) console.error(`scratch worktree kept at ${copy}; drop it with: git worktree remove --force ${copy}`);
  else scratchDrop(copy);

  const line = JSON.stringify(report);
  if (o.report) writeFileSync(o.report, line + "\n");
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = Object.entries(report.gates).map(([g, s]) => `| ${g} | ${s} |`).join("\n");
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Bend upstream trial: ${report.verdict}\n\npin \`${pinShort}\` (${PIN.version}), head \`${head.sha.slice(0, 7)}\` (${head.subject})\n\n| gate | state |\n|---|---|\n${rows}\n\nkernels the head's emitter changes: ${report.kernelsChanged.length ? report.kernelsChanged.join(", ") : "none"}\n`);
  }
  console.log(line);
  return failed ? 1 : 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
