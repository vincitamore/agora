// @ts-check
// The seat service's log (src/service-log.mjs): a detached daemon's face warnings land in
// `<state>/native/service.log`, one JSON line each, 0600, rotated at a cap into a bounded set of
// files, with no token and no message text; `agora doctor` names the log and shows its last lines,
// and `agora service status --json` carries the last warning's time.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SERVICE_LOG_MESSAGE_MAX, createServiceLog, readServiceLog, serviceLogPath } from "../src/service-log.mjs";
import { slackInboundTick } from "../src/faces-inbound.mjs";

const run = promisify(execFile);
const BIN = fileURLToPath(new URL("../bin/agora.mjs", import.meta.url));
const CLEARED = ["CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_PID", "GROK_SESSION_ID", "GROK_PID", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "HERMES_SESSION_ID", "AGORA_SESSION_PID", "AGORA_SESSION", "AGORA_ACTOR", "AGORA_CONFIG", "AGORA_STATE"];
const ROOM = "8f2c1a0b4d6e9f7a2b5c8d1e3f4a6b90";
const TOKEN = "xoxb-1234567890-abcdefghijklmnop";

/** @param {string[]} args @param {Record<string, string>} env */
async function agora(args, env) {
  try {
    const clean = { ...process.env };
    for (const name of CLEARED) delete clean[name];
    const child = run(process.execPath, [BIN, ...args], { env: { ...clean, ...env }, windowsHide: true });
    child.child.stdin?.end();
    const { stdout, stderr } = await child;
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = /** @type {any} */ (e);
    return { code: err.code, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

/** @param {import('node:test').TestContext} t */
async function stateRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-service-log-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("a warning is one JSON line with its time, level and room, 0600, and carries no token", async (t) => {
  const root = await stateRoot(t);
  /** @type {string[]} */
  const echoed = [];
  const log = createServiceLog(root, { now: () => new Date("2026-10-12T09:00:00.000Z"), echo: (l) => echoed.push(l) });
  log.warn(`agora: face tick of ${ROOM} failed: slack auth.test refused token ${TOKEN}`);
  log.warn("x".repeat(SERVICE_LOG_MESSAGE_MAX * 3));
  const text = await readFile(serviceLogPath(root), "utf8");
  assert.doesNotMatch(text, /xoxb-1234567890/, "the token never reaches the file");
  assert.doesNotMatch(echoed.join("\n"), /xoxb-1234567890/, "nor the echo");
  const [first, second] = text.trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(Object.keys(first).sort(), ["level", "message", "room", "ts"]);
  assert.deepEqual([first.ts, first.level, first.room], ["2026-10-12T09:00:00.000Z", "warn", ROOM]);
  assert.match(first.message, /face tick of 8f2c.* failed: .*\[redacted\]/);
  assert.equal(second.room, undefined, "a warning that names no room carries none");
  assert.ok(second.message.length <= SERVICE_LOG_MESSAGE_MAX, "a line is bounded");
  if (process.platform !== "win32") assert.equal((await stat(serviceLogPath(root))).mode & 0o777, 0o600);
});

test("the log rotates at its cap into a bounded set of files, and the reader reads across them in order", async (t) => {
  const root = await stateRoot(t);
  let n = 0;
  const log = createServiceLog(root, { maxBytes: 400, files: 3, now: () => new Date(Date.UTC(2026, 9, 12, 9, 0, n++)) });
  for (let i = 0; i < 40; i++) log.warn(`warning number ${String(i).padStart(2, "0")} about room ${ROOM}`);
  const names = (await readdir(path.join(root, "native"))).filter((f) => f.startsWith("service.log")).sort();
  assert.deepEqual(names, ["service.log", "service.log.1", "service.log.2"], "never more than three files");
  for (const f of names) assert.ok((await stat(path.join(root, "native", f))).size <= 400, `${f} is within the cap`);
  const last = readServiceLog(root, { last: 6 });
  assert.deepEqual(last.map((l) => l.message.slice(15, 17)), ["34", "35", "36", "37", "38", "39"], "the newest six, oldest first, across a rotation");
  assert.deepEqual(readServiceLog(path.join(root, "absent")), []);
});

test("the inbound tick's warnings land in the log when the daemon hands it the log's warn", async (t) => {
  const root = await stateRoot(t);
  const log = createServiceLog(root);
  const tick = slackInboundTick({ connect: async () => { throw new Error(`the service refused the hello (${TOKEN})`); }, warn: log.warn });
  const face = { transport: "slack", alias: "house-slack", target: { channel: "C0123ABC" }, enabled: true, post: { human: /** @type {any} */ (["always"]), agent: /** @type {any} */ (["never"]), system: /** @type {any} */ (["never"]) }, attachments: /** @type {const} */ ("metadata"), backfill: null };
  await tick.onTick({ root, roomId: ROOM, runner: /** @type {any} */ ({}), faces: [face] });
  const [line] = readServiceLog(root);
  assert.equal(line.room, ROOM);
  assert.match(line.message, /inbound slack face of 8f2c.* not polled/);
  assert.doesNotMatch(JSON.stringify(line), /xoxb-1234567890/);
});

test("doctor names the log and shows its last warnings; service status --json carries the last warning's time", async (t) => {
  const root = await stateRoot(t);
  const cfg = path.join(root, "agora.json");
  await writeFile(cfg, JSON.stringify({ actor: { name: "Opus/test", kind: "agent" }, rooms: { desk: { transport: "local", path: path.join(root, "desk.ndjson") } } }));
  const env = { AGORA_STATE: root, AGORA_CONFIG: cfg, AGORA_SESSION: "s1", AGORA_ACTOR: "Opus/test" };
  let r = await agora(["service", "status", "--json"], env);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual([JSON.parse(r.stdout).lastWarningAt, JSON.parse(r.stdout).log], [null, serviceLogPath(root)]);
  const log = createServiceLog(root, { now: () => new Date("2026-10-12T09:30:00.000Z") });
  log.warn(`agora: face sweep of ${ROOM} failed: a token ${TOKEN} was refused`);
  r = await agora(["doctor", "--offline"], env);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes(`log ${serviceLogPath(root)}, the last 1:`), r.stdout);
  assert.match(r.stdout, /2026-10-12T09:30:00\.000Z warn 8f2c1a0b4d6e9f7a2b5c8d1e3f4a6b90 agora: face sweep of .* failed/);
  assert.doesNotMatch(r.stdout, /xoxb-1234567890/);
  r = await agora(["doctor", "--offline", "--json"], env);
  /** @type {any[]} */
  const lines = r.stdout.trim().split(/\r?\n/).map((/** @type {string} */ l) => JSON.parse(l));
  const native = lines.find((/** @type {any} */ l) => l.type === "native-service");
  assert.deepEqual([native.log, native.lastWarningAt], [serviceLogPath(root), "2026-10-12T09:30:00.000Z"]);
  assert.equal(lines.filter((/** @type {any} */ l) => l.type === "service-log").length, 1);
  r = await agora(["service", "status", "--json"], env);
  assert.equal(JSON.parse(r.stdout).lastWarningAt, "2026-10-12T09:30:00.000Z");
});
