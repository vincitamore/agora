// The Nat the proven kernels are proved over is the interpreter's Nat, which aborts past
// 2^48-1. The emitted JS the product runs aborts there too (measured), but by throwing the
// bare string `bend: a Nat past the largest immediate 2^48-1`: not an Error, no name, no stack,
// which the store would surface as an unnamed failure. So every number the store hands a kernel
// crosses this boundary first: inside the range, the kernel's reading is the one the laws are
// about; past it, the product refuses by name before the kernel's own abort.
//
// Reach today is far below the ceiling (epoch milliseconds ~1.8e12 against 2.8e14; sequences,
// lease lengths and interned ids are small), so this guard is a statement of where the proofs
// hold, never a path a live room takes.

import { AgoraError } from "./core.mjs";

/** the largest Nat the interpreter represents: 2^48 - 1 */
export const NAT_MAX = (1n << 48n) - 1n;

/**
 * A kernel argument, refused past the interpreter's Nat ceiling.
 * @param {bigint | number} value
 * @param {string} what what the number is, for the refusal
 * @returns {bigint}
 */
export function nat(value, what) {
  const n = typeof value === "bigint" ? value : BigInt(value);
  if (n < 0n) throw new AgoraError(`kernel-nat-range: ${what} is ${n}, below zero; the kernels are proved over Nat`);
  if (n > NAT_MAX) throw new AgoraError(`kernel-nat-range: ${what} is ${n}, past 2^48-1, the largest Nat the proofs' interpreter represents; the kernel aborts there with a bare string and no name`);
  return n;
}
