import { describe, expect, test } from "bun:test";
import { mountApp } from "../lib/harness";
import { stubClient } from "./fixtures";

describe("PEERS", () => {
  test("shows this seat's sessions as live, dark and unknown rows, and says the scope", async () => {
    const client = stubClient();
    const h = await mountApp({ client, initialAlias: "scratch" }, { width: 120, height: 30 });
    try {
      await h.until((x) => x.includes("Fable (agent)"));
      h.mockInput.pressKey("3");
      const f = await h.until((x) => x.includes("BEARER") && x.includes("Grok/general"));
      expect(f).toContain("⁂ PEERS this seat only");
      expect(f).toMatch(/● Fable\/agora-orchest…\s+live\s+4242/);
      expect(f).toMatch(/◐ Sol\/codex\s+dark\s+5151/);
      expect(f).toMatch(/○ Grok\/general\s+unknown\s+-/);
      expect(f).toContain('"orchestrator"');
      for (const r of f.replace(/\n$/, "").split("\n")) expect(r.length).toBe(120);
      // the ROOM header carries the same presence, derived at read time
      h.mockInput.pressKey("1");
      const room = await h.until((x) => x.includes("▣ ROOM scratch"));
      expect(room).toContain("PEERS ● Fable/agora-orchestrator  ◐ Sol/codex  ○ Grok/general · this seat only");
    } finally {
      h.destroy();
    }
  });

  test("no records reads as no sessions, never as an error", async () => {
    const { StubRoomClient } = await import("../lib/room-client");
    const client = new StubRoomClient({ name: "Alex", rooms: { scratch: [] }, peers: [] });
    const h = await mountApp({ client, initialAlias: "scratch" }, { width: 80, height: 24 });
    try {
      await h.until((x) => x.includes("nothing in this room yet"));
      h.mockInput.pressKey("3");
      const f = await h.until((x) => x.includes("BEARER"));
      expect(f).toContain("no sessions registered on this seat");
    } finally {
      h.destroy();
    }
  });
});
