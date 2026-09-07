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

- `writer.lock` — exclusive create, holding the writer's pid. A second live `openSessionLedger`
  on the same root fails with `ledger-busy`. A leftover lock whose pid is not alive is
  unlinked and the open retried; a live pid is never stolen. Pid reuse is a residual: a
  recycled pid still looks live.
- `state.json` — one JSON object: ledger generation, last ingest position, per-key entries,
  gap records. Contribution and ingest position are the same write. Each stored entry
  retains `observedAt`, `model` when present, and every `sourceReported*` field the
  contract admitted (`sourceReportedCost` now; later optionals without a ledger edit).
  Each keeps the source's stated unit. The digest is still identity+usage
  only, so existing ledgers open; entries written before these fields simply omit them
  and a reader must treat omission as absent, never invent a time, model or cost. A
  later record with the same identity+usage and a different cost is a duplicate and
  does not replace the stored cost.

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

`deriveTotals` sums only `confirmed` entries. Every `provisional` entry it skipped
is listed on the bucket as `{ key, components }` so the omission is visible; a
consumer may sum those at its own risk. Overlap is honoured on both sides:
`contained-in-parent` excludes that record; `contains-child` excludes the named
`peerKey` when that key is a confirmed ledger entry (`parent-declared`). `unknown`
is not `none`: it is excluded with reason `overlap-unknown`, never added. An orphan
child whose named parent is absent is excluded with reason `parent-absent`. A
`contains-child` whose `peerKey` matches no confirmed entry still sums the other
records, and records `{ key: peerKey, reason: 'peer-absent' }` so the dropped
claim is visible. Each excluded row is `{ key, reason }`. A record whose overlap
`peerKey` equals its own ledger key is stored as `conflict` with reason
`self-overlap`. Two confirmed parents naming the same child still sum, exclude
the child, and record `{ reason: 'parent-contradiction', keys }` on conflicts.
`reasoning-billed` is stored on the entry and is never folded into output.

## Ingest position

Each commit carries `{ locator, sourceGeneration, offset, fingerprint }`. Rotation is a
higher `sourceGeneration`. Duplicate and ignore-partial results still persist the ingest
position: the contribution is unchanged, the cursor advances, so a later commit cannot
invent an offset-skip and a restart cannot re-read consumed offsets.

A same-generation offset **behind** the stored position is refused (`ledger-ingest-rewind`);
the position does not move backwards. That is not a re-ingest window. An offset skip
(jumping forward inside one generation) is recorded as a gap and the position moves to the
new offset. A corrupt `state.json` (including an entry missing identity) fails `open` with
`ledger-corrupt`, not a late protocol throw.

Replay of the same identity digest after rotation is still a duplicate. Prior
contributions are not deleted by a skip or a refused rewind.

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
