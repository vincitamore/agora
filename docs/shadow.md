# The shadow optimizer

`src/economy/shadow.mjs` and `src/economy/baselines.mjs` are the E2c unit, and `agora economy
shadow` is its verb. It replays an E1 ledger through E2a pricing (`priceUsage`) and the E2b
horizon (`estimateHorizon`) and emits, for every decision point of every session, the competing
trajectories with their costs, the three baselines, and why no action won.

It calls no provider, actuates nothing, and every output carries `shadow: true` and
`actuationAllowed: false`. `horizonEligible` is copied from the horizon per decision; nothing here
recomputes it.

## What the verb reads

```
agora economy shadow --ledger-root <dir> --rates <file> --billing-context <file> --envelope <file>
  --verification-cost <usd> --epsilon <n> --risk-budget <0.1|0.5|0.9>
  --as-of <iso> --observation-cutoff <iso> --split-at <iso>
  [--classify all-requests-useful|unknown] [--ended-after <s>] [--session <harness>/<epoch>] [--json]
```

Every argument is refused, missing or malformed, with exit 2 before any file is read, and the verb
never loads the seat's config: a machine with no `agora.json` replays a ledger. Timestamps are
ISO-8601 UTC with milliseconds, the form the ledger stores. `--risk-budget` is one of the three
quantiles E2b exposes and selects which one the conservative scenario reads; it is not
interpolated. `--verification-cost` is finite and non-negative; zero is admitted only as the
literal and is labelled `explicit-zero` on every line that rests on it, and it is charged at zero
future calls too.

`--rates` is an E2a table (`data/rates.json` shape). There is no default: the table priced against
is named in the invocation. Illustrative rows price nothing here; the verb has no
`--allow-illustrative`.

`--billing-context` is a file of the `data/billing-contexts.example.json` shape, and you write your
own for your seat (the example is one seat's record: a subscription Claude Code, a subscription
Codex, an xAI Amore Build; a seat on the API prices against a different billing mode and must say
so): `version`, `retrieved`, and under `harnesses`
one entry per harness carrying `provider`, `endpoint`, `serviceTier`, `region`, `billingMode`, each
`{ state: 'known', value, source }` or `{ state: 'unknown', reason }`. A known field without a
source is refused. `modelRevision` is refused in the file: it is per record, read from the retained
`model`; a record with no model has an unknown revision and prices nothing. A harness the file does
not name is every-field-unknown. For Claude Code on this seat's subscription the shipped file names
provider `anthropic`, endpoint `messages`, tier `standard` (measured on the seat's own usage envelopes), region `global` (the cited pricing page
is region-less, and the source says so), billing mode `subscription`; the other harnesses are
unknown where no sourced record exists, which leaves their API-equivalent column unpriced.

`--envelope` carries the scenario dimensions the caller ASSUMES, each `{ value, source }`:
`summaryTokens`, `postCompactionTokens`, `recoveryTokens`, `pingTokens`, `cacheTtlSeconds`.
`data/shadow-envelope.example.json` is one such file with its assumptions sourced to the design
record. A file naming `prefixReuse` is refused: E2 rules prefix reuse unassessable until a
resident-context seam exists, and an envelope that carried it would be an assumption dressed as a
measurement.

## Resident context

Per request, the resident prompt is the sum of the input pools when every one is known, with
`basis: 'sum-of-input-pools'` on the row: `uncached-input`, `cached-input`, and the cache writes.
The writes are one measurement an adapter states in one of two forms, never both: the
`cache-write-5m` + `cache-write-1h` split when the TTLs are known (Claude Code), or the single
`cache-write-unknown-ttl` bucket when they are not (Codex); the sum takes whichever form the
record carries; a record carrying neither has unknown writes (`pool-absent:cache-write`), and a
record carrying both is refused (`pool-both-forms:cache-write`) rather than summed twice.
Measured on this seat's real Claude records: every one carries the split and none carries the
pooled bucket, so a literal five-pool rule would have left every real record unmeasured. A
`not-applicable` pool contributes nothing; an `unknown` or `invalid` pool, or an absent
`uncached-input` / `cached-input`, leaves the context unknown and the request unpriced
(`context-unmeasured`). Lifetime totals are never substituted.

## The classify rule and the session-end rule

The ledger has no field that separates a watch wake from a useful request. The default rule is
that every `request` entry is useful, and every horizon line that rests on it carries
`{ classify: 'all-requests-useful', assumption: 'no-maintenance-evidence-in-ledger' }`.
`--classify unknown` classifies nothing and yields a horizon `unknown` by construction.

The ledger has no session-end evidence either. Without `--ended-after` every session is
right-censored at the observation cutoff, which leaves every stopping quantity absent
(`stoppingUnavailable`) and every ratio null. With `--ended-after <s>`, a session quiet for longer
than that before the cutoff is treated as ended at its last request, and every horizon line says
so: `{ sessionEnd: 'quiet-past-<s>s-means-ended-at-last-request' }`.

## The forward model

At decision point `k` (after the `k`-th request of a session) with resident prefix `P`, tariff from
the row `priceUsage` selected for that request, horizon `H` = the remaining-calls quantile named by
the risk budget, and envelope `E`:

- **continue**: `H` reads of `P`. Prefix growth is assumed 0 (constant-prefix approximation, named
  on the row).
- **compactCold**: `K + H` reads of `E.postCompactionTokens`, where `K` = a cold read of `P` (the
  summary request) + `E.summaryTokens` of output + a cache write of `E.postCompactionTokens` + the
  verification cost + an uncached read of `E.recoveryTokens`. `K` is itemised on the row.
- **compactWarm**: one warming ping (a cold read of `P`, the ping write, one output token) then a
  warm summary read, then the same rebuild, verification, recovery and future reads. It is compared
  as ONE sequence against cold compaction; at non-negative rates it never beats it, and the log
  shows that rather than assuming it.
- **ping**: continue plus `ceil(p50 gap / ttl) - 1` pings per remaining call, each a read of `P`, a
  ping write, one output token and the rereads of the ping message on the horizon's remaining
  calls; an unknown horizon leaves the ping unknown, never a total missing its rereads term.
  Orchestration is unpriced and named. The ping's benefit (a warm rather than cold later read) rests on prefix
  reuse, which is unassessable, so it is reported as such rather than credited.

Every cost is a state, never a bare number: `known`, `lower-bound` (with the unpriced tokens
beside it), `interval` (the two prefix-reuse extremes, all-warm to all-cold), or `unknown` with a
reason. Adding an unknown yields unknown; adding an interval widens; a lower bound stays one.

The **ratio** is continue over compactCold. It is defined only when the decision is after the split
(no leakage), the horizon is `estimated` and `horizonEligible`, the remaining-calls quantile is
present, every envelope dimension is measured or assumed with a source, the request priced, and
both costs are known points. Then `crossing` is `least > 1 + epsilon`. Otherwise the ratio is null
with the first reason and the verdict is `shadow-only`. **On real data prefix reuse is
unassessable, so every future read is an interval and the ratio is always null**: that is the
honest E2 result, and the verb has no way to change it. The library's `prefixReuse: { value,
source }` option exists so tests can exercise the crossing arithmetic under a stated assumption;
the verb never passes it.

Baselines per session: `neverCompact` is the observed priced spend of every request (unknown if any
is unpriced, a lower bound if any is partial); `alwaysCompact` is `K` at every decision point;
`periodicPing` is the observed spend plus `ceil(measured gap / ttl) - 1` pings per observed gap,
each ping's rereads counted over the session's OBSERVED remaining calls, never the horizon: a
replay of the past has no forecast in it.
Both counterfactuals say so in `basis`. Latency and completed-work quality are `unknown` on every
trajectory and baseline, always.

## What it refuses to price

Each is a reason on the row and never a zero:

- a request whose `priceUsage` coverage is `none` (`billing-context-unknown`,
  `context-unmeasured`, `no-matching-rate`);
- a `conflict` or `gap` entry: it still counts as a call for cadence, and is unpriced
  `status-<state>`; a `provisional` entry is priced and counted as provisional;
- a trajectory containing a partial-coverage request: `lower-bound`, never a total. A component
  measured at zero tokens with no rate costs exactly nothing at any rate and does not lower a
  total; a non-zero count with no rate, or an unknown count, does;
- a component rate the selected row lacks: `unknown missing-rate:<component>`;
- a session with no request-unit entries (Codex, Amore Build): listed with marker `unassessable`,
  reason `no-request-unit-entries`, and its totals;
- a session with a pre-retention row (no `observedAt`): marker `unclassified`, reason
  `observed-at-absent`, the entries named, and the horizon excludes the session rather than fitting
  a one-row cadence;
- a decision point before `--split-at`: `leakage-before-split`, shadow-only, because the fit saw
  that session's own future.

## Reading a session total

`totals` is `deriveTotals` over the session's entries. Note the Codex-reset clause, measured at
`reconcileRevision`: a cumulative snapshot committed with `reset` lands **confirmed** and sums into
`snapshot.confirmed`; one without reset lands provisional and sits in `snapshot.provisional`. "Codex
entries land provisional" is true on the default path and false on a reset, so a consumer that reads
only provisional for Codex misses every reset snapshot. This replay reports both.

## The silent-number enumeration

Paths that would return a well-formed number instead of an error, each pinned by a cell:

- (a) `nextArrivalSeconds.p50` null (a fit with no gaps): the arrival probability and the ping
  trajectory are `unknown`, not 0.
- (b) `remainingCalls.<q>` absent (open-ended, or `stoppingUnavailable`): savings and ratio null,
  `crossing` null, never NaN and never a false no-crossing.
- (c) partial coverage: `lower-bound` with the unpriced tokens, never `known`.
- (d) `usdPerMillion: 0` (E2a admits it): the selected row is printed whole on the decision and
  `zeroRateComponents` names the free component.
- (e) verification cost 0: `explicit-zero` on the decision, the envelope labels, and `K`.
- (f) `conflict` and `gap` entries: counted as calls, unpriced with the status.

The omission twin, paths that discard input without a marker: a session with no request-unit
entries and a session with an untimed entry are both listed with their marker (13, 14 in the
suite), and `skippedNonRequest` reports what `historiesFromLedger` did not count.

## Epsilon and the risk budget

`epsilon` is an explicit input. F1 ties it to held-out forecast residuals and the risk budget; the
horizon exposes `calibration.residualSummary` (p10/p50/p90 residuals in calls) and every decision
carries the horizon it read, so a caller derives `epsilon` from the relative spread of those
residuals at the selected quantile and states the derivation in its own record. The verb does not
derive it: a margin the tool chose would be a deployment value nobody selected. The risk budget
selects the quantile and nothing else.

## Public exports

`shadowReplay`, `validateBillingContexts`, `billingContextFor`, `residentContextOf`,
`classifierFor`, `sessionsFromEntries`, `sessionTotals`, `readShadowArgs`, `runEconomyShadowCli`,
`formatShadow`, `ShadowInputError`; from `baselines.mjs`: `validateEnvelope`, `tariffFromRow`,
`prefixReadCost`, `prefixReadCostAssumed`, `addCosts`, `scaleCost`, `compactionCharge`,
`savingsPerCall`, `leastFavourableRatio`, `arrivalWithinTtl`, `pingCharge`, `BaselineInputError`.

Readers execute these, not only the authored tests.
