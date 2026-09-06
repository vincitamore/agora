// @ts-check
/**
 * Seat-visible stand-down for one session. The record lives beside that session's
 * armed watches; the seat service does not start a harness, and resume does not
 * either. Draining sends SIGTERM to this session's live watch pids only.
 */
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { AgoraError, EXIT, writeFileAtomic } from "./core.mjs";
import { pidAlive } from "./session.mjs";

const BECAUSE_MAX = 400;

/** @param {string} sessionDir */
export function standDownPath(sessionDir) {
  return path.join(sessionDir, "stand-down.json");
}

/**
 * @typedef {{ session: string, bearer: string, until: string, because: string, declaredAt: string, drained: Array<{ key: string, pid: number, room?: string }> }} StandDownRecord
 */

/** @param {string} sessionDir @returns {Promise<StandDownRecord | undefined>} */
export async function readStandDown(sessionDir) {
  try {
    const rec = JSON.parse(await readFile(standDownPath(sessionDir), "utf8"));
    if (!rec || typeof rec.until !== "string" || typeof rec.because !== "string") return undefined;
    return rec;
  } catch {
    return undefined;
  }
}

/**
 * @param {string} stateRoot
 * @returns {Promise<Array<{ slug: string, dir: string, rec: StandDownRecord }>>}
 */
export async function listStandDowns(stateRoot) {
  const sessionsDir = path.join(stateRoot, "sessions");
  /** @type {string[]} */
  let slugs = [];
  try {
    slugs = await readdir(sessionsDir);
  } catch {
    return [];
  }
  /** @type {Array<{ slug: string, dir: string, rec: StandDownRecord }>} */
  const out = [];
  for (const slug of slugs.sort()) {
    const dir = path.join(sessionsDir, slug);
    const rec = await readStandDown(dir);
    if (rec) out.push({ slug, dir, rec });
  }
  return out;
}

/**
 * @param {{ sessionDir: string, slug: string, bearer: string, until: string, because: string, now?: () => Date, kill?: (pid: number, sig: NodeJS.Signals) => void, armed?: Array<{ key: string, armed: { pid: number, room?: string } }> }} opts
 */
export async function declareStandDown(opts) {
  const now = opts.now ?? (() => new Date());
  const untilMs = Date.parse(opts.until);
  if (Number.isNaN(untilMs)) throw new AgoraError("stand-down --until needs an RFC 3339 timestamp", EXIT.usage);
  if (untilMs <= now().getTime()) throw new AgoraError("stand-down --until must be in the future", EXIT.usage);
  const because = String(opts.because ?? "").trim();
  if (!because) throw new AgoraError("stand-down needs --because", EXIT.usage);
  if (because.length > BECAUSE_MAX) throw new AgoraError(`stand-down --because exceeds ${BECAUSE_MAX} characters`, EXIT.usage);

  /** @type {StandDownRecord["drained"]} */
  const drained = [];
  for (const item of opts.armed ?? []) {
    if (!pidAlive(item.armed.pid)) continue;
    try {
      (opts.kill ?? process.kill)(item.armed.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
    drained.push({ key: item.key, pid: item.armed.pid, room: item.armed.room });
  }

  /** @type {StandDownRecord} */
  const rec = {
    session: opts.slug,
    bearer: opts.bearer,
    until: new Date(untilMs).toISOString(),
    because,
    declaredAt: now().toISOString(),
    drained,
  };
  await writeFileAtomic(standDownPath(opts.sessionDir), JSON.stringify(rec, null, 2) + "\n");
  return rec;
}

/** @param {string} sessionDir */
export async function clearStandDown(sessionDir) {
  const rec = await readStandDown(sessionDir);
  await rm(standDownPath(sessionDir), { force: true });
  return rec;
}
