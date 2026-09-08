// L12: the readiness descriptor, and above all what it is NOT.
//
// Seam 7 splits the claim from the descriptor because conflating them is the defect wearing a fix.
// So the cells here pin two things: the descriptor routes and reports, and every refusal carries
// the START line rather than an invitation to dial — "re-dial" is the defect returning under
// another name, and a refusal that only says the client is absent invites exactly that.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  memberDescriptorPath, memberDescriptorStatus, memberStartLine, readMemberDescriptor,
  removeMemberDescriptor, writeMemberDescriptor,
} from "../src/native-member-descriptor.mjs";
import { ServiceDarkError } from "../src/wake/subscriber.mjs";

const ALIAS = "house-remote";
const ROOM_ID = "a".repeat(32);
const KEY_DIGEST = `sha256:${"b".repeat(64)}`;

/** @param {import('node:test').TestContext} t */
async function stateRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-memberdesc-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** A complete readiness descriptor, as the resident client publishes it after subscribe. */
const descriptorFor = (extra = {}) => ({
  path: "/tmp/agora-member.sock",
  nonce: "f".repeat(32),
  alias: ALIAS,
  roomId: ROOM_ID,
  keyDigest: KEY_DIGEST,
  accountId: `m-${"c".repeat(32)}`,
  bootEpoch: "d".repeat(32),
  pid: process.pid,
  startedAt: new Date().toISOString(),
  ...extra,
});

test("a session with no resident client is told to START one, never to dial", async (t) => {
  const root = await stateRoot(t);
  await assert.rejects(
    () => readMemberDescriptor(root, ALIAS),
    (/** @type {any} */ error) => {
      assert.ok(error instanceof ServiceDarkError, "a missing member client is service-dark, like a dark seat service");
      assert.equal(error.reason, "service-dark");
      assert.equal(error.exitCode, 1);
      // The two halves of seam 4: name the descriptor, and say to start the client.
      assert.match(error.message, /native[/\\]member[/\\]house-remote\.json/);
      assert.match(error.message, /agora member start house-remote/);
      // A refusal that offers a dial is the defect returning under another name.
      assert.doesNotMatch(error.message, /re-?dial|dial (?:it|the host|directly|again)/i);
      return true;
    },
  );
});

test("every unreadable shape refuses with the start line, not just the absent one", async (t) => {
  const root = await stateRoot(t);
  const file = memberDescriptorPath(root, ALIAS);
  await mkdir(path.dirname(file), { recursive: true });

  const shapes = [
    ["not valid JSON", "{ not json\n"],
    ["no endpoint", `${JSON.stringify({ alias: ALIAS, roomId: ROOM_ID, keyDigest: KEY_DIGEST })}\n`],
    ["no room binding", `${JSON.stringify({ path: "/tmp/s.sock", nonce: "f".repeat(32) })}\n`],
  ];
  for (const [name, body] of shapes) {
    await writeFile(file, body, "utf8");
    await assert.rejects(
      () => readMemberDescriptor(root, ALIAS),
      (/** @type {any} */ error) => {
        assert.ok(error instanceof ServiceDarkError, name);
        assert.match(error.message, /agora member start house-remote/, `${name} must carry the start line`);
        return true;
      },
      name,
    );
  }
});

test("the descriptor round-trips and status never surfaces the nonce", async (t) => {
  const root = await stateRoot(t);
  const written = await writeMemberDescriptor(root, descriptorFor({
    claim: { path: "/state/native/member/claims/x.claim.json", generation: "gen1" },
    build: { version: "0.1.0", source: "git", git: "e".repeat(40), at: new Date().toISOString() },
  }));
  assert.equal(written, memberDescriptorPath(root, ALIAS));

  const read = await readMemberDescriptor(root, ALIAS);
  assert.equal(read.roomId, ROOM_ID);
  assert.equal(read.keyDigest, KEY_DIGEST);
  assert.equal(read.nonce, "f".repeat(32));

  const status = await memberDescriptorStatus(root, ALIAS);
  assert.equal(status.present, true);
  assert.equal(status.alias, ALIAS);
  assert.equal(status.endpoint, "/tmp/agora-member.sock");
  assert.equal(status.pid, process.pid);
  assert.equal(status.pidAlive, true);
  assert.equal(status.claim?.generation, "gen1");
  assert.equal(status.build?.source, "git");
  // The nonce is the seat-local service secret. It does not leave this machine, and `status` is
  // the surface most likely to be pasted into a room.
  assert.equal(/** @type {any} */ (status).nonce, undefined);
  assert.doesNotMatch(JSON.stringify(status), /f{32}/);
});

test("status reports a dark client without throwing, and still names the file", async (t) => {
  const root = await stateRoot(t);
  const status = await memberDescriptorStatus(root, ALIAS);
  assert.equal(status.present, false);
  assert.equal(status.descriptor, memberDescriptorPath(root, ALIAS));
  assert.match(String(status.error), /agora member start house-remote/);
});

test("status separates a published descriptor whose process is gone", async (t) => {
  const root = await stateRoot(t);
  await writeMemberDescriptor(root, descriptorFor({ pid: 999_999_999 }));
  const status = await memberDescriptorStatus(root, ALIAS);
  // Present and routable on its face; the pid says otherwise. Both facts are reported, and the
  // caller decides — as `doctor` does for a watch whose process is gone.
  assert.equal(status.present, true);
  assert.equal(status.pid, 999_999_999);
  assert.equal(status.pidAlive, false);
});

test("the descriptor is per alias while the claim is per key", async (t) => {
  const root = await stateRoot(t);
  await writeMemberDescriptor(root, descriptorFor());
  await writeMemberDescriptor(root, descriptorFor({ alias: "other-room", roomId: "9".repeat(32) }));

  // Two aliases on ONE key: two readiness descriptors, both naming the same key digest, because
  // they are two rooms on one client. Nothing here is an ownership statement.
  const a = await readMemberDescriptor(root, ALIAS);
  const b = await readMemberDescriptor(root, "other-room");
  assert.equal(a.keyDigest, b.keyDigest);
  assert.notEqual(a.roomId, b.roomId);
  assert.notEqual(memberDescriptorPath(root, ALIAS), memberDescriptorPath(root, "other-room"));
});

test("removal is idempotent and never throws", async (t) => {
  const root = await stateRoot(t);
  await writeMemberDescriptor(root, descriptorFor());
  assert.equal(await removeMemberDescriptor(root, ALIAS), true);
  await assert.rejects(() => readMemberDescriptor(root, ALIAS), (e) => e instanceof ServiceDarkError);
  // A bounded stop that runs twice, or a stop racing a crash, must not turn teardown into an error.
  assert.equal(await removeMemberDescriptor(root, ALIAS), true);
  assert.equal(await removeMemberDescriptor(root, "never-existed"), true);
});

test("an alias that is not a usable path segment is refused, not joined into a path", async (t) => {
  const root = await stateRoot(t);
  for (const alias of ["../escape", "a/b", "", "with space", "dot.dot/../x"]) {
    assert.throws(() => memberDescriptorPath(root, alias), (/** @type {any} */ error) => {
      assert.ok(error instanceof ServiceDarkError);
      assert.match(error.message, /not a usable room alias/);
      return true;
    }, JSON.stringify(alias));
  }
  // And the status projection reports it rather than throwing out of a reporting call.
  const status = await memberDescriptorStatus(root, "../escape");
  assert.equal(status.present, false);
  assert.match(String(status.error), /not a usable room alias/);
});

test("the start line names the alias it is for", () => {
  assert.match(memberStartLine("house-remote"), /agora member start house-remote/);
  assert.match(memberStartLine("other"), /agora member start other/);
  assert.match(memberStartLine("house-remote"), /no session dials Tailcat directly/);
});

test("the descriptor write is atomic-replace, so a reader never sees a half-written file", async (t) => {
  const root = await stateRoot(t);
  await writeMemberDescriptor(root, descriptorFor());
  await writeMemberDescriptor(root, descriptorFor({ roomId: "7".repeat(32) }));
  const read = await readMemberDescriptor(root, ALIAS);
  assert.equal(read.roomId, "7".repeat(32));
  // No temp files left behind in the member directory.
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(path.dirname(memberDescriptorPath(root, ALIAS)));
  assert.deepEqual(entries.filter((e) => e.includes(".tmp-")), []);
  assert.ok(entries.includes(`${ALIAS}.json`));
  const raw = await readFile(memberDescriptorPath(root, ALIAS), "utf8");
  assert.equal(raw.endsWith("\n"), true);
});
