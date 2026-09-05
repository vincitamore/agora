// @ts-check
import { ProtocolValidationError, PROTOCOL_LIMITS, readArray, readEnum, readRecord } from './common.mjs';
import { validateAcceptedHostContext, validateNativeAccountRef } from './identity.mjs';

/** @typedef {ReturnType<typeof validateAdvertisedCapabilities>} AdvertisedCapabilities */
/** @typedef {ReturnType<typeof validateRequiredCapabilities>} RequiredCapabilities */
/** @typedef {ReturnType<typeof validateCapabilityOffer>} CapabilityOffer */
/** @typedef {ReturnType<typeof validateNegotiatedCapabilities>} NegotiatedCapabilities */

export const NATIVE_CAPABILITIES = Object.freeze(['contracts-v2', 'board-v1']);
/** @param {unknown} value */
function capabilities(value) {
  const result = readArray(value, 'capabilities', PROTOCOL_LIMITS.capabilities, (v) => readEnum(v, 'capabilities', NATIVE_CAPABILITIES));
  if (new Set(result).size !== result.length) throw new ProtocolValidationError('field', 'capabilities');
  return result;
}
/** @param {unknown} value */
export function validateAdvertisedCapabilities(value) {
  const v = readRecord(value, ['advertised']); return { advertised: capabilities(v.advertised) };
}
/** @param {unknown} value */
export function validateRequiredCapabilities(value) {
  const v = readRecord(value, ['required']); return { required: capabilities(v.required) };
}
/** @param {unknown} value */
export function validateCapabilityOffer(value) {
  const v = readRecord(value, ['advertised', 'required']);
  const advertised = capabilities(v.advertised), required = capabilities(v.required);
  if (required.some((c) => !advertised.includes(c))) throw new ProtocolValidationError('context', 'required');
  return { advertised, required };
}
/** @param {unknown} value */
export function validateNegotiatedCapabilities(value) {
  const v = readRecord(value, ['host', 'negotiated']), negotiated = capabilities(v.negotiated);
  if (negotiated.includes('board-v1') && !negotiated.includes('contracts-v2')) throw new ProtocolValidationError('context', 'negotiated');
  return { host: validateNativeAccountRef(v.host), negotiated };
}
/** Pure intersection/refusal. Caller runs AFTER real server proof and BEFORE room open,
 * scan, replay, or effect. The supplied context is not itself an authentication proof.
 * Result belongs to that authenticated connection; never restore persisted negotiation as live.
 * @param {unknown} local @param {unknown} peer @param {unknown} hostContext */
export function negotiateNativeCapabilities(local, peer, hostContext) {
  const l = validateCapabilityOffer(local), p = validateCapabilityOffer(peer), context = validateAcceptedHostContext(hostContext);
  const negotiated = NATIVE_CAPABILITIES.filter((c) => l.advertised.includes(c) && p.advertised.includes(c));
  if ([...l.required, ...p.required].some((c) => !negotiated.includes(c))) throw new ProtocolValidationError('context', 'required');
  return validateNegotiatedCapabilities({ host: context.host, negotiated });
}
/** Verifies exact agreed intersection and host, without trusting peer-selected inventory.
 * @param {unknown} value @param {unknown} local @param {unknown} peer @param {unknown} expectedHostContext */
export function assertNegotiatedCapabilitiesContext(value, local, peer, expectedHostContext) {
  const v = validateNegotiatedCapabilities(value), e = negotiateNativeCapabilities(local, peer, expectedHostContext);
  if (JSON.stringify(v.host) !== JSON.stringify(e.host) || v.negotiated.length !== e.negotiated.length || e.negotiated.some((c) => !v.negotiated.includes(c))) throw new ProtocolValidationError('context');
  return v;
}
