// @ts-check
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
