// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProtocolValidationError } from '../src/protocol/common.mjs';
import { validateNativeReadCoverage } from '../src/protocol/read.mjs';
import { validateWakeRoutes, deriveWakeSurface, validatePublicBearer, validatePresenceLease, assertPresenceContext, evaluatePresenceLease } from '../src/protocol/lease.mjs';
import { validateNativeDeliveredCoverage, validateDeliveryRange, assertDeliveredCoverageContext, coversDeliveredRange } from '../src/protocol/delivered-coverage.mjs';

const epoch = 'a'.repeat(32), roomId = 'b'.repeat(32);
const host = { scheme: /** @type {const} */ ('native'), authority: 'test-host', id: 'host000000000001' };
const service = { serviceId: 'service000000001', serviceBootId: 'boot000000000001' };
const recipient = { accountId: 'account000000001', registrationId: 'register00000001', generation: 3 };
const seat = { accountId: recipient.accountId, principal: host, attestor: service };
const room = { host, roomId, epoch };
/** @param {number} n */
const cursor = (n) => `${epoch}:${n}`;
/** @param {number} [from] @param {number} [to] */
const coverage = (from = 10, to = 20) => ({ room, fromExclusive: cursor(from), toInclusive: cursor(to), committedThrough: cursor(30) });
const progressId = 'progress00000001', admissionId = 'admitted00000001';
const proof = () => structuredClone({ recipient, service, coverage: coverage(), progressId, admissionId });
const context = () => structuredClone({ recipient, service, room, progressId, admissionId });
const range = { after: cursor(10), through: cursor(20) };
const bearer = () => ({ registration: recipient, bearer: 'Test/worker', harnessId: 'test', persistence: 'persistent',
  processPresent: 'unknown', wakeSurface: 'present', wakeRoutes: { subscriber: 'present', pane: 'unknown' } });
const lease = () => ({ seat, service, leaseId: 'lease00000000001', renewal: 2,
  renewedAt: '2026-09-05T12:00:00.000Z', expects_agents: true, build: { version: '1', git: 'c'.repeat(40) }, bearers: [bearer()] });
const leaseContext = () => ({ seat, service, leaseId: 'lease00000000001', role: 'agent-capable' });
/** @param {() => unknown} fn */
const refuses = (fn) => assert.throws(fn, ProtocolValidationError);

test('all nine wake-route pairs preserve coexistence and unknown with a derived aggregate', () => {
  const states = ['present', 'absent', 'unknown'];
  const expected = [['present', 'present', 'present'], ['present', 'absent', 'unknown'], ['present', 'unknown', 'unknown']];
  for (const [i, subscriber] of states.entries()) for (const [j, pane] of states.entries()) {
    const routes = { subscriber, pane };
    assert.deepEqual(validateWakeRoutes(routes), routes);
    assert.equal(deriveWakeSurface(routes), expected[i][j]);
    assert.equal(validatePublicBearer({ ...bearer(), wakeRoutes: routes, wakeSurface: expected[i][j] }).wakeSurface, expected[i][j]);
    for (const wrong of states.filter((s) => s !== expected[i][j])) refuses(() => validatePublicBearer({ ...bearer(), wakeRoutes: routes, wakeSurface: wrong }));
  }
});

test('wake route values are closed and missing does not mean absent', () => {
  for (const v of [null, 'pane', {}, { subscriber: 'present' }, { subscriber: 'none', pane: 'absent' },
    { subscriber: 'present', pane: 'unknown', admitted: true }]) refuses(() => validateWakeRoutes(v));
});

test('lease copies its public records and excludes local and serialized authority fields', () => {
  const input = lease(), parsed = validatePresenceLease(input);
  assert.deepEqual(parsed, input);
  input.bearers[0].wakeRoutes.subscriber = 'absent';
  assert.equal(parsed.bearers[0].wakeRoutes.subscriber, 'present');
  for (const key of ['pid', 'path', 'isLive', 'admission']) refuses(() => validatePresenceLease({ ...lease(), [key]: true }));
  refuses(() => validatePublicBearer({ ...bearer(), cwd: '/private' }));
});

test('lease roster rejects duplicate registration tuples and invalid generations', () => {
  refuses(() => validatePresenceLease({ ...lease(), bearers: [bearer(), bearer()] }));
  refuses(() => validatePublicBearer({ ...bearer(), registration: { ...recipient, generation: 0 } }));
  const next = { ...bearer(), registration: { ...recipient, generation: 4 } };
  assert.equal(validatePresenceLease({ ...lease(), bearers: [bearer(), next] }).bearers.length, 2);
  refuses(() => validatePresenceLease({ ...lease(), bearers: Array(1025).fill(bearer()) }));
});

test('lease build and renewal have bounded canonical grammar', () => {
  for (const renewal of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) refuses(() => validatePresenceLease({ ...lease(), renewal }));
  for (const git of ['a'.repeat(39), 'A'.repeat(40), 'a'.repeat(40) + '\n']) refuses(() => validatePresenceLease({ ...lease(), build: { version: '1', git } }));
  refuses(() => validatePresenceLease({ ...lease(), renewedAt: 'not-a-time' }));
  refuses(() => validatePresenceLease({ ...lease(), expects_agents: 0 }));
});

test('service-only is explicit local context, never inferred from empty roster', () => {
  const empty = { ...lease(), bearers: [] };
  assert.equal(assertPresenceContext(empty, leaseContext()).expects_agents, true);
  refuses(() => assertPresenceContext({ ...empty, expects_agents: false }, leaseContext()));
  assert.equal(assertPresenceContext({ ...empty, expects_agents: false }, { ...leaseContext(), role: 'service-only' }).expects_agents, false);
  refuses(() => assertPresenceContext(empty, { ...leaseContext(), role: 'service-only' }));
  refuses(() => validatePresenceLease({ ...lease(), expects_agents: false }));
});

test('lease binds independently supplied seat, attestor boot and lease ID', () => {
  assert.deepEqual(assertPresenceContext(lease(), leaseContext()), lease());
  refuses(() => assertPresenceContext(lease(), { ...leaseContext(), leaseId: 'otherlease000001' }));
  refuses(() => assertPresenceContext(lease(), { ...leaseContext(), service: { ...service, serviceBootId: 'otherboot0000001' } }));
  refuses(() => assertPresenceContext(lease(), { ...leaseContext(), seat: { ...seat, principal: { ...host, authority: 'other' } } }));
  refuses(() => validatePresenceLease({ ...lease(), service: { ...service, serviceBootId: 'otherboot0000001' } }));
});

test('lease freshness is receiver-timed, disconnect darkens, exact expiry is dark', () => {
  const timing = { acceptedRenewal: 2, acceptedAt: 100, now: 45099, connected: true };
  assert.equal(evaluatePresenceLease(lease(), leaseContext(), timing), 'fresh');
  assert.equal(evaluatePresenceLease(lease(), leaseContext(), { ...timing, now: 45100 }), 'dark');
  assert.equal(evaluatePresenceLease(lease(), leaseContext(), { ...timing, now: 101, connected: false }), 'dark');
  assert.equal(evaluatePresenceLease({ ...lease(), renewedAt: '2999-01-01T00:00:00.000Z' }, leaseContext(), { ...timing, now: 45100 }), 'dark');
  refuses(() => evaluatePresenceLease(lease(), leaseContext(), { ...timing, acceptedRenewal: 1 }));
  refuses(() => evaluatePresenceLease(lease(), leaseContext(), { ...timing, now: 99 }));
  refuses(() => evaluatePresenceLease(lease(), leaseContext(), { ...timing, connected: 'yes' }));
});

test('delivered coverage composes the existing scan grammar without modifying it', () => {
  const p = proof();
  assert.deepEqual(validateNativeDeliveredCoverage(p).coverage, validateNativeReadCoverage(p.coverage));
  assert.deepEqual(assertDeliveredCoverageContext(p, context()), p);
  const parsed = validateNativeDeliveredCoverage(p);
  p.recipient.generation = 9;
  p.coverage.room.host.authority = 'changed';
  assert.equal(parsed.recipient.generation, 3);
  assert.equal(parsed.coverage.room.host.authority, 'test-host');
});

test('a bare scan, saved cursor, manual cursor jump or gap flag is never delivered proof', () => {
  for (const value of [coverage(), cursor(30), { cursor: cursor(30) }, { ...proof(), gapFree: true },
    { ...proof(), source: 'authenticated' }, { ...proof(), acknowledged: true }, { ...proof(), coverage: [coverage()] }]) {
    refuses(() => validateNativeDeliveredCoverage(value));
    refuses(() => coversDeliveredRange(value, context(), range));
  }
});

test('delivered proof requires progress and admission references', () => {
  for (const key of ['recipient', 'service', 'coverage', 'progressId', 'admissionId']) {
    const p = /** @type {Record<string, unknown>} */ (proof()); delete p[key];
    refuses(() => validateNativeDeliveredCoverage(p));
  }
  refuses(() => validateNativeDeliveredCoverage({ ...proof(), progressId: '' }));
  refuses(() => validateNativeDeliveredCoverage({ ...proof(), admissionId: 'short' }));
});

test('recipient account, registration and generation cannot cross a delivery', () => {
  for (const recipient of [{ ...context().recipient, accountId: 'otheraccount0001' },
    { ...context().recipient, registrationId: 'otherregister001' }, { ...context().recipient, generation: 4 }]) {
    refuses(() => coversDeliveredRange(proof(), { ...context(), recipient }, range));
  }
});

test('service identity, boot, admission and progress cannot cross a delivery', () => {
  for (const change of [{ service: { ...service, serviceId: 'otherservice0001' } },
    { service: { ...service, serviceBootId: 'otherboot0000001' } }, { progressId: 'otherprogress001' }, { admissionId: 'otheradmitted001' }]) {
    refuses(() => coversDeliveredRange(proof(), { ...context(), ...change }, range));
  }
});

test('coverage host including authority, room and epoch cannot cross a delivery', () => {
  for (const changedRoom of [{ ...room, host: { ...host, authority: 'other-host' } },
    { ...room, host: { ...host, id: 'otherhost0000001' } }, { ...room, roomId: 'c'.repeat(32) }, { ...room, epoch: 'd'.repeat(32) }]) {
    refuses(() => coversDeliveredRange(proof(), { ...context(), room: changedRoom }, range));
  }
});

test('whole-range coverage uses delivered end, never the larger committed frontier', () => {
  assert.equal(coversDeliveredRange(proof(), context(), range), true);
  assert.equal(coversDeliveredRange(proof(), context(), { after: cursor(11), through: cursor(19) }), true);
  assert.equal(coversDeliveredRange(proof(), context(), { after: cursor(9), through: cursor(20) }), false);
  assert.equal(coversDeliveredRange(proof(), context(), { after: cursor(10), through: cursor(21) }), false);
  assert.equal(coversDeliveredRange({ ...proof(), coverage: coverage(12, 18) }, context(), range), false);
  assert.equal(coversDeliveredRange({ ...proof(), coverage: coverage(10, 10) }, context(), range), false);
});

test('disjoint intervals cannot be stitched through an omitted gap', () => {
  const a = { ...proof(), coverage: coverage(10, 14) }, b = { ...proof(), coverage: coverage(15, 20) };
  assert.equal(coversDeliveredRange(a, context(), range), false);
  assert.equal(coversDeliveredRange(b, context(), range), false);
  refuses(() => coversDeliveredRange([a, b], context(), range));
});

test('delivery range rejects foreign epoch, reversed cursors, and artifact-only sources', () => {
  assert.deepEqual(validateDeliveryRange(range), range);
  for (const r of [{ after: cursor(20), through: cursor(10) }, { after: cursor(10), through: `${'c'.repeat(32)}:20` },
    { artifact: 'reference' }, { after: cursor(10), through: cursor(20), savedCursor: cursor(30) }]) refuses(() => validateDeliveryRange(r));
  refuses(() => coversDeliveredRange(proof(), context(), { after: `${'c'.repeat(32)}:10`, through: `${'c'.repeat(32)}:20` }));
});

test('read-only lookup re-evaluates later progress without changing ACK, cursor or records', () => {
  const pending = Object.freeze({ ...range }), old = proof(), expected = context();
  old.coverage = coverage(10, 10); // minted at 10, later subscriber delivers through 20
  const snapshot = JSON.stringify({ pending, old, expected });
  assert.equal(coversDeliveredRange(old, expected, pending), false);
  assert.equal(coversDeliveredRange(proof(), expected, pending), true);
  assert.equal(JSON.stringify({ pending, old, expected }), snapshot);
  // At admission the current generation differs: cached lookup success grants nothing.
  refuses(() => coversDeliveredRange(proof(), { ...expected, recipient: { ...recipient, generation: 4 } }, pending));
});

test('boundary parsers reject getters, extra keys and polluted prototypes without reading accessors', () => {
  let reads = 0;
  const getter = { ...proof() };
  Object.defineProperty(getter, 'recipient', { enumerable: true, get() { reads++; return recipient; } });
  refuses(() => validateNativeDeliveredCoverage(getter));
  const nested = { ...bearer() };
  Object.defineProperty(nested, 'wakeRoutes', { enumerable: true, get() { reads++; return {}; } });
  refuses(() => validatePublicBearer(nested));
  assert.equal(reads, 0);
  refuses(() => validateNativeDeliveredCoverage(Object.assign(Object.create({ hidden: true }), proof())));
  refuses(() => assertDeliveredCoverageContext(proof(), { ...context(), trusted: true }));
  refuses(() => validatePresenceLease({ ...lease(), bearers: new Array(1) }));
});
