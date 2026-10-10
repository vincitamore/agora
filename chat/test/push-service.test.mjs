// @ts-check
// The push routes, the policy and the store, end to end against a loopback push service that checks
// the VAPID token and decrypts every body as a user agent would.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPush, createPushService, threadUrlFrom, DEFAULT_THREAD_URL } from "../push/server.mjs";
import { openPushStore, DEFAULT_PREFS } from "../push/store.mjs";
import { recipientsFor, lockScreenText, parsePrefs, waitingOn } from "../push/policy.mjs";
import { startFakePushService } from "../push/fake-service.mjs";

const alice = { id: "alice", name: "Alice", ref: "alice" };
const bob = { id: "bob", name: "Bob", ref: "bob" };
const carol = { id: "carol", name: "Carol", ref: "carol" };
const people = [alice, bob, carol];

/** @param {import("node:test").TestContext} t */
async function setup(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "chat-push-"));
  const fake = await startFakePushService();
  const store = await openPushStore({ storeDir: dir });
  t.after(async () => {
    store.close();
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  });
  const push = await createPush({ vapidFile: path.join(dir, "vapid.json"), subject: "mailto:ops@example.org", allowEndpoint: fake.allows });
  const service = createPushService({
    store, push,
    hooks: {
      people: async () => people,
      notifyText: ({ message }) => ({ title: `${message.author?.name ?? "someone"} wrote`, body: String(message.text ?? "") }),
    },
    threadUrl: (root) => (root ? `/room?thread=${root}` : "/room"),
  });
  /** @param {string} method @param {string} p @param {unknown} [body] @param {any} [person] */
  const call = async (method, p, body, person = alice) => {
    const res = await service.handle(new Request(`http://app.local${p}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }), person);
    assert.ok(res, `${method} ${p} answered`);
    return { status: res.status, body: await res.json() };
  };
  return { dir, fake, store, push, service, call };
}

test("routes: key, subscribe, a test push the user agent decrypts, ack, unsubscribe", async (t) => {
  const { fake, store, push, call } = await setup(t);
  const key = await call("GET", "/chat/push/key");
  assert.equal(key.status, 200);
  assert.equal(key.body.data.publicKey, push.publicKey);

  const sub = await fake.subscribe();
  assert.equal((await call("POST", "/chat/push/subscribe", sub)).status, 200);
  assert.equal(store.subscriptionsOf("alice").length, 1);

  const sent = await call("POST", "/chat/push/test");
  assert.equal(sent.status, 200);
  const [r] = sent.body.data.results;
  assert.equal(r.status, 201);
  const arrival = fake.arrivals.at(-1);
  assert.ok(arrival);
  assert.equal(arrival.vapidKey, push.publicKey, "signed with the key the browser subscribed under");
  assert.equal(arrival.payload?.pushId, r.pushId);
  assert.equal(arrival.payload?.kind, "test");
  assert.equal(arrival.payload?.title, "Test notification");
  assert.equal(arrival.headers.urgency, "normal");
  assert.equal(arrival.headers.ttl, String(24 * 3600));

  // only the person a push went to can acknowledge it
  assert.equal((await call("POST", "/chat/push/ack", { pushId: r.pushId }, bob)).status, 404);
  assert.equal((await call("POST", "/chat/push/ack", { pushId: r.pushId })).status, 200);
  assert.equal((await call("POST", "/chat/push/ack", { pushId: r.pushId, event: "clicked" })).status, 200);
  const rec = store.sentRecord(r.pushId);
  assert.ok(rec?.ackedAt && rec.clickedAt);
  assert.equal(rec.status, 201);

  assert.equal((await call("DELETE", "/chat/push/subscribe", { endpoint: sub.endpoint }, bob)).body.data.removed, false);
  assert.equal((await call("DELETE", "/chat/push/subscribe", { endpoint: sub.endpoint })).body.data.removed, true);
  assert.equal((await call("POST", "/chat/push/test")).status, 409);
});

test("routes: no session is 401, other paths are the host's, bad bodies refuse", async (t) => {
  const { service, call, fake } = await setup(t);
  for (const [m, p] of [["GET", "/chat/push/key"], ["POST", "/chat/push/test"], ["GET", "/chat/prefs"]]) {
    const res = await service.handle(new Request(`http://app.local${p}`, { method: m }), null);
    assert.equal(res?.status, 401, `${m} ${p}`);
  }
  assert.equal(await service.handle(new Request("http://app.local/chat/state"), alice), null);
  assert.equal(await service.handle(new Request("http://app.local/api/x"), alice), null);
  // an endpoint that is not a push service is refused before anything is stored
  const sub = await fake.subscribe();
  const bad = await call("POST", "/chat/push/subscribe", { ...sub, endpoint: "https://intranet.example/push/1" });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error.message, "subscription-endpoint-not-push-service");
  assert.equal((await call("POST", "/chat/push/subscribe", { ...sub, keys: { p256dh: sub.keys.p256dh, auth: "AAAA" } })).status, 422);
  assert.equal((await call("POST", "/chat/push/ack", { pushId: "not-hex" })).status, 400);
  const raw = await service.handle(new Request("http://app.local/chat/push/subscribe", { method: "POST", body: "{nope" }), alice);
  assert.equal(raw?.status, 400);
  const big = await service.handle(new Request("http://app.local/chat/push/subscribe", { method: "POST", body: "x".repeat(9000) }), alice);
  assert.equal(big?.status, 413);
});

test("a 404 or 410 from the push service removes the subscription; a 5xx keeps it", async (t) => {
  const { fake, store, service } = await setup(t);
  const a = await fake.subscribe();
  const b = await fake.subscribe();
  store.saveSubscription("alice", { endpoint: a.endpoint, ...a.keys });
  store.saveSubscription("alice", { endpoint: b.endpoint, ...b.keys });
  fake.respondWith(410, 503);
  const results = await service.sendTo("alice", { title: "t", body: "b", kind: "test" });
  assert.deepEqual(results.map((r) => r.status), [410, 503]);
  assert.deepEqual(store.subscriptionsOf("alice").map((s) => s.endpoint), [b.endpoint]);
  fake.respondWith(404);
  await service.sendTo("alice", { title: "t", body: "b", kind: "test" });
  assert.equal(store.subscriptionsOf("alice").length, 0);
  // every push and its answer stays on the record
  const statuses = fake.arrivals.map((x) => x.status);
  assert.deepEqual(statuses, [410, 503, 404]);
});

test("prefs: defaults, a partial update, unknown fields refused", async (t) => {
  const { call } = await setup(t);
  assert.deepEqual((await call("GET", "/chat/prefs")).body.data, DEFAULT_PREFS);
  const put = await call("PUT", "/chat/prefs", { notify: { all: true, mine: false }, lockScreen: "generic" });
  assert.equal(put.status, 200);
  assert.deepEqual(put.body.data, { notify: { mentions: true, asks: true, mine: false, all: true }, lockScreen: "generic" });
  assert.deepEqual((await call("GET", "/chat/prefs")).body.data, put.body.data);
  assert.deepEqual((await call("GET", "/chat/prefs", undefined, bob)).body.data, DEFAULT_PREFS, "prefs are per person");
  assert.equal((await call("PUT", "/chat/prefs", { notify: { everything: true } })).status, 422);
  assert.equal((await call("PUT", "/chat/prefs", { notify: { all: "yes" } })).status, 422);
  assert.equal((await call("PUT", "/chat/prefs", { theme: "dark" })).status, 422);
  assert.equal((await call("PUT", "/chat/prefs", { lockScreen: "full" })).status, 422);
});

test("policy: mentions, a waiting naming you, replies in your threads, or everything; never your own", () => {
  /** @type {Record<string, import("../push/store.mjs").PushPrefs>} */
  const prefs = {};
  const prefsOf = (/** @type {string} */ id) => prefs[id] ?? { notify: { ...DEFAULT_PREFS.notify }, lockScreen: "title-line" };
  const from = (/** @type {any} */ who, /** @type {Record<string, any>} */ extra = {}) => ({ id: "m1", author: { kind: "human", name: who.name, ref: who.ref }, text: "hi", ...extra });
  const agent = { id: "m2", author: { kind: "agent", name: "the resident" }, text: "done", thread: "root1", trailers: [["waiting", "bob"]] };

  // a top-level message mentioning bob: bob, under mention; the author never
  assert.deepEqual(recipientsFor({ message: from(alice), people, prefsOf, mentions: ["bob", "alice"] }).map((r) => [r.person.id, r.reason]), [["bob", "mention"]]);
  // an agent's reply waiting on bob, in a thread carol is in
  assert.deepEqual(recipientsFor({ message: agent, people, prefsOf, participants: ["carol", "alice"] }).map((r) => [r.person.id, r.reason]),
    [["alice", "mine"], ["bob", "ask"], ["carol", "mine"]]);
  assert.deepEqual(waitingOn(agent), ["bob"]);
  // participation only counts for a reply
  assert.deepEqual(recipientsFor({ message: from(alice), people, prefsOf, participants: ["bob"] }), []);
  // prefs switch each reason off, and "all" on
  prefs.bob = { notify: { mentions: false, asks: false, mine: true, all: false }, lockScreen: "title-line" };
  prefs.carol = { notify: { mentions: false, asks: false, mine: false, all: true }, lockScreen: "generic" };
  assert.deepEqual(recipientsFor({ message: from(alice), people, prefsOf, mentions: ["bob"] }).map((r) => [r.person.id, r.reason]), [["carol", "all"]]);

  const notifyText = () => ({ title: "Alice   wrote", body: `${"word ".repeat(100)}` });
  const t1 = lockScreenText({ prefs: prefsOf("alice"), notifyText, message: from(alice) });
  assert.equal(t1.title, "Alice wrote");
  assert.ok(t1.body.length <= 240 && t1.body.endsWith("…"));
  assert.deepEqual(lockScreenText({ prefs: prefsOf("carol"), notifyText, message: from(alice) }), { title: "New message", body: "" });
  assert.equal(parsePrefs([], prefsOf("alice")).ok, false);
});

test("notify: one room message reaches each recipient's subscriptions with their lock-screen text", async (t) => {
  const { fake, store, service } = await setup(t);
  const subBob = await fake.subscribe();
  const subCarol = await fake.subscribe();
  store.saveSubscription("bob", { endpoint: subBob.endpoint, ...subBob.keys });
  store.saveSubscription("carol", { endpoint: subCarol.endpoint, ...subCarol.keys });
  store.savePrefs("carol", { notify: { mentions: true, asks: true, mine: true, all: false }, lockScreen: "generic" });
  const message = { id: "r1", thread: "root9", author: { kind: "human", name: "Alice", ref: "alice" }, text: "can you check this?", trailers: [["waiting", "bob"]] };
  const out = await service.notify({ message, mentions: [], participants: ["carol"] });
  assert.deepEqual(out.map((o) => [o.person, o.reason, o.results.map((r) => r.status)]), [["bob", "ask", [201]], ["carol", "mine", [201]]]);
  const byEndpoint = Object.fromEntries(fake.arrivals.map((a) => [a.subscriptionId, a]));
  const bobArrival = byEndpoint[subBob.endpoint.split("/").pop() ?? ""];
  const carolArrival = byEndpoint[subCarol.endpoint.split("/").pop() ?? ""];
  assert.equal(bobArrival.payload?.title, "Alice wrote");
  assert.equal(bobArrival.payload?.body, "can you check this?");
  assert.equal(bobArrival.payload?.thread, "root9");
  assert.equal(bobArrival.payload?.url, "/room?thread=root9");
  assert.equal(bobArrival.headers.urgency, "high");
  assert.deepEqual([carolArrival.payload?.title, carolArrival.payload?.body], ["New message", ""]);
});

test("a host with push off: prefs still answer, every push route is PUSH_OFF, notify sends nothing", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "chat-push-"));
  const store = await openPushStore({ storeDir: dir });
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const service = createPushService({ store, push: null, hooks: { people: async () => people, notifyText: () => ({ title: "t", body: "b" }) } });
  assert.equal(service.publicKey, null);
  const key = await service.handle(new Request("http://app.local/chat/push/key"), alice);
  assert.equal(key?.status, 404);
  assert.equal((await key?.json()).error.code, "PUSH_OFF");
  assert.equal((await service.handle(new Request("http://app.local/chat/prefs"), alice))?.status, 200);
  const out = await service.notify({ message: { id: "m", author: { kind: "agent", name: "r" }, text: "x" }, mentions: ["bob"] });
  assert.deepEqual(out.map((o) => o.results), [[]]);
});

test("the store keeps push's tables beside another owner's in one kit.sqlite", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "chat-push-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const spec = "bun:sqlite";
  const { Database } = await import(spec);
  const db = new Database(path.join(dir, "kit.sqlite"), { create: true });
  db.exec("CREATE TABLE positions (person TEXT, thread TEXT, cursor TEXT); PRAGMA user_version = 7;");
  const s1 = await openPushStore({ db });
  s1.saveSubscription("alice", { endpoint: "https://fcm.googleapis.com/fcm/send/x", p256dh: "k", auth: "a" });
  // a second connection, as the probe's, sees the same rows; reopening migrates nothing twice
  const s2 = await openPushStore({ storeDir: dir });
  assert.equal(s2.subscriptionsOf("alice").length, 1);
  s2.close();
  assert.equal(db.query("PRAGMA user_version").get().user_version, 7, "the other owner's schema version is untouched");
  const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((/** @type {any} */ r) => r.name);
  assert.deepEqual(tables, ["positions", "push_meta", "push_prefs", "push_sent", "push_subscriptions"]);
  db.close();
});

test("push.threadUrl: a same-origin template naming {root} once; a push with no thread opens its path", () => {
  const byDefault = threadUrlFrom(DEFAULT_THREAD_URL);
  assert.equal(byDefault("r1"), "/?thread=r1");
  assert.equal(byDefault(null), "/");
  const hosted = threadUrlFrom("/app/rooms/{root}?from=push");
  assert.equal(hosted("a b/c"), "/app/rooms/a%20b%2Fc?from=push", "the root is encoded into its place");
  assert.equal(hosted(null), "/app/rooms/");
  assert.equal(threadUrlFrom("/app/?thread={root}")(null), "/app/");
  for (const bad of ["https://elsewhere.example/?thread={root}", "//elsewhere.example/{root}", "/\\elsewhere/{root}",
    "/?thread=", "/{root}/{root}", "relative/{root}", "/a b/{root}"]) {
    assert.throws(() => threadUrlFrom(bad), /same-origin path naming \{root\} once/, bad);
  }
});

test("a string threadUrl is what a notification opens", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "chat-push-"));
  const fake = await startFakePushService();
  const store = await openPushStore({ storeDir: dir });
  t.after(async () => {
    store.close();
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  });
  const push = await createPush({ vapidFile: path.join(dir, "vapid.json"), subject: "mailto:ops@example.org", allowEndpoint: fake.allows });
  const service = createPushService({ store, push, threadUrl: "/app/t/{root}",
    hooks: { people: async () => people, notifyText: () => ({ title: "t", body: "b" }) } });
  const sub = await fake.subscribe();
  store.saveSubscription("bob", { endpoint: sub.endpoint, ...sub.keys });
  await service.notify({ message: { id: "m1", thread: "root7", author: { kind: "human", name: "Alice", ref: "alice" }, text: "@bob" }, mentions: ["bob"], participants: [] });
  assert.equal(fake.arrivals.at(-1)?.payload?.url, "/app/t/root7");
  assert.throws(() => createPushService({ store, push, threadUrl: "https://elsewhere.example/{root}",
    hooks: { people: async () => people, notifyText: () => ({ title: "t", body: "b" }) } }), /same-origin/);
});
