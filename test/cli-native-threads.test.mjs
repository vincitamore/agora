// @ts-check
// Threads and the `via` stamp on a native room, through the CLI a session actually runs: post
// --thread, read --thread, watch --thread, what --threads and --follow do on a room whose stream
// already carries every reply, and how a message an app client submitted is shown.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NativeRoomService, NativeServiceClient } from "../src/native-service.mjs";

const run = promisify(execFile);
const BIN = new URL("../bin/agora.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const ROOM = "b".repeat(32);
const EPOCH = "c".repeat(32);
const ACCOUNT = "seat_account_0007";
const CLEARED = ["CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_PID", "GROK_SESSION_ID", "GROK_PID", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "HERMES_SESSION_ID", "AGORA_SESSION_PID", "AGORA_SESSION", "AGORA_ACTOR", "AGORA_CONFIG", "AGORA_STATE"];

/** @param {string[]} args @param {Record<string, string>} env */
async function agora(args, env) {
  const clean = { ...process.env };
  for (const name of CLEARED) delete clean[name];
  try {
    const child = run(process.execPath, [BIN, ...args], { env: { ...clean, ...env }, windowsHide: true });
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
/** @param {string} out */
const messages = (out) => typed(out).filter((l) => l.type === "message");

/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-cli-threads-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new NativeRoomService({ root, accountId: ACCOUNT, seatLabel: "seat-a" });
  const endpoint = /** @type {any} */ (await service.start());
  await service.createRoom({ roomId: ROOM, epoch: EPOCH });
  t.after(() => service.stop());
  const cfgPath = path.join(root, "agora.json");
  await writeFile(cfgPath, JSON.stringify({ actor: { name: "seat", kind: "agent" }, rooms: { nat: { transport: "native", roomId: ROOM } } }));
  const grace = { AGORA_CONFIG: cfgPath, AGORA_STATE: root, AGORA_SESSION: "grace", AGORA_ACTOR: "Grace/watch" };
  const sol = { AGORA_CONFIG: cfgPath, AGORA_STATE: root, AGORA_SESSION: "sol", AGORA_ACTOR: "Cal/codex" };
  /** @param {Record<string, string>} env @param {string[]} args */
  const post = async (env, ...args) => {
    const r = await agora(["post", "nat", ...args, "--json"], env);
    assert.equal(r.code, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
  };
  return { root, service, endpoint, grace, sol, post };
}

test("cli: post --thread replies under a native root, read --thread is the root and its replies, and every reply carries thread", async (t) => {
  const { grace, sol, post } = await fixture(t);
  const root = await post(sol, "the question");
  await post(sol, "unrelated");
  const reply = await post(grace, "the answer", "--thread", root.id);
  assert.equal(reply.thread, root.id);
  const room = await agora(["read", "nat", "--json"], grace);
  assert.equal(room.code, 0, room.stderr);
  assert.deepEqual(messages(room.stdout).map((m) => [m.text.split("\n")[0], m.thread ?? null]), [["the question", null], ["unrelated", null], ["the answer", root.id]]);
  const thread = await agora(["read", "nat", "--thread", root.id, "--json"], grace);
  assert.equal(thread.code, 0, thread.stderr);
  assert.deepEqual(messages(thread.stdout).map((m) => m.text.split("\n")[0]), ["the question", "the answer"]);
  assert.match(thread.stderr, /read 2 messages from nat \(native\) thread [a-f0-9]{64} since the start/);
  // a reply to a reply, and an id the room does not hold, are refused by name and post nothing
  const nested = await agora(["post", "nat", "deeper", "--thread", reply.id], grace);
  assert.equal(nested.code, 1);
  assert.match(nested.stderr, /thread-root-not-top-level/);
  const unknown = await agora(["post", "nat", "nowhere", "--thread", "f".repeat(64)], grace);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /thread-root-unknown/);
  const malformed = await agora(["post", "nat", "bad", "--thread", "1756900001.000000"], grace);
  assert.equal(malformed.code, 2, "a thread id that is not a native message id is a usage error at the boundary");
  assert.match(malformed.stderr, /root message's id/);
  assert.equal(messages((await agora(["read", "nat", "--json"], grace)).stdout).length, 3, "nothing refused was posted");
  // --re on a native room names a message by cursor; it is not held to the thread shape
  const re = await agora(["post", "nat", "noted", "--re", reply.cursor], grace);
  assert.equal(re.code, 0, re.stderr);
});

test("cli: --threads on a native room reads nothing more, and a thread read after a quiet stretch says where its scan ended", async (t) => {
  const { grace, sol, post } = await fixture(t);
  const root = await post(sol, "root");
  await post(grace, "reply", "--thread", root.id);
  await post(sol, "later 1");
  await post(sol, "later 2");
  const plain = await agora(["read", "nat", "--json"], grace);
  const folded = await agora(["read", "nat", "--threads", "--json"], grace);
  assert.equal(folded.code, 0, folded.stderr);
  assert.deepEqual(messages(folded.stdout).map((m) => m.id), messages(plain.stdout).map((m) => m.id), "the same messages, each once");
  assert.match(folded.stderr, /native rooms carry every thread reply in the room read; --threads reads nothing more here/);
  const quiet = await agora(["read", "nat", "--thread", root.id, "--since", `${EPOCH}:2`, "--json"], grace);
  assert.equal(quiet.code, 0, quiet.stderr);
  assert.deepEqual(messages(quiet.stdout), []);
  assert.match(quiet.stderr, new RegExp(`the host scanned the room through ${EPOCH}:4, and the thread has nothing more before it \\(go on with --since ${EPOCH}:4\\)`));
});

test("cli: watch --thread delivers its thread only and keeps a room position under the thread's own key", async (t) => {
  const { root: state, grace, sol, post } = await fixture(t);
  const root = await post(sol, "root");
  await post(sol, "elsewhere");
  await post(sol, "reply one", "--thread", root.id);
  const first = await agora(["watch", "nat", "--thread", root.id, "--once", "--json"], grace);
  assert.equal(first.code, 42, first.stderr);
  assert.deepEqual(messages(first.stdout).map((m) => m.text.split("\n")[0]), ["root", "reply one"]);
  assert.match(first.stderr, /subscribed to nat thread [a-f0-9]{64} through the seat service/);
  const key = path.join(state, "sessions", "grace", `nat#${root.id}.cursor`);
  assert.equal(JSON.parse(await readFile(key, "utf8")).cursor, `${EPOCH}:3`, "the saved position is a room cursor");
  await post(sol, "elsewhere again");
  await post(sol, "reply two", "--thread", root.id);
  const second = await agora(["watch", "nat", "--thread", root.id, "--once", "--json"], grace);
  assert.equal(second.code, 42, second.stderr);
  assert.deepEqual(messages(second.stdout).map((m) => m.text.split("\n")[0]), ["reply two"], "the records outside the thread were passed over, not delivered");
  assert.equal(JSON.parse(await readFile(key, "utf8")).cursor, `${EPOCH}:5`);
  const quiet = await agora(["watch", "nat", "--thread", root.id, "--once", "--json"], grace);
  assert.equal(quiet.code, 0, quiet.stderr);
});

test("cli: watch --follow on a native room says it reads nothing more, and delivers each reply once", async (t) => {
  const { grace, sol, post } = await fixture(t);
  const root = await post(sol, "root");
  await post(sol, "reply", "--thread", root.id);
  const watched = await agora(["watch", "nat", "--follow", "--once", "--json"], grace);
  assert.equal(watched.code, 42, watched.stderr);
  assert.match(watched.stderr, /--follow reads nothing more here and no reply is delivered twice/);
  assert.deepEqual(messages(watched.stdout).map((m) => m.text.split("\n")[0]), ["root", "reply"]);
  const result = typed(watched.stdout).find((l) => l.type === "watch-result");
  assert.equal(result.following, 0);
});

test("cli: a message an app client submitted shows its via and the person's ref, and who names the person, never the client", async (t) => {
  const { endpoint, grace, post } = await fixture(t);
  const app = await NativeServiceClient.connect({ ...endpoint, clientName: "review-app" });
  t.after(() => app.close());
  await app.request("append", { roomId: ROOM, operation: { operationId: randomUUID().replaceAll("-", ""), authorName: "Dana", authorKind: "human", authorRef: "u-17", text: "is the review ready?" } });
  await post(grace, "it is");
  const human = await agora(["read", "nat"], grace);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /\] Dana · via review-app \(human\)  cursor /);
  assert.doesNotMatch(human.stdout, /Grace\/watch[^\n]*via/, "a CLI post declares no client name");
  const json = messages((await agora(["read", "nat", "--json"], grace)).stdout);
  assert.equal(json[0].via, "review-app");
  assert.deepEqual(json[0].author, { id: ACCOUNT, name: "Dana", kind: "human", ref: "u-17" });
  assert.equal("via" in json[1], false);
  const who = typed((await agora(["who", "nat", "--json"], grace)).stdout).filter((l) => l.type === "who").map((l) => l.name).sort();
  assert.deepEqual(who, ["Dana", "Grace/watch"], "who names the person and the bearer; a client name is not a participant");
});
