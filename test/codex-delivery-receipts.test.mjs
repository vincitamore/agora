// @ts-check
// The two receipts a queued bridge can honestly have, and the one it cannot.
//
// A bridge that hands work to a consumer through a queue observes exactly one thing on its own: the
// queue ACCEPTED the item. Whether the consumer took it is a fact about the consumer. So acceptance
// is a durable receipt and processing is not available here at all -- absence from the pending list
// proves removal, which is consumption OR an operator's hand, and those are indistinguishable from
// this side.
//
// These cells pin the honest contract for the legacy queue bridge (ruled at backroom 1788888796,
// option (b)): accepted / in-flight / absent, with the cursor never advancing on absence and an
// accepted-but-unacknowledged item recoverable and idempotent by message id. The processed witness
// belongs to the native path and is a different head.
//
// Both cells are written to FAIL against the bridge as it stands, because a repair whose defect was
// never seen red is a repair nobody can check.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
// Imported as a namespace ON PURPOSE. A named import of a function that does not exist yet fails
// the whole FILE to load, and a load error is not a discriminated defect: it reports "this file is
// broken" where a reader needs "this capability is missing". Each cell asserts the capability it
// needs, so the red names the gap instead of the import.
import * as codexModule from "../src/codex.mjs";

// Cast once: the two functions these cells require do not exist yet, and a type error is not the
// red we want -- the RUNTIME assertion below is, because it names the missing capability in the
// test output where a reader looks. tsc stays green so the gate measures the change, not the gap.
const codex = /** @type {any} */ (codexModule);

/** @param {import('node:test').TestContext} t */
async function stateRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), "codex-receipts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** A message the bridge would deliver. The id is the idempotence point, above the transport. */
const message = (/** @type {string} */ id, /** @type {string} */ cursor) =>
  /** @type {any} */ ({ id, cursor, room: "backroom", text: `body ${id}`,
    author: { name: "peer", kind: "agent" }, ts: "2026-09-08T00:00:00Z" });

test("accepted is durable BEFORE the caller is told, so a death between them leaves a record to reconcile rather than a blind replay", async (t) => {
  const root = await stateRoot(t);
  /** @type {string[]} */ const queued = [];
  /** The caller's checkpoint never runs: this is the death between acceptance and the cursor write. */
  await assert.rejects(
    codex.queueCodex("backroom", [message("m1", "1788888888.000100")], {
      root, thread: "t-1", bin: process.execPath,
      run: /** @type {any} */ (async (/** @type {string} */ _bin, /** @type {string[]} */ argv) => {
        queued.push(String(argv[argv.indexOf("--message") + 1])); return { stdout: "", stderr: "" }; }),
      onQueued: async () => { throw new Error("the consumer of this callback died"); },
    }),
    /the consumer of this callback died/,
    "the injected death must surface rather than being swallowed",
  );

  assert.equal(queued.length, 1, "the queue call itself happened, so acceptance is a fact");
  assert.equal(typeof codex.readCodexIntents, "function",
    "src/codex.mjs must expose readCodexIntents(root, thread): the durable accepted record is the "
    + "one receipt this bridge can honestly have, and nothing reads it today");
  const intents = await codex.readCodexIntents(root, "t-1");
  assert.deepEqual(intents.map((/** @type {any} */ i) => i.id), ["m1"],
    "the intent record must exist after acceptance even though the caller never checkpointed: "
    + "without it a re-arm replays blind, with no way to tell an in-flight item from an unsent one");
  assert.equal(intents[0].cursor, "1788888888.000100");
  assert.ok(intents[0].acceptedAt, "an intent carries when it was accepted, or a stale one cannot be aged");
  assert.equal(intents[0].processedAt ?? null, null, "acceptance must never be written as processing");
});

test("absence from the pending list is reported as absent-unresolved and advances NOTHING", async (t) => {
  const root = await stateRoot(t);
  const run = /** @type {any} */ (async () => ({ stdout: "", stderr: "" }));
  /** @type {string[]} */ const advanced = [];
  await codex.queueCodex("backroom", [message("still-there", "1788888888.000200"), message("vanished", "1788888888.000300")], {
    root, thread: "t-2", bin: process.execPath, run,
    onQueued: async (/** @type {any} */ d) => { advanced.push(d.cursor); },
  });

  // The queue now lists only the first. The second was accepted and is gone: consumed, or removed by
  // a hand that cleared a stale backlog. From here those are the same observation.
  assert.equal(typeof codex.reconcileCodexIntents, "function",
    "src/codex.mjs must expose reconcileCodexIntents({root, thread, list}): without it a re-arm "
    + "cannot tell an in-flight delivery from one that left the queue");
  const state = await codex.reconcileCodexIntents({
    root, thread: "t-2",
    list: async () => [{ id: "still-there" }],
  });

  assert.deepEqual(state.inFlight.map((/** @type {any} */ i) => i.id), ["still-there"],
    "an item the queue still lists has demonstrably not been consumed");
  assert.deepEqual(state.absent.map((/** @type {any} */ i) => i.id), ["vanished"],
    "an item the queue no longer lists is ABSENT, which is processed-or-removed");
  assert.deepEqual(state.processed, [],
    "nothing may be reported as processed on this bridge: no consumer witness exists here");
  assert.deepEqual(state.advanceTo, null,
    "absence must advance no cursor -- advancing on processed-or-removed is silent loss wearing "
    + "the clothes of a completion receipt");

  const onDisk = JSON.parse(await readFile(path.join(root, "codex", "t-2.intents.json"), "utf8"));
  assert.equal(onDisk.find((/** @type {any} */ i) => i.id === "vanished").resolution, "absent",
    "the unresolved item is RETAINED and surfaced, not dropped, so a human can tell it happened");
});
