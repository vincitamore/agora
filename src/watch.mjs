// @ts-check
import { readCursor, writeCursor, sleep as defaultSleep } from "./core.mjs";

/**
 * Poll a room from a persisted cursor. Modes:
 *  - once:      one read; fired if anything new
 *  - until-new: poll every `interval` seconds until something new or `forSeconds` elapses
 *  - stream:    keep polling and delivering until `forSeconds` elapses (0 = forever)
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
 *   onBatch: (msgs: import('./core.mjs').Message[]) => void | Promise<void>,
 *   own?: () => Promise<Set<string>> | Set<string>,
 *   sleep?: (ms: number) => Promise<void>, now?: () => number,
 * }} opts
 * @returns {Promise<{ fired: boolean, cursor?: string, polls: number, skipped: number, delivered: number }>}
 */
export async function watch(transport, opts) {
  const { stateDir, key, thread, mode = "until-new", interval = 15, forSeconds = 0, onBatch, own } = opts;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  let skipped = 0;
  let delivered = 0;
  let cursor = opts.cursor !== undefined ? opts.cursor : await readCursor(stateDir, key);
  const start = now();
  let fired = false;
  let polls = 0;
  for (;;) {
    polls++;
    const msgs = await transport.read({ thread, since: cursor });
    if (msgs.length) {
      const posted = own ? await own() : new Set();
      const fresh = msgs.filter((m) => !posted.has(m.id));
      skipped += msgs.length - fresh.length;
      if (fresh.length) {
        await onBatch(fresh);
        delivered += fresh.length;
        fired = true;
      }
      cursor = msgs[msgs.length - 1].cursor;
      await writeCursor(stateDir, key, cursor);
      if (fired && mode !== "stream") return { fired, cursor, polls, skipped, delivered };
    }
    if (mode === "once") return { fired, cursor, polls, skipped, delivered };
    // give up when the next poll would land past the deadline, rather than after one poll too many
    if (forSeconds > 0 && now() - start + interval * 1000 > forSeconds * 1000) return { fired, cursor, polls, skipped, delivered };
    await sleep(interval * 1000);
  }
}
