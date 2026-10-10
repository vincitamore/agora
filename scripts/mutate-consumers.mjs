#!/usr/bin/env node
// C0 for the kernels' consumers. The kernels are proved; what maps a room or a store onto them
// (src/carry.mjs: the fold that asserts and retracts; src/native-store.mjs: the append and read
// paths that call the kernels and apply their verdicts) is ordinary code, and a defect there
// passes every proof. src/client.mjs (the app client: what an app's request, receipt and
// subscription become) is the same kind of consumer, of the service rather than a kernel. This
// script applies one small mutation at a time to those files, runs the
// tests that import them, and reports every mutant NO test reddened: an untested seam, named by
// file, line and the change that survived. It writes to a scratch copy of each file and restores
// the original after every mutant, and it refuses to run on a dirty target.
//
//   node scripts/mutate-consumers.mjs [--file src/carry.mjs] [--lines <a-b,c>] [--from <n>] [--limit <n>] [--json] [--report <path>]
//
// `--from <n>` skips the first n mutants, so a sweep longer than one sitting runs as slices
// (`--from 0 --limit 90`, `--from 90 --limit 90`, ...) whose union is the whole sweep; the
// mutant numbers it prints are the whole sweep's. `--lines` keeps only the mutants on those lines
// (a change's own lines, when the whole file costs hours on a slow seat); the slicing and the
// numbering then apply to what it kept.
//
// Operators (each is a change a reviewer would call a bug if it shipped): flip a boolean
// literal; swap a comparison (< <= > >= === !==); swap && and ||; add one to a numeric literal;
// drop a `!` on an identifier; swap a kernel verdict tag for its neighbour. Mutants that fail
// to parse or that time out are reported separately, never counted as survivors.

import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The consumers, and the tests that import each (those are what a mutant must redden). Two
 * passes: the fast tests run on every mutant, and only a mutant that survives them is re-run
 * against the full set (the export-record test spawns the singulis ledger under bun, the model
 * gate runs forty fuzz seeds, the seam pins append a thousand fsync'd records; seconds to a
 * minute or more each), so a survivor is one NO importing test
 * reddened, at a fraction of the wall clock.
 */
const TARGETS = {
  "src/carry.mjs": { fast: ["test/carry.test.mjs", "test/carry-seams.test.mjs"], full: ["test/carry.test.mjs", "test/carry-seams.test.mjs", "test/export-record.test.mjs"] },
  "src/native-store.mjs": { fast: ["test/native-store.test.mjs", "test/native-board.test.mjs", "test/native-post-ledger.test.mjs", "test/native-store-threads.test.mjs", "test/native-store-inputs.test.mjs", "test/native-store-v2.test.mjs", "test/native-annotations.test.mjs", "test/native-purge.test.mjs"], full: ["test/native-store.test.mjs", "test/native-board.test.mjs", "test/native-post-ledger.test.mjs", "test/native-store-threads.test.mjs", "test/native-store-seams.test.mjs", "test/native-store-inputs.test.mjs", "test/native-store-model.test.mjs", "test/native-store-bad-bytes.test.mjs", "test/native-store-v2.test.mjs", "test/native-annotations.test.mjs", "test/native-purge.test.mjs"] },
  "src/client.mjs": { fast: ["test/client.test.mjs", "test/client-seams.test.mjs", "test/client-annotations.test.mjs", "test/client-attachments.test.mjs", "test/native-purge-service.test.mjs", "test/native-purge-events.test.mjs"], full: ["test/client.test.mjs", "test/client-seams.test.mjs", "test/client-annotations.test.mjs", "test/client-attachments.test.mjs", "test/native-purge-service.test.mjs", "test/native-purge-events.test.mjs"] },
};

const VERDICTS = ["Held_by_another", "Not_the_holder", "Fence_mismatch", "Not_human", "Nothing_to_break", "Applied"];
const PLANS = ["RefusedEpoch", "RefusedFuture", "Slice"];

/**
 * Every mutant of one file: { line, column, from, to, text } with the whole mutated source.
 * @param {string} src
 */
function mutants(src) {
  const out = [];
  const lines = src.split("\n");
  const push = (li, m, from, to) => {
    const before = lines.slice(0, li).join("\n").length + (li ? 1 : 0);
    const at = before + m.index;
    out.push({ line: li + 1, column: m.index + 1, from, to, text: src.slice(0, at) + to + src.slice(at + from.length) });
  };
  lines.forEach((l, li) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(l)) return; // comments and doc blocks
    const code = l.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, (s) => " ".repeat(s.length)) // strings masked
      .replace(/\/\*.*?\*\//g, (s) => " ".repeat(s.length)) // inline block comments masked (a JSDoc type's < and > are not code)
      .replace(/\/\/.*$/, (s) => " ".repeat(s.length)); // and a trailing line comment
    for (const m of code.matchAll(/\btrue\b|\bfalse\b/g)) push(li, m, m[0], m[0] === "true" ? "false" : "true");
    for (const m of code.matchAll(/===|!==|<=|>=|(?<![<>=!])<(?![<=])|(?<![<>=])>(?![>=])/g)) {
      const swap = { "===": "!==", "!==": "===", "<=": "<", ">=": ">", "<": "<=", ">": ">=" }[m[0]];
      push(li, m, m[0], swap);
    }
    for (const m of code.matchAll(/&&|\|\|/g)) push(li, m, m[0], m[0] === "&&" ? "||" : "&&");
    for (const m of code.matchAll(/(?<![\w.])(\d+)(?![\w.]|n\b)/g)) push(li, m, m[1], String(Number(m[1]) + 1));
    for (const m of code.matchAll(/!(?=[A-Za-z_$][\w$.]*(?:\(|\b))(?!==)/g)) push(li, m, "!", "");
    for (const tag of [...VERDICTS, ...PLANS]) {
      const re = new RegExp(`"${tag}"`, "g");
      for (const m of l.matchAll(re)) {
        const pool = VERDICTS.includes(tag) ? VERDICTS : PLANS;
        const next = pool[(pool.indexOf(tag) + 1) % pool.length];
        push(li, m, `"${tag}"`, `"${next}"`);
      }
    }
  });
  return out;
}

/** @param {string[]} tests */
function run(tests, timeoutMs) {
  const r = spawnSync(process.execPath, ["--test", ...tests], { cwd: ROOT, encoding: "utf8", timeout: timeoutMs, env: { ...process.env, BEND_CLONE: process.env.BEND_CLONE ?? "" } });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  if (r.error && /ETIMEDOUT|timed out/i.test(String(r.error.message ?? r.error))) return { status: "timeout", out };
  if (r.signal === "SIGTERM") return { status: "timeout", out };
  const failed = /^# fail [1-9]/m.test(out) || /^not ok/m.test(out);
  const crashed = !/^# pass/m.test(out);
  return { status: failed ? "red" : crashed ? "crash" : "green", out };
}

function main(argv) {
  const only = argv.includes("--file") ? argv[argv.indexOf("--file") + 1] : null;
  const limit = argv.includes("--limit") ? Number(argv[argv.indexOf("--limit") + 1]) : Infinity;
  const lines = argv.includes("--lines") ? String(argv[argv.indexOf("--lines") + 1]).split(",").map((r) => r.split("-").map(Number)) : null;
  if (lines && lines.some((r) => r.some((n) => !Number.isSafeInteger(n) || n < 1))) { console.error("--lines takes ranges like 12,33-38"); return 2; }
  const from = argv.includes("--from") ? Number(argv[argv.indexOf("--from") + 1]) : 0;
  if (!Number.isSafeInteger(from) || from < 0) { console.error("--from takes a non-negative whole number"); return 2; }
  const json = argv.includes("--json");
  const report = argv.includes("--report") ? argv[argv.indexOf("--report") + 1] : null;
  const timeoutMs = 180_000;
  const results = [];
  for (const [file, { fast, full }] of Object.entries(TARGETS)) {
    if (only && only !== file) continue;
    const path = join(ROOT, file);
    const original = readFileSync(path, "utf8");
    const dirty = spawnSync("git", ["-C", ROOT, "diff", "--quiet", "--", file]).status !== 0;
    if (dirty) { console.error(`${file} has uncommitted changes; the mutator restores files and refuses to guess what yours were`); return 2; }
    const base = run(full, timeoutMs);
    if (base.status !== "green") { console.error(`${file}: the tests are not green before any mutation (${base.status})`); return 2; }
    const every = mutants(original).filter((m) => !lines || lines.some(([a, b = a]) => m.line >= a && m.line <= b));
    const all = every.slice(from, from + limit);
    console.error(`${file}: ${all.length} of ${every.length} mutants (from ${from}); fast pass ${fast.join(", ")}; survivors re-run with ${full.filter((t) => !fast.includes(t)).join(", ")}`);
    let i = from;
    for (const m of all) {
      i++;
      writeFileSync(path, m.text, "utf8");
      let r;
      try {
        r = run(fast, timeoutMs);
        if (r.status === "green") r = run(full, timeoutMs);
      } finally { writeFileSync(path, original, "utf8"); }
      const row = { file, line: m.line, column: m.column, from: m.from, to: m.to, status: r.status, source: original.split("\n")[m.line - 1].trim() };
      results.push(row);
      if (!json) console.error(`  ${String(i).padStart(3)}/${every.length} ${r.status.padEnd(7)} ${file}:${m.line}:${m.column} ${JSON.stringify(m.from)} -> ${JSON.stringify(m.to)}`);
    }
    if (readFileSync(path, "utf8") !== original) { console.error(`${file} was not restored`); return 2; }
  }
  const survivors = results.filter((r) => r.status === "green");
  const summary = {
    mutants: results.length,
    red: results.filter((r) => r.status === "red").length,
    survived: survivors.length,
    timeout: results.filter((r) => r.status === "timeout").length,
    crash: results.filter((r) => r.status === "crash").length,
    survivors,
  };
  const text = json ? JSON.stringify(summary, null, 2) : [
    `${summary.survived ? "RED  " : "green"} ${summary.mutants} mutants: ${summary.red} red, ${summary.survived} survived, ${summary.timeout} timeout, ${summary.crash} crash`,
    ...survivors.map((s) => `  survived ${s.file}:${s.line}:${s.column} ${JSON.stringify(s.from)} -> ${JSON.stringify(s.to)}    ${s.source}`),
  ].join("\n");
  if (report) writeFileSync(report, JSON.stringify(summary, null, 2) + "\n", "utf8");
  console.log(text);
  return summary.survived ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
