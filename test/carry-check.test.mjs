// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { writeCursor } from '../src/core.mjs';
import { inheritSession, readRecord, writeRecord } from '../src/session.mjs';
import { watch } from '../src/watch.mjs';
import { NativeRoomService } from '../src/native-service.mjs';
import { appendCarryEvent, beginCarryPost, captureCarryPost, carryRefKey, checkCarryBoundary, inheritCarryEvidence, mandateDigest, readCarryEvidence, readMandate, recordCarryCursorMove, requireCarrySuccessor, sealCarryBoundary, validateCarryEvent, validateMandate } from '../src/carry-check.mjs';
import { tmp } from './helpers.mjs';

const mandate = { version: 1, id: 'campaign-c1', bearer: 'Astra/uber-wizard', role: 'builder',
  units: [{ id: 'C1-BUILD', exhibit: 'backroom:1788832779.357259' }],
  issuedBy: 'Fable/orchestration', issuedAt: '2026-09-08T02:00:00.000Z' };

test('carry mandate pins semantic fields, including the assigner and unit exhibit', () => {
  assert.deepEqual(validateMandate(mandate), mandate);
  assert.equal(mandateDigest(mandate), mandateDigest(Object.fromEntries(Object.entries(mandate).reverse())));
  for (const key of ['id', 'bearer', 'role', 'issuedBy', 'issuedAt']) {
    assert.notEqual(mandateDigest(mandate), mandateDigest({ ...mandate,
      [key]: key === 'issuedAt' ? '2026-09-08T02:00:01.000Z' : 'changed' }), key);
  }
  assert.notEqual(mandateDigest(mandate), mandateDigest({ ...mandate, units: [] }));
  assert.notEqual(mandateDigest(mandate), mandateDigest({ ...mandate, units: [{ id: 'C1-BUILD', exhibit: 'other' }] }));
});

test('carry mandate rejects missing fields, unknown versions and duplicate units', () => {
  for (const key of Object.keys(mandate)) {
    const value = { ...mandate }; delete value[/** @type {keyof typeof mandate} */ (key)];
    assert.throws(() => validateMandate(value), { name: 'CarryCheckError', code: 'mandate-malformed' }, key);
  }
  for (const value of [{ ...mandate, version: 2 }, { ...mandate, units: [...mandate.units, ...mandate.units] }, { ...mandate, extra: true }])
    assert.throws(() => validateMandate(value), { name: 'CarryCheckError', code: 'mandate-malformed' });
});

test('carry mandate absent, unreadable and malformed sources never become empty assignments', async () => {
  const t = await tmp();
  try {
    const file = path.join(t.dir, 'mandate.json');
    for (const source of [undefined, file, t.dir]) {
      const result = await readMandate(source);
      assert.deepEqual(result.issues, ['assignment-source-missing', 'role-source-missing']);
      assert.equal(result.mandate, null);
    }
    await writeFile(file, '{');
    assert.deepEqual((await readMandate(file)).issues, ['mandate-malformed', 'assignment-source-missing', 'role-source-missing']);
    await writeFile(file, JSON.stringify(mandate));
    const good = await readMandate(file);
    assert.deepEqual(good.issues, []); assert.equal(good.digest, mandateDigest(mandate));
  } finally { await t.cleanup(); }
});

test('carry evidence survives independent concurrent writers; missing and torn records refuse coverage', async () => {
  const t = await tmp();
  try {
    assert.deepEqual((await readCarryEvidence(t.dir)).issues, ['delivery-coverage-unknown']);
    const events = Array.from({ length: 201 }, (_, i) => ({ version: 1, id: `event-${i}`,
      kind: 'delivery-prepared', at: '2026-09-08T02:00:00.000Z', session: 's1', bearer: mandate.bearer,
      ref: { room: 'backroom', id: `message-${i}`, cursor: String(i) } }));
    await Promise.all(events.map(event => appendCarryEvent(t.dir, event)));
    const result = await readCarryEvidence(t.dir);
    assert.deepEqual(result.issues, []); assert.equal(result.events.length, 201);
    assert.ok(result.events.some(e => e.id === 'event-0'));
    await writeFile(path.join(t.dir, 'carry-evidence', 'torn.json'), '{');
    assert.deepEqual((await readCarryEvidence(t.dir)).issues, ['carry-evidence-corrupt:torn.json']);
  } finally { await t.cleanup(); }
});

test('carry reference identity includes the room, not merely a coincident message id', () => {
  assert.notEqual(carryRefKey({ room: 'a', id: '1', cursor: '1' }), carryRefKey({ room: 'b', id: '1', cursor: '1' }));
});

function fixture() {
  const ref = { room: 'backroom', id: 'm1', cursor: '1' };
  const event = (/** @type {string} */ id, /** @type {string} */ kind, /** @type {string[]} */ targets = []) =>
    validateCarryEvent({ version: 1, id, kind, at: mandate.issuedAt, session: 's1', bearer: mandate.bearer, ref, targets });
  const prepared = event('d1', 'delivery-prepared');
  const accepted = event('a1', 'delivery-accepted', ['d1']);
  const answer = event('reply1', 'answer', ['d1']);
  const claim = validateCarryEvent({ ...prepared, id: 'claim1', kind: 'claim', subject: 'C1-BUILD' });
  const withdrawal = event('withdraw1', 'withdrawal', ['old-claim']);
  const boundary = { version: 1, id: 'boundary1',
    session: { slug: 's1', source: 'CODEX_SESSION_ID' }, bearer: mandate.bearer,
    mandatePath: '/mandate.json', mandateDigest: mandateDigest(mandate),
    cursors: [{ key: 'backroom', cursor: '1' }], claims: [{ eventId: 'claim1', ref }],
    deliveries: [{ eventId: 'd1', ref }], retractions: [{ eventId: 'withdraw1', ref }],
    watermark: ['d1', 'a1'], gaps: [] };
  const actual = { session: { ...boundary.session }, registeredBearer: mandate.bearer,
    mandate: { mandate, digest: mandateDigest(mandate), issues: /** @type {string[]} */ ([]) },
    cursors: new Map([['backroom', '1']]), evidence: [prepared, accepted, answer, claim, withdrawal], evidenceIssues: /** @type {string[]} */ ([]),
    accounted: [{ kind: 'role', id: 'builder', exhibit: 'resume:role' }, { kind: 'unit', id: 'C1-BUILD', exhibit: 'resume:unit' },
      { kind: 'claim', id: 'claim1', exhibit: 'resume:claim' }, { kind: 'retraction', id: 'withdraw1', exhibit: 'resume:withdrawal' }] };
  return { boundary, actual, event };
}

for (const code of ['bearer-registration-missing', 'session-key-mismatch', 'session-source-mismatch',
  'cursor-missing', 'role-unaccounted', 'unit-unaccounted', 'claim-unaccounted', 'delivery-unanswered',
  'delivery-unconfirmed', 'delivery-coverage-unknown', 'retraction-unaccounted', 'mandate-digest-mismatch']) {
  test(`carry gate control: ${code}`, () => {
    const { boundary, actual } = fixture();
    assert.equal(checkCarryBoundary(boundary, actual).ok, true);
    switch (code) {
      case 'bearer-registration-missing': actual.registeredBearer = 'Other'; break;
      case 'session-key-mismatch': actual.session.slug = 'other'; break;
      case 'session-source-mismatch': actual.session.source = 'other'; break;
      case 'cursor-missing': actual.cursors.clear(); break;
      case 'role-unaccounted': actual.accounted = actual.accounted.filter(a => a.kind !== 'role'); break;
      case 'unit-unaccounted': actual.accounted = actual.accounted.filter(a => a.kind !== 'unit'); break;
      case 'claim-unaccounted': actual.accounted = actual.accounted.filter(a => a.kind !== 'claim'); break;
      case 'retraction-unaccounted': actual.accounted = actual.accounted.filter(a => a.kind !== 'retraction'); break;
      case 'delivery-unanswered': actual.evidence = actual.evidence.filter(e => e.kind !== 'answer'); break;
      case 'delivery-unconfirmed': actual.evidence = actual.evidence.filter(e => e.kind !== 'delivery-accepted'); break;
      case 'delivery-coverage-unknown': actual.evidenceIssues.push('lost span'); break;
      case 'mandate-digest-mismatch': actual.mandate.digest = 'changed'; break;
    }
    const result = checkCarryBoundary(boundary, actual);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(i => i.code === code), `missing refusal ${code}`);
    const restored = fixture();
    assert.equal(checkCarryBoundary(restored.boundary, restored.actual).ok, true);
  });
}

test('carry gate refuses every unaccounted obligation independently; restoring its evidence clears only it', () => {
  const { boundary, actual } = fixture();
  assert.equal(checkCarryBoundary(boundary, actual).ok, true);
  for (const [kind, code] of [['role', 'role-unaccounted'], ['unit', 'unit-unaccounted'], ['claim', 'claim-unaccounted'], ['retraction', 'retraction-unaccounted']]) {
    const changed = { ...actual, accounted: actual.accounted.filter(a => a.kind !== kind) };
    assert.deepEqual(checkCarryBoundary(boundary, changed).issues.map(i => i.code), [code]);
    assert.equal(checkCarryBoundary(boundary, actual).ok, true);
  }
  assert.deepEqual(checkCarryBoundary(boundary, { ...actual, registeredBearer: 'Other' }).issues.map(i => i.code),
    ['bearer-registration-missing', 'delivery-unanswered']);
  assert.deepEqual(checkCarryBoundary(boundary, { ...actual, session: { ...actual.session, slug: 'wrong' } }).issues.map(i => i.code),
    ['session-key-mismatch', 'delivery-unanswered']);
  assert.deepEqual(checkCarryBoundary(boundary, { ...actual, session: { ...actual.session, source: 'AGORA_SESSION' } }).issues.map(i => i.code), ['session-source-mismatch']);
  assert.deepEqual(checkCarryBoundary(boundary, { ...actual, cursors: new Map() }).issues.map(i => i.code), ['cursor-missing']);
  assert.deepEqual(checkCarryBoundary(boundary, { ...actual, cursors: new Map([['backroom', '99']]) }).issues.map(i => i.code), ['cursor-coverage-unknown']);
  assert.deepEqual(checkCarryBoundary(boundary, { ...actual, mandate: { ...actual.mandate, digest: 'other' } }).issues.map(i => i.code), ['mandate-digest-mismatch']);
  assert.deepEqual(checkCarryBoundary({ ...boundary, gaps: ['unread span'] }, actual).issues.map(i => i.code), ['delivery-coverage-unknown']);
});

test('carry gate distinguishes delivered then forgotten from never acknowledged, without consulting a room window', () => {
  const { boundary, actual, event } = fixture();
  const forgotten = { ...actual, evidence: actual.evidence.filter(e => e.kind !== 'answer') };
  assert.deepEqual(checkCarryBoundary(boundary, forgotten).issues.map(i => i.code), ['delivery-unanswered']);
  // Two hundred later unrelated deliveries cannot erase the saved expectation.
  forgotten.evidence.push(...Array.from({ length: 200 }, (_, i) => event(`later-${i}`, 'delivery-prepared')));
  assert.deepEqual(checkCarryBoundary(boundary, forgotten).issues.map(i => i.code), ['delivery-unanswered']);
  // An explicit answer for a DIFFERENT target, even in this room, does not discharge it.
  forgotten.evidence.push(event('unrelated-reply', 'answer', ['later-0']));
  assert.deepEqual(checkCarryBoundary(boundary, forgotten).issues.map(i => i.code), ['delivery-unanswered']);
  forgotten.evidence.push(event('named-reply', 'answer', ['d1']));
  assert.equal(checkCarryBoundary(boundary, forgotten).ok, true);
  const undelivered = { ...actual, evidence: actual.evidence.filter(e => e.kind !== 'delivery-accepted') };
  assert.deepEqual(checkCarryBoundary(boundary, undelivered).issues.map(i => i.code), ['evidence-missing', 'delivery-unconfirmed']);
  // Missing receipt store is unknown, even with an otherwise fully accounted envelope.
  assert.deepEqual(checkCarryBoundary(boundary, { ...actual, evidenceIssues: ['store absent'] }).issues.map(i => i.code), ['delivery-coverage-unknown']);
});

test('carry --check exits nonzero for a forgotten named obligation and zero only after its durable answer', async () => {
  const t = await tmp();
  try {
    const { boundary, actual, event } = fixture();
    boundary.session.source = 'AGORA_SESSION';
    boundary.mandatePath = path.join(t.dir, 'mandate.json');
    const sdir = path.join(t.dir, 'sessions', 's1');
    await writeRecord(sdir, { slug: 's1', source: 'AGORA_SESSION', explicit: true }, { bearer: mandate.bearer });
    await writeCursor(sdir, 'backroom', '1');
    await writeFile(boundary.mandatePath, JSON.stringify(mandate));
    const boundaryFile = path.join(t.dir, 'boundary.json');
    await writeFile(boundaryFile, JSON.stringify(boundary));
    const accountFile = path.join(t.dir, 'account.json');
    await writeFile(accountFile, JSON.stringify({ version: 1, boundary: boundary.id, session: 's1', items: actual.accounted }));
    const config = path.join(t.dir, 'agora.json');
    await writeFile(config, JSON.stringify({ actor: { name: 'test', kind: 'agent' },
      rooms: { backroom: { transport: 'local', path: path.join(t.dir, 'room.jsonl') } } }));
    for (const e of actual.evidence.filter(e => e.kind !== 'answer')) await appendCarryEvent(sdir, e);
    const run = promisify(execFile);
    const bin = fileURLToPath(new URL('../bin/agora.mjs', import.meta.url));
    const env = { ...process.env, AGORA_STATE: t.dir, AGORA_CONFIG: config, AGORA_SESSION: 's1', AGORA_ACTOR: mandate.bearer };
    const args = [bin, 'carry', 'backroom', '--check', '--boundary', boundaryFile, '--account', accountFile, '--json'];
    let red;
    try { await run(process.execPath, args, { env, timeout: 10000, windowsHide: true }); assert.fail('check accepted forgotten delivery'); }
    catch (error) { red = /** @type {Error & {code:number,stdout:string}} */ (error); }
    assert.equal(red.code, 1);
    assert.deepEqual(JSON.parse(red.stdout).issues, [{ code: 'delivery-unanswered', item: 'd1' }]);
    await appendCarryEvent(sdir, event('reply1', 'answer', ['d1']));
    const green = await run(process.execPath, args, { env, timeout: 10000, windowsHide: true });
    assert.equal(JSON.parse(green.stdout).ok, true);
    // The ordinary report is still allowed to report an empty room and exit zero.
    const report = await run(process.execPath, [bin, 'carry', 'backroom', '--json'], { env, timeout: 10000, windowsHide: true });
    assert.equal(JSON.parse(report.stdout).type, 'carry');
  } finally { await t.cleanup(); }
});

test('real addressed watch delivery is prepared before the callback and acknowledged before its cursor, on both batch paths', async () => {
  for (const coalesceSeconds of [0, 1]) {
    const t = await tmp();
    try {
      await writeRecord(t.dir, { slug: path.basename(t.dir), source: 'AGORA_SESSION', explicit: true }, { bearer: mandate.bearer });
      const m = { id: 'addressed-1', cursor: '1', room: 'room', ts: mandate.issuedAt,
        author: { id: 'peer', name: 'Peer', kind: /** @type {'agent'} */ ('agent') },
        text: 'Please discharge this obligation.\n\nto: Astra/uber-wizard\n\n-- Peer/reader' };
      const other = { ...m, id: 'other-1', cursor: '2', text: 'Unrelated\n\nto: Someone/else\n\n-- Peer/reader' };
      const transport = /** @type {import('../src/core.mjs').Transport} */ ({
        kind: 'local', room: 'room', threads: false,
        whoami: async () => ({ id: 'seat', name: 'Seat' }),
        read: async () => [m, other],
      });
      let callback = 0;
      await watch(transport, { stateDir: t.dir, key: 'room', mode: 'once', coalesceSeconds, seat: { id: 'seat', name: 'Seat' },
        maxBatch: coalesceSeconds ? 2 : 0, onBatch: async (msgs, batch) => {
          callback++;
          const before = await readCarryEvidence(t.dir);
          assert.deepEqual(before.events.map(e => e.kind), ['delivery-prepared']);
          assert.deepEqual(before.events[0].to, [mandate.bearer]);
          await batch.checkpoint(msgs[0]);
          const checkpointed = await readCarryEvidence(t.dir);
          assert.equal(checkpointed.events.filter(e => e.kind === 'delivery-accepted').length, 1);
          await batch.checkpoint(msgs[1]);
        } });
      assert.equal(callback, 1);
      const after = await readCarryEvidence(t.dir);
      assert.equal(after.events.length, 2, 'checkpointed item is not acknowledged a second time at whole-batch completion');
      assert.equal(after.events.filter(e => e.kind === 'delivery-prepared').length, 1, 'other-bearer message creates no obligation');
      // Simulate replacing the context: no room window or callback-local memory
      // survives. The earlier snapshot did not yet contain this in-flight message.
      const f = fixture();
      const snapshot = JSON.parse(JSON.stringify({ ...f.boundary,
        session: { slug: path.basename(t.dir), source: 'AGORA_SESSION' },
        claims: [], retractions: [], deliveries: [], watermark: [], cursors: [] }));
      const resumed = { ...f.actual, session: snapshot.session, evidence: (await readCarryEvidence(t.dir)).events };
      const prepared = after.events.find(e => e.kind === 'delivery-prepared');
      assert.ok(prepared);
      assert.deepEqual(checkCarryBoundary(snapshot, resumed).issues, [{ code: 'delivery-unanswered', item: prepared.id }]);
      resumed.evidence.push(validateCarryEvent({ ...prepared, id: 'named-answer', kind: 'answer', targets: [prepared.id] }));
      assert.equal(checkCarryBoundary(snapshot, resumed).ok, true);
    } finally { await t.cleanup(); }
  }
});

test('failed delivery callback keeps prepared evidence unconfirmed and does not advance the cursor', async () => {
  const t = await tmp();
  try {
    await writeRecord(t.dir, { slug: path.basename(t.dir), source: 'AGORA_SESSION', explicit: true }, { bearer: mandate.bearer });
    const m = { id: 'in-flight', cursor: '1', room: 'room', ts: mandate.issuedAt,
      author: { id: 'peer', name: 'Peer', kind: /** @type {'agent'} */ ('agent') },
      text: 'Required\n\nto: Astra/uber-wizard\n\n-- Peer/reader' };
    const transport = /** @type {import('../src/core.mjs').Transport} */ ({ kind: 'local', room: 'room', threads: false,
      whoami: async () => ({ id: 'seat', name: 'Seat' }), read: async () => [m] });
    await assert.rejects(() => watch(transport, { stateDir: t.dir, key: 'room', mode: 'once',
      onBatch: () => { throw new Error('delivery adapter refused'); } }), { name: 'Error', message: 'delivery adapter refused' });
    const evidence = await readCarryEvidence(t.dir);
    assert.deepEqual(evidence.events.map(e => e.kind), ['delivery-prepared']);
    const { readCursorFile } = await import('../src/core.mjs');
    assert.equal((await readCursorFile(t.dir, 'room')).exists, false);
  } finally { await t.cleanup(); }
});

test('sealed boundaries pin the assigner source, retain releases, and never infer old commitment coverage from a new ledger', async () => {
  for (const legacy of [false, true]) {
    const t = await tmp();
    try {
      const source = path.join(t.dir, 'mandate.json');
      await writeFile(source, JSON.stringify(mandate));
      if (legacy) await writeFile(path.join(t.dir, 'posted.1.jsonl'), 'old-post\n');
      const session = { slug: 's1', source: 'AGORA_SESSION' };
      await captureCarryPost(t.dir, 'room', session, mandate.bearer, 'Taking\n\nclaim: C1\n\n-- Astra/uber-wizard', { id: 'claim-post', cursor: '1' });
      const first = await sealCarryBoundary(t.dir, path.join(t.dir, 'first.json'), { session, bearer: mandate.bearer, mandatePath: source, cursors: [] });
      assert.equal(first.claims.length, 1);
      assert.deepEqual(first.gaps, legacy ? ['commitment-history-coverage-unknown'] : []);
      assert.equal(first.mandateDigest, mandateDigest(mandate));
      await assert.rejects(() => sealCarryBoundary(t.dir, path.join(t.dir, 'first.json'), { session, bearer: mandate.bearer, mandatePath: source, cursors: [] }), { code: 'EEXIST' });
      await captureCarryPost(t.dir, 'room', session, mandate.bearer, 'Done\n\nrelease: C1\n\n-- Astra/uber-wizard', { id: 'release-post', cursor: '2' });
      const second = await sealCarryBoundary(t.dir, path.join(t.dir, 'second.json'), { session, bearer: mandate.bearer, mandatePath: source, cursors: [] });
      assert.equal(second.claims.length, 0);
      assert.equal(second.retractions.length, 1);
      assert.equal(second.retractions[0].ref.id, 'release-post');
      assert.deepEqual(second.gaps, first.gaps, 'later writes do not erase the historical gap');
    } finally { await t.cleanup(); }
  }
});

test('only a successful named own post discharges a durable delivery; unrelated speech does not', async () => {
  const t = await tmp();
  try {
    const { actual, boundary } = fixture();
    for (const event of actual.evidence.filter(e => e.kind !== 'answer')) await appendCarryEvent(t.dir, event);
    const session = { slug: 's1', source: 'AGORA_SESSION' };
    await captureCarryPost(t.dir, 'backroom', session, mandate.bearer, 'Unrelated update\n\n-- Astra/uber-wizard', { id: 'other', cursor: '2' });
    actual.evidence = (await readCarryEvidence(t.dir)).events;
    assert.deepEqual(checkCarryBoundary(boundary, actual).issues.map(i => i.code), ['delivery-unanswered']);
    await captureCarryPost(t.dir, 'backroom', session, mandate.bearer, 'Answered\n\nre: m1\n\n-- Astra/uber-wizard', { id: 'answer', cursor: '3' });
    actual.evidence = (await readCarryEvidence(t.dir)).events;
    assert.equal(checkCarryBoundary(boundary, actual).ok, true);
  } finally { await t.cleanup(); }
});

test('cursor movement leaves a durable gap even if a later snapshot or account lists the new cursor', async () => {
  const t = await tmp();
  try {
    const { boundary, actual } = fixture();
    await writeCursor(t.dir, 'backroom', '1');
    await recordCarryCursorMove(t.dir, 'backroom', actual.session, mandate.bearer, '99', 'cursor-set');
    await writeCursor(t.dir, 'backroom', '99');
    actual.evidence.push(...(await readCarryEvidence(t.dir)).events);
    actual.cursors.set('backroom', '99');
    actual.accounted.push({ kind: 'cursor', id: 'backroom', exhibit: 'I saw the cursor move' });
    assert.deepEqual(checkCarryBoundary(boundary, actual).issues.map(i => i.code), ['delivery-coverage-unknown']);
    const before = actual.evidence.length;
    await recordCarryCursorMove(t.dir, 'backroom', actual.session, mandate.bearer, '99', 'cursor-set');
    assert.equal((await readCarryEvidence(t.dir)).events.length, 1, 'no gap for a byte-identical no-op');
    assert.equal(actual.evidence.length, before);
  } finally { await t.cleanup(); }
});

test('successor registration alone is not arrival; a posted arrival must name this boundary and room', async () => {
  const t = await tmp();
  try {
    const { boundary, event } = fixture();
    const dir = path.join(t.dir, 'sessions', 's2');
    await assert.rejects(() => requireCarrySuccessor(t.dir, 's2', boundary, 'backroom'), { name: 'CarryCheckError', code: 'successor-registration-missing' });
    await writeRecord(dir, { slug: 's2', source: 'AGORA_SESSION', explicit: true }, { bearer: mandate.bearer });
    await appendCarryEvent(dir, { ...event('ordinary-post', 'post'), session: 's2' });
    await assert.rejects(() => requireCarrySuccessor(t.dir, 's2', boundary, 'backroom'), { name: 'CarryCheckError', code: 'successor-arrival-missing' });
    await appendCarryEvent(dir, { ...event('other-boundary', 'arrival', ['different']), session: 's2' });
    await assert.rejects(() => requireCarrySuccessor(t.dir, 's2', boundary, 'backroom'), { name: 'CarryCheckError', code: 'successor-arrival-missing' });
    await appendCarryEvent(dir, { ...event('correct-arrival', 'arrival', [boundary.id]), session: 's2' });
    assert.equal((await requireCarrySuccessor(t.dir, 's2', boundary, 'backroom')).id, 'correct-arrival');
    await assert.rejects(() => requireCarrySuccessor(t.dir, 's2', boundary, 'another-room'), { name: 'CarryCheckError', code: 'successor-arrival-missing' });
    await assert.rejects(() => requireCarrySuccessor(t.dir, '../s2', boundary, 'backroom'), { name: 'CarryCheckError', code: 'successor-session-invalid' });
  } finally { await t.cleanup(); }
});

test('session inheritance copies durable evidence, not registration, and dry-run writes nothing', async () => {
  const t = await tmp();
  try {
    const { actual, event } = fixture();
    const src = path.join(t.dir, 'sessions', 's1'), dst = path.join(t.dir, 'sessions', 's2');
    await writeRecord(src, { ...actual.session, explicit: true }, { bearer: mandate.bearer });
    await appendCarryEvent(src, event('prepared', 'delivery-prepared'));
    const next = { slug: 's2', source: 'AGORA_SESSION', explicit: true };
    const plan = await inheritSession(t.dir, 's1', next, { dryRun: true });
    assert.equal(plan.carry.events, 1);
    assert.deepEqual((await readCarryEvidence(dst)).issues, ['delivery-coverage-unknown']);
    await inheritSession(t.dir, 's1', next);
    assert.equal(await readRecord(dst), undefined);
    assert.equal((await readCarryEvidence(dst)).events[0].id, 'prepared');
    assert.equal((await readCarryEvidence(src)).events[0].id, 'prepared');
  } finally { await t.cleanup(); }
});

test('carry CLI enforces registered successor arrival before predecessor handoff', async () => {
  const t = await tmp();
  try {
    const config = path.join(t.dir, 'agora.json'), source = path.join(t.dir, 'mandate.json'), boundaryFile = path.join(t.dir, 'boundary.json');
    await writeFile(config, JSON.stringify({ actor: { name: 'test', kind: 'agent' },
      rooms: { backroom: { transport: 'local', path: path.join(t.dir, 'room.jsonl') } } }));
    await writeFile(source, JSON.stringify(mandate));
    const exec = promisify(execFile), bin = fileURLToPath(new URL('../bin/agora.mjs', import.meta.url));
    const call = async (/** @type {string} */ session, /** @type {string[]} */ args) => {
      try {
        const r = await exec(process.execPath, [bin, ...args], { windowsHide: true, timeout: 10000,
          env: { ...process.env, AGORA_STATE: t.dir, AGORA_CONFIG: config, AGORA_SESSION: session, AGORA_ACTOR: mandate.bearer } });
        return { code: 0, ...r };
      } catch (err) { const e = /** @type {{code:number,stdout:string,stderr:string}} */ (err); return e; }
    };
    assert.equal((await call('s1', ['session', '--as', mandate.bearer])).code, 0);
    assert.equal((await call('s1', ['post', 'backroom', 'Starting', '--claim', 'C1-BUILD'])).code, 0);
    const posted = await readCarryEvidence(path.join(t.dir, 'sessions', 's1'));
    assert.equal(posted.events.filter(e => e.kind === 'gap').length, 1, 'public post uses the write-ahead capture path');
    assert.equal(posted.events.filter(e => e.kind === 'coverage').length, 1);
    const sealed = await call('s1', ['carry', 'backroom', '--seal', '--mandate', source, '--boundary', boundaryFile]);
    assert.equal(sealed.code, 0, sealed.stderr);
    assert.deepEqual(JSON.parse(sealed.stdout).gaps, []);
    assert.equal((await call('s1', ['carry', 'backroom', '--announce', '--boundary', boundaryFile])).code, 0);
    const handoff = ['carry', 'backroom', '--handoff', 's2', '--boundary', boundaryFile];
    const missing = await call('s1', handoff);
    assert.equal(missing.code, 1); assert.match(missing.stderr, /successor-registration-missing/);
    assert.equal((await call('s2', ['session', '--as', mandate.bearer])).code, 0);
    const unposted = await call('s1', handoff);
    assert.equal(unposted.code, 1); assert.match(unposted.stderr, /successor-evidence-unreadable/);
    assert.equal((await call('s2', ['carry', 'backroom', '--arrive', '--boundary', boundaryFile])).code, 0);
    const departed = await call('s1', handoff);
    assert.equal(departed.code, 0, departed.stderr);
    const predecessor = await readCarryEvidence(path.join(t.dir, 'sessions', 's1'));
    assert.equal(predecessor.events.filter(e => e.kind === 'departure').length, 1);
    const successor = await readCarryEvidence(path.join(t.dir, 'sessions', 's2'));
    assert.equal(successor.events.filter(e => e.kind === 'arrival').length, 1);
  } finally { await t.cleanup(); }
});

test('carry preflight refuses missing boundary inputs without config and admits a complete shape to config loading', async () => {
  const t = await tmp();
  try {
    const exec = promisify(execFile), bin = fileURLToPath(new URL('../bin/agora.mjs', import.meta.url));
    const env = { ...process.env, AGORA_CONFIG: path.join(t.dir, 'missing.json'), AGORA_SESSION: 'test' };
    for (const [args, message] of [
      [['--check'], 'carry --check needs --boundary <file>'],
      [['--seal', '--boundary', 'new.json'], 'carry --seal needs --mandate <file>'],
      [['--announce'], 'carry --announce needs --boundary <file>'],
      [['--arrive'], 'carry --arrive needs --boundary <file>'],
      [['--handoff', 's2'], 'carry --handoff needs --boundary <file>'],
    ]) {
      await assert.rejects(() => exec(process.execPath, [bin, 'carry', 'room', .../** @type {string[]} */ (args)], { env, windowsHide: true }),
        (/** @type {unknown} */ err) => {
          const e = /** @type {{code:number,stderr:string}} */ (err);
          assert.equal(e.code, 2); assert.equal(e.stderr, `agora: ${message}\n`); return true;
        });
    }
    await assert.rejects(() => exec(process.execPath, [bin, 'carry', 'room', '--check', '--boundary', 'file.json'], { env, windowsHide: true }),
      (/** @type {unknown} */ err) => {
        const e = /** @type {{code:number,stderr:string}} */ (err);
        assert.equal(e.code, 1); assert.match(e.stderr, /no config/); return true;
      });
  } finally { await t.cleanup(); }
});

test('a post crash between send and capture cannot erase its commitment behind a green check', async () => {
  const t = await tmp();
  try {
    const { boundary, actual } = fixture();
    const session = { slug: 's1', source: 'AGORA_SESSION' };
    boundary.claims = []; boundary.retractions = []; boundary.deliveries = []; boundary.watermark = [];
    const text = 'Body not admitted to the recovery record\n\nclaim: C1\n\n-- Astra/uber-wizard';
    const intent = await beginCarryPost(t.dir, 'backroom', session, mandate.bearer, text);
    actual.evidence = (await readCarryEvidence(t.dir)).events;
    assert.equal(JSON.stringify(actual.evidence).includes('Body not admitted'), false);
    assert.deepEqual(checkCarryBoundary(boundary, actual).issues, [{ code: 'delivery-coverage-unknown', item: intent.id }]);
    // This state is also what a successful external send followed by a crash leaves.
    await captureCarryPost(t.dir, 'backroom', session, mandate.bearer, text, { id: 'accepted-post', cursor: '10' }, intent);
    actual.evidence = (await readCarryEvidence(t.dir)).events;
    const claim = actual.evidence.find(e => e.kind === 'claim'); assert.ok(claim);
    assert.deepEqual(checkCarryBoundary(boundary, actual).issues, [{ code: 'claim-unaccounted', item: claim.id }]);
    actual.accounted.push({ kind: 'claim', id: claim.id, exhibit: 'resume-plan:C1' });
    assert.equal(checkCarryBoundary(boundary, actual).ok, true);
  } finally { await t.cleanup(); }
});

test('native claim has durable unknown outcome before the board commits, cleared only after post capture', async () => {
  const t = await tmp();
  const service = new NativeRoomService({ root: t.dir, accountId: 'seat_account_0003', seatLabel: 'test' });
  try {
    await service.start();
    const roomId = '9'.repeat(32);
    await service.createRoom({ roomId, epoch: 'a'.repeat(32) });
    const store = service.rooms.get(roomId); assert.ok(store);
    const append = store.append.bind(store);
    const dir = path.join(t.dir, 'sessions', 's1');
    /** @type {number[]} */ const pendingAtEffect = [];
    store.append = async (...args) => {
      const evidence = (await readCarryEvidence(dir)).events;
      pendingAtEffect.push(evidence.filter(e => e.kind === 'gap'
        && !evidence.some(c => c.kind === 'coverage' && c.targets.includes(e.id))).length);
      return append(...args);
    };
    const config = path.join(t.dir, 'agora.json');
    await writeFile(config, JSON.stringify({ actor: { name: 'test', kind: 'agent' }, rooms: { nat: { transport: 'native', roomId } } }));
    const bin = fileURLToPath(new URL('../bin/agora.mjs', import.meta.url));
    await promisify(execFile)(process.execPath, [bin, 'post', 'nat', 'Taking', '--claim', 'C1'], {
      timeout: 10000, windowsHide: true,
      env: { ...process.env, AGORA_STATE: t.dir, AGORA_CONFIG: config, AGORA_SESSION: 's1', AGORA_ACTOR: mandate.bearer } });
    assert.deepEqual(pendingAtEffect, [1, 2], 'board and message effects both enter inside durable unknown-outcome windows');
    const evidence = (await readCarryEvidence(dir)).events;
    assert.equal(evidence.filter(e => e.kind === 'claim').length, 1);
    assert.equal(evidence.filter(e => e.kind === 'gap').length, 2);
    for (const gap of evidence.filter(e => e.kind === 'gap'))
      assert.equal(evidence.filter(e => e.kind === 'coverage' && e.targets.includes(gap.id)).length, 1);
    let calls = 0;
    store.append = async (...args) => {
      if (++calls === 2) throw new Error('test refuses message after board commit');
      return append(...args);
    };
    await assert.rejects(() => promisify(execFile)(process.execPath, [bin, 'post', 'nat', 'Taking another', '--claim', 'C2'], {
      timeout: 10000, windowsHide: true,
      env: { ...process.env, AGORA_STATE: t.dir, AGORA_CONFIG: config, AGORA_SESSION: 's1', AGORA_ACTOR: mandate.bearer } }),
      (/** @type {any} */ err) => err.code === 1 && err.stderr.includes('test refuses message after board commit'));
    const failed = (await readCarryEvidence(dir)).events;
    assert.equal(failed.filter(e => e.kind === 'gap' && !failed.some(c => c.kind === 'coverage' && c.targets.includes(e.id))).length, 2,
      'committed board with failed message retains whole-operation and per-send uncertainty');
  } finally { await service.stop(); await t.cleanup(); }
});

test('carry delivery capture makes no identity request and retains unknown seat addressing as a gap', async () => {
  const t = await tmp();
  try {
    await writeRecord(t.dir, { slug: path.basename(t.dir), source: 'AGORA_SESSION', explicit: true }, { bearer: mandate.bearer });
    let identityCalls = 0;
    const message = { id: 'seat-addressed', cursor: '1', room: 'room', ts: mandate.issuedAt,
      author: { id: 'peer', name: 'Peer', kind: /** @type {'agent'} */ ('agent') },
      text: 'Required\n\nto: unknown-seat\n\n-- Peer/reader' };
    const transport = /** @type {import('../src/core.mjs').Transport} */ ({ kind: 'local', room: 'room', threads: false,
      whoami: async () => { identityCalls++; throw new Error('identity unavailable'); }, read: async () => [message],
      post: async () => { throw new Error('not exercised'); } });
    await watch(transport, { stateDir: t.dir, key: 'room', mode: 'once', onBatch: async () => {} });
    assert.equal(identityCalls, 0, 'capture reuses caller context, never adds a network wait');
    const evidence = (await readCarryEvidence(t.dir)).events;
    assert.deepEqual(evidence.map(e => [e.kind, e.subject]), [['gap', 'seat-address-context-unknown']]);
  } finally { await t.cleanup(); }
});

test('inheritance refuses an incompatible lineage in dry-run and before copying any evidence', async () => {
  const source = await tmp(), target = await tmp();
  try {
    await appendCarryEvent(source.dir, { version: 1, id: 'source-claim', kind: 'claim',
      at: mandate.issuedAt, session: 's1', bearer: mandate.bearer,
      ref: { room: 'backroom', id: 'claim', cursor: '1' }, subject: 'C1' });
    await writeFile(path.join(target.dir, 'carry-inherited.json'), JSON.stringify({ version: 1, from: 'unrelated', to: 's2' }));
    const before = await readCarryEvidence(target.dir);
    for (const dryRun of [true, false]) {
      await assert.rejects(() => inheritCarryEvidence(source.dir, target.dir, 's1', 's2', dryRun),
        { name: 'CarryCheckError', code: 'carry-inherit-lineage-conflict' });
      assert.deepEqual(await readCarryEvidence(target.dir), before, 'refusal did not copy source evidence');
    }
  } finally { await source.cleanup(); await target.cleanup(); }
});
