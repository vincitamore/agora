// @ts-check
// The plain logic behind plugins/tern/agora (the Tern pane): its settings, the environment a CLI
// child gets, one room read folded into subjects (latest activity first, the unread baseline, your
// own posts never unread, whom a thread reply is addressed to), a subject's replies as a tree by
// their `re:` trailers, the board, residents, and a post landing where the compose card said it
// would (a reply carrying its `re:` and its thread), in process as the seat's human, through the
// CLI, or through a configured post command. Rooms are local files in a temporary root, or a real
// seat service for the in-process native path.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DATA_FILE, ENV, SEAT_ACTIONS, SESSION_KEY, THREAD_DEPTH_CAP, boardOf, childEnv, formatMessage, handle, loadView, pickAddressees, postFromPane, readDataFile,
  resolvePaneConfig, resolveSeats, residentRows, seatKindOf, subjectsOf, threadTree, writeHuman,
} from "../plugins/tern/agora/pane.mjs";
import { localTransport } from "../src/transports/local.mjs";
import { ROOM, seat as nativeSeat } from "./client-fixtures.mjs";
import { tmp } from "./helpers.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridge = path.join(root, "plugins", "tern", "agora", "bridge.mjs");

// ---- settings ----

test("settings: environment over the data file over the defaults; an empty value does not shadow", () => {
  const d = resolvePaneConfig();
  assert.deepEqual([d.rooms, d.room, d.config, d.post.command, d.intervalMs, d.problems], [[], null, null, null, 25000, []]);

  const file = { rooms: ["lab", "ops"], room: "ops", config: "/c.json", post: { command: ["agora", "--config", "/h.json"], env: { AGORA_STATE: "/h", N: 3 } }, intervalMs: 30000 };
  const f = resolvePaneConfig({ file });
  assert.deepEqual([f.rooms, f.room, f.config, f.post.command, f.post.env, f.intervalMs], [["lab", "ops"], "ops", "/c.json", ["agora", "--config", "/h.json"], { AGORA_STATE: "/h" }, 30000]);

  const env = { [ENV.rooms]: "a, b", [ENV.room]: "b", [ENV.config]: "/e.json", [ENV.postCommand]: '["node","/e/agora.mjs"]', [ENV.intervalMs]: "10000" };
  const e = resolvePaneConfig({ env, file });
  assert.deepEqual([e.rooms, e.room, e.config, e.post.command, e.intervalMs], [["a", "b"], "b", "/e.json", ["node", "/e/agora.mjs"], 10000]);

  const blank = resolvePaneConfig({ env: { [ENV.rooms]: "  ", [ENV.room]: "" }, file: { rooms: "lab", room: "lab" } });
  assert.deepEqual([blank.rooms, blank.room], [["lab"], "lab"]);
});

test("settings: bad values fall back and say so", () => {
  const bad = resolvePaneConfig({ env: { [ENV.rooms]: "lab,-x", [ENV.room]: "-y", [ENV.intervalMs]: "10" }, file: { post: { env: { A: "1" } } } });
  assert.deepEqual(bad.rooms, ["lab"], "an alias that starts with a dash is refused");
  assert.equal(bad.room, null);
  assert.equal(bad.intervalMs, 5000, "the interval is clamped");
  assert.equal(bad.problems.length, 3, bad.problems.join(" | "));
  assert.match(bad.problems.join(" "), /post\.env is set without post\.command/);
  assert.equal(resolvePaneConfig({ env: { [ENV.intervalMs]: "x" } }).intervalMs, 25000);
});

test("data file: missing is no file; invalid JSON or a non-object is a problem, not a crash", async () => {
  const { dir, cleanup } = await tmp();
  try {
    assert.deepEqual(readDataFile(path.join(dir, "none.json")), { file: null, problem: null });
    assert.deepEqual(readDataFile(null), { file: null, problem: null });
    const bad = path.join(dir, "bad.json");
    await writeFile(bad, "{ nope");
    assert.match(readDataFile(bad).problem ?? "", /bad\.json is not valid JSON/);
    const arr = path.join(dir, "arr.json");
    await writeFile(arr, "[1]");
    assert.match(readDataFile(arr).problem ?? "", /must hold one JSON object/);
  } finally { await cleanup(); }
});

test("child environment: the daemon's bearer, session and position never reach a CLI child", () => {
  const base = { PATH: "/bin", AGORA_ACTOR: "Some Agent", AGORA_SESSION: "agent-session", AGORA_LABEL: "desk.coding", AGORA_STATE: "/s" };
  const env = childEnv(base, { AGORA_CONFIG: "/h.json" });
  assert.deepEqual(env, { PATH: "/bin", AGORA_STATE: "/s", AGORA_SESSION: SESSION_KEY, AGORA_CONFIG: "/h.json" });
});

// ---- pure folds ----

/** @param {Partial<import('../plugins/tern/agora/pane.mjs').PaneMessage> & { id: string }} p @returns {import('../plugins/tern/agora/pane.mjs').PaneMessage} */
function pm(p) {
  return /** @type {any} */ ({ thread: null, author: { id: "", name: "Ada", kind: "agent" }, signedAs: null, speaker: p.author?.name ?? "Ada", seat: "", ts: "", rawTs: "", cursor: p.id, derived: "", note: "", re: [], title: null, body: "", attachmentText: "", trailers: [], to: [], ...p });
}

test("addressing: a reply goes to the agents on the root author's seat who spoke in the thread, never a human or the sender", () => {
  const host = "acct-host";
  assert.equal(seatKindOf("m-abc", host), "member");
  assert.equal(seatKindOf(host, host), "host");
  assert.equal(seatKindOf("other", host), "");
  const msgs = [
    pm({ id: "r", author: { id: "m-1", name: "Lin", kind: "agent" } }),
    pm({ id: "a", thread: "r", author: { id: "m-1", name: "Lin", kind: "agent" }, signedAs: "Lin/watch" }),
    pm({ id: "b", thread: "r", author: { id: host, name: "Ada", kind: "agent" } }),
    pm({ id: "c", thread: "r", author: { id: "m-2", name: "Zed", kind: "agent" } }),
    pm({ id: "d", thread: "r", author: { id: "m-3", name: "Grace", kind: "human" } }),
    pm({ id: "h", author: { id: "m-3", name: "Grace", kind: "human" } }),
  ];
  assert.deepEqual(pickAddressees(msgs, "r", null, host), ["Lin", "Lin/watch", "Zed"], "member accounts are one seat kind");
  assert.deepEqual(pickAddressees(msgs, "r", "Zed", host), ["Lin", "Lin/watch"]);
  assert.deepEqual(pickAddressees(msgs, "h", null, host), [], "a human root addresses nobody: the person picks");
  assert.deepEqual(pickAddressees(msgs, "gone", null, host), [], "a root outside the window addresses nobody");
});

test("board: claims, releases, verdicts and withdrawals; speakers newest first; watching only from this seat", () => {
  const t = (/** @type {string} */ key, /** @type {string} */ value) => ({ key, value });
  const msgs = [
    pm({ id: "1", author: { id: "", name: "Ada", kind: "agent" }, speaker: "Ada", trailers: [t("claim", "the parser")] }),
    pm({ id: "2", author: { id: "", name: "Lin", kind: "agent" }, speaker: "Lin", trailers: [t("claim", "the docs")] }),
    pm({ id: "3", author: { id: "", name: "Lin", kind: "agent" }, speaker: "Lin", trailers: [t("withdraws", "2")] }),
    pm({ id: "4", author: { id: "", name: "Ada", kind: "agent" }, speaker: "Ada", trailers: [t("release", "the parser"), t("verdict", "pass"), t("exhibit", "test/a.mjs"), t("exhibit", "log"), t("because", "green")] }),
    pm({ id: "5", author: { id: "", name: "Grace", kind: "human" }, speaker: "Grace" }),
  ];
  const b = boardOf(msgs, new Set(["Ada", "Grace"]));
  assert.deepEqual(b.claims.map((c) => [c.subject, c.status]), [["the docs", "withdrawn"], ["the parser", "released"]]);
  assert.deepEqual(b.verdicts.map((v) => [v.verdict, v.exhibit, v.because, v.status]), [["pass", "test/a.mjs · log", "green", "standing"]]);
  assert.deepEqual(b.who.map((w) => [w.speaker, w.count, w.watching]), [["Grace", 1, false], ["Ada", 2, true], ["Lin", 2, false]], "a human is never 'watching'");
  const changed = boardOf([pm({ id: "a", speaker: "Grace", author: { id: "", name: "Grace", kind: "agent" } }), pm({ id: "b", speaker: "Grace", author: { id: "", name: "Grace", kind: "human" } })], new Set());
  assert.equal(changed.who[0].kind, "human", "a speaker's kind is the one their latest message carries");
});

test("residents: the config's table, each with the live sessions that hold its position, else idle", () => {
  const cfg = { residents: { "desk.coding": { restart: "run {slug}" }, triage: {} } };
  const s = (/** @type {string} */ bearer, /** @type {string} */ label, /** @type {string} */ state) => ({ slug: bearer, record: { bearer, label }, bearer, label, pid: 1, state, lastSeen: "2026-01-01 00:00", rooms: [], threadCount: 0, armed: [] });
  const rows = residentRows(cfg, [s("Ada/Opus", "desk.coding", "live"), s("Lin", "desk.coding", "dark"), s("Zed", "other", "live")]);
  assert.deepEqual(rows.map((r) => [r.slug, r.state, r.bearer, r.restart]), [["desk.coding", "live", "Ada/Opus", "set"], ["triage", "idle", "", ""]]);
});

// ---- a room ----

/** A temporary seat: a config with two local rooms, its own state root, the bridge's data folder. */
async function seat() {
  const { dir, cleanup } = await tmp();
  const state = path.join(dir, "state");
  const config = path.join(dir, "config.json");
  const rooms = { lab: { transport: "local", path: path.join(dir, "lab.ndjson") }, ops: { transport: "local", path: path.join(dir, "ops.ndjson"), note: "operations" } };
  await writeFile(config, JSON.stringify({ actor: { name: "Config Actor", kind: "agent" }, state, rooms, residents: { triage: {} } }));
  const prior = process.env.AGORA_STATE;
  process.env.AGORA_STATE = state;
  const pc = resolvePaneConfig({ file: { config } });
  /** @param {string} name @param {string} text @param {string} [thread] */
  const other = async (name, text, thread) => {
    const t = localTransport({ transport: "local", path: rooms.lab.path }, { actor: { name, kind: "agent" } });
    const r = /** @type {any} */ (await t.post(`${text}\n\n-- ${name}`, thread ? { thread } : {}));
    return /** @type {string} */ (r.id);
  };
  return {
    dir, config, state, pc, other,
    cleanup: async () => {
      if (prior === undefined) delete process.env.AGORA_STATE; else process.env.AGORA_STATE = prior;
      await cleanup();
    },
  };
}

/** @param {any} view @returns {string[]} */
const titles = (view) => view.subjects.map((/** @type {any} */ s) => s.title);

test("view: every configured room, the default room, subjects by latest activity with replies and the last speaker", async () => {
  const s = await seat();
  try {
    const a = await s.other("Bea", "Subject A");
    await s.other("Bea", "Subject B");
    await s.other("Lin", "a reply in A", a);
    const view = /** @type {any} */ (await loadView({ pc: s.pc }));
    assert.equal(view.ok, true, JSON.stringify(view.fault));
    assert.deepEqual(view.rooms.map((/** @type {any} */ r) => [r.alias, r.transport, r.note]), [["lab", "local", ""], ["ops", "local", "operations"]]);
    assert.equal(view.room, "lab", "no native room: the first configured one");
    assert.deepEqual(titles(view), ["Subject A", "Subject B"]);
    const sa = view.subjects[0];
    assert.deepEqual([sa.replies, sa.lastFrom, sa.unread], [1, "Lin", 0], "a first open marks nothing unread");
    assert.match(sa.meta, /^Lin · 1 reply · \d+s$/);
    assert.deepEqual(sa.messages.map((/** @type {any} */ m) => m.body), ["Subject A", "a reply in A"], "the signature is not part of the body");
    assert.deepEqual(sa.autoTo, ["Bea", "Lin"], "a reply in A goes to the agents in it");
    const long = `A subject whose first line runs well past the eighty characters a row has room for, ending here`;
    await s.other("Bea", long);
    const withLong = /** @type {any} */ (await loadView({ pc: s.pc }));
    assert.equal(withLong.subjects[0].fullTitle, long, "the compose card states the subject in full");
    assert.ok(withLong.subjects[0].title.length <= 80 && withLong.subjects[0].title.endsWith("…"), "the row's title is cut");
    assert.equal(view.human.needsName, true);
    assert.deepEqual(view.residents.map((/** @type {any} */ r) => [r.slug, r.state]), [["triage", "idle"]]);
    assert.equal(view.posting.via, "local");

    const only = /** @type {any} */ (await loadView({ pc: resolvePaneConfig({ file: { config: s.config, rooms: ["ops"] } }), room: "lab" }));
    assert.deepEqual([only.room, only.rooms.length], ["ops", 1], "a room the settings do not offer is not shown");
    assert.match(only.problems.join(" "), /not one the pane offers/);
  } finally { await s.cleanup(); }
});

test("view: later posts are unread except your own; the seen marks clear a subject", async () => {
  const s = await seat();
  try {
    const a = await s.other("Bea", "Subject A");
    const named = /** @type {any} */ (await handle("set-name", { file: null, env: { ...process.env, [ENV.config]: s.config }, input: { name: "Grace" } }));
    assert.deepEqual(named, { ok: true, human: { name: "Grace", kind: "human" } });
    const first = /** @type {any} */ (await loadView({ pc: s.pc }));
    assert.equal(first.self, "Grace");

    const mine = /** @type {any} */ (await postFromPane({ pc: s.pc, room: "lab", text: "my own subject" }));
    assert.equal(mine.ok, true, JSON.stringify(mine));
    await s.other("Bea", "news in A", a);
    const input = { hasBaseline: true, baselineId: first.baselineId, seen: {} };
    const next = /** @type {any} */ (await loadView({ pc: s.pc, input }));
    const by = (/** @type {string} */ id) => next.subjects.find((/** @type {any} */ x) => x.id === id);
    assert.equal(by(a).unread, 1);
    assert.equal(by(mine.receipt.id).unread, 0, "your own post is never unread");
    assert.equal(by(mine.receipt.id).messages[0].mine, true);
    assert.equal(by(a).messages[0].mine, false);

    const cleared = /** @type {any} */ (await loadView({ pc: s.pc, input: { ...input, seen: { [a]: by(a).latestId } } }));
    assert.equal(cleared.subjects.find((/** @type {any} */ x) => x.id === a).unread, 0);
  } finally { await s.cleanup(); }
});

test("post: in process as the seat's human, exactly where the card said, addressed; bad drafts refused", async () => {
  const s = await seat();
  try {
    const noName = /** @type {any} */ (await postFromPane({ pc: s.pc, room: "lab", text: "hello" }));
    assert.match(noName.error, /no name yet/);
    await handle("set-name", { env: { ...process.env, [ENV.config]: s.config }, input: { name: "Grace" } });
    const a = await s.other("Bea", "Subject A");
    const b = await s.other("Bea", "Subject B");

    const reply = /** @type {any} */ (await postFromPane({ pc: s.pc, room: "lab", text: "an answer for Bea", thread: b, to: ["Bea"] }));
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.deepEqual(reply.to, ["Bea"]);
    const typed = /** @type {any} */ (await postFromPane({ pc: s.pc, room: "lab", text: "a typed line wins\n\nto: Lin", thread: a, to: ["Bea"] }));
    assert.deepEqual(typed.to, ["Lin"], "a `to:` line typed in the draft wins over the card's");

    const view = /** @type {any} */ (await loadView({ pc: s.pc }));
    const sub = (/** @type {string} */ id) => view.subjects.find((/** @type {any} */ x) => x.id === id);
    const answer = sub(b).messages[1];
    assert.deepEqual([answer.body, answer.from, answer.kind, answer.to], ["an answer for Bea", "Grace", "human", ["Bea"]]);
    assert.deepEqual(sub(a).messages.map((/** @type {any} */ m) => m.body), ["Subject A", "a typed line wins"]);

    for (const [text, why] of [["   ", /draft is empty/], ["token xoxb-1234567890-abcdefghijklmnop", /credential shape/]]) {
      const r = /** @type {any} */ (await postFromPane({ pc: s.pc, room: "lab", text: /** @type {string} */ (text) }));
      assert.match(r.error, /** @type {RegExp} */ (why));
    }
    assert.match((/** @type {any} */ (await postFromPane({ pc: s.pc, room: "elsewhere", text: "x" }))).error, /not one the pane offers/);
  } finally { await s.cleanup(); }
});

test("post: with a post command (a member seat's human), the post and the name go through it, under the pane's session", async () => {
  const s = await seat();
  try {
    /** @type {Array<{ argv: string[], env: Record<string, string> | undefined }>} */
    const calls = [];
    /** @type {import('../plugins/tern/agora/pane.mjs').Run} */
    const run = async (argv, opts = {}) => {
      calls.push({ argv, env: opts.env });
      if (argv.includes("whoami")) return { code: 0, stdout: '{"type":"whoami","name":"Grace"}\n', stderr: "" };
      return { code: 0, stdout: '{"type":"post","id":"m9","cursor":"9"}\n', stderr: "" };
    };
    const pc = resolvePaneConfig({ file: { config: s.config, post: { command: ["agora", "--config", "/human/config.json"], env: { AGORA_STATE: "/human/state" } } } });
    const env = { ...process.env, AGORA_ACTOR: "Daemon Agent" };
    const r = /** @type {any} */ (await postFromPane({ pc, room: "lab", text: "from my own key", thread: "m1", to: ["Bea"], env, run }));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(calls[0].argv, ["agora", "--config", "/human/config.json", "post", "lab", "--json", "--thread", "m1", "--to", "Bea", "--", "from my own key"]);
    assert.equal(calls[0].env?.AGORA_STATE, "/human/state");
    assert.equal(calls[0].env?.AGORA_SESSION, SESSION_KEY);
    assert.equal(calls[0].env?.AGORA_ACTOR, undefined, "the daemon's bearer never signs the person's post");

    const view = /** @type {any} */ (await loadView({ pc, env, run }));
    assert.equal(view.self, "Grace", "the name the pane marks as yours is what the post command's config says");
    assert.equal(view.posting.via, "command");
    assert.deepEqual(calls[1].argv, ["agora", "--config", "/human/config.json", "whoami", "lab", "--json"]);
    const cached = /** @type {any} */ (await loadView({ pc, env, run, input: { self: "Grace" } }));
    assert.equal(cached.self, "Grace");
    assert.equal(calls.length, 2, "a name the pane already holds is not asked again");
  } finally { await s.cleanup(); }
});

test("seat actions run the checkout's CLI with the pane's session; a failure is an error line", async () => {
  /** @type {string[][]} */
  const seen = [];
  /** @type {import('../plugins/tern/agora/pane.mjs').Run} */
  const run = async (argv) => {
    seen.push(argv);
    return argv.includes("stop") ? { code: 2, stdout: "", stderr: "no service\n" } : { code: 0, stdout: '{"ok":true}', stderr: "" };
  };
  const ok = /** @type {any} */ (await handle("resident-cycle-dry", { env: {}, run }));
  assert.equal(ok.ok, true);
  assert.deepEqual(seen[0].slice(-5), [...SEAT_ACTIONS["resident-cycle-dry"]]);
  assert.equal(seen[0][1], path.join(root, "bin", "agora.mjs"), "the CLI of the checkout the plugin is linked from");
  const bad = /** @type {any} */ (await handle("service-stop", { env: {}, run }));
  assert.deepEqual([bad.ok, bad.error], [false, "agora service-stop failed (2): no service"]);
  assert.equal((/** @type {any} */ (await handle("nope", {}))).ok, false);
});

test("bridge.mjs: one JSON object on stdout for rooms, view, set-name and post, settings from the data folder", async () => {
  const s = await seat();
  try {
    await writeFile(path.join(s.dir, DATA_FILE), JSON.stringify({ config: s.config, rooms: ["lab", "ops"] }));
    const env = { ...process.env, AGORA_STATE: s.state, AGORA_ACTOR: "Daemon Agent", AGORA_SESSION: "daemon-session" };
    /** @param {string[]} args @param {unknown} [input] @returns {Promise<any>} */
    const call = (args, input) => new Promise((resolve, reject) => {
      const child = execFile(process.execPath, [bridge, ...args, "--data", s.dir], { env, timeout: 30000 }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve(JSON.parse(stdout.trim()))));
      child.stdin?.end(input === undefined ? "" : JSON.stringify(input));
    });
    const rooms = await call(["rooms"]);
    assert.deepEqual([rooms.ok, rooms.rooms.map((/** @type {any} */ r) => r.alias), rooms.room], [true, ["lab", "ops"], "lab"]);
    assert.equal((await call(["set-name"], { name: "Grace" })).ok, true);
    const posted = await call(["post", "--room", "ops"], { text: "from the bridge" });
    assert.equal(posted.ok, true, JSON.stringify(posted));
    const view = await call(["view", "--room", "ops"], { hasBaseline: false });
    assert.equal(view.ok, true, JSON.stringify(view));
    assert.deepEqual([view.room, view.subjects[0].messages[0].from, view.subjects[0].messages[0].mine], ["ops", "Grace", true], "signed as the seat's human, not the daemon's bearer");
    const reply = await call(["post", "--room", "ops", "--thread", posted.receipt.id, "--to", "Ada"], { text: "a reply" });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    const again = await call(["view", "--room", "ops"], { hasBaseline: true, baselineId: view.baselineId });
    assert.deepEqual(again.subjects[0].messages.map((/** @type {any} */ m) => [m.body, m.to]), [["from the bridge", []], ["a reply", ["Ada"]]]);
  } finally { await s.cleanup(); }
});

// ---- threads: replies nested under what they answer ----

/** @param {string} id @param {string} from @param {string[]} [re] @param {string} [cursor] */
const reply = (id, from, re = [], cursor = id) => pm({ id, cursor, re, author: { id: "", name: from, kind: "agent" } });
/** @param {ReturnType<typeof threadTree>} tree */
const shape = (tree) => tree.map((n) => [n.m.id, n.depth, n.parent]);

test("formatMessage: `re` names what a message answers, and the one trailer line leaves out what the header and the indentation already say", () => {
  const m = formatMessage({ id: "m5", cursor: "5", ts: "2026-01-01T00:00:00Z", author: { id: "a", name: "Ada", kind: "agent" }, text: "hi\n\nto: Bea\nre: m1, m2\nclaim: tidy up" }, "");
  assert.deepEqual([m.re, m.to, m.note], [["m1", "m2"], ["Bea"], "→ claim tidy up"]);
  const plain = formatMessage({ id: "m6", cursor: "6", ts: "2026-01-01T00:00:00Z", author: { id: "a", name: "Ada", kind: "agent" }, text: "no block here" }, "");
  assert.deepEqual([plain.re, plain.note], [[], ""]);
});

test("thread tree: an answer sits right under what it answers, children and plain replies each in time order", () => {
  const tree = threadTree([
    reply("r", "Bea"), reply("a", "Ada"), reply("b", "Lin", ["a"]), reply("c", "Cy"), reply("d", "Di", ["b"]), reply("e", "Ed", ["r"]), reply("f", "Fy", ["a"]),
  ], { rootId: "r" });
  assert.deepEqual(shape(tree), [["r", 0, null], ["a", 0, null], ["b", 1, "a"], ["d", 2, "b"], ["f", 1, "a"], ["c", 0, null], ["e", 0, null]], "`re` naming the subject itself is a plain reply");
  assert.deepEqual(Object.fromEntries(tree.map((n) => [n.m.id, n.rank])), { r: 7, a: 6, b: 5, c: 4, d: 3, e: 2, f: 1 }, "rank counts from the newest message by time, not by drawing order");
  assert.ok(tree.every((n) => n.cue === ""));
});

test("thread tree: an `re:` is read by id or by cursor; the subject's own cursor is still the subject", () => {
  const tree = threadTree([reply("r", "Bea", [], "c1"), reply("a", "Ada", ["c1"], "c2"), reply("b", "Lin", ["c2"], "c3")], { rootId: "r" });
  assert.deepEqual(shape(tree), [["r", 0, null], ["a", 0, null], ["b", 1, "a"]]);
});

test("thread tree: an `re:` that names nothing in the subject is an orphan at depth 0 with a cue, never dropped; its own answers still nest under it", () => {
  const outside = (/** @type {string} */ name) => (name === "elsewhere" ? "Lin" : null);
  const tree = threadTree([
    reply("r", "Bea"), reply("o1", "Ada", ["elsewhere"]), reply("p", "Cy", ["o1"]), reply("o2", "Di", ["nowhere"]), reply("q", "Ed", ["later"]), reply("later", "Fy"),
  ], { rootId: "r", outside });
  assert.deepEqual(shape(tree), [["r", 0, null], ["o1", 0, null], ["p", 1, "o1"], ["o2", 0, null], ["q", 0, null], ["later", 0, null]], "a forward reference cannot nest: its parent is not yet said");
  assert.deepEqual(Object.fromEntries(tree.map((n) => [n.m.id, n.cue])), {
    r: "", o1: "↳ reply to Lin (not shown)", p: "", o2: "↳ reply to an earlier message (not shown)", q: "↳ reply to an earlier message (not shown)", later: "",
  });
});

test("thread tree: a subject whose root is outside the window still takes `re:` of that root as a plain reply", () => {
  const tree = threadTree([reply("a", "Ada", ["gone-root"]), reply("b", "Lin", ["a"])], { rootId: "gone-root" });
  assert.deepEqual(shape(tree), [["a", 0, null], ["b", 1, "a"]]);
});

test("thread tree: depth is capped, and a deeper reply stays at the cap with a cue naming whom it answers", () => {
  assert.equal(THREAD_DEPTH_CAP, 4);
  const tree = threadTree([
    reply("r", "Bea"), reply("a", "Ada"), reply("b", "Bea", ["a"]), reply("c", "Cy", ["b"]), reply("d", "Di", ["c"]), reply("e", "Ed", ["d"]), reply("f", "Fy", ["e"]), reply("g", "Gus", ["f"]),
  ], { rootId: "r" });
  assert.deepEqual(tree.map((n) => n.depth), [0, 0, 1, 2, 3, 4, 4, 4]);
  assert.deepEqual(tree.map((n) => n.cue), ["", "", "", "", "", "", "↳ Ed", "↳ Fy"]);
  assert.deepEqual(tree.map((n) => n.parent), [null, null, "a", "b", "c", "d", "e", "f"], "`parent` is the real one, so a view that shows part of the thread can keep what a message answers");
  assert.equal(threadTree([reply("r", "Bea"), reply("a", "Ada"), reply("b", "Bea", ["a"]), reply("c", "Cy", ["b"])], { rootId: "r", cap: 1 })[3].depth, 1);
});

test("view: replies posted as replies nest in the subject; a typed `re:` and a typed trailer block are kept, never doubled", async () => {
  const s = await seat();
  try {
    await handle("set-name", { env: { ...process.env, [ENV.config]: s.config }, input: { name: "Grace" } });
    const root = await s.other("Bea", "Subject");
    const plain = await s.other("Lin", "a plain answer", root);
    const toLin = /** @type {any} */ (await postFromPane({ pc: s.pc, room: "lab", text: "an answer for Lin", thread: root, replyTo: plain, to: ["Lin"] }));
    assert.equal(toLin.ok, true, JSON.stringify(toLin));
    assert.deepEqual([toLin.receipt.thread, toLin.receipt.re, toLin.to], [root, plain, ["Lin"]]);
    const deeper = /** @type {any} */ (await postFromPane({ pc: s.pc, room: "lab", text: "and a claim on that\n\nclaim: tidy up", thread: root, replyTo: toLin.receipt.id }));
    const typed = /** @type {any} */ (await postFromPane({ pc: s.pc, room: "lab", text: "typed wins\n\nre: somewhere-else", thread: root, replyTo: plain }));
    assert.equal(typed.receipt.re, null, "a typed `re:` wins over the card's");

    const view = /** @type {any} */ (await loadView({ pc: s.pc }));
    const messages = view.subjects[0].messages;
    assert.deepEqual(messages.map((/** @type {any} */ m) => [m.body, m.depth, m.parent, m.cue]), [
      ["Subject", 0, null, ""],
      ["a plain answer", 0, null, ""],
      ["an answer for Lin", 1, plain, ""],
      ["and a claim on that", 2, toLin.receipt.id, ""],
      ["typed wins", 0, null, "↳ reply to an earlier message (not shown)"],
    ]);
    const claim = messages[3];
    assert.equal(claim.note, "→ claim tidy up", "one trailer block: the card's `re` joined the typed `claim`");
    assert.deepEqual([messages[2].to, claim.mine, messages[2].mine], [["Lin"], true, true]);
    assert.deepEqual(messages.map((/** @type {any} */ m) => m.rank), [5, 4, 3, 2, 1]);
    assert.ok(deeper.ok);
  } finally { await s.cleanup(); }
});

test("post: a reply needs its subject and a message id; no reply, no `re`", async () => {
  const s = await seat();
  try {
    await handle("set-name", { env: { ...process.env, [ENV.config]: s.config }, input: { name: "Grace" } });
    const root = await s.other("Bea", "Subject");
    assert.match((/** @type {any} */ (await postFromPane({ pc: s.pc, room: "lab", text: "x", replyTo: root }))).error, /needs the subject it is in/);
    assert.match((/** @type {any} */ (await postFromPane({ pc: s.pc, room: "lab", text: "x", thread: root, replyTo: "a b\n" }))).error, /not a message id/);
    const none = /** @type {any} */ (await postFromPane({ pc: s.pc, room: "lab", text: "just a reply", thread: root }));
    assert.equal(none.receipt.re, null);
    const view = /** @type {any} */ (await loadView({ pc: s.pc }));
    assert.deepEqual(view.subjects[0].messages.map((/** @type {any} */ m) => [m.depth, m.cue]), [[0, ""], [0, ""]]);
  } finally { await s.cleanup(); }
});

test("post: a reply writes `--thread` and `--re` through a post command and through the CLI", async () => {
  const s = await seat();
  try {
    /** @type {string[][]} */
    const argvs = [];
    /** @type {import('../plugins/tern/agora/pane.mjs').Run} */
    const run = async (argv) => {
      argvs.push(argv);
      return { code: 0, stdout: '{"type":"post","id":"m9","cursor":"9","thread":"t1"}\n', stderr: "" };
    };
    const viaCommand = resolvePaneConfig({ file: { config: s.config, post: { command: ["agora", "--config", "/human/config.json"] } } });
    const a = /** @type {any} */ (await postFromPane({ pc: viaCommand, room: "lab", text: "an answer", thread: "t1", replyTo: "m0", to: ["Bea"], run }));
    assert.deepEqual(argvs[0], ["agora", "--config", "/human/config.json", "post", "lab", "--json", "--thread", "t1", "--re", "m0", "--to", "Bea", "--", "an answer"]);
    assert.deepEqual([a.ok, a.receipt.re], [true, "m0"]);
    await postFromPane({ pc: viaCommand, room: "lab", text: "typed\n\nre: m3", thread: "t1", replyTo: "m0", run });
    assert.ok(!argvs[1].includes("--re"), "a typed `re:` is the person's; no second one is added");

    await handle("set-name", { env: { ...process.env, [ENV.config]: s.config }, input: { name: "Grace" } });
    await writeFile(s.config, JSON.stringify({ actor: { name: "Config Actor", kind: "agent" }, state: s.state, rooms: { gh: { transport: "github", repo: "acme/widgets", issue: 7 } } }));
    const cli = resolvePaneConfig({ file: { config: s.config } });
    const b = /** @type {any} */ (await postFromPane({ pc: cli, room: "gh", text: "an answer", thread: "t1", replyTo: "m0", run }));
    assert.equal(b.ok, true, JSON.stringify(b));
    assert.deepEqual(argvs[2].slice(argvs[2].indexOf("post")), ["post", "gh", "--json", "--thread", "t1", "--re", "m0", "--as", "Grace", "--", "an answer"]);
  } finally { await s.cleanup(); }
});

test("post: in process on a native room a reply carries `re:` above the signature, in its thread, and nests in the view", { timeout: 30_000 }, async (t) => {
  const n = await nativeSeat(t);
  const prior = process.env.AGORA_STATE;
  process.env.AGORA_STATE = n.root;
  t.after(() => { if (prior === undefined) delete process.env.AGORA_STATE; else process.env.AGORA_STATE = prior; });
  writeHuman(n.root, "Grace");
  const config = path.join(n.root, "pane.json");
  await writeFile(config, JSON.stringify({ actor: { name: "Config Actor", kind: "agent" }, state: n.root, rooms: { lab: { transport: "native", roomId: ROOM } } }));
  const pc = resolvePaneConfig({ file: { config, rooms: ["lab"] } });
  const first = /** @type {any} */ (await postFromPane({ pc, room: "lab", text: "a subject" }));
  assert.equal(first.ok, true, JSON.stringify(first));
  const a = /** @type {any} */ (await postFromPane({ pc, room: "lab", text: "a plain answer", thread: first.receipt.id }));
  const b = /** @type {any} */ (await postFromPane({ pc, room: "lab", text: "an answer to the answer", thread: first.receipt.id, replyTo: a.receipt.id, to: ["Ada"] }));
  assert.equal(b.ok, true, JSON.stringify(b));

  const app = await n.open();
  const { messages } = await app.read({ roomId: ROOM });
  const sent = /** @type {any} */ (messages.find((m) => m.id === b.receipt.id));
  assert.equal(sent.thread, first.receipt.id);
  assert.deepEqual(sent.trailers, [{ key: "to", value: "Ada" }, { key: "re", value: a.receipt.id }]);
  assert.match(sent.text, /\n\nto: Ada\nre: [a-f0-9]{64}\n\n-- Grace$/, "the block is above the signature");
  assert.ok(!(/** @type {any} */ (messages.find((m) => m.id === a.receipt.id))).trailers?.length, "a plain thread reply carries no `re:`");

  const view = /** @type {any} */ (await loadView({ pc, room: "lab" }));
  assert.deepEqual(view.subjects[0].messages.map((/** @type {any} */ m) => [m.body, m.depth]), [["a subject", 0], ["a plain answer", 0], ["an answer to the answer", 1]]);
});

test("bridge.mjs: post --thread --re is a reply the next view nests", async () => {
  const s = await seat();
  try {
    await writeFile(path.join(s.dir, DATA_FILE), JSON.stringify({ config: s.config, rooms: ["lab", "ops"] }));
    const env = { ...process.env, AGORA_STATE: s.state };
    /** @param {string[]} args @param {unknown} [input] @returns {Promise<any>} */
    const call = (args, input) => new Promise((resolve, reject) => {
      const child = execFile(process.execPath, [bridge, ...args, "--data", s.dir], { env, timeout: 30000 }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve(JSON.parse(stdout.trim()))));
      child.stdin?.end(input === undefined ? "" : JSON.stringify(input));
    });
    await call(["set-name"], { name: "Grace" });
    const root = await call(["post", "--room", "ops"], { text: "a subject" });
    const one = await call(["post", "--room", "ops", "--thread", root.receipt.id], { text: "an answer" });
    const two = await call(["post", "--room", "ops", "--thread", root.receipt.id, "--re", one.receipt.id], { text: "an answer to it" });
    assert.equal(two.ok, true, JSON.stringify(two));
    const view = await call(["view", "--room", "ops"], { hasBaseline: false });
    assert.deepEqual(view.subjects[0].messages.map((/** @type {any} */ m) => [m.body, m.depth, m.parent]), [["a subject", 0, null], ["an answer", 0, null], ["an answer to it", 1, one.receipt.id]]);
  } finally { await s.cleanup(); }
});

test("seat attribution: host and member seats both show named seat labels, mark their own seat as yours, and keep same-named bearers distinct", () => {
  const hostId = "a0e7ad17c2dee02fc4cee4fcd6a04a9a";
  const memberAgentId = "m-5403013c911f3fc5a397ccaebb74dac7";
  const memberHumanId = "m-38a6bb3b1c457a4cc18723628e74fee4";
  const raw = [
    { id: "c1", cursor: "1", ts: "2026-01-01T00:00:00Z", author: { id: hostId, name: "Lin", kind: "agent" }, text: "---\ntype: charter\nhost: Lin\ncollaborator: Grace\n---\n# Charter" },
    { id: "m1", cursor: "2", ts: "2026-01-01T00:01:00Z", author: { id: hostId, name: "coding/Opus", kind: "agent" }, text: "host coding\n\nclaim: task:one\n\n-- coding/Opus" },
    { id: "m2", thread: "m1", cursor: "3", ts: "2026-01-01T00:02:00Z", author: { id: memberAgentId, name: "coding/Opus", kind: "agent" }, text: "member coding\n\n-- coding/Opus" },
    { id: "m3", thread: "m1", cursor: "4", ts: "2026-01-01T00:03:00Z", author: { id: memberHumanId, name: "Grace", kind: "human" }, text: "looks good\n\n-- Grace" },
  ];

  // From the host seat (Lin):
  const hostCtx = resolveSeats({ rawMessages: raw, cfg: { rooms: { lab: { transport: "native", roomId: ROOM } } }, alias: "lab", serviceAccountId: hostId, humanName: "Lin", self: "Lin" });
  const hostMsgs = raw.map((m) => formatMessage(m, hostCtx.hostAccountId, hostCtx));
  assert.deepEqual(hostMsgs.slice(1).map((m) => [m.speaker, m.seatOwner, m.yours, m.seatLabel]), [
    ["coding/Opus", "Lin", true, "Lin's seat · yours"],
    ["coding/Opus", "Grace", false, "Grace's seat"],
    ["Grace", "Grace", false, "Grace's seat"],
  ]);
  const hostBoard = boardOf(hostMsgs.slice(1), new Set(["coding/Opus"]));
  assert.deepEqual(hostBoard.who.map((w) => [w.speaker, w.seatOwner, w.origin, w.watching]), [
    ["Grace", "Grace", "Grace's seat", false],
    ["coding/Opus", "Grace", "Grace's seat", false],
    ["coding/Opus", "Lin", "Lin's seat · yours", true],
  ], "only this seat's coding/Opus is marked watching from this seat, and the two seats stay distinct rows");
  assert.equal(hostBoard.claims[0].holder, "coding/Opus (Lin's seat)");
  const hostSubjects = subjectsOf(hostMsgs.slice(1), { room: "lab", self: "Lin", hostAccountId: hostCtx.hostAccountId, now: Date.parse("2026-01-01T00:04:00Z") });
  assert.equal(hostSubjects[0].rootFrom, "coding/Opus (Lin's seat)");

  // From the member seat (Grace):
  const memberCtx = resolveSeats({
    rawMessages: raw,
    cfg: { rooms: { lab: { transport: "native-remote" } } },
    alias: "lab",
    serviceAccountId: "",
    self: "Grace",
  });
  memberCtx.ownAccountIds.add(memberAgentId);
  const memberMsgs = raw.map((m) => formatMessage(m, memberCtx.hostAccountId, memberCtx));
  assert.deepEqual(memberMsgs.slice(1).map((m) => [m.speaker, m.seatOwner, m.yours, m.seatLabel]), [
    ["coding/Opus", "Lin", false, "Lin's seat"],
    ["coding/Opus", "Grace", true, "Grace's seat · yours"],
    ["Grace", "Grace", true, "Grace's seat · yours"],
  ]);
  const memberBoard = boardOf(memberMsgs.slice(1), new Set(["coding/Opus"]));
  assert.deepEqual(memberBoard.who.map((w) => [w.speaker, w.seatOwner, w.origin, w.watching]), [
    ["Grace", "Grace", "Grace's seat · yours", false],
    ["coding/Opus", "Grace", "Grace's seat · yours", true],
    ["coding/Opus", "Lin", "Lin's seat", false],
  ]);
});
