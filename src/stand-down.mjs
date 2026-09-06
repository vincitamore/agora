// @ts-check
/**
 * Seat-visible stand-down for one session. The record lives beside that session's
 * armed watches; the seat service does not start a harness, and resume does not
 * either. Draining is a per-arm generation stop file plus an ack from that generation.
 */
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { AgoraError, EXIT, writeFileAtomic } from "./core.mjs";

const BECAUSE_MAX = 400;

/** @param {string} sessionDir */
export function standDownPath(sessionDir) {
  return path.join(sessionDir, "stand-down.json");
}

/** @param {string} sessionDir @param {string} key */
export function watchStopPath(sessionDir, key) {
  return path.join(sessionDir, "armed", `${key}.stop.json`);
}

/** @param {string} sessionDir @param {string} key */
export function watchAckPath(sessionDir, key) {
  return path.join(sessionDir, "armed", `${key}.stop.ack.json`);
}

/** @param {string} sessionDir @param {string} key @param {string} generation */
export async function requestWatchStop(sessionDir, key, generation) {
  await writeFileAtomic(watchStopPath(sessionDir, key), JSON.stringify({ generation, at: new Date().toISOString() }) + "\n");
}

/** True when this running watch's own generation is asked to stop.
 * @param {string} sessionDir @param {string} key @param {string} generation */
export async function standDownRequested(sessionDir, key, generation) {
  if (typeof generation !== "string" || !generation) return false;
  try {
    const rec = JSON.parse(await readFile(watchStopPath(sessionDir, key), "utf8"));
    return Boolean(rec && rec.generation === generation);
  } catch {
    return false;
  }
}

/** @param {string} sessionDir @param {string} key @param {string} generation */
export async function ackWatchStop(sessionDir, key, generation) {
  await writeFileAtomic(watchAckPath(sessionDir, key), JSON.stringify({ generation, at: new Date().toISOString() }) + "\n");
}

/** @param {string} sessionDir @param {string} key @param {string} generation @param {number} ms */
async function waitAck(sessionDir, key, generation, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const rec = JSON.parse(await readFile(watchAckPath(sessionDir, key), "utf8"));
      if (rec && rec.generation === generation) return true;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  try {
    const rec = JSON.parse(await readFile(watchAckPath(sessionDir, key), "utf8"));
    return Boolean(rec && rec.generation === generation);
  } catch {
    return false;
  }
}

/** @param {string} sessionDir @param {string} key */
export async function clearWatchStop(sessionDir, key) {
  await rm(watchStopPath(sessionDir, key), { force: true });
  await rm(watchAckPath(sessionDir, key), { force: true });
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
 * A watch without generation is unverified and is not asked. A watch that does
 * not ack that generation within the bound is refused, not drained. waitGone is not used.
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
    const generation = item.armed.generation;
    if (typeof generation !== "string" || !generation) {
      rec.skipped.push({ ...row, reason: "unverified" });
      continue;
    }
    await requestWatchStop(opts.sessionDir, item.key, generation);
    if (await waitAck(opts.sessionDir, item.key, generation, ackMs)) rec.drained.push(row);
    else rec.refused.push({ ...row, reason: "no-ack" });
  }
  await writeFileAtomic(standDownPath(opts.sessionDir), JSON.stringify(rec, null, 2) + "\n");
  return rec;
}

/** @param {string} sessionDir */
export async function clearStandDown(sessionDir) {
  const rec = await readStandDown(sessionDir);
  await rm(standDownPath(sessionDir), { force: true });
  /** @type {string[]} */
  let files = [];
  try {
    files = await readdir(path.join(sessionDir, "armed"));
  } catch { /* no armed dir */ }
  for (const f of files) {
    if (f.endsWith(".stop.json") || f.endsWith(".stop.ack.json"))
      await rm(path.join(sessionDir, "armed", f), { force: true });
  }
  return rec;
}
