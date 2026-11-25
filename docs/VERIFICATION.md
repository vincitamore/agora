# Verification, bad-bytes corpus, and proved kernels

This document covers the internal verification instruments that guard Agora's storage, native
cursor/board/settlement logic, and static watcher import graph. For day-to-day test commands, see
[CONTRIBUTING.md](../CONTRIBUTING.md).

## Native room bad-bytes corpus

`test/fixtures/native-store-bad/` is a deterministic corpus of on-disk native rooms: one good room
that `NativeRoomStore.open` must accept (messages, a board claim, an app-submitted reply, a
checkpointed boundary) and one damaged copy per named failure mode:

- **Byte-level framing and files**: truncated last frame, overrunning length header, bad checksum,
  non-JSON payload, sequence gap, missing/corrupt manifest fields, boundary ending mid-frame or
  naming a foreign epoch or disagreeing with the log, unparseable or dead-endpoint writer lock.
- **Field-level validation behind well-formed frames**: re-sealed frames (valid checksums) with
  wrong room/epoch/protocol version, malformed operation/account/payload/record digests, invalid
  chat/board record fields, malformed `via`/`author.ref` or `ref` without `via`, invalid boundary
  fields, plus boundary edge cases that must open (exact record limit, first-three-frame boundary).

Each case carries an `EXPECT.json` naming what `NativeRoomStore.open` must return or refuse.
`scripts/make-bad-bytes-corpus.mjs` builds the corpus under a fixed clock and fixed IDs:

```sh
node scripts/make-bad-bytes-corpus.mjs --check   # exits 1 if committed corpus drifts
node --test test/native-store-bad-bytes.test.mjs # opens every case offline
```

Never hand-edit a fixture case; add new mutations to `scripts/make-bad-bytes-corpus.mjs` (using
`editRecord` for field-level cases so frame checksums stay valid and the field validator is what
refuses).

## Machine-checked Bend kernels

Three core state machines are written in Bend 2, machine-checked against formal law suites, and
compiled to plain committed JavaScript so the CLI keeps zero npm runtime dependencies:

1. **Native read cursor (`spec/cursor.bend` -> `src/native-cursor.kernel.mjs`)**: decides which
   rows a native room read delivers and which cursors it refuses. Seven laws (`spec/LAWS.bend`,
   proved by `spec/PROOF.bend`) cover foreign-epoch refusal, future-cursor refusal, no-advance on
   refusal, exact range delivery, and monotonicity. `src/native-store.mjs` imports it directly.
2. **Board admission (`spec/board.bend` -> `src/native-board.kernel.mjs`)**: judges `claim`,
   `renew`, `release`, `contest`, and `break` against live/expired holders. Fifteen laws
   (`spec/BOARD-LAWS.bend`, proved by `spec/BOARD-PROOF.bend`) cover exclusivity, expiry, fencing,
   holder-only release, human-only break, no-op refusals, and helper invariants. Verified on reopen
   by `test/native-board-verdict-holder.test.mjs`.
3. **Carry settlement ledger (`spec/settlement.bend` -> `src/settlement.kernel.mjs`)**: a
   byte-for-byte copy of the `singulis` settlement ledger (`Assert`, `Allocate`, `Retract`) with
   thirteen laws (`spec/SETTLEMENT-LAWS.bend`, proved by `spec/SETTLEMENT-PROOF.bend`) and an
   origin digest (`spec/settlement.origin.json`). `carry` folds a session's verdicts and
   withdrawals through this kernel in one constant-stack tail-recursive pass.

### Regenerating and checking kernels

The Bend compiler commit is pinned in `spec/bend.pin.json`:

```sh
node scripts/bend-checkout.mjs                                     # fetch pinned Bend commit into ../bend-src
BEND_CLONE=../bend-src bun spec/build-kernel.ts --check            # verify committed kernels match fresh compilation
BEND_CLONE=../bend-src bun spec/build-kernel.ts [--spec cursor|board|settlement]  # re-prove and regenerate
```

`build-kernel.ts` proves each kernel's `PROOF` file first, refuses `@unsafe`, `?TODO`, and hash
imports, checks `spec/settlement.origin.json` (and `SINGULIS_SPEC` / `../singulis/spec` when
present), and verifies the Bend pin commit. Never edit generated `*.kernel.mjs` files by hand.

Optional mirror override: set `BEND_MIRROR` (and `BEND_MIRROR_TAG`, default `pin-<sha7>`) if
upstream force-pushes its squashed commit.

To trial advancing the upstream Bend pin in an isolated scratch worktree without modifying the
working tree:

```sh
node scripts/bend-upstream-trial.mjs
```

### C0 for laws (known-red mutation suite)

Every law ships a known-red mutation of its model under `spec/laws-red/<kernel>/<law>/`:

```sh
BEND_CLONE=../bend-src bun spec/laws-check.ts          # prove green, then verify every red fixture fails its law
BEND_CLONE=../bend-src bun spec/laws-check.ts --list   # list each law's fixture and reason
```

Each red fixture may overlay only the model file (and for accumulator proofs in `settlement`, a
concrete `witness.bend` that prints `True{}` on the mutation and `False{}` on the real model). A
law that no mutation can redden constrains nothing and must be restated, never dropped.
`test/native-cursor-kernel.test.mjs`, `test/native-board-kernel.test.mjs`, and
`test/native-laws-red.test.mjs` run automatically where `bun` and a Bend checkout exist and verify
the JavaScript faces and fixture sets everywhere.

## Watcher import-graph scanner

`agora doctor` and `agora session --list` compare live watchers against the installed working tree
by intersecting changed files with the transitive static import graph of the watch entry
(`src/harness.mjs`).

- The scanner reads source without executing it; any unresolved relative specifier, string escape,
  or prose mention of `import(` / `require(` inside a file on the graph forces the result to
  `unknown` (a safe `WARNING`, never a false `inert`).
- `test/harness-import-graph.test.mjs` pins the closure so an unresolvable comment or load fails in
  the same commit.
- Audited dynamic-load exceptions live in `COMPUTED_LOAD_EXEMPTIONS` in `src/harness.mjs`, pinned
  by file, exact count, and expression digest:

```sh
node -e 'import("./src/harness.mjs").then(m => console.log(m.auditedChooserDigest("src/native-service.mjs")))'
```

## Native room writer lock

A native room writer takes `writer.lock` by exclusive create (`wx`). After `EEXIST`, only
`ECONNREFUSED` on the recorded loopback port licenses unlinking a stale lock. The listen port is
OS-allocated (`127.0.0.1` port `0`, exclusive), never derived.
