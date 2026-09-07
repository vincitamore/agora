// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateNativeId } from '../src/protocol/common.mjs';
import { ProtocolUsageError } from '../src/protocol/session-usage.mjs';
import { validateSessionUsageRecord } from '../src/protocol/session-usage.mjs';
import {
  LedgerError, closeSessionLedger, commitLedgerEvent, deriveTotals, fingerprintRecord,
  ledgerKey, openSessionLedger, readLedgerSnapshot, reconcileRevision,
} from '../src/usage/session-ledger.mjs';

const EPOCH = 'session-epoch-synthetic-01';
const OBSERVED = '2026-09-07T09:00:00.000Z';
/** @param {number} value */
const known = (value) => ({ state: /** @type {const} */ ('known'), value, unit: /** @type {const} */ ('tokens') });
/** @param {string} [reason] */
const unknown = (reason = 'missing') => ({ state: /** @type {const} */ ('unknown'), reason });
/** @param {string} [reason] */
const na = (reason = 'source-excludes') => ({ state: /** @type {const} */ ('not-applicable'), reason });

/** @param {{ sourceId: string } & Record<string, unknown>} extra */
function identity(extra) {
  return {
    harness: 'codex',
    sessionEpoch: EPOCH,
    sourceUnit: /** @type {const} */ ('request'),
    finality: /** @type {const} */ ('final'),
    ...extra,
  };
}

/**
 * @param {Record<string, unknown>} [counters]
 * @param {{ relation: 'none'|'unknown'|'contained-in-parent'|'contains-child', peerKey?: string }} [overlap]
 */
function usage(counters = {}, overlap = undefined) {
  return {
    components: {
      'uncached-input': known(10),
      'cached-input': known(0),
      'cache-write-5m': known(0),
      'cache-write-1h': unknown('no-1h-contract'),
      'cache-write-unknown-ttl': unknown('no-unsplit-write'),
      output: known(100),
      'reasoning-billed': unknown('inclusion-unknown'),
      tool: na('no-tool-charges'),
      ...counters,
    },
    coverage: /** @type {const} */ ('complete'),
    ...(overlap ? { overlap } : {}),
  };
}

/** @param {number} offset @param {number} [generation] */
function ingest(offset, generation = 1) {
  return {
    locator: 'synthetic-source-1',
    sourceGeneration: generation,
    offset,
    fingerprint: `fp:${generation}:${offset}`,
  };
}

/**
 * @param {(ledger: Awaited<ReturnType<typeof openSessionLedger>>, root: string) => Promise<void>} fn
 * @param {{ writeAtomic?: (file:string, text:string)=>Promise<void> }} [io]
 */
async function withLedger(fn, io) {
  const root = await mkdtemp(path.join(tmpdir(), 'agora-ledger-'));
  const ledger = await openSessionLedger({ root, limits: { maxBytes: 256_000, maxEntries: 64 }, io });
  try { await fn(ledger, root); }
  finally { if (!ledger.closed) await closeSessionLedger(ledger); }
}

test('ledgerKey is injective across colon-bearing identity fields and cannot pass as a native id', () => {
  const a = ledgerKey(identity({ harness: 'a:b', sessionEpoch: 'c', sourceId: 'd' }));
  const b = ledgerKey(identity({ harness: 'a', sessionEpoch: 'b:c', sourceId: 'd' }));
  assert.notEqual(a, b);
  assert.equal(a, 'src:3:a:b1:c1:d');
  assert.equal(b, 'src:1:a3:b:c1:d');
  assert.throws(() => validateNativeId(a), /protocol/);
  const odd = ledgerKey(identity({ sourceId: 'turn/abc:not-a-native-id' }));
  assert.ok(odd.includes('turn/abc:not-a-native-id'));
});

test('validateSessionUsageRecord refuses revision finality without an ordinal', () => {
  assert.throws(
    () => validateSessionUsageRecord({ identity: identity({ sourceId: 'r1', finality: 'revision' }), observedAt: OBSERVED, usage: usage() }),
    ProtocolUsageError,
  );
});

test('known zero, unknown, and not-applicable stay three states', () => {
  const set = usage({ 'cache-write-5m': known(0), 'cache-write-1h': unknown('no-1h-contract'), tool: na('no-tool') });
  assert.equal(set.components['cache-write-5m'].state, 'known');
  assert.equal(set.components['cache-write-5m'].value, 0);
  assert.equal(set.components['cache-write-1h'].state, 'unknown');
  assert.equal(Object.hasOwn(set.components['cache-write-1h'], 'value'), false);
  assert.equal(set.components.tool.state, 'not-applicable');
});

test('lowering-output revision 100 to 80 replaces under proven order', () => {
  const firstId = identity({ sourceId: 'req-1', finality: 'final', revision: 1 });
  const firstUsage = usage({ output: known(100) });
  const accepted = { identity: firstId, usage: firstUsage, status: /** @type {const} */ ('confirmed'), digest: fingerprintRecord(firstId, firstUsage) };
  const secondId = identity({ sourceId: 'req-1', finality: 'revision', revision: 2 });
  const secondUsage = usage({ output: known(80) });
  const result = reconcileRevision(accepted, { identity: secondId, usage: secondUsage, digest: fingerprintRecord(secondId, secondUsage) });
  assert.equal(result.action, 'replace');
  assert.equal(result.status, 'confirmed');
});

test('same-output later cache correction replaces cache components under proven order', () => {
  const firstId = identity({ sourceId: 'req-1', finality: 'final', revision: 1 });
  const firstUsage = usage({ output: known(100), 'cache-write-5m': known(0) });
  const accepted = { identity: firstId, usage: firstUsage, status: /** @type {const} */ ('confirmed'), digest: fingerprintRecord(firstId, firstUsage) };
  const secondId = identity({ sourceId: 'req-1', finality: 'revision', revision: 2 });
  const secondUsage = usage({ output: known(100), 'cache-write-5m': known(40) });
  const result = reconcileRevision(accepted, { identity: secondId, usage: secondUsage, digest: fingerprintRecord(secondId, secondUsage) });
  assert.equal(result.action, 'replace');
});

test('ambiguous ordering is a conflict, not max-output and not last-arrival', () => {
  const firstId = identity({ sourceId: 'req-1', finality: 'unknown' });
  const firstUsage = usage({ output: known(100) });
  const accepted = { identity: firstId, usage: firstUsage, status: /** @type {const} */ ('provisional'), digest: fingerprintRecord(firstId, firstUsage) };
  const secondId = identity({ sourceId: 'req-1', finality: 'unknown' });
  const secondUsage = usage({ output: known(80) });
  const result = reconcileRevision(accepted, { identity: secondId, usage: secondUsage, digest: fingerprintRecord(secondId, secondUsage) });
  assert.equal(result.action, 'conflict');
  assert.equal(result.reason, 'ordering-unproven');
  const orderedId = identity({ sourceId: 'req-1', finality: 'revision', revision: 2 });
  const ordered = reconcileRevision(
    { ...accepted, identity: identity({ sourceId: 'req-1', finality: 'final', revision: 1 }) },
    { identity: orderedId, usage: secondUsage, digest: fingerprintRecord(orderedId, secondUsage) },
  );
  assert.equal(ordered.action, 'replace');
});

test('identical replay is duplicate, not a second charge', () => {
  const id = identity({ sourceId: 'req-1' });
  const u = usage();
  const digest = fingerprintRecord(id, u);
  const accepted = { identity: id, usage: u, status: /** @type {const} */ ('confirmed'), digest };
  const result = reconcileRevision(accepted, { identity: id, usage: u, digest });
  assert.equal(result.action, 'duplicate');
});

test('cumulative decrease without reset is a gap, not a negative charge', () => {
  const snap = () => identity({ sourceId: 'cum-1', sourceUnit: 'cumulative-snapshot', finality: 'final' });
  const firstUsage = usage({ output: known(100) });
  const accepted = { identity: snap(), usage: firstUsage, status: /** @type {const} */ ('confirmed'), digest: fingerprintRecord(snap(), firstUsage) };
  const secondUsage = usage({ output: known(40) });
  const gap = reconcileRevision(accepted, { identity: snap(), usage: secondUsage, digest: fingerprintRecord(snap(), secondUsage) });
  assert.equal(gap.action, 'gap');
  const reset = reconcileRevision(accepted, { identity: snap(), usage: secondUsage, digest: fingerprintRecord(snap(), secondUsage), reset: true });
  assert.equal(reset.action, 'reset');
});

test('parent and child aggregates are not summed', () => {
  const parentId = identity({ sourceId: 'prompt-1', sourceUnit: 'aggregate' });
  const childId = identity({ sourceId: 'prompt-1/model-a', sourceUnit: 'aggregate' });
  const parentKey = ledgerKey(parentId);
  const childKey = ledgerKey(childId);
  const parent = {
    status: /** @type {const} */ ('confirmed'),
    identity: parentId,
    usage: usage({ output: known(90) }, { relation: 'contains-child', peerKey: childKey }),
    digest: 'p',
  };
  const child = {
    status: /** @type {const} */ ('confirmed'),
    identity: childId,
    usage: usage({ output: known(90) }, { relation: 'contained-in-parent', peerKey: parentKey }),
    digest: 'c',
  };
  const totals = deriveTotals({ [parentKey]: parent, [childKey]: child });
  assert.equal(totals.aggregate.components.output.value, 90);
  assert.deepEqual(totals.aggregate.excluded, [{ key: childKey, reason: 'contained-in-parent' }]);
});

test('reasoning is never added into output totals', () => {
  const id = identity({ sourceId: 'req-1' });
  const key = ledgerKey(id);
  const entry = {
    status: /** @type {const} */ ('confirmed'),
    identity: id,
    usage: usage({ output: known(50), 'reasoning-billed': known(20) }),
    digest: 'd',
  };
  const totals = deriveTotals({ [key]: entry });
  assert.equal(totals.request.components.output.value, 50);
  assert.equal(Object.hasOwn(totals.request.components, 'reasoning-billed'), false);
});

test('repeated commit, restart, and rotation keep one contribution', async () => {
  await withLedger(async (ledger, root) => {
    const rec = { identity: identity({ sourceId: 'req-1' }), observedAt: OBSERVED, usage: usage() };
    const first = await commitLedgerEvent(ledger, { record: rec, ingest: ingest(1) });
    assert.equal(first.action, 'accept');
    const again = await commitLedgerEvent(ledger, { record: rec, ingest: ingest(1) });
    assert.equal(again.duplicate, true);
    await closeSessionLedger(ledger);
    const reopened = await openSessionLedger({ root, limits: { maxBytes: 256_000, maxEntries: 64 } });
    try {
      const snap = readLedgerSnapshot(reopened);
      assert.equal(Object.keys(snap.entries).length, 1);
      assert.equal(snap.totals.request.components.output.value, 100);
      const rotated = await commitLedgerEvent(reopened, { record: rec, ingest: ingest(0, 2) });
      assert.equal(rotated.duplicate, true);
    } finally {
      await closeSessionLedger(reopened);
    }
  });
});

test('lowering revision persists as 80 after restart', async () => {
  await withLedger(async (ledger) => {
    await commitLedgerEvent(ledger, {
      record: { identity: identity({ sourceId: 'req-1', finality: 'final', revision: 1 }), observedAt: OBSERVED, usage: usage({ output: known(100) }) },
      ingest: ingest(1),
    });
    const replaced = await commitLedgerEvent(ledger, {
      record: { identity: identity({ sourceId: 'req-1', finality: 'revision', revision: 2 }), observedAt: OBSERVED, usage: usage({ output: known(80) }) },
      ingest: ingest(2),
    });
    assert.equal(replaced.action, 'replace');
    assert.equal(readLedgerSnapshot(ledger).totals.request.components.output.value, 80);
  });
});

test('atomic write failure leaves the prior contribution and offset', async () => {
  await withLedger(async (ledger) => {
    await commitLedgerEvent(ledger, {
      record: { identity: identity({ sourceId: 'req-1' }), observedAt: OBSERVED, usage: usage() },
      ingest: ingest(1),
    });
    ledger.io.writeAtomic = async () => { throw new Error('injected'); };
    await assert.rejects(
      () => commitLedgerEvent(ledger, {
        record: { identity: identity({ sourceId: 'req-2' }), observedAt: OBSERVED, usage: usage({ output: known(7) }) },
        ingest: ingest(2),
      }),
      (/** @type {unknown} */ err) => err instanceof LedgerError && err.code === 'ledger-write-failed',
    );
    const snap = readLedgerSnapshot(ledger);
    assert.equal(Object.keys(snap.entries).length, 1);
    assert.equal(snap.ingest && snap.ingest.offset, 1);
    assert.equal(snap.totals.request.components.output.value, 100);
  });
});

test('competing writers: second open is bounded busy and the first state remains', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agora-ledger-'));
  const first = await openSessionLedger({ root, limits: { maxBytes: 256_000, maxEntries: 64 } });
  try {
    await assert.rejects(
      () => openSessionLedger({ root, limits: { maxBytes: 256_000, maxEntries: 64 } }),
      (/** @type {unknown} */ err) => err instanceof LedgerError && err.code === 'ledger-busy',
    );
    await commitLedgerEvent(first, {
      record: { identity: identity({ sourceId: 'req-1' }), observedAt: OBSERVED, usage: usage() },
      ingest: ingest(1),
    });
    assert.equal(readLedgerSnapshot(first).totals.request.components.output.value, 100);
  } finally {
    await closeSessionLedger(first);
  }
});

test('leftover temp file does not become state and open recovers the committed snapshot', async () => {
  await withLedger(async (ledger, root) => {
    await commitLedgerEvent(ledger, {
      record: { identity: identity({ sourceId: 'req-1' }), observedAt: OBSERVED, usage: usage() },
      ingest: ingest(1),
    });
    await writeFile(path.join(root, 'state.json.tmp-dead'), '{"version":1,"entries":{}}', 'utf8');
    await closeSessionLedger(ledger);
    const reopened = await openSessionLedger({ root, limits: { maxBytes: 256_000, maxEntries: 64 } });
    try {
      assert.equal(readLedgerSnapshot(reopened).totals.request.components.output.value, 100);
    } finally {
      await closeSessionLedger(reopened);
    }
  });
});

test('entry and byte limits refuse before writing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agora-ledger-'));
  const ledger = await openSessionLedger({ root, limits: { maxBytes: 64_000, maxEntries: 1 } });
  try {
    await commitLedgerEvent(ledger, {
      record: { identity: identity({ sourceId: 'req-1' }), observedAt: OBSERVED, usage: usage() },
      ingest: ingest(1),
    });
    await assert.rejects(
      () => commitLedgerEvent(ledger, {
        record: { identity: identity({ sourceId: 'req-2' }), observedAt: OBSERVED, usage: usage() },
        ingest: ingest(2),
      }),
      (/** @type {unknown} */ err) => err instanceof LedgerError && err.code === 'ledger-limit'
        && /entries; entries=1 offset=1/.test(/** @type {Error} */ (err).message),
    );
    assert.equal(Object.keys(readLedgerSnapshot(ledger).entries).length, 1);
  } finally {
    await closeSessionLedger(ledger);
  }
  const tiny = await openSessionLedger({ root: await mkdtemp(path.join(tmpdir(), 'agora-ledger-')), limits: { maxBytes: 64, maxEntries: 64 } });
  try {
    await assert.rejects(
      () => commitLedgerEvent(tiny, {
        record: { identity: identity({ sourceId: 'req-1' }), observedAt: OBSERVED, usage: usage() },
        ingest: ingest(1),
      }),
      (/** @type {unknown} */ err) => err instanceof LedgerError && err.code === 'ledger-limit',
    );
    assert.equal(readLedgerSnapshot(tiny).ingest, null);
  } finally {
    await closeSessionLedger(tiny);
  }
});

test('byte cap binds before the entry cap and the report names bytes', async () => {
  const probeRoot = await mkdtemp(path.join(tmpdir(), 'agora-ledger-'));
  const probe = await openSessionLedger({ root: probeRoot, limits: { maxBytes: 256_000, maxEntries: 64 } });
  let twoBytes = 0;
  try {
    await commitLedgerEvent(probe, {
      record: { identity: identity({ sourceId: 'req-1' }), observedAt: OBSERVED, usage: usage() },
      ingest: ingest(1),
    });
    await commitLedgerEvent(probe, {
      record: { identity: identity({ sourceId: 'req-2' }), observedAt: OBSERVED, usage: usage() },
      ingest: ingest(2),
    });
    twoBytes = Buffer.byteLength(JSON.stringify(probe.state), 'utf8');
  } finally {
    await closeSessionLedger(probe);
  }
  // Entry cap 100 would admit many more; byte cap is just above two records.
  const root = await mkdtemp(path.join(tmpdir(), 'agora-ledger-'));
  const ledger = await openSessionLedger({ root, limits: { maxBytes: twoBytes + 80, maxEntries: 100 } });
  try {
    await commitLedgerEvent(ledger, {
      record: { identity: identity({ sourceId: 'req-1' }), observedAt: OBSERVED, usage: usage() },
      ingest: ingest(1),
    });
    await commitLedgerEvent(ledger, {
      record: { identity: identity({ sourceId: 'req-2' }), observedAt: OBSERVED, usage: usage() },
      ingest: ingest(2),
    });
    await assert.rejects(
      () => commitLedgerEvent(ledger, {
        record: { identity: identity({ sourceId: 'req-3' }), observedAt: OBSERVED, usage: usage() },
        ingest: ingest(3),
      }),
      (/** @type {unknown} */ err) => err instanceof LedgerError && err.code === 'ledger-limit'
        && /bytes; entries=2 offset=2/.test(/** @type {Error} */ (err).message),
    );
    assert.equal(Object.keys(readLedgerSnapshot(ledger).entries).length, 2);
    assert.equal(readLedgerSnapshot(ledger).ingest?.offset, 2);
  } finally {
    await closeSessionLedger(ledger);
  }
});

test('a cumulative-snapshot is not added as if it were a request', async () => {
  await withLedger(async (ledger) => {
    await commitLedgerEvent(ledger, {
      record: { identity: identity({ sourceId: 'req-1' }), observedAt: OBSERVED, usage: usage({ output: known(10) }) },
      ingest: ingest(1),
    });
    await commitLedgerEvent(ledger, {
      record: { identity: identity({ sourceId: 'cum-1', sourceUnit: 'cumulative-snapshot' }), observedAt: OBSERVED, usage: usage({ output: known(999) }) },
      ingest: ingest(2),
    });
    const totals = readLedgerSnapshot(ledger).totals;
    assert.equal(totals.request.components.output.value, 10);
    assert.equal(totals.snapshot.components.output.value, 999);
  });
});

test('duplicate and ignore-partial still persist the ingest position; restart does not re-read it', async () => {
  await withLedger(async (ledger, root) => {
    const rec = { identity: identity({ sourceId: 'req-1' }), observedAt: OBSERVED, usage: usage() };
    await commitLedgerEvent(ledger, { record: rec, ingest: ingest(1) });
    const dup = await commitLedgerEvent(ledger, { record: rec, ingest: ingest(2) });
    assert.equal(dup.action, 'duplicate');
    assert.equal(readLedgerSnapshot(ledger).ingest?.offset, 2);
    const next = await commitLedgerEvent(ledger, {
      record: { identity: identity({ sourceId: 'req-2' }), observedAt: OBSERVED, usage: usage() },
      ingest: ingest(3),
    });
    assert.equal(next.action, 'accept');
    assert.equal(readLedgerSnapshot(ledger).gaps.filter((g) => /** @type {{kind?:string}} */ (g).kind === 'offset-skip').length, 0);
    const ignored = await commitLedgerEvent(ledger, {
      record: { identity: identity({ sourceId: 'req-2', finality: 'streaming-partial' }), observedAt: OBSERVED, usage: usage({ output: known(5) }) },
      ingest: ingest(4),
    });
    assert.equal(ignored.action, 'ignore-partial');
    assert.equal(readLedgerSnapshot(ledger).ingest?.offset, 4);
    await closeSessionLedger(ledger);
    const reopened = await openSessionLedger({ root, limits: { maxBytes: 256_000, maxEntries: 64 } });
    try {
      assert.equal(readLedgerSnapshot(reopened).ingest?.offset, 4);
    } finally {
      await closeSessionLedger(reopened);
    }
  });
});

test('same-generation offset rewind is refused and the stored position does not move', async () => {
  await withLedger(async (ledger) => {
    await commitLedgerEvent(ledger, {
      record: { identity: identity({ sourceId: 'req-1' }), observedAt: OBSERVED, usage: usage() },
      ingest: ingest(5),
    });
    await assert.rejects(
      () => commitLedgerEvent(ledger, {
        record: { identity: identity({ sourceId: 'req-2' }), observedAt: OBSERVED, usage: usage() },
        ingest: ingest(3),
      }),
      (/** @type {unknown} */ err) => err instanceof LedgerError && err.code === 'ledger-ingest-rewind',
    );
    assert.equal(readLedgerSnapshot(ledger).ingest?.offset, 5);
    assert.equal(Object.keys(readLedgerSnapshot(ledger).entries).length, 1);
  });
});

test('a leftover lock from a dead pid is recovered; a live holder stays busy', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agora-ledger-'));
  await writeFile(path.join(root, 'writer.lock'), '999999999', 'utf8');
  const recovered = await openSessionLedger({ root, limits: { maxBytes: 256_000, maxEntries: 64 } });
  try {
    await commitLedgerEvent(recovered, {
      record: { identity: identity({ sourceId: 'req-1' }), observedAt: OBSERVED, usage: usage() },
      ingest: ingest(1),
    });
    await assert.rejects(
      () => openSessionLedger({ root, limits: { maxBytes: 256_000, maxEntries: 64 } }),
      (/** @type {unknown} */ err) => err instanceof LedgerError && err.code === 'ledger-busy',
    );
  } finally {
    await closeSessionLedger(recovered);
  }
});

test('a stored entry without identity is ledger-corrupt at open, not a late protocol throw', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agora-ledger-'));
  await writeFile(path.join(root, 'state.json'), JSON.stringify({
    version: 1,
    ledgerGeneration: 1,
    ingest: null,
    entries: { 'src:1:h1:e5:req-1': { status: 'confirmed', usage: { components: {}, coverage: 'none' }, digest: 'sha256:x' } },
    gaps: [],
  }), 'utf8');
  await assert.rejects(
    () => openSessionLedger({ root, limits: { maxBytes: 256_000, maxEntries: 64 } }),
    (/** @type {unknown} */ err) => err instanceof LedgerError && err.code === 'ledger-corrupt',
  );
});

/**
 * @param {ReturnType<typeof identity>} id
 * @param {Record<string, unknown>} [counters]
 * @param {{ relation: 'none'|'unknown'|'contained-in-parent'|'contains-child', peerKey?: string }} [overlap]
 */
function confirmedEntry(id, counters = {}, overlap = undefined) {
  return {
    status: /** @type {const} */ ('confirmed'),
    identity: id,
    usage: usage(counters, overlap),
    digest: 'd',
  };
}

test('contains-child excludes the named ledger key; a stub peerKey still sums and records peer-absent', () => {
  const parentId = identity({ sourceId: 'p' });
  const childId = identity({ sourceId: 'c' });
  const parentKey = ledgerKey(parentId);
  const childKey = ledgerKey(childId);
  const named = deriveTotals({
    [parentKey]: confirmedEntry(parentId, { output: known(100) }, { relation: 'contains-child', peerKey: childKey }),
    [childKey]: confirmedEntry(childId, { output: known(30) }),
  });
  assert.equal(named.request.components.output.value, 100);
  assert.deepEqual(named.request.excluded, [{ key: childKey, reason: 'parent-declared' }]);

  const stub = deriveTotals({
    [parentKey]: confirmedEntry(parentId, { output: known(100) }, { relation: 'contains-child', peerKey: 'child-key' }),
    [childKey]: confirmedEntry(childId, { output: known(30) }),
  });
  assert.equal(stub.request.components.output.value, 130);
  assert.deepEqual(stub.request.excluded, [{ key: 'child-key', reason: 'peer-absent' }]);
});

test('unknown overlap is excluded with a reason; absent overlap still sums', () => {
  const knownId = identity({ sourceId: 'k' });
  const unkId = identity({ sourceId: 'u' });
  const knownKey = ledgerKey(knownId);
  const unkKey = ledgerKey(unkId);
  const unknownCase = deriveTotals({
    [knownKey]: confirmedEntry(knownId, { output: known(100) }),
    [unkKey]: confirmedEntry(unkId, { output: known(7) }, { relation: 'unknown' }),
  });
  assert.equal(unknownCase.request.components.output.value, 100);
  assert.deepEqual(unknownCase.request.excluded, [{ key: unkKey, reason: 'overlap-unknown' }]);

  const summed = deriveTotals({
    [knownKey]: confirmedEntry(knownId, { output: known(100) }),
    [unkKey]: confirmedEntry(unkId, { output: known(7) }),
  });
  assert.equal(summed.request.components.output.value, 107);
  assert.deepEqual(summed.request.excluded, []);
});

test('orphan contained-in-parent is parent-absent; a present parent keeps the ordinary exclusion', () => {
  const childId = identity({ sourceId: 'orphan' });
  const childKey = ledgerKey(childId);
  const orphan = deriveTotals({
    [childKey]: confirmedEntry(childId, { output: known(30) }, { relation: 'contained-in-parent', peerKey: 'absent-parent' }),
  });
  assert.equal(Object.hasOwn(orphan.request.components, 'output'), false);
  assert.deepEqual(orphan.request.excluded, [{ key: childKey, reason: 'parent-absent' }]);
});

test('commit path: named child excluded, unknown not summed, two-sided twin still 100', async () => {
  await withLedger(async (ledger) => {
    const parentId = identity({ sourceId: 'p' });
    const childId = identity({ sourceId: 'c' });
    const unkId = identity({ sourceId: 'u' });
    const childKey = ledgerKey(childId);
    const unkKey = ledgerKey(unkId);
    await commitLedgerEvent(ledger, {
      record: { identity: parentId, observedAt: OBSERVED, usage: usage({ output: known(100) }, { relation: 'contains-child', peerKey: childKey }) },
      ingest: ingest(1),
    });
    await commitLedgerEvent(ledger, {
      record: { identity: childId, observedAt: OBSERVED, usage: usage({ output: known(30) }) },
      ingest: ingest(2),
    });
    await commitLedgerEvent(ledger, {
      record: { identity: unkId, observedAt: OBSERVED, usage: usage({ output: known(7) }, { relation: 'unknown' }) },
      ingest: ingest(3),
    });
    const totals = readLedgerSnapshot(ledger).totals.request;
    assert.equal(totals.components.output.value, 100);
    assert.deepEqual(totals.excluded, [
      { key: childKey, reason: 'parent-declared' },
      { key: unkKey, reason: 'overlap-unknown' },
    ]);
    assert.deepEqual(totals.conflicts, []);
    assert.deepEqual(totals.gaps, []);
  });

  await withLedger(async (ledger) => {
    const parentId = identity({ sourceId: 'p' });
    const childId = identity({ sourceId: 'c' });
    const parentKey = ledgerKey(parentId);
    const childKey = ledgerKey(childId);
    await commitLedgerEvent(ledger, {
      record: { identity: parentId, observedAt: OBSERVED, usage: usage({ output: known(100) }, { relation: 'contains-child', peerKey: childKey }) },
      ingest: ingest(1),
    });
    await commitLedgerEvent(ledger, {
      record: { identity: childId, observedAt: OBSERVED, usage: usage({ output: known(30) }, { relation: 'contained-in-parent', peerKey: parentKey }) },
      ingest: ingest(2),
    });
    const totals = readLedgerSnapshot(ledger).totals.request;
    assert.equal(totals.components.output.value, 100);
    assert.deepEqual(totals.excluded, [{ key: childKey, reason: 'contained-in-parent' }]);
  });
});

test('a record whose peerKey is its own ledger key is self-overlap, not parent-declared', async () => {
  await withLedger(async (ledger) => {
    const id = identity({ sourceId: 'self' });
    const key = ledgerKey(id);
    const result = await commitLedgerEvent(ledger, {
      record: { identity: id, observedAt: OBSERVED, usage: usage({ output: known(40) }, { relation: 'contains-child', peerKey: key }) },
      ingest: ingest(1),
    });
    assert.equal(readLedgerSnapshot(ledger).entries[key].status, 'conflict');
    assert.equal(readLedgerSnapshot(ledger).entries[key].reason, 'self-overlap');
    assert.equal(Object.hasOwn(readLedgerSnapshot(ledger).totals.request.components, 'output'), false);
    assert.equal(result.status, 'conflict');
  });
});

test('two parents naming one child still sum and record parent-contradiction', () => {
  const childId = identity({ sourceId: 'child' });
  const aId = identity({ sourceId: 'parent-a' });
  const bId = identity({ sourceId: 'parent-b' });
  const childKey = ledgerKey(childId);
  const aKey = ledgerKey(aId);
  const bKey = ledgerKey(bId);
  const totals = deriveTotals({
    [aKey]: confirmedEntry(aId, { output: known(100) }, { relation: 'contains-child', peerKey: childKey }),
    [bKey]: confirmedEntry(bId, { output: known(50) }, { relation: 'contains-child', peerKey: childKey }),
    [childKey]: confirmedEntry(childId, { output: known(30) }),
  });
  assert.equal(totals.request.components.output.value, 150);
  assert.deepEqual(totals.request.excluded, [{ key: childKey, reason: 'parent-declared' }]);
  assert.deepEqual(totals.request.conflicts, [{ reason: 'parent-contradiction', keys: [aKey, bKey] }]);
});

test('provisional entries are listed and not summed; confirmed twins still sum', () => {
  const aId = identity({ sourceId: 'a' });
  const bId = identity({ sourceId: 'b' });
  const aKey = ledgerKey(aId);
  const bKey = ledgerKey(bId);
  const a = confirmedEntry(aId, { output: known(10) });
  const b = confirmedEntry(bId, { output: known(10) });
  const provisional = deriveTotals({
    [aKey]: { ...a, status: /** @type {const} */ ('provisional') },
    [bKey]: { ...b, status: /** @type {const} */ ('provisional') },
  });
  assert.equal(Object.hasOwn(provisional.request.components, 'output'), false);
  assert.equal(provisional.request.provisional.length, 2);
  assert.deepEqual(provisional.request.provisional.map((row) => row.key).sort(), [aKey, bKey].sort());
  const confirmed = deriveTotals({ [aKey]: a, [bKey]: b });
  assert.equal(confirmed.request.components.output.value, 20);
  assert.deepEqual(confirmed.request.provisional, []);
});

test('observedAt, model and sourceReportedCost persist, survive replace and restart, and stay out of the digest', async () => {
  await withLedger(async (ledger, root) => {
    const id = identity({ sourceId: 'retain', revision: 1, finality: 'revision' });
    const firstUsage = usage({ output: known(100) });
    await commitLedgerEvent(ledger, {
      record: {
        identity: id, observedAt: OBSERVED, model: 'gpt-5.4',
        usage: firstUsage,
        sourceReportedCost: { state: 'known', amount: 42, unit: 'usd-ticks' },
      },
      ingest: ingest(1),
    });
    const stored = readLedgerSnapshot(ledger).entries[ledgerKey(id)];
    assert.equal(stored.observedAt, OBSERVED);
    assert.equal(stored.model, 'gpt-5.4');
    assert.deepEqual(stored.sourceReportedCost, { state: 'known', amount: 42, unit: 'usd-ticks' });
    assert.equal(stored.digest, fingerprintRecord(id, firstUsage));

    await commitLedgerEvent(ledger, {
      record: {
        identity: { ...id, revision: 2 },
        observedAt: '2026-09-07T10:00:00.000Z',
        model: 'gpt-5.4-mini',
        usage: usage({ output: known(80) }),
        sourceReportedCost: { state: 'known', amount: 30, unit: 'usd-ticks' },
      },
      ingest: ingest(2),
    });
    const replaced = readLedgerSnapshot(ledger).entries[ledgerKey(id)];
    assert.equal(replaced.observedAt, '2026-09-07T10:00:00.000Z');
    assert.equal(replaced.model, 'gpt-5.4-mini');
    assert.equal(replaced.sourceReportedCost?.amount, 30);
    assert.equal(replaced.usage.components.output.value, 80);

    await closeSessionLedger(ledger);
    const reopened = await openSessionLedger({ root, limits: { maxBytes: 256_000, maxEntries: 64 } });
    try {
      const again = readLedgerSnapshot(reopened).entries[ledgerKey(id)];
      assert.equal(again.observedAt, '2026-09-07T10:00:00.000Z');
      assert.equal(again.model, 'gpt-5.4-mini');
      assert.equal(again.sourceReportedCost?.unit, 'usd-ticks');
    } finally {
      await closeSessionLedger(reopened);
    }
  });
});

test('a cumulative reset replaces retained fields from the new record', async () => {
  await withLedger(async (ledger) => {
    const id = identity({ sourceId: 'snap', sourceUnit: 'cumulative-snapshot' });
    await commitLedgerEvent(ledger, {
      record: {
        identity: id, observedAt: OBSERVED, model: 'old-model',
        usage: usage({ output: known(100) }),
        sourceReportedCost: { state: 'known', amount: 9, unit: 'usd-ticks' },
      },
      ingest: ingest(1),
    });
    await commitLedgerEvent(ledger, {
      record: {
        identity: id, observedAt: '2026-09-07T11:00:00.000Z', model: 'new-model',
        usage: usage({ output: known(10) }),
        sourceReportedCost: { state: 'known', amount: 1, unit: 'usd-ticks' },
      },
      ingest: ingest(2, 2),
      reset: true,
    });
    const stored = readLedgerSnapshot(ledger).entries[ledgerKey(id)];
    assert.equal(stored.observedAt, '2026-09-07T11:00:00.000Z');
    assert.equal(stored.model, 'new-model');
    assert.equal(stored.sourceReportedCost?.amount, 1);
  });
});

test('an old entry without retained fields opens with those fields absent, never invented', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agora-ledger-'));
  const id = identity({ sourceId: 'legacy' });
  const key = ledgerKey(id);
  await writeFile(path.join(root, 'state.json'), JSON.stringify({
    version: 1,
    ledgerGeneration: 1,
    ingest: null,
    entries: {
      [key]: {
        status: 'confirmed',
        identity: id,
        usage: usage({ output: known(10) }),
        digest: 'sha256:legacy',
      },
    },
    gaps: [],
  }), 'utf8');
  const ledger = await openSessionLedger({ root, limits: { maxBytes: 256_000, maxEntries: 64 } });
  try {
    const entry = readLedgerSnapshot(ledger).entries[key];
    assert.equal(Object.hasOwn(entry, 'observedAt'), false);
    assert.equal(Object.hasOwn(entry, 'model'), false);
    assert.equal(Object.hasOwn(entry, 'sourceReportedCost'), false);
  } finally {
    await closeSessionLedger(ledger);
  }
});
