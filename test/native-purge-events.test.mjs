// @ts-check
// Purge events (docs/PURGE.md, purge-v1): a subscriber that asks for purges receives each one,
// naming the messages it took, in log order among the messages; a plain subscriber is carried past
// it; a thread subscriber hears only of its own thread's messages; `follow` hands each purge over
// once across a dark period; `foldPurges` strikes the text a reader already shows.
import test from "node:test";
import assert from "node:assert/strict";
import { foldPurges } from "../src/client.mjs";
import { ADA, EPOCH, seat, until } from "./client-fixtures.mjs";

const at = (/** @type {number} */ n) => `${EPOCH}:${n}`;

test("a subscriber that asks for purges receives each in log order; a plain one is carried past; foldPurges strikes the text", { timeout: 30_000 }, async (t) => {
  const s = await seat(t);
  const poster = await s.open();
  assert.ok(poster.capabilities.has("purge-v1"), "the seat service offers purge-v1");
  const app = await s.open();
  /** @type {string[]} */
  const heard = [];
  /** @type {string[]} */
  const plain = [];
  /** @type {any[]} */
  const shown = [];
  /** @type {any[]} */
  const purges = [];
  const sub = await app.subscribe("house", { since: at(0) }, {
    message: (m) => { heard.push(`m:${m.text}`); shown.push(m); },
    purge: (p) => { heard.push(`p:${p.purged.length}`); purges.push(p); },
  });
  const bare = await app.subscribe("house", { since: at(0) }, { message: (m) => plain.push(m.text) });
  t.after(() => { sub.close(); bare.close(); });
  const a = await poster.append("house", { text: "a private note", author: ADA });
  await poster.append("house", { text: "kept", author: ADA });
  const receipt = await poster.purge("house", { targets: [a.id], reason: "asked", author: ADA });
  await poster.append("house", { text: "after", author: ADA });
  await until(() => heard.length === 4 && plain.length === 3);
  assert.deepEqual(heard, ["m:a private note", "m:kept", "p:1", "m:after"]);
  assert.deepEqual(plain, ["a private note", "kept", "after"], "a plain subscriber is carried past the purge");
  assert.deepEqual([purges[0].id, purges[0].cursor, purges[0].purged, purges[0].reason, purges[0].by], [receipt.id, at(3), [a.id], "asked", { name: "Ada" }]);
  assert.equal(sub.cursor, at(4));
  assert.equal(bare.cursor, at(4));

  const struck = foldPurges(shown, purges);
  assert.deepEqual(struck.map((m) => [m.text, m.purged]), [["", { at: purges[0].ts, purge: receipt.id }], ["kept", undefined], ["after", undefined]]);
  assert.equal(shown[0].text, "a private note", "foldPurges is pure");

  // a subscription made after the purge replays it in place, beside the message as it now reads
  /** @type {string[]} */
  const replay = [];
  const late = await app.subscribe("house", { since: at(0) }, {
    message: (m) => replay.push(`m:${m.text}${m.purged ? ":purged" : ""}`),
    purge: (p) => replay.push(`p:${p.purged.join(",") === a.id ? "a" : "?"}`),
  });
  late.close();
  assert.deepEqual(replay, ["m::purged", "m:kept", "p:a", "m:after"]);
});

test("a thread subscriber hears of a purge only for its own thread's messages", { timeout: 30_000 }, async (t) => {
  const s = await seat(t);
  const poster = await s.open();
  const root = await poster.append("house", { text: "root", author: ADA });
  const reply = await poster.append("house", { text: "reply", author: ADA, thread: root.id });
  const other = await poster.append("house", { text: "elsewhere", author: ADA });
  const elsewhere = await poster.append("house", { text: "also elsewhere", author: ADA });
  const app = await s.open();
  /** @type {any[]} */
  const purges = [];
  const sub = await app.subscribe("house", { since: at(4), thread: root.id }, { message: () => {}, purge: (p) => purges.push(p) });
  t.after(() => sub.close());
  await poster.purge("house", { targets: [elsewhere.id], reason: "not this thread", author: ADA });
  await poster.purge("house", { targets: [other.id, reply.id], reason: "one of each", author: ADA });
  await until(() => purges.length === 1);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(purges.map((p) => p.purged), [[reply.id]], "only the thread's message, and nothing from the purge that took none of it");
});

test("follow delivers each purge once across a dark period", { timeout: 30_000 }, async (t) => {
  const s = await seat(t);
  const poster = await s.open();
  const app = await s.open();
  /** @type {string[]} */
  const seen = [];
  /** @type {string[]} */
  const states = [];
  const follow = app.follow("house", { since: at(0) }, {
    message: (m) => seen.push(`m:${m.text}`),
    purge: (p) => seen.push(`p:${p.purged.length}`),
    state: (state) => states.push(state),
  }, { backoffMs: [0, 200] });
  t.after(() => follow.close());
  await until(() => states.includes("live"));
  const one = await poster.append("house", { text: "one", author: ADA });
  const two = await poster.append("house", { text: "two", author: ADA });
  await poster.purge("house", { targets: [one.id], reason: "first", author: ADA });
  await until(() => seen.length === 3);

  await s.stop();
  await until(() => states.at(-1) === "dark");
  await s.start();
  const fresh = await s.open();
  await fresh.purge("house", { targets: [two.id], reason: "second", author: ADA });
  await until(() => states.at(-1) === "live");
  await fresh.append("house", { text: "three", author: ADA });
  await until(() => seen.length === 5);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(seen, ["m:one", "m:two", "p:1", "p:1", "m:three"]);
  assert.equal(follow.cursor, at(5));
});
