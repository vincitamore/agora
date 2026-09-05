/**
 * Every frame the walker renders, at every size, passes through `redact()` unchanged and carries
 * none of the shapes it rewrites, while the seeded room does carry one: the render path, not the
 * fixture, is what keeps a token off the screen.
 */

import { describe, expect, test } from "bun:test";
import { walkFrames } from "../scripts/frame-dump";
import { redact } from "../../src/core.mjs";
import { PAT_SHAPE, seededRoom, TOKEN_SHAPE } from "./fixtures";

const SHAPES = [/xox[abprse]-[A-Za-z0-9-]+/, /gh[pousr]_[A-Za-z0-9]{16,}/, /github_pat_[A-Za-z0-9_]+/];

describe("no token shape in any rendered frame", () => {
  test("the walker's frames are redact-invariant; the fixture is not", async () => {
    const seeded = seededRoom().map((m) => m.text).join("\n");
    expect(seeded).toContain(TOKEN_SHAPE);
    expect(seeded).toContain(PAT_SHAPE);
    expect(redact(seeded)).not.toBe(seeded);

    const frames = await walkFrames();
    expect(frames.length).toBeGreaterThanOrEqual(21);
    const names = new Set(frames.map((f) => f.name));
    for (const size of ["80x24", "120x40", "200x50"]) {
      for (const view of ["room-folded", "room-unfolded", "compose-typed", "compose-sent", "room-after-post", "search-rows", "peers"]) {
        expect(names.has(`${size}-${view}`)).toBe(true);
      }
    }
    for (const f of frames) {
      expect(redact(f.text)).toBe(f.text);
      for (const re of SHAPES) expect(f.text).not.toMatch(re);
      expect(f.text).not.toContain(TOKEN_SHAPE);
      expect(f.text).not.toContain(PAT_SHAPE);
      // the seeded shape reached the room and was redacted on the way to the cell
      if (f.name.endsWith("room-folded")) expect(f.text).toContain("[redacted]");
      // no row wider than the terminal
      for (const r of f.text.replace(/\n$/, "").split("\n")) expect(r.length).toBe(f.width);
    }
  }, 60_000);
});
