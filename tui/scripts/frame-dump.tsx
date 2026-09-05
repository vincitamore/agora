#!/usr/bin/env bun
/**
 * The frame walker: mounts the real shell over the seeded stub, drives every member and every
 * overlay by key at three sizes, and writes each char frame to a file for reading. It also
 * exports `walkFrames` so the redact test greps the very same frames.
 *
 *   bun run scripts/frame-dump.tsx [out-dir]
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { mountApp } from "../lib/harness";
import { stubClient } from "../test/fixtures";

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
}

export async function walkFrames(): Promise<Frame[]> {
  const out: Frame[] = [];
  for (const size of SIZES) {
    const client = stubClient();
    const h = await mountApp({ client, initialAlias: "scratch" }, size);
    const tag = `${size.width}x${size.height}`;
    const take = (name: string) => out.push({ name: `${tag}-${name}`, width: size.width, height: size.height, text: h.frame() });

    await h.until((f) => f.includes("Fable (agent)"));
    take("room-folded");
    // three up from the tail lands on the second entry, the thread root with two replies
    h.mockInput.pressArrow("up");
    h.mockInput.pressArrow("up");
    h.mockInput.pressArrow("up");
    await h.settle();
    await h.until((f) => f.includes("❯ [2026-09-05T01:05:00.000Z] Sol/codex (agent)  cursor 2"));
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
    await h.until((f) => f.includes("horizon:") && f.includes("Fable (agent)"));
    take("search-rows");
    // a digit typed into the search input is text; switch by chord instead
    h.mockInput.pressKey("n", { ctrl: true });
    await h.until((f) => f.includes("PEERS this seat only") || f.includes("BEARER"));
    take("peers");
    h.destroy();
  }
  return out;
}

if (import.meta.main) {
  const dir = process.argv[2] ?? path.join(process.cwd(), ".frames");
  await mkdir(dir, { recursive: true });
  const frames = await walkFrames();
  for (const f of frames) await writeFile(path.join(dir, `${f.name}.txt`), f.text, "utf8");
  process.stdout.write(`${frames.length} frames written to ${dir}\n`);
  process.exit(0);
}
