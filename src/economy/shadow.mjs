// @ts-check
// E2c: the shadow optimizer. Replays an E1 ledger through E2a pricing and the E2b horizon and
// emits, for every decision point of every session, the competing trajectories with their costs
// and why no action won. It prices from dated sourced rows, actuates nothing, and copies the
// horizon's verdict fields rather than recomputing them.
//
// Three commitments run through the file.
//
// An absent quantity is never a number. A missing rate, an unmeasured resident context, a horizon
// below its threshold, a prefix-reuse fraction nobody measured: each leaves a reason on the row
// and the ratio null. The decision log says "shadow-only" far more often than it says "crossing",
// and that is the honest shape of E2 on real data.
//
// Every assumption travels on the line that rests on it. The classify rule, the envelope's
// assumed dimensions, the quiet-means-ended rule and the verification cost's explicit-zero label
// are on each decision, never only in the docs.
//
// `shadow: true` and `actuationAllowed: false` on every output, unconditionally.
import { estimateHorizon, historiesFromLedger } from './horizon.mjs';
import { priceUsage, loadRateTable, RATE_KEY_FIELDS } from '../usage/rates.mjs';
import { deriveTotals } from '../usage/session-ledger.mjs';
import {
  addCosts, arrivalWithinTtl, compactionCharge, leastFavourableRatio, pingCharge,
  prefixReadCost, prefixReadCostAssumed, savingsPerCall, scaleCost, tariffFromRow, validateEnvelope,
} from './baselines.mjs';

export const CLASSIFY_RULES = Object.freeze(/** @type {const} */ (['all-requests-useful', 'unknown']));
export const CLASSIFY_ASSUMPTION = 'no-maintenance-evidence-in-ledger';
export const RISK_BUDGETS = Object.freeze(/** @type {const} */ ([0.1, 0.5, 0.9]));
/** The per-request input pools whose sum is the measured resident context. */
export const RESIDENT_CONTEXT_POOLS = Object.freeze(/** @type {const} */ ([
  'uncached-input', 'cached-input', 'cache-write-5m', 'cache-write-1h', 'cache-write-unknown-ttl',
]));

export class ShadowInputError extends Error {
  /** @param {string} code @param {string} [field] */
  constructor(code, field) {
    super(field ? `${code} at ${field}` : code);
    this.name = 'ShadowInputError';
    this.code = code;
    this.field = field;
  }
}

/** @param {unknown} v */
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/** @param {unknown} v */
const isIso = (v) => typeof v === 'string' && Number.isFinite(new Date(v).getTime());
/** @param {string} iso */
const ms = (iso) => new Date(iso).getTime();
/** @param {unknown} v */
const nonBlank = (v) => typeof v === 'string' && v.trim() !== '';

/** The five key fields a harness's billing context carries. modelRevision is per RECORD (the retained `model`), never per harness. */
export const BILLING_FILE_FIELDS = Object.freeze(/** @type {const} */ ([
  'provider', 'endpoint', 'serviceTier', 'region', 'billingMode',
]));

/**
 * A billing-contexts file (`data/billing-contexts.example.json` shape): one entry per harness, each of the five harness-level E2a key
 * fields either known with a source or unknown with a reason. A known field with no source is
 * refused: the whole point of the file is that the replay does not guess a billing context.
 * `modelRevision` is refused in the file because it comes from each record's retained `model`.
 * @param {unknown} value
 */
export function validateBillingContexts(value) {
  if (!isRecord(value)) throw new ShadowInputError('billing-contexts-not-record');
  const v = /** @type {Record<string, unknown>} */ (value);
  for (const key of Object.keys(v)) {
    if (!['version', 'retrieved', 'harnesses'].includes(key)) throw new ShadowInputError('billing-contexts-unknown-key', key);
  }
  if (v.version !== 1) throw new ShadowInputError('billing-contexts-version');
  if (!isIso(v.retrieved)) throw new ShadowInputError('billing-contexts-retrieved');
  if (!isRecord(v.harnesses)) throw new ShadowInputError('billing-contexts-harnesses');
  /** @type {Record<string, Record<string, { state: 'known', value: string, source: string } | { state: 'unknown', reason: string }>>} */
  const harnesses = {};
  for (const [harness, entry] of Object.entries(/** @type {Record<string, unknown>} */ (v.harnesses))) {
    if (!nonBlank(harness)) throw new ShadowInputError('billing-contexts-harness-blank');
    if (!isRecord(entry)) throw new ShadowInputError('billing-contexts-entry', harness);
    const e = /** @type {Record<string, unknown>} */ (entry);
    if (Object.hasOwn(e, 'modelRevision')) throw new ShadowInputError('billing-contexts-model-revision-is-per-record', harness);
    for (const key of Object.keys(e)) {
      if (!BILLING_FILE_FIELDS.includes(/** @type {any} */ (key))) throw new ShadowInputError('billing-contexts-unknown-field', `${harness}.${key}`);
    }
    /** @type {Record<string, any>} */
    const fields = {};
    for (const field of BILLING_FILE_FIELDS) {
      const f = e[field];
      const at = `${harness}.${field}`;
      if (!isRecord(f)) throw new ShadowInputError('billing-contexts-field-missing', at);
      const r = /** @type {Record<string, unknown>} */ (f);
      if (r.state === 'known') {
        if (!nonBlank(r.value)) throw new ShadowInputError('billing-contexts-known-value', at);
        if (!nonBlank(r.source)) throw new ShadowInputError('billing-contexts-known-without-source', at);
        if (Object.keys(r).length !== 3) throw new ShadowInputError('billing-contexts-field-shape', at);
        fields[field] = { state: 'known', value: r.value, source: r.source };
      } else if (r.state === 'unknown') {
        if (!nonBlank(r.reason)) throw new ShadowInputError('billing-contexts-unknown-without-reason', at);
        if (Object.keys(r).length !== 2) throw new ShadowInputError('billing-contexts-field-shape', at);
        fields[field] = { state: 'unknown', reason: r.reason };
      } else {
        throw new ShadowInputError('billing-contexts-field-state', at);
      }
    }
    harnesses[harness] = fields;
  }
  return { version: /** @type {const} */ (1), retrieved: /** @type {string} */ (v.retrieved), harnesses };
}

/**
 * The E2a billing-context shape for one record: the harness's five fields from the file (states
 * and values only; provenance stays in the file) plus `modelRevision` from the record's retained
 * `model`. A harness the file does not name is every-field-unknown, and a record with no model
 * has an unknown revision; either prices nothing rather than guessing.
 * @param {ReturnType<typeof validateBillingContexts>} contexts @param {string} harness
 * @param {string | undefined} model
 */
export function billingContextFor(contexts, harness, model) {
  const entry = contexts.harnesses[harness];
  /** @type {Record<string, { state: 'known', value: string } | { state: 'unknown' }>} */
  const out = {};
  for (const field of BILLING_FILE_FIELDS) {
    const f = entry ? entry[field] : undefined;
    out[field] = f && f.state === 'known' ? { state: 'known', value: f.value } : { state: 'unknown' };
  }
  out.modelRevision = nonBlank(model) ? { state: 'known', value: /** @type {string} */ (model) } : { state: 'unknown' };
  return { version: 1, ...out };
}

/**
 * The resident prompt of a request-unit record is the sum of its input pools when every
 * one is known: `uncached-input`, `cached-input`, and the cache writes. The writes are ONE
 * measurement the adapter states in one of two forms (`session-sources.mjs` makeRecord: the
 * `cache-write-5m` + `cache-write-1h` split when the TTLs are known, else the single
 * `cache-write-unknown-ttl` bucket, never both), so the sum takes whichever form the record
 * carries; a record carrying neither form has unknown writes. An `unknown` or `invalid` pool, or
 * an absent `uncached-input` / `cached-input`, leaves the context unknown with that pool named.
 * `not-applicable` contributes nothing. Lifetime totals are never substituted.
 * @param {{ usage: { components: Record<string, { state: string, value?: number }> } }} record
 * @returns {{ state: 'known', tokens: number, basis: 'sum-of-input-pools' } | { state: 'unknown', reason: string }}
 */
export function residentContextOf(record) {
  const c = record.usage.components;
  let tokens = 0;
  /** @param {string} pool @returns {{ ok: true, tokens: number } | { ok: false, reason: string }} */
  const take = (pool) => {
    const x = c[pool];
    if (!x) return { ok: false, reason: `pool-absent:${pool}` };
    if (x.state === 'not-applicable') return { ok: true, tokens: 0 };
    if (x.state !== 'known' || typeof x.value !== 'number') return { ok: false, reason: `pool-${x.state}:${pool}` };
    return { ok: true, tokens: x.value };
  };
  for (const pool of ['uncached-input', 'cached-input']) {
    const r = take(pool);
    if (!r.ok) return { state: 'unknown', reason: r.reason };
    tokens += r.tokens;
  }
  const split = Boolean(c['cache-write-5m'] || c['cache-write-1h']);
  const pooled = Boolean(c['cache-write-unknown-ttl']);
  if (!split && !pooled) return { state: 'unknown', reason: 'pool-absent:cache-write' };
  // Both forms on one record is a contradiction of the adapter contract, not a sum: summing them
  // would count the same writes twice into a valid-looking context.
  if (split && pooled) return { state: 'unknown', reason: 'pool-both-forms:cache-write' };
  for (const pool of split ? ['cache-write-5m', 'cache-write-1h'] : []) {
    const r = take(pool);
    if (!r.ok) return { state: 'unknown', reason: r.reason };
    tokens += r.tokens;
  }
  if (pooled) {
    const r = take('cache-write-unknown-ttl');
    if (!r.ok) return { state: 'unknown', reason: r.reason };
    tokens += r.tokens;
  }
  return { state: 'known', tokens, basis: 'sum-of-input-pools' };
}

/** @param {string} rule */
export function classifierFor(rule) {
  if (!CLASSIFY_RULES.includes(/** @type {any} */ (rule))) throw new ShadowInputError('classify-rule', rule);
  if (rule === 'unknown') return { classify: () => /** @type {const} */ ('unknown'), assumption: null };
  return { classify: () => /** @type {const} */ ('useful'), assumption: CLASSIFY_ASSUMPTION };
}

/** @param {number} q */
function quantileKey(q) {
  if (!RISK_BUDGETS.includes(/** @type {any} */ (q))) throw new ShadowInputError('risk-budget', String(q));
  return /** @type {'p10'|'p50'|'p90'} */ (`p${Math.round(q * 100)}`);
}

/**
 * Group ledger entries by harness + sessionEpoch. Request-unit entries are ordered by
 * observedAt; an entry with no observedAt (pre-retention) is kept, named, and never ordered.
 * @param {Record<string, any>} entries
 */
export function sessionsFromEntries(entries) {
  /** @type {Map<string, { key: string, harness: string, sessionEpoch: string, entries: Record<string, any>, requests: { key: string, entry: any }[], untimed: string[] }>} */
  const by = new Map();
  for (const [key, entry] of Object.entries(entries)) {
    const id = entry && entry.identity;
    if (!isRecord(id)) throw new ShadowInputError('entry-identity-missing', key);
    const harness = String(id.harness);
    const sessionEpoch = String(id.sessionEpoch);
    const sk = `${harness}/${sessionEpoch}`;
    let s = by.get(sk);
    if (!s) {
      s = { key: sk, harness, sessionEpoch, entries: {}, requests: [], untimed: [] };
      by.set(sk, s);
    }
    s.entries[key] = entry;
    if (id.sourceUnit !== 'request') continue;
    if (!isIso(entry.observedAt)) { s.untimed.push(key); continue; }
    s.requests.push({ key, entry });
  }
  for (const s of by.values()) s.requests.sort((a, b) => ms(a.entry.observedAt) - ms(b.entry.observedAt));
  return [...by.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Session totals through deriveTotals, with the Codex-reset clause made visible: a cumulative
 * snapshot committed with `reset` lands CONFIRMED and sums into `snapshot.components`; one
 * without reset lands provisional and sits in `snapshot.provisional`. A consumer that reads
 * only provisional for Codex misses every reset snapshot, so both are reported.
 * @param {Record<string, any>} entries
 */
export function sessionTotals(entries) {
  const t = deriveTotals(entries);
  return {
    request: { confirmed: t.request.components, provisional: t.request.provisional, excluded: t.request.excluded, conflicts: t.request.conflicts, gaps: t.request.gaps },
    aggregate: { confirmed: t.aggregate.components, provisional: t.aggregate.provisional, excluded: t.aggregate.excluded },
    snapshot: { confirmed: t.snapshot.components, provisional: t.snapshot.provisional, excluded: t.snapshot.excluded },
    note: 'snapshot.confirmed includes cumulative snapshots committed with reset; snapshot.provisional holds the rest',
  };
}

/** @param {{ apiEquivalent: any, coverage: string, unpriced: Record<string, any> }} priced @returns {import('./baselines.mjs').Cost} */
function requestCost(priced) {
  if (priced.coverage === 'none' || priced.apiEquivalent.state !== 'known') {
    return { state: 'unknown', reason: priced.apiEquivalent.reason ?? 'unpriced' };
  }
  let total = 0;
  for (const c of Object.values(/** @type {Record<string, { usd: number }>} */ (priced.apiEquivalent.components))) total += c.usd;
  if (priced.coverage === 'complete') return { state: 'known', usd: total };
  // A component the row does not price but the record measured at ZERO tokens costs exactly
  // nothing at any finite rate: that is arithmetic, not an assumption, so it does not lower the
  // total to a bound. A missing rate over a non-zero count, or an unknown count, does.
  /** @type {Record<string, number | 'unknown'>} */
  const unpriced = {};
  for (const [name, u] of Object.entries(priced.unpriced)) {
    if (typeof u.tokens === 'number') { if (u.tokens > 0) unpriced[name] = u.tokens; }
    else unpriced[name] = 'unknown';
  }
  if (Object.keys(unpriced).length === 0) return { state: 'known', usd: total };
  return { state: 'lower-bound', usd: total, unpriced };
}

/**
 * Replay a ledger's entries. Pure over its inputs; `entries` is the `entries` object of a ledger
 * snapshot (or any object of the same shape).
 *
 * @param {{
 *   entries: Record<string, any>,
 *   rateTable: unknown,
 *   billingContexts: unknown,
 *   envelope: unknown,
 *   epsilon: number,
 *   riskBudget: number,
 *   verificationUsd: number,
 *   asOf: string,
 *   observationCutoff: string,
 *   splitAt: string,
 *   classify?: string,
 *   endedAfterSeconds?: number | null,
 *   sessionFilter?: string | null,
 *   prefixReuse?: { value: number, source: string } | null,
 *   minComparable?: number,
 * }} opts
 */
export function shadowReplay(opts) {
  if (!isRecord(opts.entries)) throw new ShadowInputError('entries-not-record');
  const table = loadRateTable(opts.rateTable);
  const contexts = validateBillingContexts(opts.billingContexts);
  const env = validateEnvelope(opts.envelope);
  if (!(Number.isFinite(opts.epsilon) && opts.epsilon >= 0)) throw new ShadowInputError('epsilon');
  const q = quantileKey(opts.riskBudget);
  if (!(Number.isFinite(opts.verificationUsd) && opts.verificationUsd >= 0)) throw new ShadowInputError('verification-cost');
  for (const [name, v] of [['asOf', opts.asOf], ['observationCutoff', opts.observationCutoff], ['splitAt', opts.splitAt]]) {
    if (!isIso(v)) throw new ShadowInputError('timestamp', String(name));
  }
  const { classify, assumption } = classifierFor(opts.classify ?? 'all-requests-useful');
  const endedAfter = opts.endedAfterSeconds ?? null;
  if (endedAfter !== null && !(Number.isFinite(endedAfter) && endedAfter > 0)) throw new ShadowInputError('ended-after');
  const reuse = opts.prefixReuse ?? null;
  if (reuse !== null) {
    if (!(Number.isFinite(reuse.value) && reuse.value >= 0 && reuse.value <= 1) || !nonBlank(reuse.source)) throw new ShadowInputError('prefix-reuse');
  }
  const verificationLabel = opts.verificationUsd === 0 ? 'explicit-zero' : 'explicit';

  const sessions = sessionsFromEntries(opts.entries);
  const selected = opts.sessionFilter ? sessions.filter((s) => s.key === opts.sessionFilter) : sessions;
  if (opts.sessionFilter && selected.length === 0) throw new ShadowInputError('session-not-in-ledger', opts.sessionFilter);

  // Histories per harness, from EVERY session of that harness (the cohort), whatever the filter.
  /** @type {Map<string, string | null>} */
  const endedAtBySession = new Map();
  for (const s of sessions) {
    if (!s.requests.length) { endedAtBySession.set(s.key, null); continue; }
    const last = s.requests[s.requests.length - 1].entry.observedAt;
    const quiet = endedAfter !== null && ms(opts.observationCutoff) - ms(last) > endedAfter * 1000;
    endedAtBySession.set(s.key, quiet ? last : null);
  }
  const allRequestEntries = Object.fromEntries(Object.entries(opts.entries).filter(([, e]) => e?.identity?.sourceUnit === 'request'));
  const { histories, skippedNonRequest } = historiesFromLedger(Object.values(allRequestEntries), {
    sessionKeyOf: (e) => `${e.identity.harness}/${e.identity.sessionEpoch}`,
    classify,
    endedAt: (key) => endedAtBySession.get(key) ?? null,
  });
  const historiesByHarness = new Map();
  for (const h of histories) {
    const list = historiesByHarness.get(h.harness) ?? [];
    list.push(h);
    historiesByHarness.set(h.harness, list);
  }
  /** @type {Map<string, any>} */
  const horizonCache = new Map();
  /** @param {string} harness @param {number} k */
  const horizonAt = (harness, k) => {
    const ck = `${harness}#${k}`;
    if (horizonCache.has(ck)) return horizonCache.get(ck);
    const hs = historiesByHarness.get(harness) ?? [];
    const r = estimateHorizon(hs, {
      observationCutoff: opts.observationCutoff,
      split: { at: opts.splitAt },
      subject: { harness, phase: 'unknown', callsSoFar: k },
      ...(opts.minComparable !== undefined ? { minComparable: opts.minComparable } : {}),
    });
    horizonCache.set(ck, r);
    return r;
  };

  /** @param {import('./baselines.mjs').Tariff} t */
  const readerFor = (t) => (reuse
    ? (/** @type {number} */ tokens) => prefixReadCostAssumed(t, tokens, reuse.value)
    : (/** @type {number} */ tokens) => prefixReadCost(t, tokens));

  const horizonAssumptions = [
    ...(assumption ? [{ classify: opts.classify ?? 'all-requests-useful', assumption }] : [{ classify: 'unknown', assumption: null }]),
    ...(endedAfter !== null
      ? [{ sessionEnd: `quiet-past-${endedAfter}s-means-ended-at-last-request` }]
      : [{ sessionEnd: 'no-end-evidence-every-session-right-censored' }]),
  ];

  const sessionRows = selected.map((s) => {
    const totals = sessionTotals(s.entries);
    const entryCount = Object.keys(s.entries).length;
    const base = {
      sessionKey: s.key, harness: s.harness, sessionEpoch: s.sessionEpoch, entryCount,
      calls: s.requests.length, shadow: true, actuationAllowed: false, totals,
      latency: 'unknown', quality: 'unknown',
    };
    if (s.requests.length === 0 && s.untimed.length === 0) {
      return { ...base, marker: 'unassessable', reason: 'no-request-unit-entries', horizonEligible: false, decisions: [], baselines: null };
    }
    if (s.untimed.length) {
      return { ...base, marker: 'unclassified', reason: 'observed-at-absent', untimedEntries: s.untimed, horizonEligible: false, decisions: [], baselines: null };
    }
    /** @type {{ priced: number, provisional: number, unpriced: Record<string, number> }} */
    const pricingCounts = { priced: 0, provisional: 0, unpriced: {} };
    /** @type {Record<string, number>} */
    const zeroRateSeen = {};
    /** @type {import('./baselines.mjs').Cost[]} */
    const observedCosts = [];
    const priced = s.requests.map(({ key, entry }) => {
      const record = {
        identity: entry.identity, observedAt: entry.observedAt, usage: entry.usage,
        ...(entry.model !== undefined ? { model: entry.model } : {}),
        ...(entry.sourceReportedCost !== undefined ? { sourceReportedCost: entry.sourceReportedCost } : {}),
        ...(entry.sourceReportedReasoning !== undefined ? { sourceReportedReasoning: entry.sourceReportedReasoning } : {}),
      };
      const resident = residentContextOf(record);
      const status = String(entry.status);
      if (status === 'conflict' || status === 'gap') {
        const reason = `status-${status}`;
        pricingCounts.unpriced[reason] = (pricingCounts.unpriced[reason] ?? 0) + 1;
        observedCosts.push({ state: 'unknown', reason });
        return { key, entry, resident, status, pricing: null, cost: { state: 'unknown', reason } };
      }
      const residentForPrice = resident.state === 'known' ? { state: 'known', tokens: resident.tokens } : { state: 'unknown' };
      const billingCtx = billingContextFor(contexts, s.harness, typeof entry.model === 'string' ? entry.model : undefined);
      const p = priceUsage(record, table, { eventTime: entry.observedAt, asOf: opts.asOf }, billingCtx, residentForPrice);
      const cost = requestCost(p);
      if (cost.state === 'unknown') pricingCounts.unpriced[cost.reason] = (pricingCounts.unpriced[cost.reason] ?? 0) + 1;
      else if (status === 'provisional') pricingCounts.provisional++;
      else pricingCounts.priced++;
      if (p.row && p.row.publishedApi) {
        for (const [name, r] of Object.entries(p.row.publishedApi)) if (r.usdPerMillion === 0) zeroRateSeen[name] = (zeroRateSeen[name] ?? 0) + 1;
      }
      observedCosts.push(cost);
      return { key, entry, resident, status, pricing: p, cost };
    });

    const decisions = priced.map((pr, i) => {
      const k = i + 1;
      const at = pr.entry.observedAt;
      /** @type {string[]} */
      const reasons = [];
      const leakage = ms(at) < ms(opts.splitAt);
      const h = horizonAt(s.harness, k);
      const horizon = {
        status: h.status,
        horizonEligible: h.horizonEligible,
        actuationAllowed: h.actuationAllowed,
        actuationReason: h.actuationReason,
        quantile: q,
        ...(h.status === 'unknown' ? { reason: h.reason } : {}),
        ...(h.stoppingUnavailable ? { stoppingUnavailable: h.stoppingUnavailable } : {}),
        ...(h.remainingCallsUnavailable ? { remainingCallsUnavailable: h.remainingCallsUnavailable } : {}),
        ...(h.remainingCalls ? { remainingCalls: h.remainingCalls } : {}),
        ...(h.pTerminate ? { pTerminate: h.pTerminate } : {}),
        ...(h.immediateTerminationLossBound ? { immediateTerminationLossBound: h.immediateTerminationLossBound } : {}),
        ...(h.nextArrivalSeconds ? { nextArrivalSeconds: h.nextArrivalSeconds } : {}),
        comparableSessions: h.comparableSessions,
        unclassifiedSessions: h.unclassifiedSessions,
        ...(leakage ? { leakage: 'leakage-before-split' } : {}),
        assumptions: horizonAssumptions,
      };
      if (leakage) reasons.push('horizon-leakage-before-split');
      if (h.status !== 'estimated') reasons.push('horizon-unknown');
      else if (!h.horizonEligible) reasons.push('horizon-not-eligible');
      const remaining = h.status === 'estimated' && h.remainingCalls && typeof h.remainingCalls[q] === 'number' ? h.remainingCalls[q] : null;
      if (h.status === 'estimated' && remaining === null) reasons.push(h.stoppingUnavailable ? 'horizon-stopping-unavailable' : `horizon-remaining-absent:${q}`);

      const tariff = tariffFromRow(pr.pricing ? pr.pricing.row : null);
      const tariffOut = {
        row: pr.pricing ? pr.pricing.row : null,
        zeroRateComponents: tariff.zeroRateComponents,
      };
      if (!pr.pricing || !pr.pricing.row) reasons.push(`rate-classification-unknown:${pr.cost.state === 'unknown' ? pr.cost.reason : 'no-row'}`);
      if (pr.resident.state !== 'known') reasons.push(`resident-context-unknown:${pr.resident.reason}`);

      const envelopeLabels = {
        horizon: h.status === 'estimated' && !leakage ? 'measured' : 'unknown',
        prefixReuse: reuse ? `assumed(${reuse.value}, ${reuse.source})` : 'unassessable',
        rateClassification: pr.pricing && pr.pricing.row ? 'measured' : 'unknown',
        summarySize: `assumed(${env.summaryTokens.value}, ${env.summaryTokens.source})`,
        postCompaction: `assumed(${env.postCompactionTokens.value}, ${env.postCompactionTokens.source})`,
        recovery: `assumed(${env.recoveryTokens.value}, ${env.recoveryTokens.source})`,
        verification: verificationLabel,
      };
      if (!reuse) reasons.push('envelope-unassessable:prefix-reuse');

      /** @type {any} */
      let trajectories;
      /** @type {any} */
      let K = null;
      /** @type {import('./baselines.mjs').Cost} */
      let perCall = { state: 'unknown', reason: 'resident-context-unknown' };
      if (pr.resident.state === 'known') {
        const P = pr.resident.tokens;
        const read = readerFor(tariff);
        const H = remaining ?? null;
        /** @type {import('./baselines.mjs').Cost} */
        const cold = tariff.uncachedInput === undefined
          ? { state: 'unknown', reason: 'missing-rate:uncached-input' }
          : { state: 'known', usd: (P / 1_000_000) * tariff.uncachedInput };
        /** @type {import('./baselines.mjs').Cost} */
        const warm = tariff.cachedInput === undefined
          ? { state: 'unknown', reason: 'missing-rate:cached-input' }
          : { state: 'known', usd: (P / 1_000_000) * tariff.cachedInput };
        K = compactionCharge(tariff, P, env, opts.verificationUsd, { summaryRead: cold });
        perCall = savingsPerCall(tariff, P, env, read);
        /** @param {import('./baselines.mjs').Cost} c */
        const overH = (c) => (H === null ? /** @type {import('./baselines.mjs').Cost} */ ({ state: 'unknown', reason: 'horizon-unknown' }) : scaleCost(c, H));
        const continueCost = overH(read(P));
        const futureAfterCompaction = overH(read(env.postCompactionTokens.value));
        const compactCold = addCosts(K.total, futureAfterCompaction);
        // Warm-then-compact as ONE sequence: a ping reads the prefix cold (that is why it is
        // warming), then the summary request reads it warm. It is never cheaper than cold
        // compaction at non-negative rates, and the log shows that rather than assuming it.
        const warmPing = pingCharge(tariff, P, env, 0, () => cold);
        const Kwarm = compactionCharge(tariff, P, env, opts.verificationUsd, { summaryRead: warm });
        const compactWarm = addCosts(warmPing.total, Kwarm.total, futureAfterCompaction);
        // Periodic ping without compaction: pings per gap from the p50 gap against the TTL.
        const gapP50 = h.status === 'estimated' && h.nextArrivalSeconds && typeof h.nextArrivalSeconds.p50 === 'number' ? h.nextArrivalSeconds.p50 : null;
        const pingsPerCall = gapP50 === null ? null : Math.max(0, Math.ceil(gapP50 / env.cacheTtlSeconds.value) - 1);
        // The forecast ping: its rereads are over the HORIZON's remaining calls, so an unknown
        // horizon leaves the ping unknown rather than a total missing its rereads term.
        const onePing = pingCharge(tariff, P, env, H, read);
        // The replay's ping, for the periodic-ping baseline: rereads over the OBSERVED remaining
        // calls of this session (calls - k), a count and never a forecast.
        const observedPing = pingCharge(tariff, P, env, s.requests.length - k, read);
        const pingTotal = pingsPerCall === null
          ? /** @type {import('./baselines.mjs').Cost} */ ({ state: 'unknown', reason: 'next-arrival-p50-null' })
          : addCosts(continueCost, overH(scaleCost(onePing.total, pingsPerCall)));
        const arrival = arrivalWithinTtl(h.status === 'estimated' ? h.nextArrivalSeconds : undefined, env.cacheTtlSeconds.value);
        trajectories = {
          continue: { cost: continueCost, basis: 'remaining calls each read the current prefix; prefix growth assumed 0 (constant-prefix approximation)' },
          compactCold: { cost: compactCold, K: K, future: futureAfterCompaction },
          compactWarm: { cost: compactWarm, warmingPing: warmPing, K: Kwarm, future: futureAfterCompaction, note: 'warm-then-compact compared as one sequence against cold compaction' },
          ping: { cost: pingTotal, perPing: onePing, observedPing, pingsPerCall, pingsBasis: 'ceil(p50 gap / ttl) - 1', arrivalWithinTtl: arrival, benefit: reuse ? 'assumed-reuse-already-in-continue' : 'unassessable:prefix-reuse' },
        };
      } else {
        trajectories = {
          continue: { cost: { state: 'unknown', reason: 'resident-context-unknown' } },
          compactCold: { cost: { state: 'unknown', reason: 'resident-context-unknown' } },
          compactWarm: { cost: { state: 'unknown', reason: 'resident-context-unknown' } },
          ping: { cost: { state: 'unknown', reason: 'resident-context-unknown' } },
        };
      }

      const gateOpen = !leakage && h.status === 'estimated' && h.horizonEligible === true && remaining !== null
        && reuse !== null && pr.pricing && pr.pricing.row && pr.resident.state === 'known';
      const ratio = gateOpen
        ? leastFavourableRatio(trajectories.continue.cost, trajectories.compactCold.cost, opts.epsilon)
        : { least: null, reason: reasons[0] ?? 'gate-closed' };
      const verdict = ratio.least === null ? 'shadow-only' : ratio.crossing ? 'crossing' : 'no-crossing';
      if (ratio.least === null && ratio.reason && !reasons.includes(ratio.reason)) reasons.push(ratio.reason);
      return {
        at, callsSoFar: k, entryKey: pr.key, entryStatus: pr.status,
        residentContext: pr.resident,
        requestCost: pr.cost,
        tariff: tariffOut,
        horizon,
        envelope: envelopeLabels,
        verification: { usd: opts.verificationUsd, label: verificationLabel },
        savingsPerCall: perCall,
        trajectories,
        ratio,
        crossing: ratio.least === null ? null : ratio.crossing,
        verdict,
        reasons,
        shadow: true,
        actuationAllowed: false,
      };
    });

    // Baselines over the whole session. never-compact is the observed spend where priced;
    // always-compact and periodic-ping are counterfactual and say so.
    const neverCompact = { cost: addCosts(...observedCosts), basis: 'observed priced spend of every request; unknown if any request is unpriced', latency: 'unknown', quality: 'unknown' };
    const alwaysCompactParts = decisions.map((d) => (d.trajectories.compactCold.K ? d.trajectories.compactCold.K.total : { state: 'unknown', reason: 'resident-context-unknown' }));
    const alwaysCompact = { cost: addCosts(...alwaysCompactParts), basis: 'predicted: K paid at every decision point (future reads not re-added; counterfactual prefix sizes unmeasured)', latency: 'unknown', quality: 'unknown' };
    /** @type {import('./baselines.mjs').Cost[]} */
    const pingParts = [];
    for (let i = 1; i < priced.length; i++) {
      const gap = (ms(priced[i].entry.observedAt) - ms(priced[i - 1].entry.observedAt)) / 1000;
      const n = Math.max(0, Math.ceil(gap / env.cacheTtlSeconds.value) - 1);
      const d = decisions[i - 1];
      if (n === 0) continue;
      if (!d.trajectories.ping.observedPing) { pingParts.push({ state: 'unknown', reason: 'resident-context-unknown' }); continue; }
      pingParts.push(scaleCost(d.trajectories.ping.observedPing.total, n));
    }
    const periodicPing = { cost: addCosts(neverCompact.cost, ...pingParts), basis: 'predicted: observed spend plus ceil(measured gap / ttl) - 1 pings per observed gap, each ping reread on the observed remaining calls of the session (never the horizon)', latency: 'unknown', quality: 'unknown' };

    return {
      ...base,
      marker: 'assessed',
      horizonEligible: decisions.length ? decisions[decisions.length - 1].horizon.horizonEligible : false,
      pricing: pricingCounts,
      zeroRateComponents: zeroRateSeen,
      decisions,
      baselines: { neverCompact, alwaysCompact, periodicPing },
    };
  });

  return {
    type: 'economy-shadow',
    shadow: true,
    actuationAllowed: false,
    inputs: {
      asOf: opts.asOf, observationCutoff: opts.observationCutoff, splitAt: opts.splitAt,
      epsilon: opts.epsilon, riskBudget: opts.riskBudget, quantile: q,
      verification: { usd: opts.verificationUsd, label: verificationLabel },
      classify: opts.classify ?? 'all-requests-useful',
      endedAfterSeconds: endedAfter,
      prefixReuse: reuse,
    },
    envelope: env,
    billingContexts: contexts,
    rateRows: table.rows.length,
    skippedNonRequest,
    sessions: sessionRows,
  };
}

// --- The verb ------------------------------------------------------------------------------------

/** @param {import('./baselines.mjs').Cost} c */
export function formatCost(c) {
  if (c.state === 'known') return c.usd.toFixed(4);
  if (c.state === 'lower-bound') return `>=${c.usd.toFixed(4)}`;
  if (c.state === 'interval') return `[${c.low.toFixed(4)}..${c.high.toFixed(4)}]`;
  return `unknown(${c.reason})`;
}

/**
 * Text rendering: one header per session, one row per decision. The same rows as the JSON,
 * nothing summarised away; a reader wanting the whole row reads --json.
 * @param {ReturnType<typeof shadowReplay>} log
 */
export function formatShadow(log) {
  const lines = [];
  lines.push(`economy shadow  shadow=true actuationAllowed=false  quantile=${log.inputs.quantile} epsilon=${log.inputs.epsilon} verification=${log.inputs.verification.usd} (${log.inputs.verification.label}) classify=${log.inputs.classify} rateRows=${log.rateRows}`);
  for (const s of log.sessions) {
    if (s.marker !== 'assessed' || !s.baselines) {
      lines.push(`${s.sessionKey}  entries=${s.entryCount} calls=${s.calls}  ${s.marker}: ${'reason' in s ? s.reason : ''}`);
      continue;
    }
    const up = Object.entries(s.pricing.unpriced).map(([r, n]) => `${r}=${n}`).join(',');
    lines.push(`${s.sessionKey}  entries=${s.entryCount} calls=${s.calls} priced=${s.pricing.priced} provisional=${s.pricing.provisional} unpriced=${up || 'none'} horizonEligible=${s.horizonEligible}`);
    lines.push(`  baselines never-compact=${formatCost(s.baselines.neverCompact.cost)} always-compact=${formatCost(s.baselines.alwaysCompact.cost)} periodic-ping=${formatCost(s.baselines.periodicPing.cost)} latency=unknown quality=unknown`);
    for (const d of s.decisions) {
      const rc = d.residentContext.state === 'known' ? String(d.residentContext.tokens) : `unknown(${d.residentContext.reason})`;
      const rem = d.horizon.remainingCalls && typeof d.horizon.remainingCalls[d.horizon.quantile] === 'number' ? String(d.horizon.remainingCalls[d.horizon.quantile]) : d.horizon.status === 'estimated' ? 'absent' : 'unknown';
      const ratio = d.ratio.least === null ? `null(${d.ratio.reason})` : `${d.ratio.least.toFixed(3)}>${d.ratio.threshold.toFixed(3)}=${d.ratio.crossing}`;
      lines.push(`  ${d.at} k=${d.callsSoFar} ctx=${rc} H${d.horizon.quantile}=${rem} continue=${formatCost(d.trajectories.continue.cost)} compact-cold=${formatCost(d.trajectories.compactCold.cost)} compact-warm=${formatCost(d.trajectories.compactWarm.cost)} ping=${formatCost(d.trajectories.ping.cost)} ratio=${ratio} ${d.verdict}${d.reasons.length ? ` [${d.reasons.join('; ')}]` : ''}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Argument refusals for the verb, all before any file or config is read. Each returns the flag
 * name in the message so a wrapper reads which one. Absent and malformed are both refused here.
 * @param {Record<string, unknown>} v
 */
export function readShadowArgs(v) {
  /** @param {string} flag */
  const need = (flag) => {
    const raw = v[flag];
    if (raw === undefined) throw new ShadowInputError(`--${flag} is required`);
    return String(raw);
  };
  /** @param {string} flag @param {(n: number) => boolean} ok */
  const num = (flag, ok) => {
    const s = need(flag);
    if (!/^-?[0-9]+(\.[0-9]+)?$/.test(s)) throw new ShadowInputError(`--${flag} must be a decimal number`);
    const n = Number(s);
    if (!Number.isFinite(n) || !ok(n)) throw new ShadowInputError(`--${flag} is out of range`);
    return n;
  };
  /** @param {string} flag */
  const stamp = (flag) => {
    const s = need(flag);
    if (!isIso(s) || new Date(s).toISOString() !== s) throw new ShadowInputError(`--${flag} must be an ISO-8601 UTC timestamp with milliseconds (YYYY-MM-DDTHH:MM:SS.sssZ)`);
    return s;
  };
  const ledgerRoot = need('ledger-root');
  const rates = need('rates');
  const billingContext = need('billing-context');
  const envelope = need('envelope');
  const verificationUsd = num('verification-cost', (n) => n >= 0);
  const epsilon = num('epsilon', (n) => n >= 0);
  const riskBudget = num('risk-budget', (n) => RISK_BUDGETS.includes(/** @type {any} */ (n)));
  const asOf = stamp('as-of');
  const observationCutoff = stamp('observation-cutoff');
  const splitAt = stamp('split-at');
  const classify = v.classify === undefined ? 'all-requests-useful' : String(v.classify);
  if (!CLASSIFY_RULES.includes(/** @type {any} */ (classify))) throw new ShadowInputError(`--classify must be one of ${CLASSIFY_RULES.join(', ')}`);
  let endedAfterSeconds = null;
  if (v['ended-after'] !== undefined) {
    const s = String(v['ended-after']);
    if (!/^[0-9]+$/.test(s) || Number(s) < 1) throw new ShadowInputError('--ended-after must be a positive integer number of seconds');
    endedAfterSeconds = Number(s);
  }
  let sessionFilter = null;
  if (v.session !== undefined) {
    const s = String(v.session);
    if (!/^[^/]+\/.+$/.test(s)) throw new ShadowInputError('--session must be <harness>/<sessionEpoch>');
    sessionFilter = s;
  }
  return { ledgerRoot, rates, billingContext, envelope, verificationUsd, epsilon, riskBudget, asOf, observationCutoff, splitAt, classify, endedAfterSeconds, sessionFilter };
}

/**
 * The `economy shadow` verb. No config, no room, no provider, no actuation: it reads the ledger
 * (opening it read-only through the ledger's own lock), the three JSON inputs, replays, prints.
 * @param {ReturnType<typeof readShadowArgs> & { json: boolean }} args
 */
export async function runEconomyShadowCli(args) {
  const { readFile } = await import('node:fs/promises');
  const { openSessionLedger, closeSessionLedger, readLedgerSnapshot } = await import('../usage/session-ledger.mjs');
  /** @param {string} file @param {string} flag */
  const readJson = async (file, flag) => {
    let text;
    try { text = await readFile(file, 'utf8'); }
    catch { throw new ShadowInputError(`${flag} is not readable: ${file}`); }
    try { return JSON.parse(text); }
    catch { throw new ShadowInputError(`${flag} is not JSON: ${file}`); }
  };
  const rateTable = await readJson(args.rates, '--rates');
  const billingContexts = await readJson(args.billingContext, '--billing-context');
  const envelope = await readJson(args.envelope, '--envelope');
  const ledger = await openSessionLedger({ root: args.ledgerRoot, limits: { maxBytes: 64_000_000, maxEntries: 1_000_000 } });
  let entries;
  try { entries = readLedgerSnapshot(ledger).entries; }
  finally { await closeSessionLedger(ledger); }
  const log = shadowReplay({
    entries, rateTable, billingContexts, envelope,
    epsilon: args.epsilon, riskBudget: args.riskBudget, verificationUsd: args.verificationUsd,
    asOf: args.asOf, observationCutoff: args.observationCutoff, splitAt: args.splitAt,
    classify: args.classify, endedAfterSeconds: args.endedAfterSeconds, sessionFilter: args.sessionFilter,
  });
  return args.json ? `${JSON.stringify(log)}\n` : formatShadow(log);
}
