// A member seat's HUMAN in a native room (docs/MEMBERSHIP.md, "A human on a member seat").
//
// Human authorship on a member route is a property of the KEY the route admits, granted in the
// act the counter-seat authority signs, and enforced by the host from the route's binding: the
// seat's agent key posts as an agent whatever its frames claim, and the human key posts as the one
// human its grant names. The rig is the remote-client suite's: an in-process host service with
// faked Tailcat routes and real RemoteRooms dialling them, so the client half is exercised
// against the real host admission path. It proves nothing about Tailcat's own --allow refusal.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Duplex, PassThrough } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";
import { memberAccountId, readRouteSecret, settleMemberAuthor } from "../src/native-member.mjs";
import { RemoteRoom } from "../src/native-remote.mjs";
import { nativeDigest } from "../src/native-protocol.mjs";
import { publicNodeKeyDigest } from "../src/protocol/route.mjs";
import { validateAuthorityRequest } from "../src/authority.mjs";
import { nativeRemoteTransport } from "../src/transports/native-remote.mjs";
import { authorityFixtureService, fixtureProof } from "./authority-fixture.mjs";

const run = promisify(execFile);
const BIN = new URL("../bin/agora.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const HOST_ACCOUNT = "a".repeat(32);
const ROOM = "b".repeat(32);
const EPOCH = "c".repeat(32);
/** The member seat's own key: what its agents post through. */
const AGENT_KEY = `nodekey:${"d".repeat(64)}`;
/** A second key on the same member seat, enrolled in its own state root for its human. */
const HUMAN_KEY = `nodekey:${"e".repeat(64)}`;
const ADDRESS = `tc${"a".repeat(48)}`;

/** @param {{ exit?: number | null, signal?: AbortSignal, stdout?: any, stdin?: any }} [options] */
function fakeChild(options = {}) {
  const { exit = null, signal } = options;
  const stdout = options.stdout ?? new PassThrough();
  /** @type {Record<string, Function[]>} */ const listeners = {};
  const child = /** @type {any} */ ({
    stdout, stdin: options.stdin, exitCode: null, signalCode: null, connected: false,
    once(/** @type {string} */ e, /** @type {Function} */ cb) { (listeners[e] ??= []).push(cb); return child; },
    on(/** @type {string} */ e, /** @type {Function} */ cb) { return child.once(e, cb); },
    disconnect() {},
  });
  const finish = (/** @type {number} */ code) => {
    if (child.exitCode !== null) return;
    child.exitCode = code;
    if (!options.stdout) stdout.end();
    for (const cb of listeners.exit ?? []) cb(code, null);
  };
  if (exit !== null) queueMicrotask(() => finish(exit));
  else if (signal) signal.addEventListener("abort", () => finish(0), { once: true });
  return child;
}

/**
 * Open one route on the host under a signed act, and a RemoteRoom on a seat root of its own that
 * dials it. `humanName` makes it a human route.
 * @param {import('node:test').TestContext} t @param {any} service @param {string} hostRoot
 * @param {string} key @param {string} [humanName]
 */
async function route(t, service, hostRoot, key, humanName) {
  /** @type {{ fn?: (socket: any) => void }} */
  const accept = {};
  const pending = await service.createRouteChallenge({ action: "room-enroll", roomId: ROOM, publicNodeKey: key,
    ...(humanName !== undefined ? { humanName } : {}) });
  const opened = await service.openRoute({ roomId: ROOM, publicNodeKey: key, proof: fixtureProof(service, pending.challenge),
    routeOptions: {
      listen: async (/** @type {(socket: any) => void} */ hook) => { accept.fn = hook; return { port: 4242, close: async () => {} }; },
      spawn: async (/** @type {string[]} */ args, /** @type {any} */ _r, /** @type {any} */ owner) =>
        fakeChild({ exit: (args[0] === "parse" || args[0] === "genkey") ? 0 : null, signal: owner?.signal }),
      address: async () => ADDRESS,
    } });
  const secret = await readRouteSecret(hostRoot, opened.descriptor.binding, opened.descriptor.proofRef);
  const seatRoot = await mkdtemp(path.join(tmpdir(), "agora-member-human-seat-"));
  t.after(() => rm(seatRoot, { recursive: true, force: true }));
  const keyPath = path.join(seatRoot, "identity.private.json");
  await writeFile(keyPath, "{}", { mode: 0o600 });
  const room = new RemoteRoom({ descriptor: opened.descriptor, secret, stateRoot: seatRoot, keyPath, nodeKey: key, timeoutMs: 4000,
    channelOptions: {
      spawn: async (/** @type {string[]} */ args, /** @type {any} */ _runtime, /** @type {any} */ owner) => {
        if ((args[0] === "parse" || args[0] === "genkey")) return fakeChild({ exit: 0, signal: owner?.signal });
        if (args[1] === "printpub") {
          const stdout = new PassThrough();
          const child = fakeChild({ exit: 0, stdout, signal: owner?.signal });
          stdout.end(`${key}\n`);
          return child;
        }
        const toHost = new PassThrough(), toClient = new PassThrough();
        const hostSide = Duplex.from({ readable: toHost, writable: toClient });
        hostSide.on("error", () => {});
        /** @type {(socket: any) => void} */ (accept.fn)(hostSide);
        return fakeChild({ signal: owner?.signal, stdout: toClient, stdin: toHost });
      },
    } });
  t.after(() => room.close());
  return { pending, opened, room };
}

/** @param {import('node:test').TestContext} t */
async function rig(t) {
  const hostRoot = await mkdtemp(path.join(tmpdir(), "agora-member-human-host-"));
  t.after(() => rm(hostRoot, { recursive: true, force: true }));
  const service = await authorityFixtureService({ root: hostRoot, accountId: HOST_ACCOUNT, seatLabel: "host" },
    [{ roomId: ROOM, publicNodeKeys: [AGENT_KEY, HUMAN_KEY] }]);
  await service.start();
  await service.createRoom({ roomId: ROOM, epoch: EPOCH });
  t.after(() => service.stop());
  const agent = await route(t, service, hostRoot, AGENT_KEY);
  const human = await route(t, service, hostRoot, HUMAN_KEY, "Grace");
  const store = await service.openRoom(ROOM);
  /** @param {any} remote @param {{ name: string, kind: string }} actor */
  const transport = (remote, actor) => {
    const made = nativeRemoteTransport(/** @type {any} */ ({ transport: "native-remote" }), { actor: /** @type {any} */ (actor), remote });
    t.after(() => made.close?.());
    return made;
  };
  return { hostRoot, service, store, agent, human, transport };
}

const HUMAN_ID = memberAccountId(publicNodeKeyDigest(HUMAN_KEY));
const AGENT_ID = memberAccountId(publicNodeKeyDigest(AGENT_KEY));
const opId = (/** @type {string} */ c) => c.repeat(32);

test("a member seat's human key posts as human under its bound name; the same seat's agent key posts as agent", async (t) => {
  const { service, store, agent, human, transport } = await rig(t);
  assert.deepEqual(human.opened.descriptor.binding.author, { kind: "human", name: "Grace" });
  assert.equal(Object.hasOwn(agent.opened.descriptor.binding, "author"), false, "an agent route's binding is unchanged");

  await transport(human.room, { name: "Grace", kind: "human" }).post("yes: I agree to the joint ruling");
  await transport(agent.room, { name: "builder/Model", kind: "agent" }).post("the build is green");
  // a frame that leaves the author out is stamped from the binding, never from a default
  await (await human.room.client()).request("append", { roomId: ROOM, operation: { operationId: opId("1"), text: "and again" } });
  await (await agent.room.client()).request("append", { roomId: ROOM, operation: { operationId: opId("2"), authorName: "builder/Model", text: "agent, unlabelled" } });

  assert.deepEqual(store.view().messages.map((m) => [m.author.id, m.author.kind, m.author.name]), [
    [HUMAN_ID, "human", "Grace"],
    [AGENT_ID, "agent", "builder/Model"],
    [HUMAN_ID, "human", "Grace"],
    [AGENT_ID, "agent", "builder/Model"],
  ]);
  const rows = service.listRoutes();
  assert.deepEqual(rows.find((r) => r.accountId === HUMAN_ID)?.author, { kind: "human", name: "Grace" });
  assert.equal(Object.hasOwn(rows.find((r) => r.accountId === AGENT_ID) ?? {}, "author"), false);
});

test("the host refuses human authorship to the agent key, and any other kind or name on the human key, by name, with nothing appended", async (t) => {
  const { store, agent, human, transport } = await rig(t);
  // the seat's agents post through the seat's own key: a human flag there is refused, however set
  await assert.rejects(transport(agent.room, { name: "Grace", kind: "human" }).post("I am Grace"), /member-author-kind-refused/);
  await assert.rejects((await agent.room.client()).request("append", { roomId: ROOM,
    operation: { operationId: opId("3"), authorName: "Grace", authorKind: "human", text: "forged" } }), /member-author-kind-refused/);
  // the human key is the human: not an agent, and not anyone else
  await assert.rejects(transport(human.room, { name: "Grace", kind: "agent" }).post("as an agent"), /member-author-kind-refused/);
  await assert.rejects(transport(human.room, { name: "Ada", kind: "human" }).post("as the host's human"), /member-author-name-refused/);
  await assert.rejects((await human.room.client()).request("append", { roomId: ROOM,
    operation: { operationId: opId("4"), authorName: 7, text: "no name" } }), /member-author-name-refused/);
  assert.equal(store.view().messages.length, 0, "nothing was appended");
});

test("a human route may not break a holder or purge; its attachments ride as on any member route", async (t) => {
  const { store, human, transport } = await rig(t);
  const claim = await store.append({ kind: "board", operationId: opId("5"), payload: { action: "claim", subject: "work:unit-1" } }, { accountId: HOST_ACCOUNT });
  assert.equal(/** @type {any} */ (claim).held, true, "fixture failed to establish a local holder");
  const before = store.board().find((h) => h.subject === "work:unit-1");
  const grace = transport(human.room, { name: "Grace", kind: "human" });
  await assert.rejects(/** @type {any} */ (grace).board({ action: "break", subject: "work:unit-1" }), /member-break-refused/);
  const after = store.board().find((h) => h.subject === "work:unit-1");
  assert.equal(after?.accountId, HOST_ACCOUNT);
  assert.equal(after?.leaseId, before?.leaseId, "the local holder survived the refused break");

  const local = await store.append({ operationId: opId("6"), authorName: "Ada", authorKind: "human", text: "the host's words" }, { accountId: HOST_ACCOUNT });
  await assert.rejects((await human.room.client()).request("append", { roomId: ROOM,
    operation: { kind: "purge", operationId: opId("7"), authorName: "Grace", purge: { targets: [local.id], reason: "from afar" } } }), /purge-refused-remote/);
  assert.equal(store.view().messages.length, 1, "the purge appended nothing");

  const { uploadAttachment } = await import("../src/client-attachments.mjs");
  const { ClientError } = await import("../src/client.mjs");
  /** @type {import("../src/client-attachments.mjs").AttachmentSeam} */
  const seam = {
    roomId: () => ROOM,
    live: async () => ({ client: await human.room.client(), accountId: human.room.binding.accountId }),
    capabilities: () => new Set(),
    refused: (code, msg, extra) => new ClientError("refused", code, msg, extra),
    dark: (code, msg, extra) => new ClientError("dark", code, msg, extra),
    classify: (e) => e instanceof ClientError ? e : new ClientError("refused", "unexpected", String(e)),
  };
  const ref = await uploadAttachment(seam, "remote", { bytes: Buffer.from("signed copy\n"), name: "ruling.txt", mimetype: "text/plain" });
  await grace.post("the signed copy", { attachments: [ref] });
  const last = store.view().messages.at(-1);
  assert.deepEqual([last?.author.kind, last?.author.name, last?.attachments?.map((/** @type {any} */ a) => a.id)], ["human", "Grace", [ref.id]]);
});

test("the human grant is in the act the authority signs, and only an enroll takes a well-formed one", async (t) => {
  const hostRoot = await mkdtemp(path.join(tmpdir(), "agora-member-human-act-"));
  t.after(() => rm(hostRoot, { recursive: true, force: true }));
  const service = await authorityFixtureService({ root: hostRoot, accountId: HOST_ACCOUNT, seatLabel: "host" },
    [{ roomId: ROOM, publicNodeKeys: [AGENT_KEY, HUMAN_KEY] }]);
  await service.start();
  await service.createRoom({ roomId: ROOM, epoch: EPOCH });
  t.after(() => service.stop());

  const pending = await service.createRouteChallenge({ action: "room-enroll", roomId: ROOM, publicNodeKey: HUMAN_KEY, humanName: "Grace" });
  assert.deepEqual(pending.request.binding.author, { kind: "human", name: "Grace" });
  assert.equal(pending.challenge.act.requestDigest, nativeDigest(validateAuthorityRequest(pending.request)));
  const { author: _dropped, ...agentBinding } = pending.request.binding;
  assert.notEqual(nativeDigest(validateAuthorityRequest({ ...pending.request, binding: agentBinding })), pending.challenge.act.requestDigest,
    "the signed digest does not cover the grant");
  const renamed = { ...pending.request, binding: { ...pending.request.binding, author: { kind: "human", name: "Ada" } } };
  assert.notEqual(nativeDigest(validateAuthorityRequest(renamed)), pending.challenge.act.requestDigest);

  for (const name of ["", " Grace", "Grace ", "Gr\nace", "x".repeat(121), 7])
    await assert.rejects(service.createRouteChallenge({ action: "room-enroll", roomId: ROOM, publicNodeKey: AGENT_KEY, humanName: name }), /route-human-invalid/);
  // a name that spells a position is refused by its own code: `to:` would name both the person and a position's holder
  for (const name of ["main.coding", "Main.Coding", "desk.review-2"])
    await assert.rejects(service.createRouteChallenge({ action: "room-enroll", roomId: ROOM, publicNodeKey: AGENT_KEY, humanName: name }), /route-human-position/, name);
  const opened = await service.openRoute({ roomId: ROOM, publicNodeKey: HUMAN_KEY, proof: fixtureProof(service, pending.challenge),
    routeOptions: { listen: async () => ({ port: 4242, close: async () => {} }),
      spawn: async (/** @type {string[]} */ args, /** @type {any} */ _r, /** @type {any} */ owner) => fakeChild({ exit: (args[0] === "parse" || args[0] === "genkey") ? 0 : null, signal: owner?.signal }),
      address: async () => ADDRESS } });
  assert.deepEqual(opened.descriptor.binding.author, { kind: "human", name: "Grace" });
  await assert.rejects(service.createRouteChallenge({ action: "room-revoke", roomId: ROOM, publicNodeKey: HUMAN_KEY, humanName: "Grace" }), /route-human-invalid/);
  const revoke = await service.createRouteChallenge({ action: "room-revoke", roomId: ROOM, publicNodeKey: HUMAN_KEY });
  assert.deepEqual(revoke.request.binding.author, { kind: "human", name: "Grace" }, "a revoke names the live route's own grant");
});

test("settleMemberAuthor decides by binding: the agent rule is unchanged, the human rule fills in and refuses by name", () => {
  const base = { host: {}, accountId: AGENT_ID };
  /** @param {any} binding @param {Record<string, any>} op */
  const settle = (binding, op) => { const refused = settleMemberAuthor(binding, op); return refused ? refused.code : op; };
  assert.deepEqual(settle(base, { text: "x" }), { text: "x", authorKind: "agent" });
  assert.equal(settle(base, { authorKind: "human" }), "member-author-kind-refused");
  assert.equal(settle(base, { authorKind: "unknown" }), "member-author-kind-refused");
  const human = { ...base, author: { kind: "human", name: "Grace" } };
  assert.deepEqual(settle(human, { text: "x" }), { text: "x", authorKind: "human", authorName: "Grace" });
  assert.deepEqual(settle(human, { authorName: " Grace " }), { authorKind: "human", authorName: "Grace" });
  assert.equal(settle(human, { authorKind: "agent" }), "member-author-kind-refused");
  assert.equal(settle(human, { authorKind: "system" }), "member-author-kind-refused");
  assert.equal(settle(human, { authorName: "Ada" }), "member-author-name-refused");
  assert.equal(settle(human, { kind: "board", payload: { action: "break", subject: "s" } }), "member-break-refused");
  assert.deepEqual(settle(human, { kind: "board", payload: { action: "claim", subject: "s" } }),
    { kind: "board", payload: { action: "claim", subject: "s" }, authorKind: "human", authorName: "Grace" });
});

test("--human-name goes only with route challenge --act room-enroll, refused before any service is asked", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-member-human-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  /** @param {string[]} args */
  const agora = async (args) => {
    /** @type {NodeJS.ProcessEnv} */
    const env = { ...process.env, AGORA_STATE: path.join(root, "state"), AGORA_CONFIG: path.join(root, "absent.json") };
    for (const name of ["AGORA_ACTOR", "AGORA_SESSION", "AGORA_SESSION_PID"]) delete env[name];
    try { await run(process.execPath, [BIN, ...args], { env, windowsHide: true, timeout: 20000 }); return { code: 0, stderr: "" }; }
    catch (e) { const err = /** @type {any} */ (e); return { code: err.code, stderr: String(err.stderr ?? "") }; }
  };
  const common = ["service", "route"];
  for (const args of [
    [...common, "open", ROOM, "--allow-key", HUMAN_KEY, "--proof-file", path.join(root, "p.json"), "--human-name", "Grace"],
    [...common, "challenge", ROOM, "--allow-key", HUMAN_KEY, "--act", "room-revoke", "--out", path.join(root, "c.json"), "--human-name", "Grace"],
  ]) {
    const r = await agora(args);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /--human-name goes with route challenge --act room-enroll/);
  }
  const padded = await agora([...common, "challenge", ROOM, "--allow-key", HUMAN_KEY, "--act", "room-enroll", "--out", path.join(root, "c.json"), "--human-name", " Grace"]);
  assert.notEqual(padded.code, 0);
  assert.match(padded.stderr, /no leading or trailing space/);
  const position = await agora([...common, "challenge", ROOM, "--allow-key", HUMAN_KEY, "--act", "room-enroll", "--out", path.join(root, "c.json"), "--human-name", "main.coding"]);
  assert.notEqual(position.code, 0);
  assert.match(position.stderr, /--human-name "main\.coding" spells a position/);
  // red leg: a plain name passes this refusal (it fails later, with no service to ask)
  const plain = await agora([...common, "challenge", ROOM, "--allow-key", HUMAN_KEY, "--act", "room-enroll", "--out", path.join(root, "c.json"), "--human-name", "Grace"]);
  assert.doesNotMatch(plain.stderr, /spells a position|no leading or trailing space|--human-name goes with/);
});
