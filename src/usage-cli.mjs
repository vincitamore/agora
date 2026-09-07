// @ts-check
// N3: first usage CLI consumer of the N2 Codex collector.
//
// Room-less: `agora usage --provider codex --pool-id <id> [--timeout <ms>] [--json]`.
// Cooperative harness reading only. No ServiceRef, no store, no credential print, no
// provider body. The collector clock is an injected `() => Date`; timeout is a separate
// argument. OPTIONS.now remains cursor --now.
import { collectCodexUsage, CODEX_LIMITS } from './usage/codex.mjs';
import { windowFreshness } from './protocol/usage.mjs';

export const USAGE_TIMEOUT_MAX_MS = 60_000;
/** Default producer identity. Must satisfy N1 validateNativeId (16..128 [A-Za-z0-9_-]). */
export const USAGE_CLI_PRODUCER_ID = 'agora-usage-cli01';

/** @typedef {{ status: string, code?: string, principal?: any, observation?: any }} UsageResult */

/**
 * @param {string | undefined} raw
 * @param {number} fallback
 */
export function parseTimeoutMs(raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  if (!/^[0-9]+$/.test(raw)) {
    const err = new Error('--timeout must be a positive integer number of milliseconds');
    /** @type {any} */ (err).exit = 2;
    throw err;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > USAGE_TIMEOUT_MAX_MS) {
    const err = new Error(`--timeout must be an integer from 1 to ${USAGE_TIMEOUT_MAX_MS}`);
    /** @type {any} */ (err).exit = 2;
    throw err;
  }
  return n;
}

/**
 * @param {UsageResult} result
 * @param {{ json?: boolean, now: () => Date }} opts
 */
export function formatUsageResult(result, opts) {
  if (opts.json) return `${JSON.stringify(result)}\n`;
  if (result.status !== 'supported') {
    return `unsupported ${result.code ?? 'unknown'}\n`;
  }
  const principal = result.principal;
  const observation = result.observation;
  const lines = [
    `provider ${principal.provider} pool ${principal.poolId} principal ${principal.principalRef} identity ${principal.identity} source ${observation.source} attestation ${observation.attestation}`,
    `captured ${observation.capturedAt}`,
  ];
  for (const reading of observation.windows) {
    const ident = reading.window;
    const id = `${ident.limitId}${ident.scope ? `/${ident.scope}` : ''}${ident.durationMinutes ? ` ${ident.durationMinutes}m` : ''}`;
    if (!reading.available) {
      lines.push(`window ${id} unavailable ${reading.code}`);
      continue;
    }
    const percent = (reading.value / 100).toFixed(2);
    const reset = reading.resetsAt ? ` resets ${reading.resetsAt}` : '';
    const fresh = windowFreshness(reading, opts.now().toISOString());
    lines.push(`window ${id} ${reading.sense} ${reading.value} basis-points (${percent}%)${reset} freshness ${fresh}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * @param {{ provider?: string, poolId?: string, timeout?: string, json?: boolean,
 *           now?: () => Date,
 *           collect?: (opts: { poolId: string, producer: unknown, now: () => Date, timeoutMs?: number, signal?: AbortSignal, spawn?: any, resolveBinary?: any }) => Promise<UsageResult>,
 *           producer?: { producerId: string, generation: number, sequence: number },
 *           spawn?: any, resolveBinary?: any, codexPath?: string, signal?: AbortSignal }} options
 * @returns {Promise<{ exit: number, stdout: string, stderr: string }>}
 */
export async function runUsage(options) {
  const now = options.now ?? (() => new Date());
  const provider = options.provider;
  if (!provider) return { exit: 2, stdout: '', stderr: 'agora usage needs --provider <name>\n' };
  if (provider !== 'codex') return { exit: 2, stdout: '', stderr: `unsupported --provider ${JSON.stringify(provider)} (have: codex)\n` };
  const poolId = options.poolId;
  if (!poolId) return { exit: 2, stdout: '', stderr: 'agora usage needs --pool-id <id>\n' };

  let timeoutMs;
  try {
    timeoutMs = parseTimeoutMs(options.timeout, CODEX_LIMITS.timeoutMs);
  } catch (error) {
    return { exit: /** @type {any} */ (error).exit ?? 2, stdout: '', stderr: `${error instanceof Error ? error.message : String(error)}\n` };
  }

  const producer = options.producer ?? { producerId: USAGE_CLI_PRODUCER_ID, generation: 1, sequence: 1 };
  const collect = options.collect ?? collectCodexUsage;
  let result;
  try {
    result = await collect({
      poolId, producer, now, timeoutMs, signal: options.signal,
      ...(options.spawn ? { spawn: options.spawn } : {}),
      ...(options.resolveBinary ? { resolveBinary: options.resolveBinary } : {}),
      ...(options.codexPath ? { codexPath: options.codexPath } : {}),
    });
  } catch {
    return { exit: 1, stdout: '', stderr: '' };
  }

  const stdout = formatUsageResult(result, { json: Boolean(options.json), now });
  const secrets = ['Authorization', 'Bearer ', 'accessToken', 'SYNTHETIC_PRIVATE'];
  if (secrets.some((s) => stdout.includes(s))) return { exit: 1, stdout: '', stderr: '' };
  const exit = result.status === 'supported' ? 0 : 1;
  return { exit, stdout, stderr: '' };
}
