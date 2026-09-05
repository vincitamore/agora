// @ts-check
import { PROTOCOL_LIMITS, ProtocolValidationError, parseCursor, readArray, readEnum, readInteger, readRecord, readString, readTimestamp, validateDigest, validateEpoch, validateNativeId, validateRoomId, validateText } from './common.mjs';
import { validateWireAttachment } from './attachment.mjs';
import { validateAccountBinding, validateBearerAttestation, validateHumanChannelAttestation, validateOperatorAct, validateRegistrationRef, validateServiceRef } from './identity.mjs';
import { validateOriginReference } from './origin.mjs';
import { validateMessagePayload } from './operation.mjs';

/** @typedef {ReturnType<typeof validateAppendRequest>} AppendRequest */
/** @typedef {ReturnType<typeof validateNativeMessage>} NativeMessage */
/** @typedef {ReturnType<typeof validateLegacyUnattestedMessage>} LegacyUnattestedMessage */

/** @param {unknown} value */
export function validateAppendRequest(value) {
  const v = readRecord(value, ['operationId', 'text'], ['thread', 'attachments']);
  const { operationId, ...payload } = v;
  return { operationId: validateNativeId(operationId), ...validateMessagePayload(payload) };
}
/** @param {unknown} value */
function author(value) {
  const v = readRecord(value, ['id', 'name', 'kind']);
  return { id: validateNativeId(v.id), name: readString(v.name, 'name', { min: 1, max: 120, controls: true }), kind: readEnum(v.kind, 'kind', ['human', 'agent', 'unknown', 'system']) };
}
/** @param {unknown} value @param {string} field @param {number} units @param {number} [min] */
function legacyString(value, field, units, min = 0) {
  const text = readString(value, field, { min, max: units * 4 });
  if (text.length > units) throw new ProtocolValidationError('range', field);
  return text;
}
/** @param {Record<string, unknown>} v @param {boolean} [legacy] */
function base(v, legacy = false) {
  const cursor = parseCursor(v.cursor);
  if (cursor.sequence === 0) throw new ProtocolValidationError('range', 'cursor');
  const a = legacy ? readRecord(v.author, ['id', 'name', 'kind']) : undefined;
  const parsedAuthor = a ? { id: validateNativeId(a.id), name: legacyString(a.name, 'name', 120, 1), kind: readEnum(a.kind, 'kind', ['human', 'agent', 'unknown']) } : author(v.author);
  return { id: readString(v.id, 'id', { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ }), room: validateRoomId(v.room),
    ...(Object.hasOwn(v, 'thread') ? { thread: validateNativeId(v.thread) } : {}),
    author: parsedAuthor, text: validateText(v.text), ts: readTimestamp(v.ts), cursor: `${cursor.epoch}:${cursor.sequence}` };
}
/** New strict canonical shape only. Effective author kind and native-agent bearer requirement
 * belong to route admission via assertMessageContext, never sender-supplied payload.
 * This validator does not authenticate attestations or verify a v1 stored message hash.
 * @param {unknown} value */
export function validateNativeMessage(value) {
  const v = readRecord(value, ['id', 'room', 'author', 'text', 'ts', 'cursor', 'account'], ['thread', 'bearer', 'humanChannel', 'operator_act', 'origin', 'attachments']);
  const message = base(v), account = validateAccountBinding(v.account);
  const bearer = Object.hasOwn(v, 'bearer') ? validateBearerAttestation(v.bearer) : undefined;
  const humanChannel = Object.hasOwn(v, 'humanChannel') ? validateHumanChannelAttestation(v.humanChannel) : undefined;
  if (message.author.id !== account.accountId || (bearer && (bearer.accountId !== account.accountId || JSON.stringify(bearer.attestor) !== JSON.stringify(account.attestor))) || (humanChannel && (humanChannel.accountId !== account.accountId || JSON.stringify(humanChannel.attestor) !== JSON.stringify(account.attestor)))) throw new ProtocolValidationError('context', 'account');
  return { ...message, account, ...(bearer ? { bearer } : {}), ...(humanChannel ? { humanChannel } : {}),
    ...(Object.hasOwn(v, 'operator_act') ? { operator_act: validateOperatorAct(v.operator_act) } : {}),
    ...(Object.hasOwn(v, 'origin') ? { origin: validateOriginReference(v.origin) } : {}),
    ...(Object.hasOwn(v, 'attachments') ? { attachments: readArray(v.attachments, 'attachments', PROTOCOL_LIMITS.attachments, validateWireAttachment) } : {}) };
}
/** Caller constructs expected context from its admitted route/channel. Optional bearer is the
 * required registration for native registered-agent appends, absent for imported/service rows.
 * @param {unknown} value @param {unknown} expected */
export function assertMessageContext(value, expected) {
  const m = validateNativeMessage(value), e = readRecord(expected, ['roomId', 'epoch', 'accountId', 'authorKind', 'attestor'], ['bearer']);
  if (m.room !== validateRoomId(e.roomId) || parseCursor(m.cursor).epoch !== validateEpoch(e.epoch) || m.account.accountId !== validateNativeId(e.accountId) || m.author.kind !== readEnum(e.authorKind, 'authorKind', ['human', 'agent', 'unknown', 'system']) || JSON.stringify(m.account.attestor) !== JSON.stringify(validateServiceRef(e.attestor))) throw new ProtocolValidationError('context');
  if (Object.hasOwn(e, 'bearer')) {
    const b = validateRegistrationRef(e.bearer);
    if (!m.bearer || m.bearer.accountId !== b.accountId || m.bearer.registrationId !== b.registrationId || m.bearer.generation !== b.generation) throw new ProtocolValidationError('context', 'bearer');
  }
  return m;
}
/** Explicit historical metadata validator: no lifetime default and no local path.
 * Does not reconstruct the old store's digest inputs; only call after v1 record verification.
 * @param {unknown} value */
function legacyAttachment(value) {
  const v = readRecord(value, ['id', 'digest', 'name', 'kind', 'size'], ['mimetype', 'width', 'height']);
  return { id: validateNativeId(v.id), digest: validateDigest(v.digest), name: legacyString(v.name, 'name', 255, 1), kind: readEnum(v.kind, 'kind', ['image', 'file']), size: readInteger(v.size, 'size'),
    ...(Object.hasOwn(v, 'mimetype') ? { mimetype: legacyString(v.mimetype, 'mimetype', 200) } : {}),
    ...(Object.hasOwn(v, 'width') ? { width: readInteger(v.width, 'width', 1) } : {}),
    ...(Object.hasOwn(v, 'height') ? { height: readInteger(v.height, 'height', 1) } : {}) };
}
/** Separate explicit unattested projection. Never accepts v2 account/bearer claims or adds
 * attestation/lifetime to old bytes. This is not the legacy store decoder or a migration.
 * Historical ill-formed Unicode is outside this new UTF-8 projection's representable domain.
 * @param {unknown} value */
export function validateLegacyUnattestedMessage(value) {
  const v = readRecord(value, ['provenance', 'message']);
  const provenance = readEnum(v.provenance, 'provenance', ['legacy-unattested']);
  const m = readRecord(v.message, ['id', 'room', 'author', 'text', 'ts', 'cursor'], ['thread', 'attachments']);
  return { provenance, message: { ...base(m, true), ...(Object.hasOwn(m, 'attachments') ? { attachments: readArray(m.attachments, 'attachments', PROTOCOL_LIMITS.attachments, legacyAttachment) } : {}) } };
}
