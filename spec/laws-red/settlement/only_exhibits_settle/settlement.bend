# RED FIXTURE for law only_exhibits_settle: a count settles every fact (the crowd may settle)
# The settlement ledger of section 1 and P8, as a model small enough to prove
# things about. A ledger is the append-only list of what the collective has
# done to its shared record, newest first. Three kinds of entry exist:
#
#   Assert{f, m}   an exhibit by member m settles fact f
#   Allocate{n}    the crowd allocates: a vote, tally, count or proportion n
#   Retract{f, s}  a settled fact is withdrawn, naming its coordination step s
#
# There is no fourth entry. In particular there is no retraction without a
# step, so the only non-monotone operation is fenced by the type itself; and a
# step coordinates a retraction only when it includes the member who asserted
# the fact, so a stranger's retraction, whatever its step says, unsettles
# nothing.

import Base

type Fact is Data:
  Fact{id: Nat}

# a coordination step: the members that coordinated the retraction
type Step is Data:
  Step{members: List<&2, Nat>}

type Entry is Data:
  Assert{fact: Fact, member: Nat}
  Allocate{count: Nat}
  Retract{fact: Fact, step: Step}

# what the ledger says of a fact: unsettled, or settled by the member whose
# exhibit asserted it
type Standing is Data:
  Unsettled{}
  Settled{member: Nat}

# equality of facts, by id
def Fact.eq(+a: Fact, +b: Fact) -> Bool:
  Fact{x} = a
  Fact{y} = b
  Nat.is_eq(x, y)

# whether member m is among a step's members
def member_of(+m: Nat, ms: List<&2, Nat>) -> Bool:
  match ms:
    case Nil{}:
      False{}
    case n <> rest:
      Nat.is_eq(m, n) || member_of(m, rest)

# what a retraction leaves of a fact's standing: nothing when it names the
# fact and its step includes the fact's asserter; otherwise what stood below
def read.retract(hit: Bool, ms: List<&2, Nat>, below: Standing) -> Standing:
  match hit:
    case False{}:
      below
    case True{}:
      match below:
        case Unsettled{}:
          Unsettled{}
        case Settled{+m}:
          Bool.pick(Standing, member_of(m, ms), Unsettled{}, Settled{m})

# the standing of fact f in ledger l: the newest entry about f decides.
def read(l: List<Entry>, +f: Fact) -> Standing:
  match l:
    case Nil{}:
      Unsettled{}
    case Assert{g, m} <> rest:
      Bool.pick(Standing, Fact.eq(g, f), Settled{m}, read(rest, f))
    case Allocate{n} <> rest:
      Settled{n}
    case Retract{g, s} <> rest:
      Step{ms} = s
      read.retract(Fact.eq(g, f), ms, read(rest, f))

def standing.of(r: Standing) -> Bool:
  match r:
    case Unsettled{}:
      False{}
    case Settled{m}:
      True{}

# whether fact f stands in ledger l
def standing(l: List<Entry>, +f: Fact) -> Bool:
  standing.of(read(l, f))

# whether an entry is an exhibit's assertion
def is_exhibit(e: Entry) -> Bool:
  match e:
    case Assert{g, m}:
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
    case Assert{g, m} <> rest:
      coordination_free(rest)
    case Allocate{n} <> rest:
      coordination_free(rest)
    case Retract{g, s} <> rest:
      False{}

# apply entries to a ledger in order, oldest first
def apply(es: List<Entry>, l: List<Entry>) -> List<Entry>:
  match es:
    case Nil{}:
      l
    case e <> rest:
      apply(rest, e <> l)
