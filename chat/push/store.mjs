// @ts-check
/**
 * Push's tables in the kit store. The kit store (`kit.sqlite` under the host's `storeDir`) belongs
 * to the server half; push keeps its own tables in it and touches nothing else, through this one
 * narrow interface:
 *
 * - the tables are all named `push_*` and the schema version is push's own row in `push_meta`, so
 *   the store's other migrations and push's never step on each other;
 * - `openPushStore({ db })` takes the store's open `bun:sqlite` Database, or `openPushStore({ storeDir })`
 *   opens `kit.sqlite` itself (the probe does, from its own process), in WAL mode with a busy
 *   timeout so the two connections share the file.
 *
 * What lives here: subscriptions (not rebuildable from the room), prefs (likewise), and every push
 * sent with the push service's answer and the user agent's acknowledgement, which is the probe's
 * record and the evidence a push arrived.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";

export const PUSH_SCHEMA_VERSION = 1;

/**
 * The subset of bun:sqlite's Database push uses.
 * @typedef {{
 *   exec(sql: string): void,
 *   query(sql: string): { run(...args: any[]): unknown, get(...args: any[]): any, all(...args: any[]): any[] },
 *   close(): void,
 * }} SqliteDatabase
 */

/** @typedef {{ endpoint: string, person: string, p256dh: string, auth: string, createdAt: string }} StoredSubscription */
/** @typedef {{ notify: { mentions: boolean, asks: boolean, mine: boolean, all: boolean }, lockScreen: 'title-line' | 'generic' }} PushPrefs */
/**
 * @typedef {{
 *   id: string, person: string, endpoint: string, kind: 'message' | 'test' | 'probe',
 *   run: string | null, seq: number | null, sentAt: string,
 *   status: number | null, answer: string | null, ackedAt: string | null, clickedAt: string | null,
 * }} SentRecord
 */

/** @type {PushPrefs} */
export const DEFAULT_PREFS = Object.freeze({ notify: Object.freeze({ mentions: true, asks: true, mine: true, all: false }), lockScreen: "title-line" });

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS push_subscriptions (
     endpoint TEXT PRIMARY KEY,
     person TEXT NOT NULL,
     p256dh TEXT NOT NULL,
     auth TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS push_subscriptions_person ON push_subscriptions(person);
   CREATE TABLE IF NOT EXISTS push_prefs (person TEXT PRIMARY KEY, prefs TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS push_sent (
     id TEXT PRIMARY KEY,
     person TEXT NOT NULL,
     endpoint TEXT NOT NULL,
     kind TEXT NOT NULL,
     run TEXT,
     seq INTEGER,
     sent_at TEXT NOT NULL,
     status INTEGER,
     answer TEXT,
     acked_at TEXT,
     clicked_at TEXT
   );
   CREATE INDEX IF NOT EXISTS push_sent_run ON push_sent(run, person);`,
];

/** @param {string} storeDir @returns {Promise<SqliteDatabase>} */
async function openDatabase(storeDir) {
  await mkdir(storeDir, { recursive: true });
  // bun:sqlite by name held in a variable: the kit is type-checked against Node's types, where the
  // module has none, and it is only ever loaded under Bun
  const spec = "bun:sqlite";
  const { Database } = await import(spec);
  const db = new Database(path.join(storeDir, "kit.sqlite"), { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  return db;
}

/**
 * @param {{ db: SqliteDatabase } | { storeDir: string }} where
 */
export async function openPushStore(where) {
  const owned = !("db" in where);
  const db = "db" in where ? where.db : await openDatabase(where.storeDir);
  db.exec("CREATE TABLE IF NOT EXISTS push_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const row = db.query("SELECT value FROM push_meta WHERE key = 'schema'").get();
  const at = row ? Number(row.value) : 0;
  if (at > PUSH_SCHEMA_VERSION) throw new Error(`push-schema-newer: the store is at ${at}, this kit knows ${PUSH_SCHEMA_VERSION}`);
  for (let v = at; v < PUSH_SCHEMA_VERSION; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      db.query("INSERT INTO push_meta (key, value) VALUES ('schema', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(v + 1));
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  const now = () => new Date().toISOString();

  /** @param {any} r @returns {SentRecord} */
  const sent = (r) => ({ id: r.id, person: r.person, endpoint: r.endpoint, kind: r.kind, run: r.run, seq: r.seq, sentAt: r.sent_at,
    status: r.status, answer: r.answer, ackedAt: r.acked_at, clickedAt: r.clicked_at });

  return {
    /** @param {string} person @param {{ endpoint: string, p256dh: string, auth: string }} sub */
    saveSubscription(person, sub) {
      // an endpoint is one browser profile's; re-subscribing it under another person moves it
      db.query(`INSERT INTO push_subscriptions (endpoint, person, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET person = excluded.person, p256dh = excluded.p256dh, auth = excluded.auth`)
        .run(sub.endpoint, person, sub.p256dh, sub.auth, now());
    },
    /** @param {string} endpoint @param {string} [person] only that person's @returns {boolean} */
    removeSubscription(endpoint, person) {
      const before = db.query("SELECT 1 AS x FROM push_subscriptions WHERE endpoint = ?").get(endpoint);
      if (person === undefined) db.query("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
      else db.query("DELETE FROM push_subscriptions WHERE endpoint = ? AND person = ?").run(endpoint, person);
      const after = db.query("SELECT 1 AS x FROM push_subscriptions WHERE endpoint = ?").get(endpoint);
      return Boolean(before) && !after;
    },
    /** @param {string} person @returns {StoredSubscription[]} */
    subscriptionsOf(person) {
      return db.query("SELECT endpoint, person, p256dh, auth, created_at FROM push_subscriptions WHERE person = ? ORDER BY created_at")
        .all(person).map((r) => ({ endpoint: r.endpoint, person: r.person, p256dh: r.p256dh, auth: r.auth, createdAt: r.created_at }));
    },
    /** @param {string} person @returns {PushPrefs} */
    prefsOf(person) {
      const r = db.query("SELECT prefs FROM push_prefs WHERE person = ?").get(person);
      if (!r) return { notify: { ...DEFAULT_PREFS.notify }, lockScreen: DEFAULT_PREFS.lockScreen };
      const p = JSON.parse(r.prefs);
      return { notify: { ...DEFAULT_PREFS.notify, ...p.notify }, lockScreen: p.lockScreen ?? DEFAULT_PREFS.lockScreen };
    },
    /** @param {string} person @param {PushPrefs} prefs */
    savePrefs(person, prefs) {
      db.query("INSERT INTO push_prefs (person, prefs) VALUES (?, ?) ON CONFLICT(person) DO UPDATE SET prefs = excluded.prefs")
        .run(person, JSON.stringify(prefs));
    },
    /** @param {{ id: string, person: string, endpoint: string, kind: SentRecord['kind'], run?: string | null, seq?: number | null }} r */
    recordSent(r) {
      db.query("INSERT INTO push_sent (id, person, endpoint, kind, run, seq, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(r.id, r.person, r.endpoint, r.kind, r.run ?? null, r.seq ?? null, now());
    },
    /** @param {string} id @param {number | null} status @param {string} answer */
    recordAnswer(id, status, answer) {
      db.query("UPDATE push_sent SET status = ?, answer = ? WHERE id = ?").run(status, answer.slice(0, 500), id);
    },
    /**
     * The user agent's receipt. Only the person the push was sent to can acknowledge it; the first
     * receipt of each kind stands.
     * @param {string} id @param {string} person @param {'shown' | 'clicked'} event @returns {boolean}
     */
    recordAck(id, person, event) {
      const col = event === "clicked" ? "clicked_at" : "acked_at";
      const r = db.query(`SELECT ${col} AS at FROM push_sent WHERE id = ? AND person = ?`).get(id, person);
      if (!r) return false;
      if (!r.at) db.query(`UPDATE push_sent SET ${col} = ? WHERE id = ?`).run(now(), id);
      // a click is also proof it was shown
      if (event === "clicked") db.query("UPDATE push_sent SET acked_at = COALESCE(acked_at, ?) WHERE id = ?").run(now(), id);
      return true;
    },
    /** @param {string} id @returns {SentRecord | null} */
    sentRecord(id) {
      const r = db.query("SELECT * FROM push_sent WHERE id = ?").get(id);
      return r ? sent(r) : null;
    },
    /** @param {string} run @returns {SentRecord[]} */
    runRecords(run) {
      return db.query("SELECT * FROM push_sent WHERE run = ? ORDER BY seq, person").all(run).map(sent);
    },
    /** @param {string} person @param {number} [limit] @returns {SentRecord[]} a person's pushes, newest first */
    recentSent(person, limit = 20) {
      return db.query("SELECT * FROM push_sent WHERE person = ? ORDER BY sent_at DESC, rowid DESC LIMIT ?").all(person, limit).map(sent);
    },
    /** @returns {string[]} every probe run, newest first */
    probeRuns() {
      return db.query("SELECT run, MAX(sent_at) AS at FROM push_sent WHERE kind = 'probe' AND run IS NOT NULL GROUP BY run ORDER BY at DESC")
        .all().map((r) => r.run);
    },
    /** @param {string} run @returns {number} the next sequence number of a run */
    nextSeq(run) {
      const r = db.query("SELECT MAX(seq) AS seq FROM push_sent WHERE run = ?").get(run);
      return (r && r.seq != null ? Number(r.seq) : 0) + 1;
    },
    close() {
      if (owned) db.close();
    },
  };
}

/** @typedef {Awaited<ReturnType<typeof openPushStore>>} PushStore */
