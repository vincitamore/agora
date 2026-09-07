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
not `supported` is not stored as overlap `none`. `--follow` re-reads the file each
poll and ingests only lines past the ledger's persisted position for that locator
when the line at that offset still matches the stored fingerprint. A shorter file
or a fingerprint mismatch is a rotation: new generation, ingest from line one.
A replacement file that still has the identical line at the persisted offset
reads as an append (named limit; a two-position fingerprint is deferred). A
position written before this fingerprint existed carries a synthetic value, so
the first poll after that change opens a new generation and re-ingests the
file once; those events return as duplicates and the ledger absorbs them.
Each snapshot reports ingest counts
(`ingested`, `duplicate`, `unsupported`, `malformed`) and the offsets of failed
lines: in the JSON object, and as one stderr line in text mode.

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
usage object and `status` (`confirmed` or `provisional`, the ledger entry's own).
An unsupported row carries a reason and no usage field. Missing is not zero.
