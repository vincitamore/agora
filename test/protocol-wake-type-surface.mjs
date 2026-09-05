// @ts-check
// Compile-only P1/P4 import seam. No registration, authentication or IO performed.
import { validatePresenceLease, deriveWakeSurface, evaluatePresenceLease } from '../src/protocol/lease.mjs';
import { validateNativeDeliveredCoverage, coversDeliveredRange } from '../src/protocol/delivered-coverage.mjs';
/** @param {unknown} lease @param {unknown} proof @param {unknown} leaseOwner
 * @param {unknown} timing @param {unknown} progressOwner @param {unknown} range */
export function consumeWakeContracts(lease, proof, leaseOwner, timing, progressOwner, range) {
  const presence = validatePresenceLease(lease);
  /** @type {'fresh'|'dark'} */ const freshness = evaluatePresenceLease(presence, leaseOwner, timing);
  /** @type {import('../src/protocol/read.mjs').NativeReadCoverage} */
  const scanShape = validateNativeDeliveredCoverage(proof).coverage;
  /** @type {'native'} */ const scheme = scanShape.room.host.scheme;
  const routes = presence.bearers.map((b) => deriveWakeSurface(b.wakeRoutes));
  /** @type {boolean} */ const covered = coversDeliveredRange(proof, progressOwner, range);
  // @ts-expect-error scan coverage has no recipient; a scan is not delivery.
  const recipient = scanShape.recipient;
  return { freshness, scheme, routes, covered, recipient };
}
