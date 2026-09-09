// @ts-check
import { execFile, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
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

/**
 * Where a thread's delivery marks live: an append-only JOURNAL, one line per mark, under the seat's
 * state.
 *
 * It is a journal rather than a document because the normal launcher shape arms several watch
 * processes against one thread and one state root. A read-modify-write of a whole file lets two of
 * them read the same rows, append different ones, and overwrite each other -- and the mark that
 * disappears is an ACCEPTANCE, so the record ends up reporting a delivery nobody attempted. It is
 * also worse than loss in practice: a reader that arrives mid-write parses a truncated file and
 * THROWS, inside the watch's delivery path. One line, one append, no read first.
 */
const intentsPath = (/** @type {string} */ root, /** @type {string} */ thread) =>
  path.join(root, "codex", `${thread}.intents.jsonl`);

/** @param {string} root @param {string} thread @param {Record<string, unknown>} mark */
async function appendCodexMark(root, thread, mark) {
  const file = intentsPath(root, thread);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(mark)}\n`, "utf8");
}

/**
 * Every delivery this bridge has accepted for a thread, oldest first.
 *
 * The record exists because acceptance and processing are different facts and only the first is
 * observable here. Reading it is how a re-arm distinguishes a delivery that is in flight from one
 * that was never sent -- a distinction the cursor alone cannot carry, because the cursor is written
 * after acceptance and a death between the two leaves it behind.
 * The queue path writes `acceptedAt` alone; the native server path writes `intentAt`, then
 * `acceptedAt` with its `turnId`, then `outcome` and `processedAt`. Every mark is optional because
 * a row is read at every stage of its life, including the stage where almost nothing is known yet.
 * @param {string} root @param {string} thread
 * @returns {Promise<{ id: string, cursor: string, room: string, acceptedAt?: string | null,
 *   intentAt?: string | null, turnId?: string, processedAt?: string | null,
 *   outcome?: 'completed'|'cancelled'|'failed'|'closed-without-completion',
 *   resolution?: string }[]>}
 */
export async function readCodexIntents(root, thread) {
  let raw;
  try { raw = await readFile(intentsPath(root, thread), "utf8"); }
  catch (error) {
    // A missing file is an empty history. Anything else is a real read failure and must not be
    // laundered into "nothing was ever accepted", which is the shape that turns a broken disk into
    // a clean slate and replays or drops a whole backlog without saying so.
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code === "ENOENT") return [];
    throw error;
  }
  // Project the journal: fold each mark onto its row, in recorded order. First appearance fixes a
  // row's position, which is what the longest-completed-prefix advance reads.
  /** @type {Map<string, any>} */
  const rows = new Map();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let mark;
    // A corrupt line fails loudly for the same reason a read error does: skipping it would turn a
    // damaged journal into a shorter history that looks complete.
    try { mark = JSON.parse(line); }
    catch { throw new AgoraError(`Codex delivery journal for thread ${thread} has an unreadable line`, EXIT.error); }
    const row = rows.get(mark.id) ?? { id: mark.id, cursor: mark.cursor, room: mark.room, processedAt: null };
    for (const [key, value] of Object.entries(mark)) {
      if (key === "type" || value === undefined) continue;
      // An earlier mark of the same kind wins: a replayed submission must not move the original
      // intent's clock, and a re-acknowledged turn must not restate its acceptance time.
      if ((key === "intentAt" || key === "acceptedAt") && row[key]) continue;
      row[key] = value;
    }
    rows.set(mark.id, row);
  }
  return [...rows.values()];
}

/** @param {string} root @param {string} thread @param {import('./core.mjs').Message} message */
async function recordCodexIntent(root, thread, message) {
  // Idempotent by message id: a retried delivery of the same id is the same acceptance, not a second
  // one. The id is the idempotence point above the transport, so it is the key here too, and the
  // projection keeps the FIRST acceptedAt for exactly that reason -- no read is needed to enforce it.
  await appendCodexMark(root, thread, { type: "accepted", id: message.id, cursor: message.cursor,
    room: message.room, acceptedAt: new Date().toISOString() });
}

// The native server path carries THREE marks, because three different things happen and no one word
// covers them. The queue path above keeps `acceptedAt` alone, and rightly: there, the queue call
// returning success IS the queue's acceptance, and nothing further is observable.

/** We handed this message to the emitter. Nothing has acknowledged anything yet -- this is an
 * INTENT, not an acceptance. It exists so that a turn running to the processed timeout leaves a
 * durable row while it runs, instead of a window in which a death leaves no record at all.
 * @param {string} root @param {string} thread @param {import('./core.mjs').Message} message */
export async function recordCodexSubmitted(root, thread, message) {
  await appendCodexMark(root, thread, { type: "intent", id: message.id, cursor: message.cursor,
    room: message.room, intentAt: new Date().toISOString() });
}

/** turn/start returned an id: the server holds the work. Distinct from the intent before it and from
 * the outcome after it, and it is the state a reader needs to tell a RUNNING turn from a finished one.
 * @param {string} root @param {string} thread
 * @param {import('./core.mjs').Message} message @param {{turnId: string}} ack */
export async function recordCodexAccepted(root, thread, message, ack) {
  await appendCodexMark(root, thread, { type: "accepted", id: message.id, cursor: message.cursor,
    room: message.room, acceptedAt: new Date().toISOString(), turnId: ack.turnId });
}

/** The consumer's own word about its own work. `processedAt` is set ONLY on `completed`: a cancelled,
 * failed or closed-without-completion turn reached the consumer and did not finish, and stamping it
 * processed would launder an interruption into a completion.
 * @param {string} root @param {string} thread @param {import('./core.mjs').Message} message
 * @param {{id: string, outcome: 'completed'|'cancelled'|'failed'|'closed-without-completion'}} receipt */
export async function recordCodexReceipt(root, thread, message, receipt) {
  await appendCodexMark(root, thread, { type: "receipt", id: message.id, cursor: message.cursor,
    room: message.room, outcome: receipt.outcome,
    ...(receipt.outcome === "completed" ? { processedAt: new Date().toISOString() } : {}) });
}

/**
 * Fold the delivery records against the queue's own pending list and any consumer witness on them.
 *
 * On a queue-only thread this is the closest thing to a second receipt a one-signal bridge has, and
 * it is deliberately not called one. An item the queue STILL LISTS demonstrably has not been
 * consumed: that is in-flight, and re-queueing it would duplicate rather than recover. An item that
 * is GONE is processed-OR-REMOVED -- consumed by the far side, or deleted by a purge, an expiry, or
 * an operator clearing a stale backlog, and nothing visible from there separates those. Advancing on
 * absence would turn a deletion into a completion receipt, which is the silent loss this unit exists
 * to close, so absence is RETAINED and surfaced instead.
 *
 * `processed` and `advanceTo` come only from a real consumer witness, which the native server path
 * supplies and the queue path cannot. On a thread with no witness they stay empty and null exactly
 * as before.
 * @param {{ root: string, thread: string, room?: string,
 *   list?: () => Promise<{ id: string }[]> }} opts
 * @returns {Promise<{ rows: any[], inFlight: any[], unresolved: any[], absent: any[],
 *   unacknowledged: any[], unwitnessedCompletion: any[], processed: any[], advanceTo: string | null }>}
 */
export async function reconcileCodexIntents({ root, thread, room, list }) {
  const all = await readCodexIntents(root, thread);
  // One Codex thread receives deliveries from every room this seat watches, so one journal holds
  // rows from several rooms. Scope first: a row from another room answers no question about this one.
  const intents = room ? all.filter((/** @type {any} */ i) => i.room === room) : all;
  const open = intents.filter((/** @type {any} */ i) => !i.processedAt);
  // A row the consumer has spoken about is never "absent". Absence is what this bridge says when it
  // does NOT know what happened; an outcome is knowing, even when the outcome is a failure.
  const unwitnessed = open.filter((/** @type {any} */ i) => !i.outcome);
  /** @type {any[]} */ let inFlight;
  /** @type {any[]} */ let absent;
  if (list) {
    const pending = new Set((await list()).map((/** @type {any} */ entry) => entry.id));
    inFlight = unwitnessed.filter((/** @type {any} */ i) => pending.has(i.id));
    absent = unwitnessed.filter((/** @type {any} */ i) => !pending.has(i.id));
  } else {
    // No queue listing was offered and none is invented. Without one, NOTHING is observed pending:
    // an acknowledged row with no terminal mark proves only that no outcome was recorded, and on the
    // legacy queue that item may already have been consumed or cleared by a hand. Calling it
    // in-flight would assert a live delivery from the absence of a record, which is the same
    // inference the second receipt exists to refuse.
    inFlight = [];
    absent = unwitnessed.filter((/** @type {any} */ i) => i.resolution === "absent");
  }
  // Acknowledged, WITNESSED, and the witness was not a completion. It has an outcome, so it is not
  // unwitnessed and falls out of every category above; it has no processedAt, so it is not processed
  // either. Before the checkpoint moved to the acknowledgment this state was rare enough that landing
  // in no bucket went unnoticed; now it is what an ordinary delivery looks like whenever the outcome
  // has not arrived by the time the connection closes, so a row here would otherwise be recorded and
  // reported to nobody. Named for what is missing: the completion was never witnessed.
  const unwitnessedCompletion = intents.filter(
    (/** @type {any} */ i) => !i.processedAt && i.outcome && i.outcome !== "completed");
  // Inferred from the marks, never observed: acknowledged, no terminal, no recorded absence.
  const unresolved = list ? [] : unwitnessed.filter(
    (/** @type {any} */ i) => i.acceptedAt && i.resolution !== "absent");
  const unacknowledged = unwitnessed.filter(
    (/** @type {any} */ i) => !i.acceptedAt && i.resolution !== "absent");
  for (const intent of absent) {
    // Already recorded on an earlier reconcile: appending again would grow the journal on every poll
    // and say nothing new.
    if (intent.resolution === "absent") continue;
    intent.resolution = "absent";
    await appendCodexMark(root, thread, { type: "resolution", id: intent.id, resolution: "absent" });
  }
  const processed = intents.filter((/** @type {any} */ i) => i.processedAt);
  // The advance is the longest COMPLETED PREFIX in recorded order. Stopping at the first gap is the
  // whole point: a later completion must never carry the cursor past an earlier delivery that
  // failed, because that retires the failed one with a receipt saying it succeeded.
  // The advance is a cursor, and a cursor is a coordinate in ONE room: opaque, and ascending only
  // within it. With no room named there is no coordinate system to advance in, so none is produced
  // -- handing back the last completed row would give one room a position minted in another.
  let advanceTo = null;
  if (room) for (const intent of intents) {
    if (!intent.processedAt) break;
    advanceTo = intent.cursor;
  }
  // `rows` is this room's marks in recorded order. A caller cannot compare two opaque cursors,
  // so the only way to know whether a target is FORWARD of the saved position is to find both
  // in this sequence. Handing back the sequence is what makes a guarded checkpoint possible.
  return { rows: intents, inFlight, unresolved, absent, unacknowledged, unwitnessedCompletion, processed, advanceTo };
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
