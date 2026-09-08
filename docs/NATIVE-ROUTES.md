# Native Tailcat route resources

These are local service integration primitives. They do not start from ordinary
reads, add a CLI command, or grant authority from a parsed room message. The seat
service must retain each returned resource until `closed` settles. See
[protocol contracts](PROTOCOL.md) and [native rooms](NATIVE-ROOMS.md).

## Ownership and admission

`src/tailcat-routes.mjs` exports:

```js
startMemberRoute({binding, allowedNodeKey}, options)
// -> {ready, closed, stop}
// ready: {binding, endpoint: {transport: 'tailcat', address, port}}

startMemberChannel({descriptor}, options)
// -> {ready, closed, stop}
// ready: {binding}, after the P1 session reports admission
```

Both take the live local `owner` (`serviceId`, `serviceBootId`, `signal`), trusted
runtime resolver settings, and `acceptChannel(binding, duplex, signal)`. That
callback returns a local `{ready, closed, stop}` session handle; the service owns
its framing, proof and grant checks. Startup/stop deadlines and a channel bound
are configurable. Tests can inject listener, spawn and address-reader operations.
Injected duplexes must emit `close` after actual disposal, as the production
Socket and `Duplex.from` paths do; an arbitrary `emitClose:false` stream does not
meet that route dependency contract and leaves cleanup pending.

Outbound also requires `assertDescriptor(descriptor, signal)` and
`resolveClientKey(binding, signal)`, returning an absolute local `keyPath`. The
existing Tailcat parser checks the address; `printpub` checks the resolved key's
public digest against the binding before connection. P1 must keep that private key
file immutable for the route's lifetime; checking it and later opening its path is
not an atomic key pin against a hostile process sharing the OS account.

Each host ingress has its own loopback listener and Tailcat child with one exact
allowed member key. Its captured `RouteBinding` is passed to the service's
`acceptChannel` callback; incoming bytes cannot choose a different account, grant,
room or route generation. The service checks current authority again at serialized
effects. Validation and the allowlisted transport alone are not that check.

An outbound descriptor must be accepted by trusted local service code before any
network launch. A descriptor's `proofRef` is a reference, not proof merely because
the DTO accepts it. Native key resolution is explicit and separate from W11 offer
discovery. The binding's service boot identifies the host; an outbound caller's
resource owner is its own local service and can have a different boot.

The runtime guardian remains a nested owned resource, not another resident service.
Stopping a route fences new local admission, cancels pending admission, destroys
owned sockets, and joins late-returned sessions and children. A bounded stop timeout
reports cleanup pending; it never settles actual `closed` as a success. P1 revokes
the canonical grant before teardown and rejects buffered requests at commit.

## Immutable object stream seam

`createRouteObjectSender(binding, allowlist, {signal, maxBytes, openObject})` in
`src/tailcat-custody.mjs` captures a validated binding and an explicit list of durable
`WireAttachment` objects. Each has a unique ID, exact digest and size. `maxBytes` is
an explicit local service policy; an entry exceeding it refuses before acquisition.

`sender.send({id, digest, lifetime}, destination)` accepts only an exact entry in that
list. It does not accept a directory, filesystem path, changed digest or offer
ordinal. The trusted P1 callback is:

```js
openObject(binding, attachment, signal)
// -> Promise<{info, readable, closed, release}>
```

P1 checks live membership and room policy, returns an immutable pinned readable
stream and aborts the route signal on revocation. `release()` relinquishes that
specific pin. `closed` is the owner's promise of actual stream-resource disposal;
EOF, `destroyed` and `stream.finished()` are not interchangeable with disposal for
all Node stream configurations. P2 destroys the stream and joins `closed` before
releasing the pin. No consumer-visible writable hard link or reopen-by-path is involved.
The callback must eventually return or reject when cancelled; a late successful
acquisition is still destroyed and released by P2. Callback code runs inside the
trusted service boundary; these JavaScript interfaces are not wire capabilities.

P2 checks the returned identity/size against the allowlist, bounds emitted bytes,
hashes them and checks the final digest and size. Cancellation, source error,
destination error and mismatched content all reject and release the pin. A failed
release also prevents successful return. The successful result is `{id,digest,size}`.

Streaming can deliver a prefix before a later digest mismatch. The receiver must
stage privately and verify before materialization or acknowledgement. A successful
sender result does not prove receiver storage or native message commitment. This
module generates neither kind of receipt and does not publish attachments itself.

## Acceptance boundaries

Direct transport requires a reachable UDP endpoint in both directions. On a
network with multiple WANs, check the public source address and port of packets
sent to the actual peer: a successful STUN query describes that query's path,
which can differ from the peer's route or source-NAT mapping. Relay connectivity
can remain healthy while those direct packets use an unreachable or unexpected
public endpoint.

In particular, a peer address inside a WAN interface's subnet can select that
interface's connected route instead of the default Internet route. Check that
source NAT on the selected path presents the public endpoint the peer learned
through STUN; changing the default route alone need not change this path.

Use the [paired direct-path gate](TRANSFERS.md) to require an observed direct IP
endpoint and a clean ping exit. Preserve the actual path in the result: outbound
discovery logs, NIC packets, router counters and a successful relay ping do not
individually establish a completed direct exchange. This ping gate does not
establish native admission, live subscription delivery or committed file bytes.

The direct-path investigation used a
[logging-only diagnostic fork](https://git.golden-vernier.ts.net/amoyer/tailcat/commit/1052fd684ce5bb1cc471e211c57e3aa535c348cc).
The bundled runtime remains upstream `ce6fedcabc220bab3b94d470ab330219111eeae8`;
the observed direct-path repair required network configuration, not that fork.

Local fixtures exercise resource ownership and stream custody. They do not exhibit
physical cross-seat transfer, DERP-only connectivity, simultaneous routes sharing a
client key, authenticated P1 hello/admission, or filesystem immutability inside P1.
Those remain integration tests, not properties inferred from a callback name.
The root CLI and historical record-v1 byte/digest paths are unchanged.
