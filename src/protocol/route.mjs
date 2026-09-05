// @ts-check
import { createHash } from 'node:crypto';
import { ProtocolValidationError, readEnum, readInteger, readRecord, readString, readTimestamp, validateDigest, validateEpoch, validateNativeId, validateRoomId } from './common.mjs';
import { validateAccountRef, validateNativeAccountRef } from './identity.mjs';

/** @typedef {ReturnType<typeof validateRouteBinding>} RouteBinding */
/** @typedef {ReturnType<typeof validateRouteDescriptor>} RouteDescriptor */
/** @typedef {ReturnType<typeof validateRouteStatus>} RouteStatus */

/** Full digest of canonical PUBLIC nodekey text, not decoded key bytes or display fingerprint.
 * @param {unknown} value */
export function publicNodeKeyDigest(value) {
  const text = readString(value, 'nodeKey', { min: 72, max: 72, pattern: /^nodekey:[a-f0-9]{64}$/ });
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}
/** @param {unknown} value */
export function validateRouteBinding(value) {
  const v = readRecord(value, ['host', 'member', 'accountId', 'serviceBootId', 'roomId', 'roomEpoch', 'membershipRevision', 'grantId', 'routeGeneration', 'allowedKeyDigest']);
  return { host: validateNativeAccountRef(v.host), member: validateAccountRef(v.member), accountId: validateNativeId(v.accountId), serviceBootId: validateNativeId(v.serviceBootId),
    roomId: validateRoomId(v.roomId), roomEpoch: validateEpoch(v.roomEpoch), membershipRevision: readInteger(v.membershipRevision, 'membershipRevision', 1),
    grantId: validateNativeId(v.grantId), routeGeneration: validateNativeId(v.routeGeneration), allowedKeyDigest: validateDigest(v.allowedKeyDigest) };
}
/** @param {unknown} value */
export function validateRouteDescriptor(value) {
  const v = readRecord(value, ['binding', 'protocol', 'endpoint', 'issuedAt', 'descriptorDigest', 'proofRef']);
  const e = readRecord(v.endpoint, ['transport', 'address', 'port']);
  return { binding: validateRouteBinding(v.binding), protocol: readEnum(v.protocol, 'protocol', ['agora-native/1']),
    endpoint: { transport: readEnum(e.transport, 'transport', ['tailcat']), address: readString(e.address, 'address', { min: 20, max: 1800, pattern: /^[A-Za-z0-9._:~+-]+$/ }), port: readInteger(e.port, 'port', 1, 65535) },
    issuedAt: readTimestamp(v.issuedAt), descriptorDigest: validateDigest(v.descriptorDigest), proofRef: readString(v.proofRef, 'proofRef', { min: 1, max: 512, controls: true }) };
}
/** @param {unknown} value */
export function validateRouteStatus(value) {
  const v = readRecord(value, ['binding', 'authority', 'resource', 'observedAt'], ['code']);
  return { binding: validateRouteBinding(v.binding), authority: readEnum(v.authority, 'authority', ['active', 'revoked', 'unknown']),
    resource: readEnum(v.resource, 'resource', ['starting', 'ready', 'stopping', 'closed', 'cleanup-pending', 'unknown']), observedAt: readTimestamp(v.observedAt),
    ...(Object.hasOwn(v, 'code') ? { code: readString(v.code, 'code', { min: 1, max: 64, pattern: /^[a-z][a-z0-9-]{0,63}$/ }) } : {}) };
}
/** Every field compared. membershipRevision belongs to grantId, never a global log counter.
 * No check of live authority, policy, revocation, key possession or resource state happens here.
 * @param {unknown} value @param {unknown} expected */
export function assertRouteContext(value, expected) {
  const a = validateRouteBinding(value), e = validateRouteBinding(expected);
  if (JSON.stringify(a) !== JSON.stringify(e)) throw new ProtocolValidationError('context');
  return a;
}
