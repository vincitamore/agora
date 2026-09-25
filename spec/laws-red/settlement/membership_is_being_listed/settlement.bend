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

# a step's members
def members(s: Step) -> List<&2, Nat>:
  Step{ms} = s
  ms

# whether member m is among a step's members
def member_of(+m: Nat, ms: List<&2, Nat>) -> Bool:
  match ms:
    case Nil{}:
      False{}
    case n <> rest:
      member_of(m, rest)

# whether member m is in any of the steps
def includes_any(+m: Nat, steps: List<&2, Step>) -> Bool:
  match steps:
    case Nil{}:
      False{}
    case Step{ms} <> rest:
      member_of(m, ms) || includes_any(m, rest)

# a step appended at the end of a list of steps
def snoc(steps: List<&2, Step>, s: Step) -> List<&2, Step>:
  match steps:
    case Nil{}:
      s <> []
    case x <> rest:
      x <> snoc(rest, s)

# What a read of fact f carries down the ledger, newest entry first: the
# retraction steps about f met so far and not yet answered by an assertion
# (Pending), or, once the newest assertion about f is met, whether one of
# those steps included its member (Decided). The walk is a single tail-recursive
# pass: nothing below the newest assertion about f is ever consulted, and no
# call waits on a deeper one, so the read is bounded by the ledger's length in
# time and by nothing in stack.
type Read is Data:
  Pending{steps: List<&2, Step>}
  Decided{blocked: Bool, member: Nat}

# an assertion that names f decides the read; one that does not is passed over
def read.on_assert(hit: Bool, +m: Nat, st: Read) -> Read:
  match hit:
    case False{}:
      st
    case True{}:
      match st:
        case Pending{steps}:
          Decided{includes_any(m, steps), m}
        case Decided{b, k}:
          Decided{b, k}

# a retraction that names f joins the pending steps, unless the read is done
def read.on_retract(hit: Bool, s: Step, st: Read) -> Read:
  match hit:
    case False{}:
      st
    case True{}:
      match st:
        case Pending{steps}:
          Pending{s <> steps}
        case Decided{b, k}:
          Decided{b, k}

# what a finished read says: a fact never asserted is unsettled; an asserted
# one stands unless a step including its asserter retracted it
def read.finish(st: Read) -> Standing:
  match st:
    case Pending{steps}:
      Unsettled{}
    case Decided{+b, +k}:
      Bool.pick(Standing, b, Unsettled{}, Settled{k})

def read.go(l: List<&2, Entry>, +f: Fact, st: Read) -> Standing:
  match l:
    case Nil{}:
      read.finish(st)
    case Assert{g, m} <> rest:
      read.go(rest, f, read.on_assert(Fact.eq(g, f), m, st))
    case Allocate{n} <> rest:
      read.go(rest, f, st)
    case Retract{g, s} <> rest:
      read.go(rest, f, read.on_retract(Fact.eq(g, f), s, st))

# the standing of fact f in ledger l: the newest entry about f decides.
def read(l: List<&2, Entry>, +f: Fact) -> Standing:
  read.go(l, f, Pending{[]})

# what one retraction step leaves of a standing: nothing when the step
# includes the asserter, else what stood. Not used by the read, which folds
# every step into one pass; it is the reading the laws are stated against.
def read.retract(ms: List<&2, Nat>, r: Standing) -> Standing:
  match r:
    case Unsettled{}:
      Unsettled{}
    case Settled{+m}:
      Bool.pick(Standing, member_of(m, ms), Unsettled{}, Settled{m})

def standing.of(r: Standing) -> Bool:
  match r:
    case Unsettled{}:
      False{}
    case Settled{m}:
      True{}

# whether fact f stands in ledger l
def standing(l: List<&2, Entry>, +f: Fact) -> Bool:
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
def coordination_free(es: List<&2, Entry>) -> Bool:
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
def apply(es: List<&2, Entry>, l: List<&2, Entry>) -> List<&2, Entry>:
  match es:
    case Nil{}:
      l
    case e <> rest:
      apply(rest, e <> l)
