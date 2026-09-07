// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectClaudeUsage, normalizeUsageAndProfile, windowsFromUsage, resetsAtToIso, CLAUDE_ORIGIN, CLAUDE_LIMITS,
} from '../src/usage/claude.mjs';
import { windowKey, windowFreshness } from '../src/protocol/usage.mjs';

const POOL = 'pool_synthetic_claude01';
const PRODUCER = { producerId: 'producer_synthetic_0001', generation: 1, sequence: 1 };
const NOW = () => new Date('2026-09-07T00:20:00.000Z');
const ctx = { poolId: POOL, capturedAt: '2026-09-07T00:20:00.000Z', producer: PRODUCER };

const ORG = 'org_synthetic_claude_01';
const profile = {
  organization: {
    uuid: ORG,
    organization_type: 'claude_max',
    rate_limit_tier: 'default_claude_max_20x',
  },
};

/** Measured shape plus a restating limits array and a populated scoped weekly. */
const threeWindowUsage = {
  five_hour: { utilization: 21.0, resets_at: '2026-09-07T00:40Z' },
  seven_day: { utilization: 5.0, resets_at: '2026-09-13T17:00Z' },
  seven_day_opus: null,
  seven_day_sonnet: { utilization: 7.0, resets_at: '2026-09-13T17:00Z' },
  extra_usage: { is_enabled: false, spend_limit_reached: false },
  limits: [
    { kind: 'session', percent: 21, resets_at: '2026-09-07T00:40Z', is_active: true },
    { kind: 'weekly_all', percent: 5, resets_at: '2026-09-13T17:00Z', is_active: true },
    { kind: 'weekly_scoped', percent: 7, resets_at: '2026-09-13T17:00Z', is_active: true, scope: { model: { display_name: 'Synthetic Model' } } },
  ],
};

test('three named windows plus a restating limits array become three windows, not six', () => {
  const result = normalizeUsageAndProfile(threeWindowUsage, profile, ctx);
  assert.equal(result.status, 'supported');
  if (result.status !== 'supported') return;
  assert.equal(result.observation.windows.length, 3);
  assert.equal(new Set(result.observation.windows.map((w) => windowKey(w.window))).size, 3);
  const ids = result.observation.windows.map((w) => w.window.limitId).sort();
  assert.deepEqual(ids, ['five_hour', 'seven_day', 'seven_day_sonnet']);
  assert.equal(result.principal.principalRef, ORG);
  assert.equal(result.principal.provider, 'claude');
  assert.equal(result.observation.source, 'harness');
  assert.equal(result.observation.attestation, 'cooperative');
});

test('percentages convert through the contract and sense is used', () => {
  const result = normalizeUsageAndProfile(threeWindowUsage, profile, ctx);
  assert.equal(result.status, 'supported');
  if (result.status !== 'supported') return;
  const five = result.observation.windows.find((w) => w.window.limitId === 'five_hour');
  assert.equal(five?.available, true);
  if (!five?.available) return;
  assert.equal(five.value, 2100);
  assert.equal(five.sense, 'used');
  assert.equal(five.window.durationMinutes, 300);
  assert.equal(five.resetsAt, '2026-09-07T00:40:00.000Z');
});

test('a malformed represented window is retained as unavailable, not dropped', () => {
  const usage = { ...threeWindowUsage, seven_day_sonnet: 'malformed' };
  const result = normalizeUsageAndProfile(usage, profile, ctx);
  assert.equal(result.status, 'supported');
  if (result.status !== 'supported') return;
  const scoped = result.observation.windows.find((w) => w.window.limitId === 'seven_day_sonnet');
  assert.equal(scoped?.available, false);
  if (scoped?.available !== false) return;
  assert.equal(scoped.code, 'malformed-window');
  assert.equal(result.observation.windows.length, 3);
});

test('excess precision is unavailable rather than rounded', () => {
  const usage = { five_hour: { utilization: 21.000000001, resets_at: '2026-09-07T00:40Z' } };
  const result = normalizeUsageAndProfile(usage, profile, ctx);
  assert.equal(result.status, 'supported');
  if (result.status !== 'supported') return;
  assert.equal(result.observation.windows[0].available, false);
});

test('missing organization uuid is identity-unavailable, no invented principal', () => {
  const result = normalizeUsageAndProfile(threeWindowUsage, { organization: {} }, ctx);
  assert.equal(result.status, 'unsupported');
  assert.equal(result.code, 'claude-account-identity-unavailable');
});

test('same organization on two calls is the same principalRef', () => {
  const a = normalizeUsageAndProfile(threeWindowUsage, profile, { ...ctx, producer: { ...PRODUCER, sequence: 1 } });
  const b = normalizeUsageAndProfile(threeWindowUsage, profile, { ...ctx, producer: { ...PRODUCER, sequence: 2 } });
  assert.equal(a.status, 'supported');
  assert.equal(b.status, 'supported');
  if (a.status !== 'supported' || b.status !== 'supported') return;
  assert.equal(a.principal.principalRef, b.principal.principalRef);
});

test('null named windows are omitted, not zero', () => {
  const readings = windowsFromUsage({ five_hour: { utilization: 0, resets_at: '2026-09-07T00:40Z' }, seven_day_opus: null });
  assert.equal(readings.length, 1);
  assert.equal(readings[0].available, true);
  if (!readings[0].available) return;
  assert.equal(readings[0].value, 0);
});

test('short resets_at converts; unparseable is omitted so freshness is unknown', () => {
  assert.equal(resetsAtToIso('2026-09-07T00:40Z'), '2026-09-07T00:40:00.000Z');
  assert.equal(resetsAtToIso('not-a-date'), undefined);
  const reading = windowsFromUsage({ five_hour: { utilization: 1, resets_at: 'not-a-date' } })[0];
  assert.equal(windowFreshness(reading, '2026-09-07T00:20:00.000Z'), 'unknown');
});

/** @param {(pathname: string, init: any) => any} script */
function fakeFetch(script) {
  /** @param {string} url @param {any} [init] */
  return async (url, init) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, CLAUDE_ORIGIN);
    assert.equal(init.redirect, 'manual');
    return script(parsed.pathname, init);
  };
}

/** @param {number} status @param {unknown} body @param {object} [extra] */
function jsonResponse(status, body, extra = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const buf = Buffer.from(text);
  return {
    status,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    ...extra,
  };
}

const readCredential = async () => 'synthetic-token';

test('public path maps usage+profile through collectClaudeUsage', async () => {
  const fetch = fakeFetch((pathname) => {
    if (pathname === '/api/oauth/usage') return jsonResponse(200, threeWindowUsage);
    if (pathname === '/api/oauth/profile') return jsonResponse(200, profile);
    assert.fail(`unexpected path ${pathname}`);
  });
  const result = await collectClaudeUsage({ poolId: POOL, producer: PRODUCER, now: NOW, fetch, readCredential });
  assert.equal(result.status, 'supported');
  if (result.status !== 'supported') return;
  assert.equal(result.observation.windows.length, 3);
  assert.equal(result.principal.principalRef, ORG);
});

test('401 is unsupported-until-refresh and a later call rereads the credential', async () => {
  let reads = 0;
  const tokens = ['expired', 'fresh'];
  const read = async () => { const t = tokens[reads] ?? 'fresh'; reads += 1; return t; };
  const fetch = fakeFetch((_path, init) => {
    const auth = String(init.headers.Authorization);
    if (auth.includes('expired')) return jsonResponse(401, { error: 'no' });
    if (_path === '/api/oauth/usage') return jsonResponse(200, threeWindowUsage);
    return jsonResponse(200, profile);
  });
  const first = await collectClaudeUsage({ poolId: POOL, producer: PRODUCER, now: NOW, fetch, readCredential: read });
  assert.equal(first.status, 'unsupported');
  assert.equal(first.code, 'claude-unsupported-until-refresh');
  const second = await collectClaudeUsage({ poolId: POOL, producer: PRODUCER, now: NOW, fetch, readCredential: read });
  assert.equal(second.status, 'supported');
  assert.equal(reads, 2);
});

test('redirects are refused and the token is not forwarded', async () => {
  let forwarded = false;
  const fetch = fakeFetch((pathname, init) => {
    if (pathname === '/api/oauth/usage') {
      return jsonResponse(302, '', { headers: { Location: 'https://evil.example/steal' } });
    }
    forwarded = true;
    return jsonResponse(200, profile);
  });
  const result = await collectClaudeUsage({ poolId: POOL, producer: PRODUCER, now: NOW, fetch, readCredential });
  assert.equal(result.status, 'unsupported');
  assert.equal(result.code, 'claude-redirect-refused');
  assert.equal(forwarded, false);
});

test('timeout is a bounded code', async () => {
  const fetch = async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return jsonResponse(200, threeWindowUsage);
  };
  const result = await collectClaudeUsage({
    poolId: POOL, producer: PRODUCER, now: NOW, fetch, readCredential, timeoutMs: 5,
  });
  assert.equal(result.status, 'unsupported');
  assert.equal(result.code, 'claude-timeout');
});

test('pre-aborted signal cancels', async () => {
  const result = await collectClaudeUsage({
    poolId: POOL, producer: PRODUCER, now: NOW, fetch: fakeFetch(() => jsonResponse(200, threeWindowUsage)),
    readCredential, signal: AbortSignal.abort(),
  });
  assert.equal(result.status, 'unsupported');
  assert.equal(result.code, 'claude-cancelled');
});

test('missing credential is unsupported, not a quota of zero', async () => {
  const result = await collectClaudeUsage({
    poolId: POOL, producer: PRODUCER, now: NOW,
    readCredential: async () => { const e = /** @type {any} */ (new Error('x')); e.code = 'claude-credential-unavailable'; throw e; },
  });
  assert.equal(result.status, 'unsupported');
  assert.equal(result.code, 'claude-credential-unavailable');
});

test('provider 500 is a bounded code and never carries the body', async () => {
  const fetch = fakeFetch(() => jsonResponse(500, { error: { message: 'secret-provider-text' } }));
  const result = await collectClaudeUsage({ poolId: POOL, producer: PRODUCER, now: NOW, fetch, readCredential });
  assert.equal(result.status, 'unsupported');
  assert.equal(result.code, 'claude-provider-error');
  assert.equal(JSON.stringify(result).includes('secret-provider-text'), false);
});

test('oversized body is refused', async () => {
  const fetch = fakeFetch(() => jsonResponse(200, 'x'.repeat(1_048_577)));
  const result = await collectClaudeUsage({ poolId: POOL, producer: PRODUCER, now: NOW, fetch, readCredential });
  assert.equal(result.status, 'unsupported');
  assert.equal(result.code, 'claude-output-oversized');
});

test('public path capturedAt comes from the injected clock', async () => {
  const fetch = fakeFetch((pathname) => {
    if (pathname === '/api/oauth/usage') return jsonResponse(200, threeWindowUsage);
    return jsonResponse(200, profile);
  });
  const result = await collectClaudeUsage({ poolId: POOL, producer: PRODUCER, now: NOW, fetch, readCredential });
  assert.equal(result.status, 'supported');
  if (result.status !== 'supported') return;
  assert.equal(result.observation.capturedAt, '2026-09-07T00:20:00.000Z');
});

test('a 5ms budget still times out when arrayBuffer is delayed 25ms per request', async () => {
  /** @param {unknown} body */
  const delayed = (body) => ({
    status: 200,
    arrayBuffer: async () => {
      await new Promise((r) => setTimeout(r, 25));
      const buf = Buffer.from(JSON.stringify(body));
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
  });
  const started = Date.now();
  const result = await collectClaudeUsage({
    poolId: POOL, producer: PRODUCER, now: NOW, timeoutMs: 5, readCredential,
    fetch: async (url) => delayed(String(url).includes('profile') ? profile : threeWindowUsage),
  });
  assert.equal(result.status, 'unsupported');
  assert.equal(result.code, 'claude-timeout');
  assert.ok(Date.now() - started < 200);
});

test('abort during the profile body is cancelled, not supported', async () => {
  const controller = new AbortController();
  const result = await collectClaudeUsage({
    poolId: POOL, producer: PRODUCER, now: NOW, signal: controller.signal, timeoutMs: 5000, readCredential,
    fetch: async (url) => {
      if (String(url).includes('profile')) {
        return {
          status: 200,
          arrayBuffer: async () => {
            controller.abort();
            await new Promise((r) => setTimeout(r, 25));
            const buf = Buffer.from(JSON.stringify(profile));
            return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
          },
        };
      }
      const buf = Buffer.from(JSON.stringify(threeWindowUsage));
      return { status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
    },
  });
  assert.equal(result.status, 'unsupported');
  assert.equal(result.code, 'claude-cancelled');
});

test('an oversized stream is refused without waiting for the whole body', async () => {
  let sent = 0;
  const chunk = new Uint8Array(64 * 1024);
  const body = new ReadableStream({
    pull(controller) {
      sent += chunk.byteLength;
      controller.enqueue(chunk);
      if (sent > CLAUDE_LIMITS.maxBytes) controller.close();
    },
  });
  const result = await collectClaudeUsage({
    poolId: POOL, producer: PRODUCER, now: NOW, readCredential,
    fetch: async () => ({ status: 200, body }),
  });
  assert.equal(result.status, 'unsupported');
  assert.equal(result.code, 'claude-output-oversized');
  assert.ok(sent < CLAUDE_LIMITS.maxBytes + chunk.byteLength * 3);
});

test('exception.code is not copied; only allowlisted codes are returned', async () => {
  const result = await collectClaudeUsage({
    poolId: POOL, producer: PRODUCER, now: NOW,
    readCredential: async () => {
      const e = /** @type {any} */ (new Error('no'));
      e.code = 'SYNTHETIC_PRIVATE_TOKEN_AND_PATH';
      throw e;
    },
  });
  assert.equal(result.status, 'unsupported');
  assert.equal(result.code, 'claude-credential-unavailable');
  assert.equal(JSON.stringify(result).includes('SYNTHETIC_PRIVATE_TOKEN_AND_PATH'), false);
});

test('stdout JSON path never includes the token in the result object', async () => {
  const fetch = fakeFetch((pathname) => {
    if (pathname === '/api/oauth/usage') return jsonResponse(200, threeWindowUsage);
    return jsonResponse(200, profile);
  });
  const result = await collectClaudeUsage({ poolId: POOL, producer: PRODUCER, now: NOW, fetch, readCredential });
  const dumped = JSON.stringify(result);
  assert.equal(dumped.includes('synthetic-token'), false);
  assert.equal(dumped.includes('Authorization'), false);
});
