// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  shadowReplay, validateBillingContexts, billingContextFor, residentContextOf, readShadowArgs,
  sessionsFromEntries, CLASSIFY_ASSUMPTION, ShadowInputError,
} from '../src/economy/shadow.mjs';
import {
  addCosts, scaleCost, leastFavourableRatio, arrivalWithinTtl, validateEnvelope, tariffFromRow,
  prefixReadCost, BaselineInputError,
} from '../src/economy/baselines.mjs';
import { closeSessionLedger, commitLedgerEvent, openSessionLedger } from '../src/usage/session-ledger.mjs';

const bin = fileURLToPath(new URL('../bin/agora.mjs', import.meta.url));
const T0 = Date.parse('2026-09-01T00:00:00.000Z');
/** @param {number} m */
const iso = (m) => new Date(m).toISOString();
const DAY = 86_400_000;
const SPLIT = iso(T0 + 10 * DAY);
const CUTOFF = iso(T0 + 20 * DAY);
const AS_OF = '2026-09-07T00:00:00.000Z';

/** @param {number} v */
const known = (v) => ({ state: 'known', value: v, unit: 'tokens' });
const KEY = { provider: 'anthropic', endpoint: 'messages', modelRevision: 'model-x', serviceTier: 'default', region: 'global', billingMode: 'api' };
/** Dated, sourced, qualified: the fixture's tariff is a row the table would admit outside tests. */
const ROW = {
  ...KEY, effective: '2026-08-01T00:00:00.000Z', contextBracketMin: 0, contextBracketMax: 1_000_000,
  source: 'fixture://tariff', retrieved: '2026-09-07T00:00:00.000Z', qualification: 'qualified',
  publishedApi: { 'uncached-input': { usdPerMillion: 5 }, 'cached-input': { usdPerMillion: 0.5 }, 'cache-write-5m': { usdPerMillion: 6.25 }, output: { usdPerMillion: 25 } },
};
const RATES = { version: 1, rows: [ROW] };
/** @type {any} */
const BILLING = {
  version: 1, retrieved: AS_OF,
  harnesses: { 'claude-code': Object.fromEntries(['provider', 'endpoint', 'serviceTier', 'region', 'billingMode'].map((f) => [f, { state: 'known', value: /** @type {any} */ (KEY)[f], source: 'fixture' }])) },
};
const ENVELOPE = {
  summaryTokens: { value: 10_000, source: 'fixture' }, postCompactionTokens: { value: 100_000, source: 'fixture' },
  recoveryTokens: { value: 5_000, source: 'fixture' }, pingTokens: { value: 20, source: 'fixture' }, cacheTtlSeconds: { value: 300, source: 'fixture' },
};

/**
 * A ledger `entries` object. `sessions` is a list of { epoch, calls, start, prefix?, gapMs?, model?, status? }.
 * @param {Array<{ epoch: string, calls: number, start: number, prefix?: number, gapMs?: number, model?: string | null, status?: string, harness?: string, components?: Record<string, any>, coverage?: string }>} sessions
 */
function ledgerOf(sessions) {
  /** @type {Record<string, any>} */
  const entries = {};
  let n = 0;
  for (const s of sessions) {
    for (let i = 0; i < s.calls; i++) {
      const key = `k${n++}`;
      const prefix = s.prefix ?? 200_000;
      entries[key] = {
        identity: { harness: s.harness ?? 'claude-code', sessionEpoch: s.epoch, sourceId: `r${n}`, sourceUnit: 'request', finality: 'final' },
        observedAt: iso(s.start + i * (s.gapMs ?? 60_000)), status: s.status ?? 'confirmed', digest: `sha256:${n}`,
        ...(s.model === null ? {} : { model: s.model ?? 'model-x' }),
        usage: {
          components: s.components ?? { 'uncached-input': known(10), 'cached-input': known(prefix), 'cache-write-5m': known(0), 'cache-write-1h': known(0), 'cache-write-unknown-ttl': known(0), output: known(500) },
          coverage: s.coverage ?? 'complete',
        },
      };
    }
  }
  return entries;
}

/** 40 fit sessions before the split, 12 eval after, `calls` calls each unless a function is given. */
/** @param {number | ((i: number) => number)} calls @param {Record<string, any>} [extra] */
function cohort(calls, extra = {}) {
  const c = typeof calls === 'function' ? calls : () => calls;
  const sessions = [];
  for (let i = 0; i < 40; i++) sessions.push({ epoch: `f${i}`, calls: c(i), start: T0 + i * 3_600_000, ...extra });
  for (let i = 0; i < 12; i++) sessions.push({ epoch: `e${i}`, calls: c(i), start: T0 + 11 * DAY + i * 3_600_000, ...extra });
  return sessions;
}

/** @param {Record<string, any>} entries @param {Record<string, any>} [o] @returns {any} */
function replay(entries, o = {}) {
  return shadowReplay({
    entries, rateTable: RATES, billingContexts: BILLING, envelope: ENVELOPE,
    epsilon: 0.1, riskBudget: 0.1, verificationUsd: 0.05, asOf: AS_OF,
    observationCutoff: CUTOFF, splitAt: SPLIT, endedAfterSeconds: 3600,
    prefixReuse: { value: 1, source: 'fixture' },
    ...o,
  });
}

// --- Shadow, unconditionally --------------------------------------------------------------------

test('every output carries shadow: true and actuationAllowed: false; horizonEligible is copied from E2b, not recomputed', () => {
  const r = replay(ledgerOf(cohort((i) => 2 + (i % 8))));
  assert.equal(r.shadow, true);
  assert.equal(r.actuationAllowed, false);
  const s = r.sessions.find((/** @type {any} */ x) => x.sessionKey === 'claude-code/e3');
  assert.ok(s && s.marker === 'assessed');
  assert.equal(s.shadow, true);
  assert.equal(s.actuationAllowed, false);
  for (const d of s.decisions) {
    assert.equal(d.shadow, true);
    assert.equal(d.actuationAllowed, false);
    assert.equal(d.horizon.actuationAllowed, false);
    assert.equal(d.horizon.actuationReason, 'e2-shadow');
    assert.equal(typeof d.horizon.horizonEligible, 'boolean');
  }
  // The session's horizonEligible is the last decision's horizon field, verbatim.
  assert.equal(s.horizonEligible, s.decisions[s.decisions.length - 1].horizon.horizonEligible);
  // The classify assumption travels on every horizon line.
  for (const d of s.decisions) assert.deepEqual(d.horizon.assumptions[0], { classify: 'all-requests-useful', assumption: CLASSIFY_ASSUMPTION });
});

test('a calibrated horizon with an unknown rate yields no ratio and no crossing: rates.json with no rows prices nothing', () => {
  const r = replay(ledgerOf(cohort((i) => 2 + (i % 8))), { rateTable: { version: 1, rows: [] } });
  const s = r.sessions.find((/** @type {any} */ x) => x.sessionKey === 'claude-code/e3');
  assert.ok(s && s.marker === 'assessed');
  assert.equal(s.pricing.priced, 0);
  assert.equal(s.pricing.unpriced['no-matching-rate'], s.calls);
  for (const d of s.decisions) {
    assert.equal(d.ratio.least, null);
    assert.equal(d.crossing, null);
    assert.equal(d.verdict, 'shadow-only');
    assert.ok(d.reasons.includes('rate-classification-unknown:no-matching-rate'));
    assert.equal(d.trajectories.continue.cost.state, 'unknown');
  }
  assert.equal(s.baselines.neverCompact.cost.state, 'unknown');
});

test('an unknown envelope dimension is refused, never defaulted', () => {
  const { recoveryTokens, ...missing } = ENVELOPE;
  assert.throws(() => replay(ledgerOf(cohort(3)), { envelope: missing }), (e) => e instanceof BaselineInputError && e.code === 'envelope-dimension-missing' && e.field === 'recoveryTokens');
  assert.throws(() => validateEnvelope({ ...ENVELOPE, prefixReuse: { value: 1, source: 'x' } }), (e) => e instanceof BaselineInputError && e.code === 'envelope-prefix-reuse-not-in-e2');
  assert.throws(() => validateEnvelope({ ...ENVELOPE, summaryTokens: { value: 10 } }), (e) => e instanceof BaselineInputError && e.code === 'envelope-source');
});

test('an uncalibrated horizon (drift) yields shadow-only recommendations and no ratio verdict', () => {
  // Fit sessions make 3 calls; eval sessions make 12: a real length shift, the drift stop fires.
  const sessions = [];
  for (let i = 0; i < 40; i++) sessions.push({ epoch: `f${i}`, calls: 3, start: T0 + i * 3_600_000 });
  for (let i = 0; i < 12; i++) sessions.push({ epoch: `e${i}`, calls: 12, start: T0 + 11 * DAY + i * 3_600_000 });
  const r = replay(ledgerOf(sessions));
  const s = r.sessions.find((/** @type {any} */ x) => x.sessionKey === 'claude-code/e0');
  assert.ok(s && s.marker === 'assessed');
  assert.equal(s.horizonEligible, false);
  for (const d of s.decisions) {
    assert.equal(d.horizon.status, 'estimated');
    assert.equal(d.ratio.least, null);
    assert.equal(d.verdict, 'shadow-only');
    assert.ok(d.reasons.includes('horizon-not-eligible'));
  }
});

// --- The forward model ----------------------------------------------------------------------------

test('a session ending now is not compacted because it is large: zero remaining calls, K still paid, no crossing', () => {
  // Every session makes exactly one call and ends: p10 remaining after the first call is 0.
  const r = replay(ledgerOf(cohort(1, { prefix: 900_000 })));
  const s = r.sessions.find((/** @type {any} */ x) => x.sessionKey === 'claude-code/e0');
  assert.ok(s && s.marker === 'assessed');
  const d = s.decisions[0];
  assert.equal(d.horizon.remainingCalls.p10, 0);
  assert.equal(d.trajectories.continue.cost.state, 'known');
  assert.equal(d.trajectories.continue.cost.usd, 0);
  assert.equal(d.trajectories.compactCold.cost.state, 'known');
  assert.ok(d.trajectories.compactCold.cost.usd > 0.05, 'K is paid even with nothing ahead');
  assert.equal(d.trajectories.compactCold.K.verification.usd, 0.05);
  assert.equal(d.verdict, 'no-crossing');
  assert.equal(d.crossing, false);
});

test('verification cost is required, refused negative, zero only as the explicit literal and labelled explicit-zero, applied at zero future calls', () => {
  assert.throws(() => replay(ledgerOf(cohort(1)), { verificationUsd: -1 }), (e) => e instanceof ShadowInputError && e.code === 'verification-cost');
  assert.throws(() => replay(ledgerOf(cohort(1)), { verificationUsd: Number.NaN }), (e) => e instanceof ShadowInputError && e.code === 'verification-cost');
  const r = replay(ledgerOf(cohort(1)), { verificationUsd: 0 });
  assert.equal(r.inputs.verification.label, 'explicit-zero');
  const s = r.sessions.find((/** @type {any} */ x) => x.sessionKey === 'claude-code/e0');
  assert.ok(s && s.marker === 'assessed');
  const d = s.decisions[0];
  assert.equal(d.verification.label, 'explicit-zero');
  assert.equal(d.trajectories.compactCold.K.verificationLabel, 'explicit-zero');
  assert.equal(d.trajectories.compactCold.K.verification.usd, 0);
  // With a real verification charge the same decision's K is higher by exactly that charge.
  const r2 = replay(ledgerOf(cohort(1)), { verificationUsd: 0.25 });
  const d2 = r2.sessions.find((/** @type {any} */ x) => x.sessionKey === 'claude-code/e0').decisions[0];
  assert.equal(d2.verification.label, 'explicit');
  assert.ok(Math.abs(d2.trajectories.compactCold.K.total.usd - d.trajectories.compactCold.K.total.usd - 0.25) < 1e-9);
});

test('a warm-then-compact sequence is compared as a whole and never beats cold compaction at non-negative rates', () => {
  const r = replay(ledgerOf(cohort((i) => 2 + (i % 8))));
  for (const s of r.sessions) {
    if (s.marker !== 'assessed') continue;
    for (const d of s.decisions) {
      const cold = d.trajectories.compactCold.cost;
      const warm = d.trajectories.compactWarm.cost;
      assert.equal(cold.state, 'known');
      assert.equal(warm.state, 'known');
      assert.ok(warm.usd >= cold.usd, `${s.sessionKey} k=${d.callsSoFar}: warm ${warm.usd} < cold ${cold.usd}`);
      assert.equal(d.trajectories.compactWarm.warmingPing.prefixRead.state, 'known');
    }
  }
});

test('crossing or no crossing is reported from dated sourced tariffs with stated assumptions, never tuned to a call count', () => {
  // Long sessions: 40 remaining is plenty for a 200K prefix to pay back a 100K post-compaction rebuild.
  const long = replay(ledgerOf(cohort(50)), { riskBudget: 0.5 });
  const sl = long.sessions.find((/** @type {any} */ x) => x.sessionKey === 'claude-code/e0');
  assert.ok(sl && sl.marker === 'assessed');
  const dl = sl.decisions[0];
  assert.equal(dl.ratio.epsilon, 0.1);
  assert.equal(dl.ratio.threshold, 1.1);
  assert.equal(dl.verdict, 'crossing');
  // The ratio is exactly continue / compact from the row's rates and the envelope, no hidden term.
  const H = dl.horizon.remainingCalls.p50;
  const P = 200_010;
  const cont = H * (P / 1e6) * 0.5;
  const K = (P / 1e6) * 5 + (10_000 / 1e6) * 25 + (100_000 / 1e6) * 6.25 + 0.05 + (5_000 / 1e6) * 5;
  const compact = K + H * (100_000 / 1e6) * 0.5;
  assert.ok(Math.abs(dl.ratio.least - cont / compact) < 1e-9, `${dl.ratio.least} vs ${cont / compact}`);
  // Short sessions, same tariff, same envelope, same margin: no crossing. The sign came from the
  // horizon and the tariff, not from a call count written into the test.
  const short = replay(ledgerOf(cohort(2)), { riskBudget: 0.5 });
  const ds = short.sessions.find((/** @type {any} */ x) => x.sessionKey === 'claude-code/e0').decisions[0];
  assert.equal(ds.verdict, 'no-crossing');
  assert.equal(ds.crossing, false);
  // Both are shadow: true whatever they report.
  assert.equal(dl.shadow, true);
  assert.equal(ds.shadow, true);
  // The tariff's row is printed whole on the decision so the reader sees which rates produced it.
  assert.equal(dl.tariff.row.source, 'fixture://tariff');
  assert.equal(dl.tariff.row.effective, ROW.effective);
});

test('without an assumed prefix reuse (real data) every future read is an interval and the ratio is null with the reason', () => {
  const r = replay(ledgerOf(cohort((i) => 2 + (i % 8))), { prefixReuse: null });
  const s = r.sessions.find((/** @type {any} */ x) => x.sessionKey === 'claude-code/e3');
  assert.ok(s && s.marker === 'assessed');
  assert.equal(r.inputs.prefixReuse, null);
  for (const d of s.decisions) {
    assert.equal(d.envelope.prefixReuse, 'unassessable');
    assert.equal(d.trajectories.continue.cost.state, 'interval');
    assert.equal(d.trajectories.continue.cost.reason, 'prefix-reuse-unassessable');
    assert.equal(d.ratio.least, null);
    assert.equal(d.ratio.reason, 'envelope-unassessable:prefix-reuse');
    assert.equal(d.verdict, 'shadow-only');
    assert.equal(d.crossing, null);
  }
});

test('a decision point before the split is leakage and shadow-only even with a calibrated horizon', () => {
  const r = replay(ledgerOf(cohort((i) => 2 + (i % 8))));
  const s = r.sessions.find((/** @type {any} */ x) => x.sessionKey === 'claude-code/f3');
  assert.ok(s && s.marker === 'assessed');
  for (const d of s.decisions) {
    assert.equal(d.horizon.leakage, 'leakage-before-split');
    assert.equal(d.envelope.horizon, 'unknown');
    assert.equal(d.verdict, 'shadow-only');
    assert.equal(d.ratio.least, null);
  }
});

test('--classify unknown yields a horizon unknown by construction; the default carries the assumption', () => {
  const r = replay(ledgerOf(cohort((i) => 2 + (i % 8))), { classify: 'unknown' });
  const s = r.sessions.find((/** @type {any} */ x) => x.sessionKey === 'claude-code/e3');
  assert.ok(s && s.marker === 'assessed');
  for (const d of s.decisions) {
    assert.equal(d.horizon.status, 'unknown');
    assert.ok(d.horizon.unclassifiedSessions >= 52);
    assert.deepEqual(d.horizon.assumptions[0], { classify: 'unknown', assumption: null });
    assert.equal(d.verdict, 'shadow-only');
  }
  assert.throws(() => replay(ledgerOf(cohort(1)), { classify: 'everything-useful' }), (e) => e instanceof ShadowInputError && e.code === 'classify-rule');
});

test('the session-end rule travels on every horizon line; without it every session is right-censored and stopping is unavailable', () => {
  const r = replay(ledgerOf(cohort((i) => 2 + (i % 8))), { endedAfterSeconds: null });
  const s = r.sessions.find((/** @type {any} */ x) => x.sessionKey === 'claude-code/e3');
  assert.ok(s && s.marker === 'assessed');
  const d = s.decisions[0];
  assert.deepEqual(d.horizon.assumptions[1], { sessionEnd: 'no-end-evidence-every-session-right-censored' });
  assert.ok(typeof d.horizon.stoppingUnavailable === 'string');
  assert.equal(d.horizon.remainingCalls, undefined);
  assert.equal(d.ratio.least, null);
  assert.ok(d.reasons.includes('horizon-stopping-unavailable'));
  assert.equal(d.trajectories.continue.cost.state, 'unknown');
  assert.equal(d.trajectories.continue.cost.reason, 'horizon-unknown');
  const r2 = replay(ledgerOf(cohort(3)));
  const d2 = r2.sessions.find((/** @type {any} */ x) => x.sessionKey === 'claude-code/e3').decisions[0];
  assert.deepEqual(d2.horizon.assumptions[1], { sessionEnd: 'quiet-past-3600s-means-ended-at-last-request' });
});

// --- The omission twin: sessions that vanish without a marker -------------------------------------

test('a Codex session (cumulative snapshots only) is unassessable with the reason and still listed with its totals; a reset snapshot is confirmed, one without reset provisional', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agora-shadow-'));
  const ledger = await openSessionLedger({ root, limits: { maxBytes: 1_000_000, maxEntries: 100 } });
  /** @param {string} id @param {number} out */
  const snap = (id, out) => ({
    identity: { harness: 'codex', sessionEpoch: 'cx', sourceId: id, sourceUnit: 'cumulative-snapshot', finality: 'unknown' },
    observedAt: iso(T0 + 12 * DAY), usage: { components: { output: known(out) }, coverage: 'partial' },
  });
  await commitLedgerEvent(ledger, { record: snap('s1', 100), ingest: { locator: 'f', sourceGeneration: 1, offset: 1, fingerprint: 'fp:1' }, reset: true });
  await commitLedgerEvent(ledger, { record: snap('s2', 150), ingest: { locator: 'f', sourceGeneration: 1, offset: 2, fingerprint: 'fp:2' } });
  /** @type {Record<string, any>} */
  const entries = structuredClone(ledger.state.entries);
  await closeSessionLedger(ledger);
  assert.equal(entries[Object.keys(entries)[0]].status, 'confirmed', 'a Codex snapshot with reset lands confirmed');
  assert.equal(entries[Object.keys(entries)[1]].status, 'provisional', 'a Codex snapshot without reset lands provisional');
  const all = { ...entries, ...ledgerOf(cohort((i) => 2 + (i % 8))) };
  const r = replay(all, { billingContexts: { ...BILLING, harnesses: { ...BILLING.harnesses, codex: Object.fromEntries(['provider', 'endpoint', 'serviceTier', 'region', 'billingMode'].map((f) => [f, { state: 'unknown', reason: 'fixture' }])) } } });
  const cx = r.sessions.find((/** @type {any} */ x) => x.sessionKey === 'codex/cx');
  assert.ok(cx, 'the Codex session is listed, not silently absent');
  assert.equal(cx.marker, 'unassessable');
  assert.equal(cx.reason, 'no-request-unit-entries');
  assert.equal(cx.entryCount, 2);
  assert.equal(cx.calls, 0);
  assert.equal(cx.decisions.length, 0);
  assert.equal(cx.shadow, true);
  assert.equal(cx.actuationAllowed, false);
  // Both halves of the Codex-reset clause are visible in the totals.
  assert.equal(cx.totals.snapshot.confirmed.output.value, 100);
  assert.equal(cx.totals.snapshot.provisional.length, 1);
  assert.equal(cx.totals.snapshot.provisional[0].components.output.value, 150);
  assert.equal(r.skippedNonRequest, 0, 'non-request entries never reach historiesFromLedger');
});

test('a session with a pre-retention row (no observedAt) is unclassified, named, and never counted as a cadence', () => {
  const entries = ledgerOf(cohort((i) => 2 + (i % 8)));
  entries.legacy = {
    identity: { harness: 'claude-code', sessionEpoch: 'e3', sourceId: 'old', sourceUnit: 'request', finality: 'final' },
    status: 'confirmed', digest: 'sha256:old',
    usage: { components: { output: known(1) }, coverage: 'partial' },
  };
  const r = replay(entries);
  const s = r.sessions.find((/** @type {any} */ x) => x.sessionKey === 'claude-code/e3');
  assert.equal(s.marker, 'unclassified');
  assert.equal(s.reason, 'observed-at-absent');
  assert.deepEqual(s.untimedEntries, ['legacy']);
  assert.equal(s.decisions.length, 0);
  // And the horizon excluded that session rather than fitting a one-row cadence from it.
  const other = r.sessions.find((/** @type {any} */ x) => x.sessionKey === 'claude-code/e4');
  assert.ok(other.decisions[0].horizon.unclassifiedSessions >= 1);
});

// --- The silent-number enumeration, one cell each -------------------------------------------------

test('(a) a null next-arrival quantile leaves the arrival probability and the ping trajectory unknown, never 0', () => {
  assert.deepEqual(arrivalWithinTtl({ p10: null, p50: null, p90: null }, 300), { state: 'unknown', reason: 'next-arrival-quantile-null' });
  assert.deepEqual(arrivalWithinTtl(undefined, 300), { state: 'unknown', reason: 'next-arrival-absent' });
  // One call per session: a fit with no gaps at all.
  const r = replay(ledgerOf(cohort(1)));
  const d = r.sessions.find((/** @type {any} */ x) => x.sessionKey === 'claude-code/e0').decisions[0];
  assert.equal(d.horizon.nextArrivalSeconds.p50, null);
  assert.equal(d.trajectories.ping.pingsPerCall, null);
  assert.equal(d.trajectories.ping.cost.state, 'unknown');
  assert.equal(d.trajectories.ping.cost.reason, 'next-arrival-p50-null');
  assert.equal(d.trajectories.ping.arrivalWithinTtl.state, 'unknown');
});

test('(b) an absent remaining-calls quantile leaves the savings and ratio null: never NaN, never a false no-crossing', () => {
  const r = replay(ledgerOf(cohort((i) => 2 + (i % 8))), { endedAfterSeconds: null });
  const d = r.sessions.find((/** @type {any} */ x) => x.sessionKey === 'claude-code/e3').decisions[0];
  assert.equal(d.ratio.least, null);
  assert.equal(d.crossing, null);
  assert.notEqual(d.verdict, 'no-crossing');
  assert.equal(JSON.stringify(d).includes('NaN'), false);
  assert.deepEqual(leastFavourableRatio({ state: 'unknown', reason: 'x' }, { state: 'known', usd: 1 }, 0.1), { least: null, reason: 'continue-cost-unknown' });
  assert.deepEqual(leastFavourableRatio({ state: 'known', usd: 1 }, { state: 'unknown', reason: 'x' }, 0.1), { least: null, reason: 'compact-cost-unknown' });
  assert.deepEqual(leastFavourableRatio({ state: 'known', usd: 1 }, { state: 'interval', low: 1, high: 2, reason: 'i' }, 0.1), { least: null, reason: 'compact-cost-interval' });
  assert.deepEqual(leastFavourableRatio({ state: 'known', usd: 1 }, { state: 'known', usd: 0 }, 0.1), { least: null, reason: 'compact-cost-not-positive' });
});

test('(c) a partial-coverage request makes its trajectory a lower bound with the unpriced tokens beside it, never a known total', () => {
  const noOutputRate = { ...ROW, publishedApi: { 'uncached-input': { usdPerMillion: 5 }, 'cached-input': { usdPerMillion: 0.5 }, 'cache-write-5m': { usdPerMillion: 6.25 } } };
  const r = replay(ledgerOf(cohort((i) => 2 + (i % 8))), { rateTable: { version: 1, rows: [noOutputRate] } });
  const s = r.sessions.find((/** @type {any} */ x) => x.sessionKey === 'claude-code/e3');
  assert.equal(s.pricing.priced, s.calls);
  for (const d of s.decisions) {
    assert.equal(d.requestCost.state, 'lower-bound');
    assert.equal(d.requestCost.unpriced.output, 500);
  }
  assert.equal(s.baselines.neverCompact.cost.state, 'lower-bound');
  assert.equal(s.baselines.neverCompact.cost.unpriced.output, 500 * s.calls);
  // A component measured at ZERO tokens with no rate costs exactly nothing and does not lower a total.
  const r2 = replay(ledgerOf(cohort(3)));
  const s2 = r2.sessions.find((/** @type {any} */ x) => x.sessionKey === 'claude-code/e3');
  assert.equal(s2.baselines.neverCompact.cost.state, 'known');
  // addCosts keeps the bound and the unknowns.
  const sum = /** @type {any} */ (addCosts({ state: 'known', usd: 1 }, { state: 'lower-bound', usd: 2, unpriced: { output: 5 } }, { state: 'lower-bound', usd: 1, unpriced: { output: 'unknown' } }));
  assert.deepEqual(sum, { state: 'lower-bound', usd: 4, unpriced: { output: 'unknown' } });
  assert.deepEqual(addCosts({ state: 'known', usd: 1 }, { state: 'unknown', reason: 'r' }), { state: 'unknown', reason: 'r' });
  assert.deepEqual(scaleCost({ state: 'unknown', reason: 'r' }, 3), { state: 'unknown', reason: 'r' });
  assert.deepEqual(scaleCost({ state: 'interval', low: 1, high: 2, reason: 'i' }, 3), { state: 'interval', low: 3, high: 6, reason: 'i' });
});

test('(d) a zero usdPerMillion is admitted by E2a and named on the decision so a free rate is not read as a missing one', () => {
  const freeCache = { ...ROW, publishedApi: { ...ROW.publishedApi, 'cached-input': { usdPerMillion: 0 } } };
  const r = replay(ledgerOf(cohort(3)), { rateTable: { version: 1, rows: [freeCache] } });
  const s = r.sessions.find((/** @type {any} */ x) => x.sessionKey === 'claude-code/e3');
  assert.deepEqual(s.zeroRateComponents, { 'cached-input': 3 });
  assert.deepEqual(s.decisions[0].tariff.zeroRateComponents, ['cached-input']);
  assert.equal(s.decisions[0].tariff.row.publishedApi['cached-input'].usdPerMillion, 0);
  assert.deepEqual(tariffFromRow(null), { zeroRateComponents: [], rowEffective: null });
  assert.equal(prefixReadCost(tariffFromRow(null), 10).state, 'unknown');
});

test('(e) explicit-zero verification is labelled on every line that rests on it', () => {
  const r = replay(ledgerOf(cohort(3)), { verificationUsd: 0 });
  const s = r.sessions.find((/** @type {any} */ x) => x.sessionKey === 'claude-code/e3');
  for (const d of s.decisions) {
    assert.equal(d.verification.label, 'explicit-zero');
    assert.equal(d.envelope.verification, 'explicit-zero');
    assert.equal(d.trajectories.compactWarm.K.verificationLabel, 'explicit-zero');
  }
});

test('(f) a conflict or gap entry counts as a call for cadence and is unpriced with its status, never priced and never dropped', () => {
  const entries = ledgerOf(cohort((i) => 2 + (i % 8)));
  const k = /** @type {string} */ (Object.keys(entries).find((key) => entries[key].identity.sessionEpoch === 'e3'));
  entries[k].status = 'conflict';
  entries[k].reason = 'ordering-unproven';
  const r = replay(entries);
  const s = r.sessions.find((/** @type {any} */ x) => x.sessionKey === 'claude-code/e3');
  assert.equal(s.calls, 5);
  assert.equal(s.decisions.length, 5);
  assert.equal(s.pricing.unpriced['status-conflict'], 1);
  assert.equal(s.pricing.priced, 4);
  const d = s.decisions.find((/** @type {any} */ x) => x.entryKey === k);
  assert.equal(d.entryStatus, 'conflict');
  assert.equal(d.requestCost.state, 'unknown');
  assert.equal(d.requestCost.reason, 'status-conflict');
  assert.equal(d.verdict, 'shadow-only');
  assert.ok(d.reasons.includes('rate-classification-unknown:status-conflict'));
  // A provisional entry is priced and labelled.
  const entries2 = ledgerOf(cohort((i) => 2 + (i % 8)));
  const k2 = /** @type {string} */ (Object.keys(entries2).find((key) => entries2[key].identity.sessionEpoch === 'e3'));
  entries2[k2].status = 'provisional';
  const s2 = replay(entries2).sessions.find((/** @type {any} */ x) => x.sessionKey === 'claude-code/e3');
  assert.equal(s2.pricing.provisional, 1);
  assert.equal(s2.pricing.priced, 4);
});

// --- Inputs ---------------------------------------------------------------------------------------

test('billing contexts: a known field needs a source, modelRevision is per record not per harness, an unnamed harness prices nothing', () => {
  const ok = validateBillingContexts(BILLING);
  /** @param {any} x */
  const ctx = (x) => /** @type {any} */ (x);
  assert.equal(ok.harnesses['claude-code'].provider.state, 'known');
  const noSource = structuredClone(BILLING);
  delete noSource.harnesses['claude-code'].region.source;
  assert.throws(() => validateBillingContexts(noSource), (e) => e instanceof ShadowInputError && e.code === 'billing-contexts-known-without-source');
  const withModel = structuredClone(BILLING);
  withModel.harnesses['claude-code'].modelRevision = { state: 'known', value: 'x', source: 's' };
  assert.throws(() => validateBillingContexts(withModel), (e) => e instanceof ShadowInputError && e.code === 'billing-contexts-model-revision-is-per-record');
  const noReason = structuredClone(BILLING);
  noReason.harnesses['claude-code'].region = { state: 'unknown' };
  assert.throws(() => validateBillingContexts(noReason), (e) => e instanceof ShadowInputError && e.code === 'billing-contexts-unknown-without-reason');
  assert.deepEqual(ctx(billingContextFor(ok, 'claude-code', 'model-x')).modelRevision, { state: 'known', value: 'model-x' });
  assert.deepEqual(ctx(billingContextFor(ok, 'claude-code', undefined)).modelRevision, { state: 'unknown' });
  assert.deepEqual(ctx(billingContextFor(ok, 'omp', 'model-x')).provider, { state: 'unknown' });
  // A record with no retained model prices nothing: the revision is the key, not the label.
  const r = replay(ledgerOf(cohort(3, { model: null })));
  const s = r.sessions.find((/** @type {any} */ x) => x.sessionKey === 'claude-code/e3');
  assert.equal(s.pricing.unpriced['billing-context-unknown'], 3);
});

test('resident context is the sum of the five input pools when all are known; an absent or unknown pool leaves it unknown', () => {
  /** @param {Record<string, any>} components */
  const rec = (components) => ({ usage: { components } });
  assert.deepEqual(residentContextOf(rec({ 'uncached-input': known(1), 'cached-input': known(2), 'cache-write-5m': known(3), 'cache-write-1h': known(4), 'cache-write-unknown-ttl': known(5), output: known(99) })), { state: 'known', tokens: 15, basis: 'sum-of-input-pools' });
  assert.deepEqual(residentContextOf(rec({ 'uncached-input': known(1), 'cached-input': known(2), 'cache-write-5m': known(3), 'cache-write-1h': { state: 'not-applicable' }, 'cache-write-unknown-ttl': known(5) })), { state: 'known', tokens: 11, basis: 'sum-of-input-pools' });
  assert.deepEqual(residentContextOf(rec({ 'uncached-input': known(1), 'cached-input': known(2), 'cache-write-5m': known(3), 'cache-write-1h': { state: 'unknown' }, 'cache-write-unknown-ttl': known(5) })), { state: 'unknown', reason: 'pool-unknown:cache-write-1h' });
  assert.deepEqual(residentContextOf(rec({ 'uncached-input': known(1) })), { state: 'unknown', reason: 'pool-absent:cached-input' });
  // The writes are one measurement in one of two forms (the adapter's split, or its pooled bucket): either form sums; neither is unknown.
  assert.deepEqual(residentContextOf(rec({ 'uncached-input': known(2), 'cached-input': known(26055), 'cache-write-5m': known(0), 'cache-write-1h': known(49761), output: known(130) })), { state: 'known', tokens: 75818, basis: 'sum-of-input-pools' });
  assert.deepEqual(residentContextOf(rec({ 'uncached-input': known(2), 'cached-input': known(3), 'cache-write-unknown-ttl': known(4) })), { state: 'known', tokens: 9, basis: 'sum-of-input-pools' });
  assert.deepEqual(residentContextOf(rec({ 'uncached-input': known(2), 'cached-input': known(3), output: known(1) })), { state: 'unknown', reason: 'pool-absent:cache-write' });
  assert.deepEqual(residentContextOf(rec({ 'uncached-input': known(2), 'cached-input': known(3), 'cache-write-5m': known(1), 'cache-write-1h': { state: 'invalid' } })), { state: 'unknown', reason: 'pool-invalid:cache-write-1h' });
  // Through the replay: an unknown pool leaves the request unpriced (context-unmeasured) and every trajectory unknown.
  const r = replay(ledgerOf(cohort(3, { components: { 'uncached-input': known(10), 'cached-input': known(1000), 'cache-write-5m': { state: 'unknown', reason: 'fixture' }, 'cache-write-1h': known(0), 'cache-write-unknown-ttl': known(0), output: known(5) }, coverage: 'partial' })));
  const s = r.sessions.find((/** @type {any} */ x) => x.sessionKey === 'claude-code/e3');
  assert.equal(s.pricing.unpriced['context-unmeasured'], 3);
  assert.equal(s.decisions[0].residentContext.state, 'unknown');
  assert.equal(s.decisions[0].trajectories.continue.cost.reason, 'resident-context-unknown');
});

test('risk budget is one of the three quantiles E2b exposes and selects which one the conservative scenario reads', () => {
  assert.throws(() => replay(ledgerOf(cohort(1)), { riskBudget: 0.2 }), (e) => e instanceof ShadowInputError && e.code === 'risk-budget');
  const r = replay(ledgerOf(cohort((i) => 2 + (i % 8))), { riskBudget: 0.9 });
  assert.equal(r.inputs.quantile, 'p90');
  assert.equal(r.sessions.find((/** @type {any} */ x) => x.sessionKey === 'claude-code/e3').decisions[0].horizon.quantile, 'p90');
});

test('a session filter replays one session against the whole cohort; an unknown one is refused', () => {
  const r = replay(ledgerOf(cohort((i) => 2 + (i % 8))), { sessionFilter: 'claude-code/e3' });
  assert.equal(r.sessions.length, 1);
  assert.equal(r.sessions[0].decisions[0].horizon.comparableSessions, 52);
  assert.throws(() => replay(ledgerOf(cohort(1)), { sessionFilter: 'claude-code/nope' }), (e) => e instanceof ShadowInputError && e.code === 'session-not-in-ledger');
  assert.equal(sessionsFromEntries(ledgerOf(cohort(2))).length, 52);
});

// --- The verb --------------------------------------------------------------------------------------

/** @param {string[]} args @param {NodeJS.ProcessEnv} env */
function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], {
      env: { ...process.env, ...env, AGORA_SESSION: 'cli-test', AGORA_ACTOR: 'Test/cli' },
      windowsHide: true,
    });
    child.stdin.end();
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const MISSING_CONFIG = path.join(tmpdir(), `agora-no-config-${process.pid}-shadow.json`);
/** Every required argument, valid, pointing at files the caller writes. @param {string} dir @param {Record<string, string | undefined>} [over] */
function fullArgs(dir, over = {}) {
  /** @type {Record<string, string | undefined>} */
  const a = {
    'ledger-root': path.join(dir, 'ledger'), rates: path.join(dir, 'rates.json'), 'billing-context': path.join(dir, 'billing.json'),
    envelope: path.join(dir, 'envelope.json'), 'verification-cost': '0.05', epsilon: '0.1', 'risk-budget': '0.1',
    'as-of': AS_OF, 'observation-cutoff': CUTOFF, 'split-at': SPLIT, ...over,
  };
  return Object.entries(a).flatMap(([k, v]) => (v === undefined ? [] : [`--${k}`, String(v)]));
}
/** @param {string} dir */
async function writeInputs(dir) {
  await writeFile(path.join(dir, 'rates.json'), JSON.stringify(RATES));
  await writeFile(path.join(dir, 'billing.json'), JSON.stringify(BILLING));
  await writeFile(path.join(dir, 'envelope.json'), JSON.stringify(ENVELOPE));
}

test('economy shadow refuses each missing argument before loadConfig: exit 2, the flag named, no config read', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agora-shadow-cli-'));
  for (const flag of ['ledger-root', 'rates', 'billing-context', 'envelope', 'verification-cost', 'epsilon', 'risk-budget', 'as-of', 'observation-cutoff', 'split-at']) {
    const r = await run(['economy', 'shadow', '--json', ...fullArgs(dir, { [flag]: undefined })], { AGORA_CONFIG: MISSING_CONFIG });
    assert.equal(r.code, 2, `${flag}: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`--${flag}`));
    assert.doesNotMatch(r.stderr, /no config/);
    assert.equal(r.stdout, '');
  }
});

test('economy shadow refuses each malformed argument before loadConfig: present but wrong is still the verb\'s own', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agora-shadow-cli-'));
  const cases = [
    ['verification-cost', '-1'], ['verification-cost', 'free'], ['epsilon', 'ten percent'], ['epsilon', '-0.1'],
    ['risk-budget', '0.2'], ['risk-budget', 'p10'], ['as-of', '2026-09-07'], ['split-at', 'yesterday'],
    ['observation-cutoff', '2026-09-07T00:00:00Z'], ['classify', 'all'], ['ended-after', '0'], ['ended-after', '5m'], ['session', 'no-slash'],
  ];
  for (const [flag, value] of cases) {
    const r = await run(['economy', 'shadow', '--json', ...fullArgs(dir, { [flag]: value })], { AGORA_CONFIG: MISSING_CONFIG });
    assert.equal(r.code, 2, `${flag}=${value}: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`--${flag}`));
    assert.doesNotMatch(r.stderr, /no config/);
  }
  const sub = await run(['economy', 'replay'], { AGORA_CONFIG: MISSING_CONFIG });
  assert.equal(sub.code, 2);
  assert.match(sub.stderr, /shadow/);
});

test('the twin: with every argument valid and no config anywhere, the verb runs the replay (it never loads config) and exits 0 on an empty ledger', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agora-shadow-cli-'));
  await writeInputs(dir);
  const r = await run(['economy', 'shadow', '--json', ...fullArgs(dir)], { AGORA_CONFIG: MISSING_CONFIG, AGORA_STATE: path.join(dir, 'state') });
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /no config/);
  const body = JSON.parse(r.stdout);
  assert.equal(body.type, 'economy-shadow');
  assert.equal(body.shadow, true);
  assert.equal(body.actuationAllowed, false);
  assert.deepEqual(body.sessions, []);
  assert.equal(body.rateRows, 1);
});

test('a file input that is unreadable, not JSON, or refused by its validator is exit 1 with the flag named, after the arguments were accepted', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agora-shadow-cli-'));
  await writeInputs(dir);
  const missing = await run(['economy', 'shadow', ...fullArgs(dir, { rates: path.join(dir, 'nope.json') })], { AGORA_CONFIG: MISSING_CONFIG });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /--rates is not readable/);
  await writeFile(path.join(dir, 'bad.json'), '{not json');
  const bad = await run(['economy', 'shadow', ...fullArgs(dir, { envelope: path.join(dir, 'bad.json') })], { AGORA_CONFIG: MISSING_CONFIG });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /--envelope is not JSON/);
  await writeFile(path.join(dir, 'reuse.json'), JSON.stringify({ ...ENVELOPE, prefixReuse: { value: 1, source: 'x' } }));
  const reuse = await run(['economy', 'shadow', ...fullArgs(dir, { envelope: path.join(dir, 'reuse.json') })], { AGORA_CONFIG: MISSING_CONFIG });
  assert.equal(reuse.code, 1);
  assert.match(reuse.stderr, /envelope-prefix-reuse-not-in-e2/);
});

test('the verb replays a real ledger written through the public commit path, in text and JSON, and prints no counter it did not measure', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agora-shadow-cli-'));
  await writeInputs(dir);
  const ledger = await openSessionLedger({ root: path.join(dir, 'ledger'), limits: { maxBytes: 4_000_000, maxEntries: 4000 } });
  let offset = 0;
  for (const [, e] of Object.entries(ledgerOf(cohort((i) => 2 + (i % 8))))) {
    await commitLedgerEvent(ledger, {
      record: { identity: e.identity, observedAt: e.observedAt, usage: e.usage, model: e.model },
      ingest: { locator: 'f', sourceGeneration: 1, offset: ++offset, fingerprint: `fp:${offset}` },
    });
  }
  await closeSessionLedger(ledger);
  const j = await run(['economy', 'shadow', '--json', '--ended-after', '3600', '--session', 'claude-code/e3', ...fullArgs(dir)], { AGORA_CONFIG: MISSING_CONFIG });
  assert.equal(j.code, 0, j.stderr);
  const body = JSON.parse(j.stdout);
  assert.equal(body.sessions.length, 1);
  const s = body.sessions[0];
  assert.equal(s.marker, 'assessed');
  assert.equal(s.calls, 5);
  assert.equal(s.decisions.length, 5);
  // Real data has no assumed prefix reuse: the verb never passes one, so every ratio is null.
  assert.equal(body.inputs.prefixReuse, null);
  for (const d of s.decisions) {
    assert.equal(d.envelope.prefixReuse, 'unassessable');
    assert.equal(d.ratio.least, null);
    assert.equal(d.verdict, 'shadow-only');
    assert.equal(d.shadow, true);
    assert.equal(d.actuationAllowed, false);
  }
  assert.equal(JSON.stringify(body).includes('NaN'), false);
  const t = await run(['economy', 'shadow', '--ended-after', '3600', '--session', 'claude-code/e3', ...fullArgs(dir)], { AGORA_CONFIG: MISSING_CONFIG });
  assert.equal(t.code, 0, t.stderr);
  assert.match(t.stdout, /^economy shadow  shadow=true actuationAllowed=false/);
  assert.match(t.stdout, /claude-code\/e3  entries=5 calls=5 priced=5/);
  assert.equal((t.stdout.match(/shadow-only/g) ?? []).length, 5);
  const bad = await run(['economy', 'shadow', '--session', 'claude-code/none', ...fullArgs(dir)], { AGORA_CONFIG: MISSING_CONFIG });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /session-not-in-ledger/);
});

test('readShadowArgs defaults only classify, and to the ruled rule', () => {
  const v = { 'ledger-root': 'x', rates: 'r', 'billing-context': 'b', envelope: 'e', 'verification-cost': '0', epsilon: '0', 'risk-budget': '0.5', 'as-of': AS_OF, 'observation-cutoff': CUTOFF, 'split-at': SPLIT };
  const a = readShadowArgs(v);
  assert.equal(a.classify, 'all-requests-useful');
  assert.equal(a.endedAfterSeconds, null);
  assert.equal(a.sessionFilter, null);
  assert.equal(a.verificationUsd, 0);
  assert.equal(a.riskBudget, 0.5);
});
