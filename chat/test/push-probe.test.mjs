// @ts-check
// The push probe: numbered pushes recorded with the push service's answer and the device's ack, and
// a report per person.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createPush, createPushService } from "../push/server.mjs";
import { openPushStore } from "../push/store.mjs";
import { startFakePushService } from "../push/fake-service.mjs";
import { parseDuration, probeRound, probeReport, renderReport } from "../scripts/push-probe.mjs";

const run = promisify(execFile);
const PROBE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "push-probe.mjs");

test("durations", () => {
  assert.equal(parseDuration("1h"), 3_600_000);
  assert.equal(parseDuration("72h"), 72 * 3_600_000);
  assert.equal(parseDuration("90s"), 90_000);
  assert.throws(() => parseDuration("1 hour"));
  assert.throws(() => parseDuration("0m"));
});

test("rounds record sent, the push service's answer and the ack; the report names what never arrived", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "chat-probe-"));
  const fake = await startFakePushService();
  const store = await openPushStore({ storeDir: dir });
  t.after(async () => {
    store.close();
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  });
  const push = await createPush({ vapidFile: path.join(dir, "vapid.json"), subject: "mailto:ops@example.org", allowEndpoint: fake.allows });
  const service = createPushService({ store, push, hooks: { people: async () => [], notifyText: () => ({ title: "", body: "" }) } });
  const sub = await fake.subscribe();
  store.saveSubscription("alice", { endpoint: sub.endpoint, ...sub.keys });

  const r1 = await probeRound({ service, store, people: ["alice", "bob"], run: "r", seq: store.nextSeq("r"), total: 3 });
  assert.equal(r1[0].results[0].status, 201);
  assert.deepEqual(r1[1].results, [], "bob holds no subscription");
  const arrival = fake.arrivals.at(-1);
  assert.equal(arrival?.payload?.title, "Test push 1");
  assert.equal(arrival?.payload?.kind, "probe");
  assert.equal(arrival?.payload?.seq, 1);
  // the device shows push 1 and acknowledges it through the host's route
  const ack = await service.handle(new Request("http://app.local/chat/push/ack", { method: "POST", body: JSON.stringify({ pushId: arrival?.payload?.pushId }) }), { id: "alice", name: "Alice" });
  assert.equal(ack?.status, 200);

  fake.respondWith(500);
  await probeRound({ service, store, people: ["alice", "bob"], run: "r", seq: store.nextSeq("r"), total: 3 });
  await probeRound({ service, store, people: ["alice", "bob"], run: "r", seq: store.nextSeq("r"), total: 3 });

  const report = probeReport(store, "r");
  const alice = report.people.find((p) => p.person === "alice");
  const bob = report.people.find((p) => p.person === "bob");
  assert.ok(alice && bob);
  assert.deepEqual([alice.sent, alice.accepted, alice.acked, alice.unacked], [3, 2, 1, [2, 3]]);
  assert.deepEqual(alice.answers, { 201: 2, 500: 1 });
  assert.deepEqual([bob.sent, bob.noSubscription], [0, 3]);
  const text = renderReport(report);
  assert.match(text, /alice: sent 3, push service accepted 2 \(201x2 500x1\), acked 1/);
  assert.match(text, /never acked: 2, 3/);
  assert.match(text, /bob: sent 0.*3 round\(s\) with no subscription/);
  assert.deepEqual(store.probeRuns(), ["r"]);
});

test("the CLI: --report reads the latest run; a send refuses an endpoint that is no push service", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "chat-probe-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await openPushStore({ storeDir: dir });
  store.saveSubscription("alice", { endpoint: "http://127.0.0.1:9/push/x", p256dh: "k", auth: "a" });
  store.close();
  const bun = process.execPath;
  const usage = await run(bun, [PROBE, "--store", dir, "--people", "alice"]).catch((e) => e);
  assert.equal(usage.code, 2);
  const sent = await run(bun, [PROBE, "--store", dir, "--vapid", path.join(dir, "vapid.json"), "--subject", "mailto:ops@example.org",
    "--people", "alice", "--once", "--run", "cli", "--json"]);
  const line = JSON.parse(sent.stdout.trim());
  assert.equal(line.seq, 1);
  assert.match(line.results[0].error, /push-endpoint-refused/);
  const report = await run(bun, [PROBE, "--store", dir, "--report", "--json"]);
  const r = JSON.parse(report.stdout);
  assert.equal(r.run, "cli");
  assert.equal(r.people[0].sent, 1);
  assert.equal(r.people[0].accepted, 0);
});
