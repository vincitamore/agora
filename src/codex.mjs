// @ts-check
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AgoraError, EXIT } from "./core.mjs";

const execFileAsync = promisify(execFile);

/**
 * The Codex Desktop task that owns this process. Newer Desktop builds expose both names; prefer
 * the one whose meaning is exact and retain CODEX_SESSION_ID for builds that expose only it.
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 */
export function codexThread(env = process.env) {
  return env.CODEX_THREAD_ID?.trim() || env.CODEX_SESSION_ID?.trim();
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
 * Queue every delivered room message into the current Codex Desktop task, in room order. `run` is
 * injectable so the command boundary is testable without a live app-server daemon.
 * @param {string} room
 * @param {import('./core.mjs').Message[]} messages
 * @param {{ env?: NodeJS.ProcessEnv | Record<string, string | undefined>, run?: typeof execFileAsync }} [opts]
 */
export async function queueCodex(room, messages, opts = {}) {
  const env = opts.env ?? process.env;
  const thread = codexThread(env);
  if (!thread)
    throw new AgoraError(`--codex-queue needs CODEX_THREAD_ID or CODEX_SESSION_ID from a Codex Desktop task`, EXIT.usage);
  const run = opts.run ?? execFileAsync;
  for (const message of messages) {
    try {
      await run("codex", ["queue", "--thread", thread, "--message", codexPrompt(room, message)], {
        windowsHide: true,
        env: /** @type {NodeJS.ProcessEnv} */ (env),
      });
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      throw new AgoraError(`could not queue delivery into Codex task ${thread}: ${why}`, EXIT.error);
    }
  }
}
