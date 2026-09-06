// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { ProtocolValidationError } from '../src/protocol/common.mjs';
import { humanKeyId, validateHumanKeyCandidate, validateHumanOperationChallenge, parseUnverifiedHumanOperationProof, humanOperationSigningBytes } from '../src/protocol/human-authority.mjs';

const key = generateKeyPairSync('ed25519');
const stranger = generateKeyPairSync('ed25519');
const publicHex = Buffer.from(key.publicKey.export({ format: 'jwk' }).x ?? '', 'base64url').toString('hex');
const candidate = { version: 1, authorityId: 'human_authority_0001', algorithm: 'ed25519', publicKey: publicHex, keyId: humanKeyId(publicHex) };
const challenge = {
  version: 1, action: 'board-break', authorityId: candidate.authorityId, keyId: candidate.keyId,
  host: { scheme: 'native', authority: 'fixture.invalid', id: 'seat_account_00001' },
  service: { serviceId: 'seat_service_00001', serviceBootId: 'service_boot_00001' },
  room: { roomId: '1'.repeat(32), epoch: '2'.repeat(32) },
  requester: { accountId: 'seat_account_00001', registrationId: 'registration_00001', generation: 1 },
  operationId: 'operation_break_01', requestDigest: `sha256:${'3'.repeat(64)}`,
  policyRevision: 1, challengeId: 'challenge_break_01', nonce: '4'.repeat(64),
  issuedAt: '2026-09-06T03:00:00.000Z', expiresAt: '2026-09-06T03:01:00.000Z',
};
const proof = { challenge, signature: sign(null, humanOperationSigningBytes(challenge), key.privateKey).toString('hex') };

// Test-only policy oracle. NOT service admission or an exhibited custody boundary.
// Trusted arguments model host-retained state; none is obtained from the proof.
/** @param {unknown} value @param {{active?:boolean,profile?:string,now?:string,expected?:unknown}} [options] */
function oracle(value, { active = true, profile = 'enforced', now = '2026-09-06T03:00:30.000Z', expected = challenge } = {}) {
  const p = parseUnverifiedHumanOperationProof(value);
  if (!active) throw new Error('grant-revoked');
  if (profile !== 'enforced') throw new Error('custody-unproven');
  if (!humanOperationSigningBytes(p.challenge).equals(humanOperationSigningBytes(expected))) throw new Error('context-mismatch');
  if (Date.parse(now) < Date.parse(p.challenge.issuedAt) || Date.parse(now) >= Date.parse(p.challenge.expiresAt)) throw new Error('challenge-expired');
  if (!verify(null, humanOperationSigningBytes(p.challenge), key.publicKey, Buffer.from(p.signature, 'hex'))) throw new Error('signature-refused');
  return 'proof-valid'; // NOT a store stamp, a grant, or permission to mutate.
}

test('human key candidate is closed syntax and a full raw-key fingerprint, not enrollment', () => {
  assert.deepEqual(validateHumanKeyCandidate(candidate), candidate);
  assert.throws(() => validateHumanKeyCandidate({ ...candidate, approved: true }), ProtocolValidationError);
  assert.throws(() => validateHumanKeyCandidate({ ...candidate, keyId: `sha256:${'0'.repeat(64)}` }), ProtocolValidationError);
  assert.throws(() => validateHumanKeyCandidate({ ...candidate, privateKey: 'never-on-wire' }), ProtocolValidationError);
});

test('signing bytes have a pinned tuple, independent of input object order', () => {
  const tuple = ['agora-human-operation-v1', 1, 'board-break', candidate.authorityId, candidate.keyId,
    ['native', 'fixture.invalid', 'seat_account_00001'], ['seat_service_00001', 'service_boot_00001'],
    ['1'.repeat(32), '2'.repeat(32)], ['seat_account_00001', 'registration_00001', 1],
    'operation_break_01', `sha256:${'3'.repeat(64)}`, 1, 'challenge_break_01', '4'.repeat(64),
    '2026-09-06T03:00:00.000Z', '2026-09-06T03:01:00.000Z'];
  assert.equal(humanOperationSigningBytes(challenge).toString('utf8'), JSON.stringify(tuple));
  const reversed = Object.fromEntries(Object.entries(challenge).reverse());
  assert.deepEqual(humanOperationSigningBytes(reversed), humanOperationSigningBytes(challenge));
  assert.equal(oracle(proof), 'proof-valid');
});

test('every authority, target, requester, payload and freshness field is signed', () => {
  const mutations = [
    { action: 'message-compose' }, { authorityId: 'human_authority_0002' }, { keyId: `sha256:${'5'.repeat(64)}` },
    { host: { ...challenge.host, authority: 'other.invalid' } }, { host: { ...challenge.host, id: 'seat_account_00002' } },
    { service: { ...challenge.service, serviceId: 'seat_service_00002' } }, { service: { ...challenge.service, serviceBootId: 'service_boot_00002' } },
    { room: { ...challenge.room, roomId: '5'.repeat(32) } }, { room: { ...challenge.room, epoch: '6'.repeat(32) } },
    { requester: { ...challenge.requester, accountId: 'seat_account_00002' } },
    { requester: { ...challenge.requester, registrationId: 'registration_00002' } },
    { requester: { ...challenge.requester, generation: 2 } }, { operationId: 'operation_break_02' },
    { requestDigest: `sha256:${'7'.repeat(64)}` }, { policyRevision: 2 }, { challengeId: 'challenge_break_02' },
    { nonce: '8'.repeat(64) }, { issuedAt: '2026-09-06T03:00:01.000Z' }, { expiresAt: '2026-09-06T03:01:01.000Z' },
  ];
  for (const mutation of mutations) {
    const altered = { ...challenge, ...mutation };
    assert.equal(verify(null, humanOperationSigningBytes(altered), key.publicKey, Buffer.from(proof.signature, 'hex')), false, JSON.stringify(mutation));
    assert.throws(() => oracle({ ...proof, challenge: altered }), /context-mismatch/);
  }
});

test('real signatures distinguish enrolled key from stranger, malformed or other-domain proof', () => {
  const foreign = sign(null, humanOperationSigningBytes(challenge), stranger.privateKey).toString('hex');
  assert.throws(() => oracle({ ...proof, signature: foreign }), /signature-refused/);
  const otherDomain = sign(null, Buffer.from('native-service-hello'), key.privateKey).toString('hex');
  assert.throws(() => oracle({ ...proof, signature: otherDomain }), /signature-refused/);
  assert.throws(() => oracle({ ...proof, signature: '0'.repeat(128) }), /signature-refused/);
});

test('valid signature does not substitute for grant, protected custody or target time', () => {
  assert.throws(() => oracle(proof, { active: false }), /grant-revoked/);
  assert.throws(() => oracle(proof, { profile: 'cooperative' }), /custody-unproven/);
  assert.throws(() => oracle(proof, { profile: 'unknown' }), /custody-unproven/);
  assert.throws(() => oracle(proof, { now: challenge.expiresAt }), /challenge-expired/);
  assert.throws(() => oracle(proof, { now: '2026-09-06T02:59:59.999Z' }), /challenge-expired/);
  assert.equal(oracle(proof, { now: challenge.issuedAt }), 'proof-valid');
});

test('wire authority labels, unknown actions and bad lifetimes are rejected without echoing input', () => {
  for (const field of ['authorKind', 'verified', 'profile', 'grant', 'privateKey']) {
    assert.throws(() => parseUnverifiedHumanOperationProof({ ...proof, [field]: 'SECRET-SENTINEL' }), (e) => e instanceof ProtocolValidationError && !e.message.includes('SECRET-SENTINEL'));
  }
  for (const mutation of [{ action: 'room-enroll' }, { expiresAt: challenge.issuedAt }, { expiresAt: '2026-09-06T03:02:00.001Z' }, { nonce: '4'.repeat(63) }, { policyRevision: 0 }]) {
    assert.throws(() => validateHumanOperationChallenge({ ...challenge, ...mutation }), ProtocolValidationError);
  }
  assert.throws(() => parseUnverifiedHumanOperationProof({ ...proof, signature: proof.signature.toUpperCase() }), ProtocolValidationError);
});

test('both first consumers use the same closed contract without changing general OperatorAct', () => {
  const compose = { ...challenge, action: 'message-compose' };
  const composed = { challenge: compose, signature: sign(null, humanOperationSigningBytes(compose), key.privateKey).toString('hex') };
  assert.equal(oracle(composed, { expected: compose }), 'proof-valid');
  assert.throws(() => oracle(composed), /context-mismatch/, 'compose consent is not break consent');
});
