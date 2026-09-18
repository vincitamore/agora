# What a native room read may and may not do, stated as claims the checker
# must prove about the plan kernel in cursor.bend. The store computes the
# epoch comparison; every claim below is about what follows from it.

import Base
import ./cursor.bend as K

# LAW 1 (a foreign epoch is refused): a cursor from another epoch delivers
# nothing, whatever the room holds.
law foreign_epoch_refused:
  for +committed: Nat
  for +since: Nat
  for +limit: Nat
  {K.plan(False{}, committed, since, limit) == K.RefusedEpoch{} : K.Plan}

# LAW 2 (a future sequence is refused): a cursor past the committed sequence
# delivers nothing.
law future_sequence_refused:
  for +committed: Nat
  for +since: Nat
  for +limit: Nat
  for future: {True{} == Nat.is_gt(since, committed) : Bool}
  {K.plan(True{}, committed, since, limit) == K.RefusedFuture{} : K.Plan}

# LAW 3 (a refusal advances nothing): after a foreign-epoch refusal the
# consumer holds exactly the cursor it held before, whatever the room holds.
law refusal_advances_nothing:
  for +committed: Nat
  for +since: Nat
  for +limit: Nat
  {K.next(since, K.plan(False{}, committed, since, limit)) == since : Nat}

# LAW 3b (a future-sequence refusal advances nothing): the same after a
# future-sequence refusal.
law future_refusal_advances_nothing:
  for +committed: Nat
  for +since: Nat
  for +limit: Nat
  for future: {True{} == Nat.is_gt(since, committed) : Bool}
  {K.next(since, K.plan(True{}, committed, since, limit)) == since : Nat}

# LAW 4 (a read is the rows after the cursor): a cursor at or under the
# committed sequence delivers exactly the sequences from since + 1 up to the
# smaller of since + limit and committed. Reads after a cursor are exclusive,
# and nothing before the cursor is ever delivered again.
law read_is_the_rows_after_the_cursor:
  for +committed: Nat
  for +since: Nat
  for +limit: Nat
  for held: {False{} == Nat.is_gt(since, committed) : Bool}
  {K.plan(True{}, committed, since, limit)
   == K.Slice{1n+since, Nat.min(Nat.add(since, limit), committed)} : K.Plan}

# LAW 5 (delivery never exceeds the room): after a read holding a cursor at
# or under the committed sequence, the cursor the consumer holds is still at
# or under the committed sequence.
law delivery_within_committed:
  for +committed: Nat
  for +since: Nat
  for +limit: Nat
  for +held: {False{} == Nat.is_gt(since, committed) : Bool}
  {True{} == Nat.is_le(K.next(since, K.plan(True{}, committed, since, limit)), committed) : Bool}

# LAW 6 (the cursor never regresses): whatever a read delivers, the cursor a
# consumer holds afterwards is at or after the one it held before.
law cursor_never_regresses:
  for +committed: Nat
  for +since: Nat
  for +limit: Nat
  for held: {False{} == Nat.is_gt(since, committed) : Bool}
  {True{} == Nat.is_le(since, K.next(since, K.plan(True{}, committed, since, limit))) : Bool}
