// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { localTransport } from "../src/transports/local.mjs";
import { slackTransport } from "../src/transports/slack.mjs";
import { watch } from "../src/watch.mjs";
import { readCursor } from "../src/core.mjs";
import { actor, fakeFetch, tmp } from "./helpers.mjs";

test("watch once: nothing, then something, then nothing again; cursor persists", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const t = localTransport({ transport: "local", path: path.join(dir, "r.ndjson") }, { actor });
    const state = path.join(dir, "state");
    /** @type {string[][]} */
    const batches = [];
    const onBatch = (/** @type {import('../src/core.mjs').Message[]} */ m) => { batches.push(m.map((x) => x.text)); };

    let r = await watch(t, { stateDir: state, key: "r", mode: "once", onBatch });
    assert.equal(r.fired, false);
    await t.post("one");
    await t.post("two");
    r = await watch(t, { stateDir: state, key: "r", mode: "once", onBatch });
    assert.equal(r.fired, true);
    assert.deepEqual(batches, [["one", "two"]]);
    assert.equal(await readCursor(state, "r"), "2");
    r = await watch(t, { stateDir: state, key: "r", mode: "once", onBatch });
    assert.equal(r.fired, false);
    assert.equal(batches.length, 1, "nothing re-delivered");
  } finally {
    await cleanup();
  }
});

test("watch until-new polls, sleeps, fires on arrival", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const t = localTransport({ transport: "local", path: path.join(dir, "r.ndjson") }, { actor });
    /** @type {number[]} */
    const slept = [];
    let posted = false;
    const r = await watch(t, {
      stateDir: path.join(dir, "s"), key: "r", interval: 7,
      onBatch: () => {},
      sleep: async (ms) => { slept.push(ms); if (!posted) { posted = true; await t.post("arrived"); } },
    });
    assert.equal(r.fired, true);
    assert.equal(r.polls, 2);
    assert.deepEqual(slept, [7000]);
  } finally {
    await cleanup();
  }
});

test("watch gives up after --for, and stream keeps delivering", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const t = localTransport({ transport: "local", path: path.join(dir, "r.ndjson") }, { actor });
    let clock = 0;
    const r = await watch(t, {
      stateDir: path.join(dir, "s"), key: "r", interval: 5, forSeconds: 12,
      onBatch: () => {}, now: () => clock, sleep: async (ms) => { clock += ms; },
    });
    assert.equal(r.fired, false);
    assert.equal(r.polls, 3);

    clock = 0;
    let n = 0;
    /** @type {string[]} */
    const seen = [];
    const s = await watch(t, {
      stateDir: path.join(dir, "s2"), key: "r", mode: "stream", interval: 5, forSeconds: 12,
      onBatch: (m) => { seen.push(...m.map((x) => x.text)); }, now: () => clock,
      sleep: async (ms) => { clock += ms; await t.post(`m${++n}`); },
    });
    assert.equal(s.fired, true);
    assert.deepEqual(seen, ["m1", "m2"]);
  } finally {
    await cleanup();
  }
});

test("watch skips what this session posted (the ledger), advances past it, and --all (no ledger) delivers it", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const mine = localTransport({ transport: "local", path: path.join(dir, "r.ndjson") }, { actor });
    const theirs = localTransport({ transport: "local", path: path.join(dir, "r.ndjson") }, { actor: { name: "Codex", kind: "agent" } });
    const state = path.join(dir, "state");
    const posted = new Set();
    /** @type {string[]} */
    const seen = [];
    const onBatch = (/** @type {import('../src/core.mjs').Message[]} */ m) => { seen.push(...m.map((x) => x.text)); };

    posted.add((await mine.post("on watch")).id);
    let r = await watch(mine, { stateDir: state, key: "r", mode: "once", onBatch, own: () => posted });
    assert.equal(r.fired, false, "own post does not wake us");
    assert.equal(r.skipped, 1);
    assert.equal(await readCursor(state, "r"), "1", "an all-own batch still advances the cursor");

    await theirs.post("candidate ready");
    r = await watch(mine, { stateDir: state, key: "r", mode: "once", onBatch, own: () => posted });
    assert.equal(r.fired, true);
    assert.deepEqual(seen, ["candidate ready"]);
    assert.equal(r.delivered, 1);

    // --all: no own function at all, so our own post is delivered like any other
    posted.add((await mine.post("echo")).id);
    r = await watch(mine, { stateDir: state, key: "r", mode: "once", onBatch });
    assert.equal(r.fired, true);
    assert.deepEqual(seen, ["candidate ready", "echo"]);
  } finally {
    await cleanup();
  }
});

/**
 * One bot user (the seat), several signatures under it. The local transport cannot express this
 * (its whoami is the actor), so this is the Slack transport with an injected fetch.
 * @param {Array<{ ts: string, text: string, user?: string, bot_id?: string }>} history
 */
function seat(history) {
  const { fetch } = fakeFetch([
    ["auth.test", () => ({ body: { ok: true, user_id: "UBOT", user: "examplebot" } })],
    ["users.info", (url) => ({ body: { ok: true, user: { id: url.searchParams.get("user"), real_name: "alex" } } })],
    ["conversations.history", (url) => {
      const oldest = Number(url.searchParams.get("oldest") ?? 0);
      return { body: { ok: true, messages: [...history].reverse().filter((m) => Number(m.ts) > oldest), has_more: false } };
    }],
  ]);
  return slackTransport({ transport: "slack", channel: "C1" }, { token: "xoxb-1", fetch });
}
const fromSeat = (/** @type {string} */ ts, /** @type {string} */ text) => ({ ts, text, user: "UBOT", bot_id: "B1", bot_profile: { name: "example_bot" } });

test("two bearers on one bot: a bearer's watch delivers its sibling's posts and skips only its own", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const t = seat([
      { ts: "1.000100", text: "hey", user: "U2" },
      fromSeat("1.000200", "watch armed\n\n-- Grace/watch"),
      { ts: "1.000300", text: "candidate up\n\n-- Codex", user: "UOTHER", bot_id: "B2" },
      fromSeat("1.000400", "the design is settled\n\n-- Opus/design"),
    ]);
    const posted = new Set(["1.000200"]); // Grace/watch's own ledger
    /** @type {string[]} */
    const seen = [];
    const r = await watch(t, { stateDir: path.join(dir, "s"), key: "c", mode: "once", own: () => posted, onBatch: (m) => { seen.push(...m.map((x) => x.signedAs ?? x.author.name)); } });
    assert.equal(r.fired, true);
    assert.deepEqual(seen, ["alex", "Codex", "Opus/design"]);
    assert.equal(r.skipped, 1);
    assert.equal(await readCursor(path.join(dir, "s"), "c"), "1.000400");
  } finally {
    await cleanup();
  }
});

test("two sessions of one model, signing identically: each delivers the other's post", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const t = seat([
      fromSeat("1.000100", "I took the download stage\n\n-- Grace"),
      fromSeat("1.000200", "I am on the audit\n\n-- Grace"),
    ]);
    const a = new Set(["1.000100"]);
    const b = new Set(["1.000200"]);
    /** @type {string[]} */
    const seenA = [];
    /** @type {string[]} */
    const seenB = [];
    await watch(t, { stateDir: path.join(dir, "a"), key: "c", mode: "once", own: () => a, onBatch: (m) => { seenA.push(...m.map((x) => x.text.split("\n")[0])); } });
    await watch(t, { stateDir: path.join(dir, "b"), key: "c", mode: "once", own: () => b, onBatch: (m) => { seenB.push(...m.map((x) => x.text.split("\n")[0])); } });
    assert.deepEqual(seenA, ["I am on the audit"]);
    assert.deepEqual(seenB, ["I took the download stage"]);
  } finally {
    await cleanup();
  }
});

test("an unsigned seat post is skipped by the session that posted it and delivered to every other", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const t = seat([fromSeat("1.000100", "no signature here at all")]);
    /** @type {string[]} */
    const seenAuthor = [];
    /** @type {string[]} */
    const seenPeer = [];
    await watch(t, { stateDir: path.join(dir, "a"), key: "c", mode: "once", own: () => new Set(["1.000100"]), onBatch: (m) => { seenAuthor.push(...m.map((x) => x.text)); } });
    await watch(t, { stateDir: path.join(dir, "b"), key: "c", mode: "once", own: () => new Set(), onBatch: (m) => { seenPeer.push(...m.map((x) => x.text)); } });
    assert.deepEqual(seenAuthor, []);
    assert.deepEqual(seenPeer, ["no signature here at all"]);
  } finally {
    await cleanup();
  }
});

test("a crash while delivering does not advance the cursor; the next watch re-delivers", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const t = localTransport({ transport: "local", path: path.join(dir, "r.ndjson") }, { actor });
    const state = path.join(dir, "s");
    await t.post("the candidate url");
    await assert.rejects(() => watch(t, { stateDir: state, key: "r", mode: "once", onBatch: () => { throw new Error("session died acting on the batch"); } }), /session died/);
    assert.equal(await readCursor(state, "r"), undefined, "cursor not advanced past an undelivered batch");
    /** @type {string[]} */
    const seen = [];
    const r = await watch(t, { stateDir: state, key: "r", mode: "once", onBatch: (m) => { seen.push(...m.map((x) => x.text)); } });
    assert.equal(r.fired, true);
    assert.deepEqual(seen, ["the candidate url"]);
    assert.equal(await readCursor(state, "r"), "1");
  } finally {
    await cleanup();
  }
});

test("a streaming watch re-reads the ledger each poll, so a post from the same session mid-stream is not echoed", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const t = localTransport({ transport: "local", path: path.join(dir, "r.ndjson") }, { actor });
    const posted = new Set();
    let clock = 0;
    let n = 0;
    /** @type {string[]} */
    const seen = [];
    await watch(t, {
      stateDir: path.join(dir, "s"), key: "r", mode: "stream", interval: 5, forSeconds: 12, own: () => posted,
      onBatch: (m) => { seen.push(...m.map((x) => x.text)); }, now: () => clock,
      sleep: async (ms) => { clock += ms; n++; if (n === 1) posted.add((await t.post("mine, mid-stream")).id); else await t.post(`theirs ${n}`); },
    });
    assert.deepEqual(seen, ["theirs 2"]);
  } finally {
    await cleanup();
  }
});
