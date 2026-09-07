# Session accounting: inventory of joined members

`src/session-accounting.mjs` is the E1d unit: a public inventory of every joined member
with either measured session usage from the E1c ledger, or an explicit `unsupported`
reason. It does not call a provider, does not print transcript text, and does not infer
a source identity from a PID or boot epoch.

## Verb

`agora usage-sessions [--room <cursor-key>] [--ledger-root <path>] [--bind <file>] [--ingest <file>] [--json] [--follow] [--interval <s>] [--for <s>]`

`--bind` is JSON `{ "<slug>": { "harness", "sessionEpoch", "sourceId" } }`. A member
without a binding is `unsupported unknown-binding`, never measured-as-zero. A binding
that includes `pid` or `bootEpoch` is refused. Whitespace-only binding fields are
malformed. Lookup matches that triple on the stored identity; `sourceUnit` is not
assumed, so a Codex snapshot or Amore aggregate still binds.

`--ingest` is JSONL of original usage envelopes `{ harness, sessionEpoch, envelope, context? }`.
Each line is decoded through `decodeSessionUsage` and committed. A decode that is
not `supported` is not stored as overlap `none`.

`--follow` is the continuous mode: one snapshot per interval until `--for` or SIGINT.
A one-shot report is not that mode. SIGINT/SIGTERM abort the owned controller; listeners
are removed in `finally`. On win32 `process.kill` is TerminateProcess, so the delivered
SIGINT cell is skipped there and owed to a POSIX runner.

`--ledger-root` is required for measured rows. Existing `agora usage` (pool quotas) is
unchanged.

## Membership

Live and gone sessions come from `listRecords`. If `--room` is set, only sessions with
state in that cursor key are listed (`hasRoomState`). Binding is independent of
liveness: a live unbound member is still unsupported. A ledger entry is measured when
its status is `confirmed` or `provisional` (E1b often leaves `finality: unknown`).

## Output

JSON: `{ type: "usage-sessions", members: [...] }`. A measured row carries the ledger
usage object. An unsupported row carries a reason and no usage field. Missing is not
zero.
