// @ts-check
/**
 * Hop counts on agent-to-agent wake chains.
 *
 * Two agents that each answer the other's post wake each other forever. A post a session makes
 * while answering a wake carries `hop: <n>`, one more than the highest hop among the messages that
 * woke it; a message without the trailer is hop 0, so everything written before the key existed
 * reads as the start of a chain. A watch armed with `--max-hops <n>` lets no message whose hop is
 * above `n` wake its session: the message is posted, readable and advances the cursor like any
 * filtered one, and the chain ends there. The cap is the reader's flag, never automatic, so an
 * incoming trailer steers nothing on a watch that did not ask for it.
 *
 * The count reaches the post through the session's state directory, not through the model: the
 * harness that hands a wake to the model (the agora-room extension or plugin) writes `wake.json`
 * there, with the highest hop it handed over in the current turn, and removes it when the turn
 * ends; `post` under the same session reads it. The writers live in
 * plugins/claude/agora-room/hooks/lib.js, which imports nothing from here, so the file name and
 * the `hop` field are the contract between the two.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseTrailers } from "./trailers.mjs";

export const HOP_KEY = "hop";
/** The record a harness writes beside the session's cursors while a wake turn runs. */
export const WAKE_FILE = "wake.json";
/** The cap the agora-room extension and plugin arm every resident's watch with. */
export const RESIDENT_MAX_HOPS = 4;
/** A hop is a small whole number; anything else on the line is read as no hop at all. */
const HOP_RE = /^\d{1,6}$/;

/** A trailer value as a hop: a whole number, or 0 for anything that is not one. @param {string} value */
export function hopValue(value) {
  return HOP_RE.test(value.trim()) ? Number(value.trim()) : 0;
}

/** The hop a message carries: the highest `hop:` in its trailer block, 0 when it has none. @param {string} text */
export function hopOf(text) {
  let hop = 0;
  for (const t of parseTrailers(text).trailers) if (t.key === HOP_KEY) hop = Math.max(hop, hopValue(t.value));
  return hop;
}

/**
 * The hop the session's current wake reached, from the record its harness wrote, or null when no
 * wake turn is running (no record, or one that does not parse: a post then carries no hop).
 * @param {string} sessionDir
 * @returns {Promise<number | null>}
 */
export async function readWakeHop(sessionDir) {
  let text;
  try { text = await readFile(path.join(sessionDir, WAKE_FILE), "utf8"); } catch { return null; }
  try {
    const rec = JSON.parse(text);
    return Number.isInteger(rec?.hop) && rec.hop >= 0 ? rec.hop : null;
  } catch { return null; }
}
