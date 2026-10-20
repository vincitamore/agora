// @ts-check
// `agora config`: the one writer of the shared config. Every cell runs in a temp root with
// AGORA_CONFIG naming a file there; nothing here reads or writes a real seat's config.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { tmp } from "./helpers.mjs";
import { CONFIG_KEYS, editConfig, inlineSecrets, spliceConfig, takeConfigLock, unifiedDiff } from "../src/config-write.mjs";
import { buildRouteBinding, buildRouteDescriptor, mintRouteSecret, writeRouteSecret } from "../src/native-member.mjs";

const run = promisify(execFile);
const BIN = new URL("../bin/agora.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/** @param {string[]} args @param {Record<string, string>} env @param {{ cwd?: string }} [o] @returns {Promise<{ code: number, stdout: string, stderr: string }>} */
async function agora(args, env, o = {}) {
  const clean = { ...process.env };
  for (const name of Object.keys(clean)) if (name.startsWith("AGORA_")) delete clean[name];
  try {
    const child = run(process.execPath, [BIN, ...args], { env: { ...clean, ...env }, windowsHide: true, timeout: 30_000, ...(o.cwd ? { cwd: o.cwd } : {}) });
    child.child.stdin?.end();
    const { stdout, stderr } = await child;
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = /** @type {any} */ (e);
    return { code: err.code, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

/** A config as an operator keeps one: four-space indent, one room row per line, two rooms. */
const REALISTIC = `{
    "actor": { "name": "Grace", "kind": "human" },
    "sign": true,
    "rooms": {
        "home": {"transport":"local","path":"home.jsonl"},
        "desk": {"transport":"slack","channel":"C0123ABC","tokenFile":"~/.agora/slack.token"}
    }
}
`;

/** @param {string} dir */
async function seat(dir, text = REALISTIC) {
  const file = path.join(dir, "agora.json");
  const state = path.join(dir, "state");
  await writeFile(file, text);
  return { file, state, env: { AGORA_CONFIG: file, AGORA_STATE: state } };
}

/** @param {string} dir */
const leftovers = async (dir) => (await readdir(dir)).filter((f) => /\.tmp-|\.lock|\.stale-/.test(f));
/** @param {string} dir */
const backups = async (dir) => (await readdir(dir)).filter((f) => f.startsWith("agora.json.bak-"));

test("--from-descriptor verifies the carried descriptor as this seat's and writes its row; room add-remote writes nothing and prints this command", { timeout: 60_000 }, async () => {
  const { dir, cleanup } = await tmp();
  try {
    const s = await seat(dir);
    const enrolled = await agora(["enroll", "--local", "--json"], { AGORA_STATE: s.state });
    assert.equal(enrolled.code, 0, enrolled.stderr);
    const nodeKey = String(JSON.parse(enrolled.stdout.trim().split(/\r?\n/).pop() ?? "{}").nodeKey);
    const binding = buildRouteBinding({ hostAccountId: "a".repeat(32), hostAuthority: "a".repeat(32), roomId: "b".repeat(32), roomEpoch: "c".repeat(32), serviceBootId: "f".repeat(32), publicNodeKey: nodeKey });
    const { proofRef } = await writeRouteSecret(s.state, binding, mintRouteSecret());
    const descriptor = path.join(dir, "descriptor.json");
    await writeFile(descriptor, JSON.stringify(buildRouteDescriptor({ binding, endpoint: { transport: "tailcat", address: `tc${"a".repeat(48)}`, port: 4242 }, proofRef, issuedAt: new Date().toISOString() })));

    const printed = await agora(["room", "add-remote", "partner", descriptor], s.env);
    assert.equal(printed.code, 0, printed.stderr);
    assert.match(printed.stdout, /nothing was written; to write it .*\n\n  agora config room add partner --from-descriptor /);
    const json = JSON.parse((await agora(["room", "add-remote", "partner", descriptor, "--json"], s.env)).stdout);
    assert.deepEqual(json.apply, ["agora", "config", "room", "add", "partner", "--from-descriptor", descriptor, "--config", s.file]);
    assert.equal(json.written, false);
    assert.equal(await readFile(s.file, "utf8"), REALISTIC, "room add-remote wrote the shared config");

    const missing = await agora(["config", "room", "add", "partner", "--from-descriptor", path.join(dir, "nope.json")], s.env);
    assert.equal(missing.code, 1);
    assert.equal(await readFile(s.file, "utf8"), REALISTIC);
    const both = await agora(["config", "room", "add", "partner", '{"transport":"local","path":"p"}', "--from-descriptor", descriptor], s.env);
    assert.equal(both.code, 2);

    const written = await agora(json.apply.slice(1), s.env);
    assert.equal(written.code, 0, written.stderr);
    assert.match(written.stdout, new RegExp(`descriptor verified: room ${"b".repeat(32)}`));
    assert.deepEqual(JSON.parse(await readFile(s.file, "utf8")).rooms.partner, { transport: "native-remote", descriptor });
    const again = await agora(json.apply.slice(1), s.env);
    assert.match(again.stdout, /rooms\.partner is already this row: nothing written/);
  } finally { await cleanup(); }
});

test("config room add writes the row: the file named, a unified diff, a backup, untouched bytes kept, and the reader loads it", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const s = await seat(dir);
    const r = await agora(["config", "room", "add", "notes", '{"transport":"local","path":"notes.jsonl"}'], s.env);
    assert.equal(r.code, 0, r.stderr);
    const lines = r.stdout.split(/\r?\n/);
    assert.equal(lines[0], `config ${s.file}`);
    assert.ok(lines.includes(`--- ${s.file} (before)`) && lines.includes(`+++ ${s.file} (after)`), r.stdout);
    assert.ok(lines.some((l) => /^@@ -\d+,\d+ \+\d+,\d+ @@$/.test(l)), r.stdout);
    assert.ok(lines.includes(`+        "notes": {"transport":"local","path":"notes.jsonl"}`), r.stdout);
    const text = await readFile(s.file, "utf8");
    // the new row takes its siblings' one-line shape; every other byte is the operator's
    assert.equal(text, REALISTIC.replace(`"tokenFile":"~/.agora/slack.token"}`, `"tokenFile":"~/.agora/slack.token"},\n        "notes": {"transport":"local","path":"notes.jsonl"}`));
    const kept = await backups(dir);
    assert.equal(kept.length, 1);
    assert.match(String(r.stdout), new RegExp(`the file before is kept as .*${kept[0].replace(/[.]/g, "\\.")}`));
    assert.equal(await readFile(path.join(dir, kept[0]), "utf8"), REALISTIC);
    assert.deepEqual(await leftovers(dir), [], "no temp file or lock is left beside the config");
    const rooms = await agora(["rooms"], s.env);
    assert.equal(rooms.code, 0, rooms.stderr);
    assert.match(rooms.stdout, /notes/);
  } finally { await cleanup(); }
});

test("an identical row is a no-op that says so; a conflicting row is refused without --replace and replaced with it", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const s = await seat(dir);
    // the same row with its keys in another order is the same row
    const same = await agora(["config", "room", "add", "home", '{"path":"home.jsonl","transport":"local"}'], s.env);
    assert.equal(same.code, 0, same.stderr);
    assert.match(same.stdout, /rooms\.home is already this row: nothing written/);
    assert.equal(await readFile(s.file, "utf8"), REALISTIC);
    assert.deepEqual(await backups(dir), []);

    const conflict = await agora(["config", "room", "add", "home", '{"transport":"local","path":"other.jsonl"}'], s.env);
    assert.equal(conflict.code, 1);
    assert.match(conflict.stderr, /room-conflict: rooms\.home is already a local room with another row .*--replace/);
    assert.equal(await readFile(s.file, "utf8"), REALISTIC);

    const replaced = await agora(["config", "room", "add", "home", '{"transport":"local","path":"other.jsonl"}', "--replace", "--json"], s.env);
    assert.equal(replaced.code, 0, replaced.stderr);
    const out = JSON.parse(replaced.stdout);
    assert.equal(out.written, true);
    assert.deepEqual(out.before.rooms.home, { transport: "local", path: "home.jsonl" });
    assert.deepEqual(out.after.rooms.home, { transport: "local", path: "other.jsonl" });
    assert.equal(await readFile(s.file, "utf8"), REALISTIC.replace('"path":"home.jsonl"', '"path":"other.jsonl"'));
  } finally { await cleanup(); }
});

test("the whole result is validated as every verb loads it: an invalid result is refused and nothing is written", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const s = await seat(dir);
    for (const [args, refusal, code] of /** @type {[string[], RegExp, number][]} */ ([
      [["config", "unset", "actor"], /config-invalid: .*actor\.name is required/, 1],
      [["config", "set", "actor", '{"name":"Grace","kind":"robot"}'], /config-invalid: .*actor\.kind must be one of/, 1],
      [["config", "set", "rooms", "{}"], /config-invalid: .*rooms must name at least one room/, 1],
      [["config", "room", "add", "x", '{"transport":"carrier-pigeon"}'], /needs a transport, one of/, 2],
      [["config", "room", "add", "x", '{"transport":"native","roomId":"nope"}'], /native room row needs roomId/, 2],
      [["config", "room", "add", "_x", '{"transport":"local","path":"x"}'], /room alias starts with a letter or digit/, 2],
      [["config", "room", "add", "x", "{not json"], /the room row is not JSON/, 2],
      [["config", "set", "colour", '"blue"'], /"colour" is not a config key agora reads/, 2],
      [["config", "set", "sign", '"yes"'], /sign takes a JSON boolean, not a string/, 2],
      [["config", "resident", "add", "Bad Slug"], /resident slug/, 2],
      [["config", "frobnicate"], /config takes show, room add\|remove/, 2],
    ])) {
      const r = await agora(args, s.env);
      assert.equal(r.code, code, `${args.join(" ")}: ${r.stderr}`);
      assert.match(r.stderr, refusal, args.join(" "));
      assert.equal(await readFile(s.file, "utf8"), REALISTIC, `${args.join(" ")} wrote the config`);
    }
    assert.deepEqual(await backups(dir), []);
    assert.deepEqual(await leftovers(dir), []);
    // the last room cannot go: a config names at least one
    const one = await seat(dir, JSON.stringify({ actor: { name: "Ada", kind: "agent" }, rooms: { home: { transport: "local", path: "h.jsonl" } } }));
    const r = await agora(["config", "room", "remove", "home"], one.env);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /rooms must name at least one room/);
  } finally { await cleanup(); }
});

test("an inline token is refused on every write and by show, and its value is never printed", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const s = await seat(dir);
    const value = `xoxb-${"1".repeat(12)}-abcdef`;
    for (const row of [{ transport: "slack", channel: "C1", token: "plain-text-value" }, { transport: "slack", channel: "C1", tokenEnv: value }, { transport: "slack", channel: "C1", auth: { password: "x" } }]) {
      const r = await agora(["config", "room", "add", "leak", JSON.stringify(row)], s.env);
      assert.equal(r.code, 1, r.stderr);
      assert.match(r.stderr, /inline-token: the result would hold a credential inline at rooms\.leak\./);
      assert.doesNotMatch(r.stderr + r.stdout, /plain-text-value|xoxb-|"x"/);
      assert.equal(await readFile(s.file, "utf8"), REALISTIC);
    }
    // a reference is what a config carries
    const ok = await agora(["config", "room", "add", "desk2", '{"transport":"slack","channel":"C2","tokenEnv":"DESK_TOKEN"}'], s.env);
    assert.equal(ok.code, 0, ok.stderr);
    assert.deepEqual(inlineSecrets({ rooms: { a: { tokenEnv: "X", tokenFile: "~/t" } } }), []);

    const shown = await agora(["config", "show"], s.env);
    assert.equal(shown.code, 0, shown.stderr);
    assert.equal(shown.stdout, `${await readFile(s.file, "utf8")}`.replace(/\r?\n$/, "") + "\n");
    assert.match(shown.stderr, new RegExp(`config ${s.file.replace(/[\\.]/g, "\\$&")}`));
    const json = JSON.parse((await agora(["config", "show", "--json"], s.env)).stdout);
    assert.equal(json.valid, true);
    assert.equal(json.path, s.file);

    const leaky = await seat(dir, JSON.stringify({ actor: { name: "Ada", kind: "agent" }, rooms: { desk: { transport: "slack", channel: "C1", tokenEnv: value } } }));
    const refused = await agora(["config", "show"], leaky.env);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /inline-token: .* at rooms\.desk\.tokenEnv; it is not printed/);
    assert.doesNotMatch(refused.stderr + refused.stdout, /xoxb-/);
    // removing the leaking row is the fix, and its old bytes are not printed on the way out
    await writeFile(leaky.file, JSON.stringify({ actor: { name: "Ada", kind: "agent" }, rooms: { home: { transport: "local", path: "h" }, desk: { transport: "slack", channel: "C1", tokenEnv: value } } }));
    const fixed = await agora(["config", "room", "remove", "desk"], leaky.env);
    assert.equal(fixed.code, 0, fixed.stderr);
    assert.match(fixed.stdout, /holds a credential inline at rooms\.desk\.tokenEnv, so no diff is printed/);
    assert.doesNotMatch(fixed.stdout + fixed.stderr, /xoxb-/);
  } finally { await cleanup(); }
});

test("--dry-run prints the diff and writes nothing: no file change, no backup, no lock", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const s = await seat(dir);
    const r = await agora(["config", "set", "residentManifest", '"~/team/residents.json"', "--dry-run"], s.env);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /\+    "residentManifest": "~\/team\/residents\.json"/);
    assert.match(r.stdout, /dry run: nothing written$/m);
    assert.equal(await readFile(s.file, "utf8"), REALISTIC);
    assert.deepEqual(await backups(dir), []);
    assert.deepEqual(await leftovers(dir), []);
    // and on a seat with no config at all, the would-be file
    const fresh = path.join(dir, "fresh", "agora.json");
    const n = await agora(["config", "set", "actor", '{"name":"Lin","kind":"agent"}', "rooms", '{"home":{"transport":"local","path":"h.jsonl"}}', "--dry-run"], { AGORA_CONFIG: fresh });
    assert.equal(n.code, 0, n.stderr);
    assert.match(n.stdout, /^config .* \(new file\)$/m);
    assert.match(n.stdout, /^--- \/dev\/null$/m);
    assert.equal(existsSync(fresh), false);
    assert.equal(existsSync(path.dirname(fresh)), false);
  } finally { await cleanup(); }
});

test("set, unset, resident add and remove: the top-level keys agora reads, idempotent, every other byte kept", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const s = await seat(dir);
    let r = await agora(["config", "set", "residentManifest", '"~/team/residents.json"'], s.env);
    assert.equal(r.code, 0, r.stderr);
    r = await agora(["config", "resident", "add", "support", '{"restart":"systemctl --user restart resident-{slug}.service"}'], s.env);
    assert.equal(r.code, 0, r.stderr);
    r = await agora(["config", "resident", "add", "support", '{"restart":"systemctl --user restart resident-{slug}.service"}'], s.env);
    assert.match(r.stdout, /residents\.support is already this row: nothing written/);
    r = await agora(["config", "resident", "add", "support", '{"restart":"other"}'], s.env);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /resident-conflict/);
    const cfg = JSON.parse(await readFile(s.file, "utf8"));
    assert.equal(cfg.residentManifest, "~/team/residents.json");
    assert.deepEqual(cfg.residents, { support: { restart: "systemctl --user restart resident-{slug}.service" } });
    assert.deepEqual(Object.keys(cfg), ["actor", "sign", "rooms", "residentManifest", "residents"], "new keys go at the end, old ones keep their place");

    r = await agora(["config", "set", "actor", '{"name":"Ada","kind":"agent"}'], s.env);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /their next posts sign as the new name/);
    r = await agora(["config", "resident", "remove", "support"], s.env);
    assert.equal(r.code, 0, r.stderr);
    r = await agora(["config", "resident", "remove", "support"], s.env);
    assert.match(r.stdout, /no resident "support" in the config; nothing to remove: nothing written/);
    r = await agora(["config", "unset", "residentManifest", "residents"], s.env);
    assert.equal(r.code, 0, r.stderr);
    r = await agora(["config", "unset", "residentManifest"], s.env);
    assert.match(r.stdout, /is not set; nothing to remove/);
    assert.equal(await readFile(s.file, "utf8"), REALISTIC.replace('{ "name": "Grace", "kind": "human" }', '{"name":"Ada","kind":"agent"}'));
  } finally { await cleanup(); }
});

test("a config that does not exist yet is created by one set of actor and rooms, private, and ./agora.json is the file a bare call names", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const file = path.join(dir, "seat", "config.json");
    const half = await agora(["config", "set", "actor", '{"name":"Lin","kind":"agent"}'], { AGORA_CONFIG: file });
    assert.equal(half.code, 1, "an actor alone is not a config");
    assert.match(half.stderr, /rooms must name at least one room/);
    assert.equal(existsSync(file), false);
    const r = await agora(["config", "set", "actor", '{"name":"Lin","kind":"agent"}', "rooms", '{"home":{"transport":"local","path":"h.jsonl"}}'], { AGORA_CONFIG: file });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { actor: { name: "Lin", kind: "agent" }, rooms: { home: { transport: "local", path: "h.jsonl" } } });
    if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);

    // the reader's resolution: ./agora.json in the working directory when AGORA_CONFIG is unset
    const cwd = path.join(dir, "work");
    await mkdir(cwd);
    await writeFile(path.join(cwd, "agora.json"), REALISTIC);
    const local = await agora(["config", "room", "remove", "home"], {}, { cwd });
    assert.equal(local.code, 0, local.stderr);
    assert.match(local.stdout, /^config .*work[\\/]agora\.json$/m);
    assert.equal(JSON.parse(await readFile(path.join(cwd, "agora.json"), "utf8")).rooms.home, undefined);
  } finally { await cleanup(); }
});

test("room remove refuses a native room this seat still hosts unless --force, and deletes no state", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const roomId = "c".repeat(32);
    const s = await seat(dir, JSON.stringify({ actor: { name: "Ada", kind: "agent" }, rooms: { home: { transport: "local", path: "h" }, nat: { transport: "native", roomId } } }, null, 2));
    const hosted = path.join(s.state, "native", "rooms", roomId);
    await mkdir(hosted, { recursive: true });
    await writeFile(path.join(hosted, "log.jsonl"), "{}\n");
    const before = await readFile(s.file, "utf8");
    const refused = await agora(["config", "room", "remove", "nat"], s.env);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, new RegExp(`room-hosted: rooms\\.nat is native room ${roomId}, which this seat still hosts .*agora service room delete ${roomId} --confirm ${roomId}`));
    assert.equal(await readFile(s.file, "utf8"), before);
    const forced = await agora(["config", "room", "remove", "nat", "--force"], s.env);
    assert.equal(forced.code, 0, forced.stderr);
    assert.match(forced.stdout, /only the row goes/);
    assert.equal(JSON.parse(await readFile(s.file, "utf8")).rooms.nat, undefined);
    assert.equal(await readFile(path.join(hosted, "log.jsonl"), "utf8"), "{}\n", "the hosted room is untouched");
    const absent = await agora(["config", "room", "remove", "nat"], s.env);
    assert.equal(absent.code, 0);
    assert.match(absent.stdout, /no room "nat" in the config; nothing to remove/);
  } finally { await cleanup(); }
});

test("the writer lock: a live holder is waited for and then refused with nothing written; a dead holder's lock is taken; concurrent writers lose no update", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const s = await seat(dir);
    const held = await takeConfigLock(s.file);
    /** @param {string} name @returns {() => import("../src/config-write.mjs").Plan} */
    const addRoom = (name) => () => ({ ops: [{ path: ["rooms", name], value: { transport: "local", path: `${name}.jsonl` } }] });
    await assert.rejects(editConfig(s.file, addRoom("late"), { lockWaitMs: 150 }), (/** @type {any} */ e) => e.code === "config-locked" && /held by pid \d+/.test(e.message));
    assert.equal(await readFile(s.file, "utf8"), REALISTIC);
    // the CLI waits its bound and refuses the same way
    const cli = await agora(["config", "room", "add", "late", '{"transport":"local","path":"late.jsonl"}'], s.env);
    assert.equal(cli.code, 1);
    assert.match(cli.stderr, /config-locked: .*agora\.json\.lock is held by pid/);
    assert.equal(await readFile(s.file, "utf8"), REALISTIC);
    await held.release();

    // a lock whose process is gone is a leftover, taken over
    await writeFile(`${s.file}.lock`, JSON.stringify({ pid: 2 ** 22 + 12345, token: "gone", at: "2026-01-01T00:00:00.000Z" }));
    const r = await editConfig(s.file, addRoom("after"), { lockWaitMs: 150 });
    assert.equal(r.written, true);

    // eight writers at once, each adding its own room: every room lands
    const names = Array.from({ length: 8 }, (_, i) => `r${i}`);
    await Promise.all(names.map((n) => editConfig(s.file, addRoom(n), { lockWaitMs: 10_000 })));
    const rooms = JSON.parse(await readFile(s.file, "utf8")).rooms;
    for (const n of ["home", "desk", "after", ...names]) assert.ok(n in rooms, `${n} was lost`);
    assert.deepEqual(await leftovers(dir), []);
  } finally { await cleanup(); }
});

test("the write is atomic: a temp file and a rename, the mode kept, a link followed", { skip: process.platform === "win32" ? "modes and links are POSIX" : false }, async () => {
  const { dir, cleanup } = await tmp();
  try {
    const s = await seat(dir);
    const { chmod, symlink, lstat } = await import("node:fs/promises");
    await chmod(s.file, 0o640);
    const before = (await stat(s.file)).ino;
    const r = await agora(["config", "set", "sign", "false"], s.env);
    assert.equal(r.code, 0, r.stderr);
    const after = await stat(s.file);
    assert.notEqual(after.ino, before, "the file was rewritten in place instead of renamed over");
    assert.equal(after.mode & 0o777, 0o640);
    const link = path.join(dir, "link.json");
    await symlink(s.file, link);
    const l = await agora(["config", "set", "sign", "true"], { AGORA_CONFIG: link });
    assert.equal(l.code, 0, l.stderr);
    assert.ok((await lstat(link)).isSymbolicLink(), "the link stays a link");
    assert.equal(JSON.parse(await readFile(s.file, "utf8")).sign, true);
  } finally { await cleanup(); }
});

test("the splice keeps untouched bytes and re-serializes only when it cannot; the diff is unified", () => {
  const text = '{\n  "actor": {"name":"A","kind":"agent"},\n  "rooms": {\n    "a": {"transport":"local","path":"a"}\n  }\n}\n';
  const after = { actor: { name: "A", kind: "agent" }, rooms: { a: { transport: "local", path: "a" }, b: { transport: "local", path: "b" } } };
  const out = spliceConfig(text, [{ path: ["rooms", "b"], value: after.rooms.b }], after);
  assert.equal(out, '{\n  "actor": {"name":"A","kind":"agent"},\n  "rooms": {\n    "a": {"transport":"local","path":"a"},\n    "b": {"transport":"local","path":"b"}\n  }\n}\n');
  const removed = spliceConfig(out, [{ path: ["rooms", "a"] }], { actor: after.actor, rooms: { b: after.rooms.b } });
  assert.equal(removed, '{\n  "actor": {"name":"A","kind":"agent"},\n  "rooms": {\n    "b": {"transport":"local","path":"b"}\n  }\n}\n');
  const compact = spliceConfig('{"actor":{"name":"A","kind":"agent"},"rooms":{}}', [{ path: ["rooms", "a"], value: { transport: "local", path: "a" } }], { actor: after.actor, rooms: { a: after.rooms.a } });
  assert.equal(compact, '{"actor":{"name":"A","kind":"agent"},"rooms":{"a":{"transport":"local","path":"a"}}}');
  // a duplicate key (JSON.parse keeps the last) is a shape the check catches: re-serialized, correct
  const dup = spliceConfig('{\n  "sign": true,\n  "sign": false\n}\n', [{ path: ["state"], value: "s" }], { sign: false, state: "s" });
  assert.deepEqual(JSON.parse(dup), { sign: false, state: "s" });

  const d = unifiedDiff("a\nb\nc\nd\ne\nf\ng\nh\n", "a\nb\nc\nD\ne\nf\ng\nh\n", "x (before)", "x (after)");
  assert.equal(d, ["--- x (before)", "+++ x (after)", "@@ -1,7 +1,7 @@", " a", " b", " c", "-d", "+D", " e", " f", " g"].join("\n"));
  assert.equal(unifiedDiff("same\n", "same\n", "a", "b"), "");
  assert.equal(unifiedDiff("", "x\n", "/dev/null", "b"), ["--- /dev/null", "+++ b", "@@ -0,0 +1,1 @@", "+x"].join("\n"));
});

test("CONFIG_KEYS is the set of top-level keys agora reads, and no more", () => {
  // a key joins this table when a verb starts reading it; a key nothing reads is a typo `set` refuses
  assert.deepEqual(Object.entries(CONFIG_KEYS), [
    ["actor", "object"], ["rooms", "object"], ["state", "string"], ["sign", "boolean"],
    ["session", "object"], ["residents", "object"], ["residentManifest", "string"],
  ]);
});
