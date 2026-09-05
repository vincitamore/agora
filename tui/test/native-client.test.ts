/**
 * NativeRoomClient against the real seat service (`NativeRoomService`, in this process) and
 * against the fake for what the real one cannot be made to do on command: a coverage block, a
 * withheld ack, a dropped link. The properties, each with the assertion that fails when it is
 * broken: the hello runs through the descriptor; the human's post lands `kind: human` under the
 * seat's account with a receipt that answers the operation; "read to" is the coverage's
 * `toInclusive`, never the last message and never a count; the subscription delivers events and
 * ends as dark when the channel goes; a refusal on a live socket is a refusal; acceptance unknown
 * is retried under the same operation id; `search` and `roster` are seams the service refuses;
 * no token and no nonce ever crosses the wire in a request or reaches a rendered field.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NativeRoomService, NativeServiceClient } from "../../src/native-service.mjs";
import { redact } from "../../src/core.mjs";
import { NativeRoomClient } from "../lib/native-client";
import { roomsFromConfig } from "../lib/local-client";
import { SeatRoomClient } from "../lib/seat-client";
import { PostFaultError, RoomFaultError, SeamUnservedError, type Message, type RoomFault } from "../lib/room-client";
import { composeRefusal, preparePost } from "../lib/compose-guard";
import { startFakeService, type FakeService } from "./fake-service";
import { TOKEN_SHAPE } from "./fixtures";

const ROOM = "6".repeat(32);
const EPOCH = "7".repeat(32);
const ACCOUNT = "seat_account_0002";
const ALEX = { name: "Alex", kind: "human" as const };
const NATIVE_VIEW = (stateRoot: string) => ({ stateRoot, rooms: [], native: [{ alias: "house", transport: "native" as const, room: ROOM, roomId: ROOM }], elsewhere: [] });

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function realService() {
  const root = await mkdtemp(path.join(tmpdir(), "agora-tui-native-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const service = new NativeRoomService({ root, accountId: ACCOUNT, seatLabel: "seat-a" });
  const descriptor = await service.start();
  await service.createRoom({ roomId: ROOM, epoch: EPOCH });
  cleanups.push(() => service.stop());
  const peer = await NativeServiceClient.connect(descriptor as Parameters<typeof NativeServiceClient.connect>[0]);
  cleanups.push(() => peer.close());
  const post = async (name: string, text: string) => peer.request("append", { roomId: ROOM, operation: { operationId: crypto.randomUUID().replaceAll("-", ""), authorName: name, text } });
  return { root, service, descriptor, peer, post };
}

async function fake(opts: { coverageAhead?: number; holdAppend?: boolean; refuse?: string[] } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-tui-fake-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const service: FakeService = await startFakeService({ root, roomId: ROOM, epoch: EPOCH, ...opts });
  cleanups.push(() => service.stop());
  return { root, service };
}

const untilTrue = async (pred: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("NativeRoomClient against the real seat service", () => {
  test("hello through the descriptor, the human's post lands kind human under the seat account with a receipt that answers the operation, and read to is the checkpoint", async () => {
    const { root, descriptor, post } = await realService();
    const client = new NativeRoomClient(ALEX, NATIVE_VIEW(root), { waitMs: 50 });
    cleanups.push(() => client.close());
    expect(await client.rooms()).toEqual([{ alias: "house", transport: "native", room: ROOM, roomId: ROOM, note: undefined }]);

    await post("Cal/codex", "first, from a peer\n\nto: Alex\n\n-- Cal/codex");
    const before = await client.read("house");
    expect(before.messages.map((m) => m.text.split("\n")[0])).toEqual(["first, from a peer"]);
    expect(before.horizon.source).toBe("seat service seat-a");
    // read to: the checkpoint's position, a cursor
    expect(before.horizon.readTo).toBe(`${EPOCH}:1`);
    expect(before.horizon.oldestCursor).toBe(`${EPOCH}:1`);

    const draft = "hello from the human\n";
    expect(composeRefusal(draft, ALEX)).toBeUndefined();
    const r = await client.post("house", preparePost(draft, ALEX));
    expect(r.cursor).toBe(`${EPOCH}:2`);
    expect(r.duplicate).toBe(false);
    expect(r.id).toMatch(/^[a-f0-9]{64}$/);
    expect(r.operationId).toMatch(/^[a-f0-9]{32}$/);

    const after = await client.read("house");
    const mine = after.messages[1]!;
    // the service stamps the author: the seat's account as id, the human's name and kind
    expect(mine.author).toEqual({ id: descriptor.accountId, name: "Alex", kind: "human" });
    expect(mine.signedAs).toBe("Alex");
    expect(mine.text).toBe("hello from the human\n\n-- Alex");
    expect(mine.id).toBe(r.id);
    expect(after.horizon.readTo).toBe(`${EPOCH}:2`);

    // a second, identical draft after a sent one is a new operation: it lands again, not deduplicated
    const r2 = await client.post("house", preparePost(draft, ALEX));
    expect(r2.cursor).toBe(`${EPOCH}:3`);
    expect(r2.operationId).not.toBe(r.operationId);
    expect(r2.duplicate).toBe(false);
  }, 30_000);

  test("subscribe delivers events after read to, and the service stopping is dark: on the subscription, on the next read, on the next post", async () => {
    const { root, service, post } = await realService();
    const client = new NativeRoomClient(ALEX, NATIVE_VIEW(root), { waitMs: 50 });
    cleanups.push(() => client.close());
    await post("Cal/codex", "one");
    const first = await client.read("house");
    const got: Message[] = [];
    let fault: RoomFault | undefined;
    const sub = await client.subscribe("house", first.horizon.readTo!, { onMessages: (m) => got.push(...m), onFault: (f) => (fault = f) });
    cleanups.push(() => sub.close());
    await post("Cal/codex", "two");
    await post("Cal/codex", "three");
    await untilTrue(() => got.length >= 2);
    expect(got.map((m) => [m.text, m.cursor])).toEqual([["two", `${EPOCH}:2`], ["three", `${EPOCH}:3`]]);
    expect(got[0]!.author).toEqual({ id: ACCOUNT, name: "Cal/codex", kind: "agent" });
    expect(fault).toBeUndefined();

    await service.stop();
    await untilTrue(() => fault !== undefined);
    expect(fault!.kind).toBe("dark");
    expect(fault!.reason).toContain("closed the connection");

    // the request socket is gone too: a read is dark, a post is dark with nothing posted
    let readFault: unknown;
    await client.read("house").catch((e) => (readFault = e));
    expect(readFault).toBeInstanceOf(RoomFaultError);
    expect((readFault as RoomFaultError).kind).toBe("dark");
    let postFault: unknown;
    await client.post("house", "late\n\n-- Alex").catch((e) => (postFault = e));
    expect(postFault).toBeInstanceOf(PostFaultError);
    expect((postFault as PostFaultError).outcome).toBe("dark");
    expect((postFault as PostFaultError).reason).toContain("nothing was posted and no cursor was issued");
  }, 30_000);

  test("a refused cursor on a live socket is refused, not dark, and the socket stays usable", async () => {
    const { root, post } = await realService();
    const client = new NativeRoomClient(ALEX, NATIVE_VIEW(root), { waitMs: 50 });
    cleanups.push(() => client.close());
    await post("Cal/codex", "one");
    const foreign = `${"8".repeat(32)}:0`;
    let e: unknown;
    await client.read("house", { since: foreign }).catch((x) => (e = x));
    expect(e).toBeInstanceOf(RoomFaultError);
    expect((e as RoomFaultError).kind).toBe("refused");
    expect((e as RoomFaultError).reason).toContain("epoch");
    // still live: the next read answers
    expect((await client.read("house")).messages).toHaveLength(1);
    let s: unknown;
    await client.subscribe("house", foreign, { onMessages: () => undefined, onFault: () => undefined }).catch((x) => (s = x));
    expect(s).toBeInstanceOf(RoomFaultError);
    expect((s as RoomFaultError).kind).toBe("refused");
  }, 30_000);

  test("search and roster are seams: the service's own refusal, never a pretended answer; and the nonce is refused in a draft without being echoed", async () => {
    const { root, descriptor, post } = await realService();
    const client = new NativeRoomClient(ALEX, NATIVE_VIEW(root), { waitMs: 50 });
    cleanups.push(() => client.close());
    await post("Cal/codex", "searchable");
    let e: unknown;
    await client.search("house", "search").catch((x) => (e = x));
    expect(e).toBeInstanceOf(SeamUnservedError);
    expect((e as SeamUnservedError).request).toBe("search");
    expect((e as SeamUnservedError).message).toContain("does not serve search yet");
    let r: unknown;
    await client.roster().catch((x) => (r = x));
    expect(r).toBeInstanceOf(SeamUnservedError);
    expect((r as SeamUnservedError).request).toBe("roster");

    const refusal = client.draftRefusal(`pasting the descriptor ${descriptor.nonce} by mistake`);
    expect(refusal).toContain("seat service nonce");
    expect(refusal).not.toContain(descriptor.nonce);
    expect(client.draftRefusal("a clean line")).toBeUndefined();
    const read = await client.read("house");
    expect(JSON.stringify(read)).not.toContain(descriptor.nonce);
  }, 30_000);
});

describe("NativeRoomClient against the fake for what the real one cannot do on command", () => {
  test("read to is the coverage's toInclusive, past the last message when coverage says so, and committedThrough rides along", async () => {
    const { root, service } = await fake({ coverageAhead: 2 });
    service.seed({ name: "Cal/codex", kind: "agent" }, "one");
    service.seed({ name: "Cal/codex", kind: "agent" }, "two");
    const client = new NativeRoomClient(ALEX, NATIVE_VIEW(root), { waitMs: 50 });
    cleanups.push(() => client.close());
    const r = await client.read("house");
    expect(r.messages.map((m) => m.cursor)).toEqual([`${EPOCH}:1`, `${EPOCH}:2`]);
    // coverage says the read is complete through :4 (two board-only events after the last message)
    expect(r.horizon.readTo).toBe(`${EPOCH}:4`);
    expect(r.horizon.readTo).not.toBe(r.messages[r.messages.length - 1]!.cursor);
    expect(r.horizon.committedThrough).toBe(`${EPOCH}:4`);
    expect(r.horizon.readTo).not.toMatch(/^\d+$/);
  }, 15_000);

  test("acceptance unknown is retried under the same operation id, and an identical resend reuses it until one ack arrives", async () => {
    const { root, service } = await fake({ holdAppend: true });
    const client = new NativeRoomClient(ALEX, NATIVE_VIEW(root), { waitMs: 50 });
    cleanups.push(() => client.close());
    const text = "did this land?\n\n-- Alex";
    const pending = client.post("house", text);
    let fault: unknown;
    pending.catch((e) => (fault = e));
    // the first append is on the wire and held; drop the link: acceptance unknown, one retry on a fresh socket
    await untilTrue(() => service.frames.filter((f) => f.type === "append").length === 1);
    service.dropSockets();
    await untilTrue(() => service.frames.filter((f) => f.type === "append").length === 2);
    service.dropSockets();
    await untilTrue(() => fault !== undefined);
    expect(fault).toBeInstanceOf(PostFaultError);
    const pf = fault as PostFaultError;
    expect(pf.outcome).toBe("unknown-acceptance");
    const operationId = pf.operationId!;
    expect(operationId).toMatch(/^[a-f0-9]{32}$/);
    const appends = service.frames.filter((f) => f.type === "append").map((f) => (f.operation as { operationId: string }).operationId);
    expect(appends).toEqual([operationId, operationId]);
    // the host had committed it once; the message exists exactly once
    expect(service.messages.map((m) => m.text)).toEqual([text]);

    // the ack is released; an identical resend reuses the retained operation id and gets the original receipt
    service.setHoldAppend(false);
    const r = await client.post("house", text);
    expect(r.operationId).toBe(pf.operationId);
    expect(r.duplicate).toBe(true);
    expect(r.cursor).toBe(`${EPOCH}:1`);
    expect(service.messages).toHaveLength(1);
    // and after a sent, the same words again are a new operation
    const r2 = await client.post("house", text);
    expect(r2.operationId).not.toBe(pf.operationId);
    expect(r2.duplicate).toBe(false);
    expect(service.messages).toHaveLength(2);
  }, 20_000);

  test("a receipt that does not answer the operation is refused: the id must derive from the room, the seat account and this operation", async () => {
    const { root, service } = await fake();
    service.setForgeReceipt(true);
    const client = new NativeRoomClient(ALEX, NATIVE_VIEW(root), { waitMs: 50 });
    cleanups.push(() => client.close());
    await client.read("house");
    let e: unknown;
    await client.post("house", "x\n\n-- Alex").catch((x) => (e = x));
    expect(e).toBeInstanceOf(PostFaultError);
    expect((e as PostFaultError).outcome).toBe("refused");
    expect((e as PostFaultError).reason).toContain("does not answer this operation");
    // the forged receipt never became a sent: the same words go again as a new operation and land
    service.setForgeReceipt(false);
    const r = await client.post("house", "x\n\n-- Alex");
    expect(r.duplicate).toBe(false);
    expect(r.cursor).toBe(`${EPOCH}:2`);
  }, 15_000);

  test("no token and no nonce crosses the wire in any request, and the config's token fields are never read", async () => {
    const { root, service } = await fake();
    service.seed({ name: "Cal/codex", kind: "agent" }, `a shape in a body: ${TOKEN_SHAPE}`);
    const configPath = path.join(root, "agora.json");
    const config = {
      actor: { name: "SeatBot", kind: "agent" },
      state: root,
      rooms: {
        house: { transport: "native", roomId: ROOM },
        slack: { transport: "slack", channel: "C0TEST", tokenEnv: "AGORA_TUI_TEST_TOKEN" },
        broken: { transport: "native", roomId: "not-a-room-id" },
        scratch: { transport: "local", path: path.join(root, "scratch.ndjson") },
      },
    };
    await writeFile(configPath, JSON.stringify(config), "utf8");
    process.env.AGORA_TUI_TEST_TOKEN = TOKEN_SHAPE;
    cleanups.push(() => {
      delete process.env.AGORA_TUI_TEST_TOKEN;
    });
    const view = await roomsFromConfig(configPath);
    expect(view.native.map((r) => r.alias)).toEqual(["house"]);
    expect(view.rooms.map((r) => r.alias)).toEqual(["scratch"]);
    expect(view.elsewhere.map((r) => r.alias).sort()).toEqual(["broken", "slack"]);
    expect(JSON.stringify(view)).not.toContain("tokenEnv");
    expect(JSON.stringify(view)).not.toContain("SeatBot");

    const client = new SeatRoomClient(ALEX, view, { native: { waitMs: 50 } });
    cleanups.push(() => client.close());
    expect(client.clientFor("house").kind).toBe("native");
    expect(client.clientFor("scratch").kind).toBe("local");
    const r = await client.read("house");
    expect(r.messages).toHaveLength(1);
    expect(r.horizon.source).toBe("seat service fake-seat");
    await client.post("house", "from the human\n\n-- Alex");
    await client.search("house", "shape").catch(() => undefined);
    const sub = await client.subscribe("house", r.horizon.readTo!, { onMessages: () => undefined, onFault: () => undefined });
    cleanups.push(() => sub?.close());
    expect(await client.subscribe("scratch", "0", { onMessages: () => undefined, onFault: () => undefined })).toBeUndefined();
    expect(await client.search("scratch", "x")).toBeUndefined();

    const wire = JSON.stringify(service.frames);
    expect(service.frames.map((f) => f.type)).toEqual(["read", "append", "search", "subscribe"]);
    expect(wire).not.toContain(TOKEN_SHAPE);
    expect(wire).not.toContain(service.nonce);
    expect(wire).not.toContain("SeatBot");
    expect(redact(wire)).toBe(wire);
    // the hellos carry proofs (hex HMACs), never the nonce itself
    expect(JSON.stringify(service.hellos)).not.toContain(service.nonce);
    const append = service.frames.find((f) => f.type === "append")!.operation as Record<string, unknown>;
    expect(append.authorKind).toBe("human");
    expect(append.authorName).toBe("Alex");
    expect(Object.keys(append).sort()).toEqual(["authorKind", "authorName", "operationId", "text"]);
    // the shared config is unchanged
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(config);
  }, 15_000);
});
