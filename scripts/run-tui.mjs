#!/usr/bin/env node
// @ts-check
/**
 * Launch the OpenTUI terminal room interface (`npm run tui -- [room] [--name <you>] [--config <path>]`).
 * Checks that `tui/node_modules` is installed before handing off to Bun so a fresh clone gets a
 * clear one-line instruction instead of a raw module-resolution trace.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tuiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "tui");

if (!existsSync(path.join(tuiDir, "node_modules"))) {
  console.error("agora TUI dependencies are not installed yet.");
  console.error("Run: bun install --cwd tui");
  process.exit(1);
}

const bun = process.platform === "win32" ? "bun.exe" : "bun";
const result = spawnSync(bun, ["run", "index.tsx", ...process.argv.slice(2)], {
  cwd: tuiDir,
  stdio: "inherit",
});

if (result.error) {
  if (/** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    console.error("agora TUI requires Bun (https://bun.sh), which was not found on PATH.");
  } else {
    console.error(`agora TUI could not start: ${result.error.message}`);
  }
  process.exit(1);
}

process.exit(result.status ?? 0);
