// @ts-check
// E1d: inventory of joined members with measured session usage or explicit unsupported.
// Membership from listRecords/sessionScope. Binding is caller-supplied and verified;
// boot epoch plus PID is never a source identity. No provider, no transcript text.
import { setTimeout as delay } from 'node:timers/promises';
import { hasRoomState, listRecords } from './session.mjs';
import { decodeSessionUsage } from './usage/session-sources.mjs';
import {
  ledgerKey, openSessionLedger, closeSessionLedger, readLedgerSnapshot, commitLedgerEvent,
} from './usage/session-ledger.mjs';

export const USAGE_SESSIONS_INTERVAL_MAX_S = 60;
export const USAGE_SESSIONS_FOR_MAX_S = 3600;

/** @typedef {{ harness: string, sessionEpoch: string, sourceId: string }} SourceBinding */
/** @typedef {{ member: string, slug: string, liveness: string, state: 'measured' | 'unsupported', reason?: string, key?: string, usage?: unknown }} MemberRow */

/**
 * @param {unknown} value
 * @returns {SourceBinding}
 */
export function readBinding(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    const err = Object.assign(new Error('binding must be an object'), { code: 'session-accounting-binding-malformed' });
    throw err;
  }
  const rec = /** @type {Record<string, unknown>} */ (value);
  const harness = rec.harness;
  const sessionEpoch = rec.sessionEpoch;
  const sourceId = rec.sourceId;
  if (typeof harness !== 'string' || !harness || typeof sessionEpoch !== 'string' || !sessionEpoch || typeof sourceId !== 'string' || !sourceId) {
    const err = Object.assign(new Error('binding requires harness, sessionEpoch, sourceId'), { code: 'session-accounting-binding-malformed' });
    throw err;
  }
  if (harness.trim() === '' || sessionEpoch.trim() === '' || sourceId.trim() === '') {
    const err = Object.assign(new Error('binding requires harness, sessionEpoch, sourceId'), { code: 'session-accounting-binding-malformed' });
    throw err;
  }
  if ('pid' in rec || 'bootEpoch' in rec) {
    const err = Object.assign(new Error('pid and bootEpoch are not a source binding'), { code: 'session-accounting-binding-inferred' });
    throw err;
  }
  return { harness, sessionEpoch, sourceId };
}

/**
 * Match on the binding triple only. sourceUnit is not assumed: Codex snapshots
 * and Amore aggregates are not requests.
 * @param {Record<string, { status: string, usage?: unknown, identity?: unknown }>} entries
 * @param {SourceBinding} binding
 */
export function findBoundEntry(entries, binding) {
  for (const [key, entry] of Object.entries(entries)) {
    const id = entry.identity;
    if (!id || typeof id !== 'object' || Array.isArray(id)) continue;
    const rec = /** @type {Record<string, unknown>} */ (id);
    if (rec.harness === binding.harness && rec.sessionEpoch === binding.sessionEpoch && rec.sourceId === binding.sourceId) {
      return { key, entry };
    }
  }
  return null;
}

/**
 * Decode one original envelope through E1b and commit the records. A decode
 * that is not supported is not stored as overlap none.
 * @param {Awaited<ReturnType<typeof openSessionLedger>>} ledger
 * @param {Record<string, unknown>} item
 * @param {{ locator: string, sourceGeneration: number, offset: number, fingerprint: string }} ingest
 */
export async function ingestEnvelope(ledger, item, ingest) {
  const decoded = decodeSessionUsage({
    harness: item.harness,
    sessionEpoch: item.sessionEpoch,
    envelope: item.envelope,
    harnessVersion: item.harnessVersion,
    context: item.context && typeof item.context === 'object' && !Array.isArray(item.context) ? item.context : {},
  });
  if (decoded.status !== 'supported') {
    return { status: decoded.status, code: decoded.code };
  }
  /** @type {{ action?: string, key: string }[]} */
  const committed = [];
  for (const record of decoded.records) {
    const result = await commitLedgerEvent(ledger, { record, ingest });
    committed.push({ action: result.action, key: ledgerKey(record.identity) });
  }
  return { status: 'ingested', committed };
}

/**
 * @param {Awaited<ReturnType<typeof openSessionLedger>>} ledger
 * @param {string} text
 * @param {string} [locator]
 */
export async function ingestJsonl(ledger, text, locator = 'ingest.jsonl') {
  const lines = text.split(/\r?\n/);
  let offset = 0;
  /** @type {unknown[]} */
  const outcomes = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    offset += 1;
    let item;
    try { item = JSON.parse(line); }
    catch {
      outcomes.push({ status: 'error', code: 'session-accounting-ingest-malformed', offset });
      continue;
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      outcomes.push({ status: 'error', code: 'session-accounting-ingest-malformed', offset });
      continue;
    }
    const rec = /** @type {Record<string, unknown>} */ (item);
    const generation = rec.sourceGeneration;
    const outcome = await ingestEnvelope(ledger, rec, {
      locator,
      sourceGeneration: typeof generation === 'number' && Number.isSafeInteger(generation) && generation >= 1 ? generation : 1,
      offset,
      fingerprint: typeof rec.fingerprint === 'string' && rec.fingerprint.trim() ? rec.fingerprint : `ingest:${offset}`,
    });
    outcomes.push({ ...outcome, offset });
  }
  return outcomes;
}

/**
 * @param {Array<{ slug: string, dir: string, record?: { bearer?: string }, state: string }>} records
 * @param {{ roomKey?: string, bindings: Record<string, unknown>, snapshot: { entries: Record<string, { status: string, usage?: unknown, identity?: unknown }> } }} opts
 * @returns {Promise<MemberRow[]>}
 */
export async function inventoryMembers(records, opts) {
  /** @type {MemberRow[]} */
  const rows = [];
  for (const r of records) {
    if (opts.roomKey && !(await hasRoomState(r.dir, opts.roomKey))) continue;
    const member = r.record?.bearer || r.slug;
    const raw = opts.bindings[r.slug];
    if (raw === undefined) {
      rows.push({ member, slug: r.slug, liveness: r.state, state: 'unsupported', reason: 'unknown-binding' });
      continue;
    }
    let binding;
    try { binding = readBinding(raw); }
    catch (error) {
      rows.push({
        member, slug: r.slug, liveness: r.state, state: 'unsupported',
        reason: /** @type {{ code?: string }} */ (error).code ?? 'session-accounting-binding-malformed',
      });
      continue;
    }
    const found = findBoundEntry(opts.snapshot.entries, binding);
    if (!found || !found.entry.usage || (found.entry.status !== 'confirmed' && found.entry.status !== 'provisional')) {
      rows.push({ member, slug: r.slug, liveness: r.state, state: 'unsupported', reason: 'usage-unavailable', key: found?.key });
      continue;
    }
    rows.push({ member, slug: r.slug, liveness: r.state, state: 'measured', key: found.key, usage: found.entry.usage });
  }
  return rows;
}

/** Never render a missing counter as zero. */
export function publicRow(/** @type {MemberRow} */ row) {
  /** @type {Record<string, unknown>} */
  const out = { member: row.member, slug: row.slug, liveness: row.liveness, state: row.state };
  if (row.reason) out.reason = row.reason;
  if (row.key) out.key = row.key;
  if (row.state === 'measured' && row.usage) out.usage = row.usage;
  return out;
}

/**
 * @param {MemberRow[]} rows
 * @param {{ json?: boolean }} opts
 */
export function formatInventory(rows, opts) {
  if (opts.json) return `${JSON.stringify({ type: 'usage-sessions', members: rows.map(publicRow) })}\n`;
  const lines = rows.map((row) => {
    if (row.state === 'unsupported') return `${row.member} ${row.slug} ${row.liveness} unsupported ${row.reason}`;
    return `${row.member} ${row.slug} ${row.liveness} measured`;
  });
  return `${lines.join('\n')}${lines.length ? '\n' : ''}`;
}

/**
 * @param {{
 *   stateRoot: string,
 *   ledgerRoot: string,
 *   bindings: Record<string, unknown>,
 *   roomKey?: string,
 *   json?: boolean,
 *   follow?: boolean,
 *   intervalMs?: number,
 *   forMs?: number,
 *   signal?: AbortSignal,
 *   list?: typeof listRecords,
 *   ingestText?: string,
 *   ingestLocator?: string,
 * }} opts
 */
export async function collectUsageSessions(opts) {
  if (opts.signal?.aborted) {
    const err = Object.assign(new Error('usage-sessions cancelled'), { code: 'session-accounting-cancelled' });
    throw err;
  }
  const records = await (opts.list ?? listRecords)(opts.stateRoot);
  const ledger = await openSessionLedger({ root: opts.ledgerRoot, limits: { maxBytes: 2_000_000, maxEntries: 4096 } });
  try {
    if (opts.ingestText) await ingestJsonl(ledger, opts.ingestText, opts.ingestLocator ?? 'ingest.jsonl');
    const snapshot = readLedgerSnapshot(ledger);
    return inventoryMembers(records, { roomKey: opts.roomKey, bindings: opts.bindings, snapshot });
  } finally {
    await closeSessionLedger(ledger);
  }
}

/**
 * One-shot or follow. Follow emits a snapshot each interval until --for or abort.
 * A one-shot is not a continuous mode.
 * @param {Parameters<typeof collectUsageSessions>[0] & { json?: boolean, follow?: boolean, intervalMs?: number, forMs?: number, write?: (text: string) => void }} opts
 */
export async function runUsageSessions(opts) {
  const write = opts.write ?? ((text) => { process.stdout.write(text); });
  const started = Date.now();
  const once = async () => {
    const rows = await collectUsageSessions(opts);
    write(formatInventory(rows, { json: opts.json }));
    return rows;
  };
  if (!opts.follow) return { rows: await once(), polls: 1 };
  let polls = 0;
  const interval = opts.intervalMs ?? 1000;
  const budget = opts.forMs ?? USAGE_SESSIONS_FOR_MAX_S * 1000;
  while (!opts.signal?.aborted) {
    await once();
    polls += 1;
    if (Date.now() - started + interval >= budget) break;
    try {
      await delay(interval, undefined, { signal: opts.signal });
    } catch (error) {
      if (opts.signal?.aborted || /** @type {{ name?: string }} */ (error).name === 'AbortError') {
        const err = Object.assign(new Error('usage-sessions cancelled'), { code: 'session-accounting-cancelled' });
        throw err;
      }
      throw error;
    }
  }
  if (opts.signal?.aborted) {
    const err = Object.assign(new Error('usage-sessions cancelled'), { code: 'session-accounting-cancelled' });
    throw err;
  }
  return { rows: [], polls };
}

/**
 * @param {{
 *   ledgerRoot?: string,
 *   bindPath?: string,
 *   roomKey?: string,
 *   json?: boolean,
 *   follow?: boolean,
 *   interval?: string,
 *   forSeconds?: string,
 *   ingestPath?: string,
 *   stateRoot: string,
 *   signal?: AbortSignal,
 * }} args
 */
export async function runUsageSessionsCli(args) {
  if (!args.ledgerRoot) {
    return { exit: 2, stdout: '', stderr: 'agora: --ledger-root is required\n' };
  }
  const { readFile } = await import('node:fs/promises');
  /** @type {Record<string, unknown>} */
  let bindings = {};
  if (args.bindPath) {
    try {
      bindings = JSON.parse(await readFile(args.bindPath, 'utf8'));
      if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) {
        return { exit: 2, stdout: '', stderr: 'agora: --bind must be a JSON object\n' };
      }
    } catch {
      return { exit: 2, stdout: '', stderr: 'agora: --bind is not readable JSON\n' };
    }
  }
  let ingestText;
  if (args.ingestPath) {
    try { ingestText = await readFile(args.ingestPath, 'utf8'); }
    catch { return { exit: 2, stdout: '', stderr: 'agora: --ingest is not readable\n' }; }
  }
  let intervalMs = 1000;
  let forMs = 15_000;
  if (args.interval !== undefined) {
    if (!/^[0-9]+$/.test(args.interval)) return { exit: 2, stdout: '', stderr: 'agora: --interval must be a positive integer number of seconds\n' };
    const n = Number(args.interval);
    if (n < 1 || n > USAGE_SESSIONS_INTERVAL_MAX_S) return { exit: 2, stdout: '', stderr: `agora: --interval must be 1..${USAGE_SESSIONS_INTERVAL_MAX_S}\n` };
    intervalMs = n * 1000;
  }
  if (args.forSeconds !== undefined) {
    if (!/^[0-9]+$/.test(args.forSeconds)) return { exit: 2, stdout: '', stderr: 'agora: --for must be a positive integer number of seconds\n' };
    const n = Number(args.forSeconds);
    if (n < 1 || n > USAGE_SESSIONS_FOR_MAX_S) return { exit: 2, stdout: '', stderr: `agora: --for must be 1..${USAGE_SESSIONS_FOR_MAX_S}\n` };
    forMs = n * 1000;
  }
  try {
    const chunks = /** @type {string[]} */ ([]);
    await runUsageSessions({
      stateRoot: args.stateRoot,
      ledgerRoot: args.ledgerRoot,
      bindings,
      roomKey: args.roomKey,
      json: args.json,
      follow: args.follow,
      intervalMs,
      forMs,
      signal: args.signal,
      ingestText,
      ingestLocator: args.ingestPath,
      write: (t) => { chunks.push(t); },
    });
    return { exit: 0, stdout: chunks.join(''), stderr: '' };
  } catch (error) {
    const code = /** @type {{ code?: string }} */ (error).code;
    if (code === 'session-accounting-cancelled') return { exit: 1, stdout: '', stderr: 'agora: usage-sessions cancelled\n' };
    return { exit: 1, stdout: '', stderr: `agora: ${/** @type {Error} */ (error).message}\n` };
  }
}
