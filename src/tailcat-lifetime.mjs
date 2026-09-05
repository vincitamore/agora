// @ts-check
import { AgoraError } from './core.mjs';
import { validateResourceLifetime, assertResourceOwnerContext } from './protocol/resource-lifetime.mjs';

/** @typedef {import('./protocol/resource-lifetime.mjs').ResourceLifetime} ResourceLifetime */
/** A local caller-owned cancellation handle; IDs alone are not live authority.
 * P1 supplies this from its live resource registry, never from a wire DTO.
 * @typedef {{serviceId:string,serviceBootId:string,signal:AbortSignal}} RuntimeOwner */
/** @typedef {{deadline?:number,lifetime?:ResourceLifetime}} LifetimeOptions */

/** Validate and copy before any process or runtime-cache effect.
 * @param {LifetimeOptions} options @param {RuntimeOwner} [owner] */
export function prepareRuntimeLifetime(options, owner) {
  if (options.lifetime !== undefined && options.deadline !== undefined) {
    throw new AgoraError('Tailcat lifetime and deadline cannot both be supplied. Choose one lifetime.');
  }
  const lifetime = options.lifetime === undefined ? undefined : validateResourceLifetime(options.lifetime);
  if (lifetime?.kind === 'service') {
    if (!owner || !(owner.signal instanceof AbortSignal)) {
      throw new AgoraError('Service-owned Tailcat requires a live local owner. Register it with the seat service.');
    }
    assertResourceOwnerContext(lifetime, { serviceId: owner.serviceId, serviceBootId: owner.serviceBootId });
    if (owner.signal.aborted) throw runtimeCancelled();
  } else if (owner !== undefined) {
    throw new AgoraError('A Tailcat service owner requires an explicit service lifetime.');
  }
  return lifetime;
}

/** Pure duration selection, also revalidated inside the private guardian IPC path.
 * Null means no expiry timer, not unowned or uncancellable.
 * @param {LifetimeOptions} options @param {number} [now] */
export function runtimeExpiryDelay(options, now = Date.now()) {
  if (options.lifetime !== undefined && options.deadline !== undefined) throw new AgoraError('Conflicting Tailcat lifetime.');
  const lifetime = options.lifetime === undefined ? undefined : validateResourceLifetime(options.lifetime);
  if (lifetime?.kind === 'service') return null;
  const deadline = lifetime?.kind === 'expiring' ? Date.parse(lifetime.expiresAt) : Number(options.deadline);
  return Number.isFinite(deadline) ? Math.min(86400000, Math.max(1, deadline - now)) : 86400000;
}

export function runtimeCancelled() {
  return Object.assign(new AgoraError('Tailcat service owner stopped. Retry through the live seat service.'), { code: 'AGORA_RUNTIME_CANCELLED' });
}
