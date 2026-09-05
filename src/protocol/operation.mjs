// @ts-check
import { createHash } from 'node:crypto';
import { PROTOCOL_LIMITS, ProtocolValidationError, parseCursor, readArray, readEnum, readRecord, readString, validateCursor, validateDigest, validateNativeId, validateText } from './common.mjs';
import { validateAttachmentReference } from './attachment.mjs';
import { validateNativeCommitReceipt } from './receipt.mjs';

/** @typedef {ReturnType<typeof validateMessagePayload>} NativeMessagePayload */
/** @typedef {ReturnType<typeof validateBoardPayload>} NativeBoardPayload */
/** @typedef {{kind:'message',operationId:string,payload:NativeMessagePayload}|{kind:'board',operationId:string,payload:NativeBoardPayload}} NativeOperationRequest */
/** @typedef {{receipt:import('./receipt.mjs').NativeCommitReceipt,payloadDigest:string} & ({kind:'message',payload:NativeMessagePayload}|{kind:'board',payload:NativeBoardPayload})} NativeOperationEvent */

/** @param {unknown} value */
export function validateMessagePayload(value) {
  const v = readRecord(value, ['text'], ['thread', 'attachments']);
  return { text: validateText(v.text), ...(Object.hasOwn(v, 'thread') ? { thread: validateNativeId(v.thread) } : {}),
    ...(Object.hasOwn(v, 'attachments') ? { attachments: readArray(v.attachments, 'attachments', PROTOCOL_LIMITS.attachments, validateAttachmentReference) } : {}) };
}
/** Identity comes from the admitted route. Lease/fence correlate an existing allocation.
 * @param {unknown} value */
export function validateBoardPayload(value) {
  const candidate = readRecord(value, ['action', 'subject'], ['leaseId', 'fence', 'because']);
  const action = readEnum(candidate.action, 'action', ['claim', 'renew', 'release', 'contest']);
  const extra = action === 'renew' || action === 'release' ? ['leaseId', 'fence'] : action === 'contest' ? ['because'] : [];
  const v = readRecord(value, ['action', 'subject', ...extra]);
  const subject = readString(v.subject, 'subject', { min: 1, max: 256, controls: true, pattern: /^(work|human|answer|integration|verify|gap|spawn):.+$/ });
  if (action === 'renew' || action === 'release') {
    const fence = validateCursor(v.fence);
    if (parseCursor(fence).sequence === 0) throw new ProtocolValidationError('range', 'fence');
    return { action, subject, leaseId: validateNativeId(v.leaseId), fence };
  }
  if (action === 'contest') return { action, subject, because: readString(v.because, 'because', { min: 1, max: 4096 }) };
  return { action, subject };
}
/** @param {unknown} value @returns {NativeOperationRequest} */
export function validateNativeOperationRequest(value) {
  const v = readRecord(value, ['kind', 'operationId', 'payload']);
  const kind = readEnum(v.kind, 'kind', ['message', 'board']);
  const operationId = validateNativeId(v.operationId);
  return kind === 'message' ? { kind, operationId, payload: validateMessagePayload(v.payload) } : { kind, operationId, payload: validateBoardPayload(v.payload) };
}
/** Internal only: input has already passed closed recursive DTO validation.
 * @param {unknown} value @returns {string} */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = /** @type {Record<string, unknown>} */ (value);
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}
/** SHA256(UTF8(canonical({domain:'agora-native-operation/2',kind,payload}))).
 * Canonical JSON recursively sorts object keys, preserves array order and string values,
 * and uses JSON.stringify scalar spelling with no whitespace. Operation ID is bound by
 * the unchanged receipt; kind is included here so retries cannot swap event kinds.
 * This is a NEW wire digest. Never substitute it for the v1 stored payloadDigest.
 * @param {unknown} kind @param {unknown} payload */
export function nativeOperationPayloadDigest(kind, payload) {
  const k = readEnum(kind, 'kind', ['message', 'board']);
  const p = k === 'message' ? validateMessagePayload(payload) : validateBoardPayload(payload);
  return `sha256:${createHash('sha256').update(canonical({ domain: 'agora-native-operation/2', kind: k, payload: p }), 'utf8').digest('hex')}`;
}
/** @param {unknown} value @returns {NativeOperationEvent} */
export function validateNativeOperationEvent(value) {
  const v = readRecord(value, ['kind', 'receipt', 'payload', 'payloadDigest']);
  const kind = readEnum(v.kind, 'kind', ['message', 'board']);
  const payloadDigest = validateDigest(v.payloadDigest);
  if (payloadDigest !== nativeOperationPayloadDigest(kind, v.payload)) throw new ProtocolValidationError('context', 'payloadDigest');
  const receipt = validateNativeCommitReceipt(v.receipt);
  return kind === 'message' ? { kind, receipt, payload: validateMessagePayload(v.payload), payloadDigest } : { kind, receipt, payload: validateBoardPayload(v.payload), payloadDigest };
}
/** Retry equivalence only. Receipt authentication and current room authorization remain P1-owned.
 * @param {unknown} value @param {unknown} request */
export function assertNativeOperationEventContext(value, request) {
  const e = validateNativeOperationEvent(value), r = validateNativeOperationRequest(request);
  if (e.receipt.operationId !== r.operationId || e.kind !== r.kind || e.payloadDigest !== nativeOperationPayloadDigest(r.kind, r.payload)) throw new ProtocolValidationError('context');
  return e;
}
