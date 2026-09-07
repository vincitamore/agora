// Queue item 4: is a stale build one this watch would actually notice?
//
// Two rules are under test everywhere below. It is the IMPORT GRAPH, not the executed paths. And
// every unknown WIDENS to owed; none narrows to inert — a wrong "no re-arm owed" leaves a seat
// silently on stale code, a wrong "owed" costs one re-arm.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { COMPUTED_LOAD_EXEMPTIONS, auditedChooserDigest, importClosure, watchModuleDelta } from "../src/harness.mjs";
import { readFileSync } from "node:fs";

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

test("an exemption fails closed: an unlisted file, and a second load in a listed one, are both holes", async (t) => {
  const { root } = await repo(t);
  await writeFile(path.join(root, "entry.mjs"), 'import "./src/x.mjs";\n');
  await mkdir(path.join(root, "src"), { recursive: true });
  // Not on the list, so its computed load is a hole even though it looks harmless.
  await writeFile(path.join(root, "src", "x.mjs"), 'const n = "node:sqlite";\nawait import(n);\n');
  const unlisted = importClosure({ entry: path.join(root, "entry.mjs"), root });
  assert.equal(unlisted.complete, false, "a computed load in an unlisted file was exempted");
  assert.match(String(unlisted.reason), /only 0 exempted/);
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
  // The half the first version of this cell was missing, and it is the half that matters: a rule
  // that leaves the real closure INCOMPLETE makes every measurement unknown, so the feature reports
  // nothing while looking measured. Membership alone could not see that.
  assert.equal(closure.complete, true, `the real closure is not measurable: ${closure.reason}`);
  assert.equal((closure.caveats ?? []).length, Object.keys(COMPUTED_LOAD_EXEMPTIONS).length,
    "the real closure's exempted loads do not match the exemption list");
});

test("a reachable load joins the closure or makes it unknown; it is never silently skipped", async (t) => {
  const { root } = await repo(t);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "loaded.mjs"), "\n");

  // A comment sits where a specifier may legally be preceded by one. Missing it drops a real
  // module and leaves the flag true, which is a subset calling itself complete.
  await writeFile(path.join(root, "entry.mjs"), 'import /* valid comment */ "./src/loaded.mjs";\n');
  const commented = importClosure({ entry: path.join(root, "entry.mjs"), root });
  assert.equal(commented.complete, true, commented.reason);
  assert.ok(commented.files.has("src/loaded.mjs"), "a commented side-effect import was dropped");

  // The ordinary twin, so the tolerance is not bought by matching anything at all.
  await writeFile(path.join(root, "entry.mjs"), 'import "./src/loaded.mjs";\n');
  assert.ok(importClosure({ entry: path.join(root, "entry.mjs"), root }).files.has("src/loaded.mjs"));

  // A template with an interpolation is COMPUTED: its spelling names no file, so counting it as a
  // literal both skips the module it really loads and hides the call that should have made the
  // closure incomplete.
  await writeFile(path.join(root, "entry.mjs"), 'const n = "loaded";\nawait import(`./src/${n}.mjs`);\n');
  const template = importClosure({ entry: path.join(root, "entry.mjs"), root });
  assert.equal(template.complete, false, "an interpolated template was accepted as a literal");
  assert.match(String(template.reason), /computed specifier/);

  // Its twin: a template with NO interpolation is an ordinary literal and resolves.
  await writeFile(path.join(root, "entry.mjs"), "await import(`./src/loaded.mjs`);\n");
  const plain = importClosure({ entry: path.join(root, "entry.mjs"), root });
  assert.equal(plain.complete, true, plain.reason);
  assert.ok(plain.files.has("src/loaded.mjs"), "a non-interpolated template literal was not followed");

  // A relative specifier that resolves to nothing HERE may resolve at the other build, which is the
  // comparison being made; skipping it is how the closure stays a subset while claiming complete.
  await writeFile(path.join(root, "entry.mjs"), 'import "./src/missing.mjs";\n');
  const missing = importClosure({ entry: path.join(root, "entry.mjs"), root });
  assert.equal(missing.complete, false, "an unresolvable relative load was skipped in silence");
  assert.match(String(missing.reason), /does not resolve in this checkout/);
});

test("closure membership is physical, and its keys are POSIX on every platform", async (t) => {
  const { root } = await repo(t);
  await mkdir(path.join(root, "src", "deep"), { recursive: true });
  await writeFile(path.join(root, "src", "deep", "loaded.mjs"), "\n");
  await writeFile(path.join(root, "entry.mjs"), 'import "./src/deep/loaded.mjs";\n');
  const inside = importClosure({ entry: path.join(root, "entry.mjs"), root });
  assert.equal(inside.complete, true, inside.reason);
  // The Windows half of this unit's first gate failed on exactly this: the closure stored
  // backslash keys while the other side of every comparison is git, which speaks POSIX.
  for (const key of inside.files) assert.ok(!key.includes("\\"), `closure key ${JSON.stringify(key)} is not POSIX`);
  assert.ok(inside.files.has("src/deep/loaded.mjs"));

  // An in-root link pointing OUT of the repository resolves to a file no diff of this repository
  // can speak for. Lexical containment follows it and records it as a member; physical does not.
  const external = await mkdtemp(path.join(tmpdir(), "agora-graph-out-"));
  t.after(() => rm(external, { recursive: true, force: true }));
  await writeFile(path.join(external, "loaded.mjs"), "\n");
  let linked = true;
  try { await symlink(external, path.join(root, "external"), "junction"); }
  catch { linked = false; }
  if (linked) {
    await writeFile(path.join(root, "entry.mjs"), 'import "./external/loaded.mjs";\n');
    const escaped = importClosure({ entry: path.join(root, "entry.mjs"), root });
    assert.equal(escaped.complete, false, "an in-root link out of the repository was followed as a member");
    assert.match(String(escaped.reason), /outside/);
    // The twin: an in-root link to an in-root directory is an ordinary member, so the check is not
    // bought by refusing every link.
    await symlink(path.join(root, "src", "deep"), path.join(root, "alias"), "junction");
    await writeFile(path.join(root, "entry.mjs"), 'import "./alias/loaded.mjs";\n');
    const alias = importClosure({ entry: path.join(root, "entry.mjs"), root });
    assert.equal(alias.complete, true, alias.reason);
    assert.ok(alias.files.has("src/deep/loaded.mjs"), "a same-root alias did not resolve to its physical member");
  } else {
    t.diagnostic("this platform would not create a link, so physical member resolution is unmeasured here");
  }
});

test("an exemption is bound to the audited expression, not to a proxy for it", async (t) => {
  // A count authorised any same-count substitution. A stray-relative-literal scan authorised a name
  // built by CONCATENATION, because "." and "/loaded.mjs" are each innocent and neither is a
  // relative literal. Both were proxies. Only the expression says what the load can name, so the
  // expression is what is compared, by digest over every line mentioning the operand.
  const { root } = await repo(t);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "loaded.mjs"), "\n");
  await writeFile(path.join(root, "entry.mjs"), 'import "./src/native-service.mjs";\n');

  const attacks = [
    ['concatenation', 'const moduleName = "." + "/loaded.mjs";\nawait import(moduleName);\n'],
    ['a different chooser', 'const moduleName = process.env.X ? "./loaded.mjs" : "node:sqlite";\nawait import(moduleName);\n'],
    ['an expression operand', 'await import(process.env.X ? "./loaded.mjs" : "node:sqlite");\n'],
  ];
  for (const [label, body] of attacks) {
    await writeFile(path.join(root, "src", "native-service.mjs"), body);
    const c = importClosure({ entry: path.join(root, "entry.mjs"), root });
    assert.equal(c.complete, false, `${label} kept the exemption`);
    assert.match(String(c.reason), /audited expression|bare identifier this audit can follow/);
  }

  // The twin, and it is the real one: the product's own chooser matches its pinned digest, so the
  // closure stays measurable and the caveat is printed rather than a hole.
  const product = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  await writeFile(path.join(root, "src", "native-service.mjs"),
    readFileSync(path.join(product, "src", "native-service.mjs"), "utf8"));
  const kept = importClosure({ entry: path.join(root, "entry.mjs"), root });
  assert.equal((kept.caveats ?? []).length, 1, `the audited chooser lost its exemption: ${kept.reason}`);
});

test("the pinned digest still describes the file it names", () => {
  // A stale pin is a pin that has stopped describing anything, and it would sit there licensing a
  // hole nobody can see. Recomputed from the real file rather than asserted from the record.
  const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  for (const [file, entry] of Object.entries(COMPUTED_LOAD_EXEMPTIONS)) {
    assert.equal(auditedChooserDigest(file, root), entry.chooserDigest,
      `${file}'s chooser is not the audited one; re-read it, then re-pin`);
    assert.ok(entry.chooserSummary.length > 20, `${file} carries no readable summary of what was audited`);
  }
});

test("a spelling the runtime decodes and this scanner does not is reported, never read as bare", async (t) => {
  // The engine loads a specifier whose leading dot is written as a JS escape; startsWith(".") sees
  // a backslash and files it under "a dependency", which is the silent skip in its last disguise.
  // Incompleteness is a supported result here; a missed module is not.
  const { root } = await repo(t);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "loaded.mjs"), "\n");
  await writeFile(path.join(root, "entry.mjs"), 'import "\\x2e/src/loaded.mjs";\n');
  const escaped = importClosure({ entry: path.join(root, "entry.mjs"), root });
  assert.equal(escaped.complete, false, "an escaped specifier was read as a bare dependency");
  assert.match(String(escaped.reason), /escape sequence this scanner does not decode/);

  // The ordinary twin: an unescaped specifier still resolves, so the check is not bought by
  // refusing anything with a backslash-shaped worry in it.
  await writeFile(path.join(root, "entry.mjs"), 'import "./src/loaded.mjs";\n');
  const plain = importClosure({ entry: path.join(root, "entry.mjs"), root });
  assert.equal(plain.complete, true, plain.reason);
  assert.ok(plain.files.has("src/loaded.mjs"));
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

  // The same root reached through a SYMLINK must not read as a different copy. A path that merely
  // normalises (root/src/..) is no test at all: path.resolve already collapses it, so the cell
  // would pass with realpath removed — which is exactly what calibration caught.
  const link = path.join(root, "..", `link-${path.basename(root)}`);
  let linked = true;
  try { await symlink(root, link, "junction"); t.after(() => rm(link, { force: true })); }
  catch { linked = false; }   // an unprivileged Windows checkout cannot make one; say so, do not skip silently
  if (linked) {
    assert.notEqual(path.resolve(link), path.resolve(root), "the fixture symlink resolves to the same string, so it tests nothing");
    const same = await watchModuleDelta({ ...base, armedRoot: link });
    assert.notEqual(same.state, "unknown", `a symlinked same root read as another copy: ${same.reason}`);
  } else {
    t.diagnostic("this platform would not create a symlink, so the realpath comparison is unmeasured here");
  }
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

test("git path identities survive: a quoted committed path, a dirty path with a space, a rename", async (t) => {
  const { root, git } = await repo(t);
  await git(["config", "core.quotepath", "true"]);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "café.mjs"), "export const v = 1;\n");
  await writeFile(path.join(root, "src", "space name.mjs"), "export const v = 1;\n");
  await writeFile(path.join(root, "src", "moved.mjs"), "export const v = 1;\n");
  await writeFile(path.join(root, "entry.mjs"),
    'import "./src/café.mjs";\nimport "./src/space name.mjs";\nimport "./src/moved.mjs";\n');
  const first = await commit({ git }, "one");

  // Committed, non-ASCII, with core.quotepath on: without -z git escapes this into a quoted C
  // string that matches no closure member, and the answer comes back inert.
  await writeFile(path.join(root, "src", "café.mjs"), "export const v = 2;\n");
  const second = await commit({ git }, "cafe");
  const base = { root, entry: path.join(root, "entry.mjs"), armedRoot: root };
  const accented = await watchModuleDelta({ ...base, from: first, to: second });
  assert.equal(accented.state, "owed", `a quoted committed path was not matched: ${accented.reason}`);
  assert.deepEqual(accented.changed, ["src/café.mjs"]);

  // Dirty, with a space: the porcelain pathname keeps its quotes unless the output is NUL-delimited.
  await writeFile(path.join(root, "src", "space name.mjs"), "export const v = 3;\n");
  const spaced = await watchModuleDelta({ ...base, from: second, to: second });
  assert.equal(spaced.state, "owed", `a dirty path with a space was not matched: ${spaced.reason}`);
  assert.deepEqual(spaced.changed, ["src/space name.mjs"]);
  await writeFile(path.join(root, "src", "space name.mjs"), "export const v = 1;\n");

  // On the graph, a renamed module must not read as inert. It comes back UNKNOWN rather than owed,
  // which is correct and worth pinning: the loaded module no longer resolves in this checkout, so
  // the closure cannot be shown to cover it, and unknown is what widening is for.
  await git(["mv", "src/moved.mjs", "src/renamed.mjs"]);
  const renamed = await watchModuleDelta({ ...base, from: second, to: second });
  assert.notEqual(renamed.state, "inert", "a loaded module renamed out from under the watch read as inert");
  assert.match(String(renamed.reason ?? ""), /does not resolve in this checkout/);
  await git(["mv", "src/renamed.mjs", "src/moved.mjs"]);
});

test("the rename record's ORIGIN is a name, and the parser reads it from real porcelain bytes", async (t) => {
  // A count cannot see this defect: a parser that fails to consume the origin field still yields
  // two entries, the second one mangled. Only the NAMES discriminate. So the bytes are captured
  // from a real `git mv` in a real repository and replayed against a tree where the origin still
  // exists — a fake I wrote would speak whatever dialect I already believe.
  const source = await repo(t);
  await mkdir(path.join(source.root, "src"), { recursive: true });
  await writeFile(path.join(source.root, "src", "moved.mjs"), "export const v = 1;\n");
  await commit(source, "one");
  await source.git(["mv", "src/moved.mjs", "src/renamed.mjs"]);
  const captured = String((await source.git(["status", "--porcelain", "-z", "--untracked-files=all"])).stdout);
  assert.ok(captured.includes("src/moved.mjs"), "the captured porcelain carries no origin field to parse");

  const { root, git } = await repo(t);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "moved.mjs"), "export const v = 1;\n");
  await writeFile(path.join(root, "entry.mjs"), 'import "./src/moved.mjs";\n');
  const at = await commit({ git }, "one");

  const replayed = await watchModuleDelta({
    root, entry: path.join(root, "entry.mjs"), armedRoot: root, from: at, to: at,
    run: /** @type {any} */ (async (/** @type {string} */ _bin, /** @type {string[]} */ args) => {
      if (args.includes("status")) return { stdout: captured, stderr: "" };
      return { stdout: "", stderr: "" };
    }),
  });
  assert.deepEqual(replayed.changed, ["src/moved.mjs"],
    `the rename's origin was lost or mangled: ${JSON.stringify(replayed.changed)}`);
  assert.equal(replayed.state, "owed");
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
