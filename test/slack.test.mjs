// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { slackTransport, decodeSlackText, encodeSlackText, SLACK_TEXT_MAX, chunkAtLines, validateThread } from "../src/transports/slack.mjs";
import { fakeFetch, tmp } from "./helpers.mjs";

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
  const t = slackTransport({ transport: "slack", channel: "C0123ABC" }, { token: "xoxb-1", fetch, random, sleep: async (ms) => { slept.push(ms); } });
  return { t, calls, slept };
}

test("slack room needs a channel id", () => {
  assert.throws(() => slackTransport({ transport: "slack", channel: "#general" }, { token: "x" }), /channel id/);
});

test("slack system subtypes are delivered as author.kind system, not skipped", async () => {
  const { fetch } = fakeFetch([
    ["users.info", () => ({ body: { ok: true, user: { id: "U2", real_name: "peer" } } })],
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
  assert.equal(msgs[0].author.name, "peer");
  assert.equal(msgs[1].signedAs, "Codex");
  assert.equal(msgs[2].cursor, "1756900000.000400");
  assert.equal(msgs[2].ts, "2025-09-03T11:46:40.000Z");
  assert.equal(calls.filter((c) => c.url.pathname.endsWith("users.info")).length, 1, "user name is cached");
  assert.equal(calls.filter((c) => c.url.pathname.endsWith("conversations.history")).length, 2, "paged once");
});

test("slack image attachments are authenticated into bounded local media without exposing the token", async () => {
  const tdir = await tmp();
  try {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x01, 0x02, 0x03]);
    const file = {
      id: "F0123IMAGE",
      name: "screen shot.jpg",
      mimetype: "image/jpeg",
      size: bytes.length,
      original_w: 1080,
      original_h: 2340,
      permalink: "https://workspace.slack.com/files/U1/F0123IMAGE/screen-shot",
      url_private_download: "https://files.slack.com/files-pri/T1-F0123IMAGE/download/screen-shot.jpg",
      url_private: "https://files.slack.com/files-pri/T1-F0123IMAGE/screen-shot.jpg",
      thumb_360: "https://files.slack.com/files-tmb/T1-F0123IMAGE/screen-shot-360.jpg",
    };
    const api = fakeFetch([
      ["users.info", () => ({ body: { ok: true, user: { id: "U2", real_name: "operator" } } })],
      ["conversations.history", () => ({ body: { ok: true, messages: [{ ts: "1756900000.000100", user: "U2", text: "look", files: [file] }], has_more: false } })],
    ]);
    /** @type {RequestInit | undefined} */
    let downloadInit;
    const fetchFile = /** @type {typeof globalThis.fetch} */ (async (input, init) => {
      if (String(input).startsWith("https://files.slack.com/")) {
        downloadInit = init;
        return new Response(bytes, { headers: { "content-type": "image/jpeg", "content-length": String(bytes.length) } });
      }
      return api.fetch(input, init);
    });
    const transport = slackTransport({ transport: "slack", channel: "C1" }, { token: "xoxb-private", fetch: fetchFile, mediaDir: tdir.dir });
    const [message] = await transport.read();
    assert.equal(message.attachments?.length, 1);
    assert.deepEqual(message.attachments?.[0], {
      id: "F0123IMAGE", name: "screen shot.jpg", kind: "image", mimetype: "image/jpeg",
      size: bytes.length, width: 1080, height: 2340,
      url: "https://workspace.slack.com/files/U1/F0123IMAGE/screen-shot",
      path: message.attachments?.[0].path,
    });
    assert.match(message.attachments?.[0].path ?? "", /F0123IMAGE\.jpg$/);
    assert.deepEqual(await readFile(message.attachments?.[0].path ?? ""), bytes);
    assert.equal(/** @type {Record<string, string>} */ (downloadInit?.headers).authorization, "Bearer xoxb-private");
    const raw = /** @type {any} */ (message.raw);
    assert.equal(raw.files[0].url_private, undefined);
    assert.equal(raw.files[0].url_private_download, undefined);
    assert.equal(raw.files[0].thumb_360, undefined);
    assert.equal(raw.files[0].permalink, file.permalink);
    assert.ok(!JSON.stringify(message.attachments).includes("xoxb-private"));
    assert.ok(!JSON.stringify(message).includes("files-pri"));
  } finally {
    await tdir.cleanup();
  }
});

test("slack still delivers attachment metadata when image bytes are unavailable or over the cap", async () => {
  const tdir = await tmp();
  try {
    const files = [
      { id: "F403", name: "denied.png", mimetype: "image/png", size: 12, url_private: "https://files.slack.com/denied" },
      { id: "FBIG", name: "huge.png", mimetype: "image/png", size: 99, url_private: "https://files.slack.com/huge" },
      { id: "FDOC", name: "notes.txt", mimetype: "text/plain", size: 4, url_private: "https://files.slack.com/doc" },
    ];
    const api = fakeFetch([
      ["users.info", () => ({ body: { ok: true, user: { id: "U2", real_name: "operator" } } })],
      ["conversations.history", () => ({ body: { ok: true, messages: [{ ts: "1756900000.000100", user: "U2", text: "files", files }], has_more: false } })],
    ]);
    const fetchFile = /** @type {typeof globalThis.fetch} */ (async (input, init) => String(input).startsWith("https://files.slack.com/")
      ? new Response("denied", { status: 403, headers: { "content-type": "text/html" } })
      : api.fetch(input, init));
    const transport = slackTransport({ transport: "slack", channel: "C1" }, { token: "x", fetch: fetchFile, mediaDir: tdir.dir, imageMaxBytes: 50 });
    const [message] = await transport.read();
    assert.match(message.attachments?.[0].error ?? "", /HTTP 403; reinstall the Slack app with files:read/);
    assert.match(message.attachments?.[1].error ?? "", /exceeds the 50-byte limit/);
    assert.deepEqual(message.attachments?.[2], { id: "FDOC", name: "notes.txt", kind: "file", mimetype: "text/plain", size: 4 });
    assert.equal(message.text, "files", "attachment failure never suppresses the message text");
  } finally {
    await tdir.cleanup();
  }
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
  assert.equal(encodeSlackText("hi <@U0123456780> see <https://example.com|x>"), "hi <@U0123456780> see <https://example.com|x>");
  assert.equal(decodeSlackText("n &gt; 1 and sessions/&lt;s&gt;/"), "n > 1 and sessions/<s>/");
  assert.equal(decodeSlackText("&amp;lt;"), "&lt;");
  const { t, calls } = make();
  await t.post("n > 1");
  assert.equal(JSON.parse(String(calls.at(-1)?.init?.body)).text, "n &gt; 1");
  const { fetch } = fakeFetch([
    ["users.info", () => ({ body: { ok: true, user: { id: "U2", real_name: "peer" } } })],
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

test("the constructed slack transport carries validateThread: nothing for a ts, a reason naming the malformation otherwise", async () => {
  const { t, calls } = make();
  assert.equal(typeof t.validateThread, "function", "the hook is on the transport object, not only exported");
  assert.equal(t.validateThread?.("1788459640.119699"), undefined);
  assert.equal(t.validateThread?.("1700000000.000001"), undefined);
  // the case this exists for: pwsh parsed an unquoted ts as a number and dropped the last digit
  const truncated = String(t.validateThread?.("1788589282.65997"));
  assert.match(truncated, /5 digits after the dot, not 6/);
  assert.match(truncated, /unquoted ts loses its trailing digits under PowerShell; quote it/);
  assert.match(String(t.validateThread?.("1788589282.6")), /1 digit after the dot, not 6/);
  assert.match(String(t.validateThread?.("1788589282.6599690")), /7 digits after the dot, not 6/);
  assert.doesNotMatch(String(t.validateThread?.("1788589282.6599690")), /PowerShell/, "too many digits is not the shell's doing");
  assert.match(String(t.validateThread?.("178858928.659969")), /9 digits before the dot, not 10/);
  assert.match(String(t.validateThread?.("")), /got an empty string/);
  assert.match(String(t.validateThread?.("   ")), /got an empty string/);
  assert.match(String(t.validateThread?.("p1")), /"p1" is not a ts at all/);
  assert.match(String(t.validateThread?.("1788589282")), /is not a ts at all/);
  assert.match(String(t.validateThread?.("1788589282.65997x")), /is not a ts at all/);
  for (const why of [t.validateThread?.("1788589282.65997"), t.validateThread?.("p1")])
    assert.match(String(why), /^a Slack thread id is the parent message's ts: 10 digits, a dot, 6 digits/, "every reason says what the shape is");
  // the export is the same function, so a non-string reaches it only from code, never argv
  assert.equal(validateThread, t.validateThread);
  assert.match(String(validateThread(1788459640.1197)), /got a number/);
  assert.match(String(validateThread(undefined)), /got nothing/);
  // validation is the caller's; read() spends the call whatever the id is
  await t.read({ thread: "1788459640.1197" });
  assert.equal(calls.filter((c) => String(c.url).includes("conversations.replies")).length, 1);
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
