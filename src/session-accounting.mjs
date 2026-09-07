// @ts-check
// E1d: inventory of joined members with measured session usage or explicit unsupported.
// Membership from listRecords/sessionScope. Binding is caller-supplied and verified;
// boot epoch plus PID is never a source identity. No provider, no transcript text.
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { hasRoomState, listRecords } from './session.mjs';
import { decodeSessionUsage } from './usage/session-sources.mjs';
import {
  ledgerKey, openSessionLedger, closeSessionLedger, readLedgerSnapshot, commitLedgerEvent, deriveTotals,
} from './usage/session-ledger.mjs';

export const USAGE_SESSIONS_INTERVAL_MAX_S = 60;
export const USAGE_SESSIONS_FOR_MAX_S = 3600;
// Sized so maxEntries is reachable after E2a-pre retention. Pre-retention measurement
// on 2059 real envelopes: 1,999,116 bytes ≈ 971 bytes/entry. Retention adds
// observedAt plus optional model and every sourceReported* (~200 bytes). 4096 * 1200
// = 4,915,200; default maxBytes 6_000_000 leaves headroom.
export const DEFAULT_LEDGER_MAX_BYTES = 6_000_000;
export const DEFAULT_LEDGER_MAX_ENTRIES = 4096;

/** @typedef {{ harness: string, sessionEpoch: string }} SourceBinding */
/** @typedef {{ member: string, slug: string, liveness: string, state: 'measured' | 'unsupported', reason?: string, usage?: unknown, status?: string, entryCount?: number, provisionalCount?: number }} MemberRow */

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
  if ('sourceId' in rec) {
    const err = Object.assign(
      new Error('sourceId is not a binding field; bind harness and sessionEpoch'),
      { code: 'session-accounting-binding-source-id' },
    );
    throw err;
  }
  const harness = rec.harness;
  const sessionEpoch = rec.sessionEpoch;
  if (typeof harness !== 'string' || !harness || typeof sessionEpoch !== 'string' || !sessionEpoch) {
    const err = Object.assign(new Error('binding requires harness, sessionEpoch'), { code: 'session-accounting-binding-malformed' });
    throw err;
  }
  if (harness.trim() === '' || sessionEpoch.trim() === '') {
    const err = Object.assign(new Error('binding requires harness, sessionEpoch'), { code: 'session-accounting-binding-malformed' });
    throw err;
  }
  if ('pid' in rec || 'bootEpoch' in rec) {
    const err = Object.assign(new Error('pid and bootEpoch are not a source binding'), { code: 'session-accounting-binding-inferred' });
    throw err;
  }
  return { harness, sessionEpoch };
}

/**
 * Match on harness + sessionEpoch. sourceId is not a binding field.
 * @param {Record<string, { status: string, usage?: unknown, identity?: unknown }>} entries
 * @param {SourceBinding} binding
 */
export function findBoundEntries(entries, binding) {
  /** @type {Record<string, { status: string, usage?: unknown, identity?: unknown }>} */
  const matched = {};
  for (const [key, entry] of Object.entries(entries)) {
    const id = entry.identity;
    if (!id || typeof id !== 'object' || Array.isArray(id)) continue;
    const rec = /** @type {Record<string, unknown>} */ (id);
    if (rec.harness === binding.harness && rec.sessionEpoch === binding.sessionEpoch) {
      matched[key] = entry;
    }
  }
  return matched;
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

/** @param {string} line */
export function lineFingerprint(line) {
  return `sha256:${createHash('sha256').update(line).digest('hex')}`;
}

/**
 * Non-empty JSONL lines, numbered from 1. Tail past a persisted locator
 * position when the line at that offset still matches the stored fingerprint.
 * A shorter file, a missing line, or a fingerprint mismatch is a rotation:
 * new generation, ingest from line one.
 * @param {string} text
 * @param {string} locator
 * @param {{ locator: string, sourceGeneration: number, offset: number, fingerprint?: string } | null} [lastIngest]
 */
export function selectIngestLines(text, locator, lastIngest = null) {
  const raw = text.split(/\r?\n/).filter((line) => line.trim());
  let generation = 1;
  let start = 0;
  if (lastIngest && lastIngest.locator === locator) {
    const atOffset = raw[lastIngest.offset - 1];
    const rotated = raw.length < lastIngest.offset
      || atOffset === undefined
      || (typeof lastIngest.fingerprint === 'string' && lastIngest.fingerprint.length > 0
        && lineFingerprint(atOffset) !== lastIngest.fingerprint);
    if (rotated) {
      generation = lastIngest.sourceGeneration + 1;
      start = 0;
    } else {
      generation = lastIngest.sourceGeneration;
      start = lastIngest.offset;
    }
  }
  return {
    generation,
    items: raw.slice(start).map((line, i) => ({ offset: start + i + 1, line })),
  };
}

/**
 * @param {unknown[]} outcomes
 */
export function summarizeIngest(outcomes) {
  const stats = { ingested: 0, duplicate: 0, unsupported: 0, malformed: 0, failedOffsets: /** @type {number[]} */ ([]) };
  for (const raw of outcomes) {
    const o = /** @type {{ status?: string, offset?: number, committed?: { action?: string }[] }} */ (raw);
    if (o.status === 'ingested') {
      const action = o.committed?.[0]?.action;
      if (action === 'duplicate') stats.duplicate += 1;
      else stats.ingested += 1;
    } else if (o.status === 'unsupported') {
      stats.unsupported += 1;
      if (typeof o.offset === 'number') stats.failedOffsets.push(o.offset);
    } else {
      stats.malformed += 1;
      if (typeof o.offset === 'number') stats.failedOffsets.push(o.offset);
    }
  }
  return stats;
}

/**
 * @param {Awaited<ReturnType<typeof openSessionLedger>>} ledger
 * @param {{ offset: number, line: string }[]} items
 * @param {string} locator
 * @param {number} generation
 */
export async function ingestJsonlLines(ledger, items, locator, generation) {
  /** @type {unknown[]} */
  const outcomes = [];
  for (const item of items) {
    let parsed;
    try { parsed = JSON.parse(item.line); }
    catch {
      outcomes.push({ status: 'error', code: 'session-accounting-ingest-malformed', offset: item.offset });
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      outcomes.push({ status: 'error', code: 'session-accounting-ingest-malformed', offset: item.offset });
      continue;
    }
    const rec = /** @type {Record<string, unknown>} */ (parsed);
    const outcome = await ingestEnvelope(ledger, rec, {
      locator,
      sourceGeneration: generation,
      offset: item.offset,
      fingerprint: lineFingerprint(item.line),
    });
    outcomes.push({ ...outcome, offset: item.offset });
  }
  return outcomes;
}

/**
 * @param {Awaited<ReturnType<typeof openSessionLedger>>} ledger
 * @param {string} text
 * @param {string} [locator]
 */
export async function ingestJsonl(ledger, text, locator = 'ingest.jsonl') {
  const planned = selectIngestLines(text, locator, null);
  return ingestJsonlLines(ledger, planned.items, locator, planned.generation);
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
    const matched = findBoundEntries(opts.snapshot.entries, binding);
    const entryCount = Object.keys(matched).length;
    if (entryCount === 0) {
      rows.push({ member, slug: r.slug, liveness: r.state, state: 'unsupported', reason: 'no-ledger-entries' });
      continue;
    }
    if (Object.values(matched).some((entry) => entry.status === 'conflict')) {
      rows.push({ member, slug: r.slug, liveness: r.state, state: 'unsupported', reason: 'usage-unavailable' });
      continue;
    }
    const totals = deriveTotals(/** @type {any} */ (matched));
    const provisionalCount = totals.request.provisional.length
      + totals.aggregate.provisional.length
      + totals.snapshot.provisional.length;
    rows.push({
      member, slug: r.slug, liveness: r.state, state: 'measured',
      usage: totals,
      status: provisionalCount > 0 ? 'provisional' : 'confirmed',
      entryCount,
      provisionalCount,
    });
  }
  return rows;
}

/** Never render a missing counter as zero. */
export function publicRow(/** @type {MemberRow} */ row) {
  /** @type {Record<string, unknown>} */
  const out = { member: row.member, slug: row.slug, liveness: row.liveness, state: row.state };
  if (row.reason) out.reason = row.reason;
  if (row.state === 'measured' && row.usage) out.usage = row.usage;
  if (row.state === 'measured' && row.status) out.status = row.status;
  if (row.state === 'measured' && row.entryCount !== undefined) out.entryCount = row.entryCount;
  if (row.state === 'measured' && row.provisionalCount !== undefined) out.provisionalCount = row.provisionalCount;
  return out;
}

/**
 * @param {MemberRow[]} rows
 * @param {{ json?: boolean, ingest?: ReturnType<typeof summarizeIngest> }} opts
 */
export function formatInventory(rows, opts) {
  if (opts.json) {
    /** @type {Record<string, unknown>} */
    const body = { type: 'usage-sessions', members: rows.map(publicRow) };
    if (opts.ingest) body.ingest = opts.ingest;
    return `${JSON.stringify(body)}\n`;
  }
  const lines = rows.map((row) => {
    if (row.state === 'unsupported') return `${row.member} ${row.slug} ${row.liveness} unsupported ${row.reason}`;
    return `${row.member} ${row.slug} ${row.liveness} measured`;
  });
  return `${lines.join('\n')}${lines.length ? '\n' : ''}`;
}

/** @param {ReturnType<typeof summarizeIngest>} ingest */
export function formatIngestStderr(ingest) {
  const failed = ingest.failedOffsets.length ? ` offsets=${ingest.failedOffsets.join(',')}` : '';
  return `agora: ingest ingested=${ingest.ingested} duplicate=${ingest.duplicate} unsupported=${ingest.unsupported} malformed=${ingest.malformed}${failed}\n`;
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
 *   ingestPath?: string,
 *   ingestLocator?: string,
 *   maxBytes?: number,
 *   maxEntries?: number,
 * }} opts
 */
export async function collectUsageSessions(opts) {
  if (opts.signal?.aborted) {
    const err = Object.assign(new Error('usage-sessions cancelled'), { code: 'session-accounting-cancelled' });
    throw err;
  }
  const records = await (opts.list ?? listRecords)(opts.stateRoot);
  const ledger = await openSessionLedger({
    root: opts.ledgerRoot,
    limits: {
      maxBytes: opts.maxBytes ?? DEFAULT_LEDGER_MAX_BYTES,
      maxEntries: opts.maxEntries ?? DEFAULT_LEDGER_MAX_ENTRIES,
    },
  });
  try {
    /** @type {ReturnType<typeof summarizeIngest> | undefined} */
    let ingest;
    let text = opts.ingestText;
    const locator = opts.ingestLocator ?? opts.ingestPath ?? 'ingest.jsonl';
    if (!text && opts.ingestPath) {
      const { readFile } = await import('node:fs/promises');
      text = await readFile(opts.ingestPath, 'utf8');
    }
    if (text !== undefined) {
      const snapshotBefore = readLedgerSnapshot(ledger);
      const last = snapshotBefore.ingest && snapshotBefore.ingest.locator === locator
        ? {
          locator: snapshotBefore.ingest.locator,
          sourceGeneration: snapshotBefore.ingest.sourceGeneration,
          offset: snapshotBefore.ingest.offset,
          fingerprint: snapshotBefore.ingest.fingerprint,
        }
        : null;
      const planned = selectIngestLines(text, locator, last);
      const outcomes = await ingestJsonlLines(ledger, planned.items, locator, planned.generation);
      ingest = summarizeIngest(outcomes);
    }
    const snapshot = readLedgerSnapshot(ledger);
    const rows = await inventoryMembers(records, { roomKey: opts.roomKey, bindings: opts.bindings, snapshot });
    return { rows, ingest };
  } finally {
    await closeSessionLedger(ledger);
  }
}

/**
 * One-shot or follow. Follow emits a snapshot each interval until --for or abort.
 * A one-shot is not a continuous mode.
 * @param {Parameters<typeof collectUsageSessions>[0] & { json?: boolean, follow?: boolean, intervalMs?: number, forMs?: number, write?: (text: string) => void, writeErr?: (text: string) => void }} opts
 */
export async function runUsageSessions(opts) {
  const write = opts.write ?? ((text) => { process.stdout.write(text); });
  const writeErr = opts.writeErr ?? ((text) => { process.stderr.write(text); });
  const started = Date.now();
  const once = async () => {
    const { rows, ingest } = await collectUsageSessions(opts);
    write(formatInventory(rows, { json: opts.json, ingest }));
    if (ingest && !opts.json) writeErr(formatIngestStderr(ingest));
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
 *   maxBytes?: number,
 *   maxEntries?: number,
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
  if (args.ingestPath) {
    try { await readFile(args.ingestPath, 'utf8'); }
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
    const errChunks = /** @type {string[]} */ ([]);
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
      ingestPath: args.ingestPath,
      ingestLocator: args.ingestPath,
      maxBytes: args.maxBytes,
      maxEntries: args.maxEntries,
      write: (t) => { chunks.push(t); },
      writeErr: (t) => { errChunks.push(t); },
    });
    return { exit: 0, stdout: chunks.join(''), stderr: errChunks.join('') };
  } catch (error) {
    const code = /** @type {{ code?: string }} */ (error).code;
    if (code === 'session-accounting-cancelled') return { exit: 1, stdout: '', stderr: 'agora: usage-sessions cancelled\n' };
    return { exit: 1, stdout: '', stderr: `agora: ${/** @type {Error} */ (error).message}\n` };
  }
}
