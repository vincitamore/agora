# Session ledger: revision reconciliation and local persistence

`src/usage/session-ledger.mjs` is the E1c unit: a **pure** reconciler for session-usage
records, and a **bounded local file ledger** that atomically commits a contribution with
its ingestion position. It does not talk to a provider, does not start a service, does not
price tokens, and does not compact anyone.

It consumes E1a `validateSessionUsageRecord`, `supersedesContribution`, `isSummableUnit`
and `ledgerKey` (length-prefixed, injective). A well-formed record is a well-formed claim,
not a verified one. `ledgerKey` is re-exported so a ledger caller does not import two
modules for one identity.

## What it stores

Under a caller-supplied `root`:

- `writer.lock` — exclusive create. A second `openSessionLedger` on the same root fails
  with `ledger-busy`. The lock is not a shared service; a leftover lock from a dead process
  is not stolen. The caller removes it only after proving the holder is gone.
- `state.json` — one JSON object: ledger generation, last ingest position, per-key entries,
  gap records. Contribution and ingest position are the same write.

Nothing else. No raw provider bodies, no transcript text, no credentials.

`limits.maxBytes` and `limits.maxEntries` are required caller inputs. Exceeding either
refuses before the write; the previous snapshot remains.

## Reconciliation

`reconcileRevision(accepted, candidate)` is pure. For one `ledgerKey`:

- An identical digest is a duplicate, not a second charge.
- A later `finality: revision` with a **greater** integer `revision` **replaces** the
  stored contribution (lowering output 100→80, or a same-output cache correction).
- If ordering is not evidenced (`finality: unknown`, missing sequence, or a non-increasing
  revision), the result is **conflict**. The ledger does not pick max-output and does not
  pick last-arrival.
- A `cumulative-snapshot` decrease without `reset: true` and without a higher source
  generation is a **gap**, never a negative charge. With reset or rotation it replaces.
- A `streaming-partial` does not overwrite a confirmed final.
- `sourceUnit` is identity: a snapshot is never added as if it were a request.

`deriveTotals` sums only `confirmed` entries. `coverage.overlap: contained-in-parent`
excludes the child. `reasoning-billed` is stored on the entry and is never folded into
output.

## Ingest position

Each commit carries `{ locator, sourceGeneration, offset, fingerprint }`. Rotation is a
higher `sourceGeneration`. An offset skip or rewind is recorded as a gap and does not
delete prior contributions. Replay of the same identity digest after rotation is still a
duplicate.

## Crash and concurrency

Atomic write is temp file, `fsync`, rename, directory sync (directory sync is a no-op on
win32, where rename after file flush is the portable primitive). An injected failure
before rename leaves the previous `state.json`. A leftover `state.json.tmp-*` is not
state. Two writers cannot both hold the lock.

## Public exports

`openSessionLedger`, `closeSessionLedger`, `commitLedgerEvent({ record, ingest, reset })`,
`readLedgerSnapshot`, `reconcileRevision`, `deriveTotals`, `ledgerKey`, `LedgerError`.
`record` is an E1a session-usage record.

Readers execute these, not only the authored tests.
