// @ts-check
// The client half's writing: the outbox (a post that could not be delivered is kept and resent under
// the same operation id, so the room holds it once), the text scan before send, mentions, the upload
// plan and request, and the search sheet's marking. The pure parts run here; the browser parts are
// exercised by chat/dev/probe-compose.mjs on the dev page.
import test from "node:test";
import assert from "node:assert/strict";

const { createOutbox, mentionAt, matchPeople, insertMention, scanText, newOperationId, draftKey, isMine, reactionsOf, purgedOf, DEFAULT_REACTIONS } = await import("../client/composer.js");
const { fitWithin, reencodePlan, encodedName, uploadFile, UploadError } = await import("../client/upload.js");
const { markRuns, queryTerms, rootOf, coverageWords } = await import("../client/search.js");

// ---- stand-ins: a Storage, and a room that de-duplicates by operation id ----

class MemoryStorage {
  constructor() { /** @type {Map<string, string>} */ this.m = new Map(); }
  get length() { return this.m.size; }
  /** @param {number} i */ key(i) { return [...this.m.keys()][i] ?? null; }
  /** @param {string} k */ getItem(k) { return this.m.has(k) ? /** @type {string} */ (this.m.get(k)) : null; }
  /** @param {string} k @param {string} v */ setItem(k, v) { this.m.set(k, String(v)); }
  /** @param {string} k */ removeItem(k) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

/** A room behind the post route: `online` false means the request never arrives. */
function fakeRoom() {
  const room = {
    online: true,
    /** @type {Map<string, { id: string, text: string }>} */
    byOp: new Map(),
    /** @type {any[]} every request that reached the route */
    arrived: [],
    /** @type {Array<"lose" | "dark" | "refuse">} what the next arrivals meet, in order */
    next: [],
    /** @param {Record<string, any>} body @returns {Promise<{ status: number, body: any } | null>} */
    async send(body) {
      await new Promise((r) => setTimeout(r, 2));
      if (!room.online) return null;
      room.arrived.push(body);
      const fate = room.next.shift();
      if (fate === "dark") return { status: 503, body: { ok: false, error: { code: "ROOM_DARK" } } };
      if (fate === "refuse") return { status: 422, body: { ok: false, error: { code: "TEXT_REFUSED", reason: "a private key" } } };
      let m = room.byOp.get(body.operationId);
      const duplicate = !!m;
      if (!m) { m = { id: `m-${room.byOp.size + 1}`, text: body.text }; room.byOp.set(body.operationId, m); }
      if (fate === "lose") return { status: 202, body: { ok: false, error: { code: "ACCEPTANCE_UNKNOWN", operationId: body.operationId } } };
      return { status: 200, body: { ok: true, data: { receipt: { id: m.id, duplicate, operationId: body.operationId } } } };
    },
    /** how many messages the room holds with these words */
    /** @param {string} text */
    holds: (text) => [...room.byOp.values()].filter((m) => m.text === text).length,
  };
  return room;
}

const noTimers = { schedule: () => 0, cancel: () => {} };

// ---- the outbox ----

test("an offline post is kept, and delivered once when the browser is back online", async () => {
  const room = fakeRoom();
  const storage = new MemoryStorage();
  const box = createOutbox({ send: room.send, storage, key: "ob", ...noTimers });
  room.online = false;
  const after = await box.add({ text: "back in the north house", thread: "root-1" });
  assert.equal(after?.state, "queued");
  assert.equal(after?.reason, "offline");
  assert.equal(room.arrived.length, 0, "nothing reached the room");
  assert.equal(JSON.parse(storage.getItem("ob") ?? "[]").length, 1, "the post is kept in storage while it waits");

  room.online = true;
  // the online event, a timer and a hand on "try now" can all fire together: one attempt in flight
  await Promise.all([box.flush(), box.flush(), box.flush()]);
  assert.equal(room.holds("back in the north house"), 1);
  assert.equal(room.arrived.length, 1, "one attempt reached the room");
  assert.equal(box.items().length, 0);
  assert.equal(storage.getItem("ob"), null, "the outbox is empty once the room answered");
  await box.flush();
  assert.equal(room.arrived.length, 1, "a later flush sends nothing again");
});

test("a reload while offline keeps the post; the next page delivers it once", async () => {
  const room = fakeRoom();
  const storage = new MemoryStorage();
  room.online = false;
  const first = createOutbox({ send: room.send, storage, key: "ob", ...noTimers });
  await first.add({ text: "kept across a reload", thread: null });
  first.close();
  room.online = true;
  const second = createOutbox({ send: room.send, storage, key: "ob", ...noTimers });
  assert.equal(second.items().length, 1);
  await second.flush();
  await second.flush();
  assert.equal(room.holds("kept across a reload"), 1);
  assert.equal(room.arrived.length, 1);
});

test("acceptance unknown (202) is resent under the same operation id, and the room holds it once", async () => {
  const room = fakeRoom();
  room.next.push("lose");
  const box = createOutbox({ send: room.send, storage: new MemoryStorage(), ...noTimers });
  const after = await box.add({ text: "lost answer", thread: "r", operationId: "op-lost-answer-1" });
  assert.equal(after?.state, "unknown");
  await box.flush();
  assert.equal(room.arrived.length, 2);
  assert.deepEqual(room.arrived.map((b) => b.operationId), ["op-lost-answer-1", "op-lost-answer-1"]);
  assert.equal(room.holds("lost answer"), 1);
  assert.equal(box.items().length, 0);
});

test("a page that closed mid-send resends under the same id when it opens again", async () => {
  const room = fakeRoom();
  const storage = new MemoryStorage();
  // the room took it, but the page closed before the answer came back
  await room.send({ text: "mid-send", operationId: "op-mid-send-01" });
  storage.setItem("ob", JSON.stringify([{ operationId: "op-mid-send-01", thread: null, text: "mid-send", state: "sending", tries: 1, at: "2026-10-10T00:00:00Z" }]));
  const box = createOutbox({ send: room.send, storage, key: "ob", ...noTimers });
  assert.equal(box.items()[0].state, "unknown");
  await box.flush();
  assert.equal(room.holds("mid-send"), 1);
  assert.equal(box.items().length, 0);
});

test("a dark room keeps the post queued; a refusal hands it back and is never resent", async () => {
  const room = fakeRoom();
  room.next.push("dark", "refuse");
  const box = createOutbox({ send: room.send, storage: new MemoryStorage(), ...noTimers });
  const a = await box.add({ text: "while dark", thread: null });
  assert.equal(a?.state, "queued");
  assert.match(String(a?.reason), /dark/);
  const b = await box.add({ text: "-----BEGIN KEY", thread: null });
  assert.equal(b?.state, "refused");
  assert.equal(b?.reason, "a private key");
  await box.flush();
  assert.equal(room.holds("while dark"), 1);
  assert.equal(room.arrived.filter((x) => x.text === "-----BEGIN KEY").length, 1, "a refused post is not retried");
  assert.deepEqual(box.items().map((i) => i.state), ["refused"]);
  box.discard(/** @type {string} */ (b?.operationId));
  assert.equal(box.items().length, 0);
});

test("the body sent carries the thread, trailers, attachments and also-to-room as given", async () => {
  const room = fakeRoom();
  const box = createOutbox({ send: room.send, storage: null, ...noTimers });
  await box.add({ text: "x", thread: "root-9", trailers: [["context", "zone=north"]], attachments: [{ id: "a1", digest: "sha256:00" }], alsoToRoom: true });
  await box.add({ text: "y", thread: null, alsoToRoom: true });
  assert.deepEqual(room.arrived[0].trailers, [["context", "zone=north"]]);
  assert.equal(room.arrived[0].thread, "root-9");
  assert.equal(room.arrived[0].alsoToRoom, true);
  assert.equal(room.arrived[0].attachments.length, 1);
  assert.equal("alsoToRoom" in room.arrived[1], false, "also-to-room is for a reply only");
  assert.match(room.arrived[0].operationId, /^[A-Za-z0-9_-]{8,128}$/);
  assert.match(newOperationId(), /^[A-Za-z0-9_-]{8,128}$/);
});

test("a retry is scheduled while a post waits, and none once it has gone", async () => {
  const room = fakeRoom();
  /** @type {Array<() => void>} */
  const timers = [];
  const box = createOutbox({ send: room.send, storage: null, schedule: (fn) => { timers.push(fn); return timers.length; }, cancel: () => {} });
  room.online = false;
  await box.add({ text: "timed", thread: null });
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(timers.length >= 1, "a retry was armed");
  room.online = true;
  timers[timers.length - 1]();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(room.holds("timed"), 1);
  assert.equal(box.items().length, 0);
});

// ---- the scan before send ----

/** @param {(path: string, init: any) => { status: number, body: any } | "offline"} answer */
const fakeFetch = (answer) => /** @type {typeof fetch} */ (/** @type {unknown} */ (async (/** @type {string} */ url, /** @type {any} */ init) => {
  const a = answer(url, init);
  if (a === "offline") throw new TypeError("Failed to fetch");
  return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
}));

test("the scan: a warning, a refusal, a pass, and unchecked when it cannot be reached", async () => {
  /** @type {any[]} */
  const seen = [];
  const f = fakeFetch((url, init) => {
    seen.push([url, JSON.parse(init.body)]);
    const { text } = JSON.parse(init.body);
    if (text.includes("KEY")) return { status: 422, body: { ok: false, error: { code: "TEXT_REFUSED", reason: "a private key" } } };
    if (text.includes("password")) return { status: 200, body: { ok: true, data: { warn: "looks like a password" } } };
    return { status: 200, body: { ok: true, data: {} } };
  });
  assert.deepEqual(await scanText({ base: "/kit", fetch: f }, "password: x"), { warn: "looks like a password" });
  assert.deepEqual(await scanText({ base: "/kit", fetch: f }, "BEGIN KEY"), { refuse: "a private key" });
  assert.deepEqual(await scanText({ base: "/kit", fetch: f }, "fine words"), {});
  assert.equal(seen[0][0], "/kit/scan");
  assert.deepEqual(await scanText({ fetch: fakeFetch(() => "offline") }, "x"), { unchecked: true });
  assert.deepEqual(await scanText({ fetch: fakeFetch(() => ({ status: 404, body: { ok: false, error: { code: "NOT_FOUND" } } })) }, "x"), { unchecked: true });
});

// ---- mentions ----

test("mentions: the @ being typed, matched people, and the completed word", () => {
  const people = [{ id: "p-ravi", name: "ravi" }, { id: "p-dana", name: "dana" }, { id: "p-ra", name: "ada ray" }];
  assert.deepEqual(mentionAt("ask @ra", 7), { start: 4, query: "ra" });
  assert.deepEqual(mentionAt("@", 1), { start: 0, query: "" });
  assert.equal(mentionAt("mail ops@example.org", 20), null, "an @ inside a word is an address");
  assert.equal(mentionAt("ask @ra now", 11), null);
  assert.deepEqual(matchPeople(people, "ra").map((p) => p.id), ["p-ravi", "p-ra"]);
  assert.deepEqual(matchPeople(people, "").map((p) => p.id), ["p-ravi", "p-dana", "p-ra"]);
  const done = insertMention("ask @ra about it", { start: 4, query: "ra" }, people[0]);
  assert.equal(done.text, "ask @ravi about it");
  assert.equal(done.caret, 10);
  assert.equal(draftKey("/chat", null), "agora-chat:draft:/chat:new");
});

// ---- uploads ----

test("the upload plan: pictures re-encoded within the edge, GIF and SVG and other files untouched", () => {
  assert.deepEqual(fitWithin(4032, 3024, 2560), { width: 2560, height: 1920 });
  assert.deepEqual(fitWithin(800, 600, 2560), { width: 800, height: 600 }, "never enlarged");
  assert.deepEqual(fitWithin(3024, 4032, 320), { width: 240, height: 320 });
  assert.deepEqual(reencodePlan({ name: "IMG_2244.HEIC", type: "" }), { reencode: true, type: "image/jpeg" });
  assert.deepEqual(reencodePlan({ name: "a.jpg", type: "image/jpeg" }), { reencode: true, type: "image/jpeg" });
  assert.deepEqual(reencodePlan({ name: "shot.png", type: "image/png" }), { reencode: true, type: "image/png" });
  assert.deepEqual(reencodePlan({ name: "spin.gif", type: "image/gif" }), { reencode: false });
  assert.deepEqual(reencodePlan({ name: "plan.svg", type: "image/svg+xml" }), { reencode: false });
  assert.deepEqual(reencodePlan({ name: "notes.pdf", type: "application/pdf" }), { reencode: false });
  assert.equal(encodedName("IMG_2244.HEIC", "image/jpeg"), "IMG_2244.jpg");
  assert.equal(encodedName("shot.png", "image/png"), "shot.png");
});

test("uploadFile sends the bytes with the name and type, then the thumbnail by digest", async () => {
  /** @type {any[]} */
  const calls = [];
  const f = fakeFetch((url, init) => {
    calls.push({ url, headers: init.headers, size: init.body.size });
    if (init.headers["x-thumb-for"]) return { status: 200, body: { ok: true, data: { thumb: { digest: init.headers["x-thumb-for"] } } } };
    return { status: 200, body: { ok: true, data: { attachment: { id: "a-1", digest: "sha256:ab", name: "bay 2 · vent.jpg", kind: "image", size: 3 } } } };
  });
  const prepared = { blob: new Blob(["abc"], { type: "image/jpeg" }), name: "bay 2 · vent.jpg", type: "image/jpeg", thumb: new Blob(["t"], { type: "image/jpeg" }), reencoded: true };
  const r = await uploadFile(/** @type {any} */ ({}), { base: "/kit/", fetch: f, prepared });
  assert.equal(r.attachment.id, "a-1");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "/kit/upload");
  assert.equal(calls[0].headers["content-type"], "image/jpeg");
  assert.equal(decodeURIComponent(calls[0].headers["x-file-name"]), "bay 2 · vent.jpg");
  assert.match(calls[0].headers["x-file-name"], /^[\x20-\x7e]+$/, "a header carries Latin-1 only, so the name is percent-encoded");
  assert.equal(calls[1].headers["x-thumb-for"], "sha256:ab");
});

test("uploadFile names a refusal: too large, refused with a reason, offline", async () => {
  const prepared = { blob: new Blob(["x"]), name: "f.bin", type: "application/octet-stream", reencoded: false };
  await assert.rejects(uploadFile(/** @type {any} */ ({}), { base: "/c", prepared, fetch: fakeFetch(() => ({ status: 413, body: { ok: false, error: { code: "TOO_LARGE" } } })) }),
    (/** @type {any} */ e) => e instanceof UploadError && e.code === "TOO_LARGE");
  await assert.rejects(uploadFile(/** @type {any} */ ({}), { base: "/c", prepared, fetch: fakeFetch(() => ({ status: 422, body: { ok: false, error: { code: "UPLOAD_REFUSED", reason: "a secret inside" } } })) }),
    (/** @type {any} */ e) => e.code === "UPLOAD_REFUSED" && e.reason === "a secret inside");
  await assert.rejects(uploadFile(/** @type {any} */ ({}), { base: "/c", prepared, fetch: fakeFetch(() => "offline") }),
    (/** @type {any} */ e) => e.code === "OFFLINE");
});

// ---- whose message, its reactions, its purge ----

test("own messages are matched by ref, never by name; served reactions and purges are read", () => {
  const me = { id: "p-1", name: "pat" };
  assert.equal(isMine({ author: { kind: "human", name: "pat", ref: "p-1" } }, me), true);
  assert.equal(isMine({ author: { kind: "human", name: "pat" } }, me), false, "a matching name without a ref is not enough");
  assert.equal(isMine({ author: { kind: "human", name: "pat", ref: "p-2" } }, me), false);
  assert.equal(isMine({ author: { kind: "agent", name: "pat", ref: "p-1" } }, me), false);
  assert.equal(isMine({ author: { kind: "human", name: "x", ref: "r-1" } }, { id: "p-1", name: "pat", ref: "r-1" }), true, "a person's ref, when it has one, is what the kit stamps");
  assert.deepEqual([...(reactionsOf({ reactions: [{ name: "seen", people: ["p-1", "p-2"] }, { name: "done", people: ["p-3"] }] }) ?? [])], [["seen", ["p-1", "p-2"]], ["done", ["p-3"]]]);
  // one shape only: an object keyed by name, or people under another key, is not read
  assert.equal(reactionsOf({ reactions: { done: ["p-3"] } }), null);
  assert.deepEqual([...(reactionsOf({ reactions: [{ name: "seen", who: ["p-1"] }] }) ?? [])], []);
  assert.equal(reactionsOf({}), null);
  assert.deepEqual(purgedOf({ text: "", purged: { at: "2026-10-10T10:00:00Z", purge: "x" } }), { at: "2026-10-10T10:00:00Z" });
  assert.deepEqual(purgedOf({ text: "", purged: true }), {});
  assert.equal(purgedOf({ text: "hi" }), null);
  for (const w of DEFAULT_REACTIONS) assert.match(w, /^[\p{L}\p{N}_-]{1,32}$/u, "a reaction word the server accepts");
});

// ---- search marking ----

test("search: query terms are marked in the snippet as text runs, never as markup", () => {
  assert.deepEqual(queryTerms('Vent "bay" a'), ["vent", "bay"]);
  const runs = markRuns("The bay 2 VENT <b>opens</b>", ["vent", "bay"]);
  assert.deepEqual(runs, [
    { text: "The ", mark: false }, { text: "bay", mark: true }, { text: " 2 ", mark: false }, { text: "VENT", mark: true }, { text: " <b>opens</b>", mark: false },
  ]);
  assert.deepEqual(markRuns("nothing", []), [{ text: "nothing", mark: false }]);
  assert.equal(rootOf({ id: "m2", thread: "m1" }), "m1");
  assert.equal(rootOf({ id: "m1" }), "m1");
});

test("search coverage reads as a time, never a cursor", () => {
  const now = new Date(2026, 9, 10, 15, 0);
  assert.equal(coverageWords({ through: "e1:5000", at: new Date(2026, 9, 10, 14, 16).toISOString() }, now), "searched through today 14:16");
  assert.equal(coverageWords({ through: "e1:5000", at: new Date(2026, 9, 8, 9, 5).toISOString() }, now), "searched through thu 08 oct 09:05");
  assert.equal(coverageWords({ through: "e1:5000", at: null }, now), "searched");
  assert.equal(coverageWords(undefined, now), "searched");
});
