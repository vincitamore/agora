// @ts-check
// The face commands (P5): `agora room faces`, `agora post --face/--no-face` with the receipt's face
// rows, and `agora faces --for/--unknown`, named for the fixtures under
// forge/output/agora-native-surface/fixtures/faces/ they satisfy. The room is a real seat service
// in a temp state root, which runs no face publisher, so nothing here can reach a transport; the
// Slack room's token is an unset environment variable and is never read.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NativeRoomService } from "../src/native-service.mjs";
import { appendFaceRecord, faceRecordsPath, readFaceRecords, readFacePolicy } from "../src/faces.mjs";
import { nativeTransport } from "../src/transports/native.mjs";

const run = promisify(execFile);
const BIN = new URL("../bin/agora.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const ROOM = "8f2c1a0b4d6e9f7a2b5c8d1e3f4a6b90";
const BARE = "1".repeat(32);
const EPOCH = "a".repeat(32);
const ACCOUNT = "seat_account_0005";
const CLEARED = ["CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_PID", "GROK_SESSION_ID", "GROK_PID", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "HERMES_SESSION_ID", "AGORA_SESSION_PID", "AGORA_SESSION", "AGORA_ACTOR", "AGORA_CONFIG", "AGORA_STATE", "AGORA_TEST_UNSET_TOKEN"];

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

/** @param {import('node:test').TestContext} t @param {{ slackRooms?: number, githubRoom?: boolean }} [o] */
async function fixture(t, o = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-cli-faces-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new NativeRoomService({ root, accountId: ACCOUNT, seatLabel: "seat-a" });
  await service.start();
  await service.createRoom({ roomId: ROOM, epoch: EPOCH });
  await service.createRoom({ roomId: BARE, epoch: EPOCH });
  t.after(() => service.stop());
  const cfgPath = path.join(root, "agora.json");
  /** @type {Record<string, any>} */
  const rooms = {
    nat: { transport: "native", roomId: ROOM },
    bare: { transport: "native", roomId: BARE },
    house: { transport: "slack", channel: "C0123ABC", tokenEnv: "AGORA_TEST_UNSET_TOKEN" },
    down: { transport: "local", path: path.join(root, "down.ndjson") },
  };
  if (o.slackRooms === 2) rooms.ops = { transport: "slack", channel: "C0999OPS", tokenEnv: "AGORA_TEST_UNSET_TOKEN" };
  if (o.githubRoom) rooms.issue = { transport: "github", repo: "example-org/example-repo", issue: 3, tokenEnv: "AGORA_TEST_UNSET_TOKEN" };
  const cfgText = JSON.stringify({ actor: { name: "seat", kind: "agent" }, rooms }, null, 2);
  await writeFile(cfgPath, cfgText);
  const env = { AGORA_CONFIG: cfgPath, AGORA_STATE: root, AGORA_SESSION: "grace", AGORA_ACTOR: "Grace/agora-orchestrator" };
  const policyFile = path.join(root, "native", "rooms", ROOM, "faces.json");
  /** The shared config is read and never written: its bytes before and after are one exhibit. */
  const configUnchanged = async () => assert.equal(await readFile(cfgPath, "utf8"), cfgText, "the tool never writes the shared config");
  return { root, service, env, cfgPath, policyFile, configUnchanged };
}

/** A body free of any credential shape, and one that carries one. */
const TOKENISH = "xoxb-1234567890-abcdefghijklmnop";

// ---------------------------------------------------------------------------------------------

test("fixture 01: room faces reads an absent record as a room with no faces, and --add slack --channel writes the ratified record under the seat's state, 0600, never the shared config", async (t) => {
  const { env, policyFile, configUnchanged } = await fixture(t);
  let r = await agora(["room", "faces", "nat"], env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /faces of nat \(native room 8f2c1a0b/);
  assert.match(r.stdout, /absent: every post is native only and nothing refuses/);
  assert.match(r.stdout, /no faces; add one: agora room faces nat --add slack/);
  await assert.rejects(stat(policyFile), { code: "ENOENT" }, "a read creates no record");

  r = await agora(["room", "faces", "nat", "--json"], env);
  assert.deepEqual(JSON.parse(r.stdout), { type: "face-policy", alias: "nat", room: ROOM, path: policyFile, updatedAt: null, written: false, faces: [] });

  // fixture 01's first command line, with the one configured slack room supplying the token source
  r = await agora(["room", "faces", "nat", "--add", "slack", "--channel", "C0123ABC", "--json"], env);
  assert.equal(r.code, 0, r.stderr);
  const record = JSON.parse(await readFile(policyFile, "utf8"));
  assert.match(record.updatedAt, /^\d{4}-\d\d-\d\dT/);
  const { updatedAt, ...rest } = record;
  assert.deepEqual(rest, {
    version: 1, roomId: ROOM,
    faces: [{ transport: "slack", alias: "house", target: { channel: "C0123ABC" }, enabled: true,
      post: { human: ["always"], agent: ["addressed", "landing"], system: ["never"] }, attachments: "metadata", backfill: null }],
  }, "the record is fixture 01's exactly: selector lists, the ratified defaults, the token room as alias");
  if (process.platform !== "win32") assert.equal((await stat(policyFile)).mode & 0o777, 0o600);
  const out = JSON.parse(r.stdout);
  assert.equal(out.written, true);
  assert.equal(out.updatedAt, updatedAt);
  assert.deepEqual(out.faces, rest.faces);
  await configUnchanged();

  // --show prints the same record and writes nothing
  const before = await readFile(policyFile, "utf8");
  r = await agora(["room", "faces", "nat", "--show"], env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /slack\s+via house\s+channel C0123ABC\s+enabled/);
  assert.match(r.stdout, /human: always\s+agent: addressed\+landing\s+system: never\s+attachments: metadata/);
  assert.match(r.stdout, new RegExp(`written ${updatedAt.replace(/[.]/g, "[.]")}`));
  assert.equal(await readFile(policyFile, "utf8"), before, "--show is a read");
});

test("fixture 01: the selector and attachment edits write exactly the field named, accept the ruling's + spelling, and refuse an unknown value by name with nothing written", async (t) => {
  const { env, policyFile, root, configUnchanged } = await fixture(t);
  let r = await agora(["room", "faces", "nat", "--add", "slack"], env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /channel C0123ABC/, "the channel comes from the --via room when --channel is not given");

  r = await agora(["room", "faces", "nat", "--agent", "never"], env);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual((await readFacePolicy(root, ROOM)).faces[0].post, { human: ["always"], agent: ["never"], system: ["never"] });

  r = await agora(["room", "faces", "nat", "--agent", "addressed+landing"], env);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual((await readFacePolicy(root, ROOM)).faces[0].post.agent, ["addressed", "landing"], "J2's literal text is a valid value");

  r = await agora(["room", "faces", "nat", "--human", "addressed", "--system", "always", "--pictures"], env);
  assert.equal(r.code, 0, r.stderr);
  let face = (await readFacePolicy(root, ROOM)).faces[0];
  assert.deepEqual(face.post, { human: ["addressed"], agent: ["addressed", "landing"], system: ["always"] });
  assert.equal(face.attachments, "pictures");

  r = await agora(["room", "faces", "nat", "--attachments", "none"], env);
  assert.equal(r.code, 0, r.stderr);
  assert.equal((await readFacePolicy(root, ROOM)).faces[0].attachments, "none");

  r = await agora(["room", "faces", "nat", "--disable", "slack"], env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /DISABLED/);
  assert.equal((await readFacePolicy(root, ROOM)).faces[0].enabled, false);
  r = await agora(["room", "faces", "nat", "--enable", "slack"], env);
  assert.equal(r.code, 0, r.stderr);
  assert.equal((await readFacePolicy(root, ROOM)).faces[0].enabled, true);

  // refusals: by name, exit 1, and the record untouched
  const before = await readFile(policyFile, "utf8");
  r = await agora(["room", "faces", "nat", "--agent", "sometimes"], env);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--agent: "sometimes" is not a selector \(have: always, never, addressed, landing\)/);
  r = await agora(["room", "faces", "nat", "--attachments", "bytes"], env);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--attachments "bytes" is not a mode \(have: none, metadata, pictures\)/);
  r = await agora(["room", "faces", "nat", "--enable", "github"], env);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--enable: room nat has no github face \(have: slack\)/);
  r = await agora(["room", "faces", "nat", "--add", "slack"], env);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /room nat already has a slack face/);
  r = await agora(["room", "faces", "nat", "--add", "local"], env);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--add local: not a face this build publishes \(have: slack, github\)/);
  r = await agora(["room", "faces", "nat", "--add", "github"], env);
  assert.equal(r.code, 1, "a github face borrows a configured github room's token and issue; none is configured here");
  assert.match(r.stderr, /--add github needs a configured github room to borrow a token from, and none is configured/);
  r = await agora(["room", "faces", "nat", "--agent", "never", "--face", "github"], env);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--face: room nat has no github face/);
  assert.equal(await readFile(policyFile, "utf8"), before, "a refused edit writes nothing");

  // fixture 01's last line
  r = await agora(["room", "faces", "nat", "--remove", "slack"], env);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual((await readFacePolicy(root, ROOM)).faces, []);
  r = await agora(["room", "faces", "nat", "--agent", "never"], env);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /room nat has no face to edit/);
  await configUnchanged();
  assert.doesNotMatch(await readFile(policyFile, "utf8"), /xox[bp]-|AGORA_TEST_UNSET_TOKEN/, "the record names the token room, never the token or its source");
});

test("room faces: the verb shape is generic (transport as a value), a non-native room is a usage error, and two token rooms need --via", async (t) => {
  const { env, root } = await fixture(t, { slackRooms: 2 });
  let r = await agora(["room", "faces"], env);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /room faces needs a native room \(one of: nat, bare\)/);
  r = await agora(["room", "mirror", "nat"], env);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /room takes "faces"/);
  r = await agora(["room", "faces", "house"], env);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /faces belong to a native room; "house" is a slack room/);
  r = await agora(["room", "faces", "nowhere"], env);
  assert.equal(r.code, 2);
  r = await agora(["room", "faces", "nat", "--add", "slack"], env);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--add slack needs --via <room>: the configured slack room whose token the face borrows \(have: house, ops\)/);
  r = await agora(["room", "faces", "nat", "--add", "slack", "--via", "down"], env);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--via down: not a configured slack room/);
  r = await agora(["room", "faces", "nat", "--add", "slack", "--via", "ops"], env);
  assert.equal(r.code, 0, r.stderr);
  const face = (await readFacePolicy(root, ROOM)).faces[0];
  assert.equal(face.alias, "ops");
  assert.equal(face.target.channel, "C0999OPS");
  r = await agora(["room", "faces", "nat", "--channel", "C1"], env);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--via and --channel go with --add/);
  // the verb table and the option surface are on the machine-readable schema
  r = await agora(["schema", "--json"], env);
  const schema = JSON.parse(r.stdout);
  assert.deepEqual(schema.verbs.room.args, ["faces <room> | add-remote <alias> <descriptor-path>"]);
  assert.deepEqual(schema.verbs.faces.args, ["<room>"]);
  assert.ok("--for <cursor|id>" in schema.verbs.faces.options && "--unknown" in schema.verbs.faces.options);
  assert.ok("--face <name>" in schema.verbs.post.options && "--no-face" in schema.verbs.post.options);
  assert.ok("--add <transport>" in schema.verbs.room.options && "--agent <selectors>" in schema.verbs.room.options);
  assert.deepEqual(schema.exit, { ok: 0, error: 1, usage: 2, fired: 42 }, "no new code, no new meaning");
});

test("fixture 09 row 9 by name: --add github --via <issue room> writes a github face whose target is that room's issue, FACE_BUILT lists github, --channel is refused for it, and --face github rides the append frame as an admitted name", async (t) => {
  const { env, root, policyFile, configUnchanged } = await fixture(t, { githubRoom: true });
  // the one configured github room supplies the token source and the issue, so --via may be left out
  let r = await agora(["room", "faces", "nat", "--add", "github", "--json"], env);
  assert.equal(r.code, 0, r.stderr);
  const { updatedAt, ...rest } = JSON.parse(await readFile(policyFile, "utf8"));
  assert.deepEqual(rest, {
    version: 1, roomId: ROOM,
    faces: [{ transport: "github", alias: "issue", target: { repo: "example-org/example-repo", issue: "3" }, enabled: true,
      post: { human: ["always"], agent: ["addressed", "landing"], system: ["never"] }, attachments: "metadata", backfill: null }],
  }, "the target is the --via room's issue; the token room is the alias");
  assert.doesNotMatch(await readFile(policyFile, "utf8"), /ghp_|AGORA_TEST_UNSET_TOKEN/);
  await configUnchanged();
  r = await agora(["room", "faces", "nat"], env);
  assert.match(r.stdout, /github {3}via issue {2}repo example-org\/example-repo issue 3 {2}enabled/);
  // a second face beside it, named explicitly
  r = await agora(["room", "faces", "nat", "--remove", "github"], env);
  assert.equal(r.code, 0, r.stderr);
  r = await agora(["room", "faces", "nat", "--add", "github", "--via", "issue", "--channel", "C0123ABC"], env);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--channel names a Slack channel; the github face takes its target from the --via room/);
  r = await agora(["room", "faces", "nat", "--add", "github", "--via", "house"], env);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--via house: not a configured github room \(have: issue\)/);
  r = await agora(["room", "faces", "nat", "--add", "github", "--via", "issue", "--agent", "never"], env);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual((await readFacePolicy(root, ROOM)).faces.map((f) => [f.transport, f.alias, f.post.agent]), [["github", "issue", ["never"]]]);
  // --face github is an admitted name: no refusal row is recorded by the CLI, the receipt says the service wrote none
  r = await agora(["post", "nat", "for the issue", "--face", "github", "--json"], env);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).faces, [], "absent, never pending: the seat service runs no publisher here");
  assert.match(r.stderr, /no face rows for .*: the seat service wrote none/);
  assert.deepEqual([...(await readFaceRecords(root, ROOM)).values()], [], "an admitted name records nothing at the CLI");
  // an unbuilt name beside it is still refused by name
  r = await agora(["post", "nat", "x", "--face", "github,local", "--json"], env);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).faces.map((/** @type {any} */ f) => [f.transport, f.status, f.code]), [["local", "refused", "capability"]]);
  r = await agora(["schema", "--json"], env);
  assert.match(JSON.parse(r.stdout).verbs.room.options["--add <transport>"], /\(slack, github\)/);
});

test("fixture 09 rows 2, 3, 4, 5: --face on a face the seat can refuse without a call is a recorded refused row on the receipt, the native post commits, the exit code is the native outcome, and --no-face is an empty receipt", async (t) => {
  const { env, root, configUnchanged } = await fixture(t);
  // row 3: a room with no such face
  let r = await agora(["post", "bare", "x", "--face", "slack", "--json"], env);
  assert.equal(r.code, 0, r.stderr);
  let out = JSON.parse(r.stdout);
  assert.equal(out.cursor, `${EPOCH}:1`, "the native post committed");
  assert.equal(out.faces.length, 1);
  assert.equal(out.faces[0].type, "face");
  assert.equal(out.faces[0].transport, "slack");
  assert.equal(out.faces[0].status, "refused");
  assert.equal(out.faces[0].code, "no-such-face");
  assert.equal(out.faces[0].reason, "no-such-face: room bare has no slack face; set one with agora room faces bare --add slack --channel <id>");
  assert.equal(out.faces[0].cursor, `${EPOCH}:1`);
  const recorded = await readFaceRecords(root, BARE);
  assert.equal(recorded.size, 1);
  const line = [...recorded.values()][0];
  assert.equal(line.originId, out.id, "the refusal is recorded under the committed message's id");
  assert.equal(line.status, "refused");
  assert.equal(line.attempt, 0);

  // row 4: a transport with no audience
  r = await agora(["post", "nat", "x", "--face", "local"], env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^posted [a-f0-9]{64}  cursor a{32}:1\nface local refused: capability: the local transport is an append-only NDJSON file with no audience to face to\n$/);

  // row 5: the face is off
  await agora(["room", "faces", "nat", "--add", "slack", "--disable", "slack"], env);
  r = await agora(["post", "nat", "x", "--face", "slack", "--json"], env);
  assert.equal(r.code, 0, r.stderr);
  out = JSON.parse(r.stdout);
  assert.equal(out.faces[0].reason, "disabled: the slack face of nat is off; turn it on with agora room faces nat --enable slack");
  assert.equal(out.faces[0].room, ROOM);

  // row 2: --no-face is an empty receipt and the post still commits
  r = await agora(["post", "nat", "x", "--no-face", "--json"], env);
  assert.equal(r.code, 0, r.stderr);
  out = JSON.parse(r.stdout);
  assert.deepEqual(out.faces, []);
  assert.equal(out.cursor, `${EPOCH}:3`);
  assert.match(r.stderr, /no face rows for a{32}:3 \(--no-face\): the post is native only/);

  // a comma list and a repeat name the same set once; an unknown name is never an exit code
  r = await agora(["post", "nat", "x", "--face", "local,slack", "--face", "local", "--json"], env);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).faces.map((/** @type {any} */ f) => [f.transport, f.code]), [["local", "capability"], ["slack", "disabled"]]);
  await configUnchanged();
});

test("fixture 09 row 1 and the seam: a name the policy admits rides the append frame for the service to publish; the CLI records no pending and no published row of its own, and says so", async (t) => {
  const { env, root } = await fixture(t);
  await agora(["room", "faces", "nat", "--add", "slack"], env);
  const r = await agora(["post", "nat", "for the channel", "--face", "slack", "--json"], env);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.cursor, `${EPOCH}:1`);
  assert.deepEqual(out.faces, [], "the seat service in this test runs no face publisher, so there is no row to read: absent, never pending");
  assert.match(r.stderr, /no face rows for a{32}:1: the seat service wrote none .*; agora faces nat --for a{32}:1 reads them later/);
  assert.deepEqual([...(await readFaceRecords(root, ROOM)).values()], [], "the CLI never fakes a publish: not one line in the record log");
  await assert.rejects(stat(faceRecordsPath(root, ROOM)), { code: "ENOENT" });
});

test("the native transport carries the face choice on the append frame and returns the ack's face rows as the receipt's, inventing none", async (t) => {
  const { root } = await fixture(t);
  /** @type {any[]} */
  const frames = [];
  /** @type {any} */
  let reply = { id: "b".repeat(64), cursor: `${EPOCH}:7` };
  const connect = async () => ({ socket: { unref() {}, once() {}, destroyed: false }, request: async (/** @type {string} */ type, /** @type {any} */ fields) => { frames.push({ type, ...fields }); return reply; } });
  const tr = nativeTransport({ transport: "native", roomId: ROOM }, { actor: { name: "Grace/agora-orchestrator", kind: "agent" }, stateRoot: root, connect: /** @type {any} */ (connect) });

  let receipt = await tr.post("plain", {});
  assert.deepEqual(receipt, { id: "b".repeat(64), cursor: `${EPOCH}:7` }, "no faces on the ack: none on the receipt");
  assert.equal(frames[0].type, "append");
  assert.equal("face" in frames[0], false, "absent is the room's own policy, and the frame says nothing");
  assert.deepEqual(Object.keys(frames[0].operation).sort(), ["authorKind", "authorName", "operationId", "text"], "the choice never enters the operation the store validates");

  await tr.post("named", { face: ["slack"] });
  assert.deepEqual(frames[1].face, ["slack"]);
  await tr.post("none", { face: "none" });
  assert.equal(frames[2].face, "none");

  reply = { id: "b".repeat(64), cursor: `${EPOCH}:8`, faces: [{ transport: "slack", status: "pending" }] };
  receipt = await tr.post("faced", { face: ["slack"] });
  assert.deepEqual(receipt.faces, [{ transport: "slack", status: "pending" }], "the service's rows, verbatim");
  reply = { id: "b".repeat(64), cursor: `${EPOCH}:9`, faces: "not-a-list" };
  receipt = await tr.post("odd", {});
  assert.equal("faces" in receipt, false);
});

test("faces --for reads one message's rows by cursor or id, --unknown lists what a human should look at, and neither is a count or a publish", async (t) => {
  const { env, root } = await fixture(t);
  await agora(["room", "faces", "nat", "--add", "slack", "--disable", "slack"], env);
  let r = await agora(["post", "nat", "first", "--face", "slack", "--json"], env);
  const first = JSON.parse(r.stdout);
  r = await agora(["post", "nat", "second", "--json"], env);
  // rows the service would have written under the second message's id: an unknown text face and a
  // published picture; and under two ids of its own, a quarantined one and a published one
  const at = "2026-09-05T12:00:00.000Z";
  const ORIGIN_B = JSON.parse(r.stdout).id;
  await appendFaceRecord(root, ROOM, { originId: ORIGIN_B, cursor: `${EPOCH}:2`, transport: "slack", status: "pending", attempt: 1, at, pendingAt: at, selector: "landing" });
  await appendFaceRecord(root, ROOM, { originId: ORIGIN_B, transport: "slack", status: "unknown", code: "lost-response", reason: "unknown: HTTP 503; the request may have landed", attempt: 1, at, pendingAt: at });
  await appendFaceRecord(root, ROOM, { originId: ORIGIN_B, transport: "slack", part: "attachment", attachmentId: "att-1", name: "graph.png", fileId: "F1", status: "published", attempt: 1, at, via: "response" });
  await appendFaceRecord(root, ROOM, { originId: "d".repeat(64), transport: "slack", status: "unknown", code: "ambiguous", reason: "unknown: 2 byte-identical candidates", attempt: 1, at, pendingAt: at, quarantine: ["1756900002.000100", "1756900002.000200"] });
  await appendFaceRecord(root, ROOM, { originId: "e".repeat(64), transport: "slack", status: "published", id: "1756900003.000100", attempt: 1, at, via: "response" });

  // by cursor: the message id is resolved through the service's own read
  r = await agora(["faces", "nat", "--for", `${EPOCH}:1`, "--json"], env);
  assert.equal(r.code, 0, r.stderr);
  let rows = typed(r.stdout);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, "face");
  assert.equal(rows[0].originId, first.id);
  assert.equal(rows[0].cursor, `${EPOCH}:1`);
  assert.equal(rows[0].status, "refused");
  assert.equal(rows[0].code, "disabled");
  // by id, the same row
  r = await agora(["faces", "nat", "--for", first.id, "--json"], env);
  assert.deepEqual(typed(r.stdout), rows);
  // a message with rows the service wrote: the folded state per (origin, transport, attachment)
  r = await agora(["faces", "nat", "--for", `${EPOCH}:2`], env);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "face slack unknown: unknown: HTTP 503; the request may have landed\nface slack picture graph.png published\n");
  // a message with no rows: said on stderr, exit 0, nothing invented
  r = await agora(["faces", "nat", "--for", `${EPOCH}:2`, "--json"], env);
  rows = typed(r.stdout);
  assert.equal(rows[0].selector, "landing", "the fold keeps the pending line's fields under the outcome");
  assert.equal(rows[0].pendingAt, at);
  const ORIGIN_NONE = first.id;
  r = await agora(["post", "nat", "third"], env);
  r = await agora(["faces", "nat", "--for", `${EPOCH}:3`], env);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /no face rows for a{32}:3 in nat: the seat service wrote none/);
  void ORIGIN_NONE;

  // --unknown: rows, with the quarantine beside the ambiguous one; the published rows absent
  r = await agora(["faces", "nat", "--unknown"], env);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, [
    "face slack unknown: unknown: HTTP 503; the request may have landed",
    "face slack unknown: unknown: 2 byte-identical candidates  quarantined 1756900002.000100 1756900002.000200",
    "",
  ].join("\n"));
  r = await agora(["faces", "nat", "--unknown", "--json"], env);
  rows = typed(r.stdout);
  assert.deepEqual(rows.map((x) => x.originId), [ORIGIN_B, "d".repeat(64)]);
  assert.deepEqual(rows[1].quarantine, ["1756900002.000100", "1756900002.000200"]);
  assert.ok(rows.every((x) => !("count" in x) && !("total" in x)), "rows, never a count");
  await agora(["room", "faces", "bare", "--show"], env);
  r = await agora(["faces", "bare", "--unknown"], env);
  assert.equal(r.stdout, "no unknown faces in bare\n");

  // the usage edges
  r = await agora(["faces", "nat"], env);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /faces needs --for <cursor\|id> .* or --unknown/);
  r = await agora(["faces", "nat", "--for", `${EPOCH}:1`, "--unknown"], env);
  assert.equal(r.code, 2);
  r = await agora(["faces", "nat", "--for", "not-a-cursor"], env);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--for "not-a-cursor": .*pass a native cursor/);
  r = await agora(["faces", "nat", "--for", `${EPOCH}:99`], env);
  assert.equal(r.code, 1);
  r = await agora(["faces", "down", "--unknown"], env);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /faces belong to a native room; "down" is a local room/);
  assert.deepEqual([...(await readFaceRecords(root, ROOM)).values()].filter((x) => x.status === "published" && !x.part).length, 1, "reads wrote nothing");
});

test("the post-time options are a native room's: --face on a slack room, --face with --no-face, and --split on a native room are usage errors that post nothing", async (t) => {
  const { env, root } = await fixture(t);
  // the local room: a slack room with no token is refused at transport creation, before any verb
  let r = await agora(["post", "down", "x", "--face", "slack"], env);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--face and --no-face belong to a native room; "down" is a local room/);
  r = await agora(["post", "down", "x", "--no-face"], env);
  assert.equal(r.code, 2);
  r = await agora(["post", "nat", "x", "--face", "slack", "--no-face"], env);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--no-face and --face contradict each other/);
  r = await agora(["post", "nat", "x", "--split"], env);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--split chunks a Slack post; "nat" is a native room/);
  r = await agora(["read", "nat", "--json"], env);
  assert.equal(r.stdout.trim(), "", "nothing was posted");
  await assert.rejects(stat(path.join(root, "down.ndjson")), { code: "ENOENT" });
});

test("no credential shape reaches stdout, stderr, the policy record or the face record log", async (t) => {
  const { env, root, policyFile } = await fixture(t);
  await agora(["room", "faces", "nat", "--add", "slack", "--disable", "slack"], env);
  const r = await agora(["post", "nat", `the token is ${TOKENISH}`, "--face", "slack", "--json"], env);
  assert.equal(r.code, 0, r.stderr);
  const outputs = r.stdout + r.stderr + (await readFile(policyFile, "utf8")) + (await readFile(faceRecordsPath(root, ROOM), "utf8"));
  assert.doesNotMatch(outputs, /xoxb-1234567890/, "the row carries the reason, the record carries the reason, and neither carries the body");
  const s = await agora(["faces", "nat", "--for", `${EPOCH}:1`], env);
  assert.doesNotMatch(s.stdout + s.stderr, /xoxb-1234567890/);

  // a row whose reason a transport error stamped with a credential shape is redacted on the way out
  const id = JSON.parse(r.stdout).id;
  await appendFaceRecord(root, ROOM, { originId: id, transport: "slack", status: "unknown", code: "lost-response", reason: `unknown: fetch failed for ${TOKENISH}; the request may have landed`, attempt: 1, at: "2026-09-05T12:00:00.000Z", pendingAt: "2026-09-05T12:00:00.000Z" });
  for (const args of [["faces", "nat", "--for", id], ["faces", "nat", "--for", id, "--json"], ["faces", "nat", "--unknown"], ["faces", "nat", "--unknown", "--json"]]) {
    const u = await agora(args, env);
    assert.equal(u.code, 0, u.stderr);
    assert.doesNotMatch(u.stdout + u.stderr, /xoxb-1234567890/, args.join(" "));
    assert.match(u.stdout, /fetch failed for \[redacted\]; the request may have landed/, args.join(" "));
  }
});
