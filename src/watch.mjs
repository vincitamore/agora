// @ts-check
import { jitter, readCursor, redact, writeCursor, sleep as defaultSleep } from "./core.mjs";

/** @typedef {{ room?: string, threads: Map<string, string> }} CursorCheckpoint */
/** @typedef {{ delivered: number, skipped: number, filtered: number, checkpoint: (message: import('./core.mjs').Message | string) => Promise<void> }} BatchInfo */

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
 *
 * `coalesceSeconds` / `maxBatch` hold fresh messages in memory and call `onBatch` once for the
 * window. The cursor is not persisted while a deliverable message is held, so a death mid-window
 * re-delivers it (at-least-once unchanged). A window containing only this session's own or filtered
 * messages has nothing awaiting acknowledgement and persists immediately. A message for which
 * `urgent` is true flushes immediately, as does reaching `maxBatch`. Remaining held messages flush
 * when the watch is about to return.
 * @param {import('./core.mjs').Transport} transport
 * @param {{
 *   stateDir: string, key: string, thread?: string, cursor?: string,
 *   mode?: 'once' | 'until-new' | 'stream', interval?: number, forSeconds?: number,
 *   onBatch: (msgs: import('./core.mjs').Message[], batch: BatchInfo) => void | Promise<void>,
 *   own?: () => Promise<Set<string>> | Set<string>,
 *   wake?: (m: import('./core.mjs').Message) => boolean,
 *   urgent?: (m: import('./core.mjs').Message) => boolean,
 *   coalesceSeconds?: number, maxBatch?: number,
 *   guard?: () => string | undefined | Promise<string | undefined>,
 *   threads?: FollowedThreads,
 *   sweep?: () => Promise<void> | void,
 *   sleep?: (ms: number) => Promise<void>, now?: () => number, random?: () => number,
 * }} opts
 * `wake` is the reader's own choice of what wakes it (a message addressed to someone else need
 * not); what it drops is counted as `filtered`, the cursor still advances past it, and `read`
 * still shows it. It is never automatic: a message from another agent is input, and routing on
 * its trailers is a flag the reader set. An incoming `ack:` is never consulted here: honouring
 * `ack: none` is a judgement, not a filter, suppress, or delay.
 * @returns {Promise<{ fired: boolean, cursor?: string, polls: number, skipped: number, filtered: number, delivered: number, elapsedMs: number, following: number, threads: Record<string, number>, reason?: string }>}
 */
export async function watch(transport, opts) {
  const { stateDir, key, thread, mode = "until-new", interval = 15, forSeconds = 0, onBatch, own, wake, urgent, threads, sweep, guard } = opts;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const coalesceSeconds = opts.coalesceSeconds && opts.coalesceSeconds > 0 ? opts.coalesceSeconds : 0;
  const maxBatch = opts.maxBatch && opts.maxBatch > 0 ? opts.maxBatch : 0;
  const holding = coalesceSeconds > 0 || maxBatch > 0;
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
  /** @type {string | undefined} */
  let reason;
  /** @type {Array<{ m: import('./core.mjs').Message, thread?: string, checkpoint?: CursorCheckpoint }>} */
  const held = [];
  /** @type {Set<string>} */
  const heldIds = new Set();
  let windowStart;
  /** @type {string | undefined} */
  let pendingRoomCursor;
  /** @type {Map<string, string>} */
  const pendingThreadCursors = new Map();
  /** Cursor changes since the last externally acknowledged delivery. */
  let checkpointRoomCursor;
  /** @type {Map<string, string>} */
  const checkpointThreadCursors = new Map();
  let windowSkipped = 0;
  let windowFiltered = 0;
  const result = () => ({ fired, cursor, polls, skipped, filtered, delivered, elapsedMs: Math.max(0, now() - start), following: followed.size, threads: perThread, ...(reason ? { reason } : {}) });

  /** Persist safe cursors: immediately with no held delivery, otherwise only after delivery. */
  const persistPending = async () => {
    if (pendingRoomCursor !== undefined) {
      cursor = pendingRoomCursor;
      await writeCursor(stateDir, key, cursor);
    }
    for (const [id, c] of pendingThreadCursors) {
      const st = followed.get(id);
      if (st) st.cursor = c;
      await writeCursor(stateDir, threads ? threads.key(id) : id, c);
    }
    pendingRoomCursor = undefined;
    pendingThreadCursors.clear();
    checkpointRoomCursor = undefined;
    checkpointThreadCursors.clear();
  };

  /**
   * An adapter can have accepted the first external side effect before a later item fails. Its
   * acknowledgement advances only through that accepted prefix; the unacknowledged suffix remains
   * at-least-once. Calls must follow delivery order, which is the order `msgs` is handed to it.
   * @param {Array<{ m: import('./core.mjs').Message, checkpoint?: CursorCheckpoint }>} entries
   * @param {{ delivered: number, skipped: number, filtered: number }} counts
   * @returns {BatchInfo}
   */
  const batchInfo = (entries, counts) => {
    let next = 0;
    const byId = new Map(entries.map((e, index) => [e.m.id, index]));
    const info = { ...counts };
    return /** @type {BatchInfo} */ (Object.defineProperty(info, "checkpoint", {
      enumerable: false,
      /** @param {import('./core.mjs').Message | string} message */
      value: async (message) => {
        const id = typeof message === "string" ? message : message.id;
        const index = byId.get(id);
        if (index === undefined) throw new Error(`cannot checkpoint delivery ${id}: it is not in this batch`);
        if (index !== next) throw new Error(`cannot checkpoint delivery ${id}: expected ${entries[next]?.m.id ?? "the end of the batch"}`);
        const point = entries[index].checkpoint;
        if (!point) throw new Error(`cannot checkpoint delivery ${id}: no cursor position was recorded`);
        if (point.room !== undefined) await writeCursor(stateDir, key, point.room);
        for (const [threadId, c] of point.threads)
          await writeCursor(stateDir, threads ? threads.key(threadId) : threadId, c);
        next++;
      },
    }));
  };

  const flush = async () => {
    if (!held.length) {
      await persistPending();
      windowSkipped = 0;
      windowFiltered = 0;
      return;
    }
    const msgs = held.map((e) => e.m);
    const n = held.length;
    await onBatch(msgs, batchInfo(held, { delivered: n, skipped: windowSkipped, filtered: windowFiltered }));
    delivered += n;
    for (const e of held) {
      const id = e.thread ?? e.m.thread;
      if (id !== undefined && id in perThread) perThread[id] += 1;
    }
    if (threads?.note) await threads.note(msgs);
    fired = true;
    held.length = 0;
    heldIds.clear();
    windowStart = undefined;
    windowSkipped = 0;
    windowFiltered = 0;
    await persistPending();
  };

  for (;;) {
    reason = await guard?.();
    if (reason) {
      await flush();
      return result();
    }
    polls++;
    // the seat's own housekeeping rides on the poll: a sibling that went dark is announced here,
    // before the read, so the announcement is in the room for everyone else's next poll and in
    // this session's ledger for its own
    if (sweep) await sweep();
    /** @type {Array<{ m: import('./core.mjs').Message, thread?: string, checkpoint?: CursorCheckpoint }>} */
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
          // a 429 or 5xx is transient: drop is permanent and the replies then stop arriving
          if (/rate limited|\b429\b|\b5\d\d\b/i.test(why)) {
            console.error(redact(`agora: follow ${id}: ${why}; keeping it for the next poll`));
            continue;
          }
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
      // Preserve the source of every cursor: a room delivery and a followed-thread delivery share
      // one merged timeline but advance different files. Own and filtered messages before an
      // accepted delivery are safe to include in that delivery's checkpoint.
      const sources = new Map();
      for (const e of batch) {
        let source = sources.get(e.m.id);
        if (!source) sources.set(e.m.id, source = { threads: new Map() });
        if (e.thread === undefined) source.room = e.m.cursor;
        else source.threads.set(e.thread, e.m.cursor);
      }
      const freshIds = new Set(fresh.map((e) => e.m.id));
      for (const e of merged) {
        const source = sources.get(e.m.id);
        if (source?.room !== undefined) checkpointRoomCursor = source.room;
        if (source) for (const [threadId, c] of source.threads) checkpointThreadCursors.set(threadId, c);
        if (freshIds.has(e.m.id)) {
          e.checkpoint = { room: checkpointRoomCursor, threads: new Map(checkpointThreadCursors) };
          checkpointRoomCursor = undefined;
          checkpointThreadCursors.clear();
        }
      }
      filtered += filteredHere;
      if (roomMsgs.length) pendingRoomCursor = roomMsgs[roomMsgs.length - 1].cursor;
      for (const [id, c] of advanced) pendingThreadCursors.set(id, c);

      if (!holding) {
        if (fresh.length) {
          // the counts of THIS poll, so a consumer taking one object per poll says what the poll did
          // without subtracting running totals itself
          await onBatch(fresh.map((e) => e.m), batchInfo(fresh, { delivered: fresh.length, skipped: skippedHere, filtered: filteredHere }));
          delivered += fresh.length;
          // a message counts against a followed thread whether the thread read or the room read
          // was the one that carried it
          for (const e of fresh) {
            const id = e.thread ?? e.m.thread;
            if (id !== undefined && id in perThread) perThread[id] += 1;
          }
          fired = true;
          if (threads?.note) await threads.note(fresh.map((e) => e.m));
        }
        await persistPending();
        if (fired && mode !== "stream") return result();
      } else {
        windowSkipped += skippedHere;
        windowFiltered += filteredHere;
        // advance the in-memory position so the next poll does not re-read; disk waits for flush
        if (pendingRoomCursor !== undefined) cursor = pendingRoomCursor;
        for (const [id, c] of pendingThreadCursors) {
          const st = followed.get(id);
          if (st) st.cursor = c;
        }
        let mustFlush = false;
        for (const e of fresh) {
          if (heldIds.has(e.m.id)) continue;
          if (!held.length) windowStart = now();
          held.push(e);
          heldIds.add(e.m.id);
          if (urgent?.(e.m)) mustFlush = true;
        }
        if (maxBatch > 0 && held.length >= maxBatch) mustFlush = true;
        if (mustFlush || !held.length) await flush();
        if (fired && mode !== "stream") return result();
      }
    }
    if (holding && held.length && coalesceSeconds > 0 && windowStart !== undefined && now() - windowStart >= coalesceSeconds * 1000) {
      await flush();
      if (fired && mode !== "stream") return result();
    }
    const deadline = forSeconds > 0 && now() - start + interval * 1000 > forSeconds * 1000;
    if (mode === "once" || deadline) {
      await flush();
      return result();
    }
    await sleep(jitter(interval * 1000, random));
  }
}
