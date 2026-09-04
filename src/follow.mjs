// @ts-check
import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "./core.mjs";
import { matchesAddress, parseTrailers } from "./trailers.mjs";

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
 *
 * `aliases` maps a thread id onto the root it belongs to. One post that the transport had to send
 * as several messages is several thread ids and one conversation: a human answering under the
 * second chunk is answering the post. The aliases are read like any other followed thread and
 * evicted with their root, and they never spend a slot of their own.
 * @typedef {{ threads: Record<string, string>, aliases?: Record<string, string> }} FollowSet
 */

/**
 * How many threads one session follows in one room at once. Measured on a four-seat room: at 8 the
 * watch evicted eight threads inside twenty minutes, several of them claims still being answered.
 * The cost of raising it is reads: sessions x followed x 60/threadInterval per minute, which is what
 * `doctor`'s poll budget adds up. A room sets its own with `followCap`.
 */
export const FOLLOW_CAP = 16;
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
    /** @type {Record<string, string>} */
    const aliases = {};
    const raw = parsed && typeof parsed.aliases === "object" && parsed.aliases ? parsed.aliases : {};
    for (const [id, root] of Object.entries(raw)) if (typeof root === "string" && root !== id) aliases[id] = root;
    return { threads: out, ...(Object.keys(aliases).length ? { aliases } : {}) };
  } catch {
    return { threads: {} };
  }
}

/**
 * Record `ids` as other names for `root`: the further messages one post became. Activity on any of
 * them is activity on the root, a reply under any of them is read, and none of them is a slot.
 * @param {string} dir @param {string} key @param {string} root @param {string[]} ids
 */
export async function aliasThreads(dir, key, root, ids) {
  const set = await readFollow(dir, key);
  const aliases = { ...(set.aliases ?? {}) };
  for (const id of ids) if (id !== root) aliases[id] = root;
  await writeFollow(dir, key, { ...set, aliases });
  return aliases;
}

/** The root a thread id belongs to: itself, unless it is another name for one. @param {FollowSet} set @param {string} id */
export function rootOf(set, id) {
  return set.aliases?.[id] ?? id;
}

/** @param {string} dir @param {string} key @param {FollowSet} set */
export async function writeFollow(dir, key, set) {
  await writeFileAtomic(followPath(dir, key), JSON.stringify(set, null, 2) + "\n");
}

/** Drop one thread from the set. A truncated Slack ts that 404s must leave, or the next poll puts it back. @param {string} dir @param {string} key @param {string} id */
export async function dropFollow(dir, key, id) {
  const set = await readFollow(dir, key);
  const aliases = { ...(set.aliases ?? {}) };
  if (id in aliases) {
    delete aliases[id];
    await writeFollow(dir, key, { ...set, aliases });
    return true;
  }
  if (!(id in set.threads)) return false;
  delete set.threads[id];
  for (const [alias, root] of Object.entries(aliases)) if (root === id) delete aliases[alias];
  await writeFollow(dir, key, { ...set, aliases });
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

/**
 * Messages whose conversation this reader should start following. A human's delivery always
 * qualifies: the answer lands under what they said. Agent and system traffic qualifies only when
 * its `to:` names this bearer, its model, the seat, or everyone. The message is still delivered
 * when it does not qualify; this decides only whether later replies spend the reader's follow
 * budget.
 * @param {import('./core.mjs').Message[]} msgs
 * @param {string} bearer
 * @param {{ id?: string, name?: string }} [seat]
 */
export function followableMessages(msgs, bearer, seat) {
  return msgs.filter((m) => m.author.kind === "human"
    || parseTrailers(m.text).to.some((address) => matchesAddress(address, bearer, seat)));
}

/** Oldest activity first: the order the cap evicts in. @param {FollowSet} set */
function byActivity(set) {
  return Object.entries(set.threads).sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[0] < b[0] ? -1 : 1));
}

/**
 * Note activity on `ids`, drop what has gone idle, cap the set, and write it back.
 * Pass no ids to read the set forward without adding to it (what a poll does).
 *
 * `protect` names the threads the humans answer in: a thread this session itself rooted, and one
 * whose last delivered message was a human's reply. The cap evicts by least-recent activity, and a
 * busy room's chatter is more recent than the request the operator is still answering, so without
 * this the set drops exactly the threads that matter. Protection is computed by the caller from the
 * ledger and the batch it is noting; nothing new is stored to hold it. When every followed thread
 * is protected the cap still binds -- the oldest protected one leaves, and `protectedEvicted` says
 * it did, so the caller can say so out loud.
 * @param {string} dir @param {string} key @param {string[]} ids
 * `admit`, when present, names which roots may be added. Activity still refreshes a root already in
 * the set, so narrowing automatic admission never makes an existing conversation age out while it
 * is active.
 * @param {{ cap?: number, idleMinutes?: number, now?: Date, protect?: Iterable<string>, admit?: Iterable<string> }} [opts]
 * @returns {Promise<{ threads: string[], added: string[], expired: string[], evicted: string[], protectedEvicted: string[] }>}
 */
export async function followThreads(dir, key, ids, opts = {}) {
  const cap = opts.cap ?? FOLLOW_CAP;
  const idleMinutes = opts.idleMinutes ?? FOLLOW_IDLE_MINUTES;
  const now = opts.now ?? new Date();
  const set = await readFollow(dir, key);
  const aliases = { ...(set.aliases ?? {}) };
  const protect = new Set([...(opts.protect ?? [])].map((id) => aliases[id] ?? id));
  const admit = opts.admit === undefined
    ? undefined
    : new Set([...opts.admit].map((id) => aliases[id] ?? id));
  const before = new Set(Object.keys(set.threads));
  // activity on one chunk of a split post is activity on the post
  ids = ids.map((id) => aliases[id] ?? id);
  const active = ids.filter((id) => before.has(id) || admit === undefined || admit.has(id));
  for (const id of active) set.threads[id] = now.toISOString();
  const added = active.filter((id) => !before.has(id));

  /** @type {string[]} */
  const expired = [];
  const floor = now.getTime() - idleMinutes * 60_000;
  for (const [id, at] of byActivity(set)) {
    if (active.includes(id)) continue; // just active
    if (new Date(at).getTime() < floor) {
      expired.push(id);
      delete set.threads[id];
    }
  }

  /** @type {string[]} */
  const evicted = [];
  /** @type {string[]} */
  const protectedEvicted = [];
  const over = () => Object.keys(set.threads).length > Math.max(0, cap);
  for (const [id] of byActivity(set)) {
    if (!over()) break;
    if (protect.has(id)) continue;
    evicted.push(id);
    delete set.threads[id];
  }
  // the cap binds even when everything left is protected; it just says which it took
  for (const [id] of byActivity(set)) {
    if (!over()) break;
    evicted.push(id);
    protectedEvicted.push(id);
    delete set.threads[id];
  }
  for (const id of evicted) for (const [alias, root] of Object.entries(aliases)) if (root === id) delete aliases[alias];

  // noting activity on a thread already in the set is a change too: it is what moves the thread
  // off the eviction end. A poll that adds nothing and expires nothing writes nothing.
  if (active.length || expired.length || evicted.length) await writeFollow(dir, key, { ...set, aliases });
  // every root, then the other names it goes by: a reply under a chunk is read like any other
  const roots = byActivity(set).map(([id]) => id);
  const also = Object.entries(aliases).filter(([, root]) => root in set.threads).map(([alias]) => alias);
  return { threads: [...roots, ...also], added, expired, evicted, protectedEvicted };
}
