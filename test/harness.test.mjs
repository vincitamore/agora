import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { claudeProjectSlug, clearWatchMode, touchWatchMode, watchModeSentinel } from "../src/harness.mjs";

test("the sentinel sits beside the Claude Code transcript, named by cwd slug and session id", () => {
  assert.equal(claudeProjectSlug("C:\\Users\\operator\\Documents\\alpha"), "C--Users-operator-Documents-opus");
  assert.equal(claudeProjectSlug("/home/operator/org-a"), "-home-deck-opus");
  const target = watchModeSentinel({ CLAUDE_CODE_SESSION_ID: "dd3eb167-c198-4799-96de-7e58c12194d8" }, "C:\\Users\\operator\\Documents\\alpha", "H:\\home");
  assert.ok(target);
  assert.equal(target.dir, path.join("H:\\home", ".claude", "projects", "C--Users-operator-Documents-opus"));
  assert.equal(path.basename(target.transcript), "dd3eb167-c198-4799-96de-7e58c12194d8.jsonl");
  assert.equal(path.basename(target.sentinel), "dd3eb167-c198-4799-96de-7e58c12194d8.watch-mode");
  assert.equal(watchModeSentinel({}, "/x"), null, "no Claude Code session, no sentinel");
  assert.equal(watchModeSentinel({ CLAUDE_CODE_SESSION_ID: "../evil" }, "/x"), null, "an id that is not an id is ignored");
});

test("touch writes only beside an existing transcript; clear removes it; absent is fine", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agora-harness-"));
  try {
    const env = { CLAUDE_CODE_SESSION_ID: "abcdef12-0000-4000-8000-000000000000" };
    const target = watchModeSentinel(env, "/some/where", home);
    assert.ok(target);
    assert.equal(await touchWatchMode(target), false, "no transcript, nothing written");
    await mkdir(target.dir, { recursive: true });
    await writeFile(target.transcript, "", "utf8");
    const now = new Date("2026-09-03T23:40:00.000Z");
    assert.equal(await touchWatchMode(target, { now }), true);
    assert.equal(await readFile(target.sentinel, "utf8"), "2026-09-03T23:40:00.000Z\n");
    await touchWatchMode(target);
    assert.ok((await stat(target.sentinel)).isFile());
    await clearWatchMode(target);
    await assert.rejects(stat(target.sentinel));
    await clearWatchMode(target);
    await clearWatchMode(null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
