// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PROTOCOL_LIMITS, ProtocolValidationError, assertOperationContext, formatCursor, parseCursor, readArray, readTimestamp,
  validateCursor, validateDigest, validateEpoch, validateNativeId, validateRoomId, validateSourceRef, validateText } from '../src/protocol/common.mjs';
import { assertReceiptContext, validateAppendAck, validateNativeCommitReceipt } from '../src/protocol/receipt.mjs';
import { assertMaterializationContext, validateAttachmentReference, validateLocalAttachmentState, validateWireAttachment } from '../src/protocol/attachment.mjs';
import { assertPostOutcomeContext, validateFacePublication, validateNativePostOutcome, validateQueueOutcome, validateWakeDisposition } from '../src/protocol/outcomes.mjs';
import { NativeRoomStore } from '../src/native-store.mjs';
import { encodeNativeFrame, nativeDigest } from '../src/native-protocol.mjs';

const ROOM = '1'.repeat(32), ACCOUNT = 'account_000000001', OP = 'operation_0000001';
const EPOCH = 'a'.repeat(32), DIGEST = `sha256:${'b'.repeat(64)}`, ATTACHMENT = 'attachment_000001';
const CONTEXT = { roomId: ROOM, accountId: ACCOUNT, operationId: OP };
const EXPECTED = { ...CONTEXT, epoch: EPOCH };
/** @param {Partial<typeof CONTEXT>} [context] */
function receipt(context = {}) {
  const c = { ...CONTEXT, ...context };
  return { ...c, id: createHash('sha256').update(`${c.roomId}\0${c.accountId}\0${c.operationId}`).digest('hex'), cursor: `${EPOCH}:1` };
}
function wire() { return { id: ATTACHMENT, digest: DIGEST, lifetime: 'durable', name: 'image.jpg', kind: 'image', size: 7, mimetype: 'image/jpeg', width: 1, height: 2 }; }
function local() { return { attachmentId: ATTACHMENT, state: 'materialized', path: 'C:\\local\\image.jpg', verifiedDigest: DIGEST, verifiedSize: 7, verifiedAt: '2026-09-05T06:00:00.000Z', detectedKind: 'image', detectedMimetype: 'image/jpeg' }; }
/** @param {()=>unknown} fn */
function refuses(fn) { assert.throws(fn, ProtocolValidationError); }

test('leaf IDs, digests and cursors are strict, bounded, canonical and context-free', () => {
  assert.equal(validateNativeId('a'.repeat(16)), 'a'.repeat(16));
  assert.equal(validateNativeId('z'.repeat(128)), 'z'.repeat(128));
  assert.equal(validateRoomId(ROOM), ROOM);
  refuses(() => validateRoomId('room_000000000001'));
  for (const suffix of ['\n', '\r\n']) {
    refuses(() => validateNativeId('a'.repeat(16) + suffix));
    refuses(() => parseCursor(`${EPOCH}:1${suffix}`));
    refuses(() => validateSourceRef({ transport: 'slack' + suffix, room: 'C1', id: '1' }));
    refuses(() => validateNativePostOutcome({ ...CONTEXT, status: 'refused', code: 'service-dark' + suffix }));
  }
  for (const v of [1234567890123456, null, undefined, 'a'.repeat(15), 'a'.repeat(129), ' a'.repeat(16), { toString: () => ROOM }]) refuses(() => validateNativeId(v));
  assert.equal(validateEpoch(EPOCH), EPOCH);
  refuses(() => validateEpoch(EPOCH.toUpperCase()));
  assert.equal(validateDigest(DIGEST), DIGEST);
  refuses(() => validateDigest(DIGEST.toUpperCase()));
  for (const sequence of [0, 1, Number.MAX_SAFE_INTEGER]) {
    const cursor = formatCursor(EPOCH, sequence);
    assert.equal(validateCursor(cursor), cursor);
    assert.deepEqual(parseCursor(cursor), { epoch: EPOCH, sequence });
  }
  for (const bad of [`${EPOCH}:01`, `${EPOCH}:-1`, `${EPOCH}:1.0`, `${EPOCH}:1e2`, `${EPOCH}:9007199254740992`, `${EPOCH}:1\n`, 1]) refuses(() => parseCursor(bad));
  for (const n of [-0, -1, NaN, Infinity, 1.5, '1']) refuses(() => formatCursor(EPOCH, n));
  assertOperationContext(CONTEXT, { ...CONTEXT });
  for (const key of ['roomId', 'accountId', 'operationId']) refuses(() => assertOperationContext(CONTEXT, { ...CONTEXT, [key]: 'different_0000001' }));
  refuses(() => assertOperationContext({ ...CONTEXT, epoch: EPOCH }, CONTEXT));
  refuses(() => assertOperationContext(CONTEXT, { ...CONTEXT, extra: true }));
});

test('valid body UTF-8 is preserved byte-for-byte and bounded before serialization', () => {
  const text = '\ufeffline\r\n e\u0301 é 😀 \\n ` $ " \\ \0\t  ';
  assert.deepEqual(Buffer.from(validateText(text)), Buffer.from(text));
  assert.equal(validateText(''), '');
  assert.equal(validateText('😀'.repeat(65536)).length, 131072);
  refuses(() => validateText('😀'.repeat(65536) + 'a'));
  assert.equal(validateText('a'.repeat(PROTOCOL_LIMITS.textBytes)).length, PROTOCOL_LIMITS.textBytes);
  for (const text of ['\ud800', '\udc00', '\ud800x', '\ud800\ud800', 'a'.repeat(PROTOCOL_LIMITS.textBytes + 1)]) refuses(() => validateText(text));
  // Text byte allowance is not encoded JSON-frame allowance: caller must retain the outer cap.
  const controls = validateText('\0'.repeat(PROTOCOL_LIMITS.textBytes));
  assert.throws(() => encodeNativeFrame({ text: controls }));
});

test('source IDs preserve non-native names while rejecting controls and hostile object shapes', () => {
  const source = { transport: 'slack', room: 'C123', id: '1788580000.123456' };
  const result = validateSourceRef(source);
  assert.deepEqual(result, source); assert.notEqual(result, source);
  assert.equal(validateSourceRef({ transport: 'tailcat', room: 'offer', id: '0' }).id, '0');
  for (const s of ['', 'a'.repeat(513), 'line\n', 'nul\0', '\u0085', '\ud800']) refuses(() => validateSourceRef({ ...source, room: s }));
  const plain = Object.assign(Object.create(null), source);
  assert.deepEqual(validateSourceRef(plain), source);
  const hostile = Object.defineProperty({ ...source }, 'private-secret-123', { value: 'secret-value', enumerable: true });
  assert.throws(() => validateSourceRef(hostile), (e) => {
    assert.ok(e instanceof ProtocolValidationError);
    assert.ok(!e.message.includes('private-secret-123')); assert.ok(!e.message.includes('secret-value')); assert.ok(e.field.length <= 160);
    return true;
  });
  let accessed = false;
  const getter = Object.defineProperty({ ...source }, 'room', { enumerable: true, get() { accessed = true; throw new Error('secret'); } });
  refuses(() => validateSourceRef(getter)); assert.equal(accessed, false);
  for (const value of [[], new Date(), Object.create(source), { ...source, id: undefined }, { ...source, [Symbol('secret')]: 1 },
    JSON.parse('{"transport":"slack","room":"r","id":"i","__proto__":{}}'), { ...source, constructor: 'x' }, { ...source, prototype: 'x' },
    Object.defineProperty({ ...source }, 'room', { value: 'r', enumerable: false })]) refuses(() => validateSourceRef(value));
  const cycle = { ...source, id: /** @type {unknown} */ ('i') }; cycle.id = cycle;
  refuses(() => validateSourceRef(cycle));
});

test('internal bounded array seam rejects sparse, accessor, symbol and oversized arrays', () => {
  assert.deepEqual(readArray([ROOM, ACCOUNT], 'items', 2, validateNativeId), [ROOM, ACCOUNT]);
  for (const value of [new Array(1), [undefined], [ROOM, ACCOUNT, OP], Object.assign([ROOM], { extra: 1 }), Object.assign([ROOM], { [Symbol('x')]: 1 })]) refuses(() => readArray(value, 'items', 2, validateNativeId));
  let calls = 0;
  const a = Object.defineProperty([ROOM], '0', { enumerable: true, get() { calls++; return ROOM; } });
  refuses(() => readArray(a, 'items', 2, validateNativeId)); assert.equal(calls, 0);
});

test('receipt ID matches existing v1 derivation and context validates all four dimensions', () => {
  const r = receipt();
  assert.deepEqual(validateNativeCommitReceipt(r), r);
  assert.notEqual(validateNativeCommitReceipt(r), r);
  assert.deepEqual(assertReceiptContext(r, EXPECTED), r);
  for (const c of [{ roomId: '2'.repeat(32) }, { accountId: 'account_000000002' }, { operationId: 'operation_0000002' }]) {
    const foreign = receipt(c); assert.notEqual(foreign.id, r.id);
    assert.deepEqual(validateNativeCommitReceipt(foreign), foreign);
    refuses(() => assertReceiptContext(foreign, EXPECTED));
  }
  for (const bad of [{ ...r, id: '0'.repeat(64) }, { ...r, cursor: `${EPOCH}:0` }, { ...r, duplicate: true }, { ...r, id: undefined }]) refuses(() => validateNativeCommitReceipt(bad));
  refuses(() => assertReceiptContext(r, { ...EXPECTED, epoch: 'c'.repeat(32) }));
  refuses(() => validateNativeCommitReceipt(receipt({ roomId: 'room_000000000001' })));
  refuses(() => assertReceiptContext(r, { ...EXPECTED, extra: true }));
  const original = { receipt: r, duplicate: false }, copied = validateAppendAck(original);
  original.receipt.cursor = `${EPOCH}:2`;
  assert.equal(copied.receipt.cursor, `${EPOCH}:1`);
  assert.deepEqual(validateAppendAck({ receipt: receipt(), duplicate: true }).receipt, copied.receipt);
  for (const duplicate of ['true', 1, null, undefined]) refuses(() => validateAppendAck({ receipt: receipt(), duplicate }));
  refuses(() => validateAppendAck({ receipt: receipt(), duplicate: false, status: 'sent' }));
});

test('attachment reference and wire shapes never expose foreign materializations', () => {
  const a = wire(), parsed = validateWireAttachment(a);
  assert.deepEqual(parsed, a); assert.notEqual(parsed, a);
  assert.deepEqual(validateAttachmentReference({ id: a.id, digest: a.digest, lifetime: 'offer' }), { id: a.id, digest: a.digest, lifetime: 'offer' });
  for (const lifetime of ['ephemeral', '', undefined]) refuses(() => validateWireAttachment({ ...a, lifetime }));
  for (const key of ['path', 'url', 'error', 'verifiedDigest', 'private']) refuses(() => validateWireAttachment({ ...a, [key]: 'foreign-secret' }));
  for (const size of [-1, -0, 1.2, Number.MAX_SAFE_INTEGER + 1, Infinity, '7']) refuses(() => validateWireAttachment({ ...a, size }));
  assert.equal(validateWireAttachment({ ...a, size: Number.MAX_SAFE_INTEGER }).size, Number.MAX_SAFE_INTEGER);
  for (const dimension of [0, -1, 2147483648, 1.2, undefined]) refuses(() => validateWireAttachment({ ...a, width: dimension }));
  assert.equal(validateWireAttachment({ ...a, width: 2147483647 }).width, 2147483647);
  assert.equal(validateWireAttachment({ ...a, name: 'é'.repeat(127) + 'a' }).name.length, 128);
  refuses(() => validateWireAttachment({ ...a, name: 'é'.repeat(128) }));
  for (const name of ['', '\ud800']) refuses(() => validateWireAttachment({ ...a, name }));
  for (const mimetype of ['', 'a'.repeat(201), 'image/jpeg\r\n', '\u0085', undefined]) refuses(() => validateWireAttachment({ ...a, mimetype }));
  const { mimetype, width, height, ...minimal } = a;
  assert.deepEqual(validateWireAttachment(minimal), minimal);
  refuses(() => validateAttachmentReference({ id: '0', digest: DIGEST, lifetime: 'offer' }));
});

test('local materialization shape and reference equality never read or certify a file', () => {
  const a = wire(), state = local();
  assert.deepEqual(assertMaterializationContext(state, a), state);
  const correctedType = { ...state, detectedKind: 'file', detectedMimetype: 'application/pdf' };
  assert.deepEqual(assertMaterializationContext(correctedType, a), correctedType, 'local detection survives a conflicting advertised image type');
  const { detectedKind, detectedMimetype, ...withoutDetection } = state;
  refuses(() => validateLocalAttachmentState(withoutDetection));
  for (const detectedMimetype of ['', undefined, 'a'.repeat(201), 'application/pdf\n']) refuses(() => validateLocalAttachmentState({ ...state, detectedMimetype }));
  refuses(() => validateLocalAttachmentState({ ...state, detectedKind: 'video' }));
  assert.deepEqual(validateLocalAttachmentState({ attachmentId: ATTACHMENT, state: 'pending' }), { attachmentId: ATTACHMENT, state: 'pending' });
  assert.equal(validateLocalAttachmentState({ attachmentId: ATTACHMENT, state: 'unavailable', code: 'digest-mismatch', retryable: true }).state, 'unavailable');
  assert.equal(validateLocalAttachmentState({ ...state, path: '/not-an-existing-file' }).state, 'materialized');
  for (const bad of [{ ...state, verifiedDigest: `sha256:${'c'.repeat(64)}` }, { ...state, verifiedSize: 8 }, { ...state, attachmentId: 'attachment_000002' }]) refuses(() => assertMaterializationContext(bad, a));
  for (const bad of [{ attachmentId: ATTACHMENT, state: 'pending', path: 'foreign' }, { ...state, retryable: true },
    { attachmentId: ATTACHMENT, state: 'unavailable', code: 'bad prose', retryable: true },
    { attachmentId: ATTACHMENT, state: 'unavailable', code: 'failed', retryable: 'true' }]) refuses(() => validateLocalAttachmentState(bad));
  for (const p of ['', 'nul\0path', 'a'.repeat(PROTOCOL_LIMITS.pathBytes + 1)]) refuses(() => validateLocalAttachmentState({ ...state, path: p }));
  for (const ts of ['2026-09-05', '2026-09-05T06:00:00Z', '2026-02-30T00:00:00.000Z', 'invalid']) refuses(() => readTimestamp(ts));
  assert.equal(readTimestamp(state.verifiedAt), state.verifiedAt);
});

test('native sent, refused, unknown and queued are exact distinct effect branches', () => {
  const sent = { status: 'sent', ack: { receipt: receipt(), duplicate: false } };
  assert.deepEqual(assertPostOutcomeContext(sent, EXPECTED), sent);
  for (const status of ['refused', 'unknown-acceptance']) {
    const outcome = { ...CONTEXT, status, code: 'service-dark' };
    assert.deepEqual(validateNativePostOutcome(outcome), outcome);
    assert.deepEqual(assertPostOutcomeContext(outcome, EXPECTED), outcome);
    for (const key of ['cursor', 'receipt', 'ack', 'queueId']) refuses(() => validateNativePostOutcome({ ...outcome, [key]: 'x' }));
    refuses(() => assertPostOutcomeContext(outcome, { ...EXPECTED, accountId: 'account_000000002' }));
  }
  const queued = { ...CONTEXT, status: 'queued', queueId: 'queue_000000000001' };
  assert.deepEqual(validateQueueOutcome(queued), queued);
  refuses(() => validateNativePostOutcome(queued)); refuses(() => validateQueueOutcome(sent));
  refuses(() => validateQueueOutcome({ ...queued, cursor: receipt().cursor }));
  refuses(() => validateNativePostOutcome({ ...sent, ...CONTEXT }));
  refuses(() => validateNativePostOutcome({ ...CONTEXT, status: 'unknown-acceptance', code: 'secret value' }));
  refuses(() => assertPostOutcomeContext(sent, { ...EXPECTED, epoch: 'c'.repeat(32) }));
  for (const d of ['woken', 'enqueued', 'inbox', 'deferred']) assert.equal(validateWakeDisposition(d), d);
  for (const d of ['sent', 'read', 'completed', 42]) refuses(() => validateWakeDisposition(d));
});

test('face publication identity, known source and pending/unknown distinctions survive copying', () => {
  const c = { roomId: ROOM, messageId: receipt().id, faceId: 'slack-face', sourceRoom: 'C123', publicationOperationId: OP };
  const source = { transport: 'slack', room: c.sourceRoom, id: '1788580000.123456' };
  for (const outcome of [{ ...c, status: 'pending' }, { ...c, status: 'published', source }, { ...c, status: 'refused', code: 'no-scope' },
    { ...c, status: 'unknown', code: 'timeout' }, { ...c, status: 'unknown', code: 'timeout', source }]) assert.deepEqual(validateFacePublication(outcome), outcome);
  const published = { ...c, status: 'published', source }, copy = validateFacePublication(published);
  source.id = 'changed';
  assert.equal(copy.status, 'published'); if (copy.status === 'published') assert.equal(copy.source.id, '1788580000.123456');
  for (const bad of [{ ...c, status: 'published' }, { ...c, status: 'pending', source }, { ...c, status: 'refused', code: 'failed', source },
    { ...c, status: 'published', source: { ...source, room: 'foreign' } }, { ...c, status: 'unknown', code: 'timeout', source: { ...source, room: 'foreign' } },
    { ...c, status: 'sent', source }, { ...c, status: 'unknown', code: undefined }]) refuses(() => validateFacePublication(bad));
});

test('v1 store bytes, payload digest and retry receipt survive pure contract wrapping and reopen', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'agora-leaf-compat-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await NativeRoomStore.create({ root, roomId: ROOM, epoch: EPOCH, hostAccountId: ACCOUNT, now: () => new Date('2026-09-05T06:00:00.000Z') });
  t.after(() => store.close());
  const input = { operationId: OP, authorName: 'Peer/agent', text: '\ufeffsame\r\n e\u0301 \\n  ', attachments: [{ id: ATTACHMENT, name: 'old.bin', kind: 'file', size: 7, digest: DIGEST }] };
  const original = await store.append(input, { accountId: ACCOUNT });
  const bytes = await readFile(store.logPath);
  assert.deepEqual(validateAppendAck({ receipt: { ...CONTEXT, id: original.id, cursor: original.cursor }, duplicate: original.duplicate }), { receipt: receipt(), duplicate: false });
  const frameLength = bytes.readUInt32BE(0);
  const record = JSON.parse(bytes.subarray(4, 4 + frameLength).toString('utf8'));
  assert.equal(record.version, 1);
  const payload = { accountId: ACCOUNT, authorName: input.authorName, authorKind: 'agent', text: input.text, attachments: input.attachments };
  assert.equal(nativeDigest(payload), record.payloadDigest);
  assert.notEqual(nativeDigest({ ...payload, attachments: payload.attachments.map(a => ({ ...a, lifetime: 'durable' })) }), record.payloadDigest);
  // Old attachment bytes omit lifetime; new validation must not silently upgrade/rewrite them.
  refuses(() => validateWireAttachment(record.message.attachments[0]));
  await store.close();
  const reopened = await NativeRoomStore.open({ root, roomId: ROOM });
  t.after(() => reopened.close());
  assert.equal(reopened.read({ since: `${EPOCH}:0` })[0].text, input.text);
  assert.deepEqual(await reopened.append(input, { accountId: ACCOUNT }), { ...original, duplicate: true });
  assert.deepEqual(await readFile(reopened.logPath), bytes);
});
