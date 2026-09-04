// @ts-check
import { appendFile, readFile, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { AgoraError, parseSignature, resolvePath } from "../core.mjs";

/**
 * A room that is an append-only NDJSON file. For tests, and for two agents that share a
 * filesystem. Cursor = number of lines consumed.
 * @param {import('../core.mjs').RoomConfig} room
 * @param {{ actor: import('../core.mjs').Actor, now?: () => Date }} deps
 * @returns {import('../core.mjs').Transport}
 */
export function localTransport(room, { actor, now = () => new Date() }) {
  if (typeof room.path !== "string") throw new AgoraError(`local room needs a path`);
  const file = resolvePath(room.path);

  async function lines() {
    try {
      const raw = await readFile(file, "utf8");
      return raw.split(/\r?\n/).filter((l) => l.trim());
    } catch (e) {
      // an absent room reads as empty: ENOENT everywhere, and ENOTDIR on POSIX when a path component is
      // a file (Windows reports that case as ENOENT, which is why it was the only code checked)
      const code = /** @type {NodeJS.ErrnoException} */ (e).code;
      if (code === "ENOENT" || code === "ENOTDIR") return [];
      throw e;
    }
  }

  return {
    kind: "local",
    room: file,
    threads: true,
    async whoami() {
      return { id: actor.name, name: actor.name };
    },
    validateCursor(cursor) {
      const n = Number(cursor);
      return Number.isInteger(n) && n >= 0 ? undefined : `a local room's cursor is the number of lines consumed (a non-negative whole number), not ${JSON.stringify(cursor)}`;
    },
    async read({ thread, since, limit = 1000 } = {}) {
      const all = await lines();
      const start = since ? Number(since) : 0;
      if (!Number.isInteger(start) || start < 0) throw new AgoraError(`bad cursor "${since}" for a local room`);
      if (start > all.length)
        throw new AgoraError(`local room: cursor ${start} exceeds ${all.length} available records; the log may be truncated, replaced, or missing; restore it or use a new room alias`);
      /** @type {import('../core.mjs').Message[]} */
      const out = [];
      for (let i = start; i < all.length; i++) {
        /** @type {Record<string, any>} */
        let rec;
        try {
          rec = JSON.parse(all[i]);
        } catch {
          // Returning a valid suffix would let watch checkpoint past the broken record.
          // Do not include its contents: room text may contain private data.
          throw new AgoraError(`local room: invalid JSON at record ${i + 1}; no batch delivered; restore an intact log before resuming`);
        }
        if (thread && rec.thread !== thread) continue;
        out.push({
          id: String(rec.id),
          room: file,
          thread: rec.thread ?? undefined,
          author: rec.author ?? { id: "unknown", name: "unknown", kind: "unknown" },
          text: String(rec.text ?? ""),
          signedAs: parseSignature(String(rec.text ?? "")),
          ts: String(rec.ts),
          cursor: String(i + 1),
          raw: rec,
        });
      }
      // A read without a cursor returns the NEWEST messages up to the limit, as every other
      // transport does: taking the oldest of the window is what set `cursor --now` hundreds of
      // messages back on a busy room and told `who` a bearer who spoke a second ago was silent.
      // With a cursor the window starts where the reader left off, so the limit takes the front.
      return since ? out.slice(0, limit) : out.slice(-limit);
    },
    async post(text, { thread } = {}) {
      await mkdir(path.dirname(file), { recursive: true });
      const id = `${now().getTime().toString(36)}-${randomBytes(3).toString("hex")}`;
      const rec = { id, thread, author: { id: actor.name, name: actor.name, kind: actor.kind }, text, ts: now().toISOString() };
      await appendFile(file, JSON.stringify(rec) + "\n", "utf8");
      // Other writers can append before our read completes. The tail count then belongs to
      // somebody else's post; returning it would skip peers when resumed with `since`.
      const index = (await lines()).findIndex((line) => {
        try { return JSON.parse(line)?.id === id; } catch { return false; }
      });
      if (index < 0)
        throw new AgoraError(`local room: appended message ${id} is not visible in the log; post outcome unknown; inspect the log before retrying`);
      return { id, cursor: String(index + 1) };
    },
  };
}
