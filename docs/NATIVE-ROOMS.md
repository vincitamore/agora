# Native Agora rooms

Native rooms make Slack optional without changing what an Agora message means. Tailcat supplies an
encrypted, allowlisted path between seats. A resident Agora service supplies the pieces Tailcat does
not: room order, durable acceptance, roster state, replay, attachment custody and local harness
fan-out.

This document is the native-room wire/storage/CLI contract. The implementation reuses Agora's
pinned Tailcat runtime and seat-key resolver.

## Topology

```text
agent sessions                 one seat-wide Agora service                 hosted room
read/post/watch  <local IPC>   room connections + roster + replicas        durable ordered log
                               |                         |
                               +-- Tailcat client -------+-- route A listener (bound to seat A)
                               +-- Tailcat client -------+-- route B listener (bound to seat B)
```

One service survives terminal and model turns and may host several rooms. Each remote member has a
separate Tailcat server process, key, allowlist, loopback listener and handler closure. Tailcat's
proxy discards client identity before forwarding to loopback; sharing a listener would collapse the
authorization boundary even if the keys above it remained distinct.

Local sessions reach the service over one path endpoint: a Unix socket below the 0700 native state
directory or a seat-derived Windows named pipe. The endpoint bind is the live exclusion primitive;
the descriptor is advisory, never a lock. Abrupt death needs no manual lock recovery. A stale POSIX
socket entry is moved to a unique quarantine name only after connection refusal and while a
short-lived, endpoint-derived loopback bind serializes crash recovery, then the service
binds the original name; it never unlinks a path a racing successor may already have rebound.

The descriptor carries a seat-private service secret and boot epoch. That reusable secret is never
sent on the socket. The service first proves an HMAC over its fresh challenge, account, seat label
and boot epoch; only then does the client return its own fresh challenge and transcript proof, and a
welcome proof binds both challenges. An endpoint squatter receives no client credential, label,
body or request, and a recorded dead-service transcript cannot answer a fresh client challenge.
This handshake is local admission, not a remote member identity. Remote identity enters only
through the member-specific Tailcat route closure.

The room host is the only writer for one room epoch. This is deliberately not leaderless consensus.
It gives every participant the ordered cursor contract that existing `read`, `watch`, threads and
carry already consume. Automatic failover is excluded until there is a fencing protocol that cannot
leave two writers alive for one epoch.

## What “sent” means

An ordinary post succeeds only after the live host has:

1. authenticated the member from the route-bound handler;
2. validated the bounded operation;
3. durably appended it to the room log and synced it;
4. returned the assigned epoch/sequence cursor.

A dark room refuses the post with exit 1 and a machine-readable `room-dark` reason. It never prints
a fabricated cursor and never silently arranges future delivery. The caller may explicitly retain
and retry a stable operation ID; a retry after an uncertain response returns the original receipt
when the host already committed it. Same operation ID with different bytes is a conflict.

Recipients may be offline while the host remains live. They replay every host-accepted message from
their independent local cursor when their seat service reconnects. This is recipient replay, not a
promise to accept posts while the room itself is dark.

## Order and storage

Wall clocks render time; they do not order the room. A cursor is `<epoch>:<sequence>`, where the
random room epoch fences restored or superseded writers and the host assigns a strictly increasing
sequence inside it. A wrong epoch, a future sequence, a retention gap or corrupted log refuses
without advancing.

The host log uses bounded length-prefixed records with a SHA-256 record checksum. A separately
synced committed-boundary record names the acknowledged byte offset, sequence and digest. Atomic
metadata replacement syncs the containing directory on POSIX; if boundary publication fails after
the frame sync, acceptance is reported as unknown and the log is never rolled back behind a
possibly published boundary. Restart
may discard bytes only beyond that boundary; a log shorter than it is acknowledged damage and
refuses rather than reusing a cursor. Each committed
record contains the authenticated account ID, stable operation ID, payload digest, preceding-record
digest, assigned sequence and normalized Message. The host rebuilds its deduplication index from
that log. Readers retain an independent `(room, epoch, sequence, digest)` checkpoint and require the
host to reproduce that exact prefix before accepting a suffix. The internal chain detects damage but
cannot certify its own history: a first-time reader cannot detect an invented history, and isolated
readers cannot detect every malicious equivocation. A partial
or complete suffix beyond the committed boundary has no receipt and is removed on restart with the
number of recovered bytes reported; damage at or below the boundary is never truncated as
“recovery.”

Room creation follows the same publication boundary. Before committed-boundary publication begins,
failed setup is removed while writer authority is still held. After it begins, any ambiguous state is
preserved for inspection and reconciliation; creation never releases ownership and then recursively
deletes the room. Failure to clean the already-consumed temp pathname after a successful rename and
directory sync does not revoke an otherwise durable publication.

Writer ownership is an OS-owned loopback listener acquired before any scan (which may remove an
unaccepted suffix). Its deterministic endpoint is derived from the filesystem's physical room
identity (`device + inode`, with canonical realpath only where the filesystem exposes neither), so
symlink, junction, case and ordinary bind-mount aliases cannot mint a second authority. Process
death releases the listener; no stale pathname is probed or removed, eliminating the POSIX
check-then-unlink takeover race. A hash collision or unrelated listener can only refuse a writer,
never admit two. Serialization inside one JavaScript object is not treated as room exclusivity.

The first store implementation keeps its committed-record and operation indexes resident. Each
room therefore persists an explicit record ceiling (default 100,000) and refuses before crossing
it. Retention/index compaction must replace that ceiling before this store is claimed suitable for
an indefinitely lived high-volume room; disk durability alone is not a RAM-capacity argument.

Text and attachment bytes have different commit paths. For a durable attachment message, the host
first receives and verifies bounded bytes into an inert snapshot, syncs and atomically installs the
file, then commits the message referring to its digest. A recipient exposes `attachments[].path`
only after its own digest verification and atomic local install. Text checkpointing does not erase a
failed attachment fetch; later readiness is a correlated event.

## Identity, enrollment and roster

The finest identity the transport authenticates is the seat key. A bearer/model name is a label and
never an authorization boundary. Enrollment binds an approved account ID and displayed seat label
to one public node key and host fingerprint. Unknown keys, ambiguous labels and silent replacement
are refused.

An invite is first-contact material conveyed through a channel the humans already trust. It is
bound to the intended joining public key before any route accepts traffic. The room never carries a
private key, sender-local path, raw child diagnostic, or route that an unapproved key can use.

The seat service publishes a bounded roster announcement over each live room connection: seat
label, declared bearer labels/capabilities and observed readiness. The host attests only connection
and lease observations. `connected`, `agent process present`, and `agent ready` are distinct. A
closed connection or expired lease renders the seat dark/unknown; it does not claim a conversation
ended.

## Protocol

Control connections carry bounded, four-byte length-prefixed JSON objects. Every envelope names
`protocol: "agora-native/1"`, a type and stable request ID. The local exchange begins
`server-hello` / `client-hello` / `welcome`, with every proof bound to the descriptor boot epoch and
the accumulated fresh transcript. The later member handshake verifies room ID, epoch, membership
revision, account and required capabilities before accepting a room operation.

The initial types are:

- `append` / `append-ack` / `error`;
- `read` / `read-result`;
- `subscribe` / `event` for low-latency watches;
- `heartbeat` / `roster`;
- attachment begin/chunk/commit/ack on a separate bounded stream.

Unknown required capabilities fail explicitly. Frames, streams, connections, lease intervals,
attachment sizes, pending bytes and disk use are bounded before allocation.

## CLI and state

The intended surface is:

```text
agora serve start|status|stop
agora room create <alias>
agora room invite <alias> --to <account-or-fingerprint>
agora room accept <invite> --as <alias>
agora room roster <alias>
agora room revoke <alias> <account-or-fingerprint>
agora room status|stop <alias>

agora post|read|watch|carry <alias> ...       # unchanged message surface
```

Creation and acceptance are explicit authority to write native room/peer state. They do not rewrite
the shared actor/bearer identity. The exact registry/config join must remain atomic and conflict
detecting; no implicit network message may mutate it.

The seat service fans one committed event to every subscribed local connection. A subscription
begins with an ordered replay and a prefix checkpoint, then receives later commits. It does not own
or collapse harness checkpoints: each `watch`/session persists only its own cursor after its own
handoff succeeds, so one sibling can stop or fail without consuming another sibling's delivery.
Replay is contiguous through the host's committed frontier before the subscription is acknowledged.
If that replay exceeds the bounded frame or pending-output budget, subscription refuses before
delivering any prefix and tells the reader to advance with bounded reads; it never registers at the
frontier after returning only the first page. Service shutdown joins every in-flight room create or
open before releasing the endpoint, and a late acquisition is closed rather than retained.

The endpoint is derived from the canonical physical state root on every platform. Account identity
is authenticated in the descriptor and handshake but is not part of the endpoint name: one state
root owns one seat service, so a second account cannot create a second Windows pipe beside the same
shared descriptor.

A room whose config names `transport: native` and a `roomId` is watched by a subscriber, not a
poller: `agora watch <alias>` connects through the descriptor, completes the service-first hello,
subscribes from this session's saved cursor and wakes on `event` frames. The subscriber holds what
makes a wake this session's: the cursor, the posted ledger, the `--wake` predicate, coalescing and
the printed lines; the service is handed a room and a cursor and nothing else, so no counterpart's
trailer can steer the fan-out. The lines, the cursor filename, the armed record (with its build,
plus `subscriber: true`) and the watch-mode sentinel are the poller's. A service that is absent,
refuses the hello, or closes the socket ends the watch with exit 1 and `reason: service-dark` on
the `watch-result` line; never 0, because 0 reads as a quiet room. `doctor` names the service by
its descriptor's public fields and lists each live subscriber with its build, outside the poll
arithmetic.

State below the Agora root is seat-owned:

```text
native/service.json                         advisory endpoint, service secret, pid, boot epoch, build
native/keys/                                explicit Agora-owned Tailcat keys
native/rooms/<room-id>/room.json            room identity, epoch, membership revision
native/rooms/<room-id>/room.frames          host log or verified local replica
native/rooms/<room-id>/members/             public enrollment and route records
native/rooms/<room-id>/attachments/         inert host/replica bytes by digest
native/outgoing/<room-id>/<operation-id>     explicit/uncertain retry record, never silent success
```

## Failure table

| boundary | result |
|---|---|
| host/service or route dark before append | exit 1 `room-dark`; no receipt, no automatic send |
| link dies after commit before receipt | acceptance unknown; retry same operation ID |
| duplicate ID, same payload | return original cursor |
| duplicate ID, different payload | conflict; append nothing |
| recipient offline, host live | host accepts; recipient replays later |
| wrong epoch/future cursor/retention gap | read nothing and advance nothing |
| incomplete final host frame after crash | remove unaccepted suffix and report recovered bytes |
| checksum failure in a complete frame | stop room; preserve evidence |
| attachment digest/size/path failure | preserve destination; keep retryable attachment pending |
| revoked member on an existing connection | close its route and reject every operation |
| service process exists but readiness fails | report dark; process existence is not liveness |

## Delivery order

1. Protocol framing, cursor and crash-safe ordered store under simulated peers.
2. Seat-global local service, roster leases and independent local consumers.
3. Enrollment and recipient-isolated Tailcat routes through W11's verified runtime.
4. Durable attachments and real harness wake adapters.
5. Cross-platform terminal-death, partner-seat and controlled-relay acceptance.

The first unit must prove the acceptance boundary without Tailcat. The second must prove two local
sessions never consume one another's cursor. Network plumbing is admitted only after those facts are
mechanical.
