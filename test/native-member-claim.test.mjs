// L12: the exclusive ownership claim over one enrolled node key.
//
// The claim is the whole of what makes a second Tailcat child on one key impossible, so every cell
// here asserts a NAMED refusal, and the two that matter most are the ones a plausible-looking
// implementation passes anyway: a claim taken AFTER the spawn, and a claim trusted by presence.
// Neither is testable from this file alone — the first is the contest cell's, the second is the
// stale-detection cells below, which is why pid-gone and boot-epoch-moved are separate cells.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  canonicalStateRoot, claimAlive, keyClaimPath, readKeyClaim, releaseKeyClaim, takeKeyClaim,
} from "../src/native-member-claim.mjs";
import { bootEpoch } from "../src/session.mjs";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

/** A state root that is cleaned up with the test. */
async function stateRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-claim-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** The refusal code, which is what every caller branches on. */
const codeOf = (error) => /** @type {{ code?: string }} */ (error)?.code;

test("a second acquire on one key is refused by name, and the refusal is actionable", async (t) => {
  const root = await stateRoot(t);
  const held = await takeKeyClaim({ stateRoot: root, keyDigest: DIGEST_A, kind: "resident", label: "house-remote" });

  await assert.rejects(
    () => takeKeyClaim({ stateRoot: root, keyDigest: DIGEST_A, kind: "gate", label: "direct-path gate" }),
    (error) => {
      assert.equal(codeOf(error), "member-key-claim-held");
      // A refusal that does not name the holder sends the operator to `ps`. The three facts that
      // make it actionable are the kind, the pid, and the label.
      assert.match(error.message, /resident/);
      assert.match(error.message, new RegExp(`pid ${process.pid}\\b`));
      assert.match(error.message, /house-remote/);
      return true;
    },
  );

  assert.equal(await held.release(), true);
  // Only once the holder has released does the next acquire succeed: the claim is the gate itself.
  const next = await takeKeyClaim({ stateRoot: root, keyDigest: DIGEST_A, kind: "gate" });
  assert.notEqual(next.generation, held.generation);
  await next.release();
});

test("the claim is keyed by the key, not the alias: two aliases on one key contend", async (t) => {
  const root = await stateRoot(t);
  const first = await takeKeyClaim({ stateRoot: root, keyDigest: DIGEST_A, kind: "resident", label: "house-remote" });
  await assert.rejects(
    () => takeKeyClaim({ stateRoot: root, keyDigest: DIGEST_A, kind: "resident", label: "other-room" }),
    (error) => codeOf(error) === "member-key-claim-held",
  );
  await first.release();
});

test("two different keys do not contend", async (t) => {
  const root = await stateRoot(t);
  const a = await takeKeyClaim({ stateRoot: root, keyDigest: DIGEST_A, kind: "resident" });
  const b = await takeKeyClaim({ stateRoot: root, keyDigest: DIGEST_B, kind: "resident" });
  assert.notEqual(a.path, b.path);
  await a.release();
  await b.release();
});

test("a claim whose process is gone is re-taken; a live one is not", async (t) => {
  const root = await stateRoot(t);
  const claimPath = keyClaimPath(await canonicalStateRoot(root), DIGEST_A);
  await mkdir(path.dirname(claimPath), { recursive: true });
  const dead = {
    keyDigest: DIGEST_A, pid: 999_999_999, bootEpoch: bootEpoch(), kind: "resident",
    generation: "deadgeneration", startedAt: new Date().toISOString(),
  };
  await writeFile(claimPath, `${JSON.stringify(dead)}\n`, "utf8");

  const taken = await takeKeyClaim({ stateRoot: root, keyDigest: DIGEST_A, kind: "resident" });
  assert.notEqual(taken.generation, "deadgeneration");
  const onDisk = JSON.parse(await readFile(claimPath, "utf8"));
  assert.equal(onDisk.pid, process.pid);
  await taken.release();
});

test("a claim from a previous boot is stale even though its pid answers", async (t) => {
  const root = await stateRoot(t);
  const claimPath = keyClaimPath(await canonicalStateRoot(root), DIGEST_A);
  await mkdir(path.dirname(claimPath), { recursive: true });
  // This process's own pid, so a pid probe alone says LIVE. Only the boot epoch separates them,
  // and without it a reboot that reused the pid fences every later start out forever.
  const previousBoot = {
    keyDigest: DIGEST_A, pid: process.pid, bootEpoch: bootEpoch() - 100_000, kind: "resident",
    generation: "beforethereboot", startedAt: new Date(0).toISOString(),
  };
  await writeFile(claimPath, `${JSON.stringify(previousBoot)}\n`, "utf8");
  assert.equal(claimAlive(previousBoot), false);

  const taken = await takeKeyClaim({ stateRoot: root, keyDigest: DIGEST_A, kind: "resident" });
  assert.notEqual(taken.generation, "beforethereboot");
  await taken.release();
});

test("a malformed claim refuses by name and is NOT cleared", async (t) => {
  const root = await stateRoot(t);
  const claimPath = keyClaimPath(await canonicalStateRoot(root), DIGEST_A);
  await mkdir(path.dirname(claimPath), { recursive: true });
  await writeFile(claimPath, "{ this is not a claim\n", "utf8");

  await assert.rejects(
    () => takeKeyClaim({ stateRoot: root, keyDigest: DIGEST_A, kind: "resident" }),
    (error) => {
      assert.equal(codeOf(error), "member-key-claim-malformed");
      assert.match(error.message, /not cleared automatically/);
      return true;
    },
  );
  // The file survives: an unreadable claim may belong to a live process, and clearing it is
  // exactly how the second child gets spawned.
  assert.equal(await readFile(claimPath, "utf8"), "{ this is not a claim\n");
});

test("a claim missing a required field is malformed, not free", async (t) => {
  const root = await stateRoot(t);
  const claimPath = keyClaimPath(await canonicalStateRoot(root), DIGEST_A);
  await mkdir(path.dirname(claimPath), { recursive: true });
  // Parses as JSON, carries no kind. A record shape that half-matches is the realistic corruption,
  // not a syntax error, and it must not read as an absent claim.
  await writeFile(claimPath, `${JSON.stringify({ keyDigest: DIGEST_A, pid: process.pid, generation: "g" })}\n`, "utf8");
  await assert.rejects(
    () => takeKeyClaim({ stateRoot: root, keyDigest: DIGEST_A, kind: "resident" }),
    (error) => codeOf(error) === "member-key-claim-malformed",
  );
});

test("release is fenced by generation: an old holder cannot free a later claim", async (t) => {
  const root = await stateRoot(t);
  const first = await takeKeyClaim({ stateRoot: root, keyDigest: DIGEST_A, kind: "gate" });
  await first.release();
  const second = await takeKeyClaim({ stateRoot: root, keyDigest: DIGEST_A, kind: "resident" });

  // The gate's `finally` runs late — after the resident has taken the key. Unlinking here would
  // hand the key to a third process while the resident still has a child.
  assert.equal(await first.release(), false);
  assert.equal(await releaseKeyClaim(first.path, "someothergeneration"), false);
  const stillHeld = JSON.parse(await readFile(second.path, "utf8"));
  assert.equal(stillHeld.generation, second.generation);
  assert.equal(stillHeld.kind, "resident");

  assert.equal(await second.release(), true);
});

test("release never throws on a claim that is already gone", async (t) => {
  const root = await stateRoot(t);
  const held = await takeKeyClaim({ stateRoot: root, keyDigest: DIGEST_A, kind: "resident" });
  await rm(held.path, { force: true });
  assert.equal(await held.release(), false);
});

test("readKeyClaim reports an unreadable claim as unknown, never as free", async (t) => {
  const root = await stateRoot(t);
  const absent = await readKeyClaim(root, DIGEST_A);
  assert.equal(absent.held, false);

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

test("readKeyClaim separates a stale claim from an absent one", async (t) => {
  const root = await stateRoot(t);
  const claimPath = keyClaimPath(await canonicalStateRoot(root), DIGEST_A);
  await mkdir(path.dirname(claimPath), { recursive: true });
  await writeFile(claimPath, `${JSON.stringify({
    keyDigest: DIGEST_A, pid: 999_999_999, bootEpoch: bootEpoch(), kind: "gate",
    generation: "g", startedAt: new Date().toISOString(),
  })}\n`, "utf8");
  const seen = await readKeyClaim(root, DIGEST_A);
  assert.equal(seen.held, false);
  assert.equal(seen.stale, true);
  assert.equal(seen.claim?.kind, "gate");
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
    (error) => codeOf(error) === "member-key-claim-held",
  );
  await held.release();
});

test("the digest and the kind are validated before anything is written", async (t) => {
  const root = await stateRoot(t);
  await assert.rejects(
    () => takeKeyClaim({ stateRoot: root, keyDigest: "not-a-digest", kind: "resident" }),
    (error) => codeOf(error) === "member-key-claim-digest-invalid",
  );
  await assert.rejects(
    () => takeKeyClaim({ stateRoot: root, keyDigest: DIGEST_A, kind: /** @type {any} */ ("supervisor") }),
    (error) => codeOf(error) === "member-key-claim-kind-invalid",
  );
  // Nothing was created by either refusal.
  const wouldBe = keyClaimPath(await canonicalStateRoot(root), DIGEST_A);
  await assert.rejects(() => readFile(wouldBe, "utf8"), (error) => error.code === "ENOENT");
});
