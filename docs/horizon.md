# Horizon estimation

How many more useful calls a session will make, when the next one arrives, and whether it has
just ended — or `unknown` with a reason, which is the common answer and the important one.

It estimates. It grants nothing: `actuationAllowed` is `false` on every output of this unit,
reason `e2-shadow`, and a consumer copies it rather than recomputing it.

## The two claims this module keeps apart

`horizonEligible` says **the fit is calibrated**: coverage met its nominal band and no drift was
detected. It is measured and can be true.

`actuationAllowed` says **something may act on it**. It is granted, not computed, and in this cut
it is always false. These were one field in the first draft of the seam, which is a mistake worth
naming: a perfectly calibrated estimate in a shadow-only deployment is still not permission, and a
field derived from calibration turns itself on the day the fit improves, with nobody deciding it.

## What counts as a call

One ledger entry with `sourceUnit: 'request'`. `historiesFromLedger` enforces it and reports
`skippedNonRequest`.

An `aggregate` already contains its children, and a `cumulative-snapshot` is a running total of a
session rather than a unit of work. A single Codex `token_count` is one snapshot of a whole
session; counted as a call it would inflate every cadence it touches.

Event times are `observedAt` from the ledger, which is the **first** observation of an identity:
a duplicate never replaces retained fields, so re-ingesting the same source yields the same
cadence rather than drifting later with each replay.

## Censoring, which is most of the difficulty

`endedAt: null` means the session was still running at `observationCutoff`. It is **right-censored**:
evidence that the total was *at least* what we saw, and not a completed short session.

Treating a running session as complete is the standard way to under-estimate a horizon, and
dropping it is only slightly better — the sessions still running are exactly the long ones. So the
survival curve counts a censored session as at-risk up to what it reached and never as having
stopped there. That is the whole reason a Kaplan-Meier estimator is here.

A session that **ended** after one call is the opposite case and is kept: a real observation of
zero-remaining, in the tail rather than discarded as noise.

## When it refuses

Below `MIN_COMPARABLE` (30) comparable sessions — same harness and phase — the result is
`status: 'unknown'` with a reason and **no numbers at all**: no `remainingCalls`, no `pTerminate`,
no `nextArrivalSeconds`.

A quantile computed from four sessions is not a good number with wide error bars. It is a number
the consumer cannot distinguish from a well-supported one, and every field carries its `support`
count for the same reason.

A session with any event the caller's predicate classified as `unknown` is excluded whole and
counted in `unclassifiedSessions`. It never becomes a one-row cadence and never defaults to
useful.

## Calibration and the drift stop

The split at `opts.split.at` must be strictly before `observationCutoff`; a split in the future of
the observation is refused, because every session would land in the fit half and the "evaluation"
would be on data the fit already saw.

The partition is by session **and** by time, and it is subtler than "ended before the split". A
session that *started* before the split was evidence available at the split, so it enters the fit
— but truncated there, counting only the calls it had made by then, and marked censored if it ran
on. Requiring sessions to have *ended* before the split instead puts every long-running session in
the evaluation half by construction, biasing the fit toward short sessions and, when everything is
still running, emptying it. Nothing after the split enters the fit's counts, so no later revision
informs an earlier decision.

`coverage` is the fraction of eval sessions whose actual fell inside the predicted p10..p90.
A censored eval session can only falsify the lower end — its true total is at least what we saw —
so it is scored against p10 alone.

An eval session whose predicted bound is **open-ended** cannot be scored at all — "did the actual
fall inside an interval with no upper end" has no answer — so it is counted in `unscorable` beside
the coverage rather than treated as covered, which would inflate coverage exactly where the
estimator knows least.

### Drift compares the same quantity on both halves

This is harder than it looks, and two natural comparisons are both wrong.

**Raw call counts** fail because the fit half is truncated at the split while the eval half is
counted whole. A perfectly stationary population — every session making twenty calls — reads as
median 10 against median 20 and fires the stop on a process that never changed.

**A raw median over a censored sample** fails for the reason the whole module exists: it treats
"had made 3 so far" as "made 3", re-importing the under-count through the diagnostic.

So both halves are summarised the same censoring-aware way: a Kaplan-Meier median over each
half's own curve, reported as `medianFitKm` and `medianEvalKm`. When either half cannot place a
median — too censored, too short — the comparison is `comparable: false` with a reason, and
eligibility **fails closed**. An undetectable shift is not an absent one, and "cannot assess" is
not "no drift".

Undercoverage or a detected shift sets `horizonEligible: false` with the measured reason. The stop
is exercised by cells that watch it fire on a real length shift and stay quiet on a stationary
population — a guard nobody has observed failing is a guard nobody has tested.

## Nothing about stopping without an observed stop

Every stopping quantity rests on having watched at least one session end. A fit of nothing but
running sessions supports none of them, so `remainingCalls`, `pTerminate` and
`immediateTerminationLossBound` are **absent** with `stoppingUnavailable` naming the reason, and
`observedStops` reports the count. A computed `pTerminate` of 0 would read as "termination is
impossible" when the truth is that no ending has ever been observed.

Arrival cadence is unaffected: it is about gaps between calls, not endings.

A quantile the survival curve never crosses is **open-ended**. It is omitted and named in
`openEnded`, never filled in with the length of the array the curve happened to occupy — a number
with no meaning that a consumer cannot distinguish from a real one.

## A declared plan is a feature, not a count

If a caller states it intends twenty more calls, that is reported as `declaredPlan` so a consumer
can weigh it. It moves no quantile, no `pTerminate`, and cannot make an ineligible horizon
eligible. Otherwise a session talks itself into a horizon it has no evidence for.

## Loss is denominated in calls

`immediateTerminationLossBound` is the expected useful calls forgone if immediate termination is
assumed and that assumption is wrong, bounded by the p10 remaining.

It is not money. This unit prices nothing, and a bound in dollars would smuggle a rate table in
through a field nobody was reviewing as pricing.
