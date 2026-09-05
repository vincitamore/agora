/**
 * Frames on <state>/native/pane.sock.
 *
 * The write surface is deliver plus attach. There is no write, send, type or keys
 * frame: a new writer cannot appear without editing this union and the two tests
 * that pin it. Onboarding is argv at exec, never a PTY write.
 */

export const FRAME_TYPES = Object.freeze([
  "hello",
  "deliver",
  "attach",
  "attach-input",
  "resize",
  "close",
] as const);

export type FrameType = (typeof FRAME_TYPES)[number];

export type HelloFrame = { type: "hello"; bootEpoch: number };
export type DeliverFrame = {
  type: "deliver";
  spawnId: string;
  deliveryId: string;
  admissionId: string;
  line: string;
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
      return { type, bootEpoch: Number(bootEpoch) };
    }
    case "deliver": {
      const spawnId = str(rec.spawnId, "deliver.spawnId");
      const deliveryId = str(rec.deliveryId, "deliver.deliveryId");
      const admissionId = str(rec.admissionId, "deliver.admissionId");
      const line = str(rec.line, "deliver.line");
      return { type, spawnId, deliveryId, admissionId, line };
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
