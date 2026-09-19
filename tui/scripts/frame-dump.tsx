#!/usr/bin/env bun
/**
 * The frame walker: mounts the real shell over the seeded stub, drives every member and every
 * overlay by key at three sizes, and writes each char frame to a file for reading. It also
 * exports `walkFrames` so the redact test greps the very same frames, and `walkNativeFrames`,
 * the same walk over the seat service client against a fake service (the room live, an event
 * arriving, a post through the service, the search seam, the room dark, the room refused).
 *
 *   bun run scripts/frame-dump.tsx [out-dir]
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mountApp } from "../lib/harness";
import { SeatRoomClient } from "../lib/seat-client";
import { stubClient, FABLE, SOL, PEER, TOKEN_SHAPE, PAT_SHAPE } from "../test/fixtures";
import { startFakeService } from "../test/fake-service";

export const SIZES = [
  { width: 80, height: 24 },
  { width: 120, height: 40 },
  { width: 200, height: 50 },
] as const;

export interface Frame {
  name: string;
  width: number;
  height: number;
  text: string;
  /** Strings that must never appear in this frame (the fake service's nonce, for the native walk). */
  secrets?: string[];
}

export async function walkFrames(): Promise<Frame[]> {
  const out: Frame[] = [];
  for (const size of SIZES) {
    const client = stubClient();
    const h = await mountApp({ client, initialAlias: "scratch" }, size);
    const tag = `${size.width}x${size.height}`;
    const take = (name: string) => out.push({ name: `${tag}-${name}`, width: size.width, height: size.height, text: h.frame() });

    await h.until((f) => f.includes("Alice (agent)"));
    take("room-folded");
    // three up from the tail lands on the second entry, the thread root with two replies
    h.mockInput.pressArrow("up");
    h.mockInput.pressArrow("up");
    h.mockInput.pressArrow("up");
    await h.settle();
    await h.until((f) => f.includes("❯ [2026-09-05T01:05:00.000Z] Cal/codex (agent)  cursor 2"));
    h.mockInput.pressEnter();
    await h.until((f) => f.includes("▾ 2 replies"));
    take("room-unfolded");
    h.mockInput.pressKey("i");
    await h.until((f) => f.includes("COMPOSE as"));
    await h.mockInput.typeText("a line from the walker");
    await h.settle();
    take("compose-typed");
    h.mockInput.pressEnter({ meta: true });
    await h.until((f) => f.includes("posted stub-"));
    take("compose-sent");
    // let the toast expire so the next frames carry no overlay
    await h.settle(900);
    await h.until((f) => !f.includes("posted stub-"));
    take("room-after-post");
    h.mockInput.pressKey("2");
    await h.until((f) => f.includes("type to search text and author"));
    await h.settle();
    await h.mockInput.typeText("TUI");
    await h.until((f) => f.includes("horizon:") && f.includes("Alice (agent)"));
    take("search-rows");
    // a digit typed into the search input is text; switch by chord instead
    h.mockInput.pressKey("n", { ctrl: true });
    await h.until((f) => f.includes("PEERS this seat only") || f.includes("BEARER"));
    take("peers");
    h.destroy();
  }
  return out;
}

export const NATIVE_ROOM = "6".repeat(32);
export const NATIVE_EPOCH = "7".repeat(32);

/** The seeded room again, committed through the fake service so every id and cursor is the host's. */
function seedNative(service: Awaited<ReturnType<typeof startFakeService>>): void {
  const m1 = service.seed(FABLE, "Starting the TUI slice against the seat service.\n\nclaim: work:tui-native-client\n\n-- Alice");
  const m2 = service.seed(SOL, `The seat service serves read, subscribe and append.\n\nto: Alice\nre: ${m1.id.slice(0, 12)}\n\n-- Cal/codex`);
  service.seed(FABLE, "Read. The TUI talks to the service now.\n\n-- Alice", { thread: m2.id });
  service.seed(PEER, "works for me\n\n-- peer", { thread: m2.id });
  service.seed(FABLE, `Never paste a token; this one is a shape only: ${TOKEN_SHAPE} and ${PAT_SHAPE}\n\n-- Alice`);
  service.seed(FABLE, "Verdict on the slot count: measured, not derived.\n\nverdict: landed\nexhibit: gate: bun test green\n\n-- Alice");
}

export async function walkNativeFrames(): Promise<Frame[]> {
  const out: Frame[] = [];
  for (const size of SIZES) {
    const root = await mkdtemp(path.join(tmpdir(), "agora-tui-native-frames-"));
    const tag = `${size.width}x${size.height}`;
    // one board-only event past the last message, so "read to" is visibly the coverage, not the tail
    const service = await startFakeService({ root, roomId: NATIVE_ROOM, epoch: NATIVE_EPOCH, coverageAhead: 1, seatLabel: "seat-a" });
    seedNative(service);
    const view = { stateRoot: root, rooms: [], native: [{ alias: "house", transport: "native" as const, room: NATIVE_ROOM, roomId: NATIVE_ROOM }], elsewhere: [] };
    const client = new SeatRoomClient({ name: "operator", kind: "human" }, view, { native: { waitMs: 50 } });
    const h = await mountApp({ client, initialAlias: "house" }, size);
    const take = (name: string) => out.push({ name: `${tag}-${name}`, width: size.width, height: size.height, text: h.frame(), secrets: [service.nonce] });
    try {
      await h.until((f) => f.includes("native room · live") && f.includes(`read to ${NATIVE_EPOCH}:7`));
      take("native-room-live");
      // a peer's post arrives as an event frame; nothing was pressed
      service.seed(SOL, "an event, pushed by the service\n\n-- Cal/codex");
      await h.until((f) => f.includes("an event, pushed by the service"));
      take("native-room-event");
      h.mockInput.pressKey("i");
      await h.until((f) => f.includes("COMPOSE as operator"));
      await h.mockInput.typeText("a line through the service");
      await h.settle();
      h.mockInput.pressEnter({ meta: true });
      await h.until((f) => f.includes("posted ") && f.includes("operator (human)"));
      take("native-compose-sent");
      await h.settle(900);
      await h.until((f) => !f.includes("posted "));
      take("native-room-after-post");
      h.mockInput.pressKey("2");
      await h.until((f) => f.includes("type to search text and author"));
      await h.settle();
      await h.mockInput.typeText("service");
      await h.until((f) => f.includes("is not served yet (a seam)"));
      take("native-search-seam");
      h.mockInput.pressKey("n", { ctrl: true });
      await h.until((f) => f.includes("BEARER"));
      take("native-peers");
      h.mockInput.pressKey("1");
      await h.until((f) => f.includes("▣ ROOM house"));
      await service.stop();
      // the dark row lands when the subscription sees the close or the next poll finds no
      // descriptor; on a slow runner that is seconds, not the default two, so the wait is long and
      // the frame taken is the one that carried the row
      const darkFrame = await h.until((f) => f.includes("room dark ·"), { tries: 200, ms: 50 });
      out.push({ name: `${tag}-native-room-dark`, width: size.width, height: size.height, text: darkFrame, secrets: [service.nonce] });
    } finally {
      h.destroy();
      client.close();
      await service.stop();
      await rm(root, { recursive: true, force: true });
    }

    // a second service that answers reads and refuses the subscription: refused, not dark
    const root2 = await mkdtemp(path.join(tmpdir(), "agora-tui-native-frames-"));
    const refusing = await startFakeService({ root: root2, roomId: NATIVE_ROOM, epoch: NATIVE_EPOCH, refuse: ["subscribe"], seatLabel: "seat-a" });
    seedNative(refusing);
    const view2 = { stateRoot: root2, rooms: [], native: [{ alias: "house", transport: "native" as const, room: NATIVE_ROOM, roomId: NATIVE_ROOM }], elsewhere: [] };
    const client2 = new SeatRoomClient({ name: "operator", kind: "human" }, view2, { native: { waitMs: 50 } });
    const h2 = await mountApp({ client: client2, initialAlias: "house" }, size);
    try {
      await h2.until((f) => f.includes("room refused ·"));
      out.push({ name: `${tag}-native-room-refused`, width: size.width, height: size.height, text: h2.frame(), secrets: [refusing.nonce] });
    } finally {
      h2.destroy();
      client2.close();
      await refusing.stop();
      await rm(root2, { recursive: true, force: true });
    }
  }
  return out;
}

if (import.meta.main) {
  const dir = process.argv[2] ?? path.join(process.cwd(), ".frames");
  await mkdir(dir, { recursive: true });
  const frames = [...(await walkFrames()), ...(await walkNativeFrames())];
  for (const f of frames) await writeFile(path.join(dir, `${f.name}.txt`), f.text, "utf8");
  process.stdout.write(`${frames.length} frames written to ${dir}\n`);
  process.exit(0);
}
