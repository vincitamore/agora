/**
 * Every frame the walker renders, at every size, passes through `redact()` unchanged and carries
 * none of the shapes it rewrites, while the seeded room does carry one: the render path, not the
 * fixture, is what keeps a token off the screen. The native walk adds the seat service's nonce
 * to what must never reach a cell: the client holds it for the hello and for refusing a draft,
 * and no view renders it.
 */

import { describe, expect, test } from "bun:test";
import { walkFrames, walkNativeFrames } from "../scripts/frame-dump";
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

  test("the native walk's frames carry no token shape and never the service nonce", async () => {
    const frames = await walkNativeFrames();
    expect(frames.length).toBeGreaterThanOrEqual(24);
    const names = new Set(frames.map((f) => f.name));
    for (const size of ["80x24", "120x40", "200x50"]) {
      for (const view of ["native-room-live", "native-room-event", "native-compose-sent", "native-room-after-post", "native-search-seam", "native-peers", "native-room-dark", "native-room-refused"]) {
        expect(names.has(`${size}-${view}`)).toBe(true);
      }
    }
    for (const f of frames) {
      expect(f.secrets?.length).toBeGreaterThan(0);
      for (const s of f.secrets ?? []) {
        expect(s.length).toBeGreaterThanOrEqual(32);
        expect(f.text).not.toContain(s);
      }
      expect(redact(f.text)).toBe(f.text);
      for (const re of SHAPES) expect(f.text).not.toMatch(re);
      expect(f.text).not.toContain(TOKEN_SHAPE);
      expect(f.text).not.toContain(PAT_SHAPE);
      if (f.name.endsWith("native-room-live")) expect(f.text).toContain("[redacted]");
      for (const r of f.text.replace(/\n$/, "").split("\n")) expect(r.length).toBe(f.width);
    }
  }, 120_000);
});
