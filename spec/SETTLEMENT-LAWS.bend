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
