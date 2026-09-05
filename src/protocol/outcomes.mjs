// @ts-check
import { PROTOCOL_LIMITS, ProtocolValidationError, assertOperationContext, readEnum, readRecord, readString, validateEpoch, validateNativeId, validateRoomId, validateSourceRef } from './common.mjs';
import { assertReceiptContext, validateAppendAck } from './receipt.mjs';

/** @typedef {import('./common.mjs').OperationContext} PendingOperation */
/** @typedef {{status:'sent',ack:import('./receipt.mjs').AppendAck} | (PendingOperation & {status:'refused'|'unknown-acceptance',code:string})} NativePostOutcome */
/** @typedef {PendingOperation & {status:'queued',queueId:string}} QueueOutcome */
/** @typedef {{roomId:string,messageId:string,faceId:string,sourceRoom:string,publicationOperationId:string}} FaceContext */
/** @typedef {FaceContext & ({status:'pending'} | {status:'published',source:import('./common.mjs').SourceRef} | {status:'refused',code:string} | {status:'unknown',code:string,source?:import('./common.mjs').SourceRef})} FacePublication */
/** @typedef {'woken'|'enqueued'|'inbox'|'deferred'} WakeDisposition */

/** @param {Record<string,unknown>} value @returns {PendingOperation} */
function operation(value) { return { roomId: validateRoomId(value.roomId), accountId: validateNativeId(value.accountId), operationId: validateNativeId(value.operationId) }; }
/** @param {unknown} value */
function code(value) { return readString(value, 'code', { min: 1, max: PROTOCOL_LIMITS.diagnosticCodeBytes, pattern: /^[a-z][a-z0-9-]{0,63}$/ }); }

/** Syntax does not turn a claimed effect into an observed effect. @param {unknown} value @returns {NativePostOutcome} */
export function validateNativePostOutcome(value) {
  const candidate = readRecord(value, ['status'], ['ack', 'roomId', 'accountId', 'operationId', 'code']);
  const status = readEnum(candidate.status, 'status', ['sent', 'refused', 'unknown-acceptance']);
  if (status === 'sent') {
    const v = readRecord(value, ['status', 'ack']);
    return { status, ack: validateAppendAck(v.ack) };
  }
  const v = readRecord(value, ['status', 'roomId', 'accountId', 'operationId', 'code']);
  return { ...operation(v), status, code: code(v.code) };
}

/** @param {unknown} value @returns {QueueOutcome} */
export function validateQueueOutcome(value) {
  const v = readRecord(value, ['status', 'roomId', 'accountId', 'operationId', 'queueId']);
  return { ...operation(v), status: readEnum(v.status, 'status', ['queued']), queueId: validateNativeId(v.queueId) };
}

/** @param {unknown} value @returns {FacePublication} */
export function validateFacePublication(value) {
  const keys = ['roomId', 'messageId', 'faceId', 'sourceRoom', 'publicationOperationId', 'status'];
  const candidate = readRecord(value, keys, ['source', 'code']);
  const status = readEnum(candidate.status, 'status', ['pending', 'published', 'refused', 'unknown']);
  const required = status === 'published' ? ['source'] : status === 'refused' || status === 'unknown' ? ['code'] : [];
  const v = readRecord(value, [...keys, ...required], status === 'unknown' ? ['source'] : []);
  const context = { roomId: validateRoomId(v.roomId),
    messageId: readString(v.messageId, 'messageId', { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ }),
    faceId: readString(v.faceId, 'faceId', { min: 1, max: 128, pattern: /^[A-Za-z0-9_-]{1,128}$/ }),
    sourceRoom: readString(v.sourceRoom, 'sourceRoom', { min: 1, max: PROTOCOL_LIMITS.locatorBytes, controls: true }),
    publicationOperationId: validateNativeId(v.publicationOperationId) };
  const source = Object.hasOwn(v, 'source') ? validateSourceRef(v.source) : undefined;
  if (source && source.room !== context.sourceRoom) throw new ProtocolValidationError('context', 'sourceRoom');
  if (status === 'pending') return { ...context, status };
  if (status === 'published') return { ...context, status, source: validateSourceRef(v.source) };
  if (status === 'refused') return { ...context, status, code: code(v.code) };
  return { ...context, status, code: code(v.code), ...(source ? { source } : {}) };
}

/** Backend disposition only, never reader progress or business completion. @param {unknown} value @returns {WakeDisposition} */
export function validateWakeDisposition(value) { return readEnum(value, 'disposition', ['woken', 'enqueued', 'inbox', 'deferred']); }

/** @param {unknown} value @param {unknown} expected @returns {NativePostOutcome} */
export function assertPostOutcomeContext(value, expected) {
  const outcome = validateNativePostOutcome(value);
  const e = readRecord(expected, ['roomId', 'accountId', 'operationId', 'epoch']);
  validateEpoch(e.epoch);
  if (outcome.status === 'sent') assertReceiptContext(outcome.ack.receipt, e);
  else assertOperationContext(operation(outcome), { roomId: e.roomId, accountId: e.accountId, operationId: e.operationId });
  return outcome;
}
