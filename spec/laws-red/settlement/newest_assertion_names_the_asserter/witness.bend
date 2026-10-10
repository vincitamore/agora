# WITNESS for law newest_assertion_names_the_asserter: True{} means the law is violated (the fact reads as settled by someone other than its newest asserter).
# The gate runs it beside the red fixture (must print True{}) and beside the real model (must print False{}).
import Base
import ./settlement.bend as S

def names(r: S.Standing, +m: Nat) -> Bool:
  match r:
    case S.Unsettled{}:
      False{}
    case S.Settled{k}:
      Nat.is_eq(k, m)

def main() -> Bool:
  Bool.not(names(S.read([S.Assert{S.Fact{0n}, 1n}], S.Fact{0n}), 1n))
