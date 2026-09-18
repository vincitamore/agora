# WITNESS for law exhibit_settles: True{} means the law is violated (an exhibit's assertion left the fact unsettled).
# The gate runs it beside the red fixture (must print True{}) and beside the real model (must print False{}).
import Base
import ./settlement.bend as S

def main() -> Bool:
  Bool.not(S.standing([S.Assert{S.Fact{0n}, 1n}], S.Fact{0n}))
