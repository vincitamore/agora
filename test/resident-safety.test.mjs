// @ts-check
// What a resident may call and what it is told about a delivery. A row's `deny` reaches the harness's
// own settings; absent or empty it denies nothing. The preamble is on unless a row says otherwise. A
// room the public can post in is refused for a resident until it carries a wake list.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_TOOLS, claudeDenied, manifestRow, ompOverlay, planResident, prepareRun, validateManifest } from "../src/resident-start.mjs";
import { resolveOmpConfig } from "../plugins/omp/agora-room/index.mjs";
import { resolveConfig } from "../plugins/claude/agora-room/hooks/lib.js";

const BIN = fileURLToPath(new URL("../bin/agora.mjs", import.meta.url));
const CHECKOUT = fileURLToPath(new URL("../", import.meta.url));
const EXTENSION = path.join(CHECKOUT, "plugins", "omp", "agora-room").replace(/\\/g, "/");

/**
 * A seat in a temp root: a config with one local room (more by `extraRooms`), a manifest folder with a
 * profile, and fake `omp` and `claude` executables on a PATH of their own.
 * @param {import("node:test").TestContext} t @param {Record<string, Record<string, unknown>>} [extraRooms]
 */
async function seat(t, extraRooms = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-rsafe-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const state = path.join(root, "state");
  const mdir = path.join(root, "team");
  const bin = path.join(root, "bin");
  await mkdir(mdir, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(mdir, "PROFILE.md"), "# Ada\n\nThe profile.\n");
  for (const n of ["omp", "claude"]) for (const ext of ["", ".exe", ".com"]) await writeFile(path.join(bin, n + ext), "");
  const cfg = { actor: { name: "Grace", kind: "agent" }, rooms: { lab: { transport: "local", path: path.join(root, "lab.ndjson") }, ...extraRooms } };
  const config = path.join(root, "config.json");
  await writeFile(config, JSON.stringify(cfg));
  return { root, state, mdir, file: path.join(mdir, "residents.json"), env: { PATH: bin, PATHEXT: ".COM;.EXE" }, cfg: { ...cfg, path: config } };
}

/** A manifest of the rows given over a host-less omp default. @param {Record<string, any>} rows @param {Record<string, unknown>} [defaults] */
const doc = (rows, defaults = {}) => ({
  version: 1, models: { small: "vendor/claude-haiku-9:medium" },
  defaults: { harness: "omp", model: "small", rooms: ["lab"], profile: "PROFILE.md", host: "none", ...defaults },
  residents: rows,
});

/** @param {Awaited<ReturnType<typeof seat>>} s @param {Record<string, unknown>} [extra] */
const ctxOf = (s, extra = {}) => ({ cfg: s.cfg, stateRoot: s.state, checkout: CHECKOUT, entry: BIN, node: "node-bin", env: s.env, platform: process.platform, ...extra });

// ---------------------------------------------------------------------------------------------

test("preamble: a row that says nothing leaves the harness's own default, which is on; a row may still turn it off for a room the public cannot post in", async (t) => {
  const s = await seat(t);
  const m = validateManifest(doc({ "lab.coding": { role: "coding" }, "lab.quiet": { role: "quiet", preamble: "off" } }), s.file);
  const said = planResident(m, "lab.coding", ctxOf(s));
  assert.equal(said.env.AGORA_ROOM_PREAMBLE, undefined, "the manifest names none, so nothing overrides the harness");
  assert.equal(resolveOmpConfig({ env: said.env, sessionId: "s1" }).preamble, true, "omp's extension: on");
  assert.equal(resolveConfig({ env: said.env }).preamble, true, "the Claude Code plugin: on");
  const quiet = planResident(m, "lab.quiet", ctxOf(s));
  assert.equal(quiet.env.AGORA_ROOM_PREAMBLE, "off", "red leg: an explicit off still reaches the harness");
  assert.equal(resolveOmpConfig({ env: quiet.env, sessionId: "s1" }).preamble, false);
});

test("deny: a declared list is written under tools.approval in omp's settings overlay, and the overlay is the file the start writes; the approval mode stays yolo (red leg: no list, no entry)", async (t) => {
  const s = await seat(t);
  const m = validateManifest(doc({
    "lab.reader": { role: "reader", deny: ["write", "edit", "bash", "eval"] },
    "lab.plain": { role: "plain" },
  }), s.file);
  const reader = planResident(m, "lab.reader", ctxOf(s));
  assert.deepEqual(reader.deny, ["write", "edit", "bash", "eval"]);
  assert.equal(reader.overlayText, ompOverlay(EXTENSION, null, ["write", "edit", "bash", "eval"]));
  assert.equal(reader.overlayText, `extensions:\n  - ${JSON.stringify(EXTENSION)}\ntools:\n  approval:\n    "write": "deny"\n    "edit": "deny"\n    "bash": "deny"\n    "eval": "deny"\n`);
  for (const kept of ["read", "grep", "task", "find"]) assert.doesNotMatch(String(reader.overlayText), new RegExp(`"${kept}"`), `${kept} stays allowed, so omp can still run it speculatively`);
  const at = reader.argv.indexOf("--approval-mode");
  assert.deepEqual([reader.argv[at], reader.argv[at + 1]], ["--approval-mode", "yolo"], "the list holds under yolo, which an unattended resident needs");
  assert.equal(reader.argv[reader.argv.indexOf("--config") + 1], reader.overlay, "the overlay is passed with --config");

  await prepareRun(reader, { checkout: CHECKOUT, home: s.root });
  assert.equal(await readFile(String(reader.overlay), "utf8"), reader.overlayText, "the start writes exactly the planned overlay");

  const plain = planResident(m, "lab.plain", ctxOf(s));
  assert.deepEqual(plain.deny, []);
  assert.equal(plain.overlayText, ompOverlay(EXTENSION, null), "red leg: a row with no deny gets the overlay it always had");
  assert.doesNotMatch(String(plain.overlayText), /tools|approval|deny/);
});

test("deny: absent and an empty list both deny nothing, in the file and through defaults; a row's own list replaces the defaults'; a messenger row holds no tools (red legs: each)", async (t) => {
  const s = await seat(t);
  const m = validateManifest(doc({
    "lab.none": { role: "none" },
    "lab.empty": { role: "empty", deny: [] },
    "lab.own": { role: "own", deny: ["edit", "edit", "write"] },
    "lab.messenger": { role: "messenger", harness: "agora", wake: "all" },
  }, { deny: ["bash"] }), s.file);
  assert.deepEqual(m.residents["lab.none"].deny, ["bash"], "a row inherits the defaults' list");
  assert.deepEqual(m.residents["lab.empty"].deny, [], "its own empty list opts out of it");
  assert.deepEqual(m.residents["lab.own"].deny, ["edit", "write"], "its own list replaces it, each name once");
  assert.deepEqual(m.residents["lab.messenger"].deny, [], "a messenger runs code and holds no tools");
  assert.equal(planResident(m, "lab.messenger", ctxOf(s)).overlayText, null);

  const bare = validateManifest(doc({ "lab.a": { role: "a" } }), s.file);
  assert.deepEqual(bare.residents["lab.a"].deny, [], "nothing is denied unless a manifest names it: there is no default list");
});

test("deny: a name is a tool name; a pattern, a name that is not a string and a non-list are refused with the file and the field named", async (t) => {
  const s = await seat(t);
  /** @param {unknown} deny @param {RegExp} re */
  const refuses = (deny, re) => assert.throws(() => validateManifest(doc({ "lab.a": { role: "a", deny } }), s.file), (e) => {
    const msg = /** @type {Error} */ (e).message;
    assert.ok(msg.startsWith(s.file), `names the file: ${msg}`);
    assert.match(msg, re);
    return true;
  });
  refuses("bash", /residents\.lab\.a\.deny: must be a list of non-empty strings/);
  refuses([""], /residents\.lab\.a\.deny: must be a list of non-empty strings/);
  refuses([3], /residents\.lab\.a\.deny: must be a list of non-empty strings/);
  refuses(["Bash(git *)"], /residents\.lab\.a\.deny: "Bash\(git \*\)" does not match/);
  refuses(["../x"], /residents\.lab\.a\.deny: "\.\.\/x" does not match/);
  for (const ok of ["bash", "ast_edit", "Bash", "WebFetch", "mcp__server__tool", "a.b-c"])
    assert.deepEqual(validateManifest(doc({ "lab.a": { role: "a", deny: [ok] } }), s.file).residents["lab.a"].deny, [ok], ok);
});

test("deny: Claude Code gets one --disallowedTools argument ahead of the bypass flag; the names map to its tools, eval to none, anything else as written (red leg: no list, no flag)", async (t) => {
  const s = await seat(t);
  const m = validateManifest(doc({
    "lab.reader": { role: "reader", harness: "claude", model: "claude-sonnet-9", deny: ["bash", "write", "edit", "eval", "WebFetch", "write"] },
    "lab.plain": { role: "plain", harness: "claude", model: "claude-sonnet-9" },
  }), s.file);
  const p = planResident(m, "lab.reader", ctxOf(s));
  const at = p.argv.indexOf("--disallowedTools");
  assert.ok(at > 0, p.argv.join(" "));
  assert.equal(p.argv[at + 1], "Bash,Write,Edit,MultiEdit,NotebookEdit,WebFetch");
  assert.equal(p.argv[at + 2], "--dangerously-skip-permissions", "an option follows the list, so the first prompt after the options is never read as one more tool name");
  assert.equal(p.argv.filter((a) => a === "--disallowedTools").length, 1);
  assert.equal(p.overlayText, null, "no omp overlay under Claude Code");
  assert.ok(p.argv.at(-1)?.startsWith("You are the lab.reader resident"), "the first prompt is still last");

  const plain = planResident(m, "lab.plain", ctxOf(s));
  assert.ok(!plain.argv.includes("--disallowedTools"));
  assert.deepEqual(plain.argv.slice(1, -1), ["--system-prompt", ".", "--append-system-prompt-file", path.join(plain.dir, "prompt.md"), "--plugin-dir", path.join(CHECKOUT, "plugins", "claude", "agora-room"), "--dangerously-skip-permissions", "--model", "claude-sonnet-9"]);
  assert.deepEqual(claudeDenied(["eval"]), [], "omp's code-running tool has no Claude Code tool of that name");
});

// Pinned by exact equality: a name added here is a tool every resident that denies it loses under
// Claude Code, and a name left out passes through as written, so the table is a reviewed change.
test("the Claude Code tool map is exactly these four names", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(CLAUDE_TOOLS)), { bash: ["Bash"], write: ["Write"], edit: ["Edit", "MultiEdit", "NotebookEdit"], eval: [] });
});

test("deny: a granted position is built from its base row's raw fields, so it carries that row's deny (red leg: a row with none)", async (t) => {
  const s = await seat(t);
  const m = validateManifest(doc({ "lab.reader": { role: "reader", deny: ["bash"], tenure: "on-demand", max: 2 }, "lab.open": { role: "open", tenure: "on-demand", max: 2 } }), s.file);
  const base = /** @type {Record<string, any>} */ (m.raw.residents);
  assert.deepEqual(manifestRow(m, "lab.reader-2", { ...base["lab.reader"], tenure: "on-demand", max: 1 }).deny, ["bash"]);
  assert.deepEqual(manifestRow(m, "lab.open-2", { ...base["lab.open"], tenure: "on-demand", max: 1 }).deny, []);
});

test("rooms: a resident naming a room the public can post in is refused until it has a wake list or is declared private; the plan names such rooms", async (t) => {
  const issue = { transport: "github", repo: "example-org/example-repo", issue: 7 };
  const s = await seat(t, {
    support: { ...issue },
    guarded: { ...issue, wakeFrom: ["maintainer"] },
    closed: { ...issue, public: false },
    feed: { transport: "github-events", repo: "example-org/example-repo" },
    forum: { transport: "local", path: "forum.ndjson", public: true },
  });
  const m = validateManifest(doc({
    "lab.coding": { role: "coding", rooms: ["lab", "support"], preamble: "off" },
    "lab.guard": { role: "guard", rooms: ["lab", "guarded"], preamble: "off" },
    "lab.closed": { role: "closed", rooms: ["closed"] },
    "lab.feed": { role: "feed", rooms: ["feed"] },
    "lab.forum": { role: "forum", rooms: ["forum"] },
  }), s.file);

  for (const [slug, room] of [["lab.coding", "support"], ["lab.feed", "feed"], ["lab.forum", "forum"]]) {
    assert.throws(() => planResident(m, slug, ctxOf(s)), (e) => {
      const err = /** @type {import("../src/core.mjs").AgoraError} */ (e);
      assert.equal(err.exitCode, 1);
      assert.match(err.message, new RegExp(`^resident ${slug.replace(".", "\\.")}: room "${room}" is reachable by the public`));
      assert.match(err.message, /wakeFrom/);
      assert.match(err.message, /"public": false/);
      return true;
    }, `${slug} names ${room}`);
  }

  const guard = planResident(m, "lab.guard", ctxOf(s));
  assert.deepEqual(guard.publicRooms, ["guarded"], "listed rooms the public can post in are named, so the operator sees where the preamble is forced");
  assert.equal(guard.env.AGORA_ROOM_PREAMBLE, "off", "the row's own switch is left as written: the extension frames a public room's messages whatever it says");
  assert.deepEqual(planResident(m, "lab.closed", ctxOf(s)).publicRooms, [], "declared private: no list is needed");
  assert.throws(() => planResident(m, "lab.guard", ctxOf(s, { room: "support" })), /room "support" is reachable by the public/, "--room replaces the rooms, and the replacement is checked too");
  assert.deepEqual(planResident(m, "lab.coding", ctxOf(s, { room: "lab" })).publicRooms, []);
});
