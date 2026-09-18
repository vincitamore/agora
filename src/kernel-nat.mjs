// The Nat the proven kernels are proved over is the interpreter's Nat, which aborts past
// 2^48-1 (`bend: a Nat past the largest immediate`); the emitted JS the product runs computes
// on BigInt past it without a word. So every number the store hands a kernel crosses this
// boundary first: inside the range, the kernel's reading is the one the laws are about; past
// it, the product refuses by name rather than continuing where the proofs stop.
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
  if (n > NAT_MAX) throw new AgoraError(`kernel-nat-range: ${what} is ${n}, past 2^48-1, the largest Nat the proofs' interpreter represents; the emitted kernel would compute past it unproved`);
  return n;
}
