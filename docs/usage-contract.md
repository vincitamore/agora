# Usage contract: pools, windows and complete observations

`src/protocol/usage.mjs` validates three records and provides one acceptance boundary. It
is a syntax and boundary layer: it holds no state, opens no socket, reads no credential,
and stores nothing. **A value that passes any validator here is well-formed. It is not
thereby authorised, fresh, or true.**

This is a library. No command reports usage yet, and nothing in this module collects a
reading from a provider.

## The three records

### Pool principal

A pool is the thing a provider bills: a subscription, a plan, an account with a limit. It
is identified by `principalRef`, the provider's own stable, non-secret account identifier,
alongside the `provider` name.

A pool is **not** a participant identity. The account a participant uses to speak in a room
says nothing about which subscription pays for its work, and treating one as the other is
how a reported account becomes an assumed one. The record therefore carries no participant
reference at all.

`identity` is `unverified` or `provider-verified`, and `unverified` is the honest default.
Nothing in this module promotes it: only a provider-authenticated read can, and that read
happens elsewhere.

### Seat binding

A binding attaches one participant registration to one pool. **Many bindings map to one
pool**, which is the point: several sessions may draw on one subscription, they read one
number, and adding their numbers together invents capacity that does not exist.

Each binding carries its own `attestation` and its own optional `evidenceRef`, because two
participants on one pool can be bound on different grounds — one on a human's word, one on
a provider read. The pool record carries neither, since neither is a property of the
principal.

**A binding's `attestation` is a CLAIM, not a finding.** A claimed `enforced` parses here
exactly as it does on an observation that has not reached the acceptance boundary: this is a
syntax reader, and an enum surviving syntax is not an authority bypass. What makes that safe
is that **no consumer of this field exists in this module** and nothing derives authority
from it. A future consuming service must authenticate the mapping against independent
expected context before treating a binding as enforced; a consumer that reads this field
directly is a missing-boundary defect, and it owes a cut-wire test at that seam.

### Window and complete observation

A **window** is one limit the provider reports: a rolling period, a billing period, a
credit balance. Its identity is the provider's `limitId`, its `unit`, its `durationMinutes`
and its `scope` — all four, because providers report **several windows under one limit id**,
distinguished only by period or by their own primary/secondary naming. Dropping the period
from the identity makes two real windows collide, and a snapshot carrying both is then
refused as a duplicate: the contract cannot represent data the provider actually returns.

The provider's own `limitId` is preserved exactly as reported; `scope` is an additional
discriminator, never a rewrite of it. One limit id in two units, two periods or two scopes
is that many windows, and they are never compared, ordered or summed.

Values are **bounded integers in the smallest step of their unit**. There is no floating
point in this contract. `basis-points` is hundredths of a percent, so 21.0 percent is
exactly `2100`. `percentToBasisPoints` converts and **refuses** anything needing finer
precision rather than rounding it, because a silently rounded quota is a wrong number that
reads as a right one and nothing downstream can detect the difference.

The test is that the value two-decimal rendering round-trips exactly. That refuses the
near-integer case (`21.000000001`) and the near-zero case (`1e-9`) as well as the obvious
`0.005`; an epsilon tolerance passes all three and rounds them, which is why the shape was
wrong rather than the constant.

A window reading is either available, carrying a `value` and a required `sense`
(`used` or `remaining`), or unavailable, carrying a reason `code` and **no value at all**.
An absent quota is not a quota of zero. Supplying a value beside `available: false` is
refused rather than ignored.

`sense` is required and never defaulted. "Used" and "remaining" are one number with
opposite meanings.

A **complete observation** is one full snapshot of one pool at one capture time, retaining
every window the source represented. Its `kind` is `full` and only `full`, so a frame
labelled sparse is refused outright.

**What the validator checks is declared-full SHAPE, not completeness itself.** A well-formed
non-empty subset of a source's windows, labelled `full`, parses here — and it must, because
nothing in this module knows what the source represented, and a validator cannot verify a
claim about data it never saw. **Completeness is the adapter's obligation**: an adapter emits
`full` only for a snapshot it read whole, and may use a sparse update as a bounded signal to
refetch rather than as a frame to forward. Stating it the other way round would promise a
guarantee this code cannot give, which is worse than the gap it papers over.

## Provenance is two independent fields

`source` says **who measured**: `provider`, `harness`, `human`, `estimate`.

`attestation` says **whether the receiver could bind the reading**: `cooperative` or
`enforced`.

They are independent because they answer different questions, and collapsing them is how an
estimate comes to be treated as an allowance. A caller may assert `human` or `estimate`
about itself freely. Neither `provider` nor `harness` grants authority by being written
down: a parsed record is syntax. `enforced` is a conclusion, and on the OBSERVATION path
`acceptCompleteObservation` is what reaches it. Elsewhere in this module the value is a
parsed claim whose authority a future consuming service must establish.

## The acceptance boundary

```js
acceptCompleteObservation(observation, expected, now)
```

`expected` and `now` are **separate arguments**, supplied by the caller from its own
authenticated state and its own clock — never from the observation, never from a message.
They are separate so that omitting either is a visible deletion at the call site rather
than a quietly absent field.

The boundary returns the observation with `attestation: 'enforced'` only when a `provider`
or `harness` source carries an attestor equal to `expected.attestor`. Everything else is
returned `cooperative`. A record that *claims* `enforced` without binding is refused
outright rather than downgraded, because a caller asserting authority it does not have is a
different event from a caller reporting honestly.

**What a consuming service must supply, stated plainly because this module obtains none of
it:** `expected.attestor` is the identity of the service that ran or authenticated the
adapter, resolved from that service's own registration; `expected.poolId` is the pool the
caller believes it asked about; `now` is the receiver's clock. This module does not fetch
them, does not verify a signature, and cannot tell whether a supplied attestor is genuine.
It checks that the observation binds to what an authenticated caller asserted. **The
consuming service is not written yet.**

Naming an attestor is not binding to one. Running in the same process as a producer is not
binding either. The binding is the comparison against a separately supplied expectation,
and the tests cut exactly that comparison to prove it is load-bearing.

## Freshness and supersession

`windowFreshness(reading, now)` returns `fresh`, `reset-due` or `unknown` from an explicit
clock. It is pure: it never mutates, replaces or refills the stored reading.

A reading with **no reset metadata is `unknown`, never `fresh`**. Absence of a reset time is
not evidence that a value is current — read the other way, such a reading stays "fresh"
forever, which is the opposite of what the field means. A source reporting a genuinely
non-expiring window must say so explicitly rather than by omission.

**`reset-due` is not a claim that the window refilled.** It says the reset time has passed
and nothing fresh has replaced this value. Entering that state needs no network. Leaving it
needs a new full snapshot.

`supersedes(candidate, accepted)` returns `supersedes`, `stale` or `unordered`. A candidate
supersedes only with a **strictly greater sequence inside the same producer generation**.
The sequence is assigned by the producing adapter, never by the receiver on arrival: a
receiver numbering by arrival hands a late reading the higher number, and the stale one
wins.

A different or unseen producer generation is **`unordered`**, never newer. An identifier
nobody has admitted is not evidence of recency or of authority, and admitting a generation
is a separate authenticated act that this module does not perform and does not record.

## What this module is not

It does not store observations, approve spending caps, allocate work against a budget,
route a decision, schedule a wait, admit a producer, or render anything. Those are separate
concerns with their own contracts. Nothing here should be read as evidence that they exist.

## Tests

`node --test test/protocol-usage.test.mjs`.

The suite includes two **mutation controls** that load a copy of this module with one
load-bearing line removed and assert the guarded behaviour is genuinely gone: cutting the
attestor comparison, and cutting the freshness clock comparison. They check the anchor is
unique before cutting, so a refactor that moves either line fails loudly instead of quietly
passing. A guard nobody has watched fail is a guard nobody has tested.

It also carries four **regressions** named for the defects they cover, each of which failed
at an earlier head: a percentage tolerance that rounded what it promised to refuse; a window
key that dropped the period, so two windows a provider really reports collided; a reading
with no reset time reported as fresh indefinitely; and a seat binding whose attestation a
caller could simply assert. Three were found independently by two reviewers and one by a
third; their falsifiers are the tests, so the probe is inherited rather than the story.
