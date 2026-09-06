// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProtocolValidationError } from '../src/protocol/common.mjs';
import * as usageModule from '../src/protocol/usage.mjs';
import {
  acceptCompleteObservation, percentToBasisPoints, supersedes, validateCompleteObservation,
  validatePoolPrincipal, validateSeatBinding, validateWindowIdentity, validateWindowReading, windowFreshness, windowKey,
} from '../src/protocol/usage.mjs';

// Synthetic throughout: no live identifier, no credential, no account. Passing these
// fixtures establishes shape and boundary behaviour, never live authorization.
const POOL = 'pool_synthetic_0000001';
const SERVICE = { serviceId: 'service_synthetic_00001', serviceBootId: 'boot_synthetic_000000001' };
const OTHER_SERVICE = { serviceId: 'service_synthetic_00002', serviceBootId: 'boot_synthetic_000000002' };
const PRODUCER = { producerId: 'producer_synthetic_0001', generation: 1, sequence: 7 };

const seat = (/** @type {string} */ id) => ({ accountId: id, registrationId: 'registration_synth_0001', generation: 1 });
const windowOf = (/** @type {string} */ limitId, /** @type {string} */ unit) => ({ limitId, unit });

/** A five-hour percentage and a weekly percentage and a money balance: three unlike windows. */
const fiveHour = { window: windowOf('five_hour', 'basis-points'), available: true, value: 2100, sense: 'used', resetsAt: '2026-09-07T00:40:00.000Z' };
const weekly = { window: windowOf('seven_day', 'basis-points'), available: true, value: 500, sense: 'used', resetsAt: '2026-09-13T17:00:00.000Z' };
const credits = { window: windowOf('credit_balance', 'micro-usd'), available: false, code: 'unavailable' };

const fullObservation = {
  kind: 'full', poolId: POOL, capturedAt: '2026-09-06T20:35:01.000Z',
  source: 'harness', attestation: 'cooperative', attestor: SERVICE,
  producer: PRODUCER, windows: [fiveHour, weekly, credits],
};

test('two seats bind to one principal and the pool is one identity, never two', () => {
  const principal = validatePoolPrincipal({ poolId: POOL, provider: 'example-provider', principalRef: 'org-uuid-synthetic', identity: 'unverified' });
  const a = validateSeatBinding({ poolId: POOL, registration: seat('account_synthetic_00001'), attestation: 'cooperative' });
  const b = validateSeatBinding({ poolId: POOL, registration: seat('account_synthetic_00002'), attestation: 'cooperative', evidenceRef: 'measured on this seat' });
  assert.equal(a.poolId, principal.poolId);
  assert.equal(b.poolId, principal.poolId);
  assert.notEqual(a.registration.accountId, b.registration.accountId);
  // Per-binding evidence: two seats on one pool may be bound on different grounds, and the
  // pool record carries none of it.
  assert.equal(Object.hasOwn(a, 'evidenceRef'), false);
  assert.equal(b.evidenceRef, 'measured on this seat');
  assert.equal(Object.hasOwn(principal, 'attestation'), false);
  // An unverified principal cannot be promoted by anything in this module.
  assert.equal(principal.identity, 'unverified');
});

test('a seat identity is not a billing identity: the principal ref is the provider\'s, not the account\'s', () => {
  const principal = validatePoolPrincipal({ poolId: POOL, provider: 'example-provider', principalRef: 'org-uuid-synthetic', identity: 'provider-verified' });
  assert.equal(principal.principalRef, 'org-uuid-synthetic');
  assert.equal(Object.hasOwn(principal, 'registration'), false);
  assert.equal(Object.hasOwn(principal, 'accountId'), false);
});

test('unlike windows keep distinct identities and are never merged', () => {
  const observation = validateCompleteObservation(fullObservation);
  assert.equal(observation.windows.length, 3);
  const keys = observation.windows.map((w) => windowKey(w.window));
  assert.equal(new Set(keys).size, 3);
  // Same limit id in a different unit is a DIFFERENT window, because the unit is identity.
  assert.notEqual(windowKey(windowOf('five_hour', 'basis-points')), windowKey(windowOf('five_hour', 'tokens')));
});

test('a duplicate window identity in one snapshot is refused', () => {
  assert.throws(() => validateCompleteObservation({ ...fullObservation, windows: [fiveHour, fiveHour] }), ProtocolValidationError);
});

test('an unavailable window carries a code and NO value: absent is not zero', () => {
  const reading = validateWindowReading(credits);
  assert.equal(reading.available, false);
  assert.equal(Object.hasOwn(reading, 'value'), false);
  // Supplying a value alongside available:false is refused rather than quietly ignored.
  assert.throws(() => validateWindowReading({ ...credits, value: 0 }), ProtocolValidationError);
});

test('sense is required and never inferred', () => {
  const { sense, ...withoutSense } = fiveHour;
  assert.throws(() => validateWindowReading(withoutSense), ProtocolValidationError);
});

test('an out-of-range or non-integer value is refused, per unit', () => {
  assert.throws(() => validateWindowReading({ ...fiveHour, value: 10001 }), ProtocolValidationError);
  assert.throws(() => validateWindowReading({ ...fiveHour, value: 21.5 }), ProtocolValidationError);
});

test('precision finer than the unit is REFUSED, never rounded', () => {
  assert.equal(percentToBasisPoints(21), 2100);
  assert.equal(percentToBasisPoints(0.05), 5);
  // 0.005 percent is half a basis point: rounding it would produce a wrong number that
  // reads as a right one, so the conversion refuses instead.
  assert.throws(() => percentToBasisPoints(0.005), ProtocolValidationError);
  assert.throws(() => percentToBasisPoints(101), ProtocolValidationError);
});

test('a sparse frame cannot masquerade as a complete observation', () => {
  assert.throws(() => validateCompleteObservation({ ...fullObservation, kind: 'sparse' }), ProtocolValidationError);
  // Nor by omitting the discriminator entirely.
  const { kind, ...withoutKind } = fullObservation;
  assert.throws(() => validateCompleteObservation(withoutKind), ProtocolValidationError);
  // Nor by carrying no windows at all, which is a partial frame wearing a full label.
  assert.throws(() => validateCompleteObservation({ ...fullObservation, windows: [] }), ProtocolValidationError);
});

test('source and attestation are separate fields and a parsed DTO is not authority', () => {
  // A record may CLAIM enforced; validation is syntax and says nothing about authority.
  const claimed = validateCompleteObservation({ ...fullObservation, attestation: 'enforced' });
  assert.equal(claimed.attestation, 'enforced');
  assert.equal(claimed.source, 'harness');
  // The acceptance boundary is where that claim is tested; see the next tests.
});

test('ACCEPTANCE: a bound provider/harness reading becomes enforced through the public path', () => {
  const accepted = acceptCompleteObservation(fullObservation, { poolId: POOL, attestor: SERVICE }, '2026-09-06T20:35:02.000Z');
  assert.equal(accepted.attestation, 'enforced');
  assert.equal(accepted.windows.length, 3);
});

test('ACCEPTANCE: a wrong authenticated expected context is refused, not downgraded', () => {
  // Wrong attestor, with the observation itself claiming enforced: this is the named
  // authority control. It must throw, not quietly return cooperative.
  assert.throws(
    () => acceptCompleteObservation({ ...fullObservation, attestation: 'enforced' }, { poolId: POOL, attestor: OTHER_SERVICE }, '2026-09-06T20:35:02.000Z'),
    ProtocolValidationError,
  );
  // Wrong pool is refused before anything else is concluded.
  assert.throws(
    () => acceptCompleteObservation(fullObservation, { poolId: 'pool_synthetic_0000002', attestor: SERVICE }, '2026-09-06T20:35:02.000Z'),
    ProtocolValidationError,
  );
});

test('ACCEPTANCE: a human or estimate source can never reach enforced', () => {
  for (const source of ['human', 'estimate']) {
    const accepted = acceptCompleteObservation({ ...fullObservation, source }, { poolId: POOL, attestor: SERVICE }, '2026-09-06T20:35:02.000Z');
    assert.equal(accepted.attestation, 'cooperative');
  }
});

test('ACCEPTANCE: an attestor field alone does not bind; the expected context decides', () => {
  // The observation names an attestor it was not authenticated against. Naming is a shape.
  const accepted = acceptCompleteObservation({ ...fullObservation, attestor: OTHER_SERVICE }, { poolId: POOL, attestor: SERVICE }, '2026-09-06T20:35:02.000Z');
  assert.equal(accepted.attestation, 'cooperative');
});

test('ACCEPTANCE: a reading captured after the receiver clock is refused', () => {
  assert.throws(
    () => acceptCompleteObservation(fullObservation, { poolId: POOL, attestor: SERVICE }, '2026-09-06T20:00:00.000Z'),
    ProtocolValidationError,
  );
});

test('FRESHNESS: crossing reset yields reset-due and leaves the stored reading unchanged', () => {
  const before = JSON.stringify(fiveHour);
  assert.equal(windowFreshness(fiveHour, '2026-09-06T23:00:00.000Z'), 'fresh');
  assert.equal(windowFreshness(fiveHour, '2026-09-07T01:00:00.000Z'), 'reset-due');
  // The whole point: the verdict is derived, the reading is untouched, and reset-due is
  // not a claim that the window refilled.
  assert.equal(JSON.stringify(fiveHour), before);
  const stillUsed = validateWindowReading(fiveHour);
  assert.ok(stillUsed.available);
  assert.equal(stillUsed.value, 2100);
  assert.equal(stillUsed.sense, 'used');
});

test('FRESHNESS: an unavailable window is unknown, never fresh and never reset-due', () => {
  assert.equal(windowFreshness(credits, '2026-09-07T01:00:00.000Z'), 'unknown');
});

test('SUPERSESSION: strictly greater sequence inside one generation, and nothing else', () => {
  const accepted = fullObservation;
  const newer = { ...fullObservation, producer: { ...PRODUCER, sequence: 8 } };
  const equal = { ...fullObservation, producer: { ...PRODUCER, sequence: 7 } };
  const older = { ...fullObservation, producer: { ...PRODUCER, sequence: 6 } };
  assert.equal(supersedes(newer, accepted), 'supersedes');
  assert.equal(supersedes(equal, accepted), 'stale');
  assert.equal(supersedes(older, accepted), 'stale');
});

test('SUPERSESSION: an unseen generation is unordered, never newer', () => {
  // A late arrival from a generation this receiver has not admitted must not win by
  // carrying a larger number; admitting a generation is a separate authenticated act.
  const otherGeneration = { ...fullObservation, producer: { ...PRODUCER, generation: 2, sequence: 1 } };
  assert.equal(supersedes(otherGeneration, fullObservation), 'unordered');
  const otherProducer = { ...fullObservation, producer: { ...PRODUCER, producerId: 'producer_synthetic_0002', sequence: 99 } };
  assert.equal(supersedes(otherProducer, fullObservation), 'unordered');
});

test('SUPERSESSION: two different pools are never ordered against each other', () => {
  assert.throws(() => supersedes({ ...fullObservation, poolId: 'pool_synthetic_0000002' }, fullObservation), ProtocolValidationError);
});

// --- Regressions from the independent reads of 9bf57acb ----------------------------
// Four defects, three reproduced by two readers independently and one found by a third.
// Their falsifiers are the regression: each of these failed at that head.

test('REGRESSION R1: a near-integer or near-zero percentage is refused, not rounded', () => {
  // At 9bf57acb an epsilon tolerance returned 2100 and 0 for these, silently rounding
  // exactly what this function's contract promises to refuse.
  assert.throws(() => percentToBasisPoints(21.000000001), ProtocolValidationError);
  assert.throws(() => percentToBasisPoints(1e-9), ProtocolValidationError);
  assert.throws(() => percentToBasisPoints(0.005), ProtocolValidationError);
  // The representable cases must survive the repair.
  assert.equal(percentToBasisPoints(21), 2100);
  assert.equal(percentToBasisPoints(0.05), 5);
  assert.equal(percentToBasisPoints(0.29), 29);
  assert.equal(percentToBasisPoints(100), 10000);
  assert.equal(percentToBasisPoints(0), 0);
});

test('REGRESSION R2: two periods under one limit id are two windows, and a snapshot may carry both', () => {
  // The shape a real provider returns: one limit id, a short window and a weekly one.
  const short = { limitId: 'provider_limit_a', unit: 'basis-points', durationMinutes: 300 };
  const week = { limitId: 'provider_limit_a', unit: 'basis-points', durationMinutes: 10080 };
  assert.notEqual(windowKey(short), windowKey(week));
  // At 9bf57acb these collided, so an observation carrying both was refused as a duplicate:
  // the module could not represent data the provider actually returns.
  const observation = validateCompleteObservation({
    ...fullObservation,
    windows: [
      { window: short, available: true, value: 100, sense: 'used' },
      { window: week, available: true, value: 3100, sense: 'used' },
    ],
  });
  assert.equal(observation.windows.length, 2);
  // A scope discriminator separates two windows a provider distinguishes by name, and the
  // provider's own limit id is preserved untouched in both.
  const primary = { limitId: 'provider_limit_b', unit: 'basis-points', scope: 'primary' };
  const secondary = { limitId: 'provider_limit_b', unit: 'basis-points', scope: 'secondary' };
  assert.notEqual(windowKey(primary), windowKey(secondary));
  assert.equal(validateWindowIdentity(primary).limitId, 'provider_limit_b');
  // Genuinely identical identities still collide, which is the property that must survive.
  assert.equal(windowKey(short), windowKey({ ...short }));
});

test('REGRESSION R3: a reading with no reset metadata is unknown, never fresh', () => {
  const noReset = { window: windowOf('no_reset', 'tokens'), available: true, value: 5, sense: 'used' };
  // At 9bf57acb this returned fresh a year later: absence of reset metadata was read as
  // evidence of freshness.
  assert.equal(windowFreshness(noReset, '2027-09-06T00:00:00.000Z'), 'unknown');
  assert.equal(windowFreshness(noReset, '2026-09-06T20:35:02.000Z'), 'unknown');
  // A reading that does carry a reset time still discriminates.
  assert.equal(windowFreshness(fiveHour, '2026-09-06T23:00:00.000Z'), 'fresh');
  assert.equal(windowFreshness(fiveHour, '2026-09-07T01:00:00.000Z'), 'reset-due');
});

test('R4: a seat binding parses a CLAIMED attestation and grants nothing by it', () => {
  // Adjudicated at house :401. This is a syntax reader, so a claimed `enforced` parses here
  // exactly as it does on an unaccepted observation; an enum surviving syntax is not an
  // authority bypass. What makes that safe is that no consumer of this field exists in this
  // module, so nothing derives authority from the claim.
  const claimed = validateSeatBinding({ poolId: POOL, registration: seat('account_synthetic_00003'), attestation: 'enforced' });
  assert.equal(claimed.attestation, 'enforced', 'the claim parses');
  // The same value on an observation is likewise only a claim until the boundary tests it,
  // which is the consistency the adjudication turned on.
  const claimedObservation = validateCompleteObservation({ ...fullObservation, attestation: 'enforced' });
  assert.equal(claimedObservation.attestation, 'enforced');
  // And the observation boundary is where a claim is actually tested.
  assert.throws(
    () => acceptCompleteObservation({ ...fullObservation, attestation: 'enforced' }, { poolId: POOL, attestor: OTHER_SERVICE }, '2026-09-06T20:35:02.000Z'),
    ProtocolValidationError,
  );
  // No equivalent boundary exists for a binding in this module, and that absence is the
  // point: a future consumer that reads this field without authenticating the mapping is a
  // missing-boundary defect owed a cut-wire test at that seam.
  assert.equal(typeof /** @type {Record<string, unknown>} */ (usageModule).acceptSeatBinding, 'undefined');
});

// --- Mutation controls -------------------------------------------------------------
// These live here, in the owned test file, rather than in a script a bearer types once:
// an instrument that exists only as a typed command dies with the seat, and this one has
// to run in CI for anyone to trust the two guards below.
//
// Each control cuts ONE load-bearing line, loads the mutated module, and demands that the
// property this suite asserts is actually gone. A control that merely proves "something
// went red" credits any failure, including one the mutant caused by accident; these name
// the exact behaviour that must disappear. The anchor is checked for uniqueness before it
// is cut, so a refactor that moves the line fails the control loudly instead of silently
// passing.
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SOURCE = fileURLToPath(new URL('../src/protocol/usage.mjs', import.meta.url));
const COMMON = pathToFileURL(fileURLToPath(new URL('../src/protocol/common.mjs', import.meta.url))).href;
const IDENTITY = pathToFileURL(fileURLToPath(new URL('../src/protocol/identity.mjs', import.meta.url))).href;

/** Load a copy of the module with one line replaced. Imports are rewritten to absolute
 * URLs so the copy can live outside the package directory and touch nothing in it. */
async function loadMutant(/** @type {string} */ anchor, /** @type {string} */ replacement) {
  const original = await readFile(SOURCE, 'utf8');
  const occurrences = original.split(anchor).length - 1;
  assert.equal(occurrences, 1, `mutation anchor must be unique, found ${occurrences}`);
  const mutated = original
    .replace(anchor, replacement)
    .replace("from './common.mjs'", `from '${COMMON}'`)
    .replace("from './identity.mjs'", `from '${IDENTITY}'`);
  const path = join(tmpdir(), `usage-mutant-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`);
  await writeFile(path, mutated, 'utf8');
  try {
    return await import(pathToFileURL(path).href);
  } finally {
    await unlink(path).catch(() => {});
  }
}

test('CONTROL: cutting the attestor binding removes the refusal this suite asserts', async () => {
  const mutant = await loadMutant(
    '    && JSON.stringify(observation.attestor) === JSON.stringify(expectedAttestor);',
    '    && true;',
  );
  // Baseline, from the real module: an enforced claim against the wrong attestor throws.
  assert.throws(
    () => acceptCompleteObservation({ ...fullObservation, attestation: 'enforced' }, { poolId: POOL, attestor: OTHER_SERVICE }, '2026-09-06T20:35:02.000Z'),
    ProtocolValidationError,
  );
  // With the binding cut, that refusal is gone and a wrong attestor is accepted as enforced.
  const accepted = mutant.acceptCompleteObservation({ ...fullObservation, attestation: 'enforced' }, { poolId: POOL, attestor: OTHER_SERVICE }, '2026-09-06T20:35:02.000Z');
  assert.equal(accepted.attestation, 'enforced', 'the cut wire must be load-bearing');
});

test('CONTROL: cutting the clock comparison removes reset-due entirely', async () => {
  const mutant = await loadMutant(
    "  return new Date(r.resetsAt).getTime() <= at ? 'reset-due' : 'fresh';",
    "  return 'fresh';",
  );
  assert.equal(windowFreshness(fiveHour, '2026-09-07T01:00:00.000Z'), 'reset-due');
  assert.equal(mutant.windowFreshness(fiveHour, '2026-09-07T01:00:00.000Z'), 'fresh', 'the cut wire must be load-bearing');
});
