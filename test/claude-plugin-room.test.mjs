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
  DeliveryQueue, TO_NOBODY, ago, bodyText, buildSubjects, chooseRoom, childEnvFor, formatLine, isStopReason,
  paneSessionKey, paneTree, parseCommand, parseList, parseReadOutput, parseSwitch, parseWatchOutput,
  postArgs, receiptText, resolveConfig, statusLine, subjectTitle, targetLine, whoRows, MAX_POST_CHARS,
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

// ---- the pane ----

/** Stand-ins for the elements `$.ui.resolve(e)` returns: each records its props. */
const fakeEls = (/** @type {string[]} */ without = []) => {
  /** @type {Record<string, any>} */
  const els = {};
  for (const n of ["Box", "Text", "Button", "Input", "Select"]) if (!without.includes(n)) els[n] = (/** @type {any} */ props) => ({ el: n, ...props });
  return els;
};
/** @param {any} node @param {any[]} acc */
const walk = (node, acc = []) => { if (node && typeof node === "object") { acc.push(node); for (const c of node.children ?? []) walk(c, acc); } return acc; };
const noop = () => {};
const acts = { open: noop, back: noop, newSubject: noop, setTo: noop, setRoom: noop, refresh: noop, submit: noop };
const baseModel = () => ({
  rooms: ["lab"], room: "lab", loading: false, error: null, subjects: buildSubjects(ROOM, { self: "Grace" }), thread: /** @type {string | null} */ (null),
  who: whoRows([{ type: "who", name: "Ada", last: "2026-10-20T09:10:00.000Z", count: 2 }]), to: TO_NOBODY, now: Date.parse("2026-10-20T09:40:00.000Z"),
});

test("pane: subjects list with unread marks, a stated target, a selector and a compose field", () => {
  const tree = paneTree(fakeEls(), baseModel(), acts);
  const nodes = walk(tree, []);
  const labels = nodes.filter((n) => n.el === "Button" && String(n.key).startsWith("subject-")).map((n) => n.label);
  assert.equal(labels.length, 3);
  assert.match(labels[0], /^● 1 tail of an old thread/);
  assert.match(labels[1], /^● 1 Plan the release · 3 msg · 20m$/);
  assert.equal(nodes.find((n) => n.key === "subject-old")?.hotkey, "1");
  const texts = nodes.filter((n) => n.el === "Text").map((n) => n.children[0]);
  assert.ok(texts.includes("Post → room lab · a new subject · to: no one in particular"));
  assert.ok(texts.some((t) => /^here: Ada 30m$/.test(t)));
  assert.equal(nodes.filter((n) => n.el === "Input").length, 1);
  const select = nodes.find((n) => n.el === "Select");
  assert.deepEqual(select.options.map((/** @type {any} */ o) => o.value), [TO_NOBODY, "*", "Ada"]);
});

test("pane: a thread view names the reply target and shows the messages; the explicit to: shows in the target", () => {
  const m = { ...baseModel(), thread: "r1", to: "Ada" };
  const nodes = walk(paneTree(fakeEls(), m, acts), []);
  const texts = nodes.filter((n) => n.el === "Text").map((n) => n.children[0]);
  assert.ok(texts.includes('Post → room lab · reply in "Plan the release" · to: Ada'));
  assert.ok(texts.includes("Grace · 40m"), "the thread's first message");
  assert.ok(texts.includes("Plan the release\n\nwith detail"), "bodies lose the signature line");
  assert.ok(nodes.some((n) => n.key === "back"));
  assert.equal(targetLine({ ...m, to: "*" }), 'Post → room lab · reply in "Plan the release" · to: everyone (*)');
});

test("pane: callbacks reach the actions", () => {
  /** @type {string[]} */
  const log = [];
  const a = { ...acts, open: (/** @type {string} */ id) => log.push(`open ${id}`), submit: (/** @type {string} */ t) => log.push(`submit ${t}`), setTo: (/** @type {string} */ v) => log.push(`to ${v}`) };
  const nodes = walk(paneTree(fakeEls(), baseModel(), a), []);
  nodes.find((n) => n.key === "subject-r2").onPress();
  nodes.find((n) => n.el === "Input").onSubmit("hi");
  nodes.find((n) => n.el === "Select").onSelect("Ada");
  assert.deepEqual(log, ["open r2", "submit hi", "to Ada"]);
});

test("pane: a surface without Input or Select gets the pane without them and is told so; without the base elements, nothing", () => {
  const nodes = walk(paneTree(fakeEls(["Input", "Select"]), baseModel(), acts), []);
  assert.equal(nodes.filter((n) => n.el === "Input" || n.el === "Select").length, 0);
  const texts = nodes.filter((n) => n.el === "Text").map((n) => n.children[0]);
  assert.ok(texts.some((t) => /no text field/.test(t)));
  assert.ok(texts.some((t) => /no selector/.test(t)));
  assert.equal(paneTree(fakeEls(["Button"]), baseModel(), acts), null);
});

test("pane: several rooms get room buttons, one room a title; an error is shown", () => {
  const multi = walk(paneTree(fakeEls(), { ...baseModel(), rooms: ["lab", "desk"], error: "agora read exit 1" }, acts), []);
  assert.deepEqual(multi.filter((n) => String(n.key).startsWith("room-")).map((n) => n.label), ["[lab]", "desk"]);
  assert.ok(multi.some((n) => n.el === "Text" && n.color === "red" && n.children[0] === "agora read exit 1"));
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
