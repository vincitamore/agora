// E2b: horizon estimation over session histories.
//
// Answers three questions about a session that has already made `k` useful calls: how many more
// it will make, when the next one arrives, and whether it has just ended. Or it answers none of
// them and says why, which is the common case and the important one.
//
// Two commitments run through the whole file.
//
// A running session is NOT a completed short one. Sessions observed while still alive are
// right-censored: they tell us the total was AT LEAST what we saw, and dropping them or treating
// their partial count as final is the standard way to under-estimate a horizon. Kaplan-Meier is
// here for that reason alone, not for sophistication.
//
// Below the evidence threshold the answer is `unknown` with a reason and NO numbers. A quantile
// computed from four sessions is not a small number with wide error bars; it is a number the
// consumer cannot tell apart from a good one.

/** Comparable observations required before any number is produced. */
export const MIN_COMPARABLE = 30;

/** Nominal central interval the p10..p90 band is meant to cover. */
export const NOMINAL_COVERAGE = 0.8;

/** Coverage shortfall below nominal that counts as undercoverage. */
export const COVERAGE_MARGIN = 0.1;

/** Relative shift in median call count between fit and eval that counts as drift. */
export const DRIFT_RATIO = 0.5;

export class HorizonInputError extends Error {
  /** @param {string} code @param {string} [field] */
  constructor(code, field) {
    super(field ? `${code} at ${field}` : code);
    this.name = 'HorizonInputError';
    this.code = code;
    this.field = field;
  }
}

/** @param {unknown} v */
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/** @param {unknown} v @returns {v is string} */
const isIso = (v) => typeof v === 'string' && Number.isFinite(new Date(v).getTime());
/** @param {string} iso */
const ms = (iso) => new Date(iso).getTime();

/**
 * Build histories from ledger entries.
 *
 * This is where "a useful call" is defined, and it is defined once so no caller can redefine it
 * by accident. ONLY `sourceUnit: 'request'` counts. An aggregate already contains its children
 * and a cumulative snapshot is a running total of a session rather than a unit of work; counting
 * either as a call inflates every cadence it touches, and a single Codex `token_count` would
 * otherwise look like a call.
 *
 * @param {Array<{ identity: any, observedAt?: string }>} entries
 * @param {{ sessionKeyOf: (e: any) => string, classify: (e: any) => 'useful'|'maintenance'|'unknown', phaseOf?: (e: any) => string, endedAt?: (key: string) => string | null }} opts
 */
export function historiesFromLedger(entries, opts) {
  if (!Array.isArray(entries)) throw new HorizonInputError('entries-not-array');
  if (!opts || typeof opts.sessionKeyOf !== 'function' || typeof opts.classify !== 'function') {
    throw new HorizonInputError('classifier-required');
  }
  /** @type {Map<string, { sessionKey: string, harness: string, phase: string, events: any[], endedAt: string | null }>} */
  const bySession = new Map();
  let skippedNonRequest = 0;

  for (const entry of entries) {
    const id = entry && entry.identity;
    if (!isRecord(id)) throw new HorizonInputError('entry-identity-missing');
    if (id.sourceUnit !== 'request') { skippedNonRequest++; continue; }
    const key = opts.sessionKeyOf(entry);
    let h = bySession.get(key);
    if (!h) {
      h = {
        sessionKey: key,
        harness: String(id.harness),
        phase: opts.phaseOf ? String(opts.phaseOf(entry)) : 'unknown',
        events: [],
        endedAt: opts.endedAt ? opts.endedAt(key) : null,
      };
      bySession.set(key, h);
    }
    // observedAt is the ledger's FIRST-observation time for this identity: a duplicate never
    // replaces retained fields, so re-ingesting the same source gives the same cadence.
    h.events.push({ at: entry.observedAt, kind: opts.classify(entry) });
  }
  return { histories: [...bySession.values()], skippedNonRequest };
}

/** @param {any} h @param {string} cutoff */
function normalizeHistory(h, cutoff) {
  if (!isRecord(h)) throw new HorizonInputError('history-not-record');
  if (typeof h.sessionKey !== 'string' || !h.sessionKey) throw new HorizonInputError('sessionKey-required');
  if (!Array.isArray(h.events)) throw new HorizonInputError('events-not-array', h.sessionKey);
  if (h.endedAt !== null && h.endedAt !== undefined && !isIso(h.endedAt)) {
    throw new HorizonInputError('endedAt-not-iso', h.sessionKey);
  }
  let unclassified = false;
  /** @type {number[]} */
  const useful = [];
  for (const e of h.events) {
    if (!isRecord(e) || !isIso(e.at)) throw new HorizonInputError('event-at-not-iso', h.sessionKey);
    if (e.kind === 'unknown') { unclassified = true; continue; }
    if (e.kind === 'useful') useful.push(ms(e.at));
    else if (e.kind !== 'maintenance') throw new HorizonInputError('event-kind-unknown-value', h.sessionKey);
  }
  useful.sort((a, b) => a - b);
  return {
    sessionKey: h.sessionKey,
    harness: String(h.harness ?? 'unknown'),
    phase: String(h.phase ?? 'unknown'),
    unclassified,
    calls: useful.length,
    // endedAt absent means still running at the cutoff: right-censored, a LOWER bound.
    censored: h.endedAt === null || h.endedAt === undefined,
    endedAt: h.endedAt ?? cutoff,
    gaps: useful.slice(1).map((t, i) => (t - useful[i]) / 1000),
  };
}

/**
 * Kaplan-Meier survival over call counts. S(n) = P(total calls >= n).
 *
 * A censored session is at risk at every n up to what it has already reached and is never counted
 * as having stopped there. That is the whole reason for the estimator: a session still running
 * with 3 calls is evidence for "at least 3", not evidence for "exactly 3".
 * @param {{calls: number, censored: boolean}[]} sample
 */
export function survivalCurve(sample) {
  const maxCalls = sample.reduce((m, s) => Math.max(m, s.calls), 0);
  /** @type {number[]} */
  const s = [1];
  let running = 1;
  // maxCalls + 1, not maxCalls: a session that ended at the longest observed count must still be
  // counted as having STOPPED there, or the curve never falls and every horizon reads as open.
  for (let n = 1; n <= maxCalls + 1; n++) {
    // At risk: everyone who reached n-1, censored or not. Stopped: only sessions we SAW end
    // there. A censored session at n-1 leaves the risk set without ever counting as a stop,
    // which is the whole difference between "ended after 3 calls" and "had made 3 so far".
    const atRisk = sample.filter((x) => x.calls >= n - 1).length;
    const stopped = sample.filter((x) => !x.censored && x.calls === n - 1).length;
    if (atRisk > 0) running *= 1 - stopped / atRisk;
    s[n] = running;
  }
  return s;
}

/** @param {number[]} curve @param {number} n */
const survivalAt = (curve, n) => (n < curve.length ? curve[n] : curve[curve.length - 1]);

/**
 * Smallest additional-call count m with P(remaining > m | reached k) <= 1 - q.
 * @param {number[]} curve @param {number} k @param {number} q
 */
function remainingQuantile(curve, k, q) {
  const base = survivalAt(curve, k);
  if (!(base > 0)) return 0;
  for (let m = 0; m < curve.length + 1; m++) {
    if (survivalAt(curve, k + m + 1) / base <= 1 - q) return m;
  }
  return curve.length;
}

/** @param {number[]} xs @param {number} q */
function quantile(xs, q) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return s[i];
}

/**
 * @param {any[]} histories
 * @param {{ observationCutoff: string, split: { at: string }, predicateVersion?: string,
 *           minComparable?: number, subject?: { harness: string, phase: string, callsSoFar: number },
 *           declaredPlan?: number }} opts
 */
export function estimateHorizon(histories, opts) {
  if (!Array.isArray(histories)) throw new HorizonInputError('histories-not-array');
  if (!opts || !isIso(opts.observationCutoff)) throw new HorizonInputError('observationCutoff-required');
  if (!opts.split || !isIso(opts.split.at)) throw new HorizonInputError('split-at-required');

  const minComparable = opts.minComparable ?? MIN_COMPARABLE;
  const cutoff = opts.observationCutoff;
  const splitMs = ms(opts.split.at);
  const all = histories.map((h) => normalizeHistory(h, cutoff));

  const unclassifiedCount = all.filter((h) => h.unclassified).length;
  const usable = all.filter((h) => !h.unclassified);

  const subject = opts.subject ?? null;
  const comparable = subject
    ? usable.filter((h) => h.harness === subject.harness && h.phase === subject.phase)
    : usable;

  // Split by session AND by time. A session enters the fit only if it was already over before the
  // split; nothing observed after the split can inform a decision dated before it.
  const fit = comparable.filter((h) => ms(h.endedAt) <= splitMs);
  const evalSet = comparable.filter((h) => ms(h.endedAt) > splitMs);

  /** @type {any} */
  const base = {
    actuationAllowed: false,
    actuationReason: 'e2-shadow',
    unclassifiedSessions: unclassifiedCount,
    comparableSessions: comparable.length,
  };

  if (fit.length < minComparable) {
    return {
      status: 'unknown',
      reason: `comparable-observations-below-threshold: ${fit.length} < ${minComparable}`,
      horizonEligible: false,
      ...base,
      calibration: { splitAt: opts.split.at, fitSessions: fit.length, evalSessions: evalSet.length, coverage: null, residualSummary: null, drift: null },
      predictionLog: [],
    };
  }

  const curve = survivalCurve(fit);
  const k = subject ? subject.callsSoFar : 0;
  const p10 = remainingQuantile(curve, k, 0.1);
  const p50 = remainingQuantile(curve, k, 0.5);
  const p90 = remainingQuantile(curve, k, 0.9);

  const sBase = survivalAt(curve, k);
  const pTerminate = sBase > 0 ? 1 - survivalAt(curve, k + 1) / sBase : 1;

  const gaps = fit.flatMap((h) => h.gaps);

  // Calibration on the eval half only.
  const predictionLog = [];
  let covered = 0;
  const residuals = [];
  for (const h of evalSet) {
    const predicted = { p10: remainingQuantile(curve, 0, 0.1), p50: remainingQuantile(curve, 0, 0.5), p90: remainingQuantile(curve, 0, 0.9) };
    const actual = h.calls;
    // A censored session only falsifies the LOWER end: its true total is at least what we saw.
    const inside = h.censored ? actual >= predicted.p10 : actual >= predicted.p10 && actual <= predicted.p90;
    if (inside) covered++;
    residuals.push(actual - predicted.p50);
    predictionLog.push({ sessionKey: h.sessionKey, predicted, actual, censored: h.censored, inside });
  }
  const coverage = evalSet.length ? covered / evalSet.length : null;
  const undercovered = coverage !== null && coverage < NOMINAL_COVERAGE - COVERAGE_MARGIN;

  const medianFit = quantile(fit.map((h) => h.calls), 0.5) ?? 0;
  const medianEval = quantile(evalSet.map((h) => h.calls), 0.5);
  const drifted = medianEval !== null && medianFit > 0
    && Math.abs(medianEval - medianFit) / medianFit > DRIFT_RATIO;

  const horizonEligible = !undercovered && !drifted && coverage !== null;

  return {
    status: 'estimated',
    horizonEligible,
    ...base,
    // A declared plan is a FEATURE, never a count: it is reported so a consumer can weigh it and
    // it moves nothing here. Otherwise a session talks itself into a horizon.
    declaredPlan: opts.declaredPlan ?? null,
    remainingCalls: { p10, p50, p90, support: fit.length },
    nextArrivalSeconds: { p10: quantile(gaps, 0.1), p50: quantile(gaps, 0.5), p90: quantile(gaps, 0.9), support: gaps.length },
    pTerminate: { value: pTerminate, support: fit.length },
    // Expressed in CALLS, not money: this unit prices nothing, and a loss bound denominated in
    // dollars would smuggle a rate table in through the back door.
    immediateTerminationLossBound: {
      value: (1 - pTerminate) * p10,
      basis: 'useful-calls forgone if immediate termination is assumed and is wrong, bounded by the p10 remaining',
    },
    calibration: {
      splitAt: opts.split.at,
      fitSessions: fit.length,
      evalSessions: evalSet.length,
      coverage,
      residualSummary: { p10: quantile(residuals, 0.1), p50: quantile(residuals, 0.5), p90: quantile(residuals, 0.9) },
      drift: { drifted, medianFit, medianEval, ratio: DRIFT_RATIO },
      undercovered,
    },
    predictionLog,
  };
}
