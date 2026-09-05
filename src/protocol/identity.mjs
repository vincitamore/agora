// @ts-check
import { ProtocolValidationError, readEnum, readInteger, readRecord, readString, readTimestamp, validateCursor, validateDigest, validateEpoch, validateNativeId, validateRoomId } from './common.mjs';

/** @typedef {{scheme:'native'|'slack'|'github',authority:string,id:string}} AccountRef */
/** @typedef {{host:AccountRef}} AcceptedHostContext Syntax projection, NOT a locally authenticated handle. */
/** @typedef {{serviceId:string,serviceBootId:string}} ServiceRef */
/** @typedef {{accountId:string,registrationId:string,generation:number}} RegistrationRef */
/** @typedef {ReturnType<typeof validateNativeAccountRef>} NativeAccountRef */
/** @typedef {ReturnType<typeof validateScopedNativeIdentity>} ScopedNativeIdentity */
/** @typedef {ReturnType<typeof validateScopedNativeCursor>} ScopedNativeCursor */
/** @typedef {ReturnType<typeof validateBearerAttestation>} BearerAttestation */
/** @typedef {ReturnType<typeof validateAccountBinding>} AccountBinding */
/** @typedef {ReturnType<typeof validateHumanChannelAttestation>} HumanChannelAttestation */
/** @typedef {ReturnType<typeof validateOperatorAct>} OperatorAct */
/** @param {unknown} value */
export function validateAccountRef(value) {
  const v = readRecord(value, ['scheme', 'authority', 'id']);
  return { scheme: readEnum(v.scheme, 'scheme', ['native', 'slack', 'github']),
    authority: readString(v.authority, 'authority', { min: 1, max: 512, controls: true }),
    id: readString(v.id, 'id', { min: 1, max: 512, controls: true }) };
}
/** @param {unknown} value */
export function validateNativeAccountRef(value) {
  const v = validateAccountRef(value);
  if (v.scheme !== 'native') throw new ProtocolValidationError('variant', 'scheme');
  validateNativeId(v.id);
  return { ...v, scheme: /** @type {const} */ ('native') };
}
/** Stable enrolled principal only: never derive authority from nonce, boot, label or origin.
 * @param {unknown} value */
export function validateAcceptedHostContext(value) {
  const v = readRecord(value, ['host']);
  return { host: validateNativeAccountRef(v.host) };
}
/** Equality of independently supplied DTOs, not authentication. P1 must retain its opaque verified handle.
 * @param {unknown} actual @param {unknown} expectedEnrolledHost @param {unknown} authenticatedPeerContext */
export function assertAcceptedHostContext(actual, expectedEnrolledHost, authenticatedPeerContext) {
  const a = validateAcceptedHostContext(actual), e = validateNativeAccountRef(expectedEnrolledHost), p = validateAcceptedHostContext(authenticatedPeerContext);
  if (JSON.stringify(a.host) !== JSON.stringify(e) || JSON.stringify(a.host) !== JSON.stringify(p.host)) throw new ProtocolValidationError('context', 'host');
  return a;
}
/** @param {unknown} value */
export function validateScopedNativeIdentity(value) {
  const v = readRecord(value, ['transport', 'host', 'roomId', 'id']);
  return { transport: readEnum(v.transport, 'transport', ['native']), host: validateNativeAccountRef(v.host), roomId: validateRoomId(v.roomId),
    id: readString(v.id, 'id', { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ }) };
}
/** Collision-free structured encoding; old naked ledger rows cannot enter this API.
 * @param {unknown} value */
export function scopedNativeIdentityKey(value) {
  const v = validateScopedNativeIdentity(value);
  return JSON.stringify([v.transport, [v.host.scheme, v.host.authority, v.host.id], v.roomId, v.id]);
}
/** @param {unknown} value */
export function validateScopedNativeCursor(value) {
  const v = readRecord(value, ['host', 'roomId', 'cursor']);
  return { host: validateNativeAccountRef(v.host), roomId: validateRoomId(v.roomId), cursor: validateCursor(v.cursor) };
}
/** @param {unknown} value @param {unknown} expected */
export function assertScopedNativeCursorContext(value, expected) {
  const v = validateScopedNativeCursor(value), e = readRecord(expected, ['host', 'roomId', 'epoch']);
  if (JSON.stringify(v.host) !== JSON.stringify(validateNativeAccountRef(e.host)) || v.roomId !== validateRoomId(e.roomId) || v.cursor.slice(0, 32) !== validateEpoch(e.epoch)) throw new ProtocolValidationError('context');
  return v;
}
/** @param {unknown} value */
export function validateServiceRef(value) {
  const v = readRecord(value, ['serviceId', 'serviceBootId']);
  return { serviceId: validateNativeId(v.serviceId), serviceBootId: validateNativeId(v.serviceBootId) };
}
/** @param {unknown} value */
export function validateRegistrationRef(value) {
  const v = readRecord(value, ['accountId', 'registrationId', 'generation']);
  return { accountId: validateNativeId(v.accountId), registrationId: validateNativeId(v.registrationId), generation: readInteger(v.generation, 'generation', 1) };
}
/** @param {unknown} value */
export function validateBearerAttestation(value) {
  const v = readRecord(value, ['accountId', 'registrationId', 'generation', 'label', 'attestor']);
  return { ...validateRegistrationRef({ accountId: v.accountId, registrationId: v.registrationId, generation: v.generation }),
    label: readString(v.label, 'label', { min: 1, max: 64, pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,31})*$/ }), attestor: validateServiceRef(v.attestor) };
}
/** @param {unknown} value */
export function validateAccountBinding(value) {
  const v = readRecord(value, ['accountId', 'principal', 'attestor']);
  return { accountId: validateNativeId(v.accountId), principal: validateAccountRef(v.principal), attestor: validateServiceRef(v.attestor) };
}
/** @param {unknown} value */
export function validateHumanChannelAttestation(value) {
  const v = readRecord(value, ['accountId', 'channelId', 'attestor', 'profile'], ['evidenceRef']);
  return { accountId: validateNativeId(v.accountId), channelId: validateNativeId(v.channelId), attestor: validateServiceRef(v.attestor),
    profile: readEnum(v.profile, 'profile', ['cooperative', 'enforced']),
    ...(Object.hasOwn(v, 'evidenceRef') ? { evidenceRef: readString(v.evidenceRef, 'evidenceRef', { min: 1, max: 512, controls: true }) } : {}) };
}
/** Exact bearer/account registration and attestor context; no label or proof inference.
 * @param {unknown} value @param {unknown} expected */
export function assertIdentityContext(value, expected) {
  const a = validateBearerAttestation(value), e = readRecord(expected, ['accountId', 'registrationId', 'generation', 'attestor']);
  const r = validateRegistrationRef({ accountId: e.accountId, registrationId: e.registrationId, generation: e.generation });
  if (a.accountId !== r.accountId || a.registrationId !== r.registrationId || a.generation !== r.generation || JSON.stringify(a.attestor) !== JSON.stringify(validateServiceRef(e.attestor))) throw new ProtocolValidationError('context');
  return a;
}
/** @param {unknown} value */
export function validateOperatorAct(value) {
  const v = readRecord(value, ['version', 'action', 'authorityId', 'proofRef', 'targetServiceId', 'operationId', 'requestDigest', 'challengeId', 'issuedAt', 'expiresAt', 'revisions'], ['room']);
  const revisions = readRecord(v.revisions, ['policy'], ['membership']);
  const issuedAt = readTimestamp(v.issuedAt), expiresAt = readTimestamp(v.expiresAt);
  if (new Date(issuedAt).getTime() >= new Date(expiresAt).getTime()) throw new ProtocolValidationError('range', 'expiresAt');
  const room = Object.hasOwn(v, 'room') ? readRecord(v.room, ['roomId', 'epoch']) : undefined;
  return { version: readInteger(v.version, 'version', 1, 1),
    action: readEnum(v.action, 'action', ['room-enroll', 'room-revoke', 'room-adopt', 'policy-update', 'spawn-override', 'spawn-stop', 'terminal-override', 'archive-backfill', 'archive-purge', 'profile-configure']),
    authorityId: validateNativeId(v.authorityId), proofRef: readString(v.proofRef, 'proofRef', { min: 1, max: 512, controls: true }), targetServiceId: validateNativeId(v.targetServiceId),
    operationId: validateNativeId(v.operationId), requestDigest: validateDigest(v.requestDigest), challengeId: validateNativeId(v.challengeId), issuedAt, expiresAt,
    revisions: { policy: readInteger(revisions.policy, 'policy', 1), ...(Object.hasOwn(revisions, 'membership') ? { membership: readInteger(revisions.membership, 'membership', 1) } : {}) },
    ...(room ? { room: { roomId: validateRoomId(room.roomId), epoch: validateEpoch(room.epoch) } } : {}) };
}
/** Full expected act plus explicit now; issuer verification and atomic consumption remain local effects.
 * @param {unknown} value @param {unknown} expected @param {unknown} now */
export function assertOperatorActContext(value, expected, now) {
  const a = validateOperatorAct(value), e = validateOperatorAct(expected), time = new Date(readTimestamp(now)).getTime();
  if (JSON.stringify(a) !== JSON.stringify(e) || time < new Date(a.issuedAt).getTime() || time >= new Date(a.expiresAt).getTime()) throw new ProtocolValidationError('context');
  return a;
}
