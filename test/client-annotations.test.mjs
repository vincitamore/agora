// @ts-check
// agora/client and annotations (docs/ANNOTATIONS.md): `foldAnnotations` as a pure function, and
// `annotate`, `read`, `subscribe` and `follow` against a real seat service. The client sends an
// annotation, or asks for annotation events, only to a service that offered annotations-v1: the
// tests that need the offer run when the service makes it, and the refusal a service without it
// earns runs when it does not, so each build exercises the side it serves.
import test from "node:test";
import assert from "node:assert/strict";
import { foldAnnotations } from "../src/client.mjs";
import { ADA, EPOCH, failure, seat, until } from "./client-fixtures.mjs";

const at = (/** @type {number} */ n) => `${EPOCH}:${n}`;
/** @param {number} n @param {string} text @param {Record<string, unknown>} [extra] */
const message = (n, text, extra = {}) => /** @type {any} */ ({ id: `m${n}`.padEnd(64, "0"), room: "6".repeat(32), author: { id: "a", name: "Ada", kind: "human" },
  text, ts: `t${n}`, cursor: at(n), ...extra });
/** @param {number} n @param {'edit' | 'withdraw' | 'pin' | 'unpin'} act @param {number} target @param {string} [text] */
const note = (n, act, target, text) => /** @type {any} */ ({ id: `a${n}`.padEnd(64, "0"), cursor: at(n), ts: `t${n}`, act, target: `m${target}`.padEnd(64, "0"),
  ...(text !== undefined ? { text } : {}), author: { id: "a", name: "Ada", kind: "human" } });

test("foldAnnotations: the latest edit replaces the text, a withdrawal wins over every edit, the last pin or unpin decides", () => {
  const messages = [message(1, "first\n-- Ada"), message(2, "second"), message(3, "third")];
  const frozen = structuredClone(messages);
  const annotations = [
    note(9, "edit", 1, "late edit after the withdrawal"),
    note(4, "edit", 1, "first, edited\n\nto: Bea\n-- Ada/edit"),
    note(5, "edit", 2, "second, once"),
    note(6, "edit", 2, "second, twice"),
    note(7, "withdraw", 1),
    note(8, "pin", 3), note(10, "unpin", 3), note(11, "pin", 2),
    note(12, "edit", 99, "names nothing here"),
  ];
  const folded = foldAnnotations(messages, annotations);
  assert.deepEqual(messages, frozen, "the input is not changed");
  assert.equal(folded.length, 3);
  const [one, two, three] = folded;
  // edit after withdraw: withdrawn wins, the later edit changes nothing
  assert.deepEqual(one.withdrawn, { at: "t7" });
  assert.deepEqual(one.edited, { at: "t4", text: "first, edited\n\nto: Bea\n-- Ada/edit" });
  assert.equal(one.text, "first, edited\n\nto: Bea\n-- Ada/edit");
  assert.equal(one.signedAs, "Ada/edit", "the signature is read off the new text");
  assert.deepEqual(one.to, ["Bea"], "the trailers are read off the new text");
  assert.equal(one.pinned, undefined);
  assert.deepEqual([two.text, two.edited, two.pinned, two.withdrawn], ["second, twice", { at: "t6", text: "second, twice" }, true, undefined]);
  assert.deepEqual([three.text, three.pinned, "edited" in three], ["third", false, false]);
  // a withdrawal before any edit wins over the edits after it
  const [w] = foldAnnotations([message(1, "x")], [note(2, "withdraw", 1), note(3, "edit", 1, "y")]);
  assert.deepEqual([w.text, w.withdrawn, "edited" in w], ["x", { at: "t2" }, false]);
  // an edit drops trailers and a signature the old text had and the new one lacks
  const [plain] = foldAnnotations([message(1, "old\n\nto: Bea\n-- Ada")], [note(2, "edit", 1, "new")]);
  assert.deepEqual([plain.text, "to" in plain, "signedAs" in plain, "trailers" in plain], ["new", false, false, false]);
  assert.deepEqual(foldAnnotations([], annotations), []);
});

test("a service without annotations-v1: annotate and an annotation handler are refused before anything is sent; a read has no annotations", { timeout: 30_000 }, async (t) => {
  const s = await seat(t);
  const app = await s.open();
  if (app.capabilities.has("annotations-v1")) { t.skip("this service offers annotations-v1"); return; }
  const m = await app.append("house", { text: "words", author: ADA });
  const refusal = await failure(app.annotate("house", { act: "pin", target: m.id, author: ADA }));
  assert.deepEqual([refusal.outcome, refusal.code], ["refused", "annotations-unsupported"]);
  const sub = await failure(app.subscribe("house", {}, { message: () => undefined, annotation: () => undefined }));
  assert.deepEqual([sub.outcome, sub.code], ["refused", "annotations-unsupported"]);
  const read = await app.read("house");
  assert.equal("annotations" in read, false);
  assert.equal(read.messages.length, 1, "nothing but the message was appended");
});

test("annotate, read and fold: edit and withdraw are the author's, pin anyone's; a malformed request is refused before it is sent", { timeout: 30_000 }, async (t) => {
  const s = await seat(t);
  const app = await s.open({ clientName: "example-app" });
  if (!app.capabilities.has("annotations-v1")) { t.skip("annotations-v1 is offered once the capability lands in the vocabulary and LOCAL_OFFER"); return; }
  const dana = { kind: /** @type {const} */ ("human"), name: "Dana", ref: "person.1" };
  const erin = { kind: /** @type {const} */ ("human"), name: "Erin", ref: "person.2" };
  const m = await app.append("house", { text: "a question", author: dana });
  const edit = await app.annotate("house", { act: "edit", target: m.id, text: "a better question", author: dana, operationId: "op_annotate_edit_01" });
  assert.equal(edit.duplicate, false);
  assert.deepEqual(await app.annotate("house", { act: "edit", target: m.id, text: "a better question", author: dana, operationId: "op_annotate_edit_01" }),
    { ...edit, duplicate: true }, "a resend is the original receipt");
  const notMine = await failure(app.annotate("house", { act: "edit", target: m.id, text: "hijacked", author: erin }));
  assert.deepEqual([notMine.outcome, notMine.code], ["refused", "annotation-not-author"]);
  await app.annotate("house", { act: "pin", target: m.id, author: erin });

  for (const [request, code] of /** @type {Array<[any, string]>} */ ([
    [{ act: "star", target: m.id, author: dana }, "annotation-invalid"],
    [{ act: "edit", target: m.id, author: dana }, "annotation-invalid"],
    [{ act: "pin", target: m.id, text: "no", author: dana }, "annotation-invalid"],
    [{ act: "pin", target: "nope", author: dana }, "annotation-invalid"],
    [{ act: "pin", target: m.id, author: { kind: "robot", name: "R" } }, "author-invalid"],
    [{ act: "edit", target: m.id, text: "x".repeat(256 * 1024 + 1), author: dana }, "text-too-long"],
  ])) assert.equal((await failure(app.annotate("house", request))).code, code);
  const unknown = await failure(app.annotate("house", { act: "pin", target: "f".repeat(64), author: dana }));
  assert.deepEqual([unknown.outcome, unknown.code], ["refused", "annotation-target-unknown"]);

  const read = await app.read("house");
  assert.deepEqual(read.messages.map((x) => x.text), ["a question"]);
  assert.deepEqual(read.annotations?.map((a) => [a.act, a.author.ref, a.via]), [["edit", "person.1", "example-app"], ["pin", "person.2", "example-app"]]);
  assert.equal(read.through, at(3));
  const [folded] = foldAnnotations(read.messages, read.annotations ?? []);
  assert.deepEqual([folded.text, folded.pinned, folded.edited?.text], ["a better question", true, "a better question"]);

  await app.annotate("house", { act: "withdraw", target: m.id, author: dana });
  const gone = await failure(app.annotate("house", { act: "unpin", target: m.id, author: erin }));
  assert.equal(gone.code, "annotation-target-withdrawn");
  const after = await app.read("house", { since: at(3) });
  assert.deepEqual(after.annotations?.map((a) => a.act), ["withdraw"]);
});

test("a subscriber with no annotation handler is carried past annotations; one with a handler gets each once, in order", { timeout: 30_000 }, async (t) => {
  const s = await seat(t);
  const app = await s.open();
  if (!app.capabilities.has("annotations-v1")) { t.skip("annotations-v1 is offered once the capability lands in the vocabulary and LOCAL_OFFER"); return; }
  const one = await app.append("house", { text: "one", author: ADA });
  await app.annotate("house", { act: "pin", target: one.id, author: ADA });
  /** @type {string[]} */
  const quiet = [];
  /** @type {string[]} */
  const both = [];
  const plain = await app.subscribe("house", { since: at(0) }, { message: (m) => quiet.push(m.text) });
  assert.equal(plain.cursor, at(2), "the replay's annotation is covered: the cursor advances past it");
  const full = await app.subscribe("house", { since: at(0) }, { message: (m) => both.push(`m:${m.text}`), annotation: (a) => both.push(`a:${a.act}`) });
  assert.equal(full.cursor, at(2));
  await app.annotate("house", { act: "edit", target: one.id, text: "one!", author: ADA });
  await app.append("house", { text: "two", author: ADA });
  await until(() => quiet.length === 2 && both.length === 4);
  assert.deepEqual(quiet, ["one", "two"]);
  assert.deepEqual(both, ["m:one", "a:pin", "a:edit", "m:two"]);
  assert.equal(full.cursor, at(4));
  plain.close();
  full.close();
});

test("follow delivers each annotation once across a dark period", { timeout: 30_000 }, async (t) => {
  const s = await seat(t);
  const poster = await s.open();
  if (!poster.capabilities.has("annotations-v1")) { t.skip("annotations-v1 is offered once the capability lands in the vocabulary and LOCAL_OFFER"); return; }
  const app = await s.open();
  /** @type {string[]} */
  const seen = [];
  /** @type {string[]} */
  const states = [];
  const follow = app.follow("house", { since: at(0) }, {
    message: (m) => seen.push(`m:${m.text}`),
    annotation: (a) => seen.push(`a:${a.act}${a.text ? `:${a.text}` : ""}`),
    state: (state) => states.push(state),
  }, { backoffMs: [0, 200] });
  t.after(() => follow.close());
  await until(() => states.includes("live"));
  const one = await poster.append("house", { text: "one", author: ADA });
  await poster.annotate("house", { act: "edit", target: one.id, text: "one, edited", author: ADA });
  await until(() => seen.length === 2);

  await s.stop();
  await until(() => states.at(-1) === "dark");
  await s.start();
  const fresh = await s.open();
  await fresh.annotate("house", { act: "pin", target: one.id, author: ADA });
  await fresh.annotate("house", { act: "edit", target: one.id, text: "one, again", author: ADA });
  await until(() => states.at(-1) === "live");
  await fresh.append("house", { text: "two", author: ADA });
  await until(() => seen.length === 5);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(seen, ["m:one", "a:edit:one, edited", "a:pin", "a:edit:one, again", "m:two"]);
  assert.equal(follow.cursor, at(5));
});
