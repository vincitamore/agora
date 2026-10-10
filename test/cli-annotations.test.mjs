// @ts-check
// `agora read` on a native room shows annotation lines (docs/ANNOTATIONS.md § CLI): messages posted
// through the CLI into a version 2 room, edited and withdrawn through agora/client on the same seat
// (the CLI's own edit and withdraw verbs are not part of this build), and read back through the CLI
// as JSON lines and as human output, in log order.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { EPOCH, ROOM, seat } from "./client-fixtures.mjs";

const run = promisify(execFile);
const BIN = new URL("../bin/agora.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/** @param {{ root: string, config: string }} s */
function cliEnv(s) {
  /** @type {Record<string, string | undefined>} */
  const env = { ...process.env, AGORA_CONFIG: s.config, AGORA_STATE: s.root, AGORA_SESSION: "probe", AGORA_ACTOR: "Grace/watch" };
  for (const name of ["CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_PID", "GROK_SESSION_ID", "GROK_PID", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "HERMES_SESSION_ID", "AGORA_SESSION_PID"]) delete env[name];
  return env;
}

test("read prints annotation lines among the messages, in log order, as JSON and for a person", { timeout: 60_000 }, async (t) => {
  const s = await seat(t);
  const manifest = JSON.parse(await readFile(path.join(s.root, "native", "rooms", ROOM, "room.json"), "utf8"));
  assert.equal(manifest.logVersion, 2);
  const env = cliEnv(s);
  /** @param {string[]} args */
  const cli = (args) => run(process.execPath, [BIN, ...args], { env, windowsHide: true });

  await cli(["post", "house", "the first word"]);
  await cli(["post", "house", "a second thought"]);

  const app = await s.open();
  const { messages } = await app.read("house");
  assert.deepEqual(messages.map((m) => m.cursor), [`${EPOCH}:1`, `${EPOCH}:2`]);
  const [first, second] = messages;
  // the CLI posted as the seat with no client name and no ref, so the same author is the seat with neither
  const grace = { kind: /** @type {const} */ ("agent"), name: "Grace/watch" };
  const edit = await app.annotate("house", { act: "edit", target: first.id, text: "the first word, revised", author: grace });
  const withdraw = await app.annotate("house", { act: "withdraw", target: second.id, author: grace });
  assert.deepEqual([edit.cursor, withdraw.cursor], [`${EPOCH}:3`, `${EPOCH}:4`]);

  const json = (await cli(["read", "house", "--json"])).stdout.trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(json.map((l) => [l.type, l.cursor]), [["message", `${EPOCH}:1`], ["message", `${EPOCH}:2`], ["annotation", `${EPOCH}:3`], ["annotation", `${EPOCH}:4`]]);
  const [, , editLine, withdrawLine] = json;
  assert.deepEqual(editLine, { type: "annotation", alias: "house", id: edit.id, cursor: `${EPOCH}:3`, ts: editLine.ts, act: "edit", target: first.id,
    text: "the first word, revised", author: { id: first.author.id, name: "Grace/watch", kind: "agent" } });
  assert.deepEqual(withdrawLine, { type: "annotation", alias: "house", id: withdraw.id, cursor: `${EPOCH}:4`, ts: withdrawLine.ts, act: "withdraw", target: second.id,
    author: { id: first.author.id, name: "Grace/watch", kind: "agent" } });
  assert.match(editLine.ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(json[0].text.startsWith("the first word"), true, "the message line keeps the committed text");

  // after a cursor: only what came later, annotations included
  const later = (await cli(["read", "house", "--json", "--since", `${EPOCH}:2`])).stdout.trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(later.map((l) => [l.type, l.act]), [["annotation", "edit"], ["annotation", "withdraw"]]);

  const people = (await cli(["read", "house"])).stdout;
  const editAt = people.indexOf(`Grace/watch (agent) edit ${first.id}  cursor ${EPOCH}:3`);
  const withdrawAt = people.indexOf(`Grace/watch (agent) withdraw ${second.id}  cursor ${EPOCH}:4`);
  assert.ok(editAt > people.indexOf("a second thought"), "the edit line follows both messages");
  assert.ok(withdrawAt > editAt, "the withdraw line follows the edit");
  assert.match(people.slice(editAt, withdrawAt), /\n\s+the first word, revised\n/, "the edit's text is shown under its line");
});
