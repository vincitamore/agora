#!/usr/bin/env bun
// The laws gate for the three vendored kernels, with the admission rule the kernels'
// consumers apply to themselves (C0 for laws): a law is admitted only if a known-red
// mutation of its MODEL exists under spec/laws-red/<kernel>/<law>/ and the checker goes
// red on it AT THAT LAW; the un-mutated proof is green; nothing in the closure opts out.
// A law with no fixture, or whose fixture stays green or reddens elsewhere, fails the
// gate: a law that cannot be reddened is a law that constrains nothing.
//
//   BEND_CLONE=<checkout> bun spec/laws-check.ts            run the gate; exit 1 on anything but green
//   BEND_CLONE=<checkout> bun spec/laws-check.ts --list     print the laws and their red fixtures
//   ... --kernel cursor|board|settlement                    one kernel only
//
// The gate reads the checker's stdout for the exact string `All terms check.` and never
// its exit code: an `@unsafe` book exits 0. A fixture may overlay the model file only;
// one that carries a LAWS or PROOF file is refused, since a red produced by a weakened
// law or a sabotaged proof exhibits nothing about the model.
//
// Each fixture is checked against its law IN ISOLATION: the gate builds a LAWS copy holding
// only that law and a PROOF copy holding the kit and only that law's def, both mechanically,
// and requires the checker to go red there. The checker halts at the first red, and two laws
// about one function pin its shape in their proof terms (cursor laws 5 and 6 both unfold
// `next`), so in the full file whichever law comes first catches every mutation of that
// function and the later law could never be shown red at itself. A red inside the model
// file, or a TODO, is a malformed fixture, not an exhibit.

import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const SPEC = dirname(fileURLToPath(import.meta.url));
const RED = join(SPEC, "laws-red");
const GREEN = "All terms check.";
const CLONE = process.env.BEND_CLONE ?? resolve(SPEC, "..", "..", "bend-src");
const MAIN = join(CLONE, "bend2", "main.ts").replaceAll("\\", "/");
const ROOT = resolve(SPEC, "..");

const KERNELS: Record<string, { source: string; laws: string; proof: string }> = {
  cursor: { source: "cursor.bend", laws: "LAWS.bend", proof: "PROOF.bend" },
  board: { source: "board.bend", laws: "BOARD-LAWS.bend", proof: "BOARD-PROOF.bend" },
  settlement: { source: "settlement.bend", laws: "SETTLEMENT-LAWS.bend", proof: "SETTLEMENT-PROOF.bend" },
};

function check(dir: string, proof: string): { out: string; green: boolean } {
  const file = join(dir, proof).replaceAll("\\", "/");
  const p = spawnSync("bun", [MAIN, file], { encoding: "utf8", env: { ...process.env, BEND_HUB: "http://127.0.0.1:1" } });
  const out = ((p.stdout ?? "") + (p.stderr ?? "")).trim();
  return { out, green: out === GREEN };
}

/** run a fixture's witness.bend (a pure main) and return the last line the checker printed */
function witness(dir: string): string {
  const file = join(dir, "witness.bend").replaceAll("\\", "/");
  const p = spawnSync("bun", [MAIN, file], { encoding: "utf8", env: { ...process.env, BEND_HUB: "http://127.0.0.1:1" } });
  const out = ((p.stdout ?? "") + (p.stderr ?? "")).trim().split(/\r?\n/);
  return out[out.length - 1] ?? "";
}

function lawNames(text: string): string[] {
  return [...text.matchAll(/^law ([A-Za-z0-9_.]+):/gm)].map((m) => m[1]);
}

// a LAWS file reduced to one law: everything before the first `law` line (the imports), then
// that law's block (its `law` line through the line before the next `law`, or the end)
function isolateLaws(text: string, name: string): string {
  const at = text.search(/^law /m);
  const head = at < 0 ? text : text.slice(0, at);
  const mine = text.slice(at).split(/^(?=law )/m).find((b) => b.startsWith(`law ${name}:`));
  if (!mine) throw new Error(`law ${name} not found`);
  return head + mine;
}

// a PROOF file reduced to one law's def: every top-level block that is not a `def Laws.*`
// (imports, the kit) plus that law's own def; a block runs from a `def` line to the next
function isolateProof(text: string, name: string): string {
  return text.split(/^(?=def )/m).filter((b) => !b.startsWith("def Laws.") || b.startsWith(`def Laws.${name}(`)).join("");
}

const escape = (s: string) => s.replace(/[-.]/g, (c) => "\\" + c);

function main(argv: string[]): number {
  if (!existsSync(MAIN)) {
    console.error(`no Bend checkout at ${CLONE} (set BEND_CLONE, or fetch the pin: node scripts/bend-checkout.mjs)`);
    return 2;
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
    return 2;
  }
  if (TRIAL) console.error(`TRIAL: proving against Bend ${TRIAL.slice(0, 7)}, not the pin ${PIN.sha.slice(0, 7)} (${PIN.version}); this run is a report, never a committed result`);
}
  const at = argv.indexOf("--kernel");
  const names = at >= 0 ? [argv[at + 1]] : Object.keys(KERNELS);
  for (const n of names) if (!KERNELS[n]) { console.error(`unknown kernel ${n}; known: ${Object.keys(KERNELS).join(", ")}`); return 2; }

  let bad = 0;
  let items = 0;
  const say = (ok: boolean, msg: string) => { items++; console.log(`${ok ? "green" : "RED  "} ${msg}`); if (!ok) bad++; };

  for (const name of names) {
    const k = KERNELS[name];
    const files = [k.source, k.laws, k.proof];
    const src = Object.fromEntries(files.map((f) => [f, readFileSync(join(SPEC, f), "utf8")]));
    const laws = lawNames(src[k.laws]);
    const stem = k.laws.replace(/\.bend$/, "");
    console.log(`\n${name}: ${k.source} / ${k.laws} / ${k.proof} (${laws.length} laws)`);

    if (argv.includes("--list")) {
      for (const n of laws) {
        const dir = join(RED, name, n);
        const has = existsSync(dir) ? readdirSync(dir).join(", ") : "NO RED FIXTURE";
        const why = existsSync(dir) ? (readFileSync(join(dir, readdirSync(dir)[0]), "utf8").match(/^# RED FIXTURE[^:]*: (.*)$/m)?.[1] ?? "") : "";
        console.log(`  ${n}\n     red on: ${has}${why ? ` (${why})` : ""}`);
      }
      continue;
    }

    // 1. the gate string, from the real files
    const real = check(SPEC, k.proof);
    say(real.green, `${k.proof} prints exactly "${GREEN}"${real.green ? "" : `: got "${real.out.split("\n")[0]}"`}`);

    // 2. nothing in the closure opts out
    for (const f of files) {
      const hits = [...src[f].matchAll(/@unsafe|\?TODO|import 0x/g)].map((m) => m[0]);
      say(hits.length === 0, `${f} has no @unsafe, ?TODO or hash import${hits.length ? ` (found ${hits.join(", ")})` : ""}`);
    }

    // 3. the import chain: PROOF -> LAWS -> the model
    say(new RegExp(`^import \\./${escape(k.laws)} as `, "m").test(src[k.proof]), `${k.proof} imports ${k.laws}`);
    say(new RegExp(`^import \\./${escape(k.source)} as `, "m").test(src[k.laws]), `${k.laws} imports ${k.source}`);

    // 4. every law has its def, and no def without a law
    const defs = [...src[k.proof].matchAll(/^def Laws\.([A-Za-z0-9_.]+)\(/gm)].map((m) => m[1]);
    const missing = laws.filter((n) => !defs.includes(n));
    const extra = defs.filter((d) => !laws.includes(d));
    say(missing.length === 0 && extra.length === 0,
      `every law is filled and every Laws.* def has a law${missing.length ? ` (open: ${missing.join(", ")})` : ""}${extra.length ? ` (orphan defs: ${extra.join(", ")})` : ""}`);

    // 5. C0 for laws: each law has a mutation of the model that reddens the gate, at that law
    const locAt = new RegExp(`Location: ${escape(stem)}\\.([A-Za-z0-9_.]+)`);
    const inModel = new RegExp(`Location: ${escape(k.source.replace(/\.bend$/, ""))}\\.`);
    for (const n of laws) {
      const dir = join(RED, name, n);
      if (!existsSync(dir) || !statSync(dir).isDirectory()) { say(false, `${n}: no red fixture under laws-red/${name}/${n}/`); continue; }
      const overlay = readdirSync(dir);
      // a witness.bend beside the mutation is the semantic exhibit: its pure main evaluates the
      // law's claim on concrete values and must print True{} beside the mutation and False{}
      // beside the real model; with one present, the red may fire in a kit lemma the law's proof
      // depends on (proof terms spell the model's shape), since the witness carries the falsity
      const foreign = overlay.filter((f) => f !== k.source && f !== "witness.bend");
      const witnessed = overlay.includes("witness.bend");
      if (foreign.length) { say(false, `${n}: fixture may overlay only ${k.source} (found ${foreign.join(", ")})`); continue; }
      if (!overlay.includes(k.source)) { say(false, `${n}: fixture carries no ${k.source}`); continue; }
      const tmp = mkdtempSync(join(tmpdir(), "laws-red-"));
      try {
        cpSync(join(dir, k.source), join(tmp, k.source));
        writeFileSync(join(tmp, k.laws), isolateLaws(src[k.laws], n));
        writeFileSync(join(tmp, k.proof), isolateProof(src[k.proof], n));
        const r = check(tmp, k.proof);
        const where = r.out.match(locAt)?.[1];
        let wRed = "", wReal = "";
        if (witnessed) {
          cpSync(join(dir, "witness.bend"), join(tmp, "witness.bend"));
          const real = mkdtempSync(join(tmpdir(), "laws-real-"));
          try {
            cpSync(join(SPEC, k.source), join(real, k.source));
            cpSync(join(dir, "witness.bend"), join(real, "witness.bend"));
            wRed = witness(tmp); wReal = witness(real);
          } finally { rmSync(real, { recursive: true, force: true }); }
        }
        const witnessOk = witnessed && wRed === "True{}" && wReal === "False{}";
        const malformed = inModel.test(r.out) || /TODOs? found/.test(r.out);
        const why = r.green ? " (STAYED GREEN)"
          : malformed ? ` (malformed fixture: ${r.out.split("\n").find((l) => /Location|TODO/.test(l))})`
          : witnessOk ? ` (fired at ${r.out.match(/Location: (\S+)/)?.[1] ?? "?"}; witness violated under the mutation, holds under the real model)`
          : witnessed ? ` (witness printed ${wRed || "nothing"} under the mutation and ${wReal || "nothing"} under the real model)`
          : where === n ? ""
          : ` (fired elsewhere: ${r.out.match(/Location: (\S+)/)?.[1] ?? r.out.split("\n")[0]})`;
        say(!r.green && !malformed && (witnessed ? witnessOk : where === n), `${n}: red fixture reddens the gate at this law, in isolation${why}`);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
    // a fixture directory naming no law is a stale fixture
    const fixtureDir = join(RED, name);
    if (existsSync(fixtureDir)) {
      for (const d of readdirSync(fixtureDir)) if (!laws.includes(d)) say(false, `laws-red/${name}/${d}/ names no law in ${k.laws}`);
    }
  }
  if (!argv.includes("--list")) console.log(`\n${bad} red of ${items} items`);
  return bad ? 1 : 0;
}

process.exit(main(process.argv.slice(2)));
