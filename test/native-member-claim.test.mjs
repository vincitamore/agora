// L12: the exclusive ownership claim over one enrolled node key.
//
// The claim is the whole of what makes a second Tailcat child on one key impossible, so every cell
// here asserts a NAMED refusal, and the two that matter most are the ones a plausible-looking
// implementation passes anyway: a claim taken AFTER the spawn, and a claim trusted by presence.
// Neither is testable from this file alone — the first is the contest cell's, the second is the
// stale-detection cells below, which is why pid-gone and boot-epoch-moved are separate cells.
//
// The ruled scheme (brief r12 seam 7) is a DIRECTORY of numbered generations, and its four
// contracts each have a cell here, because each is a way the whole thing silently stops working:
//
//   1. the same next name        — every taker of one record races for ONE name, so O_EXCL selects
//   2. spawn after the LISTING   — a create is not a win; a higher generation means you lost
//   3. a durable floor           — release marks, never empties, so no number is ever reissued
//   4. remove only your own      — except the holder pruning strictly below itself
//
// Contracts 2, 3 and 4 are exercised through `attemptClaimGeneration` directly, because a taker
// that DECIDED on a record the world has since moved past is exactly a call with a stale
// generation and nothing else about it is special. That is the real code path, not a hook.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  attemptClaimGeneration, canonicalStateRoot, claimAlive, clearClaimChildren, enrolledKeyDigest,
  keyClaimDir, keyClaimFile, liveClaimChildren, readKeyClaim, recordClaimChildren,
  releaseKeyClaim, scanClaimDir, takeKeyClaim,
} from "../src/native-member-claim.mjs";
import { publicNodeKeyDigest } from "../src/protocol/route.mjs";
import { bootEpoch } from "../src/session.mjs";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

/** A state root that is cleaned up with the test. */
/** @param {import('node:test').TestContext} t */
async function stateRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-claim-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** The refusal code, which is what every caller branches on. */
const codeOf = (/** @type {any} */ error) => /** @type {{ code?: string }} */ (error)?.code;

/** The claim directory for a root, created. @param {string} root @param {string} [digest] */
async function claimDir(root, digest = DIGEST_A) {
  const dir = keyClaimDir(await canonicalStateRoot(root), digest);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** A record as a taker would write it. `pid` defaults to a pid that answers nothing.
 * @param {number} generation @param {Partial<import("../src/native-member-claim.mjs").KeyClaimRecord>} [extra] */
function record(generation, extra = {}) {
  return /** @type {import('../src/native-member-claim.mjs').KeyClaimRecord} */ ({
    keyDigest: DIGEST_A, pid: 999_999_999, bootEpoch: bootEpoch(), kind: "resident",
    generation, startedAt: new Date().toISOString(), ...extra,
  });
}

/** Write one generation's claim file by hand, as a crashed or paused taker leaves it.
 * @param {string} dir @param {number} generation @param {Partial<import("../src/native-member-claim.mjs").KeyClaimRecord>} [extra] */
async function plant(dir, generation, extra = {}) {
  await writeFile(keyClaimFile(dir, generation), `${JSON.stringify(record(generation, extra))}\n`, "utf8");
}

/** Every generation file present, by name, sorted — the whole surface, never one key of it.
 * @param {string} dir */
const filesIn = async (dir) => (await readdir(dir)).sort();

test("a second acquire on one key is refused by name, and the refusal is actionable", async (t) => {
  const root = await stateRoot(t);
  const held = await takeKeyClaim({ stateRoot: root, keyDigest: DIGEST_A, kind: "resident", label: "house-remote" });
  assert.equal(held.generation, 1);

  await assert.rejects(
    () => takeKeyClaim({ stateRoot: root, keyDigest: DIGEST_A, kind: "gate", label: "direct-path gate" }),
    (/** @type {any} */ error) => {
      assert.equal(codeOf(error), "member-key-claim-held");
      // A refusal that does not name the holder sends the operator to `ps`. The facts that make it
      // actionable are the kind, the pid, the generation and the label.
      assert.match(error.message, /resident/);
      assert.match(error.message, new RegExp(`pid ${process.pid}\\b`));
      assert.match(error.message, /generation 1\b/);
      assert.match(error.message, /house-remote/);
      return true;
    },
  );

  assert.equal(await held.release(), true);
  // Only once the holder has released does the next acquire succeed: the claim is the gate itself.
  const next = await takeKeyClaim({ stateRoot: root, keyDigest: DIGEST_A, kind: "gate" });
  assert.equal(next.generation, 2, "the floor is durable across release, so 1 is never reissued");
  await next.release();
});

test("the claim is keyed by the key, not the alias: two aliases on one key contend", async (t) => {
  const root = await stateRoot(t);
  const first = await takeKeyClaim({ stateRoot: root, keyDigest: DIGEST_A, kind: "resident", label: "house-remote" });
  await assert.rejects(
    () => takeKeyClaim({ stateRoot: root, keyDigest: DIGEST_A, kind: "resident", label: "other-room" }),
    (/** @type {any} */ error) => codeOf(error) === "member-key-claim-held",
  );
  await first.release();
});

test("two different keys do not contend", async (t) => {
  const root = await stateRoot(t);
  const a = await takeKeyClaim({ stateRoot: root, keyDigest: DIGEST_A, kind: "resident" });
  const b = await takeKeyClaim({ stateRoot: root, keyDigest: DIGEST_B, kind: "resident" });
  assert.notEqual(a.dir, b.dir);
  await a.release();
  await b.release();
});

// --- contract 1: every taker of one record races for ONE name --------------------------------

test("two takers that read the same record compute the same generation, and O_EXCL admits one", async (t) => {
  const root = await stateRoot(t);
  const dir = await claimDir(root);
  await plant(dir, 1);                       // one stale generation: the world both takers read

  const scanA = await scanClaimDir(dir);
  const scanB = await scanClaimDir(dir);
  assert.equal(scanA.holder, undefined);
  assert.equal(scanB.holder, undefined);
  // THE PROPERTY. A unique token per taker would give two names and two winners; the floor+1 rule
  // gives one name, which is what turns the create into a compare-and-swap.
  assert.equal(scanA.floor + 1, scanB.floor + 1);

  const first = await attemptClaimGeneration(dir, scanA.floor + 1, record(2, { pid: process.pid }));
  const second = await attemptClaimGeneration(dir, scanB.floor + 1, record(2, { pid: process.pid }));
  assert.equal(first.outcome, "held");
  assert.equal(second.outcome, "taken", "the second create of one name must not succeed");
});

test("a claim whose process is gone is re-taken above it; a live one is not", async (t) => {
  const root = await stateRoot(t);
  const dir = await claimDir(root);
  await plant(dir, 1);                       // pid 999_999_999: proven dead

  const taken = await takeKeyClaim({ stateRoot: root, keyDigest: DIGEST_A, kind: "resident" });
  assert.equal(taken.generation, 2, "a stale generation is passed, never overwritten");
  const onDisk = JSON.parse(await readFile(taken.path, "utf8"));
  assert.equal(onDisk.pid, process.pid);
  // Contract 4's permitted removal: the holder prunes strictly below its own, so the dead 1 goes
  // and its own 2 is now the floor.
  assert.deepEqual(await filesIn(dir), ["2.claim"]);
  await taken.release();
});

test("a claim from a previous boot is stale even though its pid answers", async (t) => {
  const root = await stateRoot(t);
  const dir = await claimDir(root);
  // This process's own pid, so a pid probe alone says LIVE. Only the boot epoch separates them,
  // and without it a reboot that reused the pid fences every later start out forever.
  const previousBoot = record(1, { pid: process.pid, bootEpoch: bootEpoch() - 100_000 });
  await writeFile(keyClaimFile(dir, 1), `${JSON.stringify(previousBoot)}\n`, "utf8");
  assert.equal(claimAlive(previousBoot), false);

  const taken = await takeKeyClaim({ stateRoot: root, keyDigest: DIGEST_A, kind: "resident" });
  assert.equal(taken.generation, 2);
  await taken.release();
});

// --- contract 2: the spawn follows the LISTING, not the create --------------------------------

test("a create that lands after a higher generation exists LOSES, and removes only its own file", async (t) => {
  const root = await stateRoot(t);
  const dir = await claimDir(root);
  await plant(dir, 1);

  // A is a taker that read generation 1 as stale and computed 2 — then paused. Meanwhile B took 3
  // (a faster contender that had already reclaimed past 2) and is live.
  await writeFile(keyClaimFile(dir, 3), `${JSON.stringify(record(3, { pid: process.pid }))}\n`, "utf8");

  const late = await attemptClaimGeneration(dir, 2, record(2, { pid: process.pid }));
  assert.equal(late.outcome, "lost");
  assert.equal(/** @type {any} */ (late).by, 3);

  const files = await filesIn(dir);
  assert.ok(!files.includes("2.claim"), "the loser removes its own file");
  assert.ok(files.includes("3.claim"), "and removes NOTHING it did not create");
  assert.ok(files.includes("1.claim"), "including the stale generation it was reclaiming");
});

test("the losing taker ends holding nothing and is refused by name on its next read", async (t) => {
  const root = await stateRoot(t);
  const dir = await claimDir(root);
  await plant(dir, 1);
  await writeFile(keyClaimFile(dir, 2), `${JSON.stringify(record(2, { pid: process.pid, label: "the winner" }))}\n`, "utf8");

  // The full acquire, arriving late: it re-reads, sees the live holder, and refuses. It never
  // reaches a return value, which is the only thing a caller would spawn on.
  await assert.rejects(
    () => takeKeyClaim({ stateRoot: root, keyDigest: DIGEST_A, kind: "resident" }),
    (/** @type {any} */ error) => {
      assert.equal(codeOf(error), "member-key-claim-held");
      assert.match(error.message, /the winner/);
      return true;
    },
  );
});

// --- contract 3: the floor is durable across release ------------------------------------------

test("release marks the generation and LEAVES it, so the number is never reissued", async (t) => {
  const root = await stateRoot(t);
  const held = await takeKeyClaim({ stateRoot: root, keyDigest: DIGEST_A, kind: "resident" });
  assert.equal(held.generation, 1);
  assert.equal(await held.release(), true);

  const files = await filesIn(held.dir);
  assert.deepEqual(files, ["1.claim", "1.released"],
    "an emptied directory would let a delayed taker's stale 2 outrank a fresh live 1");
  // A second release is not a second event.
  assert.equal(await held.release(), false);

  const next = await takeKeyClaim({ stateRoot: root, keyDigest: DIGEST_A, kind: "resident" });
  assert.equal(next.generation, 2);
  await next.release();
});

test("release-reacquire: A's delayed create of a released number ends holding nothing", async (t) => {
  const root = await stateRoot(t);
  const dir = await claimDir(root);
  await plant(dir, 1);                                  // the stale record A reads

  // A reads 1 as stale and computes 2. It pauses here — no create yet.
  const aGeneration = (await scanClaimDir(dir)).floor + 1;
  assert.equal(aGeneration, 2);

  // B takes 2, prunes 1, and releases (after its child terminated — seam 8's ordering).
  const b = await takeKeyClaim({ stateRoot: root, keyDigest: DIGEST_A, kind: "resident" });
  assert.equal(b.generation, 2);
  assert.deepEqual(await filesIn(dir), ["2.claim"]);
  assert.equal(await b.release(), true);

  // C takes the next number. Its prune removes B's files, so 2.claim is gone from the directory —
  // which is exactly the state in which A's stale create can succeed.
  const c = await takeKeyClaim({ stateRoot: root, keyDigest: DIGEST_A, kind: "resident", label: "the live one" });
  assert.equal(c.generation, 3, "the floor counted B's RELEASED generation, so 2 was not reissued");
  assert.deepEqual(await filesIn(dir), ["3.claim"]);

  // A finally creates its 2. The create succeeds; the LISTING is what refuses it.
  const late = await attemptClaimGeneration(dir, aGeneration, record(aGeneration, { pid: process.pid }));
  assert.equal(late.outcome, "lost");
  assert.deepEqual(await filesIn(dir), ["3.claim"], "A removed its own file and C's is untouched");

  // And C is still the holder that any reader sees.
  const seen = await readKeyClaim(root, DIGEST_A);
  assert.equal(seen.held, true);
  assert.equal(seen.claim?.generation, 3);
  assert.equal(seen.claim?.label, "the live one");

  // Registered by the reader before this head existed: a subsequent successful acquisition must
  // EXCEED the durable floor, and generations must never regress. Asserted rather than implied by
  // the numbers above, because "3 came after 2" is what any scheme prints and "the next one is
  // above the highest ever issued" is the property the floor exists for.
  await c.release();
  const after = await takeKeyClaim({ stateRoot: root, keyDigest: DIGEST_A, kind: "resident" });
  assert.ok(after.generation > 3, `a later acquisition regressed to ${after.generation}`);
  assert.equal((await scanClaimDir(dir)).floor, after.generation);
  await after.release();
});

test("an old holder's late release cannot free a later claim", async (t) => {
  const root = await stateRoot(t);
  const first = await takeKeyClaim({ stateRoot: root, keyDigest: DIGEST_A, kind: "gate" });
  await first.release();
  const second = await takeKeyClaim({ stateRoot: root, keyDigest: DIGEST_A, kind: "resident" });

  // The gate's `finally` runs late — after the resident has taken the key. Marking its OWN number
  // released is all it can do; there is no operation here that could hand the key on. The mark may
  // even land again, because the resident's prune already swept generation 1 below the floor — and
  // that is harmless BY CONSTRUCTION rather than by luck: a file below the floor changes neither
  // the floor nor the holder, which is what the two reads below assert.
  await first.release();
  const afterLate = await scanClaimDir(first.dir);
  assert.equal(afterLate.floor, second.generation, "a late mark below the floor does not move the floor");
  assert.equal(afterLate.holder?.generation, second.generation);

  const stillHeld = await readKeyClaim(root, DIGEST_A);
  assert.equal(stillHeld.held, true);
  assert.equal(stillHeld.claim?.generation, second.generation);
  assert.equal(stillHeld.claim?.kind, "resident");

  assert.equal(await second.release(), true);
});

test("release never throws on a claim whose file is already gone", async (t) => {
  const root = await stateRoot(t);
  const held = await takeKeyClaim({ stateRoot: root, keyDigest: DIGEST_A, kind: "resident" });
  await rm(held.path, { force: true });
  // The mark is still written: it is the FLOOR that matters, and the floor is the number, not the
  // claim file. A release that threw here would strand the teardown it runs inside.
  assert.equal(await held.release(), true);
  await rm(held.dir, { recursive: true, force: true });
  assert.equal(await releaseKeyClaim(held.dir, held.generation), false);
});

// --- contract 4: nobody removes a file it did not create ---------------------------------------

test("a delayed cleanup cannot remove a replacement generation", async (t) => {
  const root = await stateRoot(t);
  const dir = await claimDir(root);
  await plant(dir, 1);
  await plant(dir, 2);                                  // both stale: two crashed takers

  // A replacement arrives and takes 3, pruning 1 and 2 — its own file is then the floor.
  const holder = await takeKeyClaim({ stateRoot: root, keyDigest: DIGEST_A, kind: "resident" });
  assert.equal(holder.generation, 3);
  assert.deepEqual(await filesIn(dir), ["3.claim"]);

  // Now the delayed cleanup of the ORIGINAL stale record arrives, in the only form this scheme
  // permits: a taker acting on generation 2. It can create 2, and its listing then makes it remove
  // its own file. There is no operation by which it could reach 3.
  const stragglerFiles = await filesIn(dir);
  const late = await attemptClaimGeneration(dir, 2, record(2, { pid: process.pid }));
  assert.equal(late.outcome, "lost");
  assert.deepEqual(await filesIn(dir), stragglerFiles, "the replacement survives the straggler exactly");
  const seen = await readKeyClaim(root, DIGEST_A);
  assert.equal(seen.held, true);
  assert.equal(seen.claim?.generation, 3);
  await holder.release();
});

test("the holder prunes strictly below its own, and the floor survives the prune", async (t) => {
  const root = await stateRoot(t);
  const dir = await claimDir(root);
  for (const generation of [1, 2, 3, 4]) await plant(dir, generation);
  await writeFile(keyClaimFile(dir, 4, "released"), `${JSON.stringify({ at: new Date().toISOString() })}\n`, "utf8");

  const held = await takeKeyClaim({ stateRoot: root, keyDigest: DIGEST_A, kind: "resident" });
  assert.equal(held.generation, 5, "floor counts the released 4");
  assert.deepEqual(await filesIn(dir), ["5.claim"]);
  const scan = await scanClaimDir(dir);
  assert.equal(scan.floor, 5, "the pruner's own file is the floor, so no number is ever reissued");
  await held.release();
});

// --- malformed, and the three-state read ------------------------------------------------------

test("a malformed claim refuses by name and is NOT cleared", async (t) => {
  const root = await stateRoot(t);
  const dir = await claimDir(root);
  await writeFile(keyClaimFile(dir, 1), "{ this is not a claim\n", "utf8");

  await assert.rejects(
    () => takeKeyClaim({ stateRoot: root, keyDigest: DIGEST_A, kind: "resident" }),
    (/** @type {any} */ error) => {
      assert.equal(codeOf(error), "member-key-claim-malformed");
      assert.match(error.message, /not cleared automatically/);
      return true;
    },
  );
  // The file survives: an unreadable claim may belong to a live process, and clearing it is
  // exactly how the second child gets spawned.
  assert.equal(await readFile(keyClaimFile(dir, 1), "utf8"), "{ this is not a claim\n");
});

test("a claim missing a required field is malformed, not free", async (t) => {
  const root = await stateRoot(t);
  const dir = await claimDir(root);
  // Parses as JSON, carries no kind. A record shape that half-matches is the realistic corruption,
  // not a syntax error, and it must not read as an absent claim.
  await writeFile(keyClaimFile(dir, 1), `${JSON.stringify({ keyDigest: DIGEST_A, pid: process.pid, generation: 1 })}\n`, "utf8");
  await assert.rejects(
    () => takeKeyClaim({ stateRoot: root, keyDigest: DIGEST_A, kind: "resident" }),
    (/** @type {any} */ error) => codeOf(error) === "member-key-claim-malformed",
  );
});

test("readKeyClaim reports an unreadable claim as unknown, never as free", async (t) => {
  const root = await stateRoot(t);
  const absent = await readKeyClaim(root, DIGEST_A);
  assert.equal(absent.held, false);
  assert.equal(absent.floor, 0);

  const held = await takeKeyClaim({ stateRoot: root, keyDigest: DIGEST_A, kind: "resident", label: "house-remote" });
  const live = await readKeyClaim(root, DIGEST_A);
  assert.equal(live.held, true);
  assert.equal(live.claim?.kind, "resident");
  assert.equal(live.claim?.label, "house-remote");

  await writeFile(held.path, "not json at all\n", "utf8");
  const unknown = await readKeyClaim(root, DIGEST_A);
  assert.equal(unknown.held, "unknown");
  // The third state must be truthy, so a caller that only checks `if (held)` fails toward
  // refusing rather than toward dialing.
  assert.ok(unknown.held);
});

test("readKeyClaim separates a stale claim, a released one, and an absent one", async (t) => {
  const root = await stateRoot(t);
  const dir = await claimDir(root);
  await plant(dir, 1, { kind: "gate" });
  const stale = await readKeyClaim(root, DIGEST_A);
  assert.equal(stale.held, false);
  assert.equal(stale.stale, true);
  assert.equal(stale.claim?.kind, "gate");
  assert.equal(stale.floor, 1);

  // A generation its holder released is NOT stale: nothing crashed, and an operator reading
  // "stale" would go looking for a dead process that never existed.
  await writeFile(keyClaimFile(dir, 1, "released"), `${JSON.stringify({ at: new Date().toISOString() })}\n`, "utf8");
  const released = await readKeyClaim(root, DIGEST_A);
  assert.equal(released.held, false);
  assert.equal(released.stale, undefined);
  assert.equal(released.floor, 1);
});

test("one state root reached by two paths is one claim", async (t) => {
  const root = await stateRoot(t);
  const real = path.join(root, "state");
  await mkdir(real, { recursive: true });
  const link = path.join(root, "link-to-state");
  try { await symlink(real, link, "dir"); }
  catch (error) {
    // Windows without developer mode refuses a symlink; the property is a POSIX one here.
    t.skip(`symlink unavailable: ${/** @type {Error} */ (error).message}`);
    return;
  }

  const held = await takeKeyClaim({ stateRoot: real, keyDigest: DIGEST_A, kind: "resident" });
  await assert.rejects(
    () => takeKeyClaim({ stateRoot: link, keyDigest: DIGEST_A, kind: "gate" }),
    (/** @type {any} */ error) => codeOf(error) === "member-key-claim-held",
  );
  await held.release();
});

test("the digest and the kind are validated before anything is written", async (t) => {
  const root = await stateRoot(t);
  await assert.rejects(
    () => takeKeyClaim({ stateRoot: root, keyDigest: "not-a-digest", kind: "resident" }),
    (/** @type {any} */ error) => codeOf(error) === "member-key-claim-digest-invalid",
  );
  await assert.rejects(
    () => takeKeyClaim({ stateRoot: root, keyDigest: DIGEST_A, kind: /** @type {any} */ ("supervisor") }),
    (/** @type {any} */ error) => codeOf(error) === "member-key-claim-kind-invalid",
  );
  // Nothing was created by either refusal.
  const wouldBe = keyClaimDir(await canonicalStateRoot(root), DIGEST_A);
  await assert.rejects(() => readdir(wouldBe), (/** @type {any} */ error) => error.code === "ENOENT");
});

// --- teardown before replacement (seam 7's last contract, seam 8's hold-through-teardown) ------
//
// The door a claim cannot watch is the previous holder's CORPSE. A dead holder tears nothing down,
// and the Tailcat child of a dead resident is still a peer on the enrolled key, so a replacement
// that spawns on the strength of "the holder is dead" is the second child arriving by the one
// route every other contract here leaves open.

test("a dead holder whose Tailcat child still answers refuses a replacement by name", async (t) => {
  const root = await stateRoot(t);
  const dir = await claimDir(root);
  await plant(dir, 1);                                   // the holder itself: proven dead
  // Its child, still alive. This process's own pid on this boot is the only pid a cell can be sure
  // answers; the point is that the replacement PROBES it rather than assuming a dead parent means
  // a dead child.
  await recordClaimChildren(dir, 1, [process.pid]);

  await assert.rejects(
    () => takeKeyClaim({ stateRoot: root, keyDigest: DIGEST_A, kind: "resident" }),
    (/** @type {any} */ error) => {
      assert.equal(codeOf(error), "member-key-claim-child-alive");
      assert.match(error.message, new RegExp(`pid ${process.pid}\\b`));
      assert.match(error.message, /second peer/);
      return true;
    },
  );
  // Nothing was created by the refusal: a replacement that had written its own generation would
  // have moved the floor for a defect that is not resolved.
  assert.deepEqual(await filesIn(dir), ["1.child", "1.claim"]);

  // Teardown completes. Only now may a replacement start, and it starts above the floor.
  await clearClaimChildren(dir, 1);
  const next = await takeKeyClaim({ stateRoot: root, keyDigest: DIGEST_A, kind: "resident" });
  assert.equal(next.generation, 2);
  await next.release();
});

test("a child record from a previous boot fences nothing", async (t) => {
  const root = await stateRoot(t);
  const dir = await claimDir(root);
  await plant(dir, 1);
  // The same pid, recorded before a reboot. Probing it would say LIVE and fence the key out
  // forever; the boot epoch is what separates a live child from a recycled number.
  await recordClaimChildren(dir, 1, [process.pid], { boot: bootEpoch() - 100_000 });
  const scan = await scanClaimDir(dir);
  assert.deepEqual(liveClaimChildren(scan, 1), []);

  const taken = await takeKeyClaim({ stateRoot: root, keyDigest: DIGEST_A, kind: "resident" });
  assert.equal(taken.generation, 2);
  await taken.release();
});

test("release refuses while the generation still owns a live child, and the mark never lands early", async (t) => {
  const root = await stateRoot(t);
  const held = await takeKeyClaim({ stateRoot: root, keyDigest: DIGEST_A, kind: "resident" });
  await recordClaimChildren(held.dir, held.generation, [process.pid]);

  // THE PROPERTY: a published released state must never precede child termination. Ordering this
  // in the caller's shutdown path is not enough, because the caller is the process that is exiting
  // and an unconfirmed teardown looks identical to a finished one from inside it.
  assert.equal(await held.release(), false);
  assert.deepEqual(await filesIn(held.dir), ["1.child", "1.claim"],
    "a released mark written here would tell the next holder the key is free while a child is dying");

  // And the key is not free in the meantime, by the reader the next start actually uses.
  await assert.rejects(
    () => takeKeyClaim({ stateRoot: root, keyDigest: DIGEST_A, kind: "gate" }),
    (/** @type {any} */ error) => codeOf(error) === "member-key-claim-held",
  );

  await clearClaimChildren(held.dir, held.generation);
  assert.equal(await held.release(), true);
  assert.deepEqual(await filesIn(held.dir), ["1.claim", "1.released"]);
});

test("recording children is the holder's own file: an empty set removes it rather than leaving a lie", async (t) => {
  const root = await stateRoot(t);
  const held = await takeKeyClaim({ stateRoot: root, keyDigest: DIGEST_A, kind: "resident" });
  await recordClaimChildren(held.dir, held.generation, [111, 222]);
  const two = await scanClaimDir(held.dir);
  assert.deepEqual(two.children.get(1)?.pids, [111, 222]);

  // The children exit; the record follows them down. A stale record naming dead pids is harmless
  // (they are probed) but a record that outlives the truth is one more thing to reason about.
  await recordClaimChildren(held.dir, held.generation, []);
  assert.deepEqual(await filesIn(held.dir), ["1.claim"]);
  await held.release();
});

// --- the digest, read with no child ---------------------------------------------------------
//
// The circularity these cells pin: the claim must precede any Tailcat child, and it is keyed by the
// enrolled key digest, but the ordinary way to learn the public node key is `printpub`, which IS a
// child. A claim that spawns a child to decide whether it may spawn a child has already lost.

const NODE_KEY = `nodekey:${"1234567890abcdef".repeat(4)}`;

/** The identity file's real shape: both halves, the public one beside the private. */
const identityFile = (extra = {}) => JSON.stringify({
  Private: `privkey:${"9".repeat(64)}`,
  Public: { ServerPublic: NODE_KEY, ServerDiscoPublic: `discokey:${"8".repeat(64)}` },
  ...extra,
});

test("the enrolled digest is derived from the identity file, with no child spawned", async (t) => {
  const root = await stateRoot(t);
  const keyPath = path.join(root, "identity.private.json");
  await writeFile(keyPath, identityFile(), "utf8");
  assert.equal(await enrolledKeyDigest(keyPath), publicNodeKeyDigest(NODE_KEY));
});

test("the private half never appears in the digest, a refusal, or anything returned", async (t) => {
  const root = await stateRoot(t);
  const secret = `privkey:${"9".repeat(64)}`;
  const keyPath = path.join(root, "identity.private.json");
  await writeFile(keyPath, identityFile(), "utf8");

  const digest = await enrolledKeyDigest(keyPath);
  assert.doesNotMatch(digest, /privkey|9{16}/);

  // And on the failure path, where a message is most likely to be pasted somewhere.
  await writeFile(keyPath, JSON.stringify({ Private: secret, Public: { ServerPublic: "not-a-node-key" } }), "utf8");
  await assert.rejects(() => enrolledKeyDigest(keyPath), (/** @type {any} */ error) => {
    assert.equal(codeOf(error), "member-key-identity-malformed");
    assert.doesNotMatch(error.message, /privkey|9{16}/);
    return true;
  });
});

test("an unreadable or shapeless identity refuses by name rather than guessing a digest", async (t) => {
  const root = await stateRoot(t);
  await assert.rejects(
    () => enrolledKeyDigest(path.join(root, "absent.json")),
    (/** @type {any} */ error) => codeOf(error) === "member-key-identity-unreadable",
  );

  const keyPath = path.join(root, "identity.private.json");
  for (const body of ["{ not json", JSON.stringify({ Private: "x" }), JSON.stringify({ Public: {} }), JSON.stringify({ Public: { ServerPublic: 42 } })]) {
    await writeFile(keyPath, body, "utf8");
    await assert.rejects(
      () => enrolledKeyDigest(keyPath),
      (/** @type {any} */ error) => codeOf(error) === "member-key-identity-malformed",
      body.slice(0, 30),
    );
  }
});

test("the digest keys a claim end to end, so the gate and the resident contend on one file", async (t) => {
  const root = await stateRoot(t);
  const keyPath = path.join(root, "identity.private.json");
  await writeFile(keyPath, identityFile(), "utf8");
  const keyDigest = await enrolledKeyDigest(keyPath);

  // The resident learns its digest from the route descriptor's binding; the gate learns it from the
  // key file it was handed. Same key, same digest, therefore the same claim file: the gate cannot
  // start while the resident holds it, in either order of arrival.
  const resident = await takeKeyClaim({ stateRoot: root, keyDigest, kind: "resident", label: "house-remote" });
  await assert.rejects(
    () => takeKeyClaim({ stateRoot: root, keyDigest, kind: "gate", label: "probe-tailcat-live --direct" }),
    (/** @type {any} */ error) => codeOf(error) === "member-key-claim-held",
  );
  await resident.release();

  const gate = await takeKeyClaim({ stateRoot: root, keyDigest, kind: "gate", label: "probe-tailcat-live --direct" });
  await assert.rejects(
    () => takeKeyClaim({ stateRoot: root, keyDigest, kind: "resident", label: "house-remote" }),
    (/** @type {any} */ error) => {
      assert.equal(codeOf(error), "member-key-claim-held");
      // A start refused by a transient gate must read as retry-in-seconds, which is what the kind
      // and the label are for.
      assert.match(error.message, /gate/);
      assert.match(error.message, /probe-tailcat-live/);
      return true;
    },
  );
  await gate.release();
});
