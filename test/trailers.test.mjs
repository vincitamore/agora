// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { parseSignature } from "../src/core.mjs";
import { formatTrailers, matchesAddress, parseTrailers, TRAILER_VALUE_MAX, trailerValueOk } from "../src/trailers.mjs";

test("a message with no block is all body", () => {
  assert.deepEqual(parseTrailers("just a line"), { body: "just a line", trailers: [], to: [] });
  const signed = "just a line\n\n-- Fable/watch";
  assert.deepEqual(parseTrailers(signed), { body: signed, trailers: [], to: [] });
  const prose = "I read the log.\nThe cause: one bad retry.\n\n-- Fable";
  assert.deepEqual(parseTrailers(prose).trailers, [], "prose that happens to hold a colon is not a claim");
});

test("body, block and signature: all three, and the signature still parses as it always did", () => {
  const text = [
    "the retry loop swallows the 429",
    "",
    "to: Codex",
    "re: 1788449823.687169",
    "claim: worker/src/fetch.ts::retryFetch",
    "",
    "-- Fable/watch",
  ].join("\n");
  const r = parseTrailers(text);
  assert.equal(r.body, "the retry loop swallows the 429");
  assert.deepEqual(r.trailers, [
    { key: "to", value: "Codex" },
    { key: "re", value: "1788449823.687169" },
    { key: "claim", value: "worker/src/fetch.ts::retryFetch" },
  ]);
  assert.deepEqual(r.to, ["Codex"]);
  assert.equal(parseSignature(text), "Fable/watch", "reading trailers changes nothing about the signature");
});

test("a block with no signature parses, and a key is read whatever its case", () => {
  const r = parseTrailers("holding this one\n\nTo: Fable/review\nBecause: it touches the settle path");
  assert.equal(r.body, "holding this one");
  assert.deepEqual(r.trailers, [
    { key: "to", value: "Fable/review" },
    { key: "because", value: "it touches the settle path" },
  ]);
});

test("no partial parses: one line that is not a trailer, or no known key, and the whole text is body", () => {
  const oneOff = "body\n\nto: Codex\nand one line of prose";
  assert.deepEqual(parseTrailers(oneOff), { body: oneOff, trailers: [], to: [] });

  const unknown = "body\n\nseverity: high\nowner: bone";
  assert.deepEqual(parseTrailers(unknown).trailers, [], "a block of only unknown keys is not a block");

  const carried = parseTrailers("body\n\nto: Codex\nseverity: high");
  assert.deepEqual(carried.trailers, [{ key: "to", value: "Codex" }, { key: "severity", value: "high" }], "an unknown key beside a known one is carried");

  const long = `body\n\nto: Codex\nbecause: ${"x".repeat(TRAILER_VALUE_MAX + 1)}`;
  assert.deepEqual(parseTrailers(long).trailers, [], `a value past ${TRAILER_VALUE_MAX} characters rejects the whole block`);
  const justFits = `body\n\nto: Codex\nbecause: ${"x".repeat(TRAILER_VALUE_MAX)}`;
  assert.equal(parseTrailers(justFits).trailers.length, 2);
  assert.equal(trailerValueOk("x".repeat(TRAILER_VALUE_MAX)), true);
  assert.equal(trailerValueOk("x".repeat(TRAILER_VALUE_MAX + 1)), false);
  assert.equal(trailerValueOk(""), false);
  assert.equal(trailerValueOk("line\nbreak"), false);
});

test("addresses accumulate across repeated keys and comma-separated values alike", () => {
  assert.deepEqual(parseTrailers("body\n\nto: A, B").to, ["A", "B"]);
  assert.deepEqual(parseTrailers("body\n\nto: A\nto: B").to, ["A", "B"]);
  assert.deepEqual(parseTrailers("body\n\nto: A\nto: A, B").to, ["A", "B"], "each address once");
});

test("what the emitter writes is what the parser reads back", () => {
  const entries = [
    { key: "because", value: "the stage log names one cause" },
    { key: "severity", value: "high" },
    { key: "exhibit", value: "run 4412 line 88" },
    { key: "to", value: "Codex" },
    { key: "verdict", value: "the retry is the bug" },
    { key: "to", value: "Fable/review" },
  ];
  const block = formatTrailers(entries);
  assert.equal(
    block,
    [
      "to: Codex",
      "to: Fable/review",
      "verdict: the retry is the bug",
      "exhibit: run 4412 line 88",
      "because: the stage log names one cause",
      "severity: high",
    ].join("\n"),
    "known keys in their fixed order, then anything else in the order it was given",
  );
  const round = parseTrailers(`body\n\n${block}\n\n-- Fable`);
  assert.deepEqual(round.trailers, [
    { key: "to", value: "Codex" },
    { key: "to", value: "Fable/review" },
    { key: "verdict", value: "the retry is the bug" },
    { key: "exhibit", value: "run 4412 line 88" },
    { key: "because", value: "the stage log names one cause" },
    { key: "severity", value: "high" },
  ]);
  assert.deepEqual(round.to, ["Codex", "Fable/review"]);
  const cap = { key: "because", value: "x".repeat(TRAILER_VALUE_MAX) };
  assert.deepEqual(
    parseTrailers(`body\n\n${formatTrailers([cap, { key: "to", value: "Codex" }])}`).trailers,
    [{ key: "to", value: "Codex" }, cap],
    "formatTrailers of a max-length value re-parses to the same entries",
  );
});

test("ack: none is a known trailer; honouring it is not the parser's job", () => {
  const r = parseTrailers("heads up, no receipt needed\n\nack: none\n\n-- Fable/watch");
  assert.equal(r.body, "heads up, no receipt needed");
  assert.deepEqual(r.trailers, [{ key: "ack", value: "none" }]);
  assert.deepEqual(formatTrailers(r.trailers), "ack: none");
});

test("an address matches a bearer by whole segments, from the left", () => {
  const seat = { id: "UBOT", name: "socius_amore" };
  const table = [
    ["Fable", "Fable/watch", true],
    ["Fable", "Fable", true],
    ["fable", "Fable/watch", true],
    ["Fable/watch", "Fable/watch", true],
    ["FABLE/WATCH", "Fable/watch", true],
    ["Fable/watch", "Fable", false],
    ["Fable/watch", "Fable/review", false],
    ["Fab", "Fable/watch", false],
    ["Fable/wat", "Fable/watch", false],
    ["*", "anyone/at/all", true],
    ["", "Fable", false],
  ];
  for (const [address, bearer, want] of table)
    assert.equal(matchesAddress(String(address), String(bearer), seat), want, `${address} -> ${bearer}`);

  // a platform mention resolves to the bot user: it reaches the seat, never one bearer
  assert.equal(matchesAddress("<@UBOT>", "Fable/watch", seat), true);
  assert.equal(matchesAddress("<@UBOT|socius>", "Fable/watch", seat), true);
  assert.equal(matchesAddress("<@UOTHER>", "Fable/watch", seat), false);
  assert.equal(matchesAddress("<@UBOT>", "Fable/watch", undefined), false, "with no seat there is nothing to match");
  assert.equal(matchesAddress("socius_amore", "Fable/watch", seat), true, "the seat's own name reaches whoever holds it");
  assert.equal(matchesAddress("socius_amore", "Fable/watch", undefined), false);
});
