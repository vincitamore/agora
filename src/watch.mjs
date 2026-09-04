// @ts-check
import { jitter, readCursor, redact, writeCursor, sleep as defaultSleep } from "./core.mjs";

/**
 * @typedef {object} FollowedThreads
 * What a watch needs to poll the threads this session is following. The caller owns the set (it
 * lives on disk under the session), so a thread joined by a sibling process mid-watch is picked up
 * on the next poll and a thread that ages out is dropped from the rotation.
 * @property {() => Promise<string[]> | string[]} ids the followed thread ids, re-read every poll
 * @property {(thread: string) => string} key the cursor key for one thread
 * @property {(thread: string) => Promise<string | undefined>} cursor its saved position
 * @property {number} interval seconds between reads of one thread
 * @property {(msgs: import('./core.mjs').Message[]) => Promise<void> | void} [note] record activity from a delivered batch
 * @property {(id: string) => Promise<void> | void} [drop] remove a thread the transport can no longer read
 */

/**
 * Poll a room from a persisted cursor. Modes:
 *  - once:      one read; fired if anything new
 *  - until-new: poll every `interval` seconds until something new or `forSeconds` elapses
 *  - stream:    keep polling and delivering until `forSeconds` elapses (0 = forever)
 *
 * With `threads`, the same watch also reads each followed thread at its own slower cadence and
 * merges the results: one process, one cursor per key, one delivered batch in `ts` order. A room
 * read does not carry thread replies on every transport, so a thread has to be asked for by name;
 * asking for each at the room's interval is what runs a read budget out, and the slow cadence is
 * the whole saving.
 *
 * A message is this side's own if, and only if, this session posted it: `own` returns the ids this
 * session recorded at post time, re-read on every poll so a sibling process of the same session is
 * seen. Nothing else is consulted: not the author, not the kind, not the signature. When the tool
 * cannot tell whose a message is, it delivers it; a missed peer message is silent and permanent, a
 * duplicated echo of your own line is visible and cheap.
 *
 * The cursor is written AFTER the batch is delivered, so delivery is at-least-once: a process that
 * dies mid-batch re-delivers next time instead of losing the batch. An all-own batch still advances
 * the cursor. `readCursor`/`writeCursor` here are the plain per-key file functions; the caller
 * chooses the directory (a session's own).
 * @param {import('./core.mjs').Transport} transport
 * @param {{
 *   stateDir: string, key: string, thread?: string, cursor?: string,
 *   mode?: 'once' | 'until-new' | 'stream', interval?: number, forSeconds?: number,
 *   onBatch: (msgs: import('./core.mjs').Message[], batch: { delivered: number, skipped: number, filtered: number }) => void | Promise<void>,
 *   own?: () => Promise<Set<string>> | Set<string>,
 *   wake?: (m: import('./core.mjs').Message) => boolean,
 *   threads?: FollowedThreads,
 *   sweep?: () => Promise<void> | void,
 *   sleep?: (ms: number) => Promise<void>, now?: () => number, random?: () => number,
 * }} opts
 * `wake` is the reader's own choice of what wakes it (a message addressed to someone else need
 * not); what it drops is counted as `filtered`, the cursor still advances past it, and `read`
 * still shows it. It is never automatic: a message from another agent is input, and routing on
 * its trailers is a flag the reader set.
 * @returns {Promise<{ fired: boolean, cursor?: string, polls: number, skipped: number, filtered: number, delivered: number, elapsedMs: number, following: number, threads: Record<string, number> }>}
 */
export async function watch(transport, opts) {
  const { stateDir, key, thread, mode = "until-new", interval = 15, forSeconds = 0, onBatch, own, wake, threads, sweep } = opts;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  let skipped = 0;
  let filtered = 0;
  let delivered = 0;
  let cursor = opts.cursor !== undefined ? opts.cursor : await readCursor(stateDir, key);
  /** @type {Map<string, { key: string, cursor: string | undefined, lastRead: number }>} */
  const followed = new Map();
  /** @type {Record<string, number>} */
  const perThread = {};
  const start = now();
  let fired = false;
  let polls = 0;
  const result = () => ({ fired, cursor, polls, skipped, filtered, delivered, elapsedMs: Math.max(0, now() - start), following: followed.size, threads: perThread });
  for (;;) {
    polls++;
    // the seat's own housekeeping rides on the poll: a sibling that went dark is announced here,
    // before the read, so the announcement is in the room for everyone else's next poll and in
    // this session's ledger for its own
    if (sweep) await sweep();
    /** @type {Array<{ m: import('./core.mjs').Message, thread?: string }>} */
    const batch = [];
    const roomMsgs = await transport.read({ thread, since: cursor });
    for (const m of roomMsgs) batch.push({ m });

    /** @type {Map<string, string>} */
    const advanced = new Map();
    if (threads) {
      const ids = await threads.ids();
      for (const id of ids) {
        if (!followed.has(id)) followed.set(id, { key: threads.key(id), cursor: await threads.cursor(id), lastRead: -Infinity });
        if (perThread[id] === undefined) perThread[id] = 0;
      }
      // a thread that aged out of the set, or was evicted by the cap, stops being read and stops
      // being reported: the result line names what this watch follows now, not what it once did
      const live = new Set(ids);
      for (const id of [...followed.keys()]) if (!live.has(id)) followed.delete(id);
      for (const id of Object.keys(perThread)) if (!live.has(id)) delete perThread[id];
      for (const id of ids) {
        const st = followed.get(id);
        if (!st || now() - st.lastRead < threads.interval * 1000) continue;
        st.lastRead = now();
        // The id came out of this session's own follow set, which a `post --thread` from another
        // shell may have written mangled (an unquoted Slack ts loses its last digits under pwsh).
        // A malformed id there is not a usage error -- the caller boundaries refuse those -- it is
        // a key to drop, so the rest of the set keeps delivering.
        const bad = transport.validateThread?.(id);
        if (bad) {
          console.error(redact(`agora: dropped follow ${id}: ${bad}`));
          followed.delete(id);
          delete perThread[id];
          if (threads.drop) await threads.drop(id);
          continue;
        }
        /** @type {import('./core.mjs').Message[]} */
        let replies = [];
        try {
          replies = await transport.read({ thread: id, since: st.cursor });
        } catch (err) {
          // one unreadable follow (truncated Slack ts → thread_not_found) must not kill the room watch
          const why = err instanceof Error ? err.message : String(err);
          console.error(redact(`agora: dropped follow ${id}: ${why}`));
          followed.delete(id);
          delete perThread[id];
          if (threads.drop) await threads.drop(id);
          continue;
        }
        if (!replies.length) continue;
        advanced.set(id, replies[replies.length - 1].cursor);
        for (const m of replies) batch.push({ m, thread: id });
      }
    }

    if (batch.length) {
      batch.sort((a, b) => (a.m.ts < b.m.ts ? -1 : a.m.ts > b.m.ts ? 1 : 0));
      // a message a room read and a thread read both carried (a broadcast reply, or a transport
      // whose room read does not hold replies back) is one message, delivered once
      /** @type {Set<string>} */
      const ids = new Set();
      const merged = batch.filter((e) => !ids.has(e.m.id) && (ids.add(e.m.id), true));
      const posted = own ? await own() : new Set();
      const notMine = merged.filter((e) => !posted.has(e.m.id));
      const skippedHere = merged.length - notMine.length;
      skipped += skippedHere;
      const fresh = wake ? notMine.filter((e) => wake(e.m)) : notMine;
      const filteredHere = notMine.length - fresh.length;
      filtered += filteredHere;
      if (fresh.length) {
        // the counts of THIS poll, so a consumer taking one object per poll says what the poll did
        // without subtracting running totals itself
        await onBatch(fresh.map((e) => e.m), { delivered: fresh.length, skipped: skippedHere, filtered: filteredHere });
        delivered += fresh.length;
        // a message counts against a followed thread whether the thread read or the room read
        // was the one that carried it
        for (const e of fresh) {
          const id = e.thread ?? e.m.thread;
          if (id !== undefined && id in perThread) perThread[id] += 1;
        }
        fired = true;
      }
      if (roomMsgs.length) {
        cursor = roomMsgs[roomMsgs.length - 1].cursor;
        await writeCursor(stateDir, key, cursor);
      }
      for (const [id, c] of advanced) {
        const st = followed.get(id);
        if (!st) continue;
        st.cursor = c;
        await writeCursor(stateDir, st.key, c);
      }
      if (threads?.note && fresh.length) await threads.note(fresh.map((e) => e.m));
      if (fired && mode !== "stream") return result();
    }
    if (mode === "once") return result();
    // give up when the next poll would land past the deadline, rather than after one poll too many
    if (forSeconds > 0 && now() - start + interval * 1000 > forSeconds * 1000) return result();
    await sleep(jitter(interval * 1000, random));
  }
}
