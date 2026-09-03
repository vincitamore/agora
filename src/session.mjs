// @ts-check
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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
/** A bearer is a path: model, then optionally what this session is for. `Grace`, `Grace/watch`, `Opus/design`. */
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
 * --as on the call, then AGORA_ACTOR, then the shared config's actor.name.
 * @param {import('./core.mjs').Config} cfg
 * @param {{ as?: string, env: NodeJS.ProcessEnv }} opts
 * @returns {Bearer}
 */
export function resolveBearer(cfg, { as, env }) {
  const pick = as !== undefined ? { name: as, source: "--as" } : env.AGORA_ACTOR !== undefined ? { name: env.AGORA_ACTOR, source: "AGORA_ACTOR" } : { name: cfg.actor.name, source: "config" };
  const name = pick.name.trim();
  if (pick.source !== "config" && (!BEARER_RE.test(name) || name.length > BEARER_MAX))
    throw new AgoraError(`${pick.source} must be a bearer path like Grace or Grace/watch (letters, digits, . _ -; segments joined by /; at most ${BEARER_MAX} characters)`, EXIT.usage);
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
