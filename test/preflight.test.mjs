// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ARGUMENT_PREFLIGHTS } from "../bin/agora.mjs";

const bin = fileURLToPath(new URL("../bin/agora.mjs", import.meta.url));
const missingConfig = path.join(tmpdir(), `agora-no-config-${process.pid}-preflight.json`);

/** @param {string[]} args @param {NodeJS.ProcessEnv} [overrides] */
function run(args, overrides = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^CODEX_|^AGORA_CODEX/.test(key)) delete env[key];
    const child = spawn(process.execPath, [bin, ...args], {
      env: { ...env, AGORA_CONFIG: missingConfig, AGORA_SESSION: "preflight-test", AGORA_ACTOR: "Test/preflight", ...overrides },
      windowsHide: true,
    });
    child.stdin.end();
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("usage-sessions preflight owns required paths and positive limit shapes", async () => {
  for (const [args, refusal] of [
    [["usage-sessions", "--json"], "--ledger-root is required"],
    [["usage-sessions", "--ledger-root", "x", "--ledger-max-bytes", "0"], "--ledger-max-bytes must be a positive integer"],
    [["usage-sessions", "--ledger-root", "x", "--ledger-max-entries", "1.5"], "--ledger-max-entries must be a positive integer"],
  ]) {
    const result = /** @type {any} */ (await run(/** @type {string[]} */ (args)));
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.stderr, `agora: ${refusal}\n`);
    assert.doesNotMatch(result.stderr, /no config/);
  }
  const admitted = /** @type {any} */ (await run(["usage-sessions", "--ledger-root", "x", "--ledger-max-bytes", "1", "--ledger-max-entries", "1"]));
  assert.equal(admitted.code, 1, admitted.stderr);
  assert.match(admitted.stderr, /no config/);
});

test("service-route preflight owns the subverb, room-id and public-key shapes", async () => {
  for (const [args, refusal] of [
    [["service", "route"], "agora service route needs open, list or close"],
    [["service", "route", "open"], "agora service route open needs <room>"],
    [["service", "route", "open", "_".repeat(32), "--allow-key", `nodekey:${"a".repeat(64)}`], "native room id must be 32 lowercase hexadecimal characters"],
    [["service", "route", "open", "b".repeat(32), "--allow-key", "deadbeef"], "--allow-key takes the public node key as enroll prints it: nodekey: followed by 64 hex characters"],
  ]) {
    const result = /** @type {any} */ (await run(/** @type {string[]} */ (args)));
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.stderr, `agora: ${refusal}\n`);
    assert.doesNotMatch(result.stderr, /no config/);
  }
  const admitted = /** @type {any} */ (await run(["service", "route", "list"]));
  assert.equal(admitted.code, 1, admitted.stderr);
  assert.match(admitted.stderr, /no config/);
});

test("room-add-remote preflight owns both positionals and their shapes", async () => {
  for (const [args, refusal] of [
    [["room", "add-remote"], "agora room add-remote needs <alias> <descriptor-path>"],
    [["room", "add-remote", "house"], "agora room add-remote needs <alias> <descriptor-path>"],
    [["room", "add-remote", "_bad", "/tmp/route.json"], "a room alias starts with a letter or digit and carries letters, digits, dot, underscore or hyphen"],
    [["room", "add-remote", "house", " "], "agora room add-remote needs a descriptor path"],
  ]) {
    const result = /** @type {any} */ (await run(/** @type {string[]} */ (args)));
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.stderr, `agora: ${refusal}\n`);
    assert.doesNotMatch(result.stderr, /no config/);
  }
  const admitted = /** @type {any} */ (await run(["room", "add-remote", "house", "/tmp/route.json"]));
  assert.equal(admitted.code, 1, admitted.stderr);
  assert.match(admitted.stderr, /no config/);
});

test("watch-codex-bridge preflight owns the Codex delivery shape", async () => {
  const refused = /** @type {any} */ (await run(["watch", "agora", "--once"], { CODEX_THREAD_ID: "thread-1" }));
  assert.equal(refused.code, 2, refused.stderr);
  const row = ARGUMENT_PREFLIGHTS.find((candidate) => candidate.name === "watch-codex-bridge");
  const message = row?.refusal({ verb: "watch", roomAlias: "agora", rest: [], values: {}, env: { CODEX_THREAD_ID: "thread-1" } });
  assert.equal(refused.stderr, `agora: ${message}\n`);
  assert.doesNotMatch(refused.stderr, /no config/);
  const admitted = /** @type {any} */ (await run(["watch", "agora", "--print-only", "--once"], { CODEX_THREAD_ID: "thread-1" }));
  assert.equal(admitted.code, 1, admitted.stderr);
  assert.match(admitted.stderr, /no config/);
});

test("economy-shadow preflight owns the subverb and every argument shape", async () => {
  const wrongSubverb = /** @type {any} */ (await run(["economy", "replay"]));
  assert.equal(wrongSubverb.code, 2, wrongSubverb.stderr);
  assert.equal(wrongSubverb.stderr, 'agora: economy takes one subverb: shadow (got "replay")\n');
  const malformed = /** @type {any} */ (await run(["economy", "shadow", "--ledger-root", "x"]));
  assert.equal(malformed.code, 2, malformed.stderr);
  assert.equal(malformed.stderr, "agora: --rates is required\n");
  assert.doesNotMatch(malformed.stderr, /no config/);
  const args = [
    "economy", "shadow", "--ledger-root", "x", "--rates", "/nope/rates.json",
    "--billing-context", "/nope/billing.json", "--envelope", "/nope/envelope.json",
    "--verification-cost", "0.05", "--epsilon", "0.1", "--risk-budget", "0.1",
    "--as-of", "2026-09-07T10:00:00.000Z", "--observation-cutoff", "2026-09-07T09:00:00.000Z",
    "--split-at", "2026-09-07T09:30:00.000Z",
  ];
  const admitted = /** @type {any} */ (await run(args));
  assert.equal(admitted.code, 1, admitted.stderr);
  assert.match(admitted.stderr, /--rates is not readable/);
  assert.doesNotMatch(admitted.stderr, /no config/);
});

test("ARGUMENT_PREFLIGHTS is the only verb-specific pre-config refusal table (value and source-shape guard)", async () => {
  assert.deepEqual(ARGUMENT_PREFLIGHTS.map((row) => row.name), [
    "usage-sessions", "service-route", "authority", "service-authority", "room-add-remote", "watch-codex-bridge", "economy-shadow",
  ]);
  assert.equal(new Set(ARGUMENT_PREFLIGHTS.map((row) => row.name)).size, ARGUMENT_PREFLIGHTS.length);

  const source = await readFile(bin, "utf8");
  const tableStart = source.indexOf("export const ARGUMENT_PREFLIGHTS");
  const tableEnd = source.indexOf("export function runArgumentPreflights");
  assert.ok(tableStart >= 0 && tableEnd > tableStart, "the exported table has no bounded source region");
  const outside = source.slice(0, tableStart) + source.slice(tableEnd);
  for (const legacy of [
    'if (verb === "service" && roomAlias === "route")',
    'if (verb === "room" && roomAlias === "add-remote")',
    'if (verb === "watch") {\n    const refusal = codexBridgeRefusal',
    'if (roomAlias !== "shadow") throw new AgoraError',
    'if (values["ledger-root"] === undefined) {',
  ]) assert.equal(outside.includes(legacy), false, `standalone preflight survived: ${legacy}`);
  assert.equal((source.match(/runArgumentPreflights\(\{ verb, roomAlias, rest, values, env: process\.env \}\)/g) ?? []).length, 1);
});
