// @ts-check
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Harness-side courtesies a long-lived watch owes the session that hosts it.
 *
 * Claude Code runs a stop hook at the end of every turn, and a persistent watch
 * turns every delivery into a turn: without a signal, a maintenance checklist
 * fires after each message and the agent spends a turn answering it, for hours.
 * The hook honours a session-scoped sentinel beside the session transcript,
 * `<transcript minus extension>.watch-mode`, and treats it as stale after 12 h.
 * A watch touches it while it runs and removes it when it stops, so the
 * suppression exists exactly as long as the watch does and is never a thing a
 * session has to remember to arm or to clear.
 *
 * The transcript lives at `~/.claude/projects/<slug of the project root>/<session id>.jsonl`,
 * the slug being the path with every character outside [A-Za-z0-9] replaced by
 * `-`; the project root is the nearest ancestor of cwd that holds it. The sentinel is written only when that transcript exists: a wrong slug
 * or a foreign harness gets nothing, never a stray file.
 */

const SESSION_ID = /^[A-Za-z0-9-]{8,128}$/;

/** @typedef {{ dir: string, transcript: string, sentinel: string }} WatchModeSentinel */

/** Claude Code's project directory name for a working directory. @param {string} cwd */
export function claudeProjectSlug(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * Where this session's watch-mode sentinel lives, or null when the process is not
 * hosted by Claude Code.
 * @param {NodeJS.ProcessEnv} env @param {string} cwd @param {string} [home]
 * @returns {WatchModeSentinel | null}
 */
export function watchModeSentinel(env, cwd, home = os.homedir()) {
  const id = env.CLAUDE_CODE_SESSION_ID;
  if (!id || !SESSION_ID.test(id)) return null;
  // The transcript is filed under the project the session was started in, and a
  // watch is usually armed from a subdirectory of it (a repo inside the tree, a
  // worktree). Walk up from cwd and take the first ancestor that has this
  // session's transcript; with none found, fall back to cwd so touch writes nothing.
  const candidates = [];
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    candidates.push(dir);
    if (path.dirname(dir) === dir) break;
  }
  const targets = candidates.map((root) => {
    const dir = path.join(home, ".claude", "projects", claudeProjectSlug(root));
    return { dir, transcript: path.join(dir, `${id}.jsonl`), sentinel: path.join(dir, `${id}.watch-mode`) };
  });
  return targets.find((t) => existsSync(t.transcript)) ?? targets[0];
}

/**
 * Write or refresh the sentinel. Returns false when there is no transcript to sit
 * beside (nothing is written).
 * @param {WatchModeSentinel | null} target @param {{ now?: Date }} [opts]
 */
export async function touchWatchMode(target, opts = {}) {
  if (!target || !existsSync(target.transcript)) return false;
  await writeFile(target.sentinel, `${(opts.now ?? new Date()).toISOString()}\n`, "utf8");
  return true;
}

/** Remove the sentinel; absent is fine. @param {WatchModeSentinel | null} target */
export async function clearWatchMode(target) {
  if (!target) return;
  await rm(target.sentinel, { force: true });
}
