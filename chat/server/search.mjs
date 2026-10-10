// @ts-check
/**
 * Search, and what keeps the index it reads honest.
 *
 * `GET /chat/search?q=&scope=messages|files&context=<k>=<v>&limit=` runs FTS5 over the kit's index:
 * `messages` matches the words of a message (its latest edit), `files` the names of its files. Every
 * word of `q` must match, each as a prefix. A hit is `{ message, snippet }`: the message folded as
 * the browser gets it, and a plain-text excerpt around the match (no markup; the client escapes and
 * highlights). `context` keeps hits whose thread carries every pair, as the thread list does.
 * `coverage.through` is the last record the index holds, so a reader knows what the answer covers.
 * A hit in a thread the person may not read (`authorize(person, "read", { thread })`) is left out.
 *
 * The index forgets at once:
 * - `forgetPurge` takes purged messages' text out of the index (search, the thread list's lines),
 *   and removes a thumbnail no remaining message references; the room's follow calls it for every
 *   purge record, whoever appended it, and `POST /chat/purge` calls it on its own receipt;
 * - `reindexEdit` reads an edited message's trailers (`card`, `waiting`, `context`, `re`) and
 *   mentions again off its new text, so the thread list's waiting markers, `scope=mine` and the
 *   context filter follow the edit. (The searchable text itself is replaced by the store.)
 */

import { KIT_TRAILER_KEYS, parseContext, parseMentions } from "./store.mjs";
import { dropThumbsUnreferenced, once } from "./uploads.mjs";

/** How many hits a search answers when it is not told, and at most. */
const SEARCH_LIMIT = 50;
const SEARCH_MAX = 200;
/** The longest query the route takes. */
const QUERY_MAX = 200;
/** The most words of a query that are matched. */
const WORDS_MAX = 16;

/** A message that still has its words: neither withdrawn nor purged. Over `messages m`. */
export const LIVE_MESSAGE = "m.withdrawn = 0 and json_extract(m.json, '$.purged') is null";

/**
 * The FTS5 expression for a query: every word, quoted, as a prefix, in the given column. Null when
 * the query has no word.
 * @param {string} q @param {'text' | 'files'} column
 * @returns {string | null}
 */
export function ftsQuery(q, column) {
  const words = (q.match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, WORDS_MAX);
  if (!words.length) return null;
  return words.map((w) => `${column} : "${w.replaceAll('"', '""')}" *`).join(" AND ");
}

/**
 * @param {Request} req @param {import("./index.mjs").Person} person @param {import("./index.mjs").ChatKit} kit
 * @returns {Promise<Response>}
 */
export async function handleSearch(req, person, kit) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  if (!q.trim() || q.length > QUERY_MAX) return kit.fail(400, "BAD_REQUEST", `q is 1 to ${QUERY_MAX} characters.`);
  const scope = url.searchParams.get("scope") ?? "messages";
  if (scope !== "messages" && scope !== "files") return kit.fail(400, "BAD_REQUEST", "scope is messages or files.");
  /** @type {Array<[string, string]>} */
  const context = [];
  for (const c of url.searchParams.getAll("context")) {
    const at = c.indexOf("=");
    if (at <= 0 || at === c.length - 1) return kit.fail(400, "BAD_REQUEST", "context is <key>=<value>.");
    context.push([c.slice(0, at).trim(), c.slice(at + 1).trim()]);
  }
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw === null ? SEARCH_LIMIT : Number(limitRaw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SEARCH_MAX) return kit.fail(400, "BAD_REQUEST", `limit is 1 to ${SEARCH_MAX}.`);
  if (!kit.hooks.authorize(person, "read", { search: true })) return kit.fail(403, "FORBIDDEN", "You cannot do that here.");

  const through = kit.store.indexState().through;
  const column = scope === "files" ? "files" : "text";
  const match = ftsQuery(q, column);
  if (!match) return kit.json(200, { ok: true, data: { hits: [], coverage: { through } } });
  /** @type {string[]} */
  const where = ["message_fts match ?", LIVE_MESSAGE];
  /** @type {Array<string | number>} */
  const params = [match];
  for (const [k, v] of context) {
    where.push("coalesce(m.thread, m.id) in (select coalesce(x.thread, x.id) from message_context c join messages x on x.id = c.id where c.k = ? and c.v = ?)");
    params.push(k, v);
  }
  const col = column === "files" ? 3 : 2;
  /** @type {Array<{ id: string, thread: string | null, snippet: string }>} */
  let rows;
  try {
    // read past the limit: a hit the person may not read is dropped after the query
    rows = /** @type {any} */ (once(kit.store.db, `
      select m.id as id, m.thread as thread, snippet(message_fts, ${col}, '', '', '…', 16) as snippet
      from message_fts join messages m on m.id = message_fts.id
      where ${where.join(" and ")} order by rank limit ${Math.min(limit * 4, 1000)}`, (st) => st.all(...params)));
  } catch (e) {
    kit.log(`chat: a search failed: ${e instanceof Error ? e.message : String(e)}`);
    return kit.fail(400, "BAD_REQUEST", "The search could not be read.");
  }
  /** @type {Array<{ message: Record<string, any>, snippet: string }>} */
  const hits = [];
  /** @type {Map<string, boolean>} */
  const readable = new Map();
  for (const r of rows) {
    const thread = r.thread ?? r.id;
    let may = readable.get(thread);
    if (may === undefined) readable.set(thread, may = kit.hooks.authorize(person, "read", { thread }));
    if (!may) continue;
    const got = kit.store.message(r.id);
    if (!got) continue;
    const message = kit.toBrowser(kit.room.fold([/** @type {any} */ (got.message)], /** @type {any} */ (got.annotations))[0]);
    hits.push({ message, snippet: r.snippet });
    if (hits.length >= limit) break;
  }
  return kit.json(200, { ok: true, data: { hits, coverage: { through } } });
}

/**
 * A purge reaches the index: the messages' text leaves search and the thread list at once, and a
 * thumbnail only they referenced is removed. Idempotent: the follow and the purge route may both call it.
 * @param {import("./store.mjs").KitStore} store @param {readonly string[]} ids @param {(line: string) => void} log
 */
export function forgetPurge(store, ids, log) {
  if (!ids.length) return;
  try {
    const marks = ids.map(() => "?").join(",");
    const digests = /** @type {Array<{ digest: string }>} */ (once(store.db, `select distinct digest from message_files where message in (${marks})`, (st) => st.all(...ids))).map((r) => r.digest);
    store.forgetText([...ids]);
    dropThumbsUnreferenced(store, digests, log);
  } catch (e) {
    log(`chat: a purge did not reach the index: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * An edit reaches the index's trailers and mentions: they are read again off the message as now
 * folded. A withdrawn or purged message keeps what it had (it shows no text either way).
 * @param {import("./store.mjs").KitStore} store
 * @param {(messages: any[], annotations: any[]) => any[]} fold
 * @param {{ act: string, target: string, text?: string }} a
 * @param {ReadonlyArray<{ id: string, name: string, ref?: string }>} people
 * @returns {string[] | null} the people the edited text mentions, or null when nothing was re-read
 *   (never throws: a failure leaves the trailers the message had)
 */
export function reindexEdit(store, fold, a, people) {
  if (a.act !== "edit" || typeof a.text !== "string") return null;
  const got = store.message(a.target);
  if (!got || got.message.purged) return null;
  const [m] = fold([got.message], got.annotations);
  if (!m || m.withdrawn || typeof m.text !== "string") return null;
  const mentions = parseMentions(m.text, people);
  const db = store.db;
  try {
    db.transaction(() => {
      db.run("delete from message_trailers where id = ?", a.target);
      db.run("delete from message_context where id = ?", a.target);
      db.run("delete from mentions where id = ?", a.target);
      for (const t of /** @type {Array<{ key: string, value: string }>} */ (m.trailers ?? [])) {
        if (!KIT_TRAILER_KEYS.includes(t.key)) continue;
        db.run("insert into message_trailers (id, key, value) values (?, ?, ?)", a.target, t.key, t.value);
        if (t.key === "context") for (const [k, v] of parseContext(t.value)) db.run("insert into message_context (id, k, v) values (?, ?, ?)", a.target, k, v);
      }
      for (const p of mentions) db.run("insert into mentions (id, person) values (?, ?)", a.target, p);
    })();
  } catch { return null; }
  return mentions;
}
