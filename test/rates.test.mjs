// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadRateTable, priceUsage, selectRateRow, bracketContains, RateError, RATE_KEY_FIELDS,
} from '../src/usage/rates.mjs';
import { attributePool, PoolAttributionError } from '../src/usage/pool-attribution.mjs';

const EVENT = '2026-09-01T12:00:00.000Z';
const AS_OF = '2026-09-07T12:00:00.000Z';
const TIMES = { eventTime: EVENT, asOf: AS_OF };

const KEY = {
  provider: 'anthropic',
  endpoint: 'api.anthropic.com',
  modelRevision: 'claude-opus-4-6',
  serviceTier: 'default',
  region: 'us',
  billingMode: 'api',
};

/** @param {Partial<typeof KEY> & Record<string, unknown>} extra */
function row(extra = {}) {
  return {
    ...KEY,
    effective: '2026-06-01T00:00:00.000Z',
    contextBracketMin: 0,
    contextBracketMax: 200000,
    source: 'https://example.invalid/rates',
    retrieved: '2026-06-01T00:00:00.000Z',
    qualification: /** @type {const} */ ('qualified'),
    publishedApi: { 'uncached-input': { usdPerMillion: 5 }, output: { usdPerMillion: 25 } },
    ...extra,
  };
}

/** @param {unknown[]} rows */
function table(rows) {
  return loadRateTable({ version: 1, rows });
}

function knownBilling() {
  /** @type {Record<string, unknown>} */
  const ctx = { version: 1 };
  for (const field of RATE_KEY_FIELDS) ctx[field] = { state: 'known', value: KEY[field] };
  return ctx;
}

function record(extra = {}) {
  return {
    identity: {
      harness: 'claude-code', sessionEpoch: 'e1', sourceId: 'req-1',
      sourceUnit: 'request', finality: 'final',
    },
    observedAt: EVENT,
    usage: {
      components: {
        'uncached-input': { state: 'known', value: 1000, unit: 'tokens' },
        output: { state: 'known', value: 200, unit: 'tokens' },
      },
      coverage: 'partial',
    },
    ...extra,
  };
}

test('a missing rate never yields a cost of zero', () => {
  const r = priceUsage(record(), table([]), TIMES, knownBilling(), { state: 'known', tokens: 1000 });
  assert.equal(r.coverage, 'none');
  assert.equal(r.apiEquivalent.state, 'unknown');
  assert.equal(r.apiEquivalent.state, 'unknown');
  assert.equal(r.unpriced['uncached-input'].tokens, 1000);
  assert.match(r.unpriced['uncached-input'].reason, /no-matching-rate/);
  assert.notEqual(r.unpriced['uncached-input'].tokens, 0);
});

test('an unknown billing-context field yields no match', () => {
  const billing = { ...knownBilling(), region: { state: 'unknown' } };
  const r = priceUsage(record(), table([row()]), TIMES, billing, { state: 'known', tokens: 1000 });
  assert.equal(r.apiEquivalent.reason, 'billing-context-unknown');
  assert.equal(r.coverage, 'none');
});

test('unmeasured resident context leaves every component unpriced', () => {
  const r = priceUsage(record(), table([row()]), TIMES, knownBilling(), { state: 'unknown' });
  assert.equal(r.apiEquivalent.reason, 'context-unmeasured');
  assert.equal(r.unpriced.output.tokens, 200);
});

test('a rate effective after eventTime does not apply', () => {
  const future = row({ effective: '2026-09-02T00:00:00.000Z' });
  const r = priceUsage(record(), table([future]), TIMES, knownBilling(), { state: 'known', tokens: 1000 });
  assert.equal(r.apiEquivalent.reason, 'no-matching-rate');
});

test('a rate effective after asOf does not apply even if the event is later', () => {
  const later = row({ effective: '2026-09-04T00:00:00.000Z' });
  const r = priceUsage(
    record(),
    table([later]),
    { eventTime: '2026-09-06T00:00:00.000Z', asOf: '2026-09-03T00:00:00.000Z' },
    knownBilling(),
    { state: 'known', tokens: 1000 },
  );
  assert.equal(r.apiEquivalent.reason, 'no-matching-rate');
});

test('two rows for one key pick the latest effective not after asOf', () => {
  const older = row({ effective: '2026-01-01T00:00:00.000Z', publishedApi: { output: { usdPerMillion: 10 } } });
  const newer = row({ effective: '2026-06-01T00:00:00.000Z', publishedApi: { output: { usdPerMillion: 25 } } });
  const r = priceUsage(record(), table([older, newer]), TIMES, knownBilling(), { state: 'known', tokens: 1000 });
  assert.equal(r.row?.effective, '2026-06-01T00:00:00.000Z');
  assert.equal(r.apiEquivalent.state, 'known');
  assert.equal(r.apiEquivalent.state === 'known' ? r.apiEquivalent.components.output.usd : null, (200 / 1_000_000) * 25);
});

test('duplicate overlapping rows at one effective timestamp are refused, but dated rows select later', () => {
  const first = row({ publishedApi: { output: { usdPerMillion: 10 } } });
  const duplicate = row({ publishedApi: { output: { usdPerMillion: 25 } } });
  assert.throws(
    () => table([first, duplicate]),
    (error) => error instanceof RateError
      && error.code === 'duplicate-rate-row'
      && error.message.includes('provider=anthropic')
      && error.message.includes('effective=2026-06-01T00:00:00.000Z'),
  );

  const later = row({
    effective: '2026-07-01T00:00:00.000Z',
    publishedApi: { output: { usdPerMillion: 25 } },
  });
  const loaded = table([first, later]);
  const selected = selectRateRow(KEY, loaded, EVENT, AS_OF, 1000);
  assert.equal(selected?.effective, '2026-07-01T00:00:00.000Z');
  assert.equal(selected?.publishedApi?.output.usdPerMillion, 25);
});

test('a context bracket boundary is exact: the shared edge belongs to the later min', () => {
  const low = row({ contextBracketMin: 0, contextBracketMax: 1000 });
  const high = row({ contextBracketMin: 1000, contextBracketMax: 200000, publishedApi: { output: { usdPerMillion: 99 } } });
  assert.equal(bracketContains(999, low), true);
  assert.equal(bracketContains(1000, low), false);
  assert.equal(bracketContains(1000, high), true);
  const r = priceUsage(record(), table([low, high]), TIMES, knownBilling(), { state: 'known', tokens: 1000 });
  assert.equal(r.row?.contextBracketMin, 1000);
  assert.equal(r.apiEquivalent.state, 'known');
  assert.equal(r.apiEquivalent.state === 'known' ? r.apiEquivalent.components.output.usd : null, (200 / 1_000_000) * 99);
});

test('an illustrative row prices nothing outside tests', () => {
  const illus = row({ illustrative: true });
  const r = priceUsage(record(), table([illus]), TIMES, knownBilling(), { state: 'known', tokens: 1000 });
  assert.equal(r.apiEquivalent.reason, 'no-matching-rate');
  const allowed = priceUsage(record(), table([illus]), TIMES, knownBilling(), { state: 'known', tokens: 1000 }, { allowIllustrative: true });
  assert.equal(allowed.apiEquivalent.state, 'known');
});

test('an unqualified row never prices', () => {
  const r = priceUsage(
    record(),
    table([row({ qualification: 'unqualified' })]),
    TIMES,
    knownBilling(),
    { state: 'known', tokens: 1000 },
  );
  assert.equal(r.apiEquivalent.reason, 'no-matching-rate');
});

test('reportedBill is the source figure in its stated unit; subscriptionConsumption is unknown unless observed', () => {
  const withCost = record({ sourceReportedCost: { state: 'known', amount: 42, unit: 'usd-ticks' } });
  const r = priceUsage(withCost, table([row()]), TIMES, knownBilling(), { state: 'known', tokens: 1000 });
  assert.deepEqual(r.reportedBill, { state: 'known', amount: 42, unit: 'usd-ticks' });
  assert.equal(r.subscriptionConsumption.state, 'unknown');
  assert.equal(r.subscriptionConsumption.reason, 'not-observed');
  const none = priceUsage(record(), table([row()]), TIMES, knownBilling(), { state: 'known', tokens: 1000 });
  assert.equal(none.reportedBill.state, 'unknown');
});

test('a component with no publishedApi rate is unpriced, never a zero cost', () => {
  const thin = row({ publishedApi: { output: { usdPerMillion: 25 } } });
  const r = priceUsage(record(), table([thin]), TIMES, knownBilling(), { state: 'known', tokens: 1000 });
  assert.equal(r.unpriced['uncached-input'].reason, 'missing-rate');
  assert.equal(r.unpriced['uncached-input'].tokens, 1000);
  assert.equal(r.apiEquivalent.state === 'known' ? r.apiEquivalent.components.output.usd : null, (200 / 1_000_000) * 25);
  assert.equal(r.coverage, 'partial');
  assert.ok(!('usd' in r.unpriced['uncached-input']));
});

test('attributePool maps only by explicit member id', () => {
  const mapping = { members: { 'sess-a': 'pool-1' } };
  assert.deepEqual(attributePool('sess-a', mapping), { attributed: true, poolId: 'pool-1' });
  assert.deepEqual(attributePool('sess-b', mapping), { attributed: false, reason: 'unknown-mapping' });
  assert.throws(() => attributePool(' ', mapping), PoolAttributionError);
});

test('a model label is not a billing key and is not consulted for the pool', () => {
  const r = priceUsage(
    record({ model: 'claude-opus-4-6' }),
    table([]),
    TIMES,
    { ...knownBilling(), modelRevision: { state: 'unknown' } },
    { state: 'known', tokens: 1000 },
  );
  assert.equal(r.apiEquivalent.reason, 'billing-context-unknown');
});

test('malformed times and unknown-with-a-value are refused, not priced', () => {
  assert.throws(() => priceUsage(record(), table([row()]), { eventTime: 'nope', asOf: AS_OF }, knownBilling(), { state: 'known', tokens: 1 }), RateError);
  assert.throws(() => priceUsage(record(), table([row()]), TIMES, knownBilling(), { state: 'unknown', tokens: 1 }), RateError);
});

test('a row carrying subscriptionConsumption or providerReportedBill is refused at load', () => {
  assert.throws(
    () => table([row({ subscriptionConsumption: { output: { usdPerMillion: 5 } } })]),
    (/** @type {any} */ err) => err instanceof RateError
      && err.code === 'observed-column-not-a-rate'
      && /subscriptionConsumption/.test(err.message)
      && /per-record observation/.test(err.message),
  );
  assert.throws(
    () => table([row({ providerReportedBill: { output: { usdPerMillion: 5 } } })]),
    (/** @type {any} */ err) => err instanceof RateError
      && err.code === 'observed-column-not-a-rate'
      && /providerReportedBill/.test(err.message),
  );
  const ok = table([row()]);
  assert.equal(ok.rows.length, 1);
  assert.equal(Object.hasOwn(ok.rows[0], 'subscriptionConsumption'), false);
  assert.equal(Object.hasOwn(ok.rows[0], 'providerReportedBill'), false);
});
