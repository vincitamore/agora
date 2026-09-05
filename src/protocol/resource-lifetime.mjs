// @ts-check
import { ProtocolValidationError, readEnum, readRecord, readTimestamp } from './common.mjs';
import { validateServiceRef } from './identity.mjs';

/** @typedef {ReturnType<typeof validateResourceLifetime>} ResourceLifetime */

/** @param {unknown} value */
export function validateResourceLifetime(value) {
  const candidate = readRecord(value, ['kind'], ['expiresAt', 'owner']);
  const kind = readEnum(candidate.kind, 'kind', ['expiring', 'service']);
  if (kind === 'expiring') { const v = readRecord(value, ['kind', 'expiresAt']); return { kind, expiresAt: readTimestamp(v.expiresAt) }; }
  const v = readRecord(value, ['kind', 'owner']);
  return { kind, owner: validateServiceRef(v.owner) };
}
/** Equality only; P1 must separately establish owner liveness and cancellation.
 * @param {unknown} value @param {unknown} expectedOwner */
export function assertResourceOwnerContext(value, expectedOwner) {
  const lifetime = validateResourceLifetime(value), owner = validateServiceRef(expectedOwner);
  if (lifetime.kind !== 'service' || JSON.stringify(lifetime.owner) !== JSON.stringify(owner)) throw new ProtocolValidationError('context', 'owner');
  return lifetime;
}
