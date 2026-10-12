// @ts-check
// A native reply posted while its root's face copy is still in flight waits for that copy and
// lands under it; a root copy that ends refused or unknown is named on the reply's row; a reply
// left waiting when the service stopped is picked up by the restart sweep; nothing posts twice.
// Every Slack call goes to an injected fetch; no test reads a token, the network, or the config.
import test from "node:test";
import assert from "node:assert/strict";
import { slackTransport } from "../src/transports/slack.mjs";
import { FaceRunner, appendFaceRecord, faceKey, readFacePolicy, readFaceRecords, writeFacePolicy } from "../src/faces.mjs";
import { tmp } from "./helpers.mjs";

const ROOM = "8f2c1a0b4d6e9f7a2b5c8d1e3f4a6b90";
const EPOCH = "3a7d9c1e5b2f4806a9d3c7e1f5b08246";
const ATTESTOR = { serviceId: "svc-0123456789abcdef", serviceBootId: "boot-0123456789abcdef" };
const ROOT = "c4f0a1b2d3e4f5061728394a5b6c7d8e9f00112233445566778899aabbccddee";
const REPLY = "aa11bb22aa11bb22aa11bb22aa11bb22aa11bb22aa11bb22aa11bb22aa119f0e";
const AGENT = { id: "acct-ada-0123456789", name: "Ada/build", kind: /** @type {const} */ ("agent") };
const ROOT_TS = "1756900500.000100";
const REPLY_TS = "1756900500.400200";

/** @param {string} iso */
function clock(iso) {
  /** @param {number} ms */
  const advance = (ms) => { c.t += ms; };
  const c = { t: Date.parse(iso), now: () => new Date(c.t), advance };
  return c;
}

/** @param {{ id: string, seq: number, text: string, thread?: string }} m */
function msg({ id, seq, text, thread }) {
  return { id, room: ROOM, author: AGENT, text, ts: "2026-09-05T12:00:00.000Z", cursor: `${EPOCH}:${seq}`, ...(thread ? { thread } : {}) };
}
const rootMsg = msg({ id: ROOT, seq: 1, text: "the root\n\n-- Ada/build" });
const replyMsg = msg({ id: REPLY, seq: 2, text: "the reply, posted at once\n\n-- Ada/build", thread: ROOT });

/**
 * A Slack face whose root post can be held open (a slow publish) and answered by the test: the
 * injected fetch parks the root's `chat.postMessage` until `release` is called with its outcome.
 * @param {{ records?: any[], clock?: ReturnType<typeof clock>, history?: () => any[], lookup?: Record<string, any> }} [o]
 */
async function rig(o = {}) {
  const { dir, cleanup } = await tmp();
  const c = o.clock ?? clock("2026-09-05T12:00:00.000Z");
  await writeFacePolicy(dir, ROOM, { faces: [{ transport: "slack", alias: "house", target: { channel: "C0123ABC" }, post: { agent: ["always"] } }] }, { now: c.now });
  for (const r of o.records ?? []) await appendFaceRecord(dir, ROOM, r);
  /** @type {{ url: URL, body: any }[]} */
  const posts = [];
  /** @type {((outcome: 'ok' | 'refused' | 'lost') => void) | undefined} */
  let release;
  const rootHeld = new Promise((resolve) => { release = resolve; });
  let historyCalls = 0;
  /** @type {typeof globalThis.fetch} */
  const fakeFetch = async (input, init) => {
    const url = new URL(String(input));
    const json = (/** @type {any} */ body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url.href.includes("auth.test")) return json({ ok: true, user_id: "UBOT", user: "house-bot" });
    if (url.href.includes("conversations.history")) { historyCalls++; return json({ ok: true, has_more: false, messages: o.history ? o.history() : [] }); }
    if (url.href.includes("chat.postMessage")) {
      const body = JSON.parse(String(init?.body));
      posts.push({ url, body });
      if (body.metadata?.event_payload?.origin === ROOT) {
        const outcome = await rootHeld;
        if (outcome === "refused") return json({ ok: false, error: "channel_not_found" });
        if (outcome === "lost") throw new TypeError("fetch failed");
        return json({ ok: true, ts: ROOT_TS });
      }
      return json({ ok: true, ts: REPLY_TS });
    }
    return new Response(JSON.stringify({ ok: false, error: "no route" }), { status: 404 });
  };
  const transport = slackTransport({ transport: "slack", channel: "C0123ABC" }, { token: "xoxb-fake-test", fetch: fakeFetch, sleep: async () => {} });
  /** @type {string[]} */
  const warned = [];
  const lookup = o.lookup ?? { [`${EPOCH}:1`]: rootMsg, [`${EPOCH}:2`]: replyMsg };
  const runner = () => new FaceRunner({ stateRoot: dir, roomId: ROOM, attestor: ATTESTOR, now: c.now, warn: (l) => warned.push(l),
    lookupCursor: (cur) => lookup[cur], transportFor: async () => transport });
  const face = (await readFacePolicy(dir, ROOM)).faces[0];
  return { dir, cleanup, clock: c, runner, face, posts, warned, release: /** @type {(o: 'ok' | 'refused' | 'lost') => void} */ (release),
    historyCalls: () => historyCalls, records: () => readFaceRecords(dir, ROOM) };
}

test("a reply posted while its root's copy is still publishing waits for that copy and lands under it, once", async () => {
  const r = await rig();
  try {
    const runner = r.runner();
    const root = await runner.face(rootMsg);
    assert.deepEqual(root.faces, [{ transport: "slack", status: "pending" }]);
    // the reply commits about 0.3 s later, while the root's chat.postMessage is still out
    r.clock.advance(300);
    const reply = await runner.face(replyMsg);
    assert.deepEqual(reply.faces, [{ transport: "slack", status: "pending" }], "a root in flight is not a root that was never published");
    const waiting = (await r.records()).get(faceKey(REPLY, "slack"));
    assert.equal(waiting?.status, "pending");
    assert.equal(waiting?.awaitingRoot, ROOT);
    assert.equal(r.posts.length, 1, "the reply makes no call while its root's copy is unsettled");
    r.release("ok");
    const [rootOut] = await root.settled;
    assert.equal(rootOut.status, "published");
    const replyOut = await reply.settled;
    assert.deepEqual(replyOut, [{ transport: "slack", status: "published", id: REPLY_TS }]);
    assert.equal(r.posts.length, 2);
    assert.equal(r.posts[1].body.thread_ts, ROOT_TS, "the reply lands in its root's Slack thread, never at top level");
    const rec = (await r.records()).get(faceKey(REPLY, "slack"));
    assert.equal(rec?.status, "published");
    assert.equal(rec?.thread, ROOT_TS);
    assert.equal(rec?.awaitingRoot, undefined, "the published row no longer waits");
    // a later sweep, past every settle window, posts nothing again and reads nothing
    r.clock.advance(120_000);
    await runner.sweep();
    assert.equal(r.posts.length, 2, "nothing is posted twice");
    assert.equal(r.historyCalls(), 0);
  } finally { await r.cleanup(); }
});

test("a reply whose root's copy ends refused is refused by name and never posted", async () => {
  const r = await rig();
  try {
    const runner = r.runner();
    const root = await runner.face(rootMsg);
    const reply = await runner.face(replyMsg);
    assert.deepEqual(reply.faces, [{ transport: "slack", status: "pending" }]);
    r.release("refused");
    await root.settled;
    const [out] = await reply.settled;
    assert.equal(out.status, "refused");
    assert.match(String(out.reason), /^thread: this reply's root was refused on the slack face \(channel-not-found\)/);
    const rec = (await r.records()).get(faceKey(REPLY, "slack"));
    assert.equal(rec?.code, "root-refused");
    assert.equal(r.posts.length, 1, "only the root's call left; the reply was never flattened to top level");
  } finally { await r.cleanup(); }
});

test("a reply whose root's copy ends unknown says so by name, and the sweep publishes it under the root once the root reconciles", async () => {
  const c = clock("2026-09-05T12:00:00.000Z");
  /** @type {any[]} */
  let channel = [];
  const r = await rig({ clock: c, history: () => channel });
  try {
    const runner = r.runner();
    const root = await runner.face(rootMsg);
    const reply = await runner.face(replyMsg);
    r.release("lost");
    const [rootOut] = await root.settled;
    assert.equal(rootOut.status, "unknown");
    const [out] = await reply.settled;
    assert.equal(out.status, "unknown");
    assert.match(String(out.reason), /root's copy is unknown/);
    const waiting = (await r.records()).get(faceKey(REPLY, "slack"));
    assert.equal(waiting?.code, "root-unknown");
    assert.equal(waiting?.awaitingRoot, ROOT);
    assert.equal(r.posts.length, 1);
    // the root's copy did land; the reconciliation finds it by its rider, and the reply follows
    channel = [{ ts: ROOT_TS, bot_id: "B1", subtype: "bot_message", username: "house-bot", text: "the root", metadata: { event_type: "agora_face", event_payload: { origin: ROOT } } }];
    c.advance(60_000);
    await runner.sweep();
    const recs = await r.records();
    assert.equal(recs.get(faceKey(ROOT, "slack"))?.status, "published");
    assert.equal(recs.get(faceKey(ROOT, "slack"))?.id, ROOT_TS);
    const rec = recs.get(faceKey(REPLY, "slack"));
    assert.equal(rec?.status, "published");
    assert.equal(rec?.thread, ROOT_TS);
    assert.equal(r.posts.length, 2, "the root was not reposted, and the reply posted once");
    assert.equal(r.posts[1].body.thread_ts, ROOT_TS);
    c.advance(60_000);
    await runner.sweep();
    assert.equal(r.posts.length, 2, "a further sweep posts nothing");
  } finally { await r.cleanup(); }
});

test("the restart sweep picks up a reply left waiting when the service stopped, publishes it under its root, and never posts it twice", async () => {
  const c = clock("2026-09-05T12:05:00.000Z");
  const stopped = "2026-09-05T12:00:00.000Z";
  const rootPending = { originId: ROOT, cursor: `${EPOCH}:1`, transport: "slack", status: "pending", selector: "always", attempt: 1, at: stopped, pendingAt: stopped };
  const replyWaiting = { originId: REPLY, cursor: `${EPOCH}:2`, transport: "slack", status: "pending", selector: "always", attempt: 1, at: stopped, pendingAt: stopped, awaitingRoot: ROOT };
  const channel = [{ ts: ROOT_TS, bot_id: "B1", subtype: "bot_message", username: "house-bot", text: "the root", metadata: { event_type: "agora_face", event_payload: { origin: ROOT } } }];
  const r = await rig({ clock: c, records: [rootPending, replyWaiting], history: () => channel });
  try {
    const runner = r.runner();
    await runner.sweep();
    const recs = await r.records();
    assert.equal(recs.get(faceKey(ROOT, "slack"))?.status, "published");
    const rec = recs.get(faceKey(REPLY, "slack"));
    assert.equal(rec?.status, "published");
    assert.equal(rec?.thread, ROOT_TS);
    assert.equal(r.posts.length, 1, "the waiting reply posts once, and the root is reconciled without a repost");
    assert.equal(r.posts[0].body.thread_ts, ROOT_TS, "under its root, never flattened");
    // a second start finds nothing to do
    c.advance(60_000);
    await r.runner().sweep();
    assert.equal(r.posts.length, 1);
  } finally { await r.cleanup(); }
});

test("a reply left waiting whose message was withdrawn meanwhile is refused and never posted", async () => {
  const c = clock("2026-09-05T12:05:00.000Z");
  const stopped = "2026-09-05T12:00:00.000Z";
  const rootPublished = { originId: ROOT, cursor: `${EPOCH}:1`, transport: "slack", status: "published", id: ROOT_TS, selector: "always", attempt: 1, at: stopped };
  const replyWaiting = { originId: REPLY, cursor: `${EPOCH}:2`, transport: "slack", status: "pending", selector: "always", attempt: 1, at: stopped, pendingAt: stopped, awaitingRoot: ROOT };
  const r = await rig({ clock: c, records: [rootPublished, replyWaiting] });
  try {
    const runner = new FaceRunner({ stateRoot: r.dir, roomId: ROOM, attestor: ATTESTOR, now: c.now, warn: () => {},
      lookupMessage: (id) => (id === REPLY ? { ...replyMsg, withdrawn: true } : undefined), transportFor: async () => { throw new Error("no call expected"); } });
    await runner.sweep();
    const rec = (await r.records()).get(faceKey(REPLY, "slack"));
    assert.equal(rec?.status, "refused");
    assert.equal(rec?.code, "withdrawn");
    assert.equal(r.posts.length, 0);
  } finally { await r.cleanup(); }
});
