// @ts-check
// The reopen path of a native room against bad bytes on disk, read from the committed corpus
// under test/fixtures/native-store-bad/ (written by scripts/make-bad-bytes-corpus.mjs: one good
// room the reader must accept, and one damaged copy per named edit of it). Each case's
// EXPECT.json says whether `NativeRoomStore.open` opens it or what refusal it names. These are
// the on-disk seams the mutation sweep found untested: the scan, boundary, manifest and
// writer-lock paths. The second wave (record, message, board and boundary fields behind a
// re-sealed frame, and the header and length bounds) reddens 19 of the sweep's 20 on-disk
// survivors; the one left green on purpose is `Buffer.alloc(4)` -> `alloc(5)` for the header:
// readExact fills the fifth byte from the next frame or stops at the file's end, the length is
// read from the first four either way, and the `< 4` check is what guards a short read.
import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NativeRoomStore } from "../src/native-store.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CORPUS = join(ROOT, "test", "fixtures", "native-store-bad");
const ROOM = "c0c0a5e5c0c0a5e5c0c0a5e5c0c0a5e5";

const cases = (await readdir(CORPUS)).sort();
assert.ok(cases.includes("good"), "the corpus carries the good room");

for (const name of cases) {
  test(`bad bytes: ${name}`, async (t) => {
    const expect = JSON.parse(await readFile(join(CORPUS, name, "EXPECT.json"), "utf8"));
    // open a copy: the store rewrites the writer lock and may repair, and the corpus stays as committed
    const root = await mkdtemp(join(tmpdir(), `agora-bad-${name}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    await cp(join(CORPUS, name, "native"), join(root, "native"), { recursive: true });
    if (expect.opens) {
      const store = await NativeRoomStore.open({ root, roomId: ROOM });
      t.after(() => store.close());
      assert.ok(Array.isArray(store.read({ limit: 10 })), "reads back");
    } else {
      // a case that opens where a refusal was expected is closed before the assertion fails: an
      // open store holds a handle that keeps the runner alive, so a defect that admits bad bytes
      // would otherwise read as a hang rather than a red
      const opened = NativeRoomStore.open({ root, roomId: ROOM }).then((store) => { store.close(); return store; }, (e) => { throw e; });
      await assert.rejects(opened, (e) => {
        assert.equal(/** @type {any} */ (e).name, "AgoraError", `${name}: refused as an AgoraError, not ${String(e)}`);
        assert.match(String(/** @type {any} */ (e).message), new RegExp(expect.refusal.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")), `${name}: refused by name`);
        return true;
      });
    }
  });
}

test("the good room reads back its four messages in order and its live board claim", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agora-bad-good-read-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(join(CORPUS, "good", "native"), join(root, "native"), { recursive: true });
  // the corpus was written under a fixed clock (2026-09-18 12:00Z); the board claim's lease is live
  // only when read under a clock near it, so the reopen is given one
  const store = await NativeRoomStore.open({ root, roomId: ROOM, now: () => new Date(Date.UTC(2026, 8, 18, 12, 0, 30)) });
  t.after(() => store.close());
  const messages = store.read({ limit: 10 });
  assert.deepEqual(messages.map((m) => m.text), ["message 1", "message 2", "message 3", "message 4"], "read delivers the chat records in order; the board record is not a message");
  assert.deepEqual(store.board().map((h) => h.subject), ["work:x"], "the board claim is live on reopen");
  assert.equal(store.status().committed, 5, "three messages, one board record, one message: five committed records");
});
