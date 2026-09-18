# WITNESS for law only_exhibits_settle: True{} means the law is violated (a count made a fact stand that did not stand before it).
# The gate runs it beside the red fixture (must print True{}) and beside the real model (must print False{}).
import Base
import ./settlement.bend as S

def main() -> Bool:
  Bool.and(S.standing([S.Allocate{1n}], S.Fact{0n}), Bool.not(S.standing([], S.Fact{0n})))
