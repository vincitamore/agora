import { describe, expect, test } from "bun:test";
import { truncPad, trunc, wrapLines } from "../lib/format";

describe("cell discipline", () => {
  test("truncPad never exceeds and always fills the width", () => {
    expect(truncPad("abc", 5)).toBe("abc  ");
    expect(truncPad("abcdef", 5)).toBe("abcd…");
    expect(truncPad("abcde", 5)).toBe("abcde");
    expect(truncPad("abc", 0)).toBe("");
  });

  test("trunc cuts with an ellipsis and never pads", () => {
    expect(trunc("abcdef", 4)).toBe("abc…");
    expect(trunc("ab", 4)).toBe("ab");
  });

  test("wrapLines breaks at spaces, keeps blank lines, caps pathological input", () => {
    expect(wrapLines("one two three", 7)).toEqual(["one two", "three"]);
    expect(wrapLines("a\n\nb", 10)).toEqual(["a", "", "b"]);
    const long = "x".repeat(50);
    expect(wrapLines(long, 20).every((l) => l.length <= 20)).toBe(true);
    const cut = wrapLines("y".repeat(100), 50, 60);
    expect(cut[cut.length - 1]).toContain("text cut for display");
  });
});
