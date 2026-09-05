import { describe, expect, test } from "bun:test";
import { mountApp } from "../lib/harness";
import { stubClient } from "./fixtures";

/** Any numeral read as a tally: `3 rows`, `2 results`, `4 matches`, `12 messages`, `N agreed`. */
const TALLY = /\b\d+\s+(rows?|results?|matches|hits?|messages?|authors?|agreed)\b/i;

describe("SEARCH", () => {
  test("rows and a horizon line, never a count; enter jumps ROOM to the row", async () => {
    const client = stubClient();
    const h = await mountApp({ client, initialAlias: "scratch" }, { width: 140, height: 30 });
    try {
      await h.until((x) => x.includes("Grace (agent)  cursor 7"));
      h.mockInput.pressKey("2");
      await h.until((x) => x.includes("type to search text and author"));
      await h.settle();
      await h.mockInput.typeText("TUI");
      let f = await h.until((x) => x.includes("c3") && x.includes("Starting the TUI slice"));
      // two rows match `TUI` (m1 and the reply m3), rendered like ROOM rows
      expect(f).toMatch(/Grace \(agent\)\s+c1\s+Starting the TUI slice/);
      expect(f).toMatch(/Grace \(agent\)\s+c3\s+Read\. The TUI imports/);
      expect(f).toContain("horizon: scratch · oldest loaded");
      expect(f).toContain("(cursor 1)");
      expect(f).toContain("older messages are not searched here");
      expect(f).not.toMatch(TALLY);
      for (const r of f.replace(/\n$/, "").split("\n")) expect(r.length).toBe(140);

      // three authors in the room, and no per-author figure anywhere
      expect(f).not.toMatch(/Grace[^\n]*\b\d+\b[^\n]*(posts|messages)/i);

      // enter on the second row lands ROOM on that reply's thread, unfolded
      h.mockInput.pressArrow("down");
      await h.settle();
      h.mockInput.pressEnter();
      f = await h.until((x) => x.includes("▣ ROOM scratch") && x.includes("▾ 2 replies"));
      expect(f).toContain("❯ [2026-09-05T01:05:00.000Z] Cal/codex (agent)  cursor 2");
      expect(f).toContain("Read. The TUI imports the local transport for now.");
    } finally {
      h.destroy();
    }
  });

  test("a query nothing matches says so and still prints the horizon", async () => {
    const client = stubClient();
    const h = await mountApp({ client, initialAlias: "scratch" }, { width: 90, height: 24 });
    try {
      await h.until((x) => x.includes("Grace (agent)"));
      h.mockInput.pressKey("2");
      await h.until((x) => x.includes("type to search text and author"));
      await h.settle();
      await h.mockInput.typeText("zzzz-nothing");
      const f = await h.until((x) => x.includes("no row matches in the loaded room"));
      expect(f).toContain("horizon: scratch");
      expect(f).not.toMatch(TALLY);
    } finally {
      h.destroy();
    }
  });
});
