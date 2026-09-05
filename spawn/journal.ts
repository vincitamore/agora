import { createHash } from "node:crypto";

export type JournalSource = "service" | "human";

export type JournalEntry = {
  at: string;
  source: JournalSource;
  spawnId: string;
  bytes?: string;
  byteCount: number;
  digest: string;
};

export function digestBytes(bytes: string): string {
  return createHash("sha256").update(bytes, "utf8").digest("hex");
}

/** Delivered lines are stored whole. Human keystrokes are length and digest only. */
export function journalWrite(source: JournalSource, spawnId: string, bytes: string, at = new Date().toISOString()): JournalEntry {
  const digest = digestBytes(bytes);
  if (source === "service") return { at, source, spawnId, bytes, byteCount: bytes.length, digest };
  return { at, source, spawnId, byteCount: bytes.length, digest };
}
