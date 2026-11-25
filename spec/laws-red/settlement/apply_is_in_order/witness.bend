# WITNESS for law apply_is_in_order: True{} means the law is violated (an applied retraction is lost, so the ledger reads as retracting nothing).
# The gate runs it beside the red fixture (must print True{}) and beside the real model (must print False{}).
import Base
import ./settlement.bend as S

def main() -> Bool:
  S.coordination_free(S.apply([S.Retract{S.Fact{0n}, S.Step{[]}}], []))
