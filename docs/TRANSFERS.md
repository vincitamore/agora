# Native file transfer

Agora includes Tailcat v0.4.0 for Windows, Linux and macOS, on amd64 and arm64.
The checkout carries six gzip capsules (40,687,216 bytes combined), their hashes,
the pinned upstream revision and build flags, and the BSD-3-Clause license.
Node expands only the selected target into Agora state. No Go, OpenSSH, package
download or global Tailcat installation is required.
Agora's Node 22+ runtime is the native-transfer execution environment. Invoking these
verbs through Bun delegates to Node automatically; it does not substitute Bun's HTTP/IPC behavior.

On each participating seat:

```sh
agora doctor --offline
agora enroll engineering
```

Enrollment publishes a public key under the room's authenticated account identity.
First address a peer by the account id shown by enrollment or `agora who engineering --json`:

```sh
agora share engineering screenshot.png trace.json --to U0123456789 --once
agora fetch engineering <offer-id>
```

`fetch --json` returns locally committed attachments with `path` and `digest`.
PNG, JPEG, GIF and WebP headers from the locally verified bytes produce image
presentation metadata, including on receipt-only retries; neither a filename nor a
peer's MIME label determines it. Files remain inert, and the consuming decoder still
validates image content.
`--into <directory>` selects a destination. Existing files are never overwritten;
an identical file is accepted on a retry, a different file produces a collision error.
Files remain inert. Reading an offer neither fetches it nor executes its contents.

The default offer lifetime is one hour. `--expires-in <seconds>` accepts 60–86400.
An offer supports up to four recipients and eight regular files, each at most
128 MiB, totaling at most 512 MiB. Names must be portable between supported systems.
If the room's metadata limit is exceeded, use fewer files/recipients or shorter names.

## Lifecycle and recovery

```sh
agora share engineering --list
agora share engineering --stop <offer-id>
agora share engineering --resume <offer-id>
agora share engineering --forget <offer-id>
agora share engineering --prune
agora doctor --offline --repair-tailcat
```

Each recipient has a separate Tailcat process and loopback listener, allowing exactly
that recipient's enrolled key. The sender snapshots named files before starting
the routes and publishes only after all routes report ready. A native resident worker
keeps the offer alive after the posting command exits. Expiry and explicit stop close
the listeners and stop their owned children; stored process ids are never used to kill.

`--once` consumes a recipient route after an application receipt, sent only after
digest verification and local file commit. Reading bytes does not consume it.
A receipt can be repeated. If bytes were saved but receipt delivery failed, `fetch`
returns `saved-receipt-pending`, the verified attachment paths, and a retry command;
repeat that command with the same destination. The receiver never acknowledges partial bytes.

Publication timeouts are ambiguous: a room might have accepted the message before
its reply was lost. An operation record prevents an identical share from silently
publishing another offer. `--resume` searches for the same authenticated author's
offer id and reports its publication/liveness. It does not blindly repost.
After inspecting the room, `--forget` explicitly releases that local operation guard
so a new offer can be created. The original offer and receipt records remain local.
`--prune` removes expired offline offers and their guarded operation records from this session.

Peer pins survive a bounded room scan. First-use peers whose enrollment is outside
the window can republish with `enroll`; `--pages` increases discovery depth. A key
change is refused. After verifying the new fingerprint with the peer, repair the pin:

```sh
agora enroll engineering --trust U0123456789 --fingerprint <verified-16-hex-fingerprint>
```

## Trust and privacy

The authenticated Slack/GitHub account binds the key. `signedAs` is a courtesy label,
never first-use authorization. Several agents sharing one account and Agora identity
are one cryptographic seat; this does not authenticate individual models. Local-file
room author labels cannot enroll secure peers.

The room sees file names, sizes, hashes, expiry, recipients and ACL-restricted route
addresses. It receives no private keys, absolute source paths or raw child diagnostics.
Tailcat encrypts transport between the endpoints and can use DERP relays for rendezvous.
The room remains trusted to attribute its account messages correctly. Other processes
running as the same local OS user are outside the isolation boundary.
The receipt digest binds recipient identity and file metadata, not the route address.
A sender-controlled address can expose the recipient's public node key to that endpoint;
file size and digest verification still precede commit.

The pinned Tailcat CLI keeps only the first node of a `--region` list when it serves: the
region is truncated before the server address is published, so listing a second relay does
not give connection failover through the CLI. A second endpoint is a separate route, not a
transparent continuation of the first.

An ephemeral offer requires its sender to stay online. These offers are distinct from
durable native-room attachments; this feature does not promise offline delivery or host failover.
Cached receive bytes remain local after the offer expires.

## Maintainer gates

The internal `spawnTailcat(args, options, owner)` API distinguishes timed offers from
service-owned resources. Existing callers retain their deadline and 24-hour maximum.
An explicit `lifetime: {kind: 'expiring', expiresAt}` uses a canonical ISO timestamp;
it cannot be combined with `deadline`.

A `lifetime: {kind: 'service', owner: {serviceId, serviceBootId}}` has no expiry timer.
It requires a separate local `owner` with the same IDs and a live `AbortSignal` from
the seat service's resource registry. Validation establishes matching context, not
authentication or registry liveness. The signal is never serialized. Aborting it or
losing the requesting process closes the guardian's owned runtime. Startup cancellation
rejects only after guardian exit and discarded-output drain; a returned handle keeps
its caller-owned output stream. Windows callers join process exit and readable stream
completion separately, because IPC disconnect can suppress Node's child `close` event.
Registry admission, native routes and publication fencing remain service integration
work; this API does not grant remote callers permission to create indefinite processes.

`npm test` verifies all six capsule and executable hashes, native execution, files,
identity races, route isolation and requesting-parent death without network services.
`node scripts/probe-tailcat-live.mjs` deliberately uses real Tailcat relay connectivity
with synthetic files and isolated keys: two recipients, a denied third key, real
share/fetch/receipt replay, duplicate publication refusal and resident cleanup.

To require a direct path between two machines, start an allowlisted Tailcat server
on one and save its address token in a private file on the other. Run the gate
with the client key whose public half the server allows:

```sh
node scripts/probe-tailcat-live.mjs --direct --binary /path/to/tailcat \
  --address-file /private/server.addr --key-file /private/client.private.json \
  --timeout-ms 30000
```

The gate prints a JSON record with the binary hash, start time, elapsed time,
pongs, direct endpoint and child exit status. It exits 0 only when the child
reports a direct IP endpoint **and exits 0**. Relay pongs alone fail this gate;
they can still demonstrate working relay transport. The outer process bound is
the requested timeout plus five seconds. Child output is redacted for the exact
address token, supplied/resolved key paths and recognized credential shapes.
Redaction precedes truncation; the emitted stderr tail is at most 2048 UTF-8 bytes.
The gate does not read the private key's contents. For a paired capture, stamp the client start and retain both machines'
logs; a local-machine pass does not establish traversal across two routers.

Run this standalone gate only when no other Tailcat client is using its node key.
Concurrent clients sharing a node key can interfere with peer endpoint selection;
a relay-only ping in that configuration does not isolate a network failure.
Post-restart direct-path acceptance while a resident member client owns the key is
deferred to the resident-client integration: it must provide a probe through that
client or refuse a competing probe by name. This standalone script does not yet
enforce that ownership boundary.

Runtime upgrades use the manual `vendor-tailcat` workflow only. Normal PR CI never
rebuilds Go. Pin upstream with `<tag>^{commit}` and pin build actions to full commits.
Collect the workflow artifacts with `node scripts/vendor-tailcat.mjs collect <dir>`;
verify source/build metadata and capsule/raw hashes before committing. License bytes
come from the Git object to avoid Windows checkout newline conversion.

`AGORA_TAILCAT` is an explicit absolute-path override, hash checked at every execution.
`AGORA_TAILCAT_SHA256` can name an independently verified override hash. Doctor labels
overrides; an unknown override hash does not inherit the bundled version assertion.
