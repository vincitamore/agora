// @ts-check
import { ProtocolValidationError, parseCursor, readArray, readInteger, readRecord, validateCursor, validateDigest, validateEpoch, validateRoomId } from './common.mjs';
import { validateNativeAccountRef } from './identity.mjs';
import { validateLegacyUnattestedMessage, validateNativeMessage } from './message.mjs';

/** @typedef {{host:import('./identity.mjs').AccountRef,roomId:string,epoch:string}} NativeReadRoom */
/** @typedef {{room:NativeReadRoom,fromExclusive:string,toInclusive:string,committedThrough:string}} NativeReadCoverage */
/** @typedef {ReturnType<typeof validateNativeMessage>|ReturnType<typeof validateLegacyUnattestedMessage>} NativeReadMessage */
/** @typedef {ReturnType<typeof validateNativeCheckpoint>} NativeCheckpoint */
/** @typedef {ReturnType<typeof validateNativeReadResult>} NativeReadResult */
/** A historical projection is explicit and cannot claim a strict v2 account or lifetime.
 * @param {unknown} value @returns {NativeReadMessage} */
export function validateNativeReadMessage(value) {
  // Only inspect the own property name to select a branch; that branch validates descriptors.
  if (value !== null && typeof value === 'object' && Object.hasOwn(value, 'provenance')) return validateLegacyUnattestedMessage(value);
  return validateNativeMessage(value);
}
/** @param {unknown} value */
function room(value) {
  const v = readRecord(value, ['host', 'roomId', 'epoch']);
  return { host: validateNativeAccountRef(v.host), roomId: validateRoomId(v.roomId), epoch: validateEpoch(v.epoch) };
}
/** Preserves the existing service/store checkpoint shape; digest at zero is exactly null.
 * Syntax does not verify a retained prefix: consumers compare an independently held checkpoint.
 * @param {unknown} value */
export function validateNativeCheckpoint(value) {
  const v = readRecord(value, ['roomId', 'epoch', 'sequence', 'digest']);
  const sequence = readInteger(v.sequence, 'sequence');
  if (sequence === 0 && v.digest !== null) throw new ProtocolValidationError('context', 'digest');
  return { roomId: validateRoomId(v.roomId), epoch: validateEpoch(v.epoch), sequence, digest: sequence === 0 ? null : validateDigest(v.digest) };
}
/** Native contiguous event scan only, not all-transport archive/index coverage.
 * @param {unknown} value @returns {NativeReadCoverage} */
export function validateNativeReadCoverage(value) {
  const v = readRecord(value, ['room', 'fromExclusive', 'toInclusive', 'committedThrough']);
  const r = room(v.room), fromExclusive = validateCursor(v.fromExclusive), toInclusive = validateCursor(v.toInclusive), committedThrough = validateCursor(v.committedThrough);
  const f = parseCursor(fromExclusive), t = parseCursor(toInclusive), c = parseCursor(committedThrough);
  if (f.epoch !== r.epoch || t.epoch !== r.epoch || c.epoch !== r.epoch || f.sequence > t.sequence || t.sequence > c.sequence) throw new ProtocolValidationError('context', 'coverage');
  return { room: r, fromExclusive, toInclusive, committedThrough };
}
/** Canonical/privileged native read: never expose directly as a public rendered response.
 * Empty messages may advance across board-only events. DTOs cannot prove a scan happened.
 * @param {unknown} value */
export function validateNativeReadResult(value) {
  const v = readRecord(value, ['messages', 'checkpoint', 'coverage']);
  const coverage = validateNativeReadCoverage(v.coverage), checkpoint = validateNativeCheckpoint(v.checkpoint);
  const start = parseCursor(coverage.fromExclusive).sequence, end = parseCursor(coverage.toInclusive).sequence;
  if (checkpoint.roomId !== coverage.room.roomId || checkpoint.epoch !== coverage.room.epoch || checkpoint.sequence !== end) throw new ProtocolValidationError('context', 'checkpoint');
  const messages = readArray(v.messages, 'messages', 10000, validateNativeReadMessage);
  let previous = start;
  const ids = new Set();
  for (const row of messages) {
    const m = 'provenance' in row ? row.message : row;
    const cursor = parseCursor(m.cursor);
    if (m.room !== coverage.room.roomId || cursor.epoch !== coverage.room.epoch || cursor.sequence <= previous || cursor.sequence > end || ids.has(m.id)) throw new ProtocolValidationError('context', 'messages');
    previous = cursor.sequence; ids.add(m.id);
  }
  return { messages, checkpoint, coverage };
}
/** Expected room and request position come from the authenticated connection and local progress.
 * @param {unknown} value @param {unknown} expectedRoom @param {unknown} since */
export function assertNativeReadContext(value, expectedRoom, since) {
  const v = validateNativeReadResult(value), e = room(expectedRoom), cursor = validateCursor(since);
  if (JSON.stringify(v.coverage.room) !== JSON.stringify(e) || v.coverage.fromExclusive !== cursor) throw new ProtocolValidationError('context');
  return v;
}
