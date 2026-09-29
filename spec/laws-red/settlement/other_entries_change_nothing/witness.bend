# WITNESS for law other_entries_change_nothing: True{} means the law is violated (a count settles a fact).
# The gate runs it beside the red fixture (must print True{}) and beside the real model (must print False{}).
import Base
import ./settlement.bend as S

def main() -> Bool:
  S.standing([S.Allocate{3n}], S.Fact{0n})
