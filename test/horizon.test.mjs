// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateHorizon, historiesFromLedger, survivalCurve,
  MIN_COMPARABLE, HorizonInputError,
} from '../src/economy/horizon.mjs';

const T0 = Date.UTC(2026, 8, 1, 0, 0, 0);
/** @param {number} offsetMinutes */
const iso = (offsetMinutes) => new Date(T0 + offsetMinutes * 60000).toISOString();
const CUTOFF = iso(100000);
const SPLIT = { at: iso(50000) };

/**
 * @param {string} key @param {number} calls @param {{ended?: boolean, startMin?: number, gapMin?: number, kind?: string}} [o]
 */
function session(key, calls, o = {}) {
  const start = o.startMin ?? 0;
  const gap = o.gapMin ?? 10;
  const events = [];
  for (let i = 0; i < calls; i++) events.push({ at: iso(start + i * gap), kind: o.kind ?? 'useful' });
  return {
    sessionKey: key, harness: 'claude-code', phase: 'build', events,
    endedAt: o.ended === false ? null : iso(start + calls * gap),
  };
}

/** N completed sessions of the given call count, all before the split. */
/** @param {number} n @param {number} calls @param {string} [prefix] */
const cohort = (n, calls, prefix = 's') =>
  Array.from({ length: n }, (_, i) => session(`${prefix}${i}`, calls, { startMin: 0 }));

const SUBJECT = { harness: 'claude-code', phase: 'build', callsSoFar: 0 };

// --- The threshold ------------------------------------------------------------------------------

test('below the comparable threshold the answer is unknown and carries NO numbers', () => {
  const few = cohort(MIN_COMPARABLE - 1, 5);
  const r = estimateHorizon(few, { observationCutoff: CUTOFF, split: SPLIT, subject: SUBJECT });
  assert.equal(r.status, 'unknown');
  assert.match(r.reason, /below-threshold/);
  assert.equal(r.horizonEligible, false);
  // The point of the cell: no number a consumer could mistake for an estimate.
  assert.ok(!('remainingCalls' in r), 'no remainingCalls');
  assert.ok(!('pTerminate' in r), 'no pTerminate');
  assert.ok(!('nextArrivalSeconds' in r), 'no nextArrivalSeconds');

  // The twin: one more comparable session and it estimates. Same shape, one row different.
  const enough = cohort(MIN_COMPARABLE, 5);
  const r2 = estimateHorizon(enough, { observationCutoff: CUTOFF, split: SPLIT, subject: SUBJECT });
  assert.equal(r2.status, 'estimated');
  assert.equal(typeof r2.remainingCalls.p50, 'number');
});

// --- Censoring ----------------------------------------------------------------------------------

test('a right-censored session is a LOWER BOUND, not a completed short one', () => {
  // Same observed counts, different endings. If censoring were ignored these would agree, and
  // the censored cohort would be reported as terminating early when it is still running.
  const completed = cohort(MIN_COMPARABLE, 3);
  const censored = Array.from({ length: MIN_COMPARABLE }, (_, i) =>
    session(`c${i}`, 3, { ended: false }));

  const cCurve = survivalCurve(completed.map(() => ({ calls: 3, censored: false })));
  const rCurve = survivalCurve(censored.map(() => ({ calls: 3, censored: true })));

  // Completed at 3: survival collapses to 0 past 3, because we watched them all stop.
  assert.equal(cCurve[4] ?? 0, 0, 'completed cohort has no survivors past its stopping point');
  // Censored at 3: nobody was seen to stop, so survival never collapses.
  assert.ok((rCurve[rCurve.length - 1] ?? 0) > 0, 'censored cohort is never driven to zero');
});

test('a session that ended after ONE call is in the tail, not dropped', () => {
  // Thirty long sessions and one that stopped immediately. The short one must move pTerminate.
  const many = cohort(MIN_COMPARABLE, 8);
  const withShort = [...many, session('short', 1)];
  const a = estimateHorizon(many, { observationCutoff: CUTOFF, split: SPLIT, subject: SUBJECT });
  const b = estimateHorizon(withShort, { observationCutoff: CUTOFF, split: SPLIT, subject: SUBJECT });
  assert.equal(b.comparableSessions, a.comparableSessions + 1, 'it is counted, not filtered out');
  assert.ok(b.pTerminate.value >= a.pTerminate.value, 'an immediate stop cannot lower termination risk');
});

// --- The plan is not a count --------------------------------------------------------------------

test('a declared plan is reported as a feature and moves no count', () => {
  const opts = { observationCutoff: CUTOFF, split: SPLIT, subject: SUBJECT };
  const without = estimateHorizon(cohort(MIN_COMPARABLE, 5), opts);
  const with_ = estimateHorizon(cohort(MIN_COMPARABLE, 5), { ...opts, declaredPlan: 500 });
  assert.equal(with_.declaredPlan, 500, 'it is carried, so a consumer can weigh it');
  assert.deepEqual(with_.remainingCalls, without.remainingCalls, 'and it moves nothing');
  assert.equal(with_.pTerminate.value, without.pTerminate.value);
  assert.equal(with_.horizonEligible, without.horizonEligible, 'a plan cannot buy eligibility');
});

// --- Classification -----------------------------------------------------------------------------

test('one unclassified event excludes the whole session, and is counted', () => {
  const clean = cohort(MIN_COMPARABLE, 5);
  const dirty = [...clean, {
    ...session('mixed', 3),
    events: [{ at: iso(0), kind: 'useful' }, { at: iso(10), kind: 'unknown' }],
  }];
  const r = estimateHorizon(dirty, { observationCutoff: CUTOFF, split: SPLIT, subject: SUBJECT });
  assert.equal(r.unclassifiedSessions, 1, 'reported, never silently dropped');
  assert.equal(r.comparableSessions, MIN_COMPARABLE, 'and excluded from the comparable set');

  // The twin: a maintenance event is classified, so its session stays in and simply adds no call.
  const withMaint = [...clean, {
    ...session('maint', 0),
    events: [{ at: iso(0), kind: 'maintenance' }],
  }];
  const r2 = estimateHorizon(withMaint, { observationCutoff: CUTOFF, split: SPLIT, subject: SUBJECT });
  assert.equal(r2.unclassifiedSessions, 0);
  assert.equal(r2.comparableSessions, MIN_COMPARABLE + 1);
});

test('aggregates and cumulative snapshots are not calls', () => {
  /** @param {string} unit @param {string} epoch */
  const entry = (unit, epoch) => ({
    identity: { harness: 'codex', sessionEpoch: epoch, sourceId: `${unit}-${epoch}`, sourceUnit: unit, finality: 'final' },
    observedAt: iso(0),
  });
  const { histories, skippedNonRequest } = historiesFromLedger(
    [entry('request', 'a'), entry('aggregate', 'a'), entry('cumulative-snapshot', 'a')],
    { sessionKeyOf: (e) => e.identity.sessionEpoch, classify: () => 'useful' },
  );
  assert.equal(skippedNonRequest, 2, 'the aggregate and the snapshot are refused as calls');
  assert.equal(histories[0].events.length, 1, 'only the request survives');
});

// --- The drift stop, watched to fire --------------------------------------------------------------

test('the drift stop FIRES on a synthetic shift, and stays quiet without one', () => {
  // Fit half: sessions that ended before the split, 4 calls each.
  const fit = Array.from({ length: MIN_COMPARABLE }, (_, i) => session(`f${i}`, 4, { startMin: 0 }));
  // Eval half: after the split. Same length in the quiet case.
  const evalSame = Array.from({ length: 10 }, (_, i) => session(`e${i}`, 4, { startMin: 60000 }));
  const quiet = estimateHorizon([...fit, ...evalSame], { observationCutoff: CUTOFF, split: SPLIT, subject: SUBJECT });
  assert.equal(quiet.calibration.drift.drifted, false, 'no shift, no stop');

  // Shifted: the same population suddenly runs four times longer.
  const evalShift = Array.from({ length: 10 }, (_, i) => session(`e${i}`, 16, { startMin: 60000 }));
  const shifted = estimateHorizon([...fit, ...evalShift], { observationCutoff: CUTOFF, split: SPLIT, subject: SUBJECT });
  assert.equal(shifted.calibration.drift.drifted, true, 'the stop fires on the shift');
  assert.equal(shifted.horizonEligible, false, 'and eligibility goes with it');
  // Both halves summarised the same censoring-aware way, so the numbers are comparable.
  assert.equal(shifted.calibration.drift.comparable, true);
  assert.equal(shifted.calibration.drift.medianFitKm, 4);
  assert.equal(shifted.calibration.drift.medianEvalKm, 16);
  assert.equal(quiet.calibration.drift.medianFitKm, quiet.calibration.drift.medianEvalKm,
    'the quiet twin agrees on both halves');
});

// --- Permission is granted, never computed --------------------------------------------------------

test('actuationAllowed is false even when the horizon is fully eligible', () => {
  const fit = Array.from({ length: MIN_COMPARABLE }, (_, i) => session(`f${i}`, 4));
  const ev = Array.from({ length: 10 }, (_, i) => session(`e${i}`, 4, { startMin: 60000 }));
  const r = estimateHorizon([...fit, ...ev], { observationCutoff: CUTOFF, split: SPLIT, subject: SUBJECT });
  assert.equal(r.horizonEligible, true, 'the fit is good');
  assert.equal(r.actuationAllowed, false, 'and that is still not permission');
  assert.equal(r.actuationReason, 'e2-shadow');

  // The twin: the unknown branch says the same thing, so a consumer never has to ask which.
  const u = estimateHorizon(cohort(2, 5), { observationCutoff: CUTOFF, split: SPLIT, subject: SUBJECT });
  assert.equal(u.actuationAllowed, false);
  assert.equal(u.actuationReason, 'e2-shadow');
});

// --- Inputs -------------------------------------------------------------------------------------

test('the cutoff is required, because censoring without one is not censoring', () => {
  assert.throws(() => estimateHorizon([], /** @type {any} */ ({ split: SPLIT })), HorizonInputError);
  assert.throws(() => estimateHorizon([], /** @type {any} */ ({ observationCutoff: 'yesterday', split: SPLIT })), HorizonInputError);
  // The twin: with both, an empty set is a legitimate unknown rather than a throw.
  const r = estimateHorizon([], { observationCutoff: CUTOFF, split: SPLIT, subject: SUBJECT });
  assert.equal(r.status, 'unknown');
});

// --- HOLD :1072 repairs -------------------------------------------------------------------------

test('a split at or after the observation cutoff is refused', () => {
  const many = cohort(MIN_COMPARABLE + 2, 3);
  // Grace's exact reproduction: cutoff before the split. Previously accepted, and it emitted
  // remainingCalls 5/5/5 -- which was curve.length, not a quantile of anything.
  assert.throws(
    () => estimateHorizon(many, { observationCutoff: iso(5000), split: { at: iso(9000) }, subject: SUBJECT }),
    /split-at-not-before-cutoff/,
  );
  assert.throws(
    () => estimateHorizon(many, { observationCutoff: iso(5000), split: { at: iso(5000) }, subject: SUBJECT }),
    /split-at-not-before-cutoff/,
  );
  // The twin: a split genuinely before the cutoff is ordinary and still works.
  const ok = estimateHorizon(many, { observationCutoff: CUTOFF, split: SPLIT, subject: SUBJECT });
  assert.equal(ok.status, 'estimated');
});

test('a fit with NO observed stop emits no stopping numbers at all', () => {
  // Every fit session still running. Nothing here supports a statement about ending.
  const running = Array.from({ length: MIN_COMPARABLE }, (_, i) => session(`r${i}`, 3, { ended: false }));
  const ev = Array.from({ length: 5 }, (_, i) => session(`e${i}`, 3, { startMin: 60000 }));
  const r = estimateHorizon([...running, ...ev], { observationCutoff: CUTOFF, split: SPLIT, subject: SUBJECT });

  assert.equal(r.status, 'estimated');
  assert.equal(r.observedStops, 0);
  assert.match(r.stoppingUnavailable, /no-observed-stop/);
  // The point of the cell: no fabricated number survives anywhere.
  assert.ok(!('remainingCalls' in r), 'no remainingCalls');
  assert.ok(!('pTerminate' in r), 'no pTerminate -- 0 would read as "termination is impossible"');
  assert.ok(!('immediateTerminationLossBound' in r), 'no loss bound');
  // Cadence is unaffected: it is about gaps, not endings.
  assert.equal(typeof r.nextArrivalSeconds.support, 'number');

  // The twin: one session observed ending restores exactly these fields, and the numbers are
  // quantiles rather than the length of an array.
  const withStop = [...running.slice(1), session('stopped', 3), ...ev];
  const r2 = estimateHorizon(withStop, { observationCutoff: CUTOFF, split: SPLIT, subject: SUBJECT });
  assert.equal(r2.observedStops, 1);
  assert.ok(!('stoppingUnavailable' in r2));
  assert.equal(typeof r2.pTerminate.value, 'number');
});

test('an unreached quantile is named open-ended, never the curve length', () => {
  // Mostly-censored fit with a single early stop: the low quantile resolves, the high one cannot.
  const sample = [
    ...Array.from({ length: MIN_COMPARABLE - 1 }, (_, i) => session(`c${i}`, 6, { ended: false })),
    session('stop', 1),
  ];
  const ev = Array.from({ length: 5 }, (_, i) => session(`e${i}`, 6, { startMin: 60000 }));
  const r = estimateHorizon([...sample, ...ev], { observationCutoff: CUTOFF, split: SPLIT, subject: SUBJECT });
  assert.equal(r.observedStops, 1);
  // The invariant, whichever shape it takes: nothing unresolved is filled in with a number.
  if ('remainingCallsUnavailable' in r) {
    assert.ok(!('remainingCalls' in r), 'the field is absent, not present and meaningless');
    assert.match(r.remainingCallsUnavailable, /open-ended/);
  } else {
    const reported = r.remainingCalls;
    const openEnded = reported.openEnded ?? [];
    for (const key of ['p10', 'p50', 'p90']) {
      assert.equal(key in reported, !openEnded.includes(key), `${key} is either reported or named open-ended`);
    }
    assert.ok(openEnded.length > 0, 'a mostly-censored fit leaves at least one quantile open-ended');
  }
});

test('one pre-retention entry costs its own session, not the whole call', () => {
  /** @param {string} epoch @param {string | null} at */
  const entry = (epoch, at) => ({
    identity: { harness: 'claude-code', sessionEpoch: epoch, sourceId: `s-${epoch}`, sourceUnit: 'request', finality: 'final' },
    ...(at ? { observedAt: at } : {}),
  });
  const good = Array.from({ length: MIN_COMPARABLE }, (_, i) => entry(`g${i}`, iso(i)));
  const legacy = entry('legacy', null);          // pre-retention: no observedAt at all
  const { histories } = historiesFromLedger([...good, legacy], {
    sessionKeyOf: (e) => e.identity.sessionEpoch,
    classify: () => 'useful',
    phaseOf: () => 'build',
    endedAt: () => iso(90000),
  });
  const r = estimateHorizon(histories, { observationCutoff: CUTOFF, split: SPLIT, subject: SUBJECT });
  assert.equal(r.status, 'estimated', 'the thirty good sessions still estimate');
  assert.equal(r.unclassifiedSessions, 1, 'and the legacy one is excluded and counted');

  // The twin: give the legacy entry a time and nothing is excluded.
  const { histories: h2 } = historiesFromLedger([...good, entry('legacy', iso(1))], {
    sessionKeyOf: (e) => e.identity.sessionEpoch, classify: () => 'useful',
    phaseOf: () => 'build', endedAt: () => iso(90000),
  });
  const r2 = estimateHorizon(h2, { observationCutoff: CUTOFF, split: SPLIT, subject: SUBJECT });
  assert.equal(r2.unclassifiedSessions, 0);
});

test('a STATIONARY population does not drift, even though the fit half is truncated', () => {
  // Grok/experience's exhibit at :1081, kept as the regression. Every session makes 20 calls.
  // Thirty start before the split and are truncated there; ten start after and are seen whole.
  // Comparing raw counts read 10 against 20 and fired the stop on a process that never changed.
  const before = Array.from({ length: MIN_COMPARABLE }, (_, i) => session(`b${i}`, 20, { startMin: 0, gapMin: 10 }));
  const after = Array.from({ length: 10 }, (_, i) => session(`a${i}`, 20, { startMin: 60000, gapMin: 10 }));
  const r = estimateHorizon([...before, ...after], {
    observationCutoff: CUTOFF, split: { at: iso(100) }, subject: SUBJECT,
  });

  assert.equal(r.calibration.drift.drifted, false, 'a stationary process must not fire the stop');

  // And it is honest about WHY rather than claiming calibration: with no fit session ending
  // before the split there is no median to place, so the comparison is unavailable and
  // eligibility fails closed. "Cannot assess" is not "no drift".
  assert.equal(r.calibration.drift.comparable, false);
  assert.match(r.calibration.drift.reason, /median-unreachable/);
  assert.equal(r.horizonEligible, false, 'unassessable drift fails closed');

  // The twin that must still fire: same shape, but the later half genuinely runs longer.
  const longer = Array.from({ length: 10 }, (_, i) => session(`l${i}`, 60, { startMin: 60000, gapMin: 10 }));
  const shifted = estimateHorizon([...before.map((s, i) => session(`s${i}`, 4, { startMin: 0 })), ...longer], {
    observationCutoff: CUTOFF, split: SPLIT, subject: SUBJECT,
  });
  assert.equal(shifted.calibration.drift.drifted, true, 'a real length shift still fires');
});
