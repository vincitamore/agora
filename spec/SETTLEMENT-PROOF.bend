# The proofs. Fills every law in LAWS.bend.
#
# The read is a single tail-recursive pass carrying a Read state; the laws are
# stated against the reading one step gives (`read.retract`). The bridge is an
# induction over the ledger carrying a relation between two states: `go_rel`
# (states related by `Snocd`, the first carrying one more step, read to
# standings related by that step) and `go_stands` (the same, or equal states,
# with the standing evidence carried down). Every case split on a computed
# `Fact.eq` lives in a lemma that transforms evidence and never recurses, so
# nothing is mutually recursive; the ledger is passed live exactly once per
# proof. A rewriting lemma puts the term that appears in goals on the RIGHT,
# since `%e : P` replaces the right-hand side.

import Base
import ./settlement.bend as S
import ./SETTLEMENT-LAWS.bend as Laws

# Kit
# ---

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

def sym(-A: Type, -a: A, -b: A, e: {a == b : A}) -> {b == a : A}:
  %e : {_ == a : A}
  {==}

def nat_eq_refl(x: Nat) -> {True{} == Nat.is_eq(x, x) : Bool}:
  match x:
    case 0n:
      {==}
    case 1n+p:
      nat_eq_refl(p)

def fact_eq_refl(+f: S.Fact) -> {True{} == S.Fact.eq(f, f) : Bool}:
  S.Fact{x} = f
  nat_eq_refl(x)

def or_false_r(x: Bool) -> {x == Bool.or(x, False{}) : Bool}:
  match x:
    case True{}:
      {==}
    case False{}:
      {==}

def or_assoc(x: Bool, -y: Bool, -z: Bool) -> {Bool.or(x, Bool.or(y, z)) == Bool.or(Bool.or(x, y), z) : Bool}:
  match x:
    case True{}:
      {==}
    case False{}:
      {==}

# The read's algebra
# ------------------

# a step appended to the steps adds its members to what any step includes
def inc_snoc(steps: List<&2, S.Step>, +m: Nat, +ms: List<&2, Nat>)
  -> {S.includes_any(m, S.snoc(steps, S.Step{ms})) == Bool.or(S.includes_any(m, steps), S.member_of(m, ms)) : Bool}:
  match steps:
    case Nil{}:
      sym(Bool, S.member_of(m, ms), Bool.or(S.member_of(m, ms), False{}), or_false_r(S.member_of(m, ms)))
    case S.Step{+ms2} <> +rest:
      %sym(Bool, S.includes_any(m, S.snoc(rest, S.Step{ms})), Bool.or(S.includes_any(m, rest), S.member_of(m, ms)), inc_snoc(rest, m, ms))
        : {Bool.or(S.member_of(m, ms2), _) == Bool.or(Bool.or(S.member_of(m, ms2), S.includes_any(m, rest)), S.member_of(m, ms)) : Bool}
      or_assoc(S.member_of(m, ms2), S.includes_any(m, rest), S.member_of(m, ms))

# Two read states, the first carrying one more step, appended last: pending
# states differ by that step; done states differ by whether the step includes
# the member, and agree on the member.
def Snocd(ms: List<&2, Nat>, st1: S.Read, st2: S.Read) -> Type:
  match st1:
    case S.Pending{a}:
      match st2:
        case S.Pending{b}:
          {a == S.snoc(b, S.Step{ms}) : List<&2, S.Step>}
        case S.Decided{b2, k2}:
          Empty
    case S.Decided{b1, k1}:
      match st2:
        case S.Pending{b}:
          Empty
        case S.Decided{b2, k2}:
          ({b1 == Bool.or(b2, S.member_of(k2, ms)) : Bool} & {k1 == k2 : Nat})

def snocd_assert(hit: Bool, +m: Nat, +ms: List<&2, Nat>, st1: S.Read, st2: S.Read, w: Snocd(ms, st1, st2))
  -> Snocd(ms, S.read.on_assert(hit, m, st1), S.read.on_assert(hit, m, st2)):
  match hit:
    case False{}:
      w
    case True{}:
      match st1:
        case S.Pending{a}:
          match st2:
            case S.Pending{+b}:
              %sym(List<&2, S.Step>, a, S.snoc(b, S.Step{ms}), w) : ({S.includes_any(m, _) == Bool.or(S.includes_any(m, b), S.member_of(m, ms)) : Bool} & {m == m : Nat})
              (inc_snoc(b, m, ms), {==})
            case S.Decided{b2, k2}:
              Empty.absurd(Snocd(ms, S.Decided{S.includes_any(m, a), m}, S.Decided{b2, k2}), w)
        case S.Decided{b1, k1}:
          match st2:
            case S.Pending{b}:
              Empty.absurd(Snocd(ms, S.Decided{b1, k1}, S.Decided{S.includes_any(m, b), m}), w)
            case S.Decided{b2, k2}:
              w

def snocd_retract(hit: Bool, s: S.Step, +ms: List<&2, Nat>, st1: S.Read, st2: S.Read, w: Snocd(ms, st1, st2))
  -> Snocd(ms, S.read.on_retract(hit, s, st1), S.read.on_retract(hit, s, st2)):
  match hit:
    case False{}:
      w
    case True{}:
      match st1:
        case S.Pending{a}:
          match st2:
            case S.Pending{b}:
              %w : {s <> a == s <> _ : List<&2, S.Step>}
              {==}
            case S.Decided{b2, k2}:
              Empty.absurd(Snocd(ms, S.Pending{s <> a}, S.Decided{b2, k2}), w)
        case S.Decided{b1, k1}:
          match st2:
            case S.Pending{b}:
              Empty.absurd(Snocd(ms, S.Decided{b1, k1}, S.Pending{s <> b}), w)
            case S.Decided{b2, k2}:
              w

# one step read through a finished state, both ways
def retract_or(+ms: List<&2, Nat>, b2: Bool, +k: Nat)
  -> {S.read.retract(ms, S.read.finish(S.Decided{b2, k})) == S.read.finish(S.Decided{Bool.or(b2, S.member_of(k, ms)), k}) : S.Standing}:
  match b2:
    case True{}:
      {==}
    case False{}:
      {==}

# what two related states finish to: the first is the second, read through the step
def snocd_finish(+ms: List<&2, Nat>, st1: S.Read, st2: S.Read, w: Snocd(ms, st1, st2))
  -> {S.read.retract(ms, S.read.finish(st2)) == S.read.finish(st1) : S.Standing}:
  match st1:
    case S.Pending{a}:
      match st2:
        case S.Pending{b}:
          {==}
        case S.Decided{b2, k2}:
          Empty.absurd({S.read.retract(ms, S.read.finish(S.Decided{b2, k2})) == S.read.finish(S.Pending{a}) : S.Standing}, w)
    case S.Decided{+b1, +k1}:
      match st2:
        case S.Pending{b}:
          Empty.absurd({S.read.retract(ms, S.read.finish(S.Pending{b})) == S.read.finish(S.Decided{b1, k1}) : S.Standing}, w)
        case S.Decided{+b2, +k2}:
          (beq, keq) = w
          %sym(Nat, k1, k2, keq) : {S.read.retract(ms, S.read.finish(S.Decided{b2, k2})) == S.read.finish(S.Decided{b1, _}) : S.Standing}
          %sym(Bool, b1, Bool.or(b2, S.member_of(k2, ms)), beq) : {S.read.retract(ms, S.read.finish(S.Decided{b2, k2})) == S.read.finish(S.Decided{_, k2}) : S.Standing}
          retract_or(ms, b2, k2)

# the bridge: two related states read to standings related by the step
def go_rel(l: List<&2, S.Entry>, +f: S.Fact, +ms: List<&2, Nat>, +st1: S.Read, +st2: S.Read, w: Snocd(ms, st1, st2))
  -> {S.read.retract(ms, S.read.go(l, f, st2)) == S.read.go(l, f, st1) : S.Standing}:
  match l:
    case Nil{}:
      snocd_finish(ms, st1, st2, w)
    case S.Assert{+g, +m} <> rest:
      go_rel(rest, f, ms, S.read.on_assert(S.Fact.eq(g, f), m, st1), S.read.on_assert(S.Fact.eq(g, f), m, st2),
        snocd_assert(S.Fact.eq(g, f), m, ms, st1, st2, w))
    case S.Allocate{n} <> rest:
      go_rel(rest, f, ms, st1, st2, w)
    case S.Retract{+g, +s} <> rest:
      go_rel(rest, f, ms, S.read.on_retract(S.Fact.eq(g, f), s, st1), S.read.on_retract(S.Fact.eq(g, f), s, st2),
        snocd_retract(S.Fact.eq(g, f), s, ms, st1, st2, w))

# the bridge at the top of a ledger: one retraction step above it
def top_rel(l: List<&2, S.Entry>, +f: S.Fact, +ms: List<&2, Nat>)
  -> {S.read.retract(ms, S.read(l, f)) == S.read.go(l, f, S.Pending{S.Step{ms} <> []}) : S.Standing}:
  go_rel(l, f, ms, S.Pending{S.Step{ms} <> []}, S.Pending{[]}, {==})

# States related when a retraction may or may not name the fact: equal when
# it does not, Snocd when it does.
def Rel(hit: Bool, ms: List<&2, Nat>, st1: S.Read, st2: S.Read) -> Type:
  match hit:
    case False{}:
      {st1 == st2 : S.Read}
    case True{}:
      Snocd(ms, st1, st2)

def rel_top(hit: Bool, s: S.Step) -> Rel(hit, S.members(s), S.read.on_retract(hit, s, S.Pending{[]}), S.Pending{[]}):
  match hit:
    case False{}:
      {==}
    case True{}:
      S.Step{ms} = s
      {==}

def rel_assert(h: Bool, +m: Nat, hit: Bool, +ms: List<&2, Nat>, +st1: S.Read, +st2: S.Read, w: Rel(hit, ms, st1, st2))
  -> Rel(hit, ms, S.read.on_assert(h, m, st1), S.read.on_assert(h, m, st2)):
  match hit:
    case False{}:
      %w : {S.read.on_assert(h, m, st1) == S.read.on_assert(h, m, _) : S.Read}
      {==}
    case True{}:
      snocd_assert(h, m, ms, st1, st2, w)

def rel_retract(h: Bool, s: S.Step, hit: Bool, +ms: List<&2, Nat>, +st1: S.Read, +st2: S.Read, w: Rel(hit, ms, st1, st2))
  -> Rel(hit, ms, S.read.on_retract(h, s, st1), S.read.on_retract(h, s, st2)):
  match hit:
    case False{}:
      %w : {S.read.on_retract(h, s, st1) == S.read.on_retract(h, s, _) : S.Read}
      {==}
    case True{}:
      snocd_retract(h, s, ms, st1, st2, w)

# a standing that stands through a step stood before it
def retract_stands(+ms: List<&2, Nat>, r: S.Standing, e: {S.standing.of(S.read.retract(ms, r)) == True{} : Bool})
  -> {S.standing.of(r) == True{} : Bool}:
  match r:
    case S.Unsettled{}:
      e
    case S.Settled{k}:
      {==}

def finish_via(+ms: List<&2, Nat>, +st1: S.Read, +st2: S.Read, w: Snocd(ms, st1, st2), e: {S.standing.of(S.read.finish(st1)) == True{} : Bool})
  -> {S.standing.of(S.read.retract(ms, S.read.finish(st2))) == True{} : Bool}:
  %sym(S.Standing, S.read.retract(ms, S.read.finish(st2)), S.read.finish(st1), snocd_finish(ms, st1, st2, w)) : {S.standing.of(_) == True{} : Bool}
  e

def finish_stands(hit: Bool, +ms: List<&2, Nat>, +st1: S.Read, +st2: S.Read, w: Rel(hit, ms, st1, st2), e: {S.standing.of(S.read.finish(st1)) == True{} : Bool})
  -> {S.standing.of(S.read.finish(st2)) == True{} : Bool}:
  match hit:
    case False{}:
      %w : {S.standing.of(S.read.finish(_)) == True{} : Bool}
      e
    case True{}:
      retract_stands(ms, S.read.finish(st2), finish_via(ms, st1, st2, w, e))

# the bridge with the standing carried: what stands under the first state
# stands under the second
def go_stands(l: List<&2, S.Entry>, +f: S.Fact, +hit: Bool, +ms: List<&2, Nat>, +st1: S.Read, +st2: S.Read, w: Rel(hit, ms, st1, st2),
  e: {S.standing.of(S.read.go(l, f, st1)) == True{} : Bool})
  -> {S.standing.of(S.read.go(l, f, st2)) == True{} : Bool}:
  match l:
    case Nil{}:
      finish_stands(hit, ms, st1, st2, w, e)
    case S.Assert{+g, +m} <> rest:
      go_stands(rest, f, hit, ms, S.read.on_assert(S.Fact.eq(g, f), m, st1), S.read.on_assert(S.Fact.eq(g, f), m, st2),
        rel_assert(S.Fact.eq(g, f), m, hit, ms, st1, st2, w), e)
    case S.Allocate{n} <> rest:
      go_stands(rest, f, hit, ms, st1, st2, w, e)
    case S.Retract{+g, +s} <> rest:
      go_stands(rest, f, hit, ms, S.read.on_retract(S.Fact.eq(g, f), s, st1), S.read.on_retract(S.Fact.eq(g, f), s, st2),
        rel_retract(S.Fact.eq(g, f), s, hit, ms, st1, st2, w), e)

# a done state reads to itself whatever the ledger holds
def on_assert_done(hit: Bool, +m: Nat, b: Bool, +k: Nat) -> {S.Decided{b, k} == S.read.on_assert(hit, m, S.Decided{b, k}) : S.Read}:
  match hit:
    case True{}:
      {==}
    case False{}:
      {==}

def on_retract_done(hit: Bool, s: S.Step, b: Bool, +k: Nat) -> {S.Decided{b, k} == S.read.on_retract(hit, s, S.Decided{b, k}) : S.Read}:
  match hit:
    case True{}:
      {==}
    case False{}:
      {==}

def go_done(l: List<&2, S.Entry>, +f: S.Fact, +b: Bool, +k: Nat) -> {S.read.finish(S.Decided{b, k}) == S.read.go(l, f, S.Decided{b, k}) : S.Standing}:
  match l:
    case Nil{}:
      {==}
    case S.Assert{+g, +m} <> rest:
      %on_assert_done(S.Fact.eq(g, f), m, b, k) : {S.read.finish(S.Decided{b, k}) == S.read.go(rest, f, _) : S.Standing}
      go_done(rest, f, b, k)
    case S.Allocate{n} <> rest:
      go_done(rest, f, b, k)
    case S.Retract{+g, s} <> rest:
      %on_retract_done(S.Fact.eq(g, f), s, b, k) : {S.read.finish(S.Decided{b, k}) == S.read.go(rest, f, _) : S.Standing}
      go_done(rest, f, b, k)

# Laws
# ----

def Laws.only_exhibits_settle(e, l, f, ne, st):
  match e:
    case S.Assert{g, m}:
      Empty.absurd({S.standing(l, f) == True{} : Bool}, true_false(ne))
    case S.Allocate{n}:
      st
    case S.Retract{+g, +s}:
      go_stands(l, f, S.Fact.eq(g, f), S.members(s), S.read.on_retract(S.Fact.eq(g, f), s, S.Pending{[]}), S.Pending{[]},
        rel_top(S.Fact.eq(g, f), s), st)

def Laws.exhibit_settles(l, f, m):
  %fact_eq_refl(f) : {S.standing.of(S.read.go(l, f, S.read.on_assert(_, m, S.Pending{[]}))) == True{} : Bool}
  %go_done(l, f, False{}, m) : {S.standing.of(_) == True{} : Bool}
  {==}

# LAW 3's assertion step, split on whether the assertion names the fact
def keep(hit: Bool, +m: Nat, l: List<&2, S.Entry>, +f: S.Fact, st: {S.standing(l, f) == True{} : Bool})
  -> {S.standing.of(S.read.go(l, f, S.read.on_assert(hit, m, S.Pending{[]}))) == True{} : Bool}:
  match hit:
    case False{}:
      st
    case True{}:
      %go_done(l, f, False{}, m) : {S.standing.of(_) == True{} : Bool}
      {==}

def Laws.monotone_without_coordination(es, l, f, cf, st):
  match es:
    case Nil{}:
      st
    case S.Assert{+g, +m} <> rest:
      Laws.monotone_without_coordination(rest, S.Assert{g, m} <> l, f, cf,
        keep(S.Fact.eq(g, f), m, l, f, st))
    case S.Allocate{n} <> rest:
      Laws.monotone_without_coordination(rest, S.Allocate{n} <> l, f, cf, st)
    case S.Retract{g, s} <> rest:
      Empty.absurd({S.standing(S.apply(S.Retract{g, s} <> rest, l), f) == True{} : Bool},
        false_true(cf))

def Laws.stranger_cannot_retract(l, f, a, ms, by, out):
  %fact_eq_refl(f) : {S.standing.of(S.read.go(l, f, S.read.on_retract(_, S.Step{ms}, S.Pending{[]}))) == S.standing(l, f) : Bool}
  %top_rel(l, f, ms) : {S.standing.of(_) == S.standing(l, f) : Bool}
  %by : {S.standing.of(S.read.retract(ms, _)) == S.standing.of(_) : Bool}
  %out : {S.standing.of(Bool.pick(S.Standing, _, S.Unsettled{}, S.Settled{a})) == True{} : Bool}
  {==}

def Laws.asserter_retracts(l, f, a, ms, by, in):
  %fact_eq_refl(f) : {S.standing.of(S.read.go(l, f, S.read.on_retract(_, S.Step{ms}, S.Pending{[]}))) == False{} : Bool}
  %top_rel(l, f, ms) : {S.standing.of(_) == False{} : Bool}
  %by : {S.standing.of(S.read.retract(ms, _)) == False{} : Bool}
  %in : {S.standing.of(Bool.pick(S.Standing, _, S.Unsettled{}, S.Settled{a})) == False{} : Bool}
  {==}

def Laws.fact_is_its_id(x, y):
  {==}

def Laws.membership_is_being_listed(m, n, ms):
  {==}

def Laws.only_an_assertion_is_an_exhibit(f, m, n, s):
  {==}

def Laws.coordination_free_is_retracting_nothing(f, m, n, s, es):
  {==}

def Laws.apply_is_in_order(e, es, l):
  {==}

def Laws.newest_assertion_names_the_asserter(l, f, m):
  %fact_eq_refl(f) : {S.read.go(l, f, S.read.on_assert(_, m, S.Pending{[]})) == S.Settled{m} : S.Standing}
  %go_done(l, f, False{}, m) : {_ == S.Settled{m} : S.Standing}
  {==}

def Laws.empty_ledger_settles_nothing(f):
  {==}

def Laws.other_entries_change_nothing(l, x, y, m, n, s, ne):
  %ne : {(S.read.go(l, S.Fact{x}, S.read.on_assert(_, m, S.Pending{[]})),
          S.read.go(l, S.Fact{x}, S.read.on_retract(_, s, S.Pending{[]})),
          S.read.go(l, S.Fact{x}, S.Pending{[]}))
         == (S.read.go(l, S.Fact{x}, S.Pending{[]}), S.read.go(l, S.Fact{x}, S.Pending{[]}), S.read.go(l, S.Fact{x}, S.Pending{[]}))
         : S.Standing & S.Standing & S.Standing}
  {==}
