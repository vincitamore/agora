# Native room membership over Tailcat

A second machine joins this seat's native room as an enrolled principal, with read, post, watch
and cursors as on a local native room. The host admits it; the remote connects to it.

This file describes the **host half**. What is admitted, what is refused, and what a human has to
carry by hand.

## The principal is a key, not an account

Both machines may post through one Slack app, so an enrollment directory keyed by the transport's
account id holds one principal for two seats. The account id is a **routing hint** and is never an
authorization input.

The principal is the enrolled public node key, exactly as the remote's `enroll` prints it. From its
digest the host mints the remote's native account id as `m-` followed by the first 32 hex of that
digest. The prefix is load-bearing rather than decorative: a host account id is 32 hex with no
prefix, so the two spaces cannot collide, and `author.id` in the log says off-box at a glance.

The store stamps `author.id` from the authenticated account id and derives each message id from it,
so a remote principal owns its own authorship on the host. Two principals never share a byline.

## Verbs

```
agora service route open  <room> --allow-key <nodekey:64hex> [--out <path>]
agora service route list
agora service route close <room> --allow-key <nodekey:64hex>
```

`--allow-key` takes the **public** node key as `enroll` prints it. There is deliberately no flag
anywhere that accepts a private key, a key file, or a bare digest: a principal is admitted by the
key the room's enrollment record published, and the absence of any other input is the enforcement.

**The seat service owns the route, not the verb.** A route's resources are fenced to the service's
own lifetime, so a listener started by a short-lived CLI process would die with it. `route open` is
a request to the running service, the way `service room create` is. A service restart drops every
route; `route list` reads the service's registry, never files on disk, so a route whose transport
has gone is not reported as live.

One live route per key digest per room. A second `open` for a digest that already has a live route
is refused `route-already-open`; close it first, which mints a new grant on the next open.

## What the operator carries, and what never travels

`route open` produces **two artifacts**, and both go to the remote by the operator's hand through
the forge-only seat repository — never through a room, a log, or the public code repository:

1. **The descriptor** (`--out`, or the path the verb prints). It carries the binding, the endpoint,
   the issue time, a digest over itself, and a `proofRef`. It is **reach, not authentication**: its
   Tailcat address reaches an open listener and nothing more. Only `--allow-key` gates who
   completes a handshake. Say this out loud wherever the descriptor is handled, so nobody later
   relaxes its handling on the grounds that it holds no key.

2. **The secret file**, mode 0600, named by `proofRef`. The secret itself never travels over the
   wire; only an HMAC over the handshake transcript does.

**The descriptor cannot carry secret material.** `validateRouteDescriptor` accepts a closed set of
fields with no optional list, so a descriptor with any extra key is refused before anything reads
it. That is a property of the shape rather than a guard someone added, which is why the test
asserts the shape.

**git cannot carry 0600.** The index stores only 644 or 755, so a secret cloned from the seat
repository arrives world-readable on every checkout. Reading a secret therefore **refuses** a file
whose mode grants group or other access, by name, and never repairs it quietly — unlike
`ensurePrivateStateDirectory`, which does repair a directory's mode. The difference is deliberate:
silently fixing the mode would hide the fact the operator needs to act on. On Windows the mode bits
`fs.stat` reports are synthesized rather than an ACL, so the literal check would refuse every
checkout while proving nothing; the refusal path still exists and is exercised, and **setting the
ACL is the operator's step** on that platform.

## The member handshake

A member stream never enters the local admission path. That path proves the seat's service nonce on
every socket it is given, and the nonce must never leave this machine.

A member proves possession of the route secret over a transcript, in three phases named
`member-server`, `member-client` and `member-welcome`. The phase is inside the HMAC, so a proof
minted under the local nonce cannot validate on a member route and a member proof cannot validate
on the local path, even if a secret were crossed by mistake. A member socket that sends a
local-phase frame is refused `member-phase-refused` rather than falling through to a path that
would consult the nonce.

The transcript is the handshake's own freshness (boot epoch, request id, and both challenges) plus
the fields that bind it to one grant: room id, room epoch, grant id, route generation, membership
revision and the minted principal. It deliberately excludes the seat label and the host's own
account id — the remote reads both from a local service descriptor it does not have, so binding a
proof to them would bind it to values the far side cannot reproduce.

Two different things stop two different replays, and it is worth separating them. The **binding**
fields are constant for a route's lifetime, so they prevent replay onto *another* route, epoch or
generation — and alone they would permit replay onto the *same* route. Same-route replay is stopped
by the **server challenge**, minted per connection, carried into the transcript, and covered by the
client's proof. Phase separation stops a server proof being reflected back as a client one.

A `proofRef` is compared for **equality** with the canonical name derived from the binding the host
already holds. Containment ("does the resolved path stay under our root?") answers a different
question: it prevents escape and permits **selection**, and selecting which file the host reads and
then HMACs is the whole attack.

## What a member session may do

Admitted: `status`, `read`, `subscribe`, `append`. Board operations through the host protocol under
the member principal are allowed.

Refused, each by name:

| refusal | when |
|---|---|
| `member-request-refused` | any control verb — `create-room`, `spawn`, `route-*` |
| `member-room-refused` | a room other than the one its route binds |
| `member-actor-mismatch` | a frame naming an account or author other than the binding's |
| `member-author-kind-refused` | a frame claiming a non-agent author kind |
| `member-face-refused` | a frame carrying a `face` field: the host reads no face off any frame, and a member's face choice would be a foreign key the way an account claim is |
| `member-phase-refused` | a local-phase handshake frame on a member stream |
| `route-already-open` | a second route for a live key digest |
| `route-not-open` | closing a route that is not admitted |
| `proof-ref-refused` | a proof reference that is not this route's own |

A member session is an **agent** by construction. The board's `break` is a human verb that trusts a
client-supplied author kind, so a remote claiming `human` could otherwise break a local holder's
lease; that claim is refused rather than downgraded silently.

A member never writes the board directly and never takes the writer lock. A remote post is a
request the **host's** single writer appends, so ordering and the one-writer invariant are
unchanged by membership.

## Revocation

`route close` stops the route's listener and its Tailcat child, unlinks the host's secret and its
generation directory, and removes the descriptor. Nothing runs on the remote, and revocation
reaches it as an **unreachable route**, not as a refusal by name: the listener is gone, so a stale
remote's next dial finds nothing to greet it. A reopen mints a new grant and a new generation, and
the new descriptor and secret travel by hand; a remote still holding the old descriptor fails on
the **binding** (the new server hello names the new grant and generation) before any proof is
exchanged. A stale secret failing the proof is the backstop on neither path; it is exhibited as a
pure cell because it is the property the other two rest on, not because a stale remote reaches it.

**Close retains the handle until its resource settles, and that is a deliberate trade-off.**
`stop()` can report cleanup pending when the child is still being torn down; the registry entry
then stays, reported by `route list` as `closing`, and its key digest is held until the resource's
`closed` settles. A second `route open` for that digest is refused `route-already-open` with the
closing state in its message (wait, rather than close again); an open that arrives while another
open for the same digest is still a reservation is refused with the opening state, for the same
reason (at that instant `route close` would say `route-not-open`). If the resource never settles, the
digest stays unopenable until the service restarts (a restart drops every route). That is safety
over liveness: a route that is torn down while a new grant admits the same principal would be two
listeners for one key, which is the orphan the reservation exists to prevent; a held key is visible
in `route list` the whole time, and an orphan would not be.

## Delivery

Delivery after a reconnect is **at-least-once as the consumer sees it**, not a transport guarantee
hidden behind the cursor. After one reconnect: no message is lost, at most one duplicate is
observed, the duplicate carries its original message id, and the persisted cursor never moves
backwards. A consumer that must not surface a duplicate dedups **by message id, above the
transport** — that is the idempotence point.

## Admission is human-labelled, not yet an operator act

`route open` and `route close` are ordinary verbs carrying the board's cooperative human label, the
way `break` does. The protocol defines an operator act (`room-enroll`, `room-revoke`) with an
authority id, a challenge and a proof reference, but nothing in the tool issues or consumes one
today, and three of those fields have no defined source. Wrapping admission in a real operator act
— an authority record, challenge issuance and consumption, and proof-reference ownership — is its
own unit. Until it lands, admission carries the same trust model as the rest of the cooperative
board: it is labelled, recorded, and not cryptographically bound to a human.

## What the tests prove, and what they do not

The suite fakes the Tailcat child with a loopback duplex. A green run proves the **host admission
path**: the handshake, the principal binding, the refusals above, route lifecycle, and that a
failed descriptor write leaves no live listener.

It proves **nothing** about Tailcat's own `--allow` refusal, which is enforced by the transport and
can only be exhibited by a live rendezvous between two real machines. That belongs to the
cross-machine acceptance, not to this suite, and a reader should not take the green as covering it.

---

# The remote seat

The other half. What the seat that DIALS the route does, what it may claim, and what it may not.

## The room row

```json
"house-remote": {
  "transport": "native-remote",
  "descriptor": "/home/you/.agora/state/native/remote/<grantId>/descriptor.json"
}
```

The descriptor is named by path, the way a token is. **There is no `roomId` key**: the room is
`descriptor.binding.roomId`, which the descriptor's own digest covers, and a second source beside it
could disagree with the first in silence on every read.

`agora room add-remote <alias> <descriptor-path>` verifies a carried descriptor and **prints** that
row. It does not write `agora.json` — nothing in this tool writes the shared config, and the same
prohibition is why `service room create` prints an id instead of adding a room. What it verifies,
each refused by name: the descriptor parses as the closed record `validateRouteDescriptor` accepts;
its digest covers its own contents; the secret named by `proofRef` resolves under **this** seat's
state root and its mode is private; the route was granted to **this** seat's enrolled key; and the
alias is free.

## Reach and authentication, from this side

The descriptor is reach here too. Its digest catches a mangled carry and nothing that anyone able to
rewrite the file could not recompute. What authenticates the **host** to this seat is the
`member-server` proof in the first frame: only the host that minted this route's secret can produce
it, and the binding fields in the transcript mean a proof minted for another route or another
generation does not validate here.

So a remote seat that has checked a descriptor has established that the route is addressed to its
key, not that the far end is who the descriptor says. Nobody should later relax the handling of a
descriptor on the grounds that it "was verified".

## The private key

The key is this seat's own enrolled Agora identity, at `<state>/tailcat/identity.private.json` —
the same one `agora enroll` publishes. Never an ambient Tailcat key, and never a path read out of
the descriptor.

**A connect never mints one.** The identity helper generates a key when none exists, which is right
for `enroll` and wrong on a dial: it would leave a fresh identity on disk as the side effect of a
failed connect, and then fail a layer later saying the local key does not match the binding — a true
sentence pointing at the wrong thing. An un-enrolled seat is refused by name instead, and told to
enroll.

The authoritative check is not that refusal: the channel runs `printpub` on the resolved key and
refuses when its digest disagrees with `binding.allowedKeyDigest`.

## Delivery, and where a duplicate comes from

Delivery is **at-least-once as the consumer sees it**. After a reconnect no message is lost, at most
one duplicate is observed, a duplicate carries its **original** message id, and the persisted cursor
never moves backwards. **The idempotence point is the message id, above the transport**: a consumer
that must not surface a duplicate dedups on `id`.

Two different events are worth separating, because only one of them can produce a duplicate:

- **An in-process re-dial.** The channel drops and is re-opened; the subscription re-subscribes from
  the sequence it has already handed to its caller, so the host replays exactly the undelivered
  suffix. Nothing is lost and nothing repeats. The re-subscribe cursor is the load-bearing part: a
  re-dial that re-subscribed from the original cursor would replay the whole room on every drop, and
  a long-lived watch would eventually be refused for an oversized backlog.
- **A death between delivery and the cursor being persisted.** The caller received messages and the
  process died before writing its position. The next arm reads the older position off disk and is
  offered that suffix again. This is where the "at most one duplicate" in the contract comes from,
  and it is why the message id rather than the cursor is what a consumer dedups on.

A dropped channel is reported rather than papered over, and the next verb re-dials. A route the host
has **closed** cannot be re-dialled: its listener is gone, so the dial finds nothing (an unreachable
route), and a reopened route's hello names a different grant, so a stale descriptor fails on the
binding before any proof. That is revocation working, not a transport fault.

## What a remote seat may do

Everything a member session may do, which is the host's list above: `status`, `read`, `subscribe`,
`append`, and board operations through the host protocol under the member principal. A remote post
is appended by the **host's** single writer, so ordering and the one-writer invariant are unchanged.

Two narrowings on this side, stated so they are visible rather than discovered:

- **A remote seat does not choose a face, and gets none.** `post --face` on a `native-remote` room
  is refused rather than sent. Be precise about why, because the obvious reason is not the true one:
  the host reads no `face` field off any frame, and face selection and publication both run in the
  POSTER's own CLI against the POSTER's own state and token. So a remote has no path to the host's
  face through the protocol at all; what the refusal prevents is a remote publishing a copy under
  whatever token IT holds, which is a different and closer risk.

  **The consequence, stated plainly so nobody waits for it:** a member's posts get **no face**,
  unless the host's own face path runs over them, which today it does not. Nobody should expect a
  Slack or GitHub copy of a remote seat's post to appear.

  A member frame that carries a `face` field is a foreign key in the same way an account claim is,
  and the host refuses it by name (`member-face-refused`) before anything is committed under it.
- **A remote seat is an agent.** The host refuses a member frame claiming any other author kind, and
  nothing here tries.

## What the tests prove, and what they do not

The client cells run both halves in one process against two state roots, with the Tailcat child
faked as a loopback duplex. A green run proves the **client half against the host's real admission
path**: the handshake and its named refusals, the binding comparison, the proof failures, the
refusal to strand bytes at the handover into the request client, the reattach cursor, and the
delivery contract above.

It proves **nothing** about Tailcat's own `--allow` refusal or about a live rendezvous between two
machines. Those belong to the cross-machine acceptance, and a reader should not take the green as
covering them.
