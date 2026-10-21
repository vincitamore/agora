// @ts-check
import { AgoraError } from "./core.mjs";

const PREFIX = /^(work|human|answer|integration|verify|gap|spawn):/;

/** Map a CLI claim/contest subject onto the native board grammar (`task:<slug>` is `work:task:<slug>`).
 * @param {string} raw */
export function asBoardSubject(raw) {
  if (typeof raw !== "string" || !raw.trim()) throw new AgoraError("board subject is empty");
  const subject = raw.trim();
  const mapped = PREFIX.test(subject) ? subject : `work:${subject}`;
  if (mapped.length > 256) throw new AgoraError("board subject exceeds 256 characters");
  return mapped;
}

/**
 * What a post's `release: <value>` does to the board: the board release act when this session holds
 * the claim, else why the claim stays. The board names accounts, and every session on a seat shares
 * the seat's account, so holding takes two facts: the holder is this seat's account, and the message
 * that carried the claim is this session's (its bearer, or an id in its posted ledger, which a
 * successor inherits with the position). A claim with no carrying message found is the account's.
 * @param {{ subjects: Array<{ subject: string, holder: { accountId: string, leaseId: string, fence: string } | null }> }} fold the board, folded now
 * @param {Map<string, { bearer: string, id: string }>} authors the message that carried each claim
 * @param {{ accountId: string | null, bearer: string, posted: Set<string> }} me
 * @param {string} value the trailer's value
 * @returns {{ subject: string, act: { action: "release", subject: string, leaseId: string, fence: string } } | { subject: string | null, reason: string }}
 */
export function boardRelease(fold, authors, me, value) {
  /** @type {string} */
  let subject;
  try { subject = asBoardSubject(value); } catch (e) { return { subject: null, reason: e instanceof Error ? e.message : String(e) }; }
  const holder = fold.subjects.find((s) => s.subject === subject)?.holder ?? null;
  if (!holder) return { subject, reason: `${subject} is not held on the board; nothing to release` };
  if (me.accountId !== null && holder.accountId !== me.accountId) return { subject, reason: `${subject} stays held: account ${holder.accountId} holds it, not this seat's` };
  const by = authors.get(subject);
  if (by && by.bearer !== me.bearer && !me.posted.has(by.id)) return { subject, reason: `${subject} stays held: it was claimed by ${by.bearer} in ${by.id}, which this session did not post` };
  return { subject, act: { action: "release", subject, leaseId: holder.leaseId, fence: holder.fence } };
}
