// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { writeCursor } from "../src/core.mjs";
import { carryState, carryWindow, foldRoom, renderCarry } from "../src/carry.mjs";
import { appendPosted, inheritSession, readPosted } from "../src/session.mjs";
import { writeFollow } from "../src/follow.mjs";
import { tmp } from "./helpers.mjs";

const run = promisify(execFile);
const BIN = new URL("../bin/agora.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/** @param {string[]} args @param {Record<string, string>} env */
async function agora(args, env) {
  try {
    // the harness running the suite injects its own session id and pid, and the tool reads both:
    // a test asserting what a verb printed must not depend on which harness ran it
    const clean = { ...process.env };
    for (const name of ["CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_PID", "GROK_SESSION_ID", "GROK_PID", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "HERMES_SESSION_ID", "AGORA_SESSION_PID", "AGORA_SESSION", "AGORA_ACTOR", "AGORA_CONFIG", "AGORA_STATE"]) delete clean[name];
    const child = run(process.execPath, [BIN, ...args], { env: { ...clean, ...env }, windowsHide: true });
    child.child.stdin?.end();
    const { stdout, stderr } = await child;
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = /** @type {any} */ (e);
    return { code: err.code, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

/** Every typed line of a `--json` run, parsed. @param {string} out */
const typed = (out) => out.trim().split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));

/** @param {string} id @param {string} text @param {{ ts?: string, who?: string, kind?: string, thread?: string, cursor?: string, raw?: Record<string, unknown> }} [o] */
function msg(id, text, o = {}) {
  return /** @type {import('../src/core.mjs').Message} */ ({
    id,
    room: "r",
    ...(o.thread ? { thread: o.thread } : {}),
    author: { id: o.who ?? "seat", name: o.who ?? "seat", kind: /** @type {any} */ (o.kind ?? "agent") },
    text,
    signedAs: /^--\s(.+)$/m.exec(text)?.[1],
    ts: o.ts ?? `2026-09-04T00:00:${String(Number(id.replace(/\D/g, "")) || 0).padStart(2, "0")}.000Z`,
    cursor: o.cursor ?? (id.replace(/\D/g, "") || id),
    ...(o.raw ? { raw: o.raw } : {}),
  });
}

const OWN_CLAIM = msg("m1", "taking it\n\nclaim: worker/src/fetch.ts::retryFetch\nto: Codex\n\n-- Fable/watch");
const OWN_SECOND = msg("m2", "and this\n\nclaim: docs/x.md\n\n-- Fable/watch");
const OWN_RELEASE = msg("m3", "handing back\n\nrelease: docs/x.md\n\n-- Fable/watch");
const OWN_VERDICT = msg("m4", "settled\n\nverdict: pass\nexhibit: run 4412 line 88\nexhibit: sha256 abc\n\n-- Fable/watch");
const THEIRS = msg("m5", "can you rerun it?\n\nto: Fable\n\n-- Bone/dev", { who: "bone", kind: "human" });

test("carry: only this session's own posts are folded, and the ledger is the whole filter", () => {
  const all = [OWN_CLAIM, OWN_SECOND, THEIRS];
  const mine = foldRoom(all, new Set(["m1", "m2"]), { bearer: "Fable/watch" });
  assert.deepEqual(mine.claims.map((c) => c.subject), ["worker/src/fetch.ts::retryFetch", "docs/x.md"]);
  // the same window read by a session that posted none of it carries no claims of its own
  const other = foldRoom(all, new Set(), { bearer: "Opus/design" });
  assert.deepEqual(other.claims, []);
  assert.deepEqual(other.obligations, []);
  assert.equal(other.horizon.own, 0);
});

test("carry: a released claim leaves the open list and the release is carried beside it", () => {
  const c = foldRoom([OWN_CLAIM, OWN_SECOND, OWN_RELEASE], new Set(["m1", "m2", "m3"]), { bearer: "Fable/watch" });
  assert.deepEqual(c.claims.map((x) => x.subject), ["worker/src/fetch.ts::retryFetch"]);
  assert.deepEqual(c.claims.map((x) => [x.id, x.cursor]), [["m1", "1"]]);
  // the retraction is not merely subtracted: a successor that saw only the survivors could not
  // tell a withdrawn subject from one that was never claimed, and would re-claim it
  assert.deepEqual(c.releases.map((x) => x.subject), ["docs/x.md"]);
});

test("carry: the earliest claim on a subject is the one carried", () => {
  const again = msg("m9", "still mine\n\nclaim: worker/src/fetch.ts::retryFetch\n\n-- Fable/watch");
  const c = foldRoom([OWN_CLAIM, again], new Set(["m1", "m9"]), { bearer: "Fable/watch" });
  assert.equal(c.claims.length, 1);
  assert.equal(c.claims[0].id, "m1");
});

test("carry: a verdict carries its exhibits, and an obligation is an own post with a to:", () => {
  const c = foldRoom([OWN_CLAIM, OWN_VERDICT], new Set(["m1", "m4"]), { bearer: "Fable/watch" });
  assert.deepEqual(c.verdicts.map((v) => [v.verdict, v.exhibits, v.id]), [["pass", ["run 4412 line 88", "sha256 abc"], "m4"]]);
  assert.deepEqual(c.obligations.map((o) => [o.to, o.id, o.cursor]), [[["Codex"], "m1", "1"]]);
});

test("carry: deliveries owing a receipt are those addressed here after this session's last own post", () => {
  const before = msg("m0", "earlier ask\n\nto: Fable/watch\n\n-- Bone/dev", { who: "bone", kind: "human" });
  const elsewhere = msg("m6", "for the other one\n\nto: Opus/design\n\n-- Bone/dev", { who: "bone", kind: "human" });
  const c = foldRoom([before, OWN_CLAIM, THEIRS, elsewhere], new Set(["m1"]), { bearer: "Fable/watch" });
  // m0 is older than the last own post, so it was answered by it; m6 names someone else
  assert.deepEqual(c.owed.map((o) => o.id), ["m5"]);
  assert.deepEqual(c.owed.map((o) => [o.from, o.to]), [["Bone/dev", ["Fable"]]]);
  assert.deepEqual(c.horizon.lastOwn, { id: "m1", cursor: "1", ts: OWN_CLAIM.ts });
});

test("carry: with nothing of this session's own in the window, every addressed message is owed", () => {
  const c = foldRoom([THEIRS], new Set(), { bearer: "Fable/watch" });
  assert.deepEqual(c.owed.map((o) => o.id), ["m5"]);
  assert.equal(c.horizon.lastOwn, null);
});

test("carry: an address naming the seat, the model or everyone reaches this bearer", () => {
  const seat = msg("m7", "anyone\n\nto: *\n\n-- Bone/dev", { who: "bone", kind: "human" });
  const named = msg("m8", "the seat\n\nto: agora-bot\n\n-- Bone/dev", { who: "bone", kind: "human" });
  const c = foldRoom([seat, named], new Set(), { bearer: "Fable/watch", seat: { id: "U01", name: "agora-bot" } });
  assert.deepEqual(c.owed.map((o) => o.id), ["m7", "m8"]);
});

test("carry: the window folds the room's live threads, so a release posted as a thread reply closes its claim", async () => {
  // the measured defect: on Slack a room read never contains replies, so a claim taken at the top
  // level and handed back in the thread under it read as still open ninety minutes later
  const parent = msg("p1", "taking it\n\nclaim: human:1788534332\n\n-- Fable/watch", { cursor: "1", raw: { reply_count: 1, latest_reply: "3" } });
  const reply = msg("r3", "handing it back\n\nrelease: human:1788534332\n\n-- Fable/watch", { thread: "p1", cursor: "3" });
  /** @type {import('../src/core.mjs').ReadOptions[]} */
  const reads = [];
  const transport = {
    threads: true,
    /** @param {import('../src/core.mjs').ReadOptions} [o] */
    async read(o = {}) {
      reads.push(o);
      if (o.thread) return o.thread === "p1" ? [reply] : [];
      return [parent]; // channel history: parents only, exactly as Slack answers
    },
  };

  const w = await carryWindow(transport, { limit: 200 });
  assert.deepEqual(w.threads, ["p1"]);
  assert.deepEqual(reads, [{ limit: 200 }, { thread: "p1", since: undefined }]);
  const c = foldRoom(w.messages, new Set(["p1", "r3"]), { bearer: "Fable/watch" });
  assert.deepEqual(c.claims, [], "the release is in the window, so the claim is not open");
  assert.deepEqual(c.releases.map((x) => [x.subject, x.id]), [["human:1788534332", "r3"]]);

  // and the room read alone is the defect, which is what --no-threads buys back
  const plain = await carryWindow(transport, { limit: 200, threads: false });
  assert.deepEqual(plain.threads, []);
  const blind = foldRoom(plain.messages, new Set(["p1", "r3"]), { bearer: "Fable/watch" });
  assert.deepEqual(blind.claims.map((x) => x.subject), ["human:1788534332"]);
  assert.deepEqual(blind.releases, []);
});

test("carry: a claim taken again after a release re-opens the subject, and the earliest after the release holds", () => {
  const take = msg("c1", "taking it\n\nclaim: docs/x.md\n\n-- Fable/watch");
  const give = msg("c2", "handing it back\n\nrelease: docs/x.md\n\n-- Fable/watch");
  const again = msg("c3", "taking it up again\n\nclaim: docs/x.md\n\n-- Fable/watch");
  const later = msg("c4", "still mine\n\nclaim: docs/x.md\n\n-- Fable/watch");
  const c = foldRoom([take, give, again, later], new Set(["c1", "c2", "c3", "c4"]), { bearer: "Fable/watch" });
  assert.deepEqual(c.claims.map((x) => [x.subject, x.id]), [["docs/x.md", "c3"]], "the earliest claim after the release, not the first one ever posted");
  assert.deepEqual(c.releases.map((x) => x.id), ["c2"], "the retraction is still carried beside it");
});

test("carry: a verdict answering an earlier own verdict supersedes it, and the withdrawn one is carried", () => {
  const first = msg("v1", "it passes\n\nverdict: pass\nexhibit: run 4412 line 88\n\n-- Fable/watch");
  const withdrawn = msg("v2", "that was the wrong branch\n\nre: v1\nverdict: withdrawn\nexhibit: run 4419 line 12\n\n-- Fable/watch");
  const c = foldRoom([first, withdrawn], new Set(["v1", "v2"]), { bearer: "Fable/watch" });
  assert.deepEqual(c.verdicts.map((v) => [v.verdict, v.id]), [["withdrawn", "v2"]], "the withdrawn verdict is no longer what this session says");
  assert.deepEqual(c.superseded.map((v) => [v.id, v.cursor, v.verdict, v.supersededBy]), [["v1", "1", "pass", "v2"]]);
  const text = renderCarry({ ...c, cursorKey: "down", cursor: null });
  assert.match(text, /superseded {2}pass {3}v1 cursor 1, withdrawn by v2/);
  assert.ok(!text.includes("it passes"), "a withdrawal names the verdict, never the words");

  // a `re:` that names something other than one of this session's own verdicts changes nothing
  const unrelated = msg("v3", "and the other one\n\nre: foreign-9\nverdict: pass\nexhibit: run 4420\n\n-- Fable/watch");
  const b = foldRoom([first, unrelated], new Set(["v1", "v3"]), { bearer: "Fable/watch" });
  assert.deepEqual(b.verdicts.map((v) => v.id), ["v1", "v3"]);
  assert.deepEqual(b.superseded, []);
});

test("carry: a delivery addressed here is owed until this session answers it by name", () => {
  const ask = msg("m10", "can you rerun it?\n\nto: Fable\n\n-- Bone/dev", { who: "bone", kind: "human" });
  const open = foldRoom([OWN_CLAIM, ask], new Set(["m1"]), { bearer: "Fable/watch" });
  assert.deepEqual(open.owed.map((o) => o.id), ["m10"], "a delivery awaiting a reply, not this session's own to:");
  assert.deepEqual(open.obligations.map((o) => o.id), ["m1"], "what this session addressed to someone else is the other list");

  // the receipt is posted in a thread, so only the `re:` can be what answers it
  const receipt = msg("m11", "on it\n\nre: m10\n\n-- Fable/watch", { thread: "t9" });
  const answered = foldRoom([OWN_CLAIM, ask, receipt], new Set(["m1", "m11"]), { bearer: "Fable/watch" });
  assert.deepEqual(answered.owed, []);

  const other = msg("m11", "on something else\n\nre: m99\n\n-- Fable/watch", { thread: "t9" });
  const still = foldRoom([OWN_CLAIM, ask, other], new Set(["m1", "m11"]), { bearer: "Fable/watch" });
  assert.deepEqual(still.owed.map((o) => o.id), ["m10"], "a re: naming another message answers nothing here");
});

test("carry: a post in the room or in another thread is no receipt for a delivery in this one", () => {
  const inThread = msg("m12", "and this one?\n\nto: Fable\n\n-- Bone/dev", { who: "bone", kind: "human", thread: "t1" });
  const elsewhere = msg("m13", "noted\n\n-- Fable/watch", { thread: "t2" });
  const top = msg("m14", "back to the room\n\n-- Fable/watch");
  const c = foldRoom([inThread, elsewhere, top], new Set(["m13", "m14"]), { bearer: "Fable/watch" });
  assert.deepEqual(c.owed.map((o) => [o.id, o.thread]), [["m12", "t1"]]);
  const here = foldRoom([inThread, msg("m15", "on it\n\n-- Fable/watch", { thread: "t1" })], new Set(["m15"]), { bearer: "Fable/watch" });
  assert.deepEqual(here.owed, [], "speaking in the same thread after it is the receipt");
});

test("carry: nothing rendered carries a message body", () => {
  const c = foldRoom([OWN_CLAIM, OWN_VERDICT, THEIRS], new Set(["m1", "m4"]), { bearer: "Fable/watch" });
  const text = renderCarry({
    room: { alias: "down", transport: "local", room: "/tmp/down.ndjson" },
    bearer: { name: "Fable/watch", source: "session" },
    session: { slug: "s1", source: "AGORA_SESSION", registered: true },
    seat: { name: "agora-bot", id: "U01" },
    cursor: "4",
    cursorKey: "down",
    threads: [],
    follow: { threads: {} },
    armed: [],
    ...c,
  });
  for (const body of ["taking it", "settled", "can you rerun it?"]) assert.ok(!text.includes(body), `${body} is a message body and must not be rendered`);
  assert.match(text, /claim {7}worker\/src\/fetch\.ts::retryFetch {3}m1 cursor 1/);
  assert.match(text, /owed {8}from Bone\/dev to Fable {3}m5 cursor 5/);
  assert.match(text, /exhibit: run 4412 line 88 \| sha256 abc/);
});

test("carry: state is read, never seeded, so the verb writes nothing", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const sdir = path.join(dir, "sessions", "s1");
    await mkdir(sdir, { recursive: true });
    await writeCursor(dir, "down", "77"); // the single-session layout at the state root
    const before = (await readdir(sdir)).sort();
    const state = await carryState(sdir, dir, "down");
    assert.equal(state.cursor, null);
    assert.equal(state.seedFrom, "77", "what the next watch would seed from is said, not performed");
    assert.deepEqual((await readdir(sdir)).sort(), before, "carry stores nothing");
  } finally {
    await cleanup();
  }
});

test("carry: a thread with a position that has left the follow set is carried, marked as left", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const sdir = path.join(dir, "sessions", "s1");
    await mkdir(sdir, { recursive: true });
    await writeCursor(sdir, "down", "12");
    await writeCursor(sdir, "down#t1", "3");
    await writeCursor(sdir, "down#t2", "9");
    await writeFollow(sdir, "down", { threads: { t1: "2026-09-04T00:00:00.000Z" }, aliases: { t1b: "t1" } });
    const state = await carryState(sdir, dir, "down");
    assert.equal(state.cursor, "12");
    assert.equal(state.seedFrom, undefined);
    assert.deepEqual(state.threads.map((t) => [t.thread, t.cursor, t.followed]), [["t1", "3", true], ["t2", "9", false]]);
    assert.deepEqual(state.follow.aliases, { t1b: "t1" });
  } finally {
    await cleanup();
  }
});

test("cli: carry derives the keep-list from the session directory and one bounded read", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const cfgPath = path.join(dir, "agora.json");
    await writeFile(cfgPath, JSON.stringify({
      actor: { name: "Fable/watch", kind: "agent" },
      rooms: { down: { transport: "local", path: path.join(dir, "down.ndjson"), note: "shared lane" } },
    }));
    const env = { AGORA_CONFIG: cfgPath, AGORA_STATE: path.join(dir, "state"), AGORA_SESSION: "s1" };
    await agora(["session", "--as", "Fable/watch"], env);
    await agora(["post", "down", "--claim", "worker/src/fetch.ts::retryFetch", "--to", "Codex", "taking the retry path"], env);
    await agora(["post", "down", "--verdict", "pass", "--exhibit", "run 4412 line 88", "settled"], env);
    // a message this session did not post, addressed to it, after its last post. The window is one
    // ascending list merged by time, as every transport's own read is, so the stamp is later than
    // the posts above it rather than a fixed one that could fall before them.
    await writeFile(path.join(dir, "down.ndjson"), await readFile(path.join(dir, "down.ndjson"), "utf8")
      + JSON.stringify({ id: "foreign-1", author: { id: "bone", name: "bone", kind: "human" }, text: "can you rerun it?\n\nto: Fable\n\n-- Bone/dev", ts: new Date(Date.now() + 60_000).toISOString() }) + "\n");

    const r = await agora(["carry", "down", "--json"], env);
    assert.equal(r.code, 0);
    const c = JSON.parse(r.stdout.trim());
    assert.equal(c.type, "carry");
    assert.deepEqual(c.room.alias, "down");
    assert.equal(c.room.note, "shared lane");
    assert.deepEqual(c.bearer, { name: "Fable/watch", source: "session" });
    assert.deepEqual(c.session, { slug: "s1", source: "AGORA_SESSION", registered: true });
    assert.deepEqual(c.claims.map((/** @type {any} */ x) => x.subject), ["worker/src/fetch.ts::retryFetch"]);
    assert.deepEqual(c.verdicts.map((/** @type {any} */ x) => [x.verdict, x.exhibits]), [["pass", ["run 4412 line 88"]]]);
    assert.deepEqual(c.obligations.map((/** @type {any} */ x) => x.to), [["Codex"]]);
    assert.deepEqual(c.superseded, [], "the field is in the envelope whether or not anything was withdrawn");
    assert.deepEqual(c.owed.map((/** @type {any} */ x) => [x.id, x.from]), [["foreign-1", "Bone/dev"]]);
    assert.equal(c.horizon.messages, 3);
    for (const body of ["taking the retry path", "can you rerun it?"]) assert.ok(!r.stdout.includes(body), "no message text crosses into the carry");

    // the cursor is not moved and nothing is written by the call
    const sdir = path.join(dir, "state", "sessions", "s1");
    const before = (await readdir(sdir)).sort();
    const human = await agora(["carry", "down"], env);
    assert.equal(human.code, 0);
    assert.match(human.stdout, /^carry down \(local /);
    assert.match(human.stdout, /Nothing here is stored/);
    assert.deepEqual((await readdir(sdir)).sort(), before);
  } finally {
    await cleanup();
  }
});

test("cli: carry --limit and --no-threads are bounded reads that move no cursor", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const cfgPath = path.join(dir, "agora.json");
    await writeFile(cfgPath, JSON.stringify({
      actor: { name: "Fable/watch", kind: "agent" },
      rooms: { down: { transport: "local", path: path.join(dir, "down.ndjson") } },
    }));
    const env = { AGORA_CONFIG: cfgPath, AGORA_STATE: path.join(dir, "state"), AGORA_SESSION: "s1" };
    await agora(["session", "--as", "Fable/watch"], env);
    for (const n of [1, 2, 3]) await agora(["post", "down", `line ${n}`], env);
    const r = await agora(["carry", "down", "--json", "--limit", "2", "--no-threads"], env);
    assert.equal(r.code, 0);
    const c = JSON.parse(r.stdout.trim());
    assert.equal(c.horizon.messages, 2, "the window is the newest --limit messages");
    const cur = await agora(["cursor", "down", "--json"], env);
    assert.equal(JSON.parse(cur.stdout.trim()).cursor, null, "carry never touches the saved position");
  } finally {
    await cleanup();
  }
});

test("inherit: cursors, follow set and ledger are copied, the ledger appended, the source untouched", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const src = path.join(dir, "sessions", "old");
    const dst = path.join(dir, "sessions", "new");
    await mkdir(src, { recursive: true });
    await writeCursor(src, "down", "41");
    await writeCursor(src, "down#t1", "3");
    await writeFollow(src, "down", { threads: { t1: "2026-09-04T00:00:00.000Z" }, aliases: { t1b: "t1" } });
    await appendPosted(src, "old-1");
    await appendPosted(src, "old-2");
    await mkdir(dst, { recursive: true });
    await appendPosted(dst, "new-1");

    const plan = await inheritSession(dir, "old", { slug: "new", source: "AGORA_SESSION", explicit: true });
    assert.deepEqual(plan.cursors, ["down", "down#t1"]);
    assert.deepEqual(plan.follow, ["down"]);
    assert.equal(plan.ledger.lines, 2);
    assert.deepEqual(plan.conflicts, []);

    assert.equal(JSON.parse(await readFile(path.join(dst, "down.cursor"), "utf8")).cursor, "41");
    assert.equal(JSON.parse(await readFile(path.join(dst, "down#t1.cursor"), "utf8")).cursor, "3");
    assert.deepEqual(JSON.parse(await readFile(path.join(dst, "follow", "down.json"), "utf8")).aliases, { t1b: "t1" });
    // appended, never replaced: this session's own ids are its own protection against a self-echo
    assert.deepEqual([...(await readPosted(dst))].sort(), ["new-1", "old-1", "old-2"]);
    assert.deepEqual([...(await readPosted(src))].sort(), ["old-1", "old-2"], "the source is read only");
    assert.ok(!existsSync(path.join(dst, "session.json")), "the record says who a session is and is never inherited");
  } finally {
    await cleanup();
  }
});

test("inherit: a room this session already holds is refused, and --force takes it", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const src = path.join(dir, "sessions", "old");
    const dst = path.join(dir, "sessions", "new");
    await mkdir(src, { recursive: true });
    await writeCursor(src, "down", "41");
    await writeCursor(dst, "down", "7");
    const session = { slug: "new", source: "AGORA_SESSION", explicit: true };
    await assert.rejects(() => inheritSession(dir, "old", session), (/** @type {any} */ e) => {
      assert.equal(e.exitCode, 2);
      assert.match(e.message, /already holds a position in down/);
      return true;
    });
    assert.equal(JSON.parse(await readFile(path.join(dst, "down.cursor"), "utf8")).cursor, "7", "a refusal changes nothing");
    const plan = await inheritSession(dir, "old", session, { force: true });
    assert.deepEqual(plan.conflicts, ["down"]);
    assert.equal(plan.forced, true);
    assert.equal(JSON.parse(await readFile(path.join(dst, "down.cursor"), "utf8")).cursor, "41");
  } finally {
    await cleanup();
  }
});

test("inherit: this session, an unknown key and a key that is not a session name are usage errors", async () => {
  const { dir, cleanup } = await tmp();
  try {
    await mkdir(path.join(dir, "sessions", "old"), { recursive: true });
    const session = { slug: "new", source: "AGORA_SESSION", explicit: true };
    for (const [key, why] of [["new", /is this session/], ["nope", /no session nope has state/], ["..", /is not one/], ["a/b", /is not one/]])
      await assert.rejects(() => inheritSession(dir, String(key), session), (/** @type {any} */ e) => {
        assert.equal(e.exitCode, 2, `${key} is a usage error`);
        assert.match(e.message, /** @type {RegExp} */ (why));
        return true;
      });
  } finally {
    await cleanup();
  }
});

test("cli: session --inherit --dry-run says what it would copy and copies nothing", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const cfgPath = path.join(dir, "agora.json");
    await writeFile(cfgPath, JSON.stringify({
      actor: { name: "Fable/watch", kind: "agent" },
      rooms: { down: { transport: "local", path: path.join(dir, "down.ndjson") } },
    }));
    const state = path.join(dir, "state");
    const one = { AGORA_CONFIG: cfgPath, AGORA_STATE: state, AGORA_SESSION: "s1" };
    const two = { AGORA_CONFIG: cfgPath, AGORA_STATE: state, AGORA_SESSION: "s2" };
    await agora(["session", "--as", "Fable/watch"], one);
    await agora(["post", "down", "the predecessor's line"], one);
    await agora(["cursor", "down", "--now"], one);

    const dry = await agora(["session", "--inherit", "s1", "--dry-run"], two);
    assert.equal(dry.code, 0);
    assert.match(dry.stdout, /^would inherit from s1: 1 cursor \(down\)/);
    assert.ok(!existsSync(path.join(state, "sessions", "s2", "down.cursor")), "a dry run copies nothing");

    const did = await agora(["session", "--inherit", "s1", "--json"], two);
    assert.equal(did.code, 0);
    const plan = JSON.parse(did.stdout.trim());
    assert.equal(plan.type, "inherit");
    assert.deepEqual(plan.cursors, ["down"]);
    assert.equal(plan.ledger.lines, 1);
    assert.match(did.stderr, /record was not copied; run `agora session --as/);

    // the whole point: the successor resumes at the predecessor's position and its predecessor's
    // own post is not delivered back to it as a foreign message
    const w = await agora(["watch", "down", "--once", "--json"], two);
    assert.equal(w.code, 0, "nothing new: the position was inherited, so the room is not replayed");
    const lines = typed(w.stdout);
    const result = lines.find((/** @type {any} */ l) => l.type === "watch-result");
    assert.equal(result.delivered, 0);

    // and with the position reset, the predecessor's post is skipped by the inherited ledger
    await agora(["cursor", "down", "--reset"], two);
    const again = await agora(["watch", "down", "--once", "--json"], two);
    assert.equal(again.code, 0, "the inherited ledger makes the predecessor's post this session's own");
    const r2 = typed(again.stdout).find((/** @type {any} */ l) => l.type === "watch-result");
    assert.equal(r2.skipped, 1);
    assert.equal(r2.delivered, 0);
  } finally {
    await cleanup();
  }
});

test("cli: session --inherit refuses a held room with exit 2 and names --force", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const cfgPath = path.join(dir, "agora.json");
    await writeFile(cfgPath, JSON.stringify({
      actor: { name: "Fable/watch", kind: "agent" },
      rooms: { down: { transport: "local", path: path.join(dir, "down.ndjson") } },
    }));
    const state = path.join(dir, "state");
    const one = { AGORA_CONFIG: cfgPath, AGORA_STATE: state, AGORA_SESSION: "s1" };
    const two = { AGORA_CONFIG: cfgPath, AGORA_STATE: state, AGORA_SESSION: "s2" };
    await agora(["post", "down", "one"], one);
    await agora(["cursor", "down", "--now"], one);
    await agora(["post", "down", "two"], two);
    await agora(["cursor", "down", "--now"], two);
    const held = JSON.parse((await agora(["cursor", "down", "--json"], two)).stdout.trim()).cursor;

    const refused = await agora(["session", "--inherit", "s1"], two);
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /already holds a position in down.*--force/s);
    assert.equal(JSON.parse((await agora(["cursor", "down", "--json"], two)).stdout.trim()).cursor, held);

    const forced = await agora(["session", "--inherit", "s1", "--force"], two);
    assert.equal(forced.code, 0);
    assert.match(forced.stdout, /--force took s1's position in down/);
  } finally {
    await cleanup();
  }
});
