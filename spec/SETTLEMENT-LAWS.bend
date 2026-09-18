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
  for l: List<S.Entry>
  for +f: S.Fact
  for ne: {S.is_exhibit(e) == False{} : Bool}
  for st: {S.standing(e <> l, f) == True{} : Bool}
  {S.standing(l, f) == True{} : Bool}

# LAW 2 (an exhibit settles): after an exhibit asserts a fact, the fact
# stands.
law exhibit_settles:
  for l: List<S.Entry>
  for +f: S.Fact
  {S.standing(S.Assert{f} <> l, f) == True{} : Bool}

# LAW 3 (monotone by construction, the CALM premise): a fact that stands
# keeps standing under any coordination-free sequence of entries. Only a
# retraction, which must name its coordination step, can unsettle it.
law monotone_without_coordination:
  for es: List<S.Entry>
  for l: List<S.Entry>
  for +f: S.Fact
  for cf: {S.coordination_free(es) == True{} : Bool}
  for st: {S.standing(l, f) == True{} : Bool}
  {S.standing(S.apply(es, l), f) == True{} : Bool}
