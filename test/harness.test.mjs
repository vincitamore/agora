import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { claudeProjectSlug, clearWatchMode, readWatchMode, touchWatchMode, watchModeSentinel } from "../src/harness.mjs";

test("the sentinel sits beside the Claude Code transcript, named by cwd slug and session id", () => {
  assert.equal(claudeProjectSlug("C:\\Users\\operator\\Documents\\alpha"), "C--Users-operator-Documents-opus");
  assert.equal(claudeProjectSlug("/home/operator/org-a"), "-home-deck-opus");
  const root = path.parse(process.cwd()).root;
  const cwd = path.join(root, "Users", "operator", "Documents", "alpha");
  const home = path.join(root, "Users", "operator");
  const target = watchModeSentinel({ CLAUDE_CODE_SESSION_ID: "dd3eb167-c198-4799-96de-7e58c12194d8" }, cwd, home);
  assert.ok(target);
  assert.equal(target.dir, path.join(home, ".claude", "projects", claudeProjectSlug(cwd)));
  assert.equal(path.basename(target.transcript), "dd3eb167-c198-4799-96de-7e58c12194d8.jsonl");
  assert.equal(path.basename(target.sentinel), "dd3eb167-c198-4799-96de-7e58c12194d8.watch-mode");
  assert.equal(watchModeSentinel({}, "/x"), null, "no Claude Code session, no sentinel");
  assert.equal(watchModeSentinel({ CLAUDE_CODE_SESSION_ID: "../evil" }, "/x"), null, "an id that is not an id is ignored");
});

test("touch writes only beside an existing transcript; clear removes it; absent is fine", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agora-harness-"));
  try {
    const env = { CLAUDE_CODE_SESSION_ID: "abcdef12-0000-4000-8000-000000000000" };
    let target = watchModeSentinel(env, "/some/where", home);
    assert.ok(target);
    assert.equal(await touchWatchMode(target), false, "no transcript, nothing written");
    await mkdir(target.dir, { recursive: true });
    await writeFile(target.transcript, "", "utf8");
    const fromSubdir = watchModeSentinel(env, "/some/where/projects/agora", home);
    assert.ok(fromSubdir);
    assert.equal(fromSubdir.transcript, target.transcript, "a watch armed from a subdirectory finds the project root's transcript");
    target = fromSubdir;
    const now = new Date("2026-09-03T23:40:00.000Z");
    assert.equal(await touchWatchMode(target, { now }), "created", "the path is worth announcing exactly once");
    assert.deepEqual(JSON.parse(await readFile(target.sentinel, "utf8")), { pid: process.pid, at: "2026-09-03T23:40:00.000Z" });
    assert.equal(await touchWatchMode(target), "refreshed", "a refresh is not an announcement");
    assert.ok((await stat(target.sentinel)).isFile());
    await clearWatchMode(target);
    await assert.rejects(stat(target.sentinel));
    await clearWatchMode(target);
    await clearWatchMode(null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the sentinel has an owner: a short watch leaving does not un-suppress a resident one", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agora-harness-"));
  try {
    const env = { CLAUDE_CODE_SESSION_ID: "abcdef12-0000-4000-8000-000000000001" };
    const target = watchModeSentinel(env, "/some/where", home);
    assert.ok(target);
    await mkdir(target.dir, { recursive: true });
    await writeFile(target.transcript, "", "utf8");

    // the resident stream (this process) owns it; a one-shot watch in the same session is another pid
    assert.equal(await touchWatchMode(target), "created");
    const other = process.pid + 1_000_000; // a pid nothing answers
    assert.equal(await touchWatchMode(target, { pid: other }), "refreshed");
    assert.equal(JSON.parse(await readFile(target.sentinel, "utf8")).pid, process.pid, "a live owner keeps the file");
    await clearWatchMode(target, { pid: other });
    assert.ok((await stat(target.sentinel)).isFile(), "the short watch left the resident one's suppression alone");
    assert.equal(JSON.parse(await readFile(target.sentinel, "utf8")).pid, process.pid);
    await clearWatchMode(target);
    await assert.rejects(stat(target.sentinel), "the owner clears it");

    // an owner that is gone (killed without clearing) is not an owner: the next watch adopts the file
    await writeFile(target.sentinel, JSON.stringify({ pid: other, at: "2026-09-03T23:40:00.000Z" }), "utf8");
    assert.equal(await touchWatchMode(target), "refreshed");
    assert.equal(JSON.parse(await readFile(target.sentinel, "utf8")).pid, process.pid);

    // a bare-timestamp sentinel from an older build is unowned and adopted the same way
    await writeFile(target.sentinel, "2026-09-03T23:40:00.000Z\n", "utf8");
    assert.deepEqual(await readWatchMode(target), { at: "2026-09-03T23:40:00.000Z" });
    await clearWatchMode(target);
    await assert.rejects(stat(target.sentinel));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
