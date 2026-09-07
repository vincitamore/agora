// @ts-check
/**
 * E1b: usage-only source adapters.
 *
 * One original usage envelope plus explicit harness/version/session context
 * produces zero or more session-usage records, or a bounded non-value. No
 * network, no corpus, no clamp, no invented request identity, no raw keys.
 *
 * Records are the E1a contract at src/protocol/session-usage.mjs. This module
 * does not restate that shape.
 */
import { validateSessionUsageRecord } from '../protocol/session-usage.mjs';

/** @typedef {{ state: 'known', value: number, unit: string }} KnownCounter */
/** @typedef {{ state: 'unknown', reason?: string }} UnknownCounter */
/** @typedef {{ state: 'invalid', reason?: string }} InvalidCounter */
/** @typedef {{ state: 'not-applicable', reason?: string }} NotApplicableCounter */
/** @typedef {KnownCounter | UnknownCounter | InvalidCounter | NotApplicableCounter} Counter */

export const SESSION_SOURCE_HARNESSES = Object.freeze(['claude-code', 'omp', 'codex', 'amore-build']);

export const SESSION_SOURCE_CODES = Object.freeze({
  unknownHarness: 'session-source-harness-unknown',
  missingEnvelope: 'session-source-envelope-missing',
  envelopeUnusable: 'session-source-envelope-unusable',
  identityMissing: 'session-source-identity-missing',
  identityMalformed: 'session-source-identity-malformed',
  observedAtMissing: 'session-source-observed-at-missing',
});

const CODE = SESSION_SOURCE_CODES;
const TOKEN = 'tokens';

/** @typedef {{ status: 'error', code: string, reason?: string }} DecodeError */
/** @typedef {{ status: 'supported', records: ReturnType<typeof validateSessionUsageRecord>[] } | { status: 'unsupported', code: string, reason?: string } | DecodeError } DecodeResult */
/** @typedef {{ missing: true }} Missing */
/** @typedef {{ malformed: true, reason: string }} Malformed */
/** @typedef {{ id: string }} OpaqueId */
/** @typedef {{ value: string }} ObservedAt */
/** @typedef {{ cacheWrite5m: Counter, cacheWrite1h: Counter, cacheWriteUnknownTtl: Counter | null }} WriteSet */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {string} [unit]
 * @returns {KnownCounter | InvalidCounter}
 */
export function knownCount(value, unit = TOKEN) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < 0) {
    return { state: 'invalid', reason: 'count-not-safe-nonnegative-integer' };
  }
  return { state: 'known', value, unit };
}

/** @param {string} [reason] @returns {UnknownCounter} */
export function unknownCount(reason) {
  return reason === undefined ? { state: 'unknown' } : { state: 'unknown', reason };
}

/** @param {string} [reason] @returns {InvalidCounter} */
export function invalidCount(reason) {
  return reason === undefined ? { state: 'invalid' } : { state: 'invalid', reason };
}

/** @returns {NotApplicableCounter} */
export function notApplicableCount() {
  return { state: 'not-applicable' };
}

/**
 * Absent is unknown. Null or non-number is invalid. Safe nonnegative integers are known.
 * Zero is a known value. Nothing clamps.
 * @param {unknown} record
 * @param {string} field
 * @returns {Counter}
 */
export function readCountField(record, field) {
  if (!isRecord(record) || !Object.hasOwn(record, field)) return unknownCount(`absent:${field}`);
  const value = record[field];
  if (value === null) return invalidCount(`null:${field}`);
  if (typeof value !== 'number') return invalidCount(`type:${field}`);
  return knownCount(value);
}

/**
 * Uncached = input − known cache parts. Never clamp.
 * @param {Counter} input
 * @param {Counter[]} subtract
 * @returns {Counter}
 */
export function disjointUncached(input, subtract) {
  if (input.state !== 'known') return input;
  let used = 0;
  for (const part of subtract) {
    if (part.state === 'not-applicable') continue;
    if (part.state === 'invalid') return invalidCount(part.reason ?? 'invalid-cache-part');
    if (part.state !== 'known') return unknownCount('uncached-depends-on-unknown-cache');
    used += part.value;
  }
  if (used > input.value) return invalidCount('cache-exceeds-input');
  return knownCount(input.value - used);
}

/**
 * @param {{ harness?: unknown, harnessVersion?: unknown, sourceVersion?: unknown, sessionEpoch?: unknown, envelope?: unknown, context?: unknown }} input
 * @returns {DecodeResult}
 */
export function decodeSessionUsage(input) {
  if (!isRecord(input)) return { status: 'error', code: CODE.envelopeUnusable };
  const harness = input.harness;
  if (typeof harness !== 'string' || !SESSION_SOURCE_HARNESSES.includes(harness)) {
    return { status: 'unsupported', code: CODE.unknownHarness };
  }
  if (!Object.hasOwn(input, 'envelope') || input.envelope === undefined) {
    return { status: 'error', code: CODE.missingEnvelope };
  }
  const epoch = readOpaqueId(input.sessionEpoch, 'sessionEpoch');
  if ('missing' in epoch) return { status: 'error', code: CODE.identityMissing, reason: 'sessionEpoch' };
  if ('malformed' in epoch) return { status: 'error', code: CODE.identityMalformed, reason: epoch.reason };
  const harnessVersion = typeof input.harnessVersion === 'string'
    ? input.harnessVersion
    : typeof input.sourceVersion === 'string'
      ? input.sourceVersion
      : undefined;
  const context = isRecord(input.context) ? input.context : {};
  const observedAt = readObservedAt(input.envelope, context);
  if ('missing' in observedAt) return { status: 'error', code: CODE.observedAtMissing };
  if ('malformed' in observedAt) return { status: 'error', code: CODE.identityMalformed, reason: observedAt.reason };

  if (harness === 'claude-code') {
    return wrap(decodeClaude(input.envelope, epoch.id, harnessVersion, observedAt.value, context));
  }
  if (harness === 'omp') {
    return wrap(decodeOmp(input.envelope, epoch.id, harnessVersion, observedAt.value, context));
  }
  if (harness === 'codex') {
    return wrap(decodeCodex(input.envelope, epoch.id, harnessVersion, observedAt.value, context));
  }
  return wrap(decodeAmore(input.envelope, epoch.id, harnessVersion, observedAt.value, context));
}

/** @param {unknown} result @returns {DecodeResult} */
function wrap(result) {
  if (isRecord(result) && typeof result.status === 'string' && result.status !== 'supported') {
    return /** @type {DecodeResult} */ (result);
  }
  const records = Array.isArray(result) ? result : [result];
  try {
    return { status: 'supported', records: records.map((record) => validateSessionUsageRecord(record)) };
  } catch (error) {
    const field = error && typeof error === 'object' && 'field' in error ? String(error.field) : 'record';
    return { status: 'error', code: CODE.envelopeUnusable, reason: `contract:${field}` };
  }
}

/**
 * @param {unknown} envelope
 * @param {string} sessionEpoch
 * @param {string | undefined} harnessVersion
 * @param {string} observedAt
 * @param {Record<string, unknown>} context
 */
function decodeClaude(envelope, sessionEpoch, harnessVersion, observedAt, context) {
  if (!isRecord(envelope) || !isRecord(envelope.message)) return fail(CODE.envelopeUnusable);
  const message = envelope.message;
  const sourceId = firstOpaqueId([
    ['message.id', message.id],
    ['requestId', envelope.requestId],
    ['uuid', envelope.uuid],
  ]);
  if ('missing' in sourceId) return fail(CODE.identityMissing, 'message.id');
  if ('malformed' in sourceId) return fail(CODE.identityMalformed, sourceId.reason);
  if (!isRecord(message.usage)) return fail(CODE.envelopeUnusable);

  const usage = message.usage;
  const writes = readClaudeWrites(usage);
  if ('status' in writes) return writes;
  return makeRecord({
    harness: 'claude-code',
    harnessVersion,
    sessionEpoch,
    sourceId: sourceId.id,
    sourceUnit: 'request',
    finality: 'unknown',
    observedAt,
    model: readModelLabel(message.model),
    input: readCountField(usage, 'input_tokens'),
    output: readCountField(usage, 'output_tokens'),
    cacheRead: readCountField(usage, 'cache_read_input_tokens'),
    cacheWrite5m: writes.cacheWrite5m,
    cacheWrite1h: writes.cacheWrite1h,
    cacheWriteUnknownTtl: writes.cacheWriteUnknownTtl,
    subtractWrites: writes.cacheWriteUnknownTtl
      ? [writes.cacheWriteUnknownTtl]
      : [writes.cacheWrite5m, writes.cacheWrite1h],
    overlap: overlapFrom(context),
  });
}

/**
 * @param {unknown} envelope
 * @param {string} sessionEpoch
 * @param {string | undefined} harnessVersion
 * @param {string} observedAt
 * @param {Record<string, unknown>} context
 */
function decodeOmp(envelope, sessionEpoch, harnessVersion, observedAt, context) {
  if (!isRecord(envelope) || !isRecord(envelope.message)) return fail(CODE.envelopeUnusable);
  const message = envelope.message;
  const sourceId = firstOpaqueId([
    ['message.id', message.id],
    ['id', envelope.id],
    ['requestId', envelope.requestId],
  ]);
  if ('missing' in sourceId) return fail(CODE.identityMissing, 'message.id');
  if ('malformed' in sourceId) return fail(CODE.identityMalformed, sourceId.reason);
  if (!isRecord(message.usage)) return fail(CODE.envelopeUnusable);

  const usage = message.usage;
  const writes = readOmpWrites(usage);
  if ('status' in writes) return writes;
  return makeRecord({
    harness: 'omp',
    harnessVersion,
    sessionEpoch,
    sourceId: sourceId.id,
    sourceUnit: 'request',
    finality: 'unknown',
    observedAt,
    model: readModelLabel(message.model),
    input: readCountField(usage, 'input'),
    output: readCountField(usage, 'output'),
    cacheRead: readCountField(usage, 'cacheRead'),
    cacheWrite5m: writes.cacheWrite5m,
    cacheWrite1h: writes.cacheWrite1h,
    cacheWriteUnknownTtl: writes.cacheWriteUnknownTtl,
    subtractWrites: writes.cacheWriteUnknownTtl
      ? [writes.cacheWriteUnknownTtl]
      : [writes.cacheWrite5m, writes.cacheWrite1h],
    overlap: overlapFrom(context),
  });
}

/**
 * @param {unknown} envelope
 * @param {string} sessionEpoch
 * @param {string | undefined} harnessVersion
 * @param {string} observedAt
 * @param {Record<string, unknown>} context
 */
function decodeCodex(envelope, sessionEpoch, harnessVersion, observedAt, context) {
  if (!isRecord(envelope) || !isRecord(envelope.payload)) return fail(CODE.envelopeUnusable);
  const payload = envelope.payload;
  if (payload.type !== 'token_count' || !isRecord(payload.info)) return fail(CODE.envelopeUnusable);
  const last = payload.info.last_token_usage;
  if (last === undefined || last === null || !isRecord(last)) return fail(CODE.envelopeUnusable);

  const sourceId = readOpaqueId(context.sourceId, 'context.sourceId');
  if ('missing' in sourceId) return fail(CODE.identityMissing, 'codex-source-id-not-watermark');
  if ('malformed' in sourceId) return fail(CODE.identityMalformed, sourceId.reason);

  return makeRecord({
    harness: 'codex',
    harnessVersion,
    sessionEpoch,
    sourceId: sourceId.id,
    sourceUnit: 'cumulative-snapshot',
    finality: 'unknown',
    observedAt,
    model: Object.hasOwn(context, 'model') ? readModelLabel(context.model) : undefined,
    input: readCountField(last, 'input_tokens'),
    output: readCountField(last, 'output_tokens'),
    cacheRead: readCountField(last, 'cached_input_tokens'),
    cacheWrite5m: readCountField(last, 'cache_write_input_tokens'),
    cacheWrite1h: unknownCount('codex-cache-write-1h-unsupported'),
    cacheWriteUnknownTtl: null,
    subtractWrites: [readCountField(last, 'cache_write_input_tokens')],
    overlap: overlapFrom(context),
  });
}

/**
 * @param {unknown} envelope
 * @param {string} sessionEpoch
 * @param {string | undefined} harnessVersion
 * @param {string} observedAt
 * @param {Record<string, unknown>} context
 */
function decodeAmore(envelope, sessionEpoch, harnessVersion, observedAt, context) {
  if (!isRecord(envelope) || !isRecord(envelope.params) || !isRecord(envelope.params.update)) {
    return fail(CODE.envelopeUnusable);
  }
  const update = envelope.params.update;
  if (update.sessionUpdate !== 'turn_completed') return fail(CODE.envelopeUnusable);
  if (!isRecord(update.usage)) return fail(CODE.envelopeUnusable);

  const promptId = readOpaqueId(update.prompt_id, 'prompt_id');
  if ('missing' in promptId) return fail(CODE.identityMissing, 'prompt_id');
  if ('malformed' in promptId) return fail(CODE.identityMalformed, promptId.reason);

  const modelUsage = update.usage.modelUsage;
  if (modelUsage === undefined || modelUsage === null) return fail(CODE.identityMissing, 'modelUsage');
  if (!isRecord(modelUsage)) return fail(CODE.envelopeUnusable);
  const models = Object.keys(modelUsage);
  if (models.length === 0) return { status: 'unsupported', code: CODE.identityMissing, reason: 'modelUsage-empty' };

  /** @type {object[]} */
  const records = [];
  for (const model of models) {
    const entry = modelUsage[model];
    if (!isRecord(entry)) return fail(CODE.envelopeUnusable);
    const sourceId = readOpaqueId(`${promptId.id}:${model}`, 'prompt_id:model');
    if ('malformed' in sourceId) return fail(CODE.identityMalformed, sourceId.reason);
    if ('missing' in sourceId) return fail(CODE.identityMissing, 'prompt_id:model');
    records.push(makeRecord({
      harness: 'amore-build',
      harnessVersion,
      sessionEpoch,
      sourceId: sourceId.id,
      sourceUnit: 'aggregate',
      finality: 'final',
      observedAt,
      model: readModelLabel(model),
      input: readCountField(entry, 'inputTokens'),
      output: readCountField(entry, 'outputTokens'),
      cacheRead: readCountField(entry, 'cachedReadTokens'),
      cacheWrite5m: readCountField(entry, 'cacheCreationTokens'),
      cacheWrite1h: unknownCount('amore-cache-write-1h-unsupported'),
      cacheWriteUnknownTtl: null,
      subtractWrites: [readCountField(entry, 'cacheCreationTokens')],
      overlap: overlapFrom(context),
    }));
  }
  return records;
}

/** @param {Record<string, unknown>} usage @returns {WriteSet | DecodeError} */
function readClaudeWrites(usage) {
  if (Object.hasOwn(usage, 'cache_creation')) {
    const creation = usage.cache_creation;
    if (creation === null) {
      return {
        cacheWrite5m: invalidCount('null:cache_creation'),
        cacheWrite1h: invalidCount('null:cache_creation'),
        cacheWriteUnknownTtl: null,
      };
    }
    if (!isRecord(creation)) return fail(CODE.envelopeUnusable);
    return {
      cacheWrite5m: readCountField(creation, 'ephemeral_5m_input_tokens'),
      cacheWrite1h: readCountField(creation, 'ephemeral_1h_input_tokens'),
      cacheWriteUnknownTtl: null,
    };
  }
  if (Object.hasOwn(usage, 'cache_creation_input_tokens')) {
    return {
      cacheWrite5m: unknownCount('ttl-split-absent'),
      cacheWrite1h: unknownCount('ttl-split-absent'),
      cacheWriteUnknownTtl: readCountField(usage, 'cache_creation_input_tokens'),
    };
  }
  return {
    cacheWrite5m: unknownCount('absent:cache_creation'),
    cacheWrite1h: unknownCount('absent:cache_creation'),
    cacheWriteUnknownTtl: unknownCount('absent:cache_creation'),
  };
}

/** @param {Record<string, unknown>} usage @returns {WriteSet | DecodeError} */
function readOmpWrites(usage) {
  if (Object.hasOwn(usage, 'cttl')) {
    const cttl = usage.cttl;
    if (cttl === null) {
      return {
        cacheWrite5m: invalidCount('null:cttl'),
        cacheWrite1h: invalidCount('null:cttl'),
        cacheWriteUnknownTtl: null,
      };
    }
    if (!isRecord(cttl)) return fail(CODE.envelopeUnusable);
    return {
      cacheWrite5m: readCountField(cttl, 'ephemeral5m'),
      cacheWrite1h: readCountField(cttl, 'ephemeral1h'),
      cacheWriteUnknownTtl: null,
    };
  }
  if (Object.hasOwn(usage, 'cacheWrite')) {
    return {
      cacheWrite5m: unknownCount('ttl-split-absent'),
      cacheWrite1h: unknownCount('ttl-split-absent'),
      cacheWriteUnknownTtl: readCountField(usage, 'cacheWrite'),
    };
  }
  return {
    cacheWrite5m: unknownCount('absent:cacheWrite'),
    cacheWrite1h: unknownCount('absent:cacheWrite'),
    cacheWriteUnknownTtl: unknownCount('absent:cacheWrite'),
  };
}

/**
 * @param {string} code
 * @param {string} [reason]
 * @returns {DecodeError}
 */
function fail(code, reason) {
  return reason ? { status: 'error', code, reason } : { status: 'error', code };
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {OpaqueId | Missing | Malformed}
 */
function readOpaqueId(value, field) {
  if (value === undefined) return { missing: true };
  if (value === null) return { malformed: true, reason: `null:${field}` };
  if (typeof value !== 'string') return { malformed: true, reason: `type:${field}` };
  if (value.length === 0 || Buffer.byteLength(value, 'utf8') > 512) {
    return { malformed: true, reason: `length:${field}` };
  }
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) return { malformed: true, reason: `controls:${field}` };
  return { id: value };
}

/**
 * @param {Array<[string, unknown]>} candidates
 * @returns {OpaqueId | Missing | Malformed}
 */
function firstOpaqueId(candidates) {
  for (const [field, value] of candidates) {
    if (value === undefined) continue;
    return readOpaqueId(value, field);
  }
  return { missing: true };
}

/** @param {unknown} value @returns {string | undefined} */
function readModelLabel(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') return undefined;
  if (value.length > 128 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return undefined;
  return value;
}

/**
 * Exact ISO-8601 instants only. Caller-supplied context.observedAt wins; otherwise
 * envelope.timestamp or Amore agentTimestampMs, normalized to Date.toISOString().
 * @param {unknown} envelope
 * @param {Record<string, unknown>} context
 */
/** @param {unknown} envelope @param {Record<string, unknown>} context @returns {ObservedAt | Missing | Malformed} */
function readObservedAt(envelope, context) {
  if (Object.hasOwn(context, 'observedAt')) return exactIso(context.observedAt, 'context.observedAt');
  if (isRecord(envelope) && Object.hasOwn(envelope, 'timestamp')) return exactIso(envelope.timestamp, 'timestamp');
  if (isRecord(envelope) && isRecord(envelope.params) && isRecord(envelope.params._meta)) {
    const ms = envelope.params._meta.agentTimestampMs;
    if (typeof ms === 'number' && Number.isFinite(ms)) {
      return exactIso(new Date(ms).toISOString(), 'agentTimestampMs');
    }
  }
  return { missing: true };
}

/** @param {unknown} value @param {string} field @returns {ObservedAt | Malformed} */
function exactIso(value, field) {
  if (typeof value !== 'string') return { malformed: true, reason: `type:${field}` };
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return { malformed: true, reason: `unparseable:${field}` };
  return { value: date.toISOString() };
}

/** @param {Record<string, unknown>} context */
function overlapFrom(context) {
  if (isRecord(context.overlap)) return context.overlap;
  return { relation: 'none' };
}

/**
 * @param {{
 *   harness: string,
 *   harnessVersion: string | undefined,
 *   sessionEpoch: string,
 *   sourceId: string,
 *   sourceUnit: string,
 *   finality: string,
 *   observedAt: string,
 *   model: string | undefined,
 *   input: Counter,
 *   output: Counter,
 *   cacheRead: Counter,
 *   cacheWrite5m: Counter,
 *   cacheWrite1h: Counter,
 *   cacheWriteUnknownTtl: Counter | null,
 *   subtractWrites: Counter[],
 *   overlap: unknown,
 * }} parts
 */
function makeRecord(parts) {
  const subtract = [parts.cacheRead, ...parts.subtractWrites];

  /** @type {Record<string, Counter>} */
  const components = {
    'uncached-input': disjointUncached(parts.input, subtract),
    'cached-input': parts.cacheRead,
    'cache-write-5m': parts.cacheWrite5m,
    'cache-write-1h': parts.cacheWrite1h,
    output: parts.output,
    'reasoning-billed': unknownCount('reasoning-inclusion-unknown'),
    tool: unknownCount('tool-not-in-source-contract'),
  };
  if (parts.cacheWriteUnknownTtl) components['cache-write-unknown-ttl'] = parts.cacheWriteUnknownTtl;

  const coverage = Object.values(components).every((counter) => counter.state === 'known' || counter.state === 'not-applicable')
    ? 'complete'
    : 'partial';

  /** @type {Record<string, unknown>} */
  const identity = {
    harness: parts.harness,
    sessionEpoch: parts.sessionEpoch,
    sourceId: parts.sourceId,
    sourceUnit: parts.sourceUnit,
    finality: parts.finality,
  };
  if (parts.harnessVersion !== undefined) identity.harnessVersion = parts.harnessVersion;

  /** @type {Record<string, unknown>} */
  const record = {
    identity,
    observedAt: parts.observedAt,
    usage: {
      components,
      coverage,
      overlap: parts.overlap,
    },
  };
  if (parts.model !== undefined) record.model = parts.model;
  return record;
}
