// @ts-check
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pidAlive } from "./session.mjs";

const execFileAsync = promisify(execFile);

/**
 * Harness-side courtesies a long-lived watch owes the session that hosts it.
 *
 * Some harnesses run a stop hook at the end of every turn, and a persistent watch
 * turns every delivery into a turn: without a signal, a maintenance checklist
 * fires after each message and the agent spends a turn answering it, for hours.
 * The hook honours a session-scoped sentinel beside the session transcript,
 * `<transcript minus extension>.watch-mode`, and treats it as stale after 12 h.
 * A watch touches it while it runs and removes it when it stops, so the
 * suppression exists exactly as long as the watch does and is never a thing a
 * session has to remember to arm or to clear.
 *
 * The file is one per harness session and a session may run several watches at
 * once, so it carries the pid of the watch that owns it: a 140 ms `--once` watch
 * inside a session hosting a resident stream must not delete the stream's
 * suppression on its way out. A watch clears the sentinel only when the recorded pid
 * is its own; otherwise it leaves the file and refreshes its timestamp, so the owner
 * keeps its suppression and the hook's staleness rule still reaps an abandoned one.
 * A watch whose owner is no longer running takes ownership. A `--once` watch writes
 * no sentinel at all: a single poll cannot span a turn.
 *
 * Each harness descriptor knows where that harness keeps its transcript. The sentinel is written
 * only beside a transcript that exists: a wrong id or a foreign harness gets nothing, never a
 * stray file. This is especially important for Codex, whose no-maintenance marker is only the
 * second line of defence after the watcher-lifetime sentinel.
 */

const SESSION_ID = /^[A-Za-z0-9-]{8,128}$/;

/** @typedef {{ harness: string, dir: string, transcript: string, sentinel: string }} WatchModeSentinel */

/**
 * The identity of the code a resident process loaded. `at` makes a recorded build comparable to
 * the installed one; `git` is present when the entry point lives in a worktree, otherwise `at` is
 * the entry file's mtime.
 * @typedef {{ version: string, source: 'git' | 'mtime', at: string, git?: string }} BuildIdentity
 */

/** Claude Code's project directory name for a working directory. @param {string} cwd */
export function claudeProjectSlug(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** @param {string} root @param {(file: string) => boolean} accepts */
function findFile(root, accepts) {
  const stack = [root];
  while (stack.length) {
    const dir = /** @type {string} */ (stack.pop());
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(file);
      else if (entry.isFile() && accepts(file)) return file;
    }
  }
  return undefined;
}

/** @param {NodeJS.ProcessEnv} env @param {string} cwd @param {string} home */
function claudeTranscript(env, cwd, home) {
  const id = env.CLAUDE_CODE_SESSION_ID;
  if (!id || !SESSION_ID.test(id)) return undefined;
  for (let root = path.resolve(cwd); ; root = path.dirname(root)) {
    const file = path.join(home, ".claude", "projects", claudeProjectSlug(root), `${id}.jsonl`);
    if (existsSync(file)) return file;
    if (path.dirname(root) === root) return undefined;
  }
}

/** @param {NodeJS.ProcessEnv} env @param {string} _cwd @param {string} home */
function codexTranscript(env, _cwd, home) {
  const id = env.CODEX_SESSION_ID;
  if (!id || !SESSION_ID.test(id)) return undefined;
  const sessions = path.join(env.CODEX_HOME || path.join(home, ".codex"), "sessions");
  return findFile(sessions, (file) => path.basename(file).startsWith("rollout-") && path.basename(file).endsWith(`-${id}.jsonl`));
}

/**
 * A harness's prompt-cache TTL as this seat can actually read it. `ttl` is seconds when a value was
 * read off a file or the environment, and null when nothing on this machine says. Nothing here
 * asserts a TTL that was not read: an unset Claude Code setting reports unknown with the two things
 * that decide it, and Codex exposes no local setting at all.
 * @typedef {{ ttl: number | null, value: string | null, source: string | null, label: string }} CacheTtl
 */

/** What Claude Code's TTL is when nothing on this machine pins it. Two branches, neither measurable from here. */
const CLAUDE_TTL_UNKNOWN = `unknown (defaults to 1h on a subscription's main conversation, 5m past plan usage or on an API key; set promptCacheTtl: "1h" to pin it)`;

/** Codex has no local setting to read: retention is a property of the request OpenAI serves. */
const CODEX_TTL_UNKNOWN = `unknown (OpenAI's equivalent is 24h cache retention, carried in the request rather than written in a setting this seat can read)`;

/**
 * Seconds from a TTL as a settings file or an environment variable writes it (`"1h"`, `"5m"`,
 * `"300"`, `300`), or nothing when the value is not one. A value that does not parse is not a TTL
 * that was read, so the caller reports unknown rather than guessing at the intent.
 * @param {unknown} raw
 * @returns {{ seconds: number, value: string } | undefined}
 */
export function parseCacheTtl(raw) {
  const text = typeof raw === "number" && Number.isFinite(raw) ? `${raw}s` : typeof raw === "string" ? raw.trim() : "";
  const m = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds|m|min|mins|minutes|h|hr|hrs|hours)?$/i.exec(text);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const unit = (m[2] ?? "s").toLowerCase();
  const scale = unit.startsWith("h") ? 3600 : unit.startsWith("m") ? 60 : 1;
  return { seconds: Math.round(n * scale), value: text };
}

/** A JSON object off disk, or nothing. A settings file that is absent, unreadable or malformed says nothing. @param {string} file */
function readJsonFile(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? /** @type {Record<string, unknown>} */ (parsed) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Claude Code's `promptCacheTtl`, in the order the harness itself resolves it: the environment
 * pinned on this process, then the settings beside each directory from the working directory up
 * (`settings.local.json` before the shared `settings.json`), then the user's own settings.
 * @param {NodeJS.ProcessEnv} env @param {string} cwd @param {string} home
 * @returns {CacheTtl}
 */
function claudeCacheTtl(env, cwd, home) {
  /** @type {Array<[string, unknown]>} */
  const candidates = [["CLAUDE_CODE_PROMPT_CACHE_TTL", env.CLAUDE_CODE_PROMPT_CACHE_TTL]];
  for (let root = path.resolve(cwd); ; root = path.dirname(root)) {
    for (const name of ["settings.local.json", "settings.json"]) {
      const file = path.join(root, ".claude", name);
      candidates.push([file, readJsonFile(file)?.promptCacheTtl]);
    }
    if (path.dirname(root) === root) break;
  }
  const userSettings = path.join(home, ".claude", "settings.json");
  candidates.push([userSettings, readJsonFile(userSettings)?.promptCacheTtl]);
  for (const [source, raw] of candidates) {
    const parsed = parseCacheTtl(raw);
    if (parsed) return { ttl: parsed.seconds, value: parsed.value, source, label: `${parsed.value} (from ${source})` };
  }
  return { ttl: null, value: null, source: null, label: CLAUDE_TTL_UNKNOWN };
}

/** @returns {CacheTtl} */
function codexCacheTtl() {
  return { ttl: null, value: null, source: null, label: CODEX_TTL_UNKNOWN };
}

/**
 * One declarative inventory for harness-specific transcript state. Adding a harness extends this
 * table; the watcher and stop-hook courtesy do not grow another harness branch of their own.
 */
export const HARNESS_DESCRIPTORS = Object.freeze([
  Object.freeze({ name: "claude-code", sessionEnv: "CLAUDE_CODE_SESSION_ID", transcript: claudeTranscript, cacheTtl: claudeCacheTtl }),
  Object.freeze({ name: "codex", sessionEnv: "CODEX_SESSION_ID", transcript: codexTranscript, cacheTtl: codexCacheTtl }),
]);

/**
 * What every known harness's prompt-cache TTL is on this seat, derived at the call from settings
 * and environment only. Nothing is written and nothing is remembered between calls.
 * @param {NodeJS.ProcessEnv} env @param {string} cwd @param {string} [home]
 * @returns {Array<CacheTtl & { harness: string }>}
 */
export function cacheTtls(env, cwd, home = os.homedir()) {
  return HARNESS_DESCRIPTORS.map((d) => ({ harness: d.name, ...d.cacheTtl(env, cwd, home) }));
}

/**
 * Where this session's watch-mode sentinel lives, or null when the process is not
 * hosted by a known harness with a transcript on disk.
 * @param {NodeJS.ProcessEnv} env @param {string} cwd @param {string} [home]
 * @returns {WatchModeSentinel | null}
 */
export function watchModeSentinel(env, cwd, home = os.homedir()) {
  for (const descriptor of HARNESS_DESCRIPTORS) {
    const transcript = descriptor.transcript(env, cwd, home);
    if (!transcript) continue;
    const parsed = path.parse(transcript);
    return {
      harness: descriptor.name,
      dir: parsed.dir,
      transcript,
      sentinel: path.join(parsed.dir, `${parsed.name}.watch-mode`),
    };
  }
  return null;
}

/**
 * Identify the installed build without trusting a package manager or a process title. A git
 * worktree gives the strongest identity; an installed/copied entry point falls back to its mtime.
 * @param {{ version: string, root: string, entry: string, run?: typeof execFileAsync, fileStat?: typeof stat }} opts
 * @returns {Promise<BuildIdentity>}
 */
export async function installedBuild(opts) {
  const run = opts.run ?? execFileAsync;
  try {
    const result = await run("git", ["-C", opts.root, "show", "-s", "--format=%H%n%cI", "HEAD"], {
      windowsHide: true,
      maxBuffer: 64 * 1024,
    });
    const [git, at] = String(result.stdout).trim().split(/\r?\n/);
    if (/^[0-9a-f]{40}$/i.test(git) && !Number.isNaN(Date.parse(at)))
      return { version: opts.version, source: "git", git, at: new Date(at).toISOString() };
  } catch {
    // A copied package or release archive is not a worktree; its entry mtime is its build marker.
  }
  const info = await (opts.fileStat ?? stat)(opts.entry);
  return { version: opts.version, source: "mtime", at: info.mtime.toISOString() };
}

/** @param {BuildIdentity | undefined} build */
export function buildLabel(build) {
  if (!build) return "unknown";
  return build.git ? `${build.version}+${build.git.slice(0, 8)}` : `${build.version}+mtime:${build.at}`;
}

/** Is a resident's loaded build older than the installed build? Unknown is named separately.
 * @param {BuildIdentity | undefined} recorded @param {BuildIdentity} installed
 */
export function buildPredates(recorded, installed) {
  if (!recorded) return undefined;
  if (recorded.version === installed.version && recorded.git && recorded.git === installed.git) return false;
  const before = Date.parse(recorded.at);
  const now = Date.parse(installed.at);
  if (Number.isNaN(before) || Number.isNaN(now)) return undefined;
  return before < now || (before === now && (recorded.version !== installed.version || recorded.git !== installed.git));
}

/**
 * What the sentinel holds, or nothing when there is no readable one. A file written by an older
 * build holds a bare timestamp and no pid; that is an unowned sentinel, and the next watch adopts it.
 * @param {WatchModeSentinel | null} target
 * @returns {Promise<{ pid?: number, at?: string } | undefined>}
 */
export async function readWatchMode(target) {
  if (!target) return undefined;
  let raw;
  try {
    raw = await readFile(target.sentinel, "utf8");
  } catch {
    return undefined;
  }
  try {
    const rec = JSON.parse(raw);
    if (rec && typeof rec === "object")
      return { pid: typeof rec.pid === "number" ? rec.pid : undefined, at: typeof rec.at === "string" ? rec.at : undefined };
  } catch {
    /* an older bare-timestamp sentinel: present, unowned */
  }
  return { at: raw.trim() || undefined };
}

/**
 * Write or refresh the sentinel. `"created"` when this call brought it into being (the one time it
 * is worth announcing), `"refreshed"` when it was already there, false when there is no transcript
 * to sit beside (nothing is written).
 * @param {WatchModeSentinel | null} target @param {{ now?: Date, pid?: number }} [opts]
 * @returns {Promise<'created' | 'refreshed' | false>}
 */
export async function touchWatchMode(target, opts = {}) {
  if (!target || !existsSync(target.transcript)) return false;
  const me = opts.pid ?? process.pid;
  const held = await readWatchMode(target);
  // a live owner keeps the file; this watch only refreshes the timestamp under it
  const owner = held?.pid !== undefined && held.pid !== me && pidAlive(held.pid) ? held.pid : me;
  await writeFile(target.sentinel, JSON.stringify({ pid: owner, at: (opts.now ?? new Date()).toISOString() }) + "\n", "utf8");
  return held ? "refreshed" : "created";
}

/**
 * Remove the sentinel this process owns; absent is fine. One owned by another live watch is left
 * where it is and re-touched, so a short watch leaving does not un-suppress a resident one.
 * @param {WatchModeSentinel | null} target @param {{ now?: Date, pid?: number }} [opts]
 */
export async function clearWatchMode(target, opts = {}) {
  if (!target) return;
  const me = opts.pid ?? process.pid;
  const held = await readWatchMode(target);
  if (held?.pid !== undefined && held.pid !== me && pidAlive(held.pid)) {
    await writeFile(target.sentinel, JSON.stringify({ pid: held.pid, at: (opts.now ?? new Date()).toISOString() }) + "\n", "utf8");
    return;
  }
  await rm(target.sentinel, { force: true });
}

// ---------------------------------------------------------------------------------------------
// Is a stale build one this watch would actually notice?
//
// `buildPredates` answers "are you running the installed build", which is not the question a seat
// asks when it sees the warning. The question is whether any module this watch LOADED moved, and
// those are different: three library-only landings can leave a watch behind main while nothing it
// runs has changed, and one landing to a module the entry imports statically changes everything it
// runs without touching the file the seat thought to look at.
//
// Two rules govern everything below.
//
//   It is the IMPORT GRAPH, not the executed paths. A static `import` at the top of the entry
//   loads its module on every invocation, so a watch that never calls a verb still has that verb's
//   code resident. Asking what the process executes gives the wrong answer in the unsafe direction.
//
//   Every unknown WIDENS to owed; none narrows to inert. A wrong "no re-arm owed" leaves a seat
//   silently running stale code and is discovered by a defect; a wrong "owed" costs one re-arm.

/** A dynamic import whose specifier is a literal is resolvable; any other is not. */
const DYNAMIC_IMPORT = /\bimport\s*\(/g;
const DYNAMIC_LITERAL = /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
const FROM_SPEC = /\bfrom\s*["']([^"']+)["']/g;
const BARE_IMPORT = /(?:^|[;\n])\s*import\s*["']([^"']+)["']/g;
/** A `require` minted by `createRequire` loads outside the ESM graph, so it gets the same treatment
 * as a dynamic import: a literal specifier resolves and joins the closure, a computed one makes the
 * closure a non-superset. A blanket "any createRequire is unmeasurable" was the first shape of this
 * rule and it was wrong in the way that matters: the entry uses exactly one, with a literal
 * specifier, to read package.json — so the rule would have made the real closure permanently
 * incomplete, the inert state unreachable, and the whole measurement a warning that always fires
 * while appearing to have been measured. */
const REQUIRE_CALL = /(?<![.\w])require\s*\(/g;
const REQUIRE_LITERAL = /(?<![.\w])require\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
/**
 * Computed loads that provably cannot name a repository file, listed one by one with the reason and
 * the exact count.
 *
 * This is DATA a reader can audit, not a heuristic. It exists because the alternative is worse in a
 * specific way: the whole 53-file closure of the entry contains exactly one computed load, a chooser
 * between the builtins `bun:sqlite` and `node:sqlite`, and treating it as a hole makes the real
 * closure permanently unmeasurable — so every watch reports "unknown", forever, safely, uselessly,
 * and while appearing to have been measured. That is the failure this unit exists to remove.
 *
 * It fails CLOSED in both directions. A computed load in any file not listed here is a hole. A
 * SECOND computed load in a listed file exceeds its count and is a hole, so the exemption cannot
 * silently widen to cover a new one. And a listed file that no longer has that many is a stale
 * entry, which a cell catches rather than a reader having to notice.
 */
export const COMPUTED_LOAD_EXEMPTIONS = Object.freeze({
  "src/native-service.mjs": Object.freeze({
    imports: 1, requires: 0,
    why: "one dynamic import choosing between the builtins bun:sqlite and node:sqlite; neither is a path and neither can be a repository file",
  }),
});

/**
 * Every repository file reachable from `entry` by a static import, plus whether that set can be
 * trusted to be complete.
 *
 * Deliberately over-inclusive on what counts as a specifier (a path inside a comment or a string
 * would be followed): a superset keeps the answer on the safe side, and the only thing a false
 * member can do is report a re-arm that is not needed.
 *
 * @param {{ entry: string, root: string, read?: (file: string) => string }} opts
 * @returns {{ files: Set<string>, complete: boolean, reason?: string, caveats?: string[] }}
 */
export function importClosure(opts) {
  const read = opts.read ?? ((/** @type {string} */ file) => readFileSync(file, "utf8"));
  const root = path.resolve(opts.root);
  const entry = path.resolve(opts.entry);
  /** @type {Set<string>} */
  const files = new Set();
  /** @type {string[]} */
  const queue = [entry];
  let complete = true;
  /** @type {string | undefined} */
  let reason;
  /** Computed loads that provably cannot name a repository file. See `RELATIVE_LITERAL`. */
  /** @type {string[]} */
  const caveats = [];
  const incomplete = (/** @type {string} */ why) => { if (complete) { complete = false; reason = why; } };

  while (queue.length) {
    const file = /** @type {string} */ (queue.shift());
    const relative = path.relative(root, file);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      // Outside the repository (a ../ module, a symlink out of the tree). Dropping it would make
      // the closure a SUBSET, which is the one direction that can produce a false inert; no diff
      // of this repo can speak for it, so the whole answer becomes unknown.
      incomplete(`${file} is outside ${root}, so no diff of this repository can say whether it moved`);
      continue;
    }
    if (files.has(relative)) continue;
    /** @type {string} */
    let source;
    try { source = read(file); }
    catch { incomplete(`${relative} could not be read, so its own imports are unknown`); continue; }
    files.add(relative);

    // A load the static graph cannot resolve makes the whole closure a non-superset, which is the
    // one thing that must never be reported as inert. A load it CAN resolve simply joins it.
    // A computed specifier is a hole in the closure unless it is one of the counted, reasoned
    // exemptions above. Exceeding the count is a hole, so a new computed load never hides behind an
    // old exemption.
    const key = relative.split(path.sep).join("/");
    const exempt = /** @type {Record<string, { imports: number, requires: number, why: string }>} */
      (COMPUTED_LOAD_EXEMPTIONS)[key];
    const computed = (/** @type {string} */ label, /** @type {RegExp} */ all, /** @type {RegExp} */ literal, /** @type {number} */ allowed) => {
      const n = (source.match(all) ?? []).length - (source.match(literal) ?? []).length;
      if (n <= 0) return;
      if (n <= allowed) caveats.push(`${key}: ${n} ${label} with a computed specifier, exempt because ${/** @type {any} */ (exempt).why}`);
      else incomplete(`${key} has ${n} ${label} with a computed specifier and only ${allowed} exempted; the closure cannot be shown to be a superset of what it loads`);
    };
    computed("dynamic import call(s)", DYNAMIC_IMPORT, DYNAMIC_LITERAL, exempt?.imports ?? 0);
    computed("require call(s)", REQUIRE_CALL, REQUIRE_LITERAL, exempt?.requires ?? 0);

    for (const pattern of [FROM_SPEC, BARE_IMPORT, DYNAMIC_LITERAL, REQUIRE_LITERAL]) {
      pattern.lastIndex = 0;
      for (const match of source.matchAll(pattern)) {
        const spec = match[1];
        if (!spec || !spec.startsWith(".")) continue; // a builtin or a dependency, not in the repo
        const resolved = path.resolve(path.dirname(file), spec);
        if (existsSync(resolved)) queue.push(resolved);
      }
    }
  }
  return { files, complete, ...(reason ? { reason } : {}), ...(caveats.length ? { caveats } : {}) };
}

/**
 * @typedef {object} ModuleDelta
 * @property {"owed" | "inert" | "unknown"} state owed: something this watch loads moved, or the
 *   measurement could not be trusted to say otherwise. inert: measured, and nothing it loads moved.
 * @property {string[]} changed the repository files that moved AND are on the import graph
 * @property {number} [scanned] how many files changed between the two builds in all
 * @property {string} [reason] why the answer is unknown, in words a seat can act on
 * @property {string[]} [caveats] computed loads the closure judged unable to name a repository file
 */

/**
 * Did anything this watch loaded move between the build it armed on and the installed one?
 *
 * @param {{ root: string, entry: string, from: import('./harness.mjs').BuildIdentity | undefined,
 *  to: import('./harness.mjs').BuildIdentity, armedRoot?: string,
 *  run?: typeof execFileAsync, read?: (file: string) => string }} opts
 * @returns {Promise<ModuleDelta>}
 */
export async function watchModuleDelta(opts) {
  const run = opts.run ?? execFileAsync;
  const root = path.resolve(opts.root);
  const unknown = (/** @type {string} */ reason) => ({ state: /** @type {const} */ ("unknown"), changed: [], reason });

  // The record may name a DIFFERENT clone. Nothing in the shipped comparison checks this, and a
  // diff of this tree is not evidence about another copy — a watch armed as a bare `agora` can be
  // a global install entirely outside this checkout.
  if (opts.armedRoot === undefined)
    return unknown("this watch recorded no root, so which checkout it loaded is unknown; re-arm it once to make module freshness measurable");
  // By realpath, not by string: a worktree path and the shared checkout are genuinely different
  // roots and rightly unknown, but a symlinked same root must not read as different.
  const real = (/** @type {string} */ dir) => { try { return realpathSync(dir); } catch { return path.resolve(dir); } };
  if (real(opts.armedRoot) !== real(root))
    return unknown(`this watch loaded ${opts.armedRoot}, not ${root}; a diff of this checkout says nothing about another copy`);
  if (!opts.from?.git || !opts.to.git)
    return unknown("one of the two builds is stamped by file time rather than by a commit, so there is no diff to take");

  for (const sha of [opts.from.git, opts.to.git]) {
    try { await run("git", ["-C", root, "cat-file", "-e", `${sha}^{commit}`], { windowsHide: true, maxBuffer: 64 * 1024 }); }
    catch { return unknown(`commit ${sha.slice(0, 8)} is not in ${root}, so the change between the two builds cannot be read`); }
  }

  /** @type {string[]} */
  let changedFiles;
  try {
    // A non-zero exit is NOT an empty change list. Reading it as one is the exact shape that turns
    // a broken measurement into a confident "nothing moved".
    const result = await run("git", ["-C", root, "diff", "--name-only", opts.from.git, opts.to.git],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    changedFiles = String(result.stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch (e) {
    return unknown(`the change between the two builds could not be read (${e instanceof Error ? e.message : String(e)})`);
  }

  // A sha diff cannot see an UNCOMMITTED edit, and a watch loaded the working tree at arm time
  // while this process reads the working tree now. On a trunk that is dirty for hours — the normal
  // case on a shared checkout — a peer's uncommitted change to a module on the closure is exactly
  // the change a seat most needs to know about, and it is invisible to `git diff <sha> <sha>`.
  /** @type {string[]} */
  let dirtyFiles = [];
  try {
    const status = await run("git", ["-C", root, "status", "--porcelain", "--untracked-files=all"],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    dirtyFiles = String(status.stdout).split(/\r?\n/).map((line) => line.slice(3).trim())
      .filter(Boolean).map((line) => line.includes(" -> ") ? line.split(" -> ")[1] : line);
  } catch (e) {
    return unknown(`the working tree's state could not be read (${e instanceof Error ? e.message : String(e)}), and an uncommitted edit to a loaded module is invisible to a commit diff`);
  }

  const closure = importClosure({ entry: opts.entry, root, ...(opts.read ? { read: opts.read } : {}) });
  const onGraph = (/** @type {string} */ file) => closure.files.has(file.split("/").join(path.sep)) || closure.files.has(file);
  const changed = [...new Set([...changedFiles, ...dirtyFiles])].filter(onGraph);
  const scanned = new Set([...changedFiles, ...dirtyFiles]).size;
  if (!closure.complete && changed.length === 0)
    return { state: "unknown", changed: [], scanned,
      reason: `nothing on the measured import graph moved, but the graph is not provably complete: ${closure.reason}` };
  if (changed.length === 0) return { state: "inert", changed: [], scanned,
    ...(closure.caveats ? { caveats: closure.caveats } : {}) };
  return { state: "owed", changed, scanned };
}
