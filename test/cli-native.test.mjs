// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { NativeRoomService } from "../src/native-service.mjs";

const run = promisify(execFile);
const BIN = new URL("../bin/agora.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const ROOM = "9".repeat(32);
const EPOCH = "a".repeat(32);
const ACCOUNT = "seat_account_0003";
const CLEARED = ["CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_PID", "GROK_SESSION_ID", "GROK_PID", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "HERMES_SESSION_ID", "AGORA_SESSION_PID", "AGORA_SESSION", "AGORA_ACTOR", "AGORA_CONFIG", "AGORA_STATE"];

/** @param {Record<string, string>} env */
function childEnv(env) {
  const clean = { ...process.env };
  for (const name of CLEARED) delete clean[name];
  return { ...clean, ...env };
}

/** @param {string[]} args @param {Record<string, string>} env */
async function agora(args, env) {
  try {
    const child = run(process.execPath, [BIN, ...args], { env: childEnv(env), windowsHide: true });
    child.child.stdin?.end();
    const { stdout, stderr } = await child;
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = /** @type {any} */ (e);
    return { code: err.code, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

/** @param {string} out */
const typed = (out) => out.trim().split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));

/**
 * A resident watch as a harness would run it: spawned, its stdout collected line by line, its exit
 * awaited by the test that decides what should have ended it.
 * @param {string[]} args @param {Record<string, string>} env
 */
function resident(args, env) {
  const child = spawn(process.execPath, [BIN, ...args], { env: childEnv(env), windowsHide: true });
  child.stdin.end();
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (s) => { stdout += s; });
  child.stderr.setEncoding("utf8").on("data", (s) => { stderr += s; });
  const closed = once(child, "close").then(([code]) => ({ code, stdout, stderr }));
  return { child, closed, out: () => stdout, err: () => stderr };
}

/** @param {() => Promise<boolean>} probe @param {string} what */
async function until(probe, what, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await delay(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-cli-native-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new NativeRoomService({ root, accountId: ACCOUNT, seatLabel: "admin-pc" });
  await service.start();
  await service.createRoom({ roomId: ROOM, epoch: EPOCH });
  t.after(() => service.stop());
  const cfgPath = path.join(root, "agora.json");
  await writeFile(cfgPath, JSON.stringify({ actor: { name: "seat", kind: "agent" }, rooms: { nat: { transport: "native", roomId: ROOM } } }));
  const fable = { AGORA_CONFIG: cfgPath, AGORA_STATE: root, AGORA_SESSION: "fable", AGORA_ACTOR: "Fable/watch" };
  const sol = { AGORA_CONFIG: cfgPath, AGORA_STATE: root, AGORA_SESSION: "sol", AGORA_ACTOR: "Sol/codex" };
  return { root, service, fable, sol, cursorFile: path.join(root, "sessions", "fable", "nat.cursor"), armedFile: path.join(root, "sessions", "fable", "armed", "nat.json") };
}

test("cli: a watch on a native room rides the seat service and prints the poller's lines", { timeout: 60000 }, async (t) => {
  const { fable, sol, cursorFile } = await fixture(t);
  let r = await agora(["post", "nat", "hello from Sol", "--json"], sol);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).cursor, `${EPOCH}:1`);

  r = await agora(["watch", "nat", "--once", "--json"], fable);
  assert.equal(r.code, 42, r.stderr);
  assert.match(r.stderr, /subscribed to nat through the seat service \(admin-pc\)/);
  const lines = typed(r.stdout);
  assert.equal(lines[0].type, "identity");
  const message = lines.find((l) => l.type === "message");
  assert.equal(message.text, "hello from Sol\n\n-- Sol/codex");
  assert.equal(message.signedAs, "Sol/codex");
  assert.equal(message.cursor, `${EPOCH}:1`);
  assert.equal(message.author.id, ACCOUNT, "the host stamped the account; the bearer is the signature");
  const result = lines[lines.length - 1];
  assert.equal(result.type, "watch-result");
  assert.equal(result.fired, true);
  assert.equal(result.delivered, 1);
  assert.equal(result.exit, 42);
  assert.equal(result.reason, undefined);
  assert.equal(result.never_offered, undefined, "a room inside the window offers everything, and the line carries no field for it");
  assert.equal(JSON.parse(await readFile(cursorFile, "utf8")).cursor, `${EPOCH}:1`, "the same cursor file the poller writes");

  r = await agora(["watch", "nat", "--once", "--json"], fable);
  assert.equal(r.code, 0, "nothing new is 0, as on every transport");
  assert.equal(typed(r.stdout).at(-1).fired, false);

  // this session's own post is skipped by the ledger, and still advances the cursor
  r = await agora(["post", "nat", "my own line"], fable);
  assert.equal(r.code, 0, r.stderr);
  r = await agora(["watch", "nat", "--once", "--json"], fable);
  assert.equal(r.code, 0);
  assert.equal(typed(r.stdout).at(-1).skipped, 1);
  assert.equal(JSON.parse(await readFile(cursorFile, "utf8")).cursor, `${EPOCH}:2`);

  // --wake mine: plain talk is filtered, what names this bearer wakes
  await agora(["post", "nat", "plain talk"], sol);
  await agora(["post", "nat", "for you", "--to", "Fable/watch"], sol);
  r = await agora(["watch", "nat", "--once", "--json", "--wake", "mine"], fable);
  assert.equal(r.code, 42, r.stderr);
  assert.deepEqual(typed(r.stdout).filter((l) => l.type === "message").map((l) => l.text.split("\n")[0]), ["for you"]);
  assert.equal(typed(r.stdout).at(-1).filtered, 1);
  assert.equal(JSON.parse(await readFile(cursorFile, "utf8")).cursor, `${EPOCH}:4`);
});

test("cli: a resident native watch is a live subscriber with its build, wakes on an event, and a dead service is exit 1 service-dark with the cursor untouched", { timeout: 60000 }, async (t) => {
  const { service, fable, sol, cursorFile, armedFile } = await fixture(t);
  await agora(["cursor", "nat", "--now"], fable);
  const first = resident(["watch", "nat", "--json"], fable);
  t.after(() => { if (first.child.exitCode === null) first.child.kill(); });
  await until(async () => { try { await readFile(armedFile); return true; } catch { return false; } }, "the armed record");
  const armed = JSON.parse(await readFile(armedFile, "utf8"));
  assert.equal(armed.subscriber, true);
  assert.equal(armed.transport, "native");
  assert.equal(armed.pid, first.child.pid);
  assert.equal(typeof armed.build?.version, "string", "the build field is written as for every watch");

  const doctor = await agora(["doctor", "--json", "--offline"], fable);
  const rows = typed(doctor.stdout);
  const subscriber = rows.find((l) => l.type === "subscriber" && l.session === "fable");
  assert.ok(subscriber, "doctor lists the native subscriber as a live watch");
  assert.equal(subscriber.room, "nat");
  assert.equal(subscriber.pid, first.child.pid);
  assert.equal(subscriber.build.version, armed.build.version);
  assert.match(subscriber.buildLabel, /^\d/);
  const native = rows.find((l) => l.type === "native-service");
  assert.equal(native.present, true);
  assert.equal(native.accountId, ACCOUNT);
  assert.equal(native.pidAlive, true);
  assert.ok(!doctor.stdout.includes(service.nonce), "doctor never prints the service secret");
  assert.ok(!rows.some((l) => l.type === "poll-rate" && l.transport === "native"), "a subscriber spends no poll budget");

  const posted = await agora(["post", "nat", "wake up"], sol);
  assert.equal(posted.code, 0, posted.stderr);
  const ended = await first.closed;
  assert.equal(ended.code, 42, ended.stderr);
  const lines = typed(ended.stdout);
  assert.equal(lines.find((l) => l.type === "message")?.text.split("\n")[0], "wake up");
  assert.equal(lines.at(-1).type, "watch-result");
  assert.equal(lines.at(-1).fired, true);
  const cursorAfter = JSON.parse(await readFile(cursorFile, "utf8")).cursor;
  assert.equal(cursorAfter, `${EPOCH}:1`);
  await until(async () => { try { await readFile(armedFile); return false; } catch { return true; } }, "the armed record to be removed");

  const second = resident(["watch", "nat", "--json"], fable);
  t.after(() => { if (second.child.exitCode === null) second.child.kill(); });
  await until(async () => { try { await readFile(armedFile); return true; } catch { return false; } }, "the second armed record");
  await service.stop();
  const dark = await second.closed;
  assert.equal(dark.code, 1, "a dark service is never a quiet room");
  const last = typed(dark.stdout).at(-1);
  assert.equal(last.type, "watch-result");
  assert.equal(last.reason, "service-dark");
  assert.equal(last.fired, false);
  assert.equal(last.exit, 1);
  assert.match(dark.stderr, /service-dark|dark/);
  assert.equal(JSON.parse(await readFile(cursorFile, "utf8")).cursor, cursorAfter, "no cursor movement on a dark service");

  const absent = await agora(["watch", "nat", "--once", "--json"], fable);
  assert.equal(absent.code, 1);
  const absentResult = typed(absent.stdout).at(-1);
  assert.equal(absentResult.type, "watch-result");
  assert.equal(absentResult.reason, "service-dark");
  assert.equal(absentResult.polls, 0);
  assert.match(absent.stderr, /no seat service descriptor/);

  const refused = await agora(["post", "nat", "into the dark"], sol);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /room-dark/);
  assert.doesNotMatch(refused.stdout, /cursor/, "no cursor is fabricated for a refused post");
});
