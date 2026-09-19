// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { githubEventsTransport } from "../src/transports/github-events.mjs";
import { fakeFetch } from "./helpers.mjs";

const events = [
  { id: "50", type: "PushEvent", actor: { login: "peer" }, repo: { name: "example-org/example-repo" }, created_at: "2026-09-03T10:05:00Z",
    payload: { ref: "refs/heads/main", before: "aaaaaaa1", head: "bbbbbbb2", commits: [{ sha: "bbbbbbb2222", message: "worker: retry the provider fetch\n\nlonger body" }, { sha: "ccccccc3333", message: "tests" }] } },
  { id: "40", type: "PullRequestEvent", actor: { login: "operator" }, repo: { name: "example-org/example-repo" }, created_at: "2026-09-03T10:04:00Z",
    payload: { action: "opened", number: 14, pull_request: { number: 14, title: "Fix the escaped exception", html_url: "https://github.com/example-org/example-repo/pull/14", head: { ref: "fix-escape" }, base: { ref: "main" } } } },
  { id: "30", type: "IssueCommentEvent", actor: { login: "codex[bot]" }, repo: { name: "example-org/example-repo" }, created_at: "2026-09-03T10:03:00Z",
    payload: { action: "created", issue: { number: 3, html_url: "https://github.com/example-org/example-repo/issues/3" }, comment: { body: "candidate is up\n\n-- Codex", html_url: "https://github.com/example-org/example-repo/issues/3#issuecomment-1" } } },
  { id: "20", type: "CreateEvent", actor: { login: "peer" }, repo: { name: "example-org/example-repo" }, created_at: "2026-09-03T10:02:00Z", payload: { ref_type: "branch", ref: "feature/x" } },
  { id: "10", type: "WatchEvent", actor: { login: "someone" }, repo: { name: "example-org/example-repo" }, created_at: "2026-09-03T10:01:00Z", payload: { action: "started" } },
];

/** @param {Record<string, unknown>} [room] */
function make(room = {}) {
  /** @type {string[]} */
  const etags = [];
  const { fetch, calls } = fakeFetch([
    ["/user", () => ({ body: { id: 7, login: "operator" } })],
    ["/events", (url, init) => {
      const sent = /** @type {Record<string, string>} */ (init?.headers ?? {})["if-none-match"];
      etags.push(sent ?? "");
      if (sent === '"tag-1"') return { status: 304 };
      const page = Number(url.searchParams.get("page") ?? "1");
      return { body: page === 1 ? events : [], headers: { etag: '"tag-1"' } };
    }],
  ]);
  const t = githubEventsTransport({ transport: "github-events", repo: "example-org/example-repo", ...room }, { token: "ghp_x", fetch });
  return { t, calls, etags };
}

test("github-events room validates its scope", () => {
  assert.throws(() => githubEventsTransport({ transport: "github-events" }, { token: "t" }), /exactly one of repo/);
  assert.throws(() => githubEventsTransport({ transport: "github-events", repo: "a/b", org: "c" }, { token: "t" }), /exactly one of repo/);
  assert.throws(() => githubEventsTransport({ transport: "github-events", repo: "bad" }, { token: "t" }), /not a valid name/);
  assert.equal(githubEventsTransport({ transport: "github-events", org: "example-org" }, { token: "t" }).room, "org:example-org events");
});

test("github-events: events become messages, newest last, with actors, summaries, urls and signatures", async () => {
  const { t } = make();
  const msgs = await t.read();
  assert.deepEqual(msgs.map((m) => m.id), ["10", "20", "30", "40", "50"]);
  assert.equal(msgs[4].text, "pushed 2 commits to main in example-org/example-repo\n  bbbbbbb worker: retry the provider fetch\n  ccccccc tests");
  assert.equal(msgs[4].url, "https://github.com/example-org/example-repo/compare/aaaaaaa1...bbbbbbb2");
  assert.equal(msgs[4].author.name, "peer");
  assert.equal(msgs[3].text, "opened pull request #14: Fix the escaped exception (fix-escape -> main) in example-org/example-repo");
  assert.equal(msgs[3].url, "https://github.com/example-org/example-repo/pull/14");
  assert.equal(msgs[2].author.kind, "agent", "a [bot] login is an agent");
  assert.equal(msgs[2].signedAs, "Codex", "a signature in a comment body carries through");
  assert.equal(msgs[1].text, "created branch feature/x in example-org/example-repo");
  assert.equal(msgs[0].text, "WatchEvent started in example-org/example-repo");
  assert.equal(msgs[0].cursor, "10");
  assert.equal(msgs[4].ts, "2026-09-03T10:05:00Z");
});

test("github-events: since is exclusive by event id; without a cursor the newest up to the limit", async () => {
  // a fresh transport per read: the fake answers 304 once it has handed out its validator
  assert.deepEqual((await make().t.read({ since: "30" })).map((m) => m.id), ["40", "50"]);
  assert.deepEqual((await make().t.read({ limit: 2 })).map((m) => m.id), ["40", "50"], "the newest two");
  assert.deepEqual((await make().t.read({ since: "10", limit: 2 })).map((m) => m.id), ["20", "30"], "the oldest two after the cursor");
});

test("github-events: the room's events and refs narrow the feed", async () => {
  const pushes = make({ events: ["PushEvent", "CreateEvent"] });
  assert.deepEqual((await pushes.t.read()).map((m) => m.id), ["20", "50"]);
  const main = make({ refs: ["main"] });
  assert.deepEqual((await main.t.read()).map((m) => m.id), ["40", "50"], "a push to main and a PR based on main; the branch create and the comment fall out");
  const feature = make({ refs: ["refs/heads/feature/x"] });
  assert.deepEqual((await feature.t.read()).map((m) => m.id), ["20"]);
});

test("github-events: reads are conditional and a feed refuses to post", async () => {
  const { t, etags } = make();
  await t.read();
  const again = await t.read();
  assert.deepEqual(etags, ["", '"tag-1"'], "the validator from the first read is sent on the second");
  assert.deepEqual(again.map((m) => m.id), ["10", "20", "30", "40", "50"], "304 re-filters the cached page");
  assert.deepEqual((await t.read({ since: "30" })).map((m) => m.id), ["40", "50"], "a lagging cursor re-filters the cached page");
  await assert.rejects(() => t.post("hello"), /read-only/);
  await assert.rejects(() => t.read({ thread: "x" }), /no threads/);
  assert.deepEqual(await t.whoami(), { id: "7", name: "operator" });
  assert.deepEqual(await t.whoami(), { id: "7", name: "operator" }, "whoami is not conditional; a second call is the same identity");
});

test("github-events whoami never sends a validator, so a 304 cannot become id 'undefined'", async () => {
  /** @type {string[]} */
  const sent = [];
  const { fetch } = fakeFetch([
    ["/user", (_url, init) => {
      const tag = /** @type {Record<string, string>} */ (init?.headers ?? {})["if-none-match"];
      sent.push(tag ?? "");
      if (tag) return { status: 304 };
      return { body: { id: 7, login: "operator" }, headers: { etag: '"u"' } };
    }],
  ]);
  const t = githubEventsTransport({ transport: "github-events", repo: "a/b" }, { token: "t", fetch });
  assert.deepEqual(await t.whoami(), { id: "7", name: "operator" });
  assert.deepEqual(await t.whoami(), { id: "7", name: "operator" });
  assert.deepEqual(sent, ["", ""], "neither call is conditional");
});
