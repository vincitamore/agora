# RED FIXTURE for law holder_release_frees: a release by the holder leaves a phantom holder behind
# The native board's claim discipline, as a kernel small enough to prove things
# about. A subject has at most one holder; a holder is an account under a lease
# id, fenced at the cursor of the event that gave it the subject, until an
# expiry instant. Every board act is judged against the LIVE holder (an expired
# lease is no holder) and answers with a refusal, which changes nothing, or the
# holder the subject has afterwards.
#
# Accounts, lease ids, fences and instants are Nats: the store maps its ids and
# ISO instants onto them and passes the comparisons' inputs, never their results.

import Base

type Holder is Data:
  NoHolder{}
  Held{account: Nat, lease: Nat, fence: Nat, expires: Nat}

# a board act, with the facts the store knows at the time it is judged
type Act is Data:
  Claim{account: Nat, op: Nat, lease_ms: Nat}
  Renew{account: Nat, lease: Nat, fence: Nat, lease_ms: Nat}
  Release{account: Nat, lease: Nat, fence: Nat}
  Break{human: Bool}
  Contest{}

type Verdict is Data:
  Held_by_another{}
  Not_the_holder{}
  Fence_mismatch{}
  Not_human{}
  Nothing_to_break{}
  Applied{holder: Holder}

# the live holder at instant `now`: a lease that has expired is no holder
def live(h: Holder, +now: Nat) -> Holder:
  match h:
    case NoHolder{}:
      NoHolder{}
    case Held{+account, +lease, +fence, +expires}:
      Bool.pick(Holder, Nat.is_gt(expires, now), Held{account, lease, fence, expires}, NoHolder{})

# whether an act's account and lease name the live holder
def owns(+account: Nat, +lease: Nat, h: Holder) -> Bool:
  match h:
    case NoHolder{}:
      False{}
    case Held{+a, +l, f, e}:
      Nat.is_eq(account, a) && Nat.is_eq(lease, l)

def fence_of(h: Holder) -> Nat:
  match h:
    case NoHolder{}:
      0n
    case Held{a, l, +f, e}:
      f

# the verdict on a claim: refused while a live holder stands, else the claimant
# holds the subject under its operation id, fenced at this event's cursor
def judge.claim(h: Holder, +account: Nat, +op: Nat, +lease_ms: Nat, +cursor: Nat, +now: Nat) -> Verdict:
  match h:
    case NoHolder{}:
      Applied{Held{account, op, cursor, Nat.add(now, lease_ms)}}
    case Held{a, l, f, e}:
      Held_by_another{}

# renew and release share their admission: the holder under that lease, at that fence
def judge.owned(ok: Bool, fenced: Bool, after: Holder) -> Verdict:
  match ok:
    case False{}:
      Not_the_holder{}
    case True{}:
      match fenced:
        case False{}:
          Fence_mismatch{}
        case True{}:
          match after:
            case NoHolder{}:
              Applied{Held{0n, 0n, 0n, 0n}}
            case Held{a, l, f, e}:
              Applied{Held{a, l, f, e}}

def judge.break(human: Bool, stored: Holder) -> Verdict:
  match human:
    case False{}:
      Not_human{}
    case True{}:
      match stored:
        case NoHolder{}:
          Nothing_to_break{}
        case Held{a, l, f, e}:
          Applied{NoHolder{}}

# the verdict on an act. `stored` is the holder the store remembers (expired or
# not); `cursor` is the sequence this event would take; `now` the instant.
def judge(a: Act, +stored: Holder, +cursor: Nat, +now: Nat) -> Verdict:
  match a:
    case Claim{+account, +op, +lease_ms}:
      judge.claim(live(stored, now), account, op, lease_ms, cursor, now)
    case Renew{+account, +lease, +fence, +lease_ms}:
      judge.owned(owns(account, lease, live(stored, now)),
        Nat.is_eq(fence, fence_of(live(stored, now))),
        Held{account, lease, cursor, Nat.add(now, lease_ms)})
    case Release{+account, +lease, +fence}:
      judge.owned(owns(account, lease, live(stored, now)),
        Nat.is_eq(fence, fence_of(live(stored, now))),
        NoHolder{})
    case Break{human}:
      judge.break(human, stored)
    case Contest{}:
      Applied{stored}

# the holder after a verdict: a refusal leaves the stored holder as it was
def after(v: Verdict, stored: Holder) -> Holder:
  match v:
    case Applied{h}:
      h
    case Held_by_another{}:
      stored
    case Not_the_holder{}:
      stored
    case Fence_mismatch{}:
      stored
    case Not_human{}:
      stored
    case Nothing_to_break{}:
      stored
