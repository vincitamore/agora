// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { cursorKey, fragilePath, jitter, parseSignature, readCursor, redact, roomInterval, roomThreadInterval, sign, validateConfig, writeCursor } from "../src/core.mjs";
import { actor, tmp } from "./helpers.mjs";

test("validateConfig accepts a minimal config", () => {
  validateConfig({ actor, rooms: { a: { transport: "local", path: "x.ndjson" } } }, "t");
});

test("validateConfig refuses an inline token", () => {
  assert.throws(
    () => validateConfig({ actor, rooms: { s: { transport: "slack", channel: "C1", token: "xoxb-1" } } }, "t"),
    /inline; use tokenEnv/,
  );
});

test("validateConfig requires actor and rooms", () => {
  assert.throws(() => validateConfig({ rooms: {} }, "t"), /actor.name/);
  assert.throws(() => validateConfig({ actor: { name: "x", kind: "robot" }, rooms: {} }, "t"), /actor.kind/);
  assert.throws(() => validateConfig({ actor, rooms: {} }, "t"), /at least one room/);
  assert.throws(() => validateConfig({ actor, rooms: { a: {} } }, "t"), /needs a transport/);
});

test("sign appends one signature line and never doubles it", () => {
  const once = sign("hello\n", actor);
  assert.equal(once, "hello\n\n-- Claude (house)");
  assert.equal(sign(once, actor), once);
  assert.equal(parseSignature(once), "Claude (house)");
  assert.equal(parseSignature("— peer"), undefined, "a lone signature line is not a signed message");
  assert.equal(parseSignature("text\n— peer"), "peer");
  assert.equal(parseSignature("text\nnot signed"), undefined);
});

test("redact strips credential shapes", () => {
  assert.equal(redact("token xoxb-123-abc here"), "token [redacted] here");
  assert.equal(redact("ghp_abcdefghijklmnopqrstuvwxyz0123"), "[redacted]");
  assert.equal(redact("Authorization: Bearer abc.def-ghi"), "Authorization: Bearer [redacted]");
  assert.equal(redact("plain"), "plain");
});

test("cursor round trip and key sanitising", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const key = cursorKey("down load/x", "171.5");
    assert.equal(key, "down_load_x#171.5");
    assert.equal(await readCursor(dir, key), undefined);
    await writeCursor(dir, key, "42");
    assert.equal(await readCursor(dir, key), "42");
    await writeCursor(dir, key, undefined);
    assert.equal(await readCursor(dir, key), undefined);
  } finally {
    await cleanup();
  }
});

test("a room's poll interval: the flag, then the room, then what the transport is for", () => {
  const slack = { transport: "slack", channel: "C1" };
  const issue = { transport: "github", repo: "a/b", issue: 3 };
  assert.equal(roomInterval(slack), 15, "a chat is read at chat latency");
  assert.equal(roomInterval(issue), 300, "a record is not");
  assert.equal(roomInterval({ ...issue, interval: 60 }), 60, "the room says so");
  assert.equal(roomInterval(issue, 30), 30, "the flag says so");
  assert.equal(roomInterval({ ...issue, interval: 0 }), 300, "a value that is not a positive number is not a value");
  assert.equal(roomThreadInterval(slack), 60);
  assert.equal(roomThreadInterval({ ...slack, threadInterval: 120 }), 120);
  assert.equal(roomThreadInterval(slack, 15), 15);
});

test("jitter spreads a wait by a tenth either way", () => {
  assert.equal(jitter(1000, () => 0.5), 1000);
  assert.equal(jitter(1000, () => 0), 900);
  assert.equal(jitter(1000, () => 1), 1100);
  for (let i = 0; i < 200; i++) {
    const ms = jitter(15000);
    assert.ok(ms >= 13500 && ms <= 16500, `${ms}`);
  }
});

test("a room path that loses lines is named by what is wrong with it", () => {
  assert.equal(fragilePath("/mnt/c/agora/room.ndjson"), "a filesystem translation layer");
  assert.equal(fragilePath("C:/Users/a/OneDrive/room.ndjson"), "a syncing folder (OneDrive)");
  assert.equal(fragilePath("/home/a/Google Drive/room.ndjson"), "a syncing folder (Google Drive)");
  assert.equal(fragilePath("/home/a/rooms/room.ndjson"), undefined);
  assert.equal(fragilePath("C:/Users/a/Documents/room.ndjson"), undefined);
});
