// @ts-check
// Pins for src/client.mjs: each test names the mutants of `node scripts/mutate-consumers.mjs --file
// src/client.mjs` it kills. They run against the stub service in test/client-fixtures.mjs, which can
// give the answers a real service gives only when something is wrong: a malformed result, a socket
// that dies on a read, a stale descriptor, a write buffer past its bound, a service replaced by an
// older one. No mutant is held equivalent. Two hang the tests instead of reddening them, and the
// sweep reports them as timeouts, which the per-test bound turns into a failure: subscribing with a
// cursor as if it had none (`from === undefined` flipped), and a follow whose close does not stop it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { connect } from "../src/client.mjs";
import { NATIVE_FRAME_MAX, nativeFramePayloadBytes, nativeMessageId } from "../src/native-protocol.mjs";
import { ADA, EPOCH, ROOM, checkpoint, failure, hex32, stub, stubMessage, until } from "./client-fixtures.mjs";

const OFFER = { advertised: ["threads-v1", "client-name-v1"], required: [] };
/** @param {Record<string, any>} frame @param {unknown[]} messages @param {unknown} cp @param {Record<string, unknown>} [extra] */
const readResult = (frame, messages, cp, extra = {}) => ({ type: "read-result", roomId: frame.roomId, messages, checkpoint: cp, ...extra });
/** @param {string} accountId @param {string} operationId @param {number} sequence @param {string} [epoch] */
const ack = (accountId, operationId, sequence, epoch = EPOCH) => ({ type: "append-ack", roomId: ROOM, id: nativeMessageId(ROOM, accountId, operationId), cursor: `${epoch}:${sequence}`, duplicate: false });

// kills: #dial `answered(e)` (a socket's own ENOENT read as the service's refusal)
test("a descriptor whose endpoint nobody holds is dark, never refused", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-client-stale-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "native"), { recursive: true });
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\agora-client-gone-${hex32()}` : path.join(root, "gone.sock");
  await writeFile(path.join(root, "native", "service.json"), JSON.stringify({ path: endpoint, nonce: hex32(), bootEpoch: hex32(), accountId: "stale_account_0001", seatLabel: "stale" }));
  const e = await failure(connect({ state: root }));
  assert.deepEqual([e.outcome, e.code], ["dark", "service-dark"], e.message);
});

// kills: classify `answered(e)` (a reset socket's code read as a refusal); the service-dark mapping
test("a read the socket dies under is dark, and a service that says it is dark is dark", { timeout: 30_000 }, async (t) => {
  const s = await stub(t, { offer: OFFER, answer: (f) => (f.type === "read" ? "drop" : undefined) });
  const app = await connect({ state: s.root });
  t.after(() => app.close());
  const e = await failure(app.read({ roomId: ROOM }));
  assert.deepEqual([e.outcome, e.code], ["dark", "service-dark"], e.message);

  const stopping = await stub(t, { offer: OFFER, answer: (f) => ({ type: "error", reason: "request-refused", message: "service-dark: native service is dark; start it explicitly before opening a room" }) });
  const late = await connect({ state: stopping.root });
  t.after(() => late.close());
  const read = await failure(late.read({ roomId: ROOM }));
  assert.deepEqual([read.outcome, read.code], ["dark", "service-dark"]);
  const post = await failure(late.append({ roomId: ROOM }, { text: "x", author: ADA }));
  assert.deepEqual([post.outcome, post.code], ["dark", "service-dark"]);
  assert.match(post.message, /nothing was posted and no cursor was issued/);
  const sub = await failure(late.subscribe({ roomId: ROOM }, { since: `${EPOCH}:0` }, { message: () => undefined }));
  assert.equal(sub.outcome, "dark");
});

// kills: classify `sent === false` (an append that never left read as maybe committed)
test("an append the request client could not write is dark, and the ones it wrote are unknown", { timeout: 30_000 }, async (t) => {
  const s = await stub(t, { offer: OFFER, paused: true });
  const app = await connect({ state: s.root });
  t.after(() => app.close());
  const heavy = String.fromCharCode(1).repeat(150_000); // a frame of about 900 KB, two of which fill the 2 MiB bound
  const outcomes = await Promise.allSettled([0, 1, 2].map((i) => app.append({ roomId: ROOM }, { text: `${i}${heavy}`, author: ADA })));
  const errors = outcomes.map((o) => (o.status === "rejected" ? o.reason : undefined));
  const notSent = errors.filter((e) => e?.outcome === "dark");
  assert.equal(notSent.length, 1, JSON.stringify(errors.map((e) => [e?.outcome, e?.code])));
  assert.equal(notSent[0].cause?.sent, false, "the request client said it never left");
  assert.match(notSent[0].message, /nothing was posted/);
  assert.equal(errors.filter((e) => e?.outcome === "unknown-acceptance").length, 2);
});

// kills: #live `writable` and its re-dial
test("the request connection is made once, and made again when it is gone", { timeout: 30_000 }, async (t) => {
  const s = await stub(t, { offer: OFFER, answer: (f) => (f.type === "read" ? readResult(f, [], checkpoint(0)) : undefined) });
  const app = await connect({ state: s.root });
  t.after(() => app.close());
  await app.read({ roomId: ROOM });
  await app.read({ roomId: ROOM });
  assert.equal(s.hellos, 1, "one hello for every request");
  s.drop();
  // the client learns of the drop when its socket stops being writable, which is asynchronous: a
  // read sent before that meets the dead connection, so read to a deadline rather than after a
  // fixed wait. A read on the dead connection makes no hello, so the count below still says once.
  const end = Date.now() + 10_000;
  /** @type {any} */
  let after;
  for (;;) {
    after = await app.read({ roomId: ROOM }).catch((/** @type {any} */ e) => e);
    if (Array.isArray(after?.messages) || Date.now() > end) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.deepEqual(after.messages, [], `the read after the drop: ${after?.code ?? ""}`);
  assert.equal(s.hellos, 2, "a dropped connection is dialled again, once");
});

// kills: #append rewrap `error.outcome === "dark"` (a refused re-dial reported as dark)
test("a re-dial re-checks the offer: a service replaced by one without client-name-v1 refuses the next append", { timeout: 30_000 }, async (t) => {
  const s = await stub(t, { offer: OFFER, echoName: true });
  const app = await connect({ state: s.root, clientName: "review-app" });
  t.after(() => app.close());
  await s.restart({ offer: { advertised: ["threads-v1"], required: [] } });
  const e = await failure(app.append({ roomId: ROOM }, { text: "x", author: ADA }));
  assert.deepEqual([e.outcome, e.code], ["refused", "client-name-unsupported"], e.message);
});

// kills: the read result's checkpoint, coverage and message checks
test("a read result the client cannot account for is refused, line by line", { timeout: 30_000 }, async (t) => {
  /** @type {(frame: Record<string, any>) => Record<string, any>} */
  let next = (f) => readResult(f, [], checkpoint(0));
  const s = await stub(t, { offer: OFFER, answer: (f) => (f.type === "read" ? next(f) : undefined) });
  const app = await connect({ state: s.root });
  t.after(() => app.close());
  const coverage = (/** @type {Record<string, unknown>} */ o = {}) => ({ room: { host: { scheme: "native", authority: "stub-seat", id: "stub_account_0001" }, roomId: ROOM, epoch: EPOCH }, fromExclusive: `${EPOCH}:0`, toInclusive: `${EPOCH}:4`, committedThrough: `${EPOCH}:6`, ...o });
  const other = "9".repeat(32);

  next = (f) => readResult(f, [stubMessage(1), stubMessage(2)], checkpoint(4), { coverage: coverage() });
  assert.deepEqual(await app.read({ roomId: ROOM }).then((r) => [r.messages.length, r.through, r.committedThrough]), [2, `${EPOCH}:4`, `${EPOCH}:6`]);

  const refusals = /** @type {Array<[string, (f: Record<string, any>) => Record<string, any>, { since?: string }?]>} */ ([
    ["no checkpoint", (f) => readResult(f, [], undefined)],
    ["a checkpoint of another room", (f) => readResult(f, [], checkpoint(0, { roomId: other }))],
    ["a malformed coverage block", (f) => readResult(f, [], checkpoint(4), { coverage: { room: "x" } })],
    ["coverage of another room", (f) => readResult(f, [], checkpoint(4), { coverage: coverage({ room: { host: { scheme: "native", authority: "stub-seat", id: "stub_account_0001" }, roomId: other, epoch: EPOCH } }) })],
    ["coverage of another epoch", (f) => readResult(f, [], checkpoint(4), { coverage: coverage({ room: { host: { scheme: "native", authority: "stub-seat", id: "stub_account_0001" }, roomId: ROOM, epoch: other }, fromExclusive: `${other}:0`, toInclusive: `${other}:4`, committedThrough: `${other}:6` }) })],
    ["coverage that ends elsewhere", (f) => readResult(f, [], checkpoint(4), { coverage: coverage({ toInclusive: `${EPOCH}:3` }) })],
    ["a null message", (f) => readResult(f, [null], checkpoint(4))],
    ["a message whose id is not a string", (f) => readResult(f, [stubMessage(1, { id: 7 })], checkpoint(4))],
    ["a message of another room", (f) => readResult(f, [stubMessage(1, { room: other })], checkpoint(4))],
    ["a message with no native cursor", (f) => readResult(f, [stubMessage(1, { cursor: "1" })], checkpoint(4))],
    ["a message of another epoch", (f) => readResult(f, [stubMessage(1, { cursor: `${other}:1` })], checkpoint(4))],
    ["messages out of order", (f) => readResult(f, [stubMessage(2), stubMessage(1)], checkpoint(4))],
    ["the same message twice", (f) => readResult(f, [stubMessage(1), stubMessage(1)], checkpoint(4))],
    ["a message past the position read to", (f) => readResult(f, [stubMessage(5)], checkpoint(4))],
    ["a message at the cursor read after", (f) => readResult(f, [stubMessage(2)], checkpoint(4)), { since: `${EPOCH}:2` }],
  ]);
  for (const [what, answer, options] of refusals) {
    next = answer;
    const e = await failure(app.read({ roomId: ROOM }, options ?? {}));
    assert.deepEqual([e.outcome, e.code], ["refused", "read-result-invalid"], `${what}: ${e.message}`);
  }
  next = (f) => readResult(f, [stubMessage(3)], checkpoint(4));
  assert.equal((await app.read({ roomId: ROOM }, { since: `${EPOCH}:2` })).messages.length, 1, "a message after the cursor is the read");
});

// kills: subscribe's status, checkpoint and event checks, and its position floor
test("a subscription refuses a status, a checkpoint or an event it cannot account for, and skips what it already covers", { timeout: 30_000 }, async (t) => {
  /** @type {(frame: Record<string, any>) => Record<string, any> | Array<Record<string, any>> | undefined} */
  let next = () => undefined;
  const s = await stub(t, { offer: OFFER, answer: (f) => next(f) });
  const app = await connect({ state: s.root });
  t.after(() => app.close());
  const other = "9".repeat(32);
  const result = (/** @type {unknown} */ cp) => ({ type: "subscribe-result", roomId: ROOM, messages: [], checkpoint: cp });
  const event = (/** @type {unknown} */ message) => ({ type: "event", roomId: ROOM, message });

  for (const status of [{ epoch: EPOCH, committed: -1 }, { epoch: EPOCH, committed: "3" }, { committed: 3 }]) {
    next = (f) => ({ type: "status-result", status });
    const e = await failure(app.subscribe({ roomId: ROOM }, {}, { message: () => undefined }));
    assert.deepEqual([e.outcome, e.code], ["refused", "status-invalid"], JSON.stringify(status));
  }
  for (const cp of [checkpoint(3, { roomId: other }), checkpoint(3, { epoch: other }), checkpoint(1), undefined]) {
    next = (f) => (f.type === "subscribe" ? result(cp) : undefined);
    const e = await failure(app.subscribe({ roomId: ROOM }, { since: `${EPOCH}:2` }, { message: () => undefined }));
    assert.deepEqual([e.outcome, e.code], ["refused", "subscribe-result-invalid"], JSON.stringify(cp));
  }

  // the replay may carry the cursor's own message (a host that resends it): it is covered, not delivered
  /** @type {string[]} */
  const got = [];
  next = (f) => (f.type === "subscribe" ? [event(stubMessage(2)), event(stubMessage(3)), result(checkpoint(5))] : undefined);
  const sub = await app.subscribe({ roomId: ROOM }, { since: `${EPOCH}:2` }, { message: (m) => got.push(m.cursor) });
  assert.deepEqual(got, [`${EPOCH}:3`]);
  assert.equal(sub.cursor, `${EPOCH}:5`, "the committed end the service reported is covered");
  sub.close();

  // an event from another epoch ends an established subscription as refused
  /** @type {string[]} */
  const ended = [];
  next = (f) => (f.type === "subscribe" ? [result(checkpoint(2)), event(stubMessage(3, { cursor: `${other}:3` }))] : undefined);
  await app.subscribe({ roomId: ROOM }, { since: `${EPOCH}:2` }, { message: (m) => got.push(m.cursor), refused: (e) => ended.push(e.code) });
  await until(() => ended.length === 1);
  assert.deepEqual(ended, ["event-invalid"]);
});

// kills: the receipt check, both paths
test("a receipt is checked against the operation, and against the room's epoch once the client has seen it", { timeout: 30_000 }, async (t) => {
  /** @type {(frame: Record<string, any>) => Record<string, any> | undefined} */
  let onAppend = () => undefined;
  const s = await stub(t, { offer: OFFER, answer: (f) => (f.type === "append" ? onAppend(f) : f.type === "read" ? readResult(f, [], checkpoint(0)) : undefined) });
  const app = await connect({ state: s.root });
  t.after(() => app.close());
  const other = "9".repeat(32);

  onAppend = (f) => ack(s.accountId, f.operation.operationId, 1, other);
  assert.equal((await app.append({ roomId: ROOM }, { text: "x", author: ADA })).cursor, `${other}:1`, "with no epoch seen, the id derivation is the check");
  onAppend = (f) => ack(s.accountId, hex32(), 1);
  assert.equal((await failure(app.append({ roomId: ROOM }, { text: "x", author: ADA }))).code, "receipt-mismatch");

  await app.read({ roomId: ROOM });
  onAppend = (f) => ack(s.accountId, f.operation.operationId, 1, other);
  const e = await failure(app.append({ roomId: ROOM }, { text: "x", author: ADA }));
  assert.deepEqual([e.outcome, e.code], ["refused", "receipt-mismatch"], "a receipt in another epoch than the room answered with");
  onAppend = (f) => ack(s.accountId, f.operation.operationId, 2);
  assert.equal((await app.append({ roomId: ROOM }, { text: "x", author: ADA })).cursor, `${EPOCH}:2`);
});

// kills: the frame bound's comparison and the request id it measures
test("an append whose frame is exactly one frame is sent; one byte more is refused here", { timeout: 30_000 }, async (t) => {
  const s = await stub(t, { offer: OFFER, answer: (f) => (f.type === "append" ? ack(s.accountId, f.operation.operationId, 1) : undefined) });
  const app = await connect({ state: s.root });
  t.after(() => app.close());
  const operationId = "op_exactly_one_frame";
  const shape = (/** @type {string} */ text) => ({ roomId: ROOM, operation: { operationId, authorName: ADA.name, authorKind: ADA.kind, text }, protocol: "agora-native/1", type: "append", requestId: hex32() });
  const control = String.fromCharCode(1);
  const escaped = 170_000; // six bytes each on the wire, one in the text
  const plain = NATIVE_FRAME_MAX - nativeFramePayloadBytes(shape(control.repeat(escaped)));
  const text = control.repeat(escaped) + "a".repeat(plain);
  assert.equal(nativeFramePayloadBytes(shape(text)), NATIVE_FRAME_MAX);
  assert.ok(Buffer.byteLength(text) <= 256 * 1024);
  assert.equal((await app.append({ roomId: ROOM }, { text, author: ADA, operationId })).cursor, `${EPOCH}:1`);
  const over = await failure(app.append({ roomId: ROOM }, { text: `${text}a`, author: ADA, operationId }));
  assert.equal(over.code, "text-too-long");
});

// kills: connect's config rule (a named state reads no config; no state finds it through one)
test("a named state root reads no config; without one, the config names the state root", { timeout: 30_000 }, async (t) => {
  const s = await stub(t, { offer: OFFER, answer: (f) => (f.type === "read" ? readResult(f, [], checkpoint(0)) : undefined) });
  const home = await mkdtemp(path.join(tmpdir(), "agora-client-home-"));
  const saved = Object.fromEntries(["AGORA_CONFIG", "AGORA_STATE", "HOME", "USERPROFILE"].map((k) => [k, process.env[k]]));
  t.after(async () => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    await rm(home, { recursive: true, force: true });
  });
  // the default state root and config resolve inside a temporary home, so no outcome reads a real one
  delete process.env.AGORA_STATE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;

  const broken = path.join(home, "broken.json");
  await writeFile(broken, "{ not json");
  process.env.AGORA_CONFIG = broken;
  const named = await connect({ state: s.root });
  named.close();

  const found = path.join(home, "found.json");
  await writeFile(found, JSON.stringify({ actor: { name: "x", kind: "agent" }, state: s.root, rooms: { house: { transport: "native", roomId: ROOM } } }));
  process.env.AGORA_CONFIG = found;
  const viaConfig = await connect();
  t.after(() => viaConfig.close());
  assert.deepEqual(viaConfig.rooms().map((r) => r.alias), ["house"]);
  assert.deepEqual((await viaConfig.read("house")).messages, []);

  process.env.AGORA_CONFIG = path.join(home, "absent.json");
  const none = await failure(connect());
  assert.deepEqual([none.outcome, none.code], ["dark", "service-dark"], "no config: the default state root, which holds no service");
});

// kills: subscribe's purge de-duplication (`read.sequence <= position` -> `<`, the purge branch of
// `deliver`, src/client.mjs): a replay that resends the purge at the cursor's own position has it
// covered, never handed to the purge handler, exactly as a message at the cursor is
test("a purge at the cursor's own position is covered, not delivered; the one after it is delivered once", { timeout: 30_000 }, async (t) => {
  /** @type {(frame: Record<string, any>) => Array<Record<string, any>> | undefined} */
  let next = () => undefined;
  const s = await stub(t, { offer: { advertised: ["threads-v1", "client-name-v1", "purge-v1"], required: [] }, answer: (f) => next(f) });
  const app = await connect({ state: s.root });
  t.after(() => app.close());
  const purgeAt = (/** @type {number} */ sequence) => ({ type: "event", roomId: ROOM, purge: { id: String(sequence).padStart(64, "p"), cursor: `${EPOCH}:${sequence}`,
    ts: "2026-01-01T00:00:00.000Z", purged: [stubMessage(1).id], reason: "asked", by: { name: "Ada" } } });
  next = (f) => (f.type === "subscribe" ? [purgeAt(2), purgeAt(3), { type: "subscribe-result", roomId: ROOM, messages: [], checkpoint: checkpoint(4) }] : undefined);
  /** @type {string[]} */
  const purges = [];
  const sub = await app.subscribe({ roomId: ROOM }, { since: `${EPOCH}:2` }, { message: () => undefined, purge: (p) => purges.push(p.cursor) });
  sub.close();
  assert.equal(s.frames.find((f) => f.type === "subscribe")?.purges, true, "a purge handler asks the service for purges");
  assert.deepEqual(purges, [`${EPOCH}:3`]);
  assert.equal(sub.cursor, `${EPOCH}:4`);
});
