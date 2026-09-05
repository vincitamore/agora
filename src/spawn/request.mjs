// @ts-check
/**
 * Bounded spawn request. Every field here is the whole of what a caller may say.
 * An unknown key is exit 1 `request-field-unknown`, never ignored.
 */
import { AgoraError } from "../core.mjs";

/** @typedef {{
 *   operationId: string,
 *   harness: string,
 *   model: string,
 *   role: string,
 *   unit: string,
 *   room: string,
 *   answersTo: string,
 *   cwd: string,
 *   briefDigest: string,
 *   targetSeat: unknown,
 *   parentRecord: unknown,
 * }} SpawnRequest */

export const SPAWN_REQUEST_REQUIRED = Object.freeze([
  "operationId", "harness", "model", "role", "unit", "room", "answersTo", "cwd", "briefDigest",
]);
export const SPAWN_REQUEST_OPTIONAL = Object.freeze(["targetSeat", "parentRecord"]);
const ALLOWED = new Set([...SPAWN_REQUEST_REQUIRED, ...SPAWN_REQUEST_OPTIONAL]);

export class SpawnRequestError extends AgoraError {
  /**
   * @param {string} reason
   * @param {string[]} [namesEachKey]
   */
  constructor(reason, namesEachKey = []) {
    super(namesEachKey.length ? `${reason}: ${namesEachKey.join(", ")}` : reason, 1);
    this.name = "SpawnRequestError";
    this.reason = reason;
    this.namesEachKey = namesEachKey;
    this.recordMinted = false;
    this.slotReserved = false;
    this.briefWritten = false;
  }
}

/**
 * @param {unknown} body
 * @returns {SpawnRequest}
 */
export function parseSpawnRequest(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new SpawnRequestError("request-not-object");
  }
  const rec = /** @type {Record<string, unknown>} */ (body);
  const keys = Object.keys(rec);
  const unknown = keys.filter((k) => !ALLOWED.has(k));
  if (unknown.length) {
    throw new SpawnRequestError("request-field-unknown", unknown);
  }
  const missing = SPAWN_REQUEST_REQUIRED.filter((k) => !(k in rec));
  if (missing.length) {
    throw new SpawnRequestError("request-field-missing", missing);
  }
  return {
    operationId: String(rec.operationId),
    harness: String(rec.harness),
    model: String(rec.model),
    role: String(rec.role),
    unit: String(rec.unit),
    room: String(rec.room),
    answersTo: String(rec.answersTo),
    cwd: String(rec.cwd),
    briefDigest: String(rec.briefDigest),
    targetSeat: "targetSeat" in rec ? rec.targetSeat : null,
    parentRecord: "parentRecord" in rec ? rec.parentRecord : null,
  };
}
