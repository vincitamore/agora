# Codex usage collector

Reads this seat's Codex rate-limit state and returns it as a usage observation under the
[usage contract](usage-contract.md). It is a read: it starts a short-lived helper, asks one
question, and exits. Nothing is stored, no credential is read, written, refreshed or
reconfigured, and no model turn is spent.

## What it is for

A pool's remaining capacity is a fact about a billing account, and the only party that can
report it is the harness holding that account's session. This collector is that reporter for
Codex. It produces an observation whose `attestation` is `cooperative` and whose `source` is
`harness`: the seat is stating its own reading, and a consumer that needs an enforced
attestation must get it from somewhere else.

## API

```js
import { collectCodexUsage } from '../src/usage/codex.mjs';

const result = await collectCodexUsage({ poolId, producer, now: () => new Date() });
if (result.status === 'supported') {
  result.principal;    // pool principal, validated against the contract
  result.observation;  // complete observation, validated against the contract
} else {
  result.code;         // a bounded diagnostic code, never provider text
}
```

`collectCodexUsage(options)` — the public path.

| Option | Required | Meaning |
|---|---|---|
| `poolId` | yes | The pool this reading is about. |
| `producer` | yes | Who is making the statement; validated by the contract, not invented here. |
| `now` | yes | A clock, `() => Date`. Injected so a caller owns the capture instant. |
| `spawn` | no | Process spawner, for tests. Defaults to `node:child_process`. |
| `resolveBinary` | no | Binary resolver, for tests. Defaults to the repository's resolver. |
| `codexPath` | no | An explicit binary path, overriding resolution. |
| `timeoutMs` | no | Budget for the whole conversation. Defaults to `CODEX_LIMITS.timeoutMs`. |
| `signal` | no | An `AbortSignal` to cancel the read. |

Returns `{status: 'supported', principal, observation}` or `{status: 'unsupported'|'error',
code, detail?}`. The caller supplies the clock and the producer; the collector creates
nothing durable and reads no configuration of its own.

Lower-level exports, useful for testing a payload without running a process:
`requestRateLimits`, `normalizeRateLimitsResponse`, `windowsFromSnapshot`,
`windowReadingFrom`, `resetsAtToIso`, `CODEX_LIMITS`.

## How the reading is taken

The helper runs as `codex app-server --stdio` and speaks line-delimited JSON. The collector
sends `initialize`, waits for its reply, sends the `initialized` notification, then sends
`account/rateLimits/read` and matches the reply by request id. A frame carrying a different
id is ignored rather than accepted, so an unrelated notification cannot finish the request.

Correlation is gated on protocol phase, not on the id alone. Request ids are assigned by the
collector, so a reply bearing the read's id before that request was actually sent is answering a
question nobody asked; it is refused as `codex-protocol-error` rather than ignored, so an
injected payload can never be mistaken for a late but genuine reading.

The binary is resolved through the repository's existing resolver rather than by name, so an
npm shim, a vendored executable and an explicit override all work; a bare name on `PATH`
resolves to the wrong thing on Windows.

`stderr` is not piped. A pipe nobody drains can fill and stall the helper, and provider text
on that stream is text this process should never hold.

## How a reading is shaped

One Codex snapshot carries two window slots, `primary` and `secondary`, which may share a
single `limitId`. They are distinct windows, so the slot name becomes the observation's
`scope` and the `limitId` is preserved untouched.

- `usedPercent` is a decimal percent and converts to basis points. A value finer than a
  basis point is reported unavailable with a reason rather than rounded away.
- `windowDurationMins` becomes `durationMinutes`. A null is absent, not defaulted. A value that
  is not a positive integer is **not** rounded into shape: the duration is part of the window's
  identity, so truncating `300.9` to `300` would rename the window and could collide with a
  genuine 300-minute window from the same limit. Such a window is reported unavailable with
  `unsupported-duration`.
- `resetsAt` is epoch seconds. When it is null the window's freshness is `unknown`, never
  `fresh` — a window with no reset metadata is not a window known to be current.
- `rateLimitsByLimitId` **absent** (null) and **supplied** are different claims. Supplied, it is
  authoritative and the legacy single-bucket summary contributes nothing — including when it is
  supplied empty, which asserts zero buckets; filling in from the summary there would invent a
  window the authoritative source says does not exist. Absent, the summary is used on its own. A
  map supplied as something other than an object is malformed, and a malformed authority is never
  silently downgraded to the legacy view: that is `codex-quota-shape-unsupported`.
- The same rule applies one level up, to the buckets themselves. Every value in the map is a
  snapshot by the schema, so a value that is null or not an object is a bucket the provider
  represents and this code cannot read. Since the observation is declared `full`, quietly
  omitting it would be a false claim about the reading's own completeness, so the whole reading
  is refused instead. Fixing this at the slot level and leaving it at the bucket level is
  exactly how it survived a first round of repair.
- Being an object is not being a snapshot. A snapshot **requires** both `primary` and
  `secondary`, each of which may be null, so `{}` is a well-formed record and a malformed
  snapshot, and a bucket carrying `primary` with no `secondary` **key** is missing a required
  field rather than reporting no window there. Required keys are checked at every represented
  bucket, and at the legacy summary when that summary is the one being consumed.
- Within a window, each field distinguishes **absent** from **unreadable** the same way. A null
  `resetsAt` means no reset metadata; anything else unreadable is `unsupported-reset`. A
  `usedPercent` that is not a number is `unsupported-percent-type`, one outside 0-100 is
  `unsupported-percent-range`, and one finer than a basis point is `unsupported-precision` --
  three faults that previously shared one code, which made the code a poor witness to its own
  cause. A snapshot's `limitId` may be null (the key it was filed under is then the identity),
  but an unreadable one is refused rather than silently replaced by that key.
- A window slot that is schema `null` means the provider reports **no** window there. A slot that
  is present but unreadable means a window exists that cannot be expressed, which is a different
  fact and is reported unavailable with `unsupported-shape` rather than dropped. Collapsing the
  two would let a represented window vanish from a reading that still claims to be complete.

## When there is no reading

Every failure is one of a closed set of codes. None of them carries provider text, a
credential, a path or a command line.

| Code | Meaning |
|---|---|
| `codex-spawn-failed` | No Codex CLI on this seat, or an explicit path that does not exist. |
| `codex-timeout` | The budget expired before a reply. |
| `codex-cancelled` | The caller aborted. |
| `codex-early-exit` | The helper exited before replying. |
| `codex-output-oversized` | Output passed the size limits. |
| `codex-malformed-frame` | A frame was not usable JSON. |
| `codex-protocol-error` | The provider returned an error. |
| `codex-account-identity-unavailable` | No account id, so no principal. |
| `codex-no-quota-reported` | A reply with no usable window. |
| `codex-quota-shape-unsupported` | A window, or a represented bucket, whose shape cannot be expressed. |
| `codex-transport-error` | An owned stream failed (a broken pipe, for instance). |
| `codex-account-identity-malformed` | An account id was present but unreadable, which is not the same as absent. |

An absent CLI is `unsupported` rather than an error: a seat without Codex installed is a fact
about the seat, not a fault. Identity is never invented — with no account id the collector
reports identity unavailable rather than deriving a principal from a credential path.

## Boundaries

- Read-only. No credential is exported, refreshed, reconfigured or extracted; no service is
  restarted; no spend is incurred.
- Raw stdout, stderr, provider error bodies and credentials are never logged. The output is
  the allow-listed fields above.
- Same-process execution is not authority. This collector states a `cooperative` reading; a
  consumer needing an authenticated context resolves it through the contract's seat binding.
- Only the helper this collector started is cleaned up. A peer process is never touched, and a
  read that is already cancelled when it begins starts no process at all: one created only to be
  abandoned can still fail asynchronously, after the caller has its result.
- Errors on the streams this collector owns are bounded results, never crashes. A stream error
  arrives asynchronously, so it is caught by neither a `try`/`catch` around the write nor the
  child's own `error` event; unhandled, it would terminate the **calling** process and print a
  raw stack, which is both a crash this library must not cause and a breach of the rule above.
