// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
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

    r = await agora(["watch", "down", "--once", "--json"], env);
    assert.equal(r.code, 42, "fired");
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
