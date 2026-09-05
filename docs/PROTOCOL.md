# Native protocol contracts

The modules in `src/protocol/` provide pure validators for new native data shapes.
They do not start a service, enroll a principal, verify a file, accept a message,
or migrate a stored log. See [NATIVE-ROOMS.md](NATIVE-ROOMS.md) for service semantics
and [DESIGN.md](DESIGN.md) for authority and presentation boundaries.

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
