// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpawnRequest, SpawnRequestError } from "../src/spawn/request.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));

/** @param {string} name */
async function loadFixture(name) {
  const raw = JSON.parse(await readFile(path.join(dir, "fixtures", "spawn", name), "utf8"));
  /** @type {Record<string, unknown>} */
  const body = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!k.startsWith("$")) body[k] = v;
  }
  return { raw, body };
}

test("spawn-request.json is the whole of what a caller may say", async () => {
  const { body } = await loadFixture("spawn-request.json");
  const req = parseSpawnRequest(body);
  assert.equal(req.operationId, body.operationId);
  assert.equal(req.harness, "claude");
  assert.equal(req.targetSeat, null);
  assert.equal(req.parentRecord, null);
});

test("red-unknown-request-key: unknown keys exit 1 request-field-unknown and mint nothing", async () => {
  const { raw, body } = await loadFixture("red-unknown-request-key.json");
  const expected = raw.$expected;
  assert.throws(
    () => parseSpawnRequest(body),
    (err) => {
      assert.ok(err instanceof SpawnRequestError);
      assert.equal(err.exitCode, expected.exitCode);
      assert.equal(err.reason, expected.reason);
      assert.deepEqual(err.namesEachKey, expected.namesEachKey);
      assert.equal(err.recordMinted, false);
      assert.equal(err.slotReserved, false);
      assert.equal(err.briefWritten, false);
      return true;
    },
  );
});

test("an unknown key is never ignored: dropping the throw would mint a record", async () => {
  const body = {
    operationId: "x", harness: "grok", model: "g", role: "forge", unit: "u",
    room: "house", answersTo: "a", cwd: ".", briefDigest: "sha256:0",
    depth: 0,
  };
  assert.throws(() => parseSpawnRequest(body), (err) => {
    assert.ok(err instanceof SpawnRequestError);
    assert.equal(err.reason, "request-field-unknown");
    assert.deepEqual(err.namesEachKey, ["depth"]);
    return true;
  });
});
