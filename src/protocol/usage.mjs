// @ts-check
// N1: pool, window and complete-observation syntax, plus one acceptance boundary.
// No enrollment, no persistence, no admission, no scheduling, no store mutation, and no
// network. A value that passes any validator here is well-formed and is not thereby
// authorised, fresh, or true. Authority is established by the consumer's assert call
// against a separately supplied authenticated context; see acceptCompleteObservation.
import { ProtocolValidationError, readArray, readEnum, readInteger, readRecord, readString, readTimestamp, validateDigest, validateNativeId } from './common.mjs';
import { validateRegistrationRef, validateServiceRef } from './identity.mjs';

/** @typedef {ReturnType<typeof validatePoolPrincipal>} PoolPrincipal */
/** @typedef {ReturnType<typeof validateSeatBinding>} SeatBinding */
/** @typedef {ReturnType<typeof validateWindowIdentity>} WindowIdentity */
/** @typedef {ReturnType<typeof validateWindowReading>} WindowReading */
/** @typedef {ReturnType<typeof validateCompleteObservation>} CompleteObservation */

/**
 * Units are bounded integers in the smallest representable step. There is no float in
 * this contract: a quota rounded silently is a wrong number that reads as a right one.
 * `basis-points` is hundredths of a percent, so 21.0 percent is exactly 2100.
 */
export const USAGE_UNITS = Object.freeze(/** @type {const} */ (['basis-points', 'micro-usd', 'tokens', 'requests']));
/** The largest value each unit admits, so a transposed field cannot pass as a quantity. */
const UNIT_MAX = Object.freeze({ 'basis-points': 10000, 'micro-usd': 1_000_000_000_000, tokens: Number.MAX_SAFE_INTEGER, requests: Number.MAX_SAFE_INTEGER });

/** Who measured. Separate from whether the receiver can bind it: see `attestation`. */
export const SOURCE_KINDS = Object.freeze(/** @type {const} */ (['provider', 'harness', 'human', 'estimate']));
/** `enforced` is a conclusion, never a syntax fact. On the OBSERVATION path only,
 * `acceptCompleteObservation` may conclude it; elsewhere the value is a parsed claim whose
 * authority a future consuming service must establish against independent expected context. */
export const ATTESTATIONS = Object.freeze(/** @type {const} */ (['cooperative', 'enforced']));

/**
 * A provider-scoped billing principal. NOT a native account: a seat identity is a
 * participant in a room, never a billing identity, and conflating them is how a reported
 * account launders into an authenticated one.
 * `identity: 'unverified'` is the honest default and stays until a provider-authenticated
 * read establishes otherwise; nothing in this module can promote it.
 * @param {unknown} value
 */
export function validatePoolPrincipal(value) {
  const v = readRecord(value, ['poolId', 'provider', 'principalRef', 'identity'], ['plan']);
  return {
    poolId: validateNativeId(v.poolId),
    provider: readString(v.provider, 'provider', { min: 1, max: 64, pattern: /^[a-z][a-z0-9-]{0,63}$/ }),
    // The provider's own stable, non-secret account identifier. Never a credential, never
    // a file path, never derived from a seat.
    principalRef: readString(v.principalRef, 'principalRef', { min: 1, max: 512, controls: true }),
    identity: readEnum(v.identity, 'identity', ['unverified', 'provider-verified']),
    ...(Object.hasOwn(v, 'plan') ? { plan: readString(v.plan, 'plan', { min: 1, max: 120, controls: true }) } : {}),
  };
}

/**
 * One seat's binding to one principal. Many bindings map to one pool, which is the whole
 * point: two seats on one subscription read one number, and summing them invents capacity.
 * The binding carries its own evidence and its own attestation, because two seats on one
 * pool can be bound on different grounds.
 * @param {unknown} value
 */
export function validateSeatBinding(value) {
  const v = readRecord(value, ['poolId', 'registration', 'attestation'], ['evidenceRef']);
  // `attestation` here is a CLAIM, exactly as it is on an unaccepted observation: this is a
  // syntax reader, and an enum surviving syntax is not an authority bypass. Parsing a
  // claimed `enforced` binding is therefore allowed and means nothing on its own.
  //
  // What makes it safe is that NO CONSUMER OF THIS FIELD EXISTS IN THIS MODULE. Nothing
  // here grants authority from it. A future consuming service must authenticate the mapping
  // against independent expected context before treating a binding as enforced, and a
  // consumer that relies on this field directly is a real missing-boundary defect with a
  // cut-wire test owed at that seam. Refusing the claim here while the observation record
  // admits the same one would make two records that mean the same thing behave differently.
  const attestation = readEnum(v.attestation, 'attestation', ATTESTATIONS);
  return {
    poolId: validateNativeId(v.poolId),
    registration: validateRegistrationRef(v.registration),
    attestation,
    ...(Object.hasOwn(v, 'evidenceRef') ? { evidenceRef: readString(v.evidenceRef, 'evidenceRef', { min: 1, max: 512, controls: true }) } : {}),
  };
}

/**
 * A window is identified by the provider's own limit id AND its unit. Two windows on one
 * pool in different units are no more comparable than two pools, so the unit is part of
 * the identity rather than an attribute of the value.
 * @param {unknown} value
 */
export function validateWindowIdentity(value) {
  const v = readRecord(value, ['limitId', 'unit'], ['durationMinutes', 'scope']);
  return {
    limitId: readString(v.limitId, 'limitId', { min: 1, max: 128, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/ }),
    unit: readEnum(v.unit, 'unit', USAGE_UNITS),
    ...(Object.hasOwn(v, 'durationMinutes') ? { durationMinutes: readInteger(v.durationMinutes, 'durationMinutes', 1) } : {}),
    // A provider may report several windows under ONE limit id, distinguished only by their
    // period or by its own primary/secondary naming. `scope` carries that discriminator
    // without rewriting the provider's limit id, which stays exactly as reported.
    ...(Object.hasOwn(v, 'scope') ? { scope: readString(v.scope, 'scope', { min: 1, max: 64, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/ }) } : {}),
  };
}

/** Key for comparing like with like. Never compare or order readings across two keys. */
export function windowKey(/** @type {unknown} */ value) {
  const w = validateWindowIdentity(value);
  // The period and the scope are part of the identity, not decoration on it. Dropping them
  // made two genuinely different windows collide under one limit id, so a snapshot carrying
  // both was refused as a duplicate: the module could not represent a shape a real provider
  // returns.
  return JSON.stringify([w.limitId, w.unit, w.durationMinutes ?? null, w.scope ?? null]);
}

/**
 * One window's reading inside a snapshot. `available: false` means the provider did not
 * report a value; it carries a reason code and NO value, because an absent quota is not a
 * quota of zero and coercing it is the failure this field exists to prevent.
 * @param {unknown} value
 */
export function validateWindowReading(value) {
  const candidate = readRecord(value, ['window', 'available'], ['value', 'sense', 'resetsAt', 'code']);
  if (typeof candidate.available !== 'boolean') throw new ProtocolValidationError('type', 'available');
  const window = validateWindowIdentity(candidate.window);
  if (!candidate.available) {
    const v = readRecord(value, ['window', 'available', 'code']);
    return { window, available: /** @type {const} */ (false), code: readString(v.code, 'code', { min: 1, max: 64, pattern: /^[a-z][a-z0-9-]{0,63}$/ }) };
  }
  const v = readRecord(value, ['window', 'available', 'value', 'sense'], ['resetsAt']);
  const value_ = readInteger(v.value, 'value', 0, UNIT_MAX[window.unit]);
  return {
    window,
    available: /** @type {const} */ (true),
    value: value_,
    // "used" and "remaining" are one number with opposite meanings; inferring it is the
    // single most expensive mistake available here, so it is required and never defaulted.
    sense: readEnum(v.sense, 'sense', ['used', 'remaining']),
    ...(Object.hasOwn(v, 'resetsAt') ? { resetsAt: readTimestamp(v.resetsAt) } : {}),
  };
}

/**
 * Convert a provider's decimal percentage to basis points, or REFUSE. A source reporting
 * finer precision than the unit represents is a refusal and never a rounding: silently
 * rounding a quota produces a wrong number that looks right, and nothing downstream can
 * detect it. Callers that genuinely want coarser data must say so by asking for a unit
 * that admits it.
 * @param {unknown} percent
 */
export function percentToBasisPoints(percent) {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) throw new ProtocolValidationError('type', 'percent');
  if (percent < 0 || percent > 100) throw new ProtocolValidationError('range', 'percent');
  // A percentage is representable in basis points only when it has at most two decimal
  // places, so the test is the two-decimal rendering round-tripping exactly. An epsilon
  // tolerance was the first attempt and it rounded precisely what this function promises to
  // refuse: 21.000000001 became 2100 and 1e-9 became 0.
  if (Number(percent.toFixed(2)) !== percent) throw new ProtocolValidationError('range', 'percent');
  return Math.round(percent * 100);
}

/**
 * A COMPLETE observation: one full snapshot of one pool at one capture time, retaining
 * every window the source represented. `kind` is `full` and only `full`, so a frame that
 * labels itself sparse is refused outright.
 *
 * What is checked here is DECLARED-FULL SHAPE, not completeness. A well-formed non-empty
 * subset of a source's windows, labelled `full`, parses — and must, because nothing in this
 * module knows what the source represented, and a validator cannot verify a claim about
 * data it never saw. Completeness is the ADAPTER's obligation: emit `full` only for a
 * snapshot read whole, and treat a sparse frame as a bounded refetch signal rather than
 * something to forward.
 *
 * `sequence` is assigned by the PRODUCING adapter, not by the receiver: a receiver
 * numbering on arrival gives a late reading the higher number and the stale one wins.
 * `producerGeneration` is carried so a later authenticated admission consumer can order
 * and supersede; this module neither admits a generation nor persists one, and an unseen
 * generation id is not evidence of being newer or authorised.
 * @param {unknown} value
 */
export function validateCompleteObservation(value) {
  const v = readRecord(value, ['kind', 'poolId', 'capturedAt', 'source', 'attestation', 'producer', 'windows'], ['evidenceRef', 'attestor']);
  const kind = readEnum(v.kind, 'kind', ['full']);
  const producer = readRecord(v.producer, ['producerId', 'generation', 'sequence']);
  const attestation = readEnum(v.attestation, 'attestation', ATTESTATIONS);
  const windows = readArray(v.windows, 'windows', 64, validateWindowReading);
  if (windows.length === 0) throw new ProtocolValidationError('range', 'windows');
  const seen = new Set();
  for (const reading of windows) {
    const key = windowKey(reading.window);
    if (seen.has(key)) throw new ProtocolValidationError('context', 'windows');
    seen.add(key);
  }
  return {
    kind,
    poolId: validateNativeId(v.poolId),
    capturedAt: readTimestamp(v.capturedAt),
    // Who measured. A caller may assert `human` or `estimate` about itself and nothing else:
    // `provider` and `harness` additionally require an attestor, and even then this is a
    // claim about provenance rather than a grant of authority.
    source: readEnum(v.source, 'source', SOURCE_KINDS),
    attestation,
    producer: {
      producerId: validateNativeId(producer.producerId),
      generation: readInteger(producer.generation, 'generation', 1),
      sequence: readInteger(producer.sequence, 'sequence', 1),
    },
    windows,
    ...(Object.hasOwn(v, 'attestor') ? { attestor: validateServiceRef(v.attestor) } : {}),
    ...(Object.hasOwn(v, 'evidenceRef') ? { evidenceRef: validateDigest(v.evidenceRef) } : {}),
  };
}

/**
 * THE ACCEPTANCE BOUNDARY. Syntax is not authority and this is where that is enforced.
 *
 * The caller supplies `expected` from its OWN authenticated state — never from the
 * observation, never from a room message, never from a body trailer — and `now` from its
 * own clock. Both are separate arguments precisely so that cutting either is a visible
 * deletion at the call site rather than a silently absent field.
 *
 * What the future seat-service consumer must supply, stated so nobody assumes it is wired:
 * `expected.attestor` is the ServiceRef of the service that RAN or authenticated the
 * adapter, resolved from that service's own registration, and `expected.poolId` is the
 * pool the caller believes it asked about. This module does not obtain either, does not
 * verify a signature, and does not know whether the supplied attestor is genuine; it
 * checks that the observation binds to what an authenticated caller asserted.
 *
 * Returns the observation with `attestation: 'enforced'` ONLY when a provider/harness
 * source binds to the expected attestor. Every other arrival stays `cooperative` — a
 * relayed reading does not become authority by travelling.
 * @param {unknown} value @param {unknown} expected @param {unknown} now
 */
export function acceptCompleteObservation(value, expected, now) {
  const observation = validateCompleteObservation(value);
  const e = readRecord(expected, ['poolId', 'attestor']);
  const expectedAttestor = validateServiceRef(e.attestor);
  if (observation.poolId !== validateNativeId(e.poolId)) throw new ProtocolValidationError('context', 'poolId');
  const at = new Date(readTimestamp(now)).getTime();
  if (new Date(observation.capturedAt).getTime() > at) throw new ProtocolValidationError('context', 'capturedAt');
  const bound = (observation.source === 'provider' || observation.source === 'harness')
    && observation.attestor !== undefined
    && JSON.stringify(observation.attestor) === JSON.stringify(expectedAttestor);
  if (observation.attestation === 'enforced' && !bound) throw new ProtocolValidationError('context', 'attestation');
  return { ...observation, attestation: /** @type {'cooperative'|'enforced'} */ (bound ? 'enforced' : 'cooperative') };
}

/**
 * Freshness derived from an explicit consumer clock. This function is pure and returns a
 * verdict; it never mutates, replaces or refills the stored reading, and `reset-due` is
 * NOT a claim that the window refilled — it is the statement that `resetsAt` has passed
 * and nothing fresh has replaced this value. Entering that state needs no network;
 * leaving it needs a new full snapshot.
 * @param {unknown} reading @param {unknown} now
 * @returns {'fresh'|'reset-due'|'unknown'}
 */
export function windowFreshness(reading, now) {
  const r = validateWindowReading(reading);
  const at = new Date(readTimestamp(now)).getTime();
  if (!r.available) return 'unknown';
  // No reset metadata is NOT evidence of freshness: a reading with no `resetsAt` was
  // reported fresh a year later. Absence is unknown until a source states a non-expiring
  // window explicitly.
  if (r.resetsAt === undefined) return 'unknown';
  return new Date(r.resetsAt).getTime() <= at ? 'reset-due' : 'fresh';
}

/**
 * Supersession, per (pool, window identity) and per producer generation. A candidate
 * supersedes only with a STRICTLY GREATER sequence inside the same generation; equal or
 * lower is refused, and a different generation is `unordered` rather than newer, because
 * an unseen generation id proves nothing about recency or authority and admitting one is
 * a separate authenticated act this module does not perform.
 * @param {unknown} candidate @param {unknown} accepted
 * @returns {'supersedes'|'stale'|'unordered'}
 */
export function supersedes(candidate, accepted) {
  const c = validateCompleteObservation(candidate), a = validateCompleteObservation(accepted);
  if (c.poolId !== a.poolId) throw new ProtocolValidationError('context', 'poolId');
  if (c.producer.producerId !== a.producer.producerId || c.producer.generation !== a.producer.generation) return 'unordered';
  return c.producer.sequence > a.producer.sequence ? 'supersedes' : 'stale';
}
