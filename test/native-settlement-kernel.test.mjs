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

test("a fact stands through an exhibit and only through one", () => {
  assert.equal(S.standing({ $: "Nil" }, fact(1n)), false);
  assert.equal(S.standing(list([{ $: "Assert", fact: fact(1n) }]), fact(1n)), true);
  assert.equal(S.standing(list([{ $: "Assert", fact: fact(1n) }]), fact(2n)), false);
  assert.equal(S.standing(list([{ $: "Allocate", count: 9n }]), fact(1n)), false, "an allocation settles nothing");
});

test("the newest entry about a fact decides: a retraction unsettles, a later assertion re-settles", () => {
  const asserted = list([{ $: "Assert", fact: fact(1n) }]);
  const retracted = { $: "Con", head: { $: "Retract", fact: fact(1n), step }, tail: asserted };
  assert.equal(S.standing(retracted, fact(1n)), false);
  const again = { $: "Con", head: { $: "Assert", fact: fact(1n) }, tail: retracted };
  assert.equal(S.standing(again, fact(1n)), true);
});

test("apply of coordination-free entries never unsettles what stood", () => {
  const es = list([{ $: "Assert", fact: fact(2n) }, { $: "Allocate", count: 3n }]);
  assert.equal(S.coordination_free(es), true);
  assert.equal(S.coordination_free(list([{ $: "Retract", fact: fact(2n), step }])), false);
  const l = list([{ $: "Assert", fact: fact(1n) }]);
  assert.equal(S.standing(S.apply(es, l), fact(1n)), true);
  assert.equal(S.standing(S.apply(es, l), fact(2n)), true);
});
