// @ts-check
// A purge scrubs the room's face records (src/faces-scrub.mjs, docs/PURGE.md § Faces): after it, no
// file under the room's directory names a purged message's attachments, while the deletions,
// facesOutOfReach and a later delete still work off what the rows keep. A scrub killed mid-way
// leaves the room openable and is finished by the next open or the next purge. Every Slack call goes
// to an injected fake; no test reads a token, the network, or the shared config.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { connect } from "../src/client.mjs";
import { NativeRoomService } from "../src/native-service.mjs";
import { NativeRoomStore } from "../src/native-store.mjs";
import { appendFaceRecord, readFaceRecords, writeFacePolicy } from "../src/faces.mjs";
import { appendInboundLine, readInbound } from "../src/faces-inbound.mjs";
import { scrubFaceRecords } from "../src/faces-scrub.mjs";
import { slackTransport } from "../src/transports/slack.mjs";
import { fakeFetch } from "./helpers.mjs";

const ROOM = "6".repeat(32);
const EPOCH = "7".repeat(32);
const ACCOUNT = "seat_account_0008";
const CHANNEL = "C0SCRUB1";
const GRACE = { kind: /** @type {const} */ ("agent"), name: "Grace/watch" };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(300)]);
const SCRUB_URL = pathToFileURL(path.resolve("src/faces-scrub.mjs")).href;

/** A fake Slack whose uploads hand out one file id per picture. @param {Record<string, (url: URL, init: RequestInit | undefined) => any>} [over] */
function fakeSlack(over = {}) {
  let n = 0;
  let f = 0;
  return fakeFetch([
    ["auth.test", () => ({ body: { ok: true, user_id: "UBOT", user: "seatbot", bot_id: "BBOT" } })],
    ["chat.postMessage", () => ({ body: { ok: true, ts: `1790000000.${String(++n).padStart(6, "0")}`, channel: CHANNEL } })],
    ["chat.delete", over["chat.delete"] ?? ((_u, init) => ({ body: { ok: true, ts: JSON.parse(String(init?.body)).ts, channel: CHANNEL } }))],
    ["files.getUploadURLExternal", () => ({ body: { ok: true, upload_url: "https://files.slack.com/upload/v1/abc", file_id: `F0PIC${++f}` } })],
    ["files.slack.com/upload", () => ({ status: 200, body: "OK" })],
    ["files.completeUploadExternal", () => ({ body: { ok: true, files: [{ id: `F0PIC${f}` }] } })],
    ["files.delete", over["files.delete"] ?? (() => ({ body: { ok: true } }))],
    ["conversations.history", () => ({ body: { ok: true, messages: [], has_more: false } })],
  ]);
}

/**
 * A seat whose service faces one native room to one Slack channel with pictures. Stopped, then
 * removed, in one hook.
 * @param {import('node:test').TestContext} t @param {{ slack?: ReturnType<typeof fakeSlack>, purgeDeadlineMs?: number }} [o]
 */
async function seat(t, o = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-faces-scrub-"));
  const slack = o.slack ?? fakeSlack();
  const options = { root, accountId: ACCOUNT, seatLabel: "seat-s",
    faces: { transportFor: async () => slackTransport({ transport: "slack", channel: CHANNEL }, { token: "xoxb-fake-test", fetch: slack.fetch, sleep: async () => {} }),
      warn: () => {}, ...(o.purgeDeadlineMs ? { purgeDeadlineMs: o.purgeDeadlineMs } : {}) } };
  let service = new NativeRoomService(options);
  /** @type {Array<{ close(): void }>} */
  const clients = [];
  t.after(async () => { for (const c of clients) c.close(); await service.stop(); await rm(root, { recursive: true, force: true }); });
  await service.start();
  await service.createRoom({ roomId: ROOM, epoch: EPOCH });
  await writeFacePolicy(root, ROOM, { faces: [{ transport: "slack", alias: "slackroom", target: { channel: CHANNEL }, post: { agent: ["always"] }, attachments: "pictures" }] });
  const config = path.join(root, "agora.json");
  await writeFile(config, JSON.stringify({ actor: GRACE, rooms: { house: { transport: "native", roomId: ROOM } } }), "utf8");
  /** @param {(r: Map<string, any>) => boolean} until */
  const records = async (until, ms = 5000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const r = await readFaceRecords(root, ROOM);
      if (until(r) || Date.now() > deadline) return r;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  return {
    root, slack, records, dir: path.join(root, "native", "rooms", ROOM),
    open: async () => { const c = await connect({ state: root, config }); clients.push(c); return c; },
    start: async () => { service = new NativeRoomService(options); await service.start(); },
    stop: () => service.stop(),
  };
}

/**
 * Every file under the room's directory (the operator's upgrade backup excluded) whose bytes hold
 * the needle, by path relative to the room.
 * @param {string} dir @param {string} needle
 */
async function filesHolding(dir, needle) {
  /** @type {string[]} */
  const hits = [];
  /** @param {string} at */
  const walk = async (at) => {
    for (const e of await readdir(at, { withFileTypes: true })) {
      const p = path.join(at, e.name);
      if (e.isDirectory()) { if (e.name !== "upgrade-v2-backup") await walk(p); continue; }
      if ((await readFile(p)).includes(Buffer.from(needle, "utf8"))) hits.push(path.relative(dir, p).replaceAll("\\", "/"));
    }
  };
  await walk(dir);
  return hits.sort();
}

/** The ids of the messages whose rows in the face record log carry a payload digest. @param {string} root */
async function digestCarriers(root) {
  const text = await readFile(path.join(root, "native", "rooms", ROOM, "faces.jsonl"), "utf8");
  return new Set(text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)).filter((l) => "payloadDigest" in l).map((l) => l.originId));
}

/** A picture whose face copy and upload are published. @param {any} s @param {any} app @param {string} name @param {string} text */
async function postPicture(s, app, name, text) {
  const ref = await app.upload("house", { bytes: Buffer.concat([PNG, randomBytes(8)]), name });
  const m = await app.append("house", { text, author: GRACE, attachments: [ref] });
  await s.records((/** @type {Map<string, any>} */ r) => [...r.values()].some((y) => y.originId === m.id && y.attachmentId && y.status === "published")
    && [...r.values()].some((y) => y.originId === m.id && !y.attachmentId && !y.part && y.status === "published"));
  return m;
}

test("a purge takes a pictures face's file names out of every file under the room, and keeps what its deletions read", { timeout: 60_000 }, async (t) => {
  const s = await seat(t);
  const app = await s.open();
  const name = `harbor-${randomUUID().slice(0, 8)}.png`;
  const keepName = `kept-${randomUUID().slice(0, 8)}.png`;
  const m = await postPicture(s, app, name, "the harbor at dusk");
  const kept = await postPicture(s, app, keepName, "a picture nobody purges");
  assert.deepEqual(await filesHolding(s.dir, name), ["faces.jsonl", "room.frames"], "before the purge the log and the face record log name the picture");
  const receipt = await app.purge("house", { targets: [m.id], reason: "asked to remove it", author: GRACE });
  assert.deepEqual(receipt.purged, [m.id]);
  assert.deepEqual(receipt.facesOutOfReach, [], "the text copy and the picture were deleted");
  // the deletions finish inside the receipt's wait; their mirror rows are written after the scrub
  const r = await s.records((x) => [...x.values()].filter((y) => y.mirror === receipt.id && y.status === "published").length === 2);
  assert.deepEqual(await filesHolding(s.dir, name), [], "no file under the room names the purged picture");
  assert.deepEqual(await filesHolding(s.dir, "the harbor at dusk"), [], "nor holds its text");
  assert.equal((await filesHolding(s.dir, keepName)).includes("faces.jsonl"), true, "a message nobody purged keeps its row as it was");
  // what the face needs stays: transport, file id, status, attachment id, and the mirror's act on each
  const picture = [...r.values()].find((y) => y.originId === m.id && y.part === "attachment");
  assert.equal(picture?.status, "published");
  assert.equal(picture?.fileId, "F0PIC1");
  assert.equal(typeof picture?.attachmentId, "string");
  assert.equal("name" in /** @type {any} */ (picture), false);
  const text = [...r.values()].find((y) => y.originId === m.id && !y.part);
  assert.equal(text?.id, "1790000000.000001");
  assert.equal(text?.cursor, m.cursor);
  assert.deepEqual([...r.values()].filter((y) => y.mirror === receipt.id).map((y) => [y.act, y.target]).sort(), [["purge", "1790000000.000001"], ["purge", "F0PIC1"]]);
  assert.deepEqual(s.slack.calls.filter((c) => c.url.href.includes("files.delete")).map((c) => JSON.parse(String(c.init?.body))), [{ file: "F0PIC1" }]);
  // the deletes settled, so no row of the purged message keeps the digest of its faced text
  const carriers = await digestCarriers(s.root);
  assert.equal(carriers.has(m.id), false, "the purged message's rows carry no payload digest");
  assert.equal(carriers.has(kept.id), true, "a message nobody purged keeps its digest");
  assert.deepEqual(await scrubFaceRecords(s.root, ROOM, [m.id]), { rewritten: [] }, "a second scrub has nothing to take");
});

test("after the scrub a purge's facesOutOfReach still names the copies it could not delete, and a later delete still lands", { timeout: 60_000 }, async (t) => {
  let refuse = true;
  const slack = fakeSlack({
    "chat.delete": (_u, init) => refuse ? { body: { ok: false, error: "cant_delete_message" } } : { body: { ok: true, ts: JSON.parse(String(init?.body)).ts, channel: CHANNEL } },
    "files.delete": () => refuse ? { body: { ok: false, error: "cant_delete_file" } } : { body: { ok: true } },
  });
  const s = await seat(t, { slack, purgeDeadlineMs: 2000 });
  const app = await s.open();
  const name = `refused-${randomUUID().slice(0, 8)}.png`;
  const m = await postPicture(s, app, name, "out of reach");
  const receipt = await app.purge("house", { targets: [m.id], reason: "remove", author: GRACE });
  const out = receipt.facesOutOfReach.map((/** @type {any} */ f) => [f.message, f.transport, f.channel, f.ts ?? null, f.file ?? null]).sort();
  assert.deepEqual(out, [[m.id, "slack", CHANNEL, "1790000000.000001", null], [m.id, "slack", CHANNEL, null, "F0PIC1"]].sort());
  assert.deepEqual(await filesHolding(s.dir, name), [], "the refused copies' rows hold no name either");
  assert.equal((await digestCarriers(s.root)).has(m.id), true, "a copy whose delete the face refused keeps its digest: a resent purge may still reach it");
  assert.deepEqual(await scrubFaceRecords(s.root, ROOM, [m.id]), { rewritten: [] }, "and a scrub run again leaves it");
  // a resend of the purge (the operation id again) deletes what the face now allows, off the scrubbed rows
  refuse = false;
  const again = await app.purge("house", { targets: [m.id], reason: "remove", author: GRACE, operationId: receipt.operationId });
  assert.equal(again.duplicate, true);
  assert.deepEqual(again.facesOutOfReach, [], "the resent purge reached both copies");
  const r = await s.records((x) => [...x.values()].filter((y) => y.mirror === receipt.id && y.status === "published").length === 2);
  assert.deepEqual([...r.values()].filter((y) => y.mirror === receipt.id && y.status === "published").map((y) => y.target).sort(), ["1790000000.000001", "F0PIC1"]);
  assert.deepEqual(await filesHolding(s.dir, name), []);
  // the deletion that settled it may finish after the receipt; the scrub follows it
  const deadline = Date.now() + 5000;
  while ((await digestCarriers(s.root)).has(m.id) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await digestCarriers(s.root)).has(m.id), false, "once the resent purge settled the delete, the digest is gone");
  assert.deepEqual(await scrubFaceRecords(s.root, ROOM, [m.id]), { rewritten: [] }, "and the scrub stays idempotent");
});

test("a crossing that came in from the face loses its file names, metadata lines and text digest when its message is purged", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-faces-scrub-in-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const name = `inbound-${randomUUID().slice(0, 8)}.pdf`;
  const purgedId = "a".repeat(64);
  const keptId = "b".repeat(64);
  const base = { kind: /** @type {const} */ ("ingested"), transport: "slack", channel: CHANNEL, thread: "1790000000.000001", at: "2026-10-01T00:00:00.000Z", author: { kind: /** @type {const} */ ("human"), name: "Ada", ref: "U0ADA" } };
  await appendInboundLine(root, ROOM, { ...base, ts: "1790000000.000002", id: purgedId, cursor: `${EPOCH}:2`, files: [{ name, copied: false, reason: "the transport offers no download for it" }],
    fileLines: [`file ${name} (application/pdf, 1234 bytes) not copied: the transport offers no download for it`], textDigest: "sha256:" + "c".repeat(64) });
  await appendInboundLine(root, ROOM, { ...base, ts: "1790000000.000003", id: keptId, cursor: `${EPOCH}:3`, files: [{ name: "kept.pdf", copied: true, attachmentId: "x".repeat(32) }], fileLines: [], textDigest: "sha256:" + "d".repeat(64) });
  await appendFaceRecord(root, ROOM, { originId: purgedId, transport: "slack", part: "attachment", attachmentId: "y".repeat(32), name, status: "refused", code: "capability", reason: "no", at: base.at });
  const first = await scrubFaceRecords(root, ROOM, [purgedId]);
  assert.deepEqual(first.rewritten.sort(), ["face-inbound.jsonl", "faces.jsonl"]);
  assert.deepEqual(await filesHolding(path.join(root, "native", "rooms", ROOM), name), []);
  const { crossed, ingested } = await readInbound(root, ROOM);
  const c = crossed.get(`slack\0${CHANNEL}\0` + "1790000000.000002");
  assert.equal(c?.id, purgedId, "the crossing keeps its ts, its native id and its author");
  assert.deepEqual(c?.fileLines, []);
  assert.equal(c?.textDigest, undefined);
  assert.deepEqual(ingested.get(`slack\0${CHANNEL}\0` + "1790000000.000002")?.files, [{ copied: false }]);
  assert.equal(crossed.get(`slack\0${CHANNEL}\0` + "1790000000.000003")?.textDigest, "sha256:" + "d".repeat(64), "a crossing nobody purged is untouched");
  assert.deepEqual(await scrubFaceRecords(root, ROOM, [purgedId]), { rewritten: [] }, "a second run has nothing to take and rewrites nothing");
});

/**
 * Run a scrub in a child process that kills itself (SIGKILL: no handler, no cleanup) at a stage.
 * @param {string} root @param {string[]} purged @param {'temp-written' | 'installed'} stage
 */
function killedScrub(root, purged, stage) {
  const script = `import { scrubFaceRecords } from ${JSON.stringify(SCRUB_URL)};
await scrubFaceRecords(${JSON.stringify(root)}, ${JSON.stringify(ROOM)}, ${JSON.stringify(purged)}, { hooks: { scrubStage: (s, file) => {
  if (s === ${JSON.stringify(stage)} && file.endsWith("faces.jsonl")) process.kill(process.pid, "SIGKILL");
} } });
console.log("not killed");`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", windowsHide: true, timeout: 60_000 });
  assert.equal(r.stdout.includes("not killed"), false, `the child reached the end: ${r.stdout}${r.stderr}`);
  assert.equal(r.status === 0, false, "the child was killed");
}

/**
 * A faced room whose picture was published, then purged by the store itself with the service down:
 * the state a purge leaves when it dies after the log's rewrite and before its face scrub.
 * @param {import('node:test').TestContext} t
 */
async function purgedBeforeScrub(t) {
  const s = await seat(t);
  const app = await s.open();
  const name = `crash-${randomUUID().slice(0, 8)}.png`;
  const m = await postPicture(s, app, name, "killed mid-scrub");
  await s.stop();
  const store = await NativeRoomStore.open({ root: s.root, roomId: ROOM });
  await store.append(/** @type {any} */ ({ kind: "purge", operationId: randomUUID().replaceAll("-", ""), authorName: "Ada", authorKind: "human", purge: { targets: [m.id], reason: "remove" } }), { accountId: ACCOUNT });
  await store.close();
  assert.deepEqual(await filesHolding(s.dir, name), ["faces.jsonl"], "the log is purged and the face records still name the picture");
  return { s, name, m };
}

test("a scrub killed after its temp copy is written leaves the room openable; opening the room finishes it", { timeout: 60_000 }, async (t) => {
  const { s, name, m } = await purgedBeforeScrub(t);
  killedScrub(s.root, [m.id], "temp-written");
  const temps = (await readdir(s.dir)).filter((f) => f.startsWith("faces.jsonl.tmp-"));
  assert.equal(temps.length, 1, "the kill left the temp copy behind");
  const store = await NativeRoomStore.open({ root: s.root, roomId: ROOM });
  await store.close();
  assert.equal((await readFaceRecords(s.root, ROOM)).size > 0, true, "the face records still read");
  // the service opens the room (a reader's read) and finishes the scrub there
  await s.start();
  const app = await s.open();
  await app.read("house", { limit: 10 });
  assert.deepEqual(await filesHolding(s.dir, name), [], "the open finished the scrub");
  assert.deepEqual((await readdir(s.dir)).filter((f) => f.startsWith("faces.jsonl.tmp-")), [], "and removed the temp copy");
});

test("a scrub killed after the outbound log is installed is finished when the room is next opened for a purge", { timeout: 60_000 }, async (t) => {
  const { s, name, m } = await purgedBeforeScrub(t);
  // a crossing for the purged message in the inbound log, which the killed scrub never reached
  await appendInboundLine(s.root, ROOM, { kind: "ingested", transport: "slack", channel: CHANNEL, ts: "1790000000.000099", thread: "", top: true, at: "2026-10-01T00:00:00.000Z",
    id: m.id, cursor: m.cursor, files: [{ name, copied: false, reason: "no" }], fileLines: [`image ${name} (image/png, 9 bytes)`], textDigest: "sha256:" + "e".repeat(64) });
  killedScrub(s.root, [m.id], "installed");
  assert.deepEqual(await filesHolding(s.dir, name), ["face-inbound.jsonl"], "the outbound log was scrubbed and the inbound one not yet");
  await s.start();
  const app = await s.open();
  const other = await app.append("house", { text: "another", author: GRACE });
  await app.purge("house", { targets: [other.id], reason: "remove", author: GRACE });
  assert.deepEqual(await filesHolding(s.dir, name), [], "the next purge finished the scrub");
});
