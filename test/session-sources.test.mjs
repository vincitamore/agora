// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeSessionUsage,
  knownCount,
  unknownCount,
  invalidCount,
  notApplicableCount,
  readCountField,
  disjointUncached,
  SESSION_SOURCE_HARNESSES,
  SESSION_SOURCE_CODES,
  OVERLAP_BASIS,
  resolveOverlap,
} from '../src/usage/session-sources.mjs';
import { validateSessionUsageRecord } from '../src/protocol/session-usage.mjs';

const EPOCH = 'session-epoch-synthetic-e1b-01';
const OBSERVED = '2026-09-07T00:20:00.000Z';
const RAW_KEYS = [
  'input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens',
  'cache_creation', 'cached_input_tokens', 'cache_write_input_tokens', 'last_token_usage',
  'total_token_usage', 'inputTokens', 'outputTokens', 'cachedReadTokens', 'cacheCreationTokens',
  'modelUsage', 'modelCalls', 'costUsdTicks', 'cacheRead', 'cacheWrite', 'cttl',
];

/**
 * @param {string} harness
 * @param {unknown} envelope
 * @param {Record<string, unknown>} [extra]
 * @returns {ReturnType<typeof decodeSessionUsage>}
 */
function decode(harness, envelope, extra = {}) {
  const extraContext = isRecord(extra.context) ? extra.context : {};
  const context = { observedAt: OBSERVED, ...extraContext };
  const rest = { ...extra };
  delete rest.context;
  return decodeSessionUsage({ harness, sessionEpoch: EPOCH, envelope, ...rest, context });
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {ReturnType<typeof decodeSessionUsage>} result
 * @returns {Extract<ReturnType<typeof decodeSessionUsage>, { status: 'supported' }>}
 */
function supported(result) {
  assert.equal(result.status, 'supported');
  if (result.status !== 'supported') throw new Error('expected supported');
  return result;
}

/**
 * @param {ReturnType<typeof decodeSessionUsage>} result
 * @returns {Exclude<ReturnType<typeof decodeSessionUsage>, { status: 'supported' }>}
 */
function rejected(result) {
  assert.notEqual(result.status, 'supported');
  if (result.status === 'supported') throw new Error('expected rejection');
  return result;
}

/**
 * @param {ReturnType<typeof validateSessionUsageRecord>} record
 * @param {string} name
 * @returns {ReturnType<typeof validateSessionUsageRecord>['usage']['components'][string]}
 */
function component(record, name) {
  const value = record.usage.components[name];
  assert.ok(value);
  return value;
}

/** @param {ReturnType<typeof component>} counter @param {string} reason */
function assertUnknown(counter, reason) {
  assert.equal(counter.state, 'unknown');
  if (counter.state !== 'unknown') return;
  assert.equal(counter.reason, reason);
}

/** @param {unknown} record */
function assertNoRawKeys(record) {
  const json = JSON.stringify(record);
  for (const key of RAW_KEYS) {
    assert.equal(json.includes(`"${key}"`), false, `raw key leaked: ${key}`);
  }
}

/** @param {unknown} record */
function assertContract(record) {
  const validated = validateSessionUsageRecord(record);
  assert.equal(validated.identity.sessionEpoch, EPOCH);
  assert.equal(validated.observedAt, OBSERVED);
}

/** @param {Record<string, unknown>} usage @param {Record<string, unknown>} [extra] */
function claudeEnvelope(usage, extra = {}) {
  return {
    timestamp: OBSERVED,
    message: {
      id: 'msg_synthetic_claude_01',
      model: 'claude-opus-4-6',
      usage,
    },
    ...extra,
  };
}

/** @param {Record<string, unknown>} usage @param {Record<string, unknown>} [extra] */
function ompEnvelope(usage, extra = {}) {
  return {
    timestamp: OBSERVED,
    message: {
      id: 'msg_synthetic_omp_01',
      model: 'gpt-5.4',
      usage,
    },
    ...extra,
  };
}

/** @param {Record<string, unknown>} last @param {Record<string, unknown>} [total] */
function codexEnvelope(last, total) {
  return {
    type: 'event_msg',
    timestamp: OBSERVED,
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: last,
        ...(total ? { total_token_usage: total } : {}),
      },
    },
  };
}

/** @param {Record<string, Record<string, unknown>>} modelUsage @param {string} [promptId] */
function amoreEnvelope(modelUsage, promptId = 'prompt_synthetic_01') {
  return {
    timestamp: OBSERVED,
    params: {
      sessionId: 'sess_synthetic_amore_01',
      update: {
        sessionUpdate: 'turn_completed',
        prompt_id: promptId,
        usage: { modelUsage },
      },
    },
  };
}

test('known zero is known, absent is unknown, null is invalid, negative is invalid', () => {
  assert.deepEqual(knownCount(0), { state: 'known', value: 0, unit: 'tokens' });
  assert.deepEqual(readCountField({}, 'n'), unknownCount('absent:n'));
  assert.deepEqual(readCountField({ n: null }, 'n'), invalidCount('null:n'));
  assert.deepEqual(readCountField({ n: -1 }, 'n'), invalidCount('count-not-safe-nonnegative-integer'));
  assert.deepEqual(readCountField({ n: 1.5 }, 'n'), invalidCount('count-not-safe-nonnegative-integer'));
  assert.deepEqual(readCountField({ n: '1' }, 'n'), invalidCount('type:n'));
  assert.equal(notApplicableCount().state, 'not-applicable');
});

test('disjoint uncached never clamps: cache exceeding input is invalid', () => {
  const over = disjointUncached(knownCount(10), [knownCount(4), knownCount(7)]);
  assert.deepEqual(over, invalidCount('cache-exceeds-input'));
  const ok = disjointUncached(knownCount(10), [knownCount(4), knownCount(3)]);
  assert.deepEqual(ok, knownCount(3));
  const unknown = disjointUncached(knownCount(10), [unknownCount('absent:cache')]);
  assert.equal(unknown.state, 'unknown');
  const skipped = disjointUncached(knownCount(10), [notApplicableCount(), knownCount(2)]);
  assert.deepEqual(skipped, knownCount(8));
});

test('unknown harness is unsupported; missing envelope, epoch and observedAt are errors', () => {
  assert.equal(rejected(decodeSessionUsage({ harness: 'other', sessionEpoch: EPOCH, envelope: {} })).code, SESSION_SOURCE_CODES.unknownHarness);
  assert.equal(rejected(decodeSessionUsage({ harness: 'claude-code', sessionEpoch: EPOCH })).code, SESSION_SOURCE_CODES.missingEnvelope);
  assert.equal(rejected(decodeSessionUsage({ harness: 'claude-code', envelope: claudeEnvelope({ input_tokens: 1, output_tokens: 1 }) })).code, SESSION_SOURCE_CODES.identityMissing);
  const noTime = rejected(decodeSessionUsage({
    harness: 'claude-code',
    sessionEpoch: EPOCH,
    envelope: { message: { id: 'msg_synthetic_claude_01', usage: { input_tokens: 1, output_tokens: 1 } } },
  }));
  assert.equal(noTime.code, SESSION_SOURCE_CODES.observedAtMissing);
  assert.ok(SESSION_SOURCE_HARNESSES.includes('codex'));
});

test('claude split writes stay split and uncached is input_tokens as reported', () => {
  const result = supported(decode('claude-code', claudeEnvelope({
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 40,
    cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 5 },
  })));
  const record = result.records[0];
  assertContract(record);
  assert.equal(record.identity.sourceUnit, 'request');
  assert.equal(record.identity.sourceId, 'msg_synthetic_claude_01');
  assert.equal(record.identity.finality, 'unknown');
  assert.equal(record.model, 'claude-opus-4-6');
  assert.deepEqual(component(record, 'cached-input'), knownCount(40));
  assert.deepEqual(component(record, 'cache-write-5m'), knownCount(10));
  assert.deepEqual(component(record, 'cache-write-1h'), knownCount(5));
  assert.deepEqual(component(record, 'uncached-input'), knownCount(100));
  assert.deepEqual(component(record, 'output'), knownCount(20));
  assert.equal(component(record, 'reasoning-billed').state, 'unknown');
  assert.equal(component(record, 'tool').state, 'unknown');
  assert.equal(Object.hasOwn(record.usage.components, 'cache-write-unknown-ttl'), false);
  assert.equal(record.usage.overlap?.relation, 'none');
  assertNoRawKeys(record);
});

test('claude unsplit cache_creation_input_tokens is cache-write-unknown-ttl, not 5m', () => {
  const result = supported(decode('claude-code', claudeEnvelope({
    input_tokens: 100,
    output_tokens: 8,
    cache_read_input_tokens: 20,
    cache_creation_input_tokens: 15,
  })));
  const record = result.records[0];
  assertContract(record);
  assertUnknown(component(record, 'cache-write-5m'), 'ttl-split-absent');
  assert.equal(component(record, 'cache-write-1h').state, 'unknown');
  assert.deepEqual(component(record, 'cache-write-unknown-ttl'), knownCount(15));
  assert.deepEqual(component(record, 'uncached-input'), knownCount(100));
});

test('claude absent cache fields are unknown, not zero; uncached is input_tokens as reported', () => {
  const result = supported(decode('claude-code', claudeEnvelope({
    input_tokens: 50,
    output_tokens: 0,
  })));
  const record = result.records[0];
  assertContract(record);
  assert.deepEqual(component(record, 'output'), knownCount(0));
  assert.equal(component(record, 'cached-input').state, 'unknown');
  assert.equal(component(record, 'cache-write-5m').state, 'unknown');
  assert.deepEqual(component(record, 'uncached-input'), knownCount(50));
  assert.equal(record.usage.coverage, 'partial');
});

test('claude null and oversized cache keep the record and mark the counter invalid', () => {
  const nullRead = supported(decode('claude-code', claudeEnvelope({
    input_tokens: 50,
    output_tokens: 1,
    cache_read_input_tokens: null,
  })));
  assertContract(nullRead.records[0]);
  assert.equal(component(nullRead.records[0], 'cached-input').state, 'invalid');
  assert.deepEqual(component(nullRead.records[0], 'uncached-input'), knownCount(50));

  const over = supported(decode('claude-code', claudeEnvelope({
    input_tokens: 10,
    output_tokens: 1,
    cache_read_input_tokens: 12,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
  })));
  assertContract(over.records[0]);
  assert.deepEqual(component(over.records[0], 'uncached-input'), knownCount(10));
  assert.deepEqual(component(over.records[0], 'cached-input'), knownCount(12));
});

test('claude real-shaped cache larger than input_tokens still yields uncached as reported', () => {
  const result = supported(decode('claude-code', claudeEnvelope({
    input_tokens: 2,
    output_tokens: 1,
    cache_read_input_tokens: 90577,
    cache_creation_input_tokens: 1545,
  })));
  assertContract(result.records[0]);
  assert.deepEqual(component(result.records[0], 'uncached-input'), knownCount(2));
  assert.deepEqual(component(result.records[0], 'cached-input'), knownCount(90577));
});

test('claude fixture numbers that looked inclusive still take input_tokens as reported', () => {
  const result = supported(decode('claude-code', claudeEnvelope({
    input_tokens: 40,
    output_tokens: 1,
    cache_read_input_tokens: 10,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
  })));
  assert.deepEqual(component(result.records[0], 'uncached-input'), knownCount(40));
});

test('claude missing message id is identity-missing, not an invented key', () => {
  const result = rejected(decode('claude-code', { timestamp: OBSERVED, message: { model: 'claude-opus-4-6', usage: { input_tokens: 1, output_tokens: 1 } } }));
  assert.equal(result.code, SESSION_SOURCE_CODES.identityMissing);
});

test('omp cttl split is authoritative; unsplit cacheWrite is unknown-ttl, not 5m', () => {
  const split = supported(decode('omp', ompEnvelope({
    input: 80,
    output: 9,
    cacheRead: 30,
    cacheWrite: 20,
    cttl: { ephemeral5m: 12, ephemeral1h: 8 },
  })));
  const record = split.records[0];
  assertContract(record);
  assert.deepEqual(component(record, 'cache-write-5m'), knownCount(12));
  assert.deepEqual(component(record, 'cache-write-1h'), knownCount(8));
  assert.deepEqual(component(record, 'uncached-input'), knownCount(30));
  assert.equal(Object.hasOwn(record.usage.components, 'cache-write-unknown-ttl'), false);
  assertNoRawKeys(record);

  const unsplit = supported(decode('omp', ompEnvelope({
    input: 80,
    output: 9,
    cacheRead: 30,
    cacheWrite: 20,
  })));
  assertContract(unsplit.records[0]);
  assertUnknown(component(unsplit.records[0], 'cache-write-5m'), 'ttl-split-absent');
  assert.deepEqual(component(unsplit.records[0], 'cache-write-unknown-ttl'), knownCount(20));
  assert.deepEqual(component(unsplit.records[0], 'uncached-input'), knownCount(30));
  assert.equal(Object.hasOwn(unsplit.records[0], 'sourceReportedCost'), false);
});

test('omp integer cost.total is sourceReportedCost in the source unit; a float is invalid, never converted', () => {
  const kept = supported(decode('omp', ompEnvelope({
    input: 10,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    cost: { total: 42 },
  })));
  assertContract(kept.records[0]);
  assert.deepEqual(kept.records[0].sourceReportedCost, { state: 'known', amount: 42, unit: 'omp-cost-total' });

  const unusable = supported(decode('omp', ompEnvelope({
    input: 10,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    cost: { total: 0.0123 },
  })));
  assertContract(unusable.records[0]);
  assert.equal(unusable.records[0].sourceReportedCost?.state, 'invalid');
  assert.equal(Object.hasOwn(unusable.records[0].sourceReportedCost ?? {}, 'amount'), false);
});

test('codex requires caller sourceId and treats 1h write as unknown, never known zero', () => {
  const envelope = codexEnvelope(
    { input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 10, output_tokens: 7 },
    { total_tokens: 999 },
  );
  const missing = rejected(decode('codex', envelope, { context: { model: 'gpt-5.4' } }));
  assert.equal(missing.code, SESSION_SOURCE_CODES.identityMissing);
  assert.equal(missing.reason, 'codex-source-id-not-watermark');

  const result = supported(decode('codex', envelope, {
    context: { sourceId: 'rollout:offset:12', model: 'gpt-5.4' },
  }));
  const record = result.records[0];
  assertContract(record);
  assert.equal(record.identity.sourceUnit, 'cumulative-snapshot');
  assert.equal(record.identity.sourceId, 'rollout:offset:12');
  assert.notEqual(record.identity.sourceId, '999');
  assert.equal(Object.hasOwn(record, 'cumulativeWatermark'), false);
  assert.deepEqual(component(record, 'cached-input'), knownCount(40));
  assertUnknown(component(record, 'cache-write-5m'), 'codex-cache-write-ttl-unknown');
  assertUnknown(component(record, 'cache-write-1h'), 'codex-cache-write-ttl-unknown');
  assert.deepEqual(component(record, 'cache-write-unknown-ttl'), knownCount(10));
  assert.deepEqual(component(record, 'uncached-input'), knownCount(50));
  assert.equal(record.model, 'gpt-5.4');
  assertNoRawKeys(record);
});

test('codex cache exceeding input is invalid uncached, not clamped to zero', () => {
  const result = supported(decode('codex', codexEnvelope({
    input_tokens: 10,
    cached_input_tokens: 8,
    cache_write_input_tokens: 5,
    output_tokens: 1,
  }), { context: { sourceId: 'rollout:offset:1' } }));
  assertContract(result.records[0]);
  assert.deepEqual(component(result.records[0], 'uncached-input'), invalidCount('cache-exceeds-input'));
});

test('amore emits one aggregate record per model and does not invent requests', () => {
  const result = supported(decode('amore-build', amoreEnvelope({
    'grok-4.6': { inputTokens: 120, outputTokens: 30, cachedReadTokens: 50, cacheCreationTokens: 10, modelCalls: 3 },
    'grok-4.5': { inputTokens: 40, outputTokens: 8, cachedReadTokens: 0, cacheCreationTokens: 0, modelCalls: 1 },
  })));
  assert.equal(result.records.length, 2);
  const ids = result.records.map((r) => r.identity.sourceId).sort();
  assert.deepEqual(ids, ['prompt_synthetic_01:grok-4.5', 'prompt_synthetic_01:grok-4.6']);
  for (const record of result.records) {
    assertContract(record);
    assert.equal(record.identity.sourceUnit, 'aggregate');
    assert.equal(record.identity.finality, 'final');
    assert.equal(component(record, 'cache-write-1h').state, 'unknown');
    assertNoRawKeys(record);
  }
  const first = result.records.find((r) => r.identity.sourceId.endsWith('grok-4.6'));
  assert.ok(first);
  assert.deepEqual(component(first, 'uncached-input'), knownCount(60));
  assert.deepEqual(component(first, 'output'), knownCount(30));
  assert.equal(result.records.every((r) => r.identity.sourceUnit !== 'request'), true);
  assert.equal(Object.hasOwn(first, 'sourceReportedCost'), false);
});

test('amore costUsdTicks is kept as usd-ticks and is never converted to dollars', () => {
  const result = supported(decode('amore-build', amoreEnvelope({
    'grok-4.6': { inputTokens: 10, outputTokens: 2, cachedReadTokens: 0, cacheCreationTokens: 0, costUsdTicks: 1_250_000_000 },
  })));
  const record = result.records[0];
  assertContract(record);
  assert.deepEqual(record.sourceReportedCost, { state: 'known', amount: 1_250_000_000, unit: 'usd-ticks' });
  assert.notEqual(record.sourceReportedCost?.amount, 0.125);
});

test('amore missing prompt_id is identity-missing; empty modelUsage is unsupported', () => {
  const noPrompt = rejected(decode('amore-build', {
    timestamp: OBSERVED,
    params: { update: { sessionUpdate: 'turn_completed', usage: { modelUsage: { 'grok-4.6': { inputTokens: 1, outputTokens: 1 } } } } },
  }));
  assert.equal(noPrompt.code, SESSION_SOURCE_CODES.identityMissing);

  const empty = rejected(decode('amore-build', amoreEnvelope({})));
  assert.equal(empty.status, 'unsupported');
});

test('sourceId stays opaque source text and is not rewritten as a native id', () => {
  const result = supported(decode('claude-code', claudeEnvelope(
    { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } },
  )));
  assert.equal(result.records[0].identity.sourceId, 'msg_synthetic_claude_01');
  assert.match(result.records[0].identity.sourceId, /^msg_/);
  assertContract(result.records[0]);
});

test('an unparseable observedAt is observed-at-malformed, not an identity fault; a valid instant still works', () => {
  const bad = rejected(decode('claude-code', claudeEnvelope({ input_tokens: 1, output_tokens: 1 }), {
    context: { observedAt: 'yesterday' },
  }));
  assert.equal(bad.code, SESSION_SOURCE_CODES.observedAtMalformed);
  assert.notEqual(bad.code, SESSION_SOURCE_CODES.identityMalformed);

  const ok = supported(decode('claude-code', claudeEnvelope({
    input_tokens: 1,
    output_tokens: 1,
    cache_read_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
  })));
  assert.equal(ok.records[0].observedAt, OBSERVED);
});

test('a blank sessionEpoch is identity-malformed, not envelope-unusable; a real epoch still works', () => {
  const blank = rejected(decodeSessionUsage({
    harness: 'claude-code',
    sessionEpoch: ' ',
    envelope: claudeEnvelope({ input_tokens: 1, output_tokens: 1 }),
  }));
  assert.equal(blank.code, SESSION_SOURCE_CODES.identityMalformed);
  assert.notEqual(blank.code, SESSION_SOURCE_CODES.envelopeUnusable);

  const ok = supported(decode('claude-code', claudeEnvelope({
    input_tokens: 1,
    output_tokens: 1,
    cache_read_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
  })));
  assert.equal(ok.records[0].identity.sessionEpoch, EPOCH);
});

test('a blank model label is omitted, not a lost record; a nonempty label is kept', () => {
  const blank = supported(decode('claude-code', {
    timestamp: OBSERVED,
    message: {
      id: 'msg_synthetic_claude_01',
      model: ' ',
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      },
    },
  }));
  assert.equal(Object.hasOwn(blank.records[0], 'model'), false);
  assertContract(blank.records[0]);

  const kept = supported(decode('claude-code', claudeEnvelope({
    input_tokens: 1,
    output_tokens: 1,
    cache_read_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
  })));
  assert.equal(kept.records[0].model, 'claude-opus-4-6');
});

// --- Overlap: absent is a basis, malformed is an error, and neither is a manufactured claim ----

test('a malformed overlap is an error with a reason, never a relation', () => {
  // Each refusal beside the SAME envelope with a usable overlap, so the cell shows that the
  // malformed VALUE is refused and not that the field is unwelcome.
  const ok = supported(decode('claude-code', claudeEnvelope({ input_tokens: 40, output_tokens: 10 }), {
    context: { overlap: { relation: 'contained-in-parent', peerKey: 'parent-key' } },
  }));
  assert.deepEqual(ok.records[0].usage.overlap, { relation: 'contained-in-parent', peerKey: 'parent-key' });

  for (const bad of ['contained-in-parent', null, 7, true]) {
    const result = decode('claude-code', claudeEnvelope({ input_tokens: 40, output_tokens: 10 }), {
      context: { overlap: bad },
    });
    const refused = rejected(result);
    assert.equal(refused.code, SESSION_SOURCE_CODES.envelopeUnusable);
    assert.equal(refused.reason, 'type:overlap');
  }

  // An explicit unknown is a real answer and is carried, not treated as malformed.
  const unknown = supported(decode('claude-code', claudeEnvelope({ input_tokens: 40, output_tokens: 10 }), {
    context: { overlap: { relation: 'unknown' } },
  }));
  assert.deepEqual(unknown.records[0].usage.overlap, { relation: 'unknown' });
});

test('an ABSENT overlap is none only where the harness has a written basis', () => {
  // none is a positive claim a ledger sums on, so each of these rests on the source's structure,
  // documented in OVERLAP_BASIS and in docs/session-sources.md.
  const cases = [
    ['claude-code', claudeEnvelope({ input_tokens: 40, output_tokens: 10 }), {}],
    ['omp', ompEnvelope({ input_tokens: 40, output_tokens: 10 }), {}],
    // Codex carries no request id of its own, so the caller supplies the opaque source id.
    ['codex', codexEnvelope({ input_tokens: 40, output_tokens: 10 }, { input_tokens: 40, output_tokens: 10 }),
      { sourceId: 'rollout:offset:12' }],
    ['amore-build', amoreEnvelope({ 'grok-a': { input_tokens: 40, output_tokens: 10 } }), {}],
  ];
  for (const [harness, envelope, ctx] of cases) {
    const result = supported(decode(/** @type {string} */ (harness), envelope,
      { context: /** @type {Record<string, unknown>} */ (ctx) }));
    for (const record of result.records) {
      assert.deepEqual(record.usage.overlap, { relation: 'none' }, `${harness} states none on its basis`);
    }
  }
});

test('a harness with no written basis gets unknown, not an inherited none', () => {
  // The structural guarantee, fired rather than asserted in prose: adding a harness to
  // SESSION_SOURCE_HARNESSES without an OVERLAP_BASIS entry must not silently inherit `none`.
  assert.deepEqual(resolveOverlap({}, 'a-future-harness'), { overlap: { relation: 'unknown' } });
  // The twin: a listed harness still gets none, so the default did not swallow the basis.
  assert.deepEqual(resolveOverlap({}, 'codex'), { overlap: { relation: 'none' } });
  // And every shipped harness carries a basis, so today none of them takes the unknown branch.
  for (const harness of SESSION_SOURCE_HARNESSES) {
    assert.ok(Object.hasOwn(OVERLAP_BASIS, harness), `${harness} needs a written overlap basis`);
  }
  // A present overlap still wins over the basis, in both directions.
  assert.deepEqual(resolveOverlap({ overlap: { relation: 'unknown' } }, 'codex'), { overlap: { relation: 'unknown' } });
  assert.deepEqual(resolveOverlap({ overlap: 'nope' }, 'codex'), { malformed: 'type:overlap' });
});
