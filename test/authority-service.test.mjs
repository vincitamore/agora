// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile, stat, chmod, symlink } from 'node:fs/promises';
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
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { generateSeatAuthority, publicSeatAuthority, prepareSeatAuthorityEnrollment, signSeatAuthorityEnrollment,
  completeSeatAuthorityEnrollment, signSeatRouteAct, readAuthorityInput, writeAuthorityOutput } from '../src/service-cli.mjs';

const NOW = '2026-09-07T20:00:00.000Z', ACCOUNT = 'a'.repeat(32), ROOM = 'b'.repeat(32);
const LOCAL = `nodekey:${'1'.repeat(64)}`, PEER = `nodekey:${'2'.repeat(64)}`, MEMBER = `nodekey:${'3'.repeat(64)}`;
const SECOND_MEMBER = `nodekey:${'4'.repeat(64)}`;
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
      entries: [MEMBER, SECOND_MEMBER].map(key => ({ roomId: ROOM, allowedKeyDigest: publicNodeKeyDigest(key), actions: ['room-enroll', 'room-revoke'] })) } };
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
  const first = journal.begin(p.request, proof, { bearer: 'Astra/uber-wizard', sessionSlug: 'claimed-session' }, NOW);
  assert.throws(() => journal.begin(p.request, proof, {}, NOW), refusal('operator-act-replayed'));
  await first;
  await f.service.stop();
  const loaded = await AuthorityJournal.load(f.root, ACCOUNT); t.after(() => loaded.close());
  assert.equal(loaded.status(p.request.operationId).state, 'intent');
  assert.throws(() => loaded.assertAvailable(ROOM), refusal('operator-recovery-required'));
  const status = loaded.status(p.request.operationId);
  assert.equal(status.authorization, 'delegation-policy');
  assert.equal(status.authenticatedPrincipal.id, ACCOUNT);
  assert.deepEqual(status.attributionClaims, { bearer: 'Astra/uber-wizard', sessionSlug: 'claimed-session' });
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
  await assert.rejects(f.service.openRoute({ roomId: ROOM, publicNodeKey: MEMBER, proof: f.signed(b.challenge), routeOptions: rig.routeOptions }), refusal('route-already-open'));
  assert.equal(rig.starts(), 1);
  assert.equal(f.journal.status(b.request.operationId).state, 'unknown');
});

test('public signed same-key opens hold the inner reservation at listener acquisition and create one grant', async (t) => {
  const f = await fixture(t), first = transport(), second = transport();
  const a = await f.service.createRouteChallenge({ action: 'room-enroll', roomId: ROOM, publicNodeKey: MEMBER });
  const b = await f.service.createRouteChallenge({ action: 'room-enroll', roomId: ROOM, publicNodeKey: MEMBER });
  /** @type {boolean[]} */ const reservations = [];
  for (const rig of [first, second]) {
    const listen = rig.routeOptions.listen;
    rig.routeOptions.listen = async (...args) => {
      reservations.push(f.service.openingRoutes.has(`${ROOM}:${publicNodeKeyDigest(MEMBER)}`));
      return listen(...args);
    };
  }
  const outcomes = await Promise.allSettled([
    f.service.openRoute({ roomId: ROOM, publicNodeKey: MEMBER, proof: f.signed(a.challenge), routeOptions: first.routeOptions }),
    f.service.openRoute({ roomId: ROOM, publicNodeKey: MEMBER, proof: f.signed(b.challenge), routeOptions: second.routeOptions }),
  ]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  const lost = outcomes.find(x => x.status === 'rejected'); assert.ok(lost && lost.status === 'rejected');
  assert.deepEqual({ name: lost.reason.name, code: lost.reason.code }, refusal('route-already-open'));
  assert.deepEqual(reservations, [true], 'public effect reached listener acquisition without its inner reservation');
  assert.equal(first.starts() + second.starts(), 1);
  assert.equal(f.service.listRoutes().length, 1);
  assert.equal(f.service.listRoutes()[0].grantId, a.request.binding.grantId);
});

test('concurrent different member keys still serialize the room admission revision', async (t) => {
  const f = await fixture(t), first = transport(), second = transport();
  const a = await f.service.createRouteChallenge({ action: 'room-enroll', roomId: ROOM, publicNodeKey: MEMBER });
  const b = await f.service.createRouteChallenge({ action: 'room-enroll', roomId: ROOM, publicNodeKey: SECOND_MEMBER });
  const outcomes = await Promise.allSettled([
    f.service.openRoute({ roomId: ROOM, publicNodeKey: MEMBER, proof: f.signed(a.challenge), routeOptions: first.routeOptions }),
    f.service.openRoute({ roomId: ROOM, publicNodeKey: SECOND_MEMBER, proof: f.signed(b.challenge), routeOptions: second.routeOptions }),
  ]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  const lost = outcomes.find(x => x.status === 'rejected'); assert.ok(lost && lost.status === 'rejected');
  assert.deepEqual({ name: lost.reason.name, code: lost.reason.code }, refusal('operator-context-refused'));
  assert.equal(first.starts() + second.starts(), 1);
  assert.equal(f.service.listRoutes().length, 1); assert.equal(f.journal.revision(ROOM), 2);
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

test('intent sync uncertainty never starts an effect and survives restart as recovery-required', async (t) => {
  const f = await fixture(t), rig = transport();
  const p = await f.service.createRouteChallenge({ action: 'room-enroll', roomId: ROOM, publicNodeKey: MEMBER });
  const sync = f.journal.handle.sync.bind(f.journal.handle);
  f.journal.handle.sync = async () => { throw Object.assign(Error('injected sync failure'), {code:'EIO'}); };
  await assert.rejects(f.service.openRoute({ roomId: ROOM, publicNodeKey: MEMBER,
    proof: f.signed(p.challenge), routeOptions: rig.routeOptions }), refusal('authority-journal-unavailable'));
  assert.equal(rig.starts(), 0);
  assert.deepEqual(f.service.listRoutes(), []);
  assert.equal(f.journal.unavailable, true);
  f.journal.handle.sync = sync;
  await f.service.stop();
  // Injected I/O uncertainty, not a power-loss experiment: the write reached disk but its
  // acknowledgement did not. Reopening sees intent, never a license to repeat an effect.
  const next = new NativeRoomService(f.options); await next.start(); t.after(() => next.stop());
  assert.equal(next.authorityJournal?.status(p.request.operationId).state, 'intent');
  await assert.rejects(next.createRouteChallenge({action:'room-enroll',roomId:ROOM,publicNodeKey:MEMBER}), refusal('operator-recovery-required'));
});

test('lost open response keeps committed status and a duplicate proof cannot create another listener', async (t) => {
  const f = await fixture(t), rig = transport();
  const p = await f.service.createRouteChallenge({ action: 'room-enroll', roomId: ROOM, publicNodeKey: MEMBER });
  const input = {roomId:ROOM, publicNodeKey:MEMBER, proof:f.signed(p.challenge),routeOptions:rig.routeOptions};
  // Discard the result and reconcile from the real local status surface.
  await f.service.openRoute(input);
  const client=await NativeServiceClient.connect(/** @type {any} */(f.service.descriptor()));
  t.after(()=>client.close());
  const answer=await client.request('route-act-status',{operationId:p.request.operationId});
  assert.equal(answer.status.state,'committed');
  assert.equal(answer.status.requestDigest,f.journal.status(p.request.operationId).requestDigest);
  await assert.rejects(f.service.openRoute(input),refusal('operator-act-replayed'));
  assert.equal(rig.starts(),1);assert.equal(f.service.listRoutes().length,1);
});

test('close failure is durably revoked, keeps its cleanup handle and cannot reactivate admission', async (t) => {
  const f = await fixture(t), rig = transport();
  const p = await f.service.createRouteChallenge({ action: 'room-enroll', roomId: ROOM, publicNodeKey: MEMBER });
  await f.service.openRoute({roomId:ROOM,publicNodeKey:MEMBER,proof:f.signed(p.challenge),routeOptions:rig.routeOptions});
  const entry = f.service.routes.values().next().value; assert.ok(entry);
  const stop=entry.resource.stop.bind(entry.resource);
  let release=()=>{};
  entry.resource.closed=new Promise(resolve=>{release=()=>resolve(undefined);});
  const close=await f.service.createRouteChallenge({action:'room-revoke',roomId:ROOM,publicNodeKey:MEMBER});
  entry.resource.stop=async()=>{
    assert.equal(f.journal.status(close.request.operationId).state,'revoked');
    throw Object.assign(Error('cleanup pending'),{code:'AGORA_CLEANUP_PENDING'});
  };
  await assert.rejects(f.service.closeRoute({roomId:ROOM,publicNodeKey:MEMBER,proof:f.signed(close.challenge)}),{code:'AGORA_CLEANUP_PENDING'});
  assert.equal(entry.activation.active,false);
  assert.equal(f.service.listRoutes()[0].state,'closing');
  const pair=loopback();t.after(()=>{pair.host.destroy();pair.client.destroy();});
  const answer=firstFrame(pair.client);rig.accept(pair.host);
  assert.match((await answer).message,/member-route-not-active/);
  const file=path.join(f.root,'native/authority-journal/events.jsonl');
  assert.equal(JSON.parse((await readFile(file,'utf8')).trim().split('\n').at(-1) ?? '').event.kind,'revoked');
  entry.resource.stop=stop;await stop();release();
});

test('authority and proof rows refuse before config; each new preflight has a config-reaching valid twin', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'agora-act-preflight-')); t.after(() => rm(root, { recursive: true, force: true }));
  const run = promisify(execFile), bin = fileURLToPath(new URL('../bin/agora.mjs', import.meta.url));
  const base = { env: { ...process.env, AGORA_CONFIG: path.join(root, 'absent.json'), AGORA_STATE: root }, timeout: 5000 };
  /** @param {string[]} args */
  async function invoke(args) {
    try { return { code: 0, ...(await run(process.execPath, [bin, ...args], base)) }; }
    catch (error) { const e = /** @type {any} */ (error); return { code: e.code, stderr: e.stderr, stdout: e.stdout }; }
  }
  for (const [args, expected] of /** @type {[string[], string][]} */ ([
    [['authority', 'sign'], 'authority needs --file'],
    [['authority', 'public'], 'authority needs --out'],
    [['authority', 'keygen', '--file', 'policy.json', '--out', 'public.json', '--label', ' '], 'authority keygen --label'],
    [['authority', 'enroll', '--file', 'proof.json'], 'authority enrollment needs --fingerprint'],
    [['service', 'start', '--authority', 'not-an-id'], 'service start --authority takes'],
    [['service', 'route', 'open', ROOM, '--allow-key', MEMBER], 'route open needs --proof-file'],
    [['service', 'route', 'close', ROOM, '--allow-key', MEMBER], 'route close needs --proof-file'],
    [['service', 'route', 'challenge', ROOM, '--allow-key', MEMBER], 'route challenge needs --act'],
    [['service', 'route', 'act-status', 'wrong'], 'route act-status needs'],
  ])) {
    const result = await invoke(args); assert.equal(result.code, 2); assert.ok(result.stderr.includes(expected), result.stderr);
    assert.doesNotMatch(result.stderr, /no config at/);
  }
  for (const args of [
    ['authority', 'sign', '--file', 'challenge.json', '--out', 'new.json'],
    ['authority', 'public', '--out', 'new.json'],
    ['service', 'start', '--authority', `a-${'a'.repeat(64)}`],
    ['service', 'route', 'open', ROOM, '--allow-key', MEMBER, '--proof-file', 'proof.json'],
    ['service', 'route', 'challenge', ROOM, '--allow-key', MEMBER, '--act', 'room-enroll', '--out', 'new.json'],
  ]) {
    const result = await invoke(args); assert.equal(result.code, 1); assert.match(result.stderr, /no config at/);
  }
});

test('hand-carried bootstrap keeps signing key on counter-seat, proves possession and checks both delegation lists', async (t) => {
  const f = await fixture(t);
  const signerRoot = await mkdtemp(path.join(tmpdir(), 'agora-signer-')); t.after(() => rm(signerRoot, { recursive: true, force: true }));
  const targetRoot = await mkdtemp(path.join(tmpdir(), 'agora-target-')); t.after(() => rm(targetRoot, { recursive: true, force: true }));
  const signerIdentity = async () => ({ nodeKey: PEER }), targetIdentity = async () => ({ nodeKey: LOCAL });
  const record = await generateSeatAuthority(signerRoot, f.record.policy, 'counter-seat', signerIdentity);
  assert.ok(!('privateKey' in record)); assert.equal(record.boundNodeKeyDigest, publicNodeKeyDigest(PEER));
  const privatePath = path.join(signerRoot, 'native/authority-key.json');
  if (process.platform !== 'win32') assert.equal((await stat(privatePath)).mode & 0o777, 0o600);
  const before = await readFile(privatePath);
  // A failed public-output write must not require deleting or regenerating the signing key.
  const recovered = await publicSeatAuthority(signerRoot, signerIdentity);
  assert.deepEqual(recovered, record);
  assert.ok(!JSON.stringify(recovered).includes(JSON.parse(before.toString('utf8')).privateKey.d));
  assert.deepEqual(await readFile(privatePath), before);
  await assert.rejects(generateSeatAuthority(signerRoot, f.record.policy, 'other', signerIdentity), refusal('authority-output-exists'));
  assert.deepEqual(await readFile(privatePath), before);
  const pending = await prepareSeatAuthorityEnrollment(targetRoot, record, record.keyId, targetIdentity);
  const proof = await signSeatAuthorityEnrollment(signerRoot, pending, signerIdentity);
  const receipt = await completeSeatAuthorityEnrollment(targetRoot, proof, record.keyId, targetIdentity);
  assert.equal(receipt.authorityId, record.authorityId);
  const targetRecord = await readAuthorityInput(receipt.file, true);
  assert.ok(!('privateKey' in targetRecord));
  await assert.rejects(readFile(path.join(targetRoot, 'native/authority-key.json')), { code: 'ENOENT' });
  const service = new NativeRoomService({ root: targetRoot, accountId: ACCOUNT, seatLabel: 'target',
    authorityId: record.authorityId, readLocalIdentity: targetIdentity });
  await service.start(); t.after(() => service.stop()); await service.createRoom({ roomId: ROOM });
  const request = await service.createRouteChallenge({ action: 'room-enroll', roomId: ROOM, publicNodeKey: MEMBER });
  const signed = await signSeatRouteAct(signerRoot, request, signerIdentity);
  const rig = transport();
  await service.openRoute({ roomId: ROOM, publicNodeKey: MEMBER, proof: signed, routeOptions: rig.routeOptions });
  assert.equal(rig.starts(), 1);
  await assert.rejects(signSeatRouteAct(signerRoot, request, targetIdentity), refusal('authority-seat-binding-refused'));
  // Local signer list can be stricter than target. Pinning on target is not permission for signer.
  const keyFile = JSON.parse(before.toString('utf8')); keyFile.record.policy.entries = [];
  await writeFile(privatePath, JSON.stringify(keyFile));
  await assert.rejects(signSeatRouteAct(signerRoot, request, signerIdentity), refusal('operator-scope-refused'));
});

test('hand-carried authority input is bounded and link-refusing; public output is atomic no-clobber', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'agora-authority-io-')); t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'public.json');
  await writeAuthorityOutput(file, { public: true });
  assert.deepEqual(await readAuthorityInput(file), { public: true });
  await assert.rejects(writeAuthorityOutput(file, { replacement: true }), refusal('authority-output-exists'));
  assert.deepEqual(await readAuthorityInput(file), { public: true });
  await writeFile(file, 'x'.repeat(262145));
  await assert.rejects(readAuthorityInput(file), refusal('authority-input-too-large'));
  await writeFile(file, '{}');
  if (process.platform !== 'win32') {
    await chmod(file, 0o644);
    await assert.rejects(readAuthorityInput(file, true), refusal('authority-input-permissions'));
    assert.deepEqual(await readAuthorityInput(file), {});
    const alias = path.join(root, 'alias.json'); await symlink(file, alias);
    await assert.rejects(readAuthorityInput(alias), refusal('authority-input-unreadable'));
  }
});
