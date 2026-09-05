// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ProtocolValidationError } from '../src/protocol/common.mjs';
import { assertAcceptedHostContext, assertScopedNativeCursorContext, scopedNativeIdentityKey, validateAcceptedHostContext, validateAccountRef, validateBearerAttestation, validateOperatorAct, assertOperatorActContext } from '../src/protocol/identity.mjs';
import { negotiateNativeCapabilities, assertNegotiatedCapabilitiesContext, validateAdvertisedCapabilities, validateRequiredCapabilities, validateNegotiatedCapabilities } from '../src/protocol/capabilities.mjs';
import { validateOriginReference, assertOriginContext } from '../src/protocol/origin.mjs';
import { validateNativeOperationRequest, validateNativeOperationEvent, nativeOperationPayloadDigest, assertNativeOperationEventContext } from '../src/protocol/operation.mjs';
import { validateAppendRequest, validateNativeMessage, validateLegacyUnattestedMessage, assertMessageContext } from '../src/protocol/message.mjs';
import { validateNativeReadResult, validateNativeCheckpoint, assertNativeReadContext } from '../src/protocol/read.mjs';
import { validateRouteBinding, validateRouteDescriptor, validateRouteStatus, assertRouteContext, publicNodeKeyDigest } from '../src/protocol/route.mjs';
import { validateResourceLifetime, assertResourceOwnerContext } from '../src/protocol/resource-lifetime.mjs';

const roomId = 'a'.repeat(32), epoch = 'b'.repeat(32), accountId = 'account0000000001', operationId = 'operation0000001';
const host = { scheme: /** @type {const} */ ('native'), authority: 'enrolled-seat-A', id: 'host000000000001' };
const otherHost = { ...host, authority: 'enrolled-seat-B' };
const service = { serviceId: 'service000000001', serviceBootId: 'boot000000000001' };
const registration = { accountId, registrationId: 'registered000001', generation: 1 };
const bearer = { ...registration, label: 'Bruno/contracts', attestor: service };
const digest = `sha256:${'c'.repeat(64)}`;
const ts = '2026-09-05T12:00:00.000Z';
const id = createHash('sha256').update(`${roomId}\0${accountId}\0${operationId}`).digest('hex');
const receipt = { roomId, accountId, operationId, id, cursor: `${epoch}:1` };
const message = { id, room: roomId, author: { id: accountId, name: 'Bruno', kind: /** @type {const} */ ('agent') }, text: 'hello', ts, cursor: `${epoch}:1`,
  account: { accountId, principal: host, attestor: service }, bearer };
const legacyAttachment = { id: 'attachment000001', digest, name: 'x.txt', kind: /** @type {const} */ ('file'), size: 3 };
const binding = { host, member: host, accountId, serviceBootId: service.serviceBootId, roomId, roomEpoch: epoch, membershipRevision: 2,
  grantId: 'grant00000000001', routeGeneration: 'route00000000001', allowedKeyDigest: digest };
const descriptor = { binding, protocol: 'agora-native/1', endpoint: { transport: 'tailcat', address: 'a'.repeat(20), port: 443 }, issuedAt: ts, descriptorDigest: digest, proofRef: 'local-proof-ref' };
const origin = { source: { transport: 'slack', room: 'C123', id: '1788590846.467739' }, ts, author: { id: 'U1', name: 'Reader', kind: 'human' }, attestor: service };
const coverageRoom = { host, roomId, epoch };
const page = { messages: [message], checkpoint: { roomId, epoch, sequence: 1, digest }, coverage: { room: coverageRoom, fromExclusive: `${epoch}:0`, toInclusive: `${epoch}:1`, committedThrough: `${epoch}:3` } };
const both = { advertised: ['contracts-v2', 'board-v1'], required: ['contracts-v2'] };
/** @param {() => unknown} fn */
const refuses = (fn) => assert.throws(fn, ProtocolValidationError);

test('native host identity is stable, scoped and cannot fall back to naked IDs', () => {
  const a = { transport: 'native', host, roomId, id }, b = { ...a, host: otherHost };
  assert.notEqual(scopedNativeIdentityKey(a), scopedNativeIdentityKey(b));
  assert.equal(scopedNativeIdentityKey(a), scopedNativeIdentityKey(structuredClone(a)));
  refuses(() => scopedNativeIdentityKey(id));
  refuses(() => scopedNativeIdentityKey({ id }));
  assert.deepEqual(validateAcceptedHostContext({ host }), { host });
  refuses(() => validateAcceptedHostContext({ host, nonce: 'secret' }));
  refuses(() => validateAcceptedHostContext({ host, serviceBootId: service.serviceBootId }));
  refuses(() => validateAcceptedHostContext({ host: { ...host, scheme: 'slack' } }));
  assert.notEqual(scopedNativeIdentityKey(a), scopedNativeIdentityKey({ ...a, host: { ...host, id: 'host000000000002' } }));
});

test('host equality requires actual, enrolled and authenticated-peer inputs to agree', () => {
  assert.deepEqual(assertAcceptedHostContext({ host }, host, { host }), { host });
  refuses(() => assertAcceptedHostContext({ host: otherHost }, host, { host }));
  refuses(() => assertAcceptedHostContext({ host }, otherHost, { host }));
  refuses(() => assertAcceptedHostContext({ host }, host, { host: otherHost }));
  // All-equal counterfeit DTOs parse: possession/authentication is deliberately not claimed.
  assert.deepEqual(assertAcceptedHostContext({ host: otherHost }, otherHost, { host: otherHost }), { host: otherHost });
});

test('scoped cursor refuses same-epoch retargeting, naked cursor and noncanonical decimal', () => {
  const cursor = { host, roomId, cursor: `${epoch}:8` };
  assert.deepEqual(assertScopedNativeCursorContext(cursor, coverageRoom), cursor);
  refuses(() => assertScopedNativeCursorContext(cursor, { ...coverageRoom, roomId: 'd'.repeat(32) }));
  refuses(() => assertScopedNativeCursorContext(cursor, { ...coverageRoom, host: otherHost }));
  refuses(() => assertScopedNativeCursorContext(`${epoch}:8`, coverageRoom));
  for (const bad of ['08', '-0', '1\n', '9007199254740992']) refuses(() => assertScopedNativeCursorContext({ ...cursor, cursor: `${epoch}:${bad}` }, coverageRoom));
});

test('explicit closed capability negotiation enforces both peers and board dependency', () => {
  const result = negotiateNativeCapabilities(both, both, { host });
  assert.deepEqual(result, { host, negotiated: ['contracts-v2', 'board-v1'] });
  assert.deepEqual(assertNegotiatedCapabilitiesContext(result, both, both, { host }), result);
  assert.deepEqual(negotiateNativeCapabilities({ advertised: [], required: [] }, { advertised: [], required: [] }, { host }), { host, negotiated: [] });
  refuses(() => negotiateNativeCapabilities(both, { advertised: [], required: [] }, { host }));
  refuses(() => negotiateNativeCapabilities({ advertised: [], required: [] }, both, { host }));
  refuses(() => negotiateNativeCapabilities({ advertised: ['board-v1'], required: [] }, { advertised: ['board-v1'], required: [] }, { host }));
  refuses(() => assertNegotiatedCapabilitiesContext(result, both, both, { host: otherHost }));
  refuses(() => validateRequiredCapabilities({ required: ['unknown-v2'] }));
  refuses(() => validateAdvertisedCapabilities({ advertised: ['contracts-v2', 'contracts-v2'] }));
});

test('caller sequencing refuses unsupported negotiation before injected effects', () => {
  let effects = 0;
  // This wrapper is a pure consumer-order fixture, not a production handshake acceptance test.
  const afterVerifiedServer = () => { negotiateNativeCapabilities(both, { advertised: [], required: [] }, { host }); effects++; };
  refuses(afterVerifiedServer);
  assert.equal(effects, 0);
});

test('operation requests are kind-bound closed payloads without sender identity', () => {
  assert.deepEqual(validateNativeOperationRequest({ kind: 'message', operationId, payload: { text: 'hello' } }), { kind: 'message', operationId, payload: { text: 'hello' } });
  for (const action of ['claim', 'renew', 'release', 'contest']) {
    const payload = { action, subject: 'work:protocol', ...(action === 'renew' || action === 'release' ? { leaseId: 'lease00000000001', fence: `${epoch}:1` } : action === 'contest' ? { because: 'Evidence differs.' } : {}) };
    assert.deepEqual(validateNativeOperationRequest({ kind: 'board', operationId, payload }).payload, payload);
    refuses(() => validateNativeOperationRequest({ kind: 'board', operationId, payload: { ...payload, holder: registration } }));
  }
  refuses(() => validateNativeOperationRequest({ kind: 'message', operationId, payload: { text: 'hello', accountId } }));
  refuses(() => validateNativeOperationRequest({ kind: 'board', operationId, payload: { action: 'claim', subject: 'work:a', because: 'extra' } }));
  refuses(() => validateNativeOperationRequest({ kind: 'board', operationId, payload: { action: 'renew', subject: 'work:a' } }));
  refuses(() => validateNativeOperationRequest({ kind: 'board', operationId, payload: { action: 'renew', subject: 'work:a', leaseId: 'lease00000000001', fence: `${epoch}:0` } }));
  refuses(() => validateNativeOperationRequest({ kind: 'message', operationId, payload: { text: '\ud800' } }));
});

test('new digest recipe has fixed domain, canonical preimage and a golden vector', () => {
  const preimage = '{"domain":"agora-native-operation/2","kind":"message","payload":{"text":"hello"}}';
  const golden = 'sha256:a072524cfb98c89054d5ccca93744365187d3027f82ad7eecb3fe1956a9a1d67';
  assert.equal(`sha256:${createHash('sha256').update(preimage, 'utf8').digest('hex')}`, golden);
  assert.equal(nativeOperationPayloadDigest('message', { text: 'hello' }), golden);
  assert.equal(nativeOperationPayloadDigest('message', { text: 'hello', thread: id }), nativeOperationPayloadDigest('message', { thread: id, text: 'hello' }));
  assert.notEqual(nativeOperationPayloadDigest('message', { text: 'é' }), nativeOperationPayloadDigest('message', { text: 'e\u0301' }));
});

test('event wraps unchanged receipt and refuses kind or payload swap on retry', () => {
  const request = { kind: 'message', operationId, payload: { text: 'hello' } };
  const event = { kind: 'message', receipt, payload: request.payload, payloadDigest: nativeOperationPayloadDigest('message', request.payload) };
  assert.deepEqual(validateNativeOperationEvent(event).receipt, receipt);
  assert.deepEqual(assertNativeOperationEventContext(event, request), event);
  const boardPayload = { action: 'claim', subject: 'work:a' };
  refuses(() => validateNativeOperationEvent({ ...event, kind: 'board', payload: boardPayload }));
  refuses(() => assertNativeOperationEventContext({ kind: 'board', receipt, payload: boardPayload, payloadDigest: nativeOperationPayloadDigest('board', boardPayload) }, request));
  refuses(() => assertNativeOperationEventContext(event, { ...request, payload: { text: 'changed' } }));
});

test('strict messages preserve text and require context-bound account/bearer admission', () => {
  const text = '\ufeffline\r\ne\u0301 \\ end  ';
  assert.equal(validateNativeMessage({ ...message, text }).text, text);
  const expected = { roomId, epoch, accountId, authorKind: 'agent', attestor: service, bearer: registration };
  assert.deepEqual(assertMessageContext(message, expected), message);
  refuses(() => assertMessageContext({ ...message, author: { ...message.author, kind: 'human' } }, expected));
  const { bearer: removed, ...withoutBearer } = message;
  assert.deepEqual(validateNativeMessage(withoutBearer), withoutBearer);
  refuses(() => assertMessageContext(withoutBearer, expected));
  refuses(() => validateNativeMessage({ ...message, bearer: { ...bearer, accountId: 'account000000002' } }));
  refuses(() => validateAppendRequest({ operationId, text: 'origin: human', authorKind: 'human' }));
});

test('origin source host is separate from destination; body cannot supply attestation', () => {
  assert.deepEqual(assertOriginContext(origin, { source: origin.source, attestor: service }), origin);
  const nativeOrigin = { ...origin, source: { transport: 'native', host: otherHost, room: roomId, id } };
  assert.deepEqual(validateNativeMessage({ ...message, origin: nativeOrigin }).origin?.source, nativeOrigin.source);
  refuses(() => validateOriginReference({ ...nativeOrigin, source: { transport: 'native', room: roomId, id } }));
  refuses(() => validateOriginReference({ ...origin, source: { ...origin.source, host } }));
  refuses(() => assertOriginContext(origin, { source: { ...origin.source, id: 'different' }, attestor: service }));
});

test('legacy projection stays explicitly unattested and adds no attachment lifetime', () => {
  const { account: removedAccount, bearer: removedBearer, ...old } = message;
  const input = { provenance: 'legacy-unattested', message: { ...old, attachments: [legacyAttachment] } };
  const before = JSON.stringify(input), result = validateLegacyUnattestedMessage(input);
  assert.deepEqual(result, input);
  assert.equal(JSON.stringify(input), before);
  assert.equal(Object.hasOwn(result.message.attachments?.[0] ?? {}, 'lifetime'), false);
  refuses(() => validateNativeMessage(input.message));
  refuses(() => validateLegacyUnattestedMessage({ ...input, message: { ...input.message, account: message.account } }));
  refuses(() => validateLegacyUnattestedMessage({ ...input, message: { ...input.message, attachments: [{ ...legacyAttachment, lifetime: 'durable' }] } }));
});

test('read result retains digest checkpoint and binds contiguous scanned interval', () => {
  assert.deepEqual(assertNativeReadContext(page, coverageRoom, `${epoch}:0`), page);
  const boardOnly = { ...page, messages: [], checkpoint: { ...page.checkpoint, sequence: 2 }, coverage: { ...page.coverage, toInclusive: `${epoch}:2` } };
  assert.deepEqual(assertNativeReadContext(boardOnly, coverageRoom, `${epoch}:0`), boardOnly);
  refuses(() => assertNativeReadContext(boardOnly, coverageRoom, `${epoch}:1`));
  refuses(() => assertNativeReadContext(boardOnly, { ...coverageRoom, host: otherHost }, `${epoch}:0`));
  refuses(() => validateNativeReadResult({ ...boardOnly, checkpoint: `${epoch}:2` }));
  refuses(() => validateNativeReadResult({ ...boardOnly, checkpoint: page.checkpoint }));
  refuses(() => validateNativeReadResult({ ...boardOnly, coverage: { ...boardOnly.coverage, committedThrough: `${epoch}:1` } }));
  refuses(() => validateNativeReadResult({ ...page, coverage: { ...page.coverage, fromExclusive: `${epoch}:2` } }));
  refuses(() => validateNativeReadResult({ ...page, coverage: { ...page.coverage, toInclusive: `${'d'.repeat(32)}:1` } }));
});

test('negotiated read carries mixed strict and explicit historical rows without invented attestations', () => {
  const { account: removedAccount, bearer: removedBearer, ...old } = message;
  const legacy = { provenance: 'legacy-unattested', message: { ...old, author: { ...old.author, name: 'é'.repeat(119) + '\n' }, attachments: [{ ...legacyAttachment, name: 'é'.repeat(255), mimetype: 'é'.repeat(200) }] } };
  const next = { ...message, id: 'f'.repeat(64), cursor: `${epoch}:2` };
  const mixed = { ...page, messages: [legacy, next], checkpoint: { ...page.checkpoint, sequence: 2 }, coverage: { ...page.coverage, toInclusive: `${epoch}:2` } };
  assert.deepEqual(assertNativeReadContext(mixed, coverageRoom, `${epoch}:0`), mixed);
  refuses(() => validateNativeReadResult({ ...mixed, messages: [next, legacy] }));
  refuses(() => validateLegacyUnattestedMessage({ ...legacy, message: { ...legacy.message, author: { ...legacy.message.author, name: 'é'.repeat(121) } } }));
  refuses(() => validateLegacyUnattestedMessage({ ...legacy, message: { ...legacy.message, text: '\ud800' } }));
});

test('read rejects duplicate, unordered and out-of-range messages without assuming message contiguity', () => {
  const second = { ...message, id: 'f'.repeat(64), cursor: `${epoch}:3` };
  const wide = { ...page, messages: [message, second], checkpoint: { ...page.checkpoint, sequence: 3 }, coverage: { ...page.coverage, toInclusive: `${epoch}:3` } };
  assert.deepEqual(validateNativeReadResult(wide), wide);
  refuses(() => validateNativeReadResult({ ...wide, messages: [second, message] }));
  refuses(() => validateNativeReadResult({ ...wide, messages: [message, { ...second, id }] }));
  refuses(() => validateNativeReadResult({ ...page, messages: [second] }));
  refuses(() => validateNativeReadResult({ ...page, messages: [{ ...message, room: 'e'.repeat(32) }] }));
  refuses(() => validateNativeCheckpoint({ roomId, epoch, sequence: 0, digest }));
  refuses(() => validateNativeCheckpoint({ roomId, epoch, sequence: 1, digest: null }));
  assert.deepEqual(validateNativeCheckpoint({ roomId, epoch, sequence: 0, digest: null }), { roomId, epoch, sequence: 0, digest: null });
});

test('route context compares every independent generation and specific grant revision', () => {
  assert.deepEqual(assertRouteContext(binding, structuredClone(binding)), binding);
  for (const replacement of [{ host: otherHost }, { member: otherHost }, { accountId: 'account000000002' }, { serviceBootId: 'boot000000000002' },
    { roomId: 'e'.repeat(32) }, { roomEpoch: 'e'.repeat(32) }, { membershipRevision: 3 }, { grantId: 'grant00000000002' }, { routeGeneration: 'route00000000002' }, { allowedKeyDigest: `sha256:${'e'.repeat(64)}` }]) {
    refuses(() => assertRouteContext(binding, { ...binding, ...replacement }));
  }
  // Unrelated grant history is deliberately outside this DTO, so does not alter A's context.
  const authority = { grantA: binding, unrelatedGrantRevision: 3 };
  authority.unrelatedGrantRevision++;
  assert.deepEqual(assertRouteContext(binding, authority.grantA), binding);
  assert.equal(validateRouteStatus({ binding, authority: 'revoked', resource: 'cleanup-pending', observedAt: ts }).resource, 'cleanup-pending');
});

test('public key digest is full hash of exact canonical text', () => {
  const key = `nodekey:${'01'.repeat(32)}`;
  assert.equal(publicNodeKeyDigest(key), 'sha256:1a8cac072dd0896b15eea5efd9068ca4bb6b6cfda45559796f8eb9ae86952e09');
  assert.notEqual(publicNodeKeyDigest(key), `sha256:${createHash('sha256').update(Buffer.from('01'.repeat(32), 'hex')).digest('hex')}`);
  for (const bad of [key + '\n', key.toUpperCase(), ' ' + key, key.slice(8)]) refuses(() => publicNodeKeyDigest(bad));
  refuses(() => validateRouteBinding({ ...binding, allowedKeyDigest: publicNodeKeyDigest(key).slice(0, 23) }));
});

test('route endpoint preserves 20–1800 ASCII envelope with no trimming or coercion', () => {
  refuses(() => validateRouteDescriptor({ ...descriptor, protocol: 'agora-native/2' }));
  for (const n of [20, 512, 513, 1800]) assert.equal(validateRouteDescriptor({ ...descriptor, endpoint: { ...descriptor.endpoint, address: 'a'.repeat(n) } }).endpoint.address.length, n);
  for (const address of ['a'.repeat(19), 'a'.repeat(1801), 'a'.repeat(20) + '\n', 'a'.repeat(20) + ' ', 'a'.repeat(20) + 'é']) refuses(() => validateRouteDescriptor({ ...descriptor, endpoint: { ...descriptor.endpoint, address } }));
  for (const port of [0, 65536, '443']) refuses(() => validateRouteDescriptor({ ...descriptor, endpoint: { ...descriptor.endpoint, port } }));
});

test('managed lifetimes are disjoint and service ownership does not imply liveness', () => {
  const lifetime = { kind: 'service', owner: service };
  assert.deepEqual(assertResourceOwnerContext(lifetime, service), lifetime);
  refuses(() => assertResourceOwnerContext(lifetime, { ...service, serviceBootId: 'boot000000000002' }));
  refuses(() => validateResourceLifetime({ ...lifetime, expiresAt: ts }));
  refuses(() => validateResourceLifetime({ kind: 'expiring', expiresAt: ts, owner: service }));
  refuses(() => assertResourceOwnerContext({ kind: 'expiring', expiresAt: ts }, service));
  assert.deepEqual(validateResourceLifetime({ kind: 'expiring', expiresAt: ts }), { kind: 'expiring', expiresAt: ts });
  let effects = 0;
  const requireLiveOwner = (/** @type {boolean} */ live, /** @type {boolean} */ cancelled) => {
    assertResourceOwnerContext(lifetime, service);
    if (!live || cancelled) return;
    effects++;
  };
  requireLiveOwner(false, false); requireLiveOwner(true, true);
  assert.equal(effects, 0);
  requireLiveOwner(true, false); assert.equal(effects, 1);
});

test('operator act context is explicit and time-bounded, never a label-derived authority', () => {
  const act = { version: 1, action: 'room-enroll', authorityId: 'authority0000001', proofRef: 'opaque-local-proof', targetServiceId: service.serviceId,
    operationId, requestDigest: digest, challengeId: 'challenge0000001', issuedAt: ts, expiresAt: '2026-09-05T13:00:00.000Z', revisions: { policy: 1 }, room: { roomId, epoch } };
  assert.deepEqual(assertOperatorActContext(act, act, ts), act);
  refuses(() => assertOperatorActContext(act, { ...act, operationId: 'operation0000002' }, ts));
  refuses(() => assertOperatorActContext(act, act, act.expiresAt));
  refuses(() => validateOperatorAct({ ...act, expiresAt: ts }));
});

/** @type {[string,(value:unknown)=>unknown,object][]} */
const closedFixtures = [
  ['account', validateAccountRef, host], ['host', validateAcceptedHostContext, { host }], ['bearer', validateBearerAttestation, bearer],
  ['advertised', validateAdvertisedCapabilities, { advertised: [] }], ['required', validateRequiredCapabilities, { required: [] }],
  ['negotiated', validateNegotiatedCapabilities, { host, negotiated: [] }], ['origin', validateOriginReference, origin],
  ['operation', validateNativeOperationRequest, { kind: 'message', operationId, payload: { text: 'hello' } }],
  ['message', validateNativeMessage, message], ['read', validateNativeReadResult, page], ['route', validateRouteBinding, binding],
  ['descriptor', validateRouteDescriptor, descriptor], ['lifetime', validateResourceLifetime, { kind: 'service', owner: service }],
];
for (const [name, validate, fixture] of closedFixtures) test(`${name} rejects unknown fields, undefined, accessors and custom prototypes`, () => {
  const before = JSON.stringify(fixture);
  const parsed = validate(fixture);
  assert.notEqual(parsed, fixture);
  assert.equal(JSON.stringify(fixture), before);
  refuses(() => validate({ ...fixture, extra: true }));
  const key = Object.keys(fixture)[0];
  refuses(() => validate({ ...fixture, [key]: undefined }));
  let called = false;
  const getter = { ...fixture };
  Object.defineProperty(getter, key, { enumerable: true, get() { called = true; return null; } });
  refuses(() => validate(getter)); assert.equal(called, false);
  refuses(() => validate(Object.assign(Object.create({ inherited: true }), fixture)));
  refuses(() => validate({ ...fixture, [Symbol('extra')]: true }));
});
