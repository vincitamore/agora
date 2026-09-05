import { describe, expect, test } from "bun:test";
import { mountApp } from "../lib/harness";
import { SIZES } from "../scripts/frame-dump";
import { stubClient } from "./fixtures";

const rows = (f: string) => f.replace(/\n$/, "").split("\n");

describe("ROOM frames", () => {
  for (const size of SIZES) {
    test(`renders the room at ${size.width}x${size.height}: chrome intact, newest at the bottom, derived line, fold and unfold`, async () => {
      const client = stubClient();
      const h = await mountApp({ client, initialAlias: "scratch" }, size);
      try {
        let f = await h.until((x) => x.includes("Fable (agent)  cursor 7"));
        // every row exactly the terminal width: nothing wrapped, nothing overflowed
        for (const r of rows(f)) expect(r.length).toBe(size.width);
        expect(f).toContain("[1] ROOM");
        expect(f).toContain("[2] SEARCH");
        expect(f).toContain("[3] PEERS");
        expect(f).toContain("▣ ROOM scratch");
        expect(f).toContain("PEERS ●");
        expect(f).toContain("this seat only");
        expect(f).toContain("i to compose");
        // the newest message is on screen with its derived line, exactly as the CLI prints it
        expect(f).toContain("→ verdict landed · exhibit gate: bun test green");
        expect(f).toContain("❯ [2026-09-05T01:15:00.000Z] Fable (agent)  cursor 7");
        // the seeded token shape never reaches a cell
        expect(f).toContain("[redacted]");
        expect(f).not.toMatch(/xox[abprse]-/);

        // three up from the tail: the thread root, folded
        h.mockInput.pressArrow("up");
        h.mockInput.pressArrow("up");
        h.mockInput.pressArrow("up");
        await h.settle();
        f = await h.until((x) => x.includes("❯ [2026-09-05T01:05:00.000Z] Sol/codex (agent)  cursor 2"));
        expect(f).toContain("▸ 2 replies");
        expect(f).toContain("→ to Fable · re m1");
        expect(f).not.toContain("bone (human)");

        h.mockInput.pressEnter();
        f = await h.until((x) => x.includes("▾ 2 replies"));
        expect(f).toContain("thread m2  cursor 3");
        // a block taller than the window shows its head; PageDown scrolls the rest into view
        h.mockInput.pressKey("\x1b[6~");
        f = await h.until((x) => x.includes("works for me"));
        expect(f).toContain("bone (human)");
        for (const r of rows(f)) expect(r.length).toBe(size.width);

        // fold it back with t
        h.mockInput.pressKey("t");
        f = await h.until((x) => x.includes("▸ 2 replies"));
        expect(f).not.toContain("works for me");

        // End returns to the tail
        h.mockInput.pressKey("END");
        f = await h.until((x) => x.includes("❯ [2026-09-05T01:15:00.000Z]"));
        expect(f).toContain("cursor 7");
      } finally {
        h.destroy();
      }
    });
  }

  test("attachments render with a local path and a bounded error", async () => {
    const client = stubClient();
    const h = await mountApp({ client, initialAlias: "scratch" }, { width: 120, height: 40 });
    try {
      let f = await h.until((x) => x.includes("image frame.png"));
      expect(f).toContain("image frame.png (image/png, 48213 bytes)");
      expect(f).toContain("local C:\\Users\\seat\\.agora\\state\\files\\frame.png");
      expect(f).toContain("bytes unavailable: the offer expired before this seat fetched it");

      // mouse is co-equal: the wheel moves the cursor, a click on the member bar switches
      await h.mockMouse.scroll(40, 15, "up");
      f = await h.until((x) => x.includes("❯ [2026-09-05T01:12:00.000Z] Fable (agent)  cursor 6"));
      expect(f).toContain("cursor 6");
      const bar = f.replace(/\n$/, "").split("\n")[3];
      await h.mockMouse.click(bar.indexOf("[2] SEARCH") + 2, 3);
      f = await h.until((x) => x.includes("⌕ SEARCH in the loaded room"));
      expect(f).toContain("type to search text and author");
    } finally {
      h.destroy();
    }
  });

  test("a room with nothing in it says so and compose still offers itself", async () => {
    const { StubRoomClient } = await import("../lib/room-client");
    const client = new StubRoomClient({ name: "Alex", rooms: { empty: [] } });
    const h = await mountApp({ client, initialAlias: "empty" }, { width: 80, height: 24 });
    try {
      const f = await h.until((x) => x.includes("nothing in this room yet"));
      expect(f).toContain("▣ ROOM empty");
      expect(f).toContain("i to compose");
    } finally {
      h.destroy();
    }
  });
});
