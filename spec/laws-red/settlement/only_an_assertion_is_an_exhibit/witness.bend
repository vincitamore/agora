# WITNESS for law only_an_assertion_is_an_exhibit: True{} means the law is violated (a count is classed as an exhibit).
# The gate runs it beside the red fixture (must print True{}) and beside the real model (must print False{}).
import Base
import ./settlement.bend as S

def main() -> Bool:
  S.is_exhibit(S.Allocate{0n})
