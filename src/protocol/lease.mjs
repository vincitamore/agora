// @ts-check
import { ProtocolValidationError, readArray, readEnum, readInteger, readRecord, readString, readTimestamp, validateNativeId } from './common.mjs';
import { validateAccountBinding, validateRegistrationRef, validateServiceRef } from './identity.mjs';

/** @typedef {'present'|'absent'|'unknown'} WakeAvailability */
/** @typedef {{subscriber:WakeAvailability,pane:WakeAvailability}} WakeRoutes */
/** @typedef {ReturnType<typeof validatePublicBearer>} PublicBearer */
/** @typedef {ReturnType<typeof validatePresenceLease>} PresenceLease */
export const PRESENCE_LEASE_MS = 45000;

/** Observations only: neither route presence nor their aggregate admits a write.
 * @param {unknown} value @returns {WakeRoutes} */
export function validateWakeRoutes(value) {
  const v = readRecord(value, ['subscriber', 'pane']);
  return { subscriber: readEnum(v.subscriber, 'subscriber', ['present', 'absent', 'unknown']),
    pane: readEnum(v.pane, 'pane', ['present', 'absent', 'unknown']) };
}
/** @param {unknown} value @returns {WakeAvailability} */
export function deriveWakeSurface(value) {
  const v = validateWakeRoutes(value);
  if (v.subscriber === 'present' || v.pane === 'present') return 'present';
  return v.subscriber === 'absent' && v.pane === 'absent' ? 'absent' : 'unknown';
}
/** @param {unknown} value */
export function validatePublicBearer(value) {
  const v = readRecord(value, ['registration', 'bearer', 'harnessId', 'persistence', 'processPresent', 'wakeSurface', 'wakeRoutes']);
  const wakeRoutes = validateWakeRoutes(v.wakeRoutes);
  const wakeSurface = readEnum(v.wakeSurface, 'wakeSurface', ['present', 'absent', 'unknown']);
  if (wakeSurface !== deriveWakeSurface(wakeRoutes)) throw new ProtocolValidationError('context', 'wakeSurface');
  return { registration: validateRegistrationRef(v.registration),
    bearer: readString(v.bearer, 'bearer', { min: 1, max: 120, controls: true }),
    harnessId: readString(v.harnessId, 'harnessId', { min: 1, max: 64, controls: true }),
    persistence: readEnum(v.persistence, 'persistence', ['persistent', 'one-shot', 'unknown']),
    processPresent: readEnum(v.processPresent, 'processPresent', ['yes', 'no', 'unknown']), wakeSurface, wakeRoutes };
}
/** Strict public snapshot; no PID, path, last-message body, or serialized liveness.
 * Sender time is descriptive. The receiver owns freshness and replay rejection.
 * @param {unknown} value */
export function validatePresenceLease(value) {
  const v = readRecord(value, ['seat', 'service', 'leaseId', 'renewal', 'renewedAt', 'expects_agents', 'build', 'bearers']);
  const seat = validateAccountBinding(v.seat), service = validateServiceRef(v.service);
  if (JSON.stringify(seat.attestor) !== JSON.stringify(service)) throw new ProtocolValidationError('context', 'service');
  if (typeof v.expects_agents !== 'boolean') throw new ProtocolValidationError('type', 'expectsAgents');
  const b = readRecord(v.build, ['version'], ['git']);
  const bearers = readArray(v.bearers, 'bearers', 1024, validatePublicBearer);
  const seen = new Set();
  for (const bearer of bearers) {
    const key = JSON.stringify(bearer.registration);
    if (seen.has(key)) throw new ProtocolValidationError('context', 'registration');
    seen.add(key);
  }
  if (!v.expects_agents && bearers.length !== 0) throw new ProtocolValidationError('context', 'bearers');
  return { seat, service, leaseId: validateNativeId(v.leaseId), renewal: readInteger(v.renewal, 'renewal', 1),
    renewedAt: readTimestamp(v.renewedAt), expects_agents: v.expects_agents,
    build: { version: readString(b.version, 'version', { min: 1, max: 128, controls: true }),
      ...(Object.hasOwn(b, 'git') ? { git: readString(b.git, 'git', { min: 40, max: 40, pattern: /^[a-f0-9]{40}$/ }) } : {}) }, bearers };
}
/** Expected identity, lease ID and role come from local authenticated registration.
 * DTO equality is NOT verification of that registration.
 * @param {unknown} value @param {unknown} expected */
export function assertPresenceContext(value, expected) {
  const v = validatePresenceLease(value), e = readRecord(expected, ['seat', 'service', 'leaseId', 'role']);
  const role = readEnum(e.role, 'role', ['agent-capable', 'service-only']);
  if (JSON.stringify(v.seat) !== JSON.stringify(validateAccountBinding(e.seat)) ||
      JSON.stringify(v.service) !== JSON.stringify(validateServiceRef(e.service)) || v.leaseId !== validateNativeId(e.leaseId) ||
      v.expects_agents !== (role === 'agent-capable')) throw new ProtocolValidationError('context');
  return v;
}
/** Pure freshness observation. Timing is receiver-local monotonic milliseconds,
 * never sender renewedAt; acceptedRenewal belongs to this exact authenticated lease.
 * The owner must reject replay BEFORE updating acceptedAt. This function writes nothing,
 * and a fresh lease still does not admit a wake or prove a live conversation.
 * @param {unknown} value @param {unknown} expected @param {unknown} timing */
export function evaluatePresenceLease(value, expected, timing) {
  const v = assertPresenceContext(value, expected);
  const t = readRecord(timing, ['acceptedRenewal', 'acceptedAt', 'now', 'connected']);
  const acceptedRenewal = readInteger(t.acceptedRenewal, 'acceptedRenewal', 1);
  const acceptedAt = readInteger(t.acceptedAt, 'acceptedAt'), now = readInteger(t.now, 'now');
  if (typeof t.connected !== 'boolean') throw new ProtocolValidationError('type', 'connected');
  if (now < acceptedAt || acceptedRenewal !== v.renewal) throw new ProtocolValidationError('context');
  return t.connected && now - acceptedAt < PRESENCE_LEASE_MS ? 'fresh' : 'dark';
}
