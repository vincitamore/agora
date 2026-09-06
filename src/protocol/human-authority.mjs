// @ts-check
// Q1 syntax and signing bytes only. No enrollment, custody, signature verification,
// human-presence check, admission, replay storage or store mutation happens here.
import { createHash } from 'node:crypto';
import { ProtocolValidationError, readEnum, readInteger, readRecord, readString, readTimestamp, validateDigest, validateEpoch, validateNativeId, validateRoomId } from './common.mjs';
import { validateNativeAccountRef, validateRegistrationRef, validateServiceRef } from './identity.mjs';

export const HUMAN_CHALLENGE_MAX_MS = 120000;
/** @param {unknown} value @param {number} bytes @param {string} field */
function hex(value, bytes, field) {
  return readString(value, field, { min: bytes * 2, max: bytes * 2, pattern: /^[a-f0-9]+$/ });
}
/** Raw Ed25519 public key fingerprint, not authority or a shortened display name.
 * @param {unknown} publicKey */
export function humanKeyId(publicKey) {
  return `sha256:${createHash('sha256').update(Buffer.from(hex(publicKey, 32, 'publicKey'), 'hex')).digest('hex')}`;
}
/** A candidate is inert even when its key ID matches. Enrollment needs an independent
 * protected bootstrap/rotation decision and proof of possession; see HUMAN-AUTHORITY.md.
 * @param {unknown} value */
export function validateHumanKeyCandidate(value) {
  const v = readRecord(value, ['version', 'authorityId', 'algorithm', 'publicKey', 'keyId']);
  const publicKey = hex(v.publicKey, 32, 'publicKey');
  const keyId = validateDigest(v.keyId);
  if (keyId !== humanKeyId(publicKey)) throw new ProtocolValidationError('context', 'keyId');
  return { version: readInteger(v.version, 'version', 1, 1), authorityId: validateNativeId(v.authorityId),
    algorithm: readEnum(v.algorithm, 'algorithm', ['ed25519']), publicKey, keyId };
}
/** Target-issued statement for ONE exact operation, never a session-wide human bit.
 * Equality to retained target context and target-clock checks are consumer obligations.
 * @param {unknown} value */
export function validateHumanOperationChallenge(value) {
  const v = readRecord(value, ['version', 'action', 'authorityId', 'keyId', 'host', 'service', 'room', 'requester', 'operationId', 'requestDigest', 'policyRevision', 'challengeId', 'nonce', 'issuedAt', 'expiresAt']);
  const room = readRecord(v.room, ['roomId', 'epoch']);
  const issuedAt = readTimestamp(v.issuedAt), expiresAt = readTimestamp(v.expiresAt);
  const span = Date.parse(expiresAt) - Date.parse(issuedAt);
  if (span <= 0 || span > HUMAN_CHALLENGE_MAX_MS) throw new ProtocolValidationError('range', 'expiresAt');
  return { version: readInteger(v.version, 'version', 1, 1),
    action: readEnum(v.action, 'action', ['board-break', 'message-compose']),
    authorityId: validateNativeId(v.authorityId), keyId: validateDigest(v.keyId),
    host: validateNativeAccountRef(v.host), service: validateServiceRef(v.service),
    room: { roomId: validateRoomId(room.roomId), epoch: validateEpoch(room.epoch) },
    requester: validateRegistrationRef(v.requester), operationId: validateNativeId(v.operationId),
    requestDigest: validateDigest(v.requestDigest), policyRevision: readInteger(v.policyRevision, 'policyRevision', 1),
    challengeId: validateNativeId(v.challengeId), nonce: hex(v.nonce, 32, 'nonce'), issuedAt, expiresAt };
}
/** Exact UTF-8 JSON tuple, fixed order, domain separated; no general JSON canonicalizer.
 * The signature algorithm is plain Ed25519 over these bytes (not Ed25519ph/ctx).
 * @param {unknown} value */
export function humanOperationSigningBytes(value) {
  const v = validateHumanOperationChallenge(value);
  return Buffer.from(JSON.stringify(['agora-human-operation-v1', v.version, v.action, v.authorityId, v.keyId,
    [v.host.scheme, v.host.authority, v.host.id], [v.service.serviceId, v.service.serviceBootId],
    [v.room.roomId, v.room.epoch], [v.requester.accountId, v.requester.registrationId, v.requester.generation],
    v.operationId, v.requestDigest, v.policyRevision, v.challengeId, v.nonce, v.issuedAt, v.expiresAt]), 'utf8');
}
/** Signature LENGTH/encoding only; a successful parse must not stamp human authority.
 * @param {unknown} value */
export function validateHumanOperationProof(value) {
  const v = readRecord(value, ['challenge', 'signature']);
  return { challenge: validateHumanOperationChallenge(v.challenge), signature: hex(v.signature, 64, 'signature') };
}
