// @ts-check
import { createHash } from 'node:crypto';
import { ProtocolValidationError, assertOperationContext, parseCursor, readRecord, readString, validateEpoch, validateNativeId, validateRoomId } from './common.mjs';

/** @typedef {import('./common.mjs').OperationContext} OperationContext */
/** @typedef {OperationContext & {id:string,cursor:string}} NativeCommitReceipt */
/** @typedef {{receipt:NativeCommitReceipt,duplicate:boolean}} AppendAck */
/** @typedef {OperationContext & {epoch:string}} ReceiptContext */

/** Checks syntax and the existing v1 ID derivation, not proof of host acceptance.
 * @param {unknown} value @returns {NativeCommitReceipt}
 */
export function validateNativeCommitReceipt(value) {
  const v = readRecord(value, ['roomId', 'accountId', 'operationId', 'id', 'cursor']);
  const roomId = validateRoomId(v.roomId), accountId = validateNativeId(v.accountId), operationId = validateNativeId(v.operationId);
  const id = readString(v.id, 'id', { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ });
  const expected = createHash('sha256').update(`${roomId}\0${accountId}\0${operationId}`).digest('hex');
  if (id !== expected) throw new ProtocolValidationError('context', 'id');
  const cursor = parseCursor(v.cursor);
  if (cursor.sequence === 0) throw new ProtocolValidationError('range', 'cursor');
  return { roomId, accountId, operationId, id, cursor: `${cursor.epoch}:${cursor.sequence}` };
}

/** @param {unknown} value @returns {AppendAck} */
export function validateAppendAck(value) {
  const v = readRecord(value, ['receipt', 'duplicate']);
  if (typeof v.duplicate !== 'boolean') throw new ProtocolValidationError('type', 'duplicate');
  return { receipt: validateNativeCommitReceipt(v.receipt), duplicate: v.duplicate };
}

/** Context must come from the consumer's authenticated connection, not the received JSON.
 * @param {unknown} value @param {unknown} expected @returns {NativeCommitReceipt}
 */
export function assertReceiptContext(value, expected) {
  const receipt = validateNativeCommitReceipt(value);
  const e = readRecord(expected, ['roomId', 'accountId', 'operationId', 'epoch']);
  const { roomId, accountId, operationId } = receipt;
  assertOperationContext({ roomId, accountId, operationId }, { roomId: e.roomId, accountId: e.accountId, operationId: e.operationId });
  if (parseCursor(receipt.cursor).epoch !== validateEpoch(e.epoch)) throw new ProtocolValidationError('context', 'epoch');
  return receipt;
}
