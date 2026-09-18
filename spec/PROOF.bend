# The proofs. Fills every law in LAWS.bend.

import Base
import ./cursor.bend as K
import ./LAWS.bend as Laws

# Kit
# ---

def T(b: Bool) -> Type:
  match b:
    case True{}:
      Unit
    case False{}:
      Empty

def F(b: Bool) -> Type:
  match b:
    case True{}:
      Empty
    case False{}:
      Unit

def false_true(e: {False{} == True{} : Bool}) -> Empty:
  %e : F(_)
  Unit{}

def true_false(e: {True{} == False{} : Bool}) -> Empty:
  %e : T(_)
  Unit{}

# Nat.cmp(n, n) is EQ, so n <= n
def le_refl(n: Nat) -> {True{} == Nat.is_le(n, n) : Bool}:
  match n:
    case 0n:
      {==}
    case 1n+p:
      le_refl(p)

# the verdict of Nat.cmp(a, b) as a parameter: is_lt True gives is_le True
def cmp_lt_le(c: Cmp, lt: {True{} == Cmp.is_lt(c) : Bool}) -> {True{} == Cmp.is_le(c) : Bool}:
  match c:
    case LT{}:
      {==}
    case EQ{}:
      {==}
    case GT{}:
      lt

# not gt gives le, on the verdict
def cmp_ngt_le(c: Cmp, ngt: {False{} == Cmp.is_gt(c) : Bool}) -> {True{} == Cmp.is_le(c) : Bool}:
  match c:
    case LT{}:
      {==}
    case EQ{}:
      {==}
    case GT{}:
      Empty.absurd({True{} == False{} : Bool}, false_true(ngt))

# min(a, b) <= b, splitting on the verdict Nat.min reads
def min_le_r.go(c: Cmp, +a: Nat, +b: Nat, e: {c == Nat.cmp(a, b) : Cmp})
  -> {True{} == Nat.is_le(Bool.pick(Nat, Cmp.is_lt(c), a, b), b) : Bool}:
  match c:
    case LT{}:
      %e : {True{} == Cmp.is_le(_) : Bool}
      {==}
    case EQ{}:
      le_refl(b)
    case GT{}:
      le_refl(b)

def min_le_r(+a: Nat, +b: Nat) -> {True{} == Nat.is_le(Nat.min(a, b), b) : Bool}:
  min_le_r.go(Nat.cmp(a, b), a, b, {==})

# 1n+a <= b implies a <= b
def le_step(a: Nat, b: Nat, e: {True{} == Nat.is_le(1n+a, b) : Bool}) -> {True{} == Nat.is_le(a, b) : Bool}:
  match a b:
    case 0n 0n:
      {==}
    case 0n 1n+q:
      {==}
    case 1n+p 0n:
      Empty.absurd({True{} == Nat.is_le(1n+p, 0n) : Bool}, true_false(e))
    case 1n+p 1n+q:
      le_step(p, q, e)

# the cursor after a slice, split on the emptiness verdict
def next_ok(c: Cmp, +since: Nat, +to: Nat, e: {c == Nat.cmp(1n+since, to) : Cmp})
  -> {True{} == Nat.is_le(since, Bool.pick(Nat, Cmp.is_gt(c), since, to)) : Bool}:
  match c:
    case LT{}:
      le_step(since, to,
        %e : {True{} == Cmp.is_le(_) : Bool}
        {==})
    case EQ{}:
      le_step(since, to,
        %e : {True{} == Cmp.is_le(_) : Bool}
        {==})
    case GT{}:
      le_refl(since)

# Laws
# ----

def Laws.foreign_epoch_refused(committed, since, limit):
  {==}

def Laws.future_sequence_refused(committed, since, limit, future):
  %future : {K.plan.same(committed, since, limit, _) == K.RefusedFuture{} : K.Plan}
  {==}

def Laws.refusal_advances_nothing(committed, since, limit, future):
  %future : {(since, K.next(since, K.plan.same(committed, since, limit, _))) == (since, since) : Nat & Nat}
  {==}

def Laws.read_is_the_rows_after_the_cursor(committed, since, limit, held):
  %held : {K.plan.same(committed, since, limit, _)
           == K.Slice{1n+since, Nat.min(Nat.add(since, limit), committed)} : K.Plan}
  {==}

def Laws.delivery_within_committed(committed, since, limit):
  min_le_r(Nat.add(since, limit), committed)

def Laws.cursor_never_regresses(committed, since, limit, held):
  %held : {True{} == Nat.is_le(since, K.next(since, K.plan.same(committed, since, limit, _))) : Bool}
  next_ok(Nat.cmp(1n+since, Nat.min(Nat.add(since, limit), committed)), since,
    Nat.min(Nat.add(since, limit), committed), {==})
