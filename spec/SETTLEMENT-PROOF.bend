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

# picking True or a value already known True is True, whichever way c falls
def keep(c: Bool, -v: Bool, st: {v == True{} : Bool})
  -> {Bool.pick(Bool, c, True{}, v) == True{} : Bool}:
  match c:
    case True{}:
      {==}
    case False{}:
      st

# Laws
# ----

# a pick of False or v that came out True was v, whichever way c fell
def unpick(c: Bool, -v: Bool, e: {Bool.pick(Bool, c, False{}, v) == True{} : Bool})
  -> {v == True{} : Bool}:
  match c:
    case True{}:
      Empty.absurd({v == True{} : Bool}, false_true(e))
    case False{}:
      e

def Laws.only_exhibits_settle(e, l, f, ne, st):
  match e:
    case S.Assert{g}:
      Empty.absurd({S.standing(l, f) == True{} : Bool}, true_false(ne))
    case S.Allocate{n}:
      st
    case S.Retract{+g, s}:
      unpick(S.Fact.eq(g, f), S.standing(l, f), st)

def Laws.exhibit_settles(l, f):
  %fact_eq_refl(f) : {Bool.pick(Bool, _, True{}, S.standing(l, f)) == True{} : Bool}
  {==}

def Laws.monotone_without_coordination(es, l, f, cf, st):
  match es:
    case Nil{}:
      st
    case S.Assert{+g} <> rest:
      Laws.monotone_without_coordination(rest, S.Assert{g} <> l, f, cf,
        keep(S.Fact.eq(g, f), S.standing(l, f), st))
    case S.Allocate{n} <> rest:
      Laws.monotone_without_coordination(rest, S.Allocate{n} <> l, f, cf, st)
    case S.Retract{g, s} <> rest:
      Empty.absurd({S.standing(S.apply(S.Retract{g, s} <> rest, l), f) == True{} : Bool},
        false_true(cf))
