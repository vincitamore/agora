#!/usr/bin/env node
// Emitter differential: the laws are proved about the Bend INTERPRETER, and the product runs the
// JS the Bend compiler EMITS (`Comp.js_lib`, a separate emitter whose own header expects bugs).
// This probe drives both on the same random inputs and reports every disagreement.
//
//   node scripts/probe-emitter-differential.mjs [--cases 300] [--seed 7] [--kernel cursor|board|settlement]
//
// For each kernel it generates random cases, writes ONE Bend file whose pure `main` returns the
// list of results, runs it under the pinned checkout (the checker normalizes a pure main and
// prints the normal form), parses that print, and compares it constructor-for-constructor and
// field-for-field with the committed `src/native-<kernel>.kernel.mjs` on the same inputs. A
// mismatch names the case and both readings. Exit 1 on any mismatch; one JSON observation line
// per kernel ({probe, kernel, cases, mismatches, pass}).
//
// Needs bun and a checkout at the pin (BEND_CLONE, else ../bend-src); says so and exits 2 otherwise.

import { spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Cursor from "../src/native-cursor.kernel.mjs";
import Board from "../src/native-board.kernel.mjs";
import Settlement from "../src/native-settlement.kernel.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLONE = process.env.BEND_CLONE ?? resolve(ROOT, "..", "bend-src");
const MAIN = join(CLONE, "bend2", "main.ts").replaceAll("\\", "/");
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const CASES = Number(opt("--cases", "300"));
let seed = Number(opt("--seed", "7")) >>> 0;
const only = opt("--kernel", null);

if (!existsSync(MAIN)) { console.error(`no Bend checkout at ${CLONE}; set BEND_CLONE or run node scripts/bend-checkout.mjs`); process.exit(2); }

// a small deterministic generator, so a mismatch is reproducible by seed
function rnd(n) { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; }

// ---- rendering: a JS kernel value and an interpreter print both become one canonical string ----
/** @param {unknown} v */
function canon(v) {
  if (typeof v === "bigint") return `${v}n`;
  if (typeof v === "boolean") return v ? "True{}" : "False{}";
  if (Array.isArray(v)) return `[${v.map(canon).join(", ")}]`;
  if (v && typeof v === "object") {
    const o = /** @type {Record<string, unknown>} */ (v);
    if (o.$ === "Nil") return "[]";
    if (o.$ === "Con") { const xs = []; let c = o; while (c && c.$ === "Con") { xs.push(c.head); c = c.tail; } return canon(xs); }
    const fields = Object.entries(o).filter(([k]) => k !== "$").map(([, x]) => canon(x));
    return `${o.$}{${fields.join(", ")}}`;
  }
  return String(v);
}
/** normalize the interpreter's print: drop module prefixes and whitespace differences @param {string} s */
const normPrint = (s) => s.replace(/\b[a-z_]+\./g, "").replace(/\s+/g, " ").trim();
/** split a printed top-level list into its element strings @param {string} s */
function splitList(s) {
  const body = s.trim().replace(/^\[/, "").replace(/\]$/, "");
  const out = []; let depth = 0, cur = "";
  for (const ch of body) {
    if (ch === "[" || ch === "{" || ch === "(") depth++;
    if (ch === "]" || ch === "}" || ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// ---- the three kernels: a case is { bend: source text, js: () => value } ----
const nat = (n) => `${n}n`;
const bendList = (xs) => `[${xs.join(", ")}]`;
const jsList = (xs) => xs.reduceRight((t, h) => ({ $: "Con", head: h, tail: t }), /** @type {any} */ ({ $: "Nil" }));

function settlementCase() {
  const n = rnd(7);
  const entries = [];
  for (let i = 0; i < n; i++) {
    const kind = rnd(3), f = rnd(3), m = rnd(3);
    if (kind === 0) entries.push({ bend: `S.Assert{S.Fact{${nat(f)}}, ${nat(m)}}`, js: { $: "Assert", fact: { $: "Fact", id: BigInt(f) }, member: BigInt(m) } });
    else if (kind === 1) entries.push({ bend: `S.Allocate{${nat(m)}}`, js: { $: "Allocate", count: BigInt(m) } });
    else {
      const members = [0, 1, 2].filter(() => rnd(2) === 0);
      entries.push({ bend: `S.Retract{S.Fact{${nat(f)}}, S.Step{${bendList(members.map(nat))}}}`, js: { $: "Retract", fact: { $: "Fact", id: BigInt(f) }, step: { $: "Step", members: jsList(members.map(BigInt)) } } });
    }
  }
  const f = rnd(3);
  const l = { bend: bendList(entries.map((e) => e.bend)), js: jsList(entries.map((e) => e.js)) };
  const q = rnd(3);
  if (q === 0) return { bend: `S.standing(${l.bend}, S.Fact{${nat(f)}})`, js: () => Settlement.standing(l.js, { $: "Fact", id: BigInt(f) }), type: "Bool" };
  if (q === 1) return { bend: `S.read(${l.bend}, S.Fact{${nat(f)}})`, js: () => Settlement.read(l.js, { $: "Fact", id: BigInt(f) }), type: "S.Standing" };
  return { bend: `S.coordination_free(${l.bend})`, js: () => Settlement.coordination_free(l.js), type: "Bool" };
}

function boardCase() {
  const holder = rnd(3) === 0 ? { bend: "B.NoHolder{}", js: { $: "NoHolder" } } : (() => {
    const a = rnd(3), l = rnd(4), f = rnd(6), e = rnd(40);
    return { bend: `B.Held{${nat(a)}, ${nat(l)}, ${nat(f)}, ${nat(e)}}`, js: { $: "Held", account: BigInt(a), lease: BigInt(l), fence: BigInt(f), expires: BigInt(e) } };
  })();
  const a = rnd(3), l = rnd(4), f = rnd(6), ms = rnd(30), op = rnd(4), cursor = rnd(8), now = rnd(40);
  const acts = [
    { bend: `B.Claim{${nat(a)}, ${nat(op)}, ${nat(ms)}}`, js: { $: "Claim", account: BigInt(a), op: BigInt(op), lease_ms: BigInt(ms) } },
    { bend: `B.Renew{${nat(a)}, ${nat(l)}, ${nat(f)}, ${nat(ms)}}`, js: { $: "Renew", account: BigInt(a), lease: BigInt(l), fence: BigInt(f), lease_ms: BigInt(ms) } },
    { bend: `B.Release{${nat(a)}, ${nat(l)}, ${nat(f)}}`, js: { $: "Release", account: BigInt(a), lease: BigInt(l), fence: BigInt(f) } },
    { bend: `B.Break{${rnd(2) ? "True{}" : "False{}"}}`, js: null },
    { bend: "B.Contest{}", js: { $: "Contest" } },
  ];
  const k = rnd(acts.length);
  const act = acts[k];
  if (k === 3) act.js = { $: "Break", human: act.bend.includes("True") };
  return { bend: `B.judge(${act.bend}, ${holder.bend}, ${nat(cursor)}, ${nat(now)})`, js: () => Board.judge(act.js, holder.js, BigInt(cursor), BigInt(now)), type: "B.Verdict" };
}

function cursorCase() {
  const same = rnd(4) !== 0, committed = rnd(13), since = rnd(14), limit = rnd(6);
  const plan = { bend: `C.plan(${same ? "True{}" : "False{}"}, ${nat(committed)}, ${nat(since)}, ${nat(limit)})`, js: () => Cursor.plan(same, BigInt(committed), BigInt(since), BigInt(limit)) };
  const q = rnd(3);
  if (q === 0) return { bend: plan.bend, js: plan.js, type: "C.Plan" };
  if (q === 1) return { bend: `C.next(${nat(since)}, ${plan.bend})`, js: () => Cursor.next(BigInt(since), plan.js()), type: "Nat" };
  return { bend: `C.delivered(${plan.bend})`, js: () => Cursor.delivered(plan.js()), type: "Nat" };
}

const KERNELS = {
  settlement: { imp: "import ./settlement.bend as S", gen: settlementCase },
  board: { imp: "import ./board.bend as B", gen: boardCase },
  cursor: { imp: "import ./cursor.bend as C", gen: cursorCase },
};

// --self-test plants one wrong emitted reading per kernel (the first case's value replaced by an
// impossible constructor) and requires the comparator to report exactly that mismatch: a
// differential whose comparator cannot fail measures nothing
const selfTest = args.includes("--self-test");

let failed = false;
for (const [name, k] of Object.entries(KERNELS)) {
  if (only && only !== name) continue;
  // one file per result type, since a Bend list is homogeneous
  const byType = new Map();
  for (let i = 0; i < CASES; i++) { const c = k.gen(); if (!byType.has(c.type)) byType.set(c.type, []); byType.get(c.type).push(c); }
  const mismatches = [];
  let ran = 0;
  for (const [type, cases] of byType) {
    // the interpreter resolves `import ./x.bend` beside the importing file, so the generated main
    // lives in spec/ under a temporary name for the length of one run
    const file = join(ROOT, "spec", `_emit-diff-${process.pid}-${name}-${type.replace(/\W/g, "")}.bend`);
    try {
      const src = `import Base\n${k.imp}\n\ndef main() -> List<${type}>:\n  ${bendList(cases.map((c) => c.bend))}\n`;
      writeFileSync(file, src);
      const r = spawnSync("bun", [MAIN, file.replaceAll("\\", "/")], { encoding: "utf8", env: { ...process.env, BEND_HUB: "http://127.0.0.1:1" }, shell: process.platform === "win32" });
      const out = (r.stdout ?? "").trim().split(/\r?\n/).at(-1) ?? "";
      if (!out.startsWith("[")) { mismatches.push({ type, error: `interpreter printed no list: ${(r.stdout + r.stderr).trim().slice(0, 300)}` }); continue; }
      const printed = splitList(normPrint(out));
      if (printed.length !== cases.length) { mismatches.push({ type, error: `interpreter printed ${printed.length} results for ${cases.length} cases` }); continue; }
      cases.forEach((c, i) => {
        ran += 1;
        const js = selfTest && i === 0 ? "Planted{}" : normPrint(canon(c.js()));
        if (js !== printed[i]) mismatches.push({ type, case: c.bend, interpreter: printed[i], emitted: js });
      });
    } finally { rmSync(file, { force: true }); }
  }
  // under --self-test the pass condition inverts: exactly one planted mismatch per result type
  const planted = byType.size;
  const pass = ran === CASES && (selfTest ? mismatches.length === planted && mismatches.every((m) => m.emitted === "Planted{}") : mismatches.length === 0);
  if (!pass) failed = true;
  console.log(JSON.stringify({ probe: "emitter-differential", kernel: name, seed: Number(opt("--seed", "7")), cases: ran, mismatches: mismatches.length, ...(selfTest ? { selfTest: true, planted } : {}), pass, ...(mismatches.length && !selfTest ? { first: mismatches.slice(0, 5) } : {}) }));
}
process.exitCode = failed ? 1 : 0;
