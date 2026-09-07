// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  collectUsageSessions, formatInventory, ingestJsonl, inventoryMembers, publicRow, readBinding, runUsageSessions,
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
  assert.throws(() => readBinding({ harness: ' ', sessionEpoch: 'e', sourceId: 's' }), /binding requires/);
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
    assert.equal(rows[0].status, 'confirmed');
    assert.equal(/** @type {any} */ (rows[0].usage).components.output.value, 80);
    assert.equal(rows[1].state, 'unsupported');
    assert.equal(rows[1].status, undefined);
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

const EPOCH = 'session-epoch-synthetic-e1d-01';
const OBSERVED_ISO = '2026-09-07T10:00:00.000Z';

function claudeLine() {
  return JSON.stringify({
    harness: 'claude-code',
    sessionEpoch: EPOCH,
    envelope: {
      timestamp: OBSERVED_ISO,
      message: {
        id: 'msg_synthetic_claude_01',
        model: 'claude-opus-4-6',
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 40,
          cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 5 },
        },
      },
    },
  });
}

test('four harness envelopes ingest; a failed decode is not stored as overlap none', async () => {
  const ledgerRoot = await mkdtemp(path.join(tmpdir(), 'agora-led-'));
  const ledger = await openSessionLedger({ root: ledgerRoot, limits: { maxBytes: 256_000, maxEntries: 64 } });
  try {
    const jsonl = [
      claudeLine(),
      JSON.stringify({
        harness: 'omp',
        sessionEpoch: EPOCH,
        envelope: {
          timestamp: OBSERVED_ISO,
          message: { id: 'msg_synthetic_omp_01', model: 'gpt-5.4', usage: { input: 80, output: 9, cacheRead: 30, cacheWrite: 20, cttl: { ephemeral5m: 12, ephemeral1h: 8 } } },
        },
      }),
      JSON.stringify({
        harness: 'codex',
        sessionEpoch: EPOCH,
        envelope: {
          type: 'event_msg',
          timestamp: OBSERVED_ISO,
          payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 90, cached_input_tokens: 40, cache_write_input_tokens: 10, output_tokens: 7 } } },
        },
        context: { sourceId: 'rollout:offset:12', observedAt: OBSERVED_ISO },
      }),
      JSON.stringify({
        harness: 'amore-build',
        sessionEpoch: EPOCH,
        envelope: {
          timestamp: OBSERVED_ISO,
          params: {
            sessionId: 'sess_synthetic_amore_01',
            update: {
              sessionUpdate: 'turn_completed',
              prompt_id: 'prompt_synthetic_01',
              usage: { modelUsage: { 'grok-4.6': { inputTokens: 120, outputTokens: 30, cachedReadTokens: 50, cacheCreationTokens: 10 } } },
            },
          },
        },
      }),
      JSON.stringify({ harness: 'other', sessionEpoch: EPOCH, envelope: {} }),
    ].join('\n');
    const outcomes = await ingestJsonl(ledger, jsonl);
    assert.equal(outcomes.filter((o) => /** @type {{status?:string}} */ (o).status === 'ingested').length, 4);
    assert.equal(outcomes.some((o) => /** @type {{code?:string}} */ (o).code === 'session-source-harness-unknown'), true);
    const snap = (await import('../src/usage/session-ledger.mjs')).readLedgerSnapshot(ledger);
    assert.equal(Object.values(snap.entries).some((e) => e.usage?.overlap?.relation === 'none' && e.identity?.harness === 'other'), false);
    const dir = await mkdtemp(path.join(tmpdir(), 'agora-s-'));
    await writeFile(path.join(dir, 'house.cursor'), '0', 'utf8');
    const rows = await inventoryMembers(
      [
        { slug: 'claude', dir, record: { bearer: 'Opus/a' }, state: 'live' },
        { slug: 'codex', dir, record: { bearer: 'Codex/a' }, state: 'live' },
        { slug: 'amore', dir, record: { bearer: 'Grok/a' }, state: 'live' },
      ],
      {
        roomKey: 'house',
        bindings: {
          claude: { harness: 'claude-code', sessionEpoch: EPOCH, sourceId: 'msg_synthetic_claude_01' },
          codex: { harness: 'codex', sessionEpoch: EPOCH, sourceId: 'rollout:offset:12' },
          amore: { harness: 'amore-build', sessionEpoch: EPOCH, sourceId: 'prompt_synthetic_01:grok-4.6' },
        },
        snapshot: snap,
      },
    );
    assert.equal(rows.every((r) => r.state === 'measured'), true);
    assert.equal(rows.every((r) => r.status === 'confirmed' || r.status === 'provisional'), true);
    assert.equal(rows.some((r) => r.status === 'provisional'), true);
    assert.equal(/** @type {any} */ (rows[0].usage).components.output.value, 20);
    assert.equal(/** @type {any} */ (rows[1].usage).components.output.value, 7);
    assert.equal(/** @type {any} */ (rows[2].usage).components.output.value, 30);
  } finally {
    await closeSessionLedger(ledger);
  }
});

test('replay ingest is a duplicate and a kill mid-commit leaves the prior contribution', async () => {
  const ledgerRoot = await mkdtemp(path.join(tmpdir(), 'agora-led-'));
  const ledger = await openSessionLedger({ root: ledgerRoot, limits: { maxBytes: 256_000, maxEntries: 64 } });
  try {
    const once = await ingestJsonl(ledger, claudeLine());
    assert.equal(/** @type {any} */ (once[0]).committed[0].action, 'accept');
    const again = await ingestJsonl(ledger, claudeLine());
    assert.equal(/** @type {any} */ (again[0]).committed[0].action, 'duplicate');
    const { readLedgerSnapshot } = await import('../src/usage/session-ledger.mjs');
    assert.equal(Object.keys(readLedgerSnapshot(ledger).entries).length, 1);
    ledger.io.writeAtomic = async () => { throw new Error('injected'); };
    await assert.rejects(() => ingestJsonl(ledger, JSON.stringify({
      harness: 'omp',
      sessionEpoch: EPOCH,
      envelope: {
        timestamp: OBSERVED_ISO,
        message: { id: 'msg_synthetic_omp_02', model: 'gpt-5.4', usage: { input: 1, output: 1 } },
      },
    })));
    assert.equal(Object.keys(readLedgerSnapshot(ledger).entries).length, 1);
  } finally {
    await closeSessionLedger(ledger);
  }
});

test('ingest outcomes are counted; follow re-reads and tails past the persisted offset', async () => {
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'agora-st-'));
  await mkdir(path.join(stateRoot, 'sessions'), { recursive: true });
  const ledgerRoot = await mkdtemp(path.join(tmpdir(), 'agora-led-'));
  const ingestPath = path.join(stateRoot, 'ingest.jsonl');
  const good = claudeLine();
  await writeFile(ingestPath, `${good}\nnot-json\n${JSON.stringify({ harness: 'other', sessionEpoch: EPOCH, envelope: {} })}\n`, 'utf8');
  const first = await collectUsageSessions({
    stateRoot, ledgerRoot, bindings: {}, ingestPath, ingestLocator: ingestPath,
  });
  assert.ok(first.ingest);
  assert.equal(first.ingest.ingested, 1);
  assert.equal(first.ingest.malformed, 1);
  assert.equal(first.ingest.unsupported, 1);
  assert.deepEqual(first.ingest.failedOffsets, [2, 3]);
  const json = formatInventory(first.rows, { json: true, ingest: first.ingest });
  assert.match(json, /"malformed":1/);
  assert.match(json, /"unsupported":1/);

  const omp = JSON.stringify({
    harness: 'omp',
    sessionEpoch: EPOCH,
    envelope: {
      timestamp: OBSERVED_ISO,
      message: { id: 'msg_synthetic_omp_grow', model: 'gpt-5.4', usage: { input: 1, output: 2 } },
    },
  });
  await writeFile(ingestPath, `${good}\n${omp}\n`, 'utf8');
  const grown = await collectUsageSessions({
    stateRoot, ledgerRoot, bindings: {}, ingestPath, ingestLocator: ingestPath,
  });
  assert.equal(grown.ingest?.ingested, 1);
  assert.equal(grown.ingest?.duplicate, 0);
  const { readLedgerSnapshot, openSessionLedger, closeSessionLedger: close } = await import('../src/usage/session-ledger.mjs');
  const led = await openSessionLedger({ root: ledgerRoot, limits: { maxBytes: 256_000, maxEntries: 64 } });
  try {
    assert.equal(Object.keys(readLedgerSnapshot(led).entries).length, 2);
    assert.equal(readLedgerSnapshot(led).ingest?.offset, 2);
  } finally {
    await close(led);
  }

  await writeFile(ingestPath, `${omp}\n`, 'utf8');
  const shrunk = await collectUsageSessions({
    stateRoot, ledgerRoot, bindings: {}, ingestPath, ingestLocator: ingestPath,
  });
  assert.equal(shrunk.ingest?.duplicate, 1);
});
