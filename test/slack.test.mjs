// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { slackTransport, decodeSlackText, encodeSlackText, SLACK_TEXT_MAX, chunkAtLines, validateThread } from "../src/transports/slack.mjs";
import { fakeFetch } from "./helpers.mjs";

const history = [
  { ts: "1756900000.000400", user: "U2", text: "latest human", thread_ts: undefined },
  { ts: "1756900000.000300", bot_id: "B1", subtype: "bot_message", username: "Codex", text: "candidate up\n\n-- Codex" },
  { ts: "1756900000.000250", user: "U2", text: "a reply", thread_ts: "1756900000.000100" },
  { ts: "1756900000.000200", user: "U9", subtype: "channel_join", text: "joined" },
  { ts: "1756900000.000100", user: "U2", text: "parent", thread_ts: "1756900000.000100", reply_count: 1 },
];

function make({ rateLimitOnce = false, random = Math.random } = {}) {
  let limited = rateLimitOnce;
  /** @type {number[]} */
  const slept = [];
  const { fetch, calls } = fakeFetch([
    ["auth.test", () => ({ body: { ok: true, user_id: "UBOT", user: "claude-house" } })],
    ["users.info", (url) => ({ body: { ok: true, user: { id: url.searchParams.get("user"), real_name: "bone" } } })],
    ["conversations.history", (url) => {
      if (limited) {
        limited = false;
        return { status: 429, body: { ok: false, error: "ratelimited" }, headers: { "retry-after": "1" } };
      }
      const oldest = Number(url.searchParams.get("oldest") ?? 0);
      const page = url.searchParams.get("cursor");
      const filtered = history.filter((m) => Number(m.ts) > oldest);
      if (!page) return { body: { ok: true, messages: filtered.slice(0, 2), has_more: filtered.length > 2, response_metadata: { next_cursor: filtered.length > 2 ? "p2" : "" } } };
      return { body: { ok: true, messages: filtered.slice(2), has_more: false } };
    }],
    ["conversations.replies", () => ({ body: { ok: true, messages: [history[4], history[2]], has_more: false } })],
    ["chat.postMessage", (_url, init) => ({ body: { ok: true, ts: "1756900001.000000", channel: "C1", echo: JSON.parse(String(init?.body)) } })],
  ]);
  const t = slackTransport({ transport: "slack", channel: "C0123ABC" }, { token: "xoxb-1", fetch, random, sleep: async (ms) => { slept.push(ms); } });
  return { t, calls, slept };
}

test("slack room needs a channel id", () => {
  assert.throws(() => slackTransport({ transport: "slack", channel: "#general" }, { token: "x" }), /channel id/);
});

test("slack system subtypes are delivered as author.kind system, not skipped", async () => {
  const { fetch } = fakeFetch([
    ["users.info", () => ({ body: { ok: true, user: { id: "U2", real_name: "bone" } } })],
    ["conversations.history", () => ({
      body: {
        ok: true,
        has_more: false,
        messages: [
          { ts: "1756900000.000100", user: "U2", text: "hello" },
          { ts: "1756900000.000200", user: "U2", subtype: "channel_purpose", text: "set the channel description: x" },
          { ts: "1756900000.000250", user: "U2", subtype: "channel_join", text: "joined" },
        ],
      },
    })],
  ]);
  const t = slackTransport({ transport: "slack", channel: "C1" }, { token: "x", fetch });
  const msgs = await t.read();
  assert.deepEqual(msgs.map((m) => m.author.kind), ["human", "system"]);
  assert.equal(/** @type {any} */ (msgs[1]).subtype, "channel_purpose");
  assert.equal(msgs[1].text, "set the channel description: x");
});

test("slack history: ascending, pages, skips joins and thread replies, names users, kinds", async () => {
  const { t, calls } = make();
  const msgs = await t.read();
  assert.deepEqual(msgs.map((m) => m.text), ["parent", "candidate up\n\n-- Codex", "latest human"]);
  assert.deepEqual(msgs.map((m) => m.author.kind), ["human", "agent", "human"]);
  assert.equal(msgs[0].author.name, "bone");
  assert.equal(msgs[1].signedAs, "Codex");
  assert.equal(msgs[2].cursor, "1756900000.000400");
  assert.equal(msgs[2].ts, "2025-09-03T11:46:40.000Z");
  assert.equal(calls.filter((c) => c.url.pathname.endsWith("users.info")).length, 1, "user name is cached");
  assert.equal(calls.filter((c) => c.url.pathname.endsWith("conversations.history")).length, 2, "paged once");
});

test("slack history without a cursor returns the newest messages up to the limit; with one, the oldest after it", async () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ ts: `1756900000.00${i + 1}000`, user: "U2", text: `m${i + 1}` }));
  const { fetch } = fakeFetch([
    ["auth.test", () => ({ body: { ok: true, user_id: "UBOT", user: "b" } })],
    ["users.info", () => ({ body: { ok: true, user: { id: "U2", real_name: "bone" } } })],
    ["conversations.history", (url) => {
      const oldest = Number(url.searchParams.get("oldest") ?? 0);
      const filtered = [...many].reverse().filter((m) => Number(m.ts) > oldest);
      const page = url.searchParams.get("cursor");
      if (!page) return { body: { ok: true, messages: filtered.slice(0, 5), has_more: filtered.length > 5, response_metadata: { next_cursor: filtered.length > 5 ? "p2" : "" } } };
      return { body: { ok: true, messages: filtered.slice(5), has_more: false } };
    }],
  ]);
  const t = slackTransport({ transport: "slack", channel: "C1" }, { token: "x", fetch });
  assert.deepEqual((await t.read({ limit: 3 })).map((m) => m.text), ["m7", "m8", "m9"], "the newest three, ascending");
  assert.deepEqual((await t.read({ limit: 3, since: "1756900000.002000" })).map((m) => m.text), ["m3", "m4", "m5"], "the oldest three after the cursor");
  assert.deepEqual((await t.read()).map((m) => m.text).length, 9);
});

/**
 * A channel with `count` messages, served newest-first, 200 to a page, exactly as Slack pages
 * `conversations.history`: the cursor is the offset into what is older than `oldest`.
 * @param {number} count
 */
function deepBacklog(count) {
  const stamp = (/** @type {number} */ n) => `1700000000.${String(n).padStart(6, "0")}`;
  const newestFirst = Array.from({ length: count }, (_, i) => ({ ts: stamp(i + 1), user: "U2", username: "fixture", text: `message ${i + 1}` })).reverse();
  const { fetch, calls } = fakeFetch([
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
  return { t, calls, stamp };
}

test("slack read after a cursor it cannot reach returns nothing and a gap, never a window from the middle of the backlog", async () => {
  // the measured P0: 2,500 unseen at 200 a page. Ten pages collect the newest 2,000 and the OLDEST
  // 200 of those are messages 501-700 -- a window that looks complete. A watch saving 700 as its
  // position steps over 1-500 permanently.
  const { t, calls, stamp } = deepBacklog(2500);
  const capped = await t.read({ since: stamp(0), limit: 200 });
  assert.equal(capped.length, 0, "nothing is delivered rather than the middle of the backlog");
  assert.deepEqual(capped.gap, { reason: "backlog deeper than 10 pages", oldestFetched: stamp(501), pages: 10 });
  assert.equal(calls.length, 10, "the default cap is ten pages");

  const walked = await t.read({ since: stamp(0), limit: 200, pages: 13 });
  assert.equal(walked.gap, undefined, "a walk that reached the cursor has no gap");
  assert.deepEqual(walked.map((m) => m.text), Array.from({ length: 200 }, (_, i) => `message ${i + 1}`), "the oldest unseen 200, in order");
  assert.equal(calls.length, 10 + 13);
});

test("slack: with no cursor the page cap is not a gap, and a walk cut short after real pages is", async () => {
  // without a cursor the read promises the NEWEST `limit`, and the first page already holds them:
  // there is no unseen backlog to step over, so the cap is not a gap
  const { t, stamp } = deepBacklog(2500);
  const newest = await t.read({ limit: 3 });
  assert.equal(newest.gap, undefined);
  assert.deepEqual(newest.map((m) => m.text), ["message 2498", "message 2499", "message 2500"]);

  // a walk stopped by the transport after real pages is the same fact as the cap: an unreached
  // cursor. A first page that fails is a failed read and still throws.
  let page = 0;
  const { fetch } = fakeFetch([
    ["conversations.history", () => {
      page++;
      if (page > 2) return { body: { ok: false, error: "ratelimited" } };
      return { body: { ok: true, messages: [{ ts: stamp(1000 - page), user: "U2", text: `p${page}` }], has_more: true, response_metadata: { next_cursor: String(page) } } };
    }],
  ]);
  const t2 = slackTransport({ transport: "slack", channel: "C1" }, { token: "x", fetch, sleep: async () => {} });
  const cut = await t2.read({ since: stamp(1), limit: 200 });
  assert.equal(cut.length, 0);
  assert.match(String(cut.gap?.reason), /the walk stopped after 2 of 10 pages: slack conversations\.history: ratelimited/);
  assert.equal(cut.gap?.oldestFetched, stamp(998));

  const dead = fakeFetch([["conversations.history", () => ({ body: { ok: false, error: "not_in_channel" } })]]);
  const t3 = slackTransport({ transport: "slack", channel: "C1" }, { token: "x", fetch: dead.fetch, sleep: async () => {} });
  await assert.rejects(() => t3.read({ since: stamp(1) }), /not_in_channel/, "nothing collected is a failed read, not a gap");
});

test("slack history since a cursor is exclusive", async () => {
  const { t, calls } = make();
  const msgs = await t.read({ since: "1756900000.000300" });
  assert.deepEqual(msgs.map((m) => m.text), ["latest human"]);
  const url = calls.find((c) => c.url.pathname.endsWith("conversations.history"))?.url;
  assert.equal(url?.searchParams.get("oldest"), "1756900000.000300");
  assert.equal(url?.searchParams.get("inclusive"), "false");
});

test("slack thread read excludes the parent", async () => {
  const { t, calls } = make();
  const msgs = await t.read({ thread: "1756900000.000100" });
  assert.deepEqual(msgs.map((m) => m.text), ["a reply"]);
  assert.equal(msgs[0].thread, "1756900000.000100");
  assert.equal(calls.find((c) => c.url.pathname.endsWith("conversations.replies"))?.url.searchParams.get("ts"), "1756900000.000100");
});

test("slack post carries thread_ts and returns ts as cursor", async () => {
  const { t, calls } = make();
  const r = await t.post("fired", { thread: "1756900000.000100" });
  assert.equal(r.id, "1756900001.000000");
  const sent = JSON.parse(String(calls.at(-1)?.init?.body));
  assert.deepEqual(sent, { channel: "C0123ABC", text: "fired", thread_ts: "1756900000.000100" });
  assert.equal(/** @type {any} */ (calls.at(-1)?.init?.headers).authorization, "Bearer xoxb-1");
});

test("slack 429 waits retry-after and retries, jittered so limited callers do not all come back together", async () => {
  const { t, slept } = make({ rateLimitOnce: true });
  const msgs = await t.read();
  assert.equal(msgs.length, 3);
  assert.equal(slept.length, 1);
  assert.ok(slept[0] >= 900 && slept[0] <= 1100, `${slept[0]} is not within a tenth of the 1000 asked for`);

  // with the randomness injected, both ends of the spread are exact
  const low = make({ rateLimitOnce: true, random: () => 0 });
  await low.t.read();
  assert.deepEqual(low.slept, [900]);
  const high = make({ rateLimitOnce: true, random: () => 1 });
  await high.t.read();
  assert.deepEqual(high.slept, [1100]);
});

test("slack whoami and api errors", async () => {
  const { t } = make();
  assert.deepEqual(await t.whoami(), { id: "UBOT", name: "claude-house" });
  const { fetch } = fakeFetch([["conversations.history", () => ({ body: { ok: false, error: "not_in_channel" } })]]);
  const t2 = slackTransport({ transport: "slack", channel: "C1" }, { token: "x", fetch });
  await assert.rejects(() => t2.read(), /not_in_channel/);
});

test("slack encodes & < > on post except mention/channel/url tokens, and decodes them on read", async () => {
  assert.equal(encodeSlackText("n > 1 and sessions/<s>/"), "n &gt; 1 and sessions/&lt;s&gt;/");
  assert.equal(encodeSlackText("hi <@U0BUTHS6LUR> see <https://example.com|x>"), "hi <@U0BUTHS6LUR> see <https://example.com|x>");
  assert.equal(decodeSlackText("n &gt; 1 and sessions/&lt;s&gt;/"), "n > 1 and sessions/<s>/");
  assert.equal(decodeSlackText("&amp;lt;"), "&lt;");
  const { t, calls } = make();
  await t.post("n > 1");
  assert.equal(JSON.parse(String(calls.at(-1)?.init?.body)).text, "n &gt; 1");
  const { fetch } = fakeFetch([
    ["users.info", () => ({ body: { ok: true, user: { id: "U2", real_name: "bone" } } })],
    ["conversations.history", () => ({ body: { ok: true, messages: [{ ts: "1756900000.000100", user: "U2", text: "n &gt; 1" }], has_more: false } })],
  ]);
  const t2 = slackTransport({ transport: "slack", channel: "C1" }, { token: "x", fetch });
  assert.equal((await t2.read())[0].text, "n > 1");
});

test("slack post refuses past SLACK_TEXT_MAX with exit 2", async () => {
  const { t, calls } = make();
  const err = await t.post("x".repeat(SLACK_TEXT_MAX + 1)).then(() => undefined, (e) => e);
  assert.equal(err?.exitCode, 2);
  assert.match(String(err?.message), /limit is 3900/);
  assert.equal(calls.filter((c) => String(c.url).includes("chat.postMessage")).length, 0);
  await t.post("x".repeat(SLACK_TEXT_MAX));
  assert.equal(calls.filter((c) => String(c.url).includes("chat.postMessage")).length, 1);
});

test("validateThread is the Slack ts predicate; read does not refuse a malformed id", async () => {
  assert.equal(validateThread("1788459640.119699"), true);
  assert.equal(validateThread("1788459640.1197"), false);
  assert.equal(validateThread(1788459640.1197), false);
  const { t } = make();
  await t.read({ thread: "1788459640.1197" });
});

test("chunkAtLines prefers line boundaries and hard-splits a long line", () => {
  assert.deepEqual(chunkAtLines("ab\ncd", 3), ["ab", "cd"]);
  assert.deepEqual(chunkAtLines("abcd", 2), ["ab", "cd"]);
  assert.deepEqual(chunkAtLines("short", 40), ["short"]);
});

test("slack 5xx HTML does not reach JSON.parse", async () => {
  const fetch = async () => new Response("<html>nope", { status: 502, headers: { "content-type": "text/html" } });
  const t = slackTransport({ transport: "slack", channel: "C1" }, { token: "x", fetch: /** @type {typeof globalThis.fetch} */ (fetch) });
  await assert.rejects(() => t.read(), /HTTP 502/);
});
