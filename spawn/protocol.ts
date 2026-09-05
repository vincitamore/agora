/**
 * Frames on <state>/native/pane.sock.
 *
 * The write surface is deliver plus attach. There is no write, send, type or keys
 * frame: a new writer cannot appear without editing this union and the two tests
 * that pin it. Onboarding is argv at exec, never a PTY write.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { DeliveredEnvelope } from "./delivered-line.ts";

export const FRAME_TYPES = Object.freeze([
  "hello",
  "open",
  "deliver",
  "attach",
  "attach-input",
  "resize",
  "close",
] as const);

export type FrameType = (typeof FRAME_TYPES)[number];

export const ADMISSION_KINDS = Object.freeze(["native-enqueue", "receiver-atomic-accept"] as const);
export type AdmissionKind = (typeof ADMISSION_KINDS)[number];
export type Admission = { kind: AdmissionKind; id: string };

export type HelloFrame = { type: "hello"; bootEpoch: number; proof?: string; challenge?: string };
export type OpenFrame = { type: "open"; spawnId: string };
export type DeliverFrame = {
  type: "deliver";
  spawnId: string;
  admission: Admission;
  envelope: DeliveredEnvelope;
};
export type AttachFrame = { type: "attach"; spawnId: string; session: string };
export type AttachInputFrame = {
  type: "attach-input";
  spawnId: string;
  session: string;
  bytes: string;
};
export type ResizeFrame = { type: "resize"; spawnId: string; cols: number; rows: number };
export type CloseFrame = { type: "close"; spawnId: string };

export type Frame =
  | HelloFrame
  | OpenFrame
  | DeliverFrame
  | AttachFrame
  | AttachInputFrame
  | ResizeFrame
  | CloseFrame;

const FORBIDDEN = Object.freeze(["write", "send", "type", "keys"]);

export function isFrameType(value: unknown): value is FrameType {
  return typeof value === "string" && (FRAME_TYPES as readonly string[]).includes(value);
}

/** Parse one JSON object as a pane frame. Unknown or forbidden types refuse. */
export function parseFrame(value: unknown): Frame {
  if (!value || typeof value !== "object") throw new Error("pane frame must be an object");
  const rec = value as Record<string, unknown>;
  const type = rec.type;
  if (typeof type !== "string") throw new Error("pane frame needs type");
  if (FORBIDDEN.includes(type)) throw new Error(`pane frame type ${type} is not a writer this package has`);
  if (!isFrameType(type)) throw new Error(`pane frame type ${type} is unknown`);
  switch (type) {
    case "hello": {
      const bootEpoch = rec.bootEpoch;
      if (!Number.isInteger(bootEpoch) || Number(bootEpoch) <= 0) throw new Error("hello needs bootEpoch");
      const proof = rec.proof;
      const challenge = rec.challenge;
      if (proof !== undefined && (typeof proof !== "string" || !/^[a-f0-9]{64}$/.test(proof))) {
        throw new Error("hello proof must be 64 hex");
      }
      if (challenge !== undefined && (typeof challenge !== "string" || challenge.length < 16)) {
        throw new Error("hello challenge must be a nonce");
      }
      return {
        type,
        bootEpoch: Number(bootEpoch),
        ...(proof ? { proof } : {}),
        ...(challenge ? { challenge } : {}),
      };
    }
    case "open": {
      if ("cmd" in rec) throw new Error("open refuses a cmd key; the authority decides the pane child");
      return { type, spawnId: str(rec.spawnId, "open.spawnId") };
    }
    case "deliver": {
      if ("line" in rec) throw new Error("deliver refuses a line key; the authority renders the envelope");
      if ("admissionId" in rec) throw new Error("deliver refuses admissionId; admission is {kind, id}");
      return {
        type,
        spawnId: str(rec.spawnId, "deliver.spawnId"),
        admission: parseAdmission(rec.admission),
        envelope: parseEnvelope(rec.envelope),
      };
    }
    case "attach":
      return { type, spawnId: str(rec.spawnId, "attach.spawnId"), session: str(rec.session, "attach.session") };
    case "attach-input":
      return {
        type,
        spawnId: str(rec.spawnId, "attach-input.spawnId"),
        session: str(rec.session, "attach-input.session"),
        bytes: str(rec.bytes, "attach-input.bytes"),
      };
    case "resize": {
      const cols = rec.cols;
      const rows = rec.rows;
      if (!Number.isInteger(cols) || !Number.isInteger(rows)) throw new Error("resize needs integer cols and rows");
      return { type, spawnId: str(rec.spawnId, "resize.spawnId"), cols: Number(cols), rows: Number(rows) };
    }
    case "close":
      return { type, spawnId: str(rec.spawnId, "close.spawnId") };
  }
}

function str(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a non-empty string`);
  return value;
}

export function isAdmissionKind(value: unknown): value is AdmissionKind {
  return typeof value === "string" && (ADMISSION_KINDS as readonly string[]).includes(value);
}

function parseAdmission(value: unknown): Admission {
  if (!value || typeof value !== "object") throw new Error("deliver needs admission {kind, id}");
  const rec = value as Record<string, unknown>;
  const kind = rec.kind;
  if (kind === "idle-sample" || kind === "idle") {
    throw new Error("admission.kind idle-sample is not an admission");
  }
  if (!isAdmissionKind(kind)) throw new Error("admission.kind is not a receiver-owned admission");
  return { kind, id: str(rec.id, "admission.id") };
}

function parseEnvelope(value: unknown): DeliveredEnvelope {
  if (!value || typeof value !== "object") throw new Error("deliver needs envelope");
  const rec = value as Record<string, unknown>;
  const cursorRange = rec.cursorRange;
  if (!cursorRange || typeof cursorRange !== "object") throw new Error("envelope needs cursorRange");
  const range = cursorRange as Record<string, unknown>;
  return {
    deliveryId: field(rec.deliveryId, "envelope.deliveryId"),
    seat: field(rec.seat, "envelope.seat"),
    bearer: field(rec.bearer, "envelope.bearer"),
    room: field(rec.room, "envelope.room"),
    cursorRange: {
      from: field(range.from, "envelope.cursorRange.from"),
      to: field(range.to, "envelope.cursorRange.to"),
    },
    since: field(rec.since, "envelope.since"),
  };
}

/** Envelope fields are interpolated into a PTY write; C0 and DEL cannot ride. */
function field(value: unknown, name: string): string {
  const s = str(value, name);
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 32 || code === 127) throw new Error(`${name} refuses control bytes`);
  }
  return s;
}

export function mintPaneNonce(): string {
  return randomBytes(16).toString("hex");
}

export function mintPaneChallenge(): string {
  return randomBytes(16).toString("hex");
}

/** HMAC-SHA256 of the hello transcript under the per-authority nonce. The nonce never rides the wire. */
export function paneHelloProof(nonce: string, bootEpoch: number, challenge: string): string {
  return createHmac("sha256", nonce).update(`pane-hello:${bootEpoch}:${challenge}`).digest("hex");
}

export function verifyPaneHelloProof(nonce: string, bootEpoch: number, challenge: string, proof: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(proof)) return false;
  const expected = paneHelloProof(nonce, bootEpoch, challenge);
  return timingSafeEqual(Buffer.from(proof, "hex"), Buffer.from(expected, "hex"));
}
