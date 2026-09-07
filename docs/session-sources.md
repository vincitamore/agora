# Session source adapters

`src/usage/session-sources.mjs` turns one original usage envelope plus explicit
harness, version and session context into typed session-usage records. It is a
pure decoder: no network, no corpus walk, no persistence, no pricing.

A value that decodes here is a well-formed claim about what the envelope
contained. It is not a verified bill, a membership, or a live harness snapshot.

Records are validated by `src/protocol/session-usage.mjs` before they are
returned. A decode that cannot produce a well-formed contract record is an
error, not a partial claim.

## API

```js
import { decodeSessionUsage } from '../src/usage/session-sources.mjs';

const result = decodeSessionUsage({
  harness: 'claude-code',
  harnessVersion: '2.0.0',
  sessionEpoch: 'session-epoch-synthetic-01',
  envelope,
  context: {},
});
if (result.status === 'supported') {
  result.records;
} else {
  result.code;
}
```

`decodeSessionUsage(input)` — the public path.

| Field | Required | Meaning |
|---|---|---|
| `harness` | yes | `claude-code`, `omp`, `codex`, or `amore-build`. Anything else is `unsupported`. |
| `sessionEpoch` | yes | Opaque session/process-start epoch supplied by the caller. Not invented. A value empty after trim is identity-malformed, not envelope-unusable. |
| `envelope` | yes | The original usage payload. Missing is an error; other update kinds are unusable. |
| `harnessVersion` | no | Source-version label. Absent leaves versioned `not-applicable` claims unavailable. |
| `sourceVersion` | no | Accepted as an alias of `harnessVersion`. |
| `context` | no | Harness-specific caller facts. Codex **requires** `context.sourceId` and may carry `context.model` from a preceding turn context. `context.observedAt` supplies the required exact ISO instant when the envelope has none. An unparseable instant is `session-source-observed-at-malformed`, not an identity fault. A blank model label is omitted, not a lost record. |

Returns `{status: 'supported', records}` or `{status: 'unsupported'|'error', code, reason?}`.
`records` is an array: one Claude, OMP or Codex envelope yields one record; one
Amore Build `turn_completed` envelope yields one record per `modelUsage` entry.

Lower-level exports: `knownCount`, `unknownCount`, `invalidCount`,
`notApplicableCount`, `readCountField`, `disjointUncached`,
`SESSION_SOURCE_HARNESSES`, `SESSION_SOURCE_CODES`.

## Counters

Each numeric component is a tagged union, never a sentinel:

- `known` — a safe nonnegative integer and a unit (`tokens`). Zero is known.
- `unknown` — the envelope did not evidence the component. Carries a reason.
- `invalid` — the envelope said something unusable (null, wrong type, negative,
  non-integer, cache exceeding input). Carries a reason. The rest of the record
  still decodes.
- `not-applicable` — only when a versioned source contract excludes the
  component. This decoder does not emit it without that contract.

Absent is not zero. Null is not absent. An unsplit cache-write total is not a
five-minute write. Nothing clamps: if cached input plus writes exceed input
on a harness whose input **includes** cache, `uncached-input` is `invalid` with
`cache-exceeds-input`. The branch is chosen by a sourced identity, never by a
fixture that happens to pass:

- **Claude Code** — exclusive. Anthropic `total_input = cache_read + cache_creation
  + input_tokens`. Cited:
  `knowledge/claude-tooling/cli/anthropic-prompt-caching-mechanics-and-pricing`.
- **OMP** — exclusive. Measured: `totalTokens = input + output + cacheRead +
  cacheWrite` (142+600+64000+0 = 64742, and two siblings). `input` sits beside
  the cache pools, never includes them.
- **Codex** — inclusive. Measured on this seat: `last_token_usage.input_tokens`
  includes `cached_input_tokens` (700 real records). Subtraction stays.
- **Amore Build** — inclusive, asserted from the xAI field names
  (`inputTokens` vs `cachedReadTokens` / `cacheCreationTokens`), **unmeasured**
  on this seat. Flip if a real envelope shows input already exclusive.

Claude and OMP take `input` as reported. Codex and Amore subtract known cache
parts. A fixture that passes either branch is not a source.

## Components

Every record carries:

| Component | Meaning |
|---|---|
| `uncached-input` | Claude and OMP: input as reported (already exclusive). Codex: input minus known cache parts (measured inclusive). Amore: same subtraction, unmeasured. Unknown if any subtracted part is unknown. |
| `cached-input` | Cache-read tokens. |
| `cache-write-5m` | Five-minute cache-write tokens, or unknown when the TTL split is absent. |
| `cache-write-1h` | One-hour cache-write tokens, or unknown when the source does not evidence them. |
| `cache-write-unknown-ttl` | Unsplit write total. Omitted when the source split the TTL. |
| `output` | Output tokens. Reasoning is not added to this. |
| `reasoning-billed` | Unknown unless the envelope evidences inclusion or exclusion. |
| `tool` | Unknown unless a versioned source contract includes tool charges. |

An unsplit write total, when the source supplies one, is emitted as
`cache-write-unknown-ttl`. There is no pooled `cache-write` bucket. Coverage
is `complete` or `partial` as the contract names it: partial whenever any
component is unknown. Overlap defaults to `none`; the caller may pass a
contract overlap object in `context.overlap`.

`sourceId` is opaque source text. It is checked for length and control
characters only. It is never rewritten into native id grammar. A Codex
cumulative watermark is not the source id and is not copied onto the record;
the caller supplies the locator.

`sourceReportedCost` is optional on the record. OMP `cost.total` is stored as
unit `omp-cost-total` when it is a safe nonnegative integer; Amore
`costUsdTicks` is stored as unit `usd-ticks`. A non-integer amount is
`invalid`, never converted. Claude Code and Codex omit the field: they
reported none. A cost is not a token component and is never added to one.

`sourceReportedReasoning` is the same optional shape. No current adapter emits
it: none of the four envelopes carry a sourced reasoning figure we will type.
`reasoning-billed` stays unknown with `reasoning-inclusion-unknown`. A later
sourced mapping writes the figure onto this field, never into a component.

## Four sources

**Claude Code** (`sourceUnit: request`). Usage lives at `message.usage`. Identity
is `message.id` (then `requestId`, then `uuid`). `cache_creation` is the TTL
split; `cache_creation_input_tokens` without that object is an unsplit total.
Finality is `unknown`: streaming corrections share an id and are not ordered here.

**OMP** (`sourceUnit: request`). Same envelope family, different keys (`input`,
`output`, `cacheRead`, `cacheWrite`, `cttl.ephemeral5m` / `ephemeral1h`).
Identity is `message.id` then top-level `id`. `input` is exclusive of the cache
pools (`totalTokens = input + output + cacheRead + cacheWrite`, measured).
Reported `cost.total` is not a token component and is not converted.

**Codex** (`sourceUnit: cumulative-snapshot`). Envelope is
`event_msg` / `payload.type === 'token_count'` / `info.last_token_usage`.
`context.sourceId` is required. `context.model` comes from a preceding
`turn_context` when the caller has it; this decoder does not walk a log to find
one. `cache_write_input_tokens` is an unsplit write: it lands in
`cache-write-unknown-ttl`. `cache-write-5m` and `cache-write-1h` are unknown
with reason `codex-cache-write-ttl-unknown` (OpenAI documents no TTL classes
for writes; the 5m bucket is Anthropic's). The cumulative watermark is not
a request id and equal watermarks do not invent revisions.

**Amore Build** (`sourceUnit: aggregate`). Envelope is `params.update` with
`sessionUpdate: 'turn_completed'`. Identity per record is the opaque
`prompt_id:model` text. One prompt with several `modelUsage` entries yields
several records. Top-level totals are not added to children. `modelCalls` is
not expanded into requests. Finality is `final` because the source labelled the
update completed. One-hour writes are unknown. `costUsdTicks` is not converted
into dollars.

## Overlap: a stated `none` needs a basis

`overlap` says how a record's counts relate to another record's, and `none` is a **positive
claim** — it asserts these counts overlap nothing, and a ledger sums on it. So it is never a
fallback here.

| context.overlap | result |
|---|---|
| a usable record | carried through verbatim, including `relation: unknown` |
| present but not a record (string, `null`, number, boolean) | **error**, `session-source-envelope-unusable` with reason `type:overlap`; no record is emitted |
| a record the contract refuses | **error**, reason `contract:<field>`, from the contract itself |
| absent, harness listed in `OVERLAP_BASIS` | `{ relation: 'none' }`, on that harness's written basis |
| absent, harness not listed | `{ relation: 'unknown' }` |

The bases, each a checkable claim about the source's own format:

- **claude-code** — one assistant envelope is one request, so its counters cover that call alone.
- **omp** — likewise, one envelope per request.
- **codex** — a `token_count` payload is one cumulative snapshot of the session, not a slice of
  another record.
- **amore-build** — a `turn_completed` yields one aggregate per model, disjoint by construction,
  because a model's usage appears under exactly one `modelUsage` entry.

A fifth harness inherits nothing. Absent an entry in `OVERLAP_BASIS` it resolves to `unknown`,
because `unknown` is a real answer and adopting a `none` that another source earned is how a
silent double count begins two units downstream. `resolveOverlap` is exported so that guarantee
is fired by a test rather than asserted here.

## What this module does not do

It does not scan a transcript, call a provider, join a member, price a token,
pick a max-output revision, or treat an ingest-row hint (`kind: usage`, `text`)
as a counter. Revision precedence is the ledger's problem: if the source does
not evidence order, this decoder emits `finality: unknown` and does not
supersede.
