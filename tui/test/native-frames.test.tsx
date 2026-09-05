/**
 * The shell over the seat service client against the fake service, per view, at three sizes:
 * ROOM shows the room live with "read to" as the coverage's toInclusive (past the last message,
 * never a count), an event frame lands without a key press, compose posts through the service
 * as the human, SEARCH names the seam and searches the loaded window, PEERS reads this seat,
 * the room goes dark when the service stops and is refused when the service refuses, each
 * rendered as itself.
 */

import { describe, expect, test } from "bun:test";
import { NATIVE_EPOCH, SIZES, walkNativeFrames } from "../scripts/frame-dump";

const rows = (f: string) => f.replace(/\n$/, "").split("\n");
const TALLY = /\b\d+\s+(rows?|results?|matches|hits?|messages?|authors?|agreed|events?)\b/i;

describe("native frames", () => {
  test("every view against the seat service client: live, event, posted, seam, peers, dark, refused", async () => {
    const frames = await walkNativeFrames();
    const byName = new Map(frames.map((f) => [f.name, f]));
    for (const size of SIZES) {
      const tag = `${size.width}x${size.height}`;
      const get = (name: string) => {
        const f = byName.get(`${tag}-${name}`);
        expect(f, `${tag}-${name}`).toBeDefined();
        for (const r of rows(f!.text)) expect(r.length).toBe(size.width);
        return f!.text;
      };

      const live = get("native-room-live");
      expect(live).toContain("▣ ROOM house · native");
      // the coverage said :7 with six messages committed: read to is the coverage, not the tail
      expect(live).toContain(`read to ${NATIVE_EPOCH}:7`);
      expect(live).not.toContain(`read to ${NATIVE_EPOCH}:6`);
      expect(live).toContain("native room · live");
      expect(live).toContain("Grace (agent)");
      expect(live).toContain("→ verdict landed · exhibit gate: bun test green");
      expect(live).toContain("[redacted]");
      expect(live).not.toMatch(/xox[abprse]-/);
      expect(live).not.toMatch(TALLY);

      const event = get("native-room-event");
      expect(event).toContain("an event, pushed by the service");
      // the event committed after the board-only record: read to advances to its cursor
      expect(event).toContain(`read to ${NATIVE_EPOCH}:8`);
      expect(event).toContain("Cal/codex (agent)");

      const sent = get("native-compose-sent");
      expect(sent).toContain("posted ");
      expect(sent).toContain("Alex (human)");
      expect(sent).toContain("a line through the service");
      expect(sent).toContain("-- Alex");
      expect(sent).not.toContain("COMPOSE as Alex");

      const seam = get("native-search-seam");
      expect(seam).toContain("horizon: house · seat service search is not served yet (a seam)");
      // the horizon row is one line, cut at the terminal's width; the rest shows where it fits
      if (size.width >= 120) expect(seam).toContain("(a seam) · searched the loaded window in memory");
      expect(seam).toContain("Alex (human)");
      expect(seam).not.toMatch(TALLY);

      const peers = get("native-peers");
      expect(peers).toContain("BEARER");
      expect(peers).toContain("no sessions registered on this seat");

      const dark = get("native-room-dark");
      // the subscription's own reason (the connection closed) or the next poll's (no descriptor
      // once the service took it down): both are the channel, neither is a refusal
      expect(dark).toContain("room dark · ");
      expect(dark).toMatch(/room dark · (seat service at .* closed the connection|no seat service descriptor at )/);
      expect(dark).not.toContain("room refused");
      expect(dark).not.toContain("· live");
      // the room read before the service went is still on screen, under the dark row
      expect(dark).toContain("Alex (human)");

      const refused = get("native-room-refused");
      expect(refused).toContain("room refused ·");
      expect(refused).toContain("request-refused");
      expect(refused).not.toContain("room dark");
      // the read answered, so the room is on screen under the refusal
      expect(refused).toContain("Grace (agent)");
    }
  }, 120_000);
});
