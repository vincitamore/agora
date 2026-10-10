// @ts-check
// The native record verbs are on the machine-readable surface and reach their module: every verb
// docs/PURGE.md lists has its schema entry, and `--help` prints its block. What each verb does is
// pinned beside its implementation; this file pins only that the surface and the dispatch exist.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NATIVE_RECORD_VERBS, nativeRecordVerb } from "../src/cli-native-records.mjs";

const run = promisify(execFile);
const BIN = new URL("../bin/agora.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

test("schema carries every native record verb and the post --attach option", async () => {
  const { stdout } = await run(process.execPath, [BIN, "schema", "--json"], { windowsHide: true });
  const schema = JSON.parse(stdout);
  assert.deepEqual(schema.verbs.attachment.args, ["get <room> <attachment id>"]);
  assert.ok("--out <path>" in schema.verbs.attachment.options);
  assert.deepEqual(schema.verbs.edit.args, ["<room>", "<message id>"]);
  assert.ok("--text <text>" in schema.verbs.edit.options && "--stdin" in schema.verbs.edit.options);
  for (const verb of ["withdraw", "pin", "unpin"]) assert.deepEqual(schema.verbs[verb].args, ["<room>", "<message id>"], verb);
  assert.match(schema.verbs.room.args[0], /\| purge <room>$/);
  assert.ok("--message <id>" in schema.verbs.room.options && "--reason <text>" in schema.verbs.room.options);
  assert.ok("--attach <path>" in schema.verbs.post.options);
  assert.deepEqual(schema.exit, { ok: 0, error: 1, usage: 2, fired: 42 }, "no new exit code");
});

test("a command line names its native record verb, and nothing else does", () => {
  assert.equal(nativeRecordVerb("attachment", "get"), "attachment-get");
  for (const v of ["edit", "withdraw", "pin", "unpin"]) assert.equal(nativeRecordVerb(v, "room"), v);
  assert.equal(nativeRecordVerb("room", "purge"), "room-purge");
  assert.equal(nativeRecordVerb("room", "faces"), undefined);
  assert.equal(nativeRecordVerb("room", "add-remote"), undefined);
  assert.equal(nativeRecordVerb("post", "room"), undefined, "post --attach is a post option, not a record verb");
  assert.deepEqual([...NATIVE_RECORD_VERBS].sort(), ["attachment-get", "edit", "pin", "room-purge", "unpin", "withdraw"]);
});

test("--help prints each verb's block", async () => {
  for (const verb of ["attachment", "edit", "withdraw", "pin", "unpin"]) {
    const { stdout } = await run(process.execPath, [BIN, verb, "--help"], { windowsHide: true });
    assert.match(stdout, new RegExp(`^  ${verb} `, "m"), verb);
  }
});
