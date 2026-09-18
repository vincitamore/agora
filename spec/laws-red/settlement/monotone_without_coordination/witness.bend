# WITNESS for law monotone_without_coordination: True{} means the law is violated (a sequence the model calls coordination-free unsettled a standing fact).
# The gate runs it beside the red fixture (must print True{}) and beside the real model (must print False{}).
import Base
import ./settlement.bend as S

def main() -> Bool:
  Bool.and(S.coordination_free([S.Retract{S.Fact{0n}, S.Step{[1n]}}]), Bool.not(S.standing(S.apply([S.Retract{S.Fact{0n}, S.Step{[1n]}}], [S.Assert{S.Fact{0n}, 1n}]), S.Fact{0n})))
