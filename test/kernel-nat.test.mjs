// @ts-check
// The kernels are proved over the interpreter's Nat, which stops at 2^48-1. The emitted JS stops
// there too, but by throwing a bare string with no stack; the product refuses at the boundary
// first, by name, so no live path reaches the kernel's own abort.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NAT_MAX, nat } from "../src/kernel-nat.mjs";
import B from "../src/native-board.kernel.mjs";

test("nat admits the ceiling and refuses past it, by name", () => {
  assert.equal(nat(0, "zero"), 0n);
  assert.equal(nat(NAT_MAX, "ceiling"), NAT_MAX);
  assert.equal(NAT_MAX, 281474976710655n);
  assert.throws(() => nat(NAT_MAX + 1n, "a clock"), /kernel-nat-range: a clock is 281474976710656, past 2\^48-1/);
  assert.throws(() => nat(-1, "a sequence"), /kernel-nat-range: a sequence is -1, below zero/);
});

test("the emitted kernel aborts past the ceiling as the interpreter does, but with a bare string", () => {
  let thrown;
  try { B.judge({ $: "Claim", account: 1n, op: 2n, lease_ms: 1n }, { $: "NoHolder" }, 5n, NAT_MAX + 1n); } catch (e) { thrown = e; }
  assert.equal(typeof thrown, "string", "not an Error: no stack, no name, `e.message` is undefined");
  assert.equal(thrown, "bend: a Nat past the largest immediate 2^48-1");
  // and arithmetic that crosses the ceiling from below aborts the same way
  assert.throws(() => B.judge({ $: "Claim", account: 1n, op: 2n, lease_ms: 2n }, { $: "NoHolder" }, 5n, NAT_MAX - 1n), (e) => e === "bend: a Nat past the largest immediate 2^48-1");
});

test("the native store refuses a board act when its clock is past the ceiling, before the kernel", async (t) => {
  const { NativeRoomStore } = await import("../src/native-store.mjs");
  const root = await mkdtemp(join(tmpdir(), "agora-nat-"));
  const store = await NativeRoomStore.create({ root, hostAccountId: "a0e7ad17c2dee02fc4cee4fcd6a04a9a", now: () => new Date(Number(NAT_MAX + 1n)) });
  t.after(() => store.close());
  await assert.rejects(
    store.append({ kind: "board", operationId: "operation_nat_00000001", payload: { action: "claim", subject: "work:nat" } }, { accountId: "a0e7ad17c2dee02fc4cee4fcd6a04a9a" }),
    /kernel-nat-range: the clock is 281474976710656/,
  );
});
