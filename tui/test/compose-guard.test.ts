import { describe, expect, test } from "bun:test";
import { composeRefusal, preparePost } from "../lib/compose-guard";
import { PAT_SHAPE, TOKEN_SHAPE } from "./fixtures";

const alex = { name: "Alex", kind: "human" as const };

describe("composeRefusal", () => {
  test("empty and whitespace drafts are refused", () => {
    expect(composeRefusal("", alex)).toBe("nothing to post");
    expect(composeRefusal("   \n", alex)).toBe("nothing to post");
  });

  test("a credential shape is refused without echoing the match", () => {
    for (const shape of [TOKEN_SHAPE, PAT_SHAPE, "github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"]) {
      const why = composeRefusal(`here: ${shape}`, alex);
      expect(why).toBeDefined();
      expect(why).toContain("credential shape");
      expect(why).not.toContain(shape);
      expect(why).not.toContain(shape.slice(0, 8));
    }
  });

  test("the seat service nonce is refused when given", () => {
    const nonce = "0123456789abcdef0123456789abcdef";
    expect(composeRefusal(`hello ${nonce}`, alex, { nonce })).toContain("nonce");
    expect(composeRefusal("hello", alex, { nonce })).toBeUndefined();
  });

  test("an unnamed human cannot post", () => {
    expect(composeRefusal("hello", { name: "", kind: "human" })).toContain("no name yet");
  });

  test("an ordinary draft passes", () => {
    expect(composeRefusal("the bearer path is Fable/watch", alex)).toBeUndefined();
  });
});

describe("preparePost", () => {
  test("signs as the human, once", () => {
    expect(preparePost("hello\n\n", alex)).toBe("hello\n\n-- Alex");
    expect(preparePost("hello\n\n-- Alex", alex)).toBe("hello\n\n-- Alex");
  });
});
