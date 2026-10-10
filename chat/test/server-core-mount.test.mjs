// @ts-check
// The mount seam: the kit answers only under /chat/ and hands every other path back to the host,
// and it starts (and closes) with no seat service at all: a dark room is reached again on use.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CHAT_ROUTES, CHAT_VERSION, createChat } from "../server/index.mjs";
import { AGORA_DIR } from "./seat-service.mjs";

/** @type {import("../server/index.mjs").ChatHooks} */
const hooks = {
  identify: async () => null,
  authorize: () => true,
  people: async () => [],
  scanText: () => ({}),
  scanUpload: async () => ({ ok: true }),
  notifyText: () => ({ title: "", body: "" }),
  presence: async () => ({ state: "dark" }),
  residentName: "the resident",
};

test("a path outside /chat/ is the host's, and a dark seat is no reason not to start", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-chat-mount-"));
  /** @type {string[]} */
  const logs = [];
  const chat = await createChat({
    agoraDir: AGORA_DIR, agoraState: path.join(root, "no-state"), room: "main", clientName: "example-app",
    storeDir: path.join(root, "kit"), hooks, push: null, log: (line) => logs.push(line),
  });
  t.after(async () => {
    await chat.close();
    await rm(root, { recursive: true, force: true });
  });
  assert.equal(await chat.handle(new Request("http://localhost/api/health"), null), null);
  assert.equal(await chat.handle(new Request("http://localhost/chatter"), null), null);
  assert.equal(chat.version, CHAT_VERSION);
  assert.ok(CHAT_ROUTES.every((r) => /^(GET|POST|PUT|DELETE) \/chat\//.test(r)));
  // nobody: 401, before anything else is looked at
  const nobody = await chat.handle(new Request("http://localhost/chat/state"), null);
  assert.equal(nobody?.status, 401);
  // a person, and the room dark
  const me = { id: "p-1", name: "Someone" };
  const posted = await chat.handle(new Request("http://localhost/chat/post", { method: "POST", body: JSON.stringify({ text: "anyone there?" }) }), me);
  assert.equal(posted?.status, 503);
  assert.equal((await posted?.json()).error.code, "ROOM_DARK");
  const state = await chat.handle(new Request("http://localhost/chat/state"), me);
  assert.equal(state?.status, 200);
  assert.equal((await state?.json()).data.link.state, "dark");
});

test("createChat refuses options it cannot run on", async () => {
  await assert.rejects(() => createChat(/** @type {any} */ (null)), TypeError);
  await assert.rejects(() => createChat(/** @type {any} */ ({ agoraDir: AGORA_DIR, room: "main", clientName: "example-app", storeDir: "x", hooks: { ...hooks, people: undefined }, push: null })), /people/);
});
