// @ts-check
/// <reference path="./bun-sqlite.d.ts" />
/**
 * The kit's own store, `kit.sqlite` under the host's `storeDir` (bun:sqlite): read positions,
 * reactions by name, the message index (FTS5) with the `context`,
 * `waiting` and `card` trailers indexed, and thumbnails by digest. Schema and migrations live here.
 *
 * Two kinds of table, kept apart on purpose:
 * - **the index** (`messages`, `annotations`, `message_trailers`, `message_context`, `mentions`,
 *   `message_files`, `message_fts`, and the `index_*` rows of `meta`) is derived from the room and
 *   rebuilt from it whenever it disagrees (a room of another epoch); nothing in it is the only copy;
 * - **what is kept** (`positions`, `reactions`, `thumbs`) is the kit's own and survives a rebuild
 *   of the index.
 *
 * Push keeps its own tables (`push_*`, with its own schema record) in this same database, opened by
 * push/store.mjs on `db`; this module never creates or reads a `push_*` table.
 *
 * The store never reads the room and never decides anything about a message; it records what the
 * room said and answers queries over it. Cursors are native room cursors, `<epoch>:<sequence>`;
 * the sequence orders records within an epoch, and nothing compares across epochs.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";

/** The schema this build writes; `PRAGMA user_version` carries it. */
export const KIT_SCHEMA_VERSION = 1;

/**
 * Each step takes the database from version N to N+1. A step is never edited once released; a
 * change is a new step.
 * @type {ReadonlyArray<string>}
 */
const MIGRATIONS = Object.freeze([
  // 0 -> 1
  `
  create table meta (key text primary key, value text not null);
  create table messages (
    id text primary key, seq integer not null, cursor text not null, ts text not null,
    thread text, author_kind text not null, author_name text not null, author_ref text, via text,
    withdrawn integer not null default 0, json text not null);
  create index messages_thread on messages(thread, seq);
  create index messages_seq on messages(seq);
  create index messages_author_ref on messages(author_ref);
  create table annotations (id text primary key, seq integer not null, cursor text not null,
    target text not null, act text not null, json text not null);
  create index annotations_target on annotations(target, seq);
  create table message_trailers (id text not null, key text not null, value text not null);
  create index message_trailers_id on message_trailers(id);
  create index message_trailers_kv on message_trailers(key, value);
  create table message_context (id text not null, k text not null, v text not null);
  create index message_context_kv on message_context(k, v);
  create table mentions (id text not null, person text not null);
  create index mentions_person on mentions(person);
  create table message_files (message text not null, attachment text not null, digest text not null,
    name text not null, kind text not null, mimetype text, size integer);
  create index message_files_message on message_files(message);
  create virtual table message_fts using fts5(id unindexed, thread unindexed, text, files);
  create table positions (person text not null, thread text not null, cursor text not null,
    epoch text not null, seq integer not null, at text not null, primary key (person, thread));
  create table reactions (target text not null, name text not null, person text not null, at text not null,
    primary key (target, name, person));
  create table thumbs (digest text primary key, path text not null, created text not null);
  `,
]);

/** The trailer keys the kit indexes: rendered and queried, never acted on. */
export const KIT_TRAILER_KEYS = Object.freeze(["card", "waiting", "context", "re"]);

/**
 * A native cursor's parts, or null when it is not one.
 * @param {unknown} cursor
 * @returns {{ epoch: string, seq: number } | null}
 */
export function parseCursor(cursor) {
  if (typeof cursor !== "string") return null;
  const m = cursor.match(/^([a-f0-9]{32}):(0|[1-9][0-9]{0,15})$/);
  if (!m) return null;
  const seq = Number(m[2]);
  return Number.isSafeInteger(seq) ? { epoch: m[1], seq } : null;
}

/**
 * A `context:` trailer's pairs: `k=v; k2=v2`. A part without `=` is skipped.
 * @param {string} value
 * @returns {Array<[string, string]>}
 */
export function parseContext(value) {
  /** @type {Array<[string, string]>} */
  const out = [];
  for (const part of value.split(";")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    const k = part.slice(0, at).trim();
    const v = part.slice(at + 1).trim();
    if (k && v) out.push([k, v]);
  }
  return out;
}

/**
 * A `card:` trailer's type and id: `<type> <id>`.
 * @param {string} value
 * @returns {{ type: string, id: string } | null}
 */
export function parseCard(value) {
  const m = value.trim().match(/^(\S+)\s+(\S.*)$/);
  return m ? { type: m[1], id: m[2].trim() } : null;
}

/**
 * The people a text mentions: `@` followed by a person's id, ref or name (case-insensitive), ending
 * at a character that cannot continue a name. Longer names are tried first, so `@Ada Lovelace` is
 * Ada Lovelace and not someone named Ada.
 * @param {string} text
 * @param {ReadonlyArray<{ id: string, name: string, ref?: string }>} people
 * @returns {string[]} the ids, each once, in the order of the people list
 */
export function parseMentions(text, people) {
  if (typeof text !== "string" || !text.includes("@")) return [];
  const lower = text.toLowerCase();
  /** @type {Array<{ token: string, id: string }>} */
  const tokens = [];
  for (const p of people) {
    for (const t of [p.id, p.ref, p.name]) if (typeof t === "string" && t.trim()) tokens.push({ token: t.trim().toLowerCase(), id: p.id });
  }
  tokens.sort((a, b) => b.token.length - a.token.length);
  /** @type {Set<string>} */
  const found = new Set();
  let at = lower.indexOf("@");
  while (at !== -1) {
    // an @ inside a word (an address) is not a mention
    const before = at > 0 ? lower[at - 1] : "";
    if (!before || !/[a-z0-9._-]/.test(before)) {
      for (const { token, id } of tokens) {
        if (!lower.startsWith(token, at + 1)) continue;
        const next = lower[at + 1 + token.length] ?? "";
        if (next && /[a-z0-9_-]/.test(next)) continue;
        found.add(id);
        break;
      }
    }
    at = lower.indexOf("@", at + 1);
  }
  return people.map((p) => p.id).filter((id, i, all) => found.has(id) && all.indexOf(id) === i);
}

/**
 * @typedef {{ key: string, value: string }} Trailer
 * @typedef {{ id: string, cursor: string, ts: string, text: string, thread?: string, via?: string,
 *   author: { id?: string, name: string, kind: string, ref?: string }, trailers?: Trailer[],
 *   attachments?: Array<{ id: string, digest: string, name: string, kind: string, mimetype?: string, size: number }>,
 *   purged?: unknown }} IndexedMessage
 * @typedef {{ id: string, cursor: string, ts: string, act: string, target: string, text?: string,
 *   author: { id?: string, name: string, kind: string, ref?: string }, via?: string }} IndexedAnnotation
 * @typedef {{ id: string, seq: number, cursor: string, ts: string, author: { name: string, kind: string, ref?: string },
 *   waiting: string[], cards: Array<{ type: string, id: string }> }} ThreadLine
 * @typedef {{ root: IndexedMessage, rootAnnotations: IndexedAnnotation[], lines: ThreadLine[], lastSeq: number }} ThreadRow
 */

/**
 * @typedef {ReturnType<typeof makeStore>} KitStore
 */

/**
 * Open (creating, and migrating up to this build's schema) `kit.sqlite` under `storeDir`, and the
 * `thumbs/` directory beside it. A database written by a newer build is refused, never downgraded.
 * @param {string} storeDir
 */
export async function openKitStore(storeDir) {
  if (typeof storeDir !== "string" || !storeDir) throw new TypeError("openKitStore takes the store directory");
  mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  mkdirSync(path.join(storeDir, "thumbs"), { recursive: true, mode: 0o700 });
  const { Database } = await import("bun:sqlite");
  const db = new Database(path.join(storeDir, "kit.sqlite"), { create: true });
  try {
    db.exec("pragma journal_mode = wal; pragma busy_timeout = 5000; pragma foreign_keys = on;");
    const version = Number(db.query("pragma user_version").get()?.user_version ?? 0);
    if (version > KIT_SCHEMA_VERSION) throw new Error(`kit.sqlite is schema ${version}, newer than this kit's ${KIT_SCHEMA_VERSION}; refusing to open it`);
    for (let v = version; v < KIT_SCHEMA_VERSION; v++) {
      db.transaction(() => {
        db.exec(MIGRATIONS[v]);
        db.exec(`pragma user_version = ${v + 1}`);
      })();
    }
  } catch (e) {
    db.close();
    throw e;
  }
  return makeStore(db, storeDir);
}

/**
 * @param {import("bun:sqlite").Database} db @param {string} storeDir
 */
function makeStore(db, storeDir) {
  const now = () => new Date().toISOString();
  /** @param {string} key */
  const getMeta = (key) => /** @type {{ value: string } | null} */ (db.query("select value from meta where key = ?").get(key))?.value ?? null;
  /** @param {string} key @param {string | null} value */
  const setMeta = (key, value) => {
    if (value === null) db.run("delete from meta where key = ?", key);
    else db.run("insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value", key, value);
  };

  const insertMessage = db.prepare(`insert or ignore into messages
    (id, seq, cursor, ts, thread, author_kind, author_name, author_ref, via, json) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertTrailer = db.prepare("insert into message_trailers (id, key, value) values (?, ?, ?)");
  const insertContext = db.prepare("insert into message_context (id, k, v) values (?, ?, ?)");
  const insertMention = db.prepare("insert into mentions (id, person) values (?, ?)");
  const insertFile = db.prepare("insert into message_files (message, attachment, digest, name, kind, mimetype, size) values (?, ?, ?, ?, ?, ?, ?)");
  const insertFts = db.prepare("insert into message_fts (id, thread, text, files) values (?, ?, ?, ?)");
  const insertAnnotation = db.prepare("insert or ignore into annotations (id, seq, cursor, target, act, json) values (?, ?, ?, ?, ?, ?)");
  const prepared = [insertMessage, insertTrailer, insertContext, insertMention, insertFile, insertFts, insertAnnotation];

  const putMessage = db.transaction(/** @param {IndexedMessage} m @param {string[]} mentioned */ (m, mentioned) => {
    const at = parseCursor(m.cursor);
    if (!at) return false;
    const thread = typeof m.thread === "string" ? m.thread : null;
    const r = insertMessage.run(m.id, at.seq, m.cursor, m.ts, thread, m.author.kind, m.author.name, m.author.ref ?? null, m.via ?? null, JSON.stringify(m));
    if (!r.changes) return false;
    for (const t of m.trailers ?? []) {
      if (!KIT_TRAILER_KEYS.includes(t.key)) continue;
      insertTrailer.run(m.id, t.key, t.value);
      if (t.key === "context") for (const [k, v] of parseContext(t.value)) insertContext.run(m.id, k, v);
    }
    for (const person of mentioned) insertMention.run(m.id, person);
    const files = [];
    for (const a of m.attachments ?? []) {
      if (!a || typeof a.id !== "string") continue;
      insertFile.run(m.id, a.id, a.digest, a.name, a.kind, a.mimetype ?? null, a.size ?? null);
      files.push(a.name);
    }
    if (!m.purged && (m.text || files.length)) insertFts.run(m.id, thread ?? m.id, m.text ?? "", files.join("\n"));
    return true;
  });

  const putAnnotation = db.transaction(/** @param {IndexedAnnotation} a */ (a) => {
    const at = parseCursor(a.cursor);
    if (!at) return false;
    const r = insertAnnotation.run(a.id, at.seq, a.cursor, a.target, a.act, JSON.stringify(a));
    if (!r.changes) return false;
    const target = /** @type {{ withdrawn: number, thread: string | null } | null} */ (db.query("select withdrawn, thread from messages where id = ?").get(a.target));
    if (!target) return true;
    if (a.act === "withdraw") {
      db.run("update messages set withdrawn = 1 where id = ?", a.target);
      db.run("delete from message_fts where id = ?", a.target);
    } else if (a.act === "edit" && !target.withdrawn && typeof a.text === "string") {
      const files = /** @type {Array<{ name: string }>} */ (db.query("select name from message_files where message = ?").all(a.target)).map((f) => f.name);
      db.run("delete from message_fts where id = ?", a.target);
      insertFts.run(a.target, target.thread ?? a.target, a.text, files.join("\n"));
    }
    return true;
  });

  /** @param {string} id @returns {IndexedMessage | null} */
  const messageJson = (id) => {
    const row = /** @type {{ json: string } | null} */ (db.query("select json from messages where id = ?").get(id));
    return row ? JSON.parse(row.json) : null;
  };
  /** @param {string[]} ids @returns {IndexedAnnotation[]} */
  const annotationsFor = (ids) => {
    if (!ids.length) return [];
    const marks = ids.map(() => "?").join(",");
    return /** @type {Array<{ json: string }>} */ (db.query(`select json from annotations where target in (${marks}) order by seq`).all(...ids)).map((r) => JSON.parse(r.json));
  };

  return {
    /** The directory the store lives in; `thumbs/` is beside `kit.sqlite`. */
    dir: storeDir,
    thumbsDir: path.join(storeDir, "thumbs"),
    /** The database, for the kit's other modules (search, reactions); never for the host. */
    db,

    // ---- the index ----

    /** The room epoch the index was built from, and the last record it covers. */
    indexState() {
      return { epoch: getMeta("index_epoch"), through: getMeta("index_through") };
    },
    /**
     * Drop the index and start it again for a room epoch. What is kept (positions, reactions,
     * thumbs, and push's own tables) stays.
     * @param {string} epoch
     */
    resetIndex(epoch) {
      db.transaction(() => {
        for (const t of ["messages", "annotations", "message_trailers", "message_context", "mentions", "message_files", "message_fts"]) db.run(`delete from ${t}`);
        setMeta("index_epoch", epoch);
        setMeta("index_through", null);
      })();
    },
    /** @param {string} cursor */
    setThrough(cursor) {
      const at = parseCursor(cursor);
      const have = parseCursor(getMeta("index_through"));
      if (!at || (have && have.epoch === at.epoch && have.seq >= at.seq)) return;
      setMeta("index_through", cursor);
    },
    /**
     * Record a message as the room delivered it, with the people it mentions. A message already
     * indexed is left as it is. Returns whether it was new.
     * @param {IndexedMessage} m @param {string[]} [mentioned]
     */
    putMessage(m, mentioned = []) {
      return putMessage(m, mentioned);
    },
    /**
     * Record an annotation; a withdrawal takes its target out of search, an edit replaces its
     * searchable text. Returns whether it was new.
     * @param {IndexedAnnotation} a
     */
    putAnnotation(a) {
      return putAnnotation(a);
    },
    /**
     * Take messages out of the index's text: search forgets them and their stored text is removed
     * (a purge). Their ids, positions and thread membership stay.
     * @param {string[]} ids
     */
    forgetText(ids) {
      db.transaction(() => {
        for (const id of ids) {
          db.run("delete from message_fts where id = ?", id);
          const m = messageJson(id);
          if (m) {
            const { text: _text, ...rest } = m;
            db.run("update messages set json = ? where id = ?", JSON.stringify({ ...rest, text: "", purged: true }), id);
          }
          db.run("update annotations set json = json_remove(json, '$.text') where target = ?", id);
        }
      })();
    },
    /**
     * The thread a message belongs to: its root's id (itself for a top-level message), or
     * undefined when the index has not seen it.
     * @param {string} id
     * @returns {string | undefined}
     */
    threadOf(id) {
      const row = /** @type {{ thread: string | null } | null} */ (db.query("select thread from messages where id = ?").get(id));
      return row ? (row.thread ?? id) : undefined;
    },
    /**
     * The refs of everyone who has posted in a thread (`author.ref`), each once.
     * @param {string} root @returns {string[]}
     */
    threadAuthorRefs(root) {
      return /** @type {Array<{ author_ref: string }>} */ (db.query("select distinct author_ref from messages where (id = ? or thread = ?) and author_ref is not null").all(root, root)).map((r) => r.author_ref);
    },
    /** @param {string} id */
    message(id) {
      const m = messageJson(id);
      return m ? { message: m, annotations: annotationsFor([id]) } : null;
    },
    /**
     * The thread list's rows, newest activity first: each root with its annotations, and every
     * line of the thread reduced to what the list needs (who, when, the waiting and card trailers).
     *
     * `mine` keeps the threads the person posted in (by `author.ref`), is mentioned in, or that a
     * `waiting:` names them in. (A waiting that no longer stands has been answered by the person's
     * own post, so the thread is theirs either way.) `context` keeps the threads with a message
     * whose `context:` trailer carries every pair given. `beforeSeq` keeps threads whose latest
     * record is before that sequence.
     * @param {{ me: { id: string, ref: string }, scope?: 'all' | 'mine', context?: Array<[string, string]>, beforeSeq?: number | null, limit?: number }} q
     * @returns {ThreadRow[]}
     */
    threadRows(q) {
      const limit = Math.max(1, Math.min(q.limit ?? 50, 200));
      /** @type {string[]} */
      const where = ["r.thread is null"];
      /** @type {Array<string | number>} */
      const params = [];
      if (q.scope === "mine") {
        where.push(`r.id in (
          select coalesce(thread, id) from messages where author_ref = ?
          union select coalesce(m.thread, m.id) from mentions x join messages m on m.id = x.id where x.person = ?
          union select coalesce(m.thread, m.id) from message_trailers t join messages m on m.id = t.id where t.key = 'waiting' and t.value = ?)`);
        params.push(q.me.ref, q.me.id, q.me.id);
      }
      for (const [k, v] of q.context ?? []) {
        where.push("r.id in (select coalesce(m.thread, m.id) from message_context c join messages m on m.id = c.id where c.k = ? and c.v = ?)");
        params.push(k, v);
      }
      let having = "";
      if (typeof q.beforeSeq === "number") {
        having = "having last_seq < ?";
        params.push(q.beforeSeq);
      }
      const roots = /** @type {Array<{ id: string, json: string, last_seq: number }>} */ (db.query(`
        select r.id as id, r.json as json, max(m.seq) as last_seq
        from messages r join messages m on (m.id = r.id or m.thread = r.id)
        where ${where.join(" and ")}
        group by r.id ${having} order by last_seq desc limit ${limit}`).all(...params));
      return roots.map((r) => {
        const lines = /** @type {Array<{ id: string, seq: number, cursor: string, ts: string, author_name: string, author_kind: string, author_ref: string | null }>} */ (
          db.query("select id, seq, cursor, ts, author_name, author_kind, author_ref from messages where id = ? or thread = ? order by seq").all(r.id, r.id));
        const trailers = /** @type {Array<{ id: string, key: string, value: string }>} */ (db.query(`
          select t.id, t.key, t.value from message_trailers t join messages m on m.id = t.id
          where (m.id = ? or m.thread = ?) and t.key in ('waiting', 'card')`).all(r.id, r.id));
        return {
          root: JSON.parse(r.json),
          rootAnnotations: annotationsFor([r.id]),
          lastSeq: r.last_seq,
          lines: lines.map((l) => ({
            id: l.id, seq: l.seq, cursor: l.cursor, ts: l.ts,
            author: { name: l.author_name, kind: l.author_kind, ...(l.author_ref ? { ref: l.author_ref } : {}) },
            waiting: trailers.filter((t) => t.id === l.id && t.key === "waiting").map((t) => t.value.trim()),
            cards: trailers.filter((t) => t.id === l.id && t.key === "card").map((t) => parseCard(t.value)).filter((c) => c !== null),
          })),
        };
      });
    },

    // ---- read positions (kept) ----

    /**
     * Move a person's position in a thread (`main` for the whole room) forward. A position never
     * moves back within an epoch; a cursor of another epoch replaces it.
     * @param {string} person @param {string} thread @param {string} cursor
     * @returns {boolean} whether the cursor was a native cursor
     */
    setPosition(person, thread, cursor) {
      const at = parseCursor(cursor);
      if (!at) return false;
      db.run(`insert into positions (person, thread, cursor, epoch, seq, at) values (?, ?, ?, ?, ?, ?)
        on conflict(person, thread) do update set cursor = excluded.cursor, epoch = excluded.epoch, seq = excluded.seq, at = excluded.at
        where positions.epoch <> excluded.epoch or excluded.seq > positions.seq`, person, thread, cursor, at.epoch, at.seq, now());
      return true;
    },
    /** @param {string} person @param {string} thread @returns {{ cursor: string, epoch: string, seq: number } | null} */
    position(person, thread) {
      return /** @type {any} */ (db.query("select cursor, epoch, seq from positions where person = ? and thread = ?").get(person, thread));
    },

    // ---- reactions and thumbnails (kept; the routes are the extension's) ----

    /** @param {string} target @param {string} name @param {string} person @param {boolean} on */
    setReaction(target, name, person, on) {
      if (on) db.run("insert or ignore into reactions (target, name, person, at) values (?, ?, ?, ?)", target, name, person, now());
      else db.run("delete from reactions where target = ? and name = ? and person = ?", target, name, person);
    },
    /** @param {string} digest @param {string} file a path under `thumbsDir` */
    putThumb(digest, file) {
      db.run("insert into thumbs (digest, path, created) values (?, ?, ?) on conflict(digest) do update set path = excluded.path", digest, file, now());
    },
    /** @param {string} digest @returns {string | null} */
    thumb(digest) {
      return /** @type {{ path: string } | null} */ (db.query("select path from thumbs where digest = ?").get(digest))?.path ?? null;
    },

    close() {
      // a statement left open holds the file on Windows after the database closes
      for (const st of prepared) {
        try { st.finalize(); } catch { /* already finalized */ }
      }
      db.clearQueryCache();
      db.close();
    },
  };
}
