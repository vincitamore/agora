// @ts-check
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pidAlive } from "./session.mjs";

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
 * The file is one per Claude Code SESSION and a session may run several watches at
 * once, so it carries the pid of the watch that owns it: a 140 ms `--once` watch
 * inside a session hosting a resident stream must not delete the stream's
 * suppression on its way out. A watch clears the sentinel only when the recorded pid
 * is its own; otherwise it leaves the file and refreshes its timestamp, so the owner
 * keeps its suppression and the hook's staleness rule still reaps an abandoned one.
 * A watch whose owner is no longer running takes ownership. A `--once` watch writes
 * no sentinel at all: a single poll cannot span a turn.
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
