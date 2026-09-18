// The native board's admission is decided by a kernel generated from spec/board.bend, whose
// laws (spec/BOARD-LAWS.bend) the Bend 2 checker proves before the file is emitted. These tests
// pin the kernel's JavaScript face (BigInt in, tagged objects out); the regeneration gate for
// every vendored kernel lives in native-cursor-kernel.test.mjs.

import assert from "node:assert/strict";
import { test } from "node:test";
import K from "../src/native-board.kernel.mjs";

/** @param {bigint} account @param {bigint} lease @param {bigint} fence @param {bigint} expires */
const held = (account, lease, fence, expires) => ({ $: "Held", account, lease, fence, expires });
/** @param {bigint} account @param {bigint} op @param {bigint} ms */
const claim = (account, op, ms) => ({ $: "Claim", account, op, lease_ms: ms });
const NOW = 1_000n;

test("a live lease refuses every claim, an expired one is free", () => {
  const live = held(1n, 10n, 5n, 2_000n);
  assert.equal(K.judge(claim(2n, 11n, 100n), live, 6n, NOW).$, "Held_by_another");
  assert.equal(K.judge(claim(1n, 11n, 100n), live, 6n, NOW).$, "Held_by_another");
  const expired = held(1n, 10n, 5n, 900n);
  assert.deepEqual(K.judge(claim(2n, 11n, 100n), expired, 6n, NOW), { $: "Applied", holder: held(2n, 11n, 6n, 1_100n) });
  assert.deepEqual(K.judge(claim(2n, 11n, 100n), { $: "NoHolder" }, 6n, NOW), { $: "Applied", holder: held(2n, 11n, 6n, 1_100n) });
});

test("release and renew need the holder's account, lease id and live fence", () => {
  const live = held(1n, 10n, 5n, 2_000n);
  assert.equal(K.judge({ $: "Release", account: 2n, lease: 10n, fence: 5n }, live, 6n, NOW).$, "Not_the_holder");
  assert.equal(K.judge({ $: "Release", account: 1n, lease: 99n, fence: 5n }, live, 6n, NOW).$, "Not_the_holder");
  assert.equal(K.judge({ $: "Release", account: 1n, lease: 10n, fence: 4n }, live, 6n, NOW).$, "Fence_mismatch");
  assert.deepEqual(K.judge({ $: "Release", account: 1n, lease: 10n, fence: 5n }, live, 6n, NOW), { $: "Applied", holder: { $: "NoHolder" } });
  assert.deepEqual(K.judge({ $: "Renew", account: 1n, lease: 10n, fence: 5n, lease_ms: 500n }, live, 6n, NOW), { $: "Applied", holder: held(1n, 10n, 6n, 1_500n) });
  const expired = held(1n, 10n, 5n, 900n);
  assert.equal(K.judge({ $: "Release", account: 1n, lease: 10n, fence: 5n }, expired, 6n, NOW).$, "Not_the_holder");
});

test("break is a human verb and names what it drops; contest takes nothing", () => {
  const live = held(1n, 10n, 5n, 2_000n);
  assert.equal(K.judge({ $: "Break", human: false }, live, 6n, NOW).$, "Not_human");
  assert.deepEqual(K.judge({ $: "Break", human: true }, live, 6n, NOW), { $: "Applied", holder: { $: "NoHolder" } });
  assert.equal(K.judge({ $: "Break", human: true }, { $: "NoHolder" }, 6n, NOW).$, "Nothing_to_break");
  assert.deepEqual(K.judge({ $: "Contest" }, live, 6n, NOW), { $: "Applied", holder: live });
});

test("a refusal changes nothing", () => {
  const live = held(1n, 10n, 5n, 2_000n);
  for (const v of ["Held_by_another", "Not_the_holder", "Fence_mismatch", "Not_human", "Nothing_to_break"]) {
    assert.deepEqual(K.after({ $: v }, live), live);
  }
  assert.deepEqual(K.after({ $: "Applied", holder: { $: "NoHolder" } }, live), { $: "NoHolder" });
});
