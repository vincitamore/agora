// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { githubTransport } from "../src/transports/github.mjs";
import { fakeFetch } from "./helpers.mjs";

const comments = [
  { id: 10, created_at: "2026-09-03T05:00:00Z", updated_at: "2026-09-03T07:00:00Z", body: "old, edited later", user: { login: "peer", type: "User" }, html_url: "u10" },
  { id: 11, created_at: "2026-09-03T06:00:00Z", updated_at: "2026-09-03T06:00:00Z", body: "candidate ready", user: { login: "peer", type: "User" }, html_url: "u11" },
  { id: 12, created_at: "2026-09-03T06:00:00Z", updated_at: "2026-09-03T06:00:00Z", body: "fired\n\n-- Claude (house)", user: { login: "alex", type: "User" }, html_url: "u12" },
  { id: 13, created_at: "2026-09-03T06:30:00Z", updated_at: "2026-09-03T06:30:00Z", body: "bot says", user: { login: "app[bot]", type: "Bot" }, html_url: "u13" },
];

/** @param {{ etag?: string, cache?: any }} [opts] */
function make(opts = {}) {
  const { fetch, calls } = fakeFetch([
    ["/user", () => ({ body: { id: 7, login: "vincitamore" } })],
    ["/issues/3/comments", (url, init) => {
      if (opts.etag) {
        const sent = /** @type {any} */ (init?.headers ?? {})["if-none-match"];
        if (sent === opts.etag) return { status: 304 };
        return { body: comments, headers: { etag: opts.etag } };
      }
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        return { status: 201, body: { id: 99, created_at: "2026-09-03T08:00:00Z", body: body.body, user: { login: "vincitamore", type: "User" }, html_url: "u99" } };
      }
      const since = url.searchParams.get("since");
      return { body: since ? comments.filter((c) => c.updated_at >= since) : comments };
    }],
  ]);
  const t = githubTransport({ transport: "github", repo: "example-org/example-repo", issue: 3 }, { token: "ghp_x", fetch, cache: opts.cache });
  return { t, calls, fetch };
}

/** A validator store that outlives a transport instance, as the file under a session does. */
function memoryCache() {
  /** @type {Map<string, string>} */
  const m = new Map();
  return { m, get: async (/** @type {string} */ k) => m.get(k), set: async (/** @type {string} */ k, /** @type {string} */ v) => void m.set(k, v) };
}

test("github room validates config", () => {
  assert.throws(() => githubTransport({ transport: "github", repo: "bad", issue: 3 }, { token: "t" }), /owner\/name/);
  assert.throws(() => githubTransport({ transport: "github", repo: "a/b", issue: 0 }, { token: "t" }), /issue number/);
});

test("github room reads ascending with cursors, kinds and signatures", async () => {
  const { t, calls } = make();
  const msgs = await t.read();
  assert.deepEqual(msgs.map((m) => m.id), ["10", "11", "12", "13"]);
  assert.equal(msgs[0].cursor, "2026-09-03T05:00:00Z|10");
  assert.equal(msgs[2].signedAs, "Claude (house)");
  assert.equal(msgs[2].author.kind, "human");
  assert.equal(msgs[3].author.kind, "agent");
  assert.equal(msgs[0].room, "example-org/example-repo#3");
  assert.equal(calls[0].init?.headers && /** @type {any} */ (calls[0].init.headers).authorization, "Bearer ghp_x");
});

test("github room: since excludes edited-old comments and ties on created_at", async () => {
  const { t } = make();
  const after11 = await t.read({ since: "2026-09-03T06:00:00Z|11" });
  assert.deepEqual(after11.map((m) => m.id), ["12", "13"], "same-second comment with a higher id is new; the edited old one is not");
  const after13 = await t.read({ since: "2026-09-03T06:30:00Z|13" });
  assert.deepEqual(after13, []);
});

test("github room posts a comment and refuses threads", async () => {
  const { t, calls } = make();
  const r = await t.post("hello");
  assert.equal(r.id, "99");
  assert.equal(r.url, "u99");
  assert.equal(r.cursor, "2026-09-03T08:00:00Z|99");
  assert.equal(JSON.parse(String(calls.at(-1)?.init?.body)).body, "hello");
  await assert.rejects(() => t.post("x", { thread: "1" }), /no threads/);
  await assert.rejects(() => t.read({ thread: "1" }), /no threads/);
  assert.deepEqual(await t.whoami(), { id: "7", name: "vincitamore" });
});

test("github room surfaces API errors with status and message", async () => {
  const { fetch } = fakeFetch([["/issues/3/comments", () => ({ status: 403, body: { message: "Resource not accessible" } })]]);
  const t = githubTransport({ transport: "github", repo: "a/b", issue: 3 }, { token: "t", fetch });
  await assert.rejects(() => t.read(), /403 Resource not accessible/);
});

test("github room sends the validator it was given last and reads a not-modified answer as an empty batch", async () => {
  const cache = memoryCache();
  const first = make({ etag: 'W/"abc123"', cache });
  assert.equal((await first.t.read()).length, 4);
  assert.equal(/** @type {any} */ (first.calls[0].init?.headers)["if-none-match"], undefined, "nothing to send the first time");
  assert.equal(cache.m.size, 1, "and the validator is kept where a later process can find it");

  const again = await first.t.read();
  assert.deepEqual(again, [], "not modified is no messages, not an error");
  assert.equal(/** @type {any} */ (first.calls.at(-1)?.init?.headers)["if-none-match"], 'W/"abc123"');

  // a fresh instance holds nothing of its own: the store is what makes this survive a re-arm
  const fresh = make({ etag: 'W/"abc123"', cache });
  assert.deepEqual(await fresh.t.read(), []);
  assert.equal(/** @type {any} */ (fresh.calls.at(-1)?.init?.headers)["if-none-match"], 'W/"abc123"');

  const uncached = make({ etag: 'W/"abc123"' });
  assert.equal((await uncached.t.read()).length, 4, "with no store the first read of each process is unconditional");
});
