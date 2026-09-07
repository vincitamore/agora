// @ts-check
// E2c: pure trajectory costing over a tariff, a resident prefix and a horizon.
//
// Nothing here reads a ledger, calls a provider or actuates. Every function takes the numbers
// it needs and returns a COST STATE, never a bare number: `known` (a point), `lower-bound` (a
// point that is known to be too low, with what it could not price beside it), `interval` (a
// range whose ends are the two prefix-reuse extremes, because prefix reuse is unassessable in
// this cut), or `unknown` with a reason. Arithmetic on an absent quantity is the failure this
// file exists to refuse: `null * x` is 0 in JavaScript and `undefined * x` is NaN, and a
// comparison against NaN is false, so "no crossing" would be reported from nothing.

/** @typedef {{ state: 'known', usd: number }} KnownCost */
/** @typedef {{ state: 'lower-bound', usd: number, unpriced: Record<string, number | 'unknown'> }} LowerBoundCost */
/** @typedef {{ state: 'interval', low: number, high: number, reason: string }} IntervalCost */
/** @typedef {{ state: 'unknown', reason: string }} UnknownCost */
/** @typedef {KnownCost | LowerBoundCost | IntervalCost | UnknownCost} Cost */

/**
 * Per-component USD per million tokens, read from ONE selected rate row. A component the row
 * does not price is absent, never zero.
 * @typedef {{ cachedInput?: number, uncachedInput?: number, cacheWrite?: number, output?: number, zeroRateComponents: string[], rowEffective: string | null }} Tariff
 */

/**
 * Envelope dimensions the caller ASSUMES, each with its source. Prefix reuse is deliberately
 * not a member: E2 rules it unassessable, and an envelope that carried it would be an
 * assumption dressed as a measurement.
 * @typedef {{
 *   summaryTokens: { value: number, source: string },
 *   postCompactionTokens: { value: number, source: string },
 *   recoveryTokens: { value: number, source: string },
 *   pingTokens: { value: number, source: string },
 *   cacheTtlSeconds: { value: number, source: string },
 * }} Envelope
 */

export const ENVELOPE_DIMENSIONS = Object.freeze(/** @type {const} */ ([
  'summaryTokens', 'postCompactionTokens', 'recoveryTokens', 'pingTokens', 'cacheTtlSeconds',
]));

export class BaselineInputError extends Error {
  /** @param {string} code @param {string} [field] */
  constructor(code, field) {
    super(field ? `${code} at ${field}` : code);
    this.name = 'BaselineInputError';
    this.code = code;
    this.field = field;
  }
}

/** @param {unknown} v */
const finiteNonNegative = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/**
 * Validate an envelope file's contents. Every dimension is required, carries a finite
 * non-negative value and a non-blank source. `prefixReuse` is refused by name.
 * @param {unknown} value
 * @returns {Envelope}
 */
export function validateEnvelope(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new BaselineInputError('envelope-not-record');
  const rec = /** @type {Record<string, unknown>} */ (value);
  if (Object.hasOwn(rec, 'prefixReuse')) throw new BaselineInputError('envelope-prefix-reuse-not-in-e2', 'prefixReuse');
  for (const key of Object.keys(rec)) {
    if (!ENVELOPE_DIMENSIONS.includes(/** @type {any} */ (key))) throw new BaselineInputError('envelope-unknown-dimension', key);
  }
  /** @type {any} */
  const out = {};
  for (const dim of ENVELOPE_DIMENSIONS) {
    const d = rec[dim];
    if (typeof d !== 'object' || d === null || Array.isArray(d)) throw new BaselineInputError('envelope-dimension-missing', dim);
    const { value: v, source } = /** @type {Record<string, unknown>} */ (d);
    if (!finiteNonNegative(v)) throw new BaselineInputError('envelope-value', dim);
    if (typeof source !== 'string' || source.trim() === '') throw new BaselineInputError('envelope-source', dim);
    out[dim] = { value: v, source };
  }
  if (out.cacheTtlSeconds.value <= 0) throw new BaselineInputError('envelope-value', 'cacheTtlSeconds');
  return out;
}

/**
 * Read the four component rates the forward model needs from one E2a rate row.
 * Cache write is read from `cache-write-5m` (the summary rebuild's write). A component absent
 * from the row is absent here; a component priced at exactly zero is named so a reader sees a
 * free rate rather than a missing one (E2a admits usdPerMillion 0).
 * @param {{ effective?: string, publishedApi?: Record<string, { usdPerMillion: number }> } | null | undefined} row
 * @returns {Tariff}
 */
export function tariffFromRow(row) {
  /** @type {Tariff} */
  const t = { zeroRateComponents: [], rowEffective: row && typeof row.effective === 'string' ? row.effective : null };
  if (!row || !row.publishedApi) return t;
  const api = row.publishedApi;
  /** @param {string} name @param {'cachedInput'|'uncachedInput'|'cacheWrite'|'output'} into */
  const take = (name, into) => {
    const r = api[name];
    if (!r || typeof r.usdPerMillion !== 'number' || !Number.isFinite(r.usdPerMillion)) return;
    t[into] = r.usdPerMillion;
    if (r.usdPerMillion === 0) t.zeroRateComponents.push(name);
  };
  take('cached-input', 'cachedInput');
  take('uncached-input', 'uncachedInput');
  take('cache-write-5m', 'cacheWrite');
  take('output', 'output');
  return t;
}

/** @param {number} tokens @param {number} usdPerMillion */
const usd = (tokens, usdPerMillion) => (tokens / 1_000_000) * usdPerMillion;

/**
 * Cost of reading `prefixTokens` once, as an interval over prefix reuse: all-warm (every token a
 * cache read) to all-cold (every token uncached). Both rates are required; either absent is
 * unknown. When the two rates are equal the interval collapses to a point and is still reported
 * as an interval, because the reason it is an interval (reuse unassessable) has not changed.
 * @param {Tariff} t @param {number} prefixTokens
 * @returns {Cost}
 */
export function prefixReadCost(t, prefixTokens) {
  if (t.cachedInput === undefined) return { state: 'unknown', reason: 'missing-rate:cached-input' };
  if (t.uncachedInput === undefined) return { state: 'unknown', reason: 'missing-rate:uncached-input' };
  const warm = usd(prefixTokens, t.cachedInput);
  const cold = usd(prefixTokens, t.uncachedInput);
  return { state: 'interval', low: Math.min(warm, cold), high: Math.max(warm, cold), reason: 'prefix-reuse-unassessable' };
}

/**
 * Cost of reading `prefixTokens` once under a STATED reuse assumption (tests and fixtures;
 * never real data in E2). `reuse` is the fraction of the prefix served from cache.
 * @param {Tariff} t @param {number} prefixTokens @param {number} reuse
 * @returns {Cost}
 */
export function prefixReadCostAssumed(t, prefixTokens, reuse) {
  if (t.cachedInput === undefined) return { state: 'unknown', reason: 'missing-rate:cached-input' };
  if (t.uncachedInput === undefined) return { state: 'unknown', reason: 'missing-rate:uncached-input' };
  if (!(reuse >= 0 && reuse <= 1)) throw new BaselineInputError('reuse-out-of-range');
  return { state: 'known', usd: usd(prefixTokens * reuse, t.cachedInput) + usd(prefixTokens * (1 - reuse), t.uncachedInput) };
}

/** @param {Cost} c @param {number} k */
export function scaleCost(c, k) {
  if (!(Number.isFinite(k) && k >= 0)) return { state: /** @type {const} */ ('unknown'), reason: 'scale-not-finite' };
  if (c.state === 'known') return { state: c.state, usd: c.usd * k };
  if (c.state === 'lower-bound') return { state: c.state, usd: c.usd * k, unpriced: c.unpriced };
  if (c.state === 'interval') return { state: c.state, low: c.low * k, high: c.high * k, reason: c.reason };
  return c;
}

/**
 * Add costs. Unknown poisons; interval widens; lower-bound stays lower-bound; two knowns are
 * known. The result is never a number where any input was not one.
 * @param {...Cost} parts
 * @returns {Cost}
 */
export function addCosts(...parts) {
  let low = 0;
  let high = 0;
  let interval = false;
  let lowerBound = false;
  /** @type {Record<string, number | 'unknown'>} */
  const unpriced = {};
  /** @type {string | null} */
  let intervalReason = null;
  for (const p of parts) {
    if (p.state === 'unknown') return p;
    if (p.state === 'known') { low += p.usd; high += p.usd; continue; }
    if (p.state === 'lower-bound') {
      lowerBound = true;
      low += p.usd; high += p.usd;
      for (const [k, v] of Object.entries(p.unpriced)) {
        const cur = unpriced[k];
        unpriced[k] = v === 'unknown' || cur === 'unknown' ? 'unknown' : (cur ?? 0) + v;
      }
      continue;
    }
    interval = true;
    intervalReason = intervalReason ?? p.reason;
    low += p.low; high += p.high;
  }
  if (interval) return { state: 'interval', low, high, reason: intervalReason ?? 'interval' };
  if (lowerBound) return { state: 'lower-bound', usd: low, unpriced };
  return { state: 'known', usd: low };
}

/**
 * The compaction charge K: read the whole prefix for the summary request, emit the summary,
 * write the post-compaction prefix (a cache write), the explicit verification cost, and the
 * assumed recovery tokens read back once. Verification is applied whatever the horizon,
 * including zero future calls.
 * @param {Tariff} t @param {number} prefixTokens @param {Envelope} env
 * @param {number} verificationUsd
 * @param {{ summaryRead: Cost }} reads the summary request's read of the prefix (interval, or assumed)
 */
export function compactionCharge(t, prefixTokens, env, verificationUsd, reads) {
  if (!finiteNonNegative(verificationUsd)) throw new BaselineInputError('verification-cost');
  /** @type {Cost} */
  const summaryOutput = t.output === undefined
    ? { state: 'unknown', reason: 'missing-rate:output' }
    : { state: 'known', usd: usd(env.summaryTokens.value, t.output) };
  /** @type {Cost} */
  const rebuildWrite = t.cacheWrite === undefined
    ? { state: 'unknown', reason: 'missing-rate:cache-write-5m' }
    : { state: 'known', usd: usd(env.postCompactionTokens.value, t.cacheWrite) };
  /** @type {Cost} */
  const recovery = t.uncachedInput === undefined
    ? { state: 'unknown', reason: 'missing-rate:uncached-input' }
    : { state: 'known', usd: usd(env.recoveryTokens.value, t.uncachedInput) };
  /** @type {Cost} */
  const verification = { state: 'known', usd: verificationUsd };
  return {
    summaryRead: reads.summaryRead,
    summaryOutput,
    rebuildWrite,
    verification,
    verificationLabel: verificationUsd === 0 ? /** @type {const} */ ('explicit-zero') : /** @type {const} */ ('explicit'),
    recovery,
    total: addCosts(reads.summaryRead, summaryOutput, rebuildWrite, verification, recovery),
  };
}

/**
 * Savings on ONE future call from a smaller prefix: the read of (prefix - postCompaction) tokens
 * that no longer happens. Same reuse question as any other read, so an interval on real data.
 * A post-compaction prefix no smaller than the current one saves nothing and says so.
 * @param {Tariff} t @param {number} prefixTokens @param {Envelope} env
 * @param {(tokens: number) => Cost} read
 * @returns {Cost}
 */
export function savingsPerCall(t, prefixTokens, env, read) {
  const delta = prefixTokens - env.postCompactionTokens.value;
  if (delta <= 0) return { state: 'known', usd: 0 };
  return read(delta);
}

/**
 * The ratio the F1 gate reads: continue-cost over compact-cost across the horizon, least
 * favourable to compaction. Defined only when both are known points and the compact cost is
 * positive; anything else is null with the reason, never NaN and never a false "no crossing".
 * @param {Cost} continueCost @param {Cost} compactCost @param {number} epsilon
 * @returns {{ least: number, epsilon: number, threshold: number, crossing: boolean } | { least: null, reason: string }}
 */
export function leastFavourableRatio(continueCost, compactCost, epsilon) {
  if (!(Number.isFinite(epsilon) && epsilon >= 0)) throw new BaselineInputError('epsilon');
  if (continueCost.state !== 'known') return { least: null, reason: `continue-cost-${continueCost.state}` };
  if (compactCost.state !== 'known') return { least: null, reason: `compact-cost-${compactCost.state}` };
  if (!(compactCost.usd > 0)) return { least: null, reason: 'compact-cost-not-positive' };
  const least = continueCost.usd / compactCost.usd;
  return { least, epsilon, threshold: 1 + epsilon, crossing: least > 1 + epsilon };
}

/**
 * Probability that a useful arrival lands inside the cache TTL, read as a LOWER BOUND from the
 * next-arrival quantiles E2b exposes. Three quantiles cannot place the probability exactly, so
 * this returns the largest quantile level whose gap is within the TTL, or unknown when the
 * quantiles are absent (a fit with no gaps yields null quantiles, and null in arithmetic is 0).
 * @param {{ p10: number | null, p50: number | null, p90: number | null } | undefined} nextArrivalSeconds
 * @param {number} ttlSeconds
 * @returns {{ state: 'lower-bound', value: number, basis: string } | { state: 'unknown', reason: string }}
 */
export function arrivalWithinTtl(nextArrivalSeconds, ttlSeconds) {
  if (!nextArrivalSeconds) return { state: 'unknown', reason: 'next-arrival-absent' };
  const { p10, p50, p90 } = nextArrivalSeconds;
  if (p10 === null || p50 === null || p90 === null) return { state: 'unknown', reason: 'next-arrival-quantile-null' };
  if (p90 <= ttlSeconds) return { state: 'lower-bound', value: 0.9, basis: 'p90-gap-within-ttl' };
  if (p50 <= ttlSeconds) return { state: 'lower-bound', value: 0.5, basis: 'p50-gap-within-ttl' };
  if (p10 <= ttlSeconds) return { state: 'lower-bound', value: 0.1, basis: 'p10-gap-within-ttl' };
  return { state: 'lower-bound', value: 0, basis: 'p10-gap-beyond-ttl' };
}

/**
 * Cost of ONE ping: read the whole prefix (warm by intent, but the reuse question still
 * applies: a ping that misses the cache paid cold), write the ping message, one output token,
 * and the future rereads of the ping message on each remaining call. Orchestration is unpriced
 * and named.
 * `remainingCalls` is the count of later calls that reread the ping message: an OBSERVED count on a
 * replay of the past, a horizon quantile on a forecast, and `null` when neither is known, in
 * which case the rereads and the total are unknown rather than a total missing one term.
 * @param {Tariff} t @param {number} prefixTokens @param {Envelope} env @param {number | null} remainingCalls
 * @param {(tokens: number) => Cost} read
 */
export function pingCharge(t, prefixTokens, env, remainingCalls, read) {
  if (remainingCalls !== null && !(Number.isInteger(remainingCalls) && remainingCalls >= 0)) throw new BaselineInputError('remaining-calls');
  /** @type {Cost} */
  const suffixWrite = t.cacheWrite === undefined
    ? { state: 'unknown', reason: 'missing-rate:cache-write-5m' }
    : { state: 'known', usd: usd(env.pingTokens.value, t.cacheWrite) };
  /** @type {Cost} */
  const output = t.output === undefined
    ? { state: 'unknown', reason: 'missing-rate:output' }
    : { state: 'known', usd: usd(1, t.output) };
  /** @type {Cost} */
  const rereads = remainingCalls === null
    ? { state: 'unknown', reason: 'remaining-calls-unknown' }
    : scaleCost(read(env.pingTokens.value), remainingCalls);
  const total = addCosts(read(prefixTokens), suffixWrite, output, rereads);
  return { prefixRead: read(prefixTokens), suffixWrite, output, rereads, orchestration: 'unpriced', total };
}
