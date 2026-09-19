#!/usr/bin/env node
// Fetch the pinned Bend checkout named by spec/bend.pin.json into a directory, or verify one.
//
//   node scripts/bend-checkout.mjs                       into $RUNNER_TOOL_CACHE/bend-src/<sha> (CI),
//                                                        else ../bend-src beside this repository
//   node scripts/bend-checkout.mjs --into <dir>          into <dir>
//   node scripts/bend-checkout.mjs --verify [<dir>]      exit 1 unless <dir> is at the pinned commit
//
// The fetch tries upstream by sha, then the pin's public mirror by tag (a fork of upstream that keeps
// every pin under a pin-<sha7> tag, because upstream has force-pushed before and a sha can vanish there); a
// mirror named by BEND_MIRROR (and BEND_MIRROR_TAG, default pin-<sha7>) is tried first when set. A
// clone of this repository builds from public hosts with nothing else to reach. A directory
// already at the pinned commit is left alone. The resolved path is printed on the last line, and
// under GitHub Actions it is also appended to $GITHUB_ENV as BEND_CLONE, so later steps (the kernel
// regeneration test, the laws gate) run the proofs instead of skipping by name.
//
// Nothing here runs Bend: `bun` is the checker's runtime and is set up separately.

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PIN = JSON.parse(readFileSync(join(ROOT, "spec", "bend.pin.json"), "utf8"));

/** @param {string[]} args @param {string} [cwd] */
function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

/** @param {string} dir */
function headOf(dir) {
  if (!existsSync(join(dir, ".git")) && !existsSync(join(dir, "HEAD"))) return null;
  const r = git(["rev-parse", "HEAD"], dir);
  return r.ok ? r.out : null;
}

/** @param {string} dir */
function fetchPinned(dir) {
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, ".git"))) {
    const init = git(["init", "-q"], dir);
    if (!init.ok) throw new Error(`git init failed in ${dir}: ${init.err}`);
  }
  const mirror = process.env.BEND_MIRROR;
  const tag = process.env.BEND_MIRROR_TAG ?? `pin-${PIN.sha.slice(0, 7)}`;
  const sources = [
    ...(mirror ? [{ name: "mirror (tag)", url: mirror, ref: `refs/tags/${tag}` }, { name: "mirror (sha)", url: mirror, ref: PIN.sha }] : []),
    { name: "upstream (sha)", url: PIN.upstream, ref: PIN.sha },
    ...(PIN.mirror ? [{ name: "public mirror (tag)", url: PIN.mirror, ref: `refs/tags/${PIN.tag ?? `pin-${PIN.sha.slice(0, 7)}`}` }] : []),
  ];
  const tried = [];
  for (const s of sources) {
    const f = git(["fetch", "--depth", "1", s.url, s.ref], dir);
    if (!f.ok) { tried.push(`${s.name}: ${f.err.split("\n").at(-1)}`); continue; }
    const co = git(["checkout", "-q", "--detach", "FETCH_HEAD"], dir);
    if (!co.ok) { tried.push(`${s.name}: checkout: ${co.err}`); continue; }
    const head = headOf(dir);
    if (head === PIN.sha) return s.name;
    tried.push(`${s.name}: fetched ${head}, not the pin`);
  }
  throw new Error(`could not fetch the pinned Bend commit ${PIN.sha}:\n  ${tried.join("\n  ")}`);
}

function main(argv) {
  const verify = argv.includes("--verify");
  const intoAt = argv.indexOf("--into");
  const positional = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--into");
  const dir = resolve(
    intoAt >= 0 ? argv[intoAt + 1]
      : positional[0]
      ?? (process.env.RUNNER_TOOL_CACHE ? join(process.env.RUNNER_TOOL_CACHE, "bend-src", PIN.sha) : join(ROOT, "..", "bend-src")),
  );
  const head = headOf(dir);
  if (verify) {
    if (head === PIN.sha) { console.log(`ok   ${dir} is at the pinned commit ${PIN.sha} (${PIN.version})`); return 0; }
    console.error(`${dir} is ${head ?? "not a checkout"}; the pin is ${PIN.sha} (${PIN.version}). Fetch it: node scripts/bend-checkout.mjs --into ${dir}`);
    return 1;
  }
  let how = "already present";
  if (head !== PIN.sha) {
    if (head) console.error(`${dir} is at ${head}, not the pin ${PIN.sha}; fetching the pin over it`);
    how = fetchPinned(dir);
  }
  if (!existsSync(join(dir, "bend2", "main.ts"))) { console.error(`${dir} holds no bend2/main.ts`); return 1; }
  if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `BEND_CLONE=${dir}\n`);
  console.log(`bend ${PIN.version} at ${PIN.sha} (${how})`);
  console.log(dir);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
