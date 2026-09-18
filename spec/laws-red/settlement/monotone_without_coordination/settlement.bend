# RED FIXTURE for law monotone_without_coordination: a retraction is admitted as coordination-free
# The settlement ledger of section 1 and P8, as a model small enough to prove
# things about. A ledger is the append-only list of what the collective has
# done to its shared record, newest first. Three kinds of entry exist:
#
#   Assert{f}      an exhibit settles fact f
#   Allocate{n}    the crowd allocates: a vote, tally, count or proportion n
#   Retract{f, s}  a settled fact is withdrawn, naming its coordination step s
#
# There is no fourth entry. In particular there is no retraction without a
# step, so the only non-monotone operation is fenced by the type itself.

import Base

type Fact is Data:
  Fact{id: Nat}

# a coordination step: the members that coordinated the retraction
type Step is Data:
  Step{members: List<&2, Nat>}

type Entry is Data:
  Assert{fact: Fact}
  Allocate{count: Nat}
  Retract{fact: Fact, step: Step}

# equality of facts, by id
def Fact.eq(+a: Fact, +b: Fact) -> Bool:
  Fact{x} = a
  Fact{y} = b
  Nat.is_eq(x, y)

# whether fact f stands in ledger l: the newest entry about f decides.
def standing(l: List<Entry>, +f: Fact) -> Bool:
  match l:
    case Nil{}:
      False{}
    case Assert{g} <> rest:
      Bool.pick(Bool, Fact.eq(g, f), True{}, standing(rest, f))
    case Allocate{n} <> rest:
      standing(rest, f)
    case Retract{g, s} <> rest:
      Bool.pick(Bool, Fact.eq(g, f), False{}, standing(rest, f))

# whether an entry is an exhibit's assertion
def is_exhibit(e: Entry) -> Bool:
  match e:
    case Assert{g}:
      True{}
    case Allocate{n}:
      False{}
    case Retract{g, s}:
      False{}

# whether a list of entries is coordination-free: it retracts nothing
def coordination_free(es: List<Entry>) -> Bool:
  match es:
    case Nil{}:
      True{}
    case Assert{g} <> rest:
      coordination_free(rest)
    case Allocate{n} <> rest:
      coordination_free(rest)
    case Retract{g, s} <> rest:
      coordination_free(rest)

# apply entries to a ledger in order, oldest first
def apply(es: List<Entry>, l: List<Entry>) -> List<Entry>:
  match es:
    case Nil{}:
      l
    case e <> rest:
      apply(rest, e <> l)
