// @ts-check
// The kit's server core against a real seat service in a temp root, through two hosts: a minimal
// one (the person named by a header it trusts) and a session-shaped one (a cookie session, a
// same-origin check and an app header on writes, routes of its own, and the kit identifying the
// person through the host's identify hook). Every test runs on both.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AGORA_DIR, startSeat } from "./seat-service.mjs";
import { createChat } from "../server/index.mjs";

const BunRuntime = /** @type {any} */ (globalThis).Bun;
/** Whether this kit carries push (push/store.mjs and its service); without it, push and prefs answer 501. */
const PUSH_BUILT = existsSync(new URL("../push/store.mjs", import.meta.url));
const CLIENT_NAME = "example-app";

/** @type {import("../server/index.mjs").Person[]} */
const PEOPLE = [
  { id: "p-ada", name: "Ada Byron", ref: "ref-ada" },
  { id: "p-grace", name: "Grace Hopper", ref: "ref-grace" },
  { id: "p-lin", name: "Lin" },
];
/** @param {string} id */
const person = (id) => /** @type {import("../server/index.mjs").Person} */ (PEOPLE.find((p) => p.id === id));

/** @type {Map<string, import("../server/index.mjs").Person>} */
const SESSIONS = new Map();

/**
 * @typedef {{
 *   name: string,
 *   identify: (req: Request) => Promise<import("../server/index.mjs").Person | null>,
 *   serve: (chat: import("../server/index.mjs").Chat) => { base: string, stop: () => void },
 *   auth: (id: string) => Record<string, string>,
 * }} Host
 */

/** @type {Host[]} */
const HOSTS = [
  {
    name: "minimal host",
    identify: async () => null,
    serve(chat) {
      const server = BunRuntime.serve({
        port: 0, hostname: "127.0.0.1",
        async fetch(/** @type {Request} */ req) {
          const who = PEOPLE.find((p) => p.id === req.headers.get("x-person")) ?? null;
          return (await chat.handle(req, who)) ?? new Response("the host's own", { status: 404 });
        },
      });
      return { base: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
    },
    auth: (id) => ({ "x-person": id }),
  },
  {
    name: "session host",
    async identify(req) {
      const m = /(?:^|;\s*)t_session=([a-f0-9]{32})/.exec(req.headers.get("cookie") ?? "");
      return m ? SESSIONS.get(m[1]) ?? null : null;
    },
    serve(chat) {
      /** @type {any} */
      let server;
      server = BunRuntime.serve({
        port: 0, hostname: "127.0.0.1",
        async fetch(/** @type {Request} */ req) {
          const url = new URL(req.url);
          if (url.pathname === "/api/health") return Response.json({ ok: true });
          if (req.method !== "GET" && req.method !== "HEAD") {
            const origin = req.headers.get("origin");
            if (req.headers.get("x-test-app") !== "1" || (origin && origin !== url.origin)) return Response.json({ ok: false, error: { code: "CROSS_SITE" } }, { status: 403 });
          }
          return (await chat.handle(req, null)) ?? new Response("the host's own", { status: 404 });
        },
      });
      return { base: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
    },
    auth(id) {
      const token = randomBytes(16).toString("hex");
      SESSIONS.set(token, person(id));
      return { cookie: `t_session=${token}`, "x-test-app": "1" };
    },
  },
];

/**
 * @param {import("node:test").TestContext} t @param {Host} host
 * @param {{ refuse?: RegExp, warn?: RegExp, deny?: Set<string>, presence?: () => Promise<any>, push?: import("../server/index.mjs").ChatOptions["push"] }} [knobs]
 */
async function setup(t, host, knobs = {}) {
  const seat = await startSeat(t);
  const kitDir = await mkdtemp(path.join(tmpdir(), "agora-chat-kit-"));
  /** @type {string[]} */
  const logs = [];
  /** @type {import("../server/index.mjs").ChatHooks} */
  const hooks = {
    identify: host.identify,
    authorize: (p, act) => !(knobs.deny?.has(`${p.id}:${act}`)),
    people: async () => PEOPLE,
    scanText: (text) => (knobs.refuse?.test(text) ? { refuse: "secret-shaped" } : knobs.warn?.test(text) ? { warn: "looks like an address" } : {}),
    scanUpload: async () => ({ ok: true }),
    notifyText: () => ({ title: "", body: "" }),
    presence: knobs.presence ?? (async () => ({ state: "ready" })),
    residentName: "the resident",
  };
  /** @type {import("../server/index.mjs").ChatOptions} */
  const chatOptions = {
    agoraDir: AGORA_DIR, agoraState: seat.state, agoraConfig: seat.config, room: seat.alias, clientName: CLIENT_NAME,
    storeDir: kitDir, hooks, push: knobs.push ?? null, log: (line) => logs.push(line),
    tuning: { keepAliveMs: 1000, presenceMs: 200, restartMs: 500, peopleMs: 0 },
  };
  let chat = await createChat(chatOptions);
  let served = host.serve(chat);
  const { connect } = await import(pathToFileURL(path.join(AGORA_DIR, "src", "client.mjs")).href);
  const agent = await connect({ state: seat.state, config: seat.config, clientName: "other-app" });
  t.after(async () => {
    agent.close();
    served.stop();
    await chat.close();
    await rm(kitDir, { recursive: true, force: true });
  });
  /** @param {string} id @param {string} p @param {RequestInit & { json?: unknown }} [init] */
  const call = async (id, p, init = {}) => {
    const { json: body, ...rest } = init;
    const headers = { ...(id ? host.auth(id) : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(/** @type {any} */ (rest.headers) ?? {}) };
    const res = await fetch(`${served.base}${p}`, { ...rest, headers, ...(body !== undefined ? { body: JSON.stringify(body), method: rest.method ?? "POST" } : {}) });
    const text = await res.text();
    /** @type {any} */
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: res.status, body: parsed, headers: res.headers };
  };
  /** @param {string} text @param {{ thread?: string, trailers?: Array<[string, string]> }} [o] */
  const agentSays = (text, o = {}) => agent.append(seat.alias, { text, author: { kind: "agent", name: "Resident/watch" }, ...o });
  return {
    seat, hooks, logs, agent, agentSays, call, kitDir,
    get base() { return served.base; },
    get chat() { return chat; },
    /** the host goes away: the kit closes */
    async down() {
      served.stop();
      await chat.close();
    },
    /** the host comes back on the same store */
    async up() {
      chat = await createChat(chatOptions);
      served = host.serve(chat);
    },
    /** @param {string} id @param {string} query @param {Record<string, string>} [extra] */
    stream: (id, query, extra = {}) => openStream(`${served.base}/chat/stream?${query}`, { ...host.auth(id), ...extra }),
  };
}

/**
 * @typedef {{ event: string, id?: string, data: any }} SseEvent
 */

/** @param {string} url @param {Record<string, string>} headers */
async function openStream(url, headers) {
  const ac = new AbortController();
  const res = await fetch(url, { headers, signal: ac.signal });
  assert.equal(res.status, 200, `the stream opened: ${res.status}`);
  assert.match(res.headers.get("content-type") ?? "", /^text\/event-stream/);
  /** @type {SseEvent[]} */
  const events = [];
  let ended = false;
  /** @type {string | undefined} */
  let lastId;
  const reader = /** @type {ReadableStream<Uint8Array>} */ (res.body).getReader();
  const decoder = new TextDecoder();
  void (async () => {
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let at;
        while ((at = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, at);
          buf = buf.slice(at + 2);
          /** @type {Partial<SseEvent>} */
          const ev = {};
          for (const line of block.split("\n")) {
            if (line.startsWith("event: ")) ev.event = line.slice(7);
            else if (line.startsWith("data: ")) ev.data = JSON.parse(line.slice(6));
            else if (line.startsWith("id: ")) ev.id = line.slice(4);
          }
          if (ev.id) lastId = ev.id;
          if (ev.event) events.push(/** @type {SseEvent} */ (ev));
        }
      }
    } catch { /* aborted */ }
    ended = true;
  })();
  return {
    events,
    get ended() { return ended; },
    get lastId() { return lastId; },
    /** @param {string} event */
    of: (event) => events.filter((e) => e.event === event),
    /** @param {() => unknown} pred @param {string} what @param {number} [ms] */
    async until(pred, what, ms = 15_000) {
      const end = Date.now() + ms;
      for (;;) {
        const got = pred();
        if (got) return got;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}; events: ${JSON.stringify(events.map((e) => [e.event, e.data?.text ?? e.data?.state ?? e.data?.act]))}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    },
    close: () => ac.abort(),
  };
}

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Probe until `ok` holds or the deadline passes, and return the last value probed, so the assertion
 * after it names what was seen. What the kit indexes from the room arrives through its follow, so a
 * fixed wait for it reads as a failure on a loaded machine.
 * @template T @param {() => Promise<T>} probe @param {(value: T) => boolean} ok @param {number} [ms]
 */
async function eventually(probe, ok, ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (ok(value) || Date.now() > end) return value;
    await sleep(25);
  }
}

/** @param {{ events: SseEvent[] }} s */
function noDuplicates(s) {
  const cursors = s.events.filter((e) => e.event === "message" || e.event === "annotation").map((e) => e.id);
  assert.equal(new Set(cursors).size, cursors.length, `a record was delivered twice: ${cursors.join(" ")}`);
}

const SLOW = { timeout: 90_000 };

for (const host of HOSTS) {
  test(`${host.name}: a post lands under the person's name, with via and author.ref, once`, SLOW, async (t) => {
    const k = await setup(t, host, { refuse: /sk-live-/, warn: /\b10\.0\.0\.\d+\b/ });
    const op = randomUUID().replaceAll("-", "");
    const first = await k.call("p-ada", "/chat/post", { json: { text: "hello from the browser", operationId: op } });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.ok, true);
    const receipt = first.body.data.receipt;
    assert.match(receipt.id, /^[a-f0-9]{64}$/);
    assert.equal(receipt.operationId, op);
    assert.equal(receipt.duplicate, false);
    // a resend of the same draft answers with the same receipt and posts nothing new
    const again = await k.call("p-ada", "/chat/post", { json: { text: "hello from the browser", operationId: op } });
    assert.equal(again.status, 200);
    assert.equal(again.body.data.receipt.id, receipt.id);
    assert.equal(again.body.data.receipt.duplicate, true);
    // another person's draft under the same id is their own post, never an answer for Ada's
    const other = await k.call("p-grace", "/chat/post", { json: { text: "hello from the browser", operationId: op } });
    assert.equal(other.status, 200);
    assert.notEqual(other.body.data.receipt.id, receipt.id);
    // a person with no ref is stamped with their id
    const lin = await k.call("p-lin", "/chat/post", { json: { text: "no ref here" } });
    assert.equal(lin.status, 200);

    const { messages } = await k.agent.read(k.seat.alias);
    assert.equal(messages.length, 3);
    const [ada, grace, linMsg] = messages;
    assert.equal(ada.text, "hello from the browser");
    assert.equal(ada.via, CLIENT_NAME);
    assert.deepEqual({ name: ada.author.name, kind: ada.author.kind, ref: ada.author.ref }, { name: "Ada Byron", kind: "human", ref: "ref-ada" });
    assert.equal(ada.signedAs, undefined, "no signature line");
    assert.equal(grace.author.ref, "ref-grace");
    assert.equal(linMsg.author.ref, "p-lin");

    // a reply, and "also send to the room" as two appends
    const reply = await k.call("p-grace", "/chat/post", { json: { text: "a reply, and to the room", thread: receipt.id, alsoToRoom: true, trailers: [["context", "item=alpha"]] } });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.body.data.receipt.thread, receipt.id);
    assert.match(reply.body.data.alsoToRoom.id, /^[a-f0-9]{64}$/);
    const after = await k.agent.read(k.seat.alias);
    const copies = after.messages.filter((/** @type {any} */ m) => m.text.startsWith("a reply, and to the room"));
    assert.equal(copies.length, 2);
    assert.equal(copies[0].thread, receipt.id);
    assert.equal(copies[1].thread, undefined);
    // agora writes the trailer block in its own key order
    assert.deepEqual([...copies[1].trailers].sort((/** @type {any} */ x, /** @type {any} */ y) => x.key.localeCompare(y.key)), [{ key: "context", value: "item=alpha" }, { key: "re", value: receipt.id }]);

    // the host's scan: a refusal posts nothing; a warning posts and says so
    const refused = await k.call("p-ada", "/chat/post", { json: { text: "my key is sk-live-abc" } });
    assert.equal(refused.status, 422);
    assert.equal(refused.body.error.code, "TEXT_REFUSED");
    assert.equal(refused.body.error.reason, "secret-shaped");
    const warned = await k.call("p-ada", "/chat/post", { json: { text: "try 10.0.0.7" } });
    assert.equal(warned.status, 200);
    assert.equal(warned.body.data.warn, "looks like an address");
    assert.equal((await k.agent.read(k.seat.alias)).messages.filter((/** @type {any} */ m) => m.text.includes("sk-live-")).length, 0);

    // the room's own refusal is 409 with its code
    const bogus = await k.call("p-ada", "/chat/post", { json: { text: "a file that was never uploaded", attachments: [{ id: "x".repeat(10), digest: "sha256:00" }] } });
    assert.equal(bogus.status, 409, JSON.stringify(bogus.body));
    assert.equal(bogus.body.error.code, "ROOM_REFUSED");
    assert.equal(typeof bogus.body.error.refusal, "string");

    // shape errors and nobody
    assert.equal((await k.call("p-ada", "/chat/post", { json: { text: "" } })).status, 400);
    assert.equal((await k.call("p-ada", "/chat/post", { json: { text: "x", thread: "main" } })).status, 400);
    assert.equal((await k.call("p-ada", "/chat/post", { json: { text: "x", alsoToRoom: true } })).status, 400);
    assert.equal((await k.call("", "/chat/post", { json: { text: "x" } })).status, host.name === "session host" ? 403 : 401);
  });

  test(`${host.name}: authorize and the routes this core does not answer`, SLOW, async (t) => {
    const k = await setup(t, host, { deny: new Set(["p-grace:post", "p-lin:read"]) });
    assert.equal((await k.call("p-grace", "/chat/post", { json: { text: "not allowed" } })).status, 403);
    assert.equal((await k.call("p-lin", "/chat/threads")).status, 403);
    assert.equal((await k.call("p-lin", "/chat/stream?thread=main")).status, 403);
    // the extension's routes are built (server-ext tests them); a bare request is a shape error, not 501
    for (const [method, p, status] of /** @type {const} */ ([["POST", "/chat/upload", 400], ["GET", "/chat/file/abc", 400], ["GET", "/chat/thumb/abc", 400],
      ["POST", "/chat/annotate", 400], ["POST", "/chat/react", 400], ["POST", "/chat/purge", 400], ["POST", "/chat/scan", 400], ["GET", "/chat/search?q=x", 200]])) {
      const r = await k.call("p-ada", p, { method });
      assert.equal(r.status, status, `${method} ${p}: ${JSON.stringify(r.body)}`);
    }
    assert.equal((await k.call("p-ada", "/chat/nothing-here")).status, 404);
    assert.equal((await k.call("p-ada", "/chat/post")).status, 405);
    // outside /chat/ is the host's
    const own = await k.call("p-ada", "/api/health");
    assert.equal(own.status, host.name === "session host" ? 200 : 404);
    assert.equal(await k.chat.handle(new Request("http://localhost/chatter"), person("p-ada")), null);

    const state = await k.call("p-ada", "/chat/state");
    assert.equal(state.status, 200);
    assert.deepEqual(state.body.data.me, { id: "p-ada", name: "Ada Byron", ref: "ref-ada" });
    assert.deepEqual(state.body.data.resident, { name: "the resident", state: "ready" });
    assert.equal(state.body.data.room, k.seat.alias);
    assert.equal(state.body.data.version, "1.0.0");
    assert.ok(state.body.data.capabilities.includes("threads-v1"));

    // prefs and push are push's routes, reached through the kit's mount and its session
    if (!PUSH_BUILT) {
      assert.equal((await k.call("p-ada", "/chat/prefs")).status, 501);
      assert.equal((await k.call("p-ada", "/chat/push/key")).status, 501);
      return;
    }
    const prefs = await k.call("p-ada", "/chat/prefs");
    assert.deepEqual(prefs.body.data, { notify: { mentions: true, asks: true, mine: true, all: false }, lockScreen: "title-line" });
    const put = await k.call("p-ada", "/chat/prefs", { method: "PUT", json: { notify: { mentions: true, asks: true, mine: true, all: true }, lockScreen: "generic" } });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.deepEqual((await k.call("p-ada", "/chat/prefs")).body.data, { notify: { mentions: true, asks: true, mine: true, all: true }, lockScreen: "generic" });
    assert.equal((await k.call("p-grace", "/chat/prefs")).body.data.notify.all, false);
    // a host that gave no push options: the push routes say so
    assert.equal((await k.call("p-ada", "/chat/push/key")).status, 404);
  });

  test(`${host.name}: a stream gives history then live, once each, on main and on a thread`, SLOW, async (t) => {
    const k = await setup(t, host);
    const root = await k.agentSays("a root before anyone opened");
    await k.agentSays("a reply before anyone opened", { thread: root.id });
    await k.agentSays("another top-level line");
    const main = await k.stream("p-ada", "thread=main");
    const thread = await k.stream("p-ada", `thread=${root.id}`);
    t.after(() => { main.close(); thread.close(); });
    await main.until(() => main.of("state").some((e) => e.data.state === "live"), "main live");
    await thread.until(() => thread.of("state").some((e) => e.data.state === "live"), "thread live");
    assert.deepEqual(main.of("message").map((e) => e.data.text), ["a root before anyone opened", "a reply before anyone opened", "another top-level line"]);
    assert.deepEqual(thread.of("message").map((e) => e.data.text), ["a root before anyone opened", "a reply before anyone opened"]);
    assert.ok(main.of("presence").length >= 1, "presence on open");
    assert.equal(main.of("message")[0].data.author.id, undefined, "the seat account's id stays on the server");
    const live = main.of("state").find((e) => e.data.state === "live");
    assert.ok(live?.data.through && live.id === live.data.through);

    // live: one from the kit in the thread, one from another app at the top level
    const posted = await k.call("p-ada", "/chat/post", { json: { text: "live in the thread", thread: root.id } });
    assert.equal(posted.status, 200);
    await k.agentSays("live at the top");
    await main.until(() => main.of("message").length === 5, "two live messages on main");
    await thread.until(() => thread.of("message").length === 3, "one live message on the thread");
    await sleep(300);
    assert.deepEqual(thread.of("message").map((e) => e.data.text).slice(2), ["live in the thread"]);
    const mine = thread.of("message")[2].data;
    assert.equal(mine.via, CLIENT_NAME);
    assert.equal(mine.author.ref, "ref-ada");

    // an annotation reaches both, with its target folded
    const edit = await k.agent.annotate(k.seat.alias, { act: "edit", target: root.id, text: "a root, edited", author: { kind: "agent", name: "Resident/watch" } });
    assert.match(edit.id, /^[a-f0-9]{64}$/);
    await thread.until(() => thread.of("annotation").length === 1, "the edit on the thread");
    await main.until(() => main.of("annotation").length === 1, "the edit on main");
    const a = thread.of("annotation")[0].data;
    assert.equal(a.act, "edit");
    assert.equal(a.message.text, "a root, edited");
    assert.ok(a.message.edited);
    noDuplicates(main);
    noDuplicates(thread);

    // a stream opened now sees the root folded in its history
    const late = await k.stream("p-grace", `thread=${root.id}`);
    t.after(() => late.close());
    await late.until(() => late.of("state").some((e) => e.data.state === "live"), "late live");
    assert.equal(late.of("message")[0].data.text, "a root, edited");
    assert.equal(late.of("annotation").length, 0, "an annotation folded into the history is not sent again");

    // a reconnect with Last-Event-ID resumes after it: nothing twice, nothing lost
    const resumeFrom = /** @type {string} */ (main.lastId);
    main.close();
    await k.agentSays("while main was away");
    const back = await k.stream("p-ada", "thread=main", { "last-event-id": resumeFrom });
    t.after(() => back.close());
    await back.until(() => back.of("state").some((e) => e.data.state === "live"), "resumed live");
    assert.deepEqual(back.of("message").map((e) => e.data.text), ["while main was away"]);
  });

  test(`${host.name}: across a seat-service restart the stream says dark, then live, and drops nothing and repeats nothing`, SLOW, async (t) => {
    const k = await setup(t, host);
    await k.agentSays("before the restart");
    const main = await k.stream("p-ada", "thread=main");
    t.after(() => main.close());
    await main.until(() => main.of("state").some((e) => e.data.state === "live"), "live");
    await k.seat.agora(["service", "stop"]);
    await main.until(() => main.of("state").some((e) => e.data.state === "dark"), "dark");
    // dark is reported on the other routes too, and nothing is posted
    const dark = await k.call("p-ada", "/chat/post", { json: { text: "into the dark" } });
    assert.equal(dark.status, 503, JSON.stringify(dark.body));
    assert.equal(dark.body.error.code, "ROOM_DARK");
    assert.equal((await k.call("p-ada", "/chat/thread/main")).status, 503);
    await k.seat.agora(["service", "start"]);
    // the kit can be live again before the start command returns, so look for a live after the last dark
    const states = () => main.of("state").map((e) => e.data.state);
    await main.until(() => states().lastIndexOf("live") > states().lastIndexOf("dark"), "live again", 30_000);
    await k.agentSays("after the restart");
    const posted = await k.call("p-ada", "/chat/post", { json: { text: "the kit posts again" } });
    assert.equal(posted.status, 200, JSON.stringify(posted.body));
    await main.until(() => main.of("message").length === 3, "both after the restart");
    await sleep(300);
    assert.deepEqual(main.of("message").map((e) => e.data.text), ["before the restart", "after the restart", "the kit posts again"]);
    noDuplicates(main);
  });

  test(`${host.name}: refused is reported, on a stream and on a read`, SLOW, async (t) => {
    const k = await setup(t, host);
    await k.agentSays("something so the room is not empty");
    const ghost = "ab".repeat(32);
    const s = await k.stream("p-ada", `thread=${ghost}`);
    t.after(() => s.close());
    await s.until(() => s.of("state").some((e) => e.data.state === "refused"), "refused");
    assert.equal(s.of("state").find((e) => e.data.state === "refused")?.data.reason, "thread-root-unknown");
    const read = await k.call("p-ada", `/chat/thread/${ghost}`);
    assert.equal(read.status, 404);
    assert.equal(read.body.error.refusal, "thread-root-unknown");
    assert.equal((await k.call("p-ada", "/chat/stream?thread=nope")).status, 400);
  });

  test(`${host.name}: the thread list: activity order, mine, context, unread by position, waiting until answered, cards`, SLOW, async (t) => {
    const k = await setup(t, host);
    const a = await k.call("p-ada", "/chat/post", { json: { text: "first thread", trailers: [["context", "item=alpha; screen=detail"], ["card", "plan P-1"]] } });
    const b = await k.agentSays("second thread, for @Grace Hopper", { trailers: [["waiting", "p-grace"]] });
    const c = await k.agentSays("third thread, nobody's");
    const rootA = a.body.data.receipt.id;
    await k.agentSays("a reply that moves the first thread up", { thread: rootA, trailers: [["card", "plan P-2"]] });

    // the agent's posts reach the kit through its follow: wait until the reply has moved the first thread up
    const all = await eventually(() => k.call("p-ada", "/chat/threads"),
      (r) => r.status === 200 && r.body.data.threads[0]?.root.id === rootA && r.body.data.threads.length === 3);
    assert.equal(all.status, 200, JSON.stringify(all.body));
    const list = all.body.data.threads;
    assert.deepEqual(list.map((/** @type {any} */ x) => x.root.id), [rootA, c.id, b.id]);
    assert.equal(list[0].root.text.startsWith("first thread"), true);
    assert.equal(list[0].lastBy.name, "Resident/watch");
    assert.equal(list[0].last.text, "a reply that moves the first thread up\n\ncard: plan P-2");
    assert.equal(list[2].last.id, b.id, "a thread with no reply: its last is its root");
    assert.deepEqual(list[0].cards, [{ type: "plan", id: "P-1" }, { type: "plan", id: "P-2" }]);
    assert.deepEqual(list[2].waiting, ["p-grace"]);
    assert.equal(list[0].unread, true);

    // mine: Ada posted in the first; Grace is mentioned and waited on in the second
    const adaMine = await k.call("p-ada", "/chat/threads?scope=mine");
    assert.deepEqual(adaMine.body.data.threads.map((/** @type {any} */ x) => x.root.id), [rootA]);
    const graceMine = await k.call("p-grace", "/chat/threads?scope=mine");
    assert.deepEqual(graceMine.body.data.threads.map((/** @type {any} */ x) => x.root.id), [b.id]);
    const ctx = await k.call("p-grace", "/chat/threads?context=item%3Dalpha");
    assert.deepEqual(ctx.body.data.threads.map((/** @type {any} */ x) => x.root.id), [rootA]);
    assert.deepEqual((await k.call("p-grace", "/chat/threads?context=item%3Dbeta")).body.data.threads, []);
    assert.equal((await k.call("p-grace", "/chat/threads?context=nonsense")).status, 400);

    // paging by the last cursor
    const page = await k.call("p-ada", "/chat/threads?limit=1");
    assert.equal(page.body.data.threads.length, 1);
    const next = await k.call("p-ada", `/chat/threads?limit=2&before=${encodeURIComponent(page.body.data.threads[0].lastCursor)}`);
    assert.deepEqual(next.body.data.threads.map((/** @type {any} */ x) => x.root.id), [c.id, b.id]);

    // a position read to the end makes the thread read; a new reply makes it unread again
    const pos = await k.call("p-ada", "/chat/position", { json: { thread: rootA, cursor: list[0].lastCursor } });
    assert.equal(pos.status, 200);
    assert.equal((await k.call("p-ada", "/chat/threads")).body.data.threads[0].unread, false);
    // a position never moves back
    await k.call("p-ada", "/chat/position", { json: { thread: rootA, cursor: a.body.data.receipt.cursor } });
    assert.equal((await k.call("p-ada", "/chat/threads")).body.data.threads[0].unread, false);
    await k.agentSays("another reply", { thread: rootA });
    assert.equal((await eventually(() => k.call("p-ada", "/chat/threads"), (r) => r.body.data.threads[0].unread === true)).body.data.threads[0].unread, true);
    assert.equal((await k.call("p-ada", "/chat/position", { json: { thread: rootA, cursor: "nope" } })).status, 400);

    // the waiting stands until Grace posts in that thread
    const answer = await k.call("p-grace", "/chat/post", { json: { text: "here I am", thread: b.id } });
    assert.equal(answer.status, 200);
    const after = (await eventually(() => k.call("p-grace", "/chat/threads"),
      (r) => r.body.data.threads.find((/** @type {any} */ x) => x.root.id === b.id)?.waiting.length === 0)).body.data.threads;
    const second = after.find((/** @type {any} */ x) => x.root.id === b.id);
    assert.deepEqual(second.waiting, []);
    assert.equal(second.unread, false, "the last word is Grace's own");
    assert.equal(after[0].root.id, b.id, "Grace's reply moved it up");
  });

  test(`${host.name}: the index catches up across a host restart, and only news is emitted`, SLOW, async (t) => {
    const k = await setup(t, host);
    /** @type {Array<{ value: any, meta: any }>} */
    const heard = [];
    k.chat.on("message", (value, meta) => heard.push({ value, meta }));
    await k.call("p-ada", "/chat/post", { json: { text: "heard live, for @Lin" } });
    await k.agentSays("also heard", { trailers: [["waiting", "ref-grace"]] });
    await eventually(async () => heard.length, (n) => n >= 2);
    assert.deepEqual(heard.map((h) => h.value.text), ["heard live, for @Lin", "also heard\n\nwaiting: ref-grace"]);
    assert.deepEqual(heard[0].meta.mentions, ["p-lin"]);
    assert.deepEqual(heard[1].meta.waiting, ["p-grace"]);
    assert.equal(heard[0].value.author.id, undefined);

    // the host goes away; the room goes on
    await k.down();
    await k.agentSays("said while the host was down");
    await k.up();
    /** @type {string[]} */
    const heardAfter = [];
    k.chat.on("message", (value) => heardAfter.push(value.text));
    const main = await k.stream("p-ada", "thread=main");
    t.after(() => main.close());
    await main.until(() => main.of("state").some((e) => e.data.state === "live"), "live after the reopen");
    const threads = (await k.call("p-ada", "/chat/threads")).body.data.threads;
    assert.deepEqual(threads.map((/** @type {any} */ x) => x.root.text), ["said while the host was down", "also heard\n\nwaiting: ref-grace", "heard live, for @Lin"]);
    await k.agentSays("news after the reopen");
    await main.until(() => main.of("message").length === 4, "the news");
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(heardAfter, ["news after the reopen"], "the catch-up is indexed, not emitted");
  });
}

for (const host of HOSTS) {
  test(`${host.name}: a new message reaches push's policy with its mentions and the thread's participants`, { ...SLOW, skip: !PUSH_BUILT }, async (t) => {
    const { startFakePushService } = await import(new URL("../push/fake-service.mjs", import.meta.url).href);
    const fake = await startFakePushService();
    t.after(() => fake.close());
    const vapidDir = await mkdtemp(path.join(tmpdir(), "agora-chat-vapid-"));
    t.after(() => rm(vapidDir, { recursive: true, force: true }));
    const k = await setup(t, host, { push: { vapidFile: path.join(vapidDir, "vapid.json"), subject: "mailto:ops@example.org", allowEndpoint: fake.allows } });
    const key = await k.call("p-grace", "/chat/push/key");
    assert.equal(key.status, 200, JSON.stringify(key.body));
    const sub = await fake.subscribe();
    assert.equal((await k.call("p-grace", "/chat/push/subscribe", { json: sub })).status, 200);
    const linSub = await fake.subscribe();
    assert.equal((await k.call("p-lin", "/chat/push/subscribe", { json: linSub })).status, 200);

    // a mention reaches Grace and nobody else
    await k.agentSays("@Grace Hopper, a question for you");
    const deadline = Date.now() + 15_000;
    while (!fake.arrivals.length && Date.now() < deadline) await sleep(50);
    assert.equal(fake.arrivals.length, 1);
    assert.equal(fake.arrivals[0].subscriptionId, sub.endpoint.split("/").pop());
    assert.equal(fake.arrivals[0].payload?.kind, "message");

    // a reply in a thread Lin posted in reaches Lin as a participant
    const lin = await k.call("p-lin", "/chat/post", { json: { text: "a thread of Lin's" } });
    assert.equal(lin.status, 200);
    await k.agentSays("an answer in Lin's thread", { thread: lin.body.data.receipt.id });
    const later = Date.now() + 15_000;
    while (!fake.arrivals.some((/** @type {any} */ a) => a.subscriptionId === linSub.endpoint.split("/").pop()) && Date.now() < later) await sleep(50);
    assert.ok(fake.arrivals.some((/** @type {any} */ a) => a.subscriptionId === linSub.endpoint.split("/").pop()), "Lin heard the reply in a thread they are in");
  });
}
