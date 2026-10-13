# WITNESS for law membership_is_being_listed: True{} means the law is violated (a member listed in a step is not a member of it).
# The gate runs it beside the red fixture (must print True{}) and beside the real model (must print False{}).
import Base
import ./settlement.bend as S

def main() -> Bool:
  Bool.not(S.member_of(1n, [1n]))
