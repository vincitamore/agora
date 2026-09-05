/**
 * The unhappy path: a client whose reads, peers and posts fail with messages carrying credential
 * shapes, the way a transport fails with the offending header or body in its message. Every
 * error string that reaches a frame passes through the one helper, so the shapes never reach a
 * cell; the frames say `[redacted]` where the message carried them.
 */

import { describe, expect, test } from "bun:test";
import { mountApp } from "../lib/harness";
import { StubRoomClient, type PeerRow, type PostResult, type ReadResult } from "../lib/room-client";
import { redact } from "../../src/core.mjs";
import { PAT_SHAPE, seededRoom, TOKEN_SHAPE } from "./fixtures";

const SHAPES = [/xox[abprse]-[A-Za-z0-9-]+/, /gh[pousr]_[A-Za-z0-9]{16,}/, /github_pat_[A-Za-z0-9_]+/];
const PAT2 = "github_pat_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

class FailingClient extends StubRoomClient {
  failRead = false;
  failPeers = false;
  failPost = false;
  override async read(alias: string, opts?: { since?: string; limit?: number }): Promise<ReadResult> {
    if (this.failRead) throw new Error(`local room: refused with Authorization ${TOKEN_SHAPE} in the request`);
    return super.read(alias, opts);
  }
  override async peers(): Promise<PeerRow[]> {
    if (this.failPeers) throw new Error(`state root unreadable: record carried ${PAT_SHAPE}`);
    return super.peers();
  }
  override async post(alias: string, text: string, opts?: { thread?: string }): Promise<PostResult> {
    if (this.failPost) throw new Error(`append rejected: ${PAT2} and ${TOKEN_SHAPE} were in the reply`);
    return super.post(alias, text, opts);
  }
}

function assertClean(f: string) {
  expect(redact(f)).toBe(f);
  for (const re of SHAPES) expect(f).not.toMatch(re);
  expect(f).not.toContain(TOKEN_SHAPE);
  expect(f).not.toContain(PAT_SHAPE);
  expect(f).not.toContain(PAT2);
}

describe("error strings reach the frame redacted", () => {
  test("a failing read and a failing peers read render as redacted diagnostics in ROOM and PEERS", async () => {
    const client = new FailingClient({ name: "Alex", rooms: { scratch: seededRoom() } });
    client.failRead = true;
    client.failPeers = true;
    const h = await mountApp({ client, initialAlias: "scratch" }, { width: 120, height: 30 });
    try {
      let f = await h.until((x) => x.includes("room unreadable:") && x.includes("peers unreadable:"));
      expect(f).toContain("room unreadable: local room: refused with Authorization [redacted] in the request");
      expect(f).toContain("peers unreadable: state root unreadable: record carried [redacted]");
      assertClean(f);
      h.mockInput.pressKey("3");
      f = await h.until((x) => x.includes("BEARER") && x.includes("peers unreadable:"));
      expect(f).toContain("record carried [redacted]");
      assertClean(f);
    } finally {
      h.destroy();
    }
  });

  test("a failing post renders its diagnostic in the toast, redacted, and the draft stays", async () => {
    const client = new FailingClient({ name: "Alex", rooms: { scratch: seededRoom() } });
    client.failPost = true;
    const h = await mountApp({ client, initialAlias: "scratch" }, { width: 120, height: 30 });
    try {
      await h.until((x) => x.includes("Grace (agent)  cursor 7"));
      h.mockInput.pressKey("i");
      await h.until((x) => x.includes("COMPOSE as Alex"));
      await h.mockInput.typeText("a clean draft");
      h.mockInput.pressEnter({ meta: true });
      const f = await h.until((x) => x.includes("not sent:"));
      // the toast truncates to its box; the redaction happens before the cut
      expect(f).toContain("not sent: append rejected: [redacted] and [redacted]");
      expect(f).toContain("a clean draft");
      expect(client.posted).toHaveLength(0);
      assertClean(f);
    } finally {
      h.destroy();
    }
  });

  test("the name writer's failure reaches the overlay through the entry's helper, redacted", async () => {
    const { shownError } = await import("../lib/safe-text");
    const client = new FailingClient({ name: "", rooms: { scratch: seededRoom() } });
    const h = await mountApp(
      { client, initialAlias: "scratch", needsName: true, onName: async () => shownError(new Error(`cannot write: ${PAT_SHAPE}`)) },
      { width: 100, height: 30 },
    );
    try {
      await h.until((x) => x.includes("YOUR NAME"));
      await h.mockInput.typeText("Alex");
      h.mockInput.pressEnter();
      const f = await h.until((x) => x.includes("cannot write:"));
      expect(f).toContain("cannot write: [redacted]");
      assertClean(f);
    } finally {
      h.destroy();
    }
  });
});
