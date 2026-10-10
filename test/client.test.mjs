// @ts-check
// agora/client against a real seat service in a temporary state root, and against a stub service
// for the two answers the real one cannot be made to give on command: a welcome that offers
// nothing, and a socket that dies with an append on the wire. The seams the mutation sweep found
// are pinned in test/client-seams.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ClientError, FOLLOW_BACKOFF_MS, connect } from "../src/client.mjs";
import { ACCOUNT, ADA, EPOCH, ROOM, failure, seat, stub, thrown, until } from "./client-fixtures.mjs";

const run = promisify(execFile);
const BIN = new URL("../bin/agora.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

test("read, append and subscribe; a message has the shape read --json prints; an identical resend is the original receipt", { timeout: 30_000 }, async (t) => {
  const s = await seat(t);
  const app = await s.open();
  assert.deepEqual(app.rooms(), [{ alias: "house", roomId: ROOM, transport: "native" }], "a native row with a malformed id and another transport's row are not served");
  assert.deepEqual([...app.capabilities].sort(), ["annotations-v1", "attachments-v1", "client-name-v1", "threads-v1"]);
  assert.deepEqual(app.seat, { accountId: ACCOUNT, label: "seat-a" });

  const empty = await app.read("house");
  assert.deepEqual(empty, { messages: [], annotations: [], through: `${EPOCH}:0` });

  const first = await app.append("house", { text: "hello from the app", author: ADA, trailers: [["to", "Grace/watch"], ["note", " one line "]] });
  assert.match(first.id, /^[a-f0-9]{64}$/);
  assert.equal(first.cursor, `${EPOCH}:1`);
  assert.equal(first.duplicate, false);
  assert.match(first.operationId, /^[a-f0-9]{32}$/);

  const again = await app.append({ roomId: ROOM }, { text: "hello from the app", author: ADA, trailers: [["to", "Grace/watch"], ["note", "one line"]], operationId: first.operationId });
  assert.deepEqual(again, { ...first, duplicate: true }, "the same operation id and bytes return the original receipt");
  const conflict = await failure(app.append("house", { text: "other words", author: ADA, operationId: first.operationId }));
  assert.deepEqual([conflict.outcome, conflict.code, conflict.operationId], ["refused", "request-refused", first.operationId]);
  assert.match(conflict.message, /already committed with different bytes/);
  assert.ok(conflict.cause instanceof Error, "a refusal the service gave carries the service's error");

  const { messages, through } = await app.read("house");
  assert.equal(through, `${EPOCH}:1`);
  const [m] = messages;
  assert.equal(m.text, "hello from the app\n\nto: Grace/watch\nnote: one line", "the block the CLI writes, and no signature line");
  assert.deepEqual(m.author, { id: ACCOUNT, name: "Ada", kind: "human" });
  assert.deepEqual(m.to, ["Grace/watch"]);
  assert.deepEqual(m.trailers, [{ key: "to", value: "Grace/watch" }, { key: "note", value: "one line" }]);
  assert.equal(m.signedAs, undefined);

  // the client wrote no session file and never touched the config
  assert.equal(existsSync(path.join(s.root, "sessions")), false);
  assert.equal(await readFile(s.config, "utf8"), s.configBody);

  // the CLI's own line for the same message, less the line's type and alias
  /** @type {Record<string, string | undefined>} */
  const env = { ...process.env, AGORA_CONFIG: s.config, AGORA_STATE: s.root, AGORA_SESSION: "probe" };
  for (const name of ["CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_PID", "GROK_SESSION_ID", "GROK_PID", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "HERMES_SESSION_ID", "AGORA_SESSION_PID", "AGORA_ACTOR"]) delete env[name];
  const cli = await run(process.execPath, [BIN, "read", "house", "--json"], { env, windowsHide: true });
  const { type, alias, ...line } = JSON.parse(cli.stdout.trim());
  assert.deepEqual([type, alias], ["message", "house"]);
  assert.deepEqual(JSON.parse(JSON.stringify(m)), line, "exactly the read --json shape");

  /** @type {import('../src/client.mjs').ClientMessage[]} */
  const got = [];
  const sub = await app.subscribe("house", { since: through }, { message: (x) => got.push(x) });
  assert.equal(sub.cursor, through);
  const second = await app.append("house", { text: "a second", author: { kind: "agent", name: "Grace/watch" } });
  await until(() => got.length === 1);
  assert.deepEqual(got.map((x) => [x.text, x.cursor, x.author.kind]), [["a second", second.cursor, "agent"]]);
  assert.equal(sub.cursor, second.cursor);
  sub.close();

  // a subscription from nowhere starts at the committed end and replays nothing
  /** @type {string[]} */
  const fresh = [];
  const now = await app.subscribe("house", {}, { message: (x) => fresh.push(x.text) });
  assert.equal(now.cursor, second.cursor);
  assert.deepEqual(fresh, []);
  now.close();

  // `limit` takes the oldest after a cursor and the newest without one
  assert.deepEqual((await app.read("house", { since: `${EPOCH}:0`, limit: 1 })).messages.map((x) => x.cursor), [`${EPOCH}:1`]);
  assert.deepEqual((await app.read("house", { limit: 1 })).messages.map((x) => x.cursor), [`${EPOCH}:2`]);
  assert.equal((await app.read("house", { limit: 10_000 })).messages.length, 2, "the largest limit is a limit");
});

test("via and author.ref round-trip under a client name; a ref without one, and malformed input, are refused before anything is sent", { timeout: 30_000 }, async (t) => {
  const s = await seat(t);
  const app = await s.open({ clientName: "review-app" });
  assert.equal(app.clientName, "review-app");
  await app.append("house", { text: "from the web", author: { kind: "human", name: "Ada", ref: "u-42@example" } });
  const plain = await s.open();
  await plain.append("house", { text: "from the CLI side", author: { kind: "agent", name: "Grace/watch" } });
  const { messages } = await plain.read("house");
  assert.deepEqual(messages.map((m) => [m.via, m.author.ref, m.author.name]), [["review-app", "u-42@example", "Ada"], [undefined, undefined, "Grace/watch"]]);

  const cases = /** @type {Array<[string, () => Promise<unknown>]>} */ ([
    ["author-ref-without-client", () => plain.append("house", { text: "x", author: { kind: "human", name: "Ada", ref: "u-1" } })],
    ["author-ref-invalid", () => app.append("house", { text: "x", author: { kind: "human", name: "Ada", ref: "has space" } })],
    ["author-ref-invalid", () => app.append("house", { text: "x", author: /** @type {any} */ ({ kind: "human", name: "Ada", ref: 42 }) })],
    ["author-invalid", () => app.append("house", { text: "x", author: /** @type {any} */ ({ kind: "robot", name: "Ada" }) })],
    ["author-invalid", () => app.append("house", { text: "x", author: { kind: "human", name: "  " } })],
    ["author-invalid", () => app.append("house", { text: "x", author: { kind: "human", name: "a".repeat(121) } })],
    ["author-invalid", () => app.append("house", /** @type {any} */ ({ text: "x", author: null }))],
    ["author-invalid", () => app.append("house", /** @type {any} */ ({ text: "x", author: "Ada" }))],
    ["text-invalid", () => app.append("house", /** @type {any} */ ({ text: 7, author: ADA }))],
    ["trailer-invalid", () => app.append("house", { text: "x", author: ADA, trailers: [["To", "Grace"]] })],
    ["trailer-invalid", () => app.append("house", { text: "x", author: ADA, trailers: [["to", "two\nlines"]] })],
    ["trailer-invalid", () => app.append("house", /** @type {any} */ ({ text: "x", author: ADA, trailers: [[7, "Grace"]] }))],
    ["trailer-invalid", () => app.append("house", /** @type {any} */ ({ text: "x", author: ADA, trailers: { to: "Grace" } }))],
    ["operation-id-invalid", () => app.append("house", { text: "x", author: ADA, operationId: "a".repeat(15) })],
    ["operation-id-invalid", () => app.append("house", { text: "x", author: ADA, operationId: "a".repeat(129) })],
    ["thread-invalid", () => app.append("house", { text: "x", author: ADA, thread: "abc" })],
    ["text-too-long", () => app.append("house", { text: "x".repeat(256 * 1024 + 1), author: ADA })],
    ["text-too-long", () => app.append("house", { text: "\u0001".repeat(200 * 1024), author: ADA })],
    ["append-invalid", () => app.append("house", /** @type {any} */ (null))],
    ["append-invalid", () => app.append("house", /** @type {any} */ ("hello"))],
    ["room-unknown", () => app.append("nowhere", { text: "x", author: ADA })],
    ["room-transport-unsupported", () => app.append("scratch", { text: "x", author: ADA })],
    ["room-transport-unsupported", () => app.append("far", { text: "x", author: ADA })],
    ["room-id-invalid", () => app.append("broken", { text: "x", author: ADA })],
    ["room-id-invalid", () => app.append({ roomId: "ROOM" }, { text: "x", author: ADA })],
    ["room-id-invalid", () => app.append(/** @type {any} */ ({ roomId: 6 }), { text: "x", author: ADA })],
    ["cursor-invalid", () => app.read("house", { since: "12" })],
    ["limit-invalid", () => app.read("house", { limit: 0 })],
    ["limit-invalid", () => app.read("house", { limit: 10_001 })],
    ["limit-invalid", () => app.read("house", { limit: 1.5 })],
  ]);
  for (const [code, attempt] of cases) {
    const e = await failure(attempt());
    assert.deepEqual([e.code, e.outcome], [code, "refused"], e.message);
    assert.equal("cause" in e, false, `${code}: a refusal this client makes by itself has no cause (it never reached the service)`);
  }
  assert.equal((await plain.read("house")).messages.length, 2, "nothing was appended");

  // an append refused here still names the operation it would have been: the caller's, or one minted
  assert.equal((await failure(app.append("house", /** @type {any} */ ({ text: 7, author: ADA, operationId: "op_named_by_caller" })))).operationId, "op_named_by_caller");
  assert.match(/** @type {string} */ ((await failure(app.append("house", /** @type {any} */ ({ text: 7, author: ADA })))).operationId), /^[a-f0-9]{32}$/);

  // the bounds are inclusive
  for (const operationId of ["a".repeat(16), "b".repeat(128)]) assert.equal((await app.append("house", { text: "bound", author: ADA, operationId })).duplicate, false);
  assert.equal((await app.append("house", { text: "x", author: { kind: "human", name: "a".repeat(120) } })).duplicate, false);
  assert.equal((await app.append("house", { text: "x".repeat(256 * 1024), author: ADA })).duplicate, false);

  assert.equal((await failure(connect({ state: s.root, config: s.config, clientName: "Review App" }))).code, "client-name-invalid");
  const nowhere = await mkdtemp(path.join(tmpdir(), "agora-client-nowhere-"));
  t.after(() => rm(nowhere, { recursive: true, force: true }));
  const early = await failure(connect({ state: nowhere, clientName: "Review App" }));
  assert.deepEqual([early.outcome, early.code], ["refused", "client-name-invalid"], "a malformed name is refused before any service is looked for");
  assert.equal((await failure(connect({ state: s.root, config: path.join(s.root, "absent.json") }))).code, "config-invalid");

  // the seat-private secret never enters a room, whoever typed it
  const nonce = JSON.parse(await readFile(path.join(s.root, "native", "service.json"), "utf8")).nonce;
  const leak = await failure(app.append("house", { text: `pasted ${nonce} by mistake`, author: ADA }));
  assert.equal(leak.code, "service-secret-in-text");
  assert.doesNotMatch(leak.message, new RegExp(nonce));
});

test("a thread read and a thread subscription; a root the room does not hold is refused by the service", { timeout: 30_000 }, async (t) => {
  const s = await seat(t);
  const app = await s.open({ clientName: "review-app" });
  const root = await app.append("house", { text: "the question", author: { kind: "system", name: "review-app" } });
  await app.append("house", { text: "unrelated", author: ADA });
  const reply = await app.append("house", { text: "the answer", author: ADA, thread: root.id });
  const thread = await app.read("house", { thread: root.id });
  assert.deepEqual(thread.messages.map((m) => [m.text, m.thread]), [["the question", undefined], ["the answer", root.id]]);
  assert.equal(thread.through, reply.cursor);

  /** @type {string[]} */
  const got = [];
  const sub = await app.subscribe("house", { since: reply.cursor, thread: root.id }, { message: (m) => got.push(m.text) });
  await app.append("house", { text: "elsewhere", author: ADA });
  const later = await app.append("house", { text: "a later answer", author: ADA, thread: root.id });
  await until(() => got.length === 1);
  assert.deepEqual(got, ["a later answer"], "the record outside the thread is passed over, not delivered");
  assert.equal(sub.cursor, later.cursor);
  sub.close();

  // a thread subscription made while the room's last record is outside the thread covers it
  const covered = await app.subscribe("house", { since: reply.cursor, thread: root.id }, { message: (m) => got.push(m.text) });
  assert.deepEqual(got, ["a later answer", "a later answer"]);
  const more = await app.append("house", { text: "more elsewhere", author: ADA });
  covered.close();
  const after = await app.subscribe("house", { since: later.cursor, thread: root.id }, { message: (m) => got.push(m.text) });
  assert.equal(after.cursor, more.cursor, "the cursor is the room's committed end, past the last reply");
  after.close();

  // after the cursor, a thread read accounts for the scan's end, past its last reply
  const scanned = await app.read("house", { thread: root.id, since: later.cursor });
  assert.deepEqual(scanned.messages, []);
  assert.equal(scanned.through, more.cursor);

  const unknown = "f".repeat(64);
  for (const attempt of [
    () => app.append("house", { text: "x", author: ADA, thread: unknown }),
    () => app.read("house", { thread: unknown }),
    () => app.subscribe("house", { thread: unknown }, { message: () => undefined }),
  ]) {
    const e = await failure(attempt());
    assert.deepEqual([e.outcome, e.code], ["refused", "thread-root-unknown"], e.message);
  }
  const nested = await failure(app.append("house", { text: "x", author: ADA, thread: reply.id }));
  assert.equal(nested.code, "thread-root-not-top-level");
});

test("a page too large for one frame is read again at the host's fitting limit, and a short newest window says so", { timeout: 30_000 }, async (t) => {
  const s = await seat(t);
  const app = await s.open();
  const big = "y".repeat(200 * 1024);
  for (let i = 0; i < 6; i++) await app.append("house", { text: `${i} ${big}`, author: ADA });
  const newest = await app.read("house", { limit: 6 });
  assert.ok(newest.gap, "the window came back short");
  assert.equal(newest.gap.reason, "frame-limit");
  assert.equal(newest.gap.requested, 6);
  assert.equal(newest.gap.returned, newest.messages.length);
  assert.ok(newest.messages.length >= 1 && newest.messages.length < 6);
  assert.equal(newest.messages.at(-1)?.cursor, `${EPOCH}:6`, "the newest end is kept");
  const window = await app.read("house");
  assert.equal(window.gap?.requested, 6, "with no limit, what the host selected is what was asked for");
  const paged = await app.read("house", { since: `${EPOCH}:0`, limit: 6 });
  assert.equal(paged.gap, undefined, "after a cursor nothing is skipped; the page ends where it ends");
  assert.equal(paged.through, paged.messages.at(-1)?.cursor);
  assert.equal(paged.messages[0].cursor, `${EPOCH}:1`);
});

test("dark: no service, a service that stopped, and a closed client", { timeout: 30_000 }, async (t) => {
  const empty = await mkdtemp(path.join(tmpdir(), "agora-client-dark-"));
  t.after(() => rm(empty, { recursive: true, force: true }));
  const config = path.join(empty, "agora.json");
  await writeFile(config, JSON.stringify({ actor: { name: "x", kind: "agent" }, rooms: { house: { transport: "native", roomId: ROOM } } }));
  const none = await failure(connect({ state: empty, config }));
  assert.deepEqual([none.outcome, none.code], ["dark", "service-dark"]);
  assert.match(none.message, /no seat service descriptor/);

  const s = await seat(t);
  const app = await s.open();
  /** @type {ClientError[]} */
  const ended = [];
  /** @type {ClientError[]} */
  const wrong = [];
  await app.subscribe("house", {}, { message: () => undefined, dark: (e) => ended.push(e), refused: (e) => wrong.push(e) });
  await s.stop();
  await until(() => ended.length === 1);
  assert.match(ended[0].message, /closed the connection/);
  assert.deepEqual(wrong, []);
  const post = await failure(app.append("house", { text: "late", author: ADA, operationId: "op_after_the_stop_1" }));
  assert.deepEqual([post.outcome, post.operationId], ["dark", "op_after_the_stop_1"]);
  assert.match(post.message, /nothing was posted and no cursor was issued/);
  assert.equal((await failure(app.read("house"))).outcome, "dark");
  assert.equal((await failure(app.subscribe("house", {}, { message: () => undefined }))).outcome, "dark");

  await s.start();
  const back = await app.append("house", { text: "after the restart", author: ADA });
  assert.equal(back.cursor, `${EPOCH}:1`, "the request connection is dialled again once the service answers");
  app.close();
  const closed = await failure(app.read("house"));
  assert.deepEqual([closed.outcome, closed.code], ["dark", "client-closed"]);
});

test("follow across service stops and starts: every message once, in order, none lost; the ladder steps and starts over; a refusal stops it", { timeout: 30_000 }, async (t) => {
  const s = await seat(t);
  const poster = await s.open();
  const app = await s.open();
  /** @type {string[]} */
  const texts = [];
  /** @type {string[]} */
  const states = [];
  const darks = () => states.filter((x) => x.startsWith("dark")).length;
  const follow = app.follow("house", {}, {
    message: (m) => texts.push(m.text),
    state: (state, error) => states.push(error ? `${state}:${error.code}` : state),
  }, { backoffMs: [0, 1500, 60_000] });
  t.after(() => follow.close());
  await until(() => states.includes("live"));
  await poster.append("house", { text: "one", author: ADA });
  await poster.append("house", { text: "two", author: ADA });
  await until(() => texts.length === 2);

  await s.stop();
  // the first step is taken at once and lands on a stopped service; the second waits 1.5 s
  await until(() => darks() === 2, 1000);
  await s.start();
  const fresh = await s.open();
  await fresh.append("house", { text: "three, while it was dark", author: ADA });
  await fresh.append("house", { text: "four, while it was dark", author: ADA });
  assert.equal(texts.length, 2, "nothing arrives while the follow waits");
  await until(() => states.at(-1) === "live");
  await fresh.append("house", { text: "five, live", author: ADA });
  await until(() => texts.length === 5);

  // a live subscription starts the ladder over: the next first step is again taken at once
  await s.stop();
  await until(() => darks() === 4, 1000);
  await s.start();
  await until(() => states.at(-1) === "live");
  const last = await (await s.open()).append("house", { text: "six", author: ADA });
  await until(() => texts.length === 6);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(texts, ["one", "two", "three, while it was dark", "four, while it was dark", "five, live", "six"]);
  assert.deepEqual(states, ["live", "dark:service-dark", "dark:service-dark", "live", "dark:service-dark", "dark:service-dark", "live"]);
  assert.equal(follow.cursor, last.cursor);
  follow.close();
  follow.close();

  /** @type {string[]} */
  const refusedStates = [];
  const stray = app.follow("house", { thread: "e".repeat(64) }, { message: () => undefined, state: (state, error) => refusedStates.push(`${state}:${error?.code}`) }, { backoffMs: [10] });
  await until(() => refusedStates.length === 1);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(refusedStates, ["refused:thread-root-unknown"], "a refusal is reported once and the follow does not loop");
  assert.equal(stray.cursor, undefined);
});

test("a follow closed before its first subscription lands reports nothing and delivers nothing; its tuning is checked", { timeout: 30_000 }, async (t) => {
  const s = await seat(t);
  const app = await s.open();
  /** @type {string[]} */
  const seen = [];
  const early = app.follow("house", {}, { message: (m) => seen.push(m.text), state: (state) => seen.push(state) });
  early.close();
  await app.append("house", { text: "after the close", author: ADA });
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(seen, []);

  assert.deepEqual(FOLLOW_BACKOFF_MS, [500, 1000, 2000, 5000, 15000]);
  app.follow("house", {}, { message: () => undefined }, { backoffMs: [0] }).close();
  for (const backoffMs of [[], [-1], [Number.NaN], [Number.POSITIVE_INFINITY], /** @type {any} */ ("500")])
    assert.equal(thrown(() => app.follow("house", {}, { message: () => undefined }, { backoffMs })).code, "backoff-invalid", JSON.stringify(backoffMs));
  assert.equal(thrown(() => app.follow("house", {}, /** @type {any} */ ({}))).code, "handlers-invalid");
  assert.equal(thrown(() => app.follow("house", {}, /** @type {any} */ (null))).code, "handlers-invalid");

  // a follow that starts on a dark service takes the ladder from its first step, and the last step repeats
  await s.stop();
  /** @type {string[]} */
  const startedDark = [];
  const waiting = app.follow("house", {}, { message: () => undefined, state: (state) => startedDark.push(state) }, { backoffMs: [0, 0, 60_000] });
  await until(() => startedDark.length === 3, 1000);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(startedDark, ["dark", "dark", "dark"], "two immediate steps, then the long one");
  waiting.close();
});

test("a handler that throws ends its subscription as refused, before the message it threw on", { timeout: 30_000 }, async (t) => {
  const s = await seat(t);
  const app = await s.open();
  /** @type {ClientError[]} */
  const ended = [];
  const sub = await app.subscribe("house", {}, {
    message: (m) => { if (m.text === "bad") throw new Error("the app's own bug"); },
    refused: (e) => ended.push(e),
  });
  const before = sub.cursor;
  await app.append("house", { text: "bad", author: ADA });
  await until(() => ended.length === 1);
  assert.equal(ended[0].code, "handler-threw");
  assert.equal(sub.cursor, before, "the cursor stays before the message whose handler threw");

  // the same during the replay: the subscription ends there, and its cursor does not jump to the end
  await app.append("house", { text: "fine", author: ADA });
  /** @type {ClientError[]} */
  const replayEnded = [];
  const replay = await app.subscribe("house", { since: `${EPOCH}:0` }, {
    message: (m) => { if (m.text === "bad") throw new Error("the app's own bug"); },
    refused: (e) => replayEnded.push(e),
  });
  assert.deepEqual(replayEnded.map((e) => e.code), ["handler-threw"]);
  assert.equal(replay.cursor, `${EPOCH}:0`, "stopped before the message it threw on, not at the committed end");
  assert.equal((await failure(app.subscribe("house", {}, /** @type {any} */ ({})))).code, "handlers-invalid");
  assert.equal((await failure(app.subscribe("house", {}, /** @type {any} */ (null)))).code, "handlers-invalid");
});

test("unknown acceptance: the socket dies with the append on the wire, and the error carries the operation id to resend", { timeout: 30_000 }, async (t) => {
  const s = await stub(t, { offer: { advertised: ["threads-v1", "client-name-v1"], required: [] }, answer: (f) => (f.type === "append" ? "drop" : undefined) });
  const app = await connect({ state: s.root, config: s.config });
  t.after(() => app.close());
  const e = await failure(app.append("house", { text: "did this land?", author: ADA, operationId: "op_unknown_0000001" }));
  assert.deepEqual([e.outcome, e.code, e.operationId], ["unknown-acceptance", "acceptance-unknown", "op_unknown_0000001"]);
  assert.equal(s.frames.filter((f) => f.type === "append").length, 1, "sent once, and never resent by the client");
  assert.deepEqual(Object.keys(s.frames[0].operation).sort(), ["authorKind", "authorName", "operationId", "text"]);
});

test("a service that offers nothing: a client name is refused at connect, and a thread request is refused before anything is sent", { timeout: 30_000 }, async (t) => {
  const s = await stub(t, {});
  const named = await failure(connect({ state: s.root, config: s.config, clientName: "review-app" }));
  assert.deepEqual([named.outcome, named.code], ["refused", "client-name-unsupported"]);
  // an offer of client-name-v1 that does not echo the name it took is refused the same way
  const quiet = await stub(t, { offer: { advertised: ["client-name-v1"], required: [] } });
  assert.equal((await failure(connect({ state: quiet.root, config: quiet.config, clientName: "review-app" }))).code, "client-name-unsupported");

  const app = await connect({ state: s.root, config: s.config });
  t.after(() => app.close());
  assert.deepEqual([...app.capabilities], []);
  for (const attempt of [
    () => app.read("house", { thread: "a".repeat(64) }),
    () => app.append("house", { text: "x", author: ADA, thread: "a".repeat(64) }),
    () => app.subscribe("house", { since: `${EPOCH}:0`, thread: "a".repeat(64) }, { message: () => undefined }),
  ]) {
    const e = await failure(attempt());
    assert.deepEqual([e.outcome, e.code], ["refused", "thread-unsupported"]);
  }
  assert.deepEqual(s.frames, [], "nothing was sent");
});

test("the package exports agora/client and nothing else under src", { timeout: 30_000 }, async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(pkg.exports, { "./client": "./src/client.mjs", "./package.json": "./package.json" });
  const named = await import("agora/client");
  assert.equal(named.connect, connect);
  const deep = "agora/src/core.mjs";
  await assert.rejects(import(deep), /ERR_PACKAGE_PATH_NOT_EXPORTED/, "a deep path is not part of the contract");
  assert.ok((await readdir(new URL("../src", import.meta.url))).includes("client.mjs"));
});
