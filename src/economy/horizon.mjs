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
    //
    // A pre-retention entry has none. That makes ITS session unclassified -- the same treatment
    // as any event the caller could not classify -- and never fails the call: one legacy row must
    // not discard thirty good sessions alongside it.
    const at = entry.observedAt;
    h.events.push(isIso(at)
      ? { at, kind: opts.classify(entry) }
      : { at: null, kind: 'unknown', reason: 'observed-at-absent' });
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
    if (!isRecord(e)) throw new HorizonInputError('event-not-record', h.sessionKey);
    // Classification first: an event nobody could classify contributes no time and needs none.
    // Demanding the timestamp before reading the kind is what turned one untimed legacy row into
    // a failure for every session in the call.
    if (e.kind === 'unknown') { unclassified = true; continue; }
    if (!isIso(e.at)) throw new HorizonInputError('event-at-not-iso', h.sessionKey);
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
    callTimes: useful,
    firstEventMs: useful.length ? useful[0] : null,
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
  // NEVER curve.length. If the curve never crosses the threshold the quantile is open-ended, and
  // returning the length of the array we happened to build is a number with no meaning that a
  // consumer cannot tell from a real one.
  return null;
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
  // A split in the future of the observation is not a split: every session would fall in the fit
  // half by default, and the "evaluation" would be on data the fit already saw.
  if (ms(opts.split.at) >= ms(opts.observationCutoff)) {
    throw new HorizonInputError('split-at-not-before-cutoff', 'split.at');
  }

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

  // Split by session AND by time, and this is subtler than "ended before the split".
  //
  // A session that STARTED before the split is evidence available at the split, so it belongs in
  // the fit -- but only as much of it as had happened by then. It is truncated at the split and
  // marked censored if it ran on, exactly as a session still running at the observation cutoff is
  // censored there. Requiring the session to have ENDED before the split instead puts every
  // long-running session in the evaluation half by construction, which silently biases the fit
  // toward short sessions and, in the extreme, empties it.
  //
  // Nothing after the split enters the fit's counts, so no later revision informs a past decision.
  const fit = comparable
    .filter((h) => h.firstEventMs !== null && h.firstEventMs < splitMs)
    .map((h) => ({
      ...h,
      calls: h.callTimes.filter((tms) => tms < splitMs).length,
      censored: h.censored || ms(h.endedAt) > splitMs,
    }));
  const evalSet = comparable.filter((h) => h.firstEventMs !== null && h.firstEventMs >= splitMs);

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
  // Every stopping quantity rests on having SEEN a session stop. A fit of nothing but running
  // sessions supports none of them: pTerminate would compute to 0, which reads as "termination is
  // impossible" when the truth is that we have never watched one end.
  const observedStops = fit.filter((h) => !h.censored).length;
  const p10 = remainingQuantile(curve, k, 0.1);
  const p50 = remainingQuantile(curve, k, 0.5);
  const p90 = remainingQuantile(curve, k, 0.9);
  const openEnded = [['p10', p10], ['p50', p50], ['p90', p90]].filter(([, v]) => v === null).map(([n]) => n);

  const sBase = survivalAt(curve, k);
  const pTerminate = sBase > 0 ? 1 - survivalAt(curve, k + 1) / sBase : 1;

  const gaps = fit.flatMap((h) => h.gaps);

  // Calibration on the eval half only.
  const predictionLog = [];
  let covered = 0;
  let scored = 0;
  let unscorable = 0;
  const residuals = [];
  for (const h of evalSet) {
    const predicted = { p10: remainingQuantile(curve, 0, 0.1), p50: remainingQuantile(curve, 0, 0.5), p90: remainingQuantile(curve, 0, 0.9) };
    const actual = h.calls;
    // An open-ended bound cannot be scored: "did the actual fall inside an interval with no upper
    // end" is not a question with an answer, and counting it as covered would inflate coverage
    // exactly where the estimator knows least.
    const lo = predicted.p10;
    const hi = predicted.p90;
    if (lo === null || (!h.censored && hi === null)) {
      unscorable++;
      predictionLog.push({ sessionKey: h.sessionKey, predicted, actual, censored: h.censored, inside: null, unscorable: 'open-ended-bound' });
      continue;
    }
    // A censored session only falsifies the LOWER end: its true total is at least what we saw.
    const inside = h.censored ? actual >= lo : actual >= lo && actual <= /** @type {number} */ (hi);
    scored++;
    if (inside) covered++;
    if (predicted.p50 !== null) residuals.push(actual - predicted.p50);
    predictionLog.push({ sessionKey: h.sessionKey, predicted, actual, censored: h.censored, inside });
  }
  // Coverage is over what could actually be scored, and the unscorable count travels beside it so
  // a high coverage over two sessions cannot masquerade as a calibrated fit.
  const coverage = scored ? covered / scored : null;
  const undercovered = coverage !== null && coverage < NOMINAL_COVERAGE - COVERAGE_MARGIN;

  // Drift must compare the SAME QUANTITY on both halves, and two obvious comparisons do not.
  //
  // Raw call counts fail because fit sessions are truncated at the split while eval sessions are
  // counted whole: a perfectly stationary process reads as median 10 against median 20 and fires
  // the stop on nothing. A raw median over a sample containing censored sessions fails for the
  // second reason -- it treats "had made 3 so far" as "made 3", which is the same under-count the
  // estimator exists to avoid, arriving through the diagnostic instead.
  //
  // So both halves are summarised the SAME censoring-aware way: a Kaplan-Meier median over each
  // half's own curve. When either half cannot reach its median -- too censored, too short -- the
  // comparison is UNAVAILABLE rather than false. An undetectable shift is not an absent one, and
  // eligibility fails closed on it.
  const evalCurve = survivalCurve(evalSet);
  // The median is the LARGEST count still reached by more than half, not the first count that
  // falls below: a cohort that all ended at 4 has a median of 4, and reporting 5 would name a
  // count nobody made.
  /** @param {number[]} c */
  const medianFromCurve = (c) => {
    let last = null;
    for (let n = 0; n < c.length; n++) if (c[n] > 0.5) last = n;
    // null when the curve never falls below half: too censored to place a median.
    return last !== null && last < c.length - 1 ? last : null;
  };
  const medianFit = medianFromCurve(curve);
  const medianEval = medianFromCurve(evalCurve);

  const driftComparable = medianFit !== null && medianFit > 0 && medianEval !== null;
  const drifted = driftComparable
    && Math.abs(/** @type {number} */ (medianEval) - medianFit) / medianFit > DRIFT_RATIO;

  const horizonEligible = !undercovered && driftComparable && !drifted && coverage !== null;

  return {
    status: 'estimated',
    horizonEligible,
    ...base,
    // A declared plan is a FEATURE, never a count: it is reported so a consumer can weigh it and
    // it moves nothing here. Otherwise a session talks itself into a horizon.
    declaredPlan: opts.declaredPlan ?? null,
    // With no observed stop, every stopping field is ABSENT with a reason rather than present
    // and meaningless. Arrival cadence is unaffected: it is about gaps between calls, not endings.
    ...(observedStops === 0
      ? { stoppingUnavailable: 'no-observed-stop-in-fit: every fit session is right-censored' }
      : {
        ...(p10 === null && p50 === null && p90 === null
          ? { remainingCallsUnavailable: 'open-ended: the survival curve never crosses any quantile' }
          : {
            remainingCalls: {
              ...(p10 === null ? {} : { p10 }),
              ...(p50 === null ? {} : { p50 }),
              ...(p90 === null ? {} : { p90 }),
              support: fit.length,
              ...(openEnded.length ? { openEnded } : {}),
            },
          }),
        pTerminate: { value: pTerminate, support: fit.length },
        // Expressed in CALLS, not money: this unit prices nothing, and a loss bound denominated
        // in dollars would smuggle a rate table in through the back door.
        ...(p10 === null ? {} : {
          immediateTerminationLossBound: {
            value: (1 - pTerminate) * p10,
            basis: 'useful-calls forgone if immediate termination is assumed and is wrong, bounded by the p10 remaining',
          },
        }),
      }),
    observedStops,
    nextArrivalSeconds: { p10: quantile(gaps, 0.1), p50: quantile(gaps, 0.5), p90: quantile(gaps, 0.9), support: gaps.length },
    calibration: {
      splitAt: opts.split.at,
      fitSessions: fit.length,
      evalSessions: evalSet.length,
      coverage,
      scored,
      unscorable,
      residualSummary: { p10: quantile(residuals, 0.1), p50: quantile(residuals, 0.5), p90: quantile(residuals, 0.9) },
      drift: {
        drifted,
        comparable: driftComparable,
        ...(driftComparable ? {} : {
          reason: medianFit === null
            ? 'fit-median-unreachable: too censored to estimate a median call count'
            : 'eval-median-unreachable: too censored or too short to estimate a median call count',
        }),
        // Both are Kaplan-Meier medians over each half's own curve, so censoring is handled the
        // same way on both sides and neither is a raw average over partial observations.
        medianFitKm: medianFit,
        medianEvalKm: medianEval,
        ratio: DRIFT_RATIO,
      },
      undercovered,
    },
    predictionLog,
  };
}
