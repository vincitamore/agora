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

export type Attribution = "delivered" | "attached-human" | "unattributed";

export function digestBytes(bytes: string): string {
  return createHash("sha256").update(bytes, "utf8").digest("hex");
}

/**
 * Attribution comes from the authority's own write ledger, never from a missing
 * record or a held attach lease. A line matching no entry is unattributed.
 */
export function attributeRead(journal: JournalEntry[], bytes: string): Attribution {
  const digest = digestBytes(bytes);
  for (const entry of journal) {
    if (entry.source === "service" && entry.bytes === bytes) return "delivered";
    if (entry.source === "human" && entry.digest === digest && entry.byteCount === bytes.length) {
      return "attached-human";
    }
  }
  return "unattributed";
}

/** Delivered lines are stored whole. Human keystrokes are length and digest only. */
export function journalWrite(source: JournalSource, spawnId: string, bytes: string, at = new Date().toISOString()): JournalEntry {
  const digest = digestBytes(bytes);
  if (source === "service") return { at, source, spawnId, bytes, byteCount: bytes.length, digest };
  return { at, source, spawnId, byteCount: bytes.length, digest };
}
