// @ts-check
// Route-authority core only: no service dispatch, signer, transport or admission effects.
// Trusted records and retained challenges must come from the caller's custody boundary,
// never the presented proof. Same-user state provides cooperative accountability only.
import { randomBytes, createPublicKey, verify } from 'node:crypto';
import { constants } from 'node:fs';
import { open, link, rm } from 'node:fs/promises';
import path from 'node:path';
import { nativeDigest } from './native-protocol.mjs';
import { validateOperatorAct, assertOperatorActContext } from './protocol/identity.mjs';
import { humanKeyId } from './protocol/human-authority.mjs';
import { validateRouteBinding } from './protocol/route.mjs';
import { memberAccountId } from './native-member.mjs';
import { assertPrivateAncestry, privateDirectory } from './tailcat.mjs';
import { readRecord, readArray, readString, readInteger, readEnum, readTimestamp,
  validateNativeId, validateDigest, validateRoomId } from './protocol/common.mjs';

export const AUTHORITY_CHALLENGE_MAX_MS = 120_000;
const DOMAIN = 'agora-route-operator-act-v1';
const RECORD_MAX_BYTES = 262144;
// libsodium 1.0.18 ge25519_has_small_order: seven y encodings, sign bit ignored.
// Includes y=p and p+1 aliases; exact-byte blocking of only eight points misses them.
// https://github.com/jedisct1/libsodium/blob/1.0.18/src/libsodium/crypto_core/ed25519/ref10/ed25519_ref10.c
// Public-input rejection only, not a replacement for Ed25519 signature verification.
const SMALL_ORDER_Y = new Set([
  '00'.repeat(32), `01${'00'.repeat(31)}`,
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  `ec${'ff'.repeat(30)}7f`, `ed${'ff'.repeat(30)}7f`, `ee${'ff'.repeat(30)}7f`,
]);

export class AuthorityError extends Error {
  /** @param {string} code */
  constructor(code) { super(code); this.name = 'AuthorityError'; this.code = code; }
}
/** @param {string} code @returns {never} */
function refuse(code) { throw new AuthorityError(code); }
/** Map structural failures without echoing caller-controlled bytes.
 * @template T @param {string} code @param {() => T} read @returns {T} */
function shape(code, read) {
  try { return read(); } catch (error) {
    if (error instanceof AuthorityError) throw error;
    return refuse(code);
  }
}
/** @param {unknown} value @param {number} bytes @param {string} field */
function hex(value, bytes, field) {
  return readString(value, field, { min: bytes * 2, max: bytes * 2, pattern: /^[a-f0-9]+$/ });
}

/** Closed immutable-operation input. An open's proposed grant/generation must already
 * be allocated; a close names the existing grant, never just the member key.
 * @param {unknown} value */
export function validateAuthorityRequest(value) {
  return shape('operator-request-malformed', () => {
    const v = readRecord(value, ['action', 'binding', 'operationId', 'revisions', 'targetNodeKeyDigest']);
    const binding = validateRouteBinding(v.binding);
    const revisions = readRecord(v.revisions, ['policy', 'membership']);
    if (binding.accountId !== memberAccountId(binding.allowedKeyDigest)
      || binding.member.scheme !== 'native' || binding.member.id !== binding.accountId
      || binding.member.authority !== binding.host.authority) refuse('operator-request-context');
    return { action: readEnum(v.action, 'action', ['room-enroll', 'room-revoke']), binding,
      targetNodeKeyDigest: validateDigest(v.targetNodeKeyDigest),
      operationId: validateNativeId(v.operationId), revisions: {
        policy: readInteger(revisions.policy, 'policy', 1),
        membership: readInteger(revisions.membership, 'membership', 1),
      } };
  });
}

/** A bounded delegation is public policy data, never proof of who installed it.
 * Each entry pairs a room and key digest; independent lists would widen to a product.
 * @param {unknown} value */
export function validateAuthorityPolicy(value) {
  return shape('authority-policy-malformed', () => {
    const v = readRecord(value, ['policyId', 'revision', 'validFrom', 'expiresAt', 'entries']);
    const validFrom = readTimestamp(v.validFrom), expiresAt = readTimestamp(v.expiresAt);
    if (Date.parse(validFrom) >= Date.parse(expiresAt)) refuse('authority-policy-window');
    const seen = new Set();
    const entries = readArray(v.entries, 'entries', 1024, (entry) => {
      const e = readRecord(entry, ['roomId', 'allowedKeyDigest', 'actions']);
      const roomId = validateRoomId(e.roomId), allowedKeyDigest = validateDigest(e.allowedKeyDigest);
      const actions = readArray(e.actions, 'actions', 2,
        (action) => readEnum(action, 'action', ['room-enroll', 'room-revoke']));
      if (!actions.length || new Set(actions).size !== actions.length) refuse('authority-policy-actions');
      const key = JSON.stringify([roomId, allowedKeyDigest]);
      if (seen.has(key)) refuse('authority-policy-duplicate');
      seen.add(key);
      return { roomId, allowedKeyDigest, actions };
    });
    return { policyId: validateNativeId(v.policyId), revision: readInteger(v.revision, 'revision', 1),
      validFrom, expiresAt, entries };
  });
}

/** @param {unknown} publicKey */
export function authorityIdForKey(publicKey) {
  return shape('authority-key-malformed', () => `a-${humanKeyId(publicKey).slice(7)}`);
}

/** A parsed record is not enrollment or protected custody. The Ed25519 signing key
 * is distinct from the source's Curve25519 node key; neither is converted into the other.
 * @param {unknown} value */
export function validateAuthorityRecord(value) {
  if (value === null || value === undefined) refuse('authority-absent');
  return shape('authority-record-malformed', () => {
    const v = readRecord(value, ['version', 'authorityId', 'algorithm', 'publicKey', 'keyId',
      'boundNodeKeyDigest', 'enrolledAt', 'enrolledBy', 'label', 'profile', 'policy']);
    const publicKey = hex(v.publicKey, 32, 'publicKey');
    const y = Buffer.from(publicKey, 'hex');
    y[31] &= 0x7f;
    if (SMALL_ORDER_Y.has(y.toString('hex'))) refuse('authority-key-small-order');
    const authorityId = validateNativeId(v.authorityId), keyId = validateDigest(v.keyId);
    if (authorityId !== authorityIdForKey(publicKey) || keyId !== humanKeyId(publicKey))
      refuse('authority-key-mismatch');
    const boundNodeKeyDigest = validateDigest(v.boundNodeKeyDigest);
    const label = readString(v.label, 'label', { min: 1, max: 120, controls: true });
    if (!label.trim()) refuse('authority-label-blank');
    const enrolledBy = readString(v.enrolledBy, 'enrolledBy', { min: 1, max: 120, controls: true });
    if (!enrolledBy.trim()) refuse('authority-enroller-blank');
    return { version: readInteger(v.version, 'version', 1, 1), authorityId,
      algorithm: readEnum(v.algorithm, 'algorithm', ['ed25519']), publicKey, keyId,
      boundNodeKeyDigest, enrolledAt: readTimestamp(v.enrolledAt),
      enrolledBy,
      label, profile: readEnum(v.profile, 'profile', ['pinned-cooperative']),
      policy: validateAuthorityPolicy(v.policy) };
  });
}

/** The local target digest is independently supplied from service identity, never
 * copied from a presented envelope. Possession cannot prove the physical seat or
 * operator provenance of the node-key binding; bootstrap must check both locally.
 * @param {ReturnType<typeof validateAuthorityRecord>} record @param {unknown} target */
function counterparty(record, target) {
  const digest = shape('authority-target-malformed', () => validateDigest(target));
  if (digest === record.boundNodeKeyDigest) refuse('authority-self-refused');
  return digest;
}

/** @param {unknown} candidate @param {unknown} targetNodeKeyDigest @param {unknown} now */
export function createAuthorityEnrollmentChallenge(candidate, targetNodeKeyDigest, now) {
  const record = validateAuthorityRecord(candidate);
  const issuedAt = readTimestamp(now);
  return { version: 1, recordDigest: nativeDigest(record),
    targetNodeKeyDigest: counterparty(record, targetNodeKeyDigest),
    challengeId: randomBytes(32).toString('hex'), issuedAt,
    expiresAt: new Date(Date.parse(issuedAt) + AUTHORITY_CHALLENGE_MAX_MS).toISOString() };
}

/** @param {unknown} value */
function enrollmentChallenge(value) {
  return shape('authority-possession-malformed', () => {
    const v = readRecord(value, ['version', 'recordDigest', 'targetNodeKeyDigest', 'challengeId', 'issuedAt', 'expiresAt']);
    const issuedAt = readTimestamp(v.issuedAt), expiresAt = readTimestamp(v.expiresAt);
    const duration = Date.parse(expiresAt) - Date.parse(issuedAt);
    if (duration <= 0 || duration > AUTHORITY_CHALLENGE_MAX_MS) refuse('authority-possession-expired');
    return { version: readInteger(v.version, 'version', 1, 1), recordDigest: validateDigest(v.recordDigest),
      targetNodeKeyDigest: validateDigest(v.targetNodeKeyDigest), challengeId: hex(v.challengeId, 32, 'challengeId'),
      issuedAt, expiresAt };
  });
}

/** Separate from route acts: enrollment possession never authorizes a route.
 * @param {unknown} challenge */
export function authorityEnrollmentSigningBytes(challenge) {
  return Buffer.from(`agora-authority-enrollment-v1\n${nativeDigest(enrollmentChallenge(challenge))}`, 'utf8');
}

/** @param {string} publicKey @param {Buffer} bytes @param {string} signature */
function signedBy(publicKey, bytes, signature) {
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519',
    x: Buffer.from(publicKey, 'hex').toString('base64url') }, format: 'jwk' });
  return verify(null, bytes, key, Buffer.from(signature, 'hex'));
}

/** @param {string} root @param {unknown} authorityId */
function recordPath(root, authorityId) {
  const id = shape('authority-id-malformed', () => validateNativeId(authorityId));
  if (!/^a-[a-f0-9]{64}$/.test(id)) refuse('authority-id-malformed');
  return path.join(path.resolve(root), 'native', 'authorities', `${id}.json`);
}

/** Explicit local bootstrap storage core, NOT authorization to trust the candidate.
 * The operator-controlled caller must compare this fingerprint independently. Never
 * overwrites a record, changes shared config, or mints a signing key. No protected
 * custody claim follows from mode bits or this same-user path.
 * No room-import or automatic trust path is provided. The expected fingerprint and
 * binding must be checked against the counter-seat terminal / hand-carried file.
 * @param {string} root @param {unknown} candidate @param {unknown} expectedKeyId
 * @param {unknown} authorization */
export async function enrollAuthorityRecord(root, candidate, expectedKeyId, authorization) {
  const record = validateAuthorityRecord(candidate);
  if (record.keyId !== expectedKeyId) refuse('authority-fingerprint-refused');
  if (authorization === undefined || authorization === null) refuse('authority-possession-required');
  const auth = shape('authority-possession-malformed', () => readRecord(authorization,
    ['targetNodeKeyDigest', 'retainedChallenge', 'proof', 'now']));
  const target = counterparty(record, auth.targetNodeKeyDigest);
  if (!auth.proof) refuse('authority-possession-required');
  const proof = shape('authority-possession-malformed', () => readRecord(auth.proof, ['challenge', 'signature']));
  const expected = enrollmentChallenge(auth.retainedChallenge), actual = enrollmentChallenge(proof.challenge);
  if (actual.recordDigest !== nativeDigest(record) || actual.targetNodeKeyDigest !== target
    || nativeDigest(actual) !== nativeDigest(expected)) refuse('authority-possession-context');
  const now = Date.parse(readTimestamp(auth.now));
  if (now < Date.parse(actual.issuedAt) || now >= Date.parse(actual.expiresAt)) refuse('authority-possession-expired');
  const signature = shape('authority-possession-malformed', () => hex(proof.signature, 64, 'signature'));
  if (!signedBy(record.publicKey, authorityEnrollmentSigningBytes(actual), signature))
    refuse('authority-possession-refused');
  const file = recordPath(root, record.authorityId), dir = path.dirname(file);
  const bytes = Buffer.from(JSON.stringify(record));
  if (bytes.length > RECORD_MAX_BYTES) refuse('authority-record-too-large');
  await privateDirectory(dir);
  const temporary = path.join(dir, `.enroll-${randomBytes(16).toString('hex')}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    // Publishing a fully written inode with an exclusive link is atomic and no-clobber.
    try { await link(temporary, file); } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'EEXIST') refuse('authority-already-enrolled');
      refuse('authority-record-write-failed');
    }
    if (process.platform !== 'win32') {
      const directory = await open(dir, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
    return { authorityId: record.authorityId, keyId: record.keyId, file, profile: record.profile };
  } catch (error) {
    if (error instanceof AuthorityError) throw error;
    // Publication may have happened before a sync failure; the caller must inspect
    // the existing record rather than overwrite or automatically retry enrollment.
    refuse('authority-record-write-unknown');
  } finally { await rm(temporary, { force: true }); }
}

/** Explicit startup read only; this function is not installed in any request path.
 * File and ancestor checks refuse links; mode bits on Windows do not certify ACLs.
 * A malformed or missing record never becomes a default authority.
 * @param {string} root @param {unknown} authorityId */
export async function readAuthorityRecord(root, authorityId) {
  const file = recordPath(root, authorityId);
  await assertPrivateAncestry(path.dirname(file));
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile()) refuse('authority-record-not-regular');
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) refuse('authority-record-permissions');
    if (stat.size > RECORD_MAX_BYTES) refuse('authority-record-too-large');
    const buffer = Buffer.alloc(RECORD_MAX_BYTES + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > RECORD_MAX_BYTES) refuse('authority-record-too-large');
    const record = shape('authority-record-malformed', () => validateAuthorityRecord(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, used)))));
    if (record.authorityId !== authorityId) refuse('authority-key-mismatch');
    return record;
  } catch (error) {
    if (error instanceof AuthorityError) throw error;
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') refuse('authority-absent');
    refuse('authority-record-unreadable');
  } finally { await handle?.close(); }
}

/** @param {unknown} record @param {unknown} request @param {unknown} now */
export function assertAuthorityDelegation(record, request, now) {
  const authority = validateAuthorityRecord(record), operation = validateAuthorityRequest(request);
  counterparty(authority, operation.targetNodeKeyDigest);
  const time = shape('operator-clock-malformed', () => Date.parse(readTimestamp(now)));
  if (time < Date.parse(authority.policy.validFrom) || time >= Date.parse(authority.policy.expiresAt))
    refuse('authority-policy-expired');
  if (operation.revisions.policy !== authority.policy.revision) refuse('authority-policy-stale');
  if (!authority.policy.entries.some((entry) => entry.roomId === operation.binding.roomId
    && entry.allowedKeyDigest === operation.binding.allowedKeyDigest && entry.actions.includes(operation.action)))
    refuse('operator-scope-refused');
  return { authority, operation };
}

/** Prepare a candidate challenge for the service to retain before publishing. No pending
 * registry is created here and no signer is contacted. Callers own storage/consumption.
 * @param {unknown} record @param {unknown} request @param {unknown} now
 * @param {number} [lifetimeMs] */
export function createAuthorityChallenge(record, request, now, lifetimeMs = AUTHORITY_CHALLENGE_MAX_MS) {
  const { authority, operation } = assertAuthorityDelegation(record, request, now);
  shape('operator-challenge-lifetime', () => readInteger(lifetimeMs, 'lifetimeMs', 1, AUTHORITY_CHALLENGE_MAX_MS));
  const issuedAt = readTimestamp(now);
  const expiresAt = new Date(Math.min(Date.parse(issuedAt) + lifetimeMs, Date.parse(authority.policy.expiresAt))).toISOString();
  const act = validateOperatorAct({ version: 1, action: operation.action,
    authorityId: authority.authorityId, proofRef: `${authority.authorityId}.json`,
    targetServiceId: operation.binding.host.id, operationId: operation.operationId,
    requestDigest: nativeDigest(operation), challengeId: randomBytes(32).toString('hex'), issuedAt, expiresAt,
    revisions: operation.revisions, room: { roomId: operation.binding.roomId, epoch: operation.binding.roomEpoch } });
  return { act, serviceBootId: operation.binding.serviceBootId, keyId: authority.keyId,
    targetNodeKeyDigest: operation.targetNodeKeyDigest,
    sourceNodeKeyDigest: authority.boundNodeKeyDigest, policyDigest: nativeDigest(authority.policy) };
}

/** @param {unknown} value */
export function validateAuthorityChallenge(value) {
  return shape('operator-challenge-malformed', () => {
    const v = readRecord(value, ['act', 'serviceBootId', 'keyId', 'sourceNodeKeyDigest', 'targetNodeKeyDigest', 'policyDigest']);
    const act = validateOperatorAct(v.act);
    if (!['room-enroll', 'room-revoke'].includes(act.action) || !act.room || act.revisions.membership === undefined)
      refuse('operator-challenge-context');
    if (Date.parse(act.expiresAt) - Date.parse(act.issuedAt) > AUTHORITY_CHALLENGE_MAX_MS)
      refuse('operator-challenge-lifetime');
    if (act.proofRef !== `${act.authorityId}.json`) refuse('operator-proof-ref-refused');
    return { act, serviceBootId: validateNativeId(v.serviceBootId), keyId: validateDigest(v.keyId),
      targetNodeKeyDigest: validateDigest(v.targetNodeKeyDigest),
      sourceNodeKeyDigest: validateDigest(v.sourceNodeKeyDigest), policyDigest: validateDigest(v.policyDigest) };
  });
}

/** Detached Ed25519 signature over UTF-8 domain plus canonical digest of the validated
 * unsigned challenge. This deliberately does not use the board/compose proof domain.
 * @param {unknown} challenge */
export function authoritySigningBytes(challenge) {
  return Buffer.from(`${DOMAIN}\n${nativeDigest(validateAuthorityChallenge(challenge))}`, 'utf8');
}

/** Verify only; NOT an admission handle. Requires an independently retained challenge
 * and current request, boot, policy and time. Caller must serialize and durably consume
 * before effects; repeat verification here intentionally does not consume anything.
 * @param {unknown} proof @param {unknown} record @param {unknown} retainedChallenge
 * @param {unknown} currentRequest @param {unknown} now */
export function verifyAuthorityProof(proof, record, retainedChallenge, currentRequest, now) {
  const { authority, operation } = assertAuthorityDelegation(record, currentRequest, now);
  if (proof === undefined || proof === null) refuse('operator-proof-required');
  const envelope = shape('operator-proof-malformed', () => readRecord(proof, ['challenge', 'signature']));
  const signature = shape('operator-proof-malformed', () => hex(envelope.signature, 64, 'signature'));
  const expected = validateAuthorityChallenge(retainedChallenge), actual = validateAuthorityChallenge(envelope.challenge);
  if (actual.act.authorityId !== authority.authorityId || actual.keyId !== authority.keyId
    || actual.sourceNodeKeyDigest !== authority.boundNodeKeyDigest
    || actual.targetNodeKeyDigest !== operation.targetNodeKeyDigest
    || actual.policyDigest !== nativeDigest(authority.policy)
    || actual.act.requestDigest !== nativeDigest(operation)
    || actual.act.operationId !== operation.operationId || actual.act.action !== operation.action
    || actual.act.targetServiceId !== operation.binding.host.id
    || actual.serviceBootId !== operation.binding.serviceBootId
    || actual.act.room?.roomId !== operation.binding.roomId || actual.act.room.epoch !== operation.binding.roomEpoch
    || actual.act.revisions.policy !== operation.revisions.policy
    || actual.act.revisions.membership !== operation.revisions.membership
    || nativeDigest(actual) !== nativeDigest(expected)) refuse('operator-context-refused');
  const time = Date.parse(readTimestamp(now));
  if (time < Date.parse(actual.act.issuedAt) || time >= Date.parse(actual.act.expiresAt)) refuse('operator-act-expired');
  shape('operator-context-refused', () => assertOperatorActContext(actual.act, expected.act, now));
  if (!signedBy(authority.publicKey, authoritySigningBytes(actual), signature))
    refuse('operator-signature-refused');
  return { actDigest: nativeDigest(actual.act), challengeId: actual.act.challengeId,
    operationId: operation.operationId, authorityId: authority.authorityId, keyId: authority.keyId,
    policyId: authority.policy.policyId, policyDigest: actual.policyDigest,
    profile: authority.profile, authorization: 'delegation-policy' };
}
