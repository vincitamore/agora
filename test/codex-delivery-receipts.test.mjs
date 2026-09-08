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
// accepted-but-unacknowledged item recoverable and idempotent by message id.
//
// The second half of the file pins the PROCESSED witness, which the native server path can honestly
// have and the queue path cannot. Both contracts live here because they are one question asked of
// two transports: what does this bridge actually know about the consumer?
//
// Both cells are written to FAIL against the bridge as it stands, because a repair whose defect was
// never seen red is a repair nobody can check.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
const execFile = promisify(execFileCb);
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

  // Read through the projection, which is what the record's readers see: the journal on disk is a
  // line per mark, and reconstructing a row from it by hand in a test would assert the storage
  // rather than the contract.
  const onDisk = await codex.readCodexIntents(root, "t-2");
  assert.equal(onDisk.find((/** @type {any} */ i) => i.id === "vanished").resolution, "absent",
    "the unresolved item is RETAINED and surfaced, not dropped, so a human can tell it happened");
  const journal = await readFile(path.join(root, "codex", "t-2.intents.jsonl"), "utf8");
  assert.ok(journal.trimEnd().split("\n").every((line) => JSON.parse(line).id),
    "every line of the journal stands alone: that is what lets two processes append without a read");
});

// ---------------------------------------------------------------------------
// The SECOND receipt: the one the native server path can honestly have.
//
// deliverCodexServer has been emitting it all along -- onProcessed({id, outcome}) fires once per
// message for EVERY terminal outcome, while onAccepted fires only when that outcome is "completed".
// The emitter is whole; the consumer is what is missing. These cells pin the consumer half.
//
// The receipt carries an id and an outcome and no cursor, which is why the row is written from the
// message the call site already holds: an advance computed from the receipt alone is not computable
// at all.

test("two INDEPENDENT writer processes on one thread lose no mark", async (t) => {
  const root = await stateRoot(t);
  const moduleURL = new URL("../src/codex.mjs", import.meta.url).href;
  // The launcher's normal shape arms backroom and agora as separate watch PROCESSES against one
  // thread and one state root. Two processes are the honest test: an in-process race can be argued
  // away as an artifact of one event loop, and the failure this guards against is a lost acceptance,
  // which is the one thing the record exists to make impossible.
  const writer = (/** @type {string} */ tag) => execFile(process.execPath, ["--input-type=module", "-e", `
    const { recordCodexSubmitted } = await import(${JSON.stringify(moduleURL)});
    for (let i = 0; i < 25; i++)
      await recordCodexSubmitted(${JSON.stringify(root)}, "t-race", {
        id: ${JSON.stringify(tag)} + "-" + i, cursor: "1788888888.0100" + String(i).padStart(2, "0"),
        room: "backroom",
      });
  `]);
  await Promise.all([writer("backroom"), writer("agora")]);

  const rows = await codex.readCodexIntents(root, "t-race");
  const ids = new Set(rows.map((/** @type {any} */ r) => r.id));
  assert.equal(ids.size, 50,
    `both writers' marks must survive: a read-modify-write of one whole file lets each process read `
    + `the same N rows, append its own, and overwrite the other's -- and the mark it drops is an `
    + `ACCEPTANCE, so the record silently reports a delivery that was never attempted. Saw ${ids.size}`);
  for (const row of rows)
    assert.ok(row.intentAt, `${row.id} kept its mark rather than a half-projected row`);
});

test("the three marks are three different facts, written in order and never standing in for each other", async (t) => {
  const root = await stateRoot(t);
  assert.equal(typeof codex.recordCodexSubmitted, "function",
    "src/codex.mjs must expose recordCodexSubmitted(root, thread, message): without a row written "
    + "BEFORE the send, a turn that runs to the thirty-minute timeout leaves no durable record at "
    + "all while it runs, which is the hole the first receipt exists to close");
  assert.equal(typeof codex.recordCodexAccepted, "function",
    "src/codex.mjs must expose recordCodexAccepted(root, thread, message, {turnId}): turn/start's "
    + "acknowledgment is a fact distinct from both the intent and the outcome");

  const m = message("ordered", "1788888888.000900");
  await codex.recordCodexSubmitted(root, "t-5", m);
  const afterIntent = (await codex.readCodexIntents(root, "t-5"))[0];
  assert.ok(afterIntent.intentAt, "the pre-send mark is an INTENT: we handed it over, nothing acknowledged it");
  assert.equal(afterIntent.acceptedAt ?? null, null,
    "intent must not be written as acceptance: at this instant the server has said nothing at all");
  assert.equal(afterIntent.processedAt ?? null, null, "and certainly not as processing");

  await codex.recordCodexAccepted(root, "t-5", m, { turnId: "turn-abc" });
  const afterAccept = (await codex.readCodexIntents(root, "t-5"))[0];
  assert.ok(afterAccept.acceptedAt, "turn/start returned an id: the server has the work");
  assert.equal(afterAccept.intentAt, afterIntent.intentAt, "the earlier mark is preserved, not overwritten");
  assert.equal(afterAccept.turnId, "turn-abc", "the row carries the turn it was accepted as");
  assert.equal(afterAccept.processedAt ?? null, null,
    "accepted is NOT processed -- this is the whole state the two-read exhibit needs to observe, and "
    + "a record that cannot show it cannot tell a running turn from a finished one");

  await codex.recordCodexReceipt(root, "t-5", m, { id: "ordered", outcome: "completed" });
  const afterTerminal = (await codex.readCodexIntents(root, "t-5"))[0];
  assert.ok(afterTerminal.processedAt, "the consumer finished: the third mark, and only now");
  assert.ok(afterTerminal.acceptedAt && afterTerminal.intentAt, "all three marks survive; none replaces another");
});

test("a turn that fails before acceptance leaves the intent unacknowledged, never an acceptance", async (t) => {
  const root = await stateRoot(t);
  const m = message("never-started", "1788888888.001000");
  await codex.recordCodexSubmitted(root, "t-6", m);
  // turn/start never returned an id: the delivery threw before any acknowledgment existed.
  const row = (await codex.readCodexIntents(root, "t-6"))[0];
  assert.ok(row.intentAt, "the intent is retained: something was attempted and a reader must see it");
  assert.equal(row.acceptedAt ?? null, null,
    "no acknowledgment ever arrived, so no acceptance may be written; an intent that silently became "
    + "an acceptance would report the server holding work it never received");
  assert.equal(row.processedAt ?? null, null, "and nothing was processed");

  const state = await codex.reconcileCodexIntents({ root, thread: "t-6", list: async () => [] });
  assert.equal(state.advanceTo, null, "an unacknowledged intent advances no cursor");
});

test("a processed witness is durable, and ONLY completed marks a delivery processed", async (t) => {
  const root = await stateRoot(t);
  assert.equal(typeof codex.recordCodexReceipt, "function",
    "src/codex.mjs must expose recordCodexReceipt(root, thread, message, receipt): the landed "
    + "emitter has been calling onProcessed with this receipt and nothing writes it down");

  const finished = message("finished", "1788888888.000400");
  const interrupted = message("interrupted", "1788888888.000500");
  await codex.recordCodexReceipt(root, "t-3", finished, { id: "finished", outcome: "completed" });
  await codex.recordCodexReceipt(root, "t-3", interrupted, { id: "interrupted", outcome: "cancelled" });

  const rows = await codex.readCodexIntents(root, "t-3");
  const byId = Object.fromEntries(rows.map((/** @type {any} */ r) => [r.id, r]));

  assert.equal(byId.finished.outcome, "completed");
  assert.ok(byId.finished.processedAt,
    "a completed turn is the consumer's own word about its own work: that, and only that, is processing");
  assert.equal(byId.finished.cursor, "1788888888.000400",
    "the row carries the cursor because the receipt does not; without it no advance is computable");

  assert.equal(byId.interrupted.outcome, "cancelled",
    "a non-completed outcome is RECORDED and kept distinct, not discarded as noise");
  assert.equal(byId.interrupted.processedAt ?? null, null,
    "an interrupted turn reached the consumer and did not finish the work; writing processedAt here "
    + "would launder an interruption into a completion, which is the exact error the second receipt exists to prevent");
});

test("advanceTo is the longest COMPLETED PREFIX, so one failure stops the advance instead of being stepped over", async (t) => {
  const root = await stateRoot(t);
  const first = message("first", "1788888888.000600");
  const second = message("second", "1788888888.000700");
  const third = message("third", "1788888888.000800");
  await codex.recordCodexReceipt(root, "t-4", first, { id: "first", outcome: "completed" });
  await codex.recordCodexReceipt(root, "t-4", second, { id: "second", outcome: "failed" });
  await codex.recordCodexReceipt(root, "t-4", third, { id: "third", outcome: "completed" });

  // Nothing is left in the queue: every turn reached a terminal state.
  const state = await codex.reconcileCodexIntents({ root, thread: "t-4", list: async () => [] });

  assert.deepEqual(state.processed.map((/** @type {any} */ i) => i.id), ["first", "third"],
    "both completed turns are processed facts, and staying honest about the third is what makes the "
    + "advance rule below a real constraint rather than a side effect of forgetting it");
  assert.equal(state.advanceTo, "1788888888.000600",
    "the advance stops at the last CONTIGUOUS completion: the third succeeded, but checkpointing past "
    + "the second would retire a cursor whose middle delivery failed, and that message is then lost "
    + "with a receipt saying otherwise");
  assert.deepEqual(state.absent.map((/** @type {any} */ i) => i.id), [],
    "a row with a witnessed outcome is never 'absent': absence is what this bridge says when it does "
    + "NOT know what happened, and here the consumer said so itself");
});
