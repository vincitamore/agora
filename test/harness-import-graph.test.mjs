// Queue item 4: is a stale build one this watch would actually notice?
//
// Two rules are under test everywhere below. It is the IMPORT GRAPH, not the executed paths. And
// every unknown WIDENS to owed; none narrows to inert — a wrong "no re-arm owed" leaves a seat
// silently on stale code, a wrong "owed" costs one re-arm.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { importClosure, watchModuleDelta } from "../src/harness.mjs";

const run = promisify(execFile);

/** A real repository, because the measurement is a real `git diff` and a real `git status`.
 * @param {import('node:test').TestContext} t */
async function repo(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-graph-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (/** @type {string[]} */ args) => run("git", ["-C", root, ...args], { windowsHide: true });
  await git(["init", "-q", "-b", "main"]);
  await git(["config", "user.email", "cell@example.invalid"]);
  await git(["config", "user.name", "cell"]);
  return { root, git };
}
/** @param {{ git: (a: string[]) => Promise<any> }} r @param {string} message */
async function commit(r, message) {
  await r.git(["add", "-A"]);
  await r.git(["commit", "-q", "-m", message]);
  const { stdout } = await r.git(["show", "-s", "--format=%H%n%cI", "HEAD"]);
  const [git, at] = String(stdout).trim().split(/\r?\n/);
  return { version: "0.0.0", source: /** @type {const} */ ("git"), git, at: new Date(at).toISOString() };
}

// ------------------------------------------------------------------------ the closure

test("the closure follows every static form, in whatever shape it is written", async (t) => {
  const { root } = await repo(t);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "entry.mjs"), [
    // a multi-line import: a scanner that reads one line at a time misses the specifier entirely,
    // and an omitted module makes the closure a SUBSET, the one direction that can say inert falsely
    'import {',
    '  a,',
    '  b,',
    '} from "./src/multi.mjs";',
    "import { c } from './src/single.mjs';",   // single quotes
    'export * from "./src/reexport.mjs";',      // a re-export is a load
    'import "./src/side.mjs";',                 // side effect only
    'const x = await import("./src/dynamic.mjs");',   // literal dynamic: resident on the path that runs it
    'import { createRequire } from "node:module";',
    'const require = createRequire(import.meta.url);',
    'const pkg = require("./package.json");',   // a literal require resolves like any other load
    'import fs from "node:fs";',                // a builtin is not in the repo and terminates
  ].join("\n"));
  for (const name of ["multi", "single", "reexport", "side", "dynamic"])
    await writeFile(path.join(root, "src", `${name}.mjs`), name === "multi" ? 'import "./nested.mjs";\n' : "\n");
  await writeFile(path.join(root, "src", "nested.mjs"), "\n");
  await writeFile(path.join(root, "package.json"), "{}\n");

  const closure = importClosure({ entry: path.join(root, "entry.mjs"), root });
  assert.equal(closure.complete, true, closure.reason);
  for (const file of ["entry.mjs", "src/multi.mjs", "src/single.mjs", "src/reexport.mjs",
    "src/side.mjs", "src/dynamic.mjs", "src/nested.mjs", "package.json"])
    assert.ok(closure.files.has(file), `${file} is not on the closure`);
});

test("a load the graph cannot resolve makes the whole closure unknown, never a smaller set", async (t) => {
  const { root } = await repo(t);
  const cases = [
    ["a computed dynamic import", 'const name = "./x.mjs";\nawait import(name);\n', /dynamic import call/],
    ["a computed require", 'import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\nconst n = "./x";\nrequire(n);\n', /require call/],
  ];
  for (const [label, source, reason] of cases) {
    await writeFile(path.join(root, "entry.mjs"), String(source));
    const closure = importClosure({ entry: path.join(root, "entry.mjs"), root });
    assert.equal(closure.complete, false, `${label} left the closure claiming to be complete`);
    assert.match(String(closure.reason), /** @type {RegExp} */ (reason));
  }
});

test("a module outside the root is unknown, not quietly dropped from the intersection", async (t) => {
  const { root } = await repo(t);
  const outside = path.join(root, "..", `outside-${path.basename(root)}.mjs`);
  await writeFile(outside, "\n");
  t.after(() => rm(outside, { force: true }));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "entry.mjs"), `import "../${path.basename(outside)}";\n`);
  const closure = importClosure({ entry: path.join(root, "entry.mjs"), root });
  assert.equal(closure.complete, false, "a module no diff of this repo can speak for was dropped silently");
  assert.match(String(closure.reason), /outside/);
});

test("the real entry: the census that catches a rule which quietly disables the measurement", async () => {
  // This cell exists because the first shape of the require rule was "any createRequire makes the
  // closure incomplete". The entry uses exactly one, with a literal specifier, to read its own
  // package.json — so that rule would have made the real closure permanently incomplete, the inert
  // state unreachable, and the whole measurement a warning that always fires while appearing to
  // have been measured. Nothing but running it on the real tree shows that.
  const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const closure = importClosure({ entry: path.join(root, "bin", "agora.mjs"), root });
  for (const file of ["bin/agora.mjs", "src/session.mjs", "src/harness.mjs", "src/watch.mjs", "package.json"])
    assert.ok(closure.files.has(file), `${file} is not on the real entry's closure`);
  assert.ok(closure.files.size > 30, `the real closure is only ${closure.files.size} files`);
});

// ------------------------------------------------------------------------ the measurement

test("without a recorded root nothing can be claimed, and two roots are compared by realpath", async (t) => {
  const { root } = await repo(t);
  await writeFile(path.join(root, "entry.mjs"), "\n");
  const first = await commit({ git: (/** @type {string[]} */ a) => run("git", ["-C", root, ...a], { windowsHide: true }) }, "one");
  const base = { root, entry: path.join(root, "entry.mjs"), from: first, to: first };

  const noRoot = await watchModuleDelta(base);
  assert.equal(noRoot.state, "unknown");
  assert.match(String(noRoot.reason), /recorded no root/);

  const elsewhere = await watchModuleDelta({ ...base, armedRoot: path.join(root, "..", "another") });
  assert.equal(elsewhere.state, "unknown");
  assert.match(String(elsewhere.reason), /says nothing about another copy/);

  // The same root reached by a different string must not read as a different copy.
  const same = await watchModuleDelta({ ...base, armedRoot: path.join(root, "src", "..") });
  assert.notEqual(same.state, "unknown", same.reason);
});

test("a build with no commit, and a commit this repo does not have, are both unknown", async (t) => {
  const { root, git } = await repo(t);
  await writeFile(path.join(root, "entry.mjs"), "\n");
  const first = await commit({ git }, "one");
  const base = { root, entry: path.join(root, "entry.mjs"), armedRoot: root, to: first };

  const mtime = await watchModuleDelta({ ...base, from: { version: "0.0.0", source: "mtime", at: first.at } });
  assert.equal(mtime.state, "unknown");
  assert.match(String(mtime.reason), /file time/);

  const absent = await watchModuleDelta({ ...base, from: { ...first, git: "0".repeat(40) } });
  assert.equal(absent.state, "unknown");
  assert.match(String(absent.reason), /is not in/);
});

test("a git diff that FAILS is unknown; a non-zero exit is not an empty change list", async (t) => {
  const { root, git } = await repo(t);
  await writeFile(path.join(root, "entry.mjs"), "\n");
  const first = await commit({ git }, "one");
  const broken = await watchModuleDelta({
    root, entry: path.join(root, "entry.mjs"), armedRoot: root, from: first, to: first,
    run: /** @type {any} */ (async (/** @type {string} */ _bin, /** @type {string[]} */ args) => {
      if (args.includes("diff")) throw new Error("fatal: something went wrong");
      return { stdout: "", stderr: "" };
    }),
  });
  assert.equal(broken.state, "unknown", "a failed diff was read as nothing having changed");
  assert.match(String(broken.reason), /could not be read/);
});

test("an uncommitted edit to a loaded module is owed, though no commit diff can see it", async (t) => {
  // The campaign's normal case: a shared trunk that is dirty for hours. A watch loaded the working
  // tree at arm time, this process reads the working tree now, and a peer's uncommitted edit to a
  // module on the closure is exactly what a seat needs to know about.
  const { root, git } = await repo(t);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "entry.mjs"), 'import "./src/loaded.mjs";\n');
  await writeFile(path.join(root, "src", "loaded.mjs"), "export const v = 1;\n");
  await writeFile(path.join(root, "src", "unloaded.mjs"), "export const v = 1;\n");
  const first = await commit({ git }, "one");
  const base = { root, entry: path.join(root, "entry.mjs"), armedRoot: root, from: first, to: first };

  // Same sha at both ends and a clean tree: nothing moved.
  assert.equal((await watchModuleDelta(base)).state, "inert");

  // A module NOT on the closure moves: still inert, or the measurement is just "is the tree dirty".
  await writeFile(path.join(root, "src", "unloaded.mjs"), "export const v = 2;\n");
  assert.equal((await watchModuleDelta(base)).state, "inert", "a change off the import graph was reported as owed");

  // A module ON the closure moves, uncommitted: owed, and it names the file.
  await writeFile(path.join(root, "src", "loaded.mjs"), "export const v = 2;\n");
  const owed = await watchModuleDelta(base);
  assert.equal(owed.state, "owed", "an uncommitted edit to a loaded module was reported as inert");
  assert.deepEqual(owed.changed, ["src/loaded.mjs"]);
});

test("a commit that moves a loaded module is owed; one that moves only unloaded files is inert", async (t) => {
  const { root, git } = await repo(t);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "entry.mjs"), 'import "./src/loaded.mjs";\n');
  await writeFile(path.join(root, "src", "loaded.mjs"), "export const v = 1;\n");
  await writeFile(path.join(root, "docs.md"), "one\n");
  const first = await commit({ git }, "one");

  await writeFile(path.join(root, "docs.md"), "two\n");
  const second = await commit({ git }, "docs only");
  const base = { root, entry: path.join(root, "entry.mjs"), armedRoot: root };
  const inert = await watchModuleDelta({ ...base, from: first, to: second });
  assert.equal(inert.state, "inert", inert.reason);
  assert.equal(inert.scanned, 1, "the file that changed was not counted");

  await writeFile(path.join(root, "src", "loaded.mjs"), "export const v = 3;\n");
  const third = await commit({ git }, "a loaded module");
  const owed = await watchModuleDelta({ ...base, from: first, to: third });
  assert.equal(owed.state, "owed");
  assert.deepEqual(owed.changed, ["src/loaded.mjs"]);
});
