// @ts-check
import { readCursor, writeCursor, sleep as defaultSleep } from "./core.mjs";

/**
 * Poll a room from a persisted cursor. Modes:
 *  - once:      one read; fired if anything new
 *  - until-new: poll every `interval` seconds until something new or `forSeconds` elapses
 *  - stream:    keep polling and delivering until `forSeconds` elapses (0 = forever)
 * The cursor advances after each delivered batch, so a watcher never re-delivers.
 * @param {import('./core.mjs').Transport} transport
 * @param {{
 *   stateDir: string, key: string, thread?: string,
 *   mode?: 'once' | 'until-new' | 'stream', interval?: number, forSeconds?: number,
 *   onBatch: (msgs: import('./core.mjs').Message[]) => void | Promise<void>,
 *   sleep?: (ms: number) => Promise<void>, now?: () => number,
 * }} opts
 * @returns {Promise<{ fired: boolean, cursor?: string, polls: number }>}
 */
export async function watch(transport, opts) {
  const { stateDir, key, thread, mode = "until-new", interval = 15, forSeconds = 0, onBatch } = opts;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  let cursor = await readCursor(stateDir, key);
  const start = now();
  let fired = false;
  let polls = 0;
  for (;;) {
    polls++;
    const msgs = await transport.read({ thread, since: cursor });
    if (msgs.length) {
      cursor = msgs[msgs.length - 1].cursor;
      await writeCursor(stateDir, key, cursor);
      await onBatch(msgs);
      fired = true;
      if (mode !== "stream") return { fired, cursor, polls };
    }
    if (mode === "once") return { fired, cursor, polls };
    // give up when the next poll would land past the deadline, rather than after one poll too many
    if (forSeconds > 0 && now() - start + interval * 1000 > forSeconds * 1000) return { fired, cursor, polls };
    await sleep(interval * 1000);
  }
}
