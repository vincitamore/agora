#!/usr/bin/env node
// @ts-check
/**
 * Set up a member seat: the machine that joins another seat's native room over a route the host
 * issued (docs/MEMBERSHIP.md), with omp and Tern on it. docs/MEMBER-SEAT.md is the guide this
 * script carries out; every step it takes is one of that guide's numbered steps.
 *
 *   node scripts/setup-member-seat.mjs --room <alias> --pin <tag> [--kit <folder>] [--check] [options]
 *
 * `--check` reports each step's state and changes nothing on disk except what any agora command
 * records about itself (the session `member-seat-setup` under the state root it reads). A plain run
 * applies the steps that are missing, in order, then reports again. A second plain run changes
 * nothing. A file the user already has is merged, never replaced: the change is printed as a diff
 * and the file before it is kept beside it as `<file>.bak-<time>`. An agora config (the seat's and
 * the human's) is written only through `agora config`, the one writer of that file, which does the
 * same: it validates the whole result, prints the diff and keeps the backup.
 *
 * States: `ok`; `todo` (a plain run does it); `wait` (something from outside this script: the
 * host's kit for the human, a pinned charter, the first turn); `fail`
 * (the user must act, and the line says how); `blocked` (an earlier step this one needs is not ok).
 * Exit 0 when nothing is todo, fail or blocked; 1 otherwise; 2 on a usage error.
 *
 * Options:
 *   --room <alias>          the room's alias on this seat (required)
 *   --pin <tag|sha>         the agora release both seats run (required for a green run)
 *   --kit <folder>          the unzipped route kit the host sent for this seat's key
 *   --human-kit <folder>    the unzipped route kit the host sent for the human's key
 *   --human-name <name>     the name the human route posts under (checked against that kit)
 *   --human-root <folder>   the human's own agora folder (default ~/.agora/human)
 *   --config <path>         this seat's agora config (default AGORA_CONFIG, else ~/.agora/config.json)
 *   --actor <name>          actor.name of the config written when none exists (default "agent")
 *   --role <role>           the role of the first omp session, for the printed launch line (default coding)
 *   --charter-name <name>   the file name of the charter the host pinned in the room (default CHARTER.md)
 *   --omp <path|json argv>  how to run omp (default: omp on PATH)
 *   --tern <path|json argv> how to run tern (default: tern on PATH)
 *   --tern-data <folder>    the agora plugin's data folder in Tern (default: derived, see the guide)
 *   --json                  one JSON report on stdout
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { writeFileAtomic } from "../src/core.mjs";
import { publicNodeKeyDigest } from "../src/protocol/route.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "bin", "agora.mjs");
const NODE_MIN = [22, 13];
/** The session key every agora child of this script runs under: one record, never one per call. */
const SESSION = "member-seat-setup";
/** The bearer of the one first-run post. Role first; this is a script, not a model. */
const FIRST_POST_AS = "setup/check";
const PROBE_ALIAS = "member-seat-setup-probe";

/** @typedef {"ok" | "todo" | "wait" | "fail" | "blocked"} State */
/** @typedef {{ code: number | null, stdout: string, stderr: string, error?: string }} Run */
/** @typedef {{ cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number }} ExecOptions */
/**
 * Everything the script reaches outside itself through. A test replaces these.
 * @typedef {{
 *   home: string,
 *   env: NodeJS.ProcessEnv,
 *   exec: (argv: string[], options?: ExecOptions) => Promise<Run>,
 *   agora: (args: string[], options: { state: string, config?: string }) => Promise<Run>,
 *   now: () => Date,
 * }} Deps
 */
/** `changes`: what a plain run would change (diff lines); `notes`: what the user must read or send.
 * @typedef {{ state: State, detail: string, changes?: string[], notes?: string[], plan?: any }} Inspection */
/** @typedef {{ id: string, title: string, needs: string[], inspect: (c: Ctx, s: Shared) => Promise<Inspection>, apply?: (c: Ctx, s: Shared, plan: any) => Promise<string[]> }} Step */
/** `changes`: what this run changed (with `changed`) or what a plain run would change.
 * @typedef {{ id: string, title: string, state: State, detail: string, changed: boolean, changes: string[], notes: string[] }} StepResult */
/**
 * @typedef {{
 *   apply: boolean, room: string, pin?: string, kit?: string, humanKit?: string, humanName?: string,
 *   humanRoot: string, humanState: string, humanConfig: string, configPath: string, configIsDefault: boolean,
 *   stateRoot: string, stateFromEnv?: string, actor: string, role: string, charterName: string,
 *   omp?: string[], tern?: string[], ternData?: string, setupDir: string, deps: Deps,
 * }} Ctx
 */
/**
 * What one step learns that a later one uses.
 * @typedef {{ seatKey?: { nodeKey: string, fingerprint: string }, humanKey?: { nodeKey: string, fingerprint: string },
 *   descriptorPath?: string, humanInstalled?: boolean, ompBin?: string[], ternBin?: string[] }} Shared
 */

// ---------------------------------------------------------------- processes

/**
 * Run a program with no shell. A child that outlives its bound is killed by its own pid.
 * @param {string[]} argv @param {ExecOptions} [options] @returns {Promise<Run>}
 */
export function execNoShell(argv, options = {}) {
  return new Promise((resolve) => {
    const [cmd, ...args] = argv;
    if (!cmd) { resolve({ code: null, stdout: "", stderr: "", error: "empty command" }); return; }
    let child;
    try {
      child = spawn(cmd, args, { cwd: options.cwd, env: options.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: null, stdout: "", stderr: "", error: e instanceof Error ? e.message : String(e) });
      return;
    }
    let stdout = "", stderr = "", timedOut = false;
    child.stdout?.on("data", (d) => { stdout += d; });
    child.stderr?.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, options.timeoutMs ?? 60_000);
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: null, stdout, stderr, error: e.message }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ...(timedOut ? { error: `no answer within ${Math.round((options.timeoutMs ?? 60_000) / 1000)} s; stopped` } : {}) });
    });
  });
}

/**
 * The environment of an agora child: the caller's, minus every variable that would sign as or
 * resolve to someone else's session, config or state, which are named explicitly instead.
 * @param {NodeJS.ProcessEnv} env @param {{ state: string, config?: string }} o
 */
export function agoraEnv(env, o) {
  /** @type {NodeJS.ProcessEnv} */
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (/^AGORA_(ACTOR|SESSION|LABEL|CONFIG|STATE)$/.test(k)) continue;
    out[k] = v;
  }
  out.AGORA_SESSION = SESSION;
  out.AGORA_STATE = o.state;
  if (o.config) out.AGORA_CONFIG = o.config;
  return out;
}

/** @param {NodeJS.ProcessEnv} env @returns {Deps["agora"]} */
function defaultAgora(env) {
  return (args, o) => execNoShell([process.execPath, ENTRY, ...args], { env: agoraEnv(env, o), timeoutMs: 120_000 });
}

/** @param {string} text @returns {any[]} one object per JSON line; other lines are skipped */
function jsonLines(text) {
  /** @type {any[]} */
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try { out.push(JSON.parse(t)); } catch { /* not a record */ }
  }
  return out;
}

/** @param {Run} r */
const failText = (r) => (r.error ?? (r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`)).split(/\r?\n/).slice(-3).join(" / ");

/**
 * An executable named on PATH, as no-shell spawn can run it (on Windows an .exe or .com; a .cmd
 * shim needs a shell and is reported instead).
 * @param {string} name @param {NodeJS.ProcessEnv} env @param {string[]} [fallbacks]
 * @returns {{ argv?: string[], note?: string }}
 */
function findExecutable(name, env, fallbacks = []) {
  const win = process.platform === "win32";
  const dirs = String(env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  const exts = win ? [".exe", ".com"] : [""];
  let shimOnly;
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      if (isFile(p)) return { argv: [p] };
    }
    if (win && isFile(path.join(dir, `${name}.cmd`))) shimOnly = path.join(dir, `${name}.cmd`);
  }
  for (const p of fallbacks) if (isFile(p)) return { argv: [p] };
  return shimOnly ? { note: `only ${shimOnly} was found, which runs only through a shell; pass --${name} <path to ${name}.exe>` } : {};
}

/** @param {string} p */
function isFile(p) { try { return statSync(p).isFile(); } catch { return false; } }
/** @param {string} p */
function isDir(p) { try { return statSync(p).isDirectory(); } catch { return false; } }

/** @param {string | undefined} value @returns {string[] | undefined} a path, or a JSON array argv prefix */
function argvOption(value) {
  if (value === undefined) return undefined;
  const t = value.trim();
  if (t.startsWith("[")) {
    const parsed = JSON.parse(t);
    if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((x) => typeof x === "string")) throw usage(`expected a path or a JSON array of strings, got ${value}`);
    return parsed;
  }
  return [path.resolve(t)];
}

// ---------------------------------------------------------------- files

/** @param {string} a @param {string} b */
export function samePath(a, b) {
  const n = (/** @type {string} */ p) => { const r = path.resolve(p); return process.platform === "win32" ? r.toLowerCase() : r; };
  return n(a) === n(b);
}

/** @param {string} p @returns {Promise<any | undefined>} undefined when absent; throws when present and not JSON */
async function readJsonIfAny(p) {
  let raw;
  try { raw = await readFile(p, "utf8"); } catch (e) { if (/** @type {any} */ (e).code === "ENOENT") return undefined; throw e; }
  try { return JSON.parse(raw); } catch (e) { throw new Error(`${p} is not JSON (${e instanceof Error ? e.message : String(e)}); fix or move it, then run again`); }
}

/**
 * The lines that turn `before` into `after`, one per changed leaf: `- key: old` and `+ key: new`.
 * @param {unknown} before @param {unknown} after @param {string} [at] @returns {string[]}
 */
export function diffJson(before, after, at = "") {
  const isObj = (/** @type {unknown} */ v) => v !== null && typeof v === "object" && !Array.isArray(v);
  if (isObj(before) && isObj(after)) {
    const b = /** @type {Record<string, unknown>} */ (before), a = /** @type {Record<string, unknown>} */ (after);
    /** @type {string[]} */
    const out = [];
    for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) out.push(...diffJson(b[k], a[k], at ? `${at}.${k}` : k));
    return out;
  }
  const bj = before === undefined ? undefined : JSON.stringify(before), aj = after === undefined ? undefined : JSON.stringify(after);
  if (bj === aj) return [];
  return [...(bj !== undefined ? [`- ${at}: ${bj}`] : []), ...(aj !== undefined ? [`+ ${at}: ${aj}`] : [])];
}

/**
 * Write `next` as JSON over `file`, keeping the bytes before it as `<file>.bak-<time>`. Never an
 * agora config: that is written only through `agora config` (agoraConfig below).
 * @param {Ctx} c @param {string} file @param {unknown} next @returns {Promise<string[]>}
 */
async function writeJsonMerged(c, file, next) {
  await mkdir(path.dirname(file), { recursive: true });
  /** @type {string[]} */
  const notes = [];
  if (existsSync(file)) {
    const stamp = c.deps.now().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const backup = `${file}.bak-${stamp}`;
    await copyFile(file, backup);
    notes.push(`backup of the file before: ${backup}`);
  }
  await writeFileAtomic(file, JSON.stringify(next, null, 2) + "\n");
  return notes;
}

/** @param {string} p */
function sha256File(p) { return createHash("sha256").update(readFileSync(p)).digest("hex"); }

// ---------------------------------------------------------------- kits

/**
 * A kit folder as `admit-peer-seat.mjs` writes it: descriptor.json, one <generation>.secret and
 * install-peer-route.mjs.
 * @param {string} dir
 * @returns {{ ok: true, descriptor: any, secretName: string } | { ok: false, why: string }}
 */
function readKit(dir) {
  if (/\.zip$/i.test(dir) || isFile(dir))
    return { ok: false, why: `${dir} is a file; unzip the kit into a private folder first (Windows: tar -xf <kit>.zip -C <folder>; macOS: unzip <kit>.zip -d <folder>) and pass the folder` };
  if (!isDir(dir)) return { ok: false, why: `no kit folder at ${dir}` };
  const names = readdirSync(dir);
  const secrets = names.filter((n) => n.endsWith(".secret"));
  if (!names.includes("descriptor.json") || !names.includes("install-peer-route.mjs") || secrets.length !== 1)
    return { ok: false, why: `${dir} is not a route kit: it must hold descriptor.json, install-peer-route.mjs and exactly one .secret (it holds ${names.join(", ") || "nothing"})` };
  let descriptor;
  try { descriptor = JSON.parse(readFileSync(path.join(dir, "descriptor.json"), "utf8")); }
  catch { return { ok: false, why: `${path.join(dir, "descriptor.json")} is not JSON` }; }
  if (!descriptor?.binding?.grantId || !descriptor?.binding?.allowedKeyDigest) return { ok: false, why: `${dir}/descriptor.json carries no route binding` };
  return { ok: true, descriptor, secretName: /** @type {string} */ (secrets[0]) };
}

/** @param {string} state @param {string} grantId */
const installedDescriptorPath = (state, grantId) => path.join(state, "native", "remote", grantId, "descriptor.json");

/** Whether the kit's two files are installed under `state`, byte for byte.
 * @param {string} kitDir @param {{ descriptor: any, secretName: string }} kit @param {string} state */
function kitInstalled(kitDir, kit, state) {
  const grant = kit.descriptor.binding.grantId;
  const desc = installedDescriptorPath(state, grant);
  const secret = path.join(state, "native", "routes", grant, kit.secretName);
  if (!isFile(desc) || !isFile(secret)) return false;
  return sha256File(desc) === sha256File(path.join(kitDir, "descriptor.json")) && sha256File(secret) === sha256File(path.join(kitDir, kit.secretName));
}

/**
 * Verify an installed descriptor offline with `agora room add-remote`, under a throwaway config
 * whose actor is `actor`: the descriptor's digest, that it names this state root's key, and that its
 * secret resolves and is private. Prints and writes no config.
 * @param {Ctx} c @param {string} descriptorPath @param {string} state @param {{ name: string, kind: string }} actor
 */
async function verifyDescriptor(c, descriptorPath, state, actor) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agora-member-seat-"));
  try {
    const cfg = path.join(dir, "probe.json");
    await writeFile(cfg, JSON.stringify({ actor, state, rooms: { [`${PROBE_ALIAS}-room`]: { transport: "local", path: path.join(dir, "probe.jsonl") } } }));
    const r = await c.deps.agora(["room", "add-remote", PROBE_ALIAS, descriptorPath, "--json", "--config", cfg], { state, config: cfg });
    const row = jsonLines(r.stdout).find((x) => x.type === "room" && x.action === "add-remote");
    if (r.code !== 0 || !row) return { ok: false, why: failText(r) };
    return { ok: true, roomId: String(row.roomId), member: String(row.member), author: row.author, actorMatches: row.actorMatches };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** @param {Ctx} c @param {string} kitDir @param {string} state */
async function runInstaller(c, kitDir, state) {
  const r = await c.deps.exec([process.execPath, path.join(kitDir, "install-peer-route.mjs"), "--state", state], { cwd: kitDir, env: c.deps.env, timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`the kit's installer failed: ${failText(r)}`);
  return r.stdout.split(/\r?\n/).filter((l) => /^Installed /.test(l)).map((l) => `  ${l}`);
}

/**
 * One `agora config` write against `file` (with `dryRun`, the same command with --dry-run, which
 * writes nothing), and what it reported. agora config is the one writer of an agora config: it
 * validates the whole result as agora loads it, locks, keeps the file before as a backup, and
 * prints the diff.
 * @param {Ctx} c @param {string[]} args the words after `config` @param {{ file: string, state: string, dryRun?: boolean }} o
 * @returns {Promise<{ path: string, written: boolean, noop?: string, backup?: string, diff: string }>}
 */
async function agoraConfig(c, args, o) {
  const r = await c.deps.agora(["config", ...args, ...(o.dryRun ? ["--dry-run"] : []), "--json", "--config", o.file], { state: o.state, config: o.file });
  const res = jsonLines(r.stdout).find((x) => x.type === "config");
  if (r.code !== 0 || !res) throw new Error(`agora config ${args.slice(0, 2).join(" ")} refused: ${failText(r)}`);
  return res;
}

/** The diff an `agora config` command printed, as change lines. @param {{ diff: string }} res */
const diffLines = (res) => (res.diff ? res.diff.split("\n").map((l) => `  ${l}`) : []);

/** What a write reported, as change lines. @param {{ path: string, backup?: string }} res */
const wroteLines = (res) => [`  wrote ${res.path} with agora config`, ...(res.backup ? [`  backup of the file before: ${res.backup}`] : [])];

/**
 * The `agora config` words that put `row` under `rooms.<room>` of the config at `file`: room add
 * (with --replace over another descriptor), or, when the file does not exist yet (or names no
 * rooms), set with the actor and the state root it lacks, and the rooms.
 * @param {Ctx} c @param {unknown} before @param {{ transport: string, descriptor: string }} row
 * @param {{ actor: { name: string, kind: string }, state?: string, replace: boolean }} o
 */
function roomConfigArgs(c, before, row, o) {
  const b = /** @type {any} */ (before);
  if (b?.rooms && typeof b.rooms === "object" && !Array.isArray(b.rooms))
    return ["room", "add", c.room, JSON.stringify(row), ...(o.replace ? ["--replace"] : [])];
  return ["set", ...(b?.actor ? [] : ["actor", JSON.stringify(o.actor)]), ...(o.state && b?.state === undefined ? ["state", JSON.stringify(o.state)] : []),
    "rooms", JSON.stringify({ [c.room]: row })];
}

// ---------------------------------------------------------------- keys

/**
 * The node key in `state`, read through `agora enroll --local` only when the key file exists, so a
 * check never mints one.
 * @param {Ctx} c @param {string} state @returns {Promise<KeyRead>}
 */
async function readKey(c, state) {
  if (!isFile(path.join(state, "tailcat", "identity.private.json"))) return { exists: false };
  return mintOrRead(c, state);
}

/** @typedef {{ exists: boolean, nodeKey?: string, fingerprint?: string, error?: string }} KeyRead */
/** @param {Ctx} c @param {string} state @returns {Promise<KeyRead>} */
async function mintOrRead(c, state) {
  const r = await c.deps.agora(["enroll", "--local", "--json"], { state });
  const row = jsonLines(r.stdout).find((x) => x.type === "enrollment-identity");
  if (r.code !== 0 || !row) return { exists: true, error: failText(r) };
  return { exists: true, nodeKey: String(row.nodeKey), fingerprint: String(row.fingerprint) };
}

// ---------------------------------------------------------------- steps

/** @type {Step[]} */
export const STEPS = [
  {
    id: "node", title: "Node", needs: [],
    async inspect() {
      const v = process.versions.node.split(".").map(Number);
      const okv = (v[0] ?? 0) > (NODE_MIN[0] ?? 0) || ((v[0] ?? 0) === NODE_MIN[0] && (v[1] ?? 0) >= (NODE_MIN[1] ?? 0));
      return okv ? { state: "ok", detail: `v${process.versions.node}` }
        : { state: "fail", detail: `v${process.versions.node}; install Node ${NODE_MIN.join(".")} or later and run again` };
    },
  },
  {
    id: "checkout", title: "agora at the pin", needs: [],
    async inspect(c) {
      const git = (/** @type {string[]} */ a) => c.deps.exec(["git", "-C", ROOT, ...a], { env: c.deps.env, timeoutMs: 30_000 });
      const head = await git(["rev-parse", "HEAD"]);
      if (head.code !== 0) {
        const why = /dubious ownership|safe\.directory/.test(head.stderr)
          ? `git refuses a checkout owned by another account (git config --global --add safe.directory "${ROOT}" accepts it)`
          : failText(head);
        return { state: "fail", detail: `${ROOT} is not a usable git checkout: ${why}; clone agora at the pin (docs/MEMBER-SEAT.md step 1)` };
      }
      const sha = head.stdout.trim();
      if (!c.pin) return { state: "fail", detail: `at ${sha.slice(0, 12)}, no pin named; pass --pin <tag>, the release both seats agreed` };
      const want = await git(["rev-parse", "--verify", "--quiet", `${c.pin}^{commit}`]);
      if (want.code !== 0) return { state: "fail", detail: `the pin ${c.pin} is not in this checkout: git -C "${ROOT}" fetch --tags origin, then git -C "${ROOT}" checkout ${c.pin}` };
      const pinned = want.stdout.trim();
      if (pinned !== sha) return { state: "fail", detail: `at ${sha.slice(0, 12)}, not the pin ${c.pin} (${pinned.slice(0, 12)}): git -C "${ROOT}" checkout ${c.pin}` };
      const dirty = await git(["status", "--porcelain", "--untracked-files=no"]);
      const n = dirty.stdout.split(/\r?\n/).filter(Boolean).length;
      return { state: "ok", detail: `at ${c.pin} (${sha.slice(0, 12)})${n ? `; note: ${n} tracked file(s) changed since` : ""}` };
    },
  },
  {
    id: "seat-key", title: "this seat's key", needs: [],
    async inspect(c, s) {
      const k = await readKey(c, c.stateRoot);
      if (!k.exists) return { state: "todo", detail: `no key under ${c.stateRoot}; a plain run mints it (agora enroll --local)` };
      if (!k.nodeKey) return { state: "fail", detail: `the key under ${c.stateRoot} could not be read: ${k.error}` };
      s.seatKey = { nodeKey: k.nodeKey, fingerprint: k.fingerprint ?? "" };
      return { state: "ok", detail: `${k.nodeKey} · fingerprint ${k.fingerprint}` };
    },
    async apply(c) {
      const k = await mintOrRead(c, c.stateRoot);
      if (!k.nodeKey) throw new Error(`could not mint this seat's key: ${k.error}`);
      return [`  minted under ${c.stateRoot}`];
    },
  },
  {
    id: "route", title: "the seat's route", needs: ["seat-key"],
    async inspect(c, s) {
      const seatKey = /** @type {NonNullable<Shared["seatKey"]>} */ (s.seatKey);
      if (c.kit) {
        const kit = readKit(c.kit);
        if (!kit.ok) return { state: "fail", detail: kit.why };
        const b = kit.descriptor.binding;
        if (b.author) return { state: "fail", detail: `${c.kit} is the human's kit (it grants ${JSON.stringify(b.author.name)}); pass it as --human-kit` };
        if (b.allowedKeyDigest !== publicNodeKeyDigest(seatKey.nodeKey))
          return { state: "fail", detail: `this kit was issued for another key (${b.allowedKeyDigest}), not this seat's (${publicNodeKeyDigest(seatKey.nodeKey)}). Send the host this seat's public key, ${seatKey.nodeKey}, and wait for a kit issued for it; never copy another machine's private key` };
        const desc = installedDescriptorPath(c.stateRoot, b.grantId);
        if (!kitInstalled(c.kit, kit, c.stateRoot)) return { state: "todo", detail: `kit for grant ${String(b.grantId).slice(0, 12)} not installed under ${c.stateRoot}; a plain run runs its installer`, plan: { kitDir: c.kit } };
        const v = await verifyDescriptor(c, desc, c.stateRoot, { name: c.actor, kind: "agent" });
        if (!v.ok) return { state: "fail", detail: `installed, but the descriptor does not verify: ${v.why}` };
        s.descriptorPath = desc;
        return { state: "ok", detail: `grant ${String(b.grantId).slice(0, 12)} installed and verified offline: room ${v.roomId}, this seat posts as ${v.member}` };
      }
      const cfg = await readJsonIfAny(c.configPath);
      const row = cfg?.rooms?.[c.room];
      if (row?.transport === "native-remote" && typeof row.descriptor === "string" && isFile(row.descriptor)) {
        const v = await verifyDescriptor(c, row.descriptor, c.stateRoot, { name: c.actor, kind: "agent" });
        if (!v.ok) return { state: "fail", detail: `the descriptor the config names does not verify: ${v.why}` };
        s.descriptorPath = row.descriptor;
        return { state: "ok", detail: `installed and verified offline: room ${v.roomId}, this seat posts as ${v.member}` };
      }
      return { state: "wait", detail: `no route yet: unzip the kit the host sent into a private folder and pass --kit <folder>. The host issues it for this seat's key, ${seatKey.nodeKey}` };
    },
    async apply(c, _s, plan) { return runInstaller(c, plan.kitDir, c.stateRoot); },
  },
  {
    // agora config is the one writer of this seat's config: a plain run writes the row with it, and
    // --check runs the same command with --dry-run, which writes nothing, to show the diff.
    id: "config", title: "the room in this seat's config", needs: ["route"],
    async inspect(c, s) {
      if (c.stateFromEnv && !samePath(c.stateFromEnv, c.stateRoot))
        return { state: "fail", detail: `AGORA_STATE (${c.stateFromEnv}) is not the state root the config names (${c.stateRoot}); sessions without AGORA_STATE would not find the route. Unset it or make them agree` };
      const row = { transport: "native-remote", descriptor: /** @type {string} */ (s.descriptorPath) };
      const before = await readJsonIfAny(c.configPath);
      const have = before?.rooms?.[c.room];
      if (have && have.transport !== "native-remote")
        return { state: "fail", detail: `${c.configPath} already has a ${have.transport} room named ${c.room}; choose another alias with --room` };
      if (have && typeof have.descriptor === "string" && samePath(have.descriptor, row.descriptor)) return { state: "ok", detail: `${c.configPath}: ${c.room} → ${row.descriptor}` };
      const args = roomConfigArgs(c, before, row, { actor: { name: c.actor, kind: "agent" }, ...(samePath(defaultStateRoot(c), c.stateRoot) ? {} : { state: c.stateRoot }), replace: Boolean(have) });
      const preview = await agoraConfig(c, args, { file: c.configPath, state: c.stateRoot, dryRun: true });
      if (preview.noop) return { state: "ok", detail: `${c.configPath}: ${c.room} → ${row.descriptor}` };
      const what = !before ? "does not exist yet" : have ? `names another descriptor for ${c.room}` : `has no room ${c.room} yet`;
      return { state: "todo", detail: `${c.configPath} ${what}; a plain run writes it with agora config ${args[0] === "set" ? "set" : `room add${have ? " --replace" : ""}`}`, changes: diffLines(preview), plan: { args } };
    },
    async apply(c, _s, plan) {
      return wroteLines(await agoraConfig(c, plan.args, { file: c.configPath, state: c.stateRoot }));
    },
  },
  {
    id: "doctor", title: "agora doctor reaches the room", needs: ["config"],
    async inspect(c) {
      const r = await c.deps.agora(["doctor", "--json", "--config", c.configPath], { state: c.stateRoot, config: c.configPath });
      const row = jsonLines(r.stdout).find((x) => x.type === "room" && x.alias === c.room);
      if (!row) return { state: "fail", detail: `doctor printed no row for ${c.room}: ${failText(r)}` };
      if (row.error || !row.identity) return { state: "fail", detail: `${row.error ?? "no identity"}. Is the host's seat service up, and this machine on its network? On macOS, a first Tailcat run may raise a firewall prompt` };
      return { state: "ok", detail: `dialled the host; this seat is ${row.identity.name ?? "?"} (${row.identity.id ?? "?"})` };
    },
  },
  {
    id: "human-key", title: "the human's key", needs: [],
    async inspect(c, s) {
      if (samePath(c.humanState, c.stateRoot)) return { state: "fail", detail: `the human's state root is the seat's (${c.stateRoot}); give the human a folder of its own (--human-root)` };
      const k = await readKey(c, c.humanState);
      if (!k.exists) return { state: "todo", detail: `no key under ${c.humanState}; a plain run mints it in that folder, apart from the seat's` };
      if (!k.nodeKey) return { state: "fail", detail: `the key under ${c.humanState} could not be read: ${k.error}` };
      if (s.seatKey && k.nodeKey === s.seatKey.nodeKey) return { state: "fail", detail: `the human's key is the seat's key; mint the human's in its own folder` };
      s.humanKey = { nodeKey: k.nodeKey, fingerprint: k.fingerprint ?? "" };
      return { state: "ok", detail: `${k.nodeKey} · fingerprint ${k.fingerprint}`, notes: sendBack(c, s.humanKey) };
    },
    async apply(c) {
      const k = await mintOrRead(c, c.humanState);
      if (!k.nodeKey) throw new Error(`could not mint the human's key: ${k.error}`);
      return [`  minted under ${c.humanState}`];
    },
  },
  {
    id: "human-route", title: "the human's route", needs: ["human-key"],
    async inspect(c, s) {
      const humanKey = /** @type {NonNullable<Shared["humanKey"]>} */ (s.humanKey);
      let descriptorPath, name;
      /** @type {any} */
      let plan = {};
      if (c.humanKit) {
        const kit = readKit(c.humanKit);
        if (!kit.ok) return { state: "fail", detail: kit.why };
        const b = kit.descriptor.binding;
        if (!b.author || b.author.kind !== "human") return { state: "fail", detail: `${c.humanKit} is an agent route, not the human's; the host issues the human's with --human-key and --human-name` };
        if (c.humanName !== undefined && b.author.name !== c.humanName.trim())
          return { state: "fail", detail: `this kit grants ${JSON.stringify(b.author.name)}, not ${JSON.stringify(c.humanName)}; the host stamps every post on it with the granted name` };
        if (b.allowedKeyDigest !== publicNodeKeyDigest(humanKey.nodeKey))
          return { state: "fail", detail: `this kit was issued for another key (${b.allowedKeyDigest}), not the human's (${publicNodeKeyDigest(humanKey.nodeKey)})` };
        name = String(b.author.name);
        descriptorPath = installedDescriptorPath(c.humanState, b.grantId);
        if (!kitInstalled(c.humanKit, kit, c.humanState)) plan.install = c.humanKit;
      } else {
        const cfg = await readJsonIfAny(c.humanConfig);
        const row = cfg?.rooms?.[c.room];
        if (!(row?.transport === "native-remote" && typeof row.descriptor === "string" && isFile(row.descriptor)))
          return { state: "wait", detail: `the host issues the human's route for the key above${c.humanName ? ` under the name ${JSON.stringify(c.humanName)}` : ""}; when its kit arrives, unzip it into a private folder and pass --human-kit <folder>` };
        descriptorPath = row.descriptor;
        name = String(cfg.actor?.name ?? "");
      }
      const before = await readJsonIfAny(c.humanConfig);
      const after = { ...(before ?? {}), actor: { name, kind: "human" }, state: c.humanState,
        rooms: { ...(before?.rooms ?? {}), [c.room]: { transport: "native-remote", descriptor: descriptorPath } } };
      const changes = (before ? diffJson(before, after) : [`+ (new file) ${JSON.stringify(after)}`]).map((l) => `  ${l}`);
      if (changes.length) plan.config = after;
      if (plan.install || plan.config) {
        return { state: "todo", detail: `${plan.install ? `install the human's kit under ${c.humanState}; ` : ""}${changes.length ? `write the human's config ${c.humanConfig}` : ""}`, changes, plan };
      }
      const v = await verifyDescriptor(c, descriptorPath, c.humanState, { name, kind: "human" });
      if (!v.ok) return { state: "fail", detail: `the human's descriptor does not verify: ${v.why}` };
      if (v.actorMatches !== true) return { state: "fail", detail: `the route does not grant ${JSON.stringify(name)} as a human` };
      // Installed and verified offline: the Tern pane can post through it. Reaching the host is the
      // doctor's question, asked next.
      s.humanInstalled = true;
      const r = await c.deps.agora(["doctor", "--json", "--config", c.humanConfig], { state: c.humanState, config: c.humanConfig });
      const row = jsonLines(r.stdout).find((x) => x.type === "room" && x.alias === c.room);
      if (!row || row.error || !row.identity) return { state: "fail", detail: `installed and verified offline, but doctor on the human's config does not reach the room: ${row?.error ?? failText(r)}` };
      return { state: "ok", detail: `${JSON.stringify(name)} posts as a human through ${c.humanConfig}; dialled as ${row.identity.id ?? "?"}` };
    },
    async apply(c, _s, plan) {
      /** @type {string[]} */
      const out = [];
      if (plan.install) out.push(...await runInstaller(c, plan.install, c.humanState));
      if (plan.config) {
        // through agora config, as the seat's own: the actor and state the route needs, then the room
        const o = { file: c.humanConfig, state: c.humanState };
        const b = /** @type {any} */ (await readJsonIfAny(c.humanConfig));
        const { actor, state } = plan.config;
        const row = plan.config.rooms[c.room];
        if (b?.rooms && typeof b.rooms === "object" && !Array.isArray(b.rooms)) {
          const set = [
            ...(JSON.stringify(b.actor) === JSON.stringify(actor) ? [] : ["actor", JSON.stringify(actor)]),
            ...(b.state === state ? [] : ["state", JSON.stringify(state)]),
          ];
          if (set.length) out.push(...wroteLines(await agoraConfig(c, ["set", ...set], o)));
          const added = await agoraConfig(c, ["room", "add", c.room, JSON.stringify(row), "--replace"], o);
          if (added.written) out.push(...wroteLines(added));
        } else {
          out.push(...wroteLines(await agoraConfig(c, ["set", "actor", JSON.stringify(actor), "state", JSON.stringify(state), "rooms", JSON.stringify({ [c.room]: row })], o)));
        }
      }
      return out;
    },
  },
  {
    id: "omp", title: "omp: the extension and the skill", needs: [],
    async inspect(c, s) {
      const bin = c.omp ?? findExecutable("omp", c.deps.env, ompFallbacks(c)).argv;
      if (!bin) return { state: "fail", detail: findExecutable("omp", c.deps.env).note ?? `omp is not on PATH; install it (bun add -g @oh-my-pi/pi-coding-agent) or pass --omp <path>` };
      s.ompBin = bin;
      const v = await c.deps.exec([...bin, "--version"], { env: c.deps.env, timeoutMs: 60_000 });
      if (v.code !== 0) return { state: "fail", detail: `${bin.join(" ")} --version failed: ${failText(v)}` };
      const linked = path.join(c.deps.home, ".omp", "plugins", "node_modules", "agora-room");
      if (lexists(linked)) return { state: "fail", detail: `agora-room is also linked as an omp plugin (${linked}), so it would load twice and deliver every message twice: omp plugin uninstall agora-room` };
      const wanted = { extensions: path.join(ROOT, "plugins", "omp", "agora-room"), "skills.customDirectories": path.join(ROOT, "skills") };
      /** @type {Record<string, string[]>} */
      const next = {};
      /** @type {string[]} */
      const changes = [];
      const cwd = await mkdtemp(path.join(os.tmpdir(), "agora-member-seat-omp-"));
      try {
        for (const [key, ours] of Object.entries(wanted)) {
          const r = await c.deps.exec([...bin, "config", "get", key, "--json"], { cwd, env: c.deps.env, timeoutMs: 60_000 });
          let value;
          try { value = JSON.parse(r.stdout).value; } catch { /* below */ }
          if (r.code !== 0 || !Array.isArray(value)) return { state: "fail", detail: `omp config get ${key} failed: ${failText(r)}` };
          const merged = mergeEntry(value.map(String), ours, key === "extensions"
            ? (/** @type {string} */ e) => /[\\/]plugins[\\/]omp[\\/]agora-room[\\/]?$/.test(e)
            : (/** @type {string} */ e) => isFile(path.join(e, "agora", "SKILL.md")));
          if (merged) { next[key] = merged; changes.push(...diffJson({ [key]: value }, { [key]: merged }).map((l) => `  ${l}`)); }
        }
      } finally { await rm(cwd, { recursive: true, force: true }); }
      const ver = v.stdout.trim().split(/\r?\n/)[0];
      if (Object.keys(next).length) return { state: "todo", detail: `${ver}: add the extension and the skill folder to omp's settings (omp config set)`, changes, plan: next };
      return { state: "ok", detail: `${ver}; extensions and skills.customDirectories name this checkout` };
    },
    async apply(c, s, plan) {
      const bin = /** @type {string[]} */ (s.ompBin);
      /** @type {string[]} */
      const out = [];
      const cwd = await mkdtemp(path.join(os.tmpdir(), "agora-member-seat-omp-"));
      try {
        for (const [key, value] of Object.entries(plan)) {
          const r = await c.deps.exec([...bin, "config", "set", key, JSON.stringify(value), "--json"], { cwd, env: c.deps.env, timeoutMs: 60_000 });
          if (r.code !== 0) throw new Error(`omp config set ${key} failed: ${failText(r)}`);
          let res;
          try { res = JSON.parse(r.stdout); } catch { res = {}; }
          if (res.overriddenBy) throw new Error(`omp wrote ${key}, but ${res.overriddenBy} still sets it; remove it there`);
          out.push(`  omp config set ${key}`);
        }
      } finally { await rm(cwd, { recursive: true, force: true }); }
      return out;
    },
  },
  {
    id: "tern", title: "Tern: the agora pane", needs: [],
    async inspect(c, s) {
      const bin = c.tern ?? findExecutable("tern", c.deps.env, ternFallbacks(c)).argv;
      if (!bin) return { state: "fail", detail: findExecutable("tern", c.deps.env).note ?? `tern is not on PATH; install Tern or pass --tern <path>` };
      s.ternBin = bin;
      const d = await c.deps.exec([...bin, "plugin", "dir", "--json"], { env: c.deps.env, timeoutMs: 60_000 });
      let dir;
      try { dir = String(JSON.parse(d.stdout).dir); } catch { /* below */ }
      if (d.code !== 0 || !dir) return { state: "fail", detail: `tern plugin dir failed: ${failText(d)}` };
      if (isDir(path.join(dir, "agora"))) return { state: "fail", detail: `an installed copy of the plugin is at ${path.join(dir, "agora")}, and a copy has no checkout beside it: tern plugin remove agora, then run again` };
      const pkg = path.join(ROOT, "plugins", "tern", "agora");
      const linkFile = path.join(dir, "agora.path");
      const linkedTo = isFile(linkFile) ? readFileSync(linkFile, "utf8").trim() : undefined;
      /** @type {any} */
      const plan = { dir, pkg };
      /** @type {string[]} */
      const changes = [];
      if (!linkedTo || !samePath(linkedTo, pkg)) {
        plan.link = { from: linkedTo };
        changes.push(...diffJson({ "agora.path": linkedTo }, { "agora.path": pkg }).map((l) => `  ${l}`));
      }
      const data = c.ternData ?? ternDataDir(c, dir);
      const file = path.join(data, "agora.json");
      const before = (await readJsonIfAny(file)) ?? {};
      const rooms = Array.isArray(before.rooms) ? before.rooms.map(String) : [];
      const after = {
        ...before,
        rooms: rooms.includes(c.room) ? rooms : [...rooms, c.room],
        room: typeof before.room === "string" && before.room ? before.room : c.room,
        ...(c.configIsDefault ? {} : { config: c.configPath }),
        ...(s.humanInstalled ? { post: { command: ["node", ENTRY, "--config", c.humanConfig], env: { AGORA_STATE: c.humanState } } } : {}),
      };
      const dataChanges = diffJson(before, after).map((l) => `  ${l}`);
      if (dataChanges.length) { plan.data = { file, after }; changes.push(`  ${file}:`, ...dataChanges); }
      if (plan.link || plan.data) return { state: "todo", detail: `${plan.link ? "link the plugin from this checkout (tern plugin link); " : ""}${plan.data ? `write its settings in ${data}` : ""}`, changes, plan };
      const l = await c.deps.exec([...bin, "plugin", "list", "--json"], { env: c.deps.env, timeoutMs: 60_000 });
      let listed;
      try { listed = JSON.parse(l.stdout); } catch { /* below */ }
      const row = listed?.plugins?.find((/** @type {any} */ p) => p.id === "agora");
      const problems = (listed?.problems ?? []).map((/** @type {any} */ p) => typeof p === "string" ? p : JSON.stringify(p));
      if (l.code !== 0 || !row || row.status !== "ready" || problems.length)
        return { state: "fail", detail: `linked, but tern does not report the plugin ready: ${row ? `status ${row.status}` : "not listed"}${problems.length ? `; problems: ${problems.join("; ")}` : ""}` };
      const seen = ["kv.json", "last-view.json"].some((f) => isFile(path.join(data, f)));
      const where = seen ? `the pane has used ${data}` : `open the pane once (ctrl+alt+a) and check again to confirm ${data} is the folder it reads`;
      if (!s.humanInstalled) return { state: "wait", detail: `linked from this checkout, ready, room ${c.room} offered; ${where}. Its post command waits for the human's route` };
      return { state: "ok", detail: `linked from this checkout, ready; posts as the human through ${c.humanConfig}; ${where}` };
    },
    async apply(c, s, plan) {
      const bin = /** @type {string[]} */ (s.ternBin);
      /** @type {string[]} */
      const out = [];
      if (plan.link) {
        if (plan.link.from) {
          const u = await c.deps.exec([...bin, "plugin", "unlink", "agora"], { env: c.deps.env, timeoutMs: 60_000 });
          if (u.code !== 0) throw new Error(`tern plugin unlink agora failed: ${failText(u)}`);
          out.push(`  tern plugin unlink agora (was ${plan.link.from})`);
        }
        const r = await c.deps.exec([...bin, "plugin", "link", plan.pkg], { env: c.deps.env, timeoutMs: 60_000 });
        if (r.code !== 0) throw new Error(`tern plugin link failed: ${failText(r)}`);
        out.push(`  tern plugin link ${plan.pkg}`);
      }
      if (plan.data) out.push(...(await writeJsonMerged(c, plan.data.file, plan.data.after)).map((l) => `  ${l}`));
      return out;
    },
  },
  {
    id: "charter", title: "the room's charter", needs: ["doctor"],
    async inspect(c) {
      const r = await c.deps.agora(["read", c.room, "--json", "--config", c.configPath], { state: c.stateRoot, config: c.configPath });
      if (r.code !== 0) return { state: "fail", detail: `could not read ${c.room}: ${failText(r)}` };
      const charter = pinnedCharter(jsonLines(r.stdout), c.charterName);
      if (!charter) return { state: "wait", detail: `no pinned message in ${c.room} carries ${c.charterName}; the host posts the charter with --attach and pins it` };
      const hex = String(charter.attachment.digest).replace(/^sha256:/, "");
      const file = path.join(c.setupDir, "charter", safeName(c.room), `${hex.slice(0, 16)}-${safeName(c.charterName)}`);
      const from = `pinned by ${charter.message.author?.name ?? "?"} in message ${String(charter.message.id).slice(0, 12)}`;
      if (isFile(file) && sha256File(file) === hex) return { state: "ok", detail: `sha256:${hex} · ${file} · ${from}` };
      return { state: "todo", detail: `fetch sha256:${hex} (${from}) to ${file}`, plan: { id: charter.attachment.id, file, hex } };
    },
    async apply(c, _s, plan) {
      await mkdir(path.dirname(plan.file), { recursive: true });
      const part = `${plan.file}.part`;
      await rm(part, { force: true });
      const r = await c.deps.agora(["attachment", "get", c.room, plan.id, "--out", part, "--json", "--config", c.configPath], { state: c.stateRoot, config: c.configPath });
      if (r.code !== 0) throw new Error(`agora attachment get failed: ${failText(r)}`);
      if (sha256File(part) !== plan.hex) { await rm(part, { force: true }); throw new Error(`the fetched charter does not hash to sha256:${plan.hex}`); }
      await rename(part, plan.file);
      return [`  fetched to ${plan.file}`];
    },
  },
  {
    id: "first-run", title: "first run: read, and one post as an agent", needs: ["doctor"],
    async inspect(c) {
      const r = await c.deps.agora(["read", c.room, "--json", "--limit", "20", "--config", c.configPath], { state: c.stateRoot, config: c.configPath });
      if (r.code !== 0) return { state: "fail", detail: `could not read ${c.room}: ${failText(r)}` };
      const n = jsonLines(r.stdout).filter((x) => x.type === "message").length;
      const record = (await readJsonIfAny(firstRunFile(c))) ?? {};
      const done = record[c.room];
      if (done) return { state: "ok", detail: `read ${n} message(s); posted ${String(done.id).slice(0, 12)} as ${done.as} at ${done.at}` };
      return { state: "todo", detail: `read ${n} message(s); a plain run posts one message as ${FIRST_POST_AS}, once` };
    },
    async apply(c) {
      const text = "Seat check: this member seat's agent route posts. (setup-member-seat, once)";
      const r = await c.deps.agora(["post", c.room, "--json", "--as", FIRST_POST_AS, "--config", c.configPath, "--", text], { state: c.stateRoot, config: c.configPath });
      const receipt = jsonLines(r.stdout).find((x) => typeof x.id === "string");
      if (r.code !== 0 || !receipt) throw new Error(`agora post failed: ${failText(r)}`);
      const file = firstRunFile(c);
      const record = (await readJsonIfAny(file)) ?? {};
      record[c.room] = { id: receipt.id, cursor: receipt.cursor, as: FIRST_POST_AS, at: c.deps.now().toISOString() };
      await mkdir(path.dirname(file), { recursive: true });
      await writeFileAtomic(file, JSON.stringify(record, null, 2) + "\n");
      return [`  posted ${String(receipt.id).slice(0, 12)} to ${c.room}`];
    },
  },
  {
    id: "extension-turn", title: "the extension delivers a turn", needs: ["omp", "config"],
    async inspect(c) {
      const dir = path.join(c.deps.home, ".agora", "omp-room");
      /** @type {any[]} */
      const watching = [];
      for (const f of isDir(dir) ? await readdir(dir) : []) {
        if (!f.endsWith(".json") || f.endsWith(".queue.json")) continue;
        try {
          const doc = JSON.parse(await readFile(path.join(dir, f), "utf8"));
          if (doc?.harness === "omp" && Array.isArray(doc.rooms) && doc.rooms.some((/** @type {any} */ r) => r?.room === c.room)) watching.push(doc);
        } catch { /* not a liveness file */ }
      }
      const delivered = watching.filter((d) => Number(d.delivered) > 0).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      const top = delivered[0];
      if (top) return { state: "ok", detail: `session ${top.session} (${top.bearer ?? "?"}) delivered ${top.delivered} turn(s); last update ${top.updatedAt}` };
      const launch = process.platform === "win32"
        ? `$env:AGORA_ROOM="${c.room}"; $env:AGORA_ROLE="${c.role}"; $env:AGORA_ROOM_WAKE="all"; omp`
        : `AGORA_ROOM=${c.room} AGORA_ROLE=${c.role} AGORA_ROOM_WAKE=all omp`;
      if (watching.length) return { state: "wait", detail: `an omp session watches ${c.room} (${watching.map((d) => d.session).join(", ")}) but has delivered no turn yet: post to it (to: ${c.role}) from the Tern pane, then check again` };
      return { state: "wait", detail: `no omp session watches ${c.room} yet. In a Tern terminal pane (not an agent block): ${launch} — then post to it (to: ${c.role}) from the Tern pane and check again` };
    },
  },
];

/**
 * The entry list with ours in it and any other copy of it gone, or undefined when nothing changes.
 * @param {string[]} list @param {string} ours @param {(e: string) => boolean} isCopy
 */
function mergeEntry(list, ours, isCopy) {
  const kept = list.filter((e) => samePath(e, ours) || !isCopy(e));
  const next = kept.some((e) => samePath(e, ours)) ? kept : [...kept, ours];
  return JSON.stringify(next) === JSON.stringify(list) ? undefined : next;
}

/** @param {any[]} lines @param {string} name */
function pinnedCharter(lines, name) {
  /** @type {Map<string, any>} */
  const messages = new Map();
  /** @type {Map<string, boolean>} */
  const pinned = new Map();
  for (const x of lines) {
    if (x.type === "message" && typeof x.id === "string") messages.set(x.id, x);
    else if (x.type === "annotation" && (x.act === "pin" || x.act === "unpin") && typeof x.target === "string") pinned.set(x.target, x.act === "pin");
  }
  const want = name.toLowerCase();
  for (const m of [...messages.values()].reverse()) {
    if (!pinned.get(m.id) || m.withdrawn) continue;
    const attachment = (Array.isArray(m.attachments) ? m.attachments : []).find((/** @type {any} */ a) => String(a?.name ?? "").toLowerCase() === want && /^sha256:[a-f0-9]{64}$/.test(String(a?.digest)));
    if (attachment) return { message: m, attachment };
  }
  return undefined;
}

/** @param {Ctx} c */
const firstRunFile = (c) => path.join(c.setupDir, "first-run.json");
/** @param {string} s */
const safeName = (s) => s.replace(/[^A-Za-z0-9._-]/g, "_");
/** @param {string} p */
function lexists(p) { try { lstatSync(p); return true; } catch { return false; } }

/** @param {Ctx} c @param {{ nodeKey: string, fingerprint: string }} key */
function sendBack(c, key) {
  return [
    "  Send the host this public key for the human's route (it is public: paste it in the room or the",
    "  channel the host named, then confirm the fingerprint with the host another way):",
    `    ${key.nodeKey}`,
    `    fingerprint ${key.fingerprint}`,
    ...(c.humanName ? [`    the name it posts under: ${c.humanName}`] : []),
  ];
}

/** @param {Ctx} c */
function defaultStateRoot(c) { return path.join(c.deps.home, ".agora", "state"); }

/** @param {Ctx} c */
function ompFallbacks(c) {
  const exe = process.platform === "win32" ? "omp.exe" : "omp";
  return [path.join(c.deps.home, ".bun", "bin", exe)];
}

/** @param {Ctx} c */
function ternFallbacks(c) {
  const local = c.deps.env.LOCALAPPDATA;
  return process.platform === "win32" && local ? [path.join(local, "Programs", "Tern", "tern.exe")] : [];
}

/**
 * Where Tern keeps the agora plugin's data (`tern.plugin.data`): under TERN_CONFIG_DIR when set; on
 * Windows under %LOCALAPPDATA%\Tern (measured); elsewhere beside the plugins folder (not measured;
 * the tern step says when the pane has used the folder).
 * @param {Ctx} c @param {string} pluginDir
 */
export function ternDataDir(c, pluginDir) {
  const env = c.deps.env;
  if (env.TERN_CONFIG_DIR) return path.join(env.TERN_CONFIG_DIR, "plugin-data", "agora");
  if (process.platform === "win32" && env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, "Tern", "plugin-data", "agora");
  return path.join(path.dirname(pluginDir), "plugin-data", "agora");
}

// ---------------------------------------------------------------- the run

/** @param {string} message */
function usage(message) { return Object.assign(new Error(message), { exitCode: 2 }); }

/** @param {string} p @param {string} home */
function expand(p, home) { return path.resolve(p === "~" ? home : p.startsWith("~/") || p.startsWith("~\\") ? path.join(home, p.slice(2)) : p); }

/**
 * Inspect every step; with `apply`, carry out each one that is todo and inspect it again.
 * @param {string[]} argv @param {Partial<Deps>} [overrides]
 */
export async function setup(argv, overrides = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      check: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      room: { type: "string" },
      pin: { type: "string" },
      kit: { type: "string" },
      "human-kit": { type: "string" },
      "human-name": { type: "string" },
      "human-root": { type: "string" },
      config: { type: "string" },
      actor: { type: "string" },
      role: { type: "string" },
      "charter-name": { type: "string" },
      omp: { type: "string" },
      tern: { type: "string" },
      "tern-data": { type: "string" },
    },
    strict: true,
  });
  const env = overrides.env ?? process.env;
  /** @type {Deps} */
  const deps = { home: os.homedir(), env, exec: execNoShell, agora: defaultAgora(env), now: () => new Date(), ...overrides };
  const home = deps.home;
  if (!values.room || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(values.room)) throw usage("--room <alias> is required: letters, digits, dot, underscore or hyphen");
  if (values["human-name"] !== undefined && values["human-name"] !== values["human-name"].trim()) throw usage("--human-name has leading or trailing space");
  const configPath = values.config ? expand(values.config, home) : env.AGORA_CONFIG ? expand(env.AGORA_CONFIG, home) : path.join(home, ".agora", "config.json");
  let cfg;
  try { cfg = await readJsonIfAny(configPath); } catch (e) { throw usage(e instanceof Error ? e.message : String(e)); }
  const stateFromEnv = env.AGORA_STATE ? expand(env.AGORA_STATE, home) : undefined;
  const stateRoot = stateFromEnv ?? (typeof cfg?.state === "string" ? expand(cfg.state, home) : path.join(home, ".agora", "state"));
  const humanRoot = expand(values["human-root"] ?? path.join(home, ".agora", "human"), home);
  /** @type {Ctx} */
  const c = {
    apply: !values.check, room: values.room, pin: values.pin,
    kit: values.kit ? expand(values.kit, home) : undefined,
    humanKit: values["human-kit"] ? expand(values["human-kit"], home) : undefined,
    humanName: values["human-name"],
    humanRoot, humanState: path.join(humanRoot, "state"), humanConfig: path.join(humanRoot, "config.json"),
    configPath, configIsDefault: samePath(configPath, path.join(home, ".agora", "config.json")),
    stateRoot, ...(stateFromEnv ? { stateFromEnv } : {}),
    actor: values.actor ?? "agent", role: values.role ?? "coding", charterName: values["charter-name"] ?? "CHARTER.md",
    omp: argvOption(values.omp), tern: argvOption(values.tern),
    ternData: values["tern-data"] ? expand(values["tern-data"], home) : undefined,
    setupDir: path.join(home, ".agora", "member-seat"), deps,
  };

  /** @type {Shared} */
  const shared = {};
  /** @type {StepResult[]} */
  const results = [];
  for (const step of STEPS) {
    const blockers = step.needs.filter((id) => results.find((r) => r.id === id)?.state !== "ok");
    if (blockers.length) {
      results.push({ id: step.id, title: step.title, state: "blocked", detail: `after ${blockers.join(", ")}`, changed: false, changes: [], notes: [] });
      continue;
    }
    let seen = await guarded(() => step.inspect(c, shared));
    let changed = false;
    let changes = seen.changes ?? [];
    if (c.apply && seen.state === "todo" && step.apply) {
      const apply = step.apply, plan = seen.plan;
      try {
        changes = [...changes, ...await apply(c, shared, plan)];
        changed = true;
        seen = await guarded(() => step.inspect(c, shared));
      } catch (e) {
        seen = { state: "fail", detail: e instanceof Error ? e.message : String(e) };
      }
    }
    results.push({ id: step.id, title: step.title, state: seen.state, detail: seen.detail, changed, changes, notes: seen.notes ?? [] });
  }
  const sha = (await deps.exec(["git", "-C", ROOT, "rev-parse", "HEAD"], { env, timeoutMs: 30_000 })).stdout.trim();
  const count = (/** @type {State} */ s) => results.filter((r) => r.state === s).length;
  return {
    type: "member-seat-setup", mode: c.apply ? "apply" : "check", room: c.room, checkout: ROOT, head: sha || null,
    config: c.configPath, state: c.stateRoot, human: c.humanRoot,
    ok: count("todo") + count("fail") + count("blocked") === 0,
    changed: results.some((r) => r.changed),
    steps: results,
  };
}

/** @param {() => Promise<Inspection>} f @returns {Promise<Inspection>} */
async function guarded(f) {
  try { return await f(); } catch (e) { return { state: "fail", detail: e instanceof Error ? e.message : String(e) }; }
}

/** @param {Awaited<ReturnType<typeof setup>>} report */
export function formatReport(report) {
  const lines = [`member seat ${report.mode} · room ${report.room} · agora ${report.checkout}${report.head ? ` at ${report.head.slice(0, 12)}` : ""}`];
  for (const r of report.steps) {
    lines.push(`${r.state.padEnd(7)} ${r.id.padEnd(15)} ${r.detail}${r.changed ? "  [changed]" : ""}`);
    for (const l of [...r.changes, ...r.notes]) lines.push(`        ${l}`);
  }
  const n = (/** @type {State} */ s) => report.steps.filter((r) => r.state === s).length;
  lines.push(`${n("ok")} ok, ${n("wait")} wait, ${n("todo")} todo, ${n("fail")} fail, ${n("blocked")} blocked · ${report.changed ? "changed: see [changed] above" : "nothing changed"}`);
  return lines.join("\n");
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  setup(argv)
    .then((report) => {
      console.log(argv.includes("--json") ? JSON.stringify(report, null, 2) : formatReport(report));
      process.exitCode = report.ok ? 0 : 1;
    })
    .catch((e) => {
      console.error(`setup-member-seat: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = typeof e?.exitCode === "number" ? e.exitCode : 1;
    });
}
