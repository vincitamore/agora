// @ts-check
// The faces wired into the seat service (src/native-faces-wiring.mjs): a committed message's face
// rows ride its ack and the copy is published after; an edit and a withdraw reach the copy
// (chat.update, chat.delete, files.delete); a purge deletes what it can within its bounded wait and
// lists the rest as facesOutOfReach; the restart sweep reconciles a face whose writer died; the
// pictures come from custody. Every Slack call goes to the injected fake of test/helpers.mjs; no test
// reads a token, the network, or the shared config.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { connect } from "../src/client.mjs";
import { NativeRoomService, NativeServiceClient } from "../src/native-service.mjs";
import { readServiceDescriptor } from "../src/wake/subscriber.mjs";
import { FaceRunner, appendFaceRecord, readFaceRecords, selectFaces, writeFacePolicy } from "../src/faces.mjs";
import { configFaceTransports, facedRooms, faceChoiceOf } from "../src/native-faces-wiring.mjs";
import { slackTransport } from "../src/transports/slack.mjs";
import { fakeFetch } from "./helpers.mjs";

const ROOM = "5".repeat(32);
const EPOCH = "4".repeat(32);
const ACCOUNT = "seat_account_0003";
const CHANNEL = "C0FACE01";
const GRACE = { kind: /** @type {const} */ ("agent"), name: "Grace/watch" };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(300)]);
const op = () => randomUUID().replaceAll("-", "");

/**
 * A fake Slack: postMessage hands out increasing ts values, and every other method answers ok
 * unless a test replaces its route. `gate` holds chat.postMessage until released.
 * @param {Record<string, (url: URL, init: RequestInit | undefined) => any>} [over]
 */
function fakeSlack(over = {}) {
  let n = 0;
  /** @type {Array<[string, (url: URL, init: RequestInit | undefined) => any]>} */
  const routes = [
    ["auth.test", () => ({ body: { ok: true, user_id: "UBOT", user: "seatbot", bot_id: "BBOT" } })],
    ["chat.postMessage", over["chat.postMessage"] ?? (() => ({ body: { ok: true, ts: `1790000000.${String(++n).padStart(6, "0")}`, channel: CHANNEL } }))],
    ["chat.update", over["chat.update"] ?? ((_u, init) => ({ body: { ok: true, ts: JSON.parse(String(init?.body)).ts, channel: CHANNEL } }))],
    ["chat.delete", over["chat.delete"] ?? ((_u, init) => ({ body: { ok: true, ts: JSON.parse(String(init?.body)).ts, channel: CHANNEL } }))],
    ["files.getUploadURLExternal", () => ({ body: { ok: true, upload_url: "https://files.slack.com/upload/v1/abc", file_id: "F0PIC" } })],
    ["files.slack.com/upload", () => ({ status: 200, body: "OK" })],
    ["files.completeUploadExternal", () => ({ body: { ok: true, files: [{ id: "F0PIC", title: "shot.png" }] } })],
    ["files.delete", over["files.delete"] ?? (() => ({ body: { ok: true } }))],
    ["conversations.history", over["conversations.history"] ?? (() => ({ body: { ok: true, messages: [], has_more: false } }))],
  ];
  return fakeFetch(routes);
}

/**
 * A seat whose service runs the faces on an injected fetch, with one native room faced to one
 * Slack channel. Stopped, then removed, in one hook.
 * @param {import('node:test').TestContext} t
 * @param {{ face?: Record<string, unknown>, slack?: ReturnType<typeof fakeSlack>, dark?: boolean, purgeDeadlineMs?: number, tickMs?: number, onTick?: (tick: any) => Promise<unknown> }} [o]
 */
async function seat(t, o = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-faces-wired-"));
  const slack = o.slack ?? fakeSlack();
  /** @type {string[]} */
  const warned = [];
  const transportFor = async () => {
    if (o.dark) throw new Error('room "slackroom": no token (set tokenEnv or tokenFile to the bot token)');
    return slackTransport({ transport: "slack", channel: CHANNEL }, { token: "xoxb-fake-test", fetch: slack.fetch, sleep: async () => {} });
  };
  const options = { root, accountId: ACCOUNT, seatLabel: "seat-f",
    faces: { transportFor, warn: (/** @type {string} */ l) => warned.push(l), ...(o.purgeDeadlineMs ? { purgeDeadlineMs: o.purgeDeadlineMs } : {}),
    ...(o.tickMs ? { tickMs: o.tickMs } : {}), ...(o.onTick ? { onTick: o.onTick } : {}) } };
  let service = new NativeRoomService(options);
  /** @type {Array<{ close(): void }>} */
  const clients = [];
  t.after(async () => { for (const c of clients) c.close(); await service.stop(); await rm(root, { recursive: true, force: true }); });
  await service.start();
  await service.createRoom({ roomId: ROOM, epoch: EPOCH });
  // the policy is the seat's record beside the room (written by `agora room faces`)
  await writeFacePolicy(root, ROOM, { faces: [{ transport: "slack", alias: "slackroom", target: { channel: CHANNEL }, post: { agent: ["always"] }, ...(o.face ?? {}) }] });
  const config = path.join(root, "agora.json");
  await writeFile(config, JSON.stringify({ actor: GRACE, rooms: { house: { transport: "native", roomId: ROOM } } }), "utf8");
  /** @param {(r: Map<string, any>) => boolean} until */
  const records = async (until = () => true, ms = 5000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const r = await readFaceRecords(root, ROOM);
      if (until(r) || Date.now() > deadline) return r;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  /** @param {string} needle */
  const callsTo = (needle) => slack.calls.filter((c) => c.url.href.includes(needle));
  /** @param {{ init: RequestInit | undefined }} call */
  const bodyOf = (call) => JSON.parse(String(call.init?.body));
  return {
    root, slack, warned, records, callsTo, bodyOf,
    /** @param {{ clientName?: string }} [co] */
    open: async (co = {}) => { const c = await connect({ state: root, config, ...co }); clients.push(c); return c; },
    raw: async () => { const c = await NativeServiceClient.connect(/** @type {any} */ (await readServiceDescriptor(root))); clients.push(c); return c; },
    start: async () => { service = new NativeRoomService(options); await service.start(); },
    stop: () => service.stop(),
  };
}

/** @param {Map<string, any>} r @param {string} origin @param {string} [mirror] */
const rowOf = (r, origin, mirror) => [...r.values()].find((x) => x.originId === origin && !x.attachmentId && (mirror ? x.mirror === mirror : x.part !== "mirror"));

test("a committed message's face rows ride its ack before any call, and its copy is published after with the rider", { timeout: 60_000 }, async (t) => {
  const s = await seat(t);
  const c = await s.raw();
  const operation = { operationId: op(), authorName: GRACE.name, authorKind: "agent", text: "the derper is up" };
  const ack = /** @type {any} */ (await c.request("append", { roomId: ROOM, operation }));
  assert.deepEqual(ack.faces, [{ transport: "slack", status: "pending" }], "the ack carries the rows, each pending");
  const r = await s.records((m) => rowOf(m, ack.id)?.status === "published");
  assert.equal(rowOf(r, ack.id)?.id, "1790000000.000001");
  const posts = s.callsTo("chat.postMessage");
  assert.equal(posts.length, 1);
  assert.deepEqual(s.bodyOf(posts[0]), { channel: CHANNEL, text: "the derper is up", metadata: { event_type: "agora_face", event_payload: { origin: ack.id } } });
  // a resend of the same operation is the original receipt: no rows on it and no second copy
  const again = /** @type {any} */ (await c.request("append", { roomId: ROOM, operation }));
  assert.deepEqual([again.id, again.duplicate, again.faces], [ack.id, true, undefined]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(s.callsTo("chat.postMessage").length, 1);
});

test("the poster's choice rides the frame: --no-face publishes nothing, a malformed choice is refused with nothing committed", { timeout: 60_000 }, async (t) => {
  const s = await seat(t);
  const c = await s.raw();
  const ack = /** @type {any} */ (await c.request("append", { roomId: ROOM, face: "none", operation: { operationId: op(), authorName: GRACE.name, authorKind: "agent", text: "native only" } }));
  assert.deepEqual(ack.faces, []);
  await assert.rejects(c.request("append", { roomId: ROOM, face: ["Slack!"], operation: { operationId: op(), authorName: GRACE.name, authorKind: "agent", text: "bad choice" } }),
    (e) => /face-invalid/.test(String(e)));
  const app = await s.open();
  assert.deepEqual((await app.read("house")).messages.map((m) => m.text), ["native only"], "the refused append committed nothing");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(s.callsTo("chat.postMessage").length, 0);
  assert.equal(faceChoiceOf(undefined), "auto");
  assert.deepEqual(faceChoiceOf(["slack", "slack"]), ["slack"]);
});

test("a dark face never fails the native post: the ack is pending, the row settles refused dark, and no call is made", { timeout: 60_000 }, async (t) => {
  const s = await seat(t, { dark: true });
  const app = await s.open();
  const m = await app.append("house", { text: "posted while the face is dark", author: GRACE });
  const r = await s.records((x) => rowOf(x, m.id)?.status === "refused");
  assert.equal(rowOf(r, m.id)?.code, "dark");
  assert.match(String(rowOf(r, m.id)?.reason), /no token/);
  assert.equal(s.slack.calls.length, 0);
  assert.equal((await app.read("house")).messages[0].text, "posted while the face is dark");
});

test("an edit reaches the copy by chat.update with the rider, and a withdraw deletes it by chat.delete; each is a mirror row beside the copy's own", { timeout: 60_000 }, async (t) => {
  const s = await seat(t);
  const app = await s.open();
  const m = await app.append("house", { text: "first words", author: GRACE });
  await s.records((x) => rowOf(x, m.id)?.status === "published");
  const edit = await app.annotate("house", { act: "edit", target: m.id, text: "better words", author: GRACE });
  let r = await s.records((x) => rowOf(x, m.id, edit.id)?.status === "published");
  const updates = s.callsTo("chat.update");
  assert.equal(updates.length, 1);
  assert.deepEqual(s.bodyOf(updates[0]), { channel: CHANNEL, ts: "1790000000.000001", text: "better words", metadata: { event_type: "agora_face", event_payload: { origin: m.id } } });
  assert.equal(rowOf(r, m.id)?.status, "published", "the copy's own row is untouched by its mirror");
  assert.deepEqual([rowOf(r, m.id, edit.id)?.act, rowOf(r, m.id, edit.id)?.target], ["edit", "1790000000.000001"]);
  // a pin carries nothing to the face
  await app.annotate("house", { act: "pin", target: m.id, author: GRACE });
  const withdraw = await app.annotate("house", { act: "withdraw", target: m.id, author: GRACE });
  r = await s.records((x) => rowOf(x, m.id, withdraw.id)?.status === "published");
  assert.deepEqual(s.callsTo("chat.delete").map((c) => s.bodyOf(c)), [{ channel: CHANNEL, ts: "1790000000.000001" }]);
  assert.equal(s.callsTo("chat.update").length, 1, "the pin made no call");
});

test("an edit made while the copy is still in flight lands on the copy after it, never before", { timeout: 60_000 }, async (t) => {
  /** @type {(v?: unknown) => void} */
  let release = () => {};
  const held = new Promise((r) => { release = r; });
  /** @type {string[]} */
  const order = [];
  const slack = fakeSlack({
    "chat.postMessage": () => { order.push("post"); return { body: { ok: true, ts: "1790000000.000009", channel: CHANNEL } }; },
    "chat.update": (_u, init) => { order.push("update"); return { body: { ok: true, ts: JSON.parse(String(init?.body)).ts } }; },
  });
  const slow = { ...slack, fetch: /** @type {typeof fetch} */ (async (input, init) => { if (String(input).includes("chat.postMessage")) await held; return slack.fetch(input, init); }) };
  const s = await seat(t, { slack: slow });
  const app = await s.open();
  const m = await app.append("house", { text: "draft", author: GRACE });
  const edit = await app.annotate("house", { act: "edit", target: m.id, text: "final", author: GRACE });
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(order, [], "nothing reaches the face while the post is held");
  release();
  const r = await s.records((x) => rowOf(x, m.id, edit.id)?.status === "published");
  assert.deepEqual(order, ["post", "update"]);
  assert.equal(rowOf(r, m.id, edit.id)?.target, "1790000000.000009");
});

test("a picture comes from custody with its digest checked, and a withdraw deletes the picture as well as the text copy", { timeout: 60_000 }, async (t) => {
  const s = await seat(t, { face: { attachments: "pictures" } });
  const app = await s.open();
  const ref = await app.upload("house", { bytes: PNG, name: "shot.png" });
  const m = await app.append("house", { text: "see the picture", author: GRACE, attachments: [ref] });
  let r = await s.records((x) => [...x.values()].some((y) => y.originId === m.id && y.attachmentId && y.status === "published"));
  const put = s.callsTo("files.slack.com/upload");
  assert.equal(put.length, 1);
  assert.equal(createHash("sha256").update(Buffer.from(/** @type {any} */ (put[0].init?.body))).digest("hex"), createHash("sha256").update(PNG).digest("hex"), "the bytes uploaded are custody's");
  const w = await app.annotate("house", { act: "withdraw", target: m.id, author: GRACE });
  r = await s.records((x) => [...x.values()].filter((y) => y.mirror === w.id && y.status === "published").length === 2);
  assert.deepEqual(s.callsTo("files.delete").map((c) => s.bodyOf(c)), [{ file: "F0PIC" }]);
  assert.equal(s.callsTo("chat.delete").length, 1);
});

test("a purge deletes the copies it reaches and lists as facesOutOfReach the ones it could not delete, with the reason", { timeout: 60_000 }, async (t) => {
  /** @type {(v?: unknown) => void} */
  let release = () => {};
  const held = new Promise((r) => { release = r; });
  t.after(() => release());
  const slack = fakeSlack({
    "chat.delete": (_u, init) => {
      const ts = JSON.parse(String(init?.body)).ts;
      return ts === "1790000000.000002" ? { body: { ok: false, error: "cant_delete_message" } } : { body: { ok: true, ts } };
    },
  });
  const hang = { ...slack, fetch: /** @type {typeof fetch} */ (async (input, init) => {
    if (String(input).includes("chat.delete") && JSON.parse(String(init?.body)).ts === "1790000000.000003") await held;
    return slack.fetch(input, init);
  }) };
  const s = await seat(t, { slack: hang, purgeDeadlineMs: 300 });
  const app = await s.open();
  const a = await app.append("house", { text: "reached", author: GRACE });
  const b = await app.append("house", { text: "refused by the face", author: GRACE });
  const c = await app.append("house", { text: "slow to delete", author: GRACE });
  const native = /** @type {any} */ (await (await s.raw()).request("append", { roomId: ROOM, face: "none", operation: { operationId: op(), authorName: GRACE.name, authorKind: "agent", text: "never faced" } }));
  await s.records((x) => [a, b, c].every((m) => rowOf(x, m.id)?.status === "published"));
  const receipt = await app.purge("house", { targets: [a.id, b.id, c.id, native.id], reason: "remove", author: GRACE });
  assert.deepEqual(receipt.purged, [a.id, b.id, c.id, native.id]);
  const out = receipt.facesOutOfReach.map((f) => [f.message, f.transport, f.channel, f.ts]);
  assert.deepEqual(out, [[b.id, "slack", CHANNEL, "1790000000.000002"], [c.id, "slack", CHANNEL, "1790000000.000003"]]);
  assert.match(String(receipt.facesOutOfReach[0].reason), /cant_delete_message/);
  assert.match(String(receipt.facesOutOfReach[1].reason), /unconfirmed when the receipt was written/);
  // the deletion that outlived the receipt goes on and lands in the record log
  release();
  const r = await s.records((x) => rowOf(x, c.id, receipt.id)?.status === "published");
  assert.equal(rowOf(r, c.id, receipt.id)?.act, "purge");
  assert.equal(rowOf(r, a.id, receipt.id)?.status, "published");
  assert.equal(rowOf(r, b.id, receipt.id)?.status, "refused");
});

test("the restart sweep: a pending face whose writer died is found by its rider and published with no post; one not found is posted once", { timeout: 60_000 }, async (t) => {
  /** @type {string[]} */
  const ids = [];
  const slack = fakeSlack({
    "conversations.history": () => ({ body: { ok: true, has_more: false, messages: [{ ts: "1790000000.000077", user: "UBOT", text: "landed before the crash",
      metadata: { event_type: "agora_face", event_payload: { origin: ids[0] } } }] } }),
  });
  const s = await seat(t, { slack });
  const c = await s.raw();
  /** @type {any[]} */
  const acks = [];
  for (const text of ["landed before the crash", "never landed"])
    acks.push(await c.request("append", { roomId: ROOM, face: "none", operation: { operationId: op(), authorName: GRACE.name, authorKind: "agent", text } }));
  ids.push(...acks.map((a) => a.id));
  await s.stop();
  // the service died after each pending line was durable and before its outcome was written
  const old = new Date(Date.now() - 120_000).toISOString();
  for (const a of acks)
    await appendFaceRecord(s.root, ROOM, { originId: a.id, cursor: a.cursor, transport: "slack", status: "pending", selector: "always", attempt: 1, at: old, pendingAt: old, payloadDigest: "sha256:" + "0".repeat(64) });
  await s.start();
  const r = await s.records((x) => ids.every((id) => rowOf(x, id)?.status === "published"));
  assert.deepEqual([rowOf(r, ids[0])?.id, rowOf(r, ids[0])?.via], ["1790000000.000077", "rider"], "found on the channel: published with zero posts");
  assert.equal(rowOf(r, ids[1])?.status, "published");
  const posts = s.callsTo("chat.postMessage");
  assert.equal(posts.length, 1, "only the one the channel did not hold is posted, once");
  assert.equal(s.bodyOf(posts[0]).text, "never landed");
  assert.equal(s.callsTo("conversations.history").length >= 2, true, "each was reconciled against the channel before any post");
});

test("a message withdrawn before its unknown face was confirmed is never reposted by the sweep", { timeout: 60_000 }, async (t) => {
  const s = await seat(t);
  const app = await s.open();
  const m = await app.append("house", { text: "taken back", author: GRACE });
  await s.records((x) => rowOf(x, m.id)?.status === "published");
  await app.annotate("house", { act: "withdraw", target: m.id, author: GRACE });
  app.close();
  await s.stop();
  const old = new Date(Date.now() - 120_000).toISOString();
  // as if the copy's response had been lost: the log says unknown, and the channel holds nothing
  await appendFaceRecord(s.root, ROOM, { originId: m.id, cursor: m.cursor, transport: "slack", status: "unknown", code: "lost-response", attempt: 1, at: old, pendingAt: old });
  const before = s.callsTo("chat.postMessage").length;
  await s.start();
  const r = await s.records((x) => rowOf(x, m.id)?.status === "refused");
  assert.equal(rowOf(r, m.id)?.code, "withdrawn");
  assert.equal(s.callsTo("chat.postMessage").length, before);
});

test("facedRooms lists the rooms with a face policy, and configFaceTransports borrows the named room's token aimed at the face's channel, writing no config", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-faces-wired-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await facedRooms(root), []);
  await writeFacePolicy(root, ROOM, { faces: [] });
  assert.deepEqual(await facedRooms(root), [ROOM]);
  /** @type {any[]} */
  const built = [];
  const cfg = { actor: GRACE, rooms: { slackroom: { transport: "slack", channel: "C0OTHER", tokenEnv: "X" }, house: { transport: "native", roomId: ROOM } } };
  const transportFor = configFaceTransports({ loadConfig: async () => cfg, createTransport: async (alias, room) => { built.push([alias, room]); return {}; } });
  await transportFor(/** @type {any} */ ({ transport: "slack", alias: "slackroom", target: { channel: CHANNEL } }));
  assert.deepEqual(built, [["slackroom", { transport: "slack", channel: CHANNEL, tokenEnv: "X" }]]);
  assert.equal(cfg.rooms.slackroom.channel, "C0OTHER", "the config object is not written");
  await assert.rejects(transportFor(/** @type {any} */ ({ transport: "slack", alias: "house", target: {} })), /does not name as a slack room/);
});

test("a face that cannot edit or delete (github) records its mirror refused by capability, and a purge lists its copy out of reach with no call", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-faces-wired-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const origin = "ab".repeat(32);
  await writeFacePolicy(root, ROOM, { faces: [{ transport: "github", alias: "issue", target: { repo: "owner/name", issue: "7" } }] });
  await appendFaceRecord(root, ROOM, { originId: origin, cursor: `${EPOCH}:1`, transport: "github", status: "published", id: "1234567", attempt: 1, at: new Date().toISOString() });
  let built = 0;
  const runner = new FaceRunner({ stateRoot: root, roomId: ROOM, attestor: { serviceId: ACCOUNT, serviceBootId: EPOCH }, warn: () => {},
    transportFor: async () => { built++; throw new Error("no transport is built for a face that cannot mirror"); } });
  const [edited] = await runner.mirror({ act: "edit", id: "e".repeat(64), target: origin });
  assert.deepEqual([edited.status, edited.code], ["refused", "capability"]);
  const { facesOutOfReach, work } = await runner.purge({ id: "f".repeat(64), purged: [origin] }, { deadlineMs: 1000 });
  await work;
  assert.equal(facesOutOfReach.length, 1);
  assert.deepEqual([facesOutOfReach[0].transport, facesOutOfReach[0].channel, facesOutOfReach[0].ts, facesOutOfReach[0].message], ["github", "owner/name#7", "1234567", origin]);
  assert.match(facesOutOfReach[0].reason, /^capability: the github face cannot delete/);
  assert.equal(built, 0);
});

test("a message that crossed in from a face is never faced back to it: via slack-face selects no Slack face, in policy mode or by name", { timeout: 60_000 }, async (t) => {
  const policy = /** @type {any} */ ({ version: 1, roomId: ROOM, updatedAt: null, faces: [{ transport: "slack", alias: "s", target: { channel: CHANNEL }, enabled: true,
    post: { human: ["always"], agent: ["always"], system: ["never"] }, attachments: "metadata", backfill: null }] });
  const ctx = { memberKind: () => undefined, lookupCursor: () => undefined };
  const human = { text: "a reply typed in the channel", author: { kind: "human", name: "Ada" } };
  assert.equal(selectFaces(policy, human, ctx).selected.length, 1, "the same message from anywhere else is faced");
  assert.deepEqual(selectFaces(policy, { ...human, via: "slack-face" }, ctx), { selected: [], refusals: [] });
  assert.deepEqual(selectFaces(policy, { ...human, via: "slack-face" }, ctx, { face: ["slack"] }), { selected: [], refusals: [] });
  assert.equal(selectFaces(policy, { ...human, via: "github-face" }, ctx).selected.length, 1, "only the face it came from is skipped");
  // through the service: a connection declared as slack-face appends a human reply; nothing goes back
  const s = await seat(t);
  const inbound = await s.open({ clientName: "slack-face" });
  const m = await inbound.append("house", { text: "a reply typed in the channel", author: { kind: "human", name: "Ada" } });
  const app = await s.open();
  const [read] = (await app.read("house")).messages;
  assert.equal(read.via, "slack-face");
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(s.callsTo("chat.postMessage").length, 0);
  assert.equal(rowOf(await readFaceRecords(s.root, ROOM), m.id), undefined, "no face row at all");
});

test("the tick runs the inbound seam per faced room with that room's own runner and its enabled faces, after the sweep", { timeout: 60_000 }, async (t) => {
  /** @type {any[]} */
  const ticks = [];
  const s = await seat(t, { tickMs: 50, onTick: async (tick) => { ticks.push(tick); } });
  const app = await s.open();
  await app.append("house", { text: "makes the room faced on this service", author: GRACE });
  for (let i = 0; i < 100 && !ticks.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(ticks.length >= 1);
  assert.equal(ticks[0].roomId, ROOM);
  assert.ok(ticks[0].runner instanceof FaceRunner);
  assert.deepEqual(ticks[0].faces.map((/** @type {any} */ f) => f.transport), ["slack"]);
  await s.stop();
  const after = ticks.length;
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(ticks.length, after, "a stopped service ticks no more");
});
