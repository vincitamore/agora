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
      if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return [];
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
    async read({ thread, since, limit = 1000 } = {}) {
      const all = await lines();
      const start = since ? Number(since) : 0;
      if (!Number.isInteger(start) || start < 0) throw new AgoraError(`bad cursor "${since}" for a local room`);
      /** @type {import('../core.mjs').Message[]} */
      const out = [];
      for (let i = start; i < all.length && out.length < limit; i++) {
        /** @type {Record<string, any>} */
        let rec;
        try {
          rec = JSON.parse(all[i]);
        } catch {
          continue;
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
      return out;
    },
    async post(text, { thread } = {}) {
      await mkdir(path.dirname(file), { recursive: true });
      const id = `${now().getTime().toString(36)}-${randomBytes(3).toString("hex")}`;
      const rec = { id, thread, author: { id: actor.name, name: actor.name, kind: actor.kind }, text, ts: now().toISOString() };
      await appendFile(file, JSON.stringify(rec) + "\n", "utf8");
      const count = (await lines()).length;
      return { id, cursor: String(count) };
    },
  };
}
