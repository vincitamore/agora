// @ts-check
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { AgoraError } from "./core.mjs";

export const NATIVE_PROTOCOL = "agora-native/1";
export const NATIVE_FRAME_MAX = 1024 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const EPOCH_RE = /^[a-f0-9]{32}$/;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** @param {unknown} value @returns {string} */
function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new AgoraError("native protocol values must contain finite JSON numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const record = /** @type {Record<string, unknown>} */ (value);
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  throw new AgoraError("native protocol values must be JSON data");
}

/** Stable across object key order; arrays retain their declared order. @param {unknown} value */
export function canonicalJson(value) {
  return canonical(value);
}

/** @param {unknown} value */
export function nativeDigest(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

const HANDSHAKE_PHASES = new Set(["server", "client", "welcome", "member-server", "member-client", "member-welcome"]);

/**
 * Proves possession of the seat-local service secret without putting that
 * reusable secret on the socket. Every phase covers the complete transcript
 * accumulated so far, including the service boot epoch.
 * @param {string} secret
 * @param {"server" | "client" | "welcome"} phase
 * @param {Record<string, unknown>} transcript
 */
export function nativeHandshakeProof(secret, phase, transcript) {
  validateNativeId(secret, "service secret");
  if (!HANDSHAKE_PHASES.has(phase)) throw new AgoraError(`native handshake has an invalid ${JSON.stringify(phase)} phase`);
  return createHmac("sha256", secret).update(canonicalJson({ ...transcript, phase, protocol: NATIVE_PROTOCOL })).digest("hex");
}

/**
 * @param {unknown} proof
 * @param {string} secret
 * @param {"server" | "client" | "welcome"} phase
 * @param {Record<string, unknown>} transcript
 */
export function verifyNativeHandshakeProof(proof, secret, phase, transcript) {
  if (typeof proof !== "string" || !/^[a-f0-9]{64}$/.test(proof)) return false;
  const expected = nativeHandshakeProof(secret, phase, transcript);
  return timingSafeEqual(Buffer.from(proof, "hex"), Buffer.from(expected, "hex"));
}

/** @param {string} value @param {string} label */
export function validateNativeId(value, label = "id") {
  if (!ID_RE.test(value)) throw new AgoraError(`native ${label} must be 16-128 URL-safe characters`);
  return value;
}

/** @param {string} value */
export function validateNativeEpoch(value) {
  if (!EPOCH_RE.test(value)) throw new AgoraError("native room epoch must be 32 lowercase hexadecimal characters");
  return value;
}

/** @param {string} epoch @param {number} sequence */
export function nativeCursor(epoch, sequence) {
  validateNativeEpoch(epoch);
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new AgoraError("native room sequence must be a non-negative safe integer");
  return `${epoch}:${sequence}`;
}

/** @param {string} cursor */
export function parseNativeCursor(cursor) {
  const match = cursor.match(/^([a-f0-9]{32}):(0|[1-9][0-9]*)$/);
  if (!match) throw new AgoraError(`bad native room cursor ${JSON.stringify(cursor)} (expected <epoch>:<sequence>)`);
  const sequence = Number(match[2]);
  if (!Number.isSafeInteger(sequence)) throw new AgoraError(`native room cursor sequence is too large: ${JSON.stringify(cursor)}`);
  return { epoch: match[1], sequence };
}

/**
 * The stream is length-prefixed so a message body may contain any text without line parsing.
 * A declared length is checked before the payload is buffered further.
 * @param {unknown} value
 * @param {number} [maximum]
 */
/**
 * The byte length `encodeNativeFrame` would refuse or accept, without allocating the frame.
 *
 * Exported so a caller that must decide how much of a result fits measures it the way the encoder
 * does. A second measurement written beside the encoder drifts the first time the envelope gains a
 * field, and it drifts silently: the caller believes it is under the bound and the encoder throws.
 * @param {unknown} value
 */
export function nativeFramePayloadBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function encodeNativeFrame(value, maximum = NATIVE_FRAME_MAX) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (!payload.length || payload.length > maximum) throw new AgoraError(`native protocol frame must be 1-${maximum} bytes`);
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export class NativeFrameDecoder {
  /** @param {{ maximum?: number }} [options] */
  constructor(options = {}) {
    this.maximum = options.maximum ?? NATIVE_FRAME_MAX;
    this.buffer = Buffer.alloc(0);
  }

  /** @param {Uint8Array} bytes */
  push(bytes) {
    const chunk = Buffer.from(bytes);
    /** @type {unknown[]} */
    const values = [];
    let offset = 0;
    while (offset < chunk.length) {
      if (this.buffer.length < 4) {
        const take = Math.min(4 - this.buffer.length, chunk.length - offset);
        this.buffer = Buffer.concat([this.buffer, chunk.subarray(offset, offset + take)]);
        offset += take;
        if (this.buffer.length < 4) break;
      }
      const length = this.buffer.readUInt32BE(0);
      if (length < 1 || length > this.maximum) throw new AgoraError(`native protocol declared an invalid ${length}-byte frame`);
      const total = 4 + length;
      if (this.buffer.length < total) {
        const take = Math.min(total - this.buffer.length, chunk.length - offset);
        this.buffer = Buffer.concat([this.buffer, chunk.subarray(offset, offset + take)]);
        offset += take;
        if (this.buffer.length < total) break;
      }
      let raw;
      try { raw = UTF8.decode(this.buffer.subarray(4, total)); }
      catch { throw new AgoraError("native protocol frame is not valid UTF-8"); }
      this.buffer = Buffer.alloc(0);
      let value;
      try { value = JSON.parse(raw); }
      catch { throw new AgoraError("native protocol frame is not valid JSON"); }
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new AgoraError("native protocol frame must contain a JSON object");
      values.push(value);
    }
    return values;
  }

  finish() {
    if (this.buffer.length) throw new AgoraError("native protocol stream ended inside a frame");
  }
}

/** @param {unknown} value */
export function validateNativeEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AgoraError("native protocol envelope must be an object");
  const envelope = /** @type {Record<string, unknown>} */ (value);
  if (envelope.protocol !== NATIVE_PROTOCOL) throw new AgoraError(`unsupported native protocol ${JSON.stringify(envelope.protocol)}`);
  if (typeof envelope.type !== "string" || !/^[a-z][a-z0-9-]{1,40}$/.test(envelope.type)) throw new AgoraError("native protocol envelope needs a bounded type");
  if (typeof envelope.requestId !== "string") throw new AgoraError("native protocol envelope needs requestId");
  validateNativeId(envelope.requestId, "requestId");
  return envelope;
}
