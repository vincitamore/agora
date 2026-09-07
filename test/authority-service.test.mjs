// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { AuthorityJournal } from '../src/authority-journal.mjs';
import { NativeRoomService, NativeServiceClient } from '../src/native-service.mjs';
import { authorityIdForKey, createAuthorityEnrollmentChallenge, authorityEnrollmentSigningBytes,
  enrollAuthorityRecord, authoritySigningBytes, createAuthorityChallenge } from '../src/authority.mjs';
import { publicNodeKeyDigest } from '../src/protocol/route.mjs';
import { humanKeyId } from '../src/protocol/human-authority.mjs';
import { buildRouteBinding } from '../src/native-member.mjs';
import { PassThrough, Duplex } from 'node:stream';
import { EventEmitter } from 'node:events';
import { NativeFrameDecoder } from '../src/native-protocol.mjs';

const NOW = '2026-09-07T20:00:00.000Z', ACCOUNT = 'a'.repeat(32), ROOM = 'b'.repeat(32);
const LOCAL = `nodekey:${'1'.repeat(64)}`, PEER = `nodekey:${'2'.repeat(64)}`, MEMBER = `nodekey:${'3'.repeat(64)}`;
const refusal = (/** @type {string} */ code) => ({ name: 'AuthorityError', code });
function transport() {
  /** @type {(stream: any) => void} */ let accept = () => { throw Error('listener absent'); };
  let starts = 0, closes = 0;
  const routeOptions = {
    listen: async (/** @type {(stream: any) => void} */ hook) => {
      accept = hook; starts++; return { port: 4242, close: async () => { closes++; } };
    },
    spawn: async (/** @type {string[]} */ args, /** @type {any} */ _runtime, /** @type {any} */ owner) => {
      const child = /** @type {any} */ (new EventEmitter());
      child.stdout = new PassThrough(); child.exitCode = null; child.signalCode = null; child.connected = false;
      const finish = () => { if (child.exitCode !== null) return; child.exitCode = 0; child.stdout.end(); child.emit('exit', 0, null); };
      if (args[0] === 'parse') queueMicrotask(finish);
      else owner.signal.addEventListener('abort', finish, { once: true });
      return child;
    },
    address: async () => `tc${'a'.repeat(48)}`,
  };
  return { routeOptions, accept: (/** @type {any} */ stream) => accept(stream), starts: () => starts, closes: () => closes };
}
function loopback() {
  const toHost = new PassThrough(), toClient = new PassThrough();
  const host = Duplex.from({ readable: toHost, writable: toClient }), client = Duplex.from({ readable: toClient, writable: toHost });
  // Duplex.from emits ABORT_ERR when its opposite half is deliberately refused/closed.
  host.on('error', () => {}); client.on('error', () => {});
  return { host, client };
}
/** @param {import('node:stream').Duplex} stream */
function firstFrame(stream) {
  return new Promise((resolve, reject) => {
    const decoder = new NativeFrameDecoder();
    const timer = setTimeout(() => { cleanup(); reject(Error('frame timeout')); }, 2000);
    const onData = (/** @type {Buffer} */ bytes) => {
      const frame = decoder.push(bytes)[0]; if (frame) { cleanup(); resolve(/** @type {any} */ (frame)); }
    };
    const cleanup = () => { clearTimeout(timer); stream.off('data', onData); };
    stream.on('data', onData);
  });
}
/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'agora-act-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keys = generateKeyPairSync('ed25519');
  const publicKey = Buffer.from(/** @type {string} */ (keys.publicKey.export({ format: 'jwk' }).x), 'base64url').toString('hex');
  const record = { version: 1, algorithm: 'ed25519', authorityId: authorityIdForKey(publicKey), publicKey,
    keyId: humanKeyId(publicKey), boundNodeKeyDigest: publicNodeKeyDigest(PEER), enrolledAt: NOW,
    enrolledBy: 'operator-local-bootstrap', label: 'counter seat', profile: 'pinned-cooperative',
    policy: { policyId: 'c'.repeat(32), revision: 1, validFrom: NOW, expiresAt: '2026-09-08T20:00:00.000Z',
      entries: [{ roomId: ROOM, allowedKeyDigest: publicNodeKeyDigest(MEMBER), actions: ['room-enroll', 'room-revoke'] }] } };
  const challenge = createAuthorityEnrollmentChallenge(record, publicNodeKeyDigest(LOCAL), NOW);
  await enrollAuthorityRecord(root, record, record.keyId, { targetNodeKeyDigest: publicNodeKeyDigest(LOCAL),
    retainedChallenge: challenge, now: NOW,
    proof: { challenge, signature: sign(null, authorityEnrollmentSigningBytes(challenge), keys.privateKey).toString('hex') } });
  const options = { root, accountId: ACCOUNT, seatLabel: 'target', authorityId: record.authorityId,
    now: () => new Date(NOW), readLocalIdentity: async () => ({ nodeKey: LOCAL }) };
  const service = new NativeRoomService(options);
  await service.start();
  t.after(() => service.stop());
  await service.createRoom({ roomId: ROOM });
  const signed = (/** @type {unknown} */ challenge) => ({ challenge,
    signature: sign(null, authoritySigningBytes(challenge), keys.privateKey).toString('hex') });
  const journal = service.authorityJournal; assert.ok(journal);
  return { root, keys, record, options, service, signed, journal };
}

test('authority absence refuses unsigned and signed-shaped route verbs without minting identity', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'agora-no-act-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new NativeRoomService({ root, accountId: ACCOUNT, seatLabel: 'plain' });
  await service.start(); t.after(() => service.stop());
  for (const proof of [undefined, { verified: true }]) {
    await assert.rejects(service.openRoute({ roomId: ROOM, publicNodeKey: MEMBER, proof }), refusal('authority-absent'));
    await assert.rejects(service.closeRoute({ roomId: ROOM, publicNodeKey: MEMBER, proof }), refusal('authority-absent'));
  }
  await assert.rejects(readFile(path.join(root, 'tailcat', 'identity.private.json')), { code: 'ENOENT' });
  assert.deepEqual(service.listRoutes(), []);
});

test('enrolled authority closes unsigned direct methods, not just CLI preflight', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.service.openRoute({ roomId: ROOM, publicNodeKey: MEMBER }), refusal('operator-proof-required'));
  await assert.rejects(f.service.closeRoute({ roomId: ROOM, publicNodeKey: MEMBER }), refusal('operator-proof-required'));
  assert.deepEqual(f.service.listRoutes(), []);
  assert.equal((await readFile(path.join(f.root, 'native/authority-journal/events.jsonl'), 'utf8')), '');
});

test('challenge owns boot, target and binding; caller mutation and out-of-policy keys cannot select context', async (t) => {
  const f = await fixture(t);
  const pending = await f.service.createRouteChallenge({ action: 'room-enroll', roomId: ROOM, publicNodeKey: MEMBER });
  assert.equal(pending.request.targetNodeKeyDigest, publicNodeKeyDigest(LOCAL));
  assert.equal(pending.request.binding.serviceBootId, f.service.bootEpoch);
  pending.request.targetNodeKeyDigest = publicNodeKeyDigest(PEER);
  pending.challenge.targetNodeKeyDigest = publicNodeKeyDigest(PEER);
  await assert.rejects(f.service.openRoute({ roomId: ROOM, publicNodeKey: MEMBER, proof: f.signed(pending.challenge) }), refusal('operator-context-refused'));
  await assert.rejects(f.service.createRouteChallenge({ action: 'room-enroll', roomId: ROOM, publicNodeKey: PEER }), refusal('operator-scope-refused'));
});

test('startup record is a snapshot; changing its file does not change the running verifier policy', async (t) => {
  const f = await fixture(t);
  const changed = structuredClone(f.record); changed.policy.entries = [];
  await writeFile(path.join(f.root, 'native/authorities', `${f.record.authorityId}.json`), JSON.stringify(changed));
  await f.service.createRouteChallenge({ action: 'room-enroll', roomId: ROOM, publicNodeKey: MEMBER });
  await f.service.stop();
  const replacement = new NativeRoomService(f.options);
  await replacement.start(); t.after(() => replacement.stop());
  await assert.rejects(replacement.createRouteChallenge({ action: 'room-enroll', roomId: ROOM, publicNodeKey: MEMBER }), refusal('operator-scope-refused'));
});

test('local wire challenge retains service context and unsigned wire open produces no effect', async (t) => {
  const f = await fixture(t), client = await NativeServiceClient.connect(/** @type {any} */ (f.service.descriptor()));
  t.after(() => client.close());
  const result = await client.request('route-challenge', { action: 'room-enroll', roomId: ROOM, publicNodeKey: MEMBER });
  assert.equal(result.challenge.targetNodeKeyDigest, publicNodeKeyDigest(LOCAL));
  // L8 owns the native error-frame code surface; this cell also measures the service journal.
  await assert.rejects(client.request('route-open', { roomId: ROOM, publicNodeKey: MEMBER }), /operator-proof-required/);
  assert.deepEqual(f.service.listRoutes(), []);
  assert.equal(f.journal.operations.size, 0);
});

test('journal synchronously reserves replay identity and retains intent without rerunning effects after restart', async (t) => {
  const f = await fixture(t);
  const p = await f.service.createRouteChallenge({ action: 'room-enroll', roomId: ROOM, publicNodeKey: MEMBER });
  const journal = f.journal, proof = f.signed(p.challenge);
  const first = journal.begin(p.request, proof, { bearer: 'Bruno/uber-wizard', sessionSlug: 'claimed-session' }, NOW);
  assert.throws(() => journal.begin(p.request, proof, {}, NOW), refusal('operator-act-replayed'));
  await first;
  await f.service.stop();
  const loaded = await AuthorityJournal.load(f.root, ACCOUNT); t.after(() => loaded.close());
  assert.equal(loaded.status(p.request.operationId).state, 'intent');
  assert.throws(() => loaded.assertAvailable(ROOM), refusal('operator-recovery-required'));
  const status = loaded.status(p.request.operationId);
  assert.equal(status.authorization, 'delegation-policy');
  assert.equal(status.authenticatedPrincipal.id, ACCOUNT);
  assert.deepEqual(status.attributionClaims, { bearer: 'Bruno/uber-wizard', sessionSlug: 'claimed-session' });
  assert.ok(!('signature' in status));
});

test('journal increments revision on commit and revocation, with revocation surviving unfinished teardown', async (t) => {
  const f = await fixture(t);
  const p = await f.service.createRouteChallenge({ action: 'room-enroll', roomId: ROOM, publicNodeKey: MEMBER });
  const journal = f.journal;
  await journal.begin(p.request, f.signed(p.challenge), {}, NOW);
  await journal.finish(p.request.operationId, 'committed', NOW);
  assert.equal(journal.revision(ROOM), 2);
  const request = { ...p.request, action: 'room-revoke', operationId: 'd'.repeat(32), revisions: { policy: 1, membership: 2 } };
  const challenge = createAuthorityChallenge(f.record, request, NOW);
  await journal.begin(request, f.signed(challenge), {}, NOW);
  await journal.finish(request.operationId, 'revoked', NOW);
  assert.equal(journal.revision(ROOM), 3);
  await f.service.stop();
  const loaded = await AuthorityJournal.load(f.root, ACCOUNT); t.after(() => loaded.close());
  assert.equal(loaded.status(request.operationId).state, 'revoked');
  assert.equal(loaded.revision(ROOM), 3);
  assert.throws(() => loaded.assertAvailable(ROOM), refusal('operator-recovery-required'));
});

test('truncated journal refuses startup rather than forgetting consumed proof', async (t) => {
  const f = await fixture(t);
  const p = await f.service.createRouteChallenge({ action: 'room-enroll', roomId: ROOM, publicNodeKey: MEMBER });
  await f.journal.begin(p.request, f.signed(p.challenge), {}, NOW);
  await f.service.stop();
  const file = path.join(f.root, 'native/authority-journal/events.jsonl');
  const original = await readFile(file);
  await writeFile(file, original.subarray(0, original.length - 1));
  await assert.rejects(AuthorityJournal.load(f.root, ACCOUNT), refusal('authority-journal-corrupt'));
  await writeFile(file, original);
  const twin = await AuthorityJournal.load(f.root, ACCOUNT); await twin.close();
});

test('signed open has one effect; replay is refused and close journals revocation before teardown', async (t) => {
  const f = await fixture(t), rig = transport();
  const p = await f.service.createRouteChallenge({ action: 'room-enroll', roomId: ROOM, publicNodeKey: MEMBER });
  const input = { roomId: ROOM, publicNodeKey: MEMBER, proof: f.signed(p.challenge), routeOptions: rig.routeOptions };
  const results = await Promise.allSettled([f.service.openRoute(input), f.service.openRoute(input)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const rejected = results.find(r => r.status === 'rejected'); assert.ok(rejected && rejected.status === 'rejected');
  assert.equal(rejected.reason.code, 'operator-act-replayed');
  assert.equal(rig.starts(), 1);
  assert.equal(f.journal.status(p.request.operationId).state, 'committed');
  const close = await f.service.createRouteChallenge({ action: 'room-revoke', roomId: ROOM, publicNodeKey: MEMBER });
  const entry = [...f.service.routes.values()][0], stop = entry.resource.stop.bind(entry.resource);
  let observed = false;
  entry.resource.stop = async () => {
    assert.equal(f.journal.status(close.request.operationId).state, 'revoked');
    assert.equal(entry.activation.active, false);
    const rows = (await readFile(path.join(f.root, 'native/authority-journal/events.jsonl'), 'utf8')).trim().split('\n');
    const last = rows.at(-1); assert.ok(last);
    assert.equal(JSON.parse(last).event.kind, 'revoked');
    observed = true; return await stop();
  };
  await f.service.closeRoute({ roomId: ROOM, publicNodeKey: MEMBER, proof: f.signed(close.challenge) });
  assert.equal(observed, true); assert.equal(rig.closes(), 1);
  assert.equal(f.journal.status(close.request.operationId).state, 'closed');
  assert.deepEqual(f.service.listRoutes(), []);
});

test('dial after listener readiness but before durable commit is refused; same listener greets after commit', async (t) => {
  const f = await fixture(t), rig = transport();
  const p = await f.service.createRouteChallenge({ action: 'room-enroll', roomId: ROOM, publicNodeKey: MEMBER });
  const finish = f.journal.finish.bind(f.journal);
  let observed = false;
  f.journal.finish = async (id, kind, at) => {
    if (kind === 'committed') {
      assert.equal(rig.starts(), 1); assert.equal(f.journal.status(id).state, 'intent');
      const pair = loopback(); t.after(() => { pair.host.destroy(); pair.client.destroy(); });
      const frame = firstFrame(pair.client); rig.accept(pair.host);
      const denied = await frame;
      assert.equal(denied.type, 'error'); assert.equal(denied.message, 'member-route-not-active');
      observed = true;
    }
    return await finish(id, kind, at);
  };
  await f.service.openRoute({ roomId: ROOM, publicNodeKey: MEMBER, proof: f.signed(p.challenge), routeOptions: rig.routeOptions });
  assert.equal(observed, true);
  const pair = loopback(); t.after(() => { pair.host.destroy(); pair.client.destroy(); });
  const frame = firstFrame(pair.client); rig.accept(pair.host);
  assert.equal((await frame).type, 'member-server-hello');
  pair.client.destroy(); pair.host.destroy();
});

test('two retained challenges at one revision cannot both commit; the stale one has no listener effect', async (t) => {
  const f = await fixture(t), rig = transport();
  const a = await f.service.createRouteChallenge({ action: 'room-enroll', roomId: ROOM, publicNodeKey: MEMBER });
  const b = await f.service.createRouteChallenge({ action: 'room-enroll', roomId: ROOM, publicNodeKey: MEMBER });
  await f.service.openRoute({ roomId: ROOM, publicNodeKey: MEMBER, proof: f.signed(a.challenge), routeOptions: rig.routeOptions });
  await assert.rejects(f.service.openRoute({ roomId: ROOM, publicNodeKey: MEMBER, proof: f.signed(b.challenge), routeOptions: rig.routeOptions }), refusal('operator-context-refused'));
  assert.equal(rig.starts(), 1);
  assert.equal(f.journal.status(b.request.operationId).state, 'unknown');
});

test('failed durable commit never activates a ready listener and cleanup retains consumed intent', async (t) => {
  const f = await fixture(t), rig = transport();
  const p = await f.service.createRouteChallenge({ action: 'room-enroll', roomId: ROOM, publicNodeKey: MEMBER });
  const finish = f.journal.finish.bind(f.journal);
  f.journal.finish = async (id, kind, at) => {
    if (kind === 'committed') { f.journal.unavailable = true; throw Object.assign(Error('injected write uncertainty'), { code: 'INJECTED_SYNC' }); }
    return await finish(id, kind, at);
  };
  await assert.rejects(f.service.openRoute({ roomId: ROOM, publicNodeKey: MEMBER, proof: f.signed(p.challenge), routeOptions: rig.routeOptions }), { code: 'INJECTED_SYNC' });
  assert.equal(rig.starts(), 1); assert.equal(rig.closes(), 1);
  assert.deepEqual(f.service.listRoutes(), []);
  assert.equal(f.journal.status(p.request.operationId).state, 'intent');
  await assert.rejects(f.service.createRouteChallenge({ action: 'room-enroll', roomId: ROOM, publicNodeKey: MEMBER }), refusal('authority-journal-unavailable'));
});
