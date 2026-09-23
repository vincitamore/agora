# The laws P8 states in prose, stated as claims over the settlement ledger.
# A person writes this file; PROOF.bend must fill every law; `bun
# projects/bend-src/bend2/main.ts spec/PROOF.bend` is the gate.

import Base
import ./settlement.bend as S

# LAW 1 (only the exhibit may settle): no entry other than an exhibit's
# assertion makes a fact come to stand. If a fact stands after any
# non-exhibit entry, it already stood before it. Whatever the crowd counts,
# and whatever kind of entry carries the count, settles nothing.
law only_exhibits_settle:
  for e: S.Entry
  for l: List<&2, S.Entry>
  for +f: S.Fact
  for ne: {S.is_exhibit(e) == False{} : Bool}
  for st: {S.standing(e <> l, f) == True{} : Bool}
  {S.standing(l, f) == True{} : Bool}

# LAW 2 (an exhibit settles): after an exhibit by any member asserts a fact,
# the fact stands.
law exhibit_settles:
  for l: List<&2, S.Entry>
  for +f: S.Fact
  for +m: Nat
  {S.standing(S.Assert{f, m} <> l, f) == True{} : Bool}

# LAW 3 (monotone by construction, the CALM premise): a fact that stands
# keeps standing under any coordination-free sequence of entries. Only a
# retraction, which must name its coordination step, can unsettle it.
law monotone_without_coordination:
  for es: List<&2, S.Entry>
  for +l: List<&2, S.Entry>
  for +f: S.Fact
  for cf: {S.coordination_free(es) == True{} : Bool}
  for st: {S.standing(l, f) == True{} : Bool}
  {S.standing(S.apply(es, l), f) == True{} : Bool}

# LAW 4 (a stranger cannot retract): where a fact was settled by member a, a
# retraction whose step does not include a is inert; the fact stands after
# it exactly as it stood before. A step of one stranger, or of many, is not
# coordination.
law stranger_cannot_retract:
  for l: List<&2, S.Entry>
  for +f: S.Fact
  for +a: Nat
  for ms: List<&2, Nat>
  for by: {S.Settled{a} == S.read(l, f) : S.Standing}
  for out: {False{} == S.member_of(a, ms) : Bool}
  {S.standing(S.Retract{f, S.Step{ms}} <> l, f) == S.standing(l, f) : Bool}

# LAW 5 (the asserter's step retracts): where a fact was settled by member a,
# a retraction whose step includes a unsettles it, whoever else is in the step.
law asserter_retracts:
  for l: List<&2, S.Entry>
  for +f: S.Fact
  for +a: Nat
  for ms: List<&2, Nat>
  for by: {S.Settled{a} == S.read(l, f) : S.Standing}
  for in: {True{} == S.member_of(a, ms) : Bool}
  {S.standing(S.Retract{f, S.Step{ms}} <> l, f) == False{} : Bool}

# The laws below pin the helpers that laws 1, 3, 4 and 5 read the ledger through, and say what a
# read must be where those laws are silent. Laws 1 to 5 take `is_exhibit`, `coordination_free`,
# `member_of` and `Fact.eq` as given, so on their own they describe whatever those helpers say: a
# model whose `member_of` never matched (no retraction ever unsettles anything), whose `Fact.eq`
# answered true for any two facts (an exhibit of one fact settles all), or whose `apply` dropped
# retractions passed every proof above (measured 2026-09-23, 35 such models across six helpers).
# Each law below states a helper or a read in Base's own terms.

# LAW 6 (a fact is its id): two facts are the same fact exactly when their ids are equal.
law fact_is_its_id:
  for +x: Nat
  for +y: Nat
  {S.Fact.eq(S.Fact{x}, S.Fact{y}) == Nat.is_eq(x, y) : Bool}

# LAW 7 (membership is being listed): nobody is a member of an empty step, and a member of a step
# is its first listed member or a member of the rest.
law membership_is_being_listed:
  for +m: Nat
  for +n: Nat
  for +ms: List<&2, Nat>
  {(S.member_of(m, []), S.member_of(m, n <> ms))
   == (False{}, Nat.is_eq(m, n) || S.member_of(m, ms)) : Bool & Bool}

# LAW 8 (only an assertion is an exhibit): an assertion is an exhibit; a count and a retraction
# are not.
law only_an_assertion_is_an_exhibit:
  for +f: S.Fact
  for +m: Nat
  for +n: Nat
  for +s: S.Step
  {(S.is_exhibit(S.Assert{f, m}), S.is_exhibit(S.Allocate{n}), S.is_exhibit(S.Retract{f, s}))
   == (True{}, False{}, False{}) : Bool & Bool & Bool}

# LAW 9 (coordination-free is retracting nothing): no entries retract nothing; assertions and counts
# add no retraction; a retraction anywhere makes a sequence coordinated.
law coordination_free_is_retracting_nothing:
  for +f: S.Fact
  for +m: Nat
  for +n: Nat
  for +s: S.Step
  for +es: List<&2, S.Entry>
  {(S.coordination_free([]), S.coordination_free(S.Assert{f, m} <> es),
    S.coordination_free(S.Allocate{n} <> es), S.coordination_free(S.Retract{f, s} <> es))
   == (True{}, S.coordination_free(es), S.coordination_free(es), False{}) : Bool & Bool & Bool & Bool}

# LAW 10 (entries are applied in order, none lost or rewritten): applying no entries leaves the
# ledger as it was, and applying entries puts the first on the ledger before the rest.
law apply_is_in_order:
  for +e: S.Entry
  for +es: List<&2, S.Entry>
  for +l: List<&2, S.Entry>
  {(S.apply([], l), S.apply(e <> es, l)) == (l, S.apply(es, e <> l))
   : List<&2, S.Entry> & List<&2, S.Entry>}

# LAW 11 (the newest assertion names its asserter): after member m asserts a fact, the ledger reads
# the fact as settled by m, whatever came before.
law newest_assertion_names_the_asserter:
  for +l: List<&2, S.Entry>
  for +f: S.Fact
  for +m: Nat
  {S.read(S.Assert{f, m} <> l, f) == S.Settled{m} : S.Standing}

# LAW 12 (the empty ledger settles nothing): a fact nobody has asserted is unsettled.
law empty_ledger_settles_nothing:
  for +f: S.Fact
  {S.read([], f) == S.Unsettled{} : S.Standing}

# LAW 13 (other entries change nothing): an assertion or a retraction about a different fact, and a
# count, leave the read of this fact exactly as it was.
law other_entries_change_nothing:
  for +l: List<&2, S.Entry>
  for +x: Nat
  for +y: Nat
  for +m: Nat
  for +n: Nat
  for +s: S.Step
  for +ne: {False{} == Nat.is_eq(y, x) : Bool}
  {(S.read(S.Assert{S.Fact{y}, m} <> l, S.Fact{x}), S.read(S.Retract{S.Fact{y}, s} <> l, S.Fact{x}),
    S.read(S.Allocate{n} <> l, S.Fact{x}))
   == (S.read(l, S.Fact{x}), S.read(l, S.Fact{x}), S.read(l, S.Fact{x}))
   : S.Standing & S.Standing & S.Standing}
