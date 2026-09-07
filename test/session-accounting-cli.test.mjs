// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { closeSessionLedger, commitLedgerEvent, openSessionLedger } from '../src/usage/session-ledger.mjs';

const bin = fileURLToPath(new URL('../bin/agora.mjs', import.meta.url));
const OBSERVED = '2026-09-07T10:00:00.000Z';

/** @param {string[]} args @param {NodeJS.ProcessEnv} env */
function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], {
      env: { ...process.env, ...env, AGORA_SESSION: 'cli-test', AGORA_ACTOR: 'Test/cli' },
      windowsHide: true,
    });
    child.stdin.end();
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('usage-sessions requires --ledger-root', async () => {
  const r = await run(['usage-sessions', '--json'], {});
  assert.equal(r.code, 2);
  assert.match(r.stderr, /ledger-root/);
  assert.equal(r.stdout, '');
});

test('cli json lists measured and unsupported together and never prints a transcript', async () => {
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'agora-st-'));
  const sess = path.join(stateRoot, 'sessions', 'sess-a');
  await mkdir(sess, { recursive: true });
  await writeFile(path.join(sess, 'house.cursor'), '0', 'utf8');
  await writeFile(path.join(sess, 'session.json'), JSON.stringify({
    bearer: 'Codex/a', pid: process.pid, lastSeen: new Date().toISOString(),
  }), 'utf8');
  const ledgerRoot = await mkdtemp(path.join(tmpdir(), 'agora-led-'));
  const ledger = await openSessionLedger({ root: ledgerRoot, limits: { maxBytes: 256_000, maxEntries: 64 } });
  await commitLedgerEvent(ledger, {
    record: {
      identity: { harness: 'codex', sessionEpoch: 'epoch-1', sourceId: 'req-a', sourceUnit: 'request', finality: 'final', revision: 1 },
      observedAt: OBSERVED,
      usage: { components: { output: { state: 'known', value: 80, unit: 'tokens' } }, coverage: 'partial' },
    },
    ingest: { locator: 'f', sourceGeneration: 1, offset: 1, fingerprint: 'fp:1' },
  });
  await closeSessionLedger(ledger);
  const bind = path.join(stateRoot, 'bind.json');
  await writeFile(bind, JSON.stringify({ 'sess-a': { harness: 'codex', sessionEpoch: 'epoch-1', sourceId: 'req-a' } }), 'utf8');
  const cfg = path.join(stateRoot, 'agora.json');
  await writeFile(cfg, JSON.stringify({ actor: { name: 'Test/cli', kind: 'agent' }, rooms: { house: { transport: 'local', path: 'house.ndjson' } } }), 'utf8');
  const r = await run(
    ['usage-sessions', '--json', '--ledger-root', ledgerRoot, '--bind', bind, '--room', 'house'],
    { AGORA_STATE: stateRoot, AGORA_CONFIG: cfg },
  );
  assert.equal(r.code, 0, r.stderr);
  const body = JSON.parse(r.stdout);
  assert.equal(body.type, 'usage-sessions');
  assert.equal(body.members.length, 1);
  assert.equal(body.members[0].state, 'measured');
  assert.equal(body.members[0].usage.components.output.value, 80);
  assert.doesNotMatch(r.stdout, /transcript|Authorization|Bearer /);
});

test('SIGINT cell is skipped on win32 where process.kill is TerminateProcess', { skip: process.platform === 'win32' }, async () => {
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'agora-st-'));
  await mkdir(path.join(stateRoot, 'sessions'), { recursive: true });
  const ledgerRoot = await mkdtemp(path.join(tmpdir(), 'agora-led-'));
  const ledger = await openSessionLedger({ root: ledgerRoot, limits: { maxBytes: 256_000, maxEntries: 64 } });
  await closeSessionLedger(ledger);
  const cfg = path.join(stateRoot, 'agora.json');
  await writeFile(cfg, JSON.stringify({ actor: { name: 'Test/cli', kind: 'agent' }, rooms: { house: { transport: 'local', path: 'house.ndjson' } } }), 'utf8');
  const child = spawn(process.execPath, [bin, 'usage-sessions', '--follow', '--interval', '1', '--for', '30', '--ledger-root', ledgerRoot, '--json'], {
    env: { ...process.env, AGORA_STATE: stateRoot, AGORA_CONFIG: cfg, AGORA_SESSION: 'cli-test' },
    windowsHide: true,
  });
  child.stdin.end();
  await new Promise((r) => setTimeout(r, 200));
  child.kill('SIGINT');
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 1);
});
