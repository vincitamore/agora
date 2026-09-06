// @ts-check
import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import path from "node:path";

const execFileAsync = promisify(execFile);

/** @typedef {'human' | 'agent' | 'unknown' | 'system'} ActorKind */
/** @typedef {{ id: string, name: string, kind: ActorKind }} Author */
/**
 * A file carried beside a message. `path` is a locally materialized, inert copy a local agent can
 * inspect without receiving the transport credential. A missing path never hides the attachment:
 * `error` says why the bytes were unavailable while the message itself is still delivered.
 * @typedef {object} Attachment
 * @property {string} id
 * @property {string} name
 * @property {'image' | 'file'} kind
 * @property {string} [mimetype]
 * @property {number} [size]
 * @property {number} [width]
 * @property {number} [height]
 * @property {string} [url] a human-facing permalink, never a credential-bearing URL
 * @property {string} [path] absolute path to a locally materialized copy
 * @property {string} [digest] verified content digest, e.g. sha256:<hex>; populated only after local materialization
 * @property {string} [error] bounded reason the copy could not be materialized
 */
/**
 * A message as every transport reports it. `cursor` is opaque to callers and
 * ascending within a room: passing it back as `since` returns only what came after.
 * @typedef {object} Message
 * @property {string} id
 * @property {string} room
 * @property {string} [thread]
 * @property {Author} author
 * @property {string} text
 * @property {string} [signedAs] the name on a trailing signature line, when present
 * @property {string} ts ISO-8601
 * @property {string} cursor
 * @property {string} [url]
 * @property {Attachment[]} [attachments]
 * @property {unknown} [raw]
 */
/**
 * `ids` is present when the transport had to send one post as several messages: every id it
 * produced, in order, `id` being the first. The caller records them all in the ledger (they are all
 * this session's own) and follows the first, the rest as other names for it.
 * `faces` is present only on a native room whose service returned the per-face rows of the
 * receipt (`pending`, `refused` before any call); a transport never invents one.
 * @typedef {{ id: string, cursor: string, url?: string, ids?: string[], faces?: { transport: string, status: string, reason?: string, id?: string, attachmentId?: string }[] }} PostResult
 */
/**
 * Why a read after a cursor could not reach it: the page cap, or a walk that stopped early. A read
 * that ends this way returns NOTHING rather than the oldest window of what it happened to collect,
 * because that window looks complete and the cursor saved after it steps over everything below.
 * `oldestFetched` is the deepest position the walk did reach, `pages` how many it was allowed.
 * @typedef {{ reason: string, oldestFetched?: string, pages: number }} ReadGap
 */
/** @typedef {{ gap?: ReadGap }} GapCarrier */
/**
 * What a read returns: the messages, ascending, and on the array itself the gap, when the walk
 * could not reach the cursor. A property on the array rather than an envelope so every existing
 * caller keeps reading a plain list (`JSON.stringify` of an array drops it, which is what the wire
 * wants); a caller that must not step over a backlog reads `.gap`.
 * @typedef {Message[] & GapCarrier} ReadResult
 */
/** @typedef {{ thread?: string, since?: string, limit?: number, pages?: number }} ReadOptions */
/**
 * `face` is a native room's post-time face choice: transports named by `--face`, `"none"` for
 * `--no-face`, absent for the room's own policy. Only the native transport reads it.
 * @typedef {{ thread?: string, face?: 'none' | string[] }} PostOptions
 */
/**
 * What a transport implements. `read` returns messages ascending, each carrying a cursor.
 * @typedef {object} Transport
 * @property {string} kind
 * @property {string} room the transport's own name for the room
 * @property {boolean} threads whether `thread` means anything here
 * @property {() => Promise<{ id: string, name: string }>} whoami
 * @property {(opts?: ReadOptions) => Promise<ReadResult>} read
 * @property {(text: string, opts?: PostOptions) => Promise<PostResult>} post
 * @property {(payload: { action: string, subject: string, because?: string, leaseId?: string, fence?: string }) => Promise<unknown>} [board] native rooms: a typed board event, not a chat message
 * @property {(cursor: string) => string | undefined} [validateCursor] why this string is not a
 *   cursor here, or nothing. `cursor --set` asks before it writes, so a shape the transport can
 *   never read is refused at the boundary instead of throwing on every later read.
 * @property {(thread: string) => string | undefined} [validateThread] why this string is not a
 *   thread id here, or nothing. Refused at the caller boundaries (`--thread`, `--re`); an id that
 *   comes back out of this session's own follow set is dropped from the set, never a usage error.
 */
/** @typedef {{ name: string, kind: ActorKind }} Actor */
/** @typedef {{ transport: string, tokenEnv?: string, tokenFile?: string, [k: string]: unknown }} RoomConfig */
/** @typedef {{ from?: string[], pidFrom?: string[], staleAfterHours?: number }} SessionConfig */
/** @typedef {{ actor: Actor, rooms: Record<string, RoomConfig>, state?: string, sign?: boolean, path?: string, session?: SessionConfig }} Config */

export class AgoraError extends Error {
  /** @param {string} message @param {number} [exitCode] */
  constructor(message, exitCode = 1) {
    super(message);
    this.name = "AgoraError";
    this.exitCode = exitCode;
  }
}

/** Exit codes the CLI uses. Watchers map onto them directly. */
export const EXIT = Object.freeze({ ok: 0, error: 1, usage: 2, fired: 42 });

const ACTOR_KINDS = new Set(["human", "agent", "unknown"]);
const SECRET_KEYS = /^(token|secret|password|apikey|api_key|bearer)$/i;

/** @param {string} p */
export function expandHome(p) {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(homedir(), p.slice(2));
  return p;
}

/** @param {string | undefined} explicit */
export function configPath(explicit) {
  if (explicit) return path.resolve(expandHome(explicit));
  if (process.env.AGORA_CONFIG) return path.resolve(expandHome(process.env.AGORA_CONFIG));
  const local = path.resolve("agora.json");
  if (existsSync(local)) return local;
  return path.join(homedir(), ".agora", "config.json");
}

/**
 * The config carries references to secrets (an env var name, a file path), never a secret.
 * @param {unknown} cfg @param {string} where
 * @returns {asserts cfg is Config}
 */
export function validateConfig(cfg, where) {
  if (!cfg || typeof cfg !== "object") throw new AgoraError(`${where}: config must be an object`);
  const c = /** @type {Record<string, unknown>} */ (cfg);
  const actor = /** @type {Record<string, unknown> | undefined} */ (c.actor);
  if (!actor || typeof actor.name !== "string" || !actor.name.trim())
    throw new AgoraError(`${where}: actor.name is required (the name this side signs as)`);
  if (!ACTOR_KINDS.has(String(actor.kind)))
    throw new AgoraError(`${where}: actor.kind must be one of human, agent, unknown`);
  const rooms = /** @type {Record<string, unknown> | undefined} */ (c.rooms);
  if (!rooms || typeof rooms !== "object" || Object.keys(rooms).length === 0)
    throw new AgoraError(`${where}: rooms must name at least one room`);
  for (const [alias, room] of Object.entries(rooms)) {
    if (!room || typeof room !== "object") throw new AgoraError(`${where}: room "${alias}" must be an object`);
    const r = /** @type {Record<string, unknown>} */ (room);
    if (typeof r.transport !== "string") throw new AgoraError(`${where}: room "${alias}" needs a transport`);
    for (const key of Object.keys(r)) {
      if (SECRET_KEYS.test(key))
        throw new AgoraError(
          `${where}: room "${alias}" carries "${key}" inline; use tokenEnv (an env var name) or tokenFile (a path) instead`,
        );
    }
  }
}

/** @param {string} [explicit] @returns {Promise<Config>} */
export async function loadConfig(explicit) {
  const p = configPath(explicit);
  let raw;
  try {
    raw = await readFile(p, "utf8");
  } catch {
    throw new AgoraError(`no config at ${p} (set AGORA_CONFIG, or write ./agora.json or ~/.agora/config.json)`);
  }
  /** @type {unknown} */
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    throw new AgoraError(`${p}: ${e instanceof Error ? e.message : String(e)}`);
  }
  validateConfig(cfg, p);
  return { ...cfg, path: p };
}

/**
 * Where a room's token comes from: tokenEnv, then tokenFile. Returns the source too so
 * `doctor` can report presence without printing the value.
 * @param {RoomConfig} room
 * @returns {Promise<{ token?: string, source: 'env' | 'file' | 'missing' }>}
 */
export async function resolveToken(room) {
  if (typeof room.tokenEnv === "string") {
    const v = process.env[room.tokenEnv];
    if (v && v.trim()) return { token: v.trim(), source: "env" };
  }
  if (typeof room.tokenFile === "string") {
    try {
      const v = (await readFile(expandHome(room.tokenFile), "utf8")).trim();
      if (v) return { token: v, source: "file" };
    } catch {
      /* fall through */
    }
  }
  return { source: "missing" };
}

/** The GitHub CLI's token, when the user is signed in there. */
export async function ghToken() {
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], { windowsHide: true });
    const t = stdout.trim();
    return t || undefined;
  } catch {
    return undefined;
  }
}

/** Signature line: `-- Name` (ASCII) or `— Name`. */
export const SIGNATURE_RE = /^(?:--|—|–)\s?(.{1,80}?)\s*$/;

/** @param {string} text @param {Actor} actor */
export function sign(text, actor) {
  const body = text.replace(/\s+$/, "");
  if (parseSignature(body) === actor.name) return body;
  return `${body}\n\n-- ${actor.name}`;
}

/** @param {string} text */
export function parseSignature(text) {
  const lines = text.replace(/\s+$/, "").split(/\r?\n/);
  const last = lines[lines.length - 1];
  if (lines.length < 2 || !last) return undefined;
  const m = last.match(SIGNATURE_RE);
  return m ? m[1] : undefined;
}

/**
 * Credential SHAPES, never the words around them. A context pattern (`Bearer <anything>`) catches
 * nothing these miss -- agora builds its authorization header as a lowercase key inside a request
 * object and never prints it -- and it ate the tool's own vocabulary: `bearer` is the noun for a
 * signing identity here, so `a bearer path like Fable` redacted the word after it in every error a
 * newcomer sees. A transport added later contributes its provider's token shape to this list; that
 * clause is the whole safety argument for keeping the list shape-based.
 */
const SECRET_PATTERNS = [
  /xox[abprse]-[A-Za-z0-9-]+/g,
  /gh[pousr]_[A-Za-z0-9]{16,}/g,
  /github_pat_[A-Za-z0-9_]+/g,
];

/** Strip anything that looks like a credential before it reaches a log or a room. @param {string} s */
export function redact(s) {
  let out = s;
  for (const re of SECRET_PATTERNS) out = out.replace(re, (_m, prefix) => `${typeof prefix === "string" ? prefix : ""}[redacted]`);
  return out;
}

/** A room path as the filesystem will see it. @param {string} p */
export function resolvePath(p) {
  return path.resolve(expandHome(p));
}

/** Folders whose contents are synced by an agent that rewrites files behind the writer. */
const SYNCED_FOLDERS = new Set(["onedrive", "dropbox", "google drive", "iclouddrive", "icloud drive"]);

/**
 * Why a path is a bad place for a room, or nothing. Concurrent writers behind a filesystem
 * translation layer, a network share or a syncing folder overwrite each other while every
 * surviving line still parses and every id stays unique, so no reader, cursor or check can
 * detect the loss.
 * Test the path as configured and as resolved: a WSL path is a `/mnt/` prefix as it was written,
 * and resolving it on a Windows host silently gives it a drive letter instead.
 * @param {string} resolved a room path, as configured or as resolved
 */
export function fragilePath(resolved) {
  if (resolved.startsWith("/mnt/")) return "a filesystem translation layer";
  if (resolved.startsWith("\\\\")) return "a network share";
  for (const seg of resolved.split(/[/\\]+/)) if (SYNCED_FOLDERS.has(seg.toLowerCase())) return `a syncing folder (${seg})`;
  return undefined;
}

/**
 * Where this seat's state lives: the environment first, then the config, then the default. The
 * environment is above the config for the same reason `--config` is above `AGORA_CONFIG`: a
 * worker started with an explicit `AGORA_STATE` (what `scripts/start-codex-watch.ps1` does) must
 * not be silently redirected by a `state` key someone left in the shared config.
 * @param {Config} cfg
 */
export function stateDir(cfg) {
  if (process.env.AGORA_STATE) return expandHome(process.env.AGORA_STATE);
  if (cfg.state) return expandHome(cfg.state);
  return path.join(homedir(), ".agora", "state");
}

/** @param {string} alias @param {string} [thread] */
export function cursorKey(alias, thread) {
  const raw = thread ? `${alias}#${thread}` : alias;
  return raw.replace(/[^A-Za-z0-9._#-]+/g, "_");
}

/**
 * The one way this tool writes a state file: a sibling temp file, then a rename into place. A
 * plain `writeFile` is a truncate followed by a write, so a crash or a concurrent reader sees a
 * half-written file, and a half-written cursor reads as *absent*, which sends the seed path over
 * a real position. The rename is atomic, so a reader sees the old bytes or the new ones and never
 * a torn file. (`fs.promises.rename` replaces an existing file on Windows as well as on POSIX;
 * measured here before this was relied on.) The temp name carries the pid and a per-call id, so
 * two writers — two processes, or two calls in one process — do not share a temp file, and it is
 * removed on failure rather than left beside the state it was meant to become.
 * @param {string} file @param {string} data
 */
export async function writeFileAtomic(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tmp, data, "utf8");
    let last;
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        await rename(tmp, file);
        return;
      } catch (e) {
        last = e;
        const code = /** @type {NodeJS.ErrnoException} */ (e).code;
        if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") throw e;
        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
      }
    }
    throw last;
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/**
 * A cursor file that exists with `cursor: null` is a position ("read from the start"), distinct from
 * a file that is absent (no position saved here yet). `cursor --reset` writes the former.
 * A file that is present but unreadable is neither: it is an error, never an absence. Reported as
 * an absence it would be seeded over by `readCursorSeeded`, which destroys the position *and* the
 * evidence, and replays the room from wherever the shared seed sits.
 * @param {string} dir @param {string} key @returns {Promise<{ exists: boolean, cursor: string | undefined }>}
 */
export async function readCursorFile(dir, key) {
  const file = path.join(dir, `${key}.cursor`);
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (e) {
    const code = /** @type {NodeJS.ErrnoException} */ (e).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { exists: false, cursor: undefined };
    throw new AgoraError(`${file}: cannot be read (${code ?? String(e)}); inspect it or delete it to start over`);
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new AgoraError(`${file}: not valid JSON (${e instanceof Error ? e.message : String(e)}); inspect it or delete it to start over`);
  }
  if (!parsed || typeof parsed !== "object")
    throw new AgoraError(`${file}: not a cursor file (expected an object with a cursor); inspect it or delete it to start over`);
  const cursor = /** @type {Record<string, unknown>} */ (parsed).cursor;
  return { exists: true, cursor: typeof cursor === "string" ? cursor : undefined };
}

/** @param {string} dir @param {string} key @returns {Promise<string | undefined>} */
export async function readCursor(dir, key) {
  return (await readCursorFile(dir, key)).cursor;
}

/** @param {string} dir @param {string} key @param {string | undefined} cursor undefined records "from the start" */
export async function writeCursor(dir, key, cursor) {
  const file = path.join(dir, `${key}.cursor`);
  await writeFileAtomic(file, JSON.stringify({ cursor: cursor ?? null, at: new Date().toISOString() }) + "\n");
}

/** Remove a saved cursor file entirely, so a session may seed again from the legacy file. @param {string} dir @param {string} key */
export async function forgetCursor(dir, key) {
  await rm(path.join(dir, `${key}.cursor`), { force: true });
}

/** @param {number} ms */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A wait, spread by a tenth either way. Watches armed together otherwise stay in lockstep for as
 * long as they live, and a rate-limit response hands every one of them the same retry interval,
 * which turns a loose herd into a tight one.
 * @param {number} ms @param {() => number} [random]
 */
export function jitter(ms, random = Math.random) {
  return Math.round(ms * (0.9 + random() * 0.2));
}

/** A positive number from a room's config, or the fallback. @param {RoomConfig} room @param {string} field @param {number} fallback */
export function roomNumber(room, field, fallback) {
  const v = Number(room[field]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * Seconds between room polls: the flag, then the room's own `interval`, then the transport's
 * default. A room that is a record rather than a chat does not need fifteen-second latency.
 * @param {RoomConfig} room @param {number} [override]
 */
export function roomInterval(room, override) {
  if (override !== undefined) return override;
  return roomNumber(room, "interval", room.transport === "github" ? 300 : room.transport === "github-events" ? 60 : 15);
}

/** Seconds between reads of one followed thread. @param {RoomConfig} room @param {number} [override] */
export function roomThreadInterval(room, override) {
  if (override !== undefined) return override;
  return roomNumber(room, "threadInterval", 60);
}

/** Reads a minute this seat is willing to spend on a transport before `doctor` says so. @param {RoomConfig} room */
export function roomPollBudget(room) {
  return roomNumber(room, "pollBudget", 40);
}
