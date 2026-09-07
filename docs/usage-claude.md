# Claude usage collector

Reads this seat's Claude Code subscription windows and returns them as a usage observation
under the [usage contract](usage-contract.md). It is a read: two GETs on a fixed origin,
then exit. Nothing is stored, the credential is read at call time and never refreshed or
rewritten, and no model turn is spent.

## What it is for

A pool's remaining capacity is a fact about a billing account. For Claude Code that account
is the organization behind `~/.claude/.credentials.json`. This collector is the reporter for
that pool. It produces an observation whose `attestation` is `cooperative` and whose `source`
is `harness`. A consumer that needs an enforced attestation must obtain it elsewhere.

## API

```js
import { collectClaudeUsage } from '../src/usage/claude.mjs';

const result = await collectClaudeUsage({ poolId, producer, now: () => new Date() });
if (result.status === 'supported') {
  result.principal;
  result.observation;
} else {
  result.code;
}
```

`collectClaudeUsage(options)` — the public path.

| Option | Required | Meaning |
|---|---|---|
| `poolId` | yes | The pool this reading is about. |
| `producer` | yes | Who is making the statement; validated by the contract. |
| `now` | yes | A clock, `() => Date`. Injected so a caller owns the capture instant. |
| `readCredential` | no | Token reader for tests. Defaults to the Claude Code credential file. |
| `fetch` | no | Transport for tests. Default refuses redirects and any non-Anthropic origin. |
| `credentialPath` | no | Override of the default CLI credential file. |
| `timeoutMs` | no | Budget for each request. Defaults to `CLAUDE_LIMITS.timeoutMs`. |
| `signal` | no | An `AbortSignal` to cancel the read. |

Returns `{status: 'supported', principal, observation}` or `{status: 'unsupported'|'error',
code}`. The caller supplies the clock and the producer. Nothing durable is created.

Lower-level exports: `normalizeUsageAndProfile`, `windowsFromUsage`, `windowReadingFrom`,
`resetsAtToIso`, `defaultFetch`, `defaultReadCredential`, `CLAUDE_ORIGIN`, `CLAUDE_LIMITS`.

## How the reading is taken

`GET https://api.anthropic.com/api/oauth/usage` and `GET https://api.anthropic.com/api/oauth/profile`
with the CLI's OAuth token and `anthropic-beta: oauth-2025-04-20`. Redirects are refused;
Authorization is never forwarded to another host. Timeout and abort apply during every `reader.read`, including the final `done` read,
not only between requests. Bodies must be streams; a response without `getReader` is
`claude-body-unstreamed` and `arrayBuffer` is never called. Stream bodies are read
incrementally up to `CLAUDE_LIMITS.maxBytes`. Cancel is not awaited unbounded. 401 is `claude-unsupported-until-refresh`;
the next call rereads the file so a harness refresh can restore service. Diagnostic codes
are allowlisted; an exception's `code` is never copied into the result.

## How a reading is shaped

Named top-level windows are authoritative: `five_hour` (300 minutes), `seven_day`,
`seven_day_opus`, `seven_day_sonnet` (10080 minutes). The `limits` array restates those
windows and is not emitted as additional ones. `extra_usage` and `spend` stay out of
numeric window arithmetic.

- `utilization` is a used percent and converts to basis points. Finer than a basis point is
  unavailable with a reason, never rounded.
- A present malformed named window is retained as unavailable so a `full` snapshot does not
  silently drop a represented slot.
- A null named window is omitted, not zero.
- `resets_at` is converted to exact `Date.toISOString()`. Absent or null omits the field, so
  freshness is `unknown`, never `fresh`. A present unparseable value is unavailable with
  `unsupported-reset`; it is not reported as a window with no reset metadata.
- `organization.uuid` is `principalRef`. Absence is identity-unavailable, never a path-derived
  principal. Names, email and account blocks never leave the process.

## When there is no reading

Missing or invalid credential, 401, timeout, cancel, oversized body, malformed JSON, redirect,
wrong origin, provider rejection, missing organization, or no represented windows: an explicit
non-value code, never a quota of zero. Body and reader `cancel()` are discarded, not awaited:
a rejected or never-settling cancel cannot hang the collector or become an unhandled rejection
after a bounded return.

## What this is not

It is not a CLI, a store, a router, an attestor, or a refresh. Two Claude Code sessions on
one login are one pool: they share the organization uuid. Same-process execution is not
authority.
