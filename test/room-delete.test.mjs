// @ts-check
// `agora service room delete`: a native room leaves the running service and its stored log,
// custody and face records are deleted; the copies its faces published stay where they are and
// are listed. Refused by name: a room the shared config still names, a room with a live member
// route or a live subscriber (unless --force), a --confirm that is not the exact room id, and a
// room the seat does not hold. Slack calls go to an injected fetch; no test reads a token.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { NativeRoomService, NativeServiceClient } from "../src/native-service.mjs";
import { memberMayRequest } from "../src/native-member.mjs";
import { readServiceDescriptor } from "../src/wake/subscriber.mjs";
import { appendFaceRecord, faceCopies, readFaceRecords, writeFacePolicy } from "../src/faces.mjs";
import { facedRooms } from "../src/native-faces-wiring.mjs";
import { slackTransport } from "../src/transports/slack.mjs";
import { fakeFetch } from "./helpers.mjs";

const ROOM = "6".repeat(32);
const OTHER = "7".repeat(32);
const EPOCH = "8".repeat(32);
const ACCOUNT = "seat_account_0006";
const CHANNEL = "C0DELETE1";
const op = () => randomUUID().replaceAll("-", "");
const exists = (/** @type {string} */ p) => stat(p).then(() => true, () => false);

/** @param {import('node:test').TestContext} t */
async function seat(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-room-delete-"));
  let n = 0;
  const slack = fakeFetch([
    ["auth.test", () => ({ body: { ok: true, user_id: "UBOT", user: "seatbot", bot_id: "BBOT" } })],
    ["chat.postMessage", () => ({ body: { ok: true, ts: `1790000100.${String(++n).padStart(6, "0")}`, channel: CHANNEL } })],
    ["conversations.history", () => ({ body: { ok: true, messages: [], has_more: false } })],
  ]);
  const service = new NativeRoomService({ root, accountId: ACCOUNT, seatLabel: "seat-d",
    faces: { transportFor: async () => slackTransport({ transport: "slack", channel: CHANNEL }, { token: "xoxb-fake-test", fetch: slack.fetch, sleep: async () => {} }), warn: () => {} } });
  /** @type {Array<{ close(): void }>} */
  const clients = [];
  t.after(async () => { for (const c of clients) c.close(); await service.stop(); await rm(root, { recursive: true, force: true }); });
  await service.start();
  await service.createRoom({ roomId: ROOM, epoch: EPOCH });
  await writeFacePolicy(root, ROOM, { faces: [{ transport: "slack", alias: "slackroom", target: { channel: CHANNEL }, post: { agent: ["always"] } }] });
  const raw = async () => { const c = await NativeServiceClient.connect(/** @type {any} */ (await readServiceDescriptor(root))); clients.push(c); return c; };
  return { root, service, slack, raw, dir: path.join(root, "native", "rooms", ROOM) };
}

/** @param {() => Promise<boolean>} until */
async function waitFor(until, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!(await until())) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("a deleted room leaves the service and its log, custody and face records go; its faced copy is listed, not deleted", { timeout: 60_000 }, async (t) => {
  const s = await seat(t);
  const c = await s.raw();
  const ack = /** @type {any} */ (await c.request("append", { roomId: ROOM, operation: { operationId: op(), authorName: "Ada/build", authorKind: "agent", text: "faced" } }));
  await waitFor(async () => (await readFaceRecords(s.root, ROOM)).get(`${ack.id}\0slack\0`)?.status === "published");
  const copies = await faceCopies(s.root, ROOM);
  assert.deepEqual(copies, [{ transport: "slack", where: CHANNEL, status: "published", message: ack.id, cursor: ack.cursor, id: "1790000100.000001" }]);
  assert.ok(await exists(path.join(s.dir, "room.frames")));
  const result = /** @type {any} */ (await c.request("delete-room", { roomId: ROOM }));
  assert.deepEqual([result.roomId, result.deleted, result.routesClosed, result.subscribersClosed], [ROOM, true, 0, 0]);
  assert.equal(await exists(s.dir), false, "the room directory (log, custody, face records) is gone");
  assert.deepEqual(await facedRooms(s.root), [], "the restart sweep no longer finds the room");
  await assert.rejects(c.request("read", { roomId: ROOM, since: `${EPOCH}:0` }), /no valid manifest/);
  assert.equal(s.slack.calls.filter((x) => x.url.href.includes("chat.delete")).length, 0, "the faced copy was not touched");
  // a room id may be minted again after its deletion
  await c.request("create-room", { roomId: ROOM });
});

test("a room with a live subscriber is refused room-in-use; --force closes the subscriber and deletes", { timeout: 60_000 }, async (t) => {
  const s = await seat(t);
  const watcher = await s.raw();
  await watcher.subscribe(ROOM, `${EPOCH}:0`, () => {});
  const asker = await s.raw();
  await assert.rejects(asker.request("delete-room", { roomId: ROOM }), (e) => /** @type {any} */ (e).code === "room-in-use" && /1 live subscriber/.test(String(e)));
  assert.ok(await exists(s.dir), "nothing was deleted");
  const result = /** @type {any} */ (await asker.request("delete-room", { roomId: ROOM, force: true }));
  assert.equal(result.subscribersClosed, 1);
  assert.equal(await exists(s.dir), false);
  await assert.rejects(watcher.request("status", {}), "the subscriber's connection was closed");
});

test("a room with a live member route is refused room-in-use; --force tears the route down and deletes", { timeout: 60_000 }, async (t) => {
  const s = await seat(t);
  let stopped = 0;
  const binding = { roomId: ROOM, grantId: "g".repeat(32).replace(/g/g, "a"), routeGeneration: 1, accountId: "m-" + "b".repeat(32), allowedKeyDigest: "sha256:" + "c".repeat(64) };
  /** @type {any} */ (s.service.routes).set(`${ROOM}:${binding.allowedKeyDigest}`, { binding, resource: { stop: async () => { stopped++; } },
    descriptor: { endpoint: "x" }, descriptorPath: path.join(s.root, "no-such-descriptor.json"), secretPath: "", state: "live", openedAt: new Date().toISOString(), activation: { active: true } });
  const c = await s.raw();
  await assert.rejects(c.request("delete-room", { roomId: ROOM }), (e) => /** @type {any} */ (e).code === "room-in-use" && /1 live member route/.test(String(e)));
  assert.ok(await exists(s.dir));
  assert.equal(stopped, 0);
  const result = /** @type {any} */ (await c.request("delete-room", { roomId: ROOM, force: true }));
  assert.equal(result.routesClosed, 1);
  assert.equal(stopped, 1);
  assert.equal(s.service.listRoutes().length, 0);
  assert.equal(await exists(s.dir), false);
});

test("a room this seat does not hold is refused room-unknown, and a member session may not ask for a deletion", { timeout: 60_000 }, async (t) => {
  const s = await seat(t);
  const c = await s.raw();
  await assert.rejects(c.request("delete-room", { roomId: OTHER }), (e) => /** @type {any} */ (e).code === "room-unknown");
  assert.equal(memberMayRequest("delete-room"), false);
});

// ---------------------------------------------------------------------------------------------
// The CLI verb, over a real service it starts
// ---------------------------------------------------------------------------------------------

const run = promisify(execFile);
const BIN = new URL("../bin/agora.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const CLEARED = ["CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_PID", "GROK_SESSION_ID", "GROK_PID", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "HERMES_SESSION_ID", "AGORA_SESSION_PID", "AGORA_SESSION", "AGORA_ACTOR", "AGORA_CONFIG", "AGORA_STATE"];

/** @param {string[]} args @param {Record<string, string>} env */
async function agora(args, env) {
  try {
    const clean = { ...process.env };
    for (const name of CLEARED) delete clean[name];
    const child = run(process.execPath, [BIN, ...args], { env: { ...clean, ...env }, windowsHide: true });
    child.child.stdin?.end();
    const { stdout, stderr } = await child;
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = /** @type {any} */ (e);
    return { code: err.code, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

test("agora service room delete: refuses a room the config names, a missing or wrong --confirm, then deletes and lists the copies it leaves", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-room-delete-cli-"));
  const cfg = path.join(root, "agora.json");
  const env = { AGORA_STATE: root, AGORA_CONFIG: cfg, AGORA_SESSION: "deleter" };
  // stop first, then remove the root, in one hook
  t.after(async () => { await agora(["service", "stop"], env); await rm(root, { recursive: true, force: true }); });
  const desk = { transport: "local", path: path.join(root, "desk.ndjson") };
  await writeFile(cfg, JSON.stringify({ actor: { name: "seat", kind: "agent" }, rooms: { desk } }));
  assert.equal((await agora(["service", "start"], env)).code, 0);
  const created = await agora(["service", "room", "create"], env);
  assert.equal(created.code, 0, created.stderr);
  const roomId = created.stdout.trim();
  const dir = path.join(root, "native", "rooms", roomId);
  // the room's face records name one published copy (as `agora room faces` and a post would leave them)
  await writeFacePolicy(root, roomId, { faces: [{ transport: "slack", alias: "slackroom", target: { channel: CHANNEL } }] });
  const origin = "d".repeat(64);
  await appendFaceRecord(root, roomId, { originId: origin, cursor: `${EPOCH}:1`, transport: "slack", status: "published", id: "1790000200.000100", attempt: 1, at: new Date().toISOString() });

  // the config still names the room: refused by alias and by id, nothing deleted
  await writeFile(cfg, JSON.stringify({ actor: { name: "seat", kind: "agent" }, rooms: { desk, house: { transport: "native", roomId } } }));
  for (const target of ["house", roomId]) {
    const named = await agora(["service", "room", "delete", target, "--confirm", roomId], env);
    assert.equal(named.code, 1, named.stderr);
    assert.match(named.stderr, /room-in-config: the shared config still names native room .* \(rooms\.house\)/);
  }
  assert.ok(await exists(dir));
  // the operator removes the row by hand; the tool never wrote it
  await writeFile(cfg, JSON.stringify({ actor: { name: "seat", kind: "agent" }, rooms: { desk } }));

  const missing = await agora(["service", "room", "delete", roomId], env);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /confirm-required/);
  assert.match(missing.stderr, /slack C0DELETE1 1790000200\.000100 published/, "the refusal lists the copies the operator may purge first");
  const wrong = await agora(["service", "room", "delete", roomId, "--confirm", roomId.slice(0, 31) + (roomId.endsWith("0") ? "1" : "0")], env);
  assert.equal(wrong.code, 2);
  assert.match(wrong.stderr, /confirm-mismatch: --confirm must be the exact room id/);
  assert.ok(await exists(dir), "no refusal deleted anything");

  const done = await agora(["service", "room", "delete", roomId, "--confirm", roomId, "--json"], env);
  assert.equal(done.code, 0, done.stderr);
  const line = JSON.parse(done.stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
  assert.equal(line.action, "room-delete");
  assert.equal(line.deleted, true);
  assert.deepEqual(line.facesNotDeleted.map((/** @type {any} */ c) => [c.transport, c.where, c.id]), [["slack", CHANNEL, "1790000200.000100"]]);
  assert.match(line.note, /does not delete its faced copies/);
  assert.equal(await exists(dir), false);

  // the text form says so too; a second deletion of the same id is room-unknown
  const again = await agora(["service", "room", "delete", roomId, "--confirm", roomId], env);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /room-unknown/);
  const other = await agora(["service", "room", "create"], env);
  const otherId = other.stdout.trim();
  const text = await agora(["service", "room", "delete", otherId, "--confirm", otherId], env);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, new RegExp(`deleted native room ${otherId}: its log, custody and face records are gone`));
  assert.match(text.stdout, /does not delete its faced copies; its face records name none/);
});
