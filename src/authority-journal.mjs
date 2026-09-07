// @ts-check
// Same-user crash-recovery journal, not a tamper-proof witness or a verifier.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { nativeDigest } from './native-protocol.mjs';
import { privateDirectory, assertPrivateAncestry } from './tailcat.mjs';
import { AuthorityError, validateAuthorityRequest, validateAuthorityChallenge } from './authority.mjs';
import { readRecord, readString, readInteger, readEnum, readTimestamp, validateNativeId } from './protocol/common.mjs';

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_RECORD_BYTES = 32768;
/** @param {string} code @returns {never} */
function refuse(code) { throw new AuthorityError(code); }

/** Attribution is caller-claimed and cannot select a principal or grant.
 * @param {unknown} value */
export function validateAttributionClaims(value) {
  if (value === undefined) return {};
  try {
    const v = readRecord(value, [], ['bearer', 'sessionSlug']);
    return {
      ...(v.bearer === undefined ? {} : { bearer: readString(v.bearer, 'bearer', {
        min: 1, max: 120, pattern: /^[A-Za-z0-9][A-Za-z0-9._/-]*$/ }) }),
      ...(v.sessionSlug === undefined ? {} : { sessionSlug: readString(v.sessionSlug, 'sessionSlug', {
        min: 1, max: 160, pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/ }) }),
    };
  } catch { return refuse('operator-attribution-malformed'); }
}

/** @param {unknown} value */
function validateEvent(value) {
  const v = readRecord(value, ['kind', 'operationId', 'at'], ['request', 'proof', 'attributionClaims']);
  const kind = readEnum(v.kind, 'kind', ['intent', 'committed', 'failed', 'revoked', 'closed']);
  const operationId = validateNativeId(v.operationId), at = readTimestamp(v.at);
  if (kind !== 'intent') {
    if (Object.keys(v).length !== 3) refuse('authority-journal-corrupt');
    return { kind, operationId, at };
  }
  const request = validateAuthorityRequest(v.request);
  const proof = readRecord(v.proof, ['challenge', 'signature']);
  const challenge = validateAuthorityChallenge(proof.challenge);
  const signature = readString(proof.signature, 'signature', { min: 128, max: 128, pattern: /^[a-f0-9]+$/ });
  if (operationId !== request.operationId || challenge.act.operationId !== operationId
    || challenge.act.requestDigest !== nativeDigest(request)) refuse('authority-journal-corrupt');
  return { kind, operationId, at, request, proof: { challenge, signature },
    attributionClaims: validateAttributionClaims(v.attributionClaims) };
}

/** One journal per service. Caller serializes whole admission transactions by room;
 * this class serializes appends across rooms, reserves ids before any append await,
 * and treats uncertain writes as permanently unavailable for this instance. */
export class AuthorityJournal {
  /** @param {import('node:fs/promises').FileHandle} handle @param {string} accountId */
  constructor(handle, accountId) {
    this.handle = handle;
    this.previous = nativeDigest({ domain: 'agora-authority-journal-v1', accountId });
    this.sequence = 0;
    this.bytes = 0;
    this.unavailable = false;
    this.closed = false;
    this.writes = Promise.resolve();
    /** @type {Map<string, {intent: ReturnType<typeof validateEvent>, state: string}>} */
    this.operations = new Map();
    /** @type {Set<string>} */ this.challenges = new Set();
    /** @type {Set<string>} */ this.reservedOperations = new Set();
    /** @type {Set<string>} */ this.reservedChallenges = new Set();
    /** @type {Map<string, number>} */ this.revisions = new Map();
    /** @type {Set<string>} */ this.recoveryRooms = new Set();
  }

  /** Startup only. No reconstruction of effects from the journal.
   * @param {string} root @param {string} accountId */
  static async load(root, accountId) {
    validateNativeId(accountId);
    const dir = path.join(root, 'native', 'authority-journal');
    await privateDirectory(dir);
    await assertPrivateAncestry(dir);
    const handle = await open(path.join(dir, 'events.jsonl'),
      constants.O_CREAT | constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    const journal = new AuthorityJournal(handle, accountId);
    try {
      const info = await handle.stat();
      if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077)))
        refuse('authority-journal-permissions');
      if (info.size > MAX_BYTES) refuse('authority-journal-full');
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let used = 0;
      while (used < buffer.length) {
        const r = await handle.read(buffer, used, buffer.length - used, used);
        if (!r.bytesRead) break;
        used += r.bytesRead;
      }
      if (used > MAX_BYTES) refuse('authority-journal-full');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, used));
      if (text && !text.endsWith('\n')) refuse('authority-journal-corrupt');
      for (const line of text ? text.slice(0, -1).split('\n') : []) {
        if (Buffer.byteLength(line) > MAX_RECORD_BYTES) refuse('authority-journal-corrupt');
        const row = readRecord(JSON.parse(line), ['sequence', 'previous', 'event']);
        if (readInteger(row.sequence, 'sequence', 1) !== journal.sequence + 1 || row.previous !== journal.previous)
          refuse('authority-journal-corrupt');
        const event = validateEvent(row.event);
        journal.apply(event);
        journal.previous = nativeDigest({ sequence: row.sequence, previous: row.previous, event });
        journal.sequence++;
      }
      journal.bytes = used;
      for (const operation of journal.operations.values()) {
        if (operation.state === 'intent' || operation.state === 'revoked')
          journal.recoveryRooms.add(/** @type {NonNullable<typeof operation.intent.request>} */ (operation.intent.request).binding.roomId);
      }
      await handle.sync();
      if (process.platform !== 'win32') {
        const directory = await open(dir, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
      return journal;
    } catch (error) {
      await handle.close();
      if (error instanceof AuthorityError) throw error;
      refuse('authority-journal-corrupt');
    }
  }

  /** @param {string} roomId */
  revision(roomId) { return this.revisions.get(roomId) ?? 1; }

  /** @param {string} roomId */
  assertAvailable(roomId) {
    if (this.unavailable || this.closed) refuse('authority-journal-unavailable');
    if (this.recoveryRooms.has(roomId)) refuse('operator-recovery-required');
  }

  /** Validate transitions both on read and before write. @param {ReturnType<typeof validateEvent>} event */
  check(event) {
    const old = this.operations.get(event.operationId);
    if (event.kind === 'intent') {
      if (!event.request || !event.proof || old || this.challenges.has(event.proof.challenge.act.challengeId)
        || event.request.revisions.membership !== this.revision(event.request.binding.roomId))
        refuse('authority-journal-corrupt');
    } else if (!old || !old.intent.request || !(
      (old.state === 'intent' && event.kind === 'failed')
      || (old.state === 'intent' && event.kind === 'committed' && old.intent.request.action === 'room-enroll')
      || (old.state === 'intent' && event.kind === 'revoked' && old.intent.request.action === 'room-revoke')
      || (old.state === 'revoked' && event.kind === 'closed'))) refuse('authority-journal-corrupt');
  }

  /** @param {ReturnType<typeof validateEvent>} event */
  apply(event) {
    this.check(event);
    if (event.kind === 'intent') {
      this.operations.set(event.operationId, { intent: event, state: 'intent' });
      this.challenges.add(/** @type {NonNullable<typeof event.proof>} */ (event.proof).challenge.act.challengeId);
    } else {
      const operation = /** @type {NonNullable<ReturnType<typeof this.operations.get>>} */ (this.operations.get(event.operationId));
      operation.state = event.kind;
      if (event.kind === 'committed' || event.kind === 'revoked') {
        const roomId = /** @type {NonNullable<typeof operation.intent.request>} */ (operation.intent.request).binding.roomId;
        this.revisions.set(roomId, this.revision(roomId) + 1);
      }
    }
  }

  /** @param {ReturnType<typeof validateEvent>} event */
  append(event) {
    const job = this.writes.then(async () => {
      if (this.unavailable || this.closed) refuse('authority-journal-unavailable');
      this.check(event);
      const row = { sequence: this.sequence + 1, previous: this.previous, event };
      const bytes = Buffer.from(`${JSON.stringify(row)}\n`);
      if (bytes.length > MAX_RECORD_BYTES || this.bytes + bytes.length > MAX_BYTES) refuse('authority-journal-full');
      try { await this.handle.writeFile(bytes); await this.handle.sync(); }
      catch { this.unavailable = true; refuse('authority-journal-unavailable'); }
      this.apply(event);
      this.previous = nativeDigest(row); this.sequence++; this.bytes += bytes.length;
    });
    this.writes = job.catch(() => {});
    return job;
  }

  /** Caller has already cryptographically verified proof. This reserves synchronously.
   * @param {unknown} request @param {unknown} proof @param {unknown} claims @param {string} at */
  begin(request, proof, claims, at) {
    const r = validateAuthorityRequest(request);
    const event = validateEvent({ kind: 'intent', operationId: r.operationId, at, request: r, proof,
      attributionClaims: validateAttributionClaims(claims) });
    this.assertAvailable(r.binding.roomId);
    const id = /** @type {NonNullable<typeof event.proof>} */ (event.proof).challenge.act.challengeId;
    if (this.operations.has(r.operationId) || this.challenges.has(id)
      || this.reservedOperations.has(r.operationId) || this.reservedChallenges.has(id)) refuse('operator-act-replayed');
    this.reservedOperations.add(r.operationId); this.reservedChallenges.add(id);
    return this.append(event);
  }

  /** @param {string} operationId @param {'committed'|'failed'|'revoked'|'closed'} kind @param {string} at */
  finish(operationId, kind, at) { return this.append(validateEvent({ operationId, kind, at })); }

  /** Safe public status: no signature, raw caller fields or private resource paths.
   * @param {string} operationId */
  status(operationId) {
    validateNativeId(operationId);
    const op = this.operations.get(operationId);
    if (!op) return { operationId, state: 'unknown' };
    const proof = /** @type {NonNullable<typeof op.intent.proof>} */ (op.intent.proof);
    const request = /** @type {NonNullable<typeof op.intent.request>} */ (op.intent.request);
    return { operationId, state: op.state, authorityId: proof.challenge.act.authorityId,
      keyId: proof.challenge.keyId, policyDigest: proof.challenge.policyDigest,
      authenticatedPrincipal: request.binding.host, attributionClaims: op.intent.attributionClaims,
      authorization: 'delegation-policy', roomId: request.binding.roomId,
      actDigest: nativeDigest(proof.challenge.act), requestDigest: nativeDigest(request) };
  }

  async close() { await this.writes; this.closed = true; await this.handle.close(); }
}
