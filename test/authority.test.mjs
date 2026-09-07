// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile, chmod, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AuthorityError, authorityIdForKey, validateAuthorityRecord, validateAuthorityRequest,
  createAuthorityChallenge, authoritySigningBytes, verifyAuthorityProof, assertAuthorityDelegation,
  validateAuthorityChallenge, enrollAuthorityRecord, readAuthorityRecord,
  createAuthorityEnrollmentChallenge, authorityEnrollmentSigningBytes } from '../src/authority.mjs';
import { publicNodeKeyDigest } from '../src/protocol/route.mjs';
import { humanKeyId } from '../src/protocol/human-authority.mjs';
import { buildRouteBinding } from '../src/native-member.mjs';
import { nativeDigest } from '../src/native-protocol.mjs';

const NOW = '2026-09-07T20:00:00.000Z';
const ROOM = 'b'.repeat(32), KEY = `nodekey:${'c'.repeat(64)}`;
const TARGET = publicNodeKeyDigest(`nodekey:${'9'.repeat(64)}`);
function fixture() {
  const keys = generateKeyPairSync('ed25519');
  const publicKey = Buffer.from(/** @type {string} */ (keys.publicKey.export({ format: 'jwk' }).x), 'base64url').toString('hex');
  const binding = buildRouteBinding({ hostAccountId: 'a'.repeat(32), hostAuthority: 'a'.repeat(32),
    roomId: ROOM, roomEpoch: 'd'.repeat(32), serviceBootId: 'e'.repeat(32), publicNodeKey: KEY });
  const request = { action: 'room-enroll', binding, targetNodeKeyDigest: TARGET,
    operationId: 'f'.repeat(32), revisions: { policy: 3, membership: 7 } };
  const record = { version: 1, authorityId: authorityIdForKey(publicKey), algorithm: 'ed25519', publicKey,
    keyId: humanKeyId(publicKey), boundNodeKeyDigest: publicNodeKeyDigest(`nodekey:${'1'.repeat(64)}`),
    enrolledAt: NOW, enrolledBy: 'operator-local-bootstrap', label: 'counter seat',
    profile: 'pinned-cooperative', policy: { policyId: '2'.repeat(32), revision: 3, validFrom: NOW,
      expiresAt: '2026-09-07T21:00:00.000Z', entries: [
        { roomId: ROOM, allowedKeyDigest: binding.allowedKeyDigest, actions: ['room-enroll', 'room-revoke'] },
      ] } };
  const challenge = createAuthorityChallenge(record, request, NOW);
  const proof = { challenge, signature: sign(null, authoritySigningBytes(challenge), keys.privateKey).toString('hex') };
  return { keys, record, request, challenge, proof };
}
/** @param {ReturnType<typeof fixture>} f @param {ReturnType<typeof fixture>['record']} [record] */
function enrollment(f, record = f.record) {
  const challenge = createAuthorityEnrollmentChallenge(record, TARGET, NOW);
  return { targetNodeKeyDigest: TARGET, retainedChallenge: challenge, now: NOW,
    proof: { challenge, signature: sign(null, authorityEnrollmentSigningBytes(challenge), f.keys.privateKey).toString('hex') } };
}
/** @param {() => unknown} call @param {string} code */
function refuses(call, code) {
  assert.throws(call, (e) => e instanceof AuthorityError && e.code === code, code);
}

test('detached signature verifies exact route request; core performs no admission or replay consumption', () => {
  const f = fixture();
  const before = structuredClone(f.request);
  const first = verifyAuthorityProof(f.proof, f.record, f.challenge, f.request, NOW);
  assert.equal(first.authorization, 'delegation-policy');
  assert.equal(first.profile, 'pinned-cooperative');
  assert.equal(first.policyId, f.record.policy.policyId);
  assert.equal(first.keyId, f.record.keyId);
  assert.equal(first.actDigest, nativeDigest(f.challenge.act));
  assert.deepEqual(verifyAuthorityProof(f.proof, f.record, f.challenge, f.request, NOW), first);
  assert.deepEqual(f.request, before);
  assert.equal(Object.hasOwn(first, 'admitted'), false);
});

test('no authority refuses; enrolled authority requires proof; signature presence never enables fallback', () => {
  const f = fixture();
  refuses(() => verifyAuthorityProof(undefined, undefined, f.challenge, f.request, NOW), 'authority-absent');
  refuses(() => verifyAuthorityProof(f.proof, undefined, f.challenge, f.request, NOW), 'authority-absent');
  refuses(() => verifyAuthorityProof(undefined, f.record, f.challenge, f.request, NOW), 'operator-proof-required');
  refuses(() => verifyAuthorityProof({ challenge: f.challenge }, f.record, f.challenge, f.request, NOW), 'operator-proof-malformed');
  refuses(() => validateAuthorityRecord({ ...f.record, algorithm: 'hmac-sha256' }), 'authority-record-malformed');
});

test('foreign valid signature and byte-damaged signature fail real Ed25519 verification', () => {
  const f = fixture(), other = generateKeyPairSync('ed25519');
  const signature = sign(null, authoritySigningBytes(f.challenge), other.privateKey).toString('hex');
  refuses(() => verifyAuthorityProof({ ...f.proof, signature }, f.record, f.challenge, f.request, NOW), 'operator-signature-refused');
  const damaged = Buffer.from(f.proof.signature, 'hex'); damaged[0] ^= 1;
  refuses(() => verifyAuthorityProof({ ...f.proof, signature: damaged.toString('hex') }, f.record, f.challenge, f.request, NOW), 'operator-signature-refused');
  const wrongDomain = sign(null, Buffer.from(nativeDigest(f.challenge)), f.keys.privateKey).toString('hex');
  refuses(() => verifyAuthorityProof({ ...f.proof, signature: wrongDomain }, f.record, f.challenge, f.request, NOW), 'operator-signature-refused');
});

test('record key id and authority id bind the signing key; a nodekey string is not a signing key', () => {
  const f = fixture();
  refuses(() => validateAuthorityRecord({ ...f.record, keyId: `sha256:${'0'.repeat(64)}` }), 'authority-key-mismatch');
  refuses(() => validateAuthorityRecord({ ...f.record, authorityId: 'x'.repeat(32) }), 'authority-key-mismatch');
  refuses(() => validateAuthorityRecord({ ...f.record, publicKey: KEY }), 'authority-record-malformed');
  const copy = validateAuthorityRecord(f.record);
  f.record.policy.entries.length = 0;
  assert.equal(copy.policy.entries.length, 1, 'parsed record must not retain mutable input arrays');
});

test('policy matches pairs, not a cross product of rooms and keys; action scope and empty policy refuse', () => {
  const f = fixture(), otherRoom = '3'.repeat(32), otherDigest = `sha256:${'4'.repeat(64)}`;
  const record = structuredClone(f.record);
  record.policy.entries = [
    { roomId: ROOM, allowedKeyDigest: otherDigest, actions: ['room-enroll'] },
    { roomId: otherRoom, allowedKeyDigest: f.request.binding.allowedKeyDigest, actions: ['room-enroll'] },
  ];
  refuses(() => createAuthorityChallenge(record, f.request, NOW), 'operator-scope-refused');
  record.policy.entries = [];
  refuses(() => createAuthorityChallenge(record, f.request, NOW), 'operator-scope-refused');
  record.policy.entries = [{ ...f.record.policy.entries[0], actions: ['room-revoke'] }];
  refuses(() => createAuthorityChallenge(record, f.request, NOW), 'operator-scope-refused');
  assertAuthorityDelegation(record, { ...f.request, action: 'room-revoke' }, NOW);
});

test('expired, not-yet-valid and changed policy refuse, including exact expiry and revision', () => {
  const f = fixture();
  refuses(() => createAuthorityChallenge(f.record, f.request, f.record.policy.expiresAt), 'authority-policy-expired');
  refuses(() => createAuthorityChallenge(f.record, f.request, '2026-09-07T19:59:59.999Z'), 'authority-policy-expired');
  refuses(() => createAuthorityChallenge(f.record, { ...f.request, revisions: { policy: 2, membership: 7 } }, NOW), 'authority-policy-stale');
  const changed = structuredClone(f.record); changed.policy.entries[0].actions = ['room-enroll'];
  refuses(() => verifyAuthorityProof(f.proof, changed, f.challenge, f.request, NOW), 'operator-context-refused');
  const removed = structuredClone(f.record); removed.policy.entries = [];
  refuses(() => verifyAuthorityProof(f.proof, removed, f.challenge, f.request, NOW), 'operator-scope-refused');
});

test('challenge uses fresh unpredictable ids and exact time boundaries, capped by policy expiry', () => {
  const f = fixture();
  const second = createAuthorityChallenge(f.record, f.request, NOW);
  assert.notEqual(second.act.challengeId, f.challenge.act.challengeId);
  assert.match(second.act.challengeId, /^[a-f0-9]{64}$/);
  assert.equal(Date.parse(second.act.expiresAt) - Date.parse(second.act.issuedAt), 120000);
  verifyAuthorityProof(f.proof, f.record, f.challenge, f.request, NOW);
  verifyAuthorityProof(f.proof, f.record, f.challenge, f.request, '2026-09-07T20:01:59.999Z');
  refuses(() => verifyAuthorityProof(f.proof, f.record, f.challenge, f.request, f.challenge.act.expiresAt), 'operator-act-expired');
  const earlier = structuredClone(f.record); earlier.policy.validFrom = '2026-09-07T19:00:00.000Z';
  const challenge = createAuthorityChallenge(earlier, f.request, NOW);
  const proof = { challenge, signature: sign(null, authoritySigningBytes(challenge), f.keys.privateKey).toString('hex') };
  refuses(() => verifyAuthorityProof(proof, earlier, challenge, f.request, '2026-09-07T19:59:59.999Z'), 'operator-act-expired');
  const short = structuredClone(f.record); short.policy.expiresAt = '2026-09-07T20:00:00.001Z';
  assert.equal(createAuthorityChallenge(short, f.request, NOW).act.expiresAt, short.policy.expiresAt);
  for (const lifetime of [0, -1, 120001, 0.5, NaN, Infinity])
    refuses(() => createAuthorityChallenge(f.record, f.request, NOW, lifetime), 'operator-challenge-lifetime');
});

test('every mutable signed field changes signing bytes and invalidates the original signature', () => {
  const f = fixture();
  const changes = [
    { serviceBootId: '5'.repeat(32) }, { keyId: `sha256:${'5'.repeat(64)}` },
    { sourceNodeKeyDigest: `sha256:${'5'.repeat(64)}` }, { policyDigest: `sha256:${'5'.repeat(64)}` },
    { targetNodeKeyDigest: `sha256:${'5'.repeat(64)}` },
  ];
  const actChanges = [
    { action: 'room-revoke' }, { targetServiceId: '5'.repeat(32) },
    { operationId: '5'.repeat(32) }, { requestDigest: `sha256:${'5'.repeat(64)}` },
    { challengeId: '5'.repeat(64) }, { issuedAt: '2026-09-07T20:00:00.001Z' },
    { expiresAt: '2026-09-07T20:01:59.999Z' }, { revisions: { policy: 4, membership: 7 } },
    { revisions: { policy: 3, membership: 8 } }, { room: { roomId: '5'.repeat(32), epoch: 'd'.repeat(32) } },
    { room: { roomId: ROOM, epoch: '5'.repeat(32) } },
    { authorityId: `a-${'5'.repeat(64)}`, proofRef: `a-${'5'.repeat(64)}.json` },
  ];
  const candidates = [...changes.map((change) => ({ ...f.challenge, ...change })),
    ...actChanges.map((change) => ({ ...f.challenge, act: { ...f.challenge.act, ...change } }))];
  for (const candidate of candidates) {
    const bytes = authoritySigningBytes(candidate);
    assert.notDeepEqual(bytes, authoritySigningBytes(f.challenge));
    assert.equal(verify(null, bytes, f.keys.publicKey, Buffer.from(f.proof.signature, 'hex')), false);
  }
  const altered = { ...f.challenge, act: { ...f.challenge.act, challengeId: '6'.repeat(64) } };
  refuses(() => verifyAuthorityProof({ ...f.proof, challenge: altered }, f.record, altered, f.request, NOW), 'operator-signature-refused');
});

test('retained target context refuses changed boot, room epoch, operation, action and membership revision', () => {
  const f = fixture();
  const changedRequests = [
    { ...f.request, targetNodeKeyDigest: publicNodeKeyDigest(`nodekey:${'8'.repeat(64)}`) },
    { ...f.request, binding: { ...f.request.binding, serviceBootId: '6'.repeat(32) } },
    { ...f.request, binding: { ...f.request.binding, roomEpoch: '6'.repeat(32) } },
    { ...f.request, binding: { ...f.request.binding, host: { ...f.request.binding.host, id: '6'.repeat(32) } } },
    { ...f.request, operationId: '6'.repeat(32) }, { ...f.request, action: 'room-revoke' },
    { ...f.request, revisions: { ...f.request.revisions, membership: 8 } },
    { ...f.request, binding: { ...f.request.binding, grantId: '6'.repeat(32) } },
    { ...f.request, binding: { ...f.request.binding, routeGeneration: '6'.repeat(32) } },
  ];
  for (const request of changedRequests)
    refuses(() => verifyAuthorityProof(f.proof, f.record, f.challenge, request, NOW), 'operator-context-refused');
  const next = createAuthorityChallenge(f.record, f.request, NOW);
  refuses(() => verifyAuthorityProof(f.proof, f.record, next, f.request, NOW), 'operator-context-refused');
});

test('proofRef must select the retained authority, not another valid enrolled authority', () => {
  const f = fixture(), other = fixture();
  const challenge = { ...f.challenge, act: { ...f.challenge.act, proofRef: `${other.record.authorityId}.json` } };
  refuses(() => validateAuthorityChallenge(challenge), 'operator-proof-ref-refused');
  const otherProof = { challenge: other.challenge,
    signature: sign(null, authoritySigningBytes(other.challenge), other.keys.privateKey).toString('hex') };
  refuses(() => verifyAuthorityProof(otherProof, f.record, f.challenge, f.request, NOW), 'operator-context-refused');
});

test('close approves an exact generation, and the unchanged close verifies', () => {
  const f = fixture(), request = { ...f.request, action: 'room-revoke' };
  const challenge = createAuthorityChallenge(f.record, request, NOW);
  const proof = { challenge, signature: sign(null, authoritySigningBytes(challenge), f.keys.privateKey).toString('hex') };
  verifyAuthorityProof(proof, f.record, challenge, request, NOW);
  refuses(() => verifyAuthorityProof(proof, f.record, challenge,
    { ...request, binding: { ...request.binding, routeGeneration: '7'.repeat(32) } }, NOW), 'operator-context-refused');
});

test('closed schemas reject covert proof fields, bad labels, duplicate scope and inconsistent member identity', () => {
  const f = fixture();
  refuses(() => validateAuthorityRecord({ ...f.record, privateKey: 'SECRET-SENTINEL' }), 'authority-record-malformed');
  refuses(() => validateAuthorityRecord({ ...f.record, label: '   ' }), 'authority-label-blank');
  const duplicate = structuredClone(f.record); duplicate.policy.entries.push(duplicate.policy.entries[0]);
  refuses(() => validateAuthorityRecord(duplicate), 'authority-policy-duplicate');
  refuses(() => validateAuthorityRequest({ ...f.request, binding: { ...f.request.binding, accountId: '8'.repeat(32) } }), 'operator-request-context');
  refuses(() => verifyAuthorityProof({ ...f.proof, verified: true }, f.record, f.challenge, f.request, NOW), 'operator-proof-malformed');
  let getterCalled = false;
  const hostile = { ...f.record, get publicKey() { getterCalled = true; return 'SECRET-SENTINEL'; } };
  refuses(() => validateAuthorityRecord(hostile), 'authority-record-malformed');
  assert.equal(getterCalled, false);
});

test('canonical key order is stable and signing bytes have a fixed separate domain', () => {
  const f = fixture();
  const reordered = Object.fromEntries(Object.entries(f.challenge).reverse());
  assert.deepEqual(authoritySigningBytes(reordered), authoritySigningBytes(f.challenge));
  assert.equal(authoritySigningBytes(f.challenge).toString(), `agora-route-operator-act-v1\n${nativeDigest(validateAuthorityChallenge(f.challenge))}`);
});

test('explicit enrollment persists public record, refuses replacement and missing read creates nothing', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'agora-authority-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture();
  await assert.rejects(readAuthorityRecord(root, f.record.authorityId), { code: 'authority-absent' });
  assert.deepEqual(await readdir(root), []);
  await assert.rejects(enrollAuthorityRecord(root, f.record, 'wrong', enrollment(f)), { code: 'authority-fingerprint-refused' });
  assert.deepEqual(await readdir(root), []);
  const receipt = await enrollAuthorityRecord(root, f.record, f.record.keyId, enrollment(f));
  assert.deepEqual(await readAuthorityRecord(root, receipt.authorityId), validateAuthorityRecord(f.record));
  const original = await readFile(receipt.file);
  const replacement = { ...f.record, label: 'replacement' };
  await assert.rejects(enrollAuthorityRecord(root, replacement, f.record.keyId, enrollment(f, replacement)), { code: 'authority-already-enrolled' });
  assert.deepEqual(await readFile(receipt.file), original);
  assert.deepEqual(await readdir(path.dirname(receipt.file)), [`${f.record.authorityId}.json`]);
});

test('simultaneous enrollment publishes one complete record without overwriting the winner', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'agora-authority-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture();
  const result = await Promise.allSettled([
    enrollAuthorityRecord(root, { ...f.record, label: 'one' }, f.record.keyId, enrollment(f, { ...f.record, label: 'one' })),
    enrollAuthorityRecord(root, { ...f.record, label: 'two' }, f.record.keyId, enrollment(f, { ...f.record, label: 'two' })),
  ]);
  assert.equal(result.filter((r) => r.status === 'fulfilled').length, 1);
  const loser = result.find((r) => r.status === 'rejected');
  assert.equal(loser?.reason.code, 'authority-already-enrolled');
  const record = await readAuthorityRecord(root, f.record.authorityId);
  assert.equal(record.label, result[0].status === 'fulfilled' ? 'one' : 'two');
});

test('record reads refuse unsafe permissions, corruption, oversize and a foreign key at the expected path', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'agora-authority-read-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture();
  const receipt = await enrollAuthorityRecord(root, f.record, f.record.keyId, enrollment(f));
  if (process.platform !== 'win32') {
    await chmod(receipt.file, 0o644);
    await assert.rejects(readAuthorityRecord(root, f.record.authorityId), { code: 'authority-record-permissions' });
    assert.equal((await stat(receipt.file)).mode & 0o777, 0o644, 'reader must not repair permissions');
    await chmod(receipt.file, 0o600);
  }
  await writeFile(receipt.file, '{');
  await assert.rejects(readAuthorityRecord(root, f.record.authorityId), { code: 'authority-record-malformed' });
  await writeFile(receipt.file, Buffer.alloc(262145));
  await assert.rejects(readAuthorityRecord(root, f.record.authorityId), { code: 'authority-record-too-large' });
  await writeFile(receipt.file, JSON.stringify(fixture().record));
  await assert.rejects(readAuthorityRecord(root, f.record.authorityId), { code: 'authority-key-mismatch' });
});

test('counterparty cannot be self at challenge, verification or enrollment; wrong source binding refuses', async (t) => {
  const f = fixture(), self = { ...f.record, boundNodeKeyDigest: TARGET };
  refuses(() => createAuthorityChallenge(self, f.request, NOW), 'authority-self-refused');
  refuses(() => verifyAuthorityProof(f.proof, self, f.challenge, f.request, NOW), 'authority-self-refused');
  refuses(() => createAuthorityEnrollmentChallenge(self, TARGET, NOW), 'authority-self-refused');
  const wrong = { ...f.record, boundNodeKeyDigest: publicNodeKeyDigest(`nodekey:${'7'.repeat(64)}`) };
  refuses(() => verifyAuthorityProof(f.proof, wrong, f.challenge, f.request, NOW), 'operator-context-refused');
  const root = await mkdtemp(path.join(tmpdir(), 'agora-authority-self-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(enrollAuthorityRecord(root, self, self.keyId, enrollment(f)), { code: 'authority-self-refused' });
  assert.deepEqual(await readdir(root), []);
});

test('enrollment requires fresh possession over the exact retained record and local target before any write', async (t) => {
  const f = fixture(), root = await mkdtemp(path.join(tmpdir(), 'agora-authority-possession-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const good = enrollment(f);
  const other = fixture();
  const cases = [
    { authorization: undefined, code: 'authority-possession-required' },
    { authorization: { ...good, proof: null }, code: 'authority-possession-required' },
    { authorization: { ...good, proof: undefined }, code: 'authority-possession-malformed' },
    { authorization: { ...good, fromRoom: 'agora' }, code: 'authority-possession-malformed' },
    { authorization: { ...good, now: good.proof.challenge.expiresAt }, code: 'authority-possession-expired' },
    { authorization: { ...good, now: '2026-09-07T19:59:59.999Z' }, code: 'authority-possession-expired' },
    { authorization: { ...good, targetNodeKeyDigest: publicNodeKeyDigest(`nodekey:${'6'.repeat(64)}`) }, code: 'authority-possession-context' },
    { authorization: { ...good, retainedChallenge: enrollment(f).retainedChallenge }, code: 'authority-possession-context' },
    { authorization: { ...good, proof: { ...good.proof, signature: sign(null,
      authorityEnrollmentSigningBytes(good.proof.challenge), other.keys.privateKey).toString('hex') } }, code: 'authority-possession-refused' },
    { authorization: { ...good, proof: { ...good.proof, signature: f.proof.signature } }, code: 'authority-possession-refused' },
  ];
  for (const { authorization, code } of cases) {
    await assert.rejects(enrollAuthorityRecord(root, f.record, f.record.keyId, authorization), { code });
    assert.deepEqual(await readdir(root), [], code);
  }
  await assert.rejects(enrollAuthorityRecord(root, { ...f.record, enrolledBy: 'someone-else' },
    f.record.keyId, good), { code: 'authority-possession-context' });
  await enrollAuthorityRecord(root, f.record, f.record.keyId, good);
  const rebound = { ...f.record, boundNodeKeyDigest: publicNodeKeyDigest(`nodekey:${'5'.repeat(64)}`) };
  await assert.rejects(enrollAuthorityRecord(root, rebound, rebound.keyId, enrollment(f, rebound)),
    { code: 'authority-already-enrolled' });
});
