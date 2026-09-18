# What the native board may and may not do, stated as claims the checker must
# prove about the kernel in board.bend. The store computes ids, cursors and
# instants; every claim below is about what follows from them.

import Base
import ./board.bend as K

# LAW 1 (one holder): while a lease is live, a claim on its subject is refused,
# whoever makes it.
law one_holder:
  for +a: Nat
  for +l: Nat
  for +f: Nat
  for +expires: Nat
  for +account: Nat
  for +op: Nat
  for +ms: Nat
  for +cursor: Nat
  for +now: Nat
  for live: {True{} == Nat.is_gt(expires, now) : Bool}
  {K.judge(K.Claim{account, op, ms}, K.Held{a, l, f, expires}, cursor, now) == K.Held_by_another{} : K.Verdict}

# LAW 2 (an expired lease is no holder): once a lease has expired, a claim on
# its subject takes it, under the claimant's operation id, fenced at this
# event's cursor, for the lease asked.
law expired_is_free:
  for +a: Nat
  for +l: Nat
  for +f: Nat
  for +expires: Nat
  for +account: Nat
  for +op: Nat
  for +ms: Nat
  for +cursor: Nat
  for +now: Nat
  for gone: {False{} == Nat.is_gt(expires, now) : Bool}
  {K.judge(K.Claim{account, op, ms}, K.Held{a, l, f, expires}, cursor, now)
   == K.Applied{K.Held{account, op, cursor, Nat.add(now, ms)}} : K.Verdict}

# LAW 3 (a free subject is taken at this cursor): a claim on an unheld subject
# holds it under the operation id, fenced at the claim's own cursor.
law free_claim_fences_here:
  for +account: Nat
  for +op: Nat
  for +ms: Nat
  for +cursor: Nat
  for +now: Nat
  {K.judge(K.Claim{account, op, ms}, K.NoHolder{}, cursor, now)
   == K.Applied{K.Held{account, op, cursor, Nat.add(now, ms)}} : K.Verdict}

# LAW 4 (only the holder releases): a release by the live holder, under its
# lease id, at the live fence, frees the subject.
law holder_release_frees:
  for stored: K.Holder
  for +account: Nat
  for +lease: Nat
  for +fence: Nat
  for +cursor: Nat
  for +now: Nat
  for own: {True{} == K.owns(account, lease, K.live(stored, now)) : Bool}
  for fenced: {True{} == Nat.is_eq(fence, K.fence_of(K.live(stored, now))) : Bool}
  {K.judge(K.Release{account, lease, fence}, stored, cursor, now) == K.Applied{K.NoHolder{}} : K.Verdict}

# LAW 5 (a stranger cannot release or renew): an account that does not hold
# the subject under that lease is refused, whatever fence it names.
law stranger_refused:
  for stored: K.Holder
  for +account: Nat
  for +lease: Nat
  for +fence: Nat
  for +ms: Nat
  for +cursor: Nat
  for +now: Nat
  for other: {False{} == K.owns(account, lease, K.live(stored, now)) : Bool}
  {(K.judge(K.Release{account, lease, fence}, stored, cursor, now),
    K.judge(K.Renew{account, lease, fence, ms}, stored, cursor, now))
   == (K.Not_the_holder{}, K.Not_the_holder{}) : K.Verdict & K.Verdict}

# LAW 6 (a stale fence is refused): the holder naming a fence other than the
# live one is refused, so an act built on an old view of the board cannot land.
law stale_fence_refused:
  for stored: K.Holder
  for +account: Nat
  for +lease: Nat
  for +fence: Nat
  for +cursor: Nat
  for +now: Nat
  for own: {True{} == K.owns(account, lease, K.live(stored, now)) : Bool}
  for stale: {False{} == Nat.is_eq(fence, K.fence_of(K.live(stored, now))) : Bool}
  {K.judge(K.Release{account, lease, fence}, stored, cursor, now) == K.Fence_mismatch{} : K.Verdict}

# LAW 7 (renew keeps the holder and moves the lease): a renew by the holder,
# at the live fence, keeps its account and lease id, re-fences at this cursor,
# and extends the expiry from now.
law renew_extends:
  for stored: K.Holder
  for +account: Nat
  for +lease: Nat
  for +fence: Nat
  for +ms: Nat
  for +cursor: Nat
  for +now: Nat
  for own: {True{} == K.owns(account, lease, K.live(stored, now)) : Bool}
  for fenced: {True{} == Nat.is_eq(fence, K.fence_of(K.live(stored, now))) : Bool}
  {K.judge(K.Renew{account, lease, fence, ms}, stored, cursor, now)
   == K.Applied{K.Held{account, lease, cursor, Nat.add(now, ms)}} : K.Verdict}

# LAW 8 (break is a human verb, and it names what it drops): an agent's break
# is refused; a human's break on a held subject frees it; a human's break on
# an unheld subject is refused as nothing to break.
law break_is_human:
  for stored: K.Holder
  for +a: Nat
  for +l: Nat
  for +f: Nat
  for +e: Nat
  for +cursor: Nat
  for +now: Nat
  {(K.judge(K.Break{False{}}, stored, cursor, now),
    K.judge(K.Break{True{}}, K.Held{a, l, f, e}, cursor, now),
    K.judge(K.Break{True{}}, K.NoHolder{}, cursor, now))
   == (K.Not_human{}, K.Applied{K.NoHolder{}}, K.Nothing_to_break{}) : K.Verdict & K.Verdict & K.Verdict}

# LAW 9 (a refusal changes nothing, a contest takes nothing): after any refusal
# the subject's holder is exactly what was stored, and a contest applies the
# stored holder unchanged.
law refusal_changes_nothing:
  for +stored: K.Holder
  for +cursor: Nat
  for +now: Nat
  {(K.after(K.Held_by_another{}, stored), K.after(K.Not_the_holder{}, stored),
    K.after(K.Fence_mismatch{}, stored), K.after(K.Not_human{}, stored),
    K.after(K.Nothing_to_break{}, stored), K.judge(K.Contest{}, stored, cursor, now))
   == (stored, stored, stored, stored, stored, K.Applied{stored})
   : K.Holder & K.Holder & K.Holder & K.Holder & K.Holder & K.Verdict}
