// @ts-check
// `agora room upgrade <room> --confirm <roomId>` (docs/NATIVE-ROOMS.md): a version 2 room the seat
// service does not hold is rewritten as version 3 offline; one the service holds is refused
// room-in-use; the id is typed again or nothing happens; the backup goes only with --prune-backup.
// Then the service serves the upgraded room, and a purge through the CLI leaves no file in the room
// directory naming the purged attachment.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { seat } from "./client-fixtures.mjs";
import { NativeRoomStore } from "../src/native-store.mjs";

const run = promisify(execFile);
const BIN = new URL("../bin/agora.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const OLD = "0123456789abcdef".repeat(2);
const NAME = "board-minutes-zq9.pdf";

/** @param {{ root: string, config: string }} s */
function cliEnv(s) {
  /** @type {Record<string, string | undefined>} */
  const env = { ...process.env, AGORA_CONFIG: s.config, AGORA_STATE: s.root, AGORA_SESSION: "probe", AGORA_ACTOR: "Grace/watch" };
  for (const name of ["CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_PID", "GROK_SESSION_ID", "GROK_PID", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "HERMES_SESSION_ID", "AGORA_SESSION_PID"]) delete env[name];
  return env;
}

/** @param {string} dir @param {string} needle */
async function grep(dir, needle) {
  /** @type {string[]} */
  const hits = [];
  for (const entry of await readdir(dir, { recursive: true })) {
    const file = path.join(dir, entry);
    if ((await stat(file)).isFile() && (await readFile(file)).includes(Buffer.from(needle, "utf8"))) hits.push(entry.replaceAll("\\", "/"));
  }
  return hits.sort();
}

test("room upgrade: confirm, in-use refusal, an offline upgrade the service then serves, the backup pruned, and a purge that leaves no name on disk", { timeout: 90_000 }, async (t) => {
  const s = await seat(t);
  const config = JSON.parse(s.configBody);
  config.rooms.old = { transport: "native", roomId: OLD };
  await writeFile(s.config, JSON.stringify(config), "utf8");
  const env = cliEnv(s);
  /** @param {string[]} args */
  const cli = (args) => run(process.execPath, [BIN, ...args], { env, windowsHide: true });
  /** @param {string[]} args */
  const fails = (args) => cli(args).then(() => assert.fail(`${args.join(" ")} succeeded`), (e) => e);

  // a version 2 room on this seat that the service has not opened
  const v2 = await NativeRoomStore.create({ root: s.root, roomId: OLD, hostAccountId: "seat_account_0001", logVersion: 2 });
  const posted = await v2.append({ operationId: randomUUID().replaceAll("-", ""), authorName: "Ada", authorKind: "human", text: "the minutes",
    attachments: [{ id: `att_${"a".repeat(20)}`, name: NAME, kind: "file", size: 10, digest: `sha256:${"a".repeat(64)}` }] }, { accountId: "seat_account_0001" });
  await v2.close();
  const dir = path.join(s.root, "native", "rooms", OLD);

  const missing = await fails(["room", "upgrade", "old"]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /confirm-required/);
  const wrong = await fails(["room", "upgrade", "old", "--confirm", "f".repeat(32)]);
  assert.equal(wrong.code, 2);
  assert.match(wrong.stderr, /confirm-mismatch/);

  // the service holds `house` open: refused by name, nothing changed
  const app = await s.open();
  await app.read("house");
  const busy = await fails(["room", "upgrade", "house", "--confirm", config.rooms.house.roomId]);
  assert.equal(busy.code, 1);
  assert.match(busy.stderr, /room-in-use/);

  const done = JSON.parse((await cli(["room", "upgrade", "old", "--confirm", OLD, "--json"])).stdout);
  assert.deepEqual([done.type, done.action, done.from, done.to, done.records], ["room", "upgrade", 2, 3, 1]);
  assert.equal(JSON.parse(await readFile(path.join(dir, "room.json"), "utf8")).logVersion, 3);

  // the service opens the upgraded room and serves what it served before
  const { messages } = await app.read("old");
  assert.deepEqual(messages.map((m) => [m.id, m.text, m.attachments?.[0]?.name]), [[posted.id, "the minutes", NAME]]);
  assert.deepEqual(await grep(dir, NAME), ["room.frames.1", "upgrade-v2-backup/room.frames"]);

  const pruned = JSON.parse((await cli(["room", "upgrade", "old", "--confirm", OLD, "--prune-backup", "--json"])).stdout);
  assert.deepEqual([pruned.action, pruned.removed], ["upgrade-prune-backup", true]);
  await cli(["room", "purge", "old", "--message", posted.id, "--reason", "asked to remove it"]);
  assert.deepEqual(await grep(dir, NAME), [], "no file under the room directory names the purged attachment");
});
