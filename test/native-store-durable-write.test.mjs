// @ts-check
// The atomic publication behind a native room's manifest and committed boundary retries its rename
// a bounded few times when the filesystem refuses it for a reason a moment cures (EPERM, EBUSY,
// EACCES: Windows while another process holds the target open), and throws at once on every other
// code. Each test plants the refusal on an injected rename and reads what landed on disk, so the
// contention a Windows CI runner exhibits is reproduced without a second process.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RENAME_RETRY, writeDurableAtomic } from "../src/native-store.mjs";

/** @param {string} code */
const errno = (code) => { const e = /** @type {NodeJS.ErrnoException} */ (new Error(`planted ${code}`)); e.code = code; return e; };

/**
 * a rename that refuses the first `refusals` calls with `code`, then delegates to the real one
 * @param {string} code @param {number} refusals
 */
function plant(code, refusals) {
  let calls = 0;
  /** @type {number[]} */
  const slept = [];
  const deps = {
    /** @type {typeof rename} */
    rename: async (from, to) => { calls++; if (calls <= refusals) throw errno(code); return rename(from, to); },
    sleep: async (/** @type {number} */ ms) => { slept.push(ms); },
  };
  return { deps, calls: () => calls, slept };
}

/** @param {import("node:test").TestContext} t */
async function dir(t) {
  const root = await mkdtemp(join(tmpdir(), "agora-durable-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("one EPERM on the rename: the publication lands on the retry and the temp file is gone", async (t) => {
  const root = await dir(t);
  const file = join(root, "committed.json");
  const p = plant("EPERM", 1);
  await writeDurableAtomic(file, "{\"sequence\":1}\n", p.deps);
  assert.equal(await readFile(file, "utf8"), "{\"sequence\":1}\n");
  assert.equal(p.calls(), 2, "the first rename refused, the second landed");
  assert.deepEqual(p.slept, [RENAME_RETRY.baseDelayMs], "one backoff, the base delay");
  assert.deepEqual(await readdir(root), ["committed.json"], "no temp file left beside it");
});

test("EBUSY and EACCES retry the same way, with a growing backoff", async (t) => {
  for (const code of ["EBUSY", "EACCES"]) {
    const root = await dir(t);
    const file = join(root, "room.json");
    const p = plant(code, 3);
    await writeDurableAtomic(file, "{}\n", p.deps);
    assert.equal(await readFile(file, "utf8"), "{}\n", code);
    assert.equal(p.calls(), 4, code);
    assert.deepEqual(p.slept, [10, 20, 30], `${code}: linear backoff from the base delay`);
  }
});

test("a refusal that outlasts every attempt is thrown as itself, with nothing published and the temp removed", async (t) => {
  const root = await dir(t);
  const file = join(root, "committed.json");
  const p = plant("EPERM", Infinity);
  await assert.rejects(writeDurableAtomic(file, "x", p.deps), (e) => /** @type {NodeJS.ErrnoException} */ (e).code === "EPERM");
  assert.equal(p.calls(), RENAME_RETRY.attempts, "exactly the bounded number of attempts");
  assert.equal(p.slept.length, RENAME_RETRY.attempts - 1, "a sleep between attempts, none after the last");
  assert.deepEqual(await readdir(root), [], "no target and no temp file");
});

test("every other code is thrown on the first refusal, unretried", async (t) => {
  for (const code of ["ENOENT", "EXDEV", "ENOSPC"]) {
    const root = await dir(t);
    const p = plant(code, Infinity);
    await assert.rejects(writeDurableAtomic(join(root, "committed.json"), "x", p.deps), (e) => /** @type {NodeJS.ErrnoException} */ (e).code === code);
    assert.equal(p.calls(), 1, code);
    assert.deepEqual(p.slept, [], code);
    assert.deepEqual(await readdir(root), [], `${code}: the temp is removed`);
  }
});

test("an error with no code is thrown at once, and an attempt count below one is refused by name", async (t) => {
  const root = await dir(t);
  const p = { rename: async () => { throw new Error("no code"); }, sleep: async () => { assert.fail("must not sleep"); } };
  await assert.rejects(writeDurableAtomic(join(root, "a.json"), "x", p), /no code/);
  await assert.rejects(writeDurableAtomic(join(root, "b.json"), "x", { attempts: 0 }), /at least one rename attempt/);
});

test("the store's own publications go through the retrying helper: a room is created and appended to with the real rename", async (t) => {
  const { NativeRoomStore } = await import("../src/native-store.mjs");
  const root = await dir(t);
  const store = await NativeRoomStore.create({ root, roomId: "d0d0a5e5d0d0a5e5d0d0a5e5d0d0a5e5", hostAccountId: "a0e7ad17c2dee02fc4cee4fcd6a04a9a" });
  t.after(() => store.close());
  await store.append({ operationId: "operation_durable_00000001", authorName: "A", text: "t" }, { accountId: "a0e7ad17c2dee02fc4cee4fcd6a04a9a" });
  assert.equal(store.status().committed, 1);
});
