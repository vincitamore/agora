// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { readCursor, readCursorFile, writeCursor } from "../src/core.mjs";
import {
  BEARER_RE,
  appendPosted,
  identityLine,
  listSessions,
  readCursorSeeded,
  readPosted,
  resolveBearer,
  resolveSession,
  sessionDir,
  sessionTag,
} from "../src/session.mjs";
import { actor, tmp } from "./helpers.mjs";

const cfg = /** @type {import('../src/core.mjs').Config} */ ({ actor, rooms: { r: { transport: "local", path: "r.ndjson" } } });

test("session key: AGORA_SESSION, then the first set harness variable, then default", () => {
  assert.deepEqual(resolveSession(cfg, { AGORA_SESSION: "grace-a" }), { slug: "grace-a", source: "AGORA_SESSION", explicit: true });
  assert.deepEqual(resolveSession(cfg, { CLAUDE_CODE_SESSION_ID: "2bfa6030-9abd-48d4-835f-53c4123fb0ed" }), {
    slug: "claude-code-2bfa6030-9abd-48d4-835f-53c4123fb0ed", source: "CLAUDE_CODE_SESSION_ID", explicit: false,
  });
  assert.deepEqual(resolveSession(cfg, {}), { slug: "default", source: "default", explicit: false });
  assert.equal(sessionTag("GROK_SESSION_ID"), "grok");
  assert.equal(sessionTag("MY_HARNESS_SESSION"), "my-harness");
  assert.throws(() => resolveSession(cfg, { AGORA_SESSION: "a/b" }), /AGORA_SESSION must match/);
  assert.throws(() => resolveSession(cfg, { AGORA_SESSION: "" }), /AGORA_SESSION must match/);
});

test("session key: a harness value that is not a key is skipped; a credential-shaped name is never read", () => {
  /** @type {string[]} */
  const warned = [];
  const withList = { ...cfg, session: { from: ["MY_TOKEN", "HARNESS_SESSION_ID", "OTHER_ID"] } };
  const s = resolveSession(withList, { MY_TOKEN: "xoxb-secret", HARNESS_SESSION_ID: "has/slash", OTHER_ID: "ok-1" }, (l) => warned.push(l));
  assert.deepEqual(s, { slug: "other-ok-1", source: "OTHER_ID", explicit: false });
  assert.equal(warned.length, 2);
  assert.match(warned[0], /MY_TOKEN.*credential/);
  assert.doesNotMatch(warned.join("\n"), /xoxb/, "a credential-shaped variable's value is never printed");
  assert.match(warned[1], /HARNESS_SESSION_ID.*skipped/);
});

test("bearer: --as, then AGORA_ACTOR, then the config; paths validated at the boundary", () => {
  assert.deepEqual(resolveBearer(cfg, { as: "Grace/watch", env: { AGORA_ACTOR: "Opus" } }), { name: "Grace/watch", source: "--as" });
  assert.deepEqual(resolveBearer(cfg, { env: { AGORA_ACTOR: "Opus/design" } }), { name: "Opus/design", source: "AGORA_ACTOR" });
  assert.deepEqual(resolveBearer(cfg, { env: {} }), { name: actor.name, source: "config" });
  assert.throws(() => resolveBearer(cfg, { env: { AGORA_ACTOR: "Grace/" } }), /bearer path/);
  assert.throws(() => resolveBearer(cfg, { env: { AGORA_ACTOR: "Grace watch" } }), /bearer path/);
  assert.throws(() => resolveBearer(cfg, { as: "x".repeat(65), env: {} }), /bearer path/);
  assert.ok(BEARER_RE.test("Grok/build"));
  assert.ok(!BEARER_RE.test("/lead"));
});

test("a session with no cursor seeds once from the shared file and writes forward; the shared file is never written", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const root = dir;
    const sdir = sessionDir(root, { slug: "s1", source: "AGORA_SESSION", explicit: true });
    await writeCursor(root, "r", "17");
    const before = await readFile(path.join(root, "r.cursor"), "utf8");

    let got = await readCursorSeeded(sdir, root, "r");
    assert.deepEqual(got, { cursor: "17", seeded: true });
    assert.equal(await readCursor(sdir, "r"), "17", "written forward into the session");
    got = await readCursorSeeded(sdir, root, "r");
    assert.deepEqual(got, { cursor: "17", seeded: false }, "second read is the session's own");

    await writeCursor(sdir, "r", "40");
    assert.equal(await readFile(path.join(root, "r.cursor"), "utf8"), before, "the shared file is byte-identical");
    assert.equal((await readCursorSeeded(sdir, root, "r")).cursor, "40");

    const other = sessionDir(root, { slug: "s2", source: "AGORA_SESSION", explicit: true });
    assert.deepEqual(await readCursorSeeded(other, root, "r"), { cursor: "17", seeded: true }, "another session seeds from the shared file, not from s1");
    assert.deepEqual(await listSessions(root), ["s1", "s2"]);
  } finally {
    await cleanup();
  }
});

test("cursor --reset leaves a null position, which is not an absence: it never re-seeds", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const sdir = sessionDir(dir, { slug: "s1", source: "AGORA_SESSION", explicit: true });
    await writeCursor(dir, "r", "17");
    assert.equal((await readCursorSeeded(sdir, dir, "r")).cursor, "17");
    await writeCursor(sdir, "r", undefined); // what `cursor --reset` does
    const f = await readCursorFile(sdir, "r");
    assert.deepEqual(f, { exists: true, cursor: undefined });
    assert.deepEqual(await readCursorSeeded(sdir, dir, "r"), { cursor: undefined, seeded: false }, "reads from the start, does not fall back to 17");
    assert.deepEqual(await readCursorSeeded(sdir, dir, "absent"), { cursor: undefined, seeded: false });
  } finally {
    await cleanup();
  }
});

test("the posted-id ledger: append, read, and the ring", async () => {
  const { dir, cleanup } = await tmp();
  try {
    assert.equal((await readPosted(dir)).size, 0, "no ledger is an empty set");
    await appendPosted(dir, "a1");
    await appendPosted(dir, "a2");
    const ids = await readPosted(dir);
    assert.ok(ids.has("a1") && ids.has("a2") && !ids.has("a3"));
    for (let i = 0; i < 2001; i++) await appendPosted(dir, `x${i}`);
    const after = await readPosted(dir);
    assert.ok(after.size >= 1000 && after.size < 1100, `ring kept to about the last thousand, got ${after.size}`);
    assert.ok(after.has("x2000") && !after.has("a1"));
  } finally {
    await cleanup();
  }
});

test("the identity line names bearer, session and their sources, and warns on a shared default with siblings", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const bearer = { name: "Grace/watch", source: "AGORA_ACTOR" };
    let line = await identityLine(bearer, { slug: "default", source: "default", explicit: false }, dir);
    assert.equal(line, "agora: Grace/watch (from AGORA_ACTOR) · session default (from default)");
    await writeCursor(sessionDir(dir, { slug: "other", source: "AGORA_SESSION", explicit: true }), "r", "1");
    line = await identityLine(bearer, { slug: "default", source: "default", explicit: false }, dir);
    assert.match(line, /WARNING session key is "default" and 1 other session has state here/);
    line = await identityLine(bearer, { slug: "claude-code-2bfa6030-9abd-48d4-835f-53c4123fb0ed", source: "CLAUDE_CODE_SESSION_ID", explicit: false }, dir);
    assert.match(line, /session claude-code-2bfa6030-9abd-4…/);
    assert.doesNotMatch(line, /WARNING/);
  } finally {
    await cleanup();
  }
});
