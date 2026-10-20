// @ts-check
// The plain helpers behind plugins/claude/agora-room: configuration precedence, the CLI's output,
// the delivery queue (cursor and dedup), post arguments, subjects and the pane tree. The last
// tests run the real CLI against a local room to check what the plugin relies on it for.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  ACTIVITY_FILE, ACTIVITY_HEARTBEAT_MS, ActivityTracker, DeliveryQueue, SEEN_FILE, SEEN_KEEP, SeenLog, TO_NOBODY, activityPath, ago, bodyText, buildSubjects, chooseRoom, childEnvFor, clip, deliveryText, formatLine, isStopReason, normaliseMessage,
  paneSessionKey, paneTree, parseCommand, parseList, parseReadOutput, parseSwitch, parseWatchOutput, preambleText, presenceLine,
  postArgs, receiptText, resolveConfig, seenPath, seenRecord, statusLine, subjectTitle, targetChip, whoRows, MAX_POST_CHARS,
} from "../plugins/claude/agora-room/hooks/lib.js";
import { tmp } from "./helpers.mjs";

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "agora.mjs");
const run = promisify(execFile);

/** @param {Partial<import('../plugins/claude/agora-room/hooks/lib.js').Msg>} p @returns {import('../plugins/claude/agora-room/hooks/lib.js').Msg} */
const msg = (p) => ({ room: "lab", id: "m1", thread: null, from: "Grace", text: "hello", cursor: "1", ts: "2026-10-20T10:00:00.000Z", to: [], title: null, signedAs: "Grace", ...p });

// ---- configuration ----

test("config precedence: environment, then the project file, then userConfig, then the defaults", () => {
  const d = resolveConfig({ sessionId: "0123456789abcdef" });
  assert.deepEqual(d.rooms, []);
  assert.equal(d.session, "claude-01234567");
  assert.equal(d.wake, "addressed");
  assert.equal(d.intervalMs, 2000);
  assert.deepEqual(d.command, ["agora"]);
  assert.equal(d.watchEnabled, true);

  const options = { rooms: "opt-room", session: "opt-key", wake: "all", interval_ms: 3000, agora_command: "/opt/agora", actor: "Opt/x", pane_as: "Opt Human" };
  const o = resolveConfig({ options, sessionId: "abc" });
  assert.deepEqual([o.rooms, o.session, o.wake, o.intervalMs, o.command, o.actor, o.paneAs], [["opt-room"], "opt-key", "all", 3000, ["/opt/agora"], "Opt/x", "Opt Human"]);

  const file = { rooms: ["file-a", "file-b"], session: "file-key", wake: "mine", intervalMs: 4000, command: ["node", "/x/agora.mjs"], actor: "File/x", env: { AGORA_CONFIG: "/c.json", N: 3 } };
  const f = resolveConfig({ file, options, sessionId: "abc" });
  assert.deepEqual([f.rooms, f.session, f.wake, f.intervalMs, f.command, f.actor], [["file-a", "file-b"], "file-key", "mine", 4000, ["node", "/x/agora.mjs"], "File/x"]);
  assert.deepEqual(f.childEnv, { AGORA_CONFIG: "/c.json" }, "only string values pass into the child environment");

  const env = { AGORA_ROOM: "env-room, env-two", AGORA_SESSION: "env-key", AGORA_ROOM_WAKE: "all", AGORA_ROOM_INTERVAL_MS: "1000", AGORA_ROOM_CMD: '["node","/e/agora.mjs"]', AGORA_ACTOR: "Env/x", AGORA_ROOM_WATCH: "off" };
  const e = resolveConfig({ env, file, options, sessionId: "abc" });
  assert.deepEqual([e.rooms, e.session, e.wake, e.intervalMs, e.command, e.actor, e.watchEnabled], [["env-room", "env-two"], "env-key", "all", 1000, ["node", "/e/agora.mjs"], "Env/x", false]);
});

test("config: an empty value does not shadow a lower layer; bad values fall back and say so", () => {
  const c = resolveConfig({ env: { AGORA_ROOM: "  ", AGORA_ROOM_WAKE: "" }, file: { rooms: "lab", wake: "all" }, sessionId: "s" });
  assert.deepEqual(c.rooms, ["lab"]);
  assert.equal(c.wake, "all");

  const bad = resolveConfig({ env: { AGORA_ROOM: "lab,-x", AGORA_SESSION: "../up", AGORA_ROOM_WAKE: "loud", AGORA_ROOM_INTERVAL_MS: "10" }, sessionId: "abcdefghij" });
  assert.deepEqual(bad.rooms, ["lab"], "a room alias that starts with a dash is refused");
  assert.equal(bad.session, "claude-abcdefgh");
  assert.equal(bad.wake, "addressed");
  assert.equal(bad.intervalMs, 500, "the interval is clamped");
  assert.equal(bad.problems.length, 3);
  assert.equal(resolveConfig({ env: { AGORA_ROOM_INTERVAL_MS: "x" } }).intervalMs, 2000);
});

test("watch switch: off disables only the watch; the rest of the configuration is untouched", () => {
  for (const v of ["off", "OFF", "0", "false", "no"]) assert.equal(resolveConfig({ env: { AGORA_ROOM_WATCH: v, AGORA_ROOM: "lab" } }).watchEnabled, false, v);
  for (const v of ["on", "1", "true", undefined, "maybe"]) assert.equal(resolveConfig({ env: { AGORA_ROOM_WATCH: v } }).watchEnabled, true, String(v));
  const c = resolveConfig({ env: { AGORA_ROOM_WATCH: "off", AGORA_ROOM: "lab", AGORA_SESSION: "k" } });
  assert.deepEqual([c.rooms, c.session], [["lab"], "k"]);
  assert.equal(parseSwitch(false), false);
});

test("preamble switch: on by default; environment, then the project file, then userConfig can turn it off; an unrecognised value leaves it on", () => {
  assert.equal(resolveConfig({}).preamble, true);
  assert.equal(resolveConfig({ options: { preamble: "off" } }).preamble, false);
  assert.equal(resolveConfig({ file: { preamble: false }, options: { preamble: "on" } }).preamble, false, "the file outranks the form");
  assert.equal(resolveConfig({ env: { AGORA_ROOM_PREAMBLE: "on" }, file: { preamble: false } }).preamble, true, "the environment outranks the file");
  assert.equal(resolveConfig({ env: { AGORA_ROOM_PREAMBLE: "off" } }).preamble, false);
  assert.equal(resolveConfig({ env: { AGORA_ROOM_PREAMBLE: "maybe" } }).preamble, true);
  assert.equal(resolveConfig({ env: { AGORA_ROOM_PREAMBLE: "off", AGORA_ROOM_WATCH: "on" } }).watchEnabled, true, "independent of the watch switch");
});

test("parse helpers: lists, commands", () => {
  assert.deepEqual(parseList("a, b  c,a"), ["a", "b", "c"]);
  assert.deepEqual(parseList(["x", " y ", ""]), ["x", "y"]);
  assert.deepEqual(parseList(undefined), []);
  assert.deepEqual(parseCommand('["node","a b/agora.mjs"]'), ["node", "a b/agora.mjs"]);
  assert.deepEqual(parseCommand("C:/tools/agora.cmd"), ["C:/tools/agora.cmd"]);
  assert.deepEqual(parseCommand("[not json"), ["[not json"]);
  assert.equal(parseCommand([]), undefined);
});

test("child environment: the watch and the tool share a session key, the pane has its own", () => {
  const cfg = { session: "k", actor: "Model/role", childEnv: { AGORA_CONFIG: "/c.json" } };
  assert.deepEqual(childEnvFor(cfg), { AGORA_CONFIG: "/c.json", AGORA_SESSION: "k", AGORA_ACTOR: "Model/role" });
  assert.deepEqual(childEnvFor(cfg, { pane: true, as: "Human" }), { AGORA_CONFIG: "/c.json", AGORA_SESSION: "k-pane", AGORA_ACTOR: "Human" });
  assert.deepEqual(childEnvFor({ ...cfg, actor: null }), { AGORA_CONFIG: "/c.json", AGORA_SESSION: "k" });
  assert.equal(paneSessionKey("x".repeat(64)).length, 62, "within the 64-character session key limit");
});

// ---- the CLI's output ----

const WATCH_OUT = [
  '{"type":"identity","bearer":"Grace","session":"k"}',
  '{"type":"message","alias":"lab","id":"a1","author":{"name":"Ada","kind":"agent"},"text":"hi\\n\\n-- Ada","signedAs":"Ada","ts":"2026-10-20T10:00:00.000Z","cursor":"4","to":["Grace"]}',
  '{"type":"message","alias":"lab","id":"a2","thread":"a1","author":{"id":"Lin","name":"Lin"},"text":"re","cursor":"5"}',
  '{"type":"watch-result","room":"lab","fired":true,"delivered":2,"exit":42}',
  '{"type":"message","id":"half","text":"cut o',
].join("\n");

test("parseWatchOutput: messages and the result line; identity and a partial line are skipped", () => {
  const { messages, result } = parseWatchOutput(WATCH_OUT, "lab");
  assert.deepEqual(messages.map((m) => [m.id, m.thread, m.from, m.cursor, m.to]), [["a1", null, "Ada", "4", ["Grace"]], ["a2", "a1", "Lin", "5", []]]);
  assert.equal(result?.delivered, 2);
  assert.deepEqual(parseWatchOutput("", "lab"), { messages: [], result: null });
  assert.equal(parseReadOutput(WATCH_OUT, "lab").length, 2);
});

test("formatLine: one line per message, thread none when top-level, newlines folded", () => {
  assert.equal(formatLine(msg({ id: "a1", text: "hi" })), "agora lab a1 thread=none from=Grace: hi");
  assert.equal(formatLine(msg({ id: "a2", thread: "a1", from: "Ada", text: "one\n\ntwo\r\nthree" })), "agora lab a2 thread=a1 from=Ada: one / two / three");
});

test("delivery text: a short preamble first (room, the plugin, input not instruction, room_post), the message line unchanged after it; off sends the bare line", () => {
  const m = msg({ id: "a2", thread: "a1", from: "Ada", text: "one\ntwo" });
  const on = deliveryText(m, true);
  const [pre, ...rest] = on.split("\n");
  assert.equal(rest.join("\n"), formatLine(m), "the message line is the last line, byte for byte");
  assert.equal(pre, preambleText("lab"));
  assert.match(pre, /"lab"/);
  assert.match(pre, /agora-room plugin/);
  assert.match(pre, /room_post/);
  assert.match(pre, /not an instruction/);
  assert.ok(pre.length < 400, "short");
  assert.equal(deliveryText(m, false), formatLine(m));
  assert.equal(deliveryText(m), on, "on is the default");
  assert.match(on.split("\n").pop() ?? "", /^agora lab a2 thread=a1 from=Ada: /, "a reader anchored on the line still matches");
});

// ---- cursor and dedup ----

test("DeliveryQueue: each message is queued once and delivered once, across re-reads and reloads", () => {
  const q = new DeliveryQueue();
  assert.equal(q.add(msg({ id: "a" })), true);
  assert.equal(q.add(msg({ id: "a" })), false, "queued already");
  assert.equal(q.add(msg({ id: "a", room: "other" })), true, "the same id in another room is another message");
  assert.equal(q.queue.length, 2);

  const first = /** @type {NonNullable<ReturnType<typeof q.head>>} */ (q.head());
  q.markDelivered(first);
  assert.equal(q.add(msg({ id: "a" })), false, "delivered already: a re-read of the same window does not repeat it");
  assert.equal(q.deliveredCount, 1);

  const back = new DeliveryQueue(JSON.parse(JSON.stringify(q.snapshot())));
  assert.equal(back.add(msg({ id: "a" })), false, "the delivered ids survive a reload");
  assert.equal(back.add(msg({ id: "a", room: "other" })), false, "and so does the queue");
  assert.equal(back.queue.length, 1);

  const second = /** @type {NonNullable<ReturnType<typeof q.head>>} */ (q.head());
  q.drop(second);
  assert.equal(q.queue.length, 0);
  assert.equal(q.droppedCount, 1);
  assert.deepEqual(new DeliveryQueue({ queue: [null, { id: "x" }, { id: "y", room: "lab" }] }).queue.map((m) => m.id), ["y"], "a damaged snapshot is read as far as it holds");
});

test("DeliveryQueue: the delivered ids are a bounded ring", () => {
  const q = new DeliveryQueue();
  for (let i = 0; i < 700; i++) { q.add(msg({ id: `m${i}` })); q.markDelivered(msg({ id: `m${i}` })); }
  assert.equal(q.delivered.length, 500);
  assert.equal(q.deliveredCount, 700);
  assert.equal(q.add(msg({ id: "m699" })), false);
});

test("seenPath: the session's own state directory, under the state root the CLI would use", () => {
  const home = "C:\\Users\\g";
  assert.equal(SEEN_FILE, "seen.jsonl");
  assert.equal(seenPath({ home, session: "k" }), "C:/Users/g/.agora/state/sessions/k/seen.jsonl", "the default root, with forward slashes");
  assert.equal(seenPath({ env: { AGORA_STATE: "/s/state/" }, home, session: "k" }), "/s/state/sessions/k/seen.jsonl");
  assert.equal(seenPath({ env: { AGORA_STATE: "~/st" }, home, session: "k" }), "C:/Users/g/st/sessions/k/seen.jsonl");
  assert.equal(seenPath({ env: { AGORA_STATE: "/a" }, childEnv: { AGORA_STATE: "/b" }, home, session: "k" }), "/b/sessions/k/seen.jsonl", "the project file's env is what the child sees, so it wins");
  assert.equal(seenPath({ env: { AGORA_STATE: "  " }, home, session: "k" }), "C:/Users/g/.agora/state/sessions/k/seen.jsonl", "an empty value does not shadow the default");
  assert.equal(seenPath({ home: null, session: "k" }), null, "no home and no state: nowhere to write");
  assert.equal(seenPath({ home, session: "../x" }), null, "a session key is one safe directory name");
});

test("seen record: the line a messenger reads; the log keeps the newest SEEN_KEEP, continues a file, and drops a torn line", () => {
  const rec = seenRecord({ session: "k", position: "desk.coding", room: "lab", id: "m1", cursor: "c1", readAt: "2026-10-20T10:00:00.000Z", admittedAt: "2026-10-20T10:00:00.100Z" });
  assert.deepEqual(rec, { v: 1, type: "seen", session: "k", position: "desk.coding", room: "lab", id: "m1", cursor: "c1", readAt: "2026-10-20T10:00:00.000Z", admittedAt: "2026-10-20T10:00:00.100Z" });
  const log = new SeenLog(null);
  assert.equal(log.text(), "");
  for (let i = 0; i < SEEN_KEEP + 5; i++) log.add({ ...rec, id: `m${i}` });
  const lines = log.text().trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, SEEN_KEEP);
  assert.equal(lines[0].id, "m5", "the oldest five aged out");
  assert.ok(log.text().endsWith("\n"));
  const resumed = new SeenLog(`${log.text()}{"v":1,"type":"seen","id":"torn\nnot json\n`);
  assert.equal(resumed.lines.length, SEEN_KEEP, "a torn line and a line that is not JSON are dropped");
  resumed.add({ ...rec, id: "new" });
  assert.equal(resumed.lines.length, SEEN_KEEP);
  assert.equal(JSON.parse(/** @type {string} */ (resumed.lines.at(-1))).id, "new");
});

test("activityPath: beside the seen record, in the session's own state directory", () => {
  assert.equal(ACTIVITY_FILE, "activity.json");
  assert.equal(activityPath({ home: "C:\\Users\\g", session: "k" }), "C:/Users/g/.agora/state/sessions/k/activity.json");
  assert.equal(activityPath({ env: { AGORA_STATE: "/s/" }, home: null, session: "k" }), "/s/sessions/k/activity.json");
  assert.equal(activityPath({ home: "/h", session: "../x" }), null);
  assert.equal(activityPath({ home: "/h", session: "k" })?.replace("activity.json", ""), seenPath({ home: "/h", session: "k" })?.replace("seen.jsonl", ""));
});

test("activity tracker: a turn change asks for its own write; tool calls and output only mark the record; the heartbeat makes a quiet watch due (red leg: before it)", () => {
  let now = Date.parse("2026-01-01T10:00:00.000Z");
  const tr = new ActivityTracker({ now: () => now });
  assert.equal(tr.due(), true, "a new record is due");
  const first = tr.take({ session: "k", position: null, intervalMs: 2000 });
  assert.deepEqual(first, { v: 1, type: "activity", session: "k", position: null, turn: "idle", since: "2026-01-01T10:00:00.000Z", lastToolAt: null, lastOutputAt: null, progress: 0, progressAt: null, intervalMs: 2000, updatedAt: "2026-01-01T10:00:00.000Z" });
  assert.equal(tr.due(), false);
  now += 1000;
  assert.equal(tr.turnStart(), true);
  assert.equal(tr.turnEnd(), true);
  assert.equal(tr.turnEnd(), false, "already idle");
  tr.take({ session: "k", position: null, intervalMs: 2000 });
  now += 1000;
  tr.tool();
  tr.output(false);
  assert.equal(tr.due(), true, "marked, to be written on the next tick");
  const rec = tr.take({ session: "k", position: "desk.coding", intervalMs: 2000 });
  assert.deepEqual([rec.lastToolAt, rec.lastOutputAt, rec.progress, rec.position], ["2026-01-01T10:00:02.000Z", "2026-01-01T10:00:02.000Z", 1, "desk.coding"], "a streamed chunk moves the time and does not count an entry");
  now += ACTIVITY_HEARTBEAT_MS - 1;
  assert.equal(tr.due(), false);
  now += 1;
  assert.equal(tr.due(), true);
  assert.equal(new ActivityTracker({ now: () => now, prior: "{not json" }).progress, 0, "a torn file starts from nothing");
});

test("stop reasons: the two refusals the platform words that way", () => {
  assert.equal(isStopReason("the session was stopped and nobody has sent input since"), true);
  assert.equal(isStopReason("the prompt was removed from the queue before it ran"), true);
  assert.equal(isStopReason("something else"), false);
});

// ---- the status line ----

test("status line: one entry per room, age in the right unit", () => {
  const now = Date.parse("2026-10-20T10:10:00.000Z");
  assert.equal(ago("2026-10-20T10:09:57.000Z", now), "3s");
  assert.equal(ago("2026-10-20T10:07:00.000Z", now), "3m");
  assert.equal(ago("2026-10-20T07:00:00.000Z", now), "3h");
  assert.equal(ago("2026-10-17T10:00:00.000Z", now), "3d");
  assert.equal(ago(null, now), "?");
  assert.equal(statusLine([{ room: "lab", lastRead: "2026-10-20T10:09:55.000Z", failing: false }], now), "lab · read 5s ago");
  assert.equal(statusLine([{ room: "lab", lastRead: null, failing: true }, { room: "b", lastRead: "2026-10-20T10:09:00.000Z", failing: false }], now), "lab · not read yet · last poll failed · b · read 60s ago");
});

// ---- posting ----

test("postArgs: options before the terminator, text after it, so a leading dash is text", () => {
  const p = postArgs({ room: "lab", text: "-- not an option", thread: "t1", replyTo: "m9", to: ["Ada", "*"] });
  assert.deepEqual(p, { ok: true, args: ["post", "lab", "--json", "--thread", "t1", "--re", "m9", "--to", "Ada", "--to", "*", "--", "-- not an option"] });
  assert.deepEqual(postArgs({ room: "lab", text: "x" }), { ok: true, args: ["post", "lab", "--json", "--", "x"] });
});

test("postArgs: refusals", () => {
  for (const bad of [
    { text: "" }, { text: "  \n" }, { text: "x".repeat(MAX_POST_CHARS + 1) },
    { text: "x", thread: "--json" }, { text: "x", thread: "a b" }, { text: "x", replyTo: "-x" }, { text: "x", to: ["--as"] }, { text: "x", to: ["a b"] },
  ]) assert.equal(postArgs({ room: "lab", ...bad }).ok, false, JSON.stringify(bad).slice(0, 60));
  assert.equal(postArgs({ room: "lab", text: "x".repeat(MAX_POST_CHARS) }).ok, true);
});

test("chooseRoom: only a configured room, and the sole room needs no name", () => {
  assert.deepEqual(chooseRoom(["lab"], undefined), { ok: true, room: "lab" });
  assert.deepEqual(chooseRoom(["lab"], "lab"), { ok: true, room: "lab" });
  assert.equal(chooseRoom(["lab"], "other").ok, false);
  assert.equal(chooseRoom(["a", "b"], "").ok, false);
  assert.deepEqual(chooseRoom(["a", "b"], "b"), { ok: true, room: "b" });
  assert.equal(chooseRoom([], "a").ok, false);
});

test("receiptText: the receipt line, not the banner", () => {
  assert.equal(receiptText('{"id":"x1","cursor":"7","alias":"lab"}\n'), '{"id":"x1","cursor":"7","alias":"lab"}');
  assert.equal(receiptText("posted x1  cursor 7"), "posted x1  cursor 7");
});

// ---- subjects ----

const ROOM = [
  msg({ id: "r1", text: "Plan the release\n\nwith detail\n\n-- Grace", ts: "2026-10-20T09:00:00.000Z" }),
  msg({ id: "r2", text: "Lunch?\n\n-- Ada", from: "Ada", signedAs: "Ada", ts: "2026-10-20T09:05:00.000Z" }),
  msg({ id: "r3", thread: "r1", text: "ok\n\n-- Ada", from: "Ada", signedAs: "Ada", ts: "2026-10-20T09:10:00.000Z" }),
  msg({ id: "r4", thread: "r1", text: "done\n\n-- Grace", ts: "2026-10-20T09:20:00.000Z" }),
  msg({ id: "r5", thread: "old", text: "tail of an old thread\n\n-- Lin", from: "Lin", signedAs: "Lin", ts: "2026-10-20T09:30:00.000Z" }),
];

test("subjects: threads fold into their root, newest activity first, titled by the first line", () => {
  const s = buildSubjects(ROOM);
  assert.deepEqual(s.map((x) => [x.id, x.count]), [["old", 1], ["r1", 3], ["r2", 1]]);
  assert.equal(s[1]?.title, "Plan the release");
  assert.equal(s[0]?.rootInWindow, false);
  assert.equal(s[0]?.latestId, "r5");
  assert.equal(subjectTitle(msg({ title: "Named thread", text: "ignored" })), "Named thread");
  assert.equal(subjectTitle(msg({ text: "x".repeat(200) })).length, 80);
  assert.equal(bodyText(msg({ text: "a\n\n-- Grace" })), "a");
  assert.equal(bodyText(msg({ text: "a\n\n-- Other" })), "a\n\n-- Other");
});

test("subjects: unread counts what is newer than the mark and the baseline, never the reader's own posts", () => {
  const all = buildSubjects(ROOM, { self: "Grace" });
  assert.deepEqual(all.map((x) => [x.id, x.unread]), [["old", 1], ["r1", 1], ["r2", 1]], "r4 is Grace's own; r3 and r1... r1 is hers too");
  const marked = buildSubjects(ROOM, { self: "Grace", seen: { r1: "r4", old: "r5" } });
  assert.deepEqual(marked.map((x) => [x.id, x.unread]), [["old", 0], ["r1", 0], ["r2", 1]]);
  const first = buildSubjects(ROOM, { self: "Grace", baselineId: "r4" });
  assert.deepEqual(first.map((x) => [x.id, x.unread]), [["old", 1], ["r1", 0], ["r2", 0]], "a first open marks only what came after it");
  const missing = buildSubjects(ROOM, { self: "Grace", baselineId: "gone" });
  assert.equal(missing.reduce((n, x) => n + x.unread, 0), 3, "a baseline that fell out of the window marks the window unread");
});

test("who: rows by last spoken, newest first", () => {
  const rows = whoRows([{ type: "who", name: "Ada", last: "2026-10-20T09:10:00.000Z", count: 2 }, { type: "who-horizon" }, { type: "who", name: "Lin", last: "2026-10-20T09:30:00.000Z", count: 1 }]);
  assert.deepEqual(rows.map((r) => r.name), ["Lin", "Ada"]);
});

test("bodyText: the trailer block the CLI parsed is not shown (the header says to whom); prose that merely has a colon stays", () => {
  const raw = { type: "message", id: "a1", author: { name: "Grace" }, text: "Compact it is.\n\nto: Ada\nre: a0\n\n-- Grace", signedAs: "Grace", trailers: [{ key: "to", value: "Ada" }, { key: "re", value: "a0" }], to: ["Ada"] };
  const m = /** @type {any} */ (normaliseMessage(raw, "lab"));
  assert.equal(bodyText(m), "Compact it is.");
  assert.deepEqual(m.to, ["Ada"]);
  assert.equal(formatLine(m), "agora lab a1 thread=none from=Grace: Compact it is. / to: Ada / re: a0 / -- Grace", "the delivered line keeps the whole text");
  assert.equal(bodyText(msg({ text: "Note:\n\nnext: step one\n\n-- Grace" })), "Note:\n\nnext: step one", "no trailers parsed: nothing is cut");
  assert.equal(bodyText({ ...msg({ text: "Only:\n\nnext: one\nbut: more prose\n\n-- Grace" }), trailers: [{ key: "next", value: "one" }] }), "Only:\n\nnext: one\nbut: more prose", "a block of a different size is not the parsed one");
  assert.equal("trailers" in /** @type {any} */ (normaliseMessage({ type: "message", id: "b", text: "x" }, "lab")), false, "no field when the CLI parsed none");
});

// ---- the pane ----

/** Stand-ins for the elements `$.ui.resolve(e)` returns: each records its props. */
const fakeEls = (/** @type {string[]} */ without = []) => {
  /** @type {Record<string, any>} */
  const els = {};
  for (const n of ["Box", "Text", "Button", "Input", "Select", "Markdown"]) if (!without.includes(n)) els[n] = (/** @type {any} */ props) => ({ el: n, ...props });
  return els;
};
/** @param {any} node @param {any[]} acc */
const walk = (node, acc = []) => { if (node && typeof node === "object") { acc.push(node); for (const c of node.children ?? []) walk(c, acc); } return acc; };
const noop = () => {};
const acts = { open: noop, back: noop, newSubject: noop, setTo: noop, setRoom: noop, refresh: noop, submit: noop, toggleWho: noop, more: noop, showEarlier: noop };
const baseModel = () => ({
  rooms: ["lab"], room: "lab", loading: false, error: null, subjects: buildSubjects(ROOM, { self: "Grace" }), thread: /** @type {string | null} */ (null),
  who: whoRows([{ type: "who", name: "Ada", last: "2026-10-20T09:10:00.000Z", count: 2 }]), to: TO_NOBODY, now: Date.parse("2026-10-20T09:40:00.000Z"),
  self: "Grace", columns: 40, limit: 20, whoOpen: false, selected: /** @type {string | null} */ (null), earlier: false,
});
/** The words of a node: its string children, and those of the inline Text nested in it. @param {any} n @returns {string} */
const flat = (n) => (typeof n === "string" ? n : (n.children ?? []).map(flat).join(""));
/** @param {any[]} nodes */
const textsOf = (nodes) => nodes.filter((n) => n.el === "Text").map((n) => n.children[0]);
/** @param {any[]} nodes */
const flatTexts = (nodes) => nodes.filter((n) => n.el === "Text").map(flat);

test("pane: subjects scan as a title line and a meta line, with a visible unread mark and no row hotkeys", () => {
  const nodes = walk(paneTree(fakeEls(), baseModel(), acts), []);
  const rows = nodes.filter((n) => n.el === "Button" && String(n.key).startsWith("subject-"));
  assert.deepEqual(rows.map((n) => n.label), ["tail of an old thread", "Plan the release", "Lunch?"]);
  assert.ok(rows.every((n) => n.hotkey === undefined), "numbers on the first nine rows only was noise");
  assert.ok(rows.every((n) => n.children === undefined), "the terminal's Button wraps its children, so its title is the label");
  const desktop = walk(paneTree(fakeEls(), { ...baseModel(), surface: "desktop" }, acts), []).filter((n) => n.el === "Button" && String(n.key).startsWith("subject-"));
  assert.deepEqual(desktop.map((n) => n.label), ["tail of an old thread", "Plan the release", "Lunch?"]);
  assert.ok(desktop.every((n) => n.children[0].wrap === "truncate-end" && n.children[0].children[0] === n.label && n.children[0].weight === "semibold"), "on the desktop the title is cut by the surface at the real width, heavier when unread");
  const texts = flatTexts(nodes);
  assert.ok(texts.includes("1 new · Lin · 1 reply · 10m"), "the new count and the meta read as one line, with no stray separator");
  assert.ok(texts.includes("1 new · Grace · 2 replies · 20m"));
  assert.ok(texts.includes("1 new · Ada · 35m"), "no replies: no reply count");
  assert.equal(nodes.filter((n) => n.el === "Text" && n.children[0] === "●" && n.color === "suggestion").length, 3, "each unread subject carries a dot in the theme's accent");
  assert.equal(texts.filter((t) => t.startsWith("1 new · ")).length, 3);
  assert.ok(texts.includes("3 of 3 · 3 with new"));
  const meta = nodes.find((n) => n.el === "Text" && flat(n) === "1 new · Lin · 1 reply · 10m");
  assert.deepEqual([meta.size, meta.color, meta.tabular, meta.wrap], ["caption", "inactive", true, "truncate-end"]);
});

test("pane: every row has a mark column of one width, a hover, and a key of its own", () => {
  const nodes = walk(paneTree(fakeEls(), { ...baseModel(), selected: "r1" }, acts), []);
  const rows = nodes.filter((n) => n.el === "Box" && String(n.key).startsWith("row-"));
  assert.equal(rows.length, 3);
  assert.ok(rows.every((n) => n.hover.backgroundColor === "userMessageBackground" && n.children[0].width === 2 && n.children[0].flexShrink === 0));
});

test("pane: a read subject has no dot, the one last opened is marked, a long title is cut to the terminal's columns and left whole for the desktop", () => {
  const long = "A subject with a rather long title indeed";
  const m = { ...baseModel(), subjects: buildSubjects([...ROOM, msg({ id: "r6", text: `${long}\n\n-- Lin`, from: "Lin", signedAs: "Lin", ts: "2026-10-20T09:35:00.000Z" })], { self: "Grace", seen: { r1: "r4", old: "r5", r2: "r2", r6: "r6" } }), selected: "r1", columns: 30 };
  const nodes = walk(paneTree(fakeEls(), m, acts), []);
  assert.equal(nodes.filter((n) => n.el === "Text" && n.children[0] === "●").length, 0);
  assert.equal(nodes.filter((n) => n.el === "Text" && n.children[0] === "▸").length, 1);
  const cut = nodes.find((n) => n.key === "subject-r6").label;
  assert.equal(cut.length, 24, "the columns left once the row's padding, mark and gap are taken");
  assert.ok(cut.endsWith("…"));
  assert.equal(walk(paneTree(fakeEls(), { ...m, surface: "desktop" }, acts), []).find((n) => n.key === "subject-r6").label, long, "the title is whole in the desktop tree");
  assert.ok(nodes.every((n) => n.el !== "Text" || !/^\d+ new/.test(flat(n))), "nothing is new");
});

test("pane: the target is stated once, as a chip beside the selector and the field; the header is the room and a small refresh", () => {
  const nodes = walk(paneTree(fakeEls(), baseModel(), acts), []);
  const texts = textsOf(nodes);
  assert.ok(texts.includes("Posting to lab › new subject"));
  assert.equal(texts.filter((t) => /^Posting to /.test(t)).length, 1, "stated once");
  assert.equal(texts.filter((t) => /to:|Post →/.test(t)).length, 0, "no second sentence restating it");
  assert.equal(nodes.filter((n) => n.el === "Input").length, 1);
  const select = nodes.find((n) => n.el === "Select");
  assert.deepEqual(select.options.map((/** @type {any} */ o) => [o.value, o.label]), [[TO_NOBODY, "the room"], ["*", "everyone (*)"], ["Ada", "Ada"]]);
  assert.equal(select.label, undefined, "the pane draws the field labels itself, in one column");
  assert.equal(nodes.find((n) => n.el === "Input").label, undefined);
  const refresh = nodes.find((n) => n.key === "refresh");
  assert.deepEqual([refresh.label, refresh.hotkey, refresh.dimColor], ["refresh", "r", true]);
  const room = nodes.find((n) => n.el === "Text" && n.children[0] === "lab");
  assert.deepEqual([room.size, room.weight, room.wrap], ["heading", "semibold", "truncate-end"]);
  const card = nodes.find((n) => n.borderStyle === "round");
  assert.deepEqual([card.flexDirection, card.borderColor], ["column", "promptBorder"], "the compose controls share one card");
  const labelBoxes = nodes.filter((n) => n.el === "Box" && n.width === 8).map((n) => n.children[0]);
  assert.deepEqual(labelBoxes.map((t) => [t.children[0], t.size, t.weight]), [["to", "footnote", "medium"], ["message", "footnote", "medium"]], "to and message start their fields at one edge");
  assert.equal(nodes.filter((n) => n.el === "Text" && /^─+$/.test(n.children[0])).length, 1, "one rule, between the header and the compose card");
});

test("pane: presence is one line with a count; pressing it lists everyone", () => {
  const who = whoRows([
    { type: "who", name: "Ada", last: "2026-10-20T09:10:00.000Z", count: 2 },
    { type: "who", name: "Lin", last: "2026-10-20T09:30:00.000Z", count: 1 },
  ]);
  const closed = walk(paneTree(fakeEls(), { ...baseModel(), who }, acts), []);
  assert.equal(closed.find((n) => n.key === "who").label, "▸ 2 active · Lin, Ada");
  assert.ok(!textsOf(closed).some((t) => /last \d+m ago/.test(t)));
  const open = walk(paneTree(fakeEls(), { ...baseModel(), who, whoOpen: true }, acts), []);
  assert.equal(open.find((n) => n.key === "who").label, "▾ 2 active · Lin, Ada");
  assert.deepEqual(textsOf(open).filter((t) => /last \d+m ago/.test(t)), ["Lin · 1 message · last 10m ago", "Ada · 2 messages · last 30m ago"]);
  /** @type {string[]} */
  const log = [];
  walk(paneTree(fakeEls(), { ...baseModel(), who }, { ...acts, toggleWho: () => log.push("who") }), []).find((n) => n.key === "who").onPress();
  assert.deepEqual(log, ["who"]);
  assert.ok(textsOf(walk(paneTree(fakeEls(), { ...baseModel(), who: [], loading: true }, acts), [])).includes("who is here: …"));
});

test("presenceLine: whole names, newest first, then how many more; never a name cut in the middle", () => {
  const who = ["Lin", "Ada", "Zed", "review/Alpha", "coding/Beta", "Kit", "Mae", "Ola"].map((name) => ({ name, last: null, count: 1 }));
  assert.equal(presenceLine(who, false, 39), "▸ 8 active · Lin, Ada, Zed +5");
  assert.equal(presenceLine(who, true, 39), "▾ 8 active · Lin, Ada, Zed +5");
  assert.equal(presenceLine(who, false, 200), "▸ 8 active · Lin, Ada, Zed, review/Alpha, coding/Beta, Kit, Mae, Ola");
  assert.equal(presenceLine(who, false, 10), "▸ 8 active", "no name fits: the count alone");
  assert.equal(presenceLine(who.slice(0, 1), false, 39), "▸ 1 active · Lin");
});

test("pane: only the most recent subjects are listed; a button shows more", () => {
  const many = Array.from({ length: 25 }, (_, i) => msg({ id: `x${i}`, text: `Subject ${i}\n\n-- Ada`, from: "Ada", signedAs: "Ada", ts: "2026-10-20T09:00:00.000Z" }));
  const subjects = buildSubjects(many, { self: "Grace" });
  /** @type {string[]} */
  const log = [];
  const nodes = walk(paneTree(fakeEls(), { ...baseModel(), subjects }, { ...acts, more: () => log.push("more") }), []);
  assert.equal(nodes.filter((n) => String(n.key).startsWith("subject-")).length, 20);
  assert.equal(nodes.find((n) => n.key === "subject-x24").label, "Subject 24", "newest first");
  const more = nodes.find((n) => n.key === "more");
  assert.equal(more.label, "show 5 more (5 older)");
  more.onPress();
  assert.deepEqual(log, ["more"]);
  const all = walk(paneTree(fakeEls(), { ...baseModel(), subjects, limit: 40 }, acts), []);
  assert.equal(all.filter((n) => String(n.key).startsWith("subject-")).length, 25);
  assert.equal(all.some((n) => n.key === "more"), false);
});

test("pane: a thread reads as a conversation: author, age, markdown body, your own posts marked; a way back; the chip names it", () => {
  const m = { ...baseModel(), thread: "r1", to: "Ada" };
  const nodes = walk(paneTree(fakeEls(), m, acts), []);
  const texts = textsOf(nodes);
  assert.ok(texts.includes("Posting to lab › Plan the release"), "the target names the thread; whom it is for is the selector's value");
  assert.equal(nodes.find((n) => n.el === "Select").value, "Ada");
  assert.ok(texts.includes("3 messages · started by Grace"));
  const bodies = nodes.filter((n) => n.el === "Markdown").map((n) => n.text);
  assert.ok(bodies.includes("Plan the release\n\nwith detail"), "bodies lose the signature line and are drawn as markdown, so code and links render");
  assert.equal(nodes.filter((n) => n.el === "Markdown").length, 3);
  const grace = nodes.filter((n) => n.el === "Text" && n.children[0] === "Grace" && n.weight === "semibold");
  assert.equal(grace.length, 2);
  assert.ok(grace.every((n) => n.color === "suggestion"), "own posts are in the theme's accent");
  const ada = nodes.find((n) => n.el === "Text" && n.children[0] === "Ada" && n.weight === "semibold");
  assert.equal(ada.color, undefined);
  assert.equal(texts.filter((t) => t === "you").length, 2);
  const age = nodes.find((n) => n.el === "Text" && n.children[0] === "40m");
  assert.deepEqual([age.size, age.tabular], ["caption", true], "age");
  assert.ok(nodes.some((n) => n.key === "back" && n.hotkey === "b"));
  assert.ok(nodes.some((n) => n.key === "new-subject"));
  assert.equal(nodes.some((n) => n.key === "who"), false, "the thread view has no presence line");
  assert.equal(nodes.filter((n) => n.el === "Text" && /Plan the release$/.test(n.children[0])).length, 1, "the title is stated once, in the target (the thread's first message carries it in full below)");
  assert.equal(targetChip({ ...m, to: "*" }), "lab › Plan the release");
  assert.equal(targetChip({ ...m, to: "*" }, { withTo: true }), "lab › Plan the release · to: everyone (*)");
  const plain = walk(paneTree(fakeEls(["Markdown"]), m, acts), []);
  assert.ok(textsOf(plain).includes("Plan the release\n\nwith detail"), "a surface without Markdown gets the same body as wrapped text");
  const dirty = walk(paneTree(fakeEls(), { ...m, subjects: buildSubjects([msg({ id: "z", text: "a\u0007b\r\nc\td\n\n-- Grace" })], { self: "Grace" }), thread: "z" }, acts), []);
  assert.deepEqual(dirty.filter((n) => n.el === "Markdown").map((n) => n.text), ["ab\nc\td"], "markdown takes tab and newline as its only control characters");
});

test("pane: a long thread shows its last messages and a way to the earlier ones; addressed posts show to whom", () => {
  const msgs = Array.from({ length: 14 }, (_, i) => msg({ id: i === 0 ? "t0" : `t${i}`, thread: i === 0 ? null : "t0", text: `${i === 0 ? "Topic" : `line ${i}`}\n\n-- Lin`, from: "Lin", signedAs: "Lin", ts: "2026-10-20T09:00:00.000Z", to: i === 13 ? ["Ada", "Grace"] : [] }));
  const subjects = buildSubjects(msgs, { self: "Grace" });
  /** @type {string[]} */
  const log = [];
  const nodes = walk(paneTree(fakeEls(["Markdown"]), { ...baseModel(), subjects, thread: "t0" }, { ...acts, showEarlier: () => log.push("earlier") }), []);
  const bodies = textsOf(nodes).filter((t) => /^line \d+$/.test(t));
  assert.equal(bodies.length, 12);
  assert.equal(bodies[0], "line 2");
  assert.ok(flatTexts(nodes).includes("40m · to Ada, Grace"));
  const earlier = nodes.find((n) => n.key === "earlier");
  assert.equal(earlier.label, "show 2 earlier");
  earlier.onPress();
  assert.deepEqual(log, ["earlier"]);
  const full = walk(paneTree(fakeEls(["Markdown"]), { ...baseModel(), subjects, thread: "t0", earlier: true }, acts), []);
  assert.equal(textsOf(full).filter((t) => /^line \d+$/.test(t)).length, 13);
  assert.equal(full.some((n) => n.key === "earlier"), false);
});

test("pane: callbacks reach the actions", () => {
  /** @type {string[]} */
  const log = [];
  const a = { ...acts, open: (/** @type {string} */ id) => log.push(`open ${id}`), submit: (/** @type {string} */ t) => log.push(`submit ${t}`), setTo: (/** @type {string} */ v) => log.push(`to ${v}`), refresh: () => log.push("refresh") };
  const nodes = walk(paneTree(fakeEls(), baseModel(), a), []);
  nodes.find((n) => n.key === "subject-r2").onPress();
  nodes.find((n) => n.el === "Input").onSubmit("hi");
  nodes.find((n) => n.el === "Select").onSelect("Ada");
  nodes.find((n) => n.key === "refresh").onPress();
  assert.deepEqual(log, ["open r2", "submit hi", "to Ada", "refresh"]);
  /** @type {string[]} */
  const t = [];
  const th = walk(paneTree(fakeEls(), { ...baseModel(), thread: "r1" }, { ...acts, back: () => t.push("back"), newSubject: () => t.push("new") }), []);
  th.find((n) => n.key === "back").onPress();
  th.find((n) => n.key === "new-subject").onPress();
  assert.deepEqual(t, ["back", "new"]);
});

test("pane: a surface without Input or Select gets the pane without them and is told so, and the chip then carries to:; without the base elements, nothing", () => {
  const nodes = walk(paneTree(fakeEls(["Input", "Select"]), { ...baseModel(), to: "*" }, acts), []);
  assert.equal(nodes.filter((n) => n.el === "Input" || n.el === "Select").length, 0);
  const texts = textsOf(nodes);
  assert.ok(texts.some((t) => /no text field/.test(t)));
  assert.ok(texts.some((t) => /no selector/.test(t)));
  assert.ok(texts.includes("Posting to lab › new subject · to: everyone (*)"));
  assert.equal(paneTree(fakeEls(["Button"]), baseModel(), acts), null);
});

test("pane: several rooms get room buttons, one room a title; an error is shown; the width default holds when the surface does not say", () => {
  const multi = walk(paneTree(fakeEls(), { ...baseModel(), rooms: ["lab", "desk"], error: "agora read exit 1", columns: null }, acts), []);
  assert.deepEqual(multi.filter((n) => String(n.key).startsWith("room-")).map((n) => n.label), ["[lab]", "desk"]);
  assert.ok(multi.some((n) => n.el === "Text" && n.color === "error" && n.children[0] === "agora read exit 1"));
  assert.equal(clip("a  b\nc", 10), "a b c");
  assert.equal(clip("abcdef", 4), "abc…");
});

// ---- the CLI, for the parts the plugin leaves to it ----

/** A temp config with one local room; every call runs as its own agora session. */
async function harness() {
  const { dir, cleanup } = await tmp();
  const config = path.join(dir, "config.json");
  await writeFile(config, JSON.stringify({ actor: { name: "Grace", kind: "agent" }, sign: true, state: path.join(dir, "state"), rooms: { lab: { transport: "local", path: path.join(dir, "lab.ndjson") } } }));
  /** @param {string} session @param {string[]} args @param {string} [actor] */
  const agora = async (session, args, actor) => {
    const env = { ...process.env, AGORA_CONFIG: config, AGORA_STATE: path.join(dir, "state"), AGORA_SESSION: session, ...(actor ? { AGORA_ACTOR: actor } : {}) };
    try {
      const r = await run(process.execPath, [bin, ...args], { env });
      return { code: 0, stdout: r.stdout, stderr: r.stderr };
    } catch (err) {
      const e = /** @type {any} */ (err);
      return { code: e.code, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") };
    }
  };
  return { agora, cleanup };
}

test("cli: a session with no saved cursor starts at the head; a saved one resumes; watch skips its own posts", async () => {
  const h = await harness();
  try {
    await h.agora("other", ["post", "lab", "--json", "--", "old news"]);
    const shown = await h.agora("watcher", ["cursor", "lab", "--json"]);
    assert.equal(JSON.parse(shown.stdout.trim().split("\n").pop() ?? "{}").cursor, null, "no saved cursor");
    const head = await h.agora("watcher", ["cursor", "lab", "--now", "--json"]);
    assert.notEqual(JSON.parse(head.stdout.trim().split("\n").pop() ?? "{}").cursor, null);

    const quiet = await h.agora("watcher", ["watch", "lab", "--once", "--json"]);
    assert.equal(quiet.code, 0, "history is not replayed");
    assert.equal(parseWatchOutput(quiet.stdout, "lab").messages.length, 0);

    await h.agora("other", ["post", "lab", "--json", "--", "-- a message that starts with dashes"]);
    await h.agora("watcher", ["post", "lab", "--json", "--", "my own post"]);
    const got = await h.agora("watcher", ["watch", "lab", "--once", "--json"]);
    assert.equal(got.code, 42);
    const { messages, result } = parseWatchOutput(got.stdout, "lab");
    assert.deepEqual(messages.map((m) => bodyText(m)), ["-- a message that starts with dashes"], "its own post is skipped; dashes are text");
    assert.equal(result?.skipped, 1);

    const again = await h.agora("watcher", ["watch", "lab", "--once", "--json"]);
    assert.equal(again.code, 0, "the CLI advanced its cursor, so nothing comes twice");
  } finally { await h.cleanup(); }
});

test("cli: the wake option is the filter; filtered messages still advance the cursor", async () => {
  const h = await harness();
  try {
    await h.agora("watcher", ["cursor", "lab", "--now", "--json"]);
    await h.agora("other", ["post", "lab", "--json", "--to", "Ada", "--", "for Ada"], "Bea");
    await h.agora("other", ["post", "lab", "--json", "--to", "Grace", "--", "for Grace"], "Bea");
    await h.agora("other", ["post", "lab", "--json", "--", "for the room"], "Bea");
    const addressed = await h.agora("watcher", ["watch", "lab", "--once", "--json", "--wake", "addressed"]);
    assert.deepEqual(parseWatchOutput(addressed.stdout, "lab").messages.map((m) => bodyText(m).split("\n")[0]), ["for Grace", "for the room"], "everything except what is addressed to someone else");
    assert.equal(parseWatchOutput(addressed.stdout, "lab").result?.filtered, 1);

    await h.agora("other", ["post", "lab", "--json", "--to", "Ada", "--", "again for Ada"], "Bea");
    await h.agora("other", ["post", "lab", "--json", "--to", "Grace", "--", "again for Grace"], "Bea");
    await h.agora("other", ["post", "lab", "--json", "--", "again for the room"], "Bea");
    const mine = await h.agora("watcher", ["watch", "lab", "--once", "--json", "--wake", "mine"]);
    assert.deepEqual(parseWatchOutput(mine.stdout, "lab").messages.map((m) => bodyText(m).split("\n")[0]), ["again for Grace"], "only what is addressed to this bearer");
    const rest = await h.agora("watcher", ["watch", "lab", "--once", "--json", "--wake", "mine"]);
    assert.equal(rest.code, 0, "the filtered messages advanced the cursor");
  } finally { await h.cleanup(); }
});

test("cli: a post built by postArgs lands in its thread, addressed, signed as the bearer", async () => {
  const h = await harness();
  try {
    const root = await h.agora("other", ["post", "lab", "--json", "--", "root"]);
    const rootId = JSON.parse(root.stdout.trim().split("\n").pop() ?? "{}").id;
    const built = postArgs({ room: "lab", text: "an answer", thread: rootId, to: ["Ada"] });
    assert.ok(built.ok);
    if (!built.ok) return;
    const posted = await h.agora("tool-session", built.args, "Bea/role");
    assert.equal(posted.code, 0, posted.stderr);
    assert.match(receiptText(posted.stdout), /"id":"[^"]+"/);
    const read = await h.agora("other", ["read", "lab", "--json"]);
    const all = parseReadOutput(read.stdout, "lab");
    const answer = all.find((m) => bodyText(m).startsWith("an answer"));
    assert.equal(answer?.thread, rootId);
    assert.deepEqual(answer?.to, ["Ada"]);
    assert.equal(answer?.from, "Bea/role");
  } finally { await h.cleanup(); }
});
