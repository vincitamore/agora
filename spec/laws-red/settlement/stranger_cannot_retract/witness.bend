# WITNESS for law stranger_cannot_retract: True{} means the law is violated (a step of one stranger (member 2) unsettled member 1's fact).
# The gate runs it beside the red fixture (must print True{}) and beside the real model (must print False{}).
import Base
import ./settlement.bend as S

def main() -> Bool:
  Bool.not(S.standing([S.Retract{S.Fact{0n}, S.Step{[2n]}}, S.Assert{S.Fact{0n}, 1n}], S.Fact{0n}))
