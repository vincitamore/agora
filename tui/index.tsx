#!/usr/bin/env bun
/**
 * The entry: `bun run tui/index.tsx [room-alias] [--name <you>] [--config <path>]`.
 *
 * Reads the shared config for its rooms and state root only, resolves the seat's human from
 * `<state>/native/human.json` (asking once in the TUI when absent, or taking `--name` on this
 * run only if no record exists), mounts <App> over a LocalRoomClient, and blocks until quit.
 * The client never holds a token and never writes the shared config.
 */

import { parseArgs } from "node:util";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { App } from "./App";
import { LocalRoomClient, roomsFromConfig } from "./lib/local-client";
import { readHuman, writeHuman } from "./lib/human";
import type { HumanActor } from "./lib/room-client";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    name: { type: "string" },
    config: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
  strict: true,
});

if (values.help) {
  console.log("usage: bun run tui/index.tsx [room-alias] [--name <you>] [--config <path>]");
  process.exit(0);
}

const view = await roomsFromConfig(values.config);
let human: HumanActor | undefined = await readHuman(view.stateRoot);
if (!human && values.name) human = await writeHuman(view.stateRoot, values.name);

const alias = positionals[0] ?? view.rooms[0]?.alias;
if (alias && !view.rooms.some((r) => r.alias === alias)) {
  const other = view.elsewhere.find((r) => r.alias === alias);
  console.error(other ? `agora tui: room ${alias} is on ${other.transport}; this slice reads local rooms only` : `agora tui: no room named ${alias} in the config`);
  process.exit(2);
}

const client = new LocalRoomClient(human ?? { name: "", kind: "human" }, view);

const renderer = await createCliRenderer({
  enableMouseMovement: false,
  targetFps: 30,
  exitOnCtrlC: false,
});

// The renderer sizes itself once from stdout and re-measures only on SIGWINCH, which Windows
// never delivers; poll the terminal size and drive the public resize.
let last = { w: process.stdout.columns ?? 0, h: process.stdout.rows ?? 0 };
const resize = () => {
  const w = process.stdout.columns ?? 0;
  const h = process.stdout.rows ?? 0;
  if (w > 0 && h > 0 && (w !== last.w || h !== last.h)) {
    last = { w, h };
    renderer.resize(w, h);
  }
};
process.stdout.on("resize", resize);
const poll = setInterval(resize, 1000);

const quit = () => {
  clearInterval(poll);
  renderer.destroy();
  process.exit(0);
};
process.on("SIGINT", quit);

createRoot(renderer).render(
  <App
    client={client}
    initialAlias={alias}
    needsName={!human}
    onName={async (name) => {
      try {
        await writeHuman(view.stateRoot, name);
        return undefined;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    }}
    onQuit={quit}
  />,
);

await new Promise<void>(() => {});
