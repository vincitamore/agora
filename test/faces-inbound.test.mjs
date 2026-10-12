// @ts-check
// The inbound face: a person's reply in a faced Slack thread becomes a native append in that thread,
// against a real seat service in a temporary state root (stopped, then removed, in one hook). Every
// Slack call goes to an injected fetch; no test reads a token, the network, or the shared config.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { FaceRunner, appendFaceRecord, faceRecordsPath, readFacePolicy, writeFacePolicy } from "../src/faces.mjs";
import {
  FaceInbound, INBOUND_FILES_PER_MESSAGE, INBOUND_FILE_MAX_BYTES, arrivedFromFace, faceInboundPath, faceThreadOf, inboundOperationId, inboundVia, readInbound, readThreadMap,
} from "../src/faces-inbound.mjs";
import { custodyPath } from "../src/native-attachments.mjs";
import { SLACK_IMAGE_MAX_BYTES, SLACK_IMAGE_MAX_PER_MESSAGE, slackTransport } from "../src/transports/slack.mjs";
import { ROOM, seat } from "./client-fixtures.mjs";

const CHANNEL = "C0123ABC";
const ROOT_TS = "1756900001.000000";
const ATTESTOR = { serviceId: "svc-0123456789abcdef", serviceBootId: "boot-0123456789abcdef" };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("a small picture")]);
const NOT_AN_IMAGE = Buffer.from("<html>a sign-in page</html>");
const PDF = Buffer.from("%PDF-1.7\n%%EOF\n");
const digestOf = (/** @type {Uint8Array} */ b) => `sha256:${createHash("sha256").update(b).digest("hex")}`;

/** A clock the tests move by hand. @param {string} iso */
function clock(iso) {
  const c = { t: Date.parse(iso), now: () => new Date(c.t), advance: (/** @type {number} */ ms) => { c.t += ms; } };
  return c;
}

/**
 * A fake Slack: Web API methods by name, file bytes by path on files.slack.com, every call recorded.
 * @param {{ replies: () => any[], files?: Record<string, { bytes: Buffer, type: string }>, own?: { user: string, bot: string } }} o
 */
function fakeSlack(o) {
  /** @type {URL[]} */
  const calls = [];
  /** @type {typeof globalThis.fetch} */
  const fetchFake = async (input, init) => {
    const url = new URL(String(input));
    calls.push(url);
    const json = (/** @type {unknown} */ body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url.hostname === "files.slack.com") {
      const file = o.files?.[url.pathname];
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer xoxb-fake-test", "a download carries the token, to slack.com only");
      return file ? new Response(new Uint8Array(file.bytes), { status: 200, headers: { "content-type": file.type } }) : new Response("gone", { status: 404 });
    }
    const method = url.pathname.split("/").pop();
    if (method === "auth.test") return json({ ok: true, user_id: o.own?.user ?? "UBOT", user: "seat-bot", bot_id: o.own?.bot ?? "BSEAT" });
    if (method === "users.info") return json({ ok: true, user: { id: url.searchParams.get("user"), real_name: url.searchParams.get("user") === "U2" ? "operator" : "someone" } });
    if (method === "conversations.replies") return json({ ok: true, has_more: false, messages: o.replies() });
    if (method === "conversations.history") return json({ ok: true, has_more: false, messages: [] });
    return json({ ok: false, error: "no route" });
  };
  return { fetch: fetchFake, calls, callsTo: (/** @type {string} */ m) => calls.filter((u) => u.pathname.endsWith(`/${m}`)) };
}

/** @param {string} ts @param {string} user @param {string} text @param {Record<string, unknown>} [extra] */
const reply = (ts, user, text, extra = {}) => ({ ts, user, text, thread_ts: ROOT_TS, ...extra });
/** @param {string} id @param {string} name @param {string} mimetype @param {number} size @param {string} [host] */
const slackFile = (id, name, mimetype, size, host = "files.slack.com") => ({ id, name, mimetype, size, url_private: `https://${host}/files-pri/T1-${id}/${name}`, url_private_download: `https://${host}/files-pri/T1-${id}/download/${name}`, permalink: `https://example.slack.com/files/${id}` });

/**
 * A seat with one native room, one Slack face, one faced root, and the inbound half wired to a
 * client that declared `slack-face`.
 * @param {import('node:test').TestContext} t
 * @param {{ replies: () => any[], files?: Record<string, { bytes: Buffer, type: string }>, rootAt?: string, records?: any[], clock?: ReturnType<typeof clock>, inbound?: Record<string, number> }} o
 */
async function rig(t, o) {
  const s = await seat(t);
  const c = o.clock ?? clock("2026-09-05T12:00:30.000Z");
  await writeFacePolicy(s.root, ROOM, { faces: [{ transport: "slack", alias: "house-slack", target: { channel: CHANNEL } }] }, { now: c.now });
  const agent = await s.open();
  const root = await agent.append("house", { text: "the relay is up; does it answer for you?\n\nto: operator", author: { kind: "agent", name: "Grace/watch" } });
  await appendFaceRecord(s.root, ROOM, { originId: root.id, cursor: root.cursor, transport: "slack", status: "published", id: ROOT_TS, attempt: 1, at: o.rootAt ?? "2026-09-05T12:00:00.300Z", selector: "addressed" });
  for (const r of o.records ?? []) await appendFaceRecord(s.root, ROOM, r);
  const slack = fakeSlack(o);
  const transport = slackTransport({ transport: "slack", channel: CHANNEL }, { token: "xoxb-fake-test", fetch: slack.fetch, sleep: async () => {} });
  /** @type {string[]} */
  const warned = [];
  const face = (await readFacePolicy(s.root, ROOM)).faces[0];
  const app = await s.open({ clientName: inboundVia("slack") });
  const make = () => {
    const runner = new FaceRunner({ stateRoot: s.root, roomId: ROOM, attestor: ATTESTOR, now: c.now, warn: (l) => warned.push(l), transportFor: async () => transport });
    return new FaceInbound({ stateRoot: s.root, roomId: ROOM, runner, client: app, room: "house", now: c.now, warn: (l) => warned.push(l), ...(o.inbound ?? {}) });
  };
  const replies = async () => (await agent.read("house", { thread: root.id })).messages.filter((m) => m.id !== root.id);
  return { s, c, slack, transport, face, root, agent, app, make, replies, warned };
}

test("a person's reply in a faced Slack thread is a native reply under the faced root, stamped human, by name, via slack-face", { timeout: 30_000 }, async (t) => {
  const r = await rig(t, { replies: () => [
    { ts: ROOT_TS, bot_id: "BSEAT", subtype: "bot_message", username: "seat-bot", text: "the relay is up", reply_count: 1, metadata: { event_type: "agora_face", event_payload: { origin: "x" } } },
    reply("1756900002.500000", "U2", "yes, both ports answer"),
  ] });
  const result = await r.make().poll(r.face);
  assert.deepEqual(result.threads.map((x) => [x.ts, x.held, x.ingested]), [[ROOT_TS, false, 1]]);
  assert.match(r.slack.callsTo("conversations.replies")[0].search, /include_all_metadata=true/, "the read asks for riders, so the loop check sees our own copies");
  const [m] = await r.replies();
  assert.equal(m.thread, r.root.id, "the reply sits under the faced root");
  assert.equal(m.text, "yes, both ports answer");
  assert.deepEqual([m.author.kind, m.author.name, m.author.ref, m.via], ["human", "operator", "U2", "slack-face"]);
  assert.equal(arrivedFromFace(m, "slack"), true, "the outbound runner can tell a crossing from a native post");
  assert.equal(arrivedFromFace({ via: "example-app" }, "slack"), false);
  // the ingested line and the persisted map
  const { ingested, threads, cursors } = await readInbound(r.s.root, ROOM);
  const line = ingested.get(`slack\0${CHANNEL}\x001756900002.500000`);
  assert.equal(line?.id, m.id);
  assert.equal(threads.get(`slack\0${CHANNEL}\0${ROOT_TS}`)?.root, r.root.id);
  assert.equal(cursors.get(`slack\0${CHANNEL}\0${ROOT_TS}`), "1756900002.500000");
  if (process.platform !== "win32") assert.equal((await stat(faceInboundPath(r.s.root, ROOM))).mode & 0o777, 0o600);
});

test("the loop check: a copy this seat faced, by rider or by published ts, never comes back in; a foreign bot arrives as an agent", { timeout: 30_000 }, async (t) => {
  const ourReply = { originId: "b".repeat(64), cursor: "x", transport: "slack", status: "published", id: "1756900003.000000", thread: ROOT_TS, attempt: 1, at: "2026-09-05T12:00:03.100Z" };
  const r = await rig(t, { records: [ourReply], replies: () => [
    // a native reply this seat faced into the thread: its rider names a face record
    reply("1756900003.000000", "UBOT", "faced back out", { bot_id: "BSEAT", subtype: "bot_message", username: "seat-bot" }),
    // the same seat's copy with the rider stripped (an edit), caught by its published ts
    reply("1756900004.000000", "UBOT", "a second faced copy", { bot_id: "BSEAT", subtype: "bot_message", username: "seat-bot", metadata: { event_type: "agora_face", event_payload: { origin: "b".repeat(64) } } }),
    reply("1756900005.000000", "UPARTNER", "the other side's agent says hello", { bot_id: "BPARTNER", subtype: "bot_message", username: "partner-agent" }),
    reply("1756900006.000000", "U2", "", { subtype: "channel_join" }),
  ] });
  const result = await r.make().poll(r.face);
  const [thread] = result.threads;
  assert.deepEqual(thread.notIngested.map((x) => x.id), ["1756900003.000000", "1756900004.000000"]);
  const replies = await r.replies();
  assert.deepEqual(replies.map((m) => [m.text, m.author.kind, m.author.name, m.via]), [["the other side's agent says hello", "agent", "partner-agent", "slack-face"]]);
});

test("a held thread keeps its position: our own account while a face is pending appends nothing and moves no cursor", { timeout: 30_000 }, async (t) => {
  const c = clock("2026-09-05T12:00:30.000Z");
  const pending = { originId: "c".repeat(64), cursor: "y", transport: "slack", status: "pending", attempt: 1, at: "2026-09-05T12:00:20.000Z", pendingAt: "2026-09-05T12:00:20.000Z", thread: ROOT_TS };
  const r = await rig(t, { clock: c, records: [pending], replies: () => [
    reply("1756900007.000000", "U2", "first"),
    reply("1756900008.000000", "UBOT", "our own copy, response not yet back", { bot_id: "BSEAT", subtype: "bot_message", username: "seat-bot" }),
    reply("1756900009.000000", "U2", "after"),
  ] });
  const result = await r.make().poll(r.face);
  assert.equal(result.threads[0].held, true);
  assert.equal(result.threads[0].reason, "own-account-while-pending");
  assert.deepEqual((await r.replies()).map((m) => m.text), ["first"], "only what came before the held message crossed");
  assert.equal((await readInbound(r.s.root, ROOM)).cursors.get(`slack\0${CHANNEL}\0${ROOT_TS}`), "1756900007.000000");
});

test("a restart resumes from the saved position, and a replay past a lost position is the host's duplicate, never a second message", { timeout: 30_000 }, async (t) => {
  /** @type {any[]} */
  let thread = [reply("1756900010.000000", "U2", "one"), reply("1756900011.000000", "U2", "two")];
  const r = await rig(t, { replies: () => thread });
  await r.make().poll(r.face);
  assert.equal((await r.replies()).length, 2);
  // a second runner and inbound on the same root, as after a seat restart: nothing new, nothing twice
  thread = [...thread, reply("1756900012.000000", "U2", "three")];
  const again = await r.make().poll(r.face);
  assert.equal(again.threads[0].ingested, 1);
  assert.deepEqual((await r.replies()).map((m) => m.text), ["one", "two", "three"]);
  // the position lost (a crash between the append and the cursor line): the replay is a duplicate
  const file = faceInboundPath(r.s.root, ROOM);
  const kept = (await readFile(file, "utf8")).split("\n").filter((l) => l && JSON.parse(l).kind !== "cursor");
  await writeFile(file, kept.join("\n") + "\n");
  await r.make().poll(r.face);
  assert.deepEqual((await r.replies()).map((m) => m.text), ["one", "two", "three"], "the operation id derives from the Slack ts, so the host answers with the original");
  const { ingested } = await readInbound(r.s.root, ROOM);
  assert.equal(ingested.get(`slack\0${CHANNEL}\x001756900010.000000`)?.duplicate, true);
  assert.equal(inboundOperationId(ROOM, "slack", CHANNEL, "1756900010.000000").length, 64);
});

test("the thread map is persisted: it survives the face record log and maps both ways", { timeout: 30_000 }, async (t) => {
  const r = await rig(t, { replies: () => [reply("1756900013.000000", "U2", "mapped")] });
  await r.make().poll(r.face);
  assert.equal(await faceThreadOf(r.s.root, ROOM, r.face, r.root.id), ROOT_TS);
  await rm(faceRecordsPath(r.s.root, ROOM));
  const map = await readThreadMap(r.s.root, ROOM, r.face);
  assert.equal(map.get(ROOT_TS)?.root, r.root.id, "a pairing a reply crossed in outlives the face records");
  assert.equal(await faceThreadOf(r.s.root, ROOM, r.face, "f".repeat(64)), undefined);
  assert.equal(await faceThreadOf(r.s.root, ROOM, { transport: "slack", target: { channel: "C0OTHER" } }, r.root.id), undefined, "a map is per channel");
});

test("a thread past the active window is not read; a faced reply is no thread root", { timeout: 30_000 }, async (t) => {
  const inThread = { originId: "d".repeat(64), cursor: "z", transport: "slack", status: "published", id: "1756900020.000000", thread: ROOT_TS, attempt: 1, at: "2026-09-05T12:00:20.000Z" };
  const r = await rig(t, { clock: clock("2026-09-20T12:00:00.000Z"), rootAt: "2026-09-05T12:00:00.300Z", records: [inThread], replies: () => [reply("1756900021.000000", "U2", "late")] });
  const inbound = r.make();
  assert.deepEqual(await inbound.threads(r.face), []);
  const result = await inbound.poll(r.face);
  assert.deepEqual(result.threads, []);
  assert.equal(r.slack.callsTo("conversations.replies").length, 0);
});

test("files cross into custody under the reader's caps; an image is what its bytes prove; the rest keep a metadata line", { timeout: 30_000 }, async (t) => {
  const files = {
    "/files-pri/T1-F1/download/shot.png": { bytes: PNG, type: "image/png" },
    "/files-pri/T1-F2/download/report.pdf": { bytes: PDF, type: "application/pdf" },
    "/files-pri/T1-F3/download/fake.png": { bytes: NOT_AN_IMAGE, type: "image/png" },
  };
  const r = await rig(t, { files, inbound: { filesPerMessage: 4 }, replies: () => [reply("1756900030.000000", "U2", "here are the files\n\nto: Grace/watch", { files: [
    slackFile("F1", "shot.png", "image/png", PNG.length),
    slackFile("F2", "report.pdf", "application/pdf", PDF.length),
    slackFile("F3", "fake.png", "image/png", NOT_AN_IMAGE.length),
    slackFile("F4", "huge.png", "image/png", INBOUND_FILE_MAX_BYTES + 1),
    slackFile("F5", "fifth.png", "image/png", PNG.length),
  ] })] });
  await r.make().poll(r.face);
  const [m] = await r.replies();
  const attachments = /** @type {any[]} */ (m.attachments);
  assert.deepEqual(attachments.map((a) => [a.name, a.kind, a.mimetype, a.digest]), [["shot.png", "image", "image/png", digestOf(PNG)], ["report.pdf", "file", "application/pdf", digestOf(PDF)]]);
  for (const a of attachments) assert.ok((await stat(custodyPath(`${r.s.root}/native/rooms/${ROOM}`, a.digest))).isFile(), `${a.name} is in custody`);
  const lines = m.text.split("\n");
  assert.equal(lines[0], "here are the files");
  assert.ok(lines.includes(`image fake.png (image/png, ${NOT_AN_IMAGE.length} bytes) not copied: the bytes are not the image the transport named`));
  assert.ok(lines.includes(`image huge.png (image/png, ${INBOUND_FILE_MAX_BYTES + 1} bytes) not copied: the file exceeds the ${INBOUND_FILE_MAX_BYTES}-byte limit`));
  assert.ok(lines.includes(`image fifth.png (image/png, ${PNG.length} bytes) not copied: more than 4 files on one message`));
  assert.equal(lines.at(-1), "to: Grace/watch", "the person's own trailer block stays last, so it still parses");
  assert.equal(r.slack.calls.filter((u) => u.pathname.includes("huge.png")).length, 0, "a file over the cap is never downloaded");
  assert.doesNotMatch(m.text, /files\.slack\.com|files-pri/, "a private URL is never written");
  assert.deepEqual([INBOUND_FILE_MAX_BYTES, INBOUND_FILES_PER_MESSAGE], [SLACK_IMAGE_MAX_BYTES, SLACK_IMAGE_MAX_PER_MESSAGE], "the caps are a reader's --files caps");
});

test("the token goes to slack.com only: a file whose private URL names another host is not downloaded", { timeout: 30_000 }, async (t) => {
  const r = await rig(t, { replies: () => [reply("1756900040.000000", "U2", "", { files: [slackFile("F9", "x.png", "image/png", 10, "files.slack.com.example.net")] })] });
  await r.make().poll(r.face);
  const [m] = await r.replies();
  assert.equal(m.attachments, undefined);
  assert.equal(m.text, "image x.png (image/png, 10 bytes) not copied: the private download URL is not a slack.com origin; the token is not sent there");
  assert.equal(r.slack.calls.filter((u) => u.hostname !== "slack.com").length, 0);
});

test("the inbound read leaves attachments unmaterialized and serializes no download or private URL", async () => {
  const slack = fakeSlack({ replies: () => [reply("1756900050.000000", "U2", "a picture", { files: [slackFile("F1", "shot.png", "image/png", PNG.length)] })], files: { "/files-pri/T1-F1/download/shot.png": { bytes: PNG, type: "image/png" } } });
  const transport = slackTransport({ transport: "slack", channel: CHANNEL }, { token: "xoxb-fake-test", fetch: slack.fetch, sleep: async () => {}, mediaDir: "/nonexistent/should-not-be-written" });
  const [m] = await transport.inbound({ thread: ROOT_TS, since: ROOT_TS });
  const json = JSON.stringify(m);
  assert.doesNotMatch(json, /files-pri|download"/);
  const [a] = /** @type {any[]} */ (m.attachments);
  assert.equal(a.path, undefined);
  assert.equal(slack.calls.filter((u) => u.hostname === "files.slack.com").length, 0, "nothing is fetched until the face asks");
  assert.deepEqual(await a.download(1024), PNG);
  await assert.rejects(a.download(4), /exceeds the 4-byte limit/);
  await assert.rejects(transport.inbound({ thread: "1756900050.65" }), /inbound read: a Slack thread id/);
});
