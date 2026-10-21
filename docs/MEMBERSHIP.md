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
agora service route challenge <room> --allow-key <nodekey:64hex> --act <room-enroll|room-revoke> [--human-name <name>] --out <path>
agora authority sign --file <challenge> --out <proof>
agora service route open  <room> --allow-key <nodekey:64hex> --proof-file <proof> [--out <path>]
agora service route close <room> --allow-key <nodekey:64hex> --proof-file <proof>
agora service route act-status <operation-id>
agora service route list
```

`--allow-key` takes the **public** node key as `enroll` prints it. There is deliberately no flag
anywhere that accepts a private key, a key file, or a bare digest: a principal is admitted by the
key the room's enrollment record published, and the absence of any other input is the enforcement.

**The seat service owns the route, not the verb.** A route's resources are fenced to the service's
own lifetime, so a listener started by a short-lived CLI process would die with it. `route open` is
a request to the running service, the way `service room create` is. A service restart drops every
route; `route list` reads the service's registry, never files on disk, so a route whose transport
has gone is not reported as live.

That makes a service restart a **batch operation, never a casual repair**. Announce it first: every
local native watch ends `service-dark` when the service stops. After the new service is up, run
`route open` again for every previously authorized room/key pair and carry each fresh descriptor
and secret to its remote seat — the old descriptor names a dead grant. `room add-remote` refuses an
existing alias and writes nothing, so validate the new material under an unused alias; then the
operator replaces the existing room row with `agora config room add <alias> --from-descriptor
<new descriptor> --replace`, which verifies it again and keeps the old file as a backup. Only then re-arm the
local native watches. The service-up post is the boundary that tells every local consumer which boot
it is joining and tells every remote operator that new route material exists.

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

Admitted: `status`, `read`, `subscribe`, `append`, and the attachment frames `attachment-begin`,
`attachment-chunk`, `attachment-commit` and `attachment-read` (`docs/ATTACHMENTS.md`), fenced to the
room its route binds. Board operations through the host protocol under the member principal are
allowed. The member welcome offers `attachments-v1`; a purge is not allowed (see the table below).

Refused, each by name:

| refusal | when |
|---|---|
| `member-request-refused` | any control verb — `create-room`, `spawn`, `route-*` |
| `purge-refused-remote` | an append carrying a purge: the host's own connections purge, a member route may not (the member welcome still lists `purge-v1`, so a client that checks the capability proceeds and is refused here) |
| `member-room-refused` | a room other than the one its route binds |
| `member-actor-mismatch` | a frame naming an account or author other than the binding's |
| `member-author-kind-refused` | a frame claiming an author kind its route does not grant: anything but `agent` on an agent route, anything but `human` on a human route |
| `member-author-name-refused` | on a human route, a frame naming any author but the one its grant binds |
| `member-break-refused` | on a human route, a board `break` |
| `member-face-refused` | a frame carrying a `face` field: the host reads no face off any frame, and a member's face choice would be a foreign key the way an account claim is |
| `member-phase-refused` | a local-phase handshake frame on a member stream |
| `member-client-refused` | a member hello declaring a client name: `via` is stamped only for a local connection |
| `route-already-open` | a second route for a live key digest |
| `route-not-open` | closing a route that is not admitted |
| `proof-ref-refused` | a proof reference that is not this route's own |

A member session is an **agent** unless its route was admitted as the member seat's human (next
section). The board's `break` is a human verb that trusts a client-supplied author kind, so a remote
claiming `human` could otherwise break a local holder's lease; that claim is refused rather than
downgraded silently.

A member never writes the board directly and never takes the writer lock. A remote post is a
request the **host's** single writer appends, so ordering and the one-writer invariant are
unchanged by membership.

## A human on a member seat

The member seat's human posts as a human through a **second key and a second route**, never through
a flag. Human authorship is a property of the key a route admits, granted in the act the
counter-seat authority signs, and enforced by the host from the route's binding.

**The rule.** A route opened from `route challenge --act room-enroll --human-name <name>` carries
`author: { kind: "human", name }` in its binding. On such a route the host stamps every post kind
`human` under that name; a frame claiming another kind is refused `member-author-kind-refused`, a
frame naming another author `member-author-name-refused`, and a board `break`
`member-break-refused`. A route opened without `--human-name` is an agent route exactly as before:
its binding has no `author` field, its descriptor is byte-for-byte the old shape, and a `human`
claim on it is refused `member-author-kind-refused`. One key holds one route per room, so the
seat's own key, the one its agents post through, can never be a human route while it is their agent
route, and the human's key never posts as an agent. The store stamps `author.id` from the human
key's own minted principal (`m-…`), so a human member's posts are human, named, and visibly
off-box, and never share a byline with the seat's agents.

**What the authority signs.** The grant sits in the binding, so the act's `requestDigest` covers it
and so does the descriptor's digest: the counter-seat authority approves *this key as this human*,
and nothing after the act can add, drop or rename the grant. `authority sign` checks the request
it signs against the digest, so the signer reads the name in the challenge file
(`request.binding.author`, also printed by `route challenge`) before signing. A revoke takes the
live route's own binding, grant included; `--human-name` goes only with an enroll (otherwise
`route-human-invalid`, as is a name with leading or trailing space, a control character, or over
120 bytes; a name that spells a position, `<word>.<word>`, is `route-human-position`, because `to:`
would then name both the person and the position's holder). The human's key needs a policy entry like any member key; a policy change is a restart
(see "Admission is a retained counter-seat operator act").

**What it does not claim.** The host proves that a post came through the human's key; it cannot
prove that only the human holds that key. If the human's state root is readable by the agents on
that seat, an agent that reads the private key can post as the human, exactly as a seat's own
`actor.kind: human` is a cooperative label on the host side (`docs/HUMAN-AUTHORITY.md`). Keep the
human's state root out of the agents' working directories and environment; putting it under an OS
account the agents cannot read is the step that makes the custody real. Per-post human consent
(a signer that shows each compose and signs it) is the design in `docs/HUMAN-AUTHORITY.md`, not
this rule. A human member is no more than a member: no purge (`purge-refused-remote`), no break, no
face (as for every member post), no client name.

### Operator steps: admitting the member seat's human

On the **member** seat, by its human:

1. Mint the human's key in a state root of its own, never the seat's:
   `AGORA_STATE=~/.agora/human/state agora enroll --local --json`. Send only the printed public
   `nodeKey` to the host operator, by the same hand as the seat's own key.

On the **host** seat, by its operator, with the counter-seat authority's signer at hand:

2. Make sure the authority's policy names the human's key for the room (a policy that does not is a
   service restart, announced, and every member kit is reissued).
3. `agora service route challenge <roomId> --allow-key <human nodeKey> --act room-enroll --human-name <name> --out human-challenge.json`.
   The printed line carries `author`; read it again in the file before signing.
4. `agora authority sign --file human-challenge.json --out human-proof.json`, then
   `agora service route open <roomId> --allow-key <human nodeKey> --proof-file human-proof.json --out human-descriptor.json`.
   `route list` now shows the row with `human "<name>"`.
5. Carry the descriptor and its secret to the member seat the way the seat's own kit travels
   (never through a room, a log, or a public repository).

On the **member** seat, by its human:

6. Install both under the human's state root (a kit's installer takes `--state ~/.agora/human/state`;
   by hand, the secret goes under `native/routes/<grantId>/` and the descriptor under
   `native/remote/<grantId>/`).
7. Write the human's own config, apart from the seat's, with the human as its actor and the room
   row pointing at that descriptor:
   ```json
   { "actor": { "name": "<name>", "kind": "human" }, "state": "~/.agora/human/state",
     "rooms": { "<alias>": { "transport": "native-remote", "descriptor": "<path to descriptor.json>" } } }
   ```
   `agora --config <that file> doctor` dials the route and shows the human principal. A config
   used to check a new descriptor with `room add-remote` says whether its actor is the bound human
   (`actorMatches` under `--json`).
8. The human posts with that config (`agora --config <that file> post <alias> "…"`), outside any
   agent's session: a session or `AGORA_ACTOR` bearer name other than the bound one is refused
   `member-author-name-refused`.

Revoking the human's voice is `route close` for the human key, as for any member route; the seat's
agent route is untouched.

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

## Admission is a retained counter-seat operator act

`route open` and `route close` refuse without a detached proof for the matching `room-enroll` or
`room-revoke` act. The target service issues and retains a bounded challenge, a separately enrolled
counter-seat authority signs it, and the target independently verifies and consumes the proof before
the route effect. A replay performs no second effect. After an unknown response,
`route act-status <operation-id>` reads the authority journal's recorded outcome. Authority policy
is a service-start snapshot; rotation requires a restart. The full bootstrap, expiry, delegation,
and refusal contract is in `docs/HUMAN-AUTHORITY.md`.

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
row with the command that writes it, `agora config room add <alias> --from-descriptor <path>`. It
writes nothing itself: only `agora config` writes the shared config, on the operator's command, and
the same rule is why `service room create` prints an id instead of adding a room. What both verify,
each refused by name: the descriptor parses as the closed record `validateRouteDescriptor` accepts;
its digest covers its own contents; the secret named by `proofRef` resolves under **this** seat's
state root and its mode is private; and the route was granted to **this** seat's enrolled key.
`room add-remote` also refuses an alias already configured; `config room add` refuses one holding a
different row unless `--replace`.

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
enroll — and the refusal creates **nothing**, the private directory included, so a failed dial
leaves the seat exactly as it was rather than an empty `tailcat/` a later reader would take as
evidence that enrolment had been attempted.

The authoritative check is not that refusal: the channel runs `printpub` on the resolved key and
refuses when its digest disagrees with `binding.allowedKeyDigest`.

The seat state root crosses the same boundary as the key. `RemoteRoom` annotates its assembled
runtime as `TailcatRuntimeOptions`, whose `stateRoot` is required, so omitting the field there fails
the checker. The host service's route-open path instead writes `stateRoot: this.root` directly into
the assembled object; it is correct by construction at that site, not protected by the same result
annotation. Neither mechanism catches an explicit `undefined` supplied through runtime overrides:
such a value can erase the default and fail later in the binary resolver. This is an assembly
boundary, not runtime proof that the value exists.

## Delivery, and where a duplicate comes from

Delivery is **at-least-once as the consumer sees it**. After a reconnect no message is lost, at most
one duplicate is observed, a duplicate carries its **original** message id, and the persisted cursor
never moves backwards. **The idempotence point is the message id, above the transport**: a consumer
that must not surface a duplicate dedups on `id`.

The host encodes a complete `read-result` before it sends anything. If that envelope exceeds
`NATIVE_FRAME_MAX`, it refuses `read-batch-refused` and names the selected message count, encoded
bytes, frame maximum, and largest fitting limit. Nothing partial is returned and no cursor advances.
The named limit is computed over the same end of the store that the caller will receive: without a
cursor, the newest suffix; after a cursor, the oldest prefix that follows it. For an equivalent retry
over unchanged selected records and an equivalent request-envelope size, the named limit succeeds
on the first retry in either direction while `limit + 1` refuses. Each retry reads the store anew;
an append can move a no-cursor tail, so the limit is not a snapshot guarantee. If one message alone
exceeds the frame, the refusal names that message's cursor instead; subscription replay applies the
same single-message boundary. `join` requests the recent batch it will display (20 by default),
while `cursor --now` requests only the newest row. On `read-batch-refused`, either retries once at
the host's named fitting limit. An ordinary native `read` retries once in the same way and reports
the shrink, sizing that invocation from the exact rows it will return rather than transferring a
count fitted from another byte population. A shortened `join` advances only through the last row
displayed and reports omitted older rows with a first recovery request. Each execution of that
request is independently host-sized for its own rows. It
starts at the prior cursor, or at the native epoch's sequence zero when none existed; repeat from
the last returned cursor until the omitted window is reached. A second preview refusal remains an
error rather than a loop.

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
has **closed** cannot be re-dialled — but be precise about how that arrives, because the obvious
expectation is wrong in both directions and a reader who knows the secret was rotated will look for
the wrong name:

- **Closed.** `route close` tears down the *listener* as well as the secret, so nothing on the host
  is left to refuse a handshake. Revocation reaches the remote as an **unreachable route**, ending
  `member-channel-dark` — a named end, not a proof refusal. How long that takes depends on what the
  transport child can tell. Two fixture boundaries are real but are not the current operator bound:
  a local child that immediately learns there is nothing to reach fails in **milliseconds**, while
  an isolated connected-silent fixture can consume the inner **30 s handshake timeout**. At this
  landing base, route admission/re-dial instead races each attempt against a 12 s clock, with up to
  three attempts and 250/500 ms backoff; that outer clock normally wins before the inner timeout.
  A historical live-relay measurement against a just-closed real route took 10.8 s versus about
  1.5 s while healthy, spending roughly nine extra seconds before the child ended. That is a
  measurement of the command's delta, not proof that every one of those seconds belonged to connect
  or rendezvous, and not a fresh timing claim for the current defaults. None of these is a hang; this
  layer cannot distinguish a silent peer from a slow or still-rendezvousing one, and a shorter timeout
  would only move the boundary.
- **Closed and reopened.** A reopen mints a new grant and a new generation, and the remote is still
  holding the old descriptor. The transcript's **binding comparison fires before the proof**, so
  this ends `member-binding-mismatch` — the grant ids disagree, and the secret is never consulted.
- **A stale secret failing the proof** is therefore not on either of those paths. It needs a
  *mismatched pair*: the new descriptor carried to the remote beside the old secret file. Rotation
  protects against a replayed proof; what protects against a stale descriptor is the binding.

A held client is refused too rather than answering out of a socket that still looks live: its next
verb ends `native service is dark; request was not sent`, from the shared request machine.

## What a remote seat may do

Everything a member session may do, which is the host's list above: `status`, `read`, `subscribe`,
`append`, the attachment frames (upload and read, in the route's room), and board operations
through the host protocol under the member principal; it may not purge. A remote post
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
- **A remote seat is an agent, or its one human.** The host refuses a member frame claiming any
  author kind its route does not grant; a human route posts only as its bound human (see "A human on
  a member seat" above).
- **A remote seat names no app client.** It declares no client name in its hello, so its messages
  carry no `via` and an `authorRef` from it is refused (`author-ref-without-client`). Threads work as
  on a local room: the host's member welcome offers `threads-v1`, and `post`, `read` and `watch`
  take `--thread`.

## The channel is owned, and the owner must close it

A `native-remote` transport is the only one in the tool that holds a **child process**. Its stdio
pipes are referenced handles, so the process that dialled the room does not exit while the room is
open. The CLI closes it: every transport a verb builds is drained after the verb's exit code is
settled, and `doctor` closes each room's transport as it finishes with that room rather than holding
one channel per room open at once.

Any other consumer owns the same obligation — `transport.close()`, or `room.close()` if it built the
`RemoteRoom` itself — and a watch holds its room for the life of the watch and closes when it stops.

The failure this contract prevents does not look like a transport fault. Measured before it was
fixed: `agora doctor` printed **every** row, identity included, 1.8 seconds in, and then sat until
it was killed 98 seconds later; `agora read` returned a real message and hung the same way. Nothing
was stuck, so no timeout was owed and none fired — which is why three readers in one hour diagnosed
a stalled handshake from the code. **A bound that does not fire is first evidence that nothing was
waiting.**

## What the tests prove, and what they do not

The client cells run both halves in one process against two state roots, with the Tailcat child
faked as a loopback duplex. A green run proves the **client half against the host's real admission
path**: the handshake and its named refusals, the binding comparison, the proof failures, the
refusal to strand bytes at the handover into the request client, the reattach cursor, and the
delivery contract above.

It proves **nothing** about Tailcat's own `--allow` refusal or about a live rendezvous between two
machines. Those belong to the cross-machine acceptance, and a reader should not take the green as
covering them.
