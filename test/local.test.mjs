// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { localTransport } from "../src/transports/local.mjs";
import { actor, tmp } from "./helpers.mjs";

test("local room: post, read, since, thread filter", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const t = localTransport({ transport: "local", path: path.join(dir, "room.ndjson") }, { actor });
    assert.deepEqual(await t.read(), []);
    const a = await t.post("first");
    const b = await t.post("reply", { thread: a.id });
    const c = await t.post("second\n\n-- bone");
    assert.equal(a.cursor, "1");
    assert.equal(c.cursor, "3");

    const all = await t.read();
    assert.deepEqual(all.map((m) => m.text), ["first", "reply", "second\n\n-- bone"]);
    assert.deepEqual(all.map((m) => m.cursor), ["1", "2", "3"]);
    assert.equal(all[2].signedAs, "bone");
    assert.equal(all[0].author.name, "Claude (house)");

    const after = await t.read({ since: b.cursor });
    assert.deepEqual(after.map((m) => m.id), [c.id]);

    const inThread = await t.read({ thread: a.id });
    assert.deepEqual(inThread.map((m) => m.text), ["reply"]);
    assert.equal((await t.whoami()).name, actor.name);
  } finally {
    await cleanup();
  }
});
