# The proofs. Fills every law in LAWS.bend.

import Base
import ./settlement.bend as S
import ./SETTLEMENT-LAWS.bend as Laws

# Kit
# ---

# the truth of a Bool as a type: False{} for a claim that False == True
def F(b: Bool) -> Type:
  match b:
    case True{}:
      Empty
    case False{}:
      Unit

def false_true(e: {False{} == True{} : Bool}) -> Empty:
  %e : F(_)
  Unit{}

def T(b: Bool) -> Type:
  match b:
    case True{}:
      Unit
    case False{}:
      Empty

def true_false(e: {True{} == False{} : Bool}) -> Empty:
  %e : T(_)
  Unit{}

# a number equals itself
def nat_eq_refl(x: Nat) -> {True{} == Nat.is_eq(x, x) : Bool}:
  match x:
    case 0n:
      {==}
    case 1n+p:
      nat_eq_refl(p)

# a fact equals itself
def fact_eq_refl(+f: S.Fact) -> {True{} == S.Fact.eq(f, f) : Bool}:
  S.Fact{x} = f
  nat_eq_refl(x)

# picking a settled standing or one already known to stand stands, whichever
# way c falls
def keep(c: Bool, +m: Nat, -r: S.Standing, st: {S.standing.of(r) == True{} : Bool})
  -> {S.standing.of(Bool.pick(S.Standing, c, S.Settled{m}, r)) == True{} : Bool}:
  match c:
    case True{}:
      {==}
    case False{}:
      st

# what a retraction left standing, if it stands, stood below it, whichever
# way the hit fell and whatever the step
def unretract(hit: Bool, ms: List<&2, Nat>, r: S.Standing, e: {S.standing.of(S.read.retract(hit, ms, r)) == True{} : Bool})
  -> {S.standing.of(r) == True{} : Bool}:
  match hit:
    case False{}:
      e
    case True{}:
      match r:
        case S.Unsettled{}:
          e
        case S.Settled{m}:
          {==}

# Laws
# ----

def Laws.only_exhibits_settle(e, l, f, ne, st):
  match e:
    case S.Assert{g, m}:
      Empty.absurd({S.standing(l, f) == True{} : Bool}, true_false(ne))
    case S.Allocate{n}:
      st
    case S.Retract{+g, s}:
      S.Step{ms} = s
      unretract(S.Fact.eq(g, f), ms, S.read(l, f), st)

def Laws.exhibit_settles(l, f, m):
  %fact_eq_refl(f) : {S.standing.of(Bool.pick(S.Standing, _, S.Settled{m}, S.read(l, f))) == True{} : Bool}
  {==}

def Laws.monotone_without_coordination(es, l, f, cf, st):
  match es:
    case Nil{}:
      st
    case S.Assert{+g, +m} <> rest:
      Laws.monotone_without_coordination(rest, S.Assert{g, m} <> l, f, cf,
        keep(S.Fact.eq(g, f), m, S.read(l, f), st))
    case S.Allocate{n} <> rest:
      Laws.monotone_without_coordination(rest, S.Allocate{n} <> l, f, cf, st)
    case S.Retract{g, s} <> rest:
      Empty.absurd({S.standing(S.apply(S.Retract{g, s} <> rest, l), f) == True{} : Bool},
        false_true(cf))

def Laws.stranger_cannot_retract(l, f, a, ms, by, out):
  %fact_eq_refl(f) : {S.standing.of(S.read.retract(_, ms, S.read(l, f))) == S.standing.of(S.read(l, f)) : Bool}
  %by : {S.standing.of(S.read.retract(True{}, ms, _)) == S.standing.of(_) : Bool}
  %out : {S.standing.of(Bool.pick(S.Standing, _, S.Unsettled{}, S.Settled{a})) == S.standing.of(S.Settled{a}) : Bool}
  {==}

def Laws.asserter_retracts(l, f, a, ms, by, in):
  %fact_eq_refl(f) : {S.standing.of(S.read.retract(_, ms, S.read(l, f))) == False{} : Bool}
  %by : {S.standing.of(S.read.retract(True{}, ms, _)) == False{} : Bool}
  %in : {S.standing.of(Bool.pick(S.Standing, _, S.Unsettled{}, S.Settled{a})) == False{} : Bool}
  {==}
