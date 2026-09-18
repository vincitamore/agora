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

import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const SPEC = dirname(fileURLToPath(import.meta.url));
const RED = join(SPEC, "laws-red");
const GREEN = "All terms check.";
const CLONE = process.env.BEND_CLONE ?? resolve(SPEC, "..", "..", "bend-src");
const MAIN = join(CLONE, "bend2", "main.ts").replaceAll("\\", "/");

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

function lawNames(text: string): string[] {
  return [...text.matchAll(/^law ([A-Za-z0-9_.]+):/gm)].map((m) => m[1]);
}

function main(argv: string[]): number {
  if (!existsSync(MAIN)) {
    console.error(`no Bend checkout at ${CLONE} (set BEND_CLONE)`);
    return 2;
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
    say(new RegExp(`^import \\./${k.laws.replace(".", "\\.")} as `, "m").test(src[k.proof]), `${k.proof} imports ${k.laws}`);
    say(new RegExp(`^import \\./${k.source.replace(".", "\\.")} as `, "m").test(src[k.laws]), `${k.laws} imports ${k.source}`);

    // 4. every law has its def, and no def without a law
    const defs = [...src[k.proof].matchAll(/^def Laws\.([A-Za-z0-9_.]+)\(/gm)].map((m) => m[1]);
    const missing = laws.filter((n) => !defs.includes(n));
    const extra = defs.filter((d) => !laws.includes(d));
    say(missing.length === 0 && extra.length === 0,
      `every law is filled and every Laws.* def has a law${missing.length ? ` (open: ${missing.join(", ")})` : ""}${extra.length ? ` (orphan defs: ${extra.join(", ")})` : ""}`);

    // 5. C0 for laws: each law has a mutation of the model that reddens the gate, at that law
    const locAt = new RegExp(`Location: ${stem.replace(/[-.]/g, "\\$&")}\\.([A-Za-z0-9_.]+)`);
    for (const n of laws) {
      const dir = join(RED, name, n);
      if (!existsSync(dir) || !statSync(dir).isDirectory()) { say(false, `${n}: no red fixture under laws-red/${name}/${n}/`); continue; }
      const overlay = readdirSync(dir);
      const foreign = overlay.filter((f) => f !== k.source);
      if (foreign.length) { say(false, `${n}: fixture may overlay only ${k.source} (found ${foreign.join(", ")})`); continue; }
      if (!overlay.includes(k.source)) { say(false, `${n}: fixture carries no ${k.source}`); continue; }
      const tmp = mkdtempSync(join(tmpdir(), "laws-red-"));
      try {
        for (const f of files) cpSync(join(SPEC, f), join(tmp, f));
        cpSync(join(dir, k.source), join(tmp, k.source));
        const r = check(tmp, k.proof);
        const where = r.out.match(locAt)?.[1];
        say(!r.green && where === n, `${n}: red fixture reddens the gate at this law${r.green ? " (STAYED GREEN)" : where ? (where === n ? "" : ` (fired at ${where})`) : ` (fired, location unparsed: ${r.out.split("\n")[0]})`}`);
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
