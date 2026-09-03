// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { tmp } from "./helpers.mjs";

const run = promisify(execFile);
const BIN = new URL("../bin/agora.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/** The message lines of a `--json` watch: it ends with one watch-result line, fired or not. @param {string} stdout */
const messages = (stdout) => stdout.trim().split(/\r?\n/).filter((l) => l.trim() && !l.includes('"type":"watch-result"'));

/** @param {string[]} args @param {Record<string, string>} env */
async function agora(args, env) {
  try {
    const child = run(process.execPath, [BIN, ...args], { env: { ...process.env, ...env }, windowsHide: true });
    child.child.stdin?.end(); // an open stdin pipe would make `post --stdin` wait forever
    const { stdout, stderr } = await child;
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = /** @type {any} */ (e);
    return { code: err.code, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

test("cli end to end on a local room", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const cfgPath = path.join(dir, "agora.json");
    await writeFile(cfgPath, JSON.stringify({
      actor: { name: "Claude (house)", kind: "agent" },
      rooms: { down: { transport: "local", path: path.join(dir, "down.ndjson") } },
    }));
    const env = { AGORA_CONFIG: cfgPath, AGORA_STATE: path.join(dir, "state") };

    let r = await agora(["schema", "--json"], env);
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.stdout).name, "agora");

    r = await agora(["doctor", "--json"], env);
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.stdout.trim().split("\n")[0]).token, "none");

    r = await agora(["watch", "down", "--once"], env);
    assert.equal(r.code, 0, "nothing new yet");

    r = await agora(["post", "down", "candidate at v1"], env);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^posted /);

    r = await agora(["read", "down", "--json"], env);
    const msgs = r.stdout.trim().split("\n").map((/** @type {string} */ l) => JSON.parse(l));
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].text, "candidate at v1\n\n-- Claude (house)");
    assert.equal(msgs[0].signedAs, "Claude (house)");
    assert.equal(msgs[0].raw, undefined, "raw stays out of the wire");

    r = await agora(["watch", "down", "--once"], env);
    assert.equal(r.code, 0, "our own post does not wake us");
    assert.match(r.stderr, /1 of our own skipped/);
    r = await agora(["cursor", "down", "--json"], env);
    assert.equal(JSON.parse(r.stdout).cursor, "1", "but the cursor advanced past it");
    r = await agora(["cursor", "down", "--reset"], env);
    r = await agora(["watch", "down", "--once", "--all", "--json"], env);
    assert.equal(r.code, 42, "--all delivers our own post");
    assert.equal(JSON.parse(messages(r.stdout)[0]).cursor, "1");
    r = await agora(["watch", "down", "--once"], env);
    assert.equal(r.code, 0, "cursor advanced; nothing re-delivered");

    r = await agora(["cursor", "down", "--json"], env);
    assert.equal(JSON.parse(r.stdout).cursor, "1");
    r = await agora(["cursor", "down", "--reset", "--json"], env);
    assert.equal(JSON.parse(r.stdout).cursor, null);
    r = await agora(["cursor", "down", "--now", "--json"], env);
    assert.equal(JSON.parse(r.stdout).cursor, "1");

    r = await agora(["post", "down", "--no-sign", "-"], env);
    assert.equal(r.code, 2, "stdin was empty");
    r = await agora(["read", "nope"], env);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /no room "nope"/);
  } finally {
    await cleanup();
  }
});

test("cli: two sessions in one state root each keep their own position and see each other's posts", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const cfgPath = path.join(dir, "agora.json");
    await writeFile(cfgPath, JSON.stringify({
      actor: { name: "Grace", kind: "agent" },
      rooms: { down: { transport: "local", path: path.join(dir, "down.ndjson") } },
    }));
    const root = path.join(dir, "state");
    const A = { AGORA_CONFIG: cfgPath, AGORA_STATE: root, AGORA_SESSION: "grace-a", AGORA_ACTOR: "Grace/watch" };
    const B = { AGORA_CONFIG: cfgPath, AGORA_STATE: root, AGORA_SESSION: "grace-b", AGORA_ACTOR: "Grace/review" };

    let r = await agora(["post", "down", "from a"], A);
    assert.equal(r.code, 0);
    assert.match(r.stderr, /^agora: Grace\/watch \(from AGORA_ACTOR\) · session grace-a \(from AGORA_SESSION\)/m, "the identity line is on stderr");
    r = await agora(["watch", "down", "--once", "--json"], B);
    assert.equal(r.code, 42, "B sees A's post");
    assert.equal(JSON.parse(r.stdout.trim().split("\n")[0]).signedAs, "Grace/watch");
    r = await agora(["watch", "down", "--once"], A);
    assert.equal(r.code, 0, "A does not see its own post");
    assert.match(r.stderr, /1 of our own skipped/);

    r = await agora(["post", "down", "from b"], B);
    r = await agora(["watch", "down", "--once", "--json"], A);
    assert.equal(r.code, 42, "A sees B's post: B's watch did not consume it for A");
    assert.equal(JSON.parse(r.stdout.trim().split("\n")[0]).signedAs, "Grace/review");
    r = await agora(["watch", "down", "--once"], A);
    assert.equal(r.code, 0, "nothing re-delivered");
    r = await agora(["watch", "down", "--once"], B);
    assert.equal(r.code, 0, "B skips its own post");

    r = await agora(["cursor", "down", "--json"], A);
    assert.deepEqual(JSON.parse(r.stdout), { room: "down", cursor: "2", session: "grace-a" });
    r = await agora(["doctor", "--offline"], A);
    assert.match(r.stdout, /session grace-a \(from AGORA_SESSION\)/);
    assert.match(r.stdout, /bearer  Grace\/watch \(agent, from AGORA_ACTOR\)/);

    // a third session with a bad key is a usage error, not a silent default
    r = await agora(["read", "down"], { ...A, AGORA_SESSION: "not/ok" });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /AGORA_SESSION must match/);
  } finally {
    await cleanup();
  }
});

test("cli: session --as registers once and every later call signs as the record; join is register + cursor --now + read", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const cfgPath = path.join(dir, "agora.json");
    await writeFile(cfgPath, JSON.stringify({
      actor: { name: "Grace", kind: "agent" },
      rooms: { down: { transport: "local", path: path.join(dir, "down.ndjson") } },
    }));
    const root = path.join(dir, "state");
    const A = { AGORA_CONFIG: cfgPath, AGORA_STATE: root, AGORA_SESSION: "a", CLAUDE_PID: String(process.pid) };
    const B = { AGORA_CONFIG: cfgPath, AGORA_STATE: root, AGORA_SESSION: "b", CLAUDE_PID: "" }; // no harness pid: the runner's own must not leak in

    let r = await agora(["session"], A);
    assert.equal(r.code, 2, "registering needs --as");
    r = await agora(["session", "--as", "Grace/watch", "--label", "the watch"], A);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /registered Grace\/watch as session a \(from AGORA_SESSION\)  pid \d+ from CLAUDE_PID/);
    r = await agora(["post", "down", "hello"], A);
    assert.match(r.stderr, /^agora: Grace\/watch \(from session\)/m, "the record supplies the bearer with no env and no flag");
    r = await agora(["read", "down", "--json"], A);
    assert.equal(JSON.parse(r.stdout.trim()).signedAs, "Grace/watch");

    await agora(["post", "down", "one more"], A);
    r = await agora(["join", "down", "--as", "Grace/review", "--limit", "1", "--json"], B);
    assert.equal(r.code, 0);
    assert.match(r.stderr, /registered|cursor set to 2/);
    assert.equal(r.stdout.trim().split("\n").length, 1, "shows the last message only");
    r = await agora(["watch", "down", "--once"], B);
    assert.equal(r.code, 0, "joined at the latest message, so nothing is new");
    r = await agora(["cursor", "down", "--json"], B);
    assert.equal(JSON.parse(r.stdout).cursor, "2");

    r = await agora(["session", "--list"], B);
    assert.match(r.stdout, /Grace\/watch\s+a\s+live/);
    assert.match(r.stdout, /\* Grace\/review\s+b\s+unknown/, "b registered with no harness pid: liveness unknown");
    r = await agora(["session", "--prune", "--dry-run"], B);
    assert.match(r.stdout, /nothing to prune/);
    r = await agora(["session", "--forget"], B);
    assert.match(r.stdout, /forgot session b/);
    r = await agora(["session", "--list", "--json"], A);
    assert.deepEqual(r.stdout.trim().split("\n").map((/** @type {string} */ l) => JSON.parse(l).slug), ["a"]);
    r = await agora(["doctor", "--offline"], A);
    assert.match(r.stdout, /sessions with state here/);
  } finally {
    await cleanup();
  }
});

test("cli: a session that went dark is announced to the room once by the first watch that notices; who shows it", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const cfgPath = path.join(dir, "agora.json");
    await writeFile(cfgPath, JSON.stringify({
      actor: { name: "Grace", kind: "agent" },
      rooms: { down: { transport: "local", path: path.join(dir, "down.ndjson") } },
    }));
    const root = path.join(dir, "state");
    const A = { AGORA_CONFIG: cfgPath, AGORA_STATE: root, AGORA_SESSION: "a", AGORA_ACTOR: "Grace/watch", CLAUDE_PID: String(process.pid) };
    const B = { AGORA_CONFIG: cfgPath, AGORA_STATE: root, AGORA_SESSION: "b", AGORA_ACTOR: "Grace/review", CLAUDE_PID: String(process.pid) };
    // a third session whose process is gone and whose record is old: registered with a pid nothing answers,
    // then its record's lastSeen pushed back past the grace by hand (the tool never writes the past)
    const G = { AGORA_CONFIG: cfgPath, AGORA_STATE: root, AGORA_SESSION: "g", AGORA_ACTOR: "Opus/design", CLAUDE_PID: "999999" };
    let r = await agora(["session", "--as", "Opus/design"], G);
    assert.equal(r.code, 0);
    await agora(["session", "--as", "Grace/watch"], A);
    await agora(["session", "--as", "Grace/review"], B);
    const recPath = path.join(root, "sessions", "g", "session.json");
    const rec = JSON.parse(await readFile(recPath, "utf8"));
    rec.lastSeen = new Date(Date.now() - 20 * 60_000).toISOString();
    await writeFile(recPath, JSON.stringify(rec));

    r = await agora(["post", "down", "hello from a"], A);
    r = await agora(["watch", "down", "--once", "--json"], B);
    assert.equal(r.code, 42);
    assert.match(r.stderr, /announced to down: Opus\/design is no longer running/);
    const texts = messages(r.stdout).map((/** @type {string} */ l) => JSON.parse(l).text);
    assert.equal(texts.length, 1, "B receives A's post; its own announcement is in its ledger and is not echoed to it");
    assert.match(texts[0], /hello from a/);
    r = await agora(["watch", "down", "--once", "--json"], A);
    assert.equal(r.code, 42, "A receives the announcement B posted");
    assert.match(JSON.parse(messages(r.stdout)[0]).text, /Opus\/design is no longer running .* Still here on this seat: Grace\/watch, Grace\/review\./);
    assert.doesNotMatch(r.stderr, /announced to down/, "announced once, not by every watcher");
    r = await agora(["watch", "down", "--once"], B);
    assert.equal(r.code, 0, "nothing new; not announced again");

    r = await agora(["who", "down"], A);
    assert.match(r.stdout, /Grace\/review\s+last spoke .*here: live/);
    assert.match(r.stdout, /Grace\/watch\s+last spoke .*here: live/);
    assert.match(r.stdout, /read 2 messages back to/);
    r = await agora(["who", "down", "--json"], A);
    const rows = r.stdout.trim().split("\n").map((/** @type {string} */ l) => JSON.parse(l));
    assert.equal(rows.at(-1).type, "who-horizon");
    assert.ok(rows.some((/** @type {any} */ x) => x.name === "Grace/review" && x.here?.[0]?.state === "live"));
  } finally {
    await cleanup();
  }
});

test("cli: a session with no position seeds once from the shared cursor and then keeps its own", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const cfgPath = path.join(dir, "agora.json");
    await writeFile(cfgPath, JSON.stringify({
      actor: { name: "Grace", kind: "agent" },
      rooms: { down: { transport: "local", path: path.join(dir, "down.ndjson") } },
    }));
    const root = path.join(dir, "state");
    const legacy = { AGORA_CONFIG: cfgPath, AGORA_STATE: root, AGORA_SESSION: "old" };
    const fresh = { AGORA_CONFIG: cfgPath, AGORA_STATE: root, AGORA_SESSION: "new" };
    // the single-session layout: a shared cursor file at the state root, as an older version wrote it
    await agora(["post", "down", "one"], legacy);
    await agora(["post", "down", "two"], legacy);
    await writeFile(path.join(root, "down.cursor"), JSON.stringify({ cursor: "1" }) + "\n");

    let r = await agora(["watch", "down", "--once", "--json"], fresh);
    assert.equal(r.code, 42);
    assert.match(r.stderr, /seeded from the shared down\.cursor \(1\)/);
    assert.equal(JSON.parse(r.stdout.trim().split("\n")[0]).text, "two\n\n-- Grace", "resumed after the shared position, not from the start");
    assert.equal(JSON.parse(await readFile(path.join(root, "down.cursor"), "utf8")).cursor, "1", "the shared file is untouched");
    r = await agora(["cursor", "down", "--reset", "--json"], fresh);
    assert.equal(JSON.parse(r.stdout).cursor, null);
    r = await agora(["watch", "down", "--once", "--json"], fresh);
    assert.equal(r.code, 42, "after a reset the watch reads from the start, not from the shared file");
    assert.equal(messages(r.stdout).length, 2);
  } finally {
    await cleanup();
  }
});

test("cli refuses a config with an inline token and never echoes it", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const cfgPath = path.join(dir, "agora.json");
    await writeFile(cfgPath, JSON.stringify({ actor: { name: "x", kind: "human" }, rooms: { s: { transport: "slack", channel: "C1", token: "xoxb-secret-value" } } }));
    const r = await agora(["rooms"], { AGORA_CONFIG: cfgPath });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /inline; use tokenEnv/);
    assert.doesNotMatch(r.stderr, /xoxb-secret/);
  } finally {
    await cleanup();
  }
});

test("cli: every watch ends with one watch-result line, on stderr in human output and on stdout under --json", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const cfgPath = path.join(dir, "agora.json");
    await writeFile(cfgPath, JSON.stringify({
      actor: { name: "Grace", kind: "agent" },
      rooms: { down: { transport: "local", path: path.join(dir, "down.ndjson") } },
    }));
    const env = { AGORA_CONFIG: cfgPath, AGORA_STATE: path.join(dir, "state"), AGORA_SESSION: "w", CLAUDE_PID: "" };

    let r = await agora(["watch", "down", "--once"], env);
    assert.equal(r.code, 0);
    const quiet = JSON.parse(r.stderr.trim().split(/\r?\n/).at(-1) ?? "");
    assert.deepEqual(quiet, { type: "watch-result", room: "down", session: "w", bearer: "Grace", fired: false, delivered: 0, skipped: 0, polls: 1, cursor: null, threads: {}, exit: 0 });
    assert.equal(r.stdout, "", "nothing on stdout when nothing arrived");

    await agora(["post", "down", "from them"], { ...env, AGORA_SESSION: "them" });
    r = await agora(["watch", "down", "--once", "--json"], env);
    assert.equal(r.code, 42);
    const lines = r.stdout.trim().split(/\r?\n/);
    const fired = JSON.parse(lines.at(-1) ?? "");
    assert.equal(lines.length, 2, "the message, then the result line");
    assert.equal(fired.type, "watch-result");
    assert.deepEqual([fired.fired, fired.delivered, fired.exit, fired.cursor], [true, 1, 42, "1"]);
    assert.doesNotMatch(r.stderr, /watch-result/, "under --json it is on stdout only");
  } finally {
    await cleanup();
  }
});

test("cli: a watch registers the cursor it holds while it runs, and a second watch on that key says so", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const cfgPath = path.join(dir, "agora.json");
    await writeFile(cfgPath, JSON.stringify({
      actor: { name: "Grace", kind: "agent" },
      rooms: { down: { transport: "local", path: path.join(dir, "down.ndjson") } },
    }));
    const root = path.join(dir, "state");
    const env = { AGORA_CONFIG: cfgPath, AGORA_STATE: root, AGORA_SESSION: "w", CLAUDE_PID: "" };
    const armed = path.join(root, "sessions", "w", "armed", "down.json");

    const running = agora(["watch", "down", "--stream", "--for", "3", "--interval", "1"], env);
    let held;
    for (let i = 0; i < 60 && !held; i++) {
      if (existsSync(armed)) held = JSON.parse(await readFile(armed, "utf8"));
      else await delay(50);
    }
    assert.ok(held, "the registration is there while the watch is");
    assert.equal(held.room, "down");
    assert.equal(held.interval, 1);
    assert.ok(held.pid > 0);
    await running;
    assert.equal(existsSync(armed), false, "and gone when it leaves");

    // this process is alive, so a watch finding it registered warns and carries on
    await writeFile(armed, JSON.stringify({ room: "down", interval: 15, pid: process.pid, startedAt: new Date().toISOString() }));
    const r = await agora(["watch", "down", "--once"], env);
    assert.equal(r.code, 0, "a warning, never a refusal");
    assert.match(r.stderr, /another watch holds this cursor \(pid \d+\); two watches on one key double-deliver/);
    assert.equal(existsSync(armed), false);
  } finally {
    await cleanup();
  }
});

test("cli: posting in a thread follows it, and --follow reads it; --follow with --thread is a usage error", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const cfgPath = path.join(dir, "agora.json");
    await writeFile(cfgPath, JSON.stringify({
      actor: { name: "Grace", kind: "agent" },
      rooms: { down: { transport: "local", path: path.join(dir, "down.ndjson"), followCap: 8, threadInterval: 60 } },
    }));
    const root = path.join(dir, "state");
    const A = { AGORA_CONFIG: cfgPath, AGORA_STATE: root, AGORA_SESSION: "a", CLAUDE_PID: "", AGORA_ACTOR: "Grace/watch" };
    const B = { AGORA_CONFIG: cfgPath, AGORA_STATE: root, AGORA_SESSION: "b", CLAUDE_PID: "", AGORA_ACTOR: "Codex" };

    let r = await agora(["post", "down", "the request"], A);
    const parent = /posted (\S+)/.exec(r.stdout)?.[1];
    assert.ok(parent);
    await agora(["post", "down", "--thread", parent, "on it"], A);
    const set = JSON.parse(await readFile(path.join(root, "sessions", "a", "follow", "down.json"), "utf8"));
    assert.deepEqual(Object.keys(set.threads), [parent], "a threaded post joins the follow set");

    await agora(["cursor", "down", "--now"], A);
    await agora(["post", "down", "--thread", parent, "the exhibit"], B);
    r = await agora(["watch", "down", "--once", "--follow", "--json"], A);
    assert.equal(r.code, 42);
    const result = JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1) ?? "");
    assert.equal(result.threads[parent], 1, "the reply came in on the followed thread");
    assert.equal(result.delivered, 1, "and once, not twice");

    r = await agora(["watch", "down", "--follow", "--thread", parent, "--once"], A);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /cannot be combined with --thread/);
  } finally {
    await cleanup();
  }
});

test("cli: doctor adds up the reads a minute this seat's live watches are spending", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const cfgPath = path.join(dir, "agora.json");
    await writeFile(cfgPath, JSON.stringify({
      actor: { name: "Grace", kind: "agent" },
      rooms: { down: { transport: "local", path: path.join(dir, "down.ndjson"), pollBudget: 6 } },
    }));
    const root = path.join(dir, "state");
    const env = { AGORA_CONFIG: cfgPath, AGORA_STATE: root, AGORA_SESSION: "a", CLAUDE_PID: "" };
    const armedDir = path.join(root, "sessions", "a", "armed");
    await agora(["session", "--as", "Grace/watch"], env);
    await mkdir(armedDir, { recursive: true });
    await writeFile(path.join(armedDir, "down.json"), JSON.stringify({ room: "down", interval: 15, threadInterval: 60, follow: true, pid: process.pid, startedAt: new Date().toISOString() }));
    await mkdir(path.join(root, "sessions", "a", "follow"), { recursive: true });
    await writeFile(path.join(root, "sessions", "a", "follow", "down.json"), JSON.stringify({ threads: { T1: new Date().toISOString(), T2: new Date().toISOString() } }));

    let r = await agora(["doctor", "--offline"], env);
    assert.equal(r.code, 0, "a rate over its budget is a warning, never an exit code");
    assert.match(r.stdout, /seat poll rate {2}~6 reads\/min on local \(budget 6, 1 watch\)/, "four room reads a minute plus one for each followed thread");
    assert.doesNotMatch(r.stdout, /WARNING this seat reads/);

    await writeFile(path.join(armedDir, "down.json"), JSON.stringify({ room: "down", interval: 5, pid: process.pid, startedAt: new Date().toISOString() }));
    r = await agora(["doctor", "--offline", "--json"], env);
    const rate = r.stdout.trim().split(/\r?\n/).map((/** @type {string} */ l) => JSON.parse(l)).find((/** @type {any} */ o) => o.type === "poll-rate");
    assert.deepEqual(rate, { type: "poll-rate", transport: "local", rate: 12, budget: 6, watches: 1, over: true });

    // a registration whose process is gone is a leftover, and counts for nothing
    await writeFile(path.join(armedDir, "down.json"), JSON.stringify({ room: "down", interval: 5, pid: 2 ** 30, startedAt: new Date().toISOString() }));
    r = await agora(["doctor", "--offline"], env);
    assert.doesNotMatch(r.stdout, /seat poll rate/);
  } finally {
    await cleanup();
  }
});

test("cli: the trailer block is emitted above the signature, rendered above the body, and carried in --json", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const cfgPath = path.join(dir, "agora.json");
    await writeFile(cfgPath, JSON.stringify({
      actor: { name: "Grace", kind: "agent" },
      rooms: { down: { transport: "local", path: path.join(dir, "down.ndjson") } },
    }));
    const env = { AGORA_CONFIG: cfgPath, AGORA_STATE: path.join(dir, "state"), AGORA_SESSION: "a", CLAUDE_PID: "" };

    // the red one first: a verdict nobody can check is not posted at all
    let r = await agora(["post", "down", "--verdict", "the retry is the bug", "it is settled"], env);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--verdict needs at least one --exhibit/);
    assert.equal(existsSync(path.join(dir, "down.ndjson")), false, "nothing was posted");

    r = await agora(["post", "down", "--to", "Codex", "--claim", "p.ts::f", "text"], env);
    assert.equal(r.code, 0);
    r = await agora(["read", "down", "--json"], env);
    const m = JSON.parse(r.stdout.trim());
    assert.equal(m.text, "text\n\nto: Codex\nclaim: p.ts::f\n\n-- Grace", "body, blank line, block, blank line, signature");
    assert.equal(m.signedAs, "Grace");
    assert.deepEqual(m.to, ["Codex"]);
    assert.deepEqual(m.trailers, [{ key: "to", value: "Codex" }, { key: "claim", value: "p.ts::f" }]);

    r = await agora(["read", "down"], env);
    assert.match(r.stdout, /→ to Codex · claim p\.ts::f/, "one derived line above the body");
    assert.match(r.stdout, / {4}text\n {4}\n {4}to: Codex/, "and the body printed as it was posted, trailers and all");

    // the primitive, and a key nobody acts on
    r = await agora(["post", "down", "--trailer", "Severity: high", "--trailer", "to: *", "watch out"], env);
    assert.equal(r.code, 0);
    r = await agora(["read", "down", "--json"], env);
    const second = JSON.parse(r.stdout.trim().split(/\r?\n/)[1]);
    assert.deepEqual(second.trailers, [{ key: "to", value: "*" }, { key: "severity", value: "high" }]);
    assert.deepEqual(second.to, ["*"]);
    r = await agora(["post", "down", "--trailer", "no colon here", "x"], env);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--trailer takes/);

    // a message with no trailers carries neither field and gets no derived line
    r = await agora(["post", "down", "plain"], env);
    r = await agora(["read", "down", "--json"], env);
    const plain = JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1) ?? "");
    assert.equal("to" in plain, false);
    assert.equal("trailers" in plain, false);
  } finally {
    await cleanup();
  }
});

test("cli: a room's note is printed with it, and doctor says when a local room sits somewhere that loses lines", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const cfgPath = path.join(dir, "agora.json");
    await writeFile(cfgPath, JSON.stringify({
      actor: { name: "Grace", kind: "agent" },
      rooms: {
        desk: { transport: "local", path: path.join(dir, "desk.ndjson"), note: "desk-local: sequencing among our own sessions" },
        shared: { transport: "local", path: "/mnt/c/agora/shared.ndjson" },
      },
    }));
    const env = { AGORA_CONFIG: cfgPath, AGORA_STATE: path.join(dir, "state"), AGORA_SESSION: "a", CLAUDE_PID: "" };

    let r = await agora(["rooms"], env);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /desk {13}local {4}.*\n {17}note: desk-local: sequencing among our own sessions/);
    assert.doesNotMatch(r.stdout, /shared.*\n {17}note:/, "a room with no note gets no line");
    r = await agora(["rooms", "--json"], env);
    const [desk, shared] = r.stdout.trim().split(/\r?\n/).map((/** @type {string} */ l) => JSON.parse(l));
    assert.equal(desk.note, "desk-local: sequencing among our own sessions");
    assert.equal("note" in shared, false);

    // the room need not exist: this is a fact about where it is, not about what is in it
    r = await agora(["doctor", "--offline"], env);
    assert.equal(r.code, 0, "a warning, never an exit code");
    assert.match(r.stdout, /WARNING this room's file sits behind a filesystem translation layer/);
    assert.match(r.stdout, /Every writer must reach it through the same native filesystem/);
    assert.match(r.stdout, /note: desk-local/);
    r = await agora(["doctor", "--offline", "--json"], env);
    const rows = r.stdout.trim().split(/\r?\n/).map((/** @type {string} */ l) => JSON.parse(l));
    assert.equal(rows.find((/** @type {any} */ o) => o.alias === "shared").warning.includes("translation layer"), true);
    assert.equal("warning" in rows.find((/** @type {any} */ o) => o.alias === "desk"), false);
  } finally {
    await cleanup();
  }
});
