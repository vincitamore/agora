// @ts-check
// N4: a read-only quota collector for the installed Claude Code OAuth meter.
//
// Two GETs on a fixed origin: /api/oauth/usage and /api/oauth/profile. The token is
// read from the CLI credential file at call time and never refreshed, rewritten, or
// logged. Redirects are refused; Authorization is never forwarded to another host.
//
// What it returns is `cooperative`, `source: 'harness'`. It fabricates no attestor and
// no service identity. A later seat-service consumer must resolve authenticated expected
// context and call `acceptCompleteObservation` itself. That work is not done here.
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { percentToBasisPoints, validateCompleteObservation, validatePoolPrincipal } from '../protocol/usage.mjs';

export const CLAUDE_ORIGIN = 'https://api.anthropic.com';
export const CLAUDE_LIMITS = Object.freeze({ timeoutMs: 15000, maxBytes: 1_048_576 });

/** @typedef {(url: string, init?: RequestInit) => Promise<{status: number, arrayBuffer: () => Promise<ArrayBuffer>}>} FetchFn */
/** @typedef {(path?: string) => Promise<string>} CredentialFn */


const NAMED_WINDOWS = Object.freeze([
  { key: 'five_hour', durationMinutes: 300 },
  { key: 'seven_day', durationMinutes: 10080 },
  { key: 'seven_day_opus', durationMinutes: 10080 },
  { key: 'seven_day_sonnet', durationMinutes: 10080 },
]);

/** @typedef {{status:'supported', principal: ReturnType<typeof validatePoolPrincipal>, observation: ReturnType<typeof validateCompleteObservation>}} SupportedResult */
/** @typedef {{status:'unsupported'|'error', code:string}} UnsupportedResult */

const CODE = Object.freeze({
  noCredential: 'claude-credential-unavailable',
  untilRefresh: 'claude-unsupported-until-refresh',
  noIdentity: 'claude-account-identity-unavailable',
  timeout: 'claude-timeout',
  cancelled: 'claude-cancelled',
  oversized: 'claude-output-oversized',
  badJson: 'claude-malformed-json',
  redirect: 'claude-redirect-refused',
  origin: 'claude-origin-refused',
  provider: 'claude-provider-error',
  noQuota: 'claude-no-quota-reported',
  badQuota: 'claude-quota-shape-unsupported',
});

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) { return typeof value === 'object' && value !== null && !Array.isArray(value); }

/**
 * Provider `resets_at` (measured as a short ISO like `2026-09-07T00:40Z`) to the contract's
 * exact `Date.toISOString()` form. Unparseable values are omitted so freshness is unknown,
 * never silently fresh.
 * @param {unknown} value
 */
export function resetsAtToIso(value) {
  if (typeof value !== 'string' || !value) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

/**
 * One named top-level usage window becomes one window reading.
 * `limits` is a restatement and is not consulted here.
 * @param {string} limitId @param {number} durationMinutes @param {unknown} window
 */
export function windowReadingFrom(limitId, durationMinutes, window) {
  if (window == null) return undefined;
  if (!isRecord(window)) {
    return { window: { limitId, unit: /** @type {const} */ ('basis-points'), durationMinutes }, available: /** @type {const} */ (false), code: 'malformed-window' };
  }
  const identity = { limitId, unit: /** @type {const} */ ('basis-points'), durationMinutes };
  let value;
  try {
    value = percentToBasisPoints(window.utilization);
  } catch {
    return { window: identity, available: /** @type {const} */ (false), code: 'unsupported-precision' };
  }
  const resetsAt = resetsAtToIso(window.resets_at);
  return { window: identity, available: /** @type {const} */ (true), value, sense: /** @type {const} */ ('used'),
    ...(resetsAt ? { resetsAt } : {}) };
}

/**
 * Named top-level keys are authoritative. The `limits` array restates them and must not
 * add windows. Null named windows are omitted; a present unusable window is retained as
 * unavailable so completeness is honest.
 * @param {unknown} usage
 */
export function windowsFromUsage(usage) {
  if (!isRecord(usage)) return [];
  const readings = [];
  for (const spec of NAMED_WINDOWS) {
    if (!Object.hasOwn(usage, spec.key) || usage[spec.key] == null) continue;
    const reading = windowReadingFrom(spec.key, spec.durationMinutes, usage[spec.key]);
    if (reading) readings.push(reading);
  }
  return readings;
}

/**
 * @param {unknown} usage
 * @param {unknown} profile
 * @param {{ poolId: string, capturedAt: string, producer: unknown }} context
 * @returns {SupportedResult | UnsupportedResult}
 */
export function normalizeUsageAndProfile(usage, profile, context) {
  if (!isRecord(profile)) return { status: 'unsupported', code: CODE.noIdentity };
  const organization = isRecord(profile.organization) ? profile.organization : undefined;
  const accountId = organization && typeof organization.uuid === 'string' ? organization.uuid : '';
  if (!accountId) return { status: 'unsupported', code: CODE.noIdentity };

  const readings = windowsFromUsage(usage);
  if (readings.length === 0) return { status: 'unsupported', code: CODE.noQuota };

  const plan = organization && typeof organization.organization_type === 'string' && organization.organization_type
    ? organization.organization_type
    : (organization && typeof organization.rate_limit_tier === 'string' ? organization.rate_limit_tier : undefined);

  const principal = validatePoolPrincipal({
    poolId: context.poolId, provider: 'claude', principalRef: accountId, identity: 'unverified',
    ...(plan ? { plan } : {}),
  });
  const observation = validateCompleteObservation({
    kind: 'full', poolId: context.poolId, capturedAt: context.capturedAt,
    source: 'harness', attestation: 'cooperative', producer: context.producer, windows: readings,
  });
  return { status: 'supported', principal, observation };
}

/** @param {string} [credentialPath] */
export async function defaultReadCredential(credentialPath) {
  const file = credentialPath ?? path.join(homedir(), '.claude', '.credentials.json');
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    const err = new Error(CODE.noCredential);
    /** @type {any} */ (err).code = CODE.noCredential;
    throw err;
  }
  let json;
  try { json = JSON.parse(text); } catch {
    const err = new Error(CODE.noCredential);
    /** @type {any} */ (err).code = CODE.noCredential;
    throw err;
  }
  const token = isRecord(json) && isRecord(json.claudeAiOauth) && typeof json.claudeAiOauth.accessToken === 'string'
    ? json.claudeAiOauth.accessToken : '';
  if (!token) {
    const err = new Error(CODE.noCredential);
    /** @type {any} */ (err).code = CODE.noCredential;
    throw err;
  }
  return token;
}

/**
 * Default transport: fixed origin, redirects refused, Authorization never forwarded.
 * @type {FetchFn}
 */
export async function defaultFetch(url, init) {
  let parsed;
  try { parsed = new URL(url); } catch {
    const err = new Error(CODE.origin);
    /** @type {any} */ (err).code = CODE.origin;
    throw err;
  }
  if (parsed.origin !== CLAUDE_ORIGIN) {
    const err = new Error(CODE.origin);
    /** @type {any} */ (err).code = CODE.origin;
    throw err;
  }
  return fetch(url, { ...init, redirect: 'manual' });
}

/**
 * @param {{ url: string, token: string, fetchFn: FetchFn, timeoutMs: number, signal?: AbortSignal }} options
 * @returns {Promise<{ok:true, body: unknown}|{ok:false, code:string}>}
 */
async function getJson(options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), options.timeoutMs);
  const onAbort = () => controller.abort('cancelled');
  if (options.signal) {
    if (options.signal.aborted) {
      clearTimeout(timer);
      return { ok: false, code: CODE.cancelled };
    }
    options.signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const response = await options.fetchFn(`${CLAUDE_ORIGIN}${options.url}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${options.token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        Accept: 'application/json',
      },
      signal: controller.signal,
      redirect: 'manual',
    });
    if (controller.signal.aborted) {
      return { ok: false, code: controller.signal.reason === 'timeout' ? CODE.timeout : CODE.cancelled };
    }
    if (response.status >= 300 && response.status < 400) return { ok: false, code: CODE.redirect };
    if (response.status === 401) return { ok: false, code: CODE.untilRefresh };
    if (response.status !== 200) return { ok: false, code: CODE.provider };
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.byteLength > CLAUDE_LIMITS.maxBytes) return { ok: false, code: CODE.oversized };
    try {
      return { ok: true, body: JSON.parse(buf.toString('utf8')) };
    } catch {
      return { ok: false, code: CODE.badJson };
    }
  } catch (error) {
    const name = error && typeof error === 'object' && 'name' in error ? String(/** @type {any} */ (error).name) : '';
    const reason = controller.signal.reason;
    if (reason === 'timeout' || name === 'TimeoutError') return { ok: false, code: CODE.timeout };
    if (reason === 'cancelled' || name === 'AbortError') return { ok: false, code: CODE.cancelled };
    const code = error && typeof error === 'object' && 'code' in error ? String(/** @type {any} */ (error).code) : '';
    if (code === CODE.origin) return { ok: false, code: CODE.origin };
    return { ok: false, code: CODE.provider };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Public collector: one bounded usage+profile read, normalised into the usage contract.
 * @param {{ poolId: string, producer: unknown, now: () => Date,
 *           readCredential?: CredentialFn, fetch?: FetchFn, credentialPath?: string,
 *           timeoutMs?: number, signal?: AbortSignal }} options
 * @returns {Promise<SupportedResult | UnsupportedResult>}
 */
export async function collectClaudeUsage(options) {
  const capturedAt = options.now().toISOString();
  const timeoutMs = options.timeoutMs ?? CLAUDE_LIMITS.timeoutMs;
  const fetchFn = options.fetch ?? defaultFetch;
  const readCredential = options.readCredential ?? defaultReadCredential;
  let token;
  try {
    token = await readCredential(options.credentialPath);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(/** @type {any} */ (error).code) : CODE.noCredential;
    return { status: 'unsupported', code: code || CODE.noCredential };
  }
  if (typeof token !== 'string' || !token) return { status: 'unsupported', code: CODE.noCredential };

  const usageReply = await getJson({ url: '/api/oauth/usage', token, fetchFn, timeoutMs, signal: options.signal });
  if (!usageReply.ok) return { status: usageReply.code === CODE.badQuota ? 'error' : 'unsupported', code: usageReply.code };
  const profileReply = await getJson({ url: '/api/oauth/profile', token, fetchFn, timeoutMs, signal: options.signal });
  if (!profileReply.ok) return { status: profileReply.code === CODE.badQuota ? 'error' : 'unsupported', code: profileReply.code };
  try {
    return normalizeUsageAndProfile(usageReply.body, profileReply.body, {
      poolId: options.poolId, capturedAt, producer: options.producer,
    });
  } catch {
    return { status: 'error', code: CODE.badQuota };
  }
}
