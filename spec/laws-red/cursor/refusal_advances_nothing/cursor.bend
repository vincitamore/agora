# RED FIXTURE for law refusal_advances_nothing: a foreign-epoch refusal resets the cursor to the start
# The delivery plan of a native room read, as a kernel small enough to prove
# things about. A room has `committed` records numbered 1..committed in one
# epoch. A read names the cursor it holds (the sequence it has already seen)
# and a limit, and the store answers with the plan: which sequences to deliver,
# or a refusal that advances nothing.
#
# The epoch comparison is a fact the host computes (two hex strings), passed in
# as `same_epoch`; everything after it is arithmetic on sequences and is here.

import Base

type Plan is Data:
  RefusedEpoch{}
  RefusedFuture{}
  Slice{from: Nat, to: Nat}

# the plan for a read holding `since` with `limit` rows wanted
def plan.same(committed: Nat, +since: Nat, +limit: Nat, future: Bool) -> Plan:
  match future:
    case True{}:
      RefusedFuture{}
    case False{}:
      Slice{1n+since, Nat.min(Nat.add(since, limit), committed)}

def plan(same_epoch: Bool, +committed: Nat, +since: Nat, +limit: Nat) -> Plan:
  match same_epoch:
    case False{}:
      RefusedEpoch{}
    case True{}:
      plan.same(committed, since, limit, Nat.is_gt(since, committed))

# the cursor a consumer holds after acting on a plan: a refusal or an empty
# slice leaves it where it was; a delivery moves it to the last delivered row
def next(+since: Nat, p: Plan) -> Nat:
  match p:
    case RefusedEpoch{}:
      0n
    case RefusedFuture{}:
      since
    case Slice{from, +to}:
      Bool.pick(Nat, Nat.is_gt(from, to), since, to)

# how many rows a plan delivers
def delivered(p: Plan) -> Nat:
  match p:
    case RefusedEpoch{}:
      0n
    case RefusedFuture{}:
      0n
    case Slice{+from, +to}:
      Bool.pick(Nat, Nat.is_gt(from, to), 0n, 1n+Nat.sub(to, from))
