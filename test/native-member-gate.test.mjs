// L12 seam 8: the direct-path gate is a key-bearing dialer, so it takes the ownership claim.
//
// The gate `spawnSync`s `tailcat --key=<identity> ping --until-direct`. The host indexes clients by
// node PUBLIC key, so run while a resident member client holds that key this child is a competing
// peer and recreates the failure the probe exists to measure. Checking for a holder and then
// spawning is a TOCTOU; the window between the two is where the second peer appears.
//
// These cells run the real script as a subprocess against a FAKE tailcat binary, because the
// property under test is about process ordering and cannot be observed from inside the module.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { enrolledKeyDigest, keyClaimPath, canonicalStateRoot, takeKeyClaim } from "../src/native-member-claim.mjs";

const run = promisify(execFile);
const REPO = fileURLToPath(new URL("..", import.meta.url));
const GATE = path.join(REPO, "scripts", "probe-tailcat-live.mjs");
const NODE_KEY = `nodekey:${"abcdef0123456789".repeat(4)}`;

/** A rig: a private state root, an identity file with both halves, an address file. */
/** @param {import('node:test').TestContext} t */
async function rig(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-gate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, "state");
  await mkdir(path.join(stateRoot, "tailcat"), { recursive: true });
  const keyPath = path.join(stateRoot, "tailcat", "identity.private.json");
  await writeFile(keyPath, JSON.stringify({
    Private: `privkey:${"9".repeat(64)}`,
    Public: { ServerPublic: NODE_KEY, ServerDiscoPublic: `discokey:${"8".repeat(64)}` },
  }), "utf8");
  const addressFile = path.join(root, "server.addr");
  // Deliberately NOT the endpoint the fake pong reports. The gate redacts its private values out
  // of the captured output before parsing, so a fixture that reuses the address as the direct
  // endpoint has its own answer redacted away and reads as a failed probe (measured once, here).
  await writeFile(addressFile, "203.0.113.9:41641\n", "utf8");
  return { root, stateRoot, keyPath, addressFile };
}

/**
 * The fake Tailcat, as a PRELOAD that replaces the gate's own child call.
 *
 * The obvious rig — write a `#!/usr/bin/env node` script, chmod +x, and pass it as `--binary` —
 * works on POSIX and silently does nothing on Windows, which cannot execute a `.mjs` by shebang.
 * The cell then reports "the gate spawned no child" on the one platform where that is a fixture
 * artifact rather than the property. Measured on the house Windows runner.
 *
 * So `--binary` is `process.execPath` and the child call is stubbed in-process, which is the
 * technique the inherited probe cell already uses. The stub keeps the REAL `spawnSync` captured
 * before it replaces it, and uses it to run a helper that attempts the key claim while the gate
 * holds it — so the TOCTOU proof stays a genuine second process rather than becoming an
 * in-process assertion about a variable.
 * @param {string} dir @param {{ marker: string, claimAttempt: string, stateRoot: string, keyDigest: string, stdout?: string }} opts
 */
async function preload(dir, { marker, claimAttempt, stateRoot, keyDigest, stdout = "pong in 3ms via 198.51.100.7:41641\n" }) {
  const helper = path.join(dir, "claim-attempt.mjs");
  await writeFile(helper, `
import { writeFile } from "node:fs/promises";
import { takeKeyClaim } from ${JSON.stringify(pathToFileURL(path.join(REPO, "src", "native-member-claim.mjs")).href)};
let outcome;
try {
  const held = await takeKeyClaim({ stateRoot: ${JSON.stringify(stateRoot)}, keyDigest: ${JSON.stringify(keyDigest)}, kind: "gate", label: "the child itself" });
  outcome = { took: true, generation: held.generation };
  await held.release();
} catch (error) { outcome = { took: false, code: error?.code ?? null }; }
await writeFile(${JSON.stringify(claimAttempt)}, JSON.stringify(outcome), "utf8");
`, "utf8");

  const file = path.join(dir, "child-fixture.mjs");
  await writeFile(file, `
import cp from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const realSpawnSync = cp.spawnSync;
cp.spawnSync = (binary, args) => {
  if (!args.includes('ping')) throw Error('unexpected child invocation');
  writeFileSync(${JSON.stringify(marker)}, args.join(' ') + '\\n', 'utf8');
  // A real second process, started with the real spawnSync, while the gate holds the claim.
  realSpawnSync(process.execPath, [${JSON.stringify(helper)}], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  return { status: 0, signal: null, error: undefined, stdout: ${JSON.stringify(stdout)}, stderr: '' };
};
syncBuiltinESMExports();
`, "utf8");
  return file;
}

/**
 * Run the gate; it exits non-zero on refusal and on a failed probe, so never throw on status.
 * @param {{ stateRoot: string, fixture: string, addressFile: string, keyPath: string }} opts
 */
async function gate({ stateRoot, fixture, addressFile, keyPath }) {
  const args = ["--import", pathToFileURL(fixture).href, GATE, "--direct",
    "--binary", process.execPath, "--address-file", addressFile, "--key-file", keyPath, "--timeout-ms", "2000"];
  try {
    const { stdout, stderr } = await run(process.execPath, args,
      { env: { ...process.env, AGORA_STATE: stateRoot }, timeout: 30_000 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = /** @type {any} */ (error);
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

const lastJson = (/** @type {string} */ stdout) => {
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  assert.ok(line, `the gate printed no result line; stdout was ${JSON.stringify(stdout)}`);
  return JSON.parse(line);
};

test("while a resident holds the key the gate refuses and spawns NOTHING", async (t) => {
  const { root, stateRoot, keyPath, addressFile } = await rig(t);
  const keyDigest = await enrolledKeyDigest(keyPath);
  const marker = path.join(root, "ran.txt");
  const claimAttempt = path.join(root, "child-claim.json");
  const fixture = await preload(root, { marker, claimAttempt, stateRoot, keyDigest });

  const resident = await takeKeyClaim({ stateRoot, keyDigest, kind: "resident", label: "house-remote" });
  t.after(() => resident.release());

  const result = await gate({ stateRoot, fixture, addressFile, keyPath });
  assert.equal(result.code, 1);

  // The whole property: no child ever ran.
  assert.equal(existsSync(marker), false, "the gate spawned a competing Tailcat child while a resident held the key");

  const out = lastJson(result.stdout);
  assert.equal(out.refused, "member-key-claim-held");
  // A refusal is NOT a direct-path failure and must never be readable as one: nothing was measured,
  // so `pass` is absent rather than false, and a field says so.
  assert.equal(out.measured, false);
  assert.equal(out.deferred, true);
  assert.equal("pass" in out, false);
  assert.match(out.message, /not measured/);
  assert.match(out.message, /resident/);
});

test("with no resident the gate takes the claim, holds it ACROSS the child, and releases it", async (t) => {
  const { root, stateRoot, keyPath, addressFile } = await rig(t);
  const keyDigest = await enrolledKeyDigest(keyPath);
  const marker = path.join(root, "ran.txt");
  const claimAttempt = path.join(root, "child-claim.json");
  const fixture = await preload(root, { marker, claimAttempt, stateRoot, keyDigest });

  const result = await gate({ stateRoot, fixture, addressFile, keyPath });

  // The child ran, and it ran with the key.
  assert.equal(existsSync(marker), true);
  assert.match(await readFile(marker, "utf8"), /--key=.*identity\.private\.json/);
  assert.match(await readFile(marker, "utf8"), /ping --until-direct/);

  // The TOCTOU proof. The child tried to take the same claim while it was running; it must have
  // been refused, which is only true if the gate claimed BEFORE spawning and had not released yet.
  const attempt = JSON.parse(await readFile(claimAttempt, "utf8"));
  assert.equal(attempt.took, false, "the key was claimable while the gate's own child was running");
  assert.equal(attempt.code, "member-key-claim-held");

  // And the claim is gone afterwards: the gate releases its generation in a finally.
  const claimFile = keyClaimPath(await canonicalStateRoot(stateRoot), keyDigest);
  assert.equal(existsSync(claimFile), false, "the gate left its claim behind, fencing out every later member start");

  const out = lastJson(result.stdout);
  assert.equal(out.measured, true);
  assert.equal(out.pass, true);
  assert.equal(out.directEndpoint, "198.51.100.7:41641");
});

test("the claim is released even when the child fails, so a red probe does not fence the key", async (t) => {
  const { root, stateRoot, keyPath, addressFile } = await rig(t);
  const keyDigest = await enrolledKeyDigest(keyPath);
  const marker = path.join(root, "ran.txt");
  const claimAttempt = path.join(root, "child-claim.json");
  // No pong line: the probe fails its own assertion, which is the common case on a broken path.
  const fixture = await preload(root, { marker, claimAttempt, stateRoot, keyDigest, stdout: "no route to host\n" });

  const result = await gate({ stateRoot, fixture, addressFile, keyPath });
  assert.equal(result.code, 1);
  const out = lastJson(result.stdout);
  assert.equal(out.measured, true, "a failed probe DID measure; only a refusal did not");
  assert.equal(out.pass, false);
  assert.equal(out.directEndpoint, null);

  const claimFile = keyClaimPath(await canonicalStateRoot(stateRoot), keyDigest);
  assert.equal(existsSync(claimFile), false, "a failed probe left the key claimed, so no member start could ever run");
});

test("an identity whose digest cannot be derived refuses instead of spawning", async (t) => {
  const { root, stateRoot, keyPath, addressFile } = await rig(t);
  const marker = path.join(root, "ran.txt");
  const claimAttempt = path.join(root, "child-claim.json");
  const fixture = await preload(root, { marker, claimAttempt, stateRoot, keyDigest: `sha256:${"0".repeat(64)}` });
  // A key file the gate cannot read a public half out of: it cannot know which key the child would
  // use, so it cannot claim, so it must not spawn. Refusing is the safe direction.
  await writeFile(keyPath, JSON.stringify({ Private: "privkey:whatever" }), "utf8");

  const result = await gate({ stateRoot, fixture, addressFile, keyPath });
  assert.equal(result.code, 1);
  assert.equal(existsSync(marker), false, "the gate spawned a child under a key it could not identify");
});
