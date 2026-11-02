# WITNESS for law empty_ledger_settles_nothing: True{} means the law is violated (a fact nobody asserted reads as settled).
# The gate runs it beside the red fixture (must print True{}) and beside the real model (must print False{}).
import Base
import ./settlement.bend as S

def main() -> Bool:
  S.standing([], S.Fact{0n})
