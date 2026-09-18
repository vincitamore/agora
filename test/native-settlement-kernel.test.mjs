// What a session's carry says still stands is decided by the singulis settlement ledger,
// generated from spec/settlement.bend (a byte-identical copy of the singulis source) whose laws
// (spec/SETTLEMENT-LAWS.bend) the Bend 2 checker proves before the file is emitted. These tests
// pin the kernel's JavaScript face; the regeneration gate for every vendored kernel lives in
// native-cursor-kernel.test.mjs.

import assert from "node:assert/strict";
import { test } from "node:test";
import S from "../src/native-settlement.kernel.mjs";

/** @param {bigint} id */
const fact = (id) => ({ $: "Fact", id });
/** @param {any[]} xs newest first */
const list = (xs) => xs.reduceRight((tail, head) => ({ $: "Con", head, tail }), { $: "Nil" });
const step = { $: "Step", members: list([0n]) };
/** @param {bigint} id @param {bigint} [member] */
const asserted = (id, member = 0n) => ({ $: "Assert", fact: fact(id), member });

test("a fact stands through an exhibit and only through one", () => {
  assert.equal(S.standing({ $: "Nil" }, fact(1n)), false);
  assert.equal(S.standing(list([asserted(1n)]), fact(1n)), true);
  assert.equal(S.standing(list([asserted(1n)]), fact(2n)), false);
  assert.equal(S.standing(list([{ $: "Allocate", count: 9n }]), fact(1n)), false, "an allocation settles nothing");
});

test("the newest entry about a fact decides: a retraction unsettles, a later assertion re-settles", () => {
  const l = list([asserted(1n)]);
  const retracted = { $: "Con", head: { $: "Retract", fact: fact(1n), step }, tail: l };
  assert.equal(S.standing(retracted, fact(1n)), false);
  const again = { $: "Con", head: asserted(1n), tail: retracted };
  assert.equal(S.standing(again, fact(1n)), true);
});

test("apply of coordination-free entries never unsettles what stood", () => {
  const es = list([asserted(2n), { $: "Allocate", count: 3n }]);
  assert.equal(S.coordination_free(es), true);
  assert.equal(S.coordination_free(list([{ $: "Retract", fact: fact(2n), step }])), false);
  const l = list([asserted(1n)]);
  assert.equal(S.standing(S.apply(es, l), fact(1n)), true);
  assert.equal(S.standing(S.apply(es, l), fact(2n)), true);
});

test("a stranger's step is inert; the asserter's step, with anyone else in it, unsettles", () => {
  const l = list([asserted(1n, 7n)]);
  const stranger = { $: "Con", head: { $: "Retract", fact: fact(1n), step: { $: "Step", members: list([3n]) } }, tail: l };
  assert.equal(S.standing(stranger, fact(1n)), true, "member 3 did not assert fact 1");
  assert.equal(S.coordination_free(stranger), false, "the retraction is on the ledger even though it did nothing");
  const many = { $: "Con", head: { $: "Retract", fact: fact(1n), step: { $: "Step", members: list([3n, 7n]) } }, tail: l };
  assert.equal(S.standing(many, fact(1n)), false, "member 7 asserted it and is in the step");
  assert.deepEqual(S.read(l, fact(1n)), { $: "Settled", member: 7n });
  assert.deepEqual(S.read(stranger, fact(1n)), { $: "Settled", member: 7n });
});

test("a ledger of a hundred thousand entries reads in constant stack (the read is one tail-recursive pass)", () => {
  // measured before the accumulator read: RangeError near 4,900 entries in the emitted kernel
  const n = 100_000;
  const l = list(Array.from({ length: n }, (_, i) => asserted(BigInt(i % 50), BigInt(i % 3))));
  assert.equal(S.standing(l, fact(49n)), true);
  assert.deepEqual(S.read(l, fact(7n)), { $: "Settled", member: 1n }, "the newest assertion of fact 7 is entry 7, by member 7 % 3");
  const withStranger = { $: "Con", head: { $: "Retract", fact: fact(7n), step: { $: "Step", members: list([9n]) } }, tail: l };
  assert.equal(S.standing(withStranger, fact(7n)), true, "a stranger's step above a hundred thousand entries retracts nothing");
});

