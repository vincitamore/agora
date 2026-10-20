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
/** The display name a human grant binds: what the store stamps as `author.name`, so the same
 * bounds (1-120 bytes, no control characters) and no leading or trailing space, because the store
 * trims a posted name and a bound name that trimmed to something else could never be matched. */
const AUTHOR_NAME = /^\S(?:[^]*\S)?$/u;
/** A route's author grant: present only on a route admitted for the member seat's HUMAN, absent on
 * every agent route (whose bindings are byte-for-byte what they were). Because it lives in the
 * binding it is covered by the descriptor's digest and by the authority act's request digest, so
 * the counter-seat authority signs it and nothing after the act can add, drop or rename it.
 * @param {unknown} value */
export function validateRouteAuthor(value) {
  const v = readRecord(value, ['kind', 'name'], [], 'author');
  return { kind: readEnum(v.kind, 'author.kind', ['human']),
    name: readString(v.name, 'author.name', { min: 1, max: 120, controls: true, pattern: AUTHOR_NAME }) };
}
/** @param {unknown} value */
export function validateRouteBinding(value) {
  const v = readRecord(value, ['host', 'member', 'accountId', 'serviceBootId', 'roomId', 'roomEpoch', 'membershipRevision', 'grantId', 'routeGeneration', 'allowedKeyDigest'], ['author']);
  return { host: validateNativeAccountRef(v.host), member: validateAccountRef(v.member), accountId: validateNativeId(v.accountId), serviceBootId: validateNativeId(v.serviceBootId),
    roomId: validateRoomId(v.roomId), roomEpoch: validateEpoch(v.roomEpoch), membershipRevision: readInteger(v.membershipRevision, 'membershipRevision', 1),
    grantId: validateNativeId(v.grantId), routeGeneration: validateNativeId(v.routeGeneration), allowedKeyDigest: validateDigest(v.allowedKeyDigest),
    ...(Object.hasOwn(v, 'author') ? { author: validateRouteAuthor(v.author) } : {}) };
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
