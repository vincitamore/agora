import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildLabel, buildPredates, claudeProjectSlug, clearWatchMode, HARNESS_DESCRIPTORS, installedBuild, readWatchMode, touchWatchMode, watchModeSentinel } from "../src/harness.mjs";

test("the descriptor table names Claude Code and Codex session transcript sources", () => {
  assert.deepEqual(HARNESS_DESCRIPTORS.map((h) => [h.name, h.sessionEnv]), [
    ["claude-code", "CLAUDE_CODE_SESSION_ID"],
    ["codex", "CODEX_SESSION_ID"],
  ]);
});

test("the sentinel sits only beside an existing Claude Code transcript", async () => {
  assert.equal(claudeProjectSlug("C:\\Users\\operator\\Documents\\org-a"), "C--Users-operator-Documents-org-a");
  assert.equal(claudeProjectSlug("/home/operator/org-a"), "-home-operator-org-a");
  const home = await mkdtemp(path.join(os.tmpdir(), "agora-harness-"));
  try {
    const cwd = path.join(home, "work", "org-a");
    const id = "dd3eb167-c198-4799-96de-7e58c12194d8";
    const dir = path.join(home, ".claude", "projects", claudeProjectSlug(cwd));
    assert.equal(watchModeSentinel({ CLAUDE_CODE_SESSION_ID: id }, cwd, home), null, "absence never creates a guessed path");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${id}.jsonl`), "", "utf8");
    const target = watchModeSentinel({ CLAUDE_CODE_SESSION_ID: id }, cwd, home);
    assert.ok(target);
    assert.equal(target.harness, "claude-code");
    assert.equal(target.dir, dir);
    assert.equal(path.basename(target.sentinel), `${id}.watch-mode`);
    assert.equal(watchModeSentinel({}, cwd, home), null, "no harness session, no sentinel");
    assert.equal(watchModeSentinel({ CLAUDE_CODE_SESSION_ID: "../evil" }, cwd, home), null, "an id that is not an id is ignored");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the Codex sentinel finds the root-session rollout recursively under CODEX_HOME", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agora-harness-"));
  try {
    const id = "01a06c9b-a40b-7121-84a7-82c8cedb3325";
    const codexHome = path.join(home, "portable-codex");
    const dir = path.join(codexHome, "sessions", "2026", "09", "04");
    await mkdir(dir, { recursive: true });
    const transcript = path.join(dir, `rollout-2026-09-04T00-00-00-${id}.jsonl`);
    await writeFile(transcript, "", "utf8");
    const target = watchModeSentinel({ CODEX_SESSION_ID: id, CODEX_HOME: codexHome }, path.join(home, "work"), home);
    assert.ok(target);
    assert.equal(target.harness, "codex");
    assert.equal(target.transcript, transcript);
    assert.equal(target.sentinel, path.join(dir, `rollout-2026-09-04T00-00-00-${id}.watch-mode`));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("build identity prefers git and otherwise uses the entry mtime", async () => {
  const git = await installedBuild({
    version: "1.2.3",
    root: "/repo",
    entry: "/repo/bin/agora.mjs",
    run: /** @type {any} */ (async () => ({ stdout: `${"a".repeat(40)}\n2026-09-04T15:00:00-05:00\n`, stderr: "" })),
  });
  assert.deepEqual(git, { version: "1.2.3", source: "git", git: "a".repeat(40), at: "2026-09-04T20:00:00.000Z" });
  const fallback = await installedBuild({
    version: "1.2.3",
    root: "/copy",
    entry: "/copy/agora.mjs",
    run: /** @type {any} */ (async () => { throw new Error("not a worktree"); }),
    fileStat: /** @type {any} */ (async () => ({ mtime: new Date("2026-09-04T20:01:00Z") })),
  });
  assert.deepEqual(fallback, { version: "1.2.3", source: "mtime", at: "2026-09-04T20:01:00.000Z" });
  assert.equal(buildLabel(git), `1.2.3+${"a".repeat(8)}`);
  assert.equal(buildPredates(git, { ...git, git: "b".repeat(40), at: "2026-09-04T20:02:00.000Z" }), true);
  assert.equal(buildPredates(git, git), false);
  assert.equal(buildPredates(undefined, git), undefined);
});

test("touch writes only beside an existing transcript; clear removes it; absent is fine", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agora-harness-"));
  try {
    const env = { CLAUDE_CODE_SESSION_ID: "abcdef12-0000-4000-8000-000000000000" };
    assert.equal(watchModeSentinel(env, "/some/where", home), null, "no transcript, no target to write beside");
    const dir = path.join(home, ".claude", "projects", claudeProjectSlug(path.resolve("/some/where")));
    const transcript = path.join(dir, `${env.CLAUDE_CODE_SESSION_ID}.jsonl`);
    await mkdir(dir, { recursive: true });
    await writeFile(transcript, "", "utf8");
    const fromSubdir = watchModeSentinel(env, "/some/where/projects/agora", home);
    assert.ok(fromSubdir);
    assert.equal(fromSubdir.transcript, transcript, "a watch armed from a subdirectory finds the project root's transcript");
    const target = fromSubdir;
    const now = new Date("2026-09-03T23:40:00.000Z");
    assert.equal(await touchWatchMode(target, { now }), "created", "the path is worth announcing exactly once");
    assert.deepEqual(JSON.parse(await readFile(target.sentinel, "utf8")), { pid: process.pid, at: "2026-09-03T23:40:00.000Z" });
    assert.equal(await touchWatchMode(target), "refreshed", "a refresh is not an announcement");
    assert.ok((await stat(target.sentinel)).isFile());
    await clearWatchMode(target);
    await assert.rejects(stat(target.sentinel), { code: "ENOENT" });
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
    const dir = path.join(home, ".claude", "projects", claudeProjectSlug(path.resolve("/some/where")));
    const transcript = path.join(dir, `${env.CLAUDE_CODE_SESSION_ID}.jsonl`);
    await mkdir(dir, { recursive: true });
    await writeFile(transcript, "", "utf8");
    const target = watchModeSentinel(env, "/some/where", home);
    assert.ok(target);

    // the resident stream (this process) owns it; a one-shot watch in the same session is another pid
    assert.equal(await touchWatchMode(target), "created");
    const other = process.pid + 1_000_000; // a pid nothing answers
    assert.equal(await touchWatchMode(target, { pid: other }), "refreshed");
    assert.equal(JSON.parse(await readFile(target.sentinel, "utf8")).pid, process.pid, "a live owner keeps the file");
    await clearWatchMode(target, { pid: other });
    assert.ok((await stat(target.sentinel)).isFile(), "the short watch left the resident one's suppression alone");
    assert.equal(JSON.parse(await readFile(target.sentinel, "utf8")).pid, process.pid);
    await clearWatchMode(target);
    await assert.rejects(stat(target.sentinel), { code: "ENOENT" }, "the owner clears it");

    // an owner that is gone (killed without clearing) is not an owner: the next watch adopts the file
    await writeFile(target.sentinel, JSON.stringify({ pid: other, at: "2026-09-03T23:40:00.000Z" }), "utf8");
    assert.equal(await touchWatchMode(target), "refreshed");
    assert.equal(JSON.parse(await readFile(target.sentinel, "utf8")).pid, process.pid);

    // a bare-timestamp sentinel from an older build is unowned and adopted the same way
    await writeFile(target.sentinel, "2026-09-03T23:40:00.000Z\n", "utf8");
    assert.deepEqual(await readWatchMode(target), { at: "2026-09-03T23:40:00.000Z" });
    await clearWatchMode(target);
    await assert.rejects(stat(target.sentinel), { code: "ENOENT" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
