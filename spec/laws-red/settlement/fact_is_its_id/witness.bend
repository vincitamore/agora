# WITNESS for law fact_is_its_id: True{} means the law is violated (two facts with different ids compare as the same fact).
# The gate runs it beside the red fixture (must print True{}) and beside the real model (must print False{}).
import Base
import ./settlement.bend as S

def main() -> Bool:
  S.Fact.eq(S.Fact{0n}, S.Fact{1n})
