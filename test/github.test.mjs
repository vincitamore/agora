// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { GITHUB_COMMENT_MAX, GitHubApiError, githubFaceHalf, githubTransport } from "../src/transports/github.mjs";
import { createTransport, tokenSource } from "../src/transports/index.mjs";
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

test("github room: without a cursor the newest messages up to the limit", async () => {
  const { t } = make();
  assert.deepEqual((await t.read({ limit: 2 })).map((m) => m.id), ["12", "13"]);
});

test("github room: same-second comments sort by Number(id), not the cursor string", async () => {
  const sameSecond = [
    { id: 10, created_at: "2026-09-03T06:00:00Z", updated_at: "2026-09-03T06:00:00Z", body: "c10", user: { login: "a", type: "User" }, html_url: "u10" },
    { id: 8, created_at: "2026-09-03T06:00:00Z", updated_at: "2026-09-03T06:00:00Z", body: "c8", user: { login: "a", type: "User" }, html_url: "u8" },
    { id: 9, created_at: "2026-09-03T06:00:00Z", updated_at: "2026-09-03T06:00:00Z", body: "c9", user: { login: "a", type: "User" }, html_url: "u9" },
  ];
  const { fetch } = fakeFetch([["/issues/3/comments", () => ({ body: sameSecond })]]);
  const t = githubTransport({ transport: "github", repo: "a/b", issue: 3 }, { token: "t", fetch });
  assert.deepEqual((await t.read()).map((m) => m.id), ["8", "9", "10"]);
  const after8 = await t.read({ since: "2026-09-03T06:00:00Z|8" });
  assert.deepEqual(after8.map((m) => m.id), ["9", "10"]);
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

test("github room sends the validator it was given last and re-filters a not-modified page", async () => {
  const cache = memoryCache();
  const first = make({ etag: 'W/"abc123"', cache });
  assert.equal((await first.t.read()).length, 4);
  assert.equal(/** @type {any} */ (first.calls[0].init?.headers)["if-none-match"], undefined, "nothing to send the first time");
  assert.equal(cache.m.size, 1, "and the validator is kept where a later process can find it");

  const again = await first.t.read();
  assert.deepEqual(again.map((m) => m.id), ["10", "11", "12", "13"], "304 re-filters the cached page, not an empty batch");
  assert.equal(/** @type {any} */ (first.calls.at(-1)?.init?.headers)["if-none-match"], 'W/"abc123"');

  // a fresh instance holds nothing of its own: the store is what makes this survive a re-arm
  const fresh = make({ etag: 'W/"abc123"', cache });
  assert.deepEqual((await fresh.t.read()).map((m) => m.id), ["10", "11", "12", "13"]);
  assert.equal(/** @type {any} */ (fresh.calls.at(-1)?.init?.headers)["if-none-match"], 'W/"abc123"');
  assert.deepEqual((await fresh.t.read({ since: "2026-09-03T06:00:00Z|11" })).map((m) => m.id), ["12", "13"], "a lagging cursor re-filters the cached page");

  const uncached = make({ etag: 'W/"abc123"' });
  assert.equal((await uncached.t.read()).length, 4, "with no store the first read of each process is unconditional");
});

test("tokenSource and createTransport name the same GITHUB_TOKEN", async () => {
  const prev = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "ghp_from_env";
  try {
    const room = /** @type {import("../src/core.mjs").RoomConfig} */ ({ transport: "github", repo: "a/b", issue: 3 });
    assert.equal(await tokenSource(room), "env");
    const { fetch, calls } = fakeFetch([
      ["/user", () => ({ body: { id: 1, login: "x" } })],
    ]);
    const cfg = /** @type {import("../src/core.mjs").Config} */ ({ actor: { name: "A", kind: "agent" }, rooms: { r: room } });
    const t = await createTransport("r", room, cfg, { fetch });
    await t.whoami();
    assert.equal(/** @type {any} */ (calls[0].init?.headers).authorization, "Bearer ghp_from_env");
  } finally {
    if (prev === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = prev;
  }
});

test("github face half: history is a bounded unconditional window on created_at, a call error carries the answered and sent facts, and the half reads a raw comment", async () => {
  const { fetch, calls } = fakeFetch([
    ["/user", () => ({ body: { id: 7, login: "vincitamore" } })],
    ["/issues/3/comments", (url, init) => {
      if (init?.method === "POST") return { status: 422, body: { message: "Validation Failed" } };
      if (url.searchParams.get("page") === "2") return { status: 502, body: { message: "Bad Gateway" } };
      return { body: comments };
    }],
  ]);
  const t = githubTransport({ transport: "github", repo: "example-org/example-repo", issue: 3 }, { token: "ghp_x", fetch });
  const win = await t.history({ since: "2026-09-03T05:30:00.000Z", until: "2026-09-03T06:00:00.000Z" });
  assert.deepEqual(win.messages.map((c) => c.id), [11, 12], "the edited old comment (updated inside, created before) is out; the later one is past until");
  assert.equal(win.complete, true);
  const q = calls.at(-1)?.url.searchParams;
  assert.equal(q?.get("since"), "2026-09-03T05:30:00.000Z");
  assert.equal(q?.get("per_page"), "100");
  assert.equal(/** @type {any} */ (calls.at(-1)?.init?.headers)["if-none-match"], undefined, "a reconciliation read is never conditional");
  await assert.rejects(t.post("x"), (e) => e instanceof GitHubApiError && e.answered === true && e.sent === true && e.status === 422 && /422 Validation Failed/.test(e.message));
  const throttled = githubTransport({ transport: "github", repo: "a/b", issue: 3 }, { token: "ghp_x", fetch: (await import("./helpers.mjs")).fakeFetch([["/comments", () => ({ status: 429, body: { message: "API rate limit exceeded" }, headers: { "retry-after": "30" } })]]).fetch });
  await assert.rejects(throttled.post("x"), (e) => e instanceof GitHubApiError && e.answered === false && e.sent === true && e.status === 429, "a 429 is not GitHub's answer to the comment: throttled before or after it landed, so a face reconciles rather than refuses");
  const gone = githubTransport({ transport: "github", repo: "a/b", issue: 3 }, { token: "ghp_x", fetch: async () => { throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } }); } });
  await assert.rejects(gone.whoami(), (e) => e instanceof GitHubApiError && e.sent === false && e.answered === false && e.message === "github GET /user: unreachable");
  const died = githubTransport({ transport: "github", repo: "a/b", issue: 3 }, { token: "ghp_x", fetch: async () => { throw new Error("socket hang up https://api.github.com/secret?token=ghp_abcdefghijklmnopqrstu"); } });
  await assert.rejects(died.whoami(), (e) => e instanceof GitHubApiError && e.sent === true && e.answered === false && e.message === "github GET /user: the link died during the request");
  // the half
  assert.equal(githubFaceHalf.textMax, GITHUB_COMMENT_MAX);
  assert.equal(githubFaceHalf.encode("a & <b>"), "a & <b>", "verbatim on the wire");
  assert.equal(githubFaceHalf.rider({ body: `<!-- agora_face:${"a".repeat(64)} --> origin=${"a".repeat(64)}` }), undefined, "no rider: the body is never parsed for one, whatever shape it quotes");
  assert.equal(githubFaceHalf.ownAccount({ user: { id: 7, login: "vincitamore" } }, { id: "7", name: "vincitamore" }), true);
  assert.equal(githubFaceHalf.ownAccount({ user: { id: 9, login: "other" } }, { id: "7", name: "vincitamore" }), false);
  assert.equal(githubFaceHalf.ownAccount({}, { id: "7", name: "vincitamore" }), false);
  assert.equal(githubFaceHalf.idOf({ id: 4242 }), "4242");
  assert.deepEqual(githubFaceHalf.window(Date.parse("2026-09-05T11:59:55.000Z"), Date.parse("2026-09-05T12:00:30.000Z")), { since: "2026-09-05T11:59:55.000Z", until: "2026-09-05T12:00:30.000Z" });
  assert.equal(githubFaceHalf.pictureLine({ digest: "sha256:ab" }, "image x.png (image/png, 1 bytes)"), "image x.png (image/png, 1 bytes) sha256:ab");
  assert.equal(githubFaceHalf.pictureLine({ url: "https://h/x.png", digest: "sha256:ab" }, "L"), "L <https://h/x.png>");
  assert.equal(githubFaceHalf.pictureLine({ url: "file:///tmp/x.png", digest: "sha256:ab" }, "L"), "L sha256:ab", "only a public http(s) link is a link");
});
