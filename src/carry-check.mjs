// @ts-check
// Cooperative recovery evidence, not authentication or a same-user tamper barrier.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { AgoraError, readCursorFile } from './core.mjs';
import { readArray, readEnum, readRecord, readString, readTimestamp } from './protocol/common.mjs';
import { matchesAddress, parseTrailers } from './trailers.mjs';

export class CarryCheckError extends AgoraError {
  /** @param {string} code */
  constructor(code) { super(code); this.name = 'CarryCheckError'; this.code = code; }
}
/** @param {unknown} value */
const label = (value) => readString(value, 'label', { min: 1, max: 512, controls: true });
/** @param {unknown} value */
export function validateMandate(value) {
  try {
    const v = readRecord(value, ['version', 'id', 'bearer', 'role', 'units', 'issuedBy', 'issuedAt']);
    if (v.version !== 1) throw new Error('version');
    const units = readArray(v.units, 'units', 4096, (item) => {
      const u = readRecord(item, ['id', 'exhibit']);
      return { id: label(u.id), exhibit: label(u.exhibit) };
    });
    if (new Set(units.map(u => u.id)).size !== units.length) throw new Error('duplicate');
    return { version: 1, id: label(v.id), bearer: label(v.bearer), role: label(v.role),
      units, issuedBy: label(v.issuedBy), issuedAt: readTimestamp(v.issuedAt) };
  } catch { throw new CarryCheckError('mandate-malformed'); }
}

/** Digest of validated semantic fields, independent of JSON whitespace/key order.
 * @param {unknown} value */
export function mandateDigest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(validateMandate(value))).digest('hex')}`;
}

/** Missing AND unreadable source are missing evidence, not an empty assignment.
 * @param {string | undefined} file
 * @returns {Promise<{mandate:ReturnType<typeof validateMandate>|null,digest:string|null,issues:string[]}>} */
export async function readMandate(file) {
  if (!file) return { mandate: null, digest: null, issues: ['assignment-source-missing', 'role-source-missing'] };
  let bytes;
  try {
    const handle = await open(file, 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 1024 * 1024) throw new Error('not bounded file');
      bytes = await handle.readFile('utf8');
      if (Buffer.byteLength(bytes) > 1024 * 1024) throw new Error('grew');
    } finally { await handle.close(); }
  } catch { return { mandate: null, digest: null, issues: ['assignment-source-missing', 'role-source-missing'] }; }
  try {
    const mandate = validateMandate(JSON.parse(bytes));
    return { mandate, digest: mandateDigest(mandate), issues: [] };
  } catch { return { mandate: null, digest: null, issues: ['mandate-malformed', 'assignment-source-missing', 'role-source-missing'] }; }
}

/** A ref always includes its room. Equal message IDs on two rooms are not one obligation.
 * @param {unknown} value */
export function validateCarryRef(value) {
  const v = readRecord(value, ['room', 'id', 'cursor']);
  return { room: label(v.room), id: label(v.id), cursor: label(v.cursor) };
}
/** @param {{room:string,id:string,cursor:string}} ref */
export const carryRefKey = (ref) => JSON.stringify([ref.room, ref.id, ref.cursor]);

/** Schema of a pinned pre-boundary expectation. It is NOT produced by a fresh
 * post-boundary room fold. Receipt IDs name the independent durable ledger.
 * @param {unknown} value */
export function validateCarryBoundary(value) {
  const v = readRecord(value, ['version', 'id', 'createdAt', 'session', 'bearer', 'mandatePath', 'mandateDigest',
    'cursors', 'claims', 'deliveries', 'retractions', 'watermark', 'gaps']);
  if (v.version !== 1) throw new CarryCheckError('carry-boundary-version');
  const s = readRecord(v.session, ['slug', 'source']);
  const cursors = readArray(v.cursors, 'cursors', 4096, item => {
    const c = readRecord(item, ['key', 'cursor']);
    return { key: label(c.key), cursor: c.cursor === null ? null : label(c.cursor) };
  });
  const refs = (/** @type {unknown} */ items) => readArray(items, 'refs', 65536, item => {
    const e = readRecord(item, ['eventId', 'ref']);
    return { eventId: label(e.eventId), ref: validateCarryRef(e.ref) };
  });
  return { version: 1, id: label(v.id), createdAt: readTimestamp(v.createdAt),
    session: { slug: label(s.slug), source: label(s.source) }, bearer: label(v.bearer),
    mandatePath: label(v.mandatePath), mandateDigest: label(v.mandateDigest), cursors,
    claims: refs(v.claims), deliveries: refs(v.deliveries), retractions: refs(v.retractions),
    watermark: readArray(v.watermark, 'watermark', 65536, label), gaps: readArray(v.gaps, 'gaps', 65536, label) };
}

/** Pure gate over an independently saved expectation and observed resumed state.
 * Explicit account rows are cooperative declarations of the successor's next action,
 * not claims of human comprehension. A delivery requires named reply/ack evidence;
 * generic later speech cannot satisfy it. Filesystem/CLI integration supplies these
 * rows from durable evidence, never from the bounded carry report.
 * @param {unknown} expected
 * @param {{session:{slug:string,source:string}, registeredBearer:string|null,
 * mandate:Awaited<ReturnType<typeof readMandate>>,
 * cursors:Map<string,string|null>, evidence:ReturnType<typeof validateCarryEvent>[],
 * evidenceIssues:string[], accounted:Array<{kind:string,id:string,exhibit:string}>,
 * successorOf?:string}} actual */
export function checkCarryBoundary(expected, actual) {
  const b = validateCarryBoundary(expected);
  /** @type {Array<{code:string,item:string}>} */ const issues = [];
  const fail = (/** @type {string} */ code, /** @type {string} */ item) => issues.push({ code, item });
  const accounted = (/** @type {string} */ kind, /** @type {string} */ id) =>
    actual.accounted.some(a => a.kind === kind && a.id === id && a.exhibit.trim().length > 0);
  if (actual.registeredBearer !== b.bearer) fail('bearer-registration-missing', b.bearer);
  if (actual.session.slug !== b.session.slug && actual.successorOf !== b.session.slug)
    fail('session-key-mismatch', b.session.slug);
  if (actual.session.slug === b.session.slug && actual.session.source !== b.session.source)
    fail('session-source-mismatch', b.session.source);
  if (!actual.session.source || actual.session.source === 'default') fail('session-source-missing', actual.session.slug);
  for (const code of actual.mandate.issues) fail(code, b.mandatePath);
  const mandate = actual.mandate.mandate;
  if (mandate) {
    if (actual.mandate.digest !== b.mandateDigest) fail('mandate-digest-mismatch', b.mandatePath);
    if (mandate.bearer !== b.bearer) fail('mandate-bearer-mismatch', mandate.bearer);
    if (!accounted('role', mandate.role)) fail('role-unaccounted', mandate.role);
    for (const unit of mandate.units) if (!accounted('unit', unit.id)) fail('unit-unaccounted', unit.id);
  }
  for (const cursor of b.cursors) {
    if (!actual.cursors.has(cursor.key)) fail('cursor-missing', cursor.key);
    // A changed position needs independently recorded coverage, never lexical cursor arithmetic.
    else if (actual.cursors.get(cursor.key) !== cursor.cursor && !accounted('cursor', cursor.key))
      fail('cursor-coverage-unknown', cursor.key);
  }
  const events = new Map(actual.evidence.map(e => [e.id, e]));
  for (const id of b.watermark) if (!events.has(id)) fail('evidence-missing', id);
  for (const item of [...b.gaps, ...actual.evidenceIssues]) fail('delivery-coverage-unknown', item);
  for (const event of actual.evidence) if (event.kind === 'gap' && !actual.evidence.some(e =>
    e.kind === 'coverage' && e.targets.includes(event.id) && e.session === event.session && e.ref.room === event.ref.room))
    fail('delivery-coverage-unknown', event.id);
  const addressedBySuccessor = (/** @type {ReturnType<typeof validateCarryEvent>} */ e) =>
    e.session === actual.session.slug && e.bearer === actual.registeredBearer;
  for (const claim of b.claims) {
    const origin = events.get(claim.eventId);
    if (!origin || origin.kind !== 'claim' || carryRefKey(origin.ref) !== carryRefKey(claim.ref)) fail('claim-evidence-missing', claim.eventId);
    if (!accounted('claim', claim.eventId)) fail('claim-unaccounted', claim.eventId);
  }
  for (const retraction of b.retractions) {
    const origin = events.get(retraction.eventId);
    if (!origin || !['release', 'withdrawal'].includes(origin.kind) || carryRefKey(origin.ref) !== carryRefKey(retraction.ref))
      fail('retraction-evidence-missing', retraction.eventId);
    if (!accounted('retraction', retraction.eventId)) fail('retraction-unaccounted', retraction.eventId);
  }
  const deliveries = new Map(b.deliveries.map(d => [d.eventId, d]));
  // A delivery prepared across the boundary must not disappear because it was not
  // in the earlier snapshot. Union durable in-flight arrivals with saved expectations.
  for (const e of actual.evidence) if (e.kind === 'delivery-prepared' && e.bearer === b.bearer
    && [b.session.slug, actual.session.slug].includes(e.session) && e.to.length)
    deliveries.set(e.id, { eventId: e.id, ref: e.ref });
  for (const delivery of deliveries.values()) {
    const prepared = events.get(delivery.eventId);
    if (!prepared || prepared.kind !== 'delivery-prepared' || carryRefKey(prepared.ref) !== carryRefKey(delivery.ref)) {
      fail('delivery-evidence-missing', delivery.eventId); continue;
    }
    const accepted = actual.evidence.some(e => e.kind === 'delivery-accepted' && e.targets.includes(delivery.eventId)
      && e.session === prepared.session && e.bearer === prepared.bearer && carryRefKey(e.ref) === carryRefKey(delivery.ref));
    if (!accepted) fail('delivery-unconfirmed', delivery.eventId);
    const answered = actual.evidence.some(e => e.kind === 'answer' && addressedBySuccessor(e)
      && e.targets.includes(delivery.eventId) && e.ref.room === delivery.ref.room);
    if (!answered) fail('delivery-unanswered', delivery.eventId);
  }
  return { version: 1, type: 'carry-check', boundary: b.id, ok: issues.length === 0, issues };
}

/** Read a previously sealed boundary and check against THIS session's files.
 * No room read and no fresh carry derivation can replace the expected set.
 * @param {string} dir @param {string} boundaryFile
 * @param {{session:{slug:string,source:string},registeredBearer:string|null,accountFile?:string}} context */
export async function checkCarryFiles(dir, boundaryFile, context) {
  let boundary;
  try { boundary = validateCarryBoundary(JSON.parse(await readFile(boundaryFile, 'utf8'))); }
  catch { return { version: 1, type: 'carry-check', boundary: boundaryFile, ok: false,
    issues: [{ code: 'carry-boundary-unreadable', item: boundaryFile }] }; }
  const source = await readMandate(boundary.mandatePath);
  const evidence = await readCarryEvidence(dir);
  /** @type {Map<string,string|null>} */ const cursors = new Map();
  for (const expected of boundary.cursors) {
    // Keys came from the sealed schema, but still may not escape the session dir.
    if (/[\\/]/.test(expected.key) || expected.key === '.' || expected.key === '..') {
      evidence.issues.push(`cursor-key-invalid:${expected.key}`); continue;
    }
    try {
      const c = await readCursorFile(dir, expected.key);
      if (c.exists) cursors.set(expected.key, c.cursor ?? null);
    } catch { evidence.issues.push(`cursor-unreadable:${expected.key}`); }
  }
  /** @type {Array<{kind:string,id:string,exhibit:string}>} */ let accounted = [];
  if (context.accountFile) {
    try {
      const v = readRecord(JSON.parse(await readFile(context.accountFile, 'utf8')), ['version', 'boundary', 'session', 'items']);
      if (v.version !== 1 || v.boundary !== boundary.id || v.session !== context.session.slug)
        throw new Error('account context');
      accounted = readArray(v.items, 'items', 65536, item => {
        const a = readRecord(item, ['kind', 'id', 'exhibit']);
        return { kind: readEnum(a.kind, 'kind', ['role', 'unit', 'claim', 'retraction', 'cursor']), id: label(a.id), exhibit: label(a.exhibit) };
      });
    } catch { evidence.issues.push('carry-account-unreadable'); }
  }
  return checkCarryBoundary(boundary, { ...context, mandate: source, cursors,
    evidence: evidence.events, evidenceIssues: evidence.issues, accounted });
}

/** Seal current durable obligations without replacing missing historical coverage
 * with an empty list. The caller supplies the cursor inventory read before sealing.
 * New arrivals remain covered by the check's union with the continuing evidence log.
 * @param {string} dir @param {string} output
 * @param {{session:{slug:string,source:string},bearer:string,mandatePath:string,
 * cursors:Array<{key:string,cursor:string|null}>}} context */
export async function sealCarryBoundary(dir, output, context) {
  const source = await readMandate(context.mandatePath);
  if (!source.mandate || !source.digest) throw new CarryCheckError(source.issues.join(', '));
  if (source.mandate.bearer !== context.bearer) throw new CarryCheckError('mandate-bearer-mismatch');
  const { events, issues } = await readCarryEvidence(dir);
  const mine = events.filter(e => e.bearer === context.bearer && e.session === context.session.slug);
  const targeted = new Set(mine.filter(e => ['release', 'withdrawal', 'answer'].includes(e.kind)).flatMap(e => e.targets));
  const ref = (/** @type {ReturnType<typeof validateCarryEvent>} */ e) => ({ eventId: e.id, ref: e.ref });
  let completeOrigin = false;
  try {
    const origin = readRecord(JSON.parse(await readFile(path.join(dir, 'carry-origin.json'), 'utf8')),
      ['version', 'session', 'bearer', 'commitmentsComplete']);
    completeOrigin = origin.version === 1 && origin.session === context.session.slug
      && origin.bearer === context.bearer && origin.commitmentsComplete === true;
  } catch { /* missing/corrupt historical provenance is not completeness */ }
  const boundary = validateCarryBoundary({ version: 1, id: randomUUID(), createdAt: new Date().toISOString(),
    session: context.session, bearer: context.bearer, mandatePath: path.resolve(context.mandatePath), mandateDigest: source.digest,
    cursors: context.cursors, claims: mine.filter(e => e.kind === 'claim' && !targeted.has(e.id)).map(ref),
    deliveries: mine.filter(e => e.kind === 'delivery-prepared' && !targeted.has(e.id)).map(ref),
    retractions: mine.filter(e => ['release', 'withdrawal'].includes(e.kind)).map(ref),
    watermark: events.map(e => e.id),
    // A delivery log cannot attest that it captured earlier own commitments.
    gaps: [...issues, ...(completeOrigin ? [] : ['commitment-history-coverage-unknown'])],
  });
  const handle = await open(output, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(boundary, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  return boundary;
}

/** Capture trailer commitments only from a successful own post. Call BEFORE the
 * existing appendPosted, so the very first post can establish a fresh origin.
 * Existing/rotated ledgers deliberately start with unknown pre-C1 history.
 * @param {string} dir @param {string} room @param {{slug:string}} session
 * @param {string} bearer @param {string} text @param {{id:string,cursor:string}} receipt */
export async function captureCarryPost(dir, room, session, bearer, text, receipt) {
  await mkdir(dir, { recursive: true });
  let previousPosts = false;
  for (const file of ['posted.jsonl', 'posted.1.jsonl']) {
    try { await readFile(path.join(dir, file)); previousPosts = true; }
    catch (err) { if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') previousPosts = true; }
  }
  try {
    const handle = await open(path.join(dir, 'carry-origin.json'), 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ version: 1, session: session.slug, bearer, commitmentsComplete: !previousPosts }) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
  } catch (err) { if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'EEXIST') throw err; }
  const evidence = await readCarryEvidence(dir);
  const mine = evidence.events.filter(e => e.session === session.slug && e.bearer === bearer && e.ref.room === room);
  const trailers = parseTrailers(text).trailers;
  const base = { version: 1, at: new Date().toISOString(), session: session.slug, bearer,
    ref: { room, id: receipt.id, cursor: receipt.cursor } };
  await appendCarryEvent(dir, { ...base, id: randomUUID(), kind: 'post' });
  for (const trailer of trailers) {
    if (trailer.key === 'claim') await appendCarryEvent(dir, { ...base, id: randomUUID(), kind: 'claim', subject: trailer.value });
    if (trailer.key === 'release') await appendCarryEvent(dir, { ...base, id: randomUUID(), kind: 'release', subject: trailer.value,
      targets: mine.filter(e => e.kind === 'claim' && e.subject === trailer.value).map(e => e.id) });
    if (trailer.key === 're' || trailer.key === 'withdraws') {
      const targets = mine.filter(e => (e.ref.id === trailer.value || e.ref.cursor === trailer.value)
        && (trailer.key === 're' ? e.kind === 'delivery-prepared' : ['claim', 'release'].includes(e.kind))).map(e => e.id);
      if (targets.length) await appendCarryEvent(dir, { ...base, id: randomUUID(), kind: trailer.key === 're' ? 'answer' : 'withdrawal', targets });
    }
  }
}

/** Versioned immutable evidence events. A prepared delivery is not acknowledgement.
 * A gap remains a gap until an explicit coverage event accounts for its ID; moving a
 * cursor cannot manufacture that event. Retractions are events, never deletions.
 * @param {unknown} value */
export function validateCarryEvent(value) {
  const v = readRecord(value, ['version', 'id', 'kind', 'at', 'session', 'bearer', 'ref'], ['targets', 'subject', 'to']);
  if (v.version !== 1) throw new CarryCheckError('carry-evidence-malformed');
  const kind = readEnum(v.kind, 'kind', ['post', 'delivery-prepared', 'delivery-accepted', 'answer', 'claim', 'release', 'withdrawal', 'gap', 'coverage']);
  const targets = v.targets === undefined ? [] : readArray(v.targets, 'targets', 4096, label);
  const subject = v.subject === undefined ? null : label(v.subject);
  const to = v.to === undefined ? [] : readArray(v.to, 'to', 4096, label);
  if (['delivery-accepted', 'answer', 'withdrawal', 'coverage'].includes(kind) && !targets.length)
    throw new CarryCheckError('carry-evidence-malformed');
  if (['claim', 'release', 'gap'].includes(kind) && !subject)
    throw new CarryCheckError('carry-evidence-malformed');
  return { version: 1, id: label(v.id), kind, at: readTimestamp(v.at), session: label(v.session),
    bearer: label(v.bearer), ref: validateCarryRef(v.ref), targets, to, ...(subject ? { subject } : {}) };
}

/** Prepared evidence precedes the external delivery. An unregistered watch has no
 * bearer evidence: it writes nothing and later checks refuse unknown coverage.
 * @param {string} dir @param {string} room
 * @param {import('./core.mjs').Message[]} messages
 * @param {{id?:string,name?:string}|undefined} seat */
export async function prepareCarryBatch(dir, room, messages, seat) {
  let record;
  try { record = JSON.parse(await readFile(path.join(dir, 'session.json'), 'utf8')); }
  catch { return new Map(); }
  if (typeof record?.bearer !== 'string') return new Map();
  /** @type {Map<string,ReturnType<typeof validateCarryEvent>>} */ const pending = new Map();
  for (const m of messages) {
    const to = parseTrailers(m.text).to;
    if (!to.some(address => matchesAddress(address, record.bearer, seat))) continue;
    const event = await appendCarryEvent(dir, { version: 1, id: randomUUID(), kind: 'delivery-prepared',
      at: new Date().toISOString(), session: path.basename(dir), bearer: record.bearer,
      ref: { room, id: m.id, cursor: m.cursor }, to });
    pending.set(m.id, event);
  }
  return pending;
}

/** Persist an adapter-accepted item before its cursor checkpoint. Kept separate
 * from prepare so a killed/failed adapter remains visibly unconfirmed.
 * @param {string} dir @param {ReturnType<typeof validateCarryEvent>|undefined} prepared */
export async function acceptCarryDelivery(dir, prepared) {
  if (!prepared) return;
  await appendCarryEvent(dir, { ...prepared, id: randomUUID(), kind: 'delivery-accepted',
    at: new Date().toISOString(), targets: [prepared.id] });
}

/** Each event has its own exclusive file; independent CLI/watch processes cannot
 * lose one another's records in a read/modify/write race. Partial files are retained
 * and refuse on read. No rotation can silently age an obligation out.
 * @param {string} dir @param {unknown} value */
export async function appendCarryEvent(dir, value) {
  const event = validateCarryEvent(value);
  const evidence = path.join(dir, 'carry-evidence');
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  const handle = await open(path.join(evidence, `${randomUUID()}.json`), 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(event) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  if (process.platform !== 'win32') {
    const parent = await open(evidence, 'r');
    try { await parent.sync(); } finally { await parent.close(); }
  }
  return event;
}

/** No store means unknown coverage, not zero obligations.
 * @param {string} dir */
export async function readCarryEvidence(dir) {
  const evidence = path.join(dir, 'carry-evidence');
  /** @type {ReturnType<typeof validateCarryEvent>[]} */ const events = [];
  /** @type {string[]} */ const issues = [];
  let files;
  try { files = await readdir(evidence); }
  catch { return { events, issues: ['delivery-coverage-unknown'] }; }
  if (!files.length) issues.push('delivery-coverage-unknown');
  const ids = new Set();
  for (const file of files.sort()) {
    try {
      if (!file.endsWith('.json')) throw new Error('unknown file');
      const event = validateCarryEvent(JSON.parse(await readFile(path.join(evidence, file), 'utf8')));
      if (ids.has(event.id)) throw new Error('duplicate event');
      ids.add(event.id); events.push(event);
    } catch { issues.push(`carry-evidence-corrupt:${file}`); }
  }
  return { events, issues };
}
