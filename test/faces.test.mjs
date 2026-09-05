// @ts-check
// The picture face (P5): tests named for the fixtures under
// forge/output/agora-native-surface/fixtures/faces/ they satisfy. Every Slack call goes to the
// injected fake of test/helpers.mjs; no test reads a token, the network, or the shared config.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { AgoraError } from "../src/core.mjs";
import { encodeTransfer } from "../src/tailcat.mjs";
import { validateFacePublication } from "../src/protocol/outcomes.mjs";
import { validateOriginReference } from "../src/protocol/origin.mjs";
import { SLACK_IMAGE_MAX_BYTES, SlackApiError, encodeSlackText, slackTransport } from "../src/transports/slack.mjs";
import {
  FACE_MAX_ATTEMPTS, FaceRunner, appendFaceRecord, classifyFaceFailure, faceKey, faceRecordsPath, faceText, isAddressed, isLanding,
  normalizeSelectors, readFacePolicy, readFaceRecords, selectFaces, toFacePublication, writeFacePolicy,
} from "../src/faces.mjs";
import { fakeFetch, tmp } from "./helpers.mjs";

const ROOM = "8f2c1a0b4d6e9f7a2b5c8d1e3f4a6b90";
const EPOCH = "3a7d9c1e5b2f4806a9d3c7e1f5b08246";
const ATTESTOR = { serviceId: "svc-0123456789abcdef", serviceBootId: "boot-0123456789abcdef" };
const ORIGIN_A = "c4f0a1b2d3e4f5061728394a5b6c7d8e9f00112233445566778899aabbccddee";
const ORIGIN_B = "aa11bb22aa11bb22aa11bb22aa11bb22aa11bb22aa11bb22aa11bb22aa119f0e";
const ORIGIN_D = "dd33ee44dd33ee44dd33ee44dd33ee44dd33ee44dd33ee44dd33ee44dd331a2b";
const ALEX = { id: "U2", name: "Alex", kind: /** @type {const} */ ("human"), account: { transport: "slack", id: "U2" } };
const FABLE = { id: "acct-fable-0123456789", name: "Fable/agora-orchestrator", kind: /** @type {const} */ ("agent") };
const CHANNEL = { transport: "slack", channel: "C0123ABC" };
const AUTH = /** @type {const} */ (["auth.test", () => ({ body: { ok: true, user_id: "UBOT", user: "claude-house" } })]);
/** @param {string} s */
const sha = (s) => `sha256:${createHash("sha256").update(s).digest("hex")}`;

/** A clock the tests move by hand. @param {string} iso */
function clock(iso) {
  /** @param {number} ms */
  const advance = (ms) => { c.t += ms; };
  const c = { t: Date.parse(iso), now: () => new Date(c.t), advance };
  return c;
}

/** A committed native message as the store hands it back. @param {{ id?: string, seq?: number, text: string, author?: any, thread?: string, attachments?: any[] }} m */
function msg({ id = ORIGIN_A, seq = 41, text, author = FABLE, thread, attachments }) {
  return { id, room: ROOM, author, text, ts: "2026-09-05T12:00:00.000Z", cursor: `${EPOCH}:${seq}`, ...(thread ? { thread } : {}), ...(attachments ? { attachments } : {}) };
}

/**
 * @param {{ routes?: any[], face?: Record<string, unknown>, faces?: any[], clock?: ReturnType<typeof clock>, membership?: any[], lookupCursor?: (c: string) => any,
 *   readBlob?: (a: any) => Promise<Buffer>, transportFor?: (f: any) => Promise<any>, records?: any[] }} [o]
 */
async function rig(o = {}) {
  const { dir, cleanup } = await tmp();
  const c = o.clock ?? clock("2026-09-05T12:00:00.000Z");
  const faces = o.faces ?? [{ transport: "slack", alias: "house", target: { channel: "C0123ABC" }, post: { agent: ["addressed"] }, ...(o.face ?? {}) }];
  await writeFacePolicy(dir, ROOM, { faces }, { now: c.now });
  for (const r of o.records ?? []) await appendFaceRecord(dir, ROOM, r);
  const { fetch, calls } = fakeFetch(o.routes ?? [AUTH]);
  /** @type {string[]} */
  const warned = [];
  const transport = slackTransport(CHANNEL, { token: "xoxb-fake-test", fetch, sleep: async () => {} });
  const runner = new FaceRunner({
    stateRoot: dir, roomId: ROOM, attestor: ATTESTOR, now: c.now, membership: o.membership ?? [ALEX], lookupCursor: o.lookupCursor, readBlob: o.readBlob,
    warn: (l) => warned.push(l), transportFor: o.transportFor ?? (async () => transport),
  });
  const face = (await readFacePolicy(dir, ROOM)).faces[0];
  /** @param {string} needle */
  const callsTo = (needle) => calls.filter((x) => x.url.href.includes(needle));
  const posts = () => callsTo("chat.postMessage");
  /** @param {{ url: URL, init: RequestInit | undefined }} call */
  const bodyOf = (call) => JSON.parse(String(call.init?.body));
  return { dir, cleanup, clock: c, runner, face, transport, calls, callsTo, posts, bodyOf, warned, records: () => readFaceRecords(dir, ROOM), file: faceRecordsPath(dir, ROOM) };
}

// ---------------------------------------------------------------------------------------------

test("fixture 01: the face policy record has the ratified shape, defaults and value domain, and an absent record is a room with no faces", async () => {
  const { dir, cleanup } = await tmp();
  try {
    assert.deepEqual(await readFacePolicy(dir, ROOM), { version: 1, roomId: ROOM, updatedAt: null, faces: [] });
    const written = await writeFacePolicy(dir, ROOM, { faces: [{ transport: "slack", alias: "house", target: { channel: "C0123ABC" } }] }, { now: () => new Date("2026-09-05T12:00:00.000Z") });
    const read = await readFacePolicy(dir, ROOM);
    assert.deepEqual(read, written);
    assert.deepEqual(read, {
      version: 1, roomId: ROOM, updatedAt: "2026-09-05T12:00:00.000Z",
      faces: [{ transport: "slack", alias: "house", target: { channel: "C0123ABC" }, enabled: true,
        post: { human: ["always"], agent: ["addressed", "landing"], system: ["never"] }, attachments: "metadata", backfill: null }],
    });
    if (process.platform !== "win32") assert.equal((await stat(`${dir}/native/rooms/${ROOM}/faces.json`)).mode & 0o777, 0o600);
    // the ruling's literal spelling is a valid input and normalizes to the list
    assert.deepEqual(normalizeSelectors("addressed+landing", "post.agent"), ["addressed", "landing"]);
    assert.deepEqual(normalizeSelectors("never", "post.agent"), ["never"]);
    assert.throws(() => normalizeSelectors("content", "post.agent"), /not a selector/);
    assert.throws(() => normalizeSelectors([], "post.agent"), /one or more selectors/);
    await assert.rejects(writeFacePolicy(dir, ROOM, { faces: [{ transport: "slack", alias: "house", attachments: "inline" }] }), /attachments must be one of none, metadata, pictures/);
    await assert.rejects(writeFacePolicy(dir, ROOM, { roomId: "0".repeat(32), faces: [] }), /another room/);
  } finally { await cleanup(); }
});

test("fixture 01: the selectors read the poster's own outbound trailers only", () => {
  const ctx = { memberKind: (/** @type {string} */ n) => (n === "Alex" ? "human" : n === "Codex" ? "agent" : undefined), lookupCursor: (/** @type {string} */ c) => (c === `${EPOCH}:7` ? { author: { kind: "human" } } : c === `${EPOCH}:8` ? { author: { kind: "agent" }, origin: { source: { transport: "slack", room: "C1", id: "1756900100.000100" } } } : undefined) };
  const face = /** @type {any} */ ({ transport: "slack" });
  assert.equal(isAddressed("x\n\nto: Alex", face, ctx), true);
  assert.equal(isAddressed("x\n\nto: Codex", face, ctx), false);
  assert.equal(isAddressed(`x\n\nre: ${EPOCH}:7`, face, ctx), true);
  assert.equal(isAddressed(`x\n\nre: ${EPOCH}:8`, face, ctx), true, "a cursor whose message arrived from this face is where the addressee lives");
  assert.equal(isAddressed(`x\n\nre: ${EPOCH}:9`, face, ctx), false);
  assert.equal(isAddressed("to: Alex is who I mean in prose", face, ctx), false, "prose is not a trailer");
  assert.equal(isLanding("landed\n\nverdict: landed\nexhibit: 9f2c1a0b4d6e9f7a2b5c8d1e3f4a6b90c7d3e1f5"), true);
  assert.equal(isLanding("landed\n\nverdict: holding\nexhibit: forge/output/x.md"), false);
});

// ---------------------------------------------------------------------------------------------

test("fixture 02: a native answer addressed to a human appears on Slack exactly once, the receipt before the call and the pending line before the request", async () => {
  /** @type {string[]} */
  const recordsAtCall = [];
  /** @type {string} */
  let file = "";
  const r = await rig({ routes: [AUTH, ["chat.postMessage", () => { recordsAtCall.push(readFileSync(file, "utf8")); return { body: { ok: true, ts: "1756900001.000000", channel: "C0123ABC" } }; }]] });
  file = r.file;
  try {
    const text = "the derper is up on 443 and 3478\n\nto: Alex\n\n-- Fable/agora-orchestrator";
    const { faces, settled } = await r.runner.face(msg({ text }));
    // the receipt: every face is pending and NO transport call has been issued
    assert.deepEqual(faces, [{ transport: "slack", status: "pending" }]);
    assert.equal(r.posts().length, 0, "the receipt returns before any chat.postMessage is issued");
    const after = await settled;
    assert.deepEqual(after, [{ transport: "slack", status: "published", id: "1756900001.000000" }]);
    assert.equal(r.posts().length, 1);
    const body = r.bodyOf(r.posts()[0]);
    assert.deepEqual(body, { channel: "C0123ABC", text: encodeSlackText(text), metadata: { event_type: "agora_face", event_payload: { origin: ORIGIN_A } } });
    assert.equal(body.text, text, "the signature and trailers travel as posted");
    // the pending line was durable before the request
    assert.equal(recordsAtCall.length, 1);
    const pendingLine = JSON.parse(recordsAtCall[0].trim().split("\n").at(-1) ?? "{}");
    assert.equal(pendingLine.status, "pending");
    assert.equal(pendingLine.originId, ORIGIN_A);
    assert.equal(pendingLine.cursor, `${EPOCH}:41`);
    assert.equal(pendingLine.attempt, 1);
    assert.ok(!recordsAtCall[0].includes('"published"'));
    const folded = (await r.records()).get(faceKey(ORIGIN_A, "slack"));
    assert.equal(folded?.status, "published");
    assert.equal(folded?.id, "1756900001.000000");
    assert.equal(folded?.selector, "addressed");
    // the P3 projection of the record validates as a FacePublication
    const dto = validateFacePublication(toFacePublication(/** @type {any} */ (folded), ROOM, "C0123ABC"));
    assert.equal(dto.status, "published");
    // an agent-only post gets no face and issues zero calls
    const agentOnly = await r.runner.face(msg({ id: ORIGIN_B, seq: 42, text: "claim taken\n\nclaim: work:faces\n\n-- Fable" }));
    assert.deepEqual(agentOnly.faces, []);
    await agentOnly.settled;
    assert.equal(r.posts().length, 1);
    assert.match(r.warned.join("\n"), /face slack published 1756900001\.000000/);
  } finally { await r.cleanup(); }
});

// ---------------------------------------------------------------------------------------------

test("fixture 03 arm 1: a lost response is recorded unknown, never refused and never retried blind", async () => {
  const r = await rig({ routes: [AUTH, ["chat.postMessage", () => { throw new TypeError("fetch failed"); }]] });
  try {
    const { faces, settled } = await r.runner.face(msg({ text: "the derper is up on 443 and 3478\n\nto: Alex\n\n-- Fable" }));
    assert.deepEqual(faces, [{ transport: "slack", status: "pending" }]);
    const [outcome] = await settled;
    assert.equal(outcome.status, "unknown");
    const rec = (await r.records()).get(faceKey(ORIGIN_A, "slack"));
    assert.equal(rec?.status, "unknown");
    assert.equal(rec?.code, "lost-response");
    assert.equal(rec?.attempt, 1);
    assert.equal(rec?.pendingAt, "2026-09-05T12:00:00.000Z");
    assert.equal(r.posts().length, 1, "one request left; no blind retry followed it");
    assert.deepEqual((await r.runner.unknown()).map((x) => x.originId), [ORIGIN_A]);
  } finally { await r.cleanup(); }
});

const unknownA = { originId: ORIGIN_A, cursor: `${EPOCH}:41`, transport: "slack", status: "unknown", code: "lost-response", attempt: 1, at: "2026-09-05T12:00:00.000Z", pendingAt: "2026-09-05T12:00:00.000Z", selector: "addressed", payloadDigest: sha("ack") };

test("fixture 03 arm 2: the reconciliation read finds the rider, so the face is published with that ts and zero posts", async () => {
  const c = clock("2026-09-05T12:01:00.000Z");
  const r = await rig({ clock: c, records: [unknownA], routes: [AUTH, ["conversations.history", () => ({ body: { ok: true, has_more: false, messages: [
    { ts: "1788609601.000000", bot_id: "B1", subtype: "bot_message", username: "claude-house", text: "the derper is up on 443 and 3478", metadata: { event_type: "agora_face", event_payload: { origin: ORIGIN_A } } },
  ] } })]] });
  try {
    const swept = await r.runner.sweep();
    assert.deepEqual(swept, { held: false, outcomes: [{ key: faceKey(ORIGIN_A, "slack"), outcome: "published" }] });
    const rec = (await r.records()).get(faceKey(ORIGIN_A, "slack"));
    assert.equal(rec?.status, "published");
    assert.equal(rec?.id, "1788609601.000000");
    assert.equal(rec?.via, "rider");
    assert.equal(r.posts().length, 0);
    // the window Slack was asked for: [pendingAt - 5s, now]
    const url = r.callsTo("conversations.history")[0].url;
    assert.equal(url.searchParams.get("oldest"), "1788609595.000000");
    assert.equal(url.searchParams.get("latest"), "1788609660.000000");
  } finally { await r.cleanup(); }
});

test("fixture 03 arm 3: the read succeeded and the message is not there, so it is reposted as attempt 2", async () => {
  const c = clock("2026-09-05T12:01:00.000Z");
  const r = await rig({ clock: c, records: [unknownA], lookupCursor: (cur) => (cur === `${EPOCH}:41` ? msg({ text: "ack\n\nto: Alex\n\n-- Fable" }) : undefined),
    routes: [AUTH, ["conversations.history", () => ({ body: { ok: true, has_more: false, messages: [] } })], ["chat.postMessage", () => ({ body: { ok: true, ts: "1756900009.000000" } })]] });
  try {
    const swept = await r.runner.sweep();
    assert.equal(swept.outcomes[0].outcome, "reposted");
    const rec = (await r.records()).get(faceKey(ORIGIN_A, "slack"));
    assert.equal(rec?.status, "published");
    assert.equal(rec?.id, "1756900009.000000");
    assert.equal(rec?.attempt, 2);
    assert.equal(r.posts().length, 1);
    assert.equal(r.bodyOf(r.posts()[0]).metadata.event_payload.origin, ORIGIN_A, "the repost carries the same origin id");
  } finally { await r.cleanup(); }
});

test("fixture 03 arm 4: a failed reconciliation read never licenses a repost; the face stays unknown at attempt 1", async () => {
  const c = clock("2026-09-05T12:01:00.000Z");
  const r = await rig({ clock: c, records: [unknownA], routes: [AUTH, ["conversations.history", () => ({ body: { ok: false, error: "ratelimited" } })], ["chat.postMessage", () => ({ body: { ok: true, ts: "1756900009.000000" } })]] });
  try {
    const swept = await r.runner.sweep();
    assert.equal(swept.held, true);
    assert.equal(swept.outcomes[0].outcome, "read-failed");
    const rec = (await r.records()).get(faceKey(ORIGIN_A, "slack"));
    assert.equal(rec?.status, "unknown");
    assert.equal(rec?.attempt, 1);
    assert.equal(r.posts().length, 0, "a retry blind to the channel IS the duplicate");
  } finally { await r.cleanup(); }
});

test("fixture 03 arm 5: no rider and two byte-identical bodies from this seat stay unknown, quarantined, listed for a human", async () => {
  const c = clock("2026-09-05T12:01:00.000Z");
  const r = await rig({ clock: c, records: [unknownA], routes: [AUTH, ["conversations.history", () => ({ body: { ok: true, has_more: false, messages: [
    { ts: "1788609601.000000", bot_id: "B1", subtype: "bot_message", username: "claude-house", text: "ack" },
    { ts: "1788609602.000000", bot_id: "B1", subtype: "bot_message", username: "claude-house", text: "ack" },
  ] } })], ["chat.postMessage", () => ({ body: { ok: true, ts: "1756900009.000000" } })]] });
  try {
    const swept = await r.runner.sweep();
    assert.equal(swept.outcomes[0].outcome, "ambiguous");
    const rec = (await r.records()).get(faceKey(ORIGIN_A, "slack"));
    assert.equal(rec?.status, "unknown");
    assert.equal(rec?.code, "ambiguous");
    assert.deepEqual(rec?.quarantine, ["1788609601.000000", "1788609602.000000"]);
    assert.equal(r.posts().length, 0);
    assert.deepEqual((await r.runner.unknown()).map((x) => x.quarantine), [["1788609601.000000", "1788609602.000000"]]);
    // a second tick does not spend a read on a face a human owns now
    await r.runner.sweep();
    assert.equal(r.callsTo("conversations.history").length, 1);
  } finally { await r.cleanup(); }
});

test("fixture 03 arm 5 (distinct bodies): no rider but a unique payload reconciles exactly through the seat's own account", async () => {
  const c = clock("2026-09-05T12:01:00.000Z");
  const r = await rig({ clock: c, records: [unknownA], routes: [AUTH, ["conversations.history", () => ({ body: { ok: true, has_more: false, messages: [
    { ts: "1788609601.000000", bot_id: "B1", subtype: "bot_message", username: "claude-house", text: "ack" },
    { ts: "1788609602.000000", bot_id: "B1", subtype: "bot_message", username: "claude-house", text: "nack" },
    { ts: "1788609603.000000", bot_id: "B9", subtype: "bot_message", username: "some-other-app", text: "ack" },
  ] } })]] });
  try {
    await r.runner.sweep();
    const rec = (await r.records()).get(faceKey(ORIGIN_A, "slack"));
    assert.equal(rec?.status, "published");
    assert.equal(rec?.id, "1788609601.000000");
    assert.equal(rec?.via, "payload");
  } finally { await r.cleanup(); }
});

test("fixture 03: the ladder is bounded; after the last attempt the face is refused as exhausted", async () => {
  const c = clock("2026-09-05T12:01:00.000Z");
  const r = await rig({ clock: c, records: [{ ...unknownA, attempt: FACE_MAX_ATTEMPTS }], routes: [AUTH, ["conversations.history", () => ({ body: { ok: true, has_more: false, messages: [] } })], ["chat.postMessage", () => ({ body: { ok: true, ts: "1756900009.000000" } })]] });
  try {
    const swept = await r.runner.sweep();
    assert.equal(swept.outcomes[0].outcome, "exhausted");
    assert.equal((await r.records()).get(faceKey(ORIGIN_A, "slack"))?.code, "exhausted");
    assert.equal(r.posts().length, 0);
  } finally { await r.cleanup(); }
});

// ---------------------------------------------------------------------------------------------

test("fixture 04: Slack unreachable by isolated configuration; the native receipt stands, the face refuses dark, one redacted stderr line", async () => {
  const r = await rig({ face: { post: { human: ["always"], agent: ["addressed"] } }, routes: [["slack.com/api", () => { throw new Error("getaddrinfo ENOTFOUND slack.com"); }]] });
  try {
    const message = msg({ text: "answered\n\nto: Alex\n\n-- Fable" });
    const { faces, settled } = await r.runner.face(message);
    assert.deepEqual(faces, [{ transport: "slack", status: "pending" }], "the receipt is returned in full before any face is attempted");
    const [outcome] = await settled;
    assert.equal(outcome.status, "refused");
    assert.equal(outcome.reason, "dark: the slack face could not be reached");
    const rec = (await r.records()).get(faceKey(ORIGIN_A, "slack"));
    assert.equal(rec?.status, "refused");
    assert.equal(rec?.code, "dark");
    assert.equal(rec?.attempt, 1);
    assert.deepEqual(r.warned, ["face slack refused: dark: the slack face could not be reached"]);
    // a claim with no human addressee never even tries the face
    const claim = await r.runner.face(msg({ id: ORIGIN_B, seq: 42, text: "claim taken\n\nclaim: work:faces\n\n-- Fable" }));
    assert.deepEqual(claim.faces, []);
    // the human default: a human's line faces always, and a dark face refuses it the same way
    const human = await r.runner.face(msg({ id: ORIGIN_D, seq: 43, text: "hello from the TUI", author: { id: "acct-alex-0123456789", name: "Alex", kind: "human" } }));
    assert.deepEqual(human.faces, [{ transport: "slack", status: "pending" }]);
    assert.equal((await human.settled)[0].status, "refused");
  } finally { await r.cleanup(); }
});

test("fixture 04 / 09 (token missing): a room with no token is dark by configuration, in createTransport's own words", async () => {
  const r = await rig({ transportFor: async () => { throw new AgoraError(`room "house": no token (set tokenEnv or tokenFile to the bot token)`); } });
  try {
    const { settled } = await r.runner.face(msg({ text: "x\n\nto: Alex\n\n-- Fable" }));
    const [outcome] = await settled;
    assert.equal(outcome.status, "refused");
    assert.equal(outcome.reason, `dark: room "house": no token (set tokenEnv or tokenFile to the bot token)`);
  } finally { await r.cleanup(); }
});

test("fixture 04: a transport error carrying a credential shape is redacted on the record and on stderr", async () => {
  const r = await rig({ transportFor: async () => { throw new Error("proxy rejected xoxb-1234567890-abcdef at https://slack.com/api"); } });
  try {
    const { settled } = await r.runner.face(msg({ text: "x\n\nto: Alex\n\n-- Fable" }));
    await settled;
    const rec = (await r.records()).get(faceKey(ORIGIN_A, "slack"));
    assert.ok(!rec?.reason?.includes("xoxb-1234567890"), "the record carries no token");
    assert.ok(rec?.reason?.includes("[redacted]"));
    assert.ok(!(await readFile(r.file, "utf8")).includes("xoxb-1234567890"));
    assert.ok(r.warned.every((l) => !l.includes("xoxb-1234567890")));
  } finally { await r.cleanup(); }
});

test("classification: answered means refused, a link death after send means unknown, a failure before send means dark", () => {
  assert.equal(classifyFaceFailure(new SlackApiError("slack chat.postMessage: not_in_channel", { answered: true, error: "not_in_channel" }), "slack").status, "refused");
  assert.equal(classifyFaceFailure(new SlackApiError("slack chat.postMessage: not_in_channel", { answered: true, error: "not_in_channel" }), "slack").code, "not-in-channel");
  assert.equal(classifyFaceFailure(new SlackApiError("slack chat.postMessage: HTTP 403", { answered: true, status: 403 }), "slack").status, "refused");
  assert.equal(classifyFaceFailure(new SlackApiError("slack chat.postMessage: HTTP 502", { answered: false, status: 502 }), "slack").status, "unknown");
  assert.equal(classifyFaceFailure(new SlackApiError("slack chat.postMessage: rate limited", { answered: false }), "slack").status, "unknown");
  assert.equal(classifyFaceFailure(new SlackApiError("slack chat.postMessage: the link died during the request", { answered: false, sent: true }), "slack").status, "unknown");
  const dark = classifyFaceFailure(new SlackApiError("slack chat.postMessage: unreachable", { answered: false, sent: false }), "slack");
  assert.deepEqual(dark, { status: "refused", code: "dark", reason: "dark: the slack face could not be reached" });
});

// ---------------------------------------------------------------------------------------------

/** The messages a poll delivers, read through the real transport against the fake API. @param {ReturnType<typeof rig> extends Promise<infer T> ? T : never} r @param {import('../src/core.mjs').ReadOptions} [opts] */
function reader(r, opts = {}) { return () => r.transport.read({ since: "1756900000.000000", ...opts }); }

test("fixture 05: a human's Slack thread reply lands in the native thread of the published face, origin stamped by the service", async () => {
  const published = { originId: ORIGIN_A, cursor: `${EPOCH}:41`, transport: "slack", status: "published", id: "1756900001.000000", attempt: 1, at: "2026-09-05T12:00:00.300Z", selector: "addressed" };
  const parent = { ts: "1756900001.000000", bot_id: "B1", subtype: "bot_message", username: "claude-house", text: "the derper is up on 443 and 3478", thread_ts: "1756900001.000000", reply_count: 1, metadata: { event_type: "agora_face", event_payload: { origin: ORIGIN_A } } };
  const reply = { ts: "1756900002.500000", user: "U2", text: "good. name it in doctor", thread_ts: "1756900001.000000" };
  const r = await rig({ records: [published], routes: [AUTH,
    ["users.info", () => ({ body: { ok: true, user: { id: "U2", real_name: "Alex" } } })],
    ["conversations.history", () => ({ body: { ok: true, has_more: false, messages: [parent] } })],
    ["conversations.replies", () => ({ body: { ok: true, has_more: false, messages: [parent, reply] } })]] });
  try {
    /** @type {any[]} */
    const appended = [];
    const appendForeign = async (/** @type {any} */ m) => { appended.push(m); };
    const room = await r.runner.poll(r.face, { read: reader(r), appendForeign });
    assert.equal(room.held, false);
    assert.deepEqual(room.ingested, [], "the parent is our published face and is not ingested");
    assert.deepEqual(room.notIngested.map((x) => x.id), ["1756900001.000000"]);
    const thread = await r.runner.poll(r.face, { read: reader(r, { thread: "1756900001.000000" }), appendForeign });
    assert.equal(appended.length, 1);
    const native = appended[0];
    assert.equal(native.thread, ORIGIN_A, "the mapping is the face record, never a trailer");
    assert.deepEqual(native.author, { id: "U2", name: "Alex", kind: "human" });
    assert.equal(native.text, "good. name it in doctor");
    assert.deepEqual(native.account, { transport: "slack", id: "U2" });
    assert.equal(native.key, "unverified");
    assert.equal("bearer" in native, false, "bearer is seat-attested and never stamped on a foreign author");
    const origin = validateOriginReference(native.origin);
    assert.deepEqual(origin, { source: { transport: "slack", room: "C0123ABC", id: "1756900002.500000" }, ts: "2025-09-03T11:46:42.500Z", author: { id: "U2", name: "Alex", kind: "human" }, attestor: ATTESTOR });
    assert.equal(thread.cursor, "1756900002.500000");
  } finally { await r.cleanup(); }
});

test("fixture 05: a reply whose thread root is unknown lands top-level with the thread ts preserved beside it, never dropped", async () => {
  const r = await rig({ routes: [AUTH, ["conversations.replies", () => ({ body: { ok: true, has_more: false, messages: [
    { ts: "1756900300.000000", user: "U2", text: "root", thread_ts: "1756900300.000000" },
    { ts: "1756900301.000000", user: "U2", text: "orphan reply", thread_ts: "1756900300.000000" }] } })], ["users.info", () => ({ body: { ok: true, user: { id: "U2", real_name: "Alex" } } })]] });
  try {
    /** @type {any[]} */
    const appended = [];
    await r.runner.poll(r.face, { read: reader(r, { thread: "1756900300.000000" }), appendForeign: async (m) => { appended.push(m); } });
    assert.equal(appended.length, 1);
    assert.equal(appended[0].thread, undefined);
    assert.equal(appended[0].threadTs, "1756900300.000000");
  } finally { await r.cleanup(); }
});

// ---------------------------------------------------------------------------------------------

test("fixture 06: a partner agent with no seat arrives natively with origin and an unverified key; the reply faces Slack in the partner's thread", async () => {
  const partnerText = "the H3 director is on main\n\nto: Fable\n\n-- Codex/slopcannon";
  /** @type {any[]} */
  const appended = [];
  const r = await rig({
    lookupCursor: (cur) => (cur === `${EPOCH}:63` ? { ...appended[0], id: ORIGIN_D, cursor: `${EPOCH}:63` } : undefined),
    routes: [AUTH, ["conversations.history", () => ({ body: { ok: true, has_more: false, messages: [
      { ts: "1756900100.000100", bot_id: "B7", subtype: "bot_message", username: "slopcannon-codex", text: partnerText }] } })],
      ["chat.postMessage", () => ({ body: { ok: true, ts: "1756900101.000000" } })]],
  });
  try {
    const polled = await r.runner.poll(r.face, { read: reader(r), appendForeign: async (m) => { appended.push(m); } });
    assert.equal(polled.ingested.length, 1);
    const native = appended[0];
    assert.deepEqual(native.author, { id: "B7", name: "slopcannon-codex", kind: "agent" });
    assert.equal(native.signedAs, "Codex/slopcannon");
    assert.equal(native.text, partnerText, "the incoming to: is carried verbatim and steers nothing");
    assert.equal(native.key, "unverified");
    assert.equal("bearer" in native, false);
    assert.equal("operator_act" in native, false);
    assert.deepEqual(native.origin.source, { transport: "slack", room: "C0123ABC", id: "1756900100.000100" });
    assert.equal(native.origin.author.id, "B7");
    assert.equal(r.posts().length, 0, "an ingested foreign message never acquires a face of its own");
    // the seat answers: re: the ingested cursor, whose message has origin on this face
    const { faces, settled } = await r.runner.face(msg({ id: ORIGIN_B, seq: 64, text: `seen; the gate is green\n\nre: ${EPOCH}:63\n\n-- Fable/agora-orchestrator` }));
    assert.deepEqual(faces, [{ transport: "slack", status: "pending" }]);
    const [outcome] = await settled;
    assert.equal(outcome.status, "published");
    assert.equal(outcome.id, "1756900101.000000");
    assert.equal(r.posts().length, 1);
    assert.equal(r.bodyOf(r.posts()[0]).thread_ts, "1756900100.000100", "the reply lands in the partner's Slack thread through the origin id");
    assert.equal((await r.records()).get(faceKey(ORIGIN_B, "slack"))?.selector, "addressed");
  } finally { await r.cleanup(); }
});

// ---------------------------------------------------------------------------------------------

const fixture07History = [
  { ts: "1756900001.000000", bot_id: "B1", subtype: "bot_message", username: "claude-house", text: "the derper is up on 443 and 3478", metadata: { event_type: "agora_face", event_payload: { origin: ORIGIN_A } } },
  { ts: "1756900014.900000", bot_id: "B1", subtype: "bot_message", username: "claude-house", text: "ack", metadata: { event_type: "agora_face", event_payload: { origin: ORIGIN_B } } },
  { ts: "1756900015.000000", user: "U2", text: "thanks" },
  { ts: "1756900016.000000", bot_id: "B9", subtype: "bot_message", username: "some-other-app", text: "build 412 passed" },
];
const publishedA = { originId: ORIGIN_A, cursor: `${EPOCH}:41`, transport: "slack", status: "published", id: "1756900001.000000", attempt: 1, at: "2026-09-05T12:00:00.300Z" };

test("fixture 07: an own face echo is not re-ingested, a pending face resolves on its echo, and everything else is foreign whatever the author", async () => {
  const c = clock("2026-09-05T12:00:20.000Z");
  const pendingB = { originId: ORIGIN_B, cursor: `${EPOCH}:42`, transport: "slack", status: "pending", attempt: 1, at: "2026-09-05T12:00:14.000Z", pendingAt: "2026-09-05T12:00:14.000Z", payloadDigest: sha("ack") };
  const r = await rig({ clock: c, records: [publishedA, pendingB], routes: [AUTH, ["users.info", () => ({ body: { ok: true, user: { id: "U2", real_name: "Alex" } } })],
    ["conversations.history", () => ({ body: { ok: true, has_more: false, messages: [...fixture07History].reverse() } })]] });
  try {
    /** @type {any[]} */
    const appended = [];
    const polled = await r.runner.poll(r.face, { read: reader(r), appendForeign: async (m) => { appended.push(m); } });
    assert.equal(polled.held, false);
    assert.deepEqual(appended.map((m) => [m.origin.source.id, m.author.id, m.author.kind, m.key]), [["1756900015.000000", "U2", "human", "unverified"], ["1756900016.000000", "B9", "agent", "unverified"]]);
    assert.deepEqual(polled.notIngested.map((x) => x.id), ["1756900001.000000", "1756900014.900000"]);
    const b = (await r.records()).get(faceKey(ORIGIN_B, "slack"));
    assert.equal(b?.status, "published");
    assert.equal(b?.id, "1756900014.900000");
    assert.equal(b?.via, "echo");
    assert.equal(r.posts().length, 0);
    assert.equal(polled.cursor, "1756900016.000000");
  } finally { await r.cleanup(); }
});

test("fixture 07 (not author based): a message from our own bot account with no face record and no pending face IS ingested", async () => {
  const r = await rig({ records: [publishedA], routes: [AUTH, ["conversations.history", () => ({ body: { ok: true, has_more: false, messages: [
    { ts: "1756900030.000000", bot_id: "B1", subtype: "bot_message", username: "claude-house", text: "posted by the other seat through the same token" }] } })]] });
  try {
    /** @type {any[]} */
    const appended = [];
    const polled = await r.runner.poll(r.face, { read: reader(r), appendForeign: async (m) => { appended.push(m); } });
    assert.equal(polled.held, false);
    assert.equal(appended.length, 1);
    assert.equal(appended[0].origin.source.id, "1756900030.000000");
  } finally { await r.cleanup(); }
});

test("fixture 07 rule 3: our own account while a face is pending inside the settle window is HELD, not ingested and not dropped, and the cursor is withheld", async () => {
  const c = clock("2026-09-05T12:00:20.000Z");
  const pendingB = { originId: ORIGIN_B, cursor: `${EPOCH}:42`, transport: "slack", status: "pending", attempt: 1, at: "2026-09-05T12:00:14.000Z", pendingAt: "2026-09-05T12:00:14.000Z" };
  const r = await rig({ clock: c, records: [pendingB], routes: [AUTH, ["users.info", () => ({ body: { ok: true, user: { id: "U2", real_name: "Alex" } } })],
    ["conversations.history", () => ({ body: { ok: true, has_more: false, messages: [
      { ts: "1756900014.900000", bot_id: "B1", subtype: "bot_message", username: "claude-house", text: "ack" },
      { ts: "1756900013.000000", user: "U2", text: "before" }] } })]] });
  try {
    /** @type {any[]} */
    const appended = [];
    const polled = await r.runner.poll(r.face, { read: reader(r), appendForeign: async (m) => { appended.push(m); } });
    assert.equal(polled.held, true);
    assert.equal(polled.reason, "own-account-while-pending");
    assert.equal(appended.length, 1, "the human line before it was ingested");
    assert.equal(polled.cursor, "1756900013.000000", "the cursor stops before the held message");
    assert.equal((await r.records()).get(faceKey(ORIGIN_B, "slack"))?.status, "pending");
  } finally { await r.cleanup(); }
});

// ---------------------------------------------------------------------------------------------

test("fixture 09: the --face and --no-face rows refuse with their named reasons; the native post is never the thing refused", async () => {
  const r = await rig({ routes: [AUTH, ["chat.postMessage", () => ({ body: { ok: true, ts: "1756900001.000000" } })]] });
  try {
    const plain = "x\n\n-- Fable";
    /** @param {any} m @param {any} [opts] */
    const run = async (m, opts) => { const { faces, settled } = await r.runner.face(m, opts); const after = await settled; return { faces, after }; };
    // --face slack: published, though no selector would have chosen an agent-only line
    let n = 1;
    const seq = () => n++;
    const row1 = await run(msg({ id: ORIGIN_A.replace(/^c4/, "01"), seq: seq(), text: plain }), { face: ["slack"] });
    assert.deepEqual(row1.after, [{ transport: "slack", status: "published", id: "1756900001.000000" }]);
    // --no-face
    const row2 = await run(msg({ id: ORIGIN_A.replace(/^c4/, "02"), seq: seq(), text: "x\n\nto: Alex\n\n-- Fable" }), { face: "none" });
    assert.deepEqual(row2.faces, []);
    assert.equal(r.posts().length, 1);
    // --face local: capability
    const row4 = await run(msg({ id: ORIGIN_A.replace(/^c4/, "04"), seq: seq(), text: plain }), { face: ["local"] });
    assert.deepEqual(row4.faces, [{ transport: "local", status: "refused", reason: "capability: the local transport is an append-only NDJSON file with no audience to face to" }]);
    // credential shape: redacted, not redact-and-send
    const row10 = await run(msg({ id: ORIGIN_A.replace(/^c4/, "10"), seq: seq(), text: "the token is xoxb-1234567890abcdef\n\nto: Alex\n\n-- Fable" }));
    assert.deepEqual(row10.faces, [{ transport: "slack", status: "refused", reason: "redacted: the body carries a credential shape and a face is byte-identical or it is not sent" }]);
    assert.ok(!(await readFile(r.file, "utf8")).includes("xoxb-1234567890abcdef"), "the record never carries the token");
    // a transfer offer envelope: route
    const envelope = encodeTransfer({ version: 1, kind: "offer", offer: { id: "o1" } });
    const row11 = await run(msg({ id: ORIGIN_A.replace(/^c4/, "11"), seq: seq(), text: `${envelope}\n\nto: Alex\n\n-- Fable` }));
    assert.equal(row11.faces[0].status, "refused");
    assert.match(String(row11.faces[0].reason), /^route: the body carries a transfer route/);
    // too-long, no --split
    const long = `${"y".repeat(3901 - "\n\nto: Alex\n\n-- Fable".length)}\n\nto: Alex\n\n-- Fable`;
    const row7 = await run(msg({ id: ORIGIN_A.replace(/^c4/, "07"), seq: seq(), text: long }));
    assert.equal(row7.faces[0].status, "refused");
    assert.equal(row7.faces[0].reason, "too-long: the slack face is 3901 rendered characters and the limit is 3900; pass --split to chunk at line boundaries");
    assert.equal(r.posts().length, 1, "no refused row issued a call");
    // every refusal is on the record and printed once
    assert.equal(r.warned.filter((l) => l.startsWith("face slack refused")).length, 3);
    assert.equal(r.warned.filter((l) => l.startsWith("face local refused")).length, 1);
  } finally { await r.cleanup(); }
});

test("fixture 09: no-such-face and disabled name the command that fixes them", async () => {
  const none = await rig({ faces: [] });
  try {
    const { faces } = await none.runner.face(msg({ text: "x\n\n-- Fable" }), { face: ["slack"] });
    assert.deepEqual(faces, [{ transport: "slack", status: "refused", reason: `no-such-face: room ${ROOM} has no slack face; set one with agora room faces ${ROOM} --add slack --channel <id>` }]);
  } finally { await none.cleanup(); }
  const off = await rig({ face: { enabled: false } });
  try {
    const { faces } = await off.runner.face(msg({ text: "x\n\n-- Fable" }), { face: ["slack"] });
    assert.deepEqual(faces, [{ transport: "slack", status: "refused", reason: "disabled: the slack face of house is off; turn it on with agora room faces house --enable slack" }]);
    const auto = await off.runner.face(msg({ id: ORIGIN_B, seq: 42, text: "x\n\nto: Alex\n\n-- Fable" }));
    assert.deepEqual(auto.faces, [], "a disabled face is skipped silently under auto selection");
  } finally { await off.cleanup(); }
});

// ---------------------------------------------------------------------------------------------

const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(992, 7)]);
const image = { id: "blob-7f3a0123456789ab", name: "screen shot.png", kind: "image", mimetype: "image/png", size: PNG.length, width: 1080, height: 2340, digest: `sha256:${createHash("sha256").update(PNG).digest("hex")}`, lifetime: "durable" };
const pcap = { id: "blob-91bc0123456789ab", name: "collector.pcap", kind: "file", mimetype: "application/vnd.tcpdump.pcap", size: 41220000, digest: `sha256:${"a".repeat(64)}`, lifetime: "durable" };

/** @param {{ complete?: () => any, url?: () => any }} [o] */
function uploadRoutes(o = {}) {
  return [AUTH,
    ["chat.postMessage", () => ({ body: { ok: true, ts: "1756900001.000000" } })],
    ["files.getUploadURLExternal", o.url ?? (() => ({ body: { ok: true, upload_url: "https://files.slack.com/upload/v1/CwABAAAAAxAAA", file_id: "F0PIC" } }))],
    ["files.slack.com/upload", () => ({ status: 200, body: "OK" })],
    ["files.completeUploadExternal", o.complete ?? (() => ({ body: { ok: true, files: [{ id: "F0PIC", title: "screen shot.png" }] } }))],
  ];
}

test("fixture 10: under pictures, the image is uploaded once through files:write with W10's bounds, the pcap is metadata only, no path and no bytes reach the text", async () => {
  /** @type {string[]} */
  const recordsAtComplete = [];
  /** @type {string} */
  let file = "";
  const r = await rig({ face: { attachments: "pictures" }, readBlob: async (a) => (a.id === image.id ? PNG : Buffer.alloc(0)),
    routes: uploadRoutes({ complete: () => { recordsAtComplete.push(readFileSync(file, "utf8")); return { body: { ok: true, files: [{ id: "F0PIC" }] } }; } }) });
  file = r.file;
  try {
    const message = msg({ text: "here is the collector\n\nto: Alex\n\n-- Fable", attachments: [{ ...image, path: "C:\\Users\\alex\\blobs\\7f3a.png" }, pcap] });
    const { faces, settled } = await r.runner.face(message);
    assert.deepEqual(faces, [{ transport: "slack", status: "pending" }]);
    assert.equal(r.calls.length, 0, "the receipt precedes every call, uploads included");
    const after = await settled;
    assert.deepEqual(after, [{ transport: "slack", status: "published", id: "1756900001.000000" }, { transport: "slack", status: "published", attachmentId: image.id }]);
    // the text face: body, then one metadata line per attachment, before the trailers; never a path, never bytes
    const text = r.bodyOf(r.posts()[0]).text;
    assert.equal(text, `here is the collector\nimage screen shot.png (image/png, ${PNG.length} bytes)\nfile collector.pcap (application/vnd.tcpdump.pcap, 41220000 bytes)\n\nto: Alex\n\n-- Fable`);
    assert.ok(!text.includes("C:\\Users"));
    assert.ok(!text.includes(PNG.toString("base64").slice(0, 16)));
    // the upload ladder, once, for the image only
    const urls = r.callsTo("files.getUploadURLExternal");
    assert.equal(urls.length, 1);
    assert.equal(urls[0].url.searchParams.get("filename"), "screen shot.png");
    assert.equal(urls[0].url.searchParams.get("length"), String(PNG.length));
    const put = r.callsTo("files.slack.com/upload");
    assert.equal(put.length, 1);
    assert.equal(Buffer.from(/** @type {any} */ (put[0].init?.body)).equals(PNG), true, "the verified bytes, as custody holds them");
    assert.equal(put[0].init?.headers && /** @type {any} */ (put[0].init.headers)["authorization"], undefined, "the pre-signed URL carries no bearer");
    const complete = r.callsTo("files.completeUploadExternal");
    assert.equal(complete.length, 1);
    assert.deepEqual(r.bodyOf(complete[0]), { files: [{ id: "F0PIC", title: "screen shot.png" }], channel_id: "C0123ABC" });
    // the pending line for the picture was durable before the visible step, carrying the file id
    const lines = recordsAtComplete[0].trim().split("\n").map((l) => JSON.parse(l));
    const pendingPic = lines.at(-1);
    assert.equal(pendingPic.status, "pending");
    assert.equal(pendingPic.part, "attachment");
    assert.equal(pendingPic.fileId, "F0PIC");
    assert.equal(pendingPic.attachmentId, image.id);
    const records = await r.records();
    assert.equal(records.get(faceKey(ORIGIN_A, "slack", image.id))?.status, "published");
    assert.equal(records.has(faceKey(ORIGIN_A, "slack", pcap.id)), false, "a file is never uploaded, so it has no picture record");
    const dto = validateFacePublication(toFacePublication(/** @type {any} */ (records.get(faceKey(ORIGIN_A, "slack", image.id))), ROOM, "C0123ABC"));
    assert.equal(dto.faceId, `slack-${image.id}`);
  } finally { await r.cleanup(); }
});

test("fixture 10: under metadata (the default) nothing is uploaded and the same two lines are rendered", async () => {
  const r = await rig({ routes: uploadRoutes() });
  try {
    const { settled } = await r.runner.face(msg({ text: "here\n\nto: Alex\n\n-- Fable", attachments: [image, pcap] }));
    await settled;
    assert.equal(r.callsTo("files.").length, 0);
    assert.match(r.bodyOf(r.posts()[0]).text, /^here\nimage screen shot\.png \(image\/png, \d+ bytes\)\nfile collector\.pcap/);
    assert.equal(faceText({ text: "t", attachments: [image] }, "none"), "t");
  } finally { await r.cleanup(); }
});

test("fixture 10: the bounds hold before any byte moves: a ninth image, an oversize image, a non-image mimetype and a digest mismatch are refused to their metadata line", async () => {
  const bytes = Buffer.alloc(16, 1);
  const good = (/** @type {number} */ i) => ({ ...image, id: `blob-img${String(i).padStart(14, "0")}`, name: `s${i}.png`, size: bytes.length, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` });
  const nine = Array.from({ length: 9 }, (_, i) => good(i));
  const r = await rig({ face: { attachments: "pictures" }, readBlob: async () => bytes, routes: uploadRoutes() });
  try {
    const { settled } = await r.runner.face(msg({ text: "nine\n\nto: Alex\n\n-- Fable", attachments: nine }));
    const after = await settled;
    assert.equal(r.callsTo("files.getUploadURLExternal").length, 8);
    assert.equal(after.filter((x) => x.attachmentId && x.status === "published").length, 8);
    const ninth = after.find((x) => x.attachmentId === nine[8].id);
    assert.equal(ninth?.status, "refused");
    assert.match(String(ninth?.reason), /more than 8 images on one message/);
    // oversize by metadata: refused before any call; wrong mimetype: refused; digest mismatch: refused after the bytes are read, before any upload
    const big = { ...good(20), size: SLACK_IMAGE_MAX_BYTES + 1 };
    const notImage = { ...good(21), mimetype: "application/pdf" };
    const tampered = { ...good(22), digest: `sha256:${"0".repeat(64)}` };
    const before = r.calls.length;
    const second = await r.runner.face(msg({ id: ORIGIN_B, seq: 42, text: "bounds\n\nto: Alex\n\n-- Fable", attachments: [big, notImage, tampered] }));
    const outcomes = await second.settled;
    assert.equal(r.calls.length - before, 1, "only the text face was called");
    assert.deepEqual(outcomes.map((x) => x.status), ["published", "refused", "refused", "refused"]);
    assert.match(String(outcomes[1].reason), /exceeds the \d+-byte limit/);
    assert.match(String(outcomes[2].reason), /is not an image type/);
    assert.match(String(outcomes[3].reason), /do not match their digest/);
  } finally { await r.cleanup(); }
});

test("fixture 10: an upload that fails degrades that picture to its metadata line and never blocks the text face", async () => {
  const r = await rig({ face: { attachments: "pictures" }, readBlob: async () => PNG, routes: uploadRoutes({ complete: () => ({ body: { ok: false, error: "not_in_channel" } }) }) });
  try {
    const { settled } = await r.runner.face(msg({ text: "pic\n\nto: Alex\n\n-- Fable", attachments: [image] }));
    const after = await settled;
    assert.equal(after[0].status, "published");
    assert.equal(after[1].status, "refused");
    assert.equal(after[1].attachmentId, image.id);
    assert.match(r.bodyOf(r.posts()[0]).text, /image screen shot\.png \(image\/png, \d+ bytes\)/);
    const rec = (await r.records()).get(faceKey(ORIGIN_A, "slack", image.id));
    assert.equal(rec?.code, "not-in-channel");
  } finally { await r.cleanup(); }
});

test("fixture 10 / 03: a lost completeUpload response is unknown, reconciled by file id in the channel, never re-shared blind", async () => {
  const c = clock("2026-09-05T12:00:00.000Z");
  let lose = true;
  const r = await rig({ clock: c, face: { attachments: "pictures" }, readBlob: async () => PNG,
    lookupCursor: (cur) => (cur === `${EPOCH}:41` ? msg({ text: "pic\n\nto: Alex\n\n-- Fable", attachments: [image] }) : undefined),
    routes: [...uploadRoutes({ complete: () => { if (lose) { lose = false; throw new TypeError("fetch failed"); } return { body: { ok: true, files: [{ id: "F0PIC" }] } }; } }),
      ["conversations.history", () => ({ body: { ok: true, has_more: false, messages: [
        { ts: "1756900001.000000", bot_id: "B1", subtype: "bot_message", username: "claude-house", text: "pic", metadata: { event_type: "agora_face", event_payload: { origin: ORIGIN_A } } },
        { ts: "1756900001.500000", bot_id: "B1", subtype: "file_share", username: "claude-house", text: "", files: [{ id: "F0PIC", name: "screen shot.png" }] }] } })]] });
  try {
    const { settled } = await r.runner.face(msg({ text: "pic\n\nto: Alex\n\n-- Fable", attachments: [image] }));
    const after = await settled;
    assert.equal(after[1].status, "unknown");
    c.advance(60_000);
    const swept = await r.runner.sweep();
    assert.deepEqual(swept.outcomes.map((o) => o.outcome), ["published"]);
    const rec = (await r.records()).get(faceKey(ORIGIN_A, "slack", image.id));
    assert.equal(rec?.status, "published");
    assert.equal(rec?.id, "1756900001.500000");
    assert.equal(rec?.via, "file-id");
    assert.equal(r.callsTo("files.completeUploadExternal").length, 1, "the share was found in the channel, so it was not repeated");
    // and the file-share echo is our own on the next poll
    /** @type {any[]} */
    const appended = [];
    const polled = await r.runner.poll(r.face, { read: reader(r), appendForeign: async (m) => { appended.push(m); } });
    assert.deepEqual(appended, []);
    assert.deepEqual(polled.notIngested.map((x) => x.id), ["1756900001.000000", "1756900001.500000"]);
  } finally { await r.cleanup(); }
});

// ---------------------------------------------------------------------------------------------

const staleA = { originId: ORIGIN_A, cursor: `${EPOCH}:41`, transport: "slack", status: "pending", attempt: 1, at: "2026-09-05T11:00:00.000Z", pendingAt: "2026-09-05T11:00:00.000Z", selector: "addressed" };
const staleD = { originId: ORIGIN_D, cursor: `${EPOCH}:42`, transport: "slack", status: "pending", attempt: 1, at: "2026-09-05T11:00:05.000Z", pendingAt: "2026-09-05T11:00:05.000Z", selector: "addressed" };
const fixture12History = [
  { ts: "1756900001.000000", bot_id: "B1", subtype: "bot_message", username: "claude-house", text: "the derper is up on 443 and 3478", metadata: { event_type: "agora_face", event_payload: { origin: ORIGIN_A } } },
  { ts: "1756900050.000000", user: "U2", text: "any word on the derper?" },
];

test("fixture 12: a pending face whose process died is swept, promoted to unknown and reconciled BEFORE any ingestion of the room", async () => {
  const c = clock("2026-09-05T12:00:00.000Z");
  /** @type {any[]} */
  const appended = [];
  /** @type {number[]} */
  const appendedAtHistoryCall = [];
  const r = await rig({ clock: c, records: [staleA, staleD], lookupCursor: (cur) => (cur === `${EPOCH}:42` ? msg({ id: ORIGIN_D, seq: 42, text: "second\n\nto: Alex\n\n-- Fable" }) : undefined),
    routes: [AUTH, ["users.info", () => ({ body: { ok: true, user: { id: "U2", real_name: "Alex" } } })],
      ["conversations.history", () => { appendedAtHistoryCall.push(appended.length); return { body: { ok: true, has_more: false, messages: [...fixture12History].reverse() } }; }],
      ["chat.postMessage", () => ({ body: { ok: true, ts: "1756900009.000000" } })]] });
  try {
    const polled = await r.runner.poll(r.face, { read: reader(r), appendForeign: async (m) => { appended.push(m); } });
    // order is the property: the archive was empty when every reconciliation read was issued
    assert.equal(appendedAtHistoryCall.length, 3, "two reconciliations, then the room read");
    assert.deepEqual(appendedAtHistoryCall, [0, 0, 0]);
    const records = await r.records();
    const a = records.get(faceKey(ORIGIN_A, "slack"));
    assert.equal(a?.status, "published");
    assert.equal(a?.id, "1756900001.000000");
    const d = records.get(faceKey(ORIGIN_D, "slack"));
    assert.equal(d?.status, "published");
    assert.equal(d?.attempt, 2, "the read succeeded and found no candidate, so it never landed and was reposted");
    assert.equal(r.posts().length, 1);
    assert.equal(polled.held, false);
    assert.deepEqual(appended.map((m) => m.origin.source.id), ["1756900050.000000"]);
    assert.deepEqual(polled.notIngested.map((x) => x.id), ["1756900001.000000"]);
    // bounded cost: a second start with nothing stale issues no reconciliation read
    const before = r.callsTo("conversations.history").length;
    await r.runner.sweep();
    assert.equal(r.callsTo("conversations.history").length, before);
  } finally { await r.cleanup(); }
});

test("fixture 12 (read failed): ingestion of the room is held for the tick, zero appends, zero posts, the faces untouched", async () => {
  const c = clock("2026-09-05T12:00:00.000Z");
  const r = await rig({ clock: c, records: [staleA], routes: [AUTH, ["conversations.history", () => ({ status: 503, body: { ok: false } })], ["chat.postMessage", () => ({ body: { ok: true, ts: "1756900009.000000" } })]] });
  try {
    /** @type {any[]} */
    const appended = [];
    const polled = await r.runner.poll(r.face, { read: reader(r), appendForeign: async (m) => { appended.push(m); } });
    assert.equal(polled.held, true);
    assert.equal(polled.reason, "reconciliation-read-failed");
    assert.deepEqual(appended, []);
    assert.equal(r.posts().length, 0);
    assert.equal(r.callsTo("conversations.history").length, 1, "the room read was never issued");
    const a = (await r.records()).get(faceKey(ORIGIN_A, "slack"));
    assert.equal(a?.status, "unknown");
    assert.equal(a?.code, "stale-pending");
  } finally { await r.cleanup(); }
});

test("fixture 12 (ambiguous): the candidates are quarantined and never ingested, the rest of the room ingests normally", async () => {
  const c = clock("2026-09-05T12:00:00.000Z");
  const r = await rig({ clock: c, records: [{ ...staleA, payloadDigest: sha("ack") }], routes: [AUTH, ["users.info", () => ({ body: { ok: true, user: { id: "U2", real_name: "Alex" } } })],
    ["conversations.history", () => ({ body: { ok: true, has_more: false, messages: [
      { ts: "1756900050.000000", user: "U2", text: "any word?" },
      { ts: "1756900002.000000", bot_id: "B1", subtype: "bot_message", username: "claude-house", text: "ack" },
      { ts: "1756900001.000000", bot_id: "B1", subtype: "bot_message", username: "claude-house", text: "ack" }] } })]] });
  try {
    /** @type {any[]} */
    const appended = [];
    const polled = await r.runner.poll(r.face, { read: reader(r), appendForeign: async (m) => { appended.push(m); } });
    assert.equal(polled.held, false, "one permanently ambiguous face never stalls the room");
    assert.deepEqual(appended.map((m) => m.origin.source.id), ["1756900050.000000"]);
    assert.deepEqual(polled.notIngested.map((x) => x.id), ["1756900001.000000", "1756900002.000000"]);
    const a = (await r.records()).get(faceKey(ORIGIN_A, "slack"));
    assert.equal(a?.status, "unknown");
    assert.deepEqual(a?.quarantine, ["1756900001.000000", "1756900002.000000"]);
    assert.equal(polled.cursor, "1756900050.000000");
  } finally { await r.cleanup(); }
});

// ---------------------------------------------------------------------------------------------

test("fixture 13: a landing line faces Slack under the landing selector; a verdict without a sha exhibit, an exhibit without a verdict, a claim, and --no-face do not", async () => {
  const r = await rig({ face: { post: { agent: ["addressed", "landing"] } }, routes: [AUTH, ["chat.postMessage", () => ({ body: { ok: true, ts: "1756900017.000000", channel: "C0123ABC" } })]] });
  try {
    const sig = "\n\n-- Fable/agora-orchestrator";
    const A = await r.runner.face(msg({ id: ORIGIN_A, seq: 1, text: `faces landed\n\nclaim: integration:faces\nverdict: landed\nexhibit: 9f2c1a0b4d6e9f7a2b5c8d1e3f4a6b90c7d3e1f5${sig}` }));
    assert.deepEqual(A.faces, [{ transport: "slack", status: "pending" }]);
    assert.deepEqual(await A.settled, [{ transport: "slack", status: "published", id: "1756900017.000000" }]);
    assert.equal((await r.records()).get(faceKey(ORIGIN_A, "slack"))?.selector, "landing");
    assert.equal(r.posts().length, 1);
    const B = await r.runner.face(msg({ id: ORIGIN_B, seq: 2, text: `still reviewing the retry ladder\n\nverdict: holding\nexhibit: forge/output/agora-native-surface/layer1-review.md${sig}` }));
    const C = await r.runner.face(msg({ id: ORIGIN_D, seq: 3, text: `the gate output\n\nexhibit: 9f2c1a0b4d6e9f7a2b5c8d1e3f4a6b90c7d3e1f5${sig}` }));
    const D = await r.runner.face(msg({ id: ORIGIN_A.replace(/^c4/, "dd"), seq: 4, text: `claim taken\n\nclaim: work:faces${sig}` }));
    const E = await r.runner.face(msg({ id: ORIGIN_A.replace(/^c4/, "ee"), seq: 5, text: `faces landed\n\nverdict: landed\nexhibit: 9f2c1a0b4d6e9f7a2b5c8d1e3f4a6b90c7d3e1f5${sig}` }), { face: "none" });
    for (const row of [B, C, D, E]) { assert.deepEqual(row.faces, []); await row.settled; }
    assert.equal(r.posts().length, 1);
    // turning it off per room, by command
    const policy = await readFacePolicy(r.dir, ROOM);
    const { selected } = selectFaces({ ...policy, faces: [{ ...policy.faces[0], post: { ...policy.faces[0].post, agent: ["addressed"] } }] }, msg({ text: `faces landed\n\nverdict: landed\nexhibit: 9f2c1a0b4d6e9f7a2b5c8d1e3f4a6b90c7d3e1f5${sig}` }), { memberKind: () => undefined, lookupCursor: () => undefined });
    assert.deepEqual(selected, []);
  } finally { await r.cleanup(); }
});
