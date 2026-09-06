# Native protocol contracts

The modules in `src/protocol/` provide pure validators for new native data shapes.
They do not start a service, enroll a principal, verify a file, accept a message,
or migrate a stored log. See [NATIVE-ROOMS.md](NATIVE-ROOMS.md) for service semantics
and [DESIGN.md](DESIGN.md) for authority and presentation boundaries.

The [human-key contract](HUMAN-AUTHORITY.md) adds inert enrollment candidates,
operation-bound challenge/proof syntax and fixed signing bytes for break/compose.
Its fixtures do not establish a deployed human-only boundary.

## Validation is one boundary, not the whole operation

`validateX(unknown)` returns a fresh closed data object or throws
`ProtocolValidationError` with a bounded `code` and schema `field`. It does not
coerce, trim, normalize Unicode, repair escaping, drop unknown fields, or mutate
its input. Explicit `undefined`, non-data properties, custom prototypes, symbols,
and extra fields are refused. These are data validators, not a sandbox for hostile
JavaScript proxies executing inside the same process.

The decoder must enforce the encoded frame ceiling before deeper validation.
Object validation does not replace that check or downstream allocation quotas.
Errors identify a known schema location, never the submitted value or arbitrary
unknown property name. The shared `read*` helpers are internal validation seams;
callers should import the named DTO validators, not compose a looser ingress path.

Text preserves well-formed Unicode as UTF-8, including BOM, CRLF, combining forms,
literal backslashes and trailing spaces. Invalid UTF-8 belongs at the decoder's
refusal boundary; an unpaired surrogate is invalid text. Body fidelity is not JSON
key order or the choice of JSON escape notation. Binary bytes use attachments.

| Value | Syntax or bound |
|---|---|
| Encoded frame | 1 MiB; separately enforced by decoder/encoder |
| Body text | 262,144 UTF-8 bytes |
| Native account/operation/attachment ID | 16–128 ASCII letters, digits, `_`, `-` |
| Room ID; epoch | 32 lowercase hex characters; distinct meanings |
| Cursor | `epoch:sequence`, canonical nonnegative decimal safe integer |
| Digest | `sha256:` followed by 64 lowercase hex characters |
| Attachment name / MIME | 255 / 200 UTF-8 bytes |
| Source room/ID | Nonempty, at most 512 UTF-8 bytes, no controls |

`common.mjs` exports `PROTOCOL_LIMITS`, `ProtocolValidationError`,
`validateNativeId`, `validateRoomId`, `validateEpoch`, `validateDigest`,
`validateCursor`, `parseCursor`, `formatCursor`, `validateText`,
`validateSourceRef`, and `assertOperationContext`.

`SourceRef` is `{transport, room, id}`. External identifiers need not satisfy the
native ID grammar: a Slack timestamp or offer ordinal is a source identifier,
not automatically a native message or attachment identity.

## Receipts and identity

```ts
type OperationContext = {roomId: string; accountId: string; operationId: string};
type NativeCommitReceipt = OperationContext & {id: string; cursor: string};
type AppendAck = {receipt: NativeCommitReceipt; duplicate: boolean};
```

`receipt.mjs` exports `validateNativeCommitReceipt`, `validateAppendAck` and
`assertReceiptContext`. A commit cursor has sequence greater than zero. Receipt
`id` retains the existing SHA256 derivation of `roomId + NUL + accountId + NUL +
operationId`; validation checks that relationship. `duplicate` is outside the
immutable receipt. `assertReceiptContext(receipt, {...context, epoch})` checks
exact context equality, not the trustworthiness of either argument.

A caller can manufacture a syntactically valid receipt. Only an authenticated
host response or reconciliation proves acceptance. Two independently enrolled
hosts can use identical room/account/operation values and produce identical
hashes. The transport must verify the expected enrolled host and carry that
authority into downstream identity. Before multi-host native delivery, the
own-post ledger must key native entries by `(host authority, roomId, id)` rather
than a naked ID; old unqualified rows must not suppress another host's messages.
This leaf library does not perform that consumer migration.

## Attachments: advertised metadata and local observations

```ts
type AttachmentReference = {id: string; digest: string; lifetime: 'offer'|'durable'};
type WireAttachment = AttachmentReference & {
  name: string; kind: 'image'|'file'; size: number;
  mimetype?: string; width?: number; height?: number;
};
type LocalAttachmentState =
  | {attachmentId: string; state: 'pending'}
  | {attachmentId: string; state: 'unavailable'; code: string; retryable: boolean}
  | {attachmentId: string; state: 'materialized'; path: string;
     verifiedDigest: string; verifiedSize: number; verifiedAt: string;
     detectedKind: 'image'|'file'; detectedMimetype: string};
```

`attachment.mjs` exports `validateAttachmentReference`, `validateWireAttachment`,
`validateLocalAttachmentState` and `assertMaterializationContext`.
Wire metadata forbids local paths, private URLs and purported local verification.
Sizes are nonnegative safe integers; optional dimensions are positive integers
at most 2³¹−1. Names are labels, not filesystem destinations.

Only the recipient's materializer constructs a trusted materialized observation
after checking actual bytes and installing an independent copy or proven
copy-on-write clone without clobbering. It derives presentation type from those
bytes. A peer advertising an image over non-image bytes does not turn the result
into an image: detected type wins, preserving existing transfer behavior.
`assertMaterializationContext` checks attachment ID, digest and size, not equality
with an advertised type. It neither reads the path nor supplies proof that any
verification occurred. Deserializing a peer's local-state-shaped object grants
no local readiness.

Offer lifetime and durable room custody are different. A parsed `durable` label
does not install bytes, a digest grants no room permission, and offer expiry must
not delete another owner's canonical custody. Existing offer ordinals are mapped
by the transfer adapter using account/offer/ordinal scope, not accepted directly
as native attachment IDs. A writable hard link to canonical custody is not an
independent materialization.

## Outcomes remain distinct

`outcomes.mjs` exports `validateNativePostOutcome`, `validateQueueOutcome`,
`validateFacePublication`, `validateWakeDisposition` and `assertPostOutcomeContext`.

| Result | Required evidence-bearing data | Does not mean |
|---|---|---|
| `sent` | `ack: AppendAck` | A recipient has read or acted |
| `refused` | Operation context and diagnostic `code` | An arbitrary timeout |
| `unknown-acceptance` | Operation context and `code` | Definite refusal or success |
| `queued` | Operation context and `queueId` | Host acceptance |
| Face `published` | Native correlation plus provider `SourceRef` | Business completion |
| Wake disposition | `woken`, `enqueued`, `inbox`, or `deferred` | Reader checkpoint or acknowledgement |

Queued/refused/unknown branches cannot carry a commit cursor, receipt or ack.
Diagnostic codes are bounded identifiers, not free-form error text. Face
publication has its own pending/published/refused/unknown state machine, with
`roomId`, `messageId`, `faceId`, `sourceRoom` and `publicationOperationId`.
Published source room must match its expected source room. An unknown publication
may name a known provider reference and still remains unknown.

The authority performing each effect owns its transition. Parsing `sent`,
`published` or `materialized` proves shape only. Face failure does not revoke a
native commit. Wake acceptance advances no native reader checkpoint. Stable
operation identity is retained across uncertain retries.

## Compatibility and next consumer gates

This slice leaves stored v1 canonicalization, hashes, replay rules and existing
service exports unchanged. Do not add lifetime, provenance or other new defaults
before verifying historical bytes. New strict wire semantics must be negotiated
before a consumer advertises them; merely importing this library negotiates
nothing. Legacy projections must remain explicitly unattested.

Identity/enrollment, hello, roster/leases, board/spawn/delivery, orientation,
authorized search/replication and rendered-view contracts retain separate
consumer gates. They must not be inferred from the four leaf modules. Public
rendering and every derived index apply the configured protection policy;
recognized protected content may remain only in authorized canonical custody,
not in a hidden raw-body field of a rendered result.

The discriminating tests cross boundaries: a valid receipt with wrong context
must not touch a ledger; valid advertised metadata must not make an unverified
file ready; a lost response must reconcile the original operation; a redacted
search/read response must contain no nested original body. Syntax-only tests do
not replace those consumer or physical cross-seat acceptance tests.

## Wave 1: native consumer boundaries

The new modules export named JSDoc DTO types as well as validators. Consumer
imports stay within `src/protocol/`, never back through a service implementation.

| Module | Primary consumer exports |
|---|---|
| `identity.mjs` | `AcceptedHostContext`, `validateAcceptedHostContext`, `assertAcceptedHostContext`, `scopedNativeIdentityKey`, `assertScopedNativeCursorContext` |
| `capabilities.mjs` | `validateCapabilityOffer`, `negotiateNativeCapabilities`, `assertNegotiatedCapabilitiesContext` |
| `origin.mjs` | `OriginReference`, `validateOriginReference`, `assertOriginContext` |
| `operation.mjs` | `NativeOperationRequest`, `NativeOperationEvent`, their validators, `nativeOperationPayloadDigest`, `assertNativeOperationEventContext` |
| `message.mjs` | `NativeMessage`, `validateNativeMessage`, `assertMessageContext`, `validateLegacyUnattestedMessage` |
| `read.mjs` | `NativeReadResult`, `NativeReadCoverage`, `NativeReadMessage`, `NativeCheckpoint`, `validateNativeReadResult`, `assertNativeReadContext` |
| `route.mjs` | `RouteBinding`, `RouteDescriptor`, `RouteStatus`, their validators, `assertRouteContext`, `publicNodeKeyDigest` |
| `resource-lifetime.mjs` | `ResourceLifetime`, `validateResourceLifetime`, `assertResourceOwnerContext` |

This release adds pure contracts, not automatic protocol activation. Existing
`agora-native/1` framing, stored v1 records and receipt derivation remain intact.
`test/protocol-v1-fidelity.test.mjs` pins the complete frame hash, payload/record
digests, message ID and retry receipt to a vector captured before this change.
A legacy attachment remains without a synthesized lifetime.

### Required consumer order

1. Verify service proof against independently enrolled expected host authority.
   Authority is not boot generation, a secret, seat label, body or trailer.
2. Negotiate explicit capabilities on that authenticated connection. Both
   parties' requirements must be supported; `board-v1` depends on `contracts-v2`.
   A persisted negotiation DTO cannot replace the live exchange. Legacy v1
   remains a distinct path, never silently upgraded.
3. Validate request kind and scope before room open: open can itself scan,
   recover or acquire ownership. Checking only before append is too late.
4. P1 rechecks current route/grant authority at serialized effect commit, after
   buffering. P2 supplies live owned resources, not authority minted by a DTO.
5. Validate response and expected host/room/epoch before ledger, archive,
   subscription or cursor mutation.

Pure-validator and injected-counter tests do not establish this production
ordering. Consumer integration owes unsupported-capability-before-open and
wrong-host-before-ledger controls against its actual dispatch path.

### Identity and provenance

Consumer deduplication keys the entire structured tuple `(transport, enrolled
host authority, roomId, messageId)`. Host includes scheme, authority and ID.
Scope must reach watch's initial duplicate filter, not only its own-post check.
The historical message hash is unchanged but not globally unique across hosts.
Never suppress scoped native traffic by falling back to an old naked ledger
row. Non-native compatibility remains the adapter's separate responsibility.

Persisted native progress binds host and room to cursor. Retargeting an alias
cannot reuse the first host's cursor even when the second reports the same
epoch. Imported origin is source metadata stamped by an authorized reader, not
destination identity or permission to suppress an own post. An
`AcceptedHostContext` is a syntax/context record; trust comes from the
consumer-owned authenticated connection, not parsing that record.

### Native scan results

Native read returns exactly `{messages, checkpoint, coverage}`. The checkpoint
retains `{roomId, epoch, sequence, digest}` with null digest only at zero. It is
not a scalar cursor, nor independent evidence when returned by the same host
whose prefix it describes; independently held prefix custody is still required.

Native scan coverage carries scoped room, `fromExclusive`, `toInclusive`, and
`committedThrough`, in one epoch and ordered `from <= to <= committed`. The
checkpoint equals `toInclusive`, not the last visible message. Messages are
strictly ordered within `(from,to]`. Empty messages may advance over board-only
events. Claimed frontier is not a claim that its entire prefix was scanned.
Context validation requires `fromExclusive` equal the requested `since`;
first-arm window selection must therefore be explicit.

The producer must return **every** committed message event in that scanned
interval, without wake/own-post/author filtering. `limit` bounds scanned event
records, not returned messages. An empty advancing page is valid only when the
scanned interval contains no message event. These completeness obligations are
tested against P1's typed store truth, not proved by adding another count from
the same host. A bounded tail read reports the actual predecessor of its tail,
never coverage of the omitted prefix.

`NativeReadCoverage` is narrower than archive/index coverage, whose retention,
gaps, index lag and authorized continuations retain separate contracts. A scan
also is not recipient-delivered coverage. Wake supersession requires the latter
with recipient/generation checks; neither scan nor wake implies agent ACK.

### Presence routes and recipient-delivered coverage

`lease.mjs` exports `validateWakeRoutes`, `deriveWakeSurface`,
`validatePublicBearer`, `validatePresenceLease`, `assertPresenceContext`, and
`evaluatePresenceLease`. A public bearer has `registration:RegistrationRef`,
`bearer`, `harnessId`, `persistence` (`persistent | one-shot | unknown`),
`processPresent` (`yes | no | unknown`), `wakeRoutes:{subscriber,pane}` and
`wakeSurface`. Each route is `present | absent | unknown`. The aggregate is
present if either is present, absent only if both are absent, otherwise unknown.
Contradictory aggregates are rejected; both routes may coexist.

`PresenceLease={seat:AccountBinding,service:ServiceRef,leaseId,renewal,renewedAt,
expects_agents,build:{version,git?},bearers:PublicBearer[]}`. The binding attestor
equals the service. Registration tuples are distinct, the roster is bounded at
1024 entries, renewal is a positive safe integer, and an optional Git revision is
40 lowercase hex characters. No PID, local path or serialized `isLive` crosses
this boundary. An empty roster does not imply a service-only seat.
`assertPresenceContext` takes independently held `{seat,service,leaseId,role}`;
`role:agent-capable | service-only` determines `expects_agents`, not roster size.

Freshness takes receiver-local monotonic milliseconds
`{acceptedRenewal,acceptedAt,now,connected}` for this exact lease. The receiver
must reject replay before updating its accepted timing; the pure evaluator does
not store renewal history. Sender `renewedAt` is descriptive, never an expiry
clock. The accepted renewal must match; disconnect or elapsed time of 45000 ms
returns `dark`. Freshness and route presence never admit a wake or prove process
death. P4 selects an authenticated recipient-bound subscriber before a freshly
admitted pane; unknown handoff reconciles the same delivery ID, not an independent
second write. Those mechanisms remain consumer work.

`delivered-coverage.mjs` exports `validateNativeDeliveredCoverage`,
`validateDeliveryRange`, `assertDeliveredCoverageContext`, `coversDeliveredRange`.
The record is `{recipient:RegistrationRef,service:ServiceRef,
coverage:NativeReadCoverage,progressId,admissionId}`. It composes the **unchanged**
native scan grammar but asserts a different event: P1/P4's authenticated progress
owner handed that contiguous interval to this recipient under this admission.
A scan alone, saved/manual cursor, or `gapFree:true` flag is not this record;
validation cannot prove the asserted event. No read-to-delivered conversion is
provided. Disjoint intervals are not merged or given inferred coverage of gaps.

The assertion requires independently authenticated
`{recipient,service,room,progressId,admissionId}`. All recipient fields, service
boot, host authority/identity, room, epoch and proof references must match.
The range predicate takes `{after,through}`, checks that context first and then
requires full containment in `(fromExclusive,toInclusive]`; `committedThrough`
does not extend delivered coverage. Partial coverage returns false, retaining
uncovered work pending. Artifact-only pointers cannot enter this range API.
An authenticated owner must recheck live progress at actual admission: a prior
lookup success or mint-time cursor is not authorization. These pure functions
write no cursor, ACK, delivery record or queue entry. Supersession avoids a
redundant poke only; it asserts neither agent acknowledgment nor completion.

### Route and child ownership

Service boot, room epoch, specific grant revision and route generation are
distinct. Captured validity does not authorize a later revoked operation.
Endpoint bounds remain 20–1800 ASCII bytes. Key digest covers UTF-8 canonical
public `nodekey:` text plus 64 lowercase hex digits, not private material,
decoded bytes or a short display fingerprint.

`ResourceLifetime` is expiring or owned by a particular live service generation.
It is not attachment custody lifetime. Service-owned resources require a live
owner and joined cleanup; far-future expiry substitutes for neither. Parsing
an owner reference, endpoint or digest starts no child and grants no stream.

### Typed operations and legacy read composition

`NativeOperationRequest` has only `{kind, operationId, payload}`. Message payload
contains text and optional thread/attachment references, not author identity.
Board claim carries action/subject; renew/release additionally carry lease ID
and acquisition fence; contest carries a reason. Holder identity comes from
the authenticated route, never from a sender-selected holder field.

`NativeOperationEvent` contains `{kind, receipt, payload, payloadDigest}`. Its
receipt uses the unchanged v1 derivation. The new digest hashes UTF-8 canonical
JSON of `{domain:'agora-native-operation/2',kind,payload}`; canonical objects
sort keys recursively, arrays preserve order and scalars use JSON spelling.
This digest binds request kind and payload for retry checking; it must never
replace a stored v1 payload digest. A board event receipt is not a chat message
and must not enter a chat-only identity or rendering path.

A strict `NativeMessage` and an explicit
`{provenance:'legacy-unattested',message:...}` projection are different types.
Native read's messages array supports both after closed validation, then checks
ordering and scope using their respective message fields. Legacy projection
does not invent account attestations, registrations, attachment lifetime or
custody. It is not a replacement decoder for historical frames: stored v1
verification happens first, against unchanged bytes. New ingress remains
strict rather than weakening its rules to match historical inputs.
Historical unpaired surrogates cannot enter this new UTF-8 DTO; a consumer must
report that representation refusal, never silently normalize or skip the frame.
Well-formed legacy metadata retains its historical UTF-16-unit bounds. The
compile-only `test/protocol-type-surface.mjs` fixture pins native host types,
origin discrimination and the closed capability vocabulary under `npm run check`.
