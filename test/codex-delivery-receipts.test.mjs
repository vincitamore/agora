// @ts-check
// The two receipts a queued bridge can honestly have, and the one it cannot.
//
// A bridge that hands work to a consumer through a queue observes exactly one thing on its own: the
// queue ACCEPTED the item. Whether the consumer took it is a fact about the consumer. So acceptance
// is a durable receipt and processing is not available here at all -- absence from the pending list
// proves removal, which is consumption OR an operator's hand, and those are indistinguishable from
// this side.
//
// These cells pin the honest contract for the legacy queue bridge: accepted / in-flight / absent, with the cursor never advancing on absence and an
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
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  /** @type {any} */ ({ id, cursor, room: "room-one", text: `body ${id}`,
    author: { name: "peer", kind: "agent" }, ts: "2026-09-08T00:00:00Z" });

test("accepted is durable BEFORE the caller is told, so a death between them leaves a record to reconcile rather than a blind replay", async (t) => {
  const root = await stateRoot(t);
  /** @type {string[]} */ const queued = [];
  /** The caller's checkpoint never runs: this is the death between acceptance and the cursor write. */
  await assert.rejects(
    codex.queueCodex("room-one", [message("m1", "1788888888.000100")], {
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
  await codex.queueCodex("room-one", [message("still-there", "1788888888.000200"), message("vanished", "1788888888.000300")], {
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

// ---------------------------------------------------------------------------
// The advance is per ROOM, and the production path has to call this at all.
//
// One Codex thread receives deliveries from every room a seat watches, so one journal holds rows
// from several rooms. Cursors are opaque and ascending only WITHIN a room, so a completed row from
// room B carries no information about room A's position -- and handing B's cursor to A is not an
// approximation, it is a different room's coordinate.

test("the journal is keyed by the TRANSPORT's room identity; the CLI alias finds nothing", async (t) => {
  const root = await stateRoot(t);
  // A local room's messages carry the resolved file path, not the alias the user typed. Reconciling
  // by the alias selects no rows at all -- not a smaller answer, a silently empty one, which is how
  // a recovery that can never fire looked correct.
  const transportRoom = path.join(root, "cli-room.ndjson");
  const m = { ...message("only", "1788888888.001600"), room: transportRoom };
  await codex.recordCodexSubmitted(root, "t-ident", m);
  await codex.recordCodexAccepted(root, "t-ident", m, { turnId: "turn-only" });
  await codex.recordCodexReceipt(root, "t-ident", m, { id: "only", outcome: "completed" });

  const byAlias = await codex.reconcileCodexIntents({ root, thread: "t-ident", room: "cli-room" });
  assert.equal(byAlias.advanceTo, null, "the alias matches no row, so it can only produce an empty answer");
  assert.deepEqual(byAlias.processed, [],
    "and nothing is reported processed: an alias-keyed read of a transport-keyed journal is BLIND, "
    + "not partial, so a caller passing the alias sees a healthy empty record forever");

  const byTransport = await codex.reconcileCodexIntents({ root, thread: "t-ident", room: transportRoom });
  assert.equal(byTransport.advanceTo, "1788888888.001600",
    "the transport's identity is the key the writers used, and it finds the row");
});

test("the completed prefix is scoped to ONE room; a sibling room's cursor never crosses", async (t) => {
  const root = await stateRoot(t);
  const a1 = { ...message("a1", "1788888888.001100"), room: "room-a" };
  const b1 = { ...message("b1", "1788888888.001200"), room: "room-b" };
  await codex.recordCodexSubmitted(root, "t-rooms", a1);
  await codex.recordCodexAccepted(root, "t-rooms", a1, { turnId: "turn-a" });
  await codex.recordCodexReceipt(root, "t-rooms", b1, { id: "b1", outcome: "completed" });

  // room-a's only row is accepted and unfinished; room-b's is complete and much later.
  const a = await codex.reconcileCodexIntents({ root, thread: "t-rooms", room: "room-a" });
  assert.equal(a.advanceTo, null,
    "room-a has completed nothing, so it advances nothing -- room-b's later cursor is a coordinate "
    + "in a different room and carrying it here would retire room-a's unfinished delivery");
  assert.deepEqual(a.processed.map((/** @type {any} */ i) => i.id), [],
    "processed is scoped too: a sibling room's completion is not this room's");

  const b = await codex.reconcileCodexIntents({ root, thread: "t-rooms", room: "room-b" });
  assert.equal(b.advanceTo, "1788888888.001200", "room-b advances on its own completed row");
  assert.deepEqual(b.inFlight.map((/** @type {any} */ i) => i.id), [],
    "room-a's unfinished row is not room-b's in-flight work");
});

test("with no room named, the advance is REFUSED rather than computed across rooms", async (t) => {
  const root = await stateRoot(t);
  const a1 = { ...message("a1", "1788888888.001300"), room: "room-a" };
  const b1 = { ...message("b1", "1788888888.001400"), room: "room-b" };
  await codex.recordCodexReceipt(root, "t-noroom", a1, { id: "a1", outcome: "completed" });
  await codex.recordCodexReceipt(root, "t-noroom", b1, { id: "b1", outcome: "completed" });

  const state = await codex.reconcileCodexIntents({ root, thread: "t-noroom" });
  assert.equal(state.advanceTo, null,
    "an advance across rooms has no meaning, so it is not produced: returning the last completed "
    + "row here would hand one room a cursor minted in another, which is the failure this refusal exists to make impossible");
  assert.equal(state.processed.length, 2,
    "the rows are still readable without a room -- reporting is fine, it is the ADVANCE that is refused");
});

test("the production arm path reconciles the journal and says so, through the real command", async (t) => {
  const root = await stateRoot(t);
  // One row acknowledged with no outcome, through the shared helper so this cell inherits the stub
  // executable and the transport-keyed rows instead of an inline fixture that drifted from both.
  const { stderr } = await armWithJournal(root, [{ id: "armed-1", cursor: "1" }], undefined);
  assert.match(stderr, /1 accepted and unresolved/,
    "the arm must report what the journal holds for this room before it starts delivering. The word "
    + "is UNRESOLVED, not in-flight: no outcome was recorded, and on the legacy queue that row may "
    + "already have been consumed or cleared by hand, so calling it live would assert a delivery "
    + "from the absence of a record");
});

// ---------------------------------------------------------------------------
// Reporting the completed prefix is not reconciling it.
//
// The window this record exists to close is: the consumer's completion is written, and the caller
// dies before checkpointing the cursor. On the next arm the journal knows the work finished and the
// cursor still points at it, so the delivery replays. A report that prints the recovered position
// and leaves the cursor where it was closes nothing.

/** Arm the real CLI once against a local room whose journal is prepared. Returns what a user sees. */
async function armWithJournal(/** @type {string} */ root, /** @type {any[]} */ marks, /** @type {string|undefined} */ savedCursor) {
  const roomFile = path.join(root, "cli-room.ndjson");
  await writeFile(roomFile, "", "utf8");
  await writeFile(path.join(root, "agora.json"), JSON.stringify({
    actor: { name: "Tester/one", kind: "agent" },
    rooms: { "cli-room": { transport: "local", path: roomFile } },
  }), "utf8");
  for (const mark of marks) {
    // The TRANSPORT's room identity, exactly as the product records it: a local room's messages
    // carry the resolved file path. Writing the CLI alias here is what let a recovery that can
    // never fire pass every cell in this file.
    const m = { id: mark.id, cursor: mark.cursor, room: roomFile, text: "x",
      author: { name: "peer", kind: "agent" }, ts: "2026-09-08T00:00:00Z" };
    await codex.recordCodexSubmitted(root, "tarm-00000001", m);
    await codex.recordCodexAccepted(root, "tarm-00000001", m, { turnId: `turn-${mark.id}` });
    if (mark.outcome) await codex.recordCodexReceipt(root, "tarm-00000001", m, { id: mark.id, outcome: mark.outcome });
  }
  const cli = new URL("../bin/agora.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  // A stub this test creates. Inheriting a Codex binary from PATH is what made these cells green
  // here and red on both CI legs: a spawn resolved from the ambient environment tests the machine.
  const stub = path.join(root, process.platform === "win32" ? "codex-stub.cmd" : "codex-stub.sh");
  await writeFile(stub, process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const env = { ...process.env, AGORA_STATE: root, AGORA_CONFIG: path.join(root, "agora.json"),
    AGORA_SESSION: "armtest", AGORA_CODEX_BIN: stub };
  if (savedCursor !== undefined)
    await execFile(process.execPath, [cli, "cursor", "cli-room", "--set", savedCursor], { env });
  let stderr = "";
  try { await execFile(process.execPath, [cli, "watch", "cli-room", "--once", "--codex-queue",
    "--codex-thread", "tarm-00000001"], { env }); }
  catch (error) { stderr = String(/** @type {any} */ (error)?.stderr ?? ""); }
  let cursor = null;
  // The cursor file is a record ({cursor, at}), not a bare string: read the field, or the assertion
  // compares a position against a whole document and reds while the product is correct.
  try { cursor = JSON.parse(await readFile(path.join(root, "sessions", "armtest", "cli-room.cursor"), "utf8")).cursor; }
  catch { cursor = null; }
  // The arm's EFFECTIVE since, as recorded at watch start. Recovering the file and leaving this at
  // the old value would re-offer the row the recovery skipped, so it is the observable that matters.
  let armed = null;
  try { armed = JSON.parse(await readFile(path.join(root, "sessions", "armtest", "armed", "cli-room.json"), "utf8")); }
  catch { armed = null; }
  return { stderr, cursor, armed };
}

test("the arm RECOVERS the cursor through the completed prefix, closing the accept-before-checkpoint window", async (t) => {
  const root = await stateRoot(t);
  // "1" and "2" completed; the caller died before checkpointing "2". "3" is acknowledged only.
  const { cursor } = await armWithJournal(root, [
    { id: "one", cursor: "1", outcome: "completed" },
    { id: "two", cursor: "2", outcome: "completed" },
    { id: "three", cursor: "3" },
  ], "1");
  assert.equal(cursor, "2",
    "the saved position must move to the end of the contiguous completed run: the consumer reported "
    + "delivery 2 finished and the cursor never caught up, so without this the next poll redelivers "
    + "work that is already done -- which is the whole reason the record is kept");
});

// NOT ASSERTED HERE, and named so a reader does not mistake its absence for coverage: that the
// recovered position becomes this arm's effective `since` for the subscription. The liveness guard
// ends a bridged watch before the subscription and before the armed record is even written, so the
// observable does not exist without a live consumer thread. A seam could therefore record the right
// position and hand the transport the wrong one and every cell here would stay green. Measured by a
// follow-on unit that holds a real writer lock from a helper process.

test("recovery STOPS at the gap: a completion after a failure never carries the cursor over it", async (t) => {
  const root = await stateRoot(t);
  const { cursor } = await armWithJournal(root, [
    { id: "one", cursor: "1", outcome: "completed" },
    { id: "two", cursor: "2", outcome: "completed" },
    { id: "three", cursor: "3", outcome: "failed" },
    { id: "four", cursor: "4", outcome: "completed" },
  ], "1");
  assert.equal(cursor, "2",
    "delivery 4 completed, but 3 did not: advancing to 4 would retire 3 with a receipt saying it "
    + "succeeded, and 3 is exactly the message a person still needs to see");
});

test("an unlocatable saved cursor is REFUSED, not guessed: no rewind, no skip", async (t) => {
  const root = await stateRoot(t);
  const { stderr, cursor } = await armWithJournal(root, [
    { id: "one", cursor: "1", outcome: "completed" },
    { id: "two", cursor: "2", outcome: "completed" },
  ], "99");
  assert.equal(cursor, "99",
    "a saved position that does not appear in the journal cannot be placed relative to it, and "
    + "cursors are opaque so nothing may compare them -- moving it would be a guess that either "
    + "rewinds into a replay or skips unread messages");
  assert.match(stderr, /is not in this thread's journal/,
    "and the refusal is VISIBLE: a silent no-op leaves a reader believing recovery happened");
});

test("two INDEPENDENT writer processes on one thread lose no mark", async (t) => {
  const root = await stateRoot(t);
  const moduleURL = new URL("../src/codex.mjs", import.meta.url).href;
  // A seat commonly arms two rooms as separate watch PROCESSES against one thread and one state
  // root. Two processes are the honest test: an in-process race can be argued
  // away as an artifact of one event loop, and the failure this guards against is a lost acceptance,
  // which is the one thing the record exists to make impossible.
  const writer = (/** @type {string} */ tag) => execFile(process.execPath, ["--input-type=module", "-e", `
    const { recordCodexSubmitted } = await import(${JSON.stringify(moduleURL)});
    for (let i = 0; i < 25; i++)
      await recordCodexSubmitted(${JSON.stringify(root)}, "t-race", {
        id: ${JSON.stringify(tag)} + "-" + i, cursor: "1788888888.0100" + String(i).padStart(2, "0"),
        room: "room-one",
      });
  `]);
  await Promise.all([writer("room-one"), writer("room-two")]);

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

  const state = await codex.reconcileCodexIntents({ root, thread: "t-6", room: "room-one", list: async () => [] });
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
  const state = await codex.reconcileCodexIntents({ root, thread: "t-4", room: "room-one", list: async () => [] });

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
