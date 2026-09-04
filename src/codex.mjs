// @ts-check
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { AgoraError, EXIT } from "./core.mjs";

const execFileAsync = promisify(execFile);

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
  return `[Agora delivery; room ${room}; cursor ${message.cursor}; from ${from}]\n` +
    `[Codex no-op policy: only when this turn needs no tool call, state change, claim, or maintenance capture, append <!-- agora:no-maintenance --> to the final reply; otherwise omit it.]\n` +
    message.text;
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
 *   onQueued?: (delivery: { thread: string, cursor: string, bin: string }) => void,
 * }} [opts]
 */
export async function queueCodex(room, messages, opts = {}) {
  const env = opts.env ?? process.env;
  const thread = opts.thread?.trim() || env.AGORA_CODEX_THREAD?.trim() || codexThread(env);
  if (!thread)
    throw new AgoraError(`--codex-queue needs --codex-thread, AGORA_CODEX_THREAD, CODEX_THREAD_ID, or CODEX_SESSION_ID`, EXIT.usage);
  const bin = await resolveCodexBinary({ env, bin: opts.bin });
  const run = opts.run ?? execFileAsync;
  for (const message of messages) {
    try {
      await run(bin, ["queue", "--thread", thread, "--message", codexPrompt(room, message)], {
        windowsHide: true,
        env: /** @type {NodeJS.ProcessEnv} */ (env),
      });
      opts.onQueued?.({ thread, cursor: message.cursor, bin });
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      throw new AgoraError(`could not queue delivery into Codex task ${thread}: ${why}`, EXIT.error);
    }
  }
}
