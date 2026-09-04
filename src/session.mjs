// @ts-check
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgoraError, EXIT, readCursorFile, writeCursor, writeFileAtomic } from "./core.mjs";

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

/**
 * A session key is one safe directory name. `.` and `..` match every other rule and are not names:
 * `path.join` normalises them away, so a key of `..` resolves the session directory to the state
 * root itself and `session --forget` deletes every session's cursors, ledgers and records.
 */
export const SESSION_RE = /^(?!\.\.?$)[A-Za-z0-9._-]{1,64}$/;
/** A bearer is a path: model, then optionally what this session is for. `Grace`, `Grace/watch`, `Opus/design`. */
export const BEARER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,31})*$/;
export const BEARER_MAX = 64;
export const DEFAULT_SESSION_FROM = Object.freeze([
  "CLAUDE_CODE_SESSION_ID",
  "GROK_SESSION_ID",
  "CODEX_SESSION_ID",
  "CODEX_THREAD_ID",
  "HERMES_SESSION_ID",
]);
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
  const from = Array.isArray(cfg.session?.from) ? cfg.session.from.map(String) : [...DEFAULT_SESSION_FROM];
  const explicit = env.AGORA_SESSION;
  if (explicit !== undefined) {
    if (!SESSION_RE.test(explicit)) throw new AgoraError(`AGORA_SESSION must match ${SESSION_RE} (got ${JSON.stringify(explicit)})`, EXIT.usage);
    // The raw value is what a reader copies out of `doctor`, which prints the harness variable's
    // value beside the slug derived from it. Setting AGORA_SESSION to that raw value must not fork
    // a second session directory (a second ledger, a second position) out of one harness session:
    // it names the same session, so it resolves to the same tagged slug.
    for (const varName of from) {
      if (SECRET_NAME.test(varName)) continue;
      if (env[varName] !== undefined && env[varName] !== "" && env[varName] === explicit && SESSION_RE.test(explicit))
        return { slug: `${sessionTag(varName)}-${explicit}`, source: `AGORA_SESSION (${varName})`, explicit: true };
    }
    return { slug: explicit, source: "AGORA_SESSION", explicit: true };
  }
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

/**
 * Belt to `SESSION_RE`'s braces: whatever produced the slug, the directory it names must be a
 * strict child of `<state>/sessions`. Nothing here is destructive on its own, but `--forget`
 * removes this directory recursively, so the one check worth making twice is that it is a session
 * directory and not the state root.
 * @param {string} sessionsBase @param {string} dir @param {string} what
 */
function assertUnderSessions(sessionsBase, dir, what) {
  const base = path.resolve(sessionsBase);
  const resolved = path.resolve(dir);
  if (resolved === base || path.dirname(resolved) !== base)
    throw new AgoraError(`${what} does not name a directory directly under ${base}`, EXIT.usage);
}

/** @param {string} stateRoot @param {Session} session */
export function sessionDir(stateRoot, session) {
  const base = path.join(stateRoot, "sessions");
  const dir = path.join(base, session.slug);
  assertUnderSessions(base, dir, `session key ${JSON.stringify(session.slug)}`);
  return dir;
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
    throw new AgoraError(`${pick.source} must be a bearer path like Grace or Grace/watch (letters, digits, . _ -; segments joined by /; at most ${BEARER_MAX} characters)`, EXIT.usage);
  return { name, source: pick.source };
}

/**
 * The saved position for this session. Absent in the session directory: seed once, read-only, from the
 * file of the same name at the state root (the single-session layout), and write it forward. A file
 * that exists but holds null (after `cursor --reset`) is a position, not an absence: it never seeds.
 * A file that exists but cannot be read raises out of `readCursorFile` rather than reporting an
 * absence, so a damaged position is never seeded over and replayed from the shared file.
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
/** The rotated half of the ring. The ledger is read as both files, oldest first. */
const ledgerPrevPath = (/** @type {string} */ dir) => path.join(dir, "posted.1.jsonl");
const ROTATE_LOCK_STALE_MS = 60_000;

/** @param {string} file */
async function ledgerLines(file) {
  try {
    return (await readFile(file, "utf8")).split(/\r?\n/).filter((l) => l.trim());
  } catch {
    return [];
  }
}

/**
 * The ring, done by rotating the file whole rather than rewriting its tail.
 *
 * A read-modify-write truncation loses every id a sibling process of this session appended between
 * the read and the write, and an own-post id that is lost is a self-echo delivered to the agent
 * that wrote it -- the one failure the ledger exists to prevent. Renaming loses nothing: an append
 * already in flight holds the old file open and its bytes land in the rotated file, which
 * `readPosted` reads too, and an append that starts after the rename opens the new one. Only
 * rotator against rotator has to be excluded, or a second rotator would move a nearly-empty file
 * over the thousand ids the first one just rotated; that is what the exclusive-create lock is for,
 * and a lock left behind by a killed process is swept after a minute. Losing the lock race is not
 * an error: the next append rotates.
 * @param {string} dir
 */
async function rotateLedger(dir) {
  const file = ledgerPath(dir);
  if ((await ledgerLines(file)).length <= LEDGER_KEEP) return;
  const lock = `${file}.rotating`;
  try {
    // not writeFileAtomic: an exclusive create IS the atom here, and a rename would overwrite the
    // holder's lock rather than lose the race to it
    await writeFile(lock, `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code !== "EEXIST") throw e;
    const held = await stat(lock).catch(() => undefined);
    if (!held || Date.now() - held.mtimeMs < ROTATE_LOCK_STALE_MS) return;
    await rm(lock, { force: true });
    return;
  }
  try {
    // another rotator may have won and released between the count above and the lock
    if ((await ledgerLines(file)).length > LEDGER_KEEP) await rename(file, ledgerPrevPath(dir));
  } finally {
    await rm(lock, { force: true });
  }
}

/**
 * Record a message this session posted. The append itself is one O_APPEND write, which the
 * filesystem orders against every sibling process's; the ring is a rotation, never a rewrite.
 * The read set is the two files together, so it holds between LEDGER_KEEP and LEDGER_MAX ids.
 * @param {string} dir @param {string} id
 */
export async function appendPosted(dir, id) {
  await mkdir(dir, { recursive: true });
  await appendFile(ledgerPath(dir), JSON.stringify({ id, pid: process.pid, at: new Date().toISOString() }) + "\n", "utf8");
  await rotateLedger(dir);
}

/** Every ledger line this session wrote, oldest file first. @param {string} dir */
async function postedLines(dir) {
  return [...(await ledgerLines(ledgerPrevPath(dir))), ...(await ledgerLines(ledgerPath(dir)))];
}

/** The ids this session posted. @param {string} dir */
export async function readPosted(dir) {
  const out = new Set();
  for (const line of await postedLines(dir)) {
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
  for (const line of await postedLines(dir)) {
    try {
      pids.add(JSON.parse(line).pid);
    } catch {
      /* skip */
    }
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

export const DEFAULT_PID_FROM = Object.freeze(["AGORA_SESSION_PID", "CLAUDE_PID", "GROK_PID"]);
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
    if (Number.isInteger(v) && v > 0) return { pid: v, pidSource: name, looked: from };
  }
  // `looked` is what the caller says out loud when there is no pid: liveness-unknown is a fact
  // about which variable the harness failed to inject, and naming it is the whole remedy.
  return { pid: undefined, pidSource: undefined, looked: from };
}

export const DEFAULT_CHILD_FROM = Object.freeze(["CLAUDE_CODE_CHILD_SESSION"]);

/**
 * Is this process a subagent of the session that holds the seat? A harness that spawns a tool or
 * hook subprocess hands it the parent's session id, so it writes into the parent's ledger and its
 * post is skipped by the parent's own watch. The harness also sets a marker; reading it is the
 * visibility the design asks for. Never a refusal: a subagent may legitimately post.
 * @param {import('./core.mjs').Config} cfg @param {NodeJS.ProcessEnv} env
 * @returns {{ child: boolean, source?: string }}
 */
export function childSession(cfg, env) {
  const from = Array.isArray(cfg.session?.childFrom) ? cfg.session.childFrom.map(String) : [...DEFAULT_CHILD_FROM];
  for (const name of from) {
    const v = env[name];
    if (v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false") return { child: true, source: name };
  }
  return { child: false };
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
  await writeFileAtomic(recordPath(dir), JSON.stringify(rec, null, 2) + "\n");
  return rec;
}

/** Mark the record as seen now, if there is one. @param {string} dir */
export async function touchRecord(dir) {
  const rec = await readRecord(dir);
  if (!rec) return undefined;
  rec.lastSeen = new Date().toISOString();
  await writeFileAtomic(recordPath(dir), JSON.stringify(rec, null, 2) + "\n");
  return rec;
}

/** @param {string} dir */
export async function removeRecord(dir) {
  await rm(recordPath(dir), { force: true });
}

/**
 * Remove a session directory entirely (cursors, ledger, record). The only recursive delete in the
 * tool, so it re-derives what it is being asked to remove instead of trusting the caller: the path
 * must be one validated session name directly inside a `sessions` directory. A caller that can
 * name the state root passes it and the check is exact.
 * @param {string} dir @param {string} [stateRoot]
 */
export async function removeSession(dir, stateRoot) {
  const resolved = path.resolve(dir);
  const slug = path.basename(resolved);
  const parent = path.dirname(resolved);
  if (path.basename(parent) !== "sessions" || !SESSION_RE.test(slug))
    throw new AgoraError(`refusing to remove ${resolved}: a session directory is one validated name under <state>/sessions`, EXIT.usage);
  if (stateRoot !== undefined) assertUnderSessions(path.join(stateRoot, "sessions"), resolved, resolved);
  await rm(resolved, { recursive: true, force: true });
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
  // A clock step larger than the tolerance (an NTP correction after a resume) moves the derived boot
  // epoch and reads every live sibling on the seat as gone, which announces them as departed. Widen
  // this only on a measurement: sample bootEpoch() across resumes and NTP steps on the seats that
  // run watches and take the largest observed jump, not a guess.
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
    // a session that never touched this room is not announced in it: a fresh room otherwise opens
    // with obituaries for bearers it never met, taken from the whole seat's roster
    if (!(await hasRoomState(r.dir, opts.roomKey))) continue;
    out.push({ slug: r.slug, dir: r.dir, record: r.record });
  }
  return out;
}

/**
 * Did this session ever have state in this room? A saved position for the key (or for a thread of
 * it) or a watch armed on it. Read off the files that already exist; nothing new is recorded to
 * answer it.
 * @param {string} dir a session directory @param {string} roomKey
 */
export async function hasRoomState(dir, roomKey) {
  const scope = await sessionScope(dir);
  const mine = (/** @type {string} */ key) => key === roomKey || key.startsWith(`${roomKey}#`);
  return scope.rooms.some(mine) || scope.armed.some((a) => mine(a.key));
}

/**
 * What one session holds, by name: the room keys it has a saved position for, and the watches it
 * has armed. Names only -- no cursor value, no room content. `doctor` and `session --list` print it
 * so "three live sessions" can be read as which rooms they are actually in.
 * @param {string} dir a session directory
 * @returns {Promise<{ rooms: string[], armed: Array<{ key: string, room: string, thread?: string, mode?: string, pid: number }> }>}
 */
export async function sessionScope(dir) {
  /** @type {string[]} */
  let rooms = [];
  try {
    rooms = (await readdir(dir)).filter((f) => f.endsWith(".cursor")).map((f) => f.slice(0, -".cursor".length)).sort();
  } catch {
    rooms = [];
  }
  /** @type {Array<{ key: string, room: string, thread?: string, mode?: string, pid: number }>} */
  const armed = [];
  /** @type {string[]} */
  let files = [];
  try {
    files = await readdir(armedDir(dir));
  } catch {
    files = [];
  }
  for (const f of files.sort()) {
    if (!f.endsWith(".json")) continue;
    const key = f.slice(0, -".json".length);
    const rec = await readArmed(dir, key);
    if (rec) armed.push({ key, room: rec.room, ...(rec.thread ? { thread: rec.thread } : {}), ...(rec.mode ? { mode: rec.mode } : {}), pid: rec.pid });
  }
  return { rooms, armed };
}

/**
 * Take the right to announce a departure in one room: an exclusive create, so of several
 * watchers noticing at once exactly one speaks. True for the winner.
 * @param {string} dir the departed session's directory @param {string} roomKey @param {string} by the announcing session's slug
 */
export async function claimDeparture(dir, roomKey, by) {
  await mkdir(departedDir(dir), { recursive: true });
  try {
    // not writeFileAtomic, for the same reason as the ledger's rotation lock: the exclusive create
    // is what makes exactly one watcher the announcer, and a rename would overwrite the winner
    await writeFile(path.join(departedDir(dir), `${roomKey}.json`), JSON.stringify({ roomKey, by, at: new Date().toISOString() }) + "\n", { encoding: "utf8", flag: "wx" });
    return true;
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "EEXIST") return false;
    throw e;
  }
}

/**
 * Give the claim back. A post that failed announced nothing, and a claim kept over a failure
 * silences that departure in that room for every watcher on the seat, permanently -- which is the
 * exact silence the mechanism exists to end. Releasing lets the next poll, or another watcher, try.
 * @param {string} dir the departed session's directory @param {string} roomKey
 */
export async function releaseDeparture(dir, roomKey) {
  await rm(path.join(departedDir(dir), `${roomKey}.json`), { force: true });
}

/**
 * The line a sibling posts for a session that went dark. It names who is still here so a
 * request can be re-addressed rather than re-sent into silence. A session whose liveness
 * cannot be probed from here (a harness that injects no pid, another OS user's process) is
 * named as such rather than dropped: a roster that silently omits it tells the counterpart
 * a live bearer is gone.
 * @param {SessionRecord} gone @param {string[]} live bearers of sessions provably live on this seat
 * @param {Array<string | { bearer: string, lastSeen?: string }>} [unknown] bearers registered here whose
 *   liveness could not be probed; each is printed with when it last wrote, so a reader can weigh a
 *   session that was active a minute ago against one quiet for hours
 */
export function departureLine(gone, live, unknown = []) {
  const seen = new Date(gone.lastSeen).toISOString().replace(/\.\d{3}Z$/, "Z");
  const others = live.length ? `Still here on this seat: ${live.join(", ")}.` : "No other session is provably live on this seat.";
  const named = unknown.map((u) => typeof u === "string" ? u : u.lastSeen ? `${u.bearer} (last seen ${new Date(u.lastSeen).toISOString().replace(/\.\d{3}Z$/, "Z")})` : u.bearer);
  const maybe = named.length ? ` Also registered here, liveness not provable from this process: ${named.join(", ")}.` : "";
  return `${gone.bearer} is no longer running (last seen ${seen}). Requests addressed to it will not be answered; re-address them. ${others}${maybe}`;
}

/**
 * One sweep, one post. A reboot leaves every recent record dark at once, and a paragraph each is
 * the loudest machine traffic in a room humans read in one pass. Bearers and last-seen times are
 * named; no count is emitted, because a roster is what a reader re-addresses against and a number
 * is not.
 * @param {SessionRecord[]} gone @param {string[]} live @param {Array<string | { bearer: string, lastSeen?: string }>} [unknown]
 */
export function departuresLine(gone, live, unknown = []) {
  if (gone.length === 1) return departureLine(gone[0], live, unknown);
  const names = gone.map((g) => g.bearer);
  const seen = gone.map((g) => new Date(g.lastSeen).toISOString().replace(/\.\d{3}Z$/, "Z"));
  const list = `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const others = live.length ? `Still here on this seat: ${live.join(", ")}.` : "No other session is provably live on this seat.";
  const named = unknown.map((u) => typeof u === "string" ? u : u.lastSeen ? `${u.bearer} (last seen ${new Date(u.lastSeen).toISOString().replace(/\.\d{3}Z$/, "Z")})` : u.bearer);
  const maybe = named.length ? ` Also registered here, liveness not provable from this process: ${named.join(", ")}.` : "";
  return `${list} are no longer running (last seen ${seen.join(", ")}, in that order). Requests addressed to them will not be answered; re-address them. ${others}${maybe}`;
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
      await writeFileAtomic(etagPath(dir), JSON.stringify(kept, null, 2) + "\n");
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
 * @property {'once' | 'until-new' | 'stream'} [mode] what this watch is doing
 * @property {number} [threadInterval] seconds between reads of one followed thread
 * @property {boolean} [follow]
 * @property {number} pid the watching process
 * @property {number} [harnessPid]
 * @property {number} [bootEpoch] the boot this pid belongs to; a pid outlives nothing across a reboot
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

/**
 * Stamps the boot this registration belongs to, like a `SessionRecord`, so a leftover from before
 * a reboot cannot be read as live by a process that happens to reuse the pid.
 * @param {string} dir @param {string} key @param {ArmedWatch} rec
 */
export async function writeArmed(dir, key, rec) {
  await writeFileAtomic(armedPath(dir, key), JSON.stringify({ ...rec, bootEpoch: rec.bootEpoch ?? bootEpoch() }, null, 2) + "\n");
}

/**
 * Is the watch this registration names still running? The pid alone is not enough: pids are reused,
 * and a registration written before a reboot names a pid that now belongs to something else, so the
 * seat warns about a watch that is not there and `doctor` counts it into the poll budget. A record
 * from an older build carries no boot epoch; it falls back to the pid, which is what it always was.
 * @param {ArmedWatch} armed
 * @param {{ kill?: (pid: number, sig: 0) => void, boot?: number }} [deps]
 */
export function armedAlive(armed, deps = {}) {
  if (typeof armed.bootEpoch === "number" && Math.abs((deps.boot ?? bootEpoch()) - armed.bootEpoch) > 2) return false;
  return pidAlive(armed.pid, deps.kill);
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
