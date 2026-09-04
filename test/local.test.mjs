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

test("local room without a cursor returns the newest messages up to the limit; with one, the oldest after it", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const t = localTransport({ transport: "local", path: path.join(dir, "room.ndjson") }, { actor });
    for (let i = 1; i <= 9; i++) await t.post(`m${i}`);
    // the invariant every transport holds (slack.test.mjs, github.test.mjs, github-events.test.mjs
    // assert the same one): taking the OLDEST of the window is what set `cursor --now` hundreds of
    // messages back on a busy room, and told `who` that a bearer who just spoke was silent
    assert.deepEqual((await t.read({ limit: 3 })).map((m) => m.text), ["m7", "m8", "m9"], "the newest three, ascending");
    assert.deepEqual((await t.read({ limit: 3 })).map((m) => m.cursor), ["7", "8", "9"], "and their cursors are the real positions");
    assert.deepEqual((await t.read({ since: "2", limit: 3 })).map((m) => m.text), ["m3", "m4", "m5"], "with a cursor the window starts where the reader left off");
    assert.equal((await t.read()).length, 9);
  } finally {
    await cleanup();
  }
});

test("local room: the transport says which cursor shapes it can read", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const t = localTransport({ transport: "local", path: path.join(dir, "room.ndjson") }, { actor });
    assert.equal(t.validateCursor?.("4"), undefined);
    assert.equal(t.validateCursor?.("0"), undefined);
    assert.match(String(t.validateCursor?.("garbage")), /non-negative whole number/);
    assert.match(String(t.validateCursor?.("-1")), /non-negative whole number/);
    assert.match(String(t.validateCursor?.("1.5")), /non-negative whole number/);
  } finally {
    await cleanup();
  }
});
