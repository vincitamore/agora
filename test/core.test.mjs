// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { cursorKey, parseSignature, readCursor, redact, sign, validateConfig, writeCursor } from "../src/core.mjs";
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
