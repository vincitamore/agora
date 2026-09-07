// @ts-check
// N2: a read-only quota collector for the installed Codex app server.
//
// It starts a short-lived helper process, performs `initialize` and one
// `account/rateLimits/read`, normalises the reply into the landed usage contract, and
// stops. It starts NO model turn, reads and exports NO credential, and never logs raw
// stdout, stderr or a provider error body — only allow-listed fields and bounded codes.
//
// What it returns is `cooperative`, `source: 'harness'`. It fabricates no attestor and no
// service identity, and running in the same process as the caller is not authority: a later
// seat-service consumer must resolve an authenticated expected context and call
// `acceptCompleteObservation` itself. That work is not done here and is not implied.
import { spawn as nodeSpawn } from 'node:child_process';
import { percentToBasisPoints, validateCompleteObservation, validatePoolPrincipal } from '../protocol/usage.mjs';
// Reuse the maintained resolver rather than looking for `codex` on PATH: on Windows the npm
// shim is commonly on PATH without the native executable, and this already handles that, an
// explicit path, and AGORA_CODEX_BIN. It is imported, not modified.
import { resolveCodexBinary } from '../codex.mjs';

/** Bounds. A helper that misbehaves must cost a bounded amount of time and memory. */
export const CODEX_LIMITS = Object.freeze({ timeoutMs: 15000, maxBytes: 4_194_304, maxLineBytes: 1_048_576 });

/** @typedef {{status:'supported', principal: ReturnType<typeof validatePoolPrincipal>, observation: ReturnType<typeof validateCompleteObservation>}} SupportedResult */
/** @typedef {{status:'unsupported'|'error', code:string, detail?:string}} UnsupportedResult */

/** Diagnostic codes. Bounded, lowercase-kebab, and never carrying provider text. */
const CODE = Object.freeze({
  spawnFailed: 'codex-spawn-failed', timeout: 'codex-timeout', cancelled: 'codex-cancelled',
  earlyExit: 'codex-early-exit', oversized: 'codex-output-oversized', badFrame: 'codex-malformed-frame',
  protocolError: 'codex-protocol-error', noIdentity: 'codex-account-identity-unavailable',
  noQuota: 'codex-no-quota-reported', badQuota: 'codex-quota-shape-unsupported',
  transport: 'codex-transport-error', badIdentity: 'codex-account-identity-malformed',
});

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) { return typeof value === 'object' && value !== null && !Array.isArray(value); }

/**
 * A `RateLimitSnapshot` REQUIRES both window slots; each may be schema null. Record-ness is not
 * snapshot shape: `{}` is a perfectly good record and a malformed snapshot, and a snapshot with
 * `primary` but no `secondary` key is missing a required field rather than reporting no window
 * there. An ABSENT key and a null are different claims -- the same distinction this module was
 * repaired for at the slot and the bucket, now checked at the field.
 * @param {unknown} value
 */
function isSnapshotShape(value) {
  return isRecord(value) && Object.hasOwn(value, 'primary') && Object.hasOwn(value, 'secondary');
}

/**
 * Epoch seconds (the shape the installed schema uses for `resetsAt`) to an ISO instant.
 * A non-finite or out-of-range value is NOT coerced: it returns undefined so the reading
 * carries no reset metadata, which the contract reports as unknown freshness rather than
 * as fresh.
 * @param {unknown} value
 */
export function resetsAtToIso(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const ms = value * 1000;
  if (!Number.isSafeInteger(Math.trunc(ms))) return undefined;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

/**
 * One `RateLimitWindow` in one slot becomes one window reading.
 *
 * `usedPercent` is a decimal percent and goes through the contract's own converter, which
 * REFUSES precision finer than a basis point rather than rounding it — so an unexpected
 * precision surfaces as an unsupported window, never as a quietly rounded quota.
 *
 * The slot name (`primary` / `secondary`) is the window's `scope`, because one snapshot
 * carries two slots that may share a `limitId`; the provider's `limitId` is preserved
 * exactly as reported and never rewritten.
 * @param {string} limitId @param {'primary'|'secondary'} slot @param {unknown} window
 */
export function windowReadingFrom(limitId, slot, window) {
  // A schema null (or an absent key) is the provider saying there is NO window in this slot.
  // A value that is present but unreadable is a different fact: a window exists and cannot be
  // expressed. Collapsing the two drops a represented window silently, so they diverge here.
  if (window === null || window === undefined) return undefined;
  const bare = { limitId, unit: /** @type {const} */ ('basis-points'), scope: slot };
  if (!isRecord(window)) return { window: bare, available: /** @type {const} */ (false), code: 'unsupported-shape' };
  // The duration is part of the window's IDENTITY, so it is never rounded into shape: a
  // fractional or out-of-range duration would silently rename the window (300.9 -> 300) and
  // could collide with a genuine 300-minute window. Absent stays absent; unexpressible is
  // reported as unavailable with a reason.
  const rawDuration = window.windowDurationMins;
  /** @type {{durationMinutes?: number}} */
  let duration = {};
  if (rawDuration !== null && rawDuration !== undefined) {
    if (typeof rawDuration !== 'number' || !Number.isInteger(rawDuration) || rawDuration < 1) {
      return { window: bare, available: /** @type {const} */ (false), code: 'unsupported-duration' };
    }
    duration = { durationMinutes: rawDuration };
  }
  const identity = { ...bare, ...duration };
  // D3. `resetsAt` is `number | null`: null is "no reset metadata", and anything else that is
  // not a finite number is metadata the provider sent and this code cannot read. Reporting the
  // second as the first says the window has no reset time when the truth is that its reset time
  // was unintelligible -- the same absent/malformed collapse, at the field.
  const rawReset = window.resetsAt;
  if (rawReset !== null && rawReset !== undefined && (typeof rawReset !== 'number' || !Number.isFinite(rawReset))) {
    return { window: identity, available: /** @type {const} */ (false), code: 'unsupported-reset' };
  }
  // D4. These are three different faults and they had one code between them. A bounded code
  // that misdescribes its own cause is a small lie a consumer will later trust, so the type
  // fault, the range fault and the genuine precision fault are now distinguished.
  const rawPercent = window.usedPercent;
  if (typeof rawPercent !== 'number' || !Number.isFinite(rawPercent)) {
    return { window: identity, available: /** @type {const} */ (false), code: 'unsupported-percent-type' };
  }
  if (rawPercent < 0 || rawPercent > 100) {
    return { window: identity, available: /** @type {const} */ (false), code: 'unsupported-percent-range' };
  }
  let value;
  try {
    value = percentToBasisPoints(rawPercent);
  } catch {
    // What remains is the genuine case this code was named for: a percentage finer than a
    // basis point, which is refused rather than rounded.
    return { window: identity, available: /** @type {const} */ (false), code: 'unsupported-precision' };
  }
  const resetsAt = resetsAtToIso(rawReset);
  return { window: identity, available: /** @type {const} */ (true), value, sense: /** @type {const} */ ('used'),
    ...(resetsAt ? { resetsAt } : {}) };
}

/**
 * A snapshot's `limitId` is `string | null`. Null (or absent) means the provider reports no id
 * of its own and the key it was filed under is the right identity. Anything ELSE present is an
 * id this code cannot read, and quietly substituting the key would file the window under an
 * identity the provider never reported -- the same identity rewriting refused for durations.
 * @param {Record<string, unknown>} snapshot
 */
function hasReadableLimitId(snapshot) {
  const id = snapshot.limitId;
  if (id === null || id === undefined) return true;
  return typeof id === 'string' && id.length > 0;
}

/**
 * A `RateLimitSnapshot` becomes zero, one or two window readings — one per populated slot.
 * A snapshot whose `limitId` is null falls back to the key it was filed under in the
 * multi-bucket map, which is the provider's own metered id.
 * @param {unknown} snapshot @param {string} fallbackLimitId
 */
export function windowsFromSnapshot(snapshot, fallbackLimitId) {
  if (!isRecord(snapshot)) return [];
  const limitId = typeof snapshot.limitId === 'string' && snapshot.limitId ? snapshot.limitId : fallbackLimitId;
  const readings = [];
  for (const slot of /** @type {const} */ (['primary', 'secondary'])) {
    const reading = windowReadingFrom(limitId, slot, snapshot[slot]);
    if (reading) readings.push(reading);
  }
  return readings;
}

/**
 * Normalise a `GetAccountRateLimitsResponse` into the contract's records.
 *
 * The multi-bucket `rateLimitsByLimitId` map is AUTHORITATIVE when supplied; the legacy
 * `rateLimits` summary is the backward-compatible single-bucket view and contributes only a
 * bucket the map does not already carry, so one window is never counted twice.
 *
 * `accountId` is nullable in the schema. When absent the result is
 * `codex-account-identity-unavailable` — the collector does not invent a principal and does
 * not reach for a credential path to manufacture one.
 * @param {unknown} response
 * @param {{ poolId: string, capturedAt: string, producer: unknown }} context
 * @returns {SupportedResult | UnsupportedResult}
 */
export function normalizeRateLimitsResponse(response, context) {
  if (!isRecord(response)) return { status: 'error', code: CODE.badQuota };
  // D2. `accountId` is `string | null`. Null is "the backend supplied no identity", which is a
  // fact about the account and reported as unsupported. A non-string, or an empty string, is a
  // response this code cannot read, which is a fault and reported as one.
  const accountId = response.accountId;
  if (accountId === null || accountId === undefined) return { status: 'unsupported', code: CODE.noIdentity };
  if (typeof accountId !== 'string' || accountId.length === 0) {
    return { status: 'error', code: CODE.badIdentity };
  }

  // ABSENT (null/undefined) and SUPPLIED are different claims. When the multi-bucket map is
  // supplied it is authoritative and the legacy single-bucket summary adds nothing -- including
  // when it is supplied EMPTY, which asserts zero buckets; falling back there would invent a
  // window the authoritative source says does not exist. A supplied map that is not a record at
  // all is malformed, and a malformed authority is never silently downgraded to the legacy view.
  const rawMap = response.rateLimitsByLimitId;
  const mapSupplied = rawMap !== null && rawMap !== undefined;
  if (mapSupplied && !isRecord(rawMap)) return { status: 'error', code: CODE.badQuota };
  const byLimitId = mapSupplied ? /** @type {Record<string, unknown>} */ (rawMap) : undefined;
  const readings = [];
  const covered = new Set();
  if (byLimitId) {
    for (const key of Object.keys(byLimitId)) {
      const snapshot = byLimitId[key];
      // The schema types every map value as a RateLimitSnapshot, so a null or non-record value
      // is not "no bucket" -- it is a bucket the provider represents and this code cannot read.
      // The observation is declared `full`, and a full reading that quietly omits a represented
      // bucket is a false claim about its own completeness, so refuse rather than under-report.
      // This is the same collapse the window slots were repaired for, one level up: fixing the
      // inner level and leaving the outer one is exactly how it survived the first repair.
      if (!isSnapshotShape(snapshot) || !hasReadableLimitId(snapshot)) {
        return { status: 'error', code: CODE.badQuota };
      }
      covered.add(typeof (/** @type {any} */ (snapshot)?.limitId) === 'string' && /** @type {any} */ (snapshot).limitId ? /** @type {any} */ (snapshot).limitId : key);
      readings.push(...windowsFromSnapshot(snapshot, key));
    }
  }
  const legacy = response.rateLimits;
  // The same check at the level above the buckets: a legacy summary we are about to CONSUME
  // must be a snapshot, not merely an object.
  if (!mapSupplied && legacy !== null && legacy !== undefined
      && (!isSnapshotShape(legacy) || !hasReadableLimitId(legacy))) {
    return { status: 'error', code: CODE.badQuota };
  }
  if (isRecord(legacy)) {
    const legacyId = typeof legacy.limitId === 'string' && legacy.limitId ? legacy.limitId : 'codex';
    // Only when the authoritative map did not already carry this bucket.
    if (!mapSupplied && !covered.has(legacyId)) readings.push(...windowsFromSnapshot(legacy, legacyId));
  }
  if (readings.length === 0) return { status: 'unsupported', code: CODE.noQuota };

  const principal = validatePoolPrincipal({
    poolId: context.poolId, provider: 'codex', principalRef: accountId, identity: 'unverified',
    ...(typeof (/** @type {any} */ (legacy)?.planType) === 'string' ? { plan: /** @type {any} */ (legacy).planType } : {}),
  });
  const observation = validateCompleteObservation({
    kind: 'full', poolId: context.poolId, capturedAt: context.capturedAt,
    source: 'harness', attestation: 'cooperative', producer: context.producer, windows: readings,
  });
  return { status: 'supported', principal, observation };
}

/**
 * Run one bounded conversation with the app server and return its reply.
 *
 * Framing is one JSON object per line. Responses are correlated by request id: a frame with
 * a different id, or any notification (a frame with no id), is ignored and does NOT finish
 * the request — a sparse rate-limits notification is not a snapshot. The helper this
 * function starts is the only process it ever stops.
 * @param {{ spawn?: typeof nodeSpawn, resolveBinary?: typeof resolveCodexBinary, codexPath?: string,
 *           timeoutMs?: number, signal?: AbortSignal }} [options]
 */
export async function requestRateLimits(options = {}) {
  const spawnFn = options.spawn ?? nodeSpawn;
  const resolve = options.resolveBinary ?? resolveCodexBinary;
  const timeoutMs = options.timeoutMs ?? CODEX_LIMITS.timeoutMs;
  let command;
  try {
    command = await resolve({ bin: options.codexPath });
  } catch {
    // Not installed, or an explicit path that does not exist. Unsupported, not an error:
    // the absence of a CLI on this seat is a fact about the seat.
    return { ok: /** @type {const} */ (false), code: CODE.spawnFailed };
  }
  // Already cancelled before anything started: do not spawn at all. A process created only to
  // be abandoned can still fail asynchronously, and there is nothing to attach handlers to yet.
  if (options.signal?.aborted) return { ok: /** @type {const} */ (false), code: CODE.cancelled };
  let child;
  try {
    // Args and stdio match the measured census probe: the server needs `--stdio`, and
    // stderr is IGNORED rather than piped so a full pipe can never stall the helper and no
    // provider text is ever in reach of this process.
    child = spawnFn(command, ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  } catch {
    return { ok: /** @type {const} */ (false), code: CODE.spawnFailed };
  }

  return await new Promise((resolve) => {
    let settled = false, bytes = 0, buffer = '';
    // The read id is not a key the server may use whenever it likes: it is OURS, and it is only
    // in play once we have actually sent that request. Without this, a server that volunteers a
    // result for id 2 before the handshake completes has its unsolicited payload accepted as the
    // reading -- a request we never made, answered.
    let requested = false;
    const nextId = (() => { let n = 0; return () => ++n; })();
    const initId = nextId(), readId = nextId();
    let initialised = false;

    const finish = (/** @type {any} */ result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      // Stop only the helper this function started; never a peer process.
      try { child.kill(); } catch { /* already gone */ }
    };
    const onAbort = () => finish({ ok: false, code: CODE.cancelled });
    const timer = setTimeout(() => finish({ ok: false, code: CODE.timeout }), timeoutMs);

    // LIFECYCLE HANDLERS FIRST, before any path that can complete early. A spawned child fails
    // asynchronously (ENOENT arrives after spawn returns), so a completion that returns before
    // these are attached leaves the failure unhandled: the caller got its bounded result AND
    // then died on an uncaught error. Ordering is the fix; a later handler is no handler.
    child.on('error', () => finish({ ok: false, code: CODE.spawnFailed }));
    child.on('exit', () => finish({ ok: false, code: CODE.earlyExit }));
    child.stdin?.on('error', () => finish({ ok: false, code: CODE.transport }));
    child.stdout?.on('error', () => finish({ ok: false, code: CODE.transport }));

    if (options.signal) {
      // Aborted between the pre-spawn check and here: the handlers above are already attached.
      if (options.signal.aborted) { finish({ ok: false, code: CODE.cancelled }); return; }
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    const send = (/** @type {object} */ message) => {
      try { child.stdin?.write(`${JSON.stringify(message)}\n`); } catch { finish({ ok: false, code: CODE.protocolError }); }
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk, 'utf8');
      if (bytes > CODEX_LIMITS.maxBytes) return finish({ ok: false, code: CODE.oversized });
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.length > CODEX_LIMITS.maxLineBytes) return finish({ ok: false, code: CODE.oversized });
        if (!line.trim()) continue;
        let frame;
        try { frame = JSON.parse(line); } catch { return finish({ ok: false, code: CODE.badFrame }); }
        if (!isRecord(frame)) return finish({ ok: false, code: CODE.badFrame });
        // A notification carries no id. It never completes a request, whatever it contains.
        if (frame.id === undefined) continue;
        if (frame.id === initId && !initialised) {
          if (isRecord(frame.error)) return finish({ ok: false, code: CODE.protocolError });
          initialised = true;
          // The measured handshake: acknowledge with an `initialized` notification BEFORE the
          // read. Omitting it leaves the server waiting and the request never completes.
          send({ method: 'initialized' });
          send({ id: readId, method: 'account/rateLimits/read' });
          requested = true;
          continue;
        }
        if (frame.id === readId) {
          // A reply to a request this collector has not issued is a protocol violation by
          // definition, not a race: ids are assigned here. Refuse rather than ignore, so an
          // injected reading can never be mistaken for a late but genuine one.
          if (!requested) return finish({ ok: false, code: CODE.protocolError });
          if (isRecord(frame.error)) return finish({ ok: false, code: CODE.protocolError });
          return finish({ ok: true, result: frame.result });
        }
        // Any other id belongs to a request this collector did not make: ignore it.
      }
    });
    send({ id: initId, method: 'initialize', params: { clientInfo: { name: 'agora-usage-collector', title: 'Read-only usage collector', version: '1' }, capabilities: null } });
  });
}

/**
 * The public collector: one bounded read, normalised into the usage contract.
 *
 * The caller supplies the producer identity, generation and sequence, and the receiver
 * clock. This function creates no durable registration, admits no producer generation, and
 * stores nothing.
 * @param {{ poolId: string, producer: unknown, now: () => Date, spawn?: typeof nodeSpawn,
 *           resolveBinary?: typeof resolveCodexBinary, codexPath?: string,
 *           timeoutMs?: number, signal?: AbortSignal }} options
 * @returns {Promise<SupportedResult | UnsupportedResult>}
 */
export async function collectCodexUsage(options) {
  const capturedAt = options.now().toISOString();
  const reply = await requestRateLimits(options);
  if (!reply.ok) return { status: reply.code === CODE.badQuota ? 'error' : 'unsupported', code: reply.code };
  try {
    return normalizeRateLimitsResponse(reply.result, { poolId: options.poolId, capturedAt, producer: options.producer });
  } catch {
    // A shape the contract refuses is reported as unsupported with a bounded code. The
    // validation error carries a schema path only, and even that is not surfaced here.
    return { status: 'error', code: CODE.badQuota };
  }
}
