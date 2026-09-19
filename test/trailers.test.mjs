// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { parseSignature } from "../src/core.mjs";
import { formatTrailers, matchesAddress, parseTrailers, TRAILER_VALUE_MAX, trailerValueOk } from "../src/trailers.mjs";

test("a message with no block is all body", () => {
  assert.deepEqual(parseTrailers("just a line"), { body: "just a line", trailers: [], to: [] });
  const signed = "just a line\n\n-- Grace/watch";
  assert.deepEqual(parseTrailers(signed), { body: signed, trailers: [], to: [] });
  const prose = "I read the log.\nThe cause: one bad retry.\n\n-- Grace";
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
    "-- Grace/watch",
  ].join("\n");
  const r = parseTrailers(text);
  assert.equal(r.body, "the retry loop swallows the 429");
  assert.deepEqual(r.trailers, [
    { key: "to", value: "Codex" },
    { key: "re", value: "1788449823.687169" },
    { key: "claim", value: "worker/src/fetch.ts::retryFetch" },
  ]);
  assert.deepEqual(r.to, ["Codex"]);
  assert.equal(parseSignature(text), "Grace/watch", "reading trailers changes nothing about the signature");
});

test("a block with no signature parses, and a key is read whatever its case", () => {
  const r = parseTrailers("holding this one\n\nTo: Grace/review\nBecause: it touches the settle path");
  assert.equal(r.body, "holding this one");
  assert.deepEqual(r.trailers, [
    { key: "to", value: "Grace/review" },
    { key: "because", value: "it touches the settle path" },
  ]);
});

test("no partial parses: one line that is not a trailer, or no known key, and the whole text is body", () => {
  const oneOff = "body\n\nto: Codex\nand one line of prose";
  assert.deepEqual(parseTrailers(oneOff), { body: oneOff, trailers: [], to: [] });

  const unknown = "body\n\nseverity: high\nowner: peer";
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
    { key: "to", value: "Grace/review" },
  ];
  const block = formatTrailers(entries);
  assert.equal(
    block,
    [
      "to: Codex",
      "to: Grace/review",
      "verdict: the retry is the bug",
      "exhibit: run 4412 line 88",
      "because: the stage log names one cause",
      "severity: high",
    ].join("\n"),
    "known keys in their fixed order, then anything else in the order it was given",
  );
  const round = parseTrailers(`body\n\n${block}\n\n-- Grace`);
  assert.deepEqual(round.trailers, [
    { key: "to", value: "Codex" },
    { key: "to", value: "Grace/review" },
    { key: "verdict", value: "the retry is the bug" },
    { key: "exhibit", value: "run 4412 line 88" },
    { key: "because", value: "the stage log names one cause" },
    { key: "severity", value: "high" },
  ]);
  assert.deepEqual(round.to, ["Codex", "Grace/review"]);
  const cap = { key: "because", value: "x".repeat(TRAILER_VALUE_MAX) };
  assert.deepEqual(
    parseTrailers(`body\n\n${formatTrailers([cap, { key: "to", value: "Codex" }])}`).trailers,
    [{ key: "to", value: "Codex" }, cap],
    "formatTrailers of a max-length value re-parses to the same entries",
  );
});

test("withdraws is a known trailer, and emitter and parser round-trip it", () => {
  const text = [
    "that run was the wrong branch",
    "",
    "withdraws: 1788449823.687169",
    "verdict: withdrawn",
    "exhibit: run 4419 line 12",
    "",
    "-- Grace/watch",
  ].join("\n");
  const r = parseTrailers(text);
  assert.equal(r.body, "that run was the wrong branch");
  assert.deepEqual(r.trailers, [
    { key: "withdraws", value: "1788449823.687169" },
    { key: "verdict", value: "withdrawn" },
    { key: "exhibit", value: "run 4419 line 12" },
  ]);
  assert.deepEqual(r.to, [], "a withdrawal addresses nobody by itself");
  assert.equal(formatTrailers(r.trailers), "withdraws: 1788449823.687169\nverdict: withdrawn\nexhibit: run 4419 line 12");

  // repeatable, and written after `re:` and before the commitments it takes back
  const block = formatTrailers([
    { key: "withdraws", value: "m9" },
    { key: "claim", value: "p.ts::f" },
    { key: "re", value: "m1" },
    { key: "withdraws", value: "m8" },
  ]);
  assert.equal(block, ["re: m1", "withdraws: m9", "withdraws: m8", "claim: p.ts::f"].join("\n"));
  assert.deepEqual(parseTrailers(`body\n\n${block}`).trailers, [
    { key: "re", value: "m1" },
    { key: "withdraws", value: "m9" },
    { key: "withdraws", value: "m8" },
    { key: "claim", value: "p.ts::f" },
  ], "what the emitter writes the parser reads back");

  // and it is a known key on its own, so a block carrying nothing else is still a block
  assert.deepEqual(parseTrailers("taking it back\n\nwithdraws: m4").trailers, [{ key: "withdraws", value: "m4" }]);
});

test("ack: none is a known trailer; honouring it is not the parser's job", () => {
  const r = parseTrailers("heads up, no receipt needed\n\nack: none\n\n-- Grace/watch");
  assert.equal(r.body, "heads up, no receipt needed");
  assert.deepEqual(r.trailers, [{ key: "ack", value: "none" }]);
  assert.deepEqual(formatTrailers(r.trailers), "ack: none");
});

test("an address matches a bearer by whole segments, from the left", () => {
  const seat = { id: "UBOT", name: "example_bot" };
  const table = [
    ["Grace", "Grace/watch", true],
    ["Grace", "Grace", true],
    ["grace", "Grace/watch", true],
    ["Grace/watch", "Grace/watch", true],
    ["GRACE/WATCH", "Grace/watch", true],
    ["Grace/watch", "Grace", false],
    ["Grace/watch", "Grace/review", false],
    ["Gra", "Grace/watch", false],
    ["Grace/wat", "Grace/watch", false],
    ["*", "anyone/at/all", true],
    ["", "Grace", false],
  ];
  for (const [address, bearer, want] of table)
    assert.equal(matchesAddress(String(address), String(bearer), seat), want, `${address} -> ${bearer}`);

  // a platform mention resolves to the bot user: it reaches the seat, never one bearer
  assert.equal(matchesAddress("<@UBOT>", "Grace/watch", seat), true);
  assert.equal(matchesAddress("<@UBOT|socius>", "Grace/watch", seat), true);
  assert.equal(matchesAddress("<@UOTHER>", "Grace/watch", seat), false);
  assert.equal(matchesAddress("<@UBOT>", "Grace/watch", undefined), false, "with no seat there is nothing to match");
  assert.equal(matchesAddress("example_bot", "Grace/watch", seat), true, "the seat's own name reaches whoever holds it");
  assert.equal(matchesAddress("example_bot", "Grace/watch", undefined), false);
});
