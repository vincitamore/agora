// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  assert.equal(result.observation.windows[0].code, 'unsupported-precision');
});

test('missing organization uuid is identity-unavailable, no invented principal', () => {
  const result = normalizeUsageAndProfile(threeWindowUsage, { organization: {} }, ctx);
  assert.equal(result.status, 'unsupported');
  assert.equal(result.code, 'claude-account-identity-unavailable');
});

test('null uuid is identity-unavailable; a present blank or non-string is malformed', () => {
  const absent = normalizeUsageAndProfile(threeWindowUsage, { organization: { uuid: null } }, ctx);
  assert.equal(absent.status, 'unsupported');
  assert.equal(absent.code, 'claude-account-identity-unavailable');
  const blank = normalizeUsageAndProfile(threeWindowUsage, { organization: { uuid: '   ' } }, ctx);
  assert.equal(blank.status, 'error');
  assert.equal(blank.code, 'claude-account-identity-malformed');
  const numbered = normalizeUsageAndProfile(threeWindowUsage, { organization: { uuid: 12345 } }, ctx);
  assert.equal(numbered.status, 'error');
  assert.equal(numbered.code, 'claude-account-identity-malformed');
});

test('a blank optional plan is omitted; a nonempty plan is kept', () => {
  const blank = normalizeUsageAndProfile(threeWindowUsage, {
    organization: { uuid: ORG, organization_type: '   ' },
  }, ctx);
  assert.equal(blank.status, 'supported');
  if (blank.status !== 'supported') return;
  assert.equal(Object.hasOwn(blank.principal, 'plan'), false);
  const kept = normalizeUsageAndProfile(threeWindowUsage, profile, ctx);
  assert.equal(kept.status, 'supported');
  if (kept.status !== 'supported') return;
  assert.equal(kept.principal.plan, 'claude_max');
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

test('short resets_at converts; unparseable is unsupported-reset, not omitted', () => {
  assert.equal(resetsAtToIso('2026-09-07T00:40Z'), '2026-09-07T00:40:00.000Z');
  assert.equal(resetsAtToIso('not-a-date'), undefined);
  const absent = windowsFromUsage({ five_hour: { utilization: 1 } })[0];
  assert.equal(absent.available, true);
  if (!absent.available) return;
  assert.equal(windowFreshness(absent, '2026-09-07T00:20:00.000Z'), 'unknown');
  const unreadable = windowsFromUsage({ five_hour: { utilization: 1, resets_at: 'soon' } })[0];
  assert.equal(unreadable.available, false);
  if (unreadable.available !== false) return;
  assert.equal(unreadable.code, 'unsupported-reset');
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
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(buf));
        controller.close();
      },
    }),
    ...extra,
  };
}

/** @param {unknown} body @param {number} delayMs */
function delayedJson(body, delayMs) {
  const buf = Buffer.from(JSON.stringify(body));
  return {
    status: 200,
    body: new ReadableStream({
      async pull(controller) {
        await new Promise((r) => setTimeout(r, delayMs));
        controller.enqueue(new Uint8Array(buf));
        controller.close();
      },
    }),
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

test('public path: blank uuid is malformed; number uuid is not absent; utilization codes split', async () => {
  const through = async (/** @type {unknown} */ prof, /** @type {unknown} */ usage) => {
    const fetch = fakeFetch((pathname) => {
      if (pathname === '/api/oauth/usage') return jsonResponse(200, usage);
      if (pathname === '/api/oauth/profile') return jsonResponse(200, prof);
      assert.fail(`unexpected path ${pathname}`);
    });
    return collectClaudeUsage({ poolId: POOL, producer: PRODUCER, now: NOW, fetch, readCredential });
  };
  const blank = await through({ organization: { uuid: '   ', organization_type: 'claude_max' } }, threeWindowUsage);
  assert.equal(blank.status, 'error');
  assert.equal(blank.code, 'claude-account-identity-malformed');
  const numbered = await through({ organization: { uuid: 12345, organization_type: 'claude_max' } }, threeWindowUsage);
  assert.equal(numbered.status, 'error');
  assert.equal(numbered.code, 'claude-account-identity-malformed');
  const absent = await through({ organization: {} }, threeWindowUsage);
  assert.equal(absent.status, 'unsupported');
  assert.equal(absent.code, 'claude-account-identity-unavailable');

  const plan = await through({ organization: { uuid: ORG, organization_type: '   ' } }, threeWindowUsage);
  assert.equal(plan.status, 'supported');
  if (plan.status !== 'supported') return;
  assert.equal(Object.hasOwn(plan.principal, 'plan'), false);

  const codes = [];
  for (const utilization of ['8', 150, -5, 21.000000001]) {
    const r = await through(profile, { five_hour: { utilization, resets_at: '2026-09-07T00:40Z' } });
    assert.equal(r.status, 'supported');
    if (r.status !== 'supported') return;
    codes.push(r.observation.windows[0].code);
  }
  assert.deepEqual(codes, [
    'unsupported-percent-type',
    'unsupported-percent-range',
    'unsupported-percent-range',
    'unsupported-precision',
  ]);
});

test('unreadable resets_at through the collector is unsupported-reset; absent and null omit the field', async () => {
  const through = async (/** @type {unknown} */ usage) => {
    const fetch = fakeFetch((pathname) => {
      if (pathname === '/api/oauth/usage') return jsonResponse(200, usage);
      if (pathname === '/api/oauth/profile') return jsonResponse(200, profile);
      assert.fail(`unexpected path ${pathname}`);
    });
    return collectClaudeUsage({ poolId: POOL, producer: PRODUCER, now: NOW, fetch, readCredential });
  };
  const soon = await through({ five_hour: { utilization: 21.0, resets_at: 'soon' } });
  assert.equal(soon.status, 'supported');
  if (soon.status !== 'supported') return;
  assert.equal(soon.observation.windows[0].available, false);
  if (soon.observation.windows[0].available !== false) return;
  assert.equal(soon.observation.windows[0].code, 'unsupported-reset');

  const absent = await through({ five_hour: { utilization: 21.0 } });
  assert.equal(absent.status, 'supported');
  if (absent.status !== 'supported') return;
  assert.equal(absent.observation.windows[0].available, true);
  assert.equal(Object.hasOwn(absent.observation.windows[0], 'resetsAt'), false);
  assert.equal(windowFreshness(absent.observation.windows[0], '2026-09-07T00:20:00.000Z'), 'unknown');

  const nul = await through({ five_hour: { utilization: 21.0, resets_at: null } });
  assert.equal(nul.status, 'supported');
  if (nul.status !== 'supported') return;
  assert.equal(nul.observation.windows[0].available, true);
  assert.equal(Object.hasOwn(nul.observation.windows[0], 'resetsAt'), false);
  assert.equal(windowFreshness(nul.observation.windows[0], '2026-09-07T00:20:00.000Z'), 'unknown');
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

test('a 5ms budget times out a stream whose pull never resolves', async () => {
  const started = Date.now();
  const result = await collectClaudeUsage({
    poolId: POOL, producer: PRODUCER, now: NOW, timeoutMs: 5, readCredential,
    fetch: async () => ({
      status: 200,
      body: new ReadableStream({ pull() { return new Promise(() => {}); } }),
    }),
  });
  assert.equal(result.status, 'unsupported');
  assert.equal(result.code, 'claude-timeout');
  assert.ok(Date.now() - started < 200);
});

test('a 5ms budget still times out when stream pull is delayed 25ms', async () => {
  const started = Date.now();
  const result = await collectClaudeUsage({
    poolId: POOL, producer: PRODUCER, now: NOW, timeoutMs: 5, readCredential,
    fetch: async (url) => delayedJson(String(url).includes('profile') ? profile : threeWindowUsage, 25),
  });
  assert.equal(result.status, 'unsupported');
  assert.equal(result.code, 'claude-timeout');
  assert.ok(Date.now() - started < 200);
});

test('abort during the final profile read(done) is cancelled, not supported', async () => {
  const controller = new AbortController();
  let pulls = 0;
  const result = await collectClaudeUsage({
    poolId: POOL, producer: PRODUCER, now: NOW, signal: controller.signal, timeoutMs: 5000, readCredential,
    fetch: async (url) => {
      if (!String(url).includes('profile')) return jsonResponse(200, threeWindowUsage);
      const buf = Buffer.from(JSON.stringify(profile));
      return {
        status: 200,
        body: new ReadableStream({
          pull(c) {
            pulls += 1;
            if (pulls === 1) {
              c.enqueue(new Uint8Array(buf));
              return;
            }
            controller.abort();
            c.close();
          },
        }),
      };
    },
  });
  assert.equal(result.status, 'unsupported');
  assert.equal(result.code, 'claude-cancelled');
});

test('a body without a stream is refused and arrayBuffer is never called', async () => {
  let allocated = 0;
  const result = await collectClaudeUsage({
    poolId: POOL, producer: PRODUCER, now: NOW, readCredential,
    fetch: async () => ({
      status: 200,
      arrayBuffer: async () => {
        allocated = 2_000_000;
        return new ArrayBuffer(2_000_000);
      },
    }),
  });
  assert.equal(result.status, 'unsupported');
  assert.equal(result.code, 'claude-body-unstreamed');
  assert.equal(allocated, 0);
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

function runIsolatedCollector(/** @type {string} */ body) {
  const collector = new URL('../src/usage/claude.mjs', import.meta.url).href;
  const dir = mkdtempSync(join(tmpdir(), 'n4-cancel-'));
  const file = join(dir, 'probe.mjs');
  writeFileSync(file, [
    "import { collectClaudeUsage } from '" + collector + "';",
    body,
    'await new Promise((res) => setTimeout(res, 200));',
  ].join('\n'), 'utf8');
  return spawnSync(process.execPath, [file], { encoding: 'utf8' });
}

test('a rejecting body.cancel on 401 does not crash the calling process', () => {
  const run = runIsolatedCollector([
    'const body = new ReadableStream({ cancel() { return Promise.reject(new Error("SYNTHETIC_CANCEL_REJECT")); } });',
    'const r = await collectClaudeUsage({',
    "  poolId: '" + POOL + "',",
    "  producer: { producerId: '" + PRODUCER.producerId + "', generation: 1, sequence: 1 },",
    "  now: () => new Date('2026-09-07T00:20:00.000Z'),",
    "  readCredential: async () => 't',",
    '  fetch: async () => ({ status: 401, body }),',
    '});',
    "console.log('RESULT ' + r.status + ' ' + (r.code || ''));",
  ].join('\n'));
  assert.equal(run.status, 0, 'a rejected cancel must not terminate the caller');
  assert.equal(/^\s*at .*:\d+:\d+/m.test(run.stderr || ''), false, 'a raw stack reached stderr');
  assert.match(run.stdout, /RESULT unsupported claude-unsupported-until-refresh/);
  assert.equal((run.stdout + run.stderr).includes('SYNTHETIC_CANCEL_REJECT'), false);
});

test('a never-settling body.cancel on 401 still returns a bounded code', async () => {
  const started = Date.now();
  const result = await collectClaudeUsage({
    poolId: POOL, producer: PRODUCER, now: NOW, readCredential,
    fetch: async () => ({
      status: 401,
      body: { cancel() { return new Promise(() => {}); } },
    }),
  });
  assert.equal(result.status, 'unsupported');
  assert.equal(result.code, 'claude-unsupported-until-refresh');
  assert.ok(Date.now() - started < 200);
});

test('a rejecting reader.cancel on abort does not crash the calling process', () => {
  const run = runIsolatedCollector([
    'const ac = new AbortController();',
    'let pulls = 0;',
    'const r = await collectClaudeUsage({',
    "  poolId: '" + POOL + "',",
    "  producer: { producerId: '" + PRODUCER.producerId + "', generation: 1, sequence: 1 },",
    "  now: () => new Date('2026-09-07T00:20:00.000Z'),",
    "  readCredential: async () => 't',",
    '  signal: ac.signal, timeoutMs: 5000,',
    '  fetch: async () => ({',
    '    status: 200,',
    '    body: new ReadableStream({',
    '      pull(c) {',
    '        pulls += 1;',
    '        if (pulls === 1) { ac.abort(); return; }',
    '        c.close();',
    '      },',
    '      cancel() { return Promise.reject(new Error("SYNTHETIC_CANCEL_REJECT")); }',
    '    }),',
    '  }),',
    '});',
    "console.log('RESULT ' + r.status + ' ' + (r.code || ''));",
  ].join('\n'));
  assert.equal(run.status, 0, 'a rejected reader.cancel must not terminate the caller');
  assert.equal(/^\s*at .*:\d+:\d+/m.test(run.stderr || ''), false, 'a raw stack reached stderr');
  assert.match(run.stdout, /RESULT unsupported claude-cancelled/);
  assert.equal((run.stdout + run.stderr).includes('SYNTHETIC_CANCEL_REJECT'), false);
});

test('a never-settling reader.cancel on abort still returns a bounded code', async () => {
  const ac = new AbortController();
  let pulls = 0;
  const started = Date.now();
  const result = await collectClaudeUsage({
    poolId: POOL, producer: PRODUCER, now: NOW, readCredential, signal: ac.signal, timeoutMs: 5000,
    fetch: async () => ({
      status: 200,
      body: new ReadableStream({
        pull(c) {
          pulls += 1;
          if (pulls === 1) { ac.abort(); return; }
          c.close();
        },
        cancel() { return new Promise(() => {}); },
      }),
    }),
  });
  assert.equal(result.status, 'unsupported');
  assert.equal(result.code, 'claude-cancelled');
  assert.ok(Date.now() - started < 200);
});
