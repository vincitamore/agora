// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { collectCodexUsage, normalizeRateLimitsResponse, resetsAtToIso, windowsFromSnapshot } from '../src/usage/codex.mjs';
import { windowKey, windowFreshness } from '../src/protocol/usage.mjs';

// Synthetic throughout: no live account, no credential, no real process. These fixtures
// establish the mapping and the process boundary, never live authorization.
const POOL = 'pool_synthetic_codex_001';
const PRODUCER = { producerId: 'producer_synthetic_0001', generation: 1, sequence: 1 };
const NOW = () => new Date('2026-09-06T22:45:00.000Z');
const ctx = { poolId: POOL, capturedAt: '2026-09-06T22:45:00.000Z', producer: PRODUCER };

const win = (/** @type {number} */ usedPercent, /** @type {number|null} */ mins, /** @type {number|null} */ resetsAt) =>
  ({ usedPercent, windowDurationMins: mins, resetsAt });

/** A fake app-server: replies to `initialize`, then to whatever the collector asks. */
function fakeSpawn(/** @type {(msg: any, reply: (frame: object) => void, child: any) => void} */ script) {
  return () => {
    const child = /** @type {any} */ (new EventEmitter());
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    /** @type {any} */ (child.stdout).setEncoding = () => {};
    /** @type {any} */ (child.stderr).resume = () => {};
    child.killed = false;
    child.kill = () => { child.killed = true; return true; };
    child.stdin = { write: (/** @type {string} */ line) => {
      const msg = JSON.parse(line);
      queueMicrotask(() => script(msg, (/** @type {object} */ frame) => child.stdout.emit('data', `${JSON.stringify(frame)}\n`), child));
      return true;
    } };
    return child;
  };
}

const resolveBinary = async () => 'C:/synthetic/codex.exe';

/** The measured shape: a multi-bucket map, one bucket carrying BOTH window slots. */
const twoSlotResponse = {
  accountId: 'account-synthetic-0001',
  rateLimits: { limitId: 'codex', limitName: 'Codex', primary: win(8, 10080, 1789269881), secondary: null, credits: null, individualLimit: null, spendControlReached: false, planType: 'pro', rateLimitReachedType: null },
  rateLimitsByLimitId: {
    codex: { limitId: 'codex', limitName: 'Codex', primary: win(8, 10080, 1789269881), secondary: null, credits: null, individualLimit: null, spendControlReached: false, planType: 'pro', rateLimitReachedType: null },
    codex_bengalfox: { limitId: 'codex_bengalfox', limitName: 'Bengalfox', primary: win(0, 300, 1788744995), secondary: win(0, 10080, 1789077087), credits: null, individualLimit: null, spendControlReached: null, planType: null, rateLimitReachedType: null },
  },
  rateLimitResetCredits: null, rateLimitUpsell: null,
};

test('two window slots under one limit id become two distinct windows', () => {
  const result = normalizeRateLimitsResponse(twoSlotResponse, ctx);
  assert.equal(result.status, 'supported');
  if (result.status !== 'supported') return;
  const keys = result.observation.windows.map((w) => windowKey(w.window));
  // codex/primary, bengalfox/primary, bengalfox/secondary — three windows, no collision.
  assert.equal(result.observation.windows.length, 3);
  assert.equal(new Set(keys).size, 3);
  // The provider's limit id is preserved untouched; the slot is the scope.
  const bengal = result.observation.windows.filter((w) => w.window.limitId === 'codex_bengalfox');
  assert.equal(bengal.length, 2);
  assert.deepEqual(bengal.map((w) => w.window.scope).sort(), ['primary', 'secondary']);
  assert.deepEqual(bengal.map((w) => w.window.durationMinutes).sort((a, b) => Number(a) - Number(b)), [300, 10080]);
});

test('the authoritative map wins and the legacy summary adds no duplicate bucket', () => {
  const result = normalizeRateLimitsResponse(twoSlotResponse, ctx);
  assert.equal(result.status, 'supported');
  if (result.status !== 'supported') return;
  // `rateLimits` mirrors the `codex` bucket. It must not appear twice.
  const codexWindows = result.observation.windows.filter((w) => w.window.limitId === 'codex');
  assert.equal(codexWindows.length, 1);
  // With no map at all, the legacy summary is the only source and IS used.
  const legacyOnly = normalizeRateLimitsResponse({ ...twoSlotResponse, rateLimitsByLimitId: null }, ctx);
  assert.equal(legacyOnly.status, 'supported');
  if (legacyOnly.status !== 'supported') return;
  assert.equal(legacyOnly.observation.windows.length, 1);
  assert.equal(legacyOnly.observation.windows[0].window.limitId, 'codex');
});

test('percentages convert through the contract and sense is used', () => {
  const result = normalizeRateLimitsResponse(twoSlotResponse, ctx);
  if (result.status !== 'supported') return assert.fail('expected supported');
  const codex = result.observation.windows.find((w) => w.window.limitId === 'codex');
  assert.ok(codex && codex.available);
  if (!codex || !codex.available) return;
  assert.equal(codex.value, 800, '8 percent is 800 basis points');
  assert.equal(codex.sense, 'used');
  assert.equal(codex.window.unit, 'basis-points');
});

test('a percentage the unit cannot carry is reported unavailable, never rounded or dropped', () => {
  const readings = windowsFromSnapshot({ limitId: 'x', primary: win(21.000000001, 60, null), secondary: null }, 'x');
  assert.equal(readings.length, 1, 'the window is retained, not discarded');
  assert.equal(readings[0].available, false);
  assert.equal(readings[0].code, 'unsupported-precision');
});

test('a null reset time leaves no reset metadata, so freshness is unknown not fresh', () => {
  const readings = windowsFromSnapshot({ limitId: 'x', primary: win(5, 60, null), secondary: null }, 'x');
  assert.equal(Object.hasOwn(readings[0], 'resetsAt'), false);
  assert.equal(windowFreshness(readings[0], '2027-01-01T00:00:00.000Z'), 'unknown');
  // A real reset time still discriminates.
  const withReset = windowsFromSnapshot({ limitId: 'x', primary: win(5, 60, 1789269881), secondary: null }, 'x');
  assert.equal(windowFreshness(withReset[0], '2026-09-06T22:45:00.000Z'), 'fresh');
});

test('epoch seconds convert, and a nonsense reset value yields no metadata rather than a wrong instant', () => {
  assert.equal(resetsAtToIso(1789269881), '2026-09-13T03:24:41.000Z');
  assert.equal(resetsAtToIso(null), undefined);
  assert.equal(resetsAtToIso(Number.POSITIVE_INFINITY), undefined);
  assert.equal(resetsAtToIso(1e18), undefined);
});

test('a null accountId is identity-unavailable, never an invented principal', () => {
  const result = normalizeRateLimitsResponse({ ...twoSlotResponse, accountId: null }, ctx);
  if (result.status === 'supported') return assert.fail('expected unsupported');
  assert.equal(result.status, 'unsupported');
  assert.equal(result.code, 'codex-account-identity-unavailable');
});

test('a response with no represented window is unsupported, not an empty observation', () => {
  const result = normalizeRateLimitsResponse({ accountId: 'a-1', rateLimits: null, rateLimitsByLimitId: null, rateLimitResetCredits: null, rateLimitUpsell: null }, ctx);
  if (result.status === 'supported') return assert.fail('expected unsupported');
  assert.equal(result.status, 'unsupported');
  assert.equal(result.code, 'codex-no-quota-reported');
});

test('the collector reads through the public path and returns a cooperative harness observation', async () => {
  const spawn = fakeSpawn((/** @type {any} */ msg, /** @type {any} */ reply) => {
    if (msg.method === 'initialize') return reply({ jsonrpc: '2.0', id: msg.id, result: {} });
    if (msg.method === 'account/rateLimits/read') return reply({ jsonrpc: '2.0', id: msg.id, result: twoSlotResponse });
  });
  const result = await collectCodexUsage({ poolId: POOL, producer: PRODUCER, now: NOW, spawn, resolveBinary });
  assert.equal(result.status, 'supported');
  if (result.status !== 'supported') return;
  assert.equal(result.observation.source, 'harness');
  assert.equal(result.observation.attestation, 'cooperative', 'the collector never concludes enforced');
  assert.equal(Object.hasOwn(result.observation, 'attestor'), false, 'no fabricated attestor');
  assert.equal(result.principal.principalRef, 'account-synthetic-0001');
  assert.equal(result.principal.identity, 'unverified');
});

test('a sparse notification before the full reply does not finish the request', async () => {
  const spawn = fakeSpawn((/** @type {any} */ msg, /** @type {any} */ reply) => {
    if (msg.method === 'initialize') return reply({ jsonrpc: '2.0', id: msg.id, result: {} });
    if (msg.method === 'account/rateLimits/read') {
      // A rate-limits notification carries no id. It must be ignored entirely.
      reply({ jsonrpc: '2.0', method: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'codex', primary: win(99, 10080, null), secondary: null } } });
      reply({ jsonrpc: '2.0', id: msg.id, result: twoSlotResponse });
    }
  });
  const result = await collectCodexUsage({ poolId: POOL, producer: PRODUCER, now: NOW, spawn, resolveBinary });
  assert.equal(result.status, 'supported');
  if (result.status !== 'supported') return;
  const codex = result.observation.windows.find((w) => w.window.limitId === 'codex');
  assert.ok(codex && codex.available && codex.value === 800, 'the full read won, not the sparse frame');
});

test('a reply carrying another request id is ignored', async () => {
  const spawn = fakeSpawn((/** @type {any} */ msg, /** @type {any} */ reply) => {
    if (msg.method === 'initialize') return reply({ jsonrpc: '2.0', id: msg.id, result: {} });
    if (msg.method === 'account/rateLimits/read') {
      reply({ jsonrpc: '2.0', id: 9999, result: { accountId: 'wrong', rateLimits: null, rateLimitsByLimitId: null } });
      reply({ jsonrpc: '2.0', id: msg.id, result: twoSlotResponse });
    }
  });
  const result = await collectCodexUsage({ poolId: POOL, producer: PRODUCER, now: NOW, spawn, resolveBinary });
  assert.equal(result.status, 'supported');
  if (result.status !== 'supported') return;
  assert.equal(result.principal.principalRef, 'account-synthetic-0001');
});

test('a provider error is a bounded code and never carries the provider body', async () => {
  const spawn = fakeSpawn((/** @type {any} */ msg, /** @type {any} */ reply) => {
    if (msg.method === 'initialize') return reply({ jsonrpc: '2.0', id: msg.id, result: {} });
    if (msg.method === 'account/rateLimits/read') return reply({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'secret provider detail' } });
  });
  const result = await collectCodexUsage({ poolId: POOL, producer: PRODUCER, now: NOW, spawn, resolveBinary });
  if (result.status === 'supported') return assert.fail('expected unsupported');
  assert.equal(result.status, 'unsupported');
  assert.equal(result.code, 'codex-protocol-error');
  assert.equal(JSON.stringify(result).includes('secret provider detail'), false, 'no provider text escapes');
});

test('an early exit before a reply is reported, and only the helper we started is stopped', async () => {
  let killed = false;
  const spawn = fakeSpawn((/** @type {any} */ msg, /** @type {any} */ _reply, /** @type {any} */ child) => {
    if (msg.method === 'initialize') { child.kill = () => { killed = true; return true; }; queueMicrotask(() => child.emit('exit', 1)); }
  });
  const result = await collectCodexUsage({ poolId: POOL, producer: PRODUCER, now: NOW, spawn, resolveBinary });
  if (result.status === 'supported') return assert.fail('expected unsupported');
  assert.equal(result.status, 'unsupported');
  assert.equal(result.code, 'codex-early-exit');
  assert.equal(killed, true, 'the helper this collector started is stopped');
});

test('an absent CLI is unsupported rather than an error, and nothing is spawned', async () => {
  let spawned = false;
  const spawn = () => { spawned = true; throw new Error('should not spawn'); };
  const result = await collectCodexUsage({
    poolId: POOL, producer: PRODUCER, now: NOW, spawn: /** @type {any} */ (spawn),
    resolveBinary: async () => { throw new Error('not installed'); },
  });
  if (result.status === 'supported') return assert.fail('expected unsupported');
  assert.equal(result.status, 'unsupported');
  assert.equal(result.code, 'codex-spawn-failed');
  assert.equal(spawned, false);
});

// --- Bounds: timeout, cancellation, and the process boundary. -----------------
// These three exercise guards that had code and no fixture at the first freeze. Each names
// the failure it demands, so a mutant that breaks the guard reddens THIS test and not merely
// something. The spawner records every child it makes, so "only the helper we started" is
// assertable rather than asserted in prose.

/** A spawner that records its children, so cleanup can be measured rather than described. */
function recordingSpawn(/** @type {(msg: any, reply: (frame: object) => void, child: any) => void} */ script) {
  /** @type {any[]} */
  const children = [];
  const make = fakeSpawn(script);
  const spawn = /** @type {any} */ (() => {
    const child = make();
    children.push(child);
    return child;
  });
  return { spawn, children };
}

/** Answers `initialize` and then goes silent: the read is never answered. */
const answersInitOnly = (/** @type {any} */ msg, /** @type {any} */ reply) => {
  if (msg.method === 'initialize') reply({ id: msg.id, result: { ok: true } });
  // account/rateLimits/read is deliberately never answered.
};

test('a server that never answers the read times out and does not hang', async () => {
  const { spawn, children } = recordingSpawn(answersInitOnly);
  const result = await collectCodexUsage({ poolId: POOL, producer: PRODUCER, now: NOW, spawn, resolveBinary, timeoutMs: 20 });
  if (result.status === 'supported') return assert.fail('expected the read to time out');
  assert.equal(result.status, 'unsupported');
  assert.equal(result.code, 'codex-timeout');
  // The budget is the whole contract here: without it this test would never return.
  assert.equal(children.length, 1);
  assert.equal(children[0].killed, true, 'the helper must be stopped when the budget expires');
});

test('an abort mid-flight is cancelled, not timed out, and stops the helper', async () => {
  const controller = new AbortController();
  const { spawn, children } = recordingSpawn((msg, reply) => {
    if (msg.method === 'initialize') { reply({ id: msg.id, result: { ok: true } }); controller.abort(); }
  });
  const result = await collectCodexUsage({
    poolId: POOL, producer: PRODUCER, now: NOW, spawn, resolveBinary,
    timeoutMs: 60_000, signal: controller.signal,
  });
  if (result.status === 'supported') return assert.fail('expected the read to be cancelled');
  assert.equal(result.status, 'unsupported');
  // Distinguishing cancelled from timeout is the point: a generous budget is still running.
  assert.equal(result.code, 'codex-cancelled');
  assert.equal(children[0].killed, true, 'an aborted read must stop the helper it started');
});

test('a signal already aborted cancels without waiting for the budget', async () => {
  const { spawn, children } = recordingSpawn(answersInitOnly);
  const result = await collectCodexUsage({
    poolId: POOL, producer: PRODUCER, now: NOW, spawn, resolveBinary,
    timeoutMs: 60_000, signal: AbortSignal.abort(),
  });
  if (result.status === 'supported') return assert.fail('expected an immediate cancellation');
  assert.equal(result.code, 'codex-cancelled');
  assert.equal(children[0].killed, true);
});

test('cleanup stops only the helper this call started, never a peer process', async () => {
  // A peer the collector never started: another session's helper, standing in the same host.
  const peer = { killed: false, kill() { this.killed = true; return true; } };
  const { spawn, children } = recordingSpawn(answersInitOnly);
  const result = await collectCodexUsage({ poolId: POOL, producer: PRODUCER, now: NOW, spawn, resolveBinary, timeoutMs: 20 });
  assert.equal(result.status, 'unsupported');
  assert.equal(children.length, 1, 'exactly one helper is started per read');
  assert.equal(children[0].killed, true);
  assert.equal(peer.killed, false, 'a process this collector did not start is never signalled');
});

// --- Integrator HOLD regressions (Astra, house :524), all through the PUBLIC path. --------
// Four defects reproduced here before repair. Each pairs with its discriminating opposite, so
// a fix that collapses the distinction (treating malformed as null, or supplied-empty as
// absent) reddens the pair rather than passing both.

/** A server that completes the handshake and then answers the read with `response`. */
const serves = (/** @type {unknown} */ response) => (/** @type {any} */ msg, /** @type {any} */ reply) => {
  if (msg.method === 'initialize') return reply({ id: msg.id, result: { ok: true } });
  if (msg.method === 'account/rateLimits/read') return reply({ id: msg.id, result: response });
};
const collect = (/** @type {unknown} */ response) => collectCodexUsage({
  poolId: POOL, producer: PRODUCER, now: NOW, spawn: fakeSpawn(serves(response)), resolveBinary, timeoutMs: 2000,
});
const snapOf = (/** @type {string} */ id, /** @type {unknown} */ primary, /** @type {unknown} */ secondary) =>
  ({ limitId: id, limitName: id, primary, secondary, credits: null, individualLimit: null,
     spendControlReached: null, planType: null, rateLimitReachedType: null });

test('HOLD 1: a malformed window slot is represented as unavailable, never dropped', async () => {
  const result = await collect({ accountId: 'a-1', rateLimits: null,
    rateLimitsByLimitId: { codex: snapOf('codex', win(8, 10080, 1789269881), 'malformed') } });
  assert.ok(result.status === 'supported', 'expected a supported reading');
  assert.equal(result.observation.windows.length, 2, 'the malformed slot must still be represented');
  const secondary = result.observation.windows.find((w) => w.window.scope === 'secondary');
  assert.ok(secondary, 'the malformed secondary window is missing entirely');
  assert.equal(secondary.available, false);
  assert.equal(secondary.code, 'unsupported-shape');
});

test('HOLD 1 pair: a schema null slot is absent, which is NOT the malformed case', async () => {
  const result = await collect({ accountId: 'a-1', rateLimits: null,
    rateLimitsByLimitId: { codex: snapOf('codex', win(8, 10080, 1789269881), null) } });
  assert.ok(result.status === 'supported');
  // Exactly one window: null means the provider reports no window, and inventing an
  // unavailable one there would be as wrong as dropping the malformed one above.
  assert.equal(result.observation.windows.length, 1);
  assert.equal(result.observation.windows[0].available, true);
});

test('HOLD 2: a supplied EMPTY map is authoritative and the legacy summary adds nothing', async () => {
  const result = await collect({ accountId: 'a-1',
    rateLimits: snapOf('codex', win(8, 10080, 1789269881), null), rateLimitsByLimitId: {} });
  // The map asserts zero buckets. Falling back to legacy would invent a window the
  // authoritative source says does not exist.
  if (result.status === 'supported') return assert.fail('a supplied empty map must not yield legacy windows');
  assert.equal(result.code, 'codex-no-quota-reported');
});

test('HOLD 2 pair: an ABSENT map does fall back to the legacy summary', async () => {
  const result = await collect({ accountId: 'a-1',
    rateLimits: snapOf('codex', win(8, 10080, 1789269881), null), rateLimitsByLimitId: null });
  assert.ok(result.status === 'supported', 'an absent map must still read the legacy summary');
  assert.equal(result.observation.windows.length, 1);
});

test('HOLD 2b: a supplied map that is not a record is malformed, not a legacy fallback', async () => {
  const result = await collect({ accountId: 'a-1',
    rateLimits: snapOf('codex', win(8, 10080, 1789269881), null), rateLimitsByLimitId: 'junk' });
  if (result.status === 'supported') return assert.fail('a malformed authority must not be downgraded');
  assert.equal(result.code, 'codex-quota-shape-unsupported');
});

test('HOLD 3: a fractional duration is reported unavailable, never truncated into identity', async () => {
  const result = await collect({ accountId: 'a-1', rateLimits: null,
    rateLimitsByLimitId: { codex: snapOf('codex', win(8, 300.9, 1789269881), null) } });
  assert.ok(result.status === 'supported');
  const only = result.observation.windows[0];
  // 300.9 truncated to 300 would silently rename the window and could collide with a real
  // 300-minute window from the same limit id.
  assert.notEqual(only.window.durationMinutes, 300, 'the duration must not be truncated into shape');
  assert.equal(only.window.durationMinutes, undefined);
  assert.equal(only.available, false);
  assert.equal(only.code, 'unsupported-duration');
});

test('HOLD 4: a reply to a request never issued is refused, not accepted as the reading', async () => {
  // The server volunteers a result for the read id before the handshake completes, so the
  // collector has not sent that request. Its id is ours to assign; this is a violation.
  const injecting = (/** @type {any} */ msg, /** @type {any} */ reply) => {
    if (msg.method === 'initialize') reply({ id: 2, result: { accountId: 'a-injected',
      rateLimits: snapOf('codex', win(99, 10080, 1789269881), null), rateLimitsByLimitId: null } });
  };
  const result = await collectCodexUsage({ poolId: POOL, producer: PRODUCER, now: NOW,
    spawn: fakeSpawn(injecting), resolveBinary, timeoutMs: 500 });
  if (result.status === 'supported') return assert.fail('an unsolicited reply was accepted as a reading');
  assert.equal(result.code, 'codex-protocol-error');
});
