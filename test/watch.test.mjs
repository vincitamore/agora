// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { localTransport } from "../src/transports/local.mjs";
import { slackTransport } from "../src/transports/slack.mjs";
import { watch } from "../src/watch.mjs";
import { readCursor, writeCursor } from "../src/core.mjs";
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
    // the sleep is jittered a tenth either way, so watches armed together do not stay in lockstep
    assert.equal(slept.length, 1);
    assert.ok(slept[0] >= 6300 && slept[0] <= 7700, `${slept[0]} is not within a tenth of 7000`);
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
    ["auth.test", () => ({ body: { ok: true, user_id: "UBOT", user: "sociusamore" } })],
    ["users.info", (url) => ({ body: { ok: true, user: { id: url.searchParams.get("user"), real_name: "operator" } } })],
    ["conversations.history", (url) => {
      const oldest = Number(url.searchParams.get("oldest") ?? 0);
      return { body: { ok: true, messages: [...history].reverse().filter((m) => Number(m.ts) > oldest), has_more: false } };
    }],
  ]);
  return slackTransport({ transport: "slack", channel: "C1" }, { token: "xoxb-1", fetch });
}
const fromSeat = (/** @type {string} */ ts, /** @type {string} */ text) => ({ ts, text, user: "UBOT", bot_id: "B1", bot_profile: { name: "socius_amore" } });

test("two bearers on one bot: a bearer's watch delivers its sibling's posts and skips only its own", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const t = seat([
      { ts: "1.000100", text: "hey", user: "U2" },
      fromSeat("1.000200", "watch armed\n\n-- Alice/watch"),
      { ts: "1.000300", text: "candidate up\n\n-- Codex", user: "UOTHER", bot_id: "B2" },
      fromSeat("1.000400", "the design is settled\n\n-- Opus/design"),
    ]);
    const posted = new Set(["1.000200"]); // Alice/watch's own ledger
    /** @type {string[]} */
    const seen = [];
    const r = await watch(t, { stateDir: path.join(dir, "s"), key: "c", mode: "once", own: () => posted, onBatch: (m) => { seen.push(...m.map((x) => x.signedAs ?? x.author.name)); } });
    assert.equal(r.fired, true);
    assert.deepEqual(seen, ["operator", "Codex", "Opus/design"]);
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
      fromSeat("1.000100", "I took the download stage\n\n-- Alice"),
      fromSeat("1.000200", "I am on the audit\n\n-- Alice"),
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

test("wake: the reader's filter drops what it chose not to wake on, counts it as filtered, and the cursor still advances", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const t = localTransport({ transport: "local", path: path.join(dir, "r.ndjson") }, { actor: { name: "Codex", kind: "agent" } });
    await t.post("for the other one\n\nto: Alice/review");
    await t.post("for me\n\nto: Alice/watch");
    await t.post("for nobody in particular");
    /** @type {string[]} */
    const seen = [];
    const wake = (/** @type {import('../src/core.mjs').Message} */ m) => !/to: Alice\/review/.test(m.text);
    const r = await watch(t, { stateDir: path.join(dir, "s"), key: "r", mode: "once", wake, onBatch: (m) => { seen.push(...m.map((x) => x.text.split("\n")[0])); } });
    assert.deepEqual(seen, ["for me", "for nobody in particular"]);
    assert.equal(r.filtered, 1);
    assert.equal(r.delivered, 2);
    assert.equal(await readCursor(path.join(dir, "s"), "r"), "3", "the cursor advanced past the filtered message too");
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

test("an external delivery checkpoint advances an accepted prefix and re-delivers only the failed suffix", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const t = localTransport({ transport: "local", path: path.join(dir, "r.ndjson") }, { actor });
    const state = path.join(dir, "s");
    await t.post("accepted");
    await t.post("failed");
    await assert.rejects(() => watch(t, {
      stateDir: state, key: "r", mode: "once",
      onBatch: async (messages, batch) => {
        await batch.checkpoint(messages[0]);
        throw new Error("second injection failed");
      },
    }), /second injection failed/);
    assert.equal(await readCursor(state, "r"), "1", "the accepted side effect is acknowledged immediately");

    /** @type {string[]} */
    const replayed = [];
    const result = await watch(t, {
      stateDir: state, key: "r", mode: "once",
      onBatch: (messages) => { replayed.push(...messages.map((m) => m.text)); },
    });
    assert.equal(result.fired, true);
    assert.deepEqual(replayed, ["failed"], "the accepted prefix is not queued a second time");
    assert.equal(await readCursor(state, "r"), "2");
  } finally {
    await cleanup();
  }
});

test("delivery checkpoints advance the right room and followed-thread cursor files", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const room = countingRoom();
    const state = path.join(dir, "s");
    room.say("", "room one", 100);
    room.say("T1", "thread one", 200);
    room.say("", "room two", 300);
    const threads = {
      ids: () => ["T1"],
      key: (/** @type {string} */ id) => `r#${id}`,
      cursor: (/** @type {string} */ id) => readCursor(state, `r#${id}`),
      interval: 1,
    };
    await assert.rejects(() => watch(room.transport, {
      stateDir: state, key: "r", mode: "once", threads,
      onBatch: async (messages, batch) => {
        for (const delivered of messages) {
          if (delivered.text === "room two") throw new Error("room two failed");
          await batch.checkpoint(delivered);
        }
      },
    }), /room two failed/);
    assert.equal(await readCursor(state, "r"), "1");
    assert.equal(await readCursor(state, "r#T1"), "1");

    /** @type {string[]} */
    const replayed = [];
    await watch(room.transport, {
      stateDir: state, key: "r", mode: "once", threads,
      onBatch: (messages) => { replayed.push(...messages.map((m) => m.text)); },
    });
    assert.deepEqual(replayed, ["room two"]);
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

/**
 * A room with threads, counting what each poll asked for. The room read never carries a thread
 * reply (which is the platform behaviour that makes `--follow` necessary), so a reply is reachable
 * only by asking for its thread by name.
 */
function countingRoom() {
  /** @type {Map<string, import('../src/core.mjs').Message[]>} */
  const lists = new Map([["", []]]);
  /** @type {{ room: number, threads: Record<string, number> }} */
  const reads = { room: 0, threads: {} };
  let clock = 0;

  /** @param {string} thread @param {string} text @param {number} ts */
  function say(thread, text, ts) {
    const list = lists.get(thread) ?? [];
    lists.set(thread, list);
    list.push({
      id: `${thread || "room"}-${list.length + 1}`,
      room: "r",
      thread: thread || undefined,
      author: { id: "them", name: "them", kind: "agent" },
      text,
      ts: new Date(ts * 1000).toISOString(),
      cursor: String(list.length + 1),
    });
  }

  /** @type {import('../src/core.mjs').Transport} */
  const transport = {
    kind: "fake",
    room: "r",
    threads: true,
    whoami: async () => ({ id: "seat", name: "seat" }),
    async read({ thread, since } = {}) {
      if (thread) reads.threads[thread] = (reads.threads[thread] ?? 0) + 1;
      else reads.room++;
      const list = lists.get(thread ?? "") ?? [];
      const from = since ? Number(since) : 0;
      return list.filter((m) => Number(m.cursor) > from);
    },
    async post() {
      return { id: "posted", cursor: "0" };
    },
  };
  return { transport, reads, say, now: () => clock, tick: (/** @type {number} */ ms) => (clock += ms) };
}

/** The follow set a test hands the watch: fixed ids, cursors in a Map, no disk. @param {string[]} ids @param {number} interval */
function followed(ids, interval) {
  return {
    ids: () => ids,
    key: (/** @type {string} */ id) => `r#${id}`,
    cursor: async () => undefined,
    interval,
  };
}

/**
 * A mutable follow set that records what the watch dropped, the way the on-disk one is written back.
 * @param {string[]} ids @param {number} interval
 */
function followSet(ids, interval) {
  /** @type {string[]} */
  const dropped = [];
  const live = [...ids];
  return {
    dropped,
    live,
    set: {
      ids: () => [...live],
      key: (/** @type {string} */ id) => `r#${id}`,
      cursor: async () => undefined,
      interval,
      drop: (/** @type {string} */ id) => {
        dropped.push(id);
        const at = live.indexOf(id);
        if (at >= 0) live.splice(at, 1);
      },
    },
  };
}

test("--follow reaches a thread reply, reads the room every poll and each thread at its own cadence", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const room = countingRoom();
    room.say("", "in the channel", 100);
    room.say("T1", "the reply the room read never carries", 101);
    /** @type {string[]} */
    const seen = [];
    const r = await watch(room.transport, {
      stateDir: path.join(dir, "s"), key: "r", mode: "stream", interval: 15, forSeconds: 60,
      threads: followed(["T1"], 60),
      onBatch: (m) => { seen.push(...m.map((x) => x.text)); },
      now: room.now, random: () => 0.5, sleep: async (ms) => { room.tick(ms); },
    });
    assert.deepEqual(seen, ["in the channel", "the reply the room read never carries"]);
    assert.equal(room.reads.room, 5, "polled at 0, 15, 30, 45 and 60 seconds");
    assert.equal(room.reads.threads.T1, 2, "read when the watch armed and once a minute after");
    assert.deepEqual(r.threads, { T1: 1 }, "the watch-result line names what each followed thread delivered");
  } finally {
    await cleanup();
  }
});

test("the reads a seat spends on threads are sessions x followed x 60/threadInterval, plus one each at the arm", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const sessions = 2;
    const ids = ["T1", "T2"];
    const threadInterval = 60;
    const minutes = 2;
    let threadReads = 0;
    for (let n = 0; n < sessions; n++) {
      const room = countingRoom();
      await watch(room.transport, {
        stateDir: path.join(dir, `s${n}`), key: "r", mode: "stream", interval: 15, forSeconds: minutes * 60,
        threads: followed(ids, threadInterval),
        onBatch: () => {},
        now: room.now, random: () => 0.5, sleep: async (ms) => { room.tick(ms); },
      });
      threadReads += Object.values(room.reads.threads).reduce((a, b) => a + b, 0);
    }
    const armed = sessions * ids.length;
    assert.equal(threadReads - armed, sessions * ids.length * minutes * (60 / threadInterval));
    assert.equal(threadReads, 12, "two sessions following two threads for two minutes at a minute apiece");
  } finally {
    await cleanup();
  }
});

test("without --follow a thread reply is never asked for, and nothing else changes", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const room = countingRoom();
    room.say("", "in the channel", 100);
    room.say("T1", "in a thread", 101);
    /** @type {string[]} */
    const seen = [];
    const r = await watch(room.transport, {
      stateDir: path.join(dir, "s"), key: "r", mode: "once",
      onBatch: (m) => { seen.push(...m.map((x) => x.text)); },
    });
    assert.deepEqual(seen, ["in the channel"]);
    assert.deepEqual(room.reads.threads, {});
    assert.deepEqual(r.threads, {});
    assert.equal(r.cursor, "1");
  } finally {
    await cleanup();
  }
});

test("a merged batch is delivered in ts order across the room and the threads it followed", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const room = countingRoom();
    room.say("T2", "second", 200);
    room.say("", "first", 100);
    room.say("T1", "third", 300);
    room.say("", "fourth", 400);
    /** @type {string[]} */
    const seen = [];
    await watch(room.transport, {
      stateDir: path.join(dir, "s"), key: "r", mode: "once",
      threads: followed(["T1", "T2"], 60),
      onBatch: (m) => { seen.push(...m.map((x) => x.text)); },
    });
    assert.deepEqual(seen, ["first", "second", "third", "fourth"], "one batch, in the order the room said them");

    // a transport whose room read also carries replies (or a broadcast reply on one that does not)
    // hands the same message to both reads; it is delivered once
    const both = countingRoom();
    both.say("", "shared", 100);
    both.say("T1", "shared", 100);
    const dup = /** @type {any} */ (both.transport);
    const readOnce = dup.read.bind(dup);
    dup.read = async (/** @type {any} */ o) => (await readOnce(o)).map((/** @type {any} */ m) => ({ ...m, id: "same" }));
    /** @type {string[]} */
    const once = [];
    await watch(both.transport, {
      stateDir: path.join(dir, "s2"), key: "r", mode: "once",
      threads: followed(["T1"], 60),
      onBatch: (m) => { once.push(...m.map((x) => x.text)); },
    });
    assert.deepEqual(once, ["shared"]);
  } finally {
    await cleanup();
  }
});

test("a thread that leaves the follow set stops being read and stops being reported", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const room = countingRoom();
    room.say("T1", "in the first thread", 100);
    room.say("T2", "in the second", 101);
    const follow = followSet(["T1", "T2"], 1);
    /** @type {string[]} */
    const seen = [];
    const r = await watch(room.transport, {
      stateDir: path.join(dir, "s"), key: "r", mode: "stream", interval: 5, forSeconds: 12,
      threads: follow.set,
      onBatch: (m) => { seen.push(...m.map((x) => x.text)); },
      now: room.now, random: () => 0.5,
      // T1 ages out of the set between polls, exactly as followIdleMinutes or the cap would drop it
      sleep: async (ms) => { room.tick(ms); const at = follow.live.indexOf("T1"); if (at >= 0) follow.live.splice(at, 1); },
    });
    assert.deepEqual(seen, ["in the first thread", "in the second"]);
    assert.deepEqual(Object.keys(r.threads), ["T2"], "the result names what this watch follows now, not what it once did");
    assert.equal(r.following, 1);
    const readsAfterDrop = room.reads.threads.T1;
    assert.equal(readsAfterDrop, 1, "and a dropped thread is not read again");
  } finally {
    await cleanup();
  }
});

test("a malformed id in this session's own follow set is dropped, never a usage error; the rest keeps delivering", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const room = countingRoom();
    room.say("T1", "the answer to the claim", 100);
    // a pwsh shell that ate the last digits of a Slack ts wrote this into the follow file
    const follow = followSet(["1788529730.98", "T1"], 1);
    const transport = /** @type {import('../src/core.mjs').Transport} */ ({
      ...room.transport,
      validateThread: (/** @type {string} */ id) => (/^[0-9]{10}\.[0-9]{6}$|^T/.test(id) ? undefined : `not a thread id here (an unquoted timestamp loses its last digits under pwsh)`),
    });
    /** @type {string[]} */
    const seen = [];
    const r = await watch(transport, {
      stateDir: path.join(dir, "s"), key: "r", mode: "once",
      threads: follow.set,
      onBatch: (m) => { seen.push(...m.map((x) => x.text)); },
    });
    assert.deepEqual(seen, ["the answer to the claim"], "the good thread still delivers");
    assert.deepEqual(follow.dropped, ["1788529730.98"], "and the bad key is gone from the set");
    assert.deepEqual(Object.keys(r.threads), ["T1"]);
    assert.equal(room.reads.threads["1788529730.98"], undefined, "the transport was never asked for it");
  } finally {
    await cleanup();
  }
});

test("on the slack transport itself, a malformed follow is reported with the reason and never read; the well-formed follow delivers", async () => {
  const { dir, cleanup } = await tmp();
  const good = "1700000000.000100";
  // what a `post --thread 1788589282.659969` typed unquoted into pwsh wrote into the follow file
  const bad = "1788589282.65997";
  const { fetch, calls } = fakeFetch([
    ["users.info", () => ({ body: { ok: true, user: { id: "U2", real_name: "peer" } } })],
    ["conversations.history", () => ({ body: { ok: true, messages: [], has_more: false } })],
    ["conversations.replies", () => ({
      body: {
        ok: true,
        has_more: false,
        messages: [
          { ts: good, user: "U2", text: "parent", thread_ts: good, reply_count: 1 },
          { ts: "1700000000.000200", user: "U2", text: "the reply in the good thread", thread_ts: good },
        ],
      },
    })],
  ]);
  const transport = slackTransport({ transport: "slack", channel: "C1" }, { token: "x", fetch });
  const follow = followSet([bad, good], 1);
  /** @type {string[]} */
  const reported = [];
  const error = console.error;
  console.error = (/** @type {unknown[]} */ ...a) => { reported.push(a.map(String).join(" ")); };
  try {
    /** @type {string[]} */
    const seen = [];
    const r = await watch(transport, {
      stateDir: path.join(dir, "s"), key: "r", mode: "once",
      threads: follow.set,
      onBatch: (m) => { seen.push(...m.map((x) => x.text)); },
    });
    assert.ok(seen.includes("the reply in the good thread"), `the good thread still delivers (got ${JSON.stringify(seen)})`);
    assert.deepEqual(follow.dropped, [bad], "the bad key is gone from the set");
    assert.deepEqual(Object.keys(r.threads), [good]);
    const asked = calls.filter((c) => String(c.url).includes("conversations.replies")).map((c) => new URL(String(c.url)).searchParams.get("ts"));
    assert.deepEqual(asked, [good], "Slack was asked for the good thread only; the malformed id never reached the API");
    const line = reported.find((l) => l.includes(`dropped follow ${bad}`));
    assert.ok(line, `the drop is reported (stderr was ${JSON.stringify(reported)})`);
    assert.match(String(line), /5 digits after the dot, not 6/);
    assert.match(String(line), /unquoted ts loses its trailing digits under PowerShell/);
  } finally {
    console.error = error;
    await cleanup();
  }
});

test("a followed thread the transport cannot read is dropped and the room watch carries on", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const room = countingRoom();
    room.say("", "in the channel", 100);
    const follow = followSet(["T404"], 1);
    const transport = /** @type {import('../src/core.mjs').Transport} */ ({
      ...room.transport,
      read: async (/** @type {import('../src/core.mjs').ReadOptions} */ o = {}) => {
        if (o.thread === "T404") throw new Error("thread_not_found");
        return room.transport.read(o);
      },
    });
    /** @type {string[]} */
    const seen = [];
    const r = await watch(transport, {
      stateDir: path.join(dir, "s"), key: "r", mode: "once",
      threads: follow.set,
      onBatch: (m) => { seen.push(...m.map((x) => x.text)); },
    });
    assert.deepEqual(seen, ["in the channel"]);
    assert.deepEqual(follow.dropped, ["T404"]);
    assert.deepEqual(r.threads, {}, "a dropped thread leaves no key behind in the result");
  } finally {
    await cleanup();
  }
});

test("a rate-limited follow is kept for the next poll, not dropped", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const room = countingRoom();
    room.say("", "in the channel", 100);
    const follow = followSet(["T429"], 1);
    const transport = /** @type {import('../src/core.mjs').Transport} */ ({
      ...room.transport,
      read: async (/** @type {import('../src/core.mjs').ReadOptions} */ o = {}) => {
        if (o.thread === "T429") throw new Error("slack conversations.replies: rate limited");
        return room.transport.read(o);
      },
    });
    const r = await watch(transport, {
      stateDir: path.join(dir, "s"), key: "r", mode: "once",
      threads: follow.set,
      onBatch: () => {},
    });
    assert.deepEqual(follow.dropped, [], "a 429 is transient");
    assert.equal("T429" in r.threads, true);
  } finally {
    await cleanup();
  }
});

test("watch delivers a message carrying ack: none; the tool does not filter on it", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const t = localTransport({ transport: "local", path: path.join(dir, "r.ndjson") }, { actor });
    await t.post("fyi, no receipt\n\nack: none");
    /** @type {string[]} */
    const seen = [];
    const r = await watch(t, {
      stateDir: path.join(dir, "s"), key: "r", mode: "once",
      onBatch: (m) => { seen.push(...m.map((x) => x.text)); },
    });
    assert.equal(r.fired, true);
    assert.equal(seen.length, 1);
    assert.match(seen[0], /ack: none/);
  } finally {
    await cleanup();
  }
});

test("a batch hands the caller the counts of THAT poll, beside the running totals", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const t = localTransport({ transport: "local", path: path.join(dir, "r.ndjson") }, { actor });
    const mine = await t.post("my own line");
    await t.post("for the other one" + String.fromCharCode(10) + String.fromCharCode(10) + "to: Codex");
    await t.post("for anyone");
    /** @type {Array<{ delivered: number, skipped: number, filtered: number }>} */
    const batches = [];
    const r = await watch(t, {
      stateDir: path.join(dir, "s"), key: "r", mode: "once",
      own: () => new Set([mine.id]),
      wake: (m) => !/to: Codex/.test(m.text),
      onBatch: (_m, batch) => { batches.push(batch); },
    });
    assert.deepEqual(batches, [{ delivered: 1, skipped: 1, filtered: 1 }]);
    assert.deepEqual([r.delivered, r.skipped, r.filtered], [1, 1, 1]);
    assert.equal(typeof r.elapsedMs, "number");
    assert.equal(r.following, 0);
  } finally {
    await cleanup();
  }
});

test("watch coalesce holds until the window, then one onBatch; cursor stays on disk until flush", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const t = localTransport({ transport: "local", path: path.join(dir, "r.ndjson") }, { actor });
    const state = path.join(dir, "s");
    let clock = 0;
    /** @type {string[][]} */
    const batches = [];
    const p = watch(t, {
      stateDir: state, key: "r", mode: "stream", interval: 5, forSeconds: 20,
      coalesceSeconds: 10, maxBatch: 0,
      onBatch: (m) => { batches.push(m.map((x) => x.text)); },
      now: () => clock,
      random: () => 0.5,
      sleep: async (ms) => { clock += ms; if (clock === 5_000) await t.post("one"); if (clock === 10_000) await t.post("two"); },
    });
    const r = await p;
    assert.equal(r.fired, true);
    assert.equal(batches.length, 1, "one envelope for the window");
    assert.deepEqual(batches[0], ["one", "two"]);
    assert.equal(await readCursor(state, "r"), "2");
  } finally {
    await cleanup();
  }
});

test("watch coalesce persists an own-only poll for both the room and followed threads", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const room = countingRoom();
    const state = path.join(dir, "s");
    room.say("", "my room post", 100);
    room.say("T1", "my thread reply", 101);
    let clock = 0;
    /** @type {Array<string | undefined> | undefined} */
    let duringRun;
    const r = await watch(room.transport, {
      stateDir: state, key: "r", mode: "stream", interval: 5, forSeconds: 8,
      coalesceSeconds: 20,
      own: () => new Set(["room-1", "T1-1"]),
      threads: followed(["T1"], 60),
      onBatch: () => { throw new Error("an own-only poll must not deliver"); },
      now: () => clock, random: () => 0.5,
      sleep: async (ms) => {
        duringRun = [await readCursor(state, "r"), await readCursor(state, "r#T1")];
        clock += ms;
      },
    });
    assert.deepEqual(duringRun, ["1", "1"], "safe positions persist before the next poll or shutdown");
    assert.deepEqual([r.delivered, r.skipped, r.filtered], [0, 2, 0]);
  } finally {
    await cleanup();
  }
});

test("watch coalesce persists a filtered-only poll for both the room and followed threads", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const room = countingRoom();
    const state = path.join(dir, "s");
    room.say("", "addressed elsewhere", 100);
    room.say("T1", "thread reply addressed elsewhere", 101);
    const r = await watch(room.transport, {
      stateDir: state, key: "r", mode: "once",
      coalesceSeconds: 20,
      wake: () => false,
      threads: followed(["T1"], 60),
      onBatch: () => { throw new Error("a filtered-only poll must not deliver"); },
    });
    assert.equal(await readCursor(state, "r"), "1");
    assert.equal(await readCursor(state, "r#T1"), "1");
    assert.deepEqual([r.delivered, r.skipped, r.filtered], [0, 0, 2]);
  } finally {
    await cleanup();
  }
});

test("watch coalesce: a message urgent for this bearer flushes immediately", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const t = localTransport({ transport: "local", path: path.join(dir, "r.ndjson") }, { actor });
    await t.post("noise");
    await t.post("for me\n\nto: Grok");
    /** @type {string[][]} */
    const batches = [];
    const r = await watch(t, {
      stateDir: path.join(dir, "s"), key: "r", mode: "once",
      coalesceSeconds: 30,
      urgent: (m) => /to: Grok/.test(m.text),
      onBatch: (m) => { batches.push(m.map((x) => x.text)); },
    });
    assert.equal(r.fired, true);
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0], ["noise", "for me\n\nto: Grok"]);
  } finally {
    await cleanup();
  }
});

test("watch coalesce: maxBatch flushes at n; death before flush does not persist the cursor", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const t = localTransport({ transport: "local", path: path.join(dir, "r.ndjson") }, { actor });
    const state = path.join(dir, "s");
    await t.post("a");
    /** @type {string[][]} */
    const batches = [];
    // window never elapses, maxBatch is 2, only one message: --once flushes what it holds on the way out
    let r = await watch(t, {
      stateDir: state, key: "r", mode: "once",
      coalesceSeconds: 30, maxBatch: 2,
      onBatch: (m) => { batches.push(m.map((x) => x.text)); },
    });
    assert.equal(r.fired, true, "--once still delivers the held window when it returns");
    assert.deepEqual(batches, [["a"]]);

    await t.post("b");
    await t.post("c");
    /** @type {string[]} */
    const seen = [];
    r = await watch(t, {
      stateDir: state, key: "r", mode: "once",
      coalesceSeconds: 30, maxBatch: 2,
      onBatch: (m) => { seen.push(...m.map((x) => x.text)); },
    });
    assert.deepEqual(seen, ["b", "c"], "maxBatch 2 flushes without waiting for the window");
  } finally {
    await cleanup();
  }
});

test("watch coalesce: own and filtered suffixes cannot advance past an unacknowledged delivery", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const t = localTransport({ transport: "local", path: path.join(dir, "r.ndjson") }, { actor });
    const state = path.join(dir, "s");
    await t.post("held external delivery");
    const mine = await t.post("my later post");
    await t.post("later filtered message");
    let clock = 0;
    let sawCursorDuringHold = /** @type {string | undefined} */ (undefined);
    /** @type {string[]} */
    const delivered = [];
    await watch(t, {
      stateDir: state, key: "r", mode: "stream", interval: 5, forSeconds: 8,
      coalesceSeconds: 30,
      own: () => new Set([mine.id]),
      wake: (m) => !m.text.includes("filtered"),
      onBatch: (messages) => { delivered.push(...messages.map((m) => m.text)); },
      now: () => clock,
      random: () => 0.5,
      sleep: async (ms) => {
        sawCursorDuringHold = await readCursor(state, "r");
        clock += ms;
      },
    });
    assert.equal(sawCursorDuringHold, undefined, "no suffix moves past the held external delivery");
    assert.deepEqual(delivered, ["held external delivery"]);
    assert.equal(await readCursor(state, "r"), "3", "delivery acknowledgement releases its safe suffix too");
  } finally {
    await cleanup();
  }
});

test("a guard stops before the next transport read and carries a machine-readable reason", async () => {
  const { dir, cleanup } = await tmp();
  try {
    let reads = 0;
    const t = localTransport({ transport: "local", path: path.join(dir, "r.ndjson") }, { actor });
    const guarded = { ...t, read: async (opts = {}) => { reads++; return t.read(opts); } };
    const result = await watch(guarded, {
      stateDir: path.join(dir, "s"), key: "r", mode: "stream", interval: 1,
      guard: () => "the delivery target is no longer live",
      onBatch: () => {},
    });
    assert.equal(reads, 0);
    assert.equal(result.polls, 0);
    assert.equal(result.reason, "the delivery target is no longer live");
    assert.equal(result.fired, false);
  } finally {
    await cleanup();
  }
});

test("watch: a room read that could not reach the cursor delivers nothing, advances nothing, and carries the gap", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const stamp = (/** @type {number} */ n) => `1700000000.${String(n).padStart(6, "0")}`;
    const newestFirst = Array.from({ length: 2500 }, (_, i) => ({ ts: stamp(i + 1), user: "U2", username: "fixture", text: `message ${i + 1}` })).reverse();
    const { fetch } = fakeFetch([
      ["conversations.history", (url) => {
        const oldest = url.searchParams.get("oldest") ?? "";
        const eligible = newestFirst.filter((m) => m.ts > oldest);
        const offset = Number(url.searchParams.get("cursor") ?? 0);
        const end = offset + Number(url.searchParams.get("limit") ?? 200);
        const more = end < eligible.length;
        return { body: { ok: true, messages: eligible.slice(offset, end), has_more: more, response_metadata: { next_cursor: more ? String(end) : "" } } };
      }],
    ]);
    const t = slackTransport({ transport: "slack", channel: "C1" }, { token: "x", fetch });
    const state = path.join(dir, "state");
    await writeCursor(state, "r", stamp(0));

    /** @type {string[][]} */
    const batches = [];
    const r = await watch(t, { stateDir: state, key: "r", mode: "once", onBatch: (m) => { batches.push(m.map((x) => x.text)); } });
    assert.equal(r.fired, false, "nothing is delivered out of a backlog the walk could not reach the cursor through");
    assert.equal(batches.length, 0);
    assert.deepEqual(r.gap, { reason: "backlog deeper than 10 pages", oldestFetched: stamp(501), pages: 10 });
    assert.equal(await readCursor(state, "r"), stamp(0), "and the saved position did not move");

    // the same watch told to walk deeper delivers the oldest unseen and advances through them
    const deep = await watch(t, { stateDir: state, key: "r", mode: "once", pages: 13, onBatch: (m) => { batches.push(m.map((x) => x.text)); } });
    assert.equal(deep.fired, true);
    assert.equal(deep.gap, undefined);
    assert.deepEqual([batches[0][0], batches[0].at(-1)], ["message 1", "message 200"]);
    assert.equal(await readCursor(state, "r"), stamp(200));
  } finally {
    await cleanup();
  }
});
