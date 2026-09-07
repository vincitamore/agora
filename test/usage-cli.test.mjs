// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseTimeoutMs, formatUsageResult, runUsage, USAGE_CLI_PRODUCER_ID } from '../src/usage-cli.mjs';
import { windowKey, validateCompleteObservation } from '../src/protocol/usage.mjs';

const POOL = 'pool_synthetic_01';
const PRODUCER = { producerId: 'producer_synthetic_0001', generation: 1, sequence: 1 };
const NOW = () => new Date('2026-09-07T04:10:00.000Z');
const bin = fileURLToPath(new URL('../bin/agora.mjs', import.meta.url));

const supported = {
  status: 'supported',
  principal: { poolId: POOL, provider: 'codex', principalRef: 'acct-1', identity: 'unverified' },
  observation: {
    kind: 'full', poolId: POOL, capturedAt: '2026-09-07T04:10:00.000Z',
    source: 'harness', attestation: 'cooperative',
    producer: PRODUCER,
    windows: [
      { window: { limitId: 'codex', unit: 'basis-points', scope: 'primary', durationMinutes: 10080 }, available: true, value: 800, sense: 'used', resetsAt: '2026-09-13T03:24:41.000Z' },
      { window: { limitId: 'codex_bengalfox', unit: 'basis-points', scope: 'primary', durationMinutes: 300 }, available: true, value: 0, sense: 'used', resetsAt: '2026-09-06T14:56:35.000Z' },
      { window: { limitId: 'codex_bengalfox', unit: 'basis-points', scope: 'secondary', durationMinutes: 10080 }, available: true, value: 0, sense: 'used', resetsAt: '2026-09-10T11:11:27.000Z' },
    ],
  },
};

test('parseTimeoutMs refuses non-integer and over-cap', () => {
  assert.equal(parseTimeoutMs(undefined, 15000), 15000);
  assert.equal(parseTimeoutMs('20', 15000), 20);
  assert.throws(() => parseTimeoutMs('20.5', 15000));
  assert.throws(() => parseTimeoutMs('0', 15000));
  assert.throws(() => parseTimeoutMs('60001', 15000));
});

test('unsupported provider is a usage error, not a zero quota', async () => {
  const r = await runUsage({ provider: 'claude', poolId: POOL, now: NOW, collect: async () => supported });
  assert.equal(r.exit, 2);
  assert.match(r.stderr, /unsupported --provider/);
  assert.equal(r.stdout, '');
});

test('missing provider and pool-id are usage errors', async () => {
  const a = await runUsage({ poolId: POOL, now: NOW, collect: async () => supported });
  assert.equal(a.exit, 2);
  const b = await runUsage({ provider: 'codex', now: NOW, collect: async () => supported });
  assert.equal(b.exit, 2);
});

test('JSON stdout is the result only and keeps two slots under one limit id', async () => {
  /** @type {(() => Date) | undefined} */
  let seenNow;
  /** @type {number | undefined} */
  let seenTimeout;
  const r = await runUsage({
    provider: 'codex', poolId: POOL, timeout: '1500', json: true, now: NOW, producer: PRODUCER,
    collect: async (opts) => {
      seenNow = opts.now;
      seenTimeout = opts.timeoutMs;
      return supported;
    },
  });
  assert.equal(r.exit, 0);
  assert.equal(typeof seenNow, 'function');
  assert.equal(seenNow && seenNow().toISOString(), NOW().toISOString());
  assert.equal(seenTimeout, 1500);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.status, 'supported');
  assert.equal(parsed.observation.windows.length, 3);
  const keys = parsed.observation.windows.map((/** @type {{ window: unknown }} */ w) => windowKey(w.window));
  assert.equal(new Set(keys).size, 3);
  assert.equal(r.stdout.includes('Authorization'), false);
});

test('text names original limitId, scope, used sense and labelled percent', async () => {
  const r = await runUsage({ provider: 'codex', poolId: POOL, now: NOW, producer: PRODUCER, collect: async () => supported });
  assert.equal(r.exit, 0);
  assert.match(r.stdout, /codex\/primary 10080m used 800 basis-points \(8\.00%\)/);
  assert.match(r.stdout, /codex_bengalfox\/primary 300m/);
  assert.match(r.stdout, /freshness reset-due/);
});

test('collector unsupported becomes exit 1 with the bounded code', async () => {
  const r = await runUsage({
    provider: 'codex', poolId: POOL, now: NOW, json: true, producer: PRODUCER,
    collect: async () => ({ status: 'unsupported', code: 'codex-account-identity-unavailable' }),
  });
  assert.equal(r.exit, 1);
  assert.equal(JSON.parse(r.stdout).code, 'codex-account-identity-unavailable');
});

test('CLI subprocess: unknown provider is usage exit 2', () => {
  const run = spawnSync(process.execPath, [bin, 'usage', '--provider', 'nope', '--pool-id', POOL], { encoding: 'utf8' });
  assert.equal(run.status, 2);
});

test('CLI subprocess: schema lists usage', () => {
  const run = spawnSync(process.execPath, [bin, 'schema', '--json'], { encoding: 'utf8' });
  assert.equal(run.status, 0);
  const schema = JSON.parse(run.stdout);
  assert.ok(schema.verbs.usage);
  assert.ok(schema.verbs.usage.options['--provider <name>']);
  assert.ok(schema.verbs.usage.options['--timeout <ms>']);
});

test('cut-wire: collect receives timeoutMs and now as separate arguments', async () => {
  /** @type {Record<string, unknown>} */
  let seen = {};
  await runUsage({
    provider: 'codex', poolId: POOL, timeout: '1234', json: true, now: NOW, producer: PRODUCER,
    collect: async (opts) => {
      seen = { hasNow: typeof opts.now === 'function', timeoutMs: opts.timeoutMs, keys: Object.keys(opts).sort() };
      return { status: 'unsupported', code: 'codex-timeout' };
    },
  });
  assert.equal(seen.hasNow, true);
  assert.equal(seen.timeoutMs, 1234);
  assert.equal(Array.isArray(seen.keys) && seen.keys.includes('now') && seen.keys.includes('timeoutMs'), true);
});

test('pre-aborted signal is forwarded to the collector', async () => {
  const signal = AbortSignal.abort();
  let seen;
  const r = await runUsage({
    provider: 'codex', poolId: POOL, now: NOW, producer: PRODUCER, signal,
    collect: async (opts) => {
      seen = opts.signal;
      return { status: 'unsupported', code: 'codex-cancelled' };
    },
  });
  assert.equal(seen, signal);
  assert.equal(r.exit, 1);
  assert.match(r.stdout, /codex-cancelled/);
});

test('default producer identity satisfies the observation contract without an override', async () => {
  assert.ok(USAGE_CLI_PRODUCER_ID.length >= 16 && USAGE_CLI_PRODUCER_ID.length <= 128);
  /** @type {unknown} */
  let seen;
  const r = await runUsage({
    provider: 'codex', poolId: 'pool_synthetic_codex_001', now: NOW,
    collect: async (opts) => {
      seen = opts.producer;
      const observation = validateCompleteObservation({
        kind: 'full', poolId: opts.poolId, capturedAt: '2026-09-07T03:55:00.000Z',
        source: 'harness', attestation: 'cooperative', producer: opts.producer,
        windows: [{ window: { limitId: 'codex', unit: 'basis-points', scope: 'primary', durationMinutes: 10080 },
                    available: true, value: 1500, sense: 'used' }],
      });
      return {
        status: 'supported',
        principal: { poolId: opts.poolId, provider: 'codex', principalRef: 'account-synthetic-0001', identity: 'unverified' },
        observation,
      };
    },
  });
  assert.equal(r.exit, 0, r.stderr);
  assert.equal(/** @type {any} */ (seen)?.producerId, USAGE_CLI_PRODUCER_ID);
  validateCompleteObservation({
    kind: 'full', poolId: 'pool_synthetic_codex_001', capturedAt: '2026-09-07T03:55:00.000Z',
    source: 'harness', attestation: 'cooperative', producer: seen,
    windows: [{ window: { limitId: 'codex', unit: 'basis-points', scope: 'primary', durationMinutes: 10080 },
                available: true, value: 1500, sense: 'used' }],
  });
});

test('CLI subprocess: real collector, default producer, synthetic helper', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agora-n3-usage-'));
  try {
    writeFileSync(path.join(dir, 'agora.json'), JSON.stringify({
      actor: { name: 'n3', kind: 'agent' },
      rooms: { down: { transport: 'local', path: path.join(dir, 'down.ndjson') } },
    }));
    writeFileSync(path.join(dir, 'down.ndjson'), '');
    writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
    const helperSrc = fileURLToPath(new URL('./fixtures/usage/fake-codex-app-server.mjs', import.meta.url));
    writeFileSync(path.join(dir, 'app-server.js'), readFileSync(helperSrc));
    const env = { ...process.env };
    for (const name of [
      'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_PID',
      'GROK_SESSION_ID', 'GROK_PID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID',
      'HERMES_SESSION_ID', 'AGORA_SESSION_PID', 'AGORA_SESSION', 'AGORA_ACTOR',
      'AGORA_CONFIG', 'AGORA_STATE', 'AGORA_CODEX_BIN',
    ]) delete env[name];
    env.AGORA_CONFIG = path.join(dir, 'agora.json');
    env.AGORA_STATE = path.join(dir, 'state');
    env.AGORA_SESSION = 'n3-usage-cli';
    const run = spawnSync(process.execPath, [
      bin, 'usage', '--provider', 'codex', '--pool-id', 'pool_synthetic_codex_001',
      '--json', '--timeout', '8000', '--codex-bin', process.execPath,
    ], { encoding: 'utf8', cwd: dir, env, windowsHide: true, timeout: 15000 });
    assert.equal(run.status, 0, `stderr=${run.stderr}\nstdout=${run.stdout}`);
    const parsed = JSON.parse(run.stdout);
    assert.equal(parsed.status, 'supported');
    assert.equal(parsed.observation.producer.producerId, USAGE_CLI_PRODUCER_ID);
    assert.ok(parsed.observation.producer.producerId.length >= 16);
    const primary = parsed.observation.windows.find((/** @type {{ window: { limitId: string, scope?: string } }} */ w) =>
      w.window.limitId === 'codex' && w.window.scope === 'primary');
    assert.ok(primary && primary.available);
    assert.equal(primary.value, 800);
    assert.equal(run.stdout.includes('Authorization'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
