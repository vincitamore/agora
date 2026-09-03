// @ts-check
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

/** @typedef {'human' | 'agent' | 'unknown'} ActorKind */
/** @typedef {{ id: string, name: string, kind: ActorKind }} Author */
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
 * @property {unknown} [raw]
 */
/** @typedef {{ id: string, cursor: string, url?: string }} PostResult */
/** @typedef {{ thread?: string, since?: string, limit?: number }} ReadOptions */
/** @typedef {{ thread?: string }} PostOptions */
/**
 * What a transport implements. `read` returns messages ascending, each carrying a cursor.
 * @typedef {object} Transport
 * @property {string} kind
 * @property {string} room the transport's own name for the room
 * @property {boolean} threads whether `thread` means anything here
 * @property {() => Promise<{ id: string, name: string }>} whoami
 * @property {(opts?: ReadOptions) => Promise<Message[]>} read
 * @property {(text: string, opts?: PostOptions) => Promise<PostResult>} post
 */
/** @typedef {{ name: string, kind: ActorKind }} Actor */
/** @typedef {{ transport: string, tokenEnv?: string, tokenFile?: string, [k: string]: unknown }} RoomConfig */
/** @typedef {{ from?: string[], staleAfterHours?: number }} SessionConfig */
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

const SECRET_PATTERNS = [
  /xox[abprse]-[A-Za-z0-9-]+/g,
  /gh[pousr]_[A-Za-z0-9]{16,}/g,
  /github_pat_[A-Za-z0-9_]+/g,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
];

/** Strip anything that looks like a credential before it reaches a log or a room. @param {string} s */
export function redact(s) {
  let out = s;
  for (const re of SECRET_PATTERNS) out = out.replace(re, (_m, prefix) => `${typeof prefix === "string" ? prefix : ""}[redacted]`);
  return out;
}

/** @param {Config} cfg */
export function stateDir(cfg) {
  if (cfg.state) return expandHome(cfg.state);
  if (process.env.AGORA_STATE) return expandHome(process.env.AGORA_STATE);
  return path.join(homedir(), ".agora", "state");
}

/** @param {string} alias @param {string} [thread] */
export function cursorKey(alias, thread) {
  const raw = thread ? `${alias}#${thread}` : alias;
  return raw.replace(/[^A-Za-z0-9._#-]+/g, "_");
}

/**
 * A cursor file that exists with `cursor: null` is a position ("read from the start"), distinct from
 * a file that is absent (no position saved here yet). `cursor --reset` writes the former.
 * @param {string} dir @param {string} key @returns {Promise<{ exists: boolean, cursor: string | undefined }>}
 */
export async function readCursorFile(dir, key) {
  try {
    const raw = await readFile(path.join(dir, `${key}.cursor`), "utf8");
    const parsed = JSON.parse(raw);
    return { exists: true, cursor: typeof parsed.cursor === "string" ? parsed.cursor : undefined };
  } catch {
    return { exists: false, cursor: undefined };
  }
}

/** @param {string} dir @param {string} key @returns {Promise<string | undefined>} */
export async function readCursor(dir, key) {
  return (await readCursorFile(dir, key)).cursor;
}

/** @param {string} dir @param {string} key @param {string | undefined} cursor undefined records "from the start" */
export async function writeCursor(dir, key, cursor) {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${key}.cursor`);
  await writeFile(file, JSON.stringify({ cursor: cursor ?? null, at: new Date().toISOString() }) + "\n", "utf8");
}

/** Remove a saved cursor file entirely, so a session may seed again from the legacy file. @param {string} dir @param {string} key */
export async function forgetCursor(dir, key) {
  await rm(path.join(dir, `${key}.cursor`), { force: true });
}

/** @param {number} ms */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
