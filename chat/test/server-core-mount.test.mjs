// @ts-check
// The mount seam: the kit answers only under /chat/ and hands every other path back to the host.
import test from "node:test";
import assert from "node:assert/strict";
import { CHAT_ROUTES, CHAT_VERSION, createChat } from "../server/index.mjs";

/** @type {import("../server/index.mjs").ChatHooks} */
const hooks = {
  identify: async () => null,
  authorize: () => false,
  people: async () => [],
  scanText: () => ({}),
  scanUpload: async () => ({ ok: true }),
  notifyText: () => ({ title: "", body: "" }),
  presence: async () => ({ state: "dark" }),
  residentName: "the resident",
};

test("a path outside /chat/ is the host's", async () => {
  const chat = await createChat({ agoraDir: ".", room: "main", clientName: "example-app", storeDir: ".", hooks, push: null });
  try {
    assert.equal(await chat.handle(new Request("http://localhost/api/health"), null), null);
    assert.equal(await chat.handle(new Request("http://localhost/chatter"), null), null);
    assert.equal(chat.version, CHAT_VERSION);
    assert.ok(CHAT_ROUTES.every((r) => /^(GET|POST|PUT|DELETE) \/chat\//.test(r)));
  } finally {
    await chat.close();
  }
});
