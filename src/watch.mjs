// @ts-check
import { readCursor, writeCursor, sleep as defaultSleep } from "./core.mjs";

/**
 * Poll a room from a persisted cursor. Modes:
 *  - once:      one read; fired if anything new
 *  - until-new: poll every `interval` seconds until something new or `forSeconds` elapses
 *  - stream:    keep polling and delivering until `forSeconds` elapses (0 = forever)
 * The cursor advances after each read batch, so a watcher never re-delivers.
 * With `self` (the transport's `whoami`) the watcher skips this side's own posts:
 * a message whose author is `self` and is either an agent or signed `actorName`.
 * The cursor still advances past them, so a side never wakes on its own echo.
 * @param {import('./core.mjs').Transport} transport
 * @param {{
 *   stateDir: string, key: string, thread?: string,
 *   mode?: 'once' | 'until-new' | 'stream', interval?: number, forSeconds?: number,
 *   onBatch: (msgs: import('./core.mjs').Message[]) => void | Promise<void>,
 *   self?: { id: string, name: string }, actorName?: string,
 *   sleep?: (ms: number) => Promise<void>, now?: () => number,
 * }} opts
 * @returns {Promise<{ fired: boolean, cursor?: string, polls: number, skipped: number }>}
 */
export async function watch(transport, opts) {
  const { stateDir, key, thread, mode = "until-new", interval = 15, forSeconds = 0, onBatch, self, actorName } = opts;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  let skipped = 0;
  /** @param {import('./core.mjs').Message} m */
  const own = (m) =>
    !!self &&
    (m.author.id === self.id || m.author.name === self.name) &&
    (m.author.kind === "agent" || (actorName !== undefined && m.signedAs === actorName));
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
      const fresh = msgs.filter((m) => !own(m));
      skipped += msgs.length - fresh.length;
      if (fresh.length) {
        await onBatch(fresh);
        fired = true;
        if (mode !== "stream") return { fired, cursor, polls, skipped };
      }
    }
    if (mode === "once") return { fired, cursor, polls, skipped };
    // give up when the next poll would land past the deadline, rather than after one poll too many
    if (forSeconds > 0 && now() - start + interval * 1000 > forSeconds * 1000) return { fired, cursor, polls, skipped };
    await sleep(interval * 1000);
  }
}
