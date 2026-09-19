import { describe, expect, test } from "bun:test";
import { buildLines, foldThreads, searchMessages } from "../lib/room-model";
import { decorate, trailerLine, headerLine } from "../../src/render.mjs";
import { seededRoom, TOKEN_SHAPE } from "./fixtures";

describe("foldThreads", () => {
  test("groups replies under the root they name, roots in read order", () => {
    const entries = foldThreads(seededRoom());
    expect(entries.map((e) => e.root.id)).toEqual(["m1", "m2", "m5", "m6", "m7"]);
    expect(entries[1].replies.map((r) => r.id)).toEqual(["m3", "m4"]);
    expect(entries.every((e) => !e.orphan)).toBe(true);
  });

  test("a reply whose root is not loaded shows at the top level, marked orphan", () => {
    const [m3] = seededRoom().filter((m) => m.id === "m3");
    const entries = foldThreads([m3]);
    expect(entries).toHaveLength(1);
    expect(entries[0].orphan).toBe(true);
  });
});

describe("buildLines", () => {
  test("the header and derived line are the CLI printer's own output", () => {
    const msgs = seededRoom();
    const lines = buildLines(foldThreads(msgs), { width: 120, unfolded: new Set() });
    const m2 = msgs.find((m) => m.id === "m2")!;
    const d = decorate(m2 as never);
    const header = lines.find((l) => l.tone === "header" && l.entry === 1)!;
    const derived = lines.find((l) => l.tone === "derived" && l.entry === 1)!;
    expect(header.text).toBe(headerLine(d));
    expect(derived.text).toBe(trailerLine(d).replace(/\n$/, ""));
    expect(derived.text).toBe("  → to Alice · re m1");
  });

  test("folded thread shows a fold line and no reply lines; unfolded shows the replies indented", () => {
    const entries = foldThreads(seededRoom());
    const folded = buildLines(entries, { width: 100, unfolded: new Set() });
    expect(folded.some((l) => l.tone === "fold" && l.text.includes("▸ 2 replies"))).toBe(true);
    expect(folded.some((l) => l.reply)).toBe(false);
    const open = buildLines(entries, { width: 100, unfolded: new Set(["m2"]) });
    expect(open.some((l) => l.tone === "fold" && l.text.includes("▾ 2 replies"))).toBe(true);
    const replyHeaders = open.filter((l) => l.reply && l.tone === "header");
    expect(replyHeaders).toHaveLength(2);
    expect(replyHeaders[1].text).toContain("peer (human)");
    expect(replyHeaders[1].text.startsWith("  [")).toBe(true);
  });

  test("bodies are verbatim but pass through redact at render time", () => {
    const lines = buildLines(foldThreads(seededRoom()), { width: 200, unfolded: new Set() });
    const joined = lines.map((l) => l.text).join("\n");
    expect(joined).not.toContain(TOKEN_SHAPE);
    expect(joined).toContain("[redacted]");
    expect(joined).toContain("\n    -- Alice");
  });

  test("attachments render as the CLI renders them, path and error alike", () => {
    const lines = buildLines(foldThreads(seededRoom()), { width: 200, unfolded: new Set() });
    const att = lines.filter((l) => l.tone === "attachment").map((l) => l.text);
    expect(att).toContain("    image frame.png (image/png, 48213 bytes)");
    expect(att).toContain("      local C:\\Users\\seat\\.agora\\state\\files\\frame.png");
    expect(att).toContain("      bytes unavailable: the offer expired before this seat fetched it");
  });
});

describe("searchMessages", () => {
  test("substring over text and author, case-insensitive, rows only", () => {
    const msgs = seededRoom();
    expect(searchMessages(msgs, "SLICE").map((m) => m.id)).toEqual(["m1"]);
    expect(searchMessages(msgs, "tui").map((m) => m.id)).toEqual(["m1", "m3"]);
    expect(searchMessages(msgs, "peer").map((m) => m.id)).toEqual(["m4"]);
    expect(searchMessages(msgs, "")).toEqual([]);
    expect(searchMessages(msgs, "tui", { kind: "human" })).toEqual([]);
  });
});
