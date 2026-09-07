// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  collectUsageSessions, formatInventory, inventoryMembers, publicRow, readBinding, runUsageSessions,
} from '../src/session-accounting.mjs';
import { closeSessionLedger, commitLedgerEvent, openSessionLedger } from '../src/usage/session-ledger.mjs';

const OBSERVED = '2026-09-07T10:00:00.000Z';
const known = (/** @type {number} */ n) => ({ state: /** @type {const} */ ('known'), value: n, unit: /** @type {const} */ ('tokens') });

/** @param {string} sourceId @param {number} output */
function usageRecord(sourceId, output) {
  return {
    identity: { harness: 'codex', sessionEpoch: 'epoch-1', sourceId, sourceUnit: 'request', finality: 'final', revision: 1 },
    observedAt: OBSERVED,
    usage: { components: { output: known(output) }, coverage: 'partial' },
  };
}

/** @param {number} offset */
function ingest(offset) {
  return { locator: 'fixture.jsonl', sourceGeneration: 1, offset, fingerprint: `fp:${offset}` };
}

test('pid and bootEpoch are refused as a source binding', () => {
  assert.throws(() => readBinding({ harness: 'codex', sessionEpoch: 'e', sourceId: 's', pid: 12 }), /not a source binding/);
  assert.throws(() => readBinding({ harness: 'codex', sessionEpoch: 'e', sourceId: 's', bootEpoch: 'x' }), /not a source binding/);
  const ok = readBinding({ harness: 'codex', sessionEpoch: 'e', sourceId: 's' });
  assert.equal(ok.sourceId, 's');
});

test('measured and unsupported members are shown together; missing is never zero', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agora-acc-'));
  const measuredDir = path.join(root, 'sessions', 'sess-a');
  const unboundDir = path.join(root, 'sessions', 'sess-b');
  await mkdir(measuredDir, { recursive: true });
  await mkdir(unboundDir, { recursive: true });
  await writeFile(path.join(measuredDir, 'house.cursor'), '0', 'utf8');
  await writeFile(path.join(unboundDir, 'house.cursor'), '0', 'utf8');
  const records = [
    { slug: 'sess-a', dir: measuredDir, record: { bearer: 'Codex/a' }, state: 'live' },
    { slug: 'sess-b', dir: unboundDir, record: { bearer: 'Opus/b' }, state: 'live' },
  ];
  const ledgerRoot = await mkdtemp(path.join(tmpdir(), 'agora-led-'));
  const ledger = await openSessionLedger({ root: ledgerRoot, limits: { maxBytes: 256_000, maxEntries: 64 } });
  try {
    await commitLedgerEvent(ledger, { record: usageRecord('req-a', 80), ingest: ingest(1) });
    const snapshot = { entries: (await import('../src/usage/session-ledger.mjs')).readLedgerSnapshot(ledger).entries };
    const rows = await inventoryMembers(records, {
      roomKey: 'house',
      bindings: { 'sess-a': { harness: 'codex', sessionEpoch: 'epoch-1', sourceId: 'req-a' } },
      snapshot,
    });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].state, 'measured');
    assert.equal(/** @type {any} */ (rows[0].usage).components.output.value, 80);
    assert.equal(rows[1].state, 'unsupported');
    assert.equal(rows[1].reason, 'unknown-binding');
    const text = formatInventory(rows, {});
    assert.match(text, /measured/);
    assert.match(text, /unsupported unknown-binding/);
    assert.doesNotMatch(text, /unsupported 0/);
    const pub = publicRow(rows[1]);
    assert.equal(Object.hasOwn(pub, 'usage'), false);
  } finally {
    await closeSessionLedger(ledger);
  }
});

test('lowering-output 100 to 80 is what the inventory reports', async () => {
  const ledgerRoot = await mkdtemp(path.join(tmpdir(), 'agora-led-'));
  const ledger = await openSessionLedger({ root: ledgerRoot, limits: { maxBytes: 256_000, maxEntries: 64 } });
  try {
    const first = usageRecord('req-a', 100);
    await commitLedgerEvent(ledger, { record: first, ingest: ingest(1) });
    const second = {
      identity: { ...first.identity, finality: 'revision', revision: 2 },
      observedAt: OBSERVED,
      usage: { components: { output: known(80) }, coverage: 'partial' },
    };
    await commitLedgerEvent(ledger, { record: second, ingest: ingest(2) });
    const { readLedgerSnapshot } = await import('../src/usage/session-ledger.mjs');
    const snapshot = readLedgerSnapshot(ledger);
    const dir = await mkdtemp(path.join(tmpdir(), 'agora-s-'));
    await writeFile(path.join(dir, 'house.cursor'), '0', 'utf8');
    const rows = await inventoryMembers(
      [{ slug: 'sess-a', dir, record: { bearer: 'Codex/a' }, state: 'live' }],
      { roomKey: 'house', bindings: { 'sess-a': { harness: 'codex', sessionEpoch: 'epoch-1', sourceId: 'req-a' } }, snapshot },
    );
    assert.equal(rows[0].state, 'measured');
    assert.equal(/** @type {any} */ (rows[0].usage).components.output.value, 80);
  } finally {
    await closeSessionLedger(ledger);
  }
});

test('follow cancels via AbortController and does not emit a zero inventory', async () => {
  const ac = new AbortController();
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'agora-st-'));
  await mkdir(path.join(stateRoot, 'sessions'), { recursive: true });
  const ledgerRoot = await mkdtemp(path.join(tmpdir(), 'agora-led-'));
  const ledger = await openSessionLedger({ root: ledgerRoot, limits: { maxBytes: 256_000, maxEntries: 64 } });
  await closeSessionLedger(ledger);
  const chunks = /** @type {string[]} */ ([]);
  setTimeout(() => ac.abort(), 30);
  await assert.rejects(
    () => runUsageSessions({
      stateRoot, ledgerRoot, bindings: {}, json: true, follow: true, intervalMs: 20, forMs: 5000, signal: ac.signal,
      write: (t) => { chunks.push(t); },
    }),
    (/** @type {any} */ err) => err.code === 'session-accounting-cancelled',
  );
  assert.equal(chunks.join('').includes('"output":0'), false);
});
