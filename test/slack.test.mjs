// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { slackTransport } from "../src/transports/slack.mjs";
import { fakeFetch } from "./helpers.mjs";

const history = [
  { ts: "1756900000.000400", user: "U2", text: "latest human", thread_ts: undefined },
  { ts: "1756900000.000300", bot_id: "B1", subtype: "bot_message", username: "Codex", text: "candidate up\n\n-- Codex" },
  { ts: "1756900000.000250", user: "U2", text: "a reply", thread_ts: "1756900000.000100" },
  { ts: "1756900000.000200", user: "U9", subtype: "channel_join", text: "joined" },
  { ts: "1756900000.000100", user: "U2", text: "parent", thread_ts: "1756900000.000100", reply_count: 1 },
];

function make({ rateLimitOnce = false } = {}) {
  let limited = rateLimitOnce;
  /** @type {number[]} */
  const slept = [];
  const { fetch, calls } = fakeFetch([
    ["auth.test", () => ({ body: { ok: true, user_id: "UBOT", user: "claude-bot" } })],
    ["users.info", (url) => ({ body: { ok: true, user: { id: url.searchParams.get("user"), real_name: "peer" } } })],
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
  const t = slackTransport({ transport: "slack", channel: "C0123ABC" }, { token: "xoxb-1", fetch, sleep: async (ms) => { slept.push(ms); } });
  return { t, calls, slept };
}

test("slack room needs a channel id", () => {
  assert.throws(() => slackTransport({ transport: "slack", channel: "#general" }, { token: "x" }), /channel id/);
});

test("slack history: ascending, pages, skips joins and thread replies, names users, kinds", async () => {
  const { t, calls } = make();
  const msgs = await t.read();
  assert.deepEqual(msgs.map((m) => m.text), ["parent", "candidate up\n\n-- Codex", "latest human"]);
  assert.deepEqual(msgs.map((m) => m.author.kind), ["human", "agent", "human"]);
  assert.equal(msgs[0].author.name, "peer");
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
    ["users.info", () => ({ body: { ok: true, user: { id: "U2", real_name: "peer" } } })],
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

test("slack 429 waits retry-after and retries", async () => {
  const { t, slept } = make({ rateLimitOnce: true });
  const msgs = await t.read();
  assert.equal(msgs.length, 3);
  assert.deepEqual(slept, [1000]);
});

test("slack whoami and api errors", async () => {
  const { t } = make();
  assert.deepEqual(await t.whoami(), { id: "UBOT", name: "claude-bot" });
  const { fetch } = fakeFetch([["conversations.history", () => ({ body: { ok: false, error: "not_in_channel" } })]]);
  const t2 = slackTransport({ transport: "slack", channel: "C1" }, { token: "x", fetch });
  await assert.rejects(() => t2.read(), /not_in_channel/);
});
