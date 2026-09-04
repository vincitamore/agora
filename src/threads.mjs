// @ts-check
/**
 * Folding a room's live threads into one read.
 *
 * On Slack a channel-history read never contains replies, and a parent older than the
 * cursor is not in the window even when its thread moved after the cursor; the local
 * transport's room read includes replies. A claim posted as a thread reply is therefore
 * invisible to a plain `read <room>` on Slack, which is how two agents claim one function
 * a second apart. `read --threads` takes a bounded horizon read of the room, picks the
 * parents whose threads hold replies after the cursor, reads those threads after the
 * cursor, and merges everything by time. These helpers are the pure part.
 */

/** Numeric when both sides are numbers (Slack ts, local line index), else string order. @param {string} a @param {string} b */
export function after(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (Number.isFinite(x) && Number.isFinite(y)) return x > y;
  return String(a) > String(b);
}

/**
 * Parents in a horizon read whose threads may hold replies after `since`.
 *
 * A reply names its thread (local transport, thread_broadcast on Slack); a Slack parent
 * carries `reply_count` and `latest_reply` in `raw`. A parent whose latest reply is not
 * after `since` is skipped; one with no `latest_reply` to check is kept, and the thread
 * read itself applies the cursor. Order is by first appearance, oldest first.
 * @param {import('./core.mjs').Message[]} msgs
 * @param {string} [since]
 * @returns {string[]}
 */
export function threadRoots(msgs, since) {
  /** @type {string[]} */
  const out = [];
  for (const m of msgs) {
    const raw = /** @type {Record<string, unknown>} */ (m.raw ?? {});
    const root = m.thread ?? m.id;
    if (!root) continue;
    const replies = Number(raw.reply_count ?? 0);
    const isReply = m.thread !== undefined && m.thread !== m.id;
    if (!isReply && !(replies > 0)) continue;
    const latest = raw.latest_reply;
    if (since && !isReply && latest !== undefined && latest !== null && !after(String(latest), since)) continue;
    if (!out.includes(root)) out.push(root);
  }
  return out;
}

/**
 * One ascending list: by `ts`, then id; the same id from two reads appears once.
 * @param {...import('./core.mjs').Message[]} lists
 * @returns {import('./core.mjs').Message[]}
 */
export function mergeAscending(...lists) {
  /** @type {Map<string, import('./core.mjs').Message>} */
  const byId = new Map();
  for (const list of lists) for (const m of list) if (!byId.has(m.id)) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The threads a fold of this window would read: every root in it that may hold replies after
 * `since`, capped to the most recently rooted `cap` of them.
 *
 * This is the bounding, held apart from the reading so that a caller which cannot let one bad
 * thread read kill the fold -- `carry`, whose envelope is worth more than any one thread in it --
 * bounds its window exactly as `read --threads` does and only differs in what it does with a
 * failure. Two fold sites reading two different sets of threads would be two horizons, and a
 * successor could not tell which one its envelope was computed from.
 * @param {import('./core.mjs').Message[]} msgs
 * @param {import('./core.mjs').Message[]} horizon
 * @param {{ since?: string, cap?: number }} [opts]
 * @returns {string[]}
 */
export function boundedRoots(msgs, horizon, opts = {}) {
  const cap = opts.cap ?? 50;
  return threadRoots(mergeAscending(msgs, horizon), opts.since).slice(-cap);
}

/**
 * The room after `since`, with the replies its live threads gained after `since`.
 * `horizon` is a bounded read of the room with no cursor (the newest messages), which is
 * where a parent older than the cursor is found; the room read itself is `msgs`.
 * @param {{ read: (o: import('./core.mjs').ReadOptions) => Promise<import('./core.mjs').Message[]> }} transport
 * @param {import('./core.mjs').Message[]} msgs
 * @param {import('./core.mjs').Message[]} horizon
 * @param {{ since?: string, cap?: number }} [opts]
 */
export async function withThreads(transport, msgs, horizon, opts = {}) {
  const roots = boundedRoots(msgs, horizon, opts);
  const replies = [];
  for (const id of roots) replies.push(await transport.read({ thread: id, since: opts.since }));
  return { messages: mergeAscending(msgs, ...replies), threads: roots };
}
