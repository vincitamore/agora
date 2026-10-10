// @ts-check
// The native record verbs (docs/PURGE.md § CLI) against a real seat service: `post --attach` posts a
// picture and a drawing that `attachment get` reads back verified, `edit`, `withdraw`, `pin` and
// `unpin` append annotations that `read` shows, `room purge` takes texts and blobs, and malformed
// arguments are refused with exit 2 before any config is read.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { EPOCH, ROOM, seat } from "./client-fixtures.mjs";

const run = promisify(execFile);
const BIN = new URL("../bin/agora.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(2048)]);
// a .vsdx is a zip package: its bytes prove no image, so custody records it a file
const VSDX = Buffer.concat([Buffer.from("PK\u0003\u0004", "latin1"), randomBytes(4096)]);
const digestOf = (/** @type {Uint8Array} */ b) => `sha256:${createHash("sha256").update(b).digest("hex")}`;
/** @param {string} file */
const exists = (file) => access(file).then(() => true, () => false);

/** @param {{ root: string, config: string }} s */
function cliEnv(s) {
  /** @type {Record<string, string | undefined>} */
  const env = { ...process.env, AGORA_CONFIG: s.config, AGORA_STATE: s.root, AGORA_SESSION: "probe", AGORA_ACTOR: "Grace/watch" };
  for (const name of ["CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_PID", "GROK_SESSION_ID", "GROK_PID", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "HERMES_SESSION_ID", "AGORA_SESSION_PID"]) delete env[name];
  return env;
}

/** @param {Record<string, string | undefined>} env */
const cliOf = (env) => /** @param {string[]} args */ (args) => run(process.execPath, [BIN, ...args], { env, windowsHide: true });
/** @param {Record<string, string | undefined>} env @param {string[]} args */
const failing = (env, args) => cliOf(env)(args).then(() => assert.fail(`agora ${args.join(" ")} succeeded`), (e) => /** @type {{ code: number, stderr: string }} */ (e));
/** @param {string} stdout */
const lines = (stdout) => stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

/** @param {Record<string, string | undefined>} env @param {string[]} args @param {string} input */
function withStdin(env, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env, windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", (b) => { stdout += b; });
    child.stderr.on("data", (b) => { stderr += b; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test("post --attach posts a PNG and a .vsdx; attachment get reads each back verified and never overwrites", { timeout: 90_000 }, async (t) => {
  const s = await seat(t);
  const env = cliEnv(s);
  const cli = cliOf(env);
  const dir = await mkdtemp(path.join(tmpdir(), "agora-cli-attach-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "panel.png"), PNG);
  await writeFile(path.join(dir, "layout.vsdx"), VSDX);

  await cli(["post", "house", "the panel and the layout", "--attach", path.join(dir, "panel.png"), "--attach", path.join(dir, "layout.vsdx")]);
  const [message] = lines((await cli(["read", "house", "--json"])).stdout);
  assert.equal(message.type, "message");
  assert.deepEqual(message.attachments.map((/** @type {any} */ a) => [a.name, a.kind, a.mimetype, a.size, a.digest, a.lifetime]), [
    ["panel.png", "image", "image/png", PNG.length, digestOf(PNG), "durable"],
    ["layout.vsdx", "file", "application/vnd.ms-visio.drawing.main+xml", VSDX.length, digestOf(VSDX), "durable"],
  ]);

  for (const [a, bytes] of /** @type {const} */ ([[message.attachments[0], PNG], [message.attachments[1], VSDX]])) {
    const out = path.join(dir, `back-${a.name}`);
    const got = lines((await cli(["attachment", "get", "house", a.id, "--out", out, "--json"])).stdout)[0];
    assert.deepEqual([got.type, got.id, got.digest, got.kind, got.size, got.path], ["attachment", a.id, a.digest, a.kind, bytes.length, out]);
    assert.equal(digestOf(await readFile(out)), a.digest, `${a.name} reads back byte for byte`);
    const again = await failing(env, ["attachment", "get", "house", a.id, "--out", out]);
    assert.equal(again.code, 1);
    assert.match(again.stderr, /never overwrites/);
  }
  const unknown = await failing(env, ["attachment", "get", "house", "z".repeat(64), "--out", path.join(dir, "nothing")]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /attachment-unknown/);
  assert.equal(await exists(path.join(dir, "nothing")), false);
});

test("edit, withdraw, pin and unpin append annotations that read shows; another kind of room is refused", { timeout: 90_000 }, async (t) => {
  const s = await seat(t);
  const env = cliEnv(s);
  const cli = cliOf(env);
  await cli(["post", "house", "the first word"]);
  await cli(["post", "house", "a second thought"]);
  const [first, second] = lines((await cli(["read", "house", "--json"])).stdout);

  const edit = lines((await cli(["edit", "house", first.id, "--text", "the first word, revised", "--json"])).stdout)[0];
  assert.deepEqual([edit.type, edit.act, edit.target, edit.cursor, edit.duplicate], ["annotation", "edit", first.id, `${EPOCH}:3`, false]);
  const piped = /** @type {{ code: number, stdout: string }} */ (await withStdin(env, ["edit", "house", second.id, "--stdin", "--json"], "a second thought, piped\n"));
  assert.equal(piped.code, 0);
  await cli(["pin", "house", first.id]);
  await cli(["unpin", "house", first.id]);
  await cli(["withdraw", "house", second.id]);

  const read = lines((await cli(["read", "house", "--json"])).stdout);
  assert.deepEqual(read.map((l) => [l.type, l.act ?? null, l.target ?? null]), [
    ["message", null, null], ["message", null, null],
    ["annotation", "edit", first.id], ["annotation", "edit", second.id], ["annotation", "pin", first.id], ["annotation", "unpin", first.id], ["annotation", "withdraw", second.id],
  ]);
  assert.equal(read[2].text, "the first word, revised\n\n-- Grace/watch", "an edit is signed as a post is");
  assert.equal(read[3].text, "a second thought, piped\n\n-- Grace/watch");

  // the store's refusal comes back by name with exit 1
  const late = await failing(env, ["edit", "house", second.id, "--text", "after the withdrawal"]);
  assert.equal(late.code, 1);
  assert.match(late.stderr, /annotation-target-withdrawn/);
  const local = await failing(env, ["pin", "scratch", first.id]);
  assert.equal(local.code, 2);
  assert.match(local.stderr, /belongs to a native room/);
});

test("room purge takes a message's text, or a thread's, and the blobs only they referenced", { timeout: 90_000 }, async (t) => {
  const s = await seat(t);
  const env = cliEnv(s);
  const cli = cliOf(env);
  const dir = await mkdtemp(path.join(tmpdir(), "agora-cli-purge-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "panel.png"), PNG);
  await cli(["post", "house", "a private note"]);
  await cli(["post", "house", "the root", "--attach", path.join(dir, "panel.png")]);
  const [note, root] = lines((await cli(["read", "house", "--json"])).stdout);
  await cli(["post", "house", "a reply", "--thread", root.id]);
  const reply = lines((await cli(["read", "house", "--json"])).stdout)[2];

  const one = lines((await cli(["room", "purge", "house", "--message", note.id, "--reason", "asked to remove it", "--json"])).stdout)[0];
  assert.deepEqual([one.type, one.purged, one.blobsRemoved, one.facesOutOfReach, one.duplicate], ["purge", [note.id], 0, [], false]);
  const thread = lines((await cli(["room", "purge", "house", "--thread", root.id, "--reason", "the thread goes", "--json"])).stdout)[0];
  assert.deepEqual([thread.purged, thread.blobsRemoved], [[root.id, reply.id], 1]);
  const blob = path.join(s.root, "native", "rooms", ROOM, "attachments", `sha256-${digestOf(PNG).slice(7)}`);
  assert.equal(await exists(blob), false);
  assert.equal(await exists(`${blob}.type`), false);

  const after = lines((await cli(["read", "house", "--json"])).stdout);
  assert.deepEqual(after.map((m) => [m.id, m.text]), [[note.id, ""], [root.id, ""], [reply.id, ""]], "every record keeps its place; the texts are gone");
  assert.deepEqual(after[1].attachments.map((/** @type {any} */ a) => a.name), ["panel.png"], "attachment metadata is kept");
  const human = (await cli(["room", "purge", "house", "--message", note.id, "--reason", "again"])).stdout;
  assert.match(human, /0 messages lost their text, 0 attachment blobs removed/, "an earlier purge's messages are not taken twice");
});

test("malformed arguments are refused with exit 2 before any config is read", { timeout: 60_000 }, async () => {
  const env = { ...process.env, AGORA_CONFIG: path.join(tmpdir(), "agora-no-such-config.json") };
  const id = "a".repeat(64);
  for (const [args, pattern] of /** @type {Array<[string[], RegExp]>} */ ([
    [["edit", "house", id], /exactly one of --text/],
    [["edit", "house", id, "--text", "x", "--stdin"], /exactly one of --text/],
    [["edit", "house"], /takes a room and a message id/],
    [["withdraw", "house", "not an id"], /is not a message id/],
    [["pin", "house", id, "--text", "x"], /carries no text/],
    [["attachment", "get", "house", id], /needs --out/],
    [["attachment", "fetch", "house", id, "--out", "x"], /takes get/],
    [["room", "purge", "house", "--reason", "r"], /needs --message/],
    [["room", "purge", "house", "--message", id], /needs --reason/],
    [["room", "purge", "house", "--message", id, "--thread", id, "--reason", "r"], /not both/],
    [["room", "purge", "house", "--thread", "short", "--reason", "r"], /native thread id/],
  ])) {
    const refused = await failing(env, args);
    assert.equal(refused.code, 2, args.join(" "));
    assert.match(refused.stderr, pattern, args.join(" "));
  }
});
