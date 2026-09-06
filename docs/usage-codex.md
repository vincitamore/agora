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
- `windowDurationMins` becomes `durationMinutes`; when it is null the field is absent, not
  defaulted.
- `resetsAt` is epoch seconds. When it is null the window's freshness is `unknown`, never
  `fresh` — a window with no reset metadata is not a window known to be current.
- `rateLimitsByLimitId` is authoritative when present, and the legacy single-bucket summary
  then adds no duplicate. When the map is absent the summary is used on its own.

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
| `codex-quota-shape-unsupported` | A window whose units cannot be expressed. |

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
- Only the helper this collector started is cleaned up. A peer process is never touched.
