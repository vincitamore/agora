// @ts-check
import { PROTOCOL_LIMITS, ProtocolValidationError, readEnum, readInteger, readRecord, readString, readTimestamp, validateDigest, validateNativeId } from './common.mjs';

/** @typedef {{id:string,digest:string,lifetime:'offer'|'durable'}} AttachmentReference */
/** @typedef {AttachmentReference & {name:string,kind:'image'|'file',mimetype?:string,size:number,width?:number,height?:number}} WireAttachment */
/** @typedef {{attachmentId:string,state:'pending'} | {attachmentId:string,state:'unavailable',code:string,retryable:boolean} | {attachmentId:string,state:'materialized',path:string,verifiedDigest:string,verifiedSize:number,verifiedAt:string,detectedKind:'image'|'file',detectedMimetype:string}} LocalAttachmentState */

/** @param {unknown} value @returns {AttachmentReference} */
export function validateAttachmentReference(value) {
  const v = readRecord(value, ['id', 'digest', 'lifetime']);
  return { id: validateNativeId(v.id), digest: validateDigest(v.digest), lifetime: readEnum(v.lifetime, 'lifetime', ['offer', 'durable']) };
}

/** Advertised bytes reference only. No local path or verification claim crosses this boundary.
 * @param {unknown} value @returns {WireAttachment}
 */
export function validateWireAttachment(value) {
  const v = readRecord(value, ['id', 'digest', 'lifetime', 'name', 'kind', 'size'], ['mimetype', 'width', 'height']);
  return {
    ...validateAttachmentReference({ id: v.id, digest: v.digest, lifetime: v.lifetime }),
    name: readString(v.name, 'name', { min: 1, max: PROTOCOL_LIMITS.nameBytes }),
    kind: readEnum(v.kind, 'kind', ['image', 'file']),
    size: readInteger(v.size, 'size'),
    ...(Object.hasOwn(v, 'mimetype') ? { mimetype: readString(v.mimetype, 'mimetype', { min: 1, max: PROTOCOL_LIMITS.mimeBytes, controls: true }) } : {}),
    ...(Object.hasOwn(v, 'width') ? { width: readInteger(v.width, 'width', 1, 2147483647) } : {}),
    ...(Object.hasOwn(v, 'height') ? { height: readInteger(v.height, 'height', 1, 2147483647) } : {}),
  };
}

/** Local-only data shape; parsing a peer's declaration never proves the file exists.
 * @param {unknown} value @returns {LocalAttachmentState}
 */
export function validateLocalAttachmentState(value) {
  const candidate = readRecord(value, ['attachmentId', 'state'], ['code', 'retryable', 'path', 'verifiedDigest', 'verifiedSize', 'verifiedAt', 'detectedKind', 'detectedMimetype']);
  const state = readEnum(candidate.state, 'state', ['pending', 'unavailable', 'materialized']);
  const fields = state === 'pending' ? [] : state === 'unavailable' ? ['code', 'retryable'] : ['path', 'verifiedDigest', 'verifiedSize', 'verifiedAt', 'detectedKind', 'detectedMimetype'];
  const v = readRecord(value, ['attachmentId', 'state', ...fields]);
  const attachmentId = validateNativeId(v.attachmentId);
  if (state === 'pending') return { attachmentId, state };
  if (state === 'unavailable') {
    if (typeof v.retryable !== 'boolean') throw new ProtocolValidationError('type', 'retryable');
    return { attachmentId, state, code: readString(v.code, 'code', { min: 1, max: 64, pattern: /^[a-z][a-z0-9-]{0,63}$/ }), retryable: v.retryable };
  }
  return { attachmentId, state,
    path: readString(v.path, 'path', { min: 1, max: PROTOCOL_LIMITS.pathBytes, nul: true }),
    verifiedDigest: validateDigest(v.verifiedDigest), verifiedSize: readInteger(v.verifiedSize, 'verifiedSize'), verifiedAt: readTimestamp(v.verifiedAt, 'verifiedAt'),
    detectedKind: readEnum(v.detectedKind, 'detectedKind', ['image', 'file']),
    detectedMimetype: readString(v.detectedMimetype, 'detectedMimetype', { min: 1, max: PROTOCOL_LIMITS.mimeBytes, controls: true }) };
}

/** Equality only: the consumer still owns filesystem/type/hash verification and authorization.
 * Local type detection is retained, never replaced with the peer's advertised kind/MIME.
 * @param {unknown} value @param {unknown} attachment @returns {LocalAttachmentState}
 */
export function assertMaterializationContext(value, attachment) {
  const state = validateLocalAttachmentState(value), a = validateWireAttachment(attachment);
  if (state.attachmentId !== a.id || (state.state === 'materialized' && (state.verifiedDigest !== a.digest || state.verifiedSize !== a.size))) throw new ProtocolValidationError('context');
  return state;
}
