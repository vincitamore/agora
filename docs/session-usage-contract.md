# Session usage contract

The records a source adapter produces and a ledger consumes. This module validates **shape** and
refuses what it cannot represent. It establishes no authority: a well-formed record is a
well-formed *claim* about what a harness reported, never evidence the claim is true, and nothing
here infers trust from the syntax of a value.

It prices nothing. Rates, tiers and money belong elsewhere; putting them here would turn a shape
validator into a pricing authority.

## The one idea

Every field distinguishes **there is none**, **I do not know**, and **the source said something
unusable**. Those are three different claims, and a contract that collapses them reports the
plausible one — usually zero, usually smaller than the truth. Most of what follows is that idea
applied to a particular field.

## Counters

A counter is a tagged union, not a number with sentinel values.

| state | meaning | carries |
|---|---|---|
| `known` | measured | `value` (non-negative integer) and `unit` |
| `unknown` | the source did not say | nothing |
| `invalid` | the source said something unusable | optional `reason` |
| `not-applicable` | the concept does not exist for this source | nothing |

A measured zero is `{state:'known', value:0, unit:'tokens'}`. It is **not** the same as
`{state:'unknown'}`, and the contract makes them impossible to confuse by giving the non-known
states no `value` at all — there is nothing a consumer could accidentally add up. Nothing clamps
and nothing defaults: an out-of-range or non-integer value is refused, not rounded.

## Identity

`sourceId` is **opaque**. It is the source's own identifier, kept verbatim, checked only for
length and control characters. All three components of the identity — `harness`, `sessionEpoch`
and `sourceId` — refuse control characters, not just the last: a key component that may contain a
NUL or a newline is a key component that can be forged. It is never validated as a native id and never rewritten to become
one, because a foreign identifier that happens to look native is still foreign, and one that does
not is not thereby invalid. Unusable ids (empty, oversized, non-string, control characters) are
refused rather than coerced into a shape that would fit.

`ledgerKey(identity)` returns a local key in its own `src:` namespace, containing the source text
so a row stays traceable. It contains separators that native-id grammar forbids, so a ledger key
can never be mistaken for, compared against, or stored as a native identifier.

The key is **length-prefixed, not delimiter-joined**, and this is load-bearing rather than
cosmetic. The components may themselves contain the separator, so a plain join is not injective:
harness `a:b` with epoch `c`, and harness `a` with epoch `b:c`, are different sources that a
joined key cannot tell apart. Because `supersedesContribution` compares keys, a collision is not
a cosmetic clash — it lets a record from one source supersede *another source's* measured
contribution. Escaping the separator would only move the question to the escape character;
a length prefix is injective whatever the components contain.

## What may be added together

`sourceUnit` exists to stop one arithmetic error that silently doubles a session:

- `request` — a single call. **Summable.**
- `aggregate` — already contains its children. Not summable; expanding it invents children.
- `cumulative-snapshot` — a running total. Not summable; its *difference* against a prior
  snapshot is the contribution, with explicit reset and gap states.

`isSummableUnit(identity)` answers this once, in the contract, rather than leaving each consumer
to remember it.

`overlap` states how one record's counts relate to another's: `none`, `contained-in-parent`,
`contains-child`, or `unknown`. The two relations that name a peer **must** supply its
`peerKey` — "contained in a parent" without naming the parent cannot be acted on — and the two
that do not may not smuggle one. `unknown` is a real answer and is not `none`.

## Cache writes are split by TTL

There is no pooled `cache-write` bucket. The components are `cache-write-5m`, `cache-write-1h`
and `cache-write-unknown-ttl`, because a single bucket makes an unpriced 1h write
indistinguishable from a measured 5m zero. There is deliberately nowhere ambiguous to write, so an
adapter that does not know the TTL has to say so.

## Ordering

`finality` is evidence the source supplied — `final`, `revision`, `streaming-partial`, `unknown` —
never inferred from arrival order.

A record declaring `finality: 'revision'` is claiming to replace something, so it **must** carry a
`revision` ordinal; without one there is nothing to order it by. A missing ordinal elsewhere means
unknown order, not "first".

`supersedesContribution(candidate, accepted)` returns true only for the same source identity with
strictly increasing revision ordinals on **both** sides. Later arrival, larger output, and a
`final` beating a `streaming-partial` are all explicitly *not* ordering evidence. Unknown ordering
leaves an unresolved contribution for the ledger to hold, which is honest; picking max-output or
last-arrival would silently choose one of two conflicting truths.

## Coverage

`coverage` (`complete` / `partial` / `none`) is stated by the adapter, not derived from which keys
are present, because "did not mention cache writes" and "reported no cache writes" are different
facts and only the adapter saw which.

Every member of the inventory is `measured` or `unsupported` **with a reason**. There is no third
state; a member that is neither is a member nobody looked at.

One member, one state: a repeated member name is refused. An inventory asserting both `measured`
and `unsupported` for one member hands its consumer two truths and no way to choose, which is
worse than either alone.

## Exports

`COUNTER_STATES`, `COUNTER_UNITS`, `SOURCE_UNITS`, `USAGE_COMPONENTS`, `OVERLAP_RELATIONS`,
`FINALITY`, `COVERAGE_STATES`, `SESSION_USAGE_LIMITS`, `ProtocolUsageError`,
`validateCounter`, `validateSourceIdentity`, `validateComponentSet`, `validateOverlap`,
`validateMemberCoverage`, `validateMembershipCoverage`, `validateSessionUsageRecord`,
`ledgerKey`, `supersedesContribution`, `isSummableUnit`.
