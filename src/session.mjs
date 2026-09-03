// @ts-check
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgoraError, EXIT, readCursorFile, writeCursor } from "./core.mjs";

/**
 * A session is the unit of state: one running agent, on one machine, for as long as it lives.
 * The tool has no session of its own (each command is a fresh process), so the key is READ from
 * the environment the harness already injects, never established by the tool:
 *   AGORA_SESSION                      an explicit label; must match SESSION_RE or the call is a usage error
 *   the first set variable in session.from   e.g. CLAUDE_CODE_SESSION_ID; a value that fails SESSION_RE is skipped
 *   "default"                          when nothing is set: every such session shares one directory
 * The slug is a directory name under <state>/sessions/, so it is validated where it enters and
 * never sanitised where it is used. No bearer and no session string is ever part of a cursor filename.
 */

export const SESSION_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** A bearer is a path: model, then optionally what this session is for. `Fable`, `Fable/watch`, `Opus/design`. */
export const BEARER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,31})*$/;
export const BEARER_MAX = 64;
export const DEFAULT_SESSION_FROM = Object.freeze(["CLAUDE_CODE_SESSION_ID", "GROK_SESSION_ID"]);
const SECRET_NAME = /token|secret|password|apikey|api_key|bearer/i;
const LEDGER_MAX = 2000;
const LEDGER_KEEP = 1000;

/** @typedef {{ slug: string, source: string, explicit: boolean }} Session */
/** @typedef {{ name: string, source: string }} Bearer */

/** The variable name, lowercased, minus a trailing _session_id / _session / _id, with _ as -. @param {string} varName */
export function sessionTag(varName) {
  return varName.toLowerCase().replace(/_(session_id|session|id)$/, "").replace(/_/g, "-");
}

/**
 * @param {import('./core.mjs').Config} cfg
 * @param {NodeJS.ProcessEnv} env
 * @param {(line: string) => void} [warn]
 * @returns {Session}
 */
export function resolveSession(cfg, env, warn = () => {}) {
  const explicit = env.AGORA_SESSION;
  if (explicit !== undefined) {
    if (!SESSION_RE.test(explicit)) throw new AgoraError(`AGORA_SESSION must match ${SESSION_RE} (got ${JSON.stringify(explicit)})`, EXIT.usage);
    return { slug: explicit, source: "AGORA_SESSION", explicit: true };
  }
  const from = Array.isArray(cfg.session?.from) ? cfg.session.from.map(String) : [...DEFAULT_SESSION_FROM];
  for (const varName of from) {
    if (SECRET_NAME.test(varName)) {
      warn(`session.from names ${varName}, which looks like a credential; skipped`);
      continue;
    }
    const value = env[varName];
    if (value === undefined || value === "") continue;
    if (!SESSION_RE.test(value)) {
      warn(`${varName} is set but its value is not a session key (${SESSION_RE}); skipped`);
      continue;
    }
    return { slug: `${sessionTag(varName)}-${value}`, source: varName, explicit: false };
  }
  return { slug: "default", source: "default", explicit: false };
}

/** @param {string} stateRoot @param {Session} session */
export function sessionDir(stateRoot, session) {
  return path.join(stateRoot, "sessions", session.slug);
}

/** Every session that has state under this root, by slug. @param {string} stateRoot */
export async function listSessions(stateRoot) {
  try {
    const entries = await readdir(path.join(stateRoot, "sessions"), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

/**
 * --as on the call, then AGORA_ACTOR, then this session's record, then the shared config's actor.name.
 * @param {import('./core.mjs').Config} cfg
 * @param {{ as?: string, env: NodeJS.ProcessEnv, record?: { bearer: string } }} opts
 * @returns {Bearer}
 */
export function resolveBearer(cfg, { as, env, record }) {
  const pick =
    as !== undefined ? { name: as, source: "--as" }
    : env.AGORA_ACTOR !== undefined ? { name: env.AGORA_ACTOR, source: "AGORA_ACTOR" }
    : record ? { name: record.bearer, source: "session" }
    : { name: cfg.actor.name, source: "config" };
  const name = pick.name.trim();
  if (pick.source !== "config" && (!BEARER_RE.test(name) || name.length > BEARER_MAX))
    throw new AgoraError(`${pick.source} must be a bearer path like Fable or Fable/watch (letters, digits, . _ -; segments joined by /; at most ${BEARER_MAX} characters)`, EXIT.usage);
  return { name, source: pick.source };
}

/**
 * The saved position for this session. Absent in the session directory: seed once, read-only, from the
 * file of the same name at the state root (the single-session layout), and write it forward. A file
 * that exists but holds null (after `cursor --reset`) is a position, not an absence: it never seeds.
 * @param {string} dir the session directory
 * @param {string} legacyDir the state root
 * @param {string} key
 * @returns {Promise<{ cursor: string | undefined, seeded: boolean }>}
 */
export async function readCursorSeeded(dir, legacyDir, key) {
  const own = await readCursorFile(dir, key);
  if (own.exists) return { cursor: own.cursor, seeded: false };
  const legacy = await readCursorFile(legacyDir, key);
  if (!legacy.exists) return { cursor: undefined, seeded: false };
  await writeCursor(dir, key, legacy.cursor);
  return { cursor: legacy.cursor, seeded: true };
}

const ledgerPath = (/** @type {string} */ dir) => path.join(dir, "posted.jsonl");

/** Record a message this session posted. Append-only; kept to the last LEDGER_KEEP ids once it passes LEDGER_MAX. @param {string} dir @param {string} id */
export async function appendPosted(dir, id) {
  await mkdir(dir, { recursive: true });
  const file = ledgerPath(dir);
  await appendFile(file, JSON.stringify({ id, pid: process.pid, at: new Date().toISOString() }) + "\n", "utf8");
  const lines = (await readFile(file, "utf8")).split(/\r?\n/).filter((l) => l.trim());
  if (lines.length > LEDGER_MAX) await writeFile(file, lines.slice(-LEDGER_KEEP).join("\n") + "\n", "utf8");
}

/** The ids this session posted. @param {string} dir */
export async function readPosted(dir) {
  const out = new Set();
  let raw;
  try {
    raw = await readFile(ledgerPath(dir), "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (typeof rec.id === "string") out.add(rec.id);
    } catch {
      /* a torn line is not an id */
    }
  }
  return out;
}

/** How many distinct processes posted from this session. @param {string} dir */
export async function postedPids(dir) {
  const pids = new Set();
  try {
    for (const line of (await readFile(ledgerPath(dir), "utf8")).split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        pids.add(JSON.parse(line).pid);
      } catch {
        /* skip */
      }
    }
  } catch {
    /* no ledger */
  }
  return pids;
}

/** @param {string} slug */
export function shortSlug(slug) {
  return slug.length > 28 ? `${slug.slice(0, 27)}…` : slug;
}

/**
 * The one line every post and watch prints to stderr: who this process is and where that came from.
 * With the key at "default" and other sessions present, it is a warning, because every default session
 * shares one position.
 * @param {Bearer} bearer @param {Session} session @param {string} stateRoot
 */
export async function identityLine(bearer, session, stateRoot) {
  let line = `agora: ${bearer.name} (from ${bearer.source}) · session ${shortSlug(session.slug)} (from ${session.source})`;
  if (session.slug === "default") {
    const others = (await listSessions(stateRoot)).filter((s) => s !== "default");
    if (others.length) line += `\nagora: WARNING session key is "default" and ${others.length} other session${others.length === 1 ? " has" : "s have"} state here; set AGORA_SESSION so this session keeps its own position`;
  }
  return line;
}

/** @param {string} stateRoot */
export function hasLegacyState(stateRoot) {
  return existsSync(stateRoot);
}

/**
 * The session record: who this session is, written once by `session --as` and touched on every
 * later call. It is the one registry of sessions on a seat; liveness is derived from it, never
 * kept anywhere else.
 * @typedef {object} SessionRecord
 * @property {string} slug
 * @property {string} source
 * @property {string} [label]
 * @property {string} bearer
 * @property {number} [pid]
 * @property {string} [pidSource]
 * @property {number} bootEpoch
 * @property {string} startedAt
 * @property {string} lastSeen
 */

export const DEFAULT_PID_FROM = Object.freeze(["AGORA_SESSION_PID", "CLAUDE_PID"]);
const recordPath = (/** @type {string} */ dir) => path.join(dir, "session.json");

/** Seconds since the epoch at which this machine booted; a pid is meaningless across a reboot. */
export function bootEpoch() {
  return Math.round(Date.now() / 1000 - os.uptime());
}

/**
 * The process that outlives this command: the harness, named by the first set variable in
 * `session.pidFrom`. The command's own pid is a fresh one every call and is never used.
 * @param {import('./core.mjs').Config} cfg @param {NodeJS.ProcessEnv} env
 */
export function harnessPid(cfg, env) {
  const from = Array.isArray(cfg.session?.pidFrom) ? cfg.session.pidFrom.map(String) : [...DEFAULT_PID_FROM];
  for (const name of from) {
    const v = Number(env[name]);
    if (Number.isInteger(v) && v > 0) return { pid: v, pidSource: name };
  }
  return { pid: undefined, pidSource: undefined };
}

/** @param {string} dir @returns {Promise<SessionRecord | undefined>} */
export async function readRecord(dir) {
  try {
    const rec = JSON.parse(await readFile(recordPath(dir), "utf8"));
    return rec && typeof rec.bearer === "string" ? rec : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write or update this session's record (idempotent). `bearer` and `label` replace what is there;
 * `startedAt` is kept from the first write.
 * @param {string} dir @param {Session} session
 * @param {{ bearer: string, label?: string, pid?: number, pidSource?: string, now?: Date }} fields
 */
export async function writeRecord(dir, session, fields) {
  const now = (fields.now ?? new Date()).toISOString();
  const prev = await readRecord(dir);
  /** @type {SessionRecord} */
  const rec = {
    slug: session.slug,
    source: session.source,
    ...(fields.label !== undefined ? { label: fields.label } : prev?.label !== undefined ? { label: prev.label } : {}),
    bearer: fields.bearer,
    ...(fields.pid !== undefined ? { pid: fields.pid, pidSource: fields.pidSource } : prev?.pid !== undefined ? { pid: prev.pid, pidSource: prev.pidSource } : {}),
    bootEpoch: prev?.bootEpoch ?? bootEpoch(),
    startedAt: prev?.startedAt ?? now,
    lastSeen: now,
  };
  await mkdir(dir, { recursive: true });
  await writeFile(recordPath(dir), JSON.stringify(rec, null, 2) + "\n", "utf8");
  return rec;
}

/** Mark the record as seen now, if there is one. @param {string} dir */
export async function touchRecord(dir) {
  const rec = await readRecord(dir);
  if (!rec) return undefined;
  rec.lastSeen = new Date().toISOString();
  await writeFile(recordPath(dir), JSON.stringify(rec, null, 2) + "\n", "utf8");
  return rec;
}

/** @param {string} dir */
export async function removeRecord(dir) {
  await rm(recordPath(dir), { force: true });
}

/** @param {string} dir remove a session directory entirely (cursors, ledger, record) */
export async function removeSession(dir) {
  await rm(dir, { recursive: true, force: true });
}

/**
 * live: the record's boot epoch matches this boot and its pid answers a signal (EPERM counts as
 * alive: a process this user cannot signal is still a process). gone: the pid is not there, or
 * the machine rebooted. unknown: the record carries no pid.
 * @param {SessionRecord} rec
 * @param {{ kill?: (pid: number, sig: 0) => void, boot?: number }} [deps]
 * @returns {'live' | 'gone' | 'unknown'}
 */
export function liveness(rec, deps = {}) {
  if (rec.pid === undefined) return "unknown";
  const boot = deps.boot ?? bootEpoch();
  if (Math.abs(boot - rec.bootEpoch) > 2) return "gone";
  try {
    (deps.kill ?? ((pid, sig) => process.kill(pid, sig)))(rec.pid, 0);
    return "live";
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === "ESRCH" ? "gone" : "live";
  }
}

/**
 * Every session with a record under this root, with its liveness.
 * @param {string} stateRoot @param {{ kill?: (pid: number, sig: 0) => void, boot?: number }} [deps]
 */
export async function listRecords(stateRoot, deps) {
  /** @type {Array<{ slug: string, dir: string, record: SessionRecord | undefined, state: 'live' | 'gone' | 'unknown' | 'unregistered' }>} */
  const out = [];
  for (const slug of await listSessions(stateRoot)) {
    const dir = path.join(stateRoot, "sessions", slug);
    const record = await readRecord(dir);
    out.push({ slug, dir, record, state: record ? liveness(record, deps) : "unregistered" });
  }
  return out;
}

/** Hours since the record was last touched. @param {SessionRecord} rec @param {Date} [now] */
export function ageHours(rec, now = new Date()) {
  return (now.getTime() - new Date(rec.lastSeen).getTime()) / 3_600_000;
}

export const DEPART_GRACE_MINUTES = 5;
const departedDir = (/** @type {string} */ dir) => path.join(dir, "departed");

/**
 * Sessions on this seat that have gone dark and that this room has not been told about: the
 * record's process is gone, its last write is older than the grace (a harness that restarts
 * gives its session a new pid and touches the record on its next command, so a few quiet
 * minutes are required before anyone is declared gone) and newer than the stale horizon
 * (older than that, the record is pruned, not announced). The caller announces each one
 * after winning `claimDeparture`, so several watchers on the seat post one line, not one each.
 * @param {string} stateRoot
 * @param {{ selfSlug: string, roomKey: string, graceMinutes?: number, staleHours?: number, now?: Date, kill?: (pid: number, sig: 0) => void, boot?: number }} opts
 */
export async function departures(stateRoot, opts) {
  const grace = (opts.graceMinutes ?? DEPART_GRACE_MINUTES) / 60;
  const stale = opts.staleHours ?? 48;
  const now = opts.now ?? new Date();
  /** @type {Array<{ slug: string, dir: string, record: SessionRecord }>} */
  const out = [];
  for (const r of await listRecords(stateRoot, { kill: opts.kill, boot: opts.boot })) {
    if (r.slug === opts.selfSlug || !r.record || r.state !== "gone") continue;
    const age = ageHours(r.record, now);
    if (age < grace || age > stale) continue;
    if (existsSync(path.join(departedDir(r.dir), `${opts.roomKey}.json`))) continue;
    out.push({ slug: r.slug, dir: r.dir, record: r.record });
  }
  return out;
}

/**
 * Take the right to announce a departure in one room: an exclusive create, so of several
 * watchers noticing at once exactly one speaks. True for the winner.
 * @param {string} dir the departed session's directory @param {string} roomKey @param {string} by the announcing session's slug
 */
export async function claimDeparture(dir, roomKey, by) {
  await mkdir(departedDir(dir), { recursive: true });
  try {
    await writeFile(path.join(departedDir(dir), `${roomKey}.json`), JSON.stringify({ roomKey, by, at: new Date().toISOString() }) + "\n", { encoding: "utf8", flag: "wx" });
    return true;
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "EEXIST") return false;
    throw e;
  }
}

/**
 * The line a sibling posts for a session that went dark. It names who is still here so a
 * request can be re-addressed rather than re-sent into silence. A session whose liveness
 * cannot be probed from here (a harness that injects no pid, another OS user's process) is
 * named as such rather than dropped: a roster that silently omits it tells the counterpart
 * a live bearer is gone.
 * @param {SessionRecord} gone @param {string[]} live bearers of sessions provably live on this seat
 * @param {string[]} [unknown] bearers registered here whose liveness could not be probed
 */
export function departureLine(gone, live, unknown = []) {
  const seen = new Date(gone.lastSeen).toISOString().replace(/\.\d{3}Z$/, "Z");
  const others = live.length ? `Still here on this seat: ${live.join(", ")}.` : "No other session is provably live on this seat.";
  const maybe = unknown.length ? ` Also registered here, liveness not provable from this process: ${unknown.join(", ")}.` : "";
  return `${gone.bearer} is no longer running (last seen ${seen}). Requests addressed to it will not be answered; re-address them. ${others}${maybe}`;
}

const ETAG_MAX = 64;
const ETAG_KEEP = 32;
const etagPath = (/** @type {string} */ dir) => path.join(dir, "etags.json");

/**
 * Where a transport keeps its cache validators between processes: one small JSON map under the
 * session, written when a value changes. A validator that does not survive a re-arm buys nothing,
 * because a watch is a fresh process every time.
 * @param {string} dir
 * @returns {{ get: (key: string) => Promise<string | undefined>, set: (key: string, value: string) => Promise<void> }}
 */
export function etagCache(dir) {
  /** @returns {Promise<Record<string, string>>} */
  const read = async () => {
    try {
      const m = JSON.parse(await readFile(etagPath(dir), "utf8"));
      return m && typeof m === "object" ? m : {};
    } catch {
      return {};
    }
  };
  return {
    async get(key) {
      const v = (await read())[key];
      return typeof v === "string" ? v : undefined;
    },
    async set(key, value) {
      const map = await read();
      if (map[key] === value) return;
      delete map[key]; // re-inserted last, so the oldest entry is the first key
      map[key] = value;
      const keys = Object.keys(map);
      const kept = keys.length > ETAG_MAX ? Object.fromEntries(keys.slice(-ETAG_KEEP).map((k) => [k, map[k]])) : map;
      await mkdir(dir, { recursive: true });
      await writeFile(etagPath(dir), JSON.stringify(kept, null, 2) + "\n", "utf8");
    },
  };
}

/**
 * Does this pid answer a signal? A process this user may not signal (EPERM) is still a process;
 * only ESRCH means gone. Used for a watch's own pid, which carries no boot epoch of its own.
 * @param {number | undefined} pid @param {(pid: number, sig: 0) => void} [kill]
 */
export function pidAlive(pid, kill) {
  if (!Number.isInteger(pid) || Number(pid) <= 0) return false;
  try {
    (kill ?? ((p, s) => process.kill(p, s)))(Number(pid), 0);
    return true;
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code !== "ESRCH";
  }
}

/**
 * A live watch's registration: one file per cursor key, written when a watch arms and removed
 * when it leaves. It is what lets a second watch on the same key say so instead of silently
 * double-delivering, and what lets `doctor` add up the reads a minute this seat is spending.
 * @typedef {object} ArmedWatch
 * @property {string} room the room alias
 * @property {string} [thread]
 * @property {number} interval seconds between room polls
 * @property {number} [threadInterval] seconds between reads of one followed thread
 * @property {boolean} [follow]
 * @property {number} pid the watching process
 * @property {number} [harnessPid]
 * @property {string | null} [since] the cursor it started from
 * @property {string} startedAt
 */

const armedDir = (/** @type {string} */ dir) => path.join(dir, "armed");
const armedPath = (/** @type {string} */ dir, /** @type {string} */ key) => path.join(armedDir(dir), `${key}.json`);

/** @param {string} dir @param {string} key @returns {Promise<ArmedWatch | undefined>} */
export async function readArmed(dir, key) {
  try {
    const rec = JSON.parse(await readFile(armedPath(dir, key), "utf8"));
    return rec && typeof rec.pid === "number" ? rec : undefined;
  } catch {
    return undefined;
  }
}

/** @param {string} dir @param {string} key @param {ArmedWatch} rec */
export async function writeArmed(dir, key, rec) {
  await mkdir(armedDir(dir), { recursive: true });
  await writeFile(armedPath(dir, key), JSON.stringify(rec, null, 2) + "\n", "utf8");
}

/** @param {string} dir @param {string} key */
export async function removeArmed(dir, key) {
  await rm(armedPath(dir, key), { force: true });
}

/**
 * Every watch registered anywhere under this state root, with the session directory it belongs to.
 * A registration whose pid is gone is a leftover from a killed process; the caller decides.
 * @param {string} stateRoot
 * @returns {Promise<Array<{ slug: string, dir: string, key: string, armed: ArmedWatch }>>}
 */
export async function listArmed(stateRoot) {
  /** @type {Array<{ slug: string, dir: string, key: string, armed: ArmedWatch }>} */
  const out = [];
  for (const slug of await listSessions(stateRoot)) {
    const dir = path.join(stateRoot, "sessions", slug);
    /** @type {string[]} */
    let files = [];
    try {
      files = await readdir(armedDir(dir));
    } catch {
      continue;
    }
    for (const f of files.sort()) {
      if (!f.endsWith(".json")) continue;
      const key = f.slice(0, -".json".length);
      const armed = await readArmed(dir, key);
      if (armed) out.push({ slug, dir, key, armed });
    }
  }
  return out;
}
