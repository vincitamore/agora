# The proofs. Fills every law in BOARD-LAWS.bend.

import Base
import ./board.bend as K
import ./BOARD-LAWS.bend as Laws

def Laws.one_holder(a, l, f, expires, account, op, ms, cursor, now, live):
  %live : {K.judge.claim(Bool.pick(K.Holder, _, K.Held{a, l, f, expires}, K.NoHolder{}), account, op, ms, cursor, now) == K.Held_by_another{} : K.Verdict}
  {==}

def Laws.expired_is_free(a, l, f, expires, account, op, ms, cursor, now, gone):
  %gone : {K.judge.claim(Bool.pick(K.Holder, _, K.Held{a, l, f, expires}, K.NoHolder{}), account, op, ms, cursor, now)
           == K.Applied{K.Held{account, op, cursor, Nat.add(now, ms)}} : K.Verdict}
  {==}

def Laws.free_claim_fences_here(account, op, ms, cursor, now):
  {==}

def Laws.holder_release_frees(stored, account, lease, fence, cursor, now, own, fenced):
  %own : {K.judge.owned(_, Nat.is_eq(fence, K.fence_of(K.live(stored, now))), K.NoHolder{}) == K.Applied{K.NoHolder{}} : K.Verdict}
  %fenced : {K.judge.owned(True{}, _, K.NoHolder{}) == K.Applied{K.NoHolder{}} : K.Verdict}
  {==}

def Laws.stranger_refused(stored, account, lease, fence, ms, cursor, now, other):
  %other : {(K.judge.owned(_, Nat.is_eq(fence, K.fence_of(K.live(stored, now))), K.NoHolder{}),
             K.judge.owned(_, Nat.is_eq(fence, K.fence_of(K.live(stored, now))), K.Held{account, lease, cursor, Nat.add(now, ms)}))
            == (K.Not_the_holder{}, K.Not_the_holder{}) : K.Verdict & K.Verdict}
  {==}

def Laws.stale_fence_refused(stored, account, lease, fence, ms, cursor, now, own, stale):
  %own : {(K.judge.owned(_, Nat.is_eq(fence, K.fence_of(K.live(stored, now))), K.NoHolder{}),
           K.judge.owned(_, Nat.is_eq(fence, K.fence_of(K.live(stored, now))), K.Held{account, lease, cursor, Nat.add(now, ms)}))
          == (K.Fence_mismatch{}, K.Fence_mismatch{}) : K.Verdict & K.Verdict}
  %stale : {(K.judge.owned(True{}, _, K.NoHolder{}), K.judge.owned(True{}, _, K.Held{account, lease, cursor, Nat.add(now, ms)}))
            == (K.Fence_mismatch{}, K.Fence_mismatch{}) : K.Verdict & K.Verdict}
  {==}

def Laws.renew_extends(stored, account, lease, fence, ms, cursor, now, own, fenced):
  %own : {K.judge.owned(_, Nat.is_eq(fence, K.fence_of(K.live(stored, now))), K.Held{account, lease, cursor, Nat.add(now, ms)})
          == K.Applied{K.Held{account, lease, cursor, Nat.add(now, ms)}} : K.Verdict}
  %fenced : {K.judge.owned(True{}, _, K.Held{account, lease, cursor, Nat.add(now, ms)})
             == K.Applied{K.Held{account, lease, cursor, Nat.add(now, ms)}} : K.Verdict}
  {==}

def Laws.break_is_human(stored, a, l, f, e, cursor, now, live):
  %live : {(K.judge(K.Break{False{}}, stored, cursor, now), K.judge.break(True{}, Bool.pick(K.Holder, _, K.Held{a, l, f, e}, K.NoHolder{})))
           == (K.Not_human{}, K.Applied{K.NoHolder{}}) : K.Verdict & K.Verdict}
  {==}

def Laws.nothing_to_break(a, l, f, e, cursor, now, gone):
  %gone : {(K.judge.break(True{}, Bool.pick(K.Holder, _, K.Held{a, l, f, e}, K.NoHolder{})), K.judge(K.Break{True{}}, K.NoHolder{}, cursor, now))
           == (K.Nothing_to_break{}, K.Nothing_to_break{}) : K.Verdict & K.Verdict}
  {==}

def Laws.refusal_changes_nothing(stored, cursor, now):
  {==}
