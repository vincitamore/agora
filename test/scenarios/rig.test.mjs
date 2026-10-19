// @ts-check
// The rig's own logic, in process: the verdict table, the two gates, the converter from `read
// --json` lines, and the address classes. Each gate rule is shown failing on the input it exists
// to refuse, so the gate cannot quietly start passing everything.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gateNormal, gateRedLeg, judge, observer } from "./lib/observe.mjs";
import { answeredTwice, classifyAddress, fromReadJson, timeline, variations } from "./lib/fixture.mjs";

/** @type {import("./lib/observe.mjs").Recording} */
const recording = { scenario: "SX", recordedOn: "2026-01-01", build: "x", checks: {
  green: { today: "green", observed: 0 },
  red: { today: "red", observed: 3 },
} };

test("judge: the verdict table, every row", () => {
  assert.equal(judge(0, 0, recording, "green"), "pass");
  assert.equal(judge(0, 1, recording, "green"), "fail");
  assert.equal(judge(0, 3, recording, "red"), "red-as-expected");
  assert.equal(judge(0, 0, recording, "red"), "flipped");
  assert.equal(judge(0, 2, recording, "red"), "drifted");
  assert.equal(judge(0, 0, recording, "other"), "unrecorded");
  assert.equal(judge(0, 0, null, "green"), "measured");
  // structural, never by reference or key order
  assert.equal(judge({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 }, { ...recording, checks: { s: { today: "green", observed: null } } }, "s"), "pass");
});

/** @param {Array<[string, unknown, unknown]>} rows */
function lines(rows, leg = "normal") {
  const o = observer({ scenario: "SX", leg, recording, write: () => {} });
  for (const [check, expected, observed] of rows) o.check(check, expected, observed);
  return o.lines;
}

test("gateNormal holds on pass and red-as-expected only, and names every other case", () => {
  assert.deepEqual(gateNormal(lines([["green", 0, 0], ["red", 0, 3]]), recording, ["green", "red"]), []);
  assert.match(gateNormal([], recording, ["green"])[0], /prints nothing/);
  assert.match(gateNormal(lines([["green", 0, 0]]), null, ["green"])[0], /no recording/);
  assert.match(gateNormal(lines([["green", 0, 0], ["red", 0, 0]]), recording, ["green", "red"]).join("\n"), /red: FLIPPED.*--record/);
  assert.match(gateNormal(lines([["green", 0, 0], ["red", 0, 5]]), recording, ["green", "red"]).join("\n"), /red: DRIFTED/);
  assert.match(gateNormal(lines([["green", 0, 1], ["red", 0, 3]]), recording, ["green", "red"]).join("\n"), /green: FAIL/);
  assert.match(gateNormal(lines([["green", 0, 0]]), recording, ["green", "red"]).join("\n"), /red: declared but printed no observation line/);
  assert.match(gateNormal(lines([["green", 0, 0], ["red", 0, 3], ["extra", 0, 0]]), recording, ["green", "red"]).join("\n"), /extra: observed but not declared/);
  // a line that lies about its verdict is caught by judging it again
  const forged = lines([["green", 0, 1], ["red", 0, 3]]).map((l) => ({ ...l, verdict: /** @type {const} */ ("pass") }));
  assert.match(gateNormal(forged, recording, ["green", "red"]).join("\n"), /the line says pass, the recording says fail/);
});

test("gateRedLeg admits a check only when its planted variation fails it", () => {
  assert.deepEqual(gateRedLeg(lines([["green", 0, 1]], "red:green"), "green", recording), []);
  assert.deepEqual(gateRedLeg(lines([["red", 0, 0]], "red:red"), "red", recording), []);
  assert.deepEqual(gateRedLeg(lines([["red", 0, 9]], "red:red"), "red", recording), []);
  assert.match(gateRedLeg(lines([["green", 0, 0]], "red:green"), "green", recording)[0], /not admitted/);
  assert.match(gateRedLeg(lines([["red", 0, 3]], "red:red"), "red", recording)[0], /not admitted/);
  assert.match(gateRedLeg([], "green", recording)[0], /a crash is not a discriminating failure/);
});

test("fromReadJson: re by id or by cursor, threads and titles as labels, body without signature or trailers", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-scenario-rig-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "export.jsonl");
  const room = "e".repeat(32);
  const rows = [
    { type: "message", id: "a".repeat(64), cursor: `${room}:1`, author: { name: "Ada", kind: "human" }, text: "Question?\n\nto: coding", to: ["coding"], trailers: [{ key: "to", value: "coding" }] },
    { type: "message", id: "b".repeat(64), cursor: `${room}:2`, author: { name: "x", kind: "agent" }, signedAs: "coding/Opus", text: "Answer.\n\nre: " + `${room}:1` + "\n\n-- coding/Opus", trailers: [{ key: "re", value: `${room}:1` }] },
    { type: "message", id: "c".repeat(64), cursor: `${room}:3`, thread: "a".repeat(64), author: { name: "x", kind: "agent" }, signedAs: "review/Sonnet", text: "In thread.\n\n-- review/Sonnet" },
    { type: "annotation", act: "title", target: "a".repeat(64), text: "The question", cursor: `${room}:4` },
    { type: "message", id: "d".repeat(64), cursor: `${room}:5`, author: { name: "x", kind: "agent" }, signedAs: "review/Sonnet", text: "Gone.\n\nre: " + "f".repeat(64), trailers: [{ key: "re", value: "f".repeat(64) }] },
  ];
  await writeFile(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const { lines: out, notes } = await fromReadJson(file);
  assert.deepEqual(out.slice(0, 2), [{ event: "register", session: "coding/Opus", author: "coding/Opus" }, { event: "register", session: "review/Sonnet", author: "review/Sonnet" }]);
  assert.deepEqual(out[2], { id: "m1", author: "Ada", kind: "human", text: "Question?", to: ["coding"], title: "The question" });
  assert.deepEqual(out[3], { id: "m2", author: "coding/Opus", kind: "agent", text: "Answer.", re: "m1" });
  assert.deepEqual(out[4], { id: "m3", author: "review/Sonnet", kind: "agent", text: "In thread.", thread: "m1" });
  assert.equal(notes.danglingRe, 1);
});

test("classifyAddress and answeredTwice: the classes the baseline counts", () => {
  const humans = new Set(["Ada"]);
  const held = new Set(["Opus/build", "Sonnet/build", "coding/Opus"]);
  const present = ["Sonnet/build", "coding/Opus"];
  assert.equal(classifyAddress("coding", present, held, humans), "matched");
  assert.equal(classifyAddress("ada", present, held, humans), "matched");
  assert.equal(classifyAddress("*", present, held, humans), "matched");
  assert.equal(classifyAddress("Opus/build", present, held, humans), "retired");
  assert.equal(classifyAddress("cod", present, held, humans), "halfName");
  assert.equal(classifyAddress("Linus", present, held, humans), "unknown");
  const msgs = [
    { id: "h", kind: "human", author: "Ada" },
    { id: "1", kind: "agent", author: "a", thread: "h" },
    { id: "2", kind: "agent", author: "b", re: "h" },
    { id: "h2", kind: "human", author: "Ada", thread: "h" },
    { id: "3", kind: "agent", author: "a", thread: "h" },
  ];
  assert.deepEqual(answeredTwice(msgs), { count: 1, ids: ["h"] });
});

test("the variations change only what they name", () => {
  /** @type {import("./lib/fixture.mjs").FixtureLine[]} */
  const fx = [
    { event: "register", session: "s", author: "coding/Opus" },
    { id: "q", author: "Ada", kind: "human", text: "q", to: ["coding", "nobody"] },
    { id: "a", author: "coding/Opus", session: "s", kind: "agent", text: "a", re: "q" },
  ];
  assert.deepEqual(variations.dropUnmatched(fx)[1], { id: "q", author: "Ada", kind: "human", text: "q", to: ["coding"] });
  assert.equal(/** @type {any} */ (variations.threadReReplies(fx)[2]).thread, "q");
  assert.equal(variations.titleRoots(fx).filter((l) => l.event !== "register" && l.title).length, 2);
  assert.equal(variations.oneMore(fx).length, 4);
  assert.equal(timeline(fx).messages[1].holding.get("s"), "coding/Opus");
});
