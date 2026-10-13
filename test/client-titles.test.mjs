// @ts-check
// Thread titles (docs/ANNOTATIONS.md, titles-v1): a title annotation names a thread's root; the
// newest is the thread's title; a reply cannot be titled; a reader that does not ask for titles is
// never handed one (a build older than titles would refuse the act); a purge of the thread takes the
// titles' text with it; the log reopens with titles and after their purge.
import test from "node:test";
import assert from "node:assert/strict";
import { foldAnnotations } from "../src/client.mjs";
import { NativeServiceClient } from "../src/native-service.mjs";
import { EPOCH, failure, seat, until } from "./client-fixtures.mjs";

const at = (/** @type {number} */ n) => `${EPOCH}:${n}`;
const dana = { kind: /** @type {const} */ ("human"), name: "Dana", ref: "person.1" };
const bot = { kind: /** @type {const} */ ("agent"), name: "Opus/helper" };

test("foldAnnotations: the newest title is the root's title, with who set it", () => {
  const m = /** @type {any} */ ({ id: "r".padEnd(64, "0"), room: "6".repeat(32), author: { id: "a", name: "Ada", kind: "human" }, text: "first words", ts: "t1", cursor: at(1) });
  const note = (/** @type {number} */ n, /** @type {string} */ text, /** @type {any} */ author) =>
    /** @type {any} */ ({ id: `a${n}`.padEnd(64, "0"), cursor: at(n), ts: `t${n}`, act: "title", target: m.id, text, author: { id: "a", ...author } });
  const [folded] = foldAnnotations([m], [note(3, "Second name", { name: "Dana", kind: "human", ref: "person.1" }), note(2, "First name", { name: "Opus/helper", kind: "agent" })]);
  assert.equal(folded.text, "first words", "a title never touches the root's text");
  assert.deepEqual(folded.title, { at: "t3", text: "Second name", by: { name: "Dana", kind: "human", ref: "person.1" } });
});

test("title a thread: root only, one bounded line, newest wins; a reader that asks gets it, a purge takes it", { timeout: 30_000 }, async (t) => {
  const s = await seat(t);
  const app = await s.open({ clientName: "example-app" });
  assert.ok(app.capabilities.has("titles-v1"), "the seat service offers titles-v1");
  const root = await app.append("house", { text: "the mobile chat ui needs a bit of refining", author: dana });
  const reply = await app.append("house", { text: "on it", thread: root.id, author: bot });
  await app.annotate("house", { act: "title", target: root.id, text: "Phone chat layout", author: bot });
  await app.annotate("house", { act: "title", target: root.id, text: "Chat app layout fixes", author: dana });
  const onReply = await failure(app.annotate("house", { act: "title", target: reply.id, text: "No", author: bot }));
  assert.deepEqual([onReply.outcome, onReply.code], ["refused", "annotation-not-root"]);
  for (const text of [undefined, "", " padded", "two\nlines", "x".repeat(121)])
    assert.equal((await failure(app.annotate("house", { act: "title", target: root.id, ...(text !== undefined ? { text } : {}), author: bot }))).code, "annotation-invalid");
  assert.ok((await app.annotate("house", { act: "title", target: root.id, text: "é".repeat(120), author: bot })).id, "120 characters, not bytes");
  await app.annotate("house", { act: "title", target: root.id, text: "Chat app layout fixes", author: dana });

  const read = await app.read("house");
  assert.deepEqual(read.annotations?.map((a) => a.act), ["title", "title", "title", "title"]);
  const [folded] = foldAnnotations(read.messages, read.annotations ?? []);
  assert.deepEqual([folded.title?.text, folded.title?.by.ref], ["Chat app layout fixes", "person.1"]);

  // the log reopens with title records in it
  await s.stop();
  await s.start();
  const again = await s.open();
  assert.equal((await again.read("house")).annotations?.filter((a) => a.act === "title").length, 4);

  await again.purge("house", { thread: root.id, reason: "test", author: bot });
  const purged = await again.read("house");
  assert.ok(purged.annotations?.filter((a) => a.act === "title").every((a) => a.text === undefined && a.purged), "a purge takes every title's text");
  await s.stop();
  await s.start();
  const third = await s.open();
  assert.equal((await third.read("house")).annotations?.filter((a) => a.act === "title").length, 4, "and the log reopens after it");
  const late = await failure(third.annotate("house", { act: "title", target: root.id, text: "Back", author: bot }));
  assert.equal(late.code, "annotation-target-purged");
});

test("a reader that does not ask for titles is never handed one, and is carried past it", { timeout: 30_000 }, async (t) => {
  const original = NativeServiceClient.connect;
  let older = false;
  NativeServiceClient.connect = async (endpoint) => {
    const c = await original.call(NativeServiceClient, endpoint);
    if (older) c.capabilities.delete("titles-v1");
    return c;
  };
  t.after(() => { NativeServiceClient.connect = original; });
  const s = await seat(t);
  const app = await s.open({ clientName: "example-app" });
  const root = await app.append("house", { text: "words", author: dana });
  await app.annotate("house", { act: "pin", target: root.id, author: bot });
  await app.annotate("house", { act: "title", target: root.id, text: "A name", author: bot });
  older = true;
  const old = await s.open();
  assert.equal(old.capabilities.has("titles-v1"), false);
  const titleRefused = await failure(old.annotate("house", { act: "title", target: root.id, text: "x", author: bot }));
  assert.equal(titleRefused.code, "titles-unsupported");
  const read = await old.read("house");
  assert.deepEqual(read.annotations?.map((a) => a.act), ["pin"], "the title is not in an older reader's read");
  /** @type {string[]} */
  const seen = [];
  const sub = await old.subscribe("house", { since: at(0) }, { message: (m) => seen.push(`m:${m.text}`), annotation: (a) => seen.push(`a:${a.act}`) });
  await app.annotate("house", { act: "title", target: root.id, text: "Another", author: bot });
  await app.append("house", { text: "more", author: dana });
  await until(() => seen.length === 3);
  assert.deepEqual(seen, ["m:words", "a:pin", "m:more"], "nor in its replay or its live events");
  sub.close();
});
