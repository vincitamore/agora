// @ts-check
/**
 * Seat-visible stand-down for one session. The record lives beside that session's
 * armed watches; the seat service does not start a harness, and resume does not
 * either. Draining sends SIGTERM to this session's live watch pids only.
 */
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { AgoraError, EXIT, writeFileAtomic } from "./core.mjs";
import { armedAlive, pidAlive } from "./session.mjs";

const BECAUSE_MAX = 400;

/** @param {string} sessionDir */
export function standDownPath(sessionDir) {
  return path.join(sessionDir, "stand-down.json");
}

/** @param {string} sessionDir @param {string} key */
export function watchStopPath(sessionDir, key) {
  return path.join(sessionDir, "armed", `${key}.stop.json`);
}

/** @param {string} sessionDir @param {string} key @param {number} bootEpoch */
export async function requestWatchStop(sessionDir, key, bootEpoch) {
  await writeFileAtomic(watchStopPath(sessionDir, key), JSON.stringify({ bootEpoch, at: new Date().toISOString() }) + "\n");
}

/** True when this watch's own generation is asked to stop. @param {string} sessionDir @param {string} key @param {number | undefined} bootEpoch */
export async function standDownRequested(sessionDir, key, bootEpoch) {
  if (typeof bootEpoch !== "number") return false;
  try {
    const rec = JSON.parse(await readFile(watchStopPath(sessionDir, key), "utf8"));
    return Boolean(rec && rec.bootEpoch === bootEpoch);
  } catch {
    return false;
  }
}

/** @param {number} pid @param {number} ms */
async function waitGone(pid, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !pidAlive(pid);
}

/**
 * @typedef {{ key: string, pid: number, room?: string, reason?: string }} StandDownWatch
 * @typedef {{ session: string, bearer: string, until: string, because: string, declaredAt: string, keepWatches: boolean, drained: StandDownWatch[], refused: StandDownWatch[], skipped: StandDownWatch[] }} StandDownRecord
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
 * Persist the stand-down intent first, then ask matching watches to exit by a
 * generation-bound stop file. No SIGTERM: a recycled pid is never signalled.
 * A watch without bootEpoch is unverified and is not asked. A watch that does
 * not acknowledge within the bound is refused, not drained.
 * @param {{ sessionDir: string, slug: string, bearer: string, until: string, because: string, keepWatches?: boolean, now?: () => Date, ackMs?: number, armed?: Array<{ key: string, armed: import("./session.mjs").ArmedWatch }> }} opts
 */
export async function declareStandDown(opts) {
  const now = opts.now ?? (() => new Date());
  const untilMs = Date.parse(opts.until);
  if (Number.isNaN(untilMs)) throw new AgoraError("stand-down --until needs an RFC 3339 timestamp", EXIT.usage);
  if (untilMs <= now().getTime()) throw new AgoraError("stand-down --until must be in the future", EXIT.usage);
  const because = String(opts.because ?? "").trim();
  if (!because) throw new AgoraError("stand-down needs --because", EXIT.usage);
  if (because.length > BECAUSE_MAX) throw new AgoraError(`stand-down --because exceeds ${BECAUSE_MAX} characters`, EXIT.usage);

  const keepWatches = Boolean(opts.keepWatches);
  /** @type {StandDownRecord} */
  const rec = {
    session: opts.slug,
    bearer: opts.bearer,
    until: new Date(untilMs).toISOString(),
    because,
    declaredAt: now().toISOString(),
    keepWatches,
    drained: [],
    refused: [],
    skipped: [],
  };
  await writeFileAtomic(standDownPath(opts.sessionDir), JSON.stringify(rec, null, 2) + "\n");

  if (keepWatches) return rec;

  const ackMs = opts.ackMs ?? 2000;
  for (const item of opts.armed ?? []) {
    const row = { key: item.key, pid: item.armed.pid, room: item.armed.room };
    if (typeof item.armed.bootEpoch !== "number") {
      rec.skipped.push({ ...row, reason: "unverified" });
      continue;
    }
    if (!armedAlive(item.armed)) {
      rec.skipped.push({ ...row, reason: "not-alive" });
      continue;
    }
    await requestWatchStop(opts.sessionDir, item.key, item.armed.bootEpoch);
    if (await waitGone(item.armed.pid, ackMs)) rec.drained.push(row);
    else rec.refused.push({ ...row, reason: "no-ack" });
  }
  await writeFileAtomic(standDownPath(opts.sessionDir), JSON.stringify(rec, null, 2) + "\n");
  return rec;
}

/** @param {string} sessionDir */
export async function clearStandDown(sessionDir) {
  const rec = await readStandDown(sessionDir);
  await rm(standDownPath(sessionDir), { force: true });
  return rec;
}
