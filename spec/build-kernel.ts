#!/usr/bin/env bun
// Regenerates a vendored kernel (src/native-<name>.kernel.mjs) from its Bend source
// through the Bend compiler's JS library emitter, after proving its laws. The generated
// file is plain JavaScript with no imports, so the CLI keeps zero runtime dependencies;
// the Bend checkout is a build-time tool only.
//
//   BEND_CLONE=<path to a bendlang/bend checkout> bun spec/build-kernel.ts [--spec <name>] [--check]
//
// Kernels: `cursor` (spec/cursor.bend, laws spec/LAWS.bend, proof spec/PROOF.bend),
// `board` (spec/board.bend, spec/BOARD-LAWS.bend, spec/BOARD-PROOF.bend) and `settlement`
// (spec/settlement.bend, the singulis ledger, with SETTLEMENT-LAWS/-PROOF). No --spec
// regenerates every kernel. --check regenerates into memory and exits 1 when a committed
// file differs.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLONE = process.env.BEND_CLONE ?? resolve(ROOT, "..", "bend-src");
const MAIN = join(CLONE, "bend2", "main.ts").replaceAll("\\", "/");

const KERNELS: Record<string, { source: string; laws: string; proof: string; out: string; origin?: string }> = {
  cursor: { source: "spec/cursor.bend", laws: "spec/LAWS.bend", proof: "spec/PROOF.bend", out: "src/native-cursor.kernel.mjs" },
  board: { source: "spec/board.bend", laws: "spec/BOARD-LAWS.bend", proof: "spec/BOARD-PROOF.bend", out: "src/native-board.kernel.mjs" },
  // the singulis settlement ledger, byte-identical to the singulis project's spec/settlement.bend
  // (its laws and proof carried beside it with the import lines renamed); `--check` also diffs
  // the source against the singulis copy when that tree is present (SINGULIS_SPEC, else
  // ../singulis/spec), so the two consumers keep one kernel
  settlement: { source: "spec/settlement.bend", laws: "spec/SETTLEMENT-LAWS.bend", proof: "spec/SETTLEMENT-PROOF.bend", out: "src/native-settlement.kernel.mjs", origin: "settlement.bend" },
};
const SINGULIS = process.env.SINGULIS_SPEC ?? resolve(ROOT, "..", "singulis", "spec");

const args = process.argv.slice(2);
const check = args.includes("--check");
const specAt = args.indexOf("--spec");
const names = specAt >= 0 ? [args[specAt + 1]] : Object.keys(KERNELS);
for (const n of names) if (!KERNELS[n]) { console.error(`unknown kernel ${n}; known: ${Object.keys(KERNELS).join(", ")}`); process.exit(2); }

if (!existsSync(MAIN)) {
  console.error(`no Bend checkout at ${CLONE}; set BEND_CLONE, or fetch the pin: node scripts/bend-checkout.mjs`);
  process.exit(2);
}

// the checkout must be at the pinned commit: a proof against another Bend is a proof of nothing
// this repository ships (spec/bend.pin.json; scripts/bend-checkout.mjs fetches the pin)
const PIN = JSON.parse(readFileSync(join(ROOT, "spec", "bend.pin.json"), "utf8"));
// BEND_PIN_TRIAL=<sha> proves against that commit instead of the pin (scripts/bend-upstream-trial.mjs
// sets it for one scratch run); the pin file is never read differently and never written, and the
// banner says so on stderr, so nothing a trial produces can be mistaken for a committed result
const TRIAL = process.env.BEND_PIN_TRIAL;
const EXPECT = TRIAL ?? PIN.sha;
{
  const head = spawnSync("git", ["-C", CLONE, "rev-parse", "HEAD"], { encoding: "utf8" });
  const at = (head.stdout ?? "").trim();
  if (head.status !== 0 || at !== EXPECT) {
    const want = TRIAL ? `the trial commit is ${TRIAL} (BEND_PIN_TRIAL)` : `the pin is ${PIN.sha} (${PIN.version})`;
    console.error(`Bend checkout at ${CLONE} is ${at || "not a git checkout"}; ${want}. Fetch it: node scripts/bend-checkout.mjs --into ${CLONE}`);
    process.exit(2);
  }
  if (TRIAL) console.error(`TRIAL: proving against Bend ${TRIAL.slice(0, 7)}, not the pin ${PIN.sha.slice(0, 7)} (${PIN.version}); this run is a report, never a committed result`);
}

const Bend = await import(join(CLONE, "bend2", "bend.ts").replaceAll("\\", "/"));
const Comp = await import(join(CLONE, "bend2", "comp.ts").replaceAll("\\", "/"));

let failed = false;
for (const name of names) {
  const k = KERNELS[name];
  const source = join(ROOT, k.source).replaceAll("\\", "/");
  const proof = join(ROOT, k.proof).replaceAll("\\", "/");
  const out = join(ROOT, k.out);

  // the gate: the checker's stdout must be exactly the green string
  const gate = spawnSync("bun", [MAIN, proof], { encoding: "utf8", env: { ...process.env, BEND_HUB: "http://127.0.0.1:1" } });
  const verdict = ((gate.stdout ?? "") + (gate.stderr ?? "")).trim();
  if (verdict !== "All terms check.") {
    console.error(`${k.proof} is not green:\n${verdict}`);
    failed = true;
    continue;
  }
  let optedOut = false;
  for (const f of [k.source, k.laws, k.proof]) {
    if (/@unsafe|\?TODO|import 0x/.test(readFileSync(join(ROOT, f), "utf8"))) {
      console.error(`${f} opts out of the proof (@unsafe, ?TODO or a hash import)`);
      optedOut = true;
    }
  }
  if (optedOut) { failed = true; continue; }

  const book = Bend.book_nil();
  await Bend.book_load(book, source, "", new Map());
  Bend.book_valid(book, 0);
  const outs = ([...new Set(book.order)] as string[]).filter((key) => {
    const t = book.tlds[key];
    return t.$ === "Def" && t.v !== null && t.b !== true && t.i === undefined && Comp.io_base(book, t.T) === null;
  });
  const header = [
    "// @ts-nocheck: generated code, not type-checked; the source is proved instead.",
    `// GENERATED by spec/build-kernel.ts from ${k.source}; do not edit.`,
    `// The laws in ${k.laws} are proved over that source by the Bend 2 checker`,
    `// (${k.proof}, gate string \`All terms check.\`) before this file is emitted.`,
    `// Bend 2; exports: ${outs.join(", ")}.`,
    "",
  ].join("\n");
  const js = header + Comp.js_lib(book, outs, outs);

  if (k.origin) {
    // the origin's digest is committed beside the copy, so drift is refused from a clean clone
    // with no sibling tree; the live sibling is compared too when it is there, and the line says which
    const pinned = JSON.parse(readFileSync(join(ROOT, "spec", "settlement.origin.json"), "utf8"));
    const digest = createHash("sha256").update(readFileSync(join(ROOT, k.source))).digest("hex");
    if (digest !== pinned.sha256) {
      console.error(`${k.source} sha256 ${digest} differs from the committed origin digest ${pinned.sha256} (spec/settlement.origin.json): the settlement kernel is one source in two trees; copy from the origin and rewrite the digest in the same commit, never edit one side`);
      failed = true;
      continue;
    }
    if (existsSync(join(SINGULIS, k.origin))) {
      if (readFileSync(join(SINGULIS, k.origin), "utf8") !== readFileSync(join(ROOT, k.source), "utf8")) {
        console.error(`${k.source} differs from the live origin ${join(SINGULIS, k.origin)} while matching the committed digest: the origin moved; copy it here and rewrite spec/settlement.origin.json`);
        failed = true;
        continue;
      }
      console.log(`ok   ${k.source} matches the committed origin digest and the live singulis copy`);
    } else {
      console.log(`ok   ${k.source} matches the committed origin digest (no singulis tree beside this repository to compare live)`);
    }
  }
  if (check) {
    const committed = existsSync(out) ? readFileSync(out, "utf8") : "";
    if (committed !== js) {
      console.error(`${k.out} differs from a fresh regeneration of ${k.source}`);
      failed = true;
    } else {
      console.log(`ok   ${k.out} matches ${k.source} (proof green)`);
    }
  } else {
    writeFileSync(out, js);
    console.log(`wrote ${k.out} (${js.length} bytes; exports ${outs.join(", ")})`);
  }
}
process.exit(failed ? 1 : 0);
