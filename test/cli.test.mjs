// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmp } from "./helpers.mjs";

const run = promisify(execFile);
const BIN = new URL("../bin/agora.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

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
    assert.equal(JSON.parse(r.stdout.trim()).cursor, "1");
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
      actor: { name: "Fable", kind: "agent" },
      rooms: { down: { transport: "local", path: path.join(dir, "down.ndjson") } },
    }));
    const root = path.join(dir, "state");
    const A = { AGORA_CONFIG: cfgPath, AGORA_STATE: root, AGORA_SESSION: "fable-a", AGORA_ACTOR: "Fable/watch" };
    const B = { AGORA_CONFIG: cfgPath, AGORA_STATE: root, AGORA_SESSION: "fable-b", AGORA_ACTOR: "Fable/review" };

    let r = await agora(["post", "down", "from a"], A);
    assert.equal(r.code, 0);
    assert.match(r.stderr, /^agora: Fable\/watch \(from AGORA_ACTOR\) · session fable-a \(from AGORA_SESSION\)/m, "the identity line is on stderr");
    r = await agora(["watch", "down", "--once", "--json"], B);
    assert.equal(r.code, 42, "B sees A's post");
    assert.equal(JSON.parse(r.stdout.trim().split("\n")[0]).signedAs, "Fable/watch");
    r = await agora(["watch", "down", "--once"], A);
    assert.equal(r.code, 0, "A does not see its own post");
    assert.match(r.stderr, /1 of our own skipped/);

    r = await agora(["post", "down", "from b"], B);
    r = await agora(["watch", "down", "--once", "--json"], A);
    assert.equal(r.code, 42, "A sees B's post: B's watch did not consume it for A");
    assert.equal(JSON.parse(r.stdout.trim().split("\n")[0]).signedAs, "Fable/review");
    r = await agora(["watch", "down", "--once"], A);
    assert.equal(r.code, 0, "nothing re-delivered");
    r = await agora(["watch", "down", "--once"], B);
    assert.equal(r.code, 0, "B skips its own post");

    r = await agora(["cursor", "down", "--json"], A);
    assert.deepEqual(JSON.parse(r.stdout), { room: "down", cursor: "2", session: "fable-a" });
    r = await agora(["doctor", "--offline"], A);
    assert.match(r.stdout, /session fable-a \(from AGORA_SESSION\)/);
    assert.match(r.stdout, /bearer  Fable\/watch \(agent, from AGORA_ACTOR\)/);

    // a third session with a bad key is a usage error, not a silent default
    r = await agora(["read", "down"], { ...A, AGORA_SESSION: "not/ok" });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /AGORA_SESSION must match/);
  } finally {
    await cleanup();
  }
});

test("cli: a session with no position seeds once from the shared cursor and then keeps its own", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const cfgPath = path.join(dir, "agora.json");
    await writeFile(cfgPath, JSON.stringify({
      actor: { name: "Fable", kind: "agent" },
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
    assert.equal(JSON.parse(r.stdout.trim().split("\n")[0]).text, "two\n\n-- Fable", "resumed after the shared position, not from the start");
    assert.equal(JSON.parse(await readFile(path.join(root, "down.cursor"), "utf8")).cursor, "1", "the shared file is untouched");
    r = await agora(["cursor", "down", "--reset", "--json"], fresh);
    assert.equal(JSON.parse(r.stdout).cursor, null);
    r = await agora(["watch", "down", "--once", "--json"], fresh);
    assert.equal(r.code, 42, "after a reset the watch reads from the start, not from the shared file");
    assert.equal(r.stdout.trim().split("\n").length, 2);
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
