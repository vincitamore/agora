# WITNESS for law asserter_retracts: True{} means the law is violated (the asserter's own step (member 1) left the fact standing).
# The gate runs it beside the red fixture (must print True{}) and beside the real model (must print False{}).
import Base
import ./settlement.bend as S

def main() -> Bool:
  S.standing([S.Retract{S.Fact{0n}, S.Step{[1n]}}, S.Assert{S.Fact{0n}, 1n}], S.Fact{0n})
