// @ts-check
import { ProtocolValidationError, parseCursor, readRecord, validateCursor, validateNativeId } from './common.mjs';
import { validateRegistrationRef, validateServiceRef } from './identity.mjs';
import { validateNativeReadCoverage } from './read.mjs';

/** @typedef {ReturnType<typeof validateNativeDeliveredCoverage>} NativeDeliveredCoverage */
/** A contiguous interval actually handed to the named recipient under one progress
 * owner's admission. A scan, saved cursor, or gapFree:true assertion is not delivery.
 * Syntax validation supplies no authenticity; only P1/P4's trusted progress owner may
 * attest delivery and retain its current record. No automatic promotion from a read.
 * @param {unknown} value */
export function validateNativeDeliveredCoverage(value) {
  const v = readRecord(value, ['recipient', 'service', 'coverage', 'progressId', 'admissionId']);
  return { recipient: validateRegistrationRef(v.recipient), service: validateServiceRef(v.service),
    coverage: validateNativeReadCoverage(v.coverage), progressId: validateNativeId(v.progressId), admissionId: validateNativeId(v.admissionId) };
}
/** Range uses the existing delivery vocabulary, with native opaque cursors.
 * @param {unknown} value */
export function validateDeliveryRange(value) {
  const v = readRecord(value, ['after', 'through']);
  const after = validateCursor(v.after), through = validateCursor(v.through);
  const a = parseCursor(after), t = parseCursor(through);
  if (a.epoch !== t.epoch || a.sequence > t.sequence) throw new ProtocolValidationError('context', 'range');
  return { after, through };
}
/** Match independent authenticated progress context, including service boot and exact
 * admission/progress IDs. Do not construct expected from the untrusted value itself.
 * The owner must recheck its live progress record at actual admission, not trust a
 * cached lookup result. This compares DTOs, not credentials or liveness.
 * @param {unknown} value @param {unknown} expected */
export function assertDeliveredCoverageContext(value, expected) {
  const v = validateNativeDeliveredCoverage(value);
  const e = readRecord(expected, ['recipient', 'service', 'room', 'progressId', 'admissionId']);
  // Reuse read's exact room validator through a zero-length interval; no second room grammar.
  const room = validateNativeReadCoverage({ room: e.room, fromExclusive: v.coverage.fromExclusive,
    toInclusive: v.coverage.fromExclusive, committedThrough: v.coverage.fromExclusive }).room;
  if (JSON.stringify(v.recipient) !== JSON.stringify(validateRegistrationRef(e.recipient)) ||
      JSON.stringify(v.service) !== JSON.stringify(validateServiceRef(e.service)) ||
      JSON.stringify(v.coverage.room) !== JSON.stringify(room) ||
      v.progressId !== validateNativeId(e.progressId) || v.admissionId !== validateNativeId(e.admissionId)) throw new ProtocolValidationError('context');
  return v;
}
/** Whole-range containment only, after context checks. Never stitches disjoint proofs
 * or treats committedThrough as delivered. False retains the uncovered wake pending.
 * Artifact-only sources cannot enter this range API. No ACK, cursor, queue or IO effect.
 * @param {unknown} value @param {unknown} expected @param {unknown} range */
export function coversDeliveredRange(value, expected, range) {
  const v = assertDeliveredCoverageContext(value, expected), r = validateDeliveryRange(range);
  const a = parseCursor(r.after), t = parseCursor(r.through);
  if (a.epoch !== v.coverage.room.epoch) throw new ProtocolValidationError('context', 'range');
  return parseCursor(v.coverage.fromExclusive).sequence <= a.sequence && parseCursor(v.coverage.toInclusive).sequence >= t.sequence;
}
