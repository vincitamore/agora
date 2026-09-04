// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { AgoraError, readCursor, readCursorFile, writeCursor } from "../src/core.mjs";
import {
  BEARER_RE,
  DEFAULT_SESSION_FROM,
  appendPosted,
  armedAlive,
  bootEpoch,
  claimDeparture,
  departureLine,
  departures,
  departuresLine,
  etagCache,
  harnessPid,
  hasRoomState,
  identityLine,
  listRecords,
  listSessions,
  liveness,
  postedPids,
  readCursorSeeded,
  readPosted,
  readArmed,
  readRecord,
  releaseDeparture,
  removeSession,
  resolveBearer,
  resolveSession,
  sessionDir,
  sessionScope,
  sessionTag,
  touchRecord,
  writeArmed,
  writeRecord,
} from "../src/session.mjs";
import { actor, tmp } from "./helpers.mjs";

const cfg = /** @type {import('../src/core.mjs').Config} */ ({ actor, rooms: { r: { transport: "local", path: "r.ndjson" } } });

test("session key: AGORA_SESSION, then the first set harness variable, then default", () => {
  assert.deepEqual(DEFAULT_SESSION_FROM, [
    "CLAUDE_CODE_SESSION_ID",
    "GROK_SESSION_ID",
    "CODEX_SESSION_ID",
    "CODEX_THREAD_ID",
    "HERMES_SESSION_ID",
  ]);
  assert.deepEqual(resolveSession(cfg, { AGORA_SESSION: "fable-a" }), { slug: "fable-a", source: "AGORA_SESSION", explicit: true });
  assert.deepEqual(resolveSession(cfg, { CLAUDE_CODE_SESSION_ID: "2bfa6030-9abd-48d4-835f-53c4123fb0ed" }), {
    slug: "claude-code-2bfa6030-9abd-48d4-835f-53c4123fb0ed", source: "CLAUDE_CODE_SESSION_ID", explicit: false,
  });
  assert.deepEqual(resolveSession(cfg, { CODEX_SESSION_ID: "01a06940-dfba-7360-ae3f-20e45b7b41d1" }), {
    slug: "codex-01a06940-dfba-7360-ae3f-20e45b7b41d1", source: "CODEX_SESSION_ID", explicit: false,
  });
  assert.deepEqual(resolveSession(cfg, { CODEX_THREAD_ID: "thread-123", CODEX_SESSION_ID: "session-123" }), {
    slug: "codex-session-123", source: "CODEX_SESSION_ID", explicit: false,
  });
  assert.deepEqual(resolveSession(cfg, { HERMES_SESSION_ID: "hermes-123" }), {
    slug: "hermes-hermes-123", source: "HERMES_SESSION_ID", explicit: false,
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

test("a session key is one safe directory name: `.` and `..` are refused, and no recursive remove runs outside sessions/", async () => {
  const usage = (/** @type {unknown} */ e) => e instanceof AgoraError && e.exitCode === 2;
  for (const bad of ["..", "."]) {
    assert.throws(() => resolveSession(cfg, { AGORA_SESSION: bad }), usage, `AGORA_SESSION=${bad} is a usage error`);
    assert.throws(() => resolveSession(cfg, { AGORA_SESSION: bad }), /AGORA_SESSION must match/);
    assert.throws(() => sessionDir("/state", { slug: bad, source: "AGORA_SESSION", explicit: true }), usage, `sessionDir refuses ${bad}`);
  }
  assert.throws(() => sessionDir("/state", { slug: "a/b", source: "x", explicit: true }), usage, "and anything else that is not one name");
  // a harness variable holding a path-relative name is skipped, not turned into a slug
  const s = resolveSession({ ...cfg, session: { from: ["H_ID"] } }, { H_ID: ".." }, () => {});
  assert.deepEqual(s, { slug: "default", source: "default", explicit: false });

  const { dir, cleanup } = await tmp();
  try {
    const one = { slug: "s1", source: "AGORA_SESSION", explicit: true };
    await writeCursor(sessionDir(dir, one), "r", "17");
    await writeCursor(dir, "r", "3"); // the shared file every unseeded session seeds from
    await assert.rejects(() => removeSession(dir), /refusing to remove/, "the state root is not a session directory");
    await assert.rejects(() => removeSession(path.join(dir, "sessions")), /refusing to remove/, "nor is sessions/ itself");
    await assert.rejects(() => removeSession(path.join(dir, "sessions", "s1", "..")), /refusing to remove/, "nor is a path that traverses out of one");
    await assert.rejects(() => removeSession(path.join(dir, "sessions", "s1"), path.join(dir, "elsewhere")), /does not name a directory/, "nor one under another state root");
    assert.equal(await readCursor(sessionDir(dir, one), "r"), "17", "nothing was removed");
    await removeSession(path.join(dir, "sessions", "s1"), dir);
    assert.deepEqual(await listSessions(dir), [], "the one session it does name is removed");
    assert.equal(await readCursor(dir, "r"), "3", "the shared file is untouched");
  } finally {
    await cleanup();
  }
});

test("bearer: --as, then AGORA_ACTOR, then the config; paths validated at the boundary", () => {
  assert.deepEqual(resolveBearer(cfg, { as: "Fable/watch", env: { AGORA_ACTOR: "Opus" } }), { name: "Fable/watch", source: "--as" });
  assert.deepEqual(resolveBearer(cfg, { env: { AGORA_ACTOR: "Opus/design" } }), { name: "Opus/design", source: "AGORA_ACTOR" });
  assert.deepEqual(resolveBearer(cfg, { env: {} }), { name: actor.name, source: "config" });
  assert.throws(() => resolveBearer(cfg, { env: { AGORA_ACTOR: "Fable/" } }), /bearer path/);
  assert.throws(() => resolveBearer(cfg, { env: { AGORA_ACTOR: "Fable watch" } }), /bearer path/);
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

test("a torn cursor file is an error naming the file, never an absence seeded over", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const sdir = sessionDir(dir, { slug: "s1", source: "AGORA_SESSION", explicit: true });
    await writeCursor(dir, "r", "3"); // the shared seed, well behind
    await writeCursor(sdir, "r", "9"); // this session's real position
    const file = path.join(sdir, "r.cursor");
    const torn = '{"cursor":"9';
    await writeFile(file, torn, "utf8"); // what a half-finished write leaves
    await assert.rejects(
      () => readCursorFile(sdir, "r"),
      (e) => e instanceof AgoraError && e.exitCode === 1 && e.message.includes(file) && /inspect it or delete it/.test(e.message),
      "the error names the file and says what to do about it",
    );
    // the regression: a torn file read as an absence seeds from the stale root cursor, overwrites
    // the real position with it, and re-delivers everything between 3 and 9
    await assert.rejects(() => readCursorSeeded(sdir, dir, "r"), /inspect it or delete it/);
    assert.equal(await readFile(file, "utf8"), torn, "the damaged file is left as it was, never overwritten with the seed");
    assert.equal((await readCursorFile(dir, "r")).cursor, "3", "and the shared file is still only ever read");
    assert.deepEqual(await readCursorFile(sdir, "absent"), { exists: false, cursor: undefined }, "an absent file is still an absence");
    assert.deepEqual(await readCursorFile(path.join(dir, "no", "such", "dir"), "r"), { exists: false, cursor: undefined });
  } finally {
    await cleanup();
  }
});

test("every state write is a rename into place: nothing half-written, no temp file left behind", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const s = { slug: "s1", source: "AGORA_SESSION", explicit: true };
    const sdir = sessionDir(dir, s);
    await writeCursor(sdir, "r", "42");
    await writeRecord(sdir, s, { bearer: "Fable/watch", pid: process.pid, pidSource: "TEST" });
    await writeArmed(sdir, "r", { room: "r", interval: 15, pid: process.pid, startedAt: new Date().toISOString() });
    await etagCache(sdir).set("r", 'W/"abc"');
    await appendPosted(sdir, "m1");

    const names = (await readdir(sdir, { recursive: true })).map(String);
    assert.deepEqual(names.filter((n) => n.includes(".tmp-")), [], "no temp file survives a write");
    assert.equal(await readCursor(sdir, "r"), "42");
    assert.equal((await readRecord(sdir))?.bearer, "Fable/watch", "the record parses whole");
    assert.equal((await readArmed(sdir, "r"))?.room, "r");
    assert.equal(await etagCache(sdir).get("r"), 'W/"abc"');
    assert.ok((await readPosted(sdir)).has("m1"));
    // and the bytes on disk are the complete document, not a prefix of it
    for (const f of ["r.cursor", "session.json", "etags.json"]) JSON.parse(await readFile(path.join(sdir, f), "utf8"));
  } finally {
    await cleanup();
  }
});

test("the posted-id ledger keeps every id under concurrent appends from two callers", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const caller = async (/** @type {string} */ tag, /** @type {number} */ n) => {
      /** @type {string[]} */
      const ids = [];
      for (let i = 0; i < n; i++) {
        const id = `${tag}${i}`;
        ids.push(id);
        await appendPosted(dir, id); // two callers interleaving, as two processes of one session do
      }
      return ids;
    };
    const [a, b] = await Promise.all([caller("a", 100), caller("b", 100)]);
    const ids = await readPosted(dir);
    for (const id of [...a, ...b]) assert.ok(ids.has(id), `${id} is in the ledger`);
    assert.equal(ids.size, 200, "200 concurrent appends, 200 ids");
    assert.equal((await postedPids(dir)).size, 1);
  } finally {
    await cleanup();
  }
});

test("the ring rotates the file whole, so an id appended across the rotation is not dropped", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const caller = async (/** @type {string} */ tag, /** @type {number} */ n) => {
      for (let i = 0; i < n; i++) await appendPosted(dir, `${tag}${i}`);
    };
    await Promise.all([caller("a", 700), caller("b", 700)]); // 1400 crosses the rotation point
    const ids = await readPosted(dir);
    for (let i = 0; i < 700; i++) {
      assert.ok(ids.has(`a${i}`), `a${i} survived the rotation`);
      assert.ok(ids.has(`b${i}`), `b${i} survived the rotation`);
    }
    assert.deepEqual((await readdir(dir)).filter((f) => f.includes("rotating")), [], "the rotation lock is released");
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

test("the session record: written once, bearer replaced on re-register, startedAt kept, touched on later calls", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const s = { slug: "s1", source: "AGORA_SESSION", explicit: true };
    const sdir = sessionDir(dir, s);
    assert.equal(await readRecord(sdir), undefined);
    const first = await writeRecord(sdir, s, { bearer: "Fable/watch", label: "the watch", pid: 4242, pidSource: "CLAUDE_PID", now: new Date("2020-01-01T00:00:00Z") });
    assert.equal(first.startedAt, "2020-01-01T00:00:00.000Z");
    const second = await writeRecord(sdir, s, { bearer: "Opus/watch", now: new Date("2020-01-01T01:00:00Z") });
    assert.equal(second.bearer, "Opus/watch");
    assert.equal(second.label, "the watch", "label kept");
    assert.equal(second.pid, 4242, "pid kept");
    assert.equal(second.startedAt, first.startedAt, "startedAt kept");
    assert.equal(second.lastSeen, "2020-01-01T01:00:00.000Z");
    const touched = await touchRecord(sdir);
    assert.ok(touched && touched.lastSeen > second.lastSeen);
    assert.deepEqual(resolveBearer(cfg, { env: {}, record: touched }), { name: "Opus/watch", source: "session" });
    assert.deepEqual(resolveBearer(cfg, { env: { AGORA_ACTOR: "Grok" }, record: touched }), { name: "Grok", source: "AGORA_ACTOR" }, "env still beats the record");
    assert.equal(await touchRecord(sessionDir(dir, { slug: "none", source: "x", explicit: true })), undefined);
  } finally {
    await cleanup();
  }
});

test("liveness: a matching boot and an answering pid is live; ESRCH or a reboot is gone; EPERM counts as alive; no pid is unknown", () => {
  const rec = { slug: "s", source: "x", bearer: "Fable", pid: 100, bootEpoch: 1000, startedAt: "t", lastSeen: "t" };
  const esrch = () => { const e = /** @type {NodeJS.ErrnoException} */ (new Error("no such process")); e.code = "ESRCH"; throw e; };
  const eperm = () => { const e = /** @type {NodeJS.ErrnoException} */ (new Error("not permitted")); e.code = "EPERM"; throw e; };
  assert.equal(liveness(rec, { kill: () => {}, boot: 1000 }), "live");
  assert.equal(liveness(rec, { kill: () => {}, boot: 1001 }), "live", "a second of drift is the same boot");
  assert.equal(liveness(rec, { kill: esrch, boot: 1000 }), "gone");
  assert.equal(liveness(rec, { kill: () => {}, boot: 9000 }), "gone", "the machine rebooted; the pid means nothing");
  assert.equal(liveness(rec, { kill: eperm, boot: 1000 }), "live");
  assert.equal(liveness({ ...rec, pid: undefined }, { kill: () => {}, boot: 1000 }), "unknown");
  assert.equal(liveness({ ...rec, pid: process.pid, bootEpoch: bootEpoch() }), "live", "this process, for real");
});

test("an armed registration carries the boot it belongs to, so a pid reused after a reboot is not a live watch", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const sdir = sessionDir(dir, { slug: "s1", source: "AGORA_SESSION", explicit: true });
    await writeArmed(sdir, "r", { room: "r", interval: 15, pid: process.pid, startedAt: new Date().toISOString() });
    const armed = await readArmed(sdir, "r");
    assert.ok(armed && typeof armed.bootEpoch === "number", "the registration is stamped with this boot");
    assert.ok(Math.abs(armed.bootEpoch - bootEpoch()) <= 2);
    const boot = armed.bootEpoch;
    const esrch = () => { const e = /** @type {NodeJS.ErrnoException} */ (new Error("gone")); e.code = "ESRCH"; throw e; };

    assert.equal(armedAlive(armed, { kill: () => {}, boot }), true);
    assert.equal(armedAlive(armed, { kill: () => {}, boot: boot + 9000 }), false, "the machine rebooted; this pid belongs to something else now");
    assert.equal(armedAlive(armed, { kill: esrch, boot }), false, "same boot, no such process");
    assert.equal(armedAlive(armed), true, "this process, for real");
    assert.equal(
      armedAlive({ room: "r", interval: 15, pid: process.pid, startedAt: "t" }, { kill: () => {}, boot: 1 }),
      true,
      "a registration from a build that stamped no boot epoch falls back to the pid",
    );

    await writeArmed(sdir, "r", { ...armed, bootEpoch: 1234 });
    assert.equal((await readArmed(sdir, "r"))?.bootEpoch, 1234, "a boot epoch already on the record is kept");
  } finally {
    await cleanup();
  }
});

test("listRecords: every session with state, registered or not, with its liveness", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const a = { slug: "a", source: "x", explicit: true };
    await writeRecord(sessionDir(dir, a), a, { bearer: "Fable/watch", pid: process.pid, pidSource: "TEST" });
    await writeCursor(sessionDir(dir, { slug: "b", source: "x", explicit: true }), "r", "1"); // state but no record
    const rows = await listRecords(dir);
    assert.deepEqual(rows.map((r) => [r.slug, r.state]), [["a", "live"], ["b", "unregistered"]]);
    assert.equal(harnessPid(cfg, { CLAUDE_PID: "77" }).pid, 77);
    assert.equal(harnessPid(cfg, { GROK_PID: "78" }).pid, 78, "a Grok Build seat is probeable too");
    // with no pid the caller says WHICH variable the harness failed to inject: that is the remedy
    assert.deepEqual(harnessPid(cfg, { CLAUDE_PID: "nope" }), { pid: undefined, pidSource: undefined, looked: ["AGORA_SESSION_PID", "CLAUDE_PID", "GROK_PID"] });
    assert.equal(harnessPid({ ...cfg, session: { pidFrom: ["MY_PID"] } }, { MY_PID: "5", CLAUDE_PID: "6" }).pidSource, "MY_PID");
  } finally {
    await cleanup();
  }
});

test("departures: gone past the grace and within the stale horizon, not yet announced in this room, never oneself; one announcer wins", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const mk = async (/** @type {string} */ slug, /** @type {string} */ bearer, /** @type {number} */ minutesAgo, /** @type {number} */ pid) => {
      const s = { slug, source: "x", explicit: true };
      await writeRecord(sessionDir(dir, s), s, { bearer, pid, pidSource: "TEST", now: new Date(Date.now() - minutesAgo * 60_000) });
    };
    const dead = () => { const e = /** @type {NodeJS.ErrnoException} */ (new Error("gone")); e.code = "ESRCH"; throw e; };
    await mk("me", "Fable/watch", 1, 1);
    await mk("quiet", "Opus/design", 30, 2); // gone, quiet for 30 minutes: announce
    await mk("blip", "Fable/review", 1, 3); // gone but touched a minute ago: a restart, not a departure
    await mk("ancient", "Grok/build", 80 * 60, 4); // gone for days: pruned, never announced
    await mk("alive", "Codex", 30, process.pid); // still running
    await mk("elsewhere", "Fable/build", 30, 5); // gone, but never touched this room: not this room's news
    // a session is announced in a room it was actually in: a saved position for the key, or a watch
    // armed on it. Without this a fresh room opens with obituaries for bearers it never met.
    for (const slug of ["quiet", "blip", "ancient", "alive"]) await writeCursor(sessionDir(dir, { slug, source: "x", explicit: true }), "r", "1");
    await writeCursor(sessionDir(dir, { slug: "elsewhere", source: "x", explicit: true }), "another", "1");
    await writeCursor(sessionDir(dir, { slug: "quiet", source: "x", explicit: true }), "another", "1"); // in both rooms: each is told once
    const kill = (/** @type {number} */ pid) => { if (pid !== process.pid) dead(); };
    const boot = bootEpoch();
    let gone = await departures(dir, { selfSlug: "me", roomKey: "r", kill, boot });
    assert.deepEqual(gone.map((g) => g.slug), ["quiet"]);
    assert.match(departureLine(gone[0].record, ["Fable/watch", "Codex"]), /^Opus\/design is no longer running \(last seen .*Z\)\. Requests addressed to it will not be answered; re-address them\. Still here on this seat: Fable\/watch, Codex\.$/);
    assert.match(departureLine(gone[0].record, []), /No other session is provably live/);
    assert.match(departureLine(gone[0].record, ["Fable/watch"], ["Grok-4.6/general"]), /Still here on this seat: Fable\/watch\. Also registered here, liveness not provable from this process: Grok-4\.6\/general\./, "an unprobeable bearer is named, never dropped");
    assert.match(departureLine(gone[0].record, [], [{ bearer: "Grok-4.6/general", lastSeen: "2026-09-03T22:09:25.559Z" }]), /liveness not provable from this process: Grok-4\.6\/general \(last seen 2026-09-03T22:09:25Z\)\./, "an unprobeable bearer carries when it last wrote");

    assert.equal(await claimDeparture(gone[0].dir, "r", "me"), true, "first announcer wins");
    assert.equal(await claimDeparture(gone[0].dir, "r", "other"), false, "second does not");
    gone = await departures(dir, { selfSlug: "me", roomKey: "r", kill, boot });
    assert.deepEqual(gone, [], "announced in this room: not again");
    gone = await departures(dir, { selfSlug: "me", roomKey: "another", kill, boot });
    assert.deepEqual(gone.map((g) => g.slug), ["elsewhere", "quiet"], "another room has not been told, and it is the room `elsewhere` was in");
    // the claim is what makes exactly one watcher the announcer; kept over a failed post it makes
    // nobody the announcer, in that room, for every session on the seat
    await releaseDeparture(sessionDir(dir, { slug: "quiet", source: "x", explicit: true }), "r");
    gone = await departures(dir, { selfSlug: "me", roomKey: "r", kill, boot });
    assert.deepEqual(gone.map((g) => g.slug), ["quiet"], "a released claim is retried by the next poll");
    assert.equal(await claimDeparture(gone[0].dir, "r", "me"), true);
    gone = await departures(dir, { selfSlug: "quiet", roomKey: "third", kill, boot });
    assert.deepEqual(gone, [], "a session never announces itself, and no session has state in a third room");
  } finally {
    await cleanup();
  }
});

test("one sweep is one post: a roster naming every bearer that went dark, and no count", async () => {
  const rec = (/** @type {string} */ bearer, /** @type {string} */ lastSeen) => /** @type {any} */ ({ bearer, lastSeen, slug: bearer, source: "x", bootEpoch: 1, startedAt: lastSeen });
  const one = departuresLine([rec("Opus/design", "2026-09-04T11:20:00.000Z")], ["Fable/watch"]);
  assert.match(one, /^Opus\/design is no longer running \(last seen 2026-09-04T11:20:00Z\)\./, "one departure reads exactly as it always did");
  const many = departuresLine(
    [rec("Fable/build", "2026-09-03T13:02:00.000Z"), rec("Fable/review", "2026-09-04T03:51:00.000Z"), rec("Opus/design", "2026-09-04T11:20:00.000Z")],
    ["Fable/orchestrator"],
    [{ bearer: "Grok-4.6/general", lastSeen: "2026-09-04T11:00:00.000Z" }],
  );
  assert.match(many, /^Fable\/build, Fable\/review and Opus\/design are no longer running \(last seen 2026-09-03T13:02:00Z, 2026-09-04T03:51:00Z, 2026-09-04T11:20:00Z, in that order\)\./);
  assert.match(many, /Requests addressed to them will not be answered; re-address them\. Still here on this seat: Fable\/orchestrator\./);
  assert.match(many, /liveness not provable from this process: Grok-4\.6\/general \(last seen 2026-09-04T11:00:00Z\)/);
  assert.doesNotMatch(many, /\b3\b/, "bearers are named; no count is emitted");
});

test("a session's scope is the rooms it holds a position in and the watches it armed, by name", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const s = { slug: "a", source: "x", explicit: true };
    const sdir = sessionDir(dir, s);
    assert.deepEqual(await sessionScope(sdir), { rooms: [], armed: [] });
    await writeCursor(sdir, "down", "3");
    await writeCursor(sdir, "down#T1", "4");
    await writeArmed(sdir, "down", { room: "down", mode: "stream", interval: 15, pid: process.pid, startedAt: new Date().toISOString() });
    const scope = await sessionScope(sdir);
    assert.deepEqual(scope.rooms, ["down", "down#T1"]);
    assert.deepEqual(scope.armed, [{ key: "down", room: "down", mode: "stream", pid: process.pid }]);
    assert.equal(await hasRoomState(sdir, "down"), true);
    assert.equal(await hasRoomState(sdir, "down#T1"), true, "a thread of the room counts as the room");
    assert.equal(await hasRoomState(sdir, "other"), false);
  } finally {
    await cleanup();
  }
});

test("AGORA_SESSION set to a harness variable's raw value names the same session, not a second one", async () => {
  const env = { CLAUDE_CODE_SESSION_ID: "2bfa6030-9abd-48d4-835f-53c4123fb0ed" };
  const derived = resolveSession(cfg, env);
  assert.equal(derived.slug, "claude-code-2bfa6030-9abd-48d4-835f-53c4123fb0ed");
  // what a reader copies out of `doctor` is the variable's value; setting it must not fork a second
  // session directory (a second ledger, a second position) out of one harness session
  const copied = resolveSession(cfg, { ...env, AGORA_SESSION: env.CLAUDE_CODE_SESSION_ID });
  assert.equal(copied.slug, derived.slug);
  assert.equal(copied.source, "AGORA_SESSION (CLAUDE_CODE_SESSION_ID)");
  const own = resolveSession(cfg, { ...env, AGORA_SESSION: "a-name-of-my-own" });
  assert.deepEqual([own.slug, own.source], ["a-name-of-my-own", "AGORA_SESSION"]);
});


test("the identity line names bearer, session and their sources, and warns on a shared default with siblings", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const bearer = { name: "Fable/watch", source: "AGORA_ACTOR" };
    let line = await identityLine(bearer, { slug: "default", source: "default", explicit: false }, dir);
    assert.equal(line, "agora: Fable/watch (from AGORA_ACTOR) · session default (from default)");
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
