// @ts-check
// E1c: pure revision reconciliation and a bounded local durable ledger.
// Consumes E1a session-usage records, not transcript text. Persistence is
// caller-rooted files only: no shared service, no network, no provider.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { ProtocolValidationError, readInteger, readRecord, readString } from '../protocol/common.mjs';
import {
  isSummableUnit, ledgerKey, supersedesContribution, validateComponentSet,
  validateSessionUsageRecord, validateSourceIdentity,
} from '../protocol/session-usage.mjs';

export { ledgerKey };

/** @typedef {'confirmed'|'provisional'|'conflict'|'gap'} EntryStatus */
/** @typedef {'accept'|'replace'|'duplicate'|'conflict'|'ignore-partial'|'reset'|'gap'} ReconcileAction */
/** @typedef {ReturnType<typeof validateSessionUsageRecord>} SessionUsageRecord */
/** @typedef {SessionUsageRecord['identity']} SourceIdentity */
/** @typedef {{ components: Record<string, {state:string, value?:number, unit?:string, reason?:string}>, coverage: string, overlap?: { relation: string, peerKey?: string } }} ComponentSet */

export const LEDGER_STATE_VERSION = 1;

export class LedgerError extends Error {
  /** @param {string} code @param {string} [detail] */
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'LedgerError';
    this.code = code;
  }
}

/** @param {unknown} value @returns {string} */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`;
  const rec = /** @type {Record<string, unknown>} */ (value);
  const keys = Object.keys(rec).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(rec[k])}`).join(',')}}`;
}

/** @param {unknown} identity @param {unknown} usage */
export function fingerprintRecord(identity, usage) {
  const digest = createHash('sha256').update(canonical({ identity, usage })).digest('hex');
  return `sha256:${digest}`;
}

/** @param {unknown} value */
export function readIngestPosition(value) {
  const v = readRecord(value, ['locator', 'sourceGeneration', 'offset', 'fingerprint']);
  return {
    locator: readString(v.locator, 'locator', { min: 1, max: 512, controls: true }),
    sourceGeneration: readInteger(v.sourceGeneration, 'sourceGeneration', 1),
    offset: readInteger(v.offset, 'offset', 0),
    fingerprint: readString(v.fingerprint, 'fingerprint', { min: 1, max: 128, pattern: /^[A-Za-z0-9:_-]{1,128}$/ }),
  };
}

/**
 * @typedef {{ identity: SourceIdentity, usage: ComponentSet, status: EntryStatus, digest: string, reason?: string }} StoredEntry
 * @typedef {{ identity: SourceIdentity, usage: ComponentSet, digest: string, reset?: boolean, ingest?: ReturnType<typeof readIngestPosition>, priorIngest?: ReturnType<typeof readIngestPosition> | null }} Candidate
 */

/**
 * Pure. Never selects max-output or last-arrival when ordering is not evidenced.
 * @param {StoredEntry | null} accepted
 * @param {Candidate} candidate
 */
export function reconcileRevision(accepted, candidate) {
  const incoming = candidate.identity;
  if (!accepted) {
    if (incoming.sourceUnit === 'cumulative-snapshot' && candidate.reset) {
      return { action: /** @type {ReconcileAction} */ ('reset'), status: /** @type {EntryStatus} */ ('confirmed') };
    }
    if (incoming.finality === 'streaming-partial' || incoming.finality === 'unknown') {
      return { action: /** @type {ReconcileAction} */ ('accept'), status: /** @type {EntryStatus} */ ('provisional') };
    }
    return { action: /** @type {ReconcileAction} */ ('accept'), status: /** @type {EntryStatus} */ ('confirmed') };
  }
  if (accepted.digest === candidate.digest) {
    return { action: /** @type {ReconcileAction} */ ('duplicate'), status: accepted.status };
  }
  if (incoming.sourceUnit !== accepted.identity.sourceUnit) {
    return { action: /** @type {ReconcileAction} */ ('conflict'), status: /** @type {EntryStatus} */ ('conflict'), reason: 'source-unit-mismatch' };
  }
  if (incoming.sourceUnit === 'cumulative-snapshot') {
    const decreased = cumulativeDecreased(accepted.usage, candidate.usage);
    const rotated = Boolean(
      candidate.ingest && candidate.priorIngest
      && candidate.ingest.sourceGeneration > candidate.priorIngest.sourceGeneration,
    );
    if (decreased && !(candidate.reset || rotated)) {
      return { action: /** @type {ReconcileAction} */ ('gap'), status: /** @type {EntryStatus} */ ('gap'), reason: 'cumulative-decrease-without-reset' };
    }
    if (candidate.reset || rotated) {
      return { action: /** @type {ReconcileAction} */ ('reset'), status: /** @type {EntryStatus} */ ('confirmed') };
    }
    return { action: /** @type {ReconcileAction} */ ('replace'), status: /** @type {EntryStatus} */ ('confirmed') };
  }
  if (incoming.finality === 'streaming-partial' && accepted.status === 'confirmed'
      && (accepted.identity.finality === 'final' || accepted.identity.finality === 'revision')) {
    return { action: /** @type {ReconcileAction} */ ('ignore-partial'), status: accepted.status };
  }
  if (supersedesContribution(incoming, accepted.identity)) {
    return { action: /** @type {ReconcileAction} */ ('replace'), status: /** @type {EntryStatus} */ ('confirmed') };
  }
  return { action: /** @type {ReconcileAction} */ ('conflict'), status: /** @type {EntryStatus} */ ('conflict'), reason: 'ordering-unproven' };
}

/** @param {ComponentSet} prior @param {ComponentSet} next */
function cumulativeDecreased(prior, next) {
  for (const name of Object.keys(prior.components)) {
    const a = prior.components[name];
    const b = next.components[name];
    if (!a || !b || a.state !== 'known' || b.state !== 'known') continue;
    const av = a.value;
    const bv = b.value;
    if (typeof av === 'number' && typeof bv === 'number' && bv < av) return true;
  }
  return false;
}

function emptyTotals() {
  return {
    components: /** @type {Record<string, {state:string, value?:number, unit?:string, reason?:string}>} */ (Object.create(null)),
    excluded: /** @type {{ key: string, reason: string }[]} */ ([]),
    conflicts: /** @type {string[]} */ ([]),
    gaps: /** @type {unknown[]} */ ([]),
  };
}

/** @param {Record<string, StoredEntry>} entries @param {string | undefined} key */
function isConfirmedEntry(entries, key) {
  return typeof key === 'string' && entries[key]?.status === 'confirmed';
}

/**
 * Own declarations first so a two-sided pair keeps the child's reason, then
 * contains-child names a peer by ledger key. A stub peerKey that is not an
 * entry key excludes nobody.
 * @param {Record<string, StoredEntry>} entries
 * @returns {Map<string, string>}
 */
function overlapSkipReasons(entries) {
  /** @type {Map<string, string>} */
  const skip = new Map();
  for (const [key, entry] of Object.entries(entries)) {
    if (entry.status !== 'confirmed') continue;
    const relation = entry.usage.overlap?.relation;
    const peer = entry.usage.overlap?.peerKey;
    if (relation === 'contained-in-parent') {
      skip.set(key, isConfirmedEntry(entries, peer) ? 'contained-in-parent' : 'parent-absent');
    } else if (relation === 'unknown') {
      skip.set(key, 'overlap-unknown');
    }
  }
  for (const entry of Object.values(entries)) {
    if (entry.status !== 'confirmed') continue;
    if (entry.usage.overlap?.relation !== 'contains-child') continue;
    const peer = entry.usage.overlap.peerKey;
    if (isConfirmedEntry(entries, peer) && peer && !skip.has(peer)) skip.set(peer, 'parent-declared');
  }
  return skip;
}

/** @param {Record<string, StoredEntry>} entries */
export function deriveTotals(entries) {
  const request = emptyTotals();
  const aggregate = emptyTotals();
  const snapshot = emptyTotals();
  const skip = overlapSkipReasons(entries);
  for (const [key, entry] of Object.entries(entries)) {
    if (entry.status !== 'confirmed') {
      if (entry.status === 'conflict') request.conflicts.push(key);
      if (entry.status === 'gap') request.gaps.push({ key, reason: entry.reason ?? 'gap' });
      continue;
    }
    const bucket = isSummableUnit(entry.identity) ? request
      : entry.identity.sourceUnit === 'aggregate' ? aggregate
        : snapshot;
    const reason = skip.get(key);
    if (reason) {
      bucket.excluded.push({ key, reason });
      continue;
    }
    mergeComponents(bucket.components, entry.usage.components);
  }
  return { request, aggregate, snapshot };
}

/**
 * @param {Record<string, {state:string, value?:number, unit?:string, reason?:string}>} into
 * @param {ComponentSet['components']} from
 */
function mergeComponents(into, from) {
  for (const name of Object.keys(from)) {
    if (name === 'reasoning-billed') continue;
    const next = from[name];
    const cur = into[name];
    if (!cur) {
      into[name] = next.state === 'known'
        ? { state: 'known', value: next.value, unit: next.unit }
        : { state: next.state, reason: next.reason };
      continue;
    }
    if (cur.state === 'invalid' || next.state === 'invalid') {
      into[name] = { state: 'invalid', reason: 'invalid-component' };
      continue;
    }
    if (cur.state === 'unknown' || next.state === 'unknown') {
      into[name] = { state: 'unknown', reason: 'incomplete' };
      continue;
    }
    if (cur.state === 'not-applicable' && next.state === 'not-applicable') continue;
    if (cur.state === 'not-applicable') {
      into[name] = next.state === 'known'
        ? { state: 'known', value: next.value, unit: next.unit }
        : { state: next.state, reason: next.reason };
      continue;
    }
    if (next.state === 'not-applicable') continue;
    if (cur.unit !== next.unit) {
      into[name] = { state: 'invalid', reason: 'unit-mismatch' };
      continue;
    }
    into[name] = { state: 'known', value: /** @type {number} */ (cur.value) + /** @type {number} */ (next.value), unit: cur.unit };
  }
}

/** @param {string} directory */
async function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r');
  try { await handle.sync(); }
  finally { await handle.close(); }
}

/** @param {string} file @param {string} text */
async function writeDurableAtomic(file, text) {
  const parent = path.dirname(file);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  let renamed = false;
  let durable = false;
  /** @type {unknown} */
  let primaryError;
  try {
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(text, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temp, file);
    renamed = true;
    await syncDirectory(parent);
    durable = true;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try { await rm(temp, { force: true }); }
    catch (cleanupError) {
      if (!primaryError && !(renamed && durable)) throw cleanupError;
    }
  }
}

function emptyState() {
  return {
    version: LEDGER_STATE_VERSION,
    ledgerGeneration: 1,
    ingest: /** @type {ReturnType<typeof readIngestPosition> | null} */ (null),
    entries: /** @type {Record<string, StoredEntry>} */ (Object.create(null)),
    gaps: /** @type {unknown[]} */ ([]),
  };
}

/** @param {number} pid */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    return false;
  }
}

/** @param {string} lockPath */
async function acquireLock(lockPath) {
  try {
    return await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') throw error;
    let text;
    try { text = await readFile(lockPath, 'utf8'); }
    catch { throw new LedgerError('ledger-busy'); }
    const pid = Number.parseInt(text.trim(), 10);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pidAlive(pid)) throw new LedgerError('ledger-busy');
    await rm(lockPath, { force: true });
    try {
      return await open(lockPath, 'wx', 0o600);
    } catch (retry) {
      if (/** @type {NodeJS.ErrnoException} */ (retry).code === 'EEXIST') throw new LedgerError('ledger-busy');
      throw retry;
    }
  }
}

/** @param {unknown} parsed */
function loadState(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new LedgerError('ledger-corrupt', 'state-shape');
  const rec = /** @type {Record<string, unknown>} */ (parsed);
  if (rec.version !== LEDGER_STATE_VERSION || typeof rec.entries !== 'object' || rec.entries === null || Array.isArray(rec.entries)) {
    throw new LedgerError('ledger-corrupt', 'state-shape');
  }
  if (rec.ingest !== null && rec.ingest !== undefined) {
    try { readIngestPosition(rec.ingest); }
    catch { throw new LedgerError('ledger-corrupt', 'ingest'); }
  }
  for (const entry of Object.values(/** @type {Record<string, unknown>} */ (rec.entries))) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new LedgerError('ledger-corrupt', 'entry');
    const row = /** @type {Record<string, unknown>} */ (entry);
    try {
      validateSourceIdentity(row.identity);
      validateComponentSet(row.usage);
    } catch {
      throw new LedgerError('ledger-corrupt', 'entry');
    }
    if (typeof row.status !== 'string' || !['confirmed', 'provisional', 'conflict', 'gap'].includes(row.status)) {
      throw new LedgerError('ledger-corrupt', 'entry');
    }
  }
  return /** @type {ReturnType<typeof emptyState>} */ (parsed);
}

/**
 * @param {ReturnType<typeof emptyState>} next
 * @param {ReturnType<typeof readIngestPosition>} ingest
 */
function applyIngest(next, ingest) {
  if (next.ingest && ingest.sourceGeneration === next.ingest.sourceGeneration && ingest.offset < next.ingest.offset) {
    throw new LedgerError('ledger-ingest-rewind');
  }
  if (next.ingest && ingest.sourceGeneration === next.ingest.sourceGeneration && ingest.offset > next.ingest.offset + 1) {
    next.gaps = [...next.gaps, { kind: 'offset-skip', from: next.ingest.offset, to: ingest.offset, locator: ingest.locator }];
  }
  next.ingest = ingest;
}

/**
 * @param {{ root:string, limits:{ maxBytes:number, maxEntries:number }, io?: { writeAtomic?: (file:string, text:string)=>Promise<void> } }} options
 */
export async function openSessionLedger(options) {
  if (!options || typeof options.root !== 'string' || options.root.length === 0) throw new LedgerError('ledger-root-required');
  const limits = options.limits;
  if (!limits || !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1 || !Number.isSafeInteger(limits.maxEntries) || limits.maxEntries < 1) {
    throw new LedgerError('ledger-limits-required');
  }
  const root = path.resolve(options.root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lockPath = path.join(root, 'writer.lock');
  const statePath = path.join(root, 'state.json');
  /** @type {import('node:fs/promises').FileHandle} */
  let lock;
  try { lock = await acquireLock(lockPath); }
  catch (error) {
    throw error;
  }
  try { await lock.writeFile(String(process.pid), 'utf8'); }
  catch (error) {
    await lock.close().catch(() => {});
    await rm(lockPath, { force: true }).catch(() => {});
    throw error;
  }
  let state = emptyState();
  try {
    const raw = await readFile(statePath, 'utf8');
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { throw new LedgerError('ledger-corrupt', 'json'); }
    state = loadState(parsed);
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code !== 'ENOENT') {
      await lock.close().catch(() => {});
      await rm(lockPath, { force: true }).catch(() => {});
      if (error instanceof LedgerError) throw error;
      throw error;
    }
  }
  return { root, lockPath, statePath, lock, limits, io: options.io ?? {}, state, closed: false };
}

/** @param {Awaited<ReturnType<typeof openSessionLedger>>} ledger */
export async function closeSessionLedger(ledger) {
  if (ledger.closed) return;
  ledger.closed = true;
  try { await ledger.lock.close(); }
  finally { await rm(ledger.lockPath, { force: true }); }
}

/**
 * Atomically persist the ingest position and the reconciled contribution.
 * @param {Awaited<ReturnType<typeof openSessionLedger>>} ledger
 * @param {{ record: unknown, ingest: unknown, reset?: boolean }} event
 */
export async function commitLedgerEvent(ledger, event) {
  if (ledger.closed) throw new LedgerError('ledger-closed');
  const record = validateSessionUsageRecord(event.record);
  const ingest = readIngestPosition(event.ingest);
  if (event.reset !== undefined && typeof event.reset !== 'boolean') throw new ProtocolValidationError('type', 'reset');
  const key = ledgerKey(record.identity);
  const digest = fingerprintRecord(record.identity, record.usage);
  const prior = ledger.state.entries[key] ?? null;
  const result = reconcileRevision(prior, {
    identity: record.identity,
    usage: record.usage,
    digest,
    reset: event.reset === true,
    ingest,
    priorIngest: ledger.state.ingest,
  });
  const next = structuredClone(ledger.state);
  applyIngest(next, ingest);
  if (result.action === 'duplicate' || result.action === 'ignore-partial') {
    const text = JSON.stringify(next);
    if (Buffer.byteLength(text, 'utf8') > ledger.limits.maxBytes) throw new LedgerError('ledger-limit', 'bytes');
    try {
      if (ledger.io.writeAtomic) await ledger.io.writeAtomic(ledger.statePath, text);
      else await writeDurableAtomic(ledger.statePath, text);
    } catch (error) {
      if (error instanceof LedgerError) throw error;
      throw new LedgerError('ledger-write-failed');
    }
    ledger.state = next;
    return { action: result.action, status: result.status, key, digest, duplicate: result.action === 'duplicate' };
  }
  if (result.action === 'gap') {
    next.gaps = [...next.gaps, { kind: 'cumulative-decrease-without-reset', key, reason: result.reason }];
    next.entries[key] = { status: 'gap', reason: result.reason, identity: record.identity, usage: record.usage, digest };
  } else if (result.action === 'conflict') {
    next.entries[key] = {
      status: 'conflict', reason: result.reason, identity: record.identity, usage: record.usage, digest,
    };
  } else {
    next.entries[key] = { status: result.status, identity: record.identity, usage: record.usage, digest };
  }
  if (Object.keys(next.entries).length > ledger.limits.maxEntries) throw new LedgerError('ledger-limit', 'entries');
  const text = JSON.stringify(next);
  if (Buffer.byteLength(text, 'utf8') > ledger.limits.maxBytes) throw new LedgerError('ledger-limit', 'bytes');
  try {
    if (ledger.io.writeAtomic) await ledger.io.writeAtomic(ledger.statePath, text);
    else await writeDurableAtomic(ledger.statePath, text);
  } catch (error) {
    if (error instanceof LedgerError) throw error;
    throw new LedgerError('ledger-write-failed');
  }
  ledger.state = next;
  return { action: result.action, status: result.status, key, digest, duplicate: false, reason: result.reason };
}

/** @param {Awaited<ReturnType<typeof openSessionLedger>>} ledger */
export function readLedgerSnapshot(ledger) {
  if (ledger.closed) throw new LedgerError('ledger-closed');
  return {
    version: ledger.state.version,
    ledgerGeneration: ledger.state.ledgerGeneration,
    ingest: ledger.state.ingest,
    entries: ledger.state.entries,
    gaps: ledger.state.gaps,
    totals: deriveTotals(ledger.state.entries),
  };
}
