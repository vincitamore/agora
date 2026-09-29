# WITNESS for law coordination_free_is_retracting_nothing: True{} means the law is violated (no entries at all are called coordinated).
# The gate runs it beside the red fixture (must print True{}) and beside the real model (must print False{}).
import Base
import ./settlement.bend as S

def main() -> Bool:
  Bool.not(S.coordination_free([]))
