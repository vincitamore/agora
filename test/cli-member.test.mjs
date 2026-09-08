// L12: the `member` verb's own surface.
//
// Every cell here runs the CLI with `AGORA_CONFIG` pinned at a path that does not exist. That is
// the house rule and it is not ceremony: a verb that refuses its own missing arguments only AFTER
// loading config passes on any machine that happens to have one and fails on a runner with none.
// Pinning the absent config proves the ordering everywhere, and the admitted twin below (a
// complete argument list reaching config and exiting 1) is what stops "refuse everything" from
// reading as a pass.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../bin/agora.mjs", import.meta.url));

/** @param {string[]} args @param {NodeJS.ProcessEnv} [env] */
async function agora(args, env = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args],
      { env: { ...process.env, AGORA_CONFIG: "/nonexistent/agora.json", ...env }, timeout: 20_000 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = /** @type {any} */ (error);
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

test("the member verb refuses its OWN arguments before it loads config", async () => {
  for (const [args, expected] of /** @type {Array<[string[], RegExp]>} */ ([
    [["member"], /needs start, stop or status/],
    [["member", "bogus"], /needs start, stop or status/],
    [["member", "start"], /member start needs the room alias/],
    [["member", "stop"], /member stop needs the room alias/],
    [["member", "status"], /member status needs the room alias/],
    [["member", "--daemon"], /--daemon needs the room alias/],
  ])) {
    const result = await agora(args);
    assert.equal(result.code, 2, `${args.join(" ")} should be a usage error: ${result.stderr}`);
    assert.match(result.stderr, expected, args.join(" "));
    // The config was never reached, which is the property: a message about a missing config would
    // mean the ordering is wrong even though the exit code happens to be non-zero.
    assert.doesNotMatch(result.stderr, /no config at/, args.join(" "));
  }
});

test("a complete argument list REACHES config, so the refusals above prove an ordering", async () => {
  // The admitted twin. Without it, a verb that refused everything unconditionally would pass every
  // cell above while proving nothing about when config is loaded.
  const result = await agora(["member", "start", "house-remote"]);
  assert.equal(result.code, 1);
  // Separator-agnostic: Windows renders the same path as C:\nonexistent\agora.json, and a POSIX
  // regex here fails on the runner while passing on every developer machine.
  assert.match(result.stderr, /no config at .*agora\.json/);
});

test("the verb is declared where the schema and the help both read it", async () => {
  const schema = await agora(["schema", "--json"]);
  assert.equal(schema.code, 0);
  const parsed = JSON.parse(schema.stdout);
  assert.ok(parsed.verbs.member, "member is absent from SCHEMA.verbs, so the verb is unreachable");
  assert.deepEqual(parsed.verbs.member.args, ["start|stop|status <room>"]);
  // The surface says what it is FOR, including the ordering that is the unit's whole point.
  assert.match(parsed.verbs.member.does, /exclusive claim as its first act, before any Tailcat child/);
  assert.match(parsed.verbs.member.does, /Never writes the shared config/);

  const help = await agora(["member", "--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /member start\|stop\|status <room>/);
});

test("a member client is refused for a room that is not native-remote, by name", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-cli-member-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = path.join(root, "agora.json");
  await writeFile(config, JSON.stringify({
    actor: { name: "Opus/test", kind: "agent" },
    state: path.join(root, "state"),
    rooms: {
      "a-slack-room": { transport: "slack", channel: "C0123456789", tokenEnv: "NOPE" },
      "no-descriptor": { transport: "native-remote" },
    },
  }), "utf8");

  const slack = await agora(["member", "start", "a-slack-room"], { AGORA_CONFIG: config });
  assert.equal(slack.code, 2);
  assert.match(slack.stderr, /is a slack room; a resident member client serves a native-remote room/);

  const missing = await agora(["member", "start", "no-descriptor"], { AGORA_CONFIG: config });
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /needs a descriptor/);

  const absent = await agora(["member", "status", "never-configured"], { AGORA_CONFIG: config });
  assert.equal(absent.code, 2);
  assert.match(absent.stderr, /is not configured/);
});

test("member status on an unstarted client reports absence and the start line, and exits 0", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-cli-member-status-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const descriptor = path.join(root, "descriptor.json");
  await writeFile(descriptor, "{}", "utf8");
  const config = path.join(root, "agora.json");
  await writeFile(config, JSON.stringify({
    actor: { name: "Opus/test", kind: "agent" },
    state: path.join(root, "state"),
    rooms: { "house-remote": { transport: "native-remote", descriptor } },
  }), "utf8");

  const status = await agora(["member", "status", "house-remote", "--json"], { AGORA_CONFIG: config });
  // Absence is a REPORT, not an error: `status` answering "there is none" is the answer.
  assert.equal(status.code, 0);
  const parsed = JSON.parse(status.stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
  assert.equal(parsed.type, "member");
  assert.equal(parsed.present, false);
  assert.match(String(parsed.error), /agora member start house-remote/);
  assert.doesNotMatch(status.stdout, /nonce/);
});

// --- no direct dial: TWO halves, and they are different claims ------------------------------
//
// Opus/architect asked for an enumeration rather than a spot check (backroom 1788838867), and
// Astra/verifier sharpened it (1788839072): a schema inventory proves NO VERB EXISTS; it does not
// prove the code refuses when the descriptor is absent. Different claims about different layers.
// Both are written here so neither can be read later as a substitute for the other.

test("half one, the INVENTORY: the verb surface carries no way to dial Tailcat on the key", async () => {
  const schema = await agora(["schema", "--json"]);
  const verbs = Object.keys(JSON.parse(schema.stdout).verbs).sort();
  // Pinned as a SET, not sampled. A later unit that adds a verb reds this cell, and whoever adds it
  // must then say whether their verb opens a Tailcat client on the enrolled key — which is exactly
  // the question a spot check of three verbs never asks about the fourth.
  assert.deepEqual(verbs, [
    "authority", "break", "carry", "contest", "cursor", "doctor", "economy", "enroll", "faces",
    "fetch", "join", "member", "post", "read", "resume", "room", "rooms", "schema", "service",
    "session", "share", "spawn", "stand-down", "usage", "usage-sessions", "watch", "who", "whoami",
  ].sort(), "the verb inventory moved; state whether the new verb dials Tailcat on the enrolled key");

  // `member` is the only verb whose own description says it holds the member channel, and it says
  // the channel is held by ONE process per machine rather than by whoever asked.
  const member = JSON.parse(schema.stdout).verbs.member.does;
  assert.match(member, /ONE process per machine holds the enrolled key's member channel/);
});

test("half two, the RUNTIME: with no resident client a native-remote room refuses with the start line", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-nodial-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const descriptor = path.join(root, "descriptor.json");
  // A route descriptor that would be perfectly dialable if anything still dialed. Nothing does.
  await writeFile(descriptor, JSON.stringify({ binding: { roomId: "a".repeat(32) } }), "utf8");
  const config = path.join(root, "agora.json");
  await writeFile(config, JSON.stringify({
    actor: { name: "Opus/test", kind: "agent" },
    state: path.join(root, "state"),
    rooms: { "house-remote": { transport: "native-remote", descriptor } },
  }), "utf8");

  for (const args of [["read", "house-remote"], ["post", "house-remote", "hello"], ["watch", "house-remote", "--once"]]) {
    const result = await agora(args, { AGORA_CONFIG: config });
    assert.equal(result.code, 1, `${args[0]} should refuse: ${result.stderr}`);
    assert.match(result.stderr, /no resident member client for "house-remote"/, args[0]);
    assert.match(result.stderr, /agora member start house-remote/, args[0]);
    // The refusal must not read as a NETWORK failure. The mutant this guards against restores
    // direct dialing when the descriptor is absent, and it shows up here as a dial error — a
    // deadline, a dark channel, a stale route — instead of the line above.
    //
    // The word "Tailcat" is deliberately NOT in this list: the start line itself says "no session
    // dials Tailcat directly", so forbidding it would make the cell fail on its own correct output.
    // (It did, once, which is why this is written down: a negative assertion has to be checked
    // against the passing text as well as the failing kind.)
    assert.doesNotMatch(result.stderr, /deadline|timed out|member-channel-dark|route-not-open|route-already|Dial:/i, args[0]);
  }
});
