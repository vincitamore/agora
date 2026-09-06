// @ts-check
import { AgoraError } from "./core.mjs";

const PREFIX = /^(work|human|answer|integration|verify|gap|spawn):/;

/** Map a CLI claim/contest subject onto the native board grammar.
 * @param {string} raw */
export function asBoardSubject(raw) {
  if (typeof raw !== "string" || !raw.trim()) throw new AgoraError("board subject is empty");
  const subject = raw.trim();
  const mapped = PREFIX.test(subject) ? subject : `work:${subject}`;
  if (mapped.length > 256) throw new AgoraError("board subject exceeds 256 characters");
  return mapped;
}
