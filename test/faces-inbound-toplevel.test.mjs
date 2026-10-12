// @ts-check
// The top-level opt-in of the inbound face (`agora room faces <room> --inbound top-level`): a
// person's new top-level message in the face's Slack channel becomes a native top-level post, and
// its Slack thread crosses as that post's replies. Against a real seat service in a temporary state
// root; every Slack call goes to an injected fetch, and no test reads a token or the network.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { foldAnnotations } from "../src/client.mjs";
import { FaceRunner, appendFaceRecord, readFacePolicy, slackTs, writeFacePolicy } from "../src/faces.mjs";
import { FaceInbound, faceInboundPath, faceThreadOf, inboundModeOf, inboundOperationId, inboundVia, readInbound, setInboundMode } from "../src/faces-inbound.mjs";
import { slackTransport } from "../src/transports/slack.mjs";
import { ROOM, seat } from "./client-fixtures.mjs";

const CHANNEL = "C0123ABC";
const ATTESTOR = { serviceId: "svc-0123456789abcdef", serviceBootId: "boot-0123456789abcdef" };
const OPT_IN_AT = "2025-09-05T12:00:00.000Z";
const SINCE = slackTs(Date.parse(OPT_IN_AT));

/** A clock the tests move by hand. @param {string} iso */
function clock(iso) {
  const c = { t: Date.parse(iso), now: () => new Date(c.t), advance: (/** @type {number} */ ms) => { c.t += ms; } };
  return c;
}

/**
 * A fake Slack whose channel history and thread replies the test sets. History honours `oldest`
 * (exclusive), as Slack does; `replies` is keyed by the thread's ts.
 * @param {{ history: () => any[] | { messages: any[], has_more?: boolean, response_metadata?: { next_cursor: string } }, replies?: Record<string, () => any> }} o
 */
function fakeSlack(o) {
  /** @type {URL[]} */
  const calls = [];
  /** @type {typeof globalThis.fetch} */
  const fetchFake = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    const json = (/** @type {unknown} */ body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    const method = url.pathname.split("/").pop();
    if (method === "auth.test") return json({ ok: true, user_id: "UBOT", user: "seat-bot", bot_id: "BSEAT" });
    if (method === "users.info") return json({ ok: true, user: { id: url.searchParams.get("user"), real_name: url.searchParams.get("user") === "U2" ? "operator" : "someone" } });
    if (method === "conversations.history") {
      const h = o.history();
      if (!Array.isArray(h)) return json({ ok: true, ...h });
      const oldest = Number(url.searchParams.get("oldest") ?? 0);
      // newest first, as Slack answers
      return json({ ok: true, has_more: false, messages: h.filter((m) => Number(m.ts) > oldest).sort((a, b) => Number(b.ts) - Number(a.ts)) });
    }
    if (method === "conversations.replies") {
      const r = o.replies?.[String(url.searchParams.get("ts"))]?.();
      if (r === undefined) return json({ ok: false, error: "thread_not_found" });
      return json(Array.isArray(r) ? { ok: true, has_more: false, messages: r } : { ok: true, ...r });
    }
    return json({ ok: false, error: "no route" });
  };
  return { fetch: fetchFake, calls, callsTo: (/** @type {string} */ m) => calls.filter((u) => u.pathname.endsWith(`/${m}`)) };
}

/** @param {string} ts @param {string} user @param {string} text @param {Record<string, unknown>} [extra] */
const top = (ts, user, text, extra = {}) => ({ ts, user, text, ...extra });
/** @param {string} thread @param {string} ts @param {string} user @param {string} text @param {Record<string, unknown>} [extra] */
const reply = (thread, ts, user, text, extra = {}) => ({ ts, user, text, thread_ts: thread, ...extra });

/**
 * A seat with one native room and one Slack face that opted into the top level at OPT_IN_AT.
 * @param {import('node:test').TestContext} t
 * @param {{ history: () => any, replies?: Record<string, () => any>, records?: (agent: any) => Promise<any[]>, optIn?: boolean, clock?: ReturnType<typeof clock> }} o
 */
async function rig(t, o) {
  const s = await seat(t);
  const c = o.clock ?? clock("2025-09-05T12:05:00.000Z");
  await writeFacePolicy(s.root, ROOM, { faces: [{ transport: "slack", alias: "house-slack", target: { channel: CHANNEL } }] }, { now: c.now });
  const face = (await readFacePolicy(s.root, ROOM)).faces[0];
  if (o.optIn !== false) await setInboundMode(s.root, ROOM, face, "top-level", { now: () => new Date(OPT_IN_AT) });
  const agent = await s.open();
  for (const r of (await o.records?.(agent)) ?? []) await appendFaceRecord(s.root, ROOM, r);
  const slack = fakeSlack(o);
  const transport = slackTransport({ transport: "slack", channel: CHANNEL }, { token: "xoxb-fake-test", fetch: slack.fetch, sleep: async () => {} });
  /** @type {string[]} */
  const warned = [];
  const app = await s.open({ clientName: inboundVia("slack") });
  const make = () => {
    const runner = new FaceRunner({ stateRoot: s.root, roomId: ROOM, attestor: ATTESTOR, now: c.now, warn: (l) => warned.push(l), transportFor: async () => transport });
    return new FaceInbound({ stateRoot: s.root, roomId: ROOM, runner, client: app, room: "house", now: c.now, warn: (l) => warned.push(l) });
  };
  const messages = async () => (await agent.read("house")).messages;
  return { s, c, slack, face, agent, make, messages, warned };
}

test("a person's new top-level message crosses as a native top-level post, and the Slack replies under it cross into that native thread", { timeout: 30_000 }, async (t) => {
  /** @type {any[]} */
  let thread = [top("1757073660.000100", "U2", "is the north pump on its schedule?")];
  const r = await rig(t, {
    history: () => [top("1757073500.000000", "U2", "before the opt-in, never read"), top("1757073660.000100", "U2", "is the north pump on its schedule?")],
    replies: { "1757073660.000100": () => thread },
  });
  assert.equal(await inboundModeOf(r.s.root, ROOM, r.face), "top-level");
  const first = await r.make().poll(r.face);
  assert.equal(r.slack.callsTo("conversations.history")[0].searchParams.get("oldest"), SINCE, "the channel is read from the opt-in, never back-filled");
  assert.match(r.slack.callsTo("conversations.history")[0].search, /include_all_metadata=true/, "riders come back for the loop check");
  assert.deepEqual([first.topLevel?.held, first.topLevel?.ingested], [false, 1]);
  const [q] = await r.messages();
  assert.equal(q.text, "is the north pump on its schedule?");
  assert.equal(q.thread, undefined, "a native top-level post");
  assert.deepEqual([q.author.kind, q.author.name, q.author.ref, q.via], ["human", "operator", "U2", "slack-face"]);
  // the thread map pairs its Slack ts with the native root, both ways
  assert.equal(await faceThreadOf(r.s.root, ROOM, r.face, q.id), "1757073660.000100");
  const { cursors, ingested } = await readInbound(r.s.root, ROOM);
  assert.equal(cursors.get(`slack\0${CHANNEL}\0`), "1757073660.000100", "the channel position persists");
  assert.equal(ingested.get(`slack\0${CHANNEL}\x001757073660.000100`)?.top, true);

  // a reply under the question in Slack crosses into the native thread
  thread = [...thread, reply("1757073660.000100", "1757073700.000200", "U2", "and the south one too")];
  const second = await r.make().poll(r.face);
  assert.equal(second.topLevel?.ingested, 0, "the question does not cross twice");
  assert.deepEqual(second.threads.map((x) => [x.ts, x.ingested]), [["1757073660.000100", 1]]);
  const all = await r.messages();
  assert.deepEqual(all.map((m) => [m.text, m.thread ?? null]), [["is the north pump on its schedule?", null], ["and the south one too", q.id]]);
});

test("the seat's own outbound copies and its own account never cross back; a foreign bot crosses as an agent; a reply broadcast to the channel crosses only through its thread", { timeout: 30_000 }, async (t) => {
  const r = await rig(t, {
    records: async (agent) => {
      const faced = await agent.append("house", { text: "the relay is up", author: { kind: "agent", name: "Grace/watch" } });
      return [
        { originId: faced.id, cursor: faced.cursor, transport: "slack", status: "published", id: "1757073610.000000", attempt: 1, at: "2025-09-05T12:00:10.000Z", selector: "always" },
        { originId: "b".repeat(64), cursor: "x", transport: "slack", status: "published", id: "1757073620.000000", attempt: 1, at: "2025-09-05T12:00:20.000Z", selector: "always" },
      ];
    },
    history: () => [
      // a copy this seat faced, rider stripped: caught by its published ts
      top("1757073610.000000", "UBOT", "the relay is up", { bot_id: "BSEAT", subtype: "bot_message" }),
      // a copy this seat faced: its rider names a face record
      top("1757073620.000000", "UBOT", "another faced copy", { bot_id: "BSEAT", subtype: "bot_message", metadata: { event_type: "agora_face", event_payload: { origin: "b".repeat(64) } } }),
      // this seat's own account, no face record (a direct post on the Slack room): not a question for the room
      top("1757073630.000000", "UBOT", "a direct post from this seat", { bot_id: "BSEAT", subtype: "bot_message" }),
      top("1757073640.000000", "UPARTNER", "the other side's agent asks", { bot_id: "BPARTNER", subtype: "bot_message", username: "partner-agent" }),
      top("1757073650.000000", "U2", "", { subtype: "channel_join" }),
      reply("1757073000.000000", "1757073655.000000", "U2", "a reply also sent to the channel", { subtype: "thread_broadcast" }),
      top("1757073660.000000", "U2", "a person asks"),
    ],
  });
  const result = await r.make().poll(r.face);
  const top_ = /** @type {any} */ (result.topLevel);
  assert.equal(top_.held, false);
  assert.deepEqual(top_.notIngested.map((/** @type {any} */ x) => x.id).sort(), ["1757073610.000000", "1757073620.000000", "1757073630.000000"]);
  assert.match(top_.notIngested.find((/** @type {any} */ x) => x.id === "1757073630.000000").why, /own account/);
  const crossed = (await r.messages()).filter((m) => m.via === "slack-face");
  assert.deepEqual(crossed.map((m) => [m.text, m.author.kind, m.author.name]), [["the other side's agent asks", "agent", "partner-agent"], ["a person asks", "human", "operator"]]);
  // the inbound half asks the seat's account once per transport, not once per message
  const asked = r.slack.callsTo("auth.test").length;
  await r.make().poll(r.face);
  assert.ok(r.slack.callsTo("auth.test").length - asked <= 1, "a second tick on the same transport asks no more than the runner does");
});

test("a face without the opt-in reads no top level; --inbound top-level is a slack face's alone, and an unknown mode is refused", { timeout: 30_000 }, async (t) => {
  const r = await rig(t, { optIn: false, history: () => [top("1757073660.000000", "U2", "a question nobody opted into")] });
  assert.equal(await inboundModeOf(r.s.root, ROOM, r.face), "threads");
  const result = await r.make().poll(r.face);
  assert.equal(result.topLevel, undefined);
  assert.equal(r.slack.callsTo("conversations.history").length, 0);
  assert.deepEqual(await r.messages(), []);
  await assert.rejects(setInboundMode(r.s.root, ROOM, r.face, "everything"), /not a mode \(have: threads, top-level\)/);
  await assert.rejects(setInboundMode(r.s.root, ROOM, { transport: "github", target: { repo: "o/n", issue: "1" } }, "top-level"), /github face has no inbound half/);
  // switched on, then off: the top level is not read again
  assert.deepEqual(await setInboundMode(r.s.root, ROOM, r.face, "top-level"), { inbound: "top-level", changed: true });
  assert.deepEqual(await setInboundMode(r.s.root, ROOM, r.face, "top-level"), { inbound: "top-level", changed: false });
  await setInboundMode(r.s.root, ROOM, r.face, "threads");
  await r.make().poll(r.face);
  assert.equal(r.slack.callsTo("conversations.history").length, 0);
});

test("a channel read truncated at the page cap infers nothing: nothing crosses and the position stays", { timeout: 30_000 }, async (t) => {
  const r = await rig(t, { history: () => ({ messages: [top("1757073999.000000", "U2", "deep in an unread backlog")], has_more: true, response_metadata: { next_cursor: "more" } }) });
  const result = await r.make().poll(r.face);
  assert.equal(result.topLevel?.held, true);
  assert.equal(result.topLevel?.reason, "gap");
  assert.deepEqual(await r.messages(), []);
  assert.equal((await readInbound(r.s.root, ROOM)).cursors.get(`slack\0${CHANNEL}\0`), SINCE, "the opt-in position, unmoved");
});

test("a restart resumes from the saved position, and a replay past a lost position is the host's duplicate", { timeout: 30_000 }, async (t) => {
  /** @type {any[]} */
  let history = [top("1757073610.000000", "U2", "one"), top("1757073620.000000", "U2", "two")];
  const r = await rig(t, { history: () => history });
  await r.make().poll(r.face);
  history = [...history, top("1757073630.000000", "U2", "three")];
  const again = await r.make().poll(r.face);
  assert.equal(again.topLevel?.ingested, 1);
  assert.equal(r.slack.callsTo("conversations.history").at(-1)?.searchParams.get("oldest"), "1757073620.000000");
  assert.deepEqual((await r.messages()).map((m) => m.text), ["one", "two", "three"]);
  // the channel position lost (a crash between the append and its cursor line)
  const file = faceInboundPath(r.s.root, ROOM);
  const kept = (await readFile(file, "utf8")).split("\n").filter((l) => l && !(JSON.parse(l).kind === "cursor" && JSON.parse(l).thread === "" && JSON.parse(l).cursor !== SINCE));
  await writeFile(file, kept.join("\n") + "\n");
  const replay = await r.make().poll(r.face);
  assert.equal(replay.topLevel?.ingested, 3, "all three were seen again");
  assert.deepEqual((await r.messages()).map((m) => m.text), ["one", "two", "three"], "and the host answered each with the original");
  assert.equal((await readInbound(r.s.root, ROOM)).ingested.get(`slack\0${CHANNEL}\x001757073610.000000`)?.duplicate, true);
  assert.equal(inboundOperationId(ROOM, "slack", CHANNEL, "1757073610.000000").length, 64);
});

test("a Slack edit of a crossed question is a native edit, and its deletion a withdraw", { timeout: 30_000 }, async (t) => {
  const TS = "1757073660.000000";
  /** @type {(() => any) | undefined} */
  let replies = () => [top(TS, "U2", "the first wording")];
  const r = await rig(t, { history: () => [top(TS, "U2", "the first wording")], replies: { [TS]: () => replies?.() } });
  await r.make().poll(r.face);
  const [q] = await r.messages();
  replies = () => [top(TS, "U2", "the second wording", { edited: { user: "U2", ts: "1757073670.000000" } })];
  const edited = await r.make().poll(r.face);
  assert.deepEqual(edited.threads[0].edited, [TS]);
  let { messages, annotations } = await r.agent.read("house");
  assert.deepEqual((annotations ?? []).map((/** @type {any} */ a) => [a.act, a.target, a.author.ref, a.via]), [["edit", q.id, "U2", "slack-face"]]);
  assert.equal(foldAnnotations(messages, annotations ?? []).find((m) => m.id === q.id)?.text, "the second wording");
  // deleted with no replies: Slack answers that the thread is gone
  replies = undefined;
  const gone = await r.make().poll(r.face);
  assert.deepEqual(gone.threads[0].withdrawn, [TS]);
  ({ annotations } = await r.agent.read("house"));
  assert.deepEqual((annotations ?? []).map((/** @type {any} */ a) => a.act), ["edit", "withdraw"]);
  await r.make().poll(r.face);
  assert.equal(((await r.agent.read("house")).annotations ?? []).length, 2, "a withdrawn question is not withdrawn again");
});
