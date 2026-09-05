/**
 * The harness's wait is fail-closed: until() resolves only with a frame its predicate accepted,
 * and when the budget runs out it throws, naming the last frame, rather than handing back
 * whatever the screen held. A wait that could return an unmatched frame let a slow runner
 * capture an unsettled screen as if the condition had been met.
 */

import { describe, expect, test } from "bun:test";
import { mountApp } from "../lib/harness";
import { StubRoomClient } from "../lib/room-client";
import { seededRoom } from "./fixtures";

describe("harness until()", () => {
  test("resolves with the first frame the predicate accepts", async () => {
    const client = new StubRoomClient({ name: "Alex", rooms: { scratch: seededRoom() } });
    const h = await mountApp({ client, initialAlias: "scratch" }, { width: 100, height: 30 });
    try {
      const f = await h.until((x) => x.includes("ROOM"));
      expect(f).toContain("ROOM");
    } finally {
      h.destroy();
    }
  });

  test("throws with the last frame when nothing matched inside the budget, never an unmatched frame", async () => {
    const client = new StubRoomClient({ name: "Alex", rooms: { scratch: seededRoom() } });
    const h = await mountApp({ client, initialAlias: "scratch" }, { width: 100, height: 30 });
    try {
      let thrown: unknown = null;
      let resolved: string | null = null;
      try {
        resolved = await h.until((x) => x.includes("this text is on no frame"), { tries: 3, ms: 10 });
      } catch (e) {
        thrown = e;
      }
      expect(resolved).toBeNull();
      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message).toContain("no frame matched after 3 tries");
      // the last frame travels with the failure so the reader sees what the screen held
      expect(message).toContain("ROOM");
    } finally {
      h.destroy();
    }
  });
});
