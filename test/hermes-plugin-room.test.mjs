// @ts-check
// plugins/hermes/agora-room: the Hermes plugin driven through its own register(ctx) with a fake Hermes
// PluginContext (test/fixtures/hermes-room-driver.py) against a real local room in a temp root, the CLI run
// as the plugin runs it (no shell, an allowlisted environment). Skipped when no Python 3.10+ is on PATH
// (AGORA_TEST_PYTHON names one).
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildBatch } from "../plugins/omp/agora-room/index.mjs";
import { ACTIVITY_FILE, SEEN_FILE, WAKE_FILE, formatLine, preambleText } from "../plugins/claude/agora-room/hooks/lib.js";
import { modelLabel } from "../plugins/omp/agora-room/index.mjs";
import { writeInheritMarker } from "../src/resident.mjs";
import { tmp } from "./helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(here, "..", "bin", "agora.mjs");
const PLUGIN_DIR = path.join(here, "..", "plugins", "hermes", "agora-room");
const DRIVER = path.join(here, "fixtures", "hermes-room-driver.py");
const run = promisify(execFile);
const HERMES_ID = `local-${"0123456789abcdef".repeat(4)}`;

/** A Python 3.10 or later: AGORA_TEST_PYTHON, else python3, else python. Null when there is none. */
function findPython() {
  for (const exe of [process.env.AGORA_TEST_PYTHON, "python3", "python"].filter(Boolean)) {
    try {
      const v = execFileSync(/** @type {string} */ (exe), ["-c", "import sys; print(sys.version_info[0] * 100 + sys.version_info[1])"], { encoding: "utf8", timeout: 15000, windowsHide: true }).trim();
      if (Number(v) >= 310) return /** @type {string} */ (exe);
    } catch { /* next */ }
  }
  return null;
}
const PYTHON = findPython();
const skip = PYTHON ? false : "no Python 3.10+ on PATH (set AGORA_TEST_PYTHON)";

/** The parent's environment without anything that names an agora session, a harness or a credential. */
const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AGORA_|CLAUDE_|OMP_|GROK_|CODEX_|HERMES_)/.test(k) && !/TOKEN|SECRET|API_?KEY|PASSW/i.test(k)));

/**
 * A temp root: one local room `lab` and a way for other participants to post through the CLI.
 * @param {Record<string, any>} [roomRow]
 */
async function room(roomRow = {}) {
  const { dir, cleanup } = await tmp();
  const config = path.join(dir, "config.json");
  const state = path.join(dir, "state");
  const cwd = path.join(dir, "work");
  const home = path.join(dir, "home");
  await mkdir(cwd, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(config, JSON.stringify({ actor: { name: "Grace", kind: "agent" }, sign: true, state, rooms: { lab: { transport: "local", path: path.join(dir, "lab.ndjson"), ...roomRow } } }));
  const cliEnv = { ...BASE_ENV, AGORA_CONFIG: config, AGORA_STATE: state };
  /** @param {string} session @param {string[]} args @param {string} [actor] @param {Record<string, string>} [extra] */
  const agora = async (session, args, actor, extra = {}) => {
    try {
      const r = await run(process.execPath, [bin, ...args], { env: { ...cliEnv, AGORA_SESSION: session, ...(actor ? { AGORA_ACTOR: actor } : {}), ...extra } });
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
  const sessionDir = (/** @type {string} */ key) => path.join(state, "sessions", key);
  return { dir, cwd, home, state, config, agora, say, cleanup, sessionDir };
}

/**
 * The plugin in its own Python process, registered with a fake Hermes context.
 * @param {Awaited<ReturnType<typeof room>>} r @param {Record<string, string>} [env] @param {Record<string, unknown>} [set]
 */
async function plugin(r, env = {}, set = {}) {
  const child = spawn(/** @type {string} */ (PYTHON), [DRIVER, PLUGIN_DIR], {
    cwd: r.cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    env: { ...BASE_ENV, HOME: r.home, USERPROFILE: r.home, AGORA_CONFIG: r.config, AGORA_STATE: r.state, AGORA_ROOM: "lab", AGORA_ROOM_CMD: JSON.stringify([process.execPath, bin]), PYTHONIOENCODING: "utf-8", ...env },
  });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  const lines = createInterface({ input: child.stdout });
  /** @type {Array<(line: string) => void>} */
  const waiting = [];
  lines.on("line", (line) => { const w = waiting.shift(); if (w) w(line); });
  /** @param {Record<string, unknown>} req @returns {Promise<any>} */
  const ask = (req) => new Promise((resolve, reject) => {
    waiting.push((line) => {
      const j = JSON.parse(line);
      if (!j.ok) reject(new Error(`${j.error}\n${j.trace}\n${stderr}`));
      else resolve(j);
    });
    child.stdin.write(`${JSON.stringify(req)}\n`);
  });
  const reg = await ask({ op: "register", set });
  const close = async () => { child.stdin.end(); await new Promise((res) => child.once("exit", res)); };
  /** @param {string} name @param {Record<string, unknown>} [kw] */
  const hook = (name, kw = {}) => ask({ op: "hook", name, kw: { session_id: HERMES_ID, platform: "cli", ...kw } });
  const sent = async () => /** @type {Array<{ content: string, session_key: string | null }>} */ ((await ask({ op: "sent" })).sent);
  const state = async () => (await ask({ op: "state" })).state;
  /** One turn as Hermes runs it: pre_llm_call, then the turn's end hooks, then the drain window. */
  const turn = async (/** @type {Record<string, unknown>} */ api = {}) => {
    await hook("pre_llm_call", { model: "deepseek/deepseek-v4.1-flash-1017" });
    if (Object.keys(api).length) await hook("post_api_request", api);
    await hook("post_llm_call");
    await hook("on_session_end", { completed: true });
    await ask({ op: "timers" });
  };
  const tick = () => ask({ op: "tick" });
  return { ask, reg, close, hook, sent, state, turn, tick, stderr: () => stderr };
}

/** The message lines of an injection. @param {string} content */
const lineOf = (content) => content.split("\n").filter((l) => l.startsWith("agora "));
/** @param {Array<{ content: string }>} sent */
const texts = (sent) => sent.flatMap((x) => lineOf(x.content)).map((l) => l.replace(/^agora lab \S+ thread=\S+ from=\S+: /, "").split(" / ")[0]);

test("hermes plugin: the delivered text is byte for byte the OMP extension's and the Claude plugin's", { skip }, async () => {
  const r = await room();
  const p = await plugin(r, { AGORA_SESSION: "hp-golden" });
  try {
    const one = { room: "lab", id: "m1", thread: null, from: "Ada", text: "two\r\nlines\n\nhere" };
    assert.equal((await p.ask({ op: "fn", name: "format_line", args: [one] })).value, formatLine(one));
    assert.equal((await p.ask({ op: "fn", name: "preamble_text", args: ["lab"] })).value, preambleText("lab"));
    for (const id of ["claude-haiku-4-5", "deepseek/deepseek-v4.1-flash-1017", "claude-opus-5-5", "gpt-6-sol", "moonshotai/Kimi-K3", null])
      assert.equal((await p.ask({ op: "fn", name: "model_label", args: [id] })).value, modelLabel(id), String(id));
    /** @type {any[]} */
    const many = [];
    for (let i = 0; i < 30; i++) many.push({ room: i % 7 === 0 ? "ops" : "lab", id: `m${i}`, thread: i % 3 ? `m${i - (i % 3)}` : null, from: "Ada", text: `line ${i} ${"x".repeat(i * 9)}`, cursor: `c${i}`, prev: i ? `c${i - 1}` : null, ...(i === 4 ? { exposure: "public" } : {}) });
    for (const msgs of [many.slice(0, 1), many.slice(0, 3), many, many.filter((m) => m.room === "lab").slice(0, 5)]) {
      for (const preamble of [true, false]) {
        const js = buildBatch(msgs, { preamble });
        const py = (await p.ask({ op: "fn", name: "build_batch", args: [msgs], kw: { preamble } })).value;
        assert.equal(py.text, js.text, `${msgs.length} messages, preamble ${preamble}`);
        assert.deepEqual(py.overflow.map((/** @type {any} */ m) => m.id), js.overflow.map((m) => m.id));
      }
    }
  } finally { await p.close(); await r.cleanup(); }
});

test("hermes plugin: registers room_post and room_read in its own toolset and the hooks its manifest declares", { skip }, async () => {
  const r = await room();
  const p = await plugin(r, { AGORA_SESSION: "hp-reg" });
  try {
    assert.deepEqual(Object.keys(p.reg.tools).sort(), ["room_post", "room_read"]);
    assert.equal(p.reg.tools.room_post.toolset, "agora-room");
    assert.deepEqual(p.reg.tools.room_post.schema.parameters.required, ["text"]);
    const manifest = await readFile(path.join(PLUGIN_DIR, "plugin.yaml"), "utf8");
    const declared = (/** @type {string} */ key) => {
      const block = (manifest.split(`${key}:\n`)[1] ?? "").split("\n");
      const end = block.findIndex((l) => !l.startsWith("  - "));
      return block.slice(0, end < 0 ? block.length : end).map((l) => l.slice(4).trim());
    };
    assert.deepEqual(declared("provides_tools").sort(), Object.keys(p.reg.tools).sort(), "plugin.yaml provides_tools matches what registers");
    assert.deepEqual(declared("provides_hooks").sort(), p.reg.hooks, "plugin.yaml provides_hooks matches what registers");
    assert.equal(p.reg.session, "hp-reg");
  } finally { await p.close(); await r.cleanup(); }
});

test("hermes plugin: nothing from before the start; what arrives while idle is one injection routed by the Hermes session id; the next waits for the turn it started", { skip }, async () => {
  const r = await room();
  await r.say("old news");
  const p = await plugin(r, { AGORA_SESSION: "hp-idle", AGORA_ACTOR: "probe/Flash" });
  try {
    await p.hook("on_session_start");
    assert.equal((await p.ask({ op: "arm" })).armed, true);
    await p.tick();
    assert.equal((await p.sent()).length, 0, "history is not replayed");

    await r.say("one");
    await r.say("two");
    await p.tick();
    let sent = await p.sent();
    assert.equal(sent.length, 1, "one injection per drain");
    assert.equal(sent[0].session_key, HERMES_ID, "routed by the Hermes session id a hook named");
    assert.match(sent[0].content, /^Messages from the Agora room "lab", delivered by the agora-room plugin, grouped by thread\./);
    assert.deepEqual(texts(sent), ["one", "two"]);

    await r.say("three");
    await p.tick();
    assert.equal((await p.sent()).length, 1, "the next waits for the turn this one started");
    await p.turn();
    sent = await p.sent();
    assert.equal(sent.length, 2, "after the turn ends, the rest is one more injection");
    assert.deepEqual(texts(sent), ["one", "two", "three"]);
    // seen lines were written for each admitted message, and an activity record
    const seen = (await readFile(path.join(r.sessionDir("hp-idle"), SEEN_FILE), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(seen.length, 3);
    assert.deepEqual(Object.keys(seen[0]), ["v", "type", "session", "position", "room", "id", "cursor", "readAt", "admittedAt"]);
    const activity = JSON.parse(await readFile(path.join(r.sessionDir("hp-idle"), ACTIVITY_FILE), "utf8"));
    assert.equal(activity.type, "activity");
    assert.equal(activity.session, "hp-idle");
  } finally { await p.close(); await r.cleanup(); }
});

test("hermes plugin: never injects while a turn runs (the classic CLI would cancel it); a held message is handed over once at the turn's end", { skip }, async () => {
  const r = await room();
  const p = await plugin(r, { AGORA_SESSION: "hp-busy", AGORA_ACTOR: "probe/Flash" });
  try {
    await p.hook("on_session_start");
    await p.ask({ op: "arm" });
    await p.tick();
    await p.hook("pre_llm_call", { model: "m" });
    await p.hook("pre_tool_call", { tool_name: "terminal", args: { command: "sleep 20" } });
    await r.say("during the tool call");
    await p.tick();
    await p.tick();
    assert.equal((await p.sent()).length, 0, "held while busy, whatever thread it is on");
    const s = await p.state();
    assert.equal(s.busy, true);
    assert.equal(s.queued, 1);
    const seen = await readFile(path.join(r.sessionDir("hp-busy"), SEEN_FILE), "utf8");
    assert.equal(seen.trim().split("\n").length, 1, "the seen line is written while busy, before any turn");
    await p.hook("post_tool_call", { tool_name: "terminal" });
    await p.hook("post_llm_call");
    await p.ask({ op: "timers" });
    let sent = await p.sent();
    assert.equal(sent.length, 1, "handed over at the turn's end");
    await p.hook("on_session_end", { completed: true });
    await p.ask({ op: "timers" });
    sent = await p.sent();
    assert.equal(sent.length, 1, "once: the second end hook of the same turn delivers nothing again");
    assert.deepEqual(texts(sent), ["during the tool call"]);
  } finally { await p.close(); await r.cleanup(); }
});

test("hermes plugin: a failed or interrupted turn still ends the busy state (on_session_end), and a host that refuses the injection keeps the messages queued", { skip }, async () => {
  const r = await room();
  const p = await plugin(r, { AGORA_SESSION: "hp-fail", AGORA_ACTOR: "probe/Flash" });
  try {
    await p.hook("on_session_start");
    await p.ask({ op: "arm" });
    await p.hook("pre_llm_call", { model: "m" });
    await p.hook("on_session_end", { completed: false, interrupted: true });
    assert.equal((await p.state()).busy, false, "an interrupted turn ends the busy state");
    await p.ask({ op: "set", accept: false });
    await r.say("first try refused");
    await p.tick();
    let s = await p.state();
    assert.equal(s.queued, 1, "a refused injection stays queued");
    assert.equal(s.refused, 1);
    assert.equal(s.turnHop, null, "and leaves no wake record behind");
    assert.equal(existsSync(path.join(r.sessionDir("hp-fail"), WAKE_FILE)), false);
    await p.ask({ op: "set", accept: true });
    await p.tick();
    const sent = await p.sent();
    assert.equal(sent.filter((x) => x.content.includes("first try refused")).length, 2, "offered again, taken the second time");
    s = await p.state();
    assert.equal(s.queued, 0);
    // a turn that was asked for and never started does not hold the queue forever
    await p.ask({ op: "set", values: { defer_after_ms: 0 } });
    await r.say("after a lost turn");
    await p.tick();
    s = await p.state();
    assert.equal(s.queued, 0, "past the defer bound the next drain goes ahead");
    assert.match(String(s.lastError ?? ""), /no turn started/);
  } finally { await p.close(); await r.cleanup(); }
});

test("hermes plugin: room_post lands in its thread signed as the bearer, carries the turn's hop, and does not come back; the shell under the same key neither", { skip }, async () => {
  const r = await room();
  const p = await plugin(r, { AGORA_SESSION: "hp-post", AGORA_ACTOR: "probe/Flash", AGORA_MODEL: "deepseek/deepseek-v4.1-flash-1017" });
  try {
    await p.hook("on_session_start");
    await p.ask({ op: "arm" });
    await p.tick();
    const root = await r.say("question");
    await p.tick();
    assert.equal((await p.sent()).length, 1);
    await p.hook("pre_llm_call", { model: "deepseek/deepseek-v4.1-flash-1017" });
    const wake = JSON.parse(await readFile(path.join(r.sessionDir("hp-post"), WAKE_FILE), "utf8"));
    assert.equal(wake.type, "wake");
    const res = (await p.ask({ op: "tool", name: "room_post", args: { text: "answer", thread: root, to: ["Ada"] } })).result;
    assert.equal(res.ok, true, JSON.stringify(res));
    // the model's own shell, under the same key (AGORA_SESSION reaches it), posts as this session too
    const shell = await r.agora("hp-post", ["post", "lab", "--json", "--", "from the shell"], "probe/Flash");
    assert.equal(shell.code, 0, shell.stderr);
    await p.hook("post_llm_call");
    await p.ask({ op: "timers" });
    assert.equal(existsSync(path.join(r.sessionDir("hp-post"), WAKE_FILE)), false, "the wake record is cleared at the turn's end");
    await p.tick();
    assert.equal((await p.sent()).length, 1, "neither its own post nor its shell's comes back as a turn");
    const read = await r.agora("ada", ["read", "lab", "--json"]);
    const mine = read.stdout.trim().split("\n").map((l) => JSON.parse(l)).find((m) => m.text?.startsWith("answer"));
    assert.ok(mine, read.stdout);
    assert.equal(mine.thread ?? mine.threadId, root, "in the thread of the message it answers");
    assert.equal(mine.author?.name ?? mine.signedAs, "probe/Flash");
    assert.ok((mine.trailers ?? []).some((/** @type {any} */ t) => t.key === "hop" && t.value === "1"), `the post carries hop 1: ${JSON.stringify(mine.trailers)}`);
    const list = await r.agora("hp-post", ["session", "--list", "--json"]);
    assert.match(list.stdout, /deepseek-v4\.1-flash-1017/, "registered with the model id, so its family is read from the record");
    const bad = (await p.ask({ op: "tool", name: "room_post", args: { text: "x", room: "elsewhere" } })).result;
    assert.equal(bad.ok, false);
    assert.match(bad.error, /not configured/);
  } finally { await p.close(); await r.cleanup(); }
});

test("hermes plugin: room_read shows the room's lines and moves no cursor", { skip }, async () => {
  const r = await room();
  const p = await plugin(r, { AGORA_SESSION: "hp-read", AGORA_ACTOR: "probe/Flash" });
  try {
    await p.hook("on_session_start");
    await p.ask({ op: "arm" });
    await r.say("readable");
    const res = (await p.ask({ op: "tool", name: "room_read", args: { limit: 5 } })).result;
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.ok(res.lines.some((/** @type {string} */ l) => /from=Ada: readable( \/|$)/.test(l)), JSON.stringify(res.lines));
    await p.tick();
    assert.deepEqual(texts(await p.sent()), ["readable"], "the read moved no cursor: the watch still delivers it");
  } finally { await p.close(); await r.cleanup(); }
});

test("hermes plugin: the deny list blocks the named tool through pre_tool_call; any other passes", { skip }, async () => {
  const r = await room();
  const p = await plugin(r, { AGORA_SESSION: "hp-deny", AGORA_ACTOR: "probe/Flash", AGORA_DENY: "terminal,write_file" });
  try {
    const blocked = (await p.hook("pre_tool_call", { tool_name: "terminal", args: {} })).results;
    assert.equal(blocked[0].action, "block");
    assert.match(blocked[0].message, /denied to this resident/);
    assert.equal((await p.hook("pre_tool_call", { tool_name: "read_file", args: {} })).results[0], null);
    assert.equal((await p.hook("pre_tool_call", { tool_name: "write_file", args: {} })).results[0].action, "block");
  } finally { await p.close(); await r.cleanup(); }
});

test("hermes plugin: turn.json carries the last main-loop inference, its context and the turn's end; usage lines record zero-filled buckets as unknown", { skip }, async () => {
  const r = await room();
  const p = await plugin(r, { AGORA_SESSION: "hp-turn", AGORA_ACTOR: "probe/Flash" });
  try {
    await p.hook("on_session_start");
    await p.ask({ op: "arm" });
    await p.hook("pre_llm_call", { model: "deepseek/deepseek-v4.1-flash-1017" });
    let turn = JSON.parse(await readFile(path.join(r.sessionDir("hp-turn"), "turn.json"), "utf8"));
    assert.equal(turn.turnEnded, false);
    assert.equal(turn.harness, "hermes");
    const usage = { input_tokens: 1200, output_tokens: 80, cache_read_tokens: 30000, cache_write_tokens: 0, reasoning_tokens: 0, prompt_tokens: 31200, total_tokens: 31280 };
    await p.hook("post_api_request", { api_request_id: "req-1", model: "deepseek/deepseek-v4.1-flash-1017", provider: "nous", usage, ended_at: 1762300000.5, assistant_tool_call_count: 1, turn_id: "t1" });
    turn = JSON.parse(await readFile(path.join(r.sessionDir("hp-turn"), "turn.json"), "utf8"));
    assert.equal(turn.context, 31200, "input + cache read + cache write");
    assert.equal(turn.lastInference, new Date(1762300000500).toISOString());
    assert.equal(turn.turnEnded, false, "a request that called a tool does not end the turn");
    await p.hook("post_auxiliary_call", { api_request_id: "aux-1", aux_task: "compression", model: "m", usage: null, ended_at: 1762300001 });
    await p.hook("post_api_request", { api_request_id: "sub-1", platform: "subagent", model: "m", usage, ended_at: 1762300002 });
    await p.hook("post_llm_call");
    turn = JSON.parse(await readFile(path.join(r.sessionDir("hp-turn"), "turn.json"), "utf8"));
    assert.equal(turn.turnEnded, true);
    assert.equal(turn.lastInference, new Date(1762300000500).toISOString(), "a subagent's request is not the session's inference");
    const lines = (await readFile(path.join(r.sessionDir("hp-turn"), "usage.hermes.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 3, "every request recorded: the loop's, the auxiliary's and the subagent's");
    const [main, aux, sub] = lines;
    assert.equal(main.harness, "hermes");
    assert.equal(main.sessionEpoch, "hp-turn");
    assert.equal(main.context.sourceId, "req-1");
    assert.deepEqual(main.envelope.usage, usage, "the hook's summary is kept verbatim");
    assert.deepEqual(main.counters.input, { state: "known", value: 1200, unit: "tokens" });
    assert.deepEqual(main.counters["cache-read"], { state: "known", value: 30000, unit: "tokens" });
    assert.equal(main.counters["cache-write-unknown-ttl"].state, "unknown", "a zero Hermes filled in is unknown, not 0");
    assert.equal(main.counters["cache-write-unknown-ttl"].value, undefined, "an unknown counter carries no number");
    assert.equal(main.counters.reasoning.state, "unknown");
    assert.equal(aux.auxiliary, true);
    assert.equal(aux.counters.input.state, "unknown", "no summary: every counter unknown");
    assert.equal(sub.subagent, true);
    assert.doesNotMatch(JSON.stringify(lines), /cost/i, "Hermes's own price estimate is never recorded as a source-reported cost");
  } finally { await p.close(); await r.cleanup(); }
});

test("hermes plugin: a session started at a position inherits its predecessor's cursor before the first read, never the head", { skip }, async () => {
  const r = await room();
  try {
    // the predecessor read up to "seen by the predecessor", then went away
    await r.agora("pred-key", ["cursor", "lab", "--now", "--json"]);
    await r.say("seen by the predecessor");
    await r.agora("pred-key", ["watch", "lab", "--once", "--json"]);
    await r.agora("pred-key", ["session", "--as", "desk.watch/Flash", "--label", "desk.watch", "--json"]);
    await r.say("owed by the predecessor");
    await writeInheritMarker(r.state, "desk.watch", { from: "pred-key", by: "cycle" });
    const p = await plugin(r, { AGORA_SESSION: "hp-succ", AGORA_ACTOR: "watch/Flash", AGORA_LABEL: "desk.watch" });
    try {
      await p.hook("on_session_start");
      await p.ask({ op: "arm" });
      const s = await p.state();
      assert.equal(s.inherit?.inherited, true, JSON.stringify(s.inherit));
      await p.tick();
      assert.deepEqual(texts(await p.sent()), ["owed by the predecessor"], "resumed at the predecessor's cursor");
    } finally { await p.close(); }
  } finally { await r.cleanup(); }
});

test("hermes plugin: with no AGORA_SESSION the key is hermes-<the first Hermes session id> and stays so across a compaction", { skip }, async () => {
  const r = await room();
  const p = await plugin(r, { AGORA_ACTOR: "probe/Flash" });
  try {
    assert.equal(p.reg.session, null, "no key before a hook names the session");
    assert.equal((await p.ask({ op: "arm" })).armed, false, "and no watch");
    await p.hook("on_session_start");
    assert.equal((await p.state()).session, `hermes-${HERMES_ID}`, "a 70-character Hermes id fits the session key");
    await p.ask({ op: "arm" });
    await p.hook("pre_llm_call", { session_id: "local-compacted-child" });
    const s = await p.state();
    assert.equal(s.session, `hermes-${HERMES_ID}`, "the agora key is pinned; only the injection route follows the new id");
    assert.equal(s.hermesSession, "local-compacted-child");
  } finally { await p.close(); await r.cleanup(); }
});

test("hermes plugin: an agora child gets an allowlisted environment, never a provider key", { skip }, async () => {
  const r = await room();
  const p = await plugin(r, { AGORA_SESSION: "hp-env", ANTHROPIC_FAKE_TEST_KEY: "x", NOUS_FAKE_TEST: "y", AGORA_FAKE_TOKEN: "z" });
  try {
    const env = (await p.ask({ op: "fn", name: "child_environment", args: [{ PATH: "/bin", ANTHROPIC_API_KEY: "sk-fake", NOUS_PORTAL_SESSION: "s", AGORA_STATE: "/s", AGORA_SLACK_TOKEN: "t", NODE_OPTIONS: "--x", HERMES_SESSION_ID: "h" }, { AGORA_SESSION: "k" }] })).value;
    assert.deepEqual(Object.keys(env).sort(), ["AGORA_SESSION", "AGORA_STATE", "NODE_OPTIONS", "PATH"]);
  } finally { await p.close(); await r.cleanup(); }
});

test("hermes plugin: in the gateway each session is its own resident, configured by its folder's .agora-room.json and never by the gateway's AGORA_* names", { skip }, async () => {
  const r = await room();
  try {
    const resident = path.join(r.dir, "resident-work");
    const adhoc = path.join(r.dir, "adhoc-work");
    await mkdir(resident, { recursive: true });
    await mkdir(adhoc, { recursive: true });
    await writeFile(path.join(resident, ".agora-room.json"), JSON.stringify({ v: 1, rooms: "lab", session: "hermes-probe.ds41-k1", actor: "probe/Flash41", deny: "terminal,process", pid: 4242,
      env: { AGORA_STATE: r.state, AGORA_CONFIG: r.config, AGORA_LABEL: "probe.ds41" } }));
    // the gateway process was started from a shell that named another session: that key is never taken
    const p = await plugin(r, { AGORA_SESSION: "the-gateway-launchers-key", AGORA_ACTOR: "Someone/else" });
    try {
      await p.ask({ op: "register" });
      const a = await p.ask({ op: "gateway", cwd: resident, kw: { session_id: HERMES_ID }, route: `agent:ab-ds41:local:dm:${HERMES_ID}` });
      assert.equal(a.session, "hermes-probe.ds41-k1");
      assert.deepEqual(a.rooms, ["lab"]);
      assert.equal(a.actor, "probe/Flash41");
      assert.deepEqual(a.deny, ["terminal", "process"]);
      assert.equal(a.pid, 4242, "liveness follows the resident's Hermes client, not the gateway");
      assert.equal(a.isDefault, false);
      // the same folder after a compaction (a new Hermes id) is the same resident
      const again = await p.ask({ op: "gateway", cwd: resident, kw: { session_id: "local-ffff" } });
      assert.equal(again.session, "hermes-probe.ds41-k1");
      assert.equal(again.residents, 1);
      // a session with no room file: tools only, keyed by its own Hermes id (the widened key holds it)
      const b = await p.ask({ op: "gateway", cwd: adhoc, kw: { session_id: HERMES_ID } });
      assert.equal(b.session, `hermes-${HERMES_ID}`);
      assert.deepEqual(b.rooms, []);
      assert.equal(b.actor, null, "the gateway's AGORA_ACTOR is not this session's bearer");
      assert.equal(b.residents, 2);
      const denied = await p.ask({ op: "hook", name: "pre_tool_call", kw: { tool_name: "terminal", args: {}, session_id: HERMES_ID } });
      assert.equal(denied.results[0], null, "the ad hoc session denies nothing");
    } finally { await p.close(); }
  } finally { await r.cleanup(); }
});

/** A pid that ran and is gone: a child spawned and waited for. */
function deadPid() {
  const pid = spawnSync(process.execPath, ["-e", ""], { windowsHide: true }).pid;
  assert.ok(pid, "a child ran");
  return /** @type {number} */ (pid);
}

/**
 * A resident's folder as `agora resident start` leaves it: the room file naming its key and its client's pid.
 * @param {Awaited<ReturnType<typeof room>>} r @param {string} name @param {Record<string, unknown>} fields
 */
async function residentFolder(r, name, fields) {
  const dir = path.join(r.dir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, ".agora-room.json"), JSON.stringify({ v: 1, rooms: "lab", actor: "probe/Flash", wake: "all",
    env: { AGORA_STATE: r.state, AGORA_CONFIG: r.config }, ...fields }));
  return dir;
}

test("hermes plugin: a plugin load in a restarted gateway resumes a live resident's watch: same agora key, Hermes session, route and cursor, no inherit, marked re-armed", { skip }, async () => {
  const r = await room();
  try {
    const profileHome = path.join(r.dir, "hermes", "profiles", "shadow-x");
    const route = `agent:shadow-x:local:dm:${HERMES_ID}`;
    // the resident's client is this test process: alive throughout, as the real client outlives the gateway
    const work = await residentFolder(r, "rearm-work", { session: "hermes-probe.rearm-k1", pid: process.pid, profile: "shadow-x",
      env: { AGORA_STATE: r.state, AGORA_CONFIG: r.config, AGORA_LABEL: "probe.rearm" } });
    // the first gateway: the watch armed at the session's first hook, delivered one line, then the gateway died
    const old = await plugin(r);
    let liveness;
    try {
      await old.ask({ op: "register", gateway: true, profile: "shadow-x", profileHome });
      await old.ask({ op: "gateway", cwd: work, kw: { session_id: HERMES_ID }, route });
      await old.ask({ op: "keyed", cwd: work, do: "arm" });
      await old.ask({ op: "keyed", cwd: work, do: "tick" });
      await r.say("before the restart");
      const k = await old.ask({ op: "keyed", cwd: work, do: "tick" });
      assert.deepEqual(texts(k.sent), ["before the restart"]);
      liveness = /** @type {string} */ (k.liveness);
    } finally { await old.close(); }
    const before = JSON.parse(await readFile(liveness, "utf8"));
    assert.equal(before.armed, true, "a gateway that dies runs no stop: its file still says armed");
    assert.equal(before.cwd, work);
    assert.equal(before.profile, "shadow-x");
    assert.equal(before.profileHome, profileHome);
    assert.equal(before.routeKey, route);
    assert.equal(typeof before.hostPid, "number");
    assert.equal(before.rearm, null);
    // a cycle meanwhile named this session the predecessor of its successor: a re-arm must not consume that
    const marker = await writeInheritMarker(r.state, "probe.rearm", { from: "hermes-probe.rearm-k1", by: "cycle" });
    await r.say("while no gateway ran");

    const next = await plugin(r);
    try {
      await next.ask({ op: "register", gateway: true, profile: "shadow-x", profileHome });
      const pass = await next.ask({ op: "rearm" });
      assert.deepEqual(pass.rearmed, ["hermes-probe.rearm-k1"], JSON.stringify(pass));
      assert.equal(pass.residents, 1);
      let k = await next.ask({ op: "keyed", cwd: work, do: "arm" });
      assert.equal(k.state.hermesSession, HERMES_ID, "the same Hermes session");
      assert.equal(k.state.routeKey, route, "and its route");
      assert.equal(k.state.rearm.count, 1);
      assert.equal(k.state.rearm.lastTickBefore, before.rooms[0].lastTick);
      assert.equal(k.state.inherit?.reason ?? null, before.inherit?.reason ?? null, "the first arming's inheritance is kept, not run again");
      const left = await readFile(path.join(r.state, "residents", "probe.rearm", "inherit.json"), "utf8").catch(() => null);
      assert.ok(left && JSON.parse(left).at === marker.at, "the successor's marker is left for the successor");
      k = await next.ask({ op: "keyed", cwd: work, do: "tick" });
      assert.deepEqual(texts(k.sent), ["while no gateway ran"], "resumed at its own cursor: the outage's line, nothing twice");
      assert.equal(k.sent[0].session_key, route);
      // the session's next hook reaches the re-armed watch, not a second one
      const h = await next.ask({ op: "gateway", cwd: work, kw: { session_id: HERMES_ID } });
      assert.equal(h.residents, 1);
      const after = JSON.parse(await readFile(liveness, "utf8"));
      assert.equal(after.rearm.count, 1);
      assert.equal(after.rearm.by, "plugin-load");
      assert.ok(Date.parse(after.rooms[0].lastTick) > Date.parse(before.rooms[0].lastTick), "the watch ticks again");
      // a second pass finds it watched here, and re-arms nothing twice
      assert.deepEqual((await next.ask({ op: "rearm" })).rearmed, []);
    } finally { await next.close(); }
  } finally { await r.cleanup(); }
});

test("hermes plugin: re-arm ignores a dead client, another profile, a superseded folder and an unarmed watch, and waits on a fresh file", { skip }, async () => {
  const r = await room();
  try {
    const mine = path.join(r.dir, "hermes", "profiles", "shadow-x");
    const theirs = path.join(r.dir, "hermes", "profiles", "shadow-y");
    const dir = path.join(r.home, ".agora", "hermes-room");
    await mkdir(dir, { recursive: true });
    const stale = new Date(Date.now() - 10 * 60000).toISOString();
    const gone = deadPid();
    /** @param {string} session @param {Record<string, unknown>} doc @param {Record<string, unknown>} [file] */
    const status = async (session, doc, file = {}) => {
      const cwd = await residentFolder(r, `w-${session}`, { session, pid: process.pid, ...file });
      await writeFile(path.join(dir, `${session}.json`), JSON.stringify({ plugin: "agora-room", harness: "hermes", session, pid: process.pid,
        watch: true, armed: true, intervalMs: 2000, rooms: [{ room: "lab", lastTick: stale }], updatedAt: stale, cwd, profile: "shadow-x",
        profileHome: mine, hostPid: gone, ...doc }));
    };
    await status("k-live", {});
    await status("k-dead-client", { pid: gone }, { pid: gone });
    await status("k-other-profile", { profile: "shadow-y", profileHome: theirs });
    await status("k-superseded", {}, { session: "k-successor" });
    await status("k-stopped", { armed: false });
    await status("k-fresh", { updatedAt: new Date().toISOString(), hostPid: process.pid });
    const p = await plugin(r);
    try {
      await p.ask({ op: "register", gateway: true, profile: "shadow-x", profileHome: mine });
      const pass = await p.ask({ op: "rearm" });
      assert.deepEqual(pass.rearmed, ["k-live"]);
      assert.deepEqual(pass.pending, ["k-fresh"], "a file another live process wrote moments ago may still be watched: asked again later");
      const why = Object.fromEntries(pass.skipped.map((/** @type {any} */ s) => [s.file.replace(/\.json$/, ""), s.reason]));
      assert.match(why["k-dead-client"], /not running/);
      assert.match(why["k-other-profile"], /another profile/);
      assert.match(why["k-superseded"], /superseded/);
      assert.match(why["k-stopped"], /not armed/);
      // the other profile's own load takes its own, and only that
      const q = await plugin(r);
      try {
        await q.ask({ op: "register", gateway: true, profile: "shadow-y", profileHome: theirs });
        assert.deepEqual((await q.ask({ op: "rearm" })).rearmed, ["k-other-profile"]);
      } finally { await q.close(); }
    } finally { await p.close(); }
  } finally { await r.cleanup(); }
});

test("hermes plugin: a liveness file an older plugin wrote (no folder, no profile) is placed through the resident's run record", { skip }, async () => {
  const r = await room();
  try {
    const mine = path.join(r.dir, "hermes", "profiles", "shadow-x");
    const work = await residentFolder(r, "legacy-work", { session: "k-legacy", pid: process.pid });
    const runDir = path.join(r.state, "residents", "probe.legacy");
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "run.json"), JSON.stringify({ type: "resident-run", resident: "probe.legacy", harness: "hermes",
      exec: { argv: ["hermes", "-p", "shadow-x", "chat", "--cli"], cwd: work, roomFile: path.join(work, ".agora-room.json") } }));
    const dir = path.join(r.home, ".agora", "hermes-room");
    await mkdir(dir, { recursive: true });
    const stale = new Date(Date.now() - 10 * 60000).toISOString();
    await writeFile(path.join(dir, "k-legacy.json"), JSON.stringify({ plugin: "agora-room", harness: "hermes", session: "k-legacy", hermesSession: HERMES_ID,
      pid: process.pid, watch: true, armed: true, intervalMs: 2000, rooms: [{ room: "lab", lastTick: stale }], updatedAt: stale,
      inherit: { position: "probe.legacy", inherited: true }, seen: { path: `${r.state.replace(/\\/g, "/")}/sessions/k-legacy/seen.jsonl` } }));
    const p = await plugin(r);
    try {
      await p.ask({ op: "register", gateway: true, profile: "shadow-y", profileHome: path.join(r.dir, "hermes", "profiles", "shadow-y") });
      assert.deepEqual((await p.ask({ op: "rearm" })).rearmed, [], "the run record's -p names another profile");
      await p.ask({ op: "register", gateway: true, profile: "shadow-x", profileHome: mine });
      const pass = await p.ask({ op: "rearm" });
      assert.deepEqual(pass.rearmed, ["k-legacy"], JSON.stringify(pass));
      const k = await p.ask({ op: "keyed", cwd: work, do: "flush" });
      assert.equal(k.state.hermesSession, HERMES_ID);
      const after = JSON.parse(await readFile(k.liveness, "utf8"));
      assert.equal(after.cwd, work, "the file now records its folder");
      assert.equal(after.profile, "shadow-x");
    } finally { await p.close(); }
  } finally { await r.cleanup(); }
});

test("hermes plugin: an injection the restarted gateway refuses reopens the resident's session once and is taken; a watch that still cannot deliver withholds its heartbeat", { skip }, async () => {
  const r = await room();
  try {
    const profileHome = path.join(r.dir, "hermes", "profiles", "shadow-x");
    const route = `agent:shadow-x:local:dm:${HERMES_ID}`;
    const work = await residentFolder(r, "revive-work", { session: "hermes-probe.revive-k1", pid: process.pid, profile: "shadow-x" });
    const p = await plugin(r);
    try {
      await p.ask({ op: "register", gateway: true, profile: "shadow-x", profileHome });
      await p.ask({ op: "fake-gateway", profile: "shadow-x", profileHome, restorable: [HERMES_ID] });
      await p.ask({ op: "gateway", cwd: work, kw: { session_id: HERMES_ID }, route });
      await p.ask({ op: "keyed", cwd: work, do: "arm" });
      await p.ask({ op: "keyed", cwd: work, do: "tick" });
      await r.say("to a closed session");
      let k = await p.ask({ op: "keyed", cwd: work, do: "tick" });
      assert.deepEqual(k.sent.map((/** @type {any} */ s) => s.accepted), [false, true], "refused, reopened, then taken");
      assert.deepEqual(texts(k.sent.filter((/** @type {any} */ s) => s.accepted)), ["to a closed session"]);
      assert.deepEqual((await p.ask({ op: "authority" })).restored, [HERMES_ID]);
      assert.equal(k.state.revive.reopened, 1);
      assert.equal(k.state.delivering, true);
      assert.equal(k.state.blockedSince, null);

      // the gateway closes it again and can no longer reopen it: the watch reads on, and says it is deaf
      await p.ask({ op: "authority", close: true, restorable: [] });
      await p.ask({ op: "keyed", cwd: work, values: { defer_after_ms: 0, blocked_deaf_ms: 0, revive_every_ms: 0 } });
      await r.say("nobody can take this");
      k = await p.ask({ op: "keyed", cwd: work, do: "tick" });
      assert.equal(k.state.queued, 1, "kept for when it can be handed over");
      assert.equal(k.state.delivering, false);
      assert.match(String(k.state.revive.lastError), /could not reopen/);
      const status = JSON.parse(await readFile(k.liveness, "utf8"));
      assert.equal(status.delivery.heartbeat, "withheld", "the liveness file says why the heartbeat stopped");
      const activity = path.join(r.sessionDir("hermes-probe.revive-k1"), ACTIVITY_FILE);
      const heartbeat = JSON.parse(await readFile(activity, "utf8")).updatedAt;
      await new Promise((res) => setTimeout(res, 20));
      await p.ask({ op: "hook", name: "post_tool_call", kw: { session_id: HERMES_ID } }); // dirties the record
      await p.ask({ op: "keyed", cwd: work, do: "tick" });
      assert.equal(JSON.parse(await readFile(activity, "utf8")).updatedAt, heartbeat, "no heartbeat while it cannot deliver: the cycle's deaf check fires");
      // a turn (the client came back and spoke) proves the session is served again
      await p.ask({ op: "hook", name: "pre_llm_call", kw: { session_id: HERMES_ID, model: "m" } });
      k = await p.ask({ op: "keyed", cwd: work });
      assert.equal(k.state.delivering, true);
    } finally { await p.close(); }
  } finally { await r.cleanup(); }
});

test("hermes plugin: an unload stops the copy's watches and leaves their files armed, so the next load resumes them", { skip }, async () => {
  const r = await room();
  try {
    const profileHome = path.join(r.dir, "hermes", "profiles", "shadow-x");
    const work = await residentFolder(r, "unload-work", { session: "hermes-probe.unload-k1", pid: process.pid, profile: "shadow-x" });
    const p = await plugin(r);
    try {
      await p.ask({ op: "register", gateway: true, profile: "shadow-x", profileHome });
      await p.ask({ op: "gateway", cwd: work, kw: { session_id: HERMES_ID }, route: `agent:shadow-x:local:dm:${HERMES_ID}` });
      await p.ask({ op: "keyed", cwd: work, do: "arm" });
      await p.ask({ op: "keyed", cwd: work, do: "tick" });
      await p.ask({ op: "unload" });
      const k = await p.ask({ op: "keyed", cwd: work });
      assert.equal(k.state.stopped, true);
      const doc = JSON.parse(await readFile(k.liveness, "utf8"));
      assert.equal(doc.armed, true, "an unload is not a deliberate stop");
      // the reloaded copy in the same process: the file is fresh and was written by this process, so it waits
      await p.ask({ op: "register", gateway: true, profile: "shadow-x", profileHome });
      let pass = await p.ask({ op: "rearm" });
      assert.deepEqual(pass.pending, ["hermes-probe.unload-k1"]);
      pass = await p.ask({ op: "rearm", now_ms: Date.now() + 60000 });
      assert.deepEqual(pass.rearmed, ["hermes-probe.unload-k1"], "once the old copy's file goes stale, the new copy resumes it");
    } finally { await p.close(); }
  } finally { await r.cleanup(); }
});
