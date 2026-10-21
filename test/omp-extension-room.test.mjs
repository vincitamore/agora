// @ts-check
// plugins/omp/agora-room: the omp extension driven through a stub `pi` and `ctx` against a real
// local room in a temp root, the CLI run as the extension runs it (no shell, its own child).
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  CHECKOUT_BIN, CUSTOM_TYPE, PROJECT_FILE, STATUS_KEY, createAgoraRoom, describePost, modelLabel, ompSessionKey, resolveOmpConfig,
} from "../plugins/omp/agora-room/index.mjs";
import { ACTIVITY_FILE, SEEN_FILE, TOOL_NAME, bodyText, deliveryText, formatLine, parseReadOutput } from "../plugins/claude/agora-room/hooks/lib.js";
import { inheritMarkerPath, writeInheritMarker } from "../src/resident.mjs";
import { tmp } from "./helpers.mjs";

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "agora.mjs");
const run = promisify(execFile);
const SESSION_ID = "01a15a18-e3d5-7654-b1ad-6a71b762ea1b";

/** The parent's environment without anything that names an agora session or a harness. */
const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AGORA_|CLAUDE_|OMP_|GROK_|CODEX_|HERMES_)/.test(k)));

// ---- plain helpers ----

test("modelLabel: the model's own name from its id, capitalised", () => {
  assert.equal(modelLabel("claude-haiku-4-5"), "Haiku");
  assert.equal(modelLabel("anthropic/claude-sonnet-5-5"), "Sonnet");
  assert.equal(modelLabel("gpt-6-sol"), "Sol");
  assert.equal(modelLabel("gemini-2.5-flash"), "Flash");
  assert.equal(modelLabel("moonshotai/Kimi-K3"), "Kimi");
  assert.equal(modelLabel("claude"), "Claude");
  assert.equal(modelLabel(null), "Model");
});

test("ompSessionKey: omp-<session id>, the key the CLI derives for the same session", () => {
  assert.equal(ompSessionKey(SESSION_ID), `omp-${SESSION_ID}`);
  assert.equal(ompSessionKey(null), "omp-session");
  assert.equal(ompSessionKey("../x"), "omp-session");
});

test("config: the Claude plugin's precedence with omp's defaults; a bad key falls back to omp's", () => {
  const home = path.join("h", "ome");
  const key = `omp-${SESSION_ID}`;
  const d = resolveOmpConfig({ env: { AGORA_ROOM: "lab" }, sessionId: SESSION_ID, home });
  assert.equal(d.session, key);
  assert.deepEqual(d.sessionEnv, { AGORA_SESSION: SESSION_ID, OMP_SESSION_ID: SESSION_ID }, "named as the CLI names an omp session");
  assert.deepEqual(d.command, ["node", CHECKOUT_BIN], "the CLI of this checkout, run with node, needs no shim");
  assert.ok(existsSync(CHECKOUT_BIN));
  assert.equal(d.liveness, path.join(home, ".agora", "omp-room", `${key}.json`));
  assert.equal(d.statePath, path.join(home, ".agora", "omp-room", `${key}.queue.json`));
  assert.equal(d.seen, `h/ome/.agora/state/sessions/${key}/${SEEN_FILE}`, "the session's own state directory, where the seat's messenger reads it");
  assert.equal(d.activity, `h/ome/.agora/state/sessions/${key}/${ACTIVITY_FILE}`, "the activity record beside it");
  assert.equal(resolveOmpConfig({ env: { AGORA_ROOM: "lab", AGORA_STATE: "~/st" }, sessionId: SESSION_ID, home }).seen, `h/ome/st/sessions/${key}/${SEEN_FILE}`, "the state root the CLI would use");
  assert.equal(resolveOmpConfig({ env: { AGORA_ROOM: "lab" }, file: { env: { AGORA_STATE: "/s/state" } }, sessionId: SESSION_ID, home }).seen, `/s/state/sessions/${key}/${SEEN_FILE}`, "the project file's env counts");
  assert.equal(d.role, null);

  const f = resolveOmpConfig({ env: { AGORA_ROLE: "coding" }, file: { rooms: ["a", "b"], session: "lab-omp", role: "desk", modelLabel: "Haiku", wake: "mine" }, sessionId: SESSION_ID, home });
  assert.deepEqual(f.rooms, ["a", "b"]);
  assert.equal(f.session, "lab-omp");
  assert.deepEqual(f.sessionEnv, { AGORA_SESSION: "lab-omp" });
  assert.equal(f.role, "coding", "environment over the project file");
  assert.equal(f.modelLabel, "Haiku");
  assert.equal(f.wake, "mine");

  const bad = resolveOmpConfig({ env: { AGORA_ROOM: "lab", AGORA_SESSION: "../x" }, sessionId: SESSION_ID, home });
  assert.equal(bad.session, key);
  assert.ok(bad.problems.some((p) => p.includes(`using ${key}`)), bad.problems.join("\n"));
  assert.ok(!bad.problems.some((p) => p.includes("claude-")));
});

test("describePost: the approval line names the room, the thread and the text", () => {
  assert.equal(describePost(["lab"], { text: "hi", thread: "m1" }), 'Post to room lab in thread m1? "hi"');
  assert.match(describePost(["a", "b"], { text: "x".repeat(300) }), /^Post to room \(unknown room\)\? "x{200}…"$/);
});

// ---- the extension against a real room ----

/** A stand-in for `pi.zod`: enough of the builder for the tool's schema. */
const zod = {
  /** @param {any} shape */ object: (shape) => ({ type: "object", shape }),
  string: () => chain("string"),
  /** @param {any} _item */ array: (_item) => chain("array"),
};
/** @param {string} t @returns {any} */
function chain(t) { const s = { t, optional: () => chain(`${t}?`), describe: () => s }; return s; }

/** A stub `pi` that records what the extension registers and sends. */
function stubPi() {
  /** @type {Record<string, Function[]>} */
  const handlers = {};
  /** @type {any[]} */
  const tools = [];
  /** @type {Array<{ msg: any, opts: any }>} */
  const sent = [];
  const pi = {
    zod,
    /** @param {string} ev @param {Function} h */ on(ev, h) { (handlers[ev] ??= []).push(h); },
    /** @param {any} def */ registerTool(def) { tools.push(def); },
    /** @param {any} msg @param {any} opts */ sendMessage(msg, opts) { sent.push({ msg, opts }); },
  };
  /** @param {string} ev @param {any} [ctx] @param {Record<string, any>} [payload] */
  const emit = async (ev, ctx, payload = {}) => { for (const h of handlers[ev] ?? []) await h({ type: ev, ...payload }, ctx); };
  return { pi, tools, sent, emit };
}

/** A stub `ctx`: idle by default; timers are recorded and run by the test. */
function stubCtx(/** @type {{ cwd: string, agent?: any, modelId?: string }} */ o) {
  /** @type {Function[]} */
  const timeouts = [];
  /** @type {Array<{ fn: Function, ms: number }>} */
  const intervals = [];
  /** @type {string[]} */
  const statuses = [];
  /** @type {any[]} */
  const branch = [];
  const ctx = {
    cwd: o.cwd, mode: "tui", hasUI: true, agent: o.agent ?? { kind: "main", id: "Main" }, idle: true,
    model: { id: o.modelId ?? "claude-haiku-4-5" },
    models: { current: () => ctx.model },
    isIdle: () => ctx.idle,
    sessionManager: { getSessionId: () => SESSION_ID, getBranch: () => branch },
    ui: {
      /** @param {string} k @param {string} t */
      setStatus(k, t) { if (k === STATUS_KEY) statuses.push(t); },
      notify() {},
    },
    /** @param {Function} fn @param {number} ms */ setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    /** @param {Function} fn */ setTimeout: (fn) => { timeouts.push(fn); return -timeouts.length; },
    clearTimer: () => {},
  };
  return { ctx, intervals, statuses, branch, runTimeouts: async () => { while (timeouts.length) await /** @type {Function} */ (timeouts.shift())(); } };
}

/**
 * A temp root: one local room `lab`, a session folder holding the project file, and a way for other
 * participants to post through the CLI.
 * @param {Record<string, any>} [project] extra project-file keys
 */
async function room(project = {}) {
  const { dir, cleanup } = await tmp();
  const config = path.join(dir, "config.json");
  const state = path.join(dir, "state");
  const cwd = path.join(dir, "session");
  await mkdir(cwd);
  await writeFile(config, JSON.stringify({ actor: { name: "Grace", kind: "agent" }, sign: true, state, rooms: { lab: { transport: "local", path: path.join(dir, "lab.ndjson") } } }));
  const liveness = path.join(dir, "live", "omp.json");
  await writeFile(path.join(cwd, PROJECT_FILE), JSON.stringify({
    rooms: ["lab"], command: [process.execPath, bin], liveness, env: { AGORA_CONFIG: config, AGORA_STATE: state }, ...project,
  }));
  const env = { ...BASE_ENV, AGORA_CONFIG: config, AGORA_STATE: state };
  /** @param {string} session @param {string[]} args @param {string} [actor] */
  const agora = async (session, args, actor) => {
    try {
      const r = await run(process.execPath, [bin, ...args], { env: { ...env, AGORA_SESSION: session, ...(actor ? { AGORA_ACTOR: actor } : {}) } });
      return { code: 0, stdout: r.stdout, stderr: r.stderr };
    } catch (err) {
      const e = /** @type {any} */ (err);
      return { code: e.code, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") };
    }
  };
  /** @param {string} text @param {string[]} [extra] */
  const say = async (text, extra = []) => {
    const r = await agora("ada", ["post", "lab", "--json", ...extra, "--", text], "Ada");
    assert.equal(r.code, 0, r.stderr);
    return /** @type {string} */ (JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}").id);
  };
  return { dir, cwd, liveness, agora, say, cleanup, env: { ...BASE_ENV }, cliEnv: env };
}

/** Start the extension for one session in the temp root. @param {Awaited<ReturnType<typeof room>>} r @param {{ env?: Record<string, string>, agent?: any, deps?: any }} [o] */
async function start(r, o = {}) {
  const p = stubPi();
  const c = stubCtx({ cwd: r.cwd, agent: o.agent });
  const ctl = createAgoraRoom(p.pi, { env: { ...r.env, ...(o.env ?? {}) }, home: r.dir, pollTimeoutMs: 15000, ...(o.deps ?? {}) });
  await p.emit("session_start", c.ctx);
  return { ...p, ...c, ctl, rt: /** @type {any} */ (ctl.runtime) };
}

/** One turn as omp runs it: it starts, the session is busy, it ends, the deferred drain runs. @param {Awaited<ReturnType<typeof start>>} s */
async function turn(s) {
  s.ctx.idle = false;
  await s.emit("agent_start", s.ctx);
  s.ctx.idle = true;
  await s.emit("agent_end", s.ctx);
  await s.runTimeouts();
}

/** @param {Array<{ msg: any }>} sent */
const texts = (sent) => sent.map((x) => String(x.msg.content).split("\n").pop()?.replace(/^agora lab \S+ thread=\S+ from=Ada: /, "").split(" / ")[0]);

test("watch: nothing from before the start arrives; three posts start three turns, in order, one at a time", async () => {
  const r = await room();
  try {
    await r.say("old news");
    const s = await start(r);
    assert.equal(s.intervals.length, 1, "one managed timer");
    assert.equal(s.intervals[0].ms, 2000);
    await s.rt.tick();
    assert.equal(s.sent.length, 0, "history is not replayed");

    await r.say("one");
    await r.say("two");
    await r.say("three");
    await s.rt.tick();
    assert.equal(s.sent.length, 1, "one turn at a time");
    const first = s.sent[0];
    assert.equal(first.msg.customType, CUSTOM_TYPE);
    assert.equal(first.msg.display, true);
    assert.deepEqual(first.opts, { triggerTurn: true }, "a turn of its own, never the follow-up queue");
    assert.match(first.msg.content, /^Message from the Agora room "lab", delivered by the agora-room plugin\./);
    assert.match(String(first.msg.content).split("\n")[1], /^agora lab \S+ thread=none from=Ada: one/);

    await s.rt.tick();
    assert.equal(s.sent.length, 1, "the next waits for this turn");
    await turn(s);
    assert.equal(s.sent.length, 2);
    await turn(s);
    assert.equal(s.sent.length, 3);
    await turn(s);
    await s.rt.tick();
    assert.deepEqual(texts(s.sent), ["one", "two", "three"], "each once, in order");

    const live = JSON.parse(await readFile(r.liveness, "utf8"));
    assert.equal(live.harness, "omp");
    assert.equal(live.delivered, 3);
    assert.equal(live.queued, 0);
    assert.equal(live.rooms[0].lastError, null);
    assert.match(s.statuses.at(-1) ?? "", /^agora-room: lab · read \d+s ago$/);
  } finally { await r.cleanup(); }
});

test("watch: a message that arrives during a turn is held and starts one turn after it", async () => {
  const r = await room();
  try {
    const s = await start(r);
    s.ctx.idle = false;
    await s.emit("agent_start", s.ctx);
    await r.say("while busy");
    await s.rt.tick();
    await s.rt.tick();
    assert.equal(s.sent.length, 0, "a running turn is never steered");
    s.ctx.idle = true;
    await s.emit("agent_end", s.ctx);
    assert.equal(s.sent.length, 0, "agent_end runs before the session is idle");
    await s.runTimeouts();
    assert.deepEqual(texts(s.sent), ["while busy"]);
    await turn(s);
    await s.rt.tick();
    assert.equal(s.sent.length, 1, "once");
  } finally { await r.cleanup(); }
});

test("seen: one line per admitted message, written when the watch admits it (before any turn); a reload continues the file", async () => {
  const r = await room();
  try {
    const s = await start(r, { env: { AGORA_LABEL: "desk.coding" } });
    const file = path.join(r.dir, "state", "sessions", s.rt.config.session, SEEN_FILE);
    assert.equal(path.resolve(s.rt.config.seen), path.resolve(file));
    s.ctx.idle = false;
    await s.emit("agent_start", s.ctx);
    const id1 = await r.say("one");
    const id2 = await r.say("two");
    const t0 = Date.now();
    await s.rt.tick();
    assert.equal(s.sent.length, 0, "the session is busy: nothing has been delivered yet");
    const read = async () => (await readFile(file, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    let lines = await read();
    assert.deepEqual(lines.map((l) => [l.v, l.type, l.session, l.position, l.room, l.id]), [
      [1, "seen", s.rt.config.session, "desk.coding", "lab", id1],
      [1, "seen", s.rt.config.session, "desk.coding", "lab", id2],
    ], "admitted, and recorded, before a turn is asked for");
    for (const l of lines) {
      assert.ok(Date.parse(l.admittedAt) >= t0 - 1000 && Date.parse(l.readAt) <= Date.parse(l.admittedAt), `${l.readAt} ${l.admittedAt}`);
      assert.equal(typeof l.cursor, "string");
    }
    await s.rt.tick();
    assert.equal((await read()).length, 2, "a message read once is recorded once");
    const live = JSON.parse(await readFile(r.liveness, "utf8"));
    assert.deepEqual(live.seen, { path: s.rt.config.seen, written: 2, lastError: null });

    s.rt.stop();
    const again = await start(r, { env: { AGORA_LABEL: "desk.coding" } });
    const id3 = await r.say("three");
    again.ctx.idle = false;
    await again.emit("agent_start", again.ctx);
    await again.rt.tick();
    lines = await read();
    assert.deepEqual(lines.map((l) => l.id), [id1, id2, id3], "the new watch continued the file");
    again.rt.stop();
  } finally { await r.cleanup(); }
});

test("activity: the record follows the session's turns, tool calls and output: a turn change is written at once, the rest on the poll tick, and a heartbeat refreshes a quiet one; a reload continues the counters", async () => {
  const r = await room();
  try {
    const base = Date.parse("2026-01-01T10:00:00.000Z");
    let t = base;
    const iso = (/** @type {number} */ ms) => new Date(ms).toISOString();
    const s = await start(r, { env: { AGORA_LABEL: "desk.coding" }, deps: { now: () => t } });
    const file = path.join(r.dir, "state", "sessions", s.rt.config.session, ACTIVITY_FILE);
    assert.equal(path.resolve(s.rt.config.activity), path.resolve(file));
    const read = async () => JSON.parse(await readFile(file, "utf8"));
    const written = async () => JSON.parse(await readFile(r.liveness, "utf8")).activity.written;
    let rec = await read();
    assert.deepEqual([rec.v, rec.type, rec.session, rec.position, rec.turn, rec.since, rec.progress, rec.lastToolAt, rec.intervalMs],
      [1, "activity", s.rt.config.session, "desk.coding", "idle", iso(base), 0, null, 2000], "written at the start, idle");

    t = base + 5000;
    await s.emit("agent_start", s.ctx);
    rec = await read();
    assert.deepEqual([rec.turn, rec.since], ["busy", iso(base + 5000)], "a turn change is written at once, not on the next tick");

    t = base + 6000;
    await s.emit("tool_call", s.ctx, { toolName: "bash" });
    await s.emit("tool_result", s.ctx, { toolName: "bash" });
    assert.equal((await read()).progress, 0, "a tool call waits for the tick: no write of its own");
    t = base + 7000;
    await s.emit("message_update", s.ctx, { message: { role: "assistant" } });
    await s.emit("message_end", s.ctx, { message: { role: "assistant" } });
    await s.emit("message_end", s.ctx, { message: { role: "toolResult" } });
    await s.emit("message_end", s.ctx, { message: { role: "user" } });
    const sub = { ...s.ctx, agent: { kind: "sub", id: "advisor" } };
    await s.emit("tool_call", sub, { toolName: "bash" });
    await s.emit("message_end", sub, { message: { role: "assistant" } });
    await s.rt.tick();
    rec = await read();
    assert.deepEqual([rec.turn, rec.lastToolAt, rec.lastOutputAt, rec.progress, rec.progressAt, rec.updatedAt],
      ["busy", iso(base + 6000), iso(base + 7000), 4, iso(base + 7000), iso(base + 7000)],
      "a tool call and its result, a finished assistant message and a user entry count; a tool-result message is not counted twice, a subagent's events are not this session's");
    const w = await written();

    await s.rt.tick();
    assert.equal(await written(), w, "nothing changed and the heartbeat is not due: no write (red leg: below)");
    t = base + 7000 + 31_000;
    await s.rt.tick();
    assert.equal(await written(), w + 1, "a quiet watch still refreshes its record");
    assert.equal((await read()).updatedAt, iso(t));

    t += 1000;
    await s.emit("agent_end", s.ctx);
    rec = await read();
    assert.deepEqual([rec.turn, rec.since, rec.progress], ["idle", iso(t), 4], "the turn ended: idle since now, written at once");
    await s.runTimeouts();
    s.rt.stop();

    const again = await start(r, { env: { AGORA_LABEL: "desk.coding" }, deps: { now: () => t } });
    await again.emit("tool_call", again.ctx, { toolName: "bash" });
    await again.rt.tick();
    rec = await read();
    assert.deepEqual([rec.progress, rec.turn], [5, "idle"], "a reload continued the counter and did not claim a turn");
    again.rt.stop();
  } finally { await r.cleanup(); }
});

test("seen: a record that cannot be written is reported and never stops the watch (red leg: the file is writable)", async () => {
  const r = await room();
  try {
    const key = ompSessionKey(SESSION_ID);
    // a directory where the file belongs: the rename over it fails
    await mkdir(path.join(r.dir, "state", "sessions", key, SEEN_FILE), { recursive: true });
    const s = await start(r);
    await r.say("still delivered");
    await s.rt.tick();
    assert.deepEqual(texts(s.sent), ["still delivered"]);
    const live = JSON.parse(await readFile(r.liveness, "utf8"));
    assert.equal(live.seen.written, 0);
    assert.equal(typeof live.seen.lastError, "string", "said in the liveness file");
    s.rt.stop();

    const ok = await room();
    try {
      const s2 = await start(ok);
      await ok.say("recorded");
      await s2.rt.tick();
      assert.equal(JSON.parse(await readFile(ok.liveness, "utf8")).seen.lastError, null);
      assert.equal(JSON.parse(await readFile(ok.liveness, "utf8")).seen.written, 1);
      s2.rt.stop();
    } finally { await ok.cleanup(); }
  } finally { await r.cleanup(); }
});

test("inherit: a session started at a position takes its predecessor's place before its first read: the cursor, the ledger, the marker consumed (red leg: a session with no position starts at the head)", async () => {
  const r = await room();
  try {
    const state = path.join(r.dir, "state");
    // the predecessor at desk.coding: it read the room, then posted once; then a message arrived it never read
    assert.equal((await r.agora("omp-pred", ["session", "--as", "coding/Sonnet", "--label", "desk.coding"])).code, 0);
    await r.say("read by the predecessor");
    assert.equal((await r.agora("omp-pred", ["cursor", "lab", "--now"])).code, 0);
    const own = await r.agora("omp-pred", ["post", "lab", "--json", "--", "taking it"], "coding/Sonnet");
    assert.equal(own.code, 0, own.stderr);
    const ownId = JSON.parse(own.stdout.trim().split("\n").pop() ?? "{}").id;
    await r.say("arrived after the predecessor stopped");
    const predCursor = JSON.parse(await readFile(path.join(state, "sessions", "omp-pred", "lab.cursor"), "utf8")).cursor;
    // the marker a cycle, a succeed or a start at the vacated position writes
    await writeInheritMarker(state, "desk.coding", { from: "omp-pred", by: "succeed" });

    const s = await start(r, { env: { AGORA_LABEL: "desk.coding", AGORA_ROLE: "coding" } });
    assert.equal(existsSync(inheritMarkerPath(state, "desk.coding")), false, "consumed before the first read");
    assert.deepEqual([s.rt.state().inherit?.inherited, s.rt.state().inherit?.from], [true, "omp-pred"]);
    const key = ompSessionKey(SESSION_ID);
    assert.equal(JSON.parse(await readFile(path.join(state, "sessions", key, "lab.cursor"), "utf8")).cursor, predCursor, "the watch resumes where the predecessor stopped, not at the head");
    await s.rt.tick();
    assert.deepEqual(texts(s.sent), ["arrived after the predecessor stopped"], "what it had not read arrives; its own post does not come back");
    assert.ok(!s.sent.some((x) => String(x.msg.content).includes(ownId)));
    assert.equal(JSON.parse(await readFile(r.liveness, "utf8")).inherit.from, "omp-pred", "said in the liveness file");
    s.rt.stop();

    // red leg: the same room, a session with no position: nothing to inherit, it starts at the head
    const q = await room();
    try {
      await q.say("history");
      await writeInheritMarker(path.join(q.dir, "state"), "desk.coding", { from: "omp-pred", by: "succeed" });
      const plain = await start(q);
      assert.equal(plain.rt.state().inherit, null);
      assert.equal(existsSync(inheritMarkerPath(path.join(q.dir, "state"), "desk.coding")), true, "a session at no position leaves the marker alone");
      await plain.rt.tick();
      assert.equal(plain.sent.length, 0, "history is not replayed");
      plain.rt.stop();
    } finally { await q.cleanup(); }
  } finally { await r.cleanup(); }
});

test("room_post: an essential, exec-tier tool; it lands in its thread with to and re; its own post never comes back", async () => {
  const r = await room();
  try {
    const s = await start(r);
    assert.equal(s.tools.length, 1);
    const tool = s.tools[0];
    assert.equal(tool.name, TOOL_NAME);
    assert.equal(tool.loadMode, "essential");
    assert.equal(tool.approval, "exec");
    assert.deepEqual(tool.formatApprovalDetails({ text: "hi", thread: "m1" }), ['Post to room lab in thread m1? "hi"']);

    const rootId = await r.say("a question");
    await s.rt.tick();
    assert.equal(s.sent.length, 1);
    await turn(s);
    const res = await tool.execute("call-1", { text: "an answer", thread: rootId, reply_to: rootId, to: ["Ada"] });
    assert.match(res.content[0].text, /"id":"[^"]+"/, res.content[0].text);
    assert.equal(res.details.ok, true);

    const read = await r.agora("ada", ["read", "lab", "--json"]);
    const answer = parseReadOutput(read.stdout, "lab").find((m) => bodyText(m).startsWith("an answer"));
    assert.equal(answer?.thread, rootId);
    assert.deepEqual(answer?.to, ["Ada"]);
    assert.equal(answer?.from, "Grace", "signed as this session's bearer (the config's actor here)");

    await s.rt.tick();
    assert.equal(s.sent.length, 1, "its own post is skipped by the CLI");

    // The model posting through the CLI from its own shell (omp sets OMP_SESSION_ID there) is the same session.
    await run(process.execPath, [bin, "post", "lab", "--json", "--", "posted from the model's shell"], { env: { ...r.cliEnv, OMP_SESSION_ID: SESSION_ID } });
    await s.rt.tick();
    assert.equal(s.sent.length, 1, "a post from the session's own shell does not come back either");

    const refused = await tool.execute("call-2", { text: "x", room: "elsewhere" });
    assert.match(refused.content[0].text, /^room_post failed: room "elsewhere" is not configured/);
    assert.equal(refused.details.ok, false);
  } finally { await r.cleanup(); }
});

test("role: the session registers as <role>/<Model> with its model id, and again on a model change, even one the bearer cannot show; --wake mine delivers only what is addressed to it", async () => {
  const r = await room({ wake: "mine" });
  try {
    const s = await start(r, { env: { AGORA_ROLE: "coding" } });
    const list = async () => (await r.agora(s.rt.config.session, ["session", "--list", "--json"])).stdout.trim().split("\n").map((l) => JSON.parse(l)).find((j) => j.slug === s.rt.config.session);
    let rec = await list();
    assert.equal(rec?.bearer, "coding/Haiku");
    assert.equal(rec?.source, "AGORA_SESSION (OMP_SESSION_ID)", "recorded as the omp session the CLI names from OMP_SESSION_ID");
    assert.equal(rec?.label, "coding");
    assert.deepEqual([rec?.model, rec?.family], ["claude-haiku-4-5", "claude"], "the record carries the model id the session runs, and its family");

    await r.say("for Lin", ["--to", "Lin"]);
    await r.say("for the coder", ["--to", "coding/Haiku"]);
    await s.rt.tick();
    assert.deepEqual(texts(s.sent), ["for the coder"], "a message for someone else does not wake it");
    await turn(s);

    s.ctx.model = { id: "claude-sonnet-5-5" };
    await s.rt.tick();
    rec = await list();
    assert.equal(rec?.bearer, "coding/Sonnet", "the role is the address; the model part follows the model");
    assert.equal(rec?.label, "coding");
    assert.deepEqual([rec?.model, rec?.family], ["claude-sonnet-5-5", "claude"]);

    // a swap the bearer cannot show: same model name, another provider and family segment intact; then another family
    s.ctx.model = { id: "google-antigravity/claude-sonnet-5-5" };
    await s.rt.tick();
    rec = await list();
    assert.deepEqual([rec?.bearer, rec?.model, rec?.family], ["coding/Sonnet", "google-antigravity/claude-sonnet-5-5", "claude"], "re-registered for the model, not only the bearer");
    s.ctx.model = { id: "google-antigravity/gemini-4-argon" };
    await s.rt.tick();
    rec = await list();
    assert.deepEqual([rec?.bearer, rec?.model, rec?.family], ["coding/Argon", "google-antigravity/gemini-4-argon", "gemini"]);
  } finally { await r.cleanup(); }
});

test("succeed kick: a turn end with a pending succeed request at this position asks the OS scheduler for a cycle run once per request, never every turn end; no timer installed is said once and nothing crashes (red leg: no request, no kick)", async () => {
  const r = await room();
  try {
    const log = path.join(r.dir, "calls.log");
    const answer = path.join(r.dir, "timer-answer.json");
    const wrapper = path.join(r.dir, "wrapper.mjs");
    await writeFile(answer, JSON.stringify({ code: 0, out: { type: "resident-timer", action: "run", state: "kicked", problems: [] } }));
    await writeFile(wrapper, [
      'import { spawnSync } from "node:child_process";',
      'import { appendFileSync, readFileSync } from "node:fs";',
      "const args = process.argv.slice(2);",
      `appendFileSync(${JSON.stringify(log)}, args.join(" ") + "\\n");`,
      `if (args[0] === "resident" && args[1] === "timer") { const a = JSON.parse(readFileSync(${JSON.stringify(answer)}, "utf8")); process.stdout.write(JSON.stringify(a.out) + "\\n"); process.exit(a.code); }`,
      `const c = spawnSync(process.execPath, [${JSON.stringify(bin)}, ...args], { stdio: "inherit" }); process.exit(c.status ?? 1);`,
    ].join("\n"));
    const state = path.join(r.dir, "state");
    const s = await start(r, { env: { AGORA_ROOM_CMD: JSON.stringify([process.execPath, wrapper]), AGORA_LABEL: "desk.coding", AGORA_ROLE: "coding", AGORA_STATE: state } });
    const kicks = async () => (await readFile(log, "utf8")).split("\n").filter((l) => l.startsWith("resident timer run")).length;
    await turn(s);
    assert.equal(await kicks(), 0, "red leg: no request, no kick");
    const { writeSucceedRequest } = await import("../src/resident.mjs");
    await writeSucceedRequest(state, "desk.coding", { by: "omp-x", now: new Date("2026-01-01T00:00:00.000Z") });
    await turn(s);
    assert.equal(await kicks(), 1, "the turn that ended after the request kicks the cycle");
    await turn(s);
    await turn(s);
    assert.equal(await kicks(), 1, "once per request, not every turn end");
    // a second request (another close) is a new one: one more kick, and the scheduler has no entry
    await writeFile(answer, JSON.stringify({ code: 1, out: { type: "resident-timer", action: "run", state: "missing", problems: ["no cycle timer is installed"] } }));
    await writeSucceedRequest(state, "desk.coding", { by: "omp-x", now: new Date("2026-01-01T01:00:00.000Z") });
    await turn(s);
    assert.equal(await kicks(), 2);
    assert.match(String(s.rt.state().succeedKick?.notice), /no cycle timer is installed: the succession requested at 2026-01-01T01:00:00\.000Z waits for the next cycle \(agora resident timer install\)/);
    await writeSucceedRequest(state, "desk.coding", { by: "omp-x", now: new Date("2026-01-01T02:00:00.000Z") });
    await turn(s);
    assert.equal(await kicks(), 3);
    assert.equal(s.rt.state().succeedKick?.notices, 1, "said once, not at every kick that finds no timer");
  } finally { await r.cleanup(); }
});

test("recovery: a failed poll and a child killed for not answering are both recovered at the next tick, the message arriving once", async () => {
  const r = await room();
  try {
    const fail = path.join(r.dir, "fail-next");
    const hang = path.join(r.dir, "hang-next");
    const flaky = path.join(r.dir, "flaky.mjs");
    await writeFile(flaky, [
      'import { spawnSync } from "node:child_process";',
      'import { existsSync, rmSync } from "node:fs";',
      "const args = process.argv.slice(2);",
      `if (args[0] === "watch" && existsSync(${JSON.stringify(fail)})) { rmSync(${JSON.stringify(fail)}); process.stderr.write("boom"); process.exit(3); }`,
      `if (args[0] === "watch" && existsSync(${JSON.stringify(hang)})) { rmSync(${JSON.stringify(hang)}); setTimeout(() => {}, 60000); }`,
      `else { const c = spawnSync(process.execPath, [${JSON.stringify(bin)}, ...args], { stdio: "inherit" }); process.exit(c.status ?? 1); }`,
    ].join("\n"));
    const s = await start(r, { env: { AGORA_ROOM_CMD: JSON.stringify([process.execPath, flaky]) }, deps: { pollTimeoutMs: 1500 } });

    await r.say("after a failure");
    await writeFile(fail, "");
    await s.rt.tick();
    assert.equal(s.sent.length, 0);
    assert.match(s.rt.state().lastError, /agora watch lab exit 3: boom/);
    assert.match(s.statuses.at(-1) ?? "", /· last poll failed$/);
    await s.rt.tick();
    assert.deepEqual(texts(s.sent), ["after a failure"]);
    assert.equal(s.rt.state().lastError, null);
    await turn(s);

    await r.say("after a kill");
    await writeFile(hang, "");
    await s.rt.tick();
    assert.match(s.rt.state().lastError, /no answer within 1500 ms; killed pid \d+/);
    await s.rt.tick();
    await turn(s);
    await s.rt.tick();
    assert.deepEqual(texts(s.sent), ["after a failure", "after a kill"], "each once");
  } finally { await r.cleanup(); }
});

test("reload: the queue and the delivered ids survive; a message that may have been sent is checked against the transcript", async () => {
  const r = await room();
  try {
    const a = await start(r);
    await r.say("first");
    await r.say("second");
    await a.rt.tick();
    assert.equal(a.sent.length, 1);
    a.rt.stop();

    // A new binding for the same session (a reload): "second" is still queued, "first" is not repeated.
    const b = await start(r);
    await b.rt.tick();
    assert.deepEqual(texts(b.sent), ["second"]);

    // A delivery that was in flight when the module went away, and that the transcript shows, is not sent again.
    const saved = JSON.parse(await readFile(b.rt.config.statePath, "utf8"));
    await r.say("third");
    await turn(b);
    b.ctx.idle = false;
    await b.rt.tick();
    const third = JSON.parse(await readFile(b.rt.config.statePath, "utf8")).queue[0];
    assert.ok(third, "queued while busy");
    b.rt.stop();
    await writeFile(b.rt.config.statePath, JSON.stringify({ ...saved, queue: [third], inflight: `lab ${third.id}` }));
    const c = await start(r);
    c.branch.push({ type: "custom_message", customType: CUSTOM_TYPE, content: deliveryText(third) });
    await c.rt.tick();
    assert.equal(c.sent.length, 0, "already in the transcript");
    assert.equal(c.rt.state().queue, 0);
  } finally { await r.cleanup(); }
});

test("a client that holds agent-started turns: noticed, said in the status line, and the rest no longer wait for turns", async () => {
  const r = await room();
  try {
    const s = await start(r, { deps: { deferAfterMs: 0 } });
    await r.say("one");
    await r.say("two");
    await s.rt.tick();
    assert.equal(s.sent.length, 1);
    await new Promise((res) => setTimeout(res, 5));
    await s.rt.tick(); // no agent_start came
    assert.equal(s.rt.state().deferring, true);
    assert.match(s.statuses.at(-1) ?? "", /room messages wait for your next prompt/);
    assert.deepEqual(texts(s.sent), ["one", "two"]);

    const acp = await start(r, { agent: { kind: "main", id: "acp:0123" } });
    assert.equal(acp.rt.state().deferring, true, "omp under ACP says so in its agent id");
  } finally { await r.cleanup(); }
});

test("watch off: no timer, no liveness file, no status line; the tool still posts", async () => {
  const r = await room({ watch: "off" });
  try {
    const s = await start(r);
    assert.equal(s.intervals.length, 0);
    assert.equal(s.statuses.length, 0);
    assert.equal(existsSync(r.liveness), false);
    const res = await s.tools[0].execute("c", { text: "posted with the watch off" });
    assert.match(res.content[0].text, /"id":"[^"]+"/);
    await s.emit("agent_end", s.ctx);
    await s.runTimeouts();
    assert.equal(s.sent.length, 0);
  } finally { await r.cleanup(); }
});

test("a subagent session and a session with no room configured do nothing", async () => {
  const r = await room();
  try {
    const sub = await start(r, { agent: { kind: "sub", id: "x" } });
    assert.equal(sub.rt, null);
    assert.equal(sub.tools.length, 0);
    assert.equal(sub.intervals.length, 0);

    await writeFile(path.join(r.cwd, PROJECT_FILE), JSON.stringify({}));
    const none = await start(r);
    assert.equal(none.rt, null);
    assert.equal(none.tools.length, 0);
  } finally { await r.cleanup(); }
});

test("the delivered text is the Claude plugin's, byte for byte", () => {
  const m = { room: "lab", id: "m1", thread: null, from: "Ada", text: "a\nb" };
  assert.equal(deliveryText(m).split("\n").pop(), formatLine(m));
});
