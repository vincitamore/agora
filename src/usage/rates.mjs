// @ts-check
// E2a: dated rate table and priceUsage. Prices nothing from a missing rate,
// and an illustrative row prices nothing outside tests.
import { readInteger, readRecord, readString, readTimestamp } from '../protocol/common.mjs';
import { USAGE_COMPONENTS, validateSessionUsageRecord } from '../protocol/session-usage.mjs';

export const RATE_KEY_FIELDS = Object.freeze(/** @type {const} */ ([
  'provider', 'endpoint', 'modelRevision', 'serviceTier', 'region', 'billingMode',
]));

export const PRICE_COLUMNS = Object.freeze(/** @type {const} */ ([
  'publishedApi', 'providerReportedBill', 'subscriptionConsumption',
]));

export const RATE_QUALIFICATIONS = Object.freeze(/** @type {const} */ ([
  'qualified', 'unqualified',
]));

export const CONTEXT_FIELD_STATES = Object.freeze(/** @type {const} */ ([
  'known', 'unknown',
]));

export class RateError extends Error {
  /** @param {string} code @param {string} [detail] */
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'RateError';
    this.code = code;
  }
}

/**
 * @typedef {{
 *   provider: string, endpoint: string, modelRevision: string, serviceTier: string,
 *   region: string, billingMode: string,
 * }} RateKey
 * @typedef {RateKey & {
 *   effective: string,
 *   contextBracketMin: number,
 *   contextBracketMax: number,
 *   source: string,
 *   retrieved: string,
 *   qualification: 'qualified' | 'unqualified',
 *   illustrative?: boolean,
 *   publishedApi?: Record<string, { usdPerMillion: number }>,
 *   providerReportedBill?: Record<string, { usdPerMillion: number }>,
 *   subscriptionConsumption?: Record<string, { usdPerMillion: number }>,
 * }} RateRow
 */

/** @param {unknown} value @param {string} field */
function readKeyPart(value, field) {
  const s = readString(value, field, { min: 1, max: 128, controls: true });
  if (s.trim() === '') throw new RateError('blank-key', field);
  return s;
}

/** @param {unknown} value */
export function validateRateKey(value) {
  const v = readRecord(value, [...RATE_KEY_FIELDS], []);
  /** @type {RateKey} */
  const key = {
    provider: readKeyPart(v.provider, 'provider'),
    endpoint: readKeyPart(v.endpoint, 'endpoint'),
    modelRevision: readKeyPart(v.modelRevision, 'modelRevision'),
    serviceTier: readKeyPart(v.serviceTier, 'serviceTier'),
    region: readKeyPart(v.region, 'region'),
    billingMode: readKeyPart(v.billingMode, 'billingMode'),
  };
  return key;
}

/** @param {unknown} value */
/** @param {unknown} value @param {string} field */
function validateColumnMap(value, field) {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RateError('column-type', field);
  }
  /** @type {Record<string, { usdPerMillion: number }>} */
  const out = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!USAGE_COMPONENTS.includes(/** @type {any} */ (name))) {
      throw new RateError('unknown-component', `${field}.${name}`);
    }
    const rec = readRecord(entry, ['usdPerMillion'], []);
    const usd = rec.usdPerMillion;
    if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) {
      throw new RateError('usd-per-million', `${field}.${name}`);
    }
    out[name] = { usdPerMillion: usd };
  }
  return out;
}

/** @param {unknown} value */
export function validateRateRow(value) {
  const v = readRecord(value, [
    ...RATE_KEY_FIELDS, 'effective', 'contextBracketMin', 'contextBracketMax', 'source', 'retrieved', 'qualification',
  ], ['illustrative', ...PRICE_COLUMNS]);
  const min = readInteger(v.contextBracketMin, 'contextBracketMin', 0);
  const max = readInteger(v.contextBracketMax, 'contextBracketMax', 0);
  if (!(max > min)) throw new RateError('bracket-empty');
  const keyFields = {
    provider: v.provider, endpoint: v.endpoint, modelRevision: v.modelRevision,
    serviceTier: v.serviceTier, region: v.region, billingMode: v.billingMode,
  };
  /** @type {RateRow} */
  const row = {
    ...validateRateKey(keyFields),
    effective: readTimestamp(v.effective, 'effective'),
    contextBracketMin: min,
    contextBracketMax: max,
    source: readKeyPart(v.source, 'source'),
    retrieved: readTimestamp(v.retrieved, 'retrieved'),
    qualification: /** @type {'qualified'|'unqualified'} */ (readKeyPart(v.qualification, 'qualification')),
    ...(v.illustrative === true ? { illustrative: /** @type {const} */ (true) } : {}),
  };
  if (row.qualification !== 'qualified' && row.qualification !== 'unqualified') {
    throw new RateError('qualification', row.qualification);
  }
  if (v.illustrative !== undefined && v.illustrative !== true) {
    throw new RateError('illustrative', 'must be true or omitted');
  }
  for (const col of PRICE_COLUMNS) {
    const mapped = validateColumnMap(v[col], col);
    if (mapped) row[col] = mapped;
  }
  return row;
}

/** @param {unknown} value */
export function loadRateTable(value) {
  const v = readRecord(value, ['version', 'rows'], []);
  const version = readInteger(v.version, 'version', 1);
  if (version !== 1) throw new RateError('table-version');
  if (!Array.isArray(v.rows)) throw new RateError('rows-type');
  return { version: /** @type {const} */ (1), rows: v.rows.map((row) => validateRateRow(row)) };
}

/** @param {RateKey} key @param {RateRow} row */
function keyMatches(key, row) {
  return RATE_KEY_FIELDS.every((field) => key[field] === row[field]);
}

/**
 * Half-open [min, max). A count equal to a shared boundary belongs to the row
 * whose min is that boundary, never the row whose max is.
 * @param {number} tokens @param {RateRow} row
 */
export function bracketContains(tokens, row) {
  return tokens >= row.contextBracketMin && tokens < row.contextBracketMax;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {{ state: 'known', value: string } | { state: 'unknown' }}
 */
export function readBillingField(value, field) {
  const v = readRecord(value, ['state'], ['value']);
  const state = readKeyPart(v.state, `${field}.state`);
  if (state === 'unknown') {
    if (Object.hasOwn(v, 'value')) throw new RateError('unknown-carries-value', field);
    return { state: 'unknown' };
  }
  if (state !== 'known') throw new RateError('field-state', field);
  return { state: 'known', value: readKeyPart(v.value, field) };
}

/**
 * Versioned provenance. Each key field is known or unknown; a model label is not the key.
 * @param {unknown} value
 */
export function validateBillingContext(value) {
  const v = readRecord(value, [...RATE_KEY_FIELDS], ['version']);
  /** @type {Record<typeof RATE_KEY_FIELDS[number], { state: 'known', value: string } | { state: 'unknown' }>} */
  const fields = /** @type {any} */ ({});
  for (const field of RATE_KEY_FIELDS) {
    fields[field] = readBillingField(v[field], field);
  }
  return {
    version: Object.hasOwn(v, 'version') ? readInteger(v.version, 'version', 1) : 1,
    ...fields,
  };
}

/**
 * Per-request measured resident context. Lifetime totals are not a substitute.
 * @param {unknown} value
 * @returns {{ state: 'known', tokens: number } | { state: 'unknown' }}
 */
export function validateResidentContext(value) {
  const v = readRecord(value, ['state'], ['tokens']);
  const state = readKeyPart(v.state, 'residentContext.state');
  if (state === 'unknown') {
    if (Object.hasOwn(v, 'tokens')) throw new RateError('unknown-carries-tokens');
    return { state: 'unknown' };
  }
  if (state !== 'known') throw new RateError('resident-state');
  return { state: 'known', tokens: readInteger(v.tokens, 'tokens', 0) };
}

/**
 * Latest matching row whose bracket contains `tokens` and whose effective date is
 * not after eventTime and not after asOf. Illustrative rows are skipped unless
 * allowIllustrative is true. Unqualified rows never match.
 * @param {RateKey} key
 * @param {ReturnType<typeof loadRateTable>} table
 * @param {string} eventTime
 * @param {string} asOf
 * @param {number} tokens
 * @param {{ allowIllustrative?: boolean }} [opts]
 */
export function selectRateRow(key, table, eventTime, asOf, tokens, opts = {}) {
  const eventMs = Date.parse(eventTime);
  const asOfMs = Date.parse(asOf);
  if (!Number.isFinite(eventMs)) throw new RateError('event-time');
  if (!Number.isFinite(asOfMs)) throw new RateError('as-of');
  /** @type {RateRow | null} */
  let best = null;
  for (const row of table.rows) {
    if (row.qualification !== 'qualified') continue;
    if (row.illustrative && opts.allowIllustrative !== true) continue;
    if (!keyMatches(key, row)) continue;
    if (!bracketContains(tokens, row)) continue;
    const eff = Date.parse(row.effective);
    if (eff > eventMs || eff > asOfMs) continue;
    if (!best || Date.parse(best.effective) < eff) best = row;
  }
  return best;
}

/** @param {ReturnType<typeof validateBillingContext>} ctx */
function billingKeyOrNull(ctx) {
  /** @type {Partial<RateKey>} */
  const key = {};
  for (const field of RATE_KEY_FIELDS) {
    const part = ctx[field];
    if (part.state !== 'known') return null;
    key[field] = part.value;
  }
  return /** @type {RateKey} */ (key);
}

/** @param {ReturnType<typeof validateSessionUsageRecord>} record */
function reportedBill(record) {
  if (!Object.hasOwn(record, 'sourceReportedCost') || record.sourceReportedCost === undefined) {
    return { state: /** @type {const} */ ('unknown'), reason: 'source-reported-cost-absent' };
  }
  return record.sourceReportedCost;
}

/**
 * @param {unknown} recordValue
 * @param {ReturnType<typeof loadRateTable>} table
 * @param {{ eventTime: string, asOf: string }} times
 * @param {unknown} billingContextValue
 * @param {unknown} residentContextValue
 * @param {{ allowIllustrative?: boolean }} [opts]
 */
export function priceUsage(recordValue, table, times, billingContextValue, residentContextValue, opts = {}) {
  const record = validateSessionUsageRecord(recordValue);
  if (!times || typeof times !== 'object') throw new RateError('times-required');
  let eventTime;
  let asOf;
  try { eventTime = readTimestamp(times.eventTime, 'eventTime'); }
  catch { throw new RateError('event-time'); }
  try { asOf = readTimestamp(times.asOf, 'asOf'); }
  catch { throw new RateError('as-of'); }
  const billing = validateBillingContext(billingContextValue);
  const resident = validateResidentContext(residentContextValue);
  const bill = reportedBill(record);
  const subscriptionConsumption = { state: /** @type {const} */ ('unknown'), reason: 'not-observed' };

  /** @param {string} reason */
  const none = (reason) => {
    /** @type {Record<string, { tokens?: number, reason: string }>} */
    const unpriced = {};
    for (const name of USAGE_COMPONENTS) {
      const c = record.usage.components[name];
      if (!c) continue;
      unpriced[name] = {
        ...(c.state === 'known' && typeof c.value === 'number' ? { tokens: c.value } : {}),
        reason,
      };
    }
    return {
      apiEquivalent: { state: /** @type {const} */ ('unknown'), reason },
      reportedBill: bill,
      subscriptionConsumption,
      unpriced,
      coverage: 'none',
      row: null,
    };
  };

  const key = billingKeyOrNull(billing);
  if (!key) return none('billing-context-unknown');
  if (resident.state !== 'known') return none('context-unmeasured');

  const row = selectRateRow(key, table, eventTime, asOf, resident.tokens, opts);
  if (!row) return none('no-matching-rate');

  /** @type {Record<string, { usd: number, tokens: number }>} */
  const components = {};
  /** @type {Record<string, { tokens?: number, reason: string }>} */
  const unpriced = {};
  for (const name of USAGE_COMPONENTS) {
    const c = record.usage.components[name];
    if (!c) continue;
    if (c.state !== 'known' || typeof c.value !== 'number') {
      unpriced[name] = { reason: `counter-${c.state}` };
      continue;
    }
    const published = row.publishedApi?.[name];
    if (!published) {
      unpriced[name] = { tokens: c.value, reason: 'missing-rate' };
      continue;
    }
    components[name] = { usd: (c.value / 1_000_000) * published.usdPerMillion, tokens: c.value };
  }

  const pricedCount = Object.keys(components).length;
  const unpricedCount = Object.keys(unpriced).length;
  const coverage = pricedCount === 0 ? 'none'
    : unpricedCount === 0 ? 'complete'
      : 'partial';
  const apiEquivalent = pricedCount === 0
    ? { state: /** @type {const} */ ('unknown'), reason: 'missing-rate', unpriced }
    : { state: /** @type {const} */ ('known'), components, unpriced };
  return {
    apiEquivalent,
    reportedBill: bill,
    subscriptionConsumption,
    unpriced,
    coverage,
    row,
  };
}
