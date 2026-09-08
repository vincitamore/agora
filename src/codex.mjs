// @ts-check
import { execFile, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { AgoraError, EXIT } from "./core.mjs";

const execFileAsync = promisify(execFile);
const CODEX_THREAD_RE = /^[A-Za-z0-9-]{8,128}$/;

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

/** @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env */
export function codexHome(env = process.env) {
  return path.resolve(env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex"));
}

/** Find the durable rollout for one task/thread id.
 * @param {string} thread @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 */
export function codexRollout(thread, env = process.env) {
  if (!CODEX_THREAD_RE.test(thread)) return undefined;
  return findFile(path.join(codexHome(env), "sessions"), (file) => {
    const name = path.basename(file);
    return name.startsWith("rollout-") && name.endsWith(`-${thread}.jsonl`);
  });
}

/**
 * Ask the OS whether Codex still holds its writer lock. The file is empty and names no pid, so
 * existence alone fails open after a crash. Windows exposes the held byte-range lock as EBUSY on
 * read; Linux's `flock -n` probes the advisory lock without disturbing it; macOS's system `lsof`
 * proves that some process still owns an open descriptor for the per-thread marker. An unavailable
 * probe is honestly unknown, never asserted live.
 * @param {string} lock @param {{ platform?: NodeJS.Platform, read?: typeof readFileSync, run?: typeof spawnSync }} [deps]
 * @returns {'active' | 'stale' | 'unknown'}
 */
export function probeCodexWriterLock(lock, deps = {}) {
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") {
    try {
      (deps.read ?? readFileSync)(lock);
      return "stale";
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      // A held Win32 byte-range lock is EBUSY. Permission errors say only that this
      // process cannot inspect the file; they are not evidence that Codex holds it.
      return code === "EBUSY" ? "active" : "unknown";
    }
  }
  if (platform === "linux") {
    const result = (deps.run ?? spawnSync)("flock", ["-n", lock, "true"], { stdio: "ignore" });
    if (result.status === 0) return "stale";
    if (result.status === 1) return "active";
  }
  if (platform === "darwin") {
    const result = (deps.run ?? spawnSync)("/usr/sbin/lsof", ["-F", "p", "--", lock], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status === 0 && /^p\d+$/m.test(String(result.stdout ?? ""))) return "active";
    if (result.status === 1 && !result.error) return "stale";
  }
  return "unknown";
}

/**
 * Is a local Codex task addressable now? Codex's thread store holds one per-thread writer lock for
 * the life of the writer, removes it on guard drop, and sweeps stale files on the next acquire.
 * Requiring the rollout as well keeps an orphan lock from being mistaken for a task.
 * @param {string} thread
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @param {{ exists?: (file: string) => boolean, rollout?: (thread: string, env: NodeJS.ProcessEnv | Record<string, string | undefined>) => string | undefined, probe?: (lock: string) => 'active' | 'stale' | 'unknown' }} [deps]
 */
export function codexLiveness(thread, env = process.env, deps = {}) {
  if (!CODEX_THREAD_RE.test(thread)) return { state: "gone", reason: `Codex thread id ${JSON.stringify(thread)} is not a valid local thread id` };
  const rollout = (deps.rollout ?? codexRollout)(thread, env);
  if (!rollout) return { state: "gone", reason: `Codex thread ${thread} has no rollout under ${path.join(codexHome(env), "sessions")}` };
  const lock = path.join(codexHome(env), "thread-writer-locks", `${thread}.lock`);
  if (!(deps.exists ?? existsSync)(lock)) return { state: "gone", reason: `Codex thread ${thread} has no writer lock at ${lock}` };
  const held = (deps.probe ?? probeCodexWriterLock)(lock);
  if (held === "stale") return { state: "gone", reason: `Codex thread ${thread} left a stale writer lock at ${lock}` };
  if (held === "unknown") return { state: "unknown", reason: `Codex thread ${thread} has a writer marker at ${lock}, but this platform cannot prove that it is still held`, rollout, lock };
  return { state: "live", rollout, lock };
}

/**
 * The Codex task that owns this process. Newer CLI and Desktop builds expose both names; prefer
 * the one whose meaning is exact and retain CODEX_SESSION_ID for builds that expose only it.
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 */
export function codexThread(env = process.env) {
  return env.CODEX_THREAD_ID?.trim() || env.CODEX_SESSION_ID?.trim();
}

/**
 * A spawned Codex thread shares the seat session but is not its posting bearer. Keep this a warning:
 * callers may intentionally assign a spawned thread its own bearer and explicit Agora session.
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 */
export function codexSpawnWarning(env = process.env) {
  const thread = env.CODEX_THREAD_ID?.trim();
  const session = env.CODEX_SESSION_ID?.trim();
  if (!thread || !session || thread === session) return undefined;
  return "this process is a spawned Codex thread of the seat session; only the session holding the seat should post, and the parent's watch will not see this thread's posted-id ledger";
}

/** @param {string | undefined} raw @param {string} delimiter */
function pathEntries(raw, delimiter) {
  return (raw ?? "").split(delimiter).map((p) => p.trim().replace(/^"|"$/g, "")).filter(Boolean);
}

/** @param {unknown} parsed */
function doctorExecutable(parsed) {
  if (!parsed || typeof parsed !== "object") return undefined;
  const checks = /** @type {{ checks?: Record<string, { details?: Record<string, unknown> }> }} */ (parsed).checks;
  const details = checks?.["runtime.provenance"]?.details ?? checks?.installation?.details;
  const executable = details?.["current executable"];
  return typeof executable === "string" ? executable : undefined;
}

/**
 * Resolve the native Codex executable without putting room text through a shell. On Windows the
 * npm command is normally a `.cmd` shim, while `execFile` needs the vendored `.exe` behind it.
 * @param {{
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
 *   bin?: string,
 *   platform?: NodeJS.Platform,
 *   exists?: (file: string) => boolean,
 *   run?: typeof execFileAsync,
 * }} [opts]
 */
export async function resolveCodexBinary(opts = {}) {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const exists = opts.exists ?? existsSync;
  const run = opts.run ?? execFileAsync;
  const explicit = opts.bin?.trim() || env.AGORA_CODEX_BIN?.trim();
  if (explicit) {
    const file = path.resolve(explicit);
    if (!exists(file)) throw new AgoraError(`Codex executable not found at ${file}`, EXIT.usage);
    return file;
  }

  if (platform === "win32") {
    try {
      const found = await run("where.exe", ["codex.exe"], { windowsHide: true, env: /** @type {NodeJS.ProcessEnv} */ (env) });
      for (const line of String(found.stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean))
        if (exists(line)) return path.resolve(line);
    } catch {
      // The npm shim is commonly on PATH without the native executable; continue to the package.
    }
  }

  const delimiter = platform === "win32" ? ";" : ":";
  const dirs = pathEntries(env.PATH, delimiter);
  if (platform === "win32" && env.ProgramFiles) dirs.push(path.join(env.ProgramFiles, "nodejs"));
  if (platform === "win32" && env.APPDATA) dirs.push(path.join(env.APPDATA, "npm"));
  for (const dir of [...new Set(dirs)]) {
    const candidate = path.join(dir, platform === "win32" ? "codex.exe" : "codex");
    if (exists(candidate)) return path.resolve(candidate);
  }

  if (platform === "win32") {
    for (const dir of [...new Set(dirs)]) {
      const node = path.join(dir, "node.exe");
      const cli = path.join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
      if (!exists(node) || !exists(cli)) continue;
      try {
        const result = await run(node, [cli, "doctor", "--json"], {
          windowsHide: true,
          env: /** @type {NodeJS.ProcessEnv} */ (env),
          maxBuffer: 4 * 1024 * 1024,
        });
        const executable = doctorExecutable(JSON.parse(String(result.stdout)));
        if (executable && exists(executable)) return path.resolve(executable);
      } catch {
        // A doctor from an old CLI may lack JSON; try the known package layout below.
      }

      const vendored = path.join(
        dir,
        "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-x64",
        "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe",
      );
      if (exists(vendored)) return path.resolve(vendored);
    }
  }

  throw new AgoraError("could not resolve the Codex executable; pass --codex-bin or set AGORA_CODEX_BIN", EXIT.usage);
}

/**
 * Render a room delivery as a queued Codex user turn. The envelope is intentionally small: Agora's
 * original text remains byte-for-byte present, while origin and cursor stay visible for protocol
 * decisions and replies.
 * @param {string} room
 * @param {import('./core.mjs').Message} message
 */
export function codexPrompt(room, message) {
  const from = message.signedAs ?? message.author.name;
  const attachments = message.attachments?.length
    ? `\n\n[Agora attachments]\n${message.attachments.map((a) => `- ${a.kind} ${JSON.stringify(a.name)}${a.mimetype ? ` (${a.mimetype}${a.size !== undefined ? `, ${a.size} bytes` : ""})` : a.size !== undefined ? ` (${a.size} bytes)` : ""}${a.path ? `; local path ${JSON.stringify(a.path)}` : ""}${a.error ? `; ${a.error}` : ""}`).join("\n")}`
    : "";
  return `[Agora delivery; room ${room}; cursor ${message.cursor}; from ${from}]\n` +
    `[Codex no-op policy: only when this turn needs no tool call, state change, claim, or maintenance capture, append <!-- agora:no-maintenance --> to the final reply; otherwise omit it.]\n` +
    message.text + attachments;
}

/**
 * Queue every delivered room message into the current Codex task, in room order. `run` is
 * injectable so the command boundary is testable without a live Codex task.
 * @param {string} room
 * @param {import('./core.mjs').Message[]} messages
 * @param {{
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
 *   run?: typeof execFileAsync,
 *   bin?: string,
 *   thread?: string,
 *   timeoutMs?: number,
 *   attempts?: number,
 *   signal?: AbortSignal,
 *   sleep?: (ms: number, signal?: AbortSignal) => Promise<void>,
 *   onRetry?: (failure: { room: string, cursor: string, thread: string, attempt: number, attempts: number, delayMs: number, reason: string }) => void,
 *   onQueued?: (delivery: { thread: string, cursor: string, bin: string, message: import('./core.mjs').Message }) => void | Promise<void>,
 *   root?: string,
 * }} [opts]
 *
 * `root` is the seat's state root and it is what turns acceptance into a DURABLE receipt: given it,
 * each accepted delivery is recorded under `<root>/codex/<thread>.intents.json` before control
 * reaches `onQueued`. Without it the call behaves exactly as it always did -- the queue is still
 * called, the caller is still told -- but nothing survives a death between the two, so a re-arm
 * replays blind. Production callers pass it; a caller that does not is choosing at-least-once with
 * no reconciliation, and should know that is the choice it made.
 */
export async function queueCodex(room, messages, opts = {}) {
  const env = opts.env ?? process.env;
  const thread = opts.thread?.trim() || env.AGORA_CODEX_THREAD?.trim() || codexThread(env);
  if (!thread)
    throw new AgoraError(`--codex-queue needs --codex-thread, AGORA_CODEX_THREAD, CODEX_THREAD_ID, or CODEX_SESSION_ID`, EXIT.usage);
  const bin = await resolveCodexBinary({ env, bin: opts.bin });
  const run = opts.run ?? execFileAsync;
  const timeout = opts.timeoutMs ?? 30_000;
  const attempts = opts.attempts ?? 3;
  if (!Number.isFinite(timeout) || timeout <= 0 || !Number.isInteger(attempts) || attempts < 1 || attempts > 5)
    throw new AgoraError("Codex queue timeout must be positive and attempts an integer from 1 to 5", EXIT.usage);
  const sleep = opts.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }));
  for (const message of messages) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        opts.signal?.throwIfAborted();
        await run(bin, ["queue", "--thread", thread, "--message", codexPrompt(room, message)], {
          windowsHide: true,
          env: /** @type {NodeJS.ProcessEnv} */ (env),
          timeout,
          killSignal: "SIGKILL",
          signal: opts.signal,
        });
        break;
      } catch (error) {
        // execFile's message includes the complete argv (the private room body). Report only
        // bounded failure metadata, never echo the queued prompt or raw subprocess diagnostics.
        const err = /** @type {NodeJS.ErrnoException & { signal?: string, stderr?: string }} */ (error ?? {});
        const reason = opts.signal?.aborted ? "cancelled" : err.signal ? `terminated (${err.signal}; timeout ${timeout}ms)`
          : `queue failed (${typeof err.code === "number" ? `exit ${err.code}` : ["ENOENT", "EACCES", "EPERM"].includes(String(err.code)) ? err.code : "execution error"})`;
        const permanent = opts.signal?.aborted || ["ENOENT", "EACCES", "EPERM"].includes(String(err.code));
        if (permanent || attempt === attempts)
          throw new AgoraError(`could not queue delivery ${room}/${message.cursor} into Codex task ${thread} after ${attempt} attempt(s): ${reason}; acceptance unknown, cursor not acknowledged; inspect the queue before re-arming to replay the pending suffix`, EXIT.error);
        const failure = { room, cursor: message.cursor, thread, attempt, attempts, delayMs: 1000 * 2 ** (attempt - 1), reason };
        if (opts.onRetry) opts.onRetry(failure);
        else console.error(`agora: ${JSON.stringify({ type: "codex-queue-retry", ...failure, acceptance: "unknown" })}`);
        try { await sleep(failure.delayMs, opts.signal); }
        catch { throw new AgoraError(`Codex queue retry cancelled for ${room}/${message.cursor}; cursor not acknowledged`, EXIT.error); }
      }
    }
    // The ACCEPTED receipt, durable, BEFORE control reaches the caller. This is the one receipt a
    // queued bridge can honestly have: the queue took the item. Whether the consumer ever ran is a
    // fact about the consumer and no callback here reports it.
    //
    // It is written before `onQueued` on purpose. The caller advances its cursor in that callback,
    // so a death between the two would otherwise leave nothing at all: not the cursor (never
    // written) and not a record of the delivery (never kept), so a re-arm replays blind with no way
    // to tell an in-flight item from one that was never sent.
    if (opts.root) await recordCodexIntent(opts.root, thread, message);
    // A checkpoint failure is NOT a queue failure: the effect already happened. Never retry
    // injection here; leaving the cursor behind exposes the existing at-least-once replay window.
    await opts.onQueued?.({ thread, cursor: message.cursor, bin, message });
  }
}

/** Where a thread's accepted-delivery records live. One file per thread, under the seat's state. */
const intentsPath = (/** @type {string} */ root, /** @type {string} */ thread) =>
  path.join(root, "codex", `${thread}.intents.json`);

/**
 * Every delivery this bridge has accepted for a thread, oldest first.
 *
 * The record exists because acceptance and processing are different facts and only the first is
 * observable here. Reading it is how a re-arm distinguishes a delivery that is in flight from one
 * that was never sent -- a distinction the cursor alone cannot carry, because the cursor is written
 * after acceptance and a death between the two leaves it behind.
 * @param {string} root @param {string} thread
 * @returns {Promise<{ id: string, cursor: string, room: string, acceptedAt: string,
 *   processedAt?: string | null, resolution?: string }[]>}
 */
export async function readCodexIntents(root, thread) {
  try { return JSON.parse(await readFile(intentsPath(root, thread), "utf8")); }
  catch (error) {
    // A missing file is an empty history. Anything else is a real read failure and must not be
    // laundered into "nothing was ever accepted", which is the shape that turns a broken disk into
    // a clean slate and replays or drops a whole backlog without saying so.
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code === "ENOENT") return [];
    throw error;
  }
}

/** @param {string} root @param {string} thread @param {import('./core.mjs').Message} message */
async function recordCodexIntent(root, thread, message) {
  const file = intentsPath(root, thread);
  await mkdir(path.dirname(file), { recursive: true });
  const intents = await readCodexIntents(root, thread);
  // Idempotent by message id: a retried delivery of the same id is the same acceptance, not a second
  // one. The id is the idempotence point above the transport, so it is the key here too.
  if (!intents.some((i) => i.id === message.id))
    intents.push({ id: message.id, cursor: message.cursor, room: message.room,
      acceptedAt: new Date().toISOString(), processedAt: null });
  await writeFile(file, `${JSON.stringify(intents, null, 2)}\n`, "utf8");
}

/**
 * Fold the accepted records against the queue's own pending list.
 *
 * This is the closest thing to a second receipt a one-signal bridge has, and it is deliberately not
 * called one. An item the queue STILL LISTS demonstrably has not been consumed: that is in-flight,
 * and re-queueing it would duplicate rather than recover. An item that is GONE is
 * processed-OR-REMOVED -- consumed by the far side, or deleted by a purge, an expiry, or an operator
 * clearing a stale backlog, and nothing visible from here separates those.
 *
 * So `processed` is always empty on this bridge and `advanceTo` is always null. Advancing a cursor
 * on absence would turn a deletion into a completion receipt, which is the silent loss this whole
 * unit exists to close; the honest output is accepted / in-flight / absent, with absent RETAINED so
 * a human can see it happened. A processed witness has to come from the consumer's own lifecycle,
 * which is the native path's to supply.
 * @param {{ root: string, thread: string, list: () => Promise<{ id: string }[]> }} opts
 * @returns {Promise<{ inFlight: any[], absent: any[], processed: any[], advanceTo: string | null }>}
 */
export async function reconcileCodexIntents({ root, thread, list }) {
  const intents = await readCodexIntents(root, thread);
  const pending = new Set((await list()).map((entry) => entry.id));
  const open = intents.filter((i) => !i.processedAt);
  const inFlight = open.filter((i) => pending.has(i.id));
  const absent = open.filter((i) => !pending.has(i.id));
  for (const intent of absent) intent.resolution = "absent";
  if (absent.length)
    await writeFile(intentsPath(root, thread), `${JSON.stringify(intents, null, 2)}\n`, "utf8");
  return { inFlight, absent, processed: [], advanceTo: null };
}

/**
 * A watch armed under a Codex session with no delivery bridge delivers to nobody: Codex does not
 * treat terminal output as a wake, so the process polls, prints, advances the cursor, and the
 * task never hears a word. That mistake was made twice in one day by copying a Claude Code watch
 * form onto Codex seats, and it was silent both times. So it is refused here, before any config
 * is read, with the one-line fixes; `--print-only` says a printing watch is wanted on purpose.
 * Returns the refusal text, or undefined when the watch may arm.
 * @param {{ "codex-queue"?: unknown, "codex-server"?: unknown, "codex-token-file"?: unknown, "print-only"?: unknown }} values
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 */
export function codexBridgeRefusal(values, env = process.env) {
  const thread = codexThread(env);
  if (!thread) return undefined;
  if (values["codex-queue"] || values["codex-server"] || values["codex-token-file"] || values["print-only"]) return undefined;
  const source = env.CODEX_THREAD_ID?.trim() ? "CODEX_THREAD_ID" : "CODEX_SESSION_ID";
  return `this watch runs under a Codex session (${source} is set) with no delivery bridge; Codex does not treat terminal output as a wake, so a printing watch delivers to nobody. Add --codex-queue (or arm through scripts/start-codex-watch.sh / start-codex-watch.ps1), or --codex-server <ws://127.0.0.1:PORT> --codex-token-file <absolute path> for the native input path; --print-only arms a printing watch on purpose`;
}
