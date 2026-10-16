// @ts-check
// `post --attach` on a Slack room: the files are uploaded invisibly, then shared in ONE message whose
// text is the signed post, and that message's ts is read back from the file's shares so the poster's
// ledger names it. Offline, against an injected fetch.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { slackTransport, SLACK_POST_FILES_MAX, SLACK_SHARE_WAITS_MS } from "../src/transports/slack.mjs";
import { readSlackFiles } from "../src/cli-native-records.mjs";
import { EXIT } from "../src/core.mjs";
import { fakeFetch } from "./helpers.mjs";

const CHANNEL = "C0123ABC";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);

/**
 * @param {{ sharesAfter?: number, thread?: string, uploadStatus?: number, shareTs?: string }} [o]
 *   sharesAfter: how many files.info asks return no shares before the share appears (Infinity: never)
 */
function make({ sharesAfter = 1, thread, uploadStatus = 200, shareTs = "1756900002.000100" } = {}) {
  let n = 0;
  let infoAsks = 0;
  /** @type {number[]} */
  const slept = [];
  const { fetch, calls } = fakeFetch([
    ["files.getUploadURLExternal", () => { n++; return { body: { ok: true, upload_url: `https://files.slack.com/upload/v1/u${n}`, file_id: `F${n}` } }; }],
    ["files.slack.com/upload", () => ({ status: uploadStatus, body: uploadStatus === 200 ? { ok: true } : undefined })],
    ["files.completeUploadExternal", () => ({ body: { ok: true, files: [{ id: "F1" }] } })],
    ["files.info", () => {
      infoAsks++;
      if (infoAsks <= sharesAfter) return { body: { ok: true, file: { id: "F1", shares: {} } } };
      const entry = thread ? { ts: shareTs, thread_ts: thread } : { ts: shareTs };
      // a share elsewhere, and in the channel's own thread when posting top-level, are not this post
      const decoys = thread ? [{ ts: thread }] : [{ ts: "1756900003.000000", thread_ts: "1756900000.000001" }];
      return { body: { ok: true, file: { id: "F1", shares: { public: { CELSEWHERE: [{ ts: "1.1" }], [CHANNEL]: [...decoys, entry] } } } } };
    }],
  ]);
  const t = slackTransport({ transport: "slack", channel: CHANNEL }, { token: "xoxb-1", fetch, sleep: async (ms) => { slept.push(ms); } });
  return { t, calls, slept };
}

const file = (name = "shot.png", bytes = PNG) => ({ name, bytes, mimetype: "image/png" });
/** @param {any[]} calls @param {string} needle */
const hits = (calls, needle) => calls.filter((c) => c.url.href.includes(needle));

test("slack post with files: uploads each, shares all in one message carrying the text, returns the share's ts", async () => {
  const { t, calls } = make();
  const r = await t.post("see attached & done\n\n-- Ada", { files: [file("a.png"), file("b.png")] });
  assert.equal(r.id, "1756900002.000100");
  assert.equal(r.cursor, "1756900002.000100");
  assert.deepEqual(r.files, ["F1", "F2"]);
  const urls = hits(calls, "getUploadURLExternal").map((c) => [c.url.searchParams.get("filename"), c.url.searchParams.get("length")]);
  assert.deepEqual(urls, [["a.png", String(PNG.length)], ["b.png", String(PNG.length)]]);
  const uploads = hits(calls, "files.slack.com/upload");
  assert.equal(uploads.length, 2);
  assert.equal(/** @type {any} */ (uploads[0].init).redirect, "error");
  assert.equal(/** @type {any} */ (uploads[0].init?.headers)["content-type"], "image/png");
  const complete = hits(calls, "completeUploadExternal");
  assert.equal(complete.length, 1, "one visible step for the whole post");
  const sent = JSON.parse(String(complete[0].init?.body));
  assert.deepEqual(sent, { files: [{ id: "F1", title: "a.png" }, { id: "F2", title: "b.png" }], channel_id: CHANNEL, initial_comment: "see attached &amp; done\n\n-- Ada" });
  assert.equal(hits(calls, "chat.postMessage").length, 0, "the text rides the share, never a second message");
});

test("slack post with files in a thread: thread_ts on the share, and the reply's ts, not the root's, comes back", async () => {
  const root = "1756900000.000100";
  const { t, calls } = make({ thread: root });
  const r = await t.post("reply", { thread: root, files: [file()] });
  assert.equal(r.id, "1756900002.000100");
  assert.equal(JSON.parse(String(hits(calls, "completeUploadExternal")[0].init?.body)).thread_ts, root);
});

test("slack post with files asks files.info on the bounded waits until the share appears", async () => {
  const { t, calls, slept } = make({ sharesAfter: 2 });
  await t.post("x", { files: [file()] });
  assert.equal(hits(calls, "files.info").length, 3);
  assert.deepEqual(slept, SLACK_SHARE_WAITS_MS.slice(0, 3));
});

test("slack post with files whose share never reports a ts: exit 1 saying it is posted, never a retry", async () => {
  const { t, calls } = make({ sharesAfter: Infinity });
  await assert.rejects(t.post("x", { files: [file()] }), (e) => {
    assert.equal(/** @type {any} */ (e).exitCode, EXIT.error);
    assert.match(String(/** @type {any} */ (e).message), /the post is there, do not post it again/);
    return true;
  });
  assert.equal(hits(calls, "files.info").length, SLACK_SHARE_WAITS_MS.length);
  assert.equal(hits(calls, "completeUploadExternal").length, 1);
});

test("slack post with files: an upload refused before the share posts nothing", async () => {
  const { t, calls } = make({ uploadStatus: 403 });
  await assert.rejects(t.post("x", { files: [file()] }), /slack upload: HTTP 403/);
  assert.equal(hits(calls, "completeUploadExternal").length, 0);
});

test("slack post with files refuses, before any call, too many, an empty or an oversized file, and a rider", async () => {
  const big = slackTransport({ transport: "slack", channel: CHANNEL }, { token: "x", fetch: async () => { throw new Error("no call expected"); }, imageMaxBytes: 4 });
  await assert.rejects(big.post("x", { files: [file()] }), (e) => /** @type {any} */ (e).exitCode === EXIT.usage && /over the 4-byte limit/.test(String(/** @type {any} */ (e).message)));
  const { t, calls } = make();
  await assert.rejects(t.post("x", { files: Array.from({ length: SLACK_POST_FILES_MAX + 1 }, () => file()) }), /at most 8 files/);
  await assert.rejects(t.post("x", { files: [file("e.png", Buffer.alloc(0))] }), /is empty/);
  await assert.rejects(t.post("x", { files: [file()], metadata: { event_type: "t", event_payload: {} } }), /no metadata rider/);
  assert.equal(calls.length, 0);
});

test("readSlackFiles: the bytes prove an image's type, else the extension, else a byte stream; a missing path posts nothing", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "agora-slack-files-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "named.txt"), PNG);
  await writeFile(path.join(dir, "report.pdf"), "%PDF-1.7");
  await writeFile(path.join(dir, "blob.bin"), "x");
  const got = await readSlackFiles([path.join(dir, "named.txt"), path.join(dir, "report.pdf"), path.join(dir, "blob.bin")]);
  assert.deepEqual(got.map((f) => [f.name, f.mimetype]), [["named.txt", "image/png"], ["report.pdf", "application/pdf"], ["blob.bin", "application/octet-stream"]]);
  await assert.rejects(readSlackFiles([path.join(dir, "absent.png")]), /nothing was posted/);
});
