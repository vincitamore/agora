// @ts-check
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * The threads one session follows in one room, and when each last carried activity.
 * A thread joins when this session posts into it or answers a message with `re:`, when a
 * delivered message carries it, or when a delivered message roots it (the thread under a
 * top-level message that woke this session);
 * it leaves after `idleMinutes` without activity, and the set is capped, oldest first.
 * Reading a thread is not activity: a thread nobody is talking in ages out even while it
 * is being polled.
 *
 * The file is re-read on every use, so a `post --thread` from a sibling process joins a
 * watch that is already running, and nothing is held in a process that can die.
 * @typedef {{ threads: Record<string, string> }} FollowSet
 */

export const FOLLOW_CAP = 8;
export const FOLLOW_IDLE_MINUTES = 60;

/** @param {string} dir @param {string} key */
export function followPath(dir, key) {
  return path.join(dir, "follow", `${key}.json`);
}

/** @param {string} dir @param {string} key @returns {Promise<FollowSet>} */
export async function readFollow(dir, key) {
  try {
    const parsed = JSON.parse(await readFile(followPath(dir, key), "utf8"));
    const threads = parsed && typeof parsed.threads === "object" && parsed.threads ? parsed.threads : {};
    /** @type {Record<string, string>} */
    const out = {};
    for (const [id, at] of Object.entries(threads)) if (typeof at === "string") out[id] = at;
    return { threads: out };
  } catch {
    return { threads: {} };
  }
}

/** @param {string} dir @param {string} key @param {FollowSet} set */
export async function writeFollow(dir, key, set) {
  const file = followPath(dir, key);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(set, null, 2) + "\n", "utf8");
}

/** Drop one thread from the set. A truncated Slack ts that 404s must leave, or the next poll puts it back. @param {string} dir @param {string} key @param {string} id */
export async function dropFollow(dir, key, id) {
  const set = await readFollow(dir, key);
  if (!(id in set.threads)) return false;
  delete set.threads[id];
  await writeFollow(dir, key, set);
  return true;
}

/** The threads a batch of messages came from, in order, without repeats. @param {import('./core.mjs').Message[]} msgs */
export function threadsOf(msgs) {
  /** @type {string[]} */
  const out = [];
  for (const m of msgs) if (m.thread && !out.includes(m.thread)) out.push(m.thread);
  return out;
}

/**
 * The thread each delivered message belongs to, or the one it would root: a reply names its
 * thread, a top-level message names itself. A reader that was woken by a message wants the
 * answers to it, and on Slack those land in the thread under it, which a channel-history read
 * never shows. Only meaningful where the transport has threads; the caller checks that.
 * @param {import('./core.mjs').Message[]} msgs
 */
export function rootsOf(msgs) {
  /** @type {string[]} */
  const out = [];
  for (const m of msgs) {
    const id = m.thread ?? m.id;
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Oldest activity first: the order the cap evicts in. @param {FollowSet} set */
function byActivity(set) {
  return Object.entries(set.threads).sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[0] < b[0] ? -1 : 1));
}

/**
 * Note activity on `ids`, drop what has gone idle, cap the set, and write it back.
 * Pass no ids to read the set forward without adding to it (what a poll does).
 * @param {string} dir @param {string} key @param {string[]} ids
 * @param {{ cap?: number, idleMinutes?: number, now?: Date }} [opts]
 * @returns {Promise<{ threads: string[], added: string[], expired: string[], evicted: string[] }>}
 */
export async function followThreads(dir, key, ids, opts = {}) {
  const cap = opts.cap ?? FOLLOW_CAP;
  const idleMinutes = opts.idleMinutes ?? FOLLOW_IDLE_MINUTES;
  const now = opts.now ?? new Date();
  const set = await readFollow(dir, key);
  const before = new Set(Object.keys(set.threads));
  for (const id of ids) set.threads[id] = now.toISOString();
  const added = ids.filter((id) => !before.has(id));

  /** @type {string[]} */
  const expired = [];
  const floor = now.getTime() - idleMinutes * 60_000;
  for (const [id, at] of byActivity(set)) {
    if (ids.includes(id)) continue; // just active
    if (new Date(at).getTime() < floor) {
      expired.push(id);
      delete set.threads[id];
    }
  }

  /** @type {string[]} */
  const evicted = [];
  for (const [id] of byActivity(set)) {
    if (Object.keys(set.threads).length <= Math.max(0, cap)) break;
    evicted.push(id);
    delete set.threads[id];
  }

  // noting activity on a thread already in the set is a change too: it is what moves the thread
  // off the eviction end. A poll that adds nothing and expires nothing writes nothing.
  if (ids.length || expired.length || evicted.length) await writeFollow(dir, key, set);
  return { threads: byActivity(set).map(([id]) => id), added, expired, evicted };
}
